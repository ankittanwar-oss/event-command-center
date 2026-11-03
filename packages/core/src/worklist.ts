// SDR daily worklist: turns lead facts into ONE next action per account, placed in exactly one section.
// Presentation logic only: it reads existing facts and rules and never changes status, SLA or any reported metric.
import { rosterById, type CadenceRule, type Rules } from "./config.js";
import { expectedTouches } from "./leads.js";
import { addDays, businessDaysBetween, toDate } from "./dates.js";
import type { LeadFact } from "./types.js";

export const WORK_SECTIONS = [
  { key: "respond", label: "Respond now", hint: "A prospect replied and nobody has answered since" },
  { key: "overdue", label: "Overdue", hint: "First outreach past the SLA, or a follow-up past its due date" },
  { key: "today", label: "Due today", hint: "First outreach or follow-up due today" },
  { key: "stale", label: "No touch in 14+ business days", hint: "Still actionable, no deadline breached, but no SDR touch for 14+ business days" },
  { key: "upcoming", label: "Upcoming", hint: "Due on a later date (shown on each row)" },
  { key: "monitor", label: "In play / Monitor", hint: "Open opportunity, meeting, paused, cadence complete, or needs review" },
] as const;
export type WorkSection = (typeof WORK_SECTIONS)[number]["key"];

export type WorkAction = "Respond" | "Send first outreach" | "Follow up" | "Complete HubSpot task" | "Monitor" | "Paused" | "Review next step" | "Needs review";

export interface WorkItem {
  section: WorkSection;
  action: WorkAction;
  why: string;
  due: string | null;               // YYYY-MM-DD, only when established from a verified trigger
  dueSource: "reply" | "task" | "sla" | "cadence" | null;
  overdueBusinessDays: number | null;
  lead: LeadFact;
}

const ORDER: Record<WorkSection, number> = { respond: 0, overdue: 1, today: 2, stale: 3, upcoming: 4, monitor: 5 };

export function addBusinessDays(day: string, n: number, rules: Rules): string {
  let d = day;
  while (businessDaysBetween(day, d, rules.businessCalendar) < n) d = addDays(d, 1);
  return d;
}

/** Reply date: the fact field, or (older snapshots) the in-play reason text. */
export function replyDate(f: LeadFact): string | null {
  return toDate(f.lastReplyAt ?? null) ?? /Prospect replied on (\d{4}-\d{2}-\d{2})/.exec(f.inPlayReason ?? "")?.[1] ?? null;
}

/** Verified engagement with SpotDraft (not just attendance): a reply, a meeting, or a conversation before the event. */
export function verifiedEngagement(f: LeadFact): string | null {
  if (replyDate(f)) return "Replied";
  if (f.lastMeetingAt || /^Meeting on/.test(f.inPlayReason ?? "")) return "Meeting";
  if (f.priorConversation) return "Prior conversation";
  return null;
}

function slaApplies(f: LeadFact, rules: Rules): boolean {
  if (typeof f.slaApplies === "boolean") return f.slaApplies;
  if (f.status === "recently_lost") return false;
  return !(rules.slaStartDate && f.eligibilityDate && f.eligibilityDate < rules.slaStartDate);
}

function placeByDate(due: string, today: string, rules: Rules): { section: WorkSection; overdue: number | null } {
  if (due < today) return { section: "overdue", overdue: businessDaysBetween(due, today, rules.businessCalendar) };
  if (due === today) return { section: "today", overdue: null };
  return { section: "upcoming", overdue: null };
}

