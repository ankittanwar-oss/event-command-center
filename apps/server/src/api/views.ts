import {
  accountQueue, applyFilters, BUCKETS, categoryBreakdown, CATEGORY_LABEL, dataQuality, eventSummaries, fiscalQuarterOf, inBucket, nextAction,
  normalizeFilters, parseQuarterKey, worklist, leadDimensions, ACTION_HEALTH_LABEL, outreachTimeliness, inactivity, overdueSource, deadlineState, leadWork, contactLevelInPlay, actionStatus, contactWorklist, accountWorklist, accountSummary, ACCOUNT_BUCKETS, ACCOUNT_METRICS, leadHotWarm, participationScope, DISPOSITION_CODES, type DispositionSet, DEFAULT_RULES, dealOrder, type DealRef, depthStats, sdrDepth, accountDepth, WINDOW_LABEL, BANDS, type TouchWindow, findings, narrative, RISK_LABEL, riskCounts, riskOf, sdrRisk, previousQuarter, qoq, quarterMetrics, regionBreakdown, rosterById, SDR_ROSTER, sdrTable, STATUS_LABEL, temperatureSummary,
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

import { ownerNames } from "./owners.js";
/** Owner name + role, only when verifiable: roster -> SDR, pod AE map -> AE, otherwise the HubSpot name without a role. */
export function ownerLabel(id: string | null | undefined, rules: Rules): { id: string; name: string | null; role: "SDR" | "AE" | null } | null {
  if (!id) return null;
  const sdr = rosterById.get(id);
  if (sdr) return { id, name: sdr.name, role: "SDR" };
  const role = Object.prototype.hasOwnProperty.call(rules.podAeToSdr ?? {}, id) ? "AE" : null;
  return { id, name: ownerNames.get(id) ?? null, role };
}

/** Adds the presentation-only risk level to a lead record. */
export function withRisk(f: LeadFact, rules: Rules, today?: string) {
  const r = riskOf(f, rules);
  const dm = today && f.eligible ? leadDimensions(f, today, rules) : null;
  const ia = dm ? inactivity(f, today!, rules) : null;
  const ds = dm ? deadlineState(f, today!, rules) : null;
  const action = today ? actionStatus(f, today, rules) : null;
  // Last qualifying outbound contact by anyone (SDR, AE, other), and the current SDR's own last qualifying touch.
  const lastAny = f.lastOutboundAt !== undefined ? { at: f.lastOutboundAt ?? null, owner: ownerLabel(f.lastOutboundOwnerId, rules) } : { at: f.lastTouchAt, owner: ownerLabel(f.lastTouchOwnerId ?? null, rules) };
  const lastContact = { at: lastAny.at, by: lastAny.owner, sdrAt: f.currentSdrLastTouchAt ?? null, sdr: ownerLabel(f.sdrOwnerId, rules) };
  const dealsOut = (f.deals ?? []).map((d) => ({ ...d, owner: ownerLabel(d.ownerId ?? null, rules) }));
  const dims = dm ? { sla: dm.sla, depth: dm.depth, followUp: dm.followUp, cadence: dm.cadence, health: dm.health, healthLabel: ACTION_HEALTH_LABEL[dm.health],
    overdue: overdueSource(dm.work)?.label ?? null, dueSource: dm.work.dueSource, due: dm.work.due,
    inactiveDays: ia?.businessDays ?? null, inactiveSince: ia?.since ?? null, stale: ia?.stale ?? false, staleKind: ia?.kind ?? null,
    deadline: ds, deadlineLabel: ds ? ({ verified: "Verified deadline", not_yet_due: "Not yet due", no_deadline: "No verified deadline", commercial: "Active commercial engagement", paused: "Paused / not actionable", missing_data: "Missing data" } as Record<string, string>)[ds] : null } : null;
  const label = f.status === "in_play" && f.touchesSinceEligibility === 0 ? "In play – no SDR touch" : STATUS_LABEL[f.status];
  return { ...f, deals: dealsOut, action, lastContact, dims, nextAction: nextAction(f, rules), statusLabel: label, risk: r?.level ?? null, riskLabel: r ? RISK_LABEL[r.level] : null, riskReason: r?.reason ?? null };
}

/** Bucket predicate including the risk buckets (risk_critical, risk_at_risk, risk_healthy, risk_neutral). */
function matches(f: LeadFact, bucket: string, rules: Rules, today = ""): boolean {
  if (bucket.startsWith("risk_")) return riskOf(f, rules)?.level === bucket.slice(5);
  // Dimension buckets: health_<key>, depth_<band>, follow_overdue, follow_due (eligible leads only)
  if (bucket.startsWith("cmo_")) return cmoKeys(f, today, rules).includes(bucket.slice(4));
  if (bucket.startsWith("ft_") || bucket.startsWith("fu_")) {
    const t = outreachTimeliness(f, today, rules);
    return bucket.startsWith("ft_") ? t.firstTouch === bucket.slice(3) : t.followUp === bucket.slice(3);
  }
  if (bucket.startsWith("health_") || bucket.startsWith("depth_") || bucket.startsWith("follow_")) {
    if (!f.eligible) return false;
    const d = leadDimensions(f, today, rules);
    if (bucket.startsWith("health_")) return d.health === bucket.slice(7);
    if (bucket.startsWith("depth_")) return d.depth === ({ "0": "0", "1": "1", "23": "2–3", "45": "4–5", "67": "6–7", "8": "8+" } as Record<string, string>)[bucket.slice(6)];
    if (bucket === "follow_overdue") return f.touchesSinceEligibility > 0 && d.health === "overdue";
    if (bucket === "follow_due") return f.touchesSinceEligibility > 0 && d.health === "due_today";
  }
  return inBucket(f, bucket);
}

/** Deal history across an account's contacts, de-duplicated by deal id, most relevant first. */
function accountDeals(leads: LeadFact[]): DealRef[] {
  const m = new Map<string, DealRef>();
  for (const l of leads) for (const d of l.deals ?? []) {
    const prev = m.get(d.id);
    // a deal linked to any of the account's contacts directly is shown as "contact"
    m.set(d.id, prev && prev.via === "contact" ? prev : d);
  }
  return [...m.values()].sort(dealOrder);
}

/** Compact deal context for the CMO overview: eligible accounts by most relevant deal status. Context only. */
function dealContext(rows: LeadFact[], today: string) {
  const byAccount = new Map<string, LeadFact[]>();
  for (const f of rows) if (f.eligible) (byAccount.get(f.companyId ?? `c:${f.contactId}`) ?? byAccount.set(f.companyId ?? `c:${f.contactId}`, []).get(f.companyId ?? `c:${f.contactId}`)!).push(f);
  const out = { accounts: byAccount.size, open: 0, won: 0, lost: 0, none: 0, lostLast90: 0, hasHistory: rows.some((f) => f.deals !== undefined) };
  const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - 90 * 86_400_000).toISOString();
  for (const leads of byAccount.values()) {
    const deals = accountDeals(leads);
    const top = deals[0]?.status ?? "none";
    out[top]++;
    if (deals.some((d) => d.status === "lost" && (d.closedAt ?? "") >= cutoff)) out.lostLast90++;
  }
  return out;
}

