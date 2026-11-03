import { rosterById, type Rules } from "./config.js";
import { CATEGORY_LABEL } from "./events.js";
import type { LeadFact, Temperature } from "./types.js";
import { contactLevelInPlay } from "./worklist.js";

// ---------------------------------------------------------------------------------------------------------------
// Risk levels for presentation. Derived ONLY from the existing follow-up statuses and the existing configured
// thresholds (first-touch SLA, stall threshold, expected cadence). No new thresholds are introduced and no existing
// status, eligibility or metric changes.
//
//   critical  – SLA breached with no outreach (status never_worked + firstTouchOverdue), or follow-up stalled
//               beyond the configured stall threshold (status stalled).  [= the existing "attention" bucket]
//   at_risk   – first touch is due today (business days since eligibility = SLA, still no outreach), or touched but
//               below the expected cadence for the lead's age (existing insufficientFollowUp flag).
//   healthy   – actively worked (status active), or in play with evidence on this contact (meeting, reply, or a
//               deal associated with the contact) after at least one SDR touch. Account-only deals are neutral.
//   neutral   – not enough to judge: outreach not yet due (inside the SLA window), one touch with the next touch
//               not yet due, or activity that cannot be verified on the contact (status unverifiable).
//
// A lead is never "healthy" just because it received one email, and a new lead is never "critical" for missing
// a long-range cadence target. Ineligible leads have no risk level (they are excluded from follow-up).
// ---------------------------------------------------------------------------------------------------------------

export type RiskLevel = "critical" | "at_risk" | "healthy" | "neutral";

export const RISK_LABEL: Record<RiskLevel, string> = {
  critical: "Critical",
  at_risk: "At risk",
  healthy: "Healthy",
  neutral: "Not judged (see reason)",
};

export function riskOf(f: LeadFact, rules: Rules): { level: RiskLevel; reason: string } | null {
  if (!f.eligible) return null;
  const sla = rules.cadence[f.temperature ?? "Warm"].firstTouchBusinessDays;
  switch (f.status) {
    case "never_worked":
      if (f.firstTouchOverdue) return { level: "critical", reason: "First-touch SLA breached, no outreach" };
      if ((f.businessDaysSinceEligibility ?? 0) >= sla) return { level: "at_risk", reason: "First touch due today" };
      return { level: "neutral", reason: "Inside first-touch window" };
    case "stalled":
      return { level: "critical", reason: f.statusReason };
    case "first_touch":
      if (f.insufficientFollowUp) {
        return { level: "at_risk", reason: f.touchesSinceEligibility === 1 ? "One touch only; further outreach is due" : "Below expected cadence for its age" };
      }
      return { level: "neutral", reason: "Early in cadence; next touch not yet due" };
    case "active":
      return { level: "healthy", reason: f.statusReason };
    case "in_play":
      // In play only counts as healthy when the SDR has actually worked the lead. An open deal, meeting or reply
      // with no qualifying SDR touch is shown grey, so "healthy" always means real follow-up happened.
      // An open opportunity that sits only on the account (not on this contact) says nothing about this lead's
      // follow-up, so it is shown grey rather than green.
      if (f.touchesSinceEligibility === 0) return { level: "neutral", reason: `${f.inPlayReason ?? "In play"}, but no SDR touch logged` };
      if (!contactLevelInPlay(f)) return { level: "neutral", reason: `${f.inPlayReason ?? "In play"} on the account (not this contact); follow-up not assessed` };
      return { level: "healthy", reason: f.inPlayReason ?? "In play" };
    case "unverifiable":
      return { level: "neutral", reason: "Activity cannot be verified on the contact" };
    case "recently_lost":
      return { level: "neutral", reason: f.statusReason };
  }
}

export function inRisk(f: LeadFact, level: RiskLevel, rules: Rules): boolean {
  return riskOf(f, rules)?.level === level;
}

export interface RiskCounts { eligible: number; critical: number; at_risk: number; healthy: number; neutral: number }

/** Mutually exclusive counts; critical + at_risk + healthy + neutral always equals eligible. */
export function riskCounts(rows: LeadFact[], rules: Rules): RiskCounts {
  const out: RiskCounts = { eligible: 0, critical: 0, at_risk: 0, healthy: 0, neutral: 0 };
  for (const f of rows) {
    const r = riskOf(f, rules);
    if (!r) continue;
    out.eligible++;
    out[r.level]++;
  }
  return out;
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);