/** The single next action for one lead (event registration). */
export function leadWork(f: LeadFact, today: string, rules: Rules): WorkItem {
  const rule = rules.cadence[f.temperature ?? "Warm"];
  const item = (section: WorkSection, action: WorkAction, why: string, due: string | null = null, dueSource: WorkItem["dueSource"] = null, overdue: number | null = null): WorkItem =>
    ({ section, action, why, due, dueSource, overdueBusinessDays: overdue, lead: f });

  // 1. Prospect reply nobody has answered (any outbound by SDR, AE or anyone else after the reply counts as answered).
  const reply = replyDate(f);
  const answeredAt = toDate(f.lastOutboundAt ?? null) ?? (f.lastOutboundAt === undefined ? toDate(f.lastTouchAt) : null);
  if (reply && (!answeredAt || answeredAt < reply)) {
    const due = addBusinessDays(reply, 1, rules);
    return item("respond", "Respond", `Replied ${reply}; no response logged since`, due, "reply", due < today ? businessDaysBetween(due, today, rules.businessCalendar) : null);
  }

  // 2. Open HubSpot task owned by the current SDR (or with no owner): a verified, explicit due date.
  if (f.nextTaskDue && (!f.nextTaskOwnerId || f.nextTaskOwnerId === f.sdrOwnerId)) {
    const due = toDate(f.nextTaskDue)!;
    const p = placeByDate(due, today, rules);
    return item(p.section, "Complete HubSpot task", f.nextTaskSubject ? `Task: ${f.nextTaskSubject}` : "Open HubSpot task", due, "task", p.overdue);
  }

  // 3. Active commercial activity / legitimate pauses: context, not SDR neglect.
  if (f.status === "in_play") {
    const r = f.inPlayReason ?? "In play";
    if (r === "Disqualified") return item("monitor", "Paused", "Disqualified in HubSpot");
    if (r.startsWith("Open opportunity")) return item("monitor", "Monitor", `${r.replace("Open opportunity: ", "Open opp: ")} – AE-led; check with the AE before outreach`);
    return item("monitor", "Monitor", r);
  }
  if (f.status === "recently_lost") return item("monitor", "Paused", f.statusReason);
  if (f.status === "unverifiable" || !f.eligibilityDate) return item("monitor", "Needs review", f.statusReason || "Due date cannot be established");

  // 4. No SDR touch yet: first outreach, due from the verified eligibility date (max of event date and allocation date).
  if (f.touchesSinceEligibility === 0) {
    if (!slaApplies(f, rules)) return item("monitor", "Needs review", `No outreach yet; eligible ${f.eligibilityDate}, before the SLA start (${rules.slaStartDate}) – no deadline applies`);
    const due = addBusinessDays(f.eligibilityDate, rule.firstTouchBusinessDays, rules);
    const p = placeByDate(due, today, rules);
    return item(p.section, "Send first outreach", `${f.temperature ?? "Temp not set"} lead, no SDR touch since ${f.eligibilityDate}`, due, "sla", p.overdue);
  }

  // 5. Worked: two existing rules, kept consistent with the rest of the app:
  //    - follow-up DUE once the lead falls below the configured expected-touches curve for its age (existing
  //      insufficientFollowUp / "at risk" rule);
  //    - follow-up OVERDUE once the gap since the last touch exceeds the stall threshold (existing "stalled" rule).
  //    Fewer than 6–7 touches alone never makes a lead overdue.
  const target = rules.touchTarget?.bandMax ?? 7;
  if (f.touchesSinceEligibility >= target) return item("monitor", "Review next step", `Cadence complete (${f.touchesSinceEligibility} touches, no reply)`);
  const last = toDate(f.lastTouchAt);
  if (!last) return item("monitor", "Needs review", "Follow-up timing unverified (last touch date unknown)");
  const stallDue = addBusinessDays(last, rule.stallBusinessDays + 1, rules);
  const cadDue = cadenceDue(f, rule);
  const why = `Next is touch ${f.touchesSinceEligibility + 1} (target ${rules.touchTarget?.minimum ?? 6}–${target}); last touch ${last}`;
  if (stallDue <= today) return item("overdue", "Follow up", why, stallDue, "cadence", Math.max(1, businessDaysBetween(stallDue, today, rules.businessCalendar)));
  if (cadDue && cadDue <= today) return item("today", "Follow up", `${why}; below expected cadence since ${cadDue}`, cadDue, "cadence");
  const due = cadDue && cadDue < stallDue ? cadDue : stallDue;
  return item("upcoming", "Follow up", why, due, "cadence");
}

/** First day the lead falls below the configured expected-touches curve, given its current touch count. */
export function cadenceDue(f: LeadFact, rule: CadenceRule): string | null {
  if (!f.eligibilityDate) return null;
  for (let a = 0; a <= 400; a++) if (expectedTouches(a, rule) > f.touchesSinceEligibility) return addDays(f.eligibilityDate, a);
  return null;
}

export type ActionHealth = "overdue" | "due_today" | "upcoming" | "not_yet_due" | "on_track" | "unverified";
export const ACTION_HEALTH_LABEL: Record<ActionHealth, string> = {
  overdue: "Overdue", due_today: "Due today", upcoming: "Upcoming (≤5 bd)", not_yet_due: "Not yet due", on_track: "On track", unverified: "Unable to verify / paused",
};