const WINDOWS: TouchWindow[] = ["eligibility", "allocation", "event", "period"];
function touchWindow(q: URLSearchParams): TouchWindow {
  const w = (q.get("window") || "").trim() as TouchWindow;
  return WINDOWS.includes(w) ? w : "eligibility";
}

/** SDR touch depth: per SDR (all / Hot / Warm) plus team totals, for the chosen measurement window. */
export function depth(facts: LeadFact[], q: URLSearchParams, today: string, rules: Rules = DEFAULT_RULES) {
  const { nf, rows } = filtered(facts, q, today);
  const w = touchWindow(q);
  const period = nf.quarterRange;
  return {
    filters: nf, window: w, windowLabel: WINDOW_LABEL[w], windows: WINDOWS.map((k) => ({ key: k, label: WINDOW_LABEL[k] })),
    period, bands: BANDS.map((b) => ({ key: b.key, label: b.label })), target: rules.touchTarget,
    team: depthStats(rows.filter((f) => !!f.sdrOwnerId), rules, w, period),
    rows: sdrTable(rows, nf).map((r) => sdrDepth(rows, r.ownerId, rules, w, period)),
  };
}

/** Every CMO metric key a lead belongs to (same function drives counts and drill-downs). */
export function cmoKeys(f: LeadFact, today: string, rules: Rules): string[] {
  const k: string[] = [];
  if (!f.eligible) {
    if (f.ineligibleReason === "No SDR assigned" || f.ineligibleReason === "SDR not on approved roster") k.push("x_missing_owner");
    return k;
  }
  const t = outreachTimeliness(f, today, rules);
  const w = leadWork(f, today, rules);
  const src = overdueSource(w)?.source;
  if (t.firstTouch === "overdue") k.push("t_ft_breach");
  if (f.touchesSinceEligibility > 0 && (src === "task" || src === "cadence" || src === "reply")) k.push("t_fu_overdue", `t_fu_overdue_${src}`);
  if (t.firstTouch === "today" || t.followUp === "today") k.push("t_due_today");
  if (t.firstTouch === "upcoming" || t.followUp === "upcoming") k.push("t_upcoming");
  if ((t.firstTouch === "today" || t.firstTouch === "upcoming")) k.push("recent");
  const ia = inactivity(f, today, rules);
  if (ia.stale) k.push("stale", `stale_${ia.kind}`);
  const ds = deadlineState(f, today, rules);
  if (ds) k.push(`dl_${ds}`);
  if (ds === "no_deadline") k.push("x_no_deadline");
  if (f.status === "unverifiable") k.push("x_unverified_activity");
  // Open deal that has NOT reached the SQL milestone: commercial context only; SDR outreach continues.
  if ((f.deals ?? []).some((d) => d.status === "open" && !d.sqlDate && d.via !== "duplicate_company")) k.push("x_uncertain_handoff");
  return k;
}

export function dimCounts(list: LeadFact[], today: string, rules: Rules) {
  const c = { leads: list.length, touched: 0, multi: 0, slaMet: 0, slaMissed: 0, firstOverdue: 0, followOverdue: 0, followDue: 0,
    health: { overdue: 0, due_today: 0, upcoming: 0, not_yet_due: 0, on_track: 0, unverified: 0 } as Record<string, number>,
    depth: { "0": 0, "1": 0, "2–3": 0, "4–5": 0, "6–7": 0, "8+": 0 } as Record<string, number>,
    ft: { ontime: 0, late: 0, today: 0, upcoming: 0, overdue: 0, no_deadline: 0 } as Record<string, number>,
    fu: { today: 0, upcoming: 0, overdue: 0, unverified: 0, complete: 0, open: 0 } as Record<string, number>,
    k: {} as Record<string, number> };
  for (const f of list) {
    const d = leadDimensions(f, today, rules);
    if (f.touchesSinceEligibility > 0) c.touched++;
    if (f.touchesSinceEligibility >= 2) c.multi++;
    if (f.firstTouchSlaMet === true) c.slaMet++;
    if (f.firstTouchSlaMet === false) c.slaMissed++;
    if (f.status === "never_worked" && f.firstTouchOverdue) c.firstOverdue++;
    if (f.touchesSinceEligibility > 0 && d.health === "overdue") c.followOverdue++;
    if (f.touchesSinceEligibility > 0 && d.health === "due_today") c.followDue++;
    c.health[d.health]!++; c.depth[d.depth]!++;
    for (const key of cmoKeys(f, today, rules)) c.k[key] = (c.k[key] ?? 0) + 1;
    const t = outreachTimeliness(f, today, rules);
    if (t.firstTouch) c.ft[t.firstTouch]!++;
    if (t.followUp) c.fu[t.followUp]!++;
  }
  return c;
}

