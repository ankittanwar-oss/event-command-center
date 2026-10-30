import {
  accountQueue, applyFilters, BUCKETS, categoryBreakdown, CATEGORY_LABEL, dataQuality, eventSummaries, fiscalQuarterOf, inBucket, nextAction,
  normalizeFilters, parseQuarterKey, previousQuarter, qoq, quarterMetrics, regionBreakdown, rosterById, SDR_ROSTER, sdrTable, STATUS_LABEL, temperatureSummary,
  type EventCategory, type Filters, type LeadFact, type NormalizedFilters, type Region, type Rules,
} from "@ecc/core";

// Pure view builders: (facts, filters) -> JSON. No database access, so they are unit-tested directly.

const REGIONS = ["NAM", "EMEA", "APAC"];
const CATS = ["owned", "sponsored", "webinar", "roundtable", "uncategorized"];

export function parseFilters(q: URLSearchParams): Filters {
  const pick = (k: string) => (q.get(k) || "").trim();
  const region = pick("region");
  const category = pick("category");
  const temperature = pick("temperature");
  return {
    quarter: pick("quarter") || "this",
    region: (REGIONS.includes(region) ? region : "") as Region | "",
    sdr: pick("sdr"),
    eventId: pick("eventId"),
    category: (CATS.includes(category) ? category : "") as EventCategory | "",
    temperature: (temperature === "Hot" || temperature === "Warm" ? temperature : "") as "Hot" | "Warm" | "",
    status: (Object.keys(STATUS_LABEL).includes(pick("status")) ? pick("status") : "") as Filters["status"],
    attendance: ["attended", "no_show", "unknown"].includes(pick("attendance")) ? pick("attendance") : "",
    icpTier: pick("icpTier"),
    search: pick("search").slice(0, 100),
  };
}

export function filtered(facts: LeadFact[], q: URLSearchParams, today: string, omit: Array<keyof Filters> = []) {
  const f = parseFilters(q);
  for (const k of omit) delete (f as any)[k];
  if (omit.includes("quarter")) f.quarter = "all";
  const nf = normalizeFilters(f, today);
  return { nf, rows: applyFilters(facts, nf) };
}

export function overview(facts: LeadFact[], q: URLSearchParams, today: string) {
  const { nf, rows } = filtered(facts, q, today);
  const cur = nf.quarter ? parseQuarterKey(nf.quarter) : null;
  const prevKey = cur ? previousQuarter(cur) : null;
  let previous = null;
  if (prevKey) {
    const { rows: all } = filtered(facts, q, today, ["quarter"]);
    previous = quarterMetrics(all, prevKey, today);
  }
  const current = cur ? quarterMetrics(rows, cur, today) : null;
  return {
    filters: nf,
    hot: temperatureSummary(rows, "Hot"),
    warm: temperatureSummary(rows, "Warm"),
    categories: categoryBreakdown(rows),
    sdrs: sdrTable(rows, nf),
    regions: regionBreakdown(rows),
    totals: {
      registrations: rows.length,
      events: new Set(rows.map((f) => f.eventId)).size,
      eligible: rows.filter(BUCKETS.eligible).length,
      ineligible: rows.filter(BUCKETS.ineligible).length,
      attention: rows.filter(BUCKETS.attention).length,
    },
    comparison: current && previous ? { current, previous } : null,
  };
}

export function leads(facts: LeadFact[], q: URLSearchParams, today: string, rules: Rules) {
  const { nf, rows } = filtered(facts, q, today);
  const bucket = (q.get("bucket") || "").trim();
  const list = bucket ? rows.filter((f) => inBucket(f, bucket)) : rows;
  list.sort((a, b) => b.priority - a.priority || (a.eventDate ?? "").localeCompare(b.eventDate ?? ""));
  const limit = Math.min(5000, Number(q.get("limit") || 1000));
  return {
    filters: nf, bucket: bucket || null, total: list.length,
    rows: list.slice(0, limit).map((f) => ({ ...f, nextAction: nextAction(f, rules), statusLabel: STATUS_LABEL[f.status] })),
  };
}

export function sdrs(facts: LeadFact[], q: URLSearchParams, today: string) {
  const { nf, rows } = filtered(facts, q, today);
  return { filters: nf, rows: sdrTable(rows, nf) };
}

export function accounts(facts: LeadFact[], q: URLSearchParams, today: string, rules: Rules) {
  const { nf, rows } = filtered(facts, q, today);
  const health = (q.get("health") || "").trim();
  let list = accountQueue(rows, rules);
  if (health) list = list.filter((a) => a.health === health);
  const limit = Math.min(1000, Number(q.get("limit") || 300));
  return {
    filters: nf, total: list.length,
    rows: list.slice(0, limit).map((a) => ({
      ...a,
      healthLabel: STATUS_LABEL[a.health],
      contacts: a.contacts.map((c) => ({
        contactId: c.contactId, contactName: c.contactName, contactEmail: c.contactEmail, jobTitle: c.jobTitle, eventId: c.eventId, eventName: c.eventName,
        eventDate: c.eventDate, temperature: c.temperature, status: c.status, statusLabel: STATUS_LABEL[c.status], statusReason: c.statusReason,
        touches: c.touchesSinceEligibility, lastTouchAt: c.lastTouchAt, nextTaskDue: c.nextTaskDue, attendance: c.attendance, nextAction: nextAction(c, rules),
      })),
    })),
  };
}