/** Three independent views of one lead: first-touch SLA, follow-up timing, cadence progress; plus action health. */
export function leadDimensions(f: LeadFact, today: string, rules: Rules) {
  const w = leadWork(f, today, rules);
  const t = f.touchesSinceEligibility;
  const min = rules.touchTarget?.minimum ?? 6, max = rules.touchTarget?.bandMax ?? 7;
  // A. first-touch
  const sla = !f.eligible ? null
    : t > 0 ? (f.firstTouchSlaMet === true ? "First-touch SLA met" : f.firstTouchSlaMet === false ? "First-touch SLA missed" : "First touch done (no SLA applied)")
    : f.firstTouchOverdue ? "First touch overdue" : !slaApplies(f, rules) ? "No first-touch deadline (pre-SLA)" : "First touch not yet due";
  // B. depth band
  const depth = t === 0 ? "0" : t === 1 ? "1" : t <= 3 ? "2–3" : t <= 5 ? "4–5" : t <= 7 ? "6–7" : "8+";
  // C. follow-up timing (only meaningful once touched)
  let followUp: string | null = null;
  if (f.eligible && t > 0) {
    if (w.section === "respond") followUp = "Reply awaiting response";
    else if (w.action === "Complete HubSpot task") followUp = w.section === "overdue" ? `HubSpot task overdue (${w.overdueBusinessDays} bd)` : w.section === "today" ? "HubSpot task due today" : `HubSpot task due ${w.due}`;
    else if (w.action === "Follow up") followUp = w.section === "overdue" ? `Follow-up overdue (${w.overdueBusinessDays} bd)` : w.section === "today" ? "Follow-up due" : `Follow-up not yet due (by ${w.due})`;
    else if (w.action === "Review next step") followUp = "Cadence complete – review";
    else followUp = `Follow-up timing unverified (${w.why})`;
  }
  const cadence = !f.eligible ? null : t >= min ? `Cadence ${t}/${min}–${max} complete` : `Cadence incomplete (${t}/${min}–${max})`;
  // action health (mutually exclusive)
  let health: ActionHealth;
  const fiveBd = addBusinessDays(today, 5, rules);
  if (w.section === "overdue" || (w.section === "respond" && w.due! < today)) health = "overdue";
  else if (w.section === "today" || w.section === "respond") health = "due_today";
  else if (w.section === "upcoming") health = w.due && w.due <= fiveBd ? "upcoming" : "not_yet_due";
  else if (w.action === "Review next step" || (w.action === "Monitor" && contactLevelInPlay(f))) health = "on_track";
  else health = "unverified";
  return { sla, depth, followUp, cadence, health, work: w };
}

/** In play with evidence on THIS contact (meeting, reply, or a deal associated with the contact), not only the account. */
export function contactLevelInPlay(f: LeadFact): boolean {
  const r = f.inPlayReason ?? "";
  if (/^Meeting on|^Prospect replied/.test(r)) return true;
  if (r.startsWith("Open opportunity")) return (f.deals ?? []).some((d) => d.status === "open" && d.via === "contact");
  return false;
}

function rank(w: WorkItem): number[] {
  const eng = verifiedEngagement(w.lead) ? 0 : w.lead.attendance === "attended" ? 1 : 2;
  const temp = w.lead.temperature === "Hot" ? 0 : w.lead.temperature === "Warm" ? 1 : 2;
  const dueKey = w.due ? Date.parse(w.due) / 86_400_000 : 1e9;
  const src = w.dueSource === "reply" || w.dueSource === "task" ? 0 : w.dueSource === "sla" ? 1 : 2;
  return [ORDER[w.section], w.section === "overdue" ? src : 0, dueKey, temp, eng, -w.lead.priority];
}
function cmp(a: number[], b: number[]) { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!; return 0; }

