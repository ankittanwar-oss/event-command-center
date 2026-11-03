import { DEFAULT_RULES, mergeRules, type Activity, type Company, type Contact, type Dataset, type Deal, type EventRecord, type Rules, type Task } from "../src/index.js";

export const BOBBI = "87607260";      // NAM
export const DISHA = "88722653";      // APAC
export const ANSHU = "2125691021";    // EMEA
export const AE = "95421364";         // not on roster (an AE)

// Test baseline: 3-business-day first-touch SLA for both temperatures (the fixtures' dates were written for it).
export function rules(patch: unknown = {}): Rules {
  const base = mergeRules({ ...DEFAULT_RULES, minEventDate: null, slaStartDate: null }, { cadence: { Hot: { firstTouchBusinessDays: 3 }, Warm: { firstTouchBusinessDays: 3 } } });
  return mergeRules(base, patch);
}

export function company(p: Partial<Company> = {}): Company {
  return {
    id: "co1", name: "Acme", domain: null, country: null, sdrOwnerId: BOBBI, allocationDate: "2026-09-01", allocationSource: "property",
    unassignmentDate: null, icpTier: "Targetable - Tier 1", competitorFlag: null, temperatureRaw: "Hot", lifecycleStage: "lead", ...p,
  };
}
export function contact(p: Partial<Contact> = {}): Contact {
  return { id: "c1", firstName: "Jane", lastName: "Doe", email: "jane@acme.com", jobTitle: "GC", country: null, companyId: "co1", lifecycleStage: "lead", leadStatus: null, doNotContact: false, attendedDate: null, ...p };
}
export function event(p: Partial<EventRecord> = {}): EventRecord {
  return { id: "e1", name: "Round Table 7", date: "2026-10-01", eventType: null, category: "roundtable", categorySource: "rule", ...p };
}
let seq = 0;
export function act(p: Partial<Activity> & { ts: string }): Activity {
  const { ts, ...rest } = p;
  return { id: `emails:${++seq}`, kind: "EMAIL", objectType: "emails", timestamp: ts.length === 10 ? `${ts}T15:00:00Z` : ts, ownerId: BOBBI, direction: "EMAIL", channel: null, status: null, title: null, contactIds: ["c1"], companyIds: ["co1"], ...rest };
}
export function deal(p: Partial<Deal> = {}): Deal {
  return { id: "d1", name: "Acme – New", stage: "s", stageLabel: "Discovery", isClosed: false, isWon: false, ownerId: AE, amount: null, createdAt: "2026-10-10T00:00:00Z", mqlDate: "2026-10-10", sqlDate: "2026-10-12", contactIds: ["c1"], companyIds: ["co1"], ...p };
}

export function dataset(opts: { companies?: Company[]; contacts?: Contact[]; events?: EventRecord[]; links?: Array<[string, string, string?]>; acts?: Activity[]; tasks?: Task[]; deals?: Deal[] } = {}): Dataset {
  const ds: Dataset = {
    companies: new Map((opts.companies ?? [company()]).map((c) => [c.id, c])),
    contacts: new Map((opts.contacts ?? [contact()]).map((c) => [c.id, c])),
    events: new Map((opts.events ?? [event()]).map((e) => [e.id, e])),
    eventContacts: (opts.links ?? [["e1", "c1"]]).map(([eventId, contactId, attendedAt]) => ({ eventId, contactId, attendedAt: attendedAt ?? null })),
    activitiesByContact: new Map(), activitiesByCompany: new Map(), tasksByContact: new Map(), dealsByContact: new Map(), dealsByCompany: new Map(),
  };
  const push = <V>(m: Map<string, V[]>, k: string, v: V) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };
  for (const a of (opts.acts ?? []).sort((x, y) => x.timestamp.localeCompare(y.timestamp))) {
    for (const c of a.contactIds) push(ds.activitiesByContact, c, a);
    for (const c of a.companyIds) push(ds.activitiesByCompany, c, a);
  }
  for (const t of opts.tasks ?? []) for (const c of t.contactIds) push(ds.tasksByContact, c, t);
  for (const d of opts.deals ?? []) { for (const c of d.contactIds) push(ds.dealsByContact, c, d); for (const c of d.companyIds) push(ds.dealsByCompany, c, d); }
  return ds;
}