export function overview(facts: LeadFact[], q: URLSearchParams, today: string, rules: Rules = DEFAULT_RULES, disp?: DispositionSet) {
  const { nf, rows } = filtered(facts, q, today);
  const cur = nf.quarter ? parseQuarterKey(nf.quarter) : null;
  const prevKey = cur ? previousQuarter(cur) : null;
  let previous = null;
  if (prevKey) {
    const { rows: all } = filtered(facts, q, today, ["quarter"]);
    previous = quarterMetrics(all, prevKey, today);
  }
  const current = cur ? quarterMetrics(rows, cur, today) : null;
  const top = findings(rows, rules);
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
    allTemps: {
      eligible: rows.filter((f) => f.eligible).length,
      multiTouch: rows.filter((f) => f.eligible && f.touchesSinceEligibility >= 2).length,
      oneTouch: rows.filter((f) => f.eligible && f.touchesSinceEligibility === 1).length,
      untouched: rows.filter((f) => f.eligible && f.touchesSinceEligibility === 0).length,
      otherTemps: rows.filter((f) => f.eligible && !f.temperature).length,
    },
    risk: {
      all: riskCounts(rows, rules),
      Hot: riskCounts(rows.filter((f) => f.temperature === "Hot"), rules),
      Warm: riskCounts(rows.filter((f) => f.temperature === "Warm"), rules),
    },
    sdrRisk: Object.fromEntries(sdrTable(rows, nf).map((s) => [s.ownerId, sdrRisk(rows, s.ownerId, rules)])),
    focus: top,
    depth: Object.fromEntries(sdrTable(rows, nf).map((s) => [s.ownerId, sdrDepth(rows, s.ownerId, rules, "eligibility", nf.quarterRange).all])),
    touchTarget: rules.touchTarget,
    // Three independent dimensions per SDR, all on the same population as the drill-downs (eligible leads, filtered).
    dimsAll: dimCounts(rows.filter((f) => f.eligible), today, rules),
    // Account-level execution (primary). Accounts = unique HubSpot company ids per SDR; contacts = eligible event contacts.
    accountExec: (() => {
      const items = contactWorklist(rows, today, rules, disp).items;
      const per = sdrTable(rows, nf).map((sd) => ({ ownerId: sd.ownerId, name: sd.name, ...accountSummary(accountWorklist(items.filter((i) => i.sdrOwnerId === sd.ownerId), today, rules)) })).filter((r) => r.accounts > 0);
      return { perSdr: per, all: accountSummary(accountWorklist(items, today, rules)), dispositionCodes: DISPOSITION_CODES };
    })(),
    missingOwner: rows.filter((f) => cmoKeys(f, today, rules).includes("x_missing_owner")).length,
    performanceColors: rules.performanceColors ?? DEFAULT_RULES.performanceColors, inactivityDays: rules.inactivityBusinessDays ?? 14,
    dims: Object.fromEntries(sdrTable(rows, nf).map((sd) => [sd.ownerId, dimCounts(rows.filter((f) => f.eligible && f.sdrOwnerId === sd.ownerId), today, rules)])),
    scorecardTargets: rules.scorecardTargets, slaStartDate: rules.slaStartDate ?? null,
    dealContext: dealContext(rows, today),
    narrative: narrative(rows, rules, top),
    slaDays: { Hot: rules.cadence.Hot.firstTouchBusinessDays, Warm: rules.cadence.Warm.firstTouchBusinessDays },
  };
}

export function leads(facts: LeadFact[], q: URLSearchParams, today: string, rules: Rules) {
  const { nf, rows } = filtered(facts, q, today);
  const bucket = (q.get("bucket") || "").trim();
  const list = bucket ? rows.filter((f) => matches(f, bucket, rules, today)) : rows;
  list.sort((a, b) => b.priority - a.priority || (a.eventDate ?? "").localeCompare(b.eventDate ?? ""));
  const limit = Math.min(5000, Number(q.get("limit") || 1000));
  return {
    filters: nf, bucket: bucket || null, total: list.length,
    rows: list.slice(0, limit).map((f) => withRisk(f, rules, today)),
  };
}

export function sdrs(facts: LeadFact[], q: URLSearchParams, today: string, rules: Rules = DEFAULT_RULES) {
  const { nf, rows } = filtered(facts, q, today);
  return { filters: nf, rows: sdrTable(rows, nf).map((r) => ({ ...r, risk: sdrRisk(rows, r.ownerId, rules) })) };
}

