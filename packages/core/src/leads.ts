import { contactTouches, touchKind } from "./activities.js";
import { isRosterSdr, sdrRegion, type CadenceRule, type Rules } from "./config.js";
import { addDays, businessDaysBetween, daysBetween, fiscalQuarterOf, isoWeek, maxDay, toDate } from "./dates.js";
import type {
  Activity, AttendanceStatus, Company, Contact, Deal, DealRef, EventContact, EventRecord, FollowUpStatus, LeadFact, Task, Temperature,
} from "./types.js";

export interface Dataset {
  companies: Map<string, Company>;
  contacts: Map<string, Contact>;
  events: Map<string, EventRecord>;
  eventContacts: EventContact[];
  activitiesByContact: Map<string, Activity[]>;
  activitiesByCompany: Map<string, Activity[]>;
  tasksByContact: Map<string, Task[]>;
  dealsByContact: Map<string, Deal[]>;
  dealsByCompany: Map<string, Deal[]>;
}

export const STATUS_LABEL: Record<FollowUpStatus, string> = {
  never_worked: "Never Worked",
  first_touch: "First Touch Completed",
  active: "Actively Worked",
  stalled: "Follow-Up Stalled",
  in_play: "Completed / In Play",
  unverifiable: "Unable to Verify",
  recently_lost: "Recently Closed Lost",
};

const PRIORITY_TIERS = new Set(["Targetable - Tier 1A", "Tier 1", "Targetable - Tier 1", "Targetable - Tier 2"]);

export function mapTemperature(raw: string | null, rules: Rules): Temperature | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (rules.temperature.hotValues.some((h) => h.toLowerCase() === v)) return "Hot";
  if (rules.temperature.warmValues.some((w) => w.toLowerCase() === v)) return "Warm";
  return null;
}

/** Expected cumulative touches at a given lead age, linear between the configured checkpoints (rounded down). */
export function expectedTouches(ageDays: number, rule: CadenceRule): number {
  const pts = [...rule.cadence].sort((a, b) => a.day - b.day);
  if (!pts.length) return 1;
  if (ageDays <= pts[0]!.day) return pts[0]!.touches;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    if (ageDays <= b.day) return Math.floor(a.touches + ((b.touches - a.touches) * (ageDays - a.day)) / (b.day - a.day));
  }
  return pts[pts.length - 1]!.touches;
}

export function attendanceFor(ec: EventContact, contact: Contact | undefined, ev: EventRecord, eventHasAttendance: boolean, rules: Rules, today: string): AttendanceStatus {
  if (!ev.date || ev.date > today) return "unknown";
  // The roundtable sheet is the source of truth for attendance when it has a Yes/No for this person.
  if (ec.sheetAttended === true) return "attended";
  if (ec.sheetAttended === false) return "no_show";
  const inWindow = (d: string | null) => {
    if (!d) return false;
    const diff = daysBetween(ev.date!, d);
    return diff >= -rules.attendanceWindow.daysBefore && diff <= rules.attendanceWindow.daysAfter;
  };
  if (inWindow(toDate(ec.attendedAt)) || inWindow(toDate(contact?.attendedDate ?? null))) return "attended";
  return eventHasAttendance ? "no_show" : "unknown";
}

/** Which events have any recorded attendance? Without it, "not attended" cannot be distinguished from "not recorded". */
export function eventsWithAttendance(ds: Dataset, rules: Rules, today: string): Set<string> {
  const out = new Set<string>();
  for (const ec of ds.eventContacts) {
    const ev = ds.events.get(ec.eventId);
    if (!ev || out.has(ev.id)) continue;
    const a = attendanceFor(ec, ds.contacts.get(ec.contactId), ev, false, rules, today);
    if (a === "attended") out.add(ev.id);
  }
  return out;
}

