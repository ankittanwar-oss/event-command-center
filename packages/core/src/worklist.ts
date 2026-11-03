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
  const replyAny = replyDate(f);
  // Only a recent reply can be "waiting for a response"; older ones are history (see rules.conversationRecencyDays).
  const reply = replyAny && replyAny >= addDays(today, -(rules.conversationRecencyDays ?? 30)) ? replyAny : null;
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
    if (r.startsWith("Qualified (SQL")) return item("monitor", "Monitor", `${r} – handed to the AE`);
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
  // 6–7 touches is the expected cadence, not a maximum: follow-up continues on the same timing rules after it.
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
  // A verified SQL (Became Qualified to Buy Date) on the account's open deal is a confirmed handoff for the account.
  if (r.startsWith("Qualified (SQL")) return true;
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
// SDR daily worklist v3: ONE row per HubSpot contact, in exactly one group.
//   respond         real prospect reply; SDR-owned HubSpot task due today or overdue
//   first_outreach  eligible, no qualifying SDR touch yet (an open deal WITHOUT an SQL date does not change this)
//   follow_up       worked before and another touch is due now (cadence, stall limit, or 14+ business days quiet)
//   qualified       verified SQL: an open deal with a "Became Qualified to Buy Date"
//   review          genuinely missing or contradictory data
//   progress        up to date: next touch not due yet, task scheduled later, meeting/reply in progress, paused
// Colour: red verified overdue · amber due today / timely outreach · green qualified or progressing · grey info/review.
// Presentation only: event-lead reporting and KPI denominators are unchanged.
// ---------------------------------------------------------------------------------------------------------------
export const CONTACT_GROUPS = [
  { key: "respond", label: "Respond now", hint: "Prospect replies and HubSpot tasks due today or overdue" },
  { key: "first_outreach", label: "First outreach", hint: "Eligible contacts with no qualifying SDR outreach yet" },
  { key: "follow_up", label: "Follow up", hint: "Already contacted; another touch is due" },
  { key: "qualified", label: "Qualified / handed off", hint: "Verified SQL: the deal has a Became Qualified to Buy Date" },
  { key: "low", label: "Lower priority", hint: "Company intent is Cold and there is no verified event engagement" },
  { key: "review", label: "Needs review", hint: "Missing or contradictory data" },
  { key: "progress", label: "Up to date", hint: "Next touch not due yet, task scheduled, in conversation, or paused" },
] as const;
export type ContactGroup = (typeof CONTACT_GROUPS)[number]["key"];

export interface ContactAction { group: ContactGroup; action: string; reason: string; color: ActionColor; due: string | null; overdueBusinessDays: number | null; sort: number }

/** Why this contact matters, from verified evidence only. Sponsored-event attendance is not SpotDraft engagement. */
export function engagementReason(f: LeadFact): { text: string; strength: number } {
  const reply = /^Prospect replied/.test(f.inPlayReason ?? "") ? replyDate(f) : null;
  if (reply) return { text: `Replied ${reply}`, strength: 0 };
  if (f.nextMeetingAt) return { text: `Meeting scheduled ${toDate(f.nextMeetingAt)}`, strength: 0 };
  if (/^Meeting on/.test(f.inPlayReason ?? "")) return { text: (f.inPlayReason ?? "").replace("Meeting on", "Meeting"), strength: 0 };
  const ev = f.eventName.split(/[|:]/)[0]!.trim().slice(0, 40);
  if (f.attendance === "attended") return f.eventCategory === "sponsored"
    ? { text: `Attended ${ev} (sponsored · SpotDraft engagement unverified)`, strength: 3 }
    : { text: `Attended ${ev}`, strength: 1 };
  if (f.attendance === "no_show") return { text: `Registered, did not attend ${ev}`, strength: 4 };
  return { text: `Registered for ${ev}${f.eventCategory === "sponsored" ? " (sponsored)" : ""} · attendance not recorded`, strength: 4 };
}

/** Current company intent, normalised for decisions: "hot" (Surging), "warm", "cold", or "unknown" (not recorded / not synced). */
export function intentLevel(f: LeadFact): "hot" | "warm" | "cold" | "unknown" {
  const l = (f.accountIntent?.level ?? "").toLowerCase();
  if (!l) return "unknown";
  if (l.startsWith("surging") || l.startsWith("hot")) return "hot";
  if (l.startsWith("warm")) return "warm";
  if (l.startsWith("cold")) return "cold";
  return "unknown";
}