export function accounts(facts: LeadFact[], q: URLSearchParams, today: string, rules: Rules) {
  const { nf, rows } = filtered(facts, q, today);
  const health = (q.get("health") || "").trim();
  const dealFilter = (q.get("deal") || "").trim();
  let list = accountQueue(rows, rules).map((a) => {
    const deals = accountDeals(a.contacts);
    const dep = accountDepth(a.contacts, "eligibility", nf.quarterRange);
    return { ...a, deals, dealStatus: deals.filter((d) => d.via !== "duplicate_company")[0]?.status ?? "none", recentlyLost: a.contacts.find((c) => c.recentlyLost)?.recentlyLost ?? null, depth: dep };
  });
  if (health) list = list.filter((a) => a.health === health);
  if (["open", "won", "lost", "none"].includes(dealFilter)) list = list.filter((a) => (dealFilter === "lost" ? a.deals.some((d) => d.status === "lost") : a.dealStatus === dealFilter));
  const limit = Math.min(1000, Number(q.get("limit") || 300));
  return {
    filters: nf, total: list.length,
    rows: list.slice(0, limit).map((a) => ({
      ...a,
      healthLabel: STATUS_LABEL[a.health],
      risk: worstRisk(a.contacts.map((c) => riskOf(c, rules)?.level ?? null)),
      contacts: a.contacts.map((c) => ({
        risk: riskOf(c, rules)?.level ?? null, riskReason: riskOf(c, rules)?.reason ?? null,
        contactId: c.contactId, contactName: c.contactName, contactEmail: c.contactEmail, jobTitle: c.jobTitle, eventId: c.eventId, eventName: c.eventName,
        eventDate: c.eventDate, temperature: c.temperature, status: c.status, statusLabel: c.status === "in_play" && c.touchesSinceEligibility === 0 ? "In play – no SDR touch" : STATUS_LABEL[c.status], statusReason: c.statusReason,
        touches: c.touchesSinceEligibility, lastTouchAt: c.lastTouchAt, nextTaskDue: c.nextTaskDue, attendance: c.attendance, nextAction: nextAction(c, rules),
      })),
    })),
  };
}

const RISK_ORDER = ["critical", "at_risk", "neutral", "healthy"] as const;
function worstRisk(levels: Array<string | null>): string | null {
  return RISK_ORDER.find((l) => levels.includes(l)) ?? null;
}