export function computeLeadFacts(ds: Dataset, rules: Rules, today: string): LeadFact[] {
  const withAttendance = eventsWithAttendance(ds, rules, today);
  const facts: LeadFact[] = [];
  for (const ec of ds.eventContacts) {
    const ev = ds.events.get(ec.eventId);
    const contact = ds.contacts.get(ec.contactId);
    if (!ev || !contact) continue;
    const f = computeLeadFact(ds, ev, contact, ec, withAttendance.has(ev.id), rules, today);
    if (!isExcludedCompany(f, rules)) facts.push(f);
  }
  return facts;
}

export function computeLeadFact(
  ds: Dataset, ev: EventRecord, contact: Contact, ec: EventContact, eventHasAttendance: boolean, rules: Rules, today: string,
): LeadFact {
  const dq: string[] = [];
  const company = contact.companyId ? ds.companies.get(contact.companyId) ?? null : null;
  if (!contact.companyId) dq.push("contact_without_company");
  else if (!company) dq.push("company_not_synced");

  const temperature = mapTemperature(company?.temperatureRaw ?? null, rules);
  if (company && !company.temperatureRaw) dq.push("temperature_missing");
  if (company?.temperatureRaw && !temperature && !["cold"].includes(company.temperatureRaw.toLowerCase())) dq.push("temperature_unmapped_value");

  // SDR: the company SDR Owner. Pod routing: if the company's AE owner belongs to a pod and the SDR Owner is not one of
  // the pod SDRs (empty, the outreach pseudo-SDR, or anyone else), the pod's SDR owns the account.
  const companySdr = company?.sdrOwnerId ?? null;
  const podMap = rules.podAeToSdr ?? {};
  const podSdrs = new Set(Object.values(podMap));
  const podSdr = company?.hubspotOwnerId ? podMap[company.hubspotOwnerId] ?? null : null;
  const viaPod = !!podSdr && !(companySdr && podSdrs.has(companySdr));
  const sdrRaw = viaPod ? podSdr : companySdr;
  const sdr = isRosterSdr(sdrRaw) ? sdrRaw : null;
  if (company && !companySdr && !viaPod) dq.push("sdr_missing");
  else if (sdrRaw && !sdr) dq.push("sdr_not_on_roster");

  const allocationDate = toDate(company?.allocationDate ?? null);
  if (sdr && !allocationDate) dq.push("allocation_date_missing");
  if (!ev.date) dq.push("event_date_missing");
  if (ev.category === "uncategorized") dq.push("event_uncategorized");
  if (company && !company.icpTier) dq.push("icp_tier_missing");

  const attendance = attendanceFor(ec, contact, ev, eventHasAttendance, rules, today);
  const isUpcoming = !!ev.date && ev.date > today;

  const contactActs = ds.activitiesByContact.get(contact.id) ?? [];
  const companyActs = company ? ds.activitiesByCompany.get(company.id) ?? [] : [];
  const ignoreDeal = rules.ignoredDealNamePattern ? new RegExp(rules.ignoredDealNamePattern, "i") : null;
  const deals = uniqueDeals([...(ds.dealsByContact.get(contact.id) ?? []), ...(company ? ds.dealsByCompany.get(company.id) ?? [] : [])])
    .filter((d) => !(ignoreDeal && d.name && ignoreDeal.test(d.name)));
  // Deals on duplicate company records (same normalised name, same SDR owner): context and recently-lost only.
  const ownDealIds = new Set(deals.map((d) => d.id));
  const siblingDeals = (rules.matchDuplicateCompanies && company ? duplicateCompanies(ds, company) : [])
    .flatMap((c) => ds.dealsByCompany.get(c.id) ?? [])
    .filter((d) => !ownDealIds.has(d.id) && !(ignoreDeal && d.name && ignoreDeal.test(d.name)));

  // ---- prior conversation (before the event): meeting, prospect reply, or deal that already existed
  const priorConversation = !!ev.date && (
    contactActs.some((a) => (a.kind === "MEETING" || a.kind === "INCOMING_EMAIL") && toDate(a.timestamp)! < ev.date! && daysBetween(toDate(a.timestamp)!, ev.date!) <= 365) ||
    deals.some((d) => d.createdAt && toDate(d.createdAt)! < ev.date!)
  );

  // ---- eligibility
  const tier = company?.icpTier ?? null;
  const isCompetitor = !!company?.competitorFlag && rules.competitorValues.includes(company.competitorFlag.trim().toLowerCase());
  const isCustomer = [contact.lifecycleStage, company?.lifecycleStage].some((s) => !!s && rules.customerLifecycleStages.includes(s.toLowerCase()));
  let reason: string | null = null;
  if (!ev.date) reason = "Event date missing";
  else if (isUpcoming) reason = "Upcoming event";
  else if (!company) reason = "No associated company";
  else if (isCompetitor) reason = "Competitor";
  else if (isCustomer) reason = "Existing customer";
  else if (contact.doNotContact) reason = "Do not contact";
  else if (rules.requireHotWarm !== false && !temperature) reason = company.temperatureRaw ? `Lead temperature is ${company.temperatureRaw}` : "Lead temperature not set";
  else if (!tier) reason = "ICP tier missing";
  else if (!rules.eligibleIcpTiers.includes(tier)) reason = `Not targetable or workable (${tier})`;
  else if (!sdr) reason = sdrRaw ? "SDR not on approved roster" : "No SDR assigned";
  else if (ev.category === "sponsored" && rules.sponsored.requireAttendance && attendance !== "attended" &&
           !(rules.sponsored.allowPriorConversation && priorConversation)) {
    reason = attendance === "no_show" ? "Sponsored event: did not attend" : "Sponsored event: attendance not confirmed";
  }
  const eligible = reason === null;

  // ---- touch windows
  const eligibilityDate = ev.date ? maxDay(ev.date, allocationDate) : null;
  const postEventStart = ev.date ? addDays(ev.date, rules.postEventStartOffsetDays) : null;
  const touches = contactTouches(contactActs, contact.id, sdr, rules);
  const day = (t: { timestamp: string }) => toDate(t.timestamp)!;
  const sinceElig = eligibilityDate ? touches.filter((t) => day(t) >= eligibilityDate) : [];
  const postEvent = postEventStart ? touches.filter((t) => day(t) >= postEventStart).length : 0;
  const sinceAlloc = allocationDate ? touches.filter((t) => day(t) >= allocationDate).length : null;
  const first30 = eligibilityDate ? sinceElig.filter((t) => daysBetween(eligibilityDate, day(t)) < 30).length : 0;
  const preEventTouches = ev.date ? touches.filter((t) => day(t) < ev.date! && daysBetween(day(t), ev.date!) <= 30).length : 0;

  const days = [...new Set(sinceElig.map(day))].sort();
  const weeks = new Set(days.map(isoWeek));
  const gaps = days.slice(1).map((d, i) => daysBetween(days[i]!, d));
  const firstTouchAt = sinceElig[0]?.timestamp ?? null;
  const lastTouchAt = sinceElig.length ? sinceElig[sinceElig.length - 1]!.timestamp : null;

  const rule = rules.cadence[temperature ?? "Warm"];
  const ageDays = eligibilityDate && eligibilityDate <= today ? daysBetween(eligibilityDate, today) : eligibilityDate ? 0 : null;
  const bizSinceElig = eligibilityDate && eligibilityDate <= today ? businessDaysBetween(eligibilityDate, today, rules.businessCalendar) : eligibilityDate ? 0 : null;
  const bizToFirst = eligibilityDate && firstTouchAt ? businessDaysBetween(eligibilityDate, toDate(firstTouchAt)!, rules.businessCalendar) : null;
  const bizSinceLast = lastTouchAt ? businessDaysBetween(toDate(lastTouchAt)!, today, rules.businessCalendar) : null;
  const expected = ageDays === null ? 0 : expectedTouches(ageDays, rule);

  let slaMet: boolean | null = null;
  if (bizToFirst !== null) slaMet = bizToFirst <= rule.firstTouchBusinessDays;
  else if (bizSinceElig !== null && bizSinceElig > rule.firstTouchBusinessDays) slaMet = false;
  const overdue = sinceElig.length === 0 && bizSinceElig !== null && bizSinceElig > rule.firstTouchBusinessDays;

  // ---- legitimate pauses (outcomes that change the expected cadence)
  let inPlayReason: string | null = null;
  if (eligibilityDate) {
    const openDeal = deals.find((d) => !d.isClosed && !rules.inactiveDealStages.some((x) => (d.stageLabel ?? "").toLowerCase().includes(x.toLowerCase())));
    const meeting = contactActs.find((a) => a.kind === "MEETING" && toDate(a.timestamp)! >= eligibilityDate);
    const reply = contactActs.find((a) => a.kind === "INCOMING_EMAIL" && toDate(a.timestamp)! >= eligibilityDate);
    if (openDeal) inPlayReason = `Open opportunity: ${openDeal.name ?? openDeal.id}${openDeal.stageLabel ? ` (${openDeal.stageLabel})` : ""}`;
    else if (meeting) inPlayReason = `Meeting on ${toDate(meeting.timestamp)}`;
    else if (reply) inPlayReason = `Prospect replied on ${toDate(reply.timestamp)}`;
    else if (contact.leadStatus && rules.disqualifiedLeadStatuses.includes(contact.leadStatus.toUpperCase())) inPlayReason = "Disqualified";
  }

  // ---- recently closed lost (account level, incl. duplicate company records): grey, no SLA, for N days after the loss
  let recentlyLost: LeadFact["recentlyLost"] = null;
  if (rules.recentlyClosedLostDays > 0) {
    const from = addDays(today, -rules.recentlyClosedLostDays);
    const lostDate = (d: Deal) => (d.isClosedLost || (d.isClosed && !d.isWon) ? d.closedLostAt ?? d.closeDate ?? null : null);
    const candidates = [...deals.map((d) => ({ d, via: (ds.dealsByContact.get(contact.id) ?? []).some((x) => x.id === d.id) ? "contact" as const : "company" as const })),
      ...siblingDeals.map((d) => ({ d, via: "duplicate_company" as const }))]
      .map((x) => ({ ...x, at: lostDate(x.d) }))
      .filter((x): x is typeof x & { at: string } => !!x.at && toDate(x.at)! >= from && toDate(x.at)! <= today)
      .sort((a, b) => b.at.localeCompare(a.at));
    const top = candidates[0];
    if (top) recentlyLost = { dealId: top.d.id, dealName: top.d.name, closedAt: top.at, via: top.via };
  }

  // ---- outreach logged on the company but not on this contact
  const companyOutreachOnly = sinceElig.length === 0 && !!company && !!eligibilityDate &&
    companyActs.some((a) => !a.contactIds.includes(contact.id) && toDate(a.timestamp)! >= eligibilityDate && touchKind(a, sdr, rules) !== null);

  // ---- next step
  const openTasks = (ds.tasksByContact.get(contact.id) ?? []).filter((t) => (t.status || "").toUpperCase() !== "COMPLETED" && t.dueDate);
  openTasks.sort((a, b) => a.dueDate!.localeCompare(b.dueDate!));
  const futureMeeting = contactActs.some((a) => a.kind === "MEETING" && toDate(a.timestamp)! > today);
  const nextTaskDue = openTasks[0]?.dueDate ?? null;
  const nextTask = openTasks[0] ?? null;

  // ---- daily-worklist facts (context only: they do not change status, SLA or any reported metric)
  const maxTs = (xs: Activity[]) => xs.map((a) => a.timestamp).sort().pop() ?? null;
  const lastReplyAt = eligibilityDate ? maxTs(contactActs.filter((a) => a.kind === "INCOMING_EMAIL" && toDate(a.timestamp)! >= eligibilityDate)) : null;
  // Any outbound response by anyone (SDR, AE or other), so a reply already answered by an AE is not shown as waiting.
  const outbound = contactActs.filter((a) => (a.kind === "EMAIL" && (a.direction || "EMAIL").toUpperCase() === "EMAIL") ||
    (a.kind === "CALL" && (a.direction || "").toUpperCase() !== "INBOUND") || a.kind === "MEETING");
  outbound.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const lastOutbound = outbound[outbound.length - 1] ?? null;
  const lastMeetingAt = maxTs(contactActs.filter((a) => a.kind === "MEETING" && toDate(a.timestamp)! <= today));
  const sdrFrom = allocationDate ?? eligibilityDate;
  const currentSdrTouches = sdr && sdrFrom ? touches.filter((t) => t.ownerId === sdr && day(t) >= sdrFrom).length : null;
  const otherSdrTouches = touches.filter((t) => t.ownerId !== sdr).length;
  const lastTouchOwnerId = sinceElig.length ? sinceElig[sinceElig.length - 1]!.ownerId : null;

  // ---- status
  let status: FollowUpStatus;
  let statusReason: string;
  if (inPlayReason) { status = "in_play"; statusReason = inPlayReason; }
  else if (recentlyLost) {
    status = "recently_lost";
    statusReason = `Closed lost on ${toDate(recentlyLost.closedAt)}${recentlyLost.via === "duplicate_company" ? " (on a duplicate company record)" : ""}; no SLA for ${rules.recentlyClosedLostDays} days after the loss`;
  }
  else if (!eligibilityDate) { status = "unverifiable"; statusReason = "Event date unknown"; }
  else if (sinceElig.length === 0 && companyOutreachOnly) { status = "unverifiable"; statusReason = "Outreach is logged on the company but not on this contact"; }
  else if (sinceElig.length === 0) { status = "never_worked"; statusReason = overdue ? `No outreach ${bizSinceElig} business days after eligibility` : "Within first-touch window"; }
  else if (bizSinceLast !== null && bizSinceLast > rule.stallBusinessDays) { status = "stalled"; statusReason = `No touch for ${bizSinceLast} business days`; }
  else if (sinceElig.length >= 2 && sinceElig.length >= expected && ((ageDays ?? 0) < 14 || weeks.size >= rules.multiWeekMinWeeks)) {
    status = "active"; statusReason = `${sinceElig.length} touches across ${weeks.size} week(s)`;
  } else { status = "first_touch"; statusReason = `${sinceElig.length} of ${Math.max(expected, 2)} expected touches`; }

  // No SLA for recently-lost accounts, or for leads that became eligible before the SLA started (rules.slaStartDate).
  const noSla = status === "recently_lost" || (!!rules.slaStartDate && !!eligibilityDate && eligibilityDate < rules.slaStartDate);
  // The SLA start date only governs the FIRST-touch SLA. Follow-up cadence is judged for every worked lead
  // (except recently-lost accounts), otherwise a one-touch lead would read "not yet due" while below cadence.
  const insufficient = eligible && sinceElig.length > 0 && !inPlayReason && status !== "recently_lost" && (sinceElig.length < expected || status === "stalled");

  const icpPriority = !!tier && PRIORITY_TIERS.has(tier);
  let priority = 0;
  if (eligible) {
    priority += temperature === "Hot" ? 100 : temperature === "Warm" ? 50 : 20;
    if (status === "never_worked") priority += overdue ? 80 : 30;
    if (status === "stalled") priority += 60;
    if (status === "first_touch" && insufficient) priority += 40;
    if (status === "unverifiable") priority += 20;
    if (icpPriority) priority += 20;
    if (attendance === "attended") priority += 10;
    if (status === "in_play" || status === "active" || status === "recently_lost") priority -= 60;
  }

  const inWindow = (d: string | null) => !!d && !!ev.date && toDate(d)! >= ev.date && daysBetween(ev.date, toDate(d)!) <= rules.dealAttributionDays;
  // Event attribution (MQL only): the deal's MQL date falls within the window after the event. A deal is "historical"
  // when it had already reached MQL before the event (or, with no MQL date, was created before it). Deal records in
  // this portal are often created early in a lead pipeline, so the create date alone does not make a deal historical.
  const historical = (d: Deal) => !!ev.date && ((d.mqlDate ? d.mqlDate < ev.date : !!d.createdAt && toDate(d.createdAt)! < ev.date));
  const attributedDeals = ev.date ? deals.filter((d) => inWindow(d.mqlDate)).map((d) => d.id) : [];
  const sqlDeals = ev.date ? deals.filter((d) => inWindow(d.sqlDate) && !historical(d)).map((d) => d.id) : [];

  // Deal history as context (does not affect eligibility, status or attribution)
  const contactDealIds = new Set((ds.dealsByContact.get(contact.id) ?? []).map((d) => d.id));
  const dealRefs: DealRef[] = [...deals, ...siblingDeals].map((d) => {
    const status: DealRef["status"] = d.isWon ? "won" : d.isClosedLost || (d.isClosed && !d.isWon) ? "lost" : "open";
    return {
      id: d.id, name: d.name, status, stageLabel: d.stageLabel,
      createdAt: d.createdAt, closedAt: status === "lost" ? d.closedLostAt ?? d.closeDate ?? null : status === "won" ? d.closeDate ?? null : null,
      previousStageLabel: status === "lost" ? d.previousStageLabel ?? null : null,
      lostReason: status === "lost" ? d.lostReason ?? null : null, lostSubReason: status === "lost" ? d.lostSubReason ?? null : null,
      lostComment: status === "lost" ? d.lostComment ?? null : null,
      timing: !ev.date || (!d.mqlDate && !d.createdAt) ? "unknown" : historical(d) ? "before_event" : "after_event",
      via: contactDealIds.has(d.id) ? "contact" : ownDealIds.has(d.id) ? "company" : "duplicate_company",
    };
  });
  dealRefs.sort(dealOrder);

  const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.email || contact.id;
  return {
    eventId: ev.id, contactId: contact.id, companyId: company?.id ?? contact.companyId ?? null,
    eventName: ev.name, eventDate: ev.date, eventCategory: ev.category, fiscalQuarter: ev.date ? fiscalQuarterOf(ev.date).key : null,
    contactName: name, contactEmail: contact.email, jobTitle: contact.jobTitle, companyName: company?.name ?? null,
    icpTier: tier, temperature, temperatureRaw: company?.temperatureRaw ?? null,
    sdrOwnerId: sdr, sdrOwnerRaw: sdrRaw, sdrRegion: sdrRegion(sdr), sdrSource: sdr ? (viaPod ? "pod_ae" : "company") : null,
    registered: true, attendance, eligible, ineligibleReason: reason,
    allocationDate, eligibilityDate, ageDays,
    firstTouchAt, lastTouchAt,
    touchesSinceAllocation: sinceAlloc, touchesPostEvent: postEvent, touchesSinceEligibility: sinceElig.length, touchesFirst30Days: first30,
    distinctTouchDays: days.length, distinctTouchWeeks: weeks.size,
    avgGapDays: gaps.length ? Math.round((gaps.reduce((a, b) => a + b, 0) / gaps.length) * 10) / 10 : null,
    maxGapDays: gaps.length ? Math.max(...gaps) : null,
    daysSinceLastTouch: lastTouchAt ? daysBetween(toDate(lastTouchAt)!, today) : null,
    businessDaysToFirstTouch: bizToFirst, businessDaysSinceEligibility: bizSinceElig,
    lastReplyAt, lastOutboundAt: lastOutbound?.timestamp ?? null, lastOutboundOwnerId: lastOutbound?.ownerId ?? null, lastMeetingAt,
    currentSdrTouches, otherSdrTouches, lastTouchOwnerId,
    nextTaskSubject: nextTask?.subject ?? null, nextTaskOwnerId: nextTask?.ownerId ?? null, slaApplies: !noSla,
    firstTouchSlaMet: noSla ? null : slaMet, firstTouchOverdue: noSla ? false : overdue, expectedTouches: expected,
    insufficientFollowUp: insufficient, multiWeek: weeks.size >= rules.multiWeekMinWeeks,
    nextTaskDue, hasNextStep: openTasks.length > 0 || futureMeeting,
    status, statusReason, inPlayReason, companyOutreachOnly,
    touchKinds: [...new Set(sinceElig.map((t) => t.kind))].sort(),
    touchDates: sinceElig.map((t) => t.timestamp),
    touchIds: sinceElig.map((t) => t.activityId),
    priorConversation, isUpcoming, preEventTouches, icpPriority,
    attributedDeals, sqlDeals, dealStatus: dealRefs.filter((d) => d.via !== "duplicate_company")[0]?.status ?? "none", deals: dealRefs, recentlyLost,
    allTouchDates: touches.map((t) => t.timestamp), allTouchIds: touches.map((t) => t.activityId),
    dataQuality: dq, priority,
  };
}

