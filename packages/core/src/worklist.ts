// SDR daily worklist: turns lead facts into ONE next action per account, placed in exactly one section.
// Presentation logic only: it reads existing facts and rules and never changes status, SLA or any reported metric.
import { rosterById, type CadenceRule, type Rules } from "./config.js";
import { expectedTouches } from "./leads.js";
import { DISPOSITION_CODES, dispositionsFor, type DispositionSet } from "./dispositions.js";
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

export type WorkAction = "Follow-up opportunity" | "Respond" | "Send first outreach" | "Follow up" | "Complete HubSpot task" | "Monitor" | "Paused" | "Review next step" | "Needs review";

export interface WorkItem {
  section: WorkSection;
  action: WorkAction;
  why: string;
  due: string | null;               // YYYY-MM-DD, only when established from a verified trigger
  dueSource: "reply" | "task" | "sla" | "cadence" | null;
  overdueBusinessDays: number | null;
  lead: LeadFact;
  historicalDue?: string | null;    // an earlier cadence step that was missed but later fulfilled (context only)
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

  // 5. Worked. Policy: the first-touch SLA is the ONLY mandatory cadence. After first outreach the SDR owns follow-up
  //    timing: no automatic follow-up due dates, no cadence overdue. We only report how long it has been.
  const last = toDate(f.lastTouchAt);
  if (!last) return item("monitor", "Needs review", "Last qualifying touch date unknown");
  const bdSince = businessDaysBetween(last, today, rules.businessCalendar);
  return item("monitor", "Follow-up opportunity", `Last SDR touch ${last} (${bdSince} business day${bdSince === 1 ? "" : "s"} ago) · ${f.touchesSinceEligibility} touch${f.touchesSinceEligibility === 1 ? "" : "es"} (6–7 recommended)`);
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
    else if (w.action === "Follow-up opportunity") followUp = "Follow-up opportunity (no deadline)";
    else if (w.action === "Review next step") followUp = "Cadence complete – review";
    else followUp = `Follow-up timing unverified (${w.why})`;
  }
  const cadence = !f.eligible ? null : `${t} touch${t === 1 ? "" : "es"} (${min}–${max} recommended)`;
  // action health (mutually exclusive)
  let health: ActionHealth;
  const fiveBd = addBusinessDays(today, 5, rules);
  if (w.section === "overdue" || (w.section === "respond" && w.due! < today)) health = "overdue";
  else if (w.section === "today" || w.section === "respond") health = "due_today";
  else if (w.section === "upcoming") health = w.due && w.due <= fiveBd ? "upcoming" : "not_yet_due";
  else if (w.action === "Follow-up opportunity") health = "not_yet_due";
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
  let followUp: "today" | "upcoming" | "overdue" | "unverified" | "complete" | "open" | null = null;
  if (f.touchesSinceEligibility > 0) {
    if (w.section === "overdue") followUp = "overdue";
    else if (w.section === "today") followUp = "today";
    else if (w.section === "respond") followUp = w.due && w.due < today ? "overdue" : "today";
    else if (w.section === "upcoming") followUp = "upcoming";
    else if (w.action === "Follow-up opportunity") followUp = "open";
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
    case "cadence": break; // no longer produced: follow-up timing is SDR-owned
  }
  if (w.section === "stale") return mk("No touch in 14+ business days", "grey", f.touchesSinceEligibility === 0 ? "Send first outreach" : "Follow up", "none");
  if (w.action === "Follow-up opportunity") {
    const n2 = f.lastTouchAt ? businessDaysBetween(toDate(f.lastTouchAt)!, today, rules.businessCalendar) : 0;
    return mk(`Last contacted ${n2} business day${n2 === 1 ? "" : "s"} ago`, n2 < 7 ? "green" : "grey", n2 >= 14 ? "Follow-up opportunity (no deadline)" : "Follow up when appropriate", "none");
  }
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
  { key: "progress", label: "Up to date", hint: "Next touch not due yet, task scheduled, or in conversation" },
  { key: "paused", label: "Paused / closed", hint: "Verified commercial reason to stop or defer outreach" },
] as const;
export type ContactGroup = (typeof CONTACT_GROUPS)[number]["key"];