export function events(facts: LeadFact[], q: URLSearchParams, today: string, rules: Rules = DEFAULT_RULES) {
  const { nf, rows } = filtered(facts, q, today);
  const riskByEvent = new Map<string, ReturnType<typeof riskCounts>>();
  for (const id of new Set(rows.map((f) => f.eventId))) riskByEvent.set(id, riskCounts(rows.filter((f) => f.eventId === id), rules));
  const pp = eventParticipation(rows);
  const list = eventSummaries(rows).map((e) => ({ ...e, risk: riskByEvent.get(e.eventId) ?? null, pp: pp.get(e.eventId) ?? null }));
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
    risk: riskCounts(rows, rules),
    leads: rows.sort((a, b) => b.priority - a.priority).map((f) => withRisk(f, rules)),
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

// ---------------------------------------------------------------------------------------------------------------
// Daily Command Centre: every eligible event ACCOUNT per SDR, judged on timeliness. Built from the live synced
// lead facts (same eligibility, touch and SLA rules as every other view); nothing here is a separate snapshot.
// ---------------------------------------------------------------------------------------------------------------
const DAILY_GROUPS = [
  { key: "respond", label: "Respond now", hint: "Prospect replied after the SDR's last touch", cls: "crit" },
  { key: "overdue", label: "First touch overdue", hint: "No SDR touch on the account and the first-touch SLA has passed", cls: "crit" },
  { key: "stalled", label: "Stalled", hint: "Worked, but no touch beyond the stall threshold", cls: "crit" },
  { key: "due", label: "Due now", hint: "First touch due today, or follow-up below the expected cadence", cls: "warnr" },
  { key: "ontrack", label: "On track", hint: "Being worked within cadence", cls: "ok" },
  { key: "inplay", label: "In play", hint: "Meeting, open opportunity or DQ", cls: "neu" },
  { key: "notdue", label: "Not yet due", hint: "Inside the first-touch window, recently closed lost, or unverified", cls: "neu" },
] as const;

export function daily(facts: LeadFact[], q: URLSearchParams, today: string, rules: Rules = DEFAULT_RULES, disp?: DispositionSet) {
  const { nf, rows } = filtered(facts, q, today);
  const accts = accountQueue(rows, rules).map((a) => {
    const leads = a.contacts;
    const day = (x: string | null | undefined) => (x ? x.slice(0, 10) : null);
    const eligibleSince = leads.map((l) => l.eligibilityDate).filter(Boolean).sort()[0] ?? null;
    const firstTouch = leads.map((l) => l.firstTouchAt).filter(Boolean).sort()[0] ?? null;
    const lastTouch = a.lastTouch;
    const replyDates = leads.map((l) => /Prospect replied on (\d{4}-\d{2}-\d{2})/.exec(l.inPlayReason ?? "")?.[1]).filter(Boolean) as string[];
    const lastReply = replyDates.sort().pop() ?? null;
    const risks = leads.map((l) => riskOf(l, rules)?.level ?? null);
    const touchedLeads = leads.filter((l) => l.touchesSinceEligibility > 0);
    const daysToFirst = touchedLeads.map((l) => l.businessDaysToFirstTouch).filter((x): x is number => x !== null);
    const slaDays = rules.cadence[a.temperature === "Hot" ? "Hot" : "Warm"].firstTouchBusinessDays;
    let group: (typeof DAILY_GROUPS)[number]["key"];
    if (lastReply && (!lastTouch || day(lastTouch)! < lastReply)) group = "respond";
    else if (!firstTouch && leads.some((l) => l.status === "never_worked" && l.firstTouchOverdue)) group = "overdue";
    else if (leads.some((l) => l.status === "stalled")) group = "stalled";
    else if (risks.includes("at_risk")) group = "due";
    else if (leads.some((l) => l.status === "in_play")) group = "inplay";
    else if (risks.includes("healthy")) group = "ontrack";
    else group = "notdue";
    // Three-colour timeliness (SDR touches only): green = reached out on time; amber = awaiting first touch inside the
    // SLA, reached out late, or gone quiet; red = never reached out and the SLA has passed (or a reply is waiting).
    const slaPassed = leads.some((l) => l.firstTouchOverdue);
    let color: "green" | "amber" | "red"; let colorLabel: string;
    if (group === "respond") { color = "red"; colorLabel = "Reply waiting"; }
    else if (!firstTouch) { color = slaPassed ? "red" : "amber"; colorLabel = slaPassed ? "Not reached out" : "Awaiting outreach"; }
    else if (leads.some((l) => l.status === "stalled")) { color = "amber"; colorLabel = "Gone quiet"; }
    else if (daysToFirst.length && Math.min(...daysToFirst) > slaDays) { color = "amber"; colorLabel = "Reached out late"; }
    else { color = "green"; colorLabel = "Reached out on time"; }
    const daysSinceLast = lastTouch ? Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(lastTouch)) / 86_400_000) : null;
    return {
      companyId: a.companyId, companyName: a.companyName, sdrOwnerId: a.sdrOwnerId, sdrName: a.sdrName, temperature: a.temperature, icpTier: a.icpTier,
      events: a.events, eligibleSince, firstTouch, lastTouch, daysSinceLast, lastReply,
      businessDaysToFirstTouch: daysToFirst.length ? Math.min(...daysToFirst) : null,
      firstTouchWithinSla: daysToFirst.length ? Math.min(...daysToFirst) <= slaDays : leads.some((l) => l.firstTouchOverdue) ? false : null,
      touches: a.touches, contactsWorked: a.contactsWorked, eligibleContacts: a.eligibleContacts,
      nextTask: leads.map((l) => l.nextTaskDue).filter(Boolean).sort()[0] ?? null,
      dealStatus: accountDeals(leads).filter((d) => d.via !== "duplicate_company")[0]?.status ?? "none",
      group, nextAction: a.nextAction, color, colorLabel,
      contacts: leads.map((l) => withRisk(l, rules, today)),
    };
  });
  const urg = Object.fromEntries(DAILY_GROUPS.map((g, i) => [g.key, i]));
  const cr = { red: 0, amber: 1, green: 2 } as const;
  accts.sort((x, y) => cr[x.color] - cr[y.color] || urg[x.group]! - urg[y.group]! || (x.temperature === "Hot" ? -1 : 1) - (y.temperature === "Hot" ? -1 : 1) || (y.daysSinceLast ?? 999) - (x.daysSinceLast ?? 999));

  const summarise = (list: typeof accts) => {
    const decided = list.filter((x) => x.firstTouchWithinSla !== null);
    const days = list.map((x) => x.businessDaysToFirstTouch).filter((x): x is number => x !== null).sort((a, b) => a - b);
    return {
      accounts: list.length,
      hot: list.filter((x) => x.temperature === "Hot").length,
      worked: list.filter((x) => x.firstTouch).length,
      withinSlaPct: decided.length ? Math.round((decided.filter((x) => x.firstTouchWithinSla).length / decided.length) * 1000) / 10 : null,
      medianDaysToFirst: days.length ? days[Math.floor(days.length / 2)]! : null,
      touchedLast7: list.filter((x) => x.daysSinceLast !== null && x.daysSinceLast <= 7).length,
      groups: Object.fromEntries(DAILY_GROUPS.map((g) => [g.key, list.filter((x) => x.group === g.key).length])),
      green: list.filter((x) => x.color === "green").length, amber: list.filter((x) => x.color === "amber").length, red: list.filter((x) => x.color === "red").length,
    };
  };
  const bySdr = sdrTable(rows, nf).map((s) => ({ ownerId: s.ownerId, name: s.name, region: s.region, ...summarise(accts.filter((a) => a.sdrOwnerId === s.ownerId)) }));
  // Action worklist (primary SDR view). The timeliness summary above stays in the response for reporting.
  const work = worklist(rows, today, rules);
  const cw = contactWorklist(rows, today, rules, disp);
  const contacts = { groups: cw.groups, counts: cw.counts, total: cw.items.length,
    items: cw.items.slice(0, 3000).map((i) => ({ ...i,
      own: i.ownership ? { previousSdr: ownerLabel(i.ownership.previousSdrId ?? null, rules), companySdr: ownerLabel(i.ownership.companySdrId, rules), companyOwner: ownerLabel(i.ownership.companyOwnerId, rules), contactOwner: ownerLabel(i.ownership.contactOwnerId, rules), contactSdr: ownerLabel(i.ownership.contactSdrId, rules), companyCount: i.ownership.companyCount } : null,
      lastBy: ownerLabel(i.lastOutboundOwnerId, rules), otherBy: ownerLabel(i.lastOtherSdrTouch?.ownerId ?? null, rules), dealOwner: ownerLabel(i.deal?.ownerId ?? null, rules) })) };
  // Account-first view (same contact items, grouped by HubSpot company id within each SDR).
  const acctList = accountWorklist(contacts.items as any, today, rules);
  const accountsOut = { buckets: ACCOUNT_BUCKETS, summary: accountSummary(acctList), dispositionCodes: DISPOSITION_CODES,
    window: "Account worked = at least one qualifying outreach by the current SDR to an eligible event contact, since that contact's event date (including before a later allocation date). Other reps' outreach is shown, never credited.",
    items: acctList.map((a) => ({ ...a, workedByOther: a.workedByOther ? { ...a.workedByOther, by: ownerLabel(a.workedByOther.ownerId, rules) } : null, companyDispositionLabel: a.companyDisposition ? DISPOSITION_CODES[a.companyDisposition.code] : null })) };
  return { accountView: accountsOut, contacts, filters: nf, groups: DAILY_GROUPS, summary: summarise(accts), bySdr, accounts: accts.slice(0, 1500), total: accts.length,
    today, work: { sections: work.sections, counts: work.counts, total: work.items.length,
      items: work.items.slice(0, 2000).map((i) => ({ ...i, lastContact: { at: i.lastOutboundAt, by: ownerLabel(i.lastOutboundOwnerId, rules), sdrAt: i.currentSdrLastTouchAt, sdr: ownerLabel(i.sdrOwnerId, rules) } })) } };
}