/** Per-SDR risk counts, split by temperature, plus a transparent health rule (no blended score). */
export function sdrRisk(rows: LeadFact[], ownerId: string, rules: Rules) {
  const mine = rows.filter((f) => f.sdrOwnerId === ownerId);
  const hot = riskCounts(mine.filter((f) => f.temperature === "Hot"), rules);
  const warm = riskCounts(mine.filter((f) => f.temperature === "Warm"), rules);
  const all = riskCounts(mine, rules);
  const hotOverdue = mine.filter((f) => f.eligible && f.temperature === "Hot" && f.status === "never_worked" && f.firstTouchOverdue).length;
  const warmOverdue = mine.filter((f) => f.eligible && f.temperature === "Warm" && f.status === "never_worked" && f.firstTouchOverdue).length;
  const oneTouchDue = mine.filter((f) => f.eligible && f.status === "first_touch" && f.insufficientFollowUp && f.touchesSinceEligibility === 1).length;
  const stalled = mine.filter((f) => f.eligible && f.status === "stalled").length;
  // Health rule (shown in the UI legend):
  //   Critical – at least one Hot lead is critical (SLA breached or stalled)
  //   At risk  – any Warm lead is critical, or any lead is at risk
  //   Healthy  – none critical or at risk, and at least one lead healthily engaged
  //   Not yet due – none critical or at risk, and no lead engaged yet (all inside their window / unverified)
  //   No data  – no eligible leads
  const health: RiskLevel | "none" = all.eligible === 0 ? "none" : hot.critical > 0 ? "critical" : warm.critical > 0 || all.at_risk > 0 ? "at_risk" : all.healthy > 0 ? "healthy" : "neutral";
  return { ownerId, hot, warm, all, hotOverdue, warmOverdue, oneTouchDue, stalled, health };
}

// ---------------------------------------------------------------------------------------------------------------
// "Where leadership should focus": deterministic findings from the records, ordered by severity, temperature and
// volume. Each finding carries the exact drilldown (bucket + filter patch) that lists the affected records.
// ---------------------------------------------------------------------------------------------------------------

export interface Finding {
  id: string;
  severity: "critical" | "at_risk";
  temperature: Temperature | null;
  title: string;
  detail: string;
  count: number;
  owner: string | null;
  drill: { bucket: string; patch: Record<string, string> };
}