export interface ContactAction { group: ContactGroup; action: string; reason: string; color: ActionColor; due: string | null; overdueBusinessDays: number | null; sort: number; historicalDue?: string | null }

/** Why this contact matters, from verified evidence only. Sponsored-event attendance is not SpotDraft engagement. */
/** CONTACT engagement priority (dashboard-only, from verified evidence; independent of company intent):
 *   0 P1 high intent: real reply / meeting (recent or scheduled)
 *   1 P2 verified attendance at a SpotDraft-run event (owned, webinar, roundtable)
 *   2 P3 verified attendance at a sponsored conference (SpotDraft engagement unverified)
 *   3 P4 registered only / attendance unknown
 *   4 P5 no qualifying individual engagement (e.g. confirmed no-show): company intent only */
export const ENGAGEMENT_LABEL = ["High intent", "Verified attendee", "Conference attendee", "Registered only", "Company intent only"] as const;
export function engagementReason(f: LeadFact): { text: string; strength: number; label: string; participation: string } {
  const p = f.participation ?? (f.attendance === "attended" ? "attended" : f.attendance === "no_show" ? "registered_only" : "unknown");
  const mk = (text: string, strength: number) => ({ text, strength, label: ENGAGEMENT_LABEL[strength]!, participation: p });
  const reply = /^Prospect replied/.test(f.inPlayReason ?? "") ? replyDate(f) : null;
  if (reply) return mk(`Replied to SDR ${reply}`, 0);
  if (f.nextMeetingAt) return mk(`Meeting scheduled ${toDate(f.nextMeetingAt)}`, 0);
  if (/^Meeting on/.test(f.inPlayReason ?? "")) return mk((f.inPlayReason ?? "").replace("Meeting on", "Meeting"), 0);
  const ev = f.eventName.split(/[|:]/)[0]!.trim().slice(0, 40);
  if (p === "attended") return f.eventCategory === "sponsored" ? mk(`Attended ${ev} (conference; SpotDraft engagement unverified)`, 2) : mk(`Verified attendee: ${ev}`, 1);
  if (p === "no_show") return mk(`Registered for ${ev}; confirmed no-show`, 4);
  if (p === "registered_only") return mk(`Registered for ${ev}; no attendance record`, 3);
  return mk(`Registered for ${ev}; attendance unknown`, 3);
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
const firstName = (f: LeadFact) => (f.sdrOwnerId ? rosterById.get(f.sdrOwnerId)?.name.split(" ")[0] : null) ?? "the SDR";

export function contactAction(f0: LeadFact, today: string, rules: Rules, disp?: DispositionSet): ContactAction {
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
    ({ group: low && (group === "first_outreach" || group === "follow_up") && color !== "red" ? "low" : group, action, reason, color: low && color === "amber" ? "grey" : color, due: w.due, overdueBusinessDays: w.overdueBusinessDays, sort: low ? sort + 20 : sort, historicalDue: w.historicalDue ?? null });

  // Verified contact disposition (dashboard-confirmed or structured HubSpot): no routine cadence alerts.
  // A new reply or an SDR task due still surfaces first (handled below only when no disposition applies to them).
  const dsp = dispositionsFor(f0, disp, today).contact;
  if (dsp && w.dueSource !== "reply" && !(w.dueSource === "task" && (w.section === "overdue" || w.section === "today")))
    return { group: "paused", action: DISPOSITION_CODES[dsp.code], reason: `${dsp.reason ?? ""}${dsp.source === "hubspot" ? " (from HubSpot)" : dsp.confirmedBy ? ` · confirmed by ${dsp.confirmedBy}` : ""}${dsp.revisitDate ? ` · revisit ${dsp.revisitDate}` : ""}`, color: "grey", due: dsp.revisitDate, overdueBusinessDays: null, sort: 11 };
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
  if (w.action === "Follow-up opportunity") {
    // Informational only: no deadline, never red/amber. Recency bands are neutral guidance.
    const n2 = ia.businessDays ?? 0;
    const ago = `Last contacted ${n2} business day${n2 === 1 ? "" : "s"} ago by ${firstName(f)}`;
    if (n2 < 7) return mk("progress", "Recently contacted", `${ago} · ${f.touchesSinceEligibility} touch${f.touchesSinceEligibility === 1 ? "" : "es"}`, "green", 9);
    return mk("follow_up", n2 >= 30 ? "No activity in 30+ business days" : n2 >= 14 ? "Stale activity · follow-up opportunity" : "Follow-up opportunity", `${ago} · ${f.touchesSinceEligibility} touch${f.touchesSinceEligibility === 1 ? "" : "es"} (6–7 recommended, not required)`, "grey", n2 >= 14 ? 5 : 6);
  }
  return mk("review", "Check timing", w.why || "No reliable next step could be determined", "grey", 7);
}

/** One row per contact across all their event-lead records. Touches are distinct activities, never summed per event. */
export function contactWorklist(rows: LeadFact[], today: string, rules: Rules, disp?: DispositionSet) {
  const by = new Map<string, LeadFact[]>();
  for (const f of rows) if (f.eligible) (by.get(f.contactId) ?? by.set(f.contactId, []).get(f.contactId)!).push(f);
  const gOrder: Record<ContactGroup, number> = { respond: 0, first_outreach: 2, follow_up: 1, qualified: 3, low: 4, review: 5, progress: 6, paused: 7 };
  const items = [...by.values()].map((leads) => {
    const scored = leads.map((f) => ({ f, a: contactAction(f, today, rules, disp), e: engagementReason(f) }));
    scored.sort((x, y) => x.a.sort - y.a.sort || gOrder[x.a.group] - gOrder[y.a.group] || x.e.strength - y.e.strength || (x.a.due ?? "9").localeCompare(y.a.due ?? "9"));
    // A contact already worked on any of their events is never "first outreach".
    let top = scored[0]!;
    if (top.a.group === "first_outreach") top = scored.find((s) => s.a.group !== "first_outreach" && s.f.touchesSinceEligibility > 0) ?? top;
    const f = top.f;
    const best = [...scored].sort((x, y) => x.e.strength - y.e.strength)[0]!.e;
    const ids = new Set(leads.flatMap((l) => l.touchIds));
    const yourTouches = Math.max(0, ...leads.map((l) => l.currentSdrTouches ?? 0));
    const yourLastTouchAt = leads.map((l) => l.currentSdrLastTouchAt ?? null).filter((x): x is string => !!x).sort().pop() ?? null;
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
      disposition: dispositionsFor(f, disp, today).contact, companyDisposition: dispositionsFor(f, disp, today).company,
      lastReplyAt: f.lastReplyAt ?? null, conversation: activeConversation(f, today, rules), ownership: f.ownership ?? null, intentRank: ({ hot: 0, warm: 1, unknown: 2, cold: 3 } as const)[intentLevel(f)],
      ...top.a, eventId: f.eventId,
      yourTouches, yourLastTouchAt, yourTouchesSinceAllocation: sinceAlloc, sdrTouchesAny: ids.size,
      otherSdrTouches: Math.max(0, ...leads.map((l) => l.otherSdrTouches ?? 0)), lastOtherSdrTouch: other,
      lastOutboundAt: lastOut?.at ?? null, lastOutboundOwnerId: lastOut?.by ?? null, lastOutboundKind: lastOut?.kind ?? null,
      daysSinceTouch: ia.businessDays, nextTask: f.nextTaskDue ? { due: f.nextTaskDue, subject: f.nextTaskSubject ?? null, ownerId: f.nextTaskOwnerId ?? null } : null,
      sql: sqlD ? "yes" : "no", sqlNote: anyMissingSql ? "open deal has no Became Qualified to Buy Date" : null,
      deal: openDeal ? { name: openDeal.name, stage: openDeal.stageLabel, id: openDeal.id, via: openDeal.via, ownerId: openDeal.ownerId ?? null, sqlDate: openDeal.sqlDate ?? null } : null,
      deals,
      events: leads.map((l) => ({ id: l.eventId, name: l.eventName, date: l.eventDate, category: l.eventCategory, attendance: l.attendance,
        participation: l.participation ?? (l.attendance === "attended" ? "attended" : "unknown"), participationSource: l.participationSource ?? null })),
      engagementLabel: best.label, scores: f.contactScores ?? null,
    };
  });
  items.sort((a, b) => a.sort - b.sort || a.intentRank - b.intentRank || a.engagementStrength - b.engagementStrength || (a.temperature === "Hot" ? -1 : 0) - (b.temperature === "Hot" ? -1 : 0) || (a.due ?? "9").localeCompare(b.due ?? "9"));
  const counts = Object.fromEntries(CONTACT_GROUPS.map((g) => [g.key, items.filter((i) => i.group === g.key).length])) as Record<ContactGroup, number>;
  return { groups: CONTACT_GROUPS, counts, items };
}

