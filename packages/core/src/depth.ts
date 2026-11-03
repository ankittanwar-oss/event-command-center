import { rosterById, type Rules } from "./config.js";
import { daysBetween, isoWeek, toDate } from "./dates.js";
import type { LeadFact, Temperature } from "./types.js";

// ---------------------------------------------------------------------------------------------------------------
// Touch depth and consistency. Counts only qualifying outbound SDR touches (same rules as everywhere else).
//  - Contact-level: touches logged on that contact.
//  - Account-level: DISTINCT HubSpot activity ids across the account's eligible contacts, so one email to three
//    contacts is one account touch (and one contact touch for each of the three).
// Coverage and depth are separate fields; there is no blended score.
// ---------------------------------------------------------------------------------------------------------------

export type TouchWindow = "eligibility" | "allocation" | "event" | "period";
export const WINDOW_LABEL: Record<TouchWindow, string> = {
  eligibility: "Since eligibility (later of event and allocation)",
  allocation: "Since SDR allocation",
  event: "Since the event",
  period: "Within the reporting period",
};

export const BANDS = [
  { key: "b0", label: "0", min: 0, max: 0 },
  { key: "b1", label: "1", min: 1, max: 1 },
  { key: "b23", label: "2–3", min: 2, max: 3 },
  { key: "b45", label: "4–5", min: 4, max: 5 },
  { key: "b67", label: "6–7", min: 6, max: 7 },
  { key: "b8", label: "8+", min: 8, max: Number.MAX_SAFE_INTEGER },
] as const;

/** Touches for one lead in a window. Returns null when the window cannot be determined (e.g. allocation date missing). */
export function windowTouches(f: LeadFact, w: TouchWindow, period: { start: string; end: string } | null): Array<{ id: string; ts: string }> | null {
  const all = (f.allTouchIds ?? f.touchIds).map((id, i) => ({ id, ts: (f.allTouchDates ?? f.touchDates)[i]! }));
  const day = (t: { ts: string }) => toDate(t.ts)!;
  switch (w) {
    // Same set as touchesSinceEligibility (includes the current SDR's own touches made before a later allocation date).
    case "eligibility": return f.eligibilityDate ? f.touchIds.map((id, i) => ({ id, ts: f.touchDates[i]! })) : null;
    case "allocation": return f.allocationDate ? all.filter((t) => day(t) >= f.allocationDate!) : null;
    case "event": return f.eventDate ? all.filter((t) => day(t) >= f.eventDate!) : null;
    case "period": return period ? all.filter((t) => day(t) >= period.start && day(t) <= period.end) : all;
  }
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);
const r1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);

/** Where a lead stands against the configurable 6–7 touch target. Progress only unless a window is configured. */
export function targetStatus(f: LeadFact, touches: number, rules: Rules): "achieved" | "in_progress" | "behind" | "not_applicable" {
  if (!f.eligible || f.status === "in_play" || f.status === "recently_lost") return "not_applicable";
  if (touches >= rules.touchTarget.minimum) return "achieved";
  const w = rules.touchTarget.windowDays;
  if (w === null || f.ageDays === null || f.ageDays < w) return "in_progress";
  return "behind";
}