/** Verified SQL: an OPEN deal with a Became Qualified to Buy Date (from the deals, not from status text). */
export function sqlDeal(f: LeadFact) {
  return (f.deals ?? []).filter((d) => d.status === "open" && !!d.sqlDate && d.via !== "duplicate_company").sort((a, b) => (b.sqlDate ?? "").localeCompare(a.sqlDate ?? ""))[0] ?? null;
}

/** Active conversation = recent real reply / recent meeting (rules.conversationRecencyDays) or a future meeting. */
export function activeConversation(f: LeadFact, today: string, rules: Rules): string | null {
  const from = addDays(today, -(rules.conversationRecencyDays ?? 30));
  if (f.nextMeetingAt) return `Meeting scheduled ${toDate(f.nextMeetingAt)}`;
  const r = f.inPlayReason ?? "";
  const m = /^(Meeting on|Prospect replied on) (\d{4}-\d{2}-\d{2})/.exec(r);
  if (m && m[2]! >= from) return r;
  return null;
}

/**
 * Decision sequence (per event-lead record):
 *  A. verified SQL (Became Qualified to Buy Date on an open deal)  -> Qualified / handed off (an SDR task due still wins)
 *  B. recent reply needing a response / HubSpot task due            -> Respond now; recent conversation -> In progress
 *  C. company intent Hot/Warm or verified event engagement          -> normal priority; otherwise lower priority
 *  D. SDR outreach: none -> First outreach; done -> Follow up when due; breached deadline -> red
 * An open deal without an SQL date is context only. Old replies/meetings never mean "in conversation".
 */
export function contactAction(f0: LeadFact, today: string, rules: Rules): ContactAction {
  // Re-derive the status from today's rules so stale snapshot labels (e.g. any open deal = "in play") cannot leak in.
  const conv = activeConversation(f0, today, rules);
  const sql = sqlDeal(f0);
  let f = f0;
  if (f0.status === "in_play" && !sql && !conv && f0.inPlayReason !== "Disqualified") {
    const stall = rules.cadence[f0.temperature ?? "Warm"].stallBusinessDays;
    const since = toDate(f0.lastTouchAt);
    const status = f0.touchesSinceEligibility === 0 ? "never_worked" : since && businessDaysBetween(since, today, rules.businessCalendar) > stall ? "stalled" : "first_touch";
    f = { ...f0, status, inPlayReason: null } as LeadFact;
  }
  const w = leadWork(f, today, rules);
  const n = w.overdueBusinessDays ?? 0;
  const bd = (x: number) => `${x} business day${x === 1 ? "" : "s"}`;
  const ia = inactivity(f, today, rules);
  const temp = f.temperature ?? "Lead";
  const slaDays = rules.cadence[f.temperature ?? "Warm"].firstTouchBusinessDays;
  const intent = intentLevel(f);
  const engaged = engagementReason(f).strength <= 1;
  const low = intent === "cold" && !engaged;          // C: no current intent and no verified engagement
  const mk = (group: ContactGroup, action: string, reason: string, color: ActionColor, sort: number): ContactAction =>
    ({ group: low && (group === "first_outreach" || group === "follow_up") && color !== "red" ? "low" : group, action, reason, color: low && color === "amber" ? "grey" : color, due: w.due, overdueBusinessDays: w.overdueBusinessDays, sort: low ? sort + 20 : sort });

  // B (commitments first): reply needing a response, SDR-owned HubSpot task due.
  if (w.dueSource === "reply") return n > 0 ? mk("respond", "Reply to prospect", `Replied ${replyDate(f)}; no response for ${bd(n)}`, "red", 0) : mk("respond", "Reply to prospect", `Replied ${replyDate(f)}`, "amber", 1);
  if (w.dueSource === "task" && (w.section === "overdue" || w.section === "today"))
    return w.section === "overdue" ? mk("respond", "Complete HubSpot task", `${w.why.replace(/^Task: /, "")} · overdue by ${bd(n)}`, "red", 0) : mk("respond", "Complete HubSpot task", `${w.why.replace(/^Task: /, "")} · due today`, "amber", 1);
  // A. verified SQL
  if (sql) return mk("qualified", "AE handoff · qualified", `SQL ${sql.sqlDate} · ${sql.name ?? "deal"}${sql.stageLabel ? ` (${sql.stageLabel})` : ""}`, "green", 8);
  if (w.dueSource === "task") return mk("progress", "Task scheduled", `${w.why.replace(/^Task: /, "")} · due ${w.due}`, "green", 9);
  // B. recent two-way engagement
  if (conv) return mk("progress", "In conversation", conv, "green", 9);
  // Paused / data problems
  if (f.inPlayReason === "Disqualified") return mk("progress", "No action now", "Disqualified in HubSpot", "grey", 10);
  if (f.status === "recently_lost") return mk("progress", "No action now", f.statusReason, "grey", 10);
  if (f.status === "unverifiable") return mk("review", "Check outreach logging", "Outreach is logged on the company, not on this contact", "grey", 7);
  if (!f.eligibilityDate) return mk("review", "Check event data", "Event date missing", "grey", 7);
  // D. outreach
  if (w.dueSource === "sla") {
    if (w.section === "overdue") return mk("first_outreach", "Send first outreach", `${temp} SLA (${slaDays} business days) passed ${bd(n)} ago`, "red", 2);
    if (w.section === "today") return mk("first_outreach", "Send first outreach", `${temp} SLA due today`, "amber", 3);
    return mk("first_outreach", "Send first outreach", `${temp} SLA: due by ${w.due}`, "amber", 4);
  }
  if (f.touchesSinceEligibility === 0) return mk("first_outreach", "Send first outreach", `No SLA deadline (eligible ${f.eligibilityDate}, before the SLA start)`, intent === "hot" || intent === "warm" ? "amber" : "grey", intent === "hot" ? 4 : intent === "warm" ? 5 : 6);
  if (w.dueSource === "cadence") {
    const next = `touch ${f.touchesSinceEligibility + 1}`;
    if (w.section === "overdue") return mk("follow_up", "Send follow-up", `${next} · no touch for ${bd(ia.businessDays ?? 0)} (was due ${w.due})`, "red", 3);
    if (w.section === "today") return mk("follow_up", "Send follow-up", `${next} · due ${w.due && w.due < today ? `since ${w.due}` : "today"}`, "amber", 4);
    if (ia.stale) return mk("follow_up", "Send follow-up", `${next} · no touch for ${bd(ia.businessDays ?? 0)}`, "amber", 5);
    // "Up to date" only with a verified reason: a recent SDR touch and the next one not yet due.
    return mk("progress", "Next touch not due yet", `${next} due by ${w.due} · last SDR touch ${toDate(f.lastTouchAt)}`, "green", 9);
  }
  return mk("review", "Check timing", w.why || "No reliable next step could be determined", "grey", 7);
}

