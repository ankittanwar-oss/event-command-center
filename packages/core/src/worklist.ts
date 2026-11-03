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

const ORDER: Record<WorkSection, number> = { respond: 0, overdue: 1, today: 2, upcoming: 3, monitor: 4 };

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
  return [ORDER[w.section], dueKey, temp, eng, -w.lead.priority];
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