// ---------------------------------------------------------------------------------------------------------------
// ACCOUNT-FIRST execution. SDRs work accounts: an account is WORKED once the current SDR has at least one qualifying
// outreach (since the event) to at least one of its eligible event contacts. Contact coverage is depth, not a
// mandate. Each account sits in ONE primary bucket; every contact keeps its own action.
// ---------------------------------------------------------------------------------------------------------------
export const ACCOUNT_BUCKETS = [
  { key: "respond", label: "Respond now", hint: "A prospect replied, or a HubSpot task is due" },
  { key: "first_outreach", label: "First outreach", hint: "Account not worked yet: no qualifying outreach by the SDR to any contact" },
  { key: "follow_up", label: "Follow-up opportunities", hint: "Worked, no recent SDR outreach (7+ business days). No deadline: the SDR decides" },
  { key: "review", label: "Needs review", hint: "Missing or contradictory data" },
  { key: "progress", label: "In progress", hint: "Worked recently, in conversation, or a task scheduled" },
  { key: "paused", label: "Paused / closed", hint: "Verified company-wide disposition, or every worked contact is paused" },
  { key: "low", label: "Lower priority", hint: "Not worked; Cold intent and no verified engagement" },
  { key: "qualified", label: "Qualified / handed off", hint: "Verified SQL; no outstanding SDR action" },
] as const;
export type AccountBucket = (typeof ACCOUNT_BUCKETS)[number]["key"];

