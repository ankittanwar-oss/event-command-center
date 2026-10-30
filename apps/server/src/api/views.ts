import {
  accountQueue, applyFilters, BUCKETS, categoryBreakdown, CATEGORY_LABEL, dataQuality, eventSummaries, fiscalQuarterOf, inBucket, nextAction,
  normalizeFilters, parseQuarterKey, DEFAULT_RULES, dealOrder, type DealRef, depthStats, sdrDepth, accountDepth, WINDOW_LABEL, BANDS, type TouchWindow, findings, narrative, RISK_LABEL, riskCounts, riskOf, sdrRisk, previousQuarter, qoq, quarterMetrics, regionBreakdown, rosterById, SDR_ROSTER, sdrTable, STATUS_LABEL, temperatureSummary,
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

/** Adds the presentation-only risk level to a lead record. */
function withRisk(f: LeadFact, rules: Rules) {
  const r = riskOf(f, rules);
  return { ...f, nextAction: nextAction(f, rules), statusLabel: STATUS_LABEL[f.status], risk: r?.level ?? null, riskLabel: r ? RISK_LABEL[r.level] : null, riskReason: r?.reason ?? null };
}

/** Bucket predicate including the risk buckets (risk_critical, risk_at_risk, risk_healthy, risk_neutral). */
function matches(f: LeadFact, bucket: string, rules: Rules): boolean {
  if (bucket.startsWith("risk_")) return riskOf(f, rules)?.level === bucket.slice(5);
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

export function overview(facts: LeadFact[], q: URLSearchParams, today: string, rules: Rules = DEFAULT_RULES) {
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
    risk: {
      all: riskCounts(rows, rules),
      Hot: riskCounts(rows.filter((f) => f.temperature === "Hot"), rules),
      Warm: riskCounts(rows.filter((f) => f.temperature === "Warm"), rules),
    },
    sdrRisk: Object.fromEntries(sdrTable(rows, nf).map((s) => [s.ownerId, sdrRisk(rows, s.ownerId, rules)])),
    focus: top,
    depth: Object.fromEntries(sdrTable(rows, nf).map((s) => [s.ownerId, sdrDepth(rows, s.ownerId, rules, "eligibility", nf.quarterRange).all])),
    touchTarget: rules.touchTarget,
    dealContext: dealContext(rows, today),
    narrative: narrative(rows, rules, top),
    slaDays: { Hot: rules.cadence.Hot.firstTouchBusinessDays, Warm: rules.cadence.Warm.firstTouchBusinessDays },
  };
}

export function leads(facts: LeadFact[], q: URLSearchParams, today: string, rules: Rules) {
  const { nf, rows } = filtered(facts, q, today);
  const bucket = (q.get("bucket") || "").trim();
  const list = bucket ? rows.filter((f) => matches(f, bucket, rules)) : rows;
  list.sort((a, b) => b.priority - a.priority || (a.eventDate ?? "").localeCompare(b.eventDate ?? ""));
  const limit = Math.min(5000, Number(q.get("limit") || 1000));
  return {
    filters: nf, bucket: bucket || null, total: list.length,
    rows: list.slice(0, limit).map((f) => withRisk(f, rules)),
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
        eventDate: c.eventDate, temperature: c.temperature, status: c.status, statusLabel: STATUS_LABEL[c.status], statusReason: c.statusReason,
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
  const list = eventSummaries(rows).map((e) => ({ ...e, risk: riskByEvent.get(e.eventId) ?? null }));
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