/** Drill-down behind one Account execution cell: same rows, same SDR attribution, same predicate as the count. */
export function accountDrill(facts: LeadFact[], q: URLSearchParams, today: string, rules: Rules, disp?: DispositionSet) {
  const metric = q.get("metric") ?? "eligible";
  const def = ACCOUNT_METRICS[metric];
  if (!def) return { error: "Unknown metric" };
  const rowSdr = q.get("rowSdr") ?? "";
  const { nf, rows } = filtered(facts, q, today);
  let items = contactWorklist(rows, today, rules, disp).items;
  if (rowSdr) items = items.filter((i) => i.sdrOwnerId === rowSdr);
  const accts = accountWorklist(items, today, rules).filter(def.test).map((a) => {
    const contacts = def.contactsOnly ? a.contacts.filter(def.contactsOnly) : a.contacts;
    return {
      key: a.key, companyId: a.companyId, companyName: a.companyName, intent: a.intent, sdrName: a.sdrName, bucket: a.bucket, worked: a.worked, daysSinceLast: a.daysSinceLast,
      coverage: a.coverage, lastSdrTouch: a.lastSdrTouch, top: { action: a.primary.action, color: a.primary.color, overdueBusinessDays: a.top.overdueBusinessDays }, opportunities: a.opportunities,
      companyDisposition: a.companyDisposition,
      events: [...new Map(a.contacts.flatMap((c) => c.events).map((e) => [e.id, e])).values()],
      contacts: contacts.map((c) => ({ contactId: c.contactId, contactName: c.contactName, jobTitle: c.jobTitle, group: c.group, action: (c as any).multithread ? "Optional: multithread" : c.action,
        reason: c.reason, color: c.color, yourTouches: c.yourTouches, lastOutboundAt: c.lastOutboundAt, lastBy: ownerLabel(c.lastOutboundOwnerId, rules), disposition: c.disposition,
        otherSdrTouches: c.otherSdrTouches, eventIds: c.events.map((e) => e.id) })),
    };
  });
  const contactCount = accts.reduce((n, a) => n + a.contacts.length, 0);
  return { metric, label: def.label, contactMetric: !!def.contactsOnly, filters: nf, rowSdr, accounts: accts, accountCount: accts.length, contactCount };
}


/** Per event: verified participation (contacts) and account execution (unique companies) with separate denominators. */
export function eventParticipation(rows: LeadFact[]) {
  const out = new Map<string, any>();
  const by = new Map<string, LeadFact[]>();
  for (const f of rows) (by.get(f.eventId) ?? by.set(f.eventId, []).get(f.eventId)!).push(f);
  for (const [id, list] of by) {
    const part = (f: LeadFact) => f.participation ?? (f.attendance === "attended" ? "attended" : "unknown");
    const worked = (f: LeadFact) => (f.currentSdrTouches ?? f.touchesSinceEligibility) > 0;
    const el = list.filter((f) => f.eligible);
    const acct = new Map<string, { level: string; worked: boolean }>();
    for (const f of el) {
      const k = f.companyId ?? `c:${f.contactId}`;
      const lv = (f.accountIntent?.level ?? "").toLowerCase();
      const level = lv.startsWith("surging") || lv.startsWith("hot") ? "hot" : lv.startsWith("warm") ? "warm" : lv ? "other" : "unknown";
      const cur = acct.get(k) ?? { level, worked: false };
      cur.worked = cur.worked || worked(f);
      acct.set(k, cur);
    }
    const accts = [...acct.values()];
    const att = el.filter((f) => part(f) === "attended"), reg = el.filter((f) => part(f) === "registered_only" || part(f) === "unknown");
    out.set(id, {
      registered: list.length, attended: list.filter((f) => part(f) === "attended").length, registeredOnly: list.filter((f) => part(f) === "registered_only").length,
      unknown: list.filter((f) => part(f) === "unknown").length, noShow: list.filter((f) => part(f) === "no_show").length,
      accounts: accts.length, hotAccounts: accts.filter((a) => a.level === "hot").length, warmAccounts: accts.filter((a) => a.level === "warm").length,
      hotWorked: accts.filter((a) => a.level === "hot" && a.worked).length, warmWorked: accts.filter((a) => a.level === "warm" && a.worked).length,
      attendeesEligible: att.length, attendeesWorked: att.filter(worked).length, regOnlyEligible: reg.length, regOnlyWorked: reg.filter(worked).length,
    });
  }
  return out;
}

// =====================================================================================================================
// CMO: Hot & Warm event-lead coverage (CONTACT level). Uses core leadHotWarm (same tiers as the Daily Command Centre).
// Population: eligible event-lead records + records whose only gap is a missing SDR owner (reported as "Unassigned").
// Worked = qualifying outreach by the CURRENT SDR since that event (currentSdrTouches). ALL rows dedupe by Contact ID.
// =====================================================================================================================
function hwPopulation(facts: LeadFact[], q: URLSearchParams, today: string) {
  const { nf, rows } = filtered(facts, q, today);
  const part = q.get("part") ?? "";
  const pop = rows.filter((f) => (f.eligible || f.ineligibleReason === "No SDR assigned" || f.ineligibleReason === "SDR not on approved roster")
    && (!part || participationScope(f) === part));
  return { nf, pop, part };
}
type ByOther = { at: string; ownerId: string | null; contactName: string | null; sameContact: boolean } | null;
type HwRec = { f: LeadFact; cls: "hot" | "warm"; evidence: string; worked: boolean; byOther: ByOther };
/** Worked = the current SDR touched this contact since the event, OR another SDR/AE did outreach to this contact or to
 *  any other contact at the same company since the event (the account is being worked, so it is not a gap). */