type CItem = ReturnType<typeof contactWorklist>["items"][number];

export function accountWorklist(items: CItem[], today?: string, rules?: Rules) {
  const by = new Map<string, CItem[]>();
  for (const i of items) { const k = i.companyId ?? `contact:${i.contactId}`; (by.get(k) ?? by.set(k, []).get(k)!).push(i); }
  const order: Record<string, number> = { respond: 0, follow_up: 1, first_outreach: 2, review: 3, progress: 4, low: 5, qualified: 6, paused: 7 };
  const accounts = [...by.entries()].map(([key, cs]) => {
    const worked = cs.filter((c) => c.yourTouches > 0);
    const isWorked = worked.length > 0;
    const lastSdr = cs.map((c) => c.yourLastTouchAt).filter(Boolean).sort().pop() ?? null;
    const accountDays = lastSdr && today && rules ? businessDaysBetween(toDate(lastSdr)!, today, rules.businessCalendar)
      : (() => { const v = worked.map((c) => c.daysSinceTouch).filter((x): x is number => x !== null && x !== undefined); return v.length ? Math.min(...v) : null; })();
    const has = (g: string, list: CItem[] = cs) => list.some((c) => c.group === g);
    const companyDisp = cs.map((c) => c.companyDisposition).find(Boolean) ?? null;
    let bucket: AccountBucket;
    if (has("respond")) bucket = "respond";
    else if (companyDisp) bucket = "paused";
    else if (has("qualified")) bucket = "qualified";
    else if (!isWorked) bucket = has("first_outreach") ? "first_outreach" : has("review") ? "review" : has("low") ? "low"
      : cs.every((c) => c.group === "paused") ? "paused" : "progress";
    // ACCOUNT recency = the selected SDR's latest qualifying outreach to ANY contact (never the stalest contact).
    else if (accountDays !== null && accountDays < 7) bucket = worked.every((c) => c.group === "paused") ? "paused" : "progress";
    else if (worked.every((c) => c.group === "paused") && !has("progress")) bucket = "paused";
    else if (has("follow_up", worked) || has("progress", worked)) bucket = accountDays !== null && accountDays >= 7 ? "follow_up" : "progress";
    else if (has("review", worked)) bucket = "review";
    else bucket = "progress";
    // Within a worked account, untouched contacts are optional multithreading, not "first outreach" for the account.
    const contacts = cs.map((c) => (isWorked && (c.group === "first_outreach" || c.group === "low") ? { ...c, multithread: true } : c));
    contacts.sort((a, b) => (order[a.group] ?? 9) - (order[b.group] ?? 9) || a.sort - b.sort);
    const top = contacts.find((c) => !(c as any).multithread && c.group !== "paused") ?? contacts[0]!;
    const count = (g: string) => cs.filter((c) => c.group === g).length;
    const daysSinceLast = isWorked ? accountDays : null;
    // Account-level primary status (independent of individual contacts' recency).
    const bd = (n: number) => `${n} business day${n === 1 ? "" : "s"} ago`;
    let primary: { action: string; reason: string; color: ActionColor };
    if (bucket === "respond" || bucket === "first_outreach" || bucket === "review" || bucket === "low" || bucket === "qualified") primary = { action: top.action, reason: top.reason, color: top.color };
    else if (bucket === "paused") primary = { action: companyDisp ? "Paused company-wide" : "No routine outreach", reason: companyDisp?.reason ?? "Every worked contact is paused", color: "grey" };
    else if (daysSinceLast === null) primary = { action: top.action, reason: top.reason, color: top.color };
    else if (daysSinceLast < 7) primary = { action: "Recently contacted", reason: `Last account outreach ${bd(daysSinceLast)}`, color: "green" };
    else primary = { action: daysSinceLast >= 30 ? "No activity in 30+ business days" : daysSinceLast >= 14 ? "Stale activity · follow-up opportunity" : "Follow-up opportunity", reason: `Last account outreach ${bd(daysSinceLast)}`, color: "grey" };
    // Secondary, informational opportunities inside the account.
    const attendees = cs.filter((c) => c.events.some((e: any) => e.participation === "attended")).length;
    const registeredOnly = cs.filter((c) => !c.events.some((e: any) => e.participation === "attended") && c.events.some((e: any) => e.participation === "registered_only" || e.participation === "unknown")).length;
    const best = [...cs].sort((x, y) => x.engagementStrength - y.engagementStrength || (y.yourTouches > 0 ? 0 : 1) - (x.yourTouches > 0 ? 0 : 1))[0]!;
    const inactive30 = worked.filter((c) => (c.daysSinceTouch ?? 0) >= 30 && c.group !== "paused").length;
    const opportunities = [inactive30 ? `${inactive30} contact${inactive30 === 1 ? "" : "s"} inactive 30+ business days` : null, cs.length - worked.length ? `${cs.length - worked.length} contact${cs.length - worked.length === 1 ? "" : "s"} not worked` : null].filter(Boolean).join(" · ");
    return {
      primary, opportunities, attendees, registeredOnly,
      bestContact: { contactId: best.contactId, name: best.contactName, title: best.jobTitle, engagement: best.engagement, label: (best as any).engagementLabel, strength: best.engagementStrength },
      daysSinceLast, slaBreach: !isWorked && cs.some((c) => c.group === "first_outreach" && c.color === "red"),
      overdueCommitment: cs.some((c) => c.group === "respond" && c.color === "red"),
      key, companyId: cs[0]!.companyId, companyName: cs[0]!.companyName ?? cs[0]!.contactName, intent: cs[0]!.intent, sdrOwnerId: cs[0]!.sdrOwnerId, sdrName: cs[0]!.sdrName,
      bucket, worked: isWorked, top, contacts, companyDisposition: companyDisp,
      coverage: {
        available: cs.length, worked: worked.length, notWorked: cs.length - worked.length,
        active: cs.filter((c) => c.conversation).length, paused: count("paused"), qualified: count("qualified"),
      },
      actions: { respond: count("respond"), follow_up: count("follow_up"), first_outreach: count("first_outreach"), review: count("review"), progress: count("progress"), paused: count("paused"), low: count("low"), qualified: count("qualified") },
      lastSdrTouch: lastSdr, conversation: cs.some((c) => c.conversation),
    };
  });
  const rank: Record<string, number> = Object.fromEntries(ACCOUNT_BUCKETS.map((b, i) => [b.key, i]));
  // Within a bucket: urgency (tasks, replies, SLA), then the best CONTACT's verified engagement, then COMPANY intent.
  accounts.sort((a, b) => rank[a.bucket]! - rank[b.bucket]! || a.top.sort - b.top.sort || a.bestContact.strength - b.bestContact.strength || (a.top.intentRank ?? 2) - (b.top.intentRank ?? 2) || (a.companyName ?? "").localeCompare(b.companyName ?? ""));
  return accounts;
}