export function depthStats(rows: LeadFact[], rules: Rules, w: TouchWindow, period: { start: string; end: string } | null) {
  const leads = rows.filter((f) => f.eligible);
  const perLead: Array<{ f: LeadFact; n: number; days: string[] }> = [];
  let missingWindow = 0;
  for (const f of leads) {
    const t = windowTouches(f, w, period);
    if (!t) { missingWindow++; continue; }
    perLead.push({ f, n: t.length, days: [...new Set(t.map((x) => toDate(x.ts)!))].sort() });
  }
  // account level: distinct activity ids per account
  const acct = new Map<string, Set<string>>();
  for (const f of leads) {
    const key = f.companyId ?? `c:${f.contactId}`;
    const s = acct.get(key) ?? acct.set(key, new Set()).get(key)!;
    for (const t of windowTouches(f, w, period) ?? []) s.add(t.id);
  }
  const accountTouches = [...acct.values()].reduce((a, s) => a + s.size, 0);
  const allIds = new Set([...acct.values()].flatMap((s) => [...s]));
  const contactTouchSum = perLead.reduce((a, x) => a + x.n, 0);
  const bands = Object.fromEntries(BANDS.map((b) => [b.key, perLead.filter((x) => x.n >= b.min && x.n <= b.max).length])) as Record<(typeof BANDS)[number]["key"], number>;
  const accountBands = Object.fromEntries(BANDS.map((b) => [b.key, [...acct.values()].filter((s) => s.size >= b.min && s.size <= b.max).length])) as Record<(typeof BANDS)[number]["key"], number>;
  const touched = perLead.filter((x) => x.n > 0);
  const gaps = touched.flatMap((x) => x.days.slice(1).map((d, i) => daysBetween(x.days[i]!, d)));
  const mature14 = leads.filter((f) => (f.ageDays ?? 0) >= 14 && f.status !== "in_play");
  const targetMin = rules.touchTarget.minimum;
  const tgt = perLead.map((x) => targetStatus(x.f, x.n, rules));
  return {
    window: w,
    accounts: acct.size,
    hotLeads: leads.filter((f) => f.temperature === "Hot").length,
    warmLeads: leads.filter((f) => f.temperature === "Warm").length,
    leads: leads.length,
    measuredLeads: perLead.length,
    missingWindow,                              // leads excluded because the window start is unknown (e.g. no allocation date)
    totalTouches: allIds.size,                  // distinct activities (account-level, no double counting)
    contactTouches: contactTouchSum,            // sum of contact-level touches
    avgPerAccount: r1(acct.size ? accountTouches / acct.size : null),
    avgPerLead: r1(perLead.length ? contactTouchSum / perLead.length : null),
    bands, accountBands,
    bandPct: Object.fromEntries(Object.entries(bands).map(([k, v]) => [k, pct(v, perLead.length)])),
    atTargetPct: pct(perLead.filter((x) => x.n >= targetMin).length, perLead.length),
    oneTouchPct: pct(bands.b1, perLead.length),
    untouchedAccounts: [...acct.values()].filter((s) => s.size === 0).length,
    multiWeekPct: pct(mature14.filter((f) => f.multiWeek).length, mature14.length),
    distinctDaysAvg: r1(touched.length ? touched.reduce((a, x) => a + x.days.length, 0) / touched.length : null),
    avgGap: r1(gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null),
    maxGap: gaps.length ? Math.max(...gaps) : null,
    daysToFirstAvg: r1(avgOf(leads.map((f) => f.businessDaysToFirstTouch))),
    daysSinceLastMin: minOf(leads.map((f) => f.daysSinceLastTouch)),
    overdue: leads.filter((f) => f.status === "never_worked" && f.firstTouchOverdue).length,
    stalled: leads.filter((f) => f.status === "stalled").length,
    target: { achieved: tgt.filter((t) => t === "achieved").length, inProgress: tgt.filter((t) => t === "in_progress").length, behind: tgt.filter((t) => t === "behind").length },
    // concentration: share of all contact touches that went to the most-touched 25% of leads
    top25Share: concentration(perLead.map((x) => x.n)),
  };
}

function avgOf(xs: Array<number | null>) { const v = xs.filter((x): x is number => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; }
function minOf(xs: Array<number | null>) { const v = xs.filter((x): x is number => x !== null); return v.length ? Math.min(...v) : null; }
function concentration(ns: number[]): number | null {
  const total = ns.reduce((a, b) => a + b, 0);
  if (!total || ns.length < 4) return null;
  const top = [...ns].sort((a, b) => b - a).slice(0, Math.ceil(ns.length / 4)).reduce((a, b) => a + b, 0);
  return Math.round((top / total) * 1000) / 10;
}

export function sdrDepth(rows: LeadFact[], ownerId: string, rules: Rules, w: TouchWindow, period: { start: string; end: string } | null) {
  const mine = rows.filter((f) => f.sdrOwnerId === ownerId);
  const s = rosterById.get(ownerId)!;
  return {
    ownerId, name: s.name, region: s.region,
    all: depthStats(mine, rules, w, period),
    Hot: depthStats(mine.filter((f) => f.temperature === "Hot"), rules, w, period),
    Warm: depthStats(mine.filter((f) => f.temperature === ("Warm" as Temperature)), rules, w, period),
  };
}

/** Per-account depth for the account queue (distinct activity ids across the account's eligible contacts). */
export function accountDepth(leads: LeadFact[], w: TouchWindow, period: { start: string; end: string } | null) {
  const ids = new Set<string>();
  const days = new Set<string>();
  for (const f of leads) for (const t of windowTouches(f, w, period) ?? []) { ids.add(t.id); days.add(toDate(t.ts)!); }
  const sorted = [...days].sort();
  return { touches: ids.size, distinctDays: sorted.length, distinctWeeks: new Set(sorted.map(isoWeek)).size };
}