function hwRecords(pop: LeadFact[]): HwRec[] {
  const byCo = new Map<string, Array<{ at: string; ownerId: string | null; contactId: string; contactName: string | null }>>();
  for (const f of pop) if (f.companyId && f.otherRepTouch) {
    const l = byCo.get(f.companyId) ?? []; l.push({ ...f.otherRepTouch, contactId: f.contactId, contactName: f.contactName ?? null }); byCo.set(f.companyId, l);
  }
  const out: HwRec[] = [];
  for (const f of pop) {
    const c = leadHotWarm(f); if (!c.cls) continue;
    const own = (f.currentSdrTouches ?? 0) > 0;
    let byOther: ByOther = null;
    if (!own) {
      if (f.otherRepTouch) byOther = { ...f.otherRepTouch, contactName: f.contactName ?? null, sameContact: true };
      else if (f.companyId && f.eventDate) {
        const t = (byCo.get(f.companyId) ?? []).filter((x) => x.contactId !== f.contactId && x.at.slice(0, 10) >= f.eventDate!).sort((a, b) => b.at.localeCompare(a.at))[0];
        if (t) byOther = { at: t.at, ownerId: t.ownerId, contactName: t.contactName, sameContact: false };
      }
    }
    out.push({ f, cls: c.cls, evidence: c.evidence, worked: own || !!byOther, byOther });
  }
  return out;
}
/** Contact-level rollup across events: Hot if Hot anywhere, else Warm; worked if worked for any of those events. */
function hwContacts(recs: HwRec[]) {
  const by = new Map<string, HwRec & { events: string[] }>();
  for (const r of recs) {
    const cur = by.get(r.f.contactId);
    if (!cur) { by.set(r.f.contactId, { ...r, events: [r.f.eventId] }); continue; }
    cur.events.push(r.f.eventId);
    if (r.cls === "hot" && cur.cls !== "hot") { cur.cls = "hot"; cur.evidence = r.evidence; cur.f = r.f; }
    if (!cur.worked && r.worked) cur.byOther = r.byOther;
    cur.worked = cur.worked || r.worked;
  }
  return [...by.values()];
}
function hwCounts(list: Array<{ cls: string; worked: boolean }>) {
  const hot = list.filter((r) => r.cls === "hot"), warm = list.filter((r) => r.cls === "warm");
  const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);
  return { hotTotal: hot.length, hotWorked: hot.filter((r) => r.worked).length, hotCoverage: pct(hot.filter((r) => r.worked).length, hot.length),
    warmTotal: warm.length, warmWorked: warm.filter((r) => r.worked).length, warmCoverage: pct(warm.filter((r) => r.worked).length, warm.length),
    hotUnworked: hot.filter((r) => !r.worked).length, warmUnworked: warm.filter((r) => !r.worked).length, unworked: list.filter((r) => !r.worked).length,
    total: list.length, worked: list.filter((r) => r.worked).length, coverage: pct(list.filter((r) => r.worked).length, list.length) };
}

export function cmoHotWarm(facts: LeadFact[], q: URLSearchParams, today: string, rules: Rules) {
  const { nf, pop, part } = hwPopulation(facts, q, today);
  const recs = hwRecords(pop);
  const contacts = hwContacts(recs);
  const evMeta = new Map<string, { name: string; date: string | null; category: string }>();
  for (const f of pop) evMeta.set(f.eventId, { name: f.eventName, date: f.eventDate, category: f.eventCategory });
  const pp = eventParticipation(pop);
  const events = [...evMeta.entries()].map(([id, m]) => {
    // one row per (event, contact): duplicates of the same contact on one event are impossible (event-contact key)
    const list = recs.filter((r) => r.f.eventId === id);
    return { eventId: id, ...m, ...hwCounts(list), participation: pp.get(id) ?? null };
  }).filter((e) => e.hotTotal + e.warmTotal > 0);
  const sdrIds = [...new Set(contacts.map((c) => c.f.sdrOwnerId ?? "unassigned"))];
  const sdrs = sdrIds.map((id) => ({ ownerId: id, name: id === "unassigned" ? "Unassigned" : rosterById.get(id)?.name ?? id, ...hwCounts(contacts.filter((c) => (c.f.sdrOwnerId ?? "unassigned") === id)) }));
  const all = hwCounts(contacts);
  // Execution gaps: facts only, each linked to its records.
  const gaps: Array<{ text: string; scope: string; id: string; metric: string }> = [];
  const topHot = [...events].sort((a, b) => b.hotUnworked - a.hotUnworked)[0];
  if (topHot && topHot.hotUnworked) gaps.push({ text: `${topHot.name} has the most unworked Hot contacts (${topHot.hotUnworked}).`, scope: "event", id: topHot.eventId, metric: "hot_unworked" });
  const lowWarm = events.filter((e) => e.warmTotal >= 5 && e.warmCoverage !== null).sort((a, b) => (a.warmCoverage ?? 0) - (b.warmCoverage ?? 0))[0];
  if (lowWarm && (lowWarm.warmCoverage ?? 100) < (rules.coverageColors?.green ?? 80)) gaps.push({ text: `${lowWarm.name} has the lowest Warm coverage among events with 5+ Warm contacts (${lowWarm.warmCoverage}% of ${lowWarm.warmTotal}).`, scope: "event", id: lowWarm.eventId, metric: "warm_unworked" });
  const topSdr = sdrs.filter((s) => s.ownerId !== "unassigned").sort((a, b) => b.unworked - a.unworked)[0];
  if (topSdr && topSdr.unworked) gaps.push({ text: `${topSdr.name} has the largest unworked Hot/Warm backlog (${topSdr.unworked}: ${topSdr.hotUnworked} Hot, ${topSdr.warmUnworked} Warm).`, scope: "sdr", id: topSdr.ownerId, metric: "unworked" });
  const un = sdrs.find((s) => s.ownerId === "unassigned");
  if (un && un.hotTotal + un.warmTotal) gaps.push({ text: `${un.hotTotal + un.warmTotal} Hot/Warm event contacts have no SDR owner.`, scope: "sdr", id: "unassigned", metric: "total" });
  return {
    filters: nf, participation: part || "all", thresholds: rules.coverageColors ?? { green: 80, amber: 50 },
    all, events, sdrs, gaps,
    definitions: {
      hot: "Hot lead = a documented conversation with this person: a real reply (not auto-replies or calendar notices), a meeting, or a note our team logged on the contact around the event (e.g. a booth conversation).",
      warm: "Warm lead = attended the event: check-in / attended date in HubSpot, the roundtable sheet, or the organiser's attendee list uploaded by our team (conference attendee). Registration only, unknown attendance and no-shows are not Warm.",
      worked: "Worked = outreach since the event by the contact's current SDR, OR by another SDR/AE to this person or anyone else at the same company (the account is being worked). Those are labelled \"Worked by <name>\" in drill-downs.",
      company: "Hot/Warm LEADS are people. Hot/Warm/Surging ACCOUNTS are the company Account Intent Level in HubSpot. They are reported separately and one never sets the other: a Warm account can have no Warm leads, and a Cold account can have a Hot lead.",
    },
  };
}