type Acct = ReturnType<typeof accountWorklist>[number];
/** Metric predicates: the SAME functions produce the CMO counts and the drill-down lists, so they always reconcile. */
export const ACCOUNT_METRICS: Record<string, { label: string; test: (a: Acct) => boolean; contactsOnly?: (c: Acct["contacts"][number]) => boolean }> = {
  eligible: { label: "Eligible accounts", test: () => true },
  worked: { label: "Accounts worked", test: (a) => a.worked },
  not_worked: { label: "Not worked", test: (a) => !a.worked },
  need_follow_up: { label: "Follow-up opportunities", test: (a) => a.bucket === "follow_up" },
  stale14: { label: "Worked, no outreach in 14+ business days", test: (a) => a.worked && (a.daysSinceLast ?? 0) >= 14 },
  sla_breach: { label: "First-touch SLA breached", test: (a) => a.slaBreach },
  overdue_commitment: { label: "Overdue HubSpot task / reply", test: (a) => a.overdueCommitment },
  contacts_worked: { label: "Contacts worked", test: (a) => a.coverage.worked > 0, contactsOnly: (c) => c.yourTouches > 0 },
  one_contact: { label: "Accounts with 1 contact worked", test: (a) => a.coverage.worked === 1 },
  two_plus: { label: "Accounts with 2+ contacts worked", test: (a) => a.coverage.worked >= 2 },
  active: { label: "In conversation", test: (a) => a.conversation },
  paused: { label: "Paused / closed", test: (a) => a.bucket === "paused" },
  paused_company: { label: "Paused company-wide", test: (a) => !!a.companyDisposition },
  qualified: { label: "Qualified", test: (a) => a.bucket === "qualified" },
};