/** True when the lead's company is on the admin exclusion list (by HubSpot company id or normalised name). */
export function isExcludedCompany(f: Pick<LeadFact, "companyId" | "companyName"> & { eventDate?: string | null }, rules: Rules): boolean {
  if (isBeforeCutoff(f.eventDate, rules)) return true;
  const list = rules.excludedCompanies ?? [];
  if (!list.length) return false;
  const name = normalizeCompanyName(f.companyName);
  return list.some((x) => (f.companyId && x.trim() === f.companyId) || (!!name && normalizeCompanyName(x) === name));
}

/** True when the event is dated before the admin cut-off (rules.minEventDate). Undated events are kept. */
export function isBeforeCutoff(eventDate: string | null | undefined, rules: Rules): boolean {
  const min = rules.minEventDate;
  return !!min && !!eventDate && eventDate.slice(0, 10) < min;
}

/** Normalised company name for duplicate-record matching ("The Channel Company, Inc." -> "channel company"). */
export function normalizeCompanyName(name: string | null | undefined): string {
  return (name ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(the|inc|incorporated|llc|ltd|limited|corp|corporation|plc|gmbh|pvt|private|co)\b/g, " ").replace(/\s+/g, " ").trim();
}

const dupIndex = new WeakMap<Dataset, Map<string, Company[]>>();
/** Other company records with the same normalised name and the same SDR owner (likely duplicates in HubSpot). */
export function duplicateCompanies(ds: Dataset, company: Company): Company[] {
  let idx = dupIndex.get(ds);
  if (!idx) {
    idx = new Map();
    for (const c of ds.companies.values()) {
      const key = normalizeCompanyName(c.name);
      if (!key || !c.sdrOwnerId) continue;
      const k = `${key}|${c.sdrOwnerId}`;
      (idx.get(k) ?? idx.set(k, []).get(k)!).push(c);
    }
    dupIndex.set(ds, idx);
  }
  const key = normalizeCompanyName(company.name);
  if (!key || !company.sdrOwnerId) return [];
  return (idx.get(`${key}|${company.sdrOwnerId}`) ?? []).filter((c) => c.id !== company.id);
}

/** Most relevant first: open deals, then the most recently closed (lost or won), then the rest by created date. */
export function dealOrder(a: DealRef, b: DealRef): number {
  const rank = (d: DealRef) => (d.status === "open" ? 0 : 1);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  return (b.closedAt ?? b.createdAt ?? "").localeCompare(a.closedAt ?? a.createdAt ?? "");
}

function uniqueDeals(deals: Deal[]): Deal[] {
  const m = new Map<string, Deal>();
  for (const d of deals) m.set(d.id, d);
  return [...m.values()];
}