/** One row per contact across all their event-lead records. Touches are distinct activities, never summed per event. */
export function contactWorklist(rows: LeadFact[], today: string, rules: Rules) {
  const by = new Map<string, LeadFact[]>();
  for (const f of rows) if (f.eligible) (by.get(f.contactId) ?? by.set(f.contactId, []).get(f.contactId)!).push(f);
  const gOrder: Record<ContactGroup, number> = { respond: 0, first_outreach: 2, follow_up: 1, qualified: 3, low: 4, review: 5, progress: 6 };
  const items = [...by.values()].map((leads) => {
    const scored = leads.map((f) => ({ f, a: contactAction(f, today, rules), e: engagementReason(f) }));
    scored.sort((x, y) => x.a.sort - y.a.sort || gOrder[x.a.group] - gOrder[y.a.group] || x.e.strength - y.e.strength || (x.a.due ?? "9").localeCompare(y.a.due ?? "9"));
    // A contact already worked on any of their events is never "first outreach".
    let top = scored[0]!;
    if (top.a.group === "first_outreach") top = scored.find((s) => s.a.group !== "first_outreach" && s.f.touchesSinceEligibility > 0) ?? top;
    const f = top.f;
    const best = [...scored].sort((x, y) => x.e.strength - y.e.strength)[0]!.e;
    const ids = new Set(leads.flatMap((l) => l.touchIds));
    const yourTouches = Math.max(0, ...leads.map((l) => l.currentSdrTouches ?? 0));
    const sinceAlloc = leads.some((l) => l.currentSdrTouchesSinceAllocation != null) ? Math.max(0, ...leads.map((l) => l.currentSdrTouchesSinceAllocation ?? 0)) : null;
    const other = leads.map((l) => l.lastOtherSdrTouch).filter((x): x is { at: string; ownerId: string | null } => !!x).sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;
    const lastOut = leads.map((l) => ({ at: l.lastOutboundAt !== undefined ? l.lastOutboundAt : l.lastTouchAt, by: l.lastOutboundAt !== undefined ? l.lastOutboundOwnerId ?? null : l.lastTouchOwnerId ?? null, kind: l.lastOutboundKind ?? null }))
      .filter((x) => x.at).sort((a, b) => b.at!.localeCompare(a.at!))[0] ?? null;
    const ia = inactivity(f, today, rules);
    const deals = leads.flatMap((l) => l.deals ?? []).filter((d, i, a) => a.findIndex((x) => x.id === d.id) === i);
    const sqlD = deals.filter((d) => d.status === "open" && d.sqlDate).sort((a, b) => (b.sqlDate ?? "").localeCompare(a.sqlDate ?? ""))[0] ?? null;
    const openDeal = sqlD ?? deals.find((d) => d.status === "open") ?? null;
    const anyMissingSql = deals.some((d) => d.status === "open" && !d.sqlDate);
    return {
      contactId: f.contactId, contactName: f.contactName, jobTitle: f.jobTitle, contactEmail: f.contactEmail,
      companyId: f.companyId, companyName: f.companyName, sdrOwnerId: f.sdrOwnerId, sdrName: f.sdrOwnerId ? rosterById.get(f.sdrOwnerId)?.name ?? null : null,
      sdrSource: f.sdrSource ?? null, allocationDate: f.allocationDate, eligibilityDate: f.eligibilityDate,
      temperature: f.temperature ?? (f.temperatureRaw || null), engagement: best.text, engagementStrength: best.strength,
      intent: { level: intentLevel(f), raw: f.accountIntent?.level ?? null, since: f.accountIntent?.since ?? null, reason: f.accountIntent?.reason ?? null,
        recentSignals: f.accountIntent?.recentSignals ?? null, warmAt: f.accountIntent?.warmAt ?? null, surgingAt: f.accountIntent?.surgingAt ?? null, coldAt: f.accountIntent?.coldAt ?? null,
        sdrCategory: f.accountIntent?.sdrCategory ?? null, lifecycleCustom: f.accountIntent?.lifecycleCustom ?? null, icp: f.accountIntent?.icp ?? f.icpTier ?? null,
        engagementScore: f.accountIntent?.engagementScore ?? null, factorsIntent: f.accountIntent?.factorsIntent ?? null,
        synced: !!f.accountIntent },
      lastReplyAt: f.lastReplyAt ?? null, conversation: activeConversation(f, today, rules), ownership: f.ownership ?? null, intentRank: ({ hot: 0, warm: 1, unknown: 2, cold: 3 } as const)[intentLevel(f)],
      ...top.a, eventId: f.eventId,
      yourTouches, yourTouchesSinceAllocation: sinceAlloc, sdrTouchesAny: ids.size,
      otherSdrTouches: Math.max(0, ...leads.map((l) => l.otherSdrTouches ?? 0)), lastOtherSdrTouch: other,
      lastOutboundAt: lastOut?.at ?? null, lastOutboundOwnerId: lastOut?.by ?? null, lastOutboundKind: lastOut?.kind ?? null,
      daysSinceTouch: ia.businessDays, nextTask: f.nextTaskDue ? { due: f.nextTaskDue, subject: f.nextTaskSubject ?? null, ownerId: f.nextTaskOwnerId ?? null } : null,
      sql: sqlD ? "yes" : "no", sqlNote: anyMissingSql ? "open deal has no Became Qualified to Buy Date" : null,
      deal: openDeal ? { name: openDeal.name, stage: openDeal.stageLabel, id: openDeal.id, via: openDeal.via, ownerId: openDeal.ownerId ?? null, sqlDate: openDeal.sqlDate ?? null } : null,
      deals,
      events: leads.map((l) => ({ id: l.eventId, name: l.eventName, date: l.eventDate, category: l.eventCategory, attendance: l.attendance })),
    };
  });
  items.sort((a, b) => a.sort - b.sort || a.intentRank - b.intentRank || a.engagementStrength - b.engagementStrength || (a.temperature === "Hot" ? -1 : 0) - (b.temperature === "Hot" ? -1 : 0) || (a.due ?? "9").localeCompare(b.due ?? "9"));
  const counts = Object.fromEntries(CONTACT_GROUPS.map((g) => [g.key, items.filter((i) => i.group === g.key).length])) as Record<ContactGroup, number>;
  return { groups: CONTACT_GROUPS, counts, items };
}