/** Records behind one CMO Hot/Warm cell. scope = all | event | sdr; metric = hot_total|hot_worked|hot_unworked|warm_*|unworked|total. */
export function cmoHotWarmDrill(facts: LeadFact[], q: URLSearchParams, today: string, rules: Rules) {
  const { nf, pop } = hwPopulation(facts, q, today);
  const scope = q.get("scope") ?? "all", id = q.get("id") ?? "", metric = q.get("metric") ?? "total";
  const recs = hwRecords(pop);
  let list: Array<HwRec & { events?: string[] }> = scope === "event" ? recs.filter((r) => r.f.eventId === id) : hwContacts(recs);
  if (scope === "sdr") list = list.filter((r) => (r.f.sdrOwnerId ?? "unassigned") === id);
  const [cls, kind] = metric.split("_");
  if (cls === "hot" || cls === "warm") list = list.filter((r) => r.cls === cls);
  const k = cls === "hot" || cls === "warm" ? kind : cls;
  if (k === "worked") list = list.filter((r) => r.worked);
  if (k === "unworked") list = list.filter((r) => !r.worked);
  const byContact = new Map<string, LeadFact[]>();
  for (const f of pop) (byContact.get(f.contactId) ?? byContact.set(f.contactId, []).get(f.contactId)!).push(f);
  const rows = list.map((r) => {
    const f = r.f;
    const all = byContact.get(f.contactId) ?? [f];
    const lastOwn = all.map((x) => x.currentSdrLastTouchAt).filter(Boolean).sort().pop() ?? null;
    const lv = (f.accountIntent?.level ?? "") || null;
    return {
      contactId: f.contactId, contactName: f.contactName, jobTitle: f.jobTitle, companyId: f.companyId, companyName: f.companyName,
      sdrName: f.sdrOwnerId ? rosterById.get(f.sdrOwnerId)?.name ?? f.sdrOwnerId : "Unassigned", cls: r.cls, evidence: r.evidence,
      companyIntent: lv, worked: r.worked, lastSdrOutreach: lastOwn,
      contactStatus: (f as any).contactLeadStatus ?? null,
      workedByOther: r.byOther ? { at: r.byOther.at, sameContact: r.byOther.sameContact, contactName: r.byOther.contactName,
        by: (() => { const o = ownerLabel(r.byOther!.ownerId, rules); return o ? `${o.name ?? o.id}${o.role ? ` (${o.role})` : ""}` : "another rep"; })() } : null,
      lastContacted: all.flatMap((x) => x.allTouchDates ?? []).sort().pop() ?? null,
      everWorked: all.some((x) => x.touchesSinceEligibility > 0 || (x.otherSdrTouches ?? 0) > 0), otherSdrTouches: Math.max(0, ...all.map((x) => x.otherSdrTouches ?? 0)),
      events: (scope === "event" ? [f] : all).map((x) => ({ id: x.eventId, name: x.eventName, date: x.eventDate, category: x.eventCategory, participation: participationScope(x), source: x.participationSource ?? null })),
    };
  });
  rows.sort((a, b) => (a.worked ? 1 : 0) - (b.worked ? 1 : 0) || (a.cls === "hot" ? 0 : 1) - (b.cls === "hot" ? 0 : 1) || (a.companyName ?? "").localeCompare(b.companyName ?? ""));
  const scopeName = scope === "event" ? pop.find((f) => f.eventId === id)?.eventName ?? id : scope === "sdr" ? (id === "unassigned" ? "Unassigned" : rosterById.get(id)?.name ?? id) : "All events";
  return { filters: nf, scope, id, metric, scopeName, count: rows.length, rows };
}