/** One row per account: the most urgent lead decides the section, action and recommended contact. */
export function worklist(rows: LeadFact[], today: string, rules: Rules) {
  const byAcct = new Map<string, WorkItem[]>();
  for (const f of rows) {
    if (!f.eligible) continue;
    const key = f.companyId ?? `contact:${f.contactId}`;
    (byAcct.get(key) ?? byAcct.set(key, []).get(key)!).push(leadWork(f, today, rules));
  }
  // Stale but still actionable (no reply/overdue/today action): surface after due-today, never as red.
  for (const ws of byAcct.values()) for (const w of ws) {
    if (w.section !== "upcoming" && !(w.section === "monitor" && w.action === "Needs review")) continue;
    const ia = inactivity(w.lead, today, rules);
    if (ia.stale && ia.kind === "sdr_action") Object.assign(w, { section: "stale", why: `${w.why} · no SDR touch for ${ia.businessDays} business days` });
  }
  // Follow-ups are an account-level rhythm: a recent SDR touch on another contact at the same account resets the
  // follow-up clock for the account (no deadline is moved earlier; it can only move to a later, verified touch).
  for (const ws of byAcct.values()) {
    const acctLast = ws.map((w) => toDate(w.lead.lastTouchAt)).filter(Boolean).sort().pop() ?? null;
    for (const w of ws) {
      if (w.dueSource !== "cadence" || !acctLast) continue;
      const own = toDate(w.lead.lastTouchAt)!;
      if (acctLast <= own) continue;
      const rule = rules.cadence[w.lead.temperature ?? "Warm"];
      const due = addBusinessDays(acctLast, rule.stallBusinessDays, rules);
      const p = placeByDate(due, today, rules);
      Object.assign(w, { section: p.section, due, overdueBusinessDays: p.overdue, why: `${w.why}; account last touched ${acctLast}` });
    }
  }
  const items = [...byAcct.entries()].map(([key, ws]) => {
    ws.sort((a, b) => cmp(rank(a), rank(b)));
    const top = ws[0]!;
    const f = top.lead;
    const leads = ws.map((w) => w.lead);
    const otherActions = new Set(ws.slice(1).filter((w) => w.section !== "monitor" && w.lead.contactId !== f.contactId).map((w) => w.lead.contactId)).size;
    const openOpp = leads.some((l) => (l.deals ?? []).some((d) => d.status === "open" && d.via !== "duplicate_company"));
    const lastTouch = leads.filter((l) => l.lastTouchAt).sort((a, b) => b.lastTouchAt!.localeCompare(a.lastTouchAt!))[0] ?? null;
    return {
      key, companyId: key.startsWith("contact:") ? null : key, companyName: f.companyName ?? f.contactName,
      status: actionStatus(f, today, rules, top),
      lastOutboundAt: f.lastOutboundAt !== undefined ? f.lastOutboundAt ?? null : f.lastTouchAt, lastOutboundOwnerId: f.lastOutboundAt !== undefined ? f.lastOutboundOwnerId ?? null : f.lastTouchOwnerId ?? null,
      currentSdrLastTouchAt: f.currentSdrLastTouchAt ?? null,
      section: top.section, action: top.action, why: top.why, due: top.due, dueSource: top.dueSource, overdueBusinessDays: top.overdueBusinessDays,
      contactId: f.contactId, contactName: f.contactName, jobTitle: f.jobTitle, eventId: f.eventId, eventName: f.eventName, eventDate: f.eventDate, eventCategory: f.eventCategory,
      sdrOwnerId: f.sdrOwnerId, sdrName: f.sdrOwnerId ? rosterById.get(f.sdrOwnerId)?.name ?? null : null, sdrSource: f.sdrSource ?? null,
      temperature: f.temperature ?? (f.temperatureRaw || null), attendance: f.attendance, engagement: verifiedEngagement(f), replyAt: replyDate(f),
      lastTouchAt: lastTouch?.lastTouchAt ?? null,
      lastTouchBy: lastTouch?.lastTouchOwnerId ? rosterById.get(lastTouch.lastTouchOwnerId)?.name ?? "Other user" : lastTouch ? null : null,
      currentSdrTouches: f.currentSdrTouches ?? null, otherSdrTouches: f.otherSdrTouches ?? 0, touchesSinceEligibility: f.touchesSinceEligibility,
      openOpp, contacts: new Set(leads.map((l) => l.contactId)).size, otherActions,
      events: [...new Map(leads.map((l) => [l.eventId, { id: l.eventId, name: l.eventName, date: l.eventDate }])).values()],
    };
  });
  items.sort((a, b) => cmp(rank({ section: a.section, due: a.due, lead: byAcct.get(a.key)![0]!.lead } as WorkItem), rank({ section: b.section, due: b.due, lead: byAcct.get(b.key)![0]!.lead } as WorkItem)));
  const counts = Object.fromEntries(WORK_SECTIONS.map((s) => [s.key, items.filter((i) => i.section === s.key).length])) as Record<WorkSection, number>;
  return { sections: WORK_SECTIONS, counts, items };
}

/**
 * Outreach timeliness for the CMO overview, split into first-touch SLA and follow-up timing. Uses the existing SLA,
 * cadence and stall rules via leadWork; records without a verifiable due date are never counted as compliant.
 *   firstTouch: ontime | late | today | upcoming | overdue | no_deadline | null (not applicable: no first touch needed / ineligible)
 *   followUp:   today | upcoming | overdue | unverified | complete | null (not touched yet / ineligible)
 */
