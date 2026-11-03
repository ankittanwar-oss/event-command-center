import { rosterById, rosterForRegion, SDR_ROSTER, type Rules } from "./config.js";
import { addDays, businessDaysBetween, fiscalQuarterOf, parseQuarterKey, quarterIsComplete, quartersBetween, toDate, type FiscalQuarter } from "./dates.js";
import { CATEGORY_LABEL } from "./events.js";
import type { EventCategory, FollowUpStatus, LeadFact, Region, Temperature } from "./types.js";

// ---------------------------------------------------------------------------------------------------------------
// Filters. Applied to the record set BEFORE any KPI is calculated, so every number and every drilldown share
// the same population.
// ---------------------------------------------------------------------------------------------------------------

export interface Filters {
  quarter?: string;              // "this" | "all" | "FY2027-Q2" | "FY2027"
  region?: Region | "";
  sdr?: string;                  // HubSpot owner id
  eventId?: string;
  category?: EventCategory | "";
  temperature?: Temperature | "";
  status?: FollowUpStatus | "";
  attendance?: string;
  icpTier?: string;
  search?: string;
}

export interface NormalizedFilters extends Filters {
  /** True when the requested SDR did not belong to the requested region and was therefore cleared. */
  sdrCleared: boolean;
  quarterRange: { start: string; end: string } | null;
  quarterLabel: string;
}

export function normalizeFilters(f: Filters, today: string): NormalizedFilters {
  const out: NormalizedFilters = { ...f, sdrCleared: false, quarterRange: null, quarterLabel: "All quarters" };
  if (out.region && out.sdr && rosterById.get(out.sdr)?.region !== out.region) { out.sdr = ""; out.sdrCleared = true; }
  if (out.sdr && !rosterById.has(out.sdr)) { out.sdr = ""; out.sdrCleared = true; }
  const q = (out.quarter || "this").trim();
  if (q === "this") {
    const cq = fiscalQuarterOf(today);
    out.quarter = cq.key; out.quarterRange = { start: cq.start, end: cq.end }; out.quarterLabel = cq.label;
  } else if (/^FY\d{4}$/.test(q)) {
    const fy = Number(q.slice(2));
    out.quarterRange = { start: `${fy - 1}-05-01`, end: `${fy}-04-30` }; out.quarterLabel = `FY${fy} (May ${fy - 1} – Apr ${fy})`;
  } else if (q !== "all") {
    const fq = parseQuarterKey(q);
    if (fq) { out.quarterRange = { start: fq.start, end: fq.end }; out.quarterLabel = fq.label; }
  } else out.quarter = "all";
  return out;
}