/** Account-level execution summary (CMO + Daily). Counts unique company ids; contacts are eligible event contacts. */
export function accountSummary(accounts: ReturnType<typeof accountWorklist>) {
  const M = ACCOUNT_METRICS;
  const n = (p: (a: (typeof accounts)[number]) => boolean) => accounts.filter(p).length;
  const contacts = accounts.reduce((s, a) => s + a.coverage.available, 0);
  const contactsWorked = accounts.reduce((s, a) => s + a.coverage.worked, 0);
  const contactDisp: Record<string, number> = {}, companyDisp: Record<string, number> = {};
  for (const a of accounts) {
    if (a.companyDisposition) companyDisp[a.companyDisposition.code] = (companyDisp[a.companyDisposition.code] ?? 0) + 1;
    for (const c of a.contacts) if (c.disposition) contactDisp[c.disposition.code] = (contactDisp[c.disposition.code] ?? 0) + 1;
  }
  return {
    accounts: accounts.length, worked: n(M.worked!.test), notWorked: n(M.not_worked!.test),
    coveragePct: accounts.length ? Math.round((n(M.worked!.test) / accounts.length) * 1000) / 10 : null,
    needFollowUp: n(M.need_follow_up!.test), respond: n((a) => a.bucket === "respond"), active: n(M.active!.test),
    qualified: n(M.qualified!.test), paused: n(M.paused!.test), pausedCompanyWide: n(M.paused_company!.test),
    oneContactWorked: n(M.one_contact!.test), twoPlusWorked: n(M.two_plus!.test),
    stale14: n(M.stale14!.test), slaBreach: n(M.sla_breach!.test), overdueCommitment: n(M.overdue_commitment!.test),
    medianDaysSinceLast: (() => { const v = accounts.filter((a) => a.worked && a.daysSinceLast !== null).map((a) => a.daysSinceLast!).sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)]! : null; })(),
    workedButQuiet: n((a) => a.worked && a.bucket === "follow_up"),
    contacts, contactsWorked, contactCoveragePct: contacts ? Math.round((contactsWorked / contacts) * 1000) / 10 : null,
    dispositions: { contact: contactDisp, company: companyDisp },
    buckets: Object.fromEntries(ACCOUNT_BUCKETS.map((b) => [b.key, { accounts: n((a) => a.bucket === b.key), contacts: accounts.filter((a) => a.bucket === b.key).reduce((s, a) => s + a.coverage.available, 0) }])),
  };
}