export function outreachTimeliness(f: LeadFact, today: string, rules: Rules) {
  if (!f.eligible) return { firstTouch: null, followUp: null } as const;
  const w = leadWork(f, today, rules);
  let firstTouch: "ontime" | "late" | "today" | "upcoming" | "overdue" | "no_deadline" | null = null;
  if (f.touchesSinceEligibility > 0) firstTouch = f.firstTouchSlaMet === true ? "ontime" : f.firstTouchSlaMet === false ? "late" : "no_deadline";
  else if (f.status === "never_worked" && f.firstTouchOverdue) firstTouch = "overdue";
  else if (w.action === "Send first outreach") firstTouch = w.section === "today" ? "today" : w.section === "upcoming" ? "upcoming" : w.section === "overdue" ? "overdue" : "no_deadline";
  else firstTouch = "no_deadline";
  let followUp: "today" | "upcoming" | "overdue" | "unverified" | "complete" | null = null;
  if (f.touchesSinceEligibility > 0) {
    if (w.section === "overdue") followUp = "overdue";
    else if (w.section === "today") followUp = "today";
    else if (w.section === "respond") followUp = w.due && w.due < today ? "overdue" : "today";
    else if (w.section === "upcoming") followUp = "upcoming";
    else if (w.action === "Review next step" || (w.action === "Monitor" && contactLevelInPlay(f))) followUp = "complete";
    else followUp = "unverified";
  }
  return { firstTouch, followUp };
}


// ---------------------------------------------------------------------------------------------------------------
// Engagement consistency: "No touch in N business days" (default 14). An indicator, not an SLA.
//   touched:     business days since the last qualifying SDR touch (since eligibility)
//   never touched: business days since the eligibility date (later of event date and current SDR allocation)
// ---------------------------------------------------------------------------------------------------------------
export type InactivityKind = "sdr_action" | "ae_or_pause" | "review";
export function inactivity(f: LeadFact, today: string, rules: Rules): { businessDays: number | null; stale: boolean; kind: InactivityKind | null; since: string | null } {
  if (!f.eligible) return { businessDays: null, stale: false, kind: null, since: null };
  const since = f.touchesSinceEligibility > 0 ? toDate(f.lastTouchAt) : f.eligibilityDate;
  if (!since || since > today) return { businessDays: null, stale: false, kind: null, since };
  const bd = businessDaysBetween(since, today, rules.businessCalendar);
  const stale = bd >= (rules.inactivityBusinessDays ?? 14);
  let kind: InactivityKind = "sdr_action";
  const r = f.inPlayReason ?? "";
  if (f.status === "recently_lost" || (f.status === "in_play" && !/^Prospect replied/.test(r))) kind = "ae_or_pause";
  else if (f.status === "unverifiable") kind = "review";
  return { businessDays: bd, stale, kind: stale ? kind : null, since };
}

/** Where an overdue deadline comes from, in words, e.g. "HubSpot task overdue by 4 business days". */
export function overdueSource(w: WorkItem): { source: "task" | "first_touch_sla" | "cadence" | "reply"; label: string } | null {
  if (w.section !== "overdue" && !(w.section === "respond" && (w.overdueBusinessDays ?? 0) > 0)) return null;
  const n = w.overdueBusinessDays ?? 0;
  const bd = `${n} business day${n === 1 ? "" : "s"}`;
  switch (w.dueSource) {
    case "task": return { source: "task", label: `HubSpot task overdue by ${bd}` };
    case "sla": return { source: "first_touch_sla", label: `First-touch SLA breached by ${bd}` };
    case "reply": return { source: "reply", label: `Prospect reply unanswered, ${bd} past the 1-business-day response` };
    case "cadence": return { source: "cadence", label: `Follow-up cadence overdue by ${bd} (no touch beyond the stall limit)` };
    default: return null;
  }
}

/** Why a lead has (or has no) verified deadline: replaces the blended "Not yet due / unverified". */
export type DeadlineState = "verified" | "not_yet_due" | "no_deadline" | "commercial" | "paused" | "missing_data";
export function deadlineState(f: LeadFact, today: string, rules: Rules): DeadlineState | null {
  if (!f.eligible) return null;
  const w = leadWork(f, today, rules);
  if (w.section === "respond" || w.section === "overdue" || w.section === "today") return "verified";
  if (w.section === "upcoming") return "not_yet_due";
  if (f.status === "in_play" && f.inPlayReason !== "Disqualified") return "commercial";
  if (f.status === "recently_lost" || f.inPlayReason === "Disqualified" || w.action === "Review next step") return "paused";
  if (f.status === "unverifiable" || !f.eligibilityDate || (f.touchesSinceEligibility > 0 && !f.lastTouchAt)) return "missing_data";
  return "no_deadline";
}