export function applyFilters(facts: LeadFact[], nf: NormalizedFilters): LeadFact[] {
  const s = (nf.search || "").trim().toLowerCase();
  return facts.filter((f) => {
    // Picking specific events overrides the quarter filter (events are chosen explicitly).
    if (!nf.eventId && nf.quarterRange && (!f.eventDate || f.eventDate < nf.quarterRange.start || f.eventDate > nf.quarterRange.end)) return false;
    if (nf.region && f.sdrRegion !== nf.region) return false;
    if (nf.sdr && f.sdrOwnerId !== nf.sdr) return false;
    if (nf.eventId && !nf.eventId.split(",").includes(f.eventId)) return false;
    if (nf.category && f.eventCategory !== nf.category) return false;
    if (nf.temperature && f.temperature !== nf.temperature) return false;
    if (nf.status && f.status !== nf.status) return false;
    if (nf.attendance && f.attendance !== nf.attendance) return false;
    if (nf.icpTier && f.icpTier !== nf.icpTier) return false;
    if (s && !`${f.contactName} ${f.contactEmail ?? ""} ${f.companyName ?? ""} ${f.eventName}`.toLowerCase().includes(s)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Buckets: every KPI is a named predicate. The same predicate drives the count and the drilldown list, so a
// number can always be reconciled with the records behind it.
// ---------------------------------------------------------------------------------------------------------------

export const BUCKETS = {
  eligible: (f: LeadFact) => f.eligible,
  worked: (f: LeadFact) => f.eligible && f.touchesSinceEligibility > 0,
  never_worked: (f: LeadFact) => f.eligible && f.status === "never_worked",
  overdue: (f: LeadFact) => f.eligible && f.status === "never_worked" && f.firstTouchOverdue,
  insufficient: (f: LeadFact) => f.eligible && f.insufficientFollowUp,
  active: (f: LeadFact) => f.eligible && f.status === "active",
  first_touch: (f: LeadFact) => f.eligible && f.status === "first_touch",
  stalled: (f: LeadFact) => f.eligible && f.status === "stalled",
  in_play: (f: LeadFact) => f.eligible && f.status === "in_play",
  unverifiable: (f: LeadFact) => f.eligible && f.status === "unverifiable",
  recently_lost: (f: LeadFact) => f.eligible && f.status === "recently_lost",
  one_touch: (f: LeadFact) => f.eligible && f.touchesSinceEligibility === 1,
  multi_touch: (f: LeadFact) => f.eligible && f.touchesSinceEligibility >= 2,
  untouched: (f: LeadFact) => f.eligible && f.touchesSinceEligibility === 0,
  in_play_touched: (f: LeadFact) => f.eligible && f.status === "in_play" && f.touchesSinceEligibility > 0,
  in_play_untouched: (f: LeadFact) => f.eligible && f.status === "in_play" && f.touchesSinceEligibility === 0,
  one_touch_due: (f: LeadFact) => f.eligible && f.status === "first_touch" && f.insufficientFollowUp && f.touchesSinceEligibility === 1,
  multi_week: (f: LeadFact) => f.eligible && f.multiWeek,
  sla_met: (f: LeadFact) => f.eligible && f.firstTouchSlaMet === true,
  sla_missed: (f: LeadFact) => f.eligible && f.firstTouchSlaMet === false,
  attention: (f: LeadFact) => f.eligible && ((f.status === "never_worked" && f.firstTouchOverdue) || f.status === "stalled"),
  no_next_step: (f: LeadFact) => f.eligible && f.touchesSinceEligibility > 0 && !f.hasNextStep && f.status !== "in_play",
  ineligible: (f: LeadFact) => !f.eligible,
  registered: (_f: LeadFact) => true,
  attended: (f: LeadFact) => f.attendance === "attended",
  no_show: (f: LeadFact) => f.attendance === "no_show",
  attendance_unknown: (f: LeadFact) => f.attendance === "unknown",
} satisfies Record<string, (f: LeadFact) => boolean>;

export type BucketKey = keyof typeof BUCKETS;

export function inBucket(f: LeadFact, key: string): boolean {
  const fn = (BUCKETS as Record<string, (f: LeadFact) => boolean>)[key];
  return fn ? fn(f) : false;
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);
const count = (rows: LeadFact[], key: BucketKey) => rows.reduce((n, f) => n + (BUCKETS[key](f) ? 1 : 0), 0);

export interface Metric { count: number; pct: number | null; denominator: number; bucket: BucketKey }

function metric(rows: LeadFact[], key: BucketKey, denomKey: BucketKey = "eligible"): Metric {
  const d = count(rows, denomKey);
  const n = count(rows, key);
  return { count: n, pct: pct(n, d), denominator: d, bucket: key };
}

export function temperatureSummary(rows: LeadFact[], temp: Temperature) {
  const r = rows.filter((f) => f.temperature === temp);
  const eligible = count(r, "eligible");
  return {
    temperature: temp,
    eligible,
    uniqueContacts: new Set(r.filter((f) => f.eligible).map((f) => f.contactId)).size,
    worked: metric(r, "worked"),
    neverWorked: metric(r, "never_worked"),
    overdue: metric(r, "overdue"),
    insufficient: metric(r, "insufficient"),
    active: metric(r, "active"),
    stalled: metric(r, "stalled"),
    inPlay: metric(r, "in_play"),
    unverifiable: metric(r, "unverifiable"),
    recentlyLost: metric(r, "recently_lost"),
    multiTouch: metric(r, "multi_touch"),
    oneTouch: metric(r, "one_touch"),
    untouched: metric(r, "untouched"),
    inPlayTouched: metric(r, "in_play_touched"),
    inPlayUntouched: metric(r, "in_play_untouched"),
  };
}

export function categoryBreakdown(rows: LeadFact[]) {
  const cats: EventCategory[] = ["owned", "sponsored", "webinar", "roundtable"];
  if (rows.some((f) => f.eventCategory === "uncategorized")) cats.push("uncategorized");
  return cats.map((c) => {
    const r = rows.filter((f) => f.eventCategory === c);
    const hot = r.filter((f) => f.temperature === "Hot");
    const warm = r.filter((f) => f.temperature === "Warm");
    return {
      category: c, label: CATEGORY_LABEL[c],
      events: new Set(r.map((f) => f.eventId)).size,
      hotLeads: count(hot, "eligible"), hotWorked: count(hot, "worked"), hotCoverage: pct(count(hot, "worked"), count(hot, "eligible")),
      warmLeads: count(warm, "eligible"), warmWorked: count(warm, "worked"), warmCoverage: pct(count(warm, "worked"), count(warm, "eligible")),
    };
  });
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
const round1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);

/**
 * Coverage and depth are reported side by side and never blended into one score.
 * Depth is age-adjusted: multi-week share uses leads eligible for at least 14 days, and "touches in first 30 days"
 * uses leads eligible for at least 30 days, so recent leads don't drag down (or flatter) an SDR.
 */
export function sdrRow(rows: LeadFact[], ownerId: string) {
  const r = rows.filter((f) => f.sdrOwnerId === ownerId && f.eligible);
  const hot = r.filter((f) => f.temperature === "Hot");
  const warm = r.filter((f) => f.temperature === "Warm");
  const touched = r.filter((f) => f.touchesSinceEligibility > 0);
  const touches = r.map((f) => f.touchesSinceEligibility);
  const mature14 = r.filter((f) => (f.ageDays ?? 0) >= 14 && f.status !== "in_play");
  const mature30 = r.filter((f) => (f.ageDays ?? 0) >= 30 && f.status !== "in_play");
  const slaRate = (x: LeadFact[]) => {
    const met = x.filter((f) => f.firstTouchSlaMet === true).length;
    const decided = x.filter((f) => f.firstTouchSlaMet !== null).length;
    return { met, decided, pct: pct(met, decided) };
  };
  const dist = (lo: number, hi: number) => pct(touched.filter((f) => f.touchesSinceEligibility >= lo && f.touchesSinceEligibility <= hi).length, touched.length);
  const last = r.map((f) => f.daysSinceLastTouch).filter((x): x is number => x !== null);
  const sdr = rosterById.get(ownerId)!;
  return {
    ownerId, name: sdr.name, region: sdr.region,
    hotAssigned: hot.length, warmAssigned: warm.length,
    hotContacted: hot.filter((f) => f.touchesSinceEligibility > 0).length,
    warmContacted: warm.filter((f) => f.touchesSinceEligibility > 0).length,
    hotCoverage: pct(hot.filter((f) => f.touchesSinceEligibility > 0).length, hot.length),
    warmCoverage: pct(warm.filter((f) => f.touchesSinceEligibility > 0).length, warm.length),
    hotSla: slaRate(hot), warmSla: slaRate(warm),
    avgTouches: round1(touches.length ? touches.reduce((a, b) => a + b, 0) / touches.length : null),
    medianTouches: median(touches),
    avgTouchesFirst30: round1(mature30.length ? mature30.reduce((a, f) => a + f.touchesFirst30Days, 0) / mature30.length : null),
    mature30Leads: mature30.length,
    oneTouchPct: dist(1, 1), twoToThreePct: dist(2, 3), fourToSevenPct: dist(4, 7), eightPlusPct: dist(8, Number.MAX_SAFE_INTEGER),
    oneTouchOnly: touched.filter((f) => f.touchesSinceEligibility === 1 && f.status !== "in_play").length,
    multiWeekPct: pct(mature14.filter((f) => f.multiWeek).length, mature14.length),
    mature14Leads: mature14.length,
    nextStepPct: pct(touched.filter((f) => f.hasNextStep).length, touched.length),
    daysSinceLastOutreach: last.length ? Math.min(...last) : null,
    neverWorked: r.filter((f) => f.status === "never_worked").length,
    overdue: r.filter((f) => f.status === "never_worked" && f.firstTouchOverdue).length,
    stalled: r.filter((f) => f.status === "stalled").length,
    attention: r.filter((f) => BUCKETS.attention(f)).length,
    active: r.filter((f) => f.status === "active").length,
    inPlay: r.filter((f) => f.status === "in_play").length,
  };
}

export function sdrTable(rows: LeadFact[], nf: NormalizedFilters) {
  const roster = rosterForRegion((nf.region as Region) || null).filter((s) => !nf.sdr || s.ownerId === nf.sdr);
  return roster.map((s) => sdrRow(rows, s.ownerId));
}

// ---------------------------------------------------------------------------------------------------------------
// Next action and account-first queue
// ---------------------------------------------------------------------------------------------------------------

export function nextAction(f: LeadFact, rules: Rules): string {
  if (!f.eligible) return f.ineligibleReason ? `Excluded: ${f.ineligibleReason}` : "Excluded";
  const rule = rules.cadence[f.temperature ?? "Warm"];
  switch (f.status) {
    case "never_worked": {
      if (f.firstTouchOverdue) return "First touch overdue – reach out today";
      const due = f.eligibilityDate ? addBusinessDays(f.eligibilityDate, rule.firstTouchBusinessDays, rules) : null;
      return due ? `First touch due by ${due}` : "Make first touch";
    }
    case "stalled": return `Resume outreach – last touch ${f.daysSinceLastTouch} days ago`;
    case "first_touch": return `Continue cadence – ${f.touchesSinceEligibility} of ${Math.max(f.expectedTouches, 2)} expected touches`;
    case "active": return f.hasNextStep ? "On track – keep cadence" : "On track – schedule the next step";
    case "in_play": return f.inPlayReason ?? "In play";
    case "unverifiable": return f.companyOutreachOnly ? "Log outreach against the contact in HubSpot" : "Check HubSpot data";
    case "recently_lost": return f.recentlyLost ? `Account closed lost ${f.recentlyLost.closedAt.slice(0, 10)}; no SLA, re-engage when appropriate` : "Recently closed lost";
  }
}

function addBusinessDays(day: string, n: number, rules: Rules): string {
  let d = day;
  while (businessDaysBetween(day, d, rules.businessCalendar) < n) d = addDays(d, 1);
  return d;
}

const HEALTH_ORDER: FollowUpStatus[] = ["never_worked", "stalled", "unverifiable", "first_touch", "recently_lost", "active", "in_play"];

export function accountQueue(rows: LeadFact[], rules: Rules) {
  const byCompany = new Map<string, LeadFact[]>();
  for (const f of rows) {
    if (!f.eligible) continue;
    const key = f.companyId ?? `contact:${f.contactId}`;
    (byCompany.get(key) ?? byCompany.set(key, []).get(key)!).push(f);
  }
  const out = [...byCompany.entries()].map(([companyId, leads]) => {
    leads.sort((a, b) => b.priority - a.priority);
    const touchIds = new Set(leads.flatMap((l) => l.touchIds));
    const lastTouch = leads.map((l) => l.lastTouchAt).filter(Boolean).sort().pop() ?? null;
    const worst = HEALTH_ORDER.find((s) => leads.some((l) => l.status === s)) ?? "active";
    const top = leads[0]!;
    return {
      companyId: companyId.startsWith("contact:") ? null : companyId,
      companyName: top.companyName,
      events: [...new Map(leads.map((l) => [l.eventId, { id: l.eventId, name: l.eventName, date: l.eventDate }])).values()],
      sdrOwnerId: top.sdrOwnerId,
      sdrName: top.sdrOwnerId ? rosterById.get(top.sdrOwnerId)?.name ?? null : null,
      icpTier: top.icpTier,
      temperature: leads.some((l) => l.temperature === "Hot") ? "Hot" : leads.some((l) => l.temperature === "Warm") ? "Warm" : (leads.find((l) => l.temperatureRaw)?.temperatureRaw ?? "Not set"),
      eligibleContacts: new Set(leads.map((l) => l.contactId)).size,
      contactsWorked: new Set(leads.filter((l) => l.touchesSinceEligibility > 0).map((l) => l.contactId)).size,
      touches: touchIds.size,
      lastTouch,
      health: worst,
      nextAction: nextAction(leads.find((l) => l.status === worst) ?? top, rules),
      priority: Math.max(...leads.map((l) => l.priority)),
      contacts: leads,
    };
  });
  out.sort((a, b) => b.priority - a.priority || (a.companyName ?? "").localeCompare(b.companyName ?? ""));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------------------------

export function eventSummaries(rows: LeadFact[]) {
  const byEvent = new Map<string, LeadFact[]>();
  for (const f of rows) (byEvent.get(f.eventId) ?? byEvent.set(f.eventId, []).get(f.eventId)!).push(f);
  return [...byEvent.values()].map((r) => {
    const f0 = r[0]!;
    const el = r.filter((f) => f.eligible);
    const hot = el.filter((f) => f.temperature === "Hot");
    const warm = el.filter((f) => f.temperature === "Warm");
    const worked = el.filter((f) => f.touchesSinceEligibility > 0);
    const touchedTotal = worked.reduce((a, f) => a + f.touchesSinceEligibility, 0);
    const attended = r.filter((f) => f.attendance === "attended").length;
    const attendanceRecorded = r.some((f) => f.attendance !== "unknown");
    return {
      eventId: f0.eventId, name: f0.eventName, date: f0.eventDate, category: f0.eventCategory, quarter: f0.fiscalQuarter,
      upcoming: f0.isUpcoming,
      registered: r.length,
      attended, noShow: r.filter((f) => f.attendance === "no_show").length, attendanceUnknown: r.filter((f) => f.attendance === "unknown").length,
      attendanceRate: attendanceRecorded ? pct(attended, r.length) : null,
      attendanceSuspect: attendanceRecorded && r.length >= 50 && attended === r.length,
      targetable: r.filter((f) => !!f.icpTier && !/low fit|non - icp|not fit/i.test(f.icpTier)).length,
      sdrAssigned: r.filter((f) => !!f.sdrOwnerId).length,
      preEventOutreach: r.filter((f) => f.preEventTouches > 0).length,
      unworkedPriority: r.filter((f) => f.icpPriority && f.preEventTouches === 0 && !!f.sdrOwnerId).length,
      existingConversations: r.filter((f) => f.priorConversation).length,
      eligibleHot: hot.length, eligibleWarm: warm.length,
      hotWorked: hot.filter((f) => f.touchesSinceEligibility > 0).length,
      warmWorked: warm.filter((f) => f.touchesSinceEligibility > 0).length,
      coverage: pct(worked.length, el.length),
      avgTouches: round1(worked.length ? touchedTotal / worked.length : null),
      slaBreaches: el.filter((f) => f.firstTouchSlaMet === false).length,
      neverWorked: el.filter((f) => f.status === "never_worked").length,
      stalled: el.filter((f) => f.status === "stalled").length,
      multiWeek: el.filter((f) => f.multiWeek).length,
      opportunities: new Set(r.flatMap((f) => f.attributedDeals)).size,
      sqls: new Set(r.flatMap((f) => f.sqlDeals)).size,
      tierCounts: countBy(r, (f) => f.icpTier ?? "Missing"),
    };
  }).sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
}

function countBy<T>(xs: T[], key: (x: T) => string): Record<string, number> {
  const o: Record<string, number> = {};
  for (const x of xs) o[key(x)] = (o[key(x)] ?? 0) + 1;
  return o;
}

// ---------------------------------------------------------------------------------------------------------------
// Quarter-over-quarter. Depth comparisons are age-normalised (first 30 days after eligibility, leads >= 30 days old).
// ---------------------------------------------------------------------------------------------------------------

export function quarterMetrics(rows: LeadFact[], q: FiscalQuarter, today: string) {
  const r = rows.filter((f) => f.eventDate && f.eventDate >= q.start && f.eventDate <= q.end && !f.isUpcoming);
  const el = r.filter((f) => f.eligible);
  const mature = el.filter((f) => (f.ageDays ?? 0) >= 30 && f.status !== "in_play");
  const decided = el.filter((f) => f.firstTouchSlaMet !== null);
  const recorded = r.filter((f) => f.attendance !== "unknown");
  return {
    key: q.key, label: q.label, complete: quarterIsComplete(q, today),
    events: new Set(r.map((f) => f.eventId)).size,
    registered: r.length,
    attendanceRate: pct(recorded.filter((f) => f.attendance === "attended").length, recorded.length),
    eligible: el.length,
    hot: el.filter((f) => f.temperature === "Hot").length,
    warm: el.filter((f) => f.temperature === "Warm").length,
    coverage: pct(el.filter((f) => f.touchesSinceEligibility > 0).length, el.length),
    slaCompliance: pct(decided.filter((f) => f.firstTouchSlaMet).length, decided.length),
    avgTouchesFirst30: round1(mature.length ? mature.reduce((a, f) => a + f.touchesFirst30Days, 0) / mature.length : null),
    multiWeekPct: pct(mature.filter((f) => f.multiWeek).length, mature.length),
    matureLeads: mature.length,
    opportunities: new Set(r.flatMap((f) => f.attributedDeals)).size,
    sqls: new Set(r.flatMap((f) => f.sqlDeals)).size,
  };
}

export function qoq(rows: LeadFact[], today: string, howMany = 4) {
  const dates = rows.map((f) => f.eventDate).filter((d): d is string => !!d && d <= today).sort();
  if (!dates.length) return [];
  return quartersBetween(dates[0]!, today).slice(0, howMany).map((q) => quarterMetrics(rows, q, today));
}

export function regionBreakdown(rows: LeadFact[]) {
  return (["NAM", "EMEA", "APAC"] as Region[]).map((region) => {
    const el = rows.filter((f) => f.eligible && f.sdrRegion === region);
    return {
      region,
      eligible: el.length,
      hot: el.filter((f) => f.temperature === "Hot").length,
      warm: el.filter((f) => f.temperature === "Warm").length,
      coverage: pct(el.filter((f) => f.touchesSinceEligibility > 0).length, el.length),
      multiWeekPct: pct(el.filter((f) => f.multiWeek).length, el.filter((f) => (f.ageDays ?? 0) >= 14).length),
    };
  });
}

export function dataQuality(rows: LeadFact[]) {
  const flags = countBy(rows.flatMap((f) => f.dataQuality.map((d) => ({ d }))), (x) => x.d);
  const unmappedSdrs = countBy(rows.filter((f) => f.sdrOwnerRaw && !f.sdrOwnerId), (f) => f.sdrOwnerRaw!);
  const temps = countBy(rows, (f) => f.temperatureRaw ?? "(not set)");
  return { flags, unmappedSdrs, temperatureValues: temps, totalLeads: rows.length };
}

export const ALL_SDRS = SDR_ROSTER;
export { toDate };