export function findings(rows: LeadFact[], rules: Rules, limit = 5): Finding[] {
  const el = rows.filter((f) => f.eligible);
  const out: Finding[] = [];
  const name = (id: string | null) => (id ? rosterById.get(id)?.name ?? id : "Unassigned");
  const topBy = <T>(xs: T[], key: (x: T) => string | null) => {
    const m = new Map<string, number>();
    for (const x of xs) { const k = key(x); if (k) m.set(k, (m.get(k) ?? 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
  };
  const sdrLine = (xs: LeadFact[]) => {
    const t = topBy(xs, (f) => f.sdrOwnerId);
    return t ? { id: t[0], text: `${name(t[0])} has ${t[1]} of ${xs.length}` } : null;
  };

  for (const temp of ["Hot", "Warm"] as Temperature[]) {
    const t = el.filter((f) => f.temperature === temp);
    const overdue = t.filter((f) => f.status === "never_worked" && f.firstTouchOverdue);
    if (overdue.length) {
      const s = sdrLine(overdue);
      out.push({
        id: `${temp}-overdue`, severity: "critical", temperature: temp, count: overdue.length,
        title: `${overdue.length} ${temp} lead${overdue.length === 1 ? " has" : "s have"} breached the first-touch SLA with no outreach`,
        detail: s ? s.text : "", owner: s?.id ?? null,
        drill: { bucket: "overdue", patch: { temperature: temp } },
      });
    }
    const stalled = t.filter((f) => f.status === "stalled");
    if (stalled.length) {
      const s = sdrLine(stalled);
      out.push({
        id: `${temp}-stalled`, severity: "critical", temperature: temp, count: stalled.length,
        title: `${stalled.length} ${temp} lead${stalled.length === 1 ? " has" : "s have"} stalled beyond the ${rules.cadence[temp].stallBusinessDays}-business-day follow-up limit`,
        detail: s ? s.text : "", owner: s?.id ?? null,
        drill: { bucket: "stalled", patch: { temperature: temp } },
      });
    }
    const oneTouch = t.filter((f) => f.status === "first_touch" && f.insufficientFollowUp && f.touchesSinceEligibility === 1);
    if (oneTouch.length) {
      const s = sdrLine(oneTouch);
      out.push({
        id: `${temp}-one-touch`, severity: "at_risk", temperature: temp, count: oneTouch.length,
        title: `${oneTouch.length} ${temp} lead${oneTouch.length === 1 ? " was" : "s were"} contacted once with no further outreach, though more is due`,
        detail: s ? s.text : "", owner: s?.id ?? null,
        drill: { bucket: "one_touch_due", patch: { temperature: temp } },
      });
    }
  }

  // The SDR carrying the largest share of critical leads (a fact, not a threshold).
  const critical = el.filter((f) => riskOf(f, rules)?.level === "critical");
  const sdrs = new Set(critical.map((f) => f.sdrOwnerId).filter(Boolean));
  if (critical.length && sdrs.size > 1) {
    const top = topBy(critical, (f) => f.sdrOwnerId);
    if (top) {
      out.push({
        id: "sdr-backlog", severity: "critical", temperature: null, count: top[1],
        title: `${name(top[0])} holds ${top[1]} of ${critical.length} critical leads (${pct(top[1], critical.length)}%)`,
        detail: `Largest critical backlog of ${sdrs.size} SDRs with critical leads`, owner: top[0],
        drill: { bucket: "risk_critical", patch: { sdr: top[0], region: "" } },
      });
    }
  }

  // The event with the most eligible leads never contacted after the SLA.
  const byEvent = new Map<string, LeadFact[]>();
  for (const f of el) (byEvent.get(f.eventId) ?? byEvent.set(f.eventId, []).get(f.eventId)!).push(f);
  let worst: { id: string; n: number; of: number; f: LeadFact } | null = null;
  for (const [id, l] of byEvent) {
    const n = l.filter((f) => f.status === "never_worked" && f.firstTouchOverdue).length;
    if (n && (!worst || n > worst.n)) worst = { id, n, of: l.length, f: l[0]! };
  }
  if (worst && byEvent.size > 1) {
    out.push({
      id: "event-gap", severity: "critical", temperature: null, count: worst.n,
      title: `${worst.f.eventName}: ${worst.n} of ${worst.of} eligible leads (${pct(worst.n, worst.of)}%) never contacted after the SLA`,
      detail: CATEGORY_LABEL[worst.f.eventCategory], owner: null,
      drill: { bucket: "overdue", patch: { eventId: worst.id, quarter: "all" } },
    });
  }

  const sevRank = (s: Finding["severity"]) => (s === "critical" ? 0 : 1);
  const tempRank = (t: Temperature | null) => (t === "Hot" ? 0 : t === null ? 1 : 2);
  out.sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || tempRank(a.temperature) - tempRank(b.temperature) || b.count - a.count);
  return out.slice(0, limit);
}

/** Two-to-three sentence summary built only from the counts above. */
export function narrative(rows: LeadFact[], rules: Rules, top: Finding[]): string {
  const c = riskCounts(rows, rules);
  if (!rows.length) return "No event registrations match the current filters, so follow-up health cannot be assessed.";
  if (!c.eligible) return `None of the ${rows.length} registrations in this view are eligible for SDR follow-up, so follow-up health cannot be assessed.`;
  const p = (n: number) => `${pct(n, c.eligible)}%`;
  const verdict = c.critical > 0 ? "needs intervention" : c.at_risk > 0 ? "is at risk" : "is on track";
  const s1 = `Event follow-up ${verdict}: ${c.critical} of ${c.eligible} eligible leads (${p(c.critical)}) are critical, ${c.at_risk} (${p(c.at_risk)}) at risk and ${c.healthy} (${p(c.healthy)}) healthy; ${c.neutral} are not yet due or cannot be verified.`;
  if (!top.length) return s1;
  const first = top[0]!;
  const s2 = `Biggest gap: ${first.title}.`;
  const sdr = top.find((f) => f.owner && f.severity === "critical");
  const s3 = sdr && sdr.owner ? `Most urgent intervention: ${rosterById.get(sdr.owner)?.name ?? sdr.owner}.` : "";
  return [s1, s2, s3].filter(Boolean).join(" ");
}