// ---------------------------------------------------------------------------------------------------------------
// One action status per record for drill-downs and the daily view. Colour = action urgency only:
//   red   verified overdue action        amber  due today / follow-up due now
//   green verified on-track or completed grey   informational, commercial context, or needs review
// A verified HubSpot task or reply always wins over an account-level deal (leadWork already orders them that way).
// ---------------------------------------------------------------------------------------------------------------
export type ActionColor = "red" | "amber" | "green" | "grey";
export interface ActionStatus { label: string; color: ActionColor; next: string; source: WorkItem["dueSource"] | "engagement" | "none"; secondary: string[] }

export function actionStatus(f: LeadFact, today: string, rules: Rules, given?: WorkItem): ActionStatus {
  const secondary: string[] = [];
  const openDeals = (f.deals ?? []).filter((d) => d.status === "open");
  if (openDeals.some((d) => d.via === "contact")) secondary.push("Open deal with contact");
  else if (openDeals.length) secondary.push("Open deal on company");
  if (!f.eligible) return { label: "Not eligible", color: "grey", next: f.ineligibleReason ? `Excluded: ${f.ineligibleReason}` : "Excluded", source: "none", secondary };
  const w = given ?? leadWork(f, today, rules);
  const n = w.overdueBusinessDays ?? 0;
  const bd = `${n} business day${n === 1 ? "" : "s"}`;
  const day = (x: string | null) => (x ? x : "");
  const mk = (label: string, color: ActionColor, next: string, source: ActionStatus["source"]) => ({ label, color, next, source, secondary });
  switch (w.dueSource) {
    case "reply":
      return n > 0 ? mk(`Reply unanswered · ${bd} overdue`, "red", "Respond to the prospect's reply", "reply") : mk("Prospect replied · respond today", "amber", "Respond to the prospect's reply", "reply");
    case "task":
      if (w.section === "overdue") return mk(`HubSpot task overdue by ${bd}`, "red", w.why, "task");
      if (w.section === "today") return mk("HubSpot task due today", "amber", w.why, "task");
      return mk(`HubSpot task due ${day(w.due)}`, "green", w.why, "task");
    case "sla":
      if (w.section === "overdue") return mk(`First outreach overdue by ${bd}`, "red", "Send first outreach", "sla");
      if (w.section === "today") return mk("First outreach due today", "amber", "Send first outreach", "sla");
      return mk(`First outreach due ${day(w.due)}`, "grey", "Send first outreach", "sla");
    case "cadence":
      if (w.section === "overdue") return mk(`Cadence follow-up overdue by ${bd}`, "red", `Follow up (touch ${f.touchesSinceEligibility + 1})`, "cadence");
      if (w.section === "today") return mk(w.due === today ? "Cadence follow-up due today" : `Cadence follow-up due since ${day(w.due)}`, "amber", `Follow up (touch ${f.touchesSinceEligibility + 1})`, "cadence");
      return mk(`On track · next follow-up by ${day(w.due)}`, "green", `Follow up by ${day(w.due)}`, "cadence");
  }
  if (w.section === "stale") return mk("No touch in 14+ business days", "grey", f.touchesSinceEligibility === 0 ? "Send first outreach" : "Follow up", "none");
  if (w.action === "Review next step") return mk(`Cadence complete (${f.touchesSinceEligibility} touches)`, "green", "Review next step", "none");
  if (w.action === "Monitor" && contactLevelInPlay(f) && f.touchesSinceEligibility > 0) {
    const r = f.inPlayReason ?? "";
    return mk(/^Meeting/.test(r) ? "In conversation · meeting" : /^Prospect replied/.test(r) ? "In conversation · reply answered" : "In conversation · deal with contact", "green", "Coordinate with the AE", "engagement");
  }
  if (w.action === "Paused") return mk(/Disqualified/.test(w.why) ? "Paused · disqualified" : "Paused · recently closed lost", "grey", "No outreach needed now", "none");
  return mk("Review next action", "grey", openDeals.length && !openDeals.some((d) => d.via === "contact") ? "Check with the AE before outreach" : "No reliable deadline: decide the next step", "none");
}