export function events(facts: LeadFact[], q: URLSearchParams, today: string) {
  const { nf, rows } = filtered(facts, q, today);
  const list = eventSummaries(rows);
  const groups = (["owned", "sponsored", "webinar", "roundtable", "uncategorized"] as EventCategory[]).map((c) => ({
    category: c, label: CATEGORY_LABEL[c],
    upcoming: list.filter((e) => e.category === c && e.upcoming).sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "")),
    past: list.filter((e) => e.category === c && !e.upcoming),
  })).filter((g) => g.upcoming.length || g.past.length);
  return { filters: nf, groups };
}

export function eventDetail(facts: LeadFact[], eventId: string, rules: Rules) {
  const rows = facts.filter((f) => f.eventId === eventId);
  if (!rows.length) return null;
  const [summary] = eventSummaries(rows);
  return {
    summary,
    leads: rows.sort((a, b) => b.priority - a.priority).map((f) => ({ ...f, nextAction: nextAction(f, rules), statusLabel: STATUS_LABEL[f.status] })),
  };
}

export function performance(facts: LeadFact[], q: URLSearchParams, today: string) {
  // QoQ ignores the quarter filter (it IS the quarter comparison) but honours every other filter.
  const { nf, rows } = filtered(facts, q, today, ["quarter"]);
  const quarters = qoq(rows, today, 5);
  const byCategory = (["owned", "sponsored", "webinar", "roundtable"] as EventCategory[]).map((c) => ({
    category: c, label: CATEGORY_LABEL[c],
    quarters: quarters.map((qq) => quarterMetrics(rows.filter((f) => f.eventCategory === c), parseQuarterKey(qq.key)!, today)),
  }));
  const bySdr = SDR_ROSTER.filter((s) => (!nf.region || s.region === nf.region) && (!nf.sdr || s.ownerId === nf.sdr)).map((s) => ({
    ownerId: s.ownerId, name: s.name, region: s.region,
    quarters: quarters.map((qq) => quarterMetrics(rows.filter((f) => f.sdrOwnerId === s.ownerId), parseQuarterKey(qq.key)!, today)),
  }));
  return { filters: nf, quarters, byCategory, bySdr };
}

export function quality(facts: LeadFact[], q: URLSearchParams, today: string) {
  const { nf, rows } = filtered(facts, q, today, ["region", "sdr"]);
  const flag = (q.get("flag") || "").trim();
  const dq = dataQuality(rows);
  const list = flag ? rows.filter((f) => f.dataQuality.includes(flag)) : [];
  return {
    filters: nf, ...dq,
    unmappedSdrs: Object.entries(dq.unmappedSdrs).map(([id, n]) => ({ ownerId: id, count: n })),
    ineligibleReasons: countBy(rows.filter((f) => !f.eligible), (f) => f.ineligibleReason ?? "Unknown"),
    attendanceSuspect: eventSummaries(rows).filter((e) => e.attendanceSuspect).map((e) => ({ eventId: e.eventId, name: e.name, registered: e.registered })),
    flagRows: list.slice(0, 1000).map((f) => ({
      eventId: f.eventId, eventName: f.eventName, contactId: f.contactId, contactName: f.contactName, companyId: f.companyId, companyName: f.companyName,
      sdrOwnerRaw: f.sdrOwnerRaw, temperatureRaw: f.temperatureRaw, icpTier: f.icpTier, flags: f.dataQuality,
    })),
  };
}

function countBy<T>(xs: T[], key: (x: T) => string) {
  const o: Record<string, number> = {};
  for (const x of xs) o[key(x)] = (o[key(x)] ?? 0) + 1;
  return Object.entries(o).map(([k, v]) => ({ key: k, count: v })).sort((a, b) => b.count - a.count);
}

export function metaFor(facts: LeadFact[], today: string) {
  const evs = new Map<string, { id: string; name: string; date: string | null; category: string }>();
  for (const f of facts) if (!evs.has(f.eventId)) evs.set(f.eventId, { id: f.eventId, name: f.eventName, date: f.eventDate, category: f.eventCategory });
  const quarters = [...new Set(facts.map((f) => f.fiscalQuarter).filter((x): x is string => !!x))].sort().reverse();
  return {
    today,
    currentQuarter: fiscalQuarterOf(today),
    quarters: quarters.map((k) => ({ key: k, label: parseQuarterKey(k)!.label })),
    events: [...evs.values()].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "")),
    roster: SDR_ROSTER,
    icpTiers: [...new Set(facts.map((f) => f.icpTier).filter((x): x is string => !!x))].sort(),
    statuses: Object.entries(STATUS_LABEL).map(([key, label]) => ({ key, label })),
    categories: Object.entries(CATEGORY_LABEL).map(([key, label]) => ({ key, label })),
  };
}

export const sdrName = (id: string | null) => (id ? rosterById.get(id)?.name ?? null : null);
export type { NormalizedFilters };
