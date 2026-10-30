/**
 * Offline smoke test: runs the production calculation layer (@ecc/core) against the JSON extracts produced by the
 * previous Claude-session refresh pipeline ("Events Dash Refresh" folder). No network, no database.
 *
 *   npx tsx scripts/validate-extracts.ts "/path/to/Events Dash Refresh" [--assume-temperature Warm] [--today YYYY-MM-DD] [--contact jane] [--dump-facts out.json]
 *
 * Limits (printed in the output too):
 *  - The extracts do not contain the company Lead Temperature property, so eligibility by temperature cannot be
 *    reproduced. Use --assume-temperature to treat every company as Hot or Warm for a coverage cross-check.
 *  - Older outbound emails exist only as per-contact daily counts; they become synthetic activities (same day, same owner).
 *  - LinkedIn communications were never extracted.
 * The numbers are therefore a logic cross-check, not the source of truth. The live sync replaces all of this.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  categorizeEvent, computeLeadFacts, DEFAULT_RULES, mergeRules, STATUS_LABEL, toDate,
  type Activity, type Company, type Contact, type Dataset, type Deal, type EventContact, type EventRecord, type Task,
} from "@ecc/core";

const dir = process.argv[2];
if (!dir || !existsSync(dir)) { console.error("Usage: validate-extracts.ts <Events Dash Refresh folder> [--assume-temperature Hot|Warm] [--today YYYY-MM-DD]"); process.exit(2); }
const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const assumeTemp = arg("--assume-temperature");
const today = arg("--today") ?? new Date().toISOString().slice(0, 10);
const j = (f: string) => JSON.parse(readFileSync(path.join(dir, f), "utf8"));

const rules = mergeRules(DEFAULT_RULES, {});
const ds: Dataset = {
  companies: new Map(), contacts: new Map(), events: new Map(), eventContacts: [],
  activitiesByContact: new Map(), activitiesByCompany: new Map(), tasksByContact: new Map(), dealsByContact: new Map(), dealsByCompany: new Map(),
};
const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };

// events
for (const e of j("events_120d.json") as any[]) {
  const cat = categorizeEvent(e.event_id, e.name, e.event_type, rules);
  ds.events.set(e.event_id, { id: e.event_id, name: e.name, date: e.date, eventType: e.event_type, category: cat.category, categorySource: cat.source } as EventRecord);
}

// companies
const companiesJson = j("companies.json");
const contactCompany: Record<string, string> = companiesJson.contact_company ?? {};
const fields: Record<string, any> = j("company_fields.json");
for (const [id, f] of Object.entries(fields)) {
  ds.companies.set(id, {
    id, name: f.name ?? companiesJson.companies?.[id]?.name ?? null, domain: f.domain ?? null, country: null, sdrOwnerId: f.sdr_owner ?? null,
    allocationDate: toDate(f.allocation_date), allocationSource: f.allocation_date ? "property" : null, unassignmentDate: null,
    icpTier: f.icp_category_20 ?? null, competitorFlag: f.competitor_check__clay ?? null,
    temperatureRaw: f.event_leads___cold_warm_surging_hot ?? assumeTemp ?? null, lifecycleStage: null,
  } as Company);
}

// registrants
for (const file of readdirSync(dir).filter((f) => /^reg_\d+\.json$/.test(f))) {
  const r = j(file);
  const ev = ds.events.get(String(r.event_id));
  if (!ev || !Array.isArray(r.contacts)) continue;
  for (const c of r.contacts) {
    const companyId = c.associatedcompanyid ?? contactCompany[c.id] ?? null;
    if (!ds.contacts.has(c.id)) {
      ds.contacts.set(c.id, {
        id: c.id, firstName: c.firstname, lastName: c.lastname, email: c.email, jobTitle: c.jobtitle, country: c.country, companyId,
        lifecycleStage: c.lifecyclestage ?? null, leadStatus: c.hs_lead_status ?? null, doNotContact: String(c.dnc ?? "").toLowerCase() === "true",
        attendedDate: toDate(c.date_engaged__event_attended_date_),
      } as Contact);
    }
    ds.eventContacts.push({ eventId: ev.id, contactId: c.id, attendedAt: null } as EventContact);
  }
}

// activities
let n = 0;
const addAct = (a: Activity) => { for (const c of a.contactIds) push(ds.activitiesByContact, c, a); for (const co of a.companyIds) push(ds.activitiesByCompany, co, a); n++; };
const store = j("activity_store.json");
const storeFrom: string = Object.values(store.acts as Record<string, any>).map((a: any) => a.ts).sort()[0] ?? "9999";
const te = j("touch_email.json");
for (const row of te.contact_level as any[]) {
  if (row.day >= storeFrom) continue;
  for (let i = 0; i < (row.n ?? 1); i++) {
    addAct({ id: `emails:agg-${row.contact}-${row.day}-${row.owner}-${i}`, kind: "EMAIL", objectType: "emails", timestamp: `${row.day}T12:${String(i).padStart(2, "0")}:00Z`,
      ownerId: row.owner, direction: "EMAIL", channel: null, status: null, title: null, contactIds: [row.contact], companyIds: row.company ? [row.company] : [] });
  }
}
for (const e of j("eng_calls_meetings.json") as any[]) {
  if (e.ts >= storeFrom) continue;
  addAct({ id: `${e.type === "call" ? "calls" : "meetings"}:${e.id}`, kind: e.type === "call" ? "CALL" : "MEETING", objectType: e.type === "call" ? "calls" : "meetings",
    timestamp: `${e.ts}T12:00:00Z`, ownerId: e.owner, direction: null, channel: null, status: null, title: e.title, contactIds: e.contacts ?? [], companyIds: e.companies ?? [] });
}
for (const [key, a] of Object.entries(store.acts as Record<string, any>)) {
  const kind = a.t === "email" ? "EMAIL" : a.t === "call" ? "CALL" : a.t === "meeting" ? "MEETING" : "OTHER";
  addAct({ id: key.replace("|", ":"), kind, objectType: a.t === "email" ? "emails" : a.t === "call" ? "calls" : "meetings", timestamp: `${a.ts}T12:00:00Z`,
    ownerId: a.o, direction: kind === "EMAIL" ? "EMAIL" : null, channel: null, status: null, title: null, contactIds: a.ct ?? [], companyIds: a.co ?? [] } as Activity);
}

// open tasks (next step)
for (const [cid, t] of Object.entries(j("tasks_open.json") as Record<string, any>)) {
  if (t.next_due) push(ds.tasksByContact, cid, { id: `t-${cid}`, dueDate: `${t.next_due}T12:00:00Z`, status: "NOT_STARTED", taskType: null, ownerId: null, subject: null, contactIds: [cid] } as Task);
}

// deals
for (const d of j("deals_mql_sql.json").deals as any[]) {
  const deal: Deal = {
    id: d.id, name: d.name, stage: d.stage, stageLabel: d.stage_label, isClosed: /closed/i.test(d.stage_label ?? ""), isWon: /won/i.test(d.stage_label ?? ""),
    ownerId: d.owner, amount: d.amount, createdAt: d.created ? `${d.created}T00:00:00Z` : null, mqlDate: d.mql, sqlDate: d.sql ?? d.sql_hs, contactIds: d.contacts ?? [], companyIds: d.companies ?? [],
  };
  for (const c of deal.contactIds) push(ds.dealsByContact, c, deal);
  for (const c of deal.companyIds) push(ds.dealsByCompany, c, deal);
}

const facts = computeLeadFacts(ds, rules, today);
console.log(`as of ${today} · ${ds.events.size} events · ${ds.eventContacts.length} registrations · ${ds.contacts.size} contacts · ${ds.companies.size} companies · ${n} activities`);
console.log(assumeTemp ? `!! temperature assumed = ${assumeTemp} for every company (extracts lack the property)` : "!! no temperature in extracts: every lead will be ineligible (pass --assume-temperature Warm to cross-check coverage)");
console.log("");
const byEvent = new Map<string, typeof facts>();
for (const f of facts) { const l = byEvent.get(f.eventId) ?? []; l.push(f); byEvent.set(f.eventId, l); }
const rows = [...byEvent.entries()].map(([id, l]) => {
  const ev = ds.events.get(id)!;
  const el = l.filter((f) => f.eligible);
  const st = (s: string) => el.filter((f) => f.status === s).length;
  return { date: ev.date, cat: ev.category, name: ev.name.slice(0, 44), reg: l.length, att: l.filter((f) => f.attendance === "attended").length, elig: el.length,
    worked: el.filter((f) => f.touchesSinceEligibility > 0).length, never: st("never_worked"), first: st("first_touch"), active: st("active"), stalled: st("stalled"), inplay: st("in_play"), unver: st("unverifiable") };
}).sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
console.table(rows);

const reasons: Record<string, number> = {};
for (const f of facts) if (!f.eligible) reasons[f.ineligibleReason ?? "?"] = (reasons[f.ineligibleReason ?? "?"] ?? 0) + 1;
console.log("Ineligible reasons:", reasons);

const dump = arg("--dump-facts");
if (dump) { writeFileSync(dump, JSON.stringify(facts)); console.log(`facts written to ${dump}`); }

const look = arg("--contact");
if (look) {
  for (const f of facts.filter((x) => x.contactName.toLowerCase().includes(look.toLowerCase()) || (x.contactEmail ?? "").toLowerCase().includes(look.toLowerCase()))) {
    console.log(`\n${f.contactName} <${f.contactEmail}> · ${f.eventName} (${f.eventDate})`);
    console.log(`  company ${f.companyName} · sdr ${f.sdrOwnerId ?? f.sdrOwnerRaw} (${f.sdrRegion}) · eligible ${f.eligible} ${f.ineligibleReason ?? ""}`);
    console.log(`  status ${STATUS_LABEL[f.status]} – ${f.statusReason} · touches ${f.touchesSinceEligibility} · first ${f.firstTouchAt} · last ${f.lastTouchAt} · SLA ${f.firstTouchSlaMet}`);
  }
}