// ---------------------------------------------------------------------------------------------------------------
// SDR daily worklist v2: ONE row per HubSpot contact, in exactly one group.
//   respond     prospect reply, or a HubSpot task (explicit commitment) due today / overdue
//   reach_out   eligible, no SDR touch yet, no commercial activity on the account
//   follow_up   contacted before; next touch is due (cadence below curve / past stall / 14+ bd quiet)
//   coordinate  open deal on the company only, nothing verified for this contact: confirm with the AE
//   progress    in progress / no action needed now (on track, task scheduled later, meeting/reply/deal with
//               contact, cadence complete, paused, or outreach logged on the company only)
// Colour: red = verified overdue commitment or first-touch SLA breach; amber = due today / due now;
//         green = progressing or complete; grey = waiting, review, or AE coordination. Zero touches is never red.
// Reporting views keep their event-lead records; this grouping is presentation only.
// ---------------------------------------------------------------------------------------------------------------
export const CONTACT_GROUPS = [
  { key: "respond", label: "Respond", hint: "Prospect replies and HubSpot tasks due today or overdue" },
  { key: "reach_out", label: "Reach out", hint: "Eligible contacts with no SDR outreach yet" },
  { key: "follow_up", label: "Follow up", hint: "Contacted before; the next touch is due" },
  { key: "coordinate", label: "Coordinate with AE", hint: "Open deal on the company, nothing verified for this contact" },
  { key: "progress", label: "In progress / no action now", hint: "On track, scheduled, in conversation, complete or paused" },
] as const;
export type ContactGroup = (typeof CONTACT_GROUPS)[number]["key"];

export interface ContactAction { group: ContactGroup; action: string; reason: string; color: ActionColor; due: string | null; overdueBusinessDays: number | null; sort: number }

export function contactAction(f: LeadFact, today: string, rules: Rules): ContactAction {
  const w = leadWork(f, today, rules);
  const n = w.overdueBusinessDays ?? 0;
  const bd = (x: number) => `${x} business day${x === 1 ? "" : "s"}`;
  const ia = inactivity(f, today, rules);
  const mk = (group: ContactGroup, action: string, reason: string, color: ActionColor, sort: number): ContactAction => ({ group, action, reason, color, due: w.due, overdueBusinessDays: w.overdueBusinessDays, sort });
  const accountDealOnly = (f.deals ?? []).some((d) => d.status === "open") && !(f.deals ?? []).some((d) => d.status === "open" && d.via === "contact");
  switch (w.dueSource) {
    case "reply": return n > 0 ? mk("respond", "Reply to prospect", `Replied ${replyDate(f)}; unanswered for ${bd(n)}`, "red", 0) : mk("respond", "Reply to prospect", `Replied ${replyDate(f)}`, "amber", 1);
    case "task":
      if (w.section === "overdue") return mk("respond", "Complete HubSpot task", `${w.why.replace(/^Task: /, "")} · overdue by ${bd(n)}`, "red", 0);
      if (w.section === "today") return mk("respond", "Complete HubSpot task", `${w.why.replace(/^Task: /, "")} · due today`, "amber", 1);
      return mk("progress", "No action needed now", `HubSpot task scheduled for ${w.due}`, "green", 9);
    case "sla":
      if (w.section === "overdue") return mk("reach_out", "Send first outreach", `First-touch SLA passed ${bd(n)} ago`, "red", 2);
      if (w.section === "today") return mk("reach_out", "Send first outreach", "First-touch SLA due today", "amber", 3);
      return mk("reach_out", "Send first outreach", `First touch due by ${w.due}`, "grey", 5);
    case "cadence":
      if (w.section === "overdue") return mk("follow_up", "Continue follow-up", `No touch for ${bd(ia.businessDays ?? 0)} (follow-up was due ${w.due})`, "amber", 3);
      if (w.section === "today") return mk("follow_up", "Continue follow-up", `Touch ${f.touchesSinceEligibility + 1} due${w.due && w.due < today ? ` since ${w.due}` : " today"}`, "amber", 4);
      if (ia.stale) return mk("follow_up", "Continue follow-up", `No touch for ${bd(ia.businessDays ?? 0)}`, "grey", 6);
      return mk("progress", "No action needed now", `On track · next touch by ${w.due}`, "green", 9);
  }
  // No date-based action. Decide by situation.
  if (w.action === "Review next step") return mk("progress", "Decide next step", `Cadence complete (${f.touchesSinceEligibility} touches), no reply`, "green", 8);
  if (w.action === "Paused") return mk("progress", "No action needed now", /Disqualified/.test(w.why) ? "Disqualified in HubSpot" : "Recently closed lost", "grey", 10);
  if (f.status === "in_play") {
    if (contactLevelInPlay(f)) return mk("progress", "No action needed now", (f.inPlayReason ?? "").replace(/^Open opportunity: /, "Deal with contact: "), "green", 9);
    if (accountDealOnly) return mk("coordinate", "Confirm next step with AE", `${(f.inPlayReason ?? "").replace(/^Open opportunity: /, "Open deal on company: ")}${f.touchesSinceEligibility ? "" : " · no SDR outreach yet"}`, "grey", 7);
    return mk("progress", "No action needed now", f.inPlayReason ?? "In play", "grey", 10);
  }
  if (f.status === "unverifiable") return mk("progress", "Log outreach on the contact", "Outreach was logged on the company, not on this contact", "grey", 10);
  if (f.touchesSinceEligibility === 0) return mk("reach_out", "Send first outreach", `No outreach yet${f.eligibilityDate ? ` · eligible since ${f.eligibilityDate}` : ""} (before the SLA start, no deadline)`, "grey", 6);
  return mk("progress", "No action needed now", w.why, "grey", 10);
}

/** One row per contact across all their event-lead records. Touches are distinct activities, never summed per event. */
export function contactWorklist(rows: LeadFact[], today: string, rules: Rules) {
  const by = new Map<string, LeadFact[]>();
  for (const f of rows) if (f.eligible) (by.get(f.contactId) ?? by.set(f.contactId, []).get(f.contactId)!).push(f);
  const items = [...by.values()].map((leads) => {
    const scored = leads.map((f) => ({ f, a: contactAction(f, today, rules) }));
    const gOrder: Record<ContactGroup, number> = { respond: 0, reach_out: 1, follow_up: 2, coordinate: 3, progress: 4 };
    // Most urgent record decides; a touched record beats an untouched one for the same contact (outreach already started).
    scored.sort((x, y) => x.a.sort - y.a.sort || gOrder[x.a.group] - gOrder[y.a.group] || (x.a.due ?? "9").localeCompare(y.a.due ?? "9"));
    let top = scored[0]!;
    const anyTouched = scored.find((s) => s.f.touchesSinceEligibility > 0);
    if (top.a.group === "reach_out" && anyTouched) top = anyTouched.a.group === "reach_out" ? top : anyTouched;
    const f = top.f;
    const ids = new Set(leads.flatMap((l) => l.touchIds));
    const yourTouches = Math.max(0, ...leads.map((l) => l.currentSdrTouches ?? 0));
    const other = leads.map((l) => l.lastOtherSdrTouch).filter((x): x is { at: string; ownerId: string | null } => !!x).sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;
    const lastOut = leads.map((l) => ({ at: l.lastOutboundAt !== undefined ? l.lastOutboundAt : l.lastTouchAt, by: l.lastOutboundAt !== undefined ? l.lastOutboundOwnerId ?? null : l.lastTouchOwnerId ?? null }))
      .filter((x) => x.at).sort((a, b) => b.at!.localeCompare(a.at!))[0] ?? null;
    const openDeal = leads.flatMap((l) => l.deals ?? []).find((d) => d.status === "open") ?? null;
    return {
      contactId: f.contactId, contactName: f.contactName, jobTitle: f.jobTitle, contactEmail: f.contactEmail,
      companyId: f.companyId, companyName: f.companyName, sdrOwnerId: f.sdrOwnerId, sdrName: f.sdrOwnerId ? rosterById.get(f.sdrOwnerId)?.name ?? null : null,
      sdrSource: f.sdrSource ?? null, allocationDate: f.allocationDate,
      temperature: f.temperature ?? (f.temperatureRaw || null),
      ...top.a, eventId: f.eventId,
      yourTouches, sdrTouchesAny: ids.size, otherSdrTouches: Math.max(0, ...leads.map((l) => l.otherSdrTouches ?? 0)), lastOtherSdrTouch: other,
      lastOutboundAt: lastOut?.at ?? null, lastOutboundOwnerId: lastOut?.by ?? null,
      deal: openDeal ? { name: openDeal.name, stage: openDeal.stageLabel, id: openDeal.id, via: openDeal.via, ownerId: openDeal.ownerId ?? null } : null,
      events: leads.map((l) => ({ id: l.eventId, name: l.eventName, date: l.eventDate, category: l.eventCategory, attendance: l.attendance })),
    };
  });
  items.sort((a, b) => a.sort - b.sort || (a.due ?? "9").localeCompare(b.due ?? "9") || (a.temperature === "Hot" ? -1 : 0) - (b.temperature === "Hot" ? -1 : 0));
  const counts = Object.fromEntries(CONTACT_GROUPS.map((g) => [g.key, items.filter((i) => i.group === g.key).length])) as Record<ContactGroup, number>;
  return { groups: CONTACT_GROUPS, counts, items };
}
