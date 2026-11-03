import { categorizeEvent, toDate, type ActivityKind, type Rules } from "@ecc/core";

// Pure functions translating HubSpot API records into database rows. Unit-tested without network access.

export const CONTACT_PROPERTIES = [
  "firstname", "lastname", "email", "jobtitle", "country", "associatedcompanyid", "lifecyclestage", "hs_lead_status",
  "dnc", "hs_email_optout", "date_engaged__event_attended_date_", "hubspot_owner_id", "sdr_from_company",
];

export const COMPANY_PROPERTIES = [
  "name", "domain", "country", "sdr_owner", "allocation_date", "date_of_unassignment", "icp_category_20",
  "competitor_check__clay", "event_leads___cold_warm_surging_hot", "lifecyclestage", "hubspot_owner_id", "team___sdr_company",
  // Current account intent (company level; fluid): Account Intent Level + the dates the company entered each stage.
  "account_type", "date_entered__warm_stage_", "date_entered__surging_stage_", "date_entered__cold_stage_",
  "latest_clay_signal_reason", "hs_recent_intent_signals",
  // Account context shown with intent: TAGS- SDR Categories, Lifecycle Stage (Custom), Total Engagement Score, Factors Intent Level.
  "newtags___sdr", "tam_bucket", "total_engagement_score", "unify_intent_level",
];
/** Company dropdowns whose option LABELS are shown (the API returns internal values). */
export const COMPANY_LABELLED = ["account_type", "newtags___sdr", "tam_bucket", "icp_category_20", "unify_intent_level"] as const;
export type LabelMaps = Record<string, Map<string, string>>;

export const ACTIVITY_TYPES = ["emails", "calls", "meetings", "communications", "tasks"] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const ACTIVITY_PROPERTIES: Record<ActivityType, string[]> = {
  emails: ["hs_timestamp", "hubspot_owner_id", "hs_email_direction", "hs_email_subject", "hs_email_status"],
  calls: ["hs_timestamp", "hubspot_owner_id", "hs_call_direction", "hs_call_status", "hs_call_title", "hs_call_disposition"],
  meetings: ["hs_timestamp", "hs_meeting_start_time", "hubspot_owner_id", "hs_meeting_outcome", "hs_meeting_title"],
  communications: ["hs_timestamp", "hubspot_owner_id", "hs_communication_channel_type", "hs_communication_logged_from", "hs_body_preview"],
  tasks: ["hs_timestamp", "hubspot_owner_id", "hs_task_status", "hs_task_type", "hs_task_subject", "hs_task_completion_date"],
};

export const DEAL_PROPERTIES_BASE = [
  "dealname", "dealstage", "pipeline", "hs_is_closed", "hs_is_closed_won", "hs_is_closed_lost", "hubspot_owner_id", "amount", "createdate", "closedate",
  // Closed-lost context exactly as recorded in HubSpot (portal 7712708). Shown only when present; never inferred.
  "closed_lost_reason_", "closed_lost_sub_reason", "closed_lost_reason",
];

const s = (v: unknown): string | null => (v === undefined || v === null || v === "" ? null : String(v));
const truthy = (v: unknown) => ["true", "1", "yes"].includes(String(v ?? "").toLowerCase());

/** HubSpot date properties arrive as "YYYY-MM-DD", ISO timestamps or epoch milliseconds. */
export function hsDate(v: unknown): string | null {
  const x = s(v);
  if (!x) return null;
  if (/^\d{11,}$/.test(x)) return new Date(Number(x)).toISOString().slice(0, 10);
  return toDate(x);
}
export function hsTimestamp(v: unknown): string | null {
  const x = s(v);
  if (!x) return null;
  if (/^\d{11,}$/.test(x)) return new Date(Number(x)).toISOString();
  const d = new Date(x);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export interface OwnerRow { id: string; name: string; email: string | null; active: boolean }
export function mapOwner(o: any): OwnerRow {
  const name = [o.firstName, o.lastName].filter(Boolean).join(" ").trim() || o.email || String(o.id);
  return { id: String(o.id), name, email: s(o.email), active: !o.archived };
}

export interface CompanyRow {
  id: string; name: string | null; domain: string | null; country: string | null;
  sdr_owner_id: string | null; allocation_date: string | null; allocation_source: string | null; unassignment_date: string | null;
  icp_tier: string | null; competitor_flag: string | null; temperature_raw: string | null; lifecycle_stage: string | null;
  hubspot_owner_id: string | null; sdr_team: string | null; sdr_history: unknown; intent: unknown;
}
/**
 * Allocation date: the "Allocation date" property when present; otherwise the timestamp at which the current
 * SDR Owner value was set (property history), flagged as allocation_source = 'history'.
 */
/** Account intent exactly as recorded in HubSpot. Nothing is inferred: missing values stay null. */
export function mapIntent(p: Record<string, unknown>, labels: LabelMaps = {}) {
  const lab = (k: string) => { const v = s(p[k]); return v ? labels[k]?.get(v) ?? v : null; };
  const raw = lab("account_type");
  const level = raw ? raw.replace(/\s*account$/i, "").trim() : null; // "Warm Account" -> "Warm"
  const warmAt = hsDate(p.date_entered__warm_stage_), surgingAt = hsDate(p.date_entered__surging_stage_), coldAt = hsDate(p.date_entered__cold_stage_);
  const since = level && /^surging/i.test(level) ? surgingAt : level && /^warm/i.test(level) ? warmAt : level && /^cold/i.test(level) ? coldAt : null;
  const score = s(p.total_engagement_score);
  return {
    level, raw, since, warmAt, surgingAt, coldAt, reason: s(p.latest_clay_signal_reason), recentSignals: s(p.hs_recent_intent_signals),
    sdrCategory: lab("newtags___sdr"), lifecycleCustom: lab("tam_bucket"), icp: lab("icp_category_20"),
    engagementScore: score !== null && !Number.isNaN(Number(score)) ? Number(score) : null, factorsIntent: lab("unify_intent_level"),
  };
}

export function mapCompany(r: any, temperatureProperty = "event_leads___cold_warm_surging_hot", labels: LabelMaps = {}): CompanyRow {
  const p = r.properties ?? {};
  const sdr = s(p.sdr_owner);
  let allocation = hsDate(p.allocation_date);
  let source: string | null = allocation ? "property" : null;
  const history: any[] | undefined = r.propertiesWithHistory?.sdr_owner;
  if (!allocation && sdr && history?.length) {
    const current = [...history].sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp))).find((h) => String(h.value) === sdr);
    if (current) { allocation = hsDate(current.timestamp); source = "history"; }
  }
  return {
    id: String(r.id), name: s(p.name), domain: s(p.domain), country: s(p.country),
    sdr_owner_id: sdr, allocation_date: allocation, allocation_source: source, unassignment_date: hsDate(p.date_of_unassignment),
    icp_tier: s(p.icp_category_20), competitor_flag: s(p.competitor_check__clay), temperature_raw: s(p[temperatureProperty]),
    lifecycle_stage: s(p.lifecyclestage), hubspot_owner_id: s(p.hubspot_owner_id), sdr_team: s(p.team___sdr_company),
    sdr_history: history ? history.slice(0, 20).map((h) => ({ value: h.value, timestamp: h.timestamp, sourceType: h.sourceType })) : null,
    intent: mapIntent(p, labels),
  };
}

export interface ContactRow {
  id: string; first_name: string | null; last_name: string | null; email: string | null; job_title: string | null; country: string | null;
  company_id: string | null; lifecycle_stage: string | null; lead_status: string | null; do_not_contact: boolean; attended_date: string | null;
  hubspot_owner_id: string | null; contact_sdr_owner_id: string | null; company_ids?: string[] | null;
}
export function mapContact(r: any): ContactRow {
  const p = r.properties ?? {};
  return {
    id: String(r.id), first_name: s(p.firstname), last_name: s(p.lastname), email: s(p.email), job_title: s(p.jobtitle), country: s(p.country),
    company_id: s(p.associatedcompanyid), lifecycle_stage: s(p.lifecyclestage), lead_status: s(p.hs_lead_status),
    do_not_contact: truthy(p.dnc), attended_date: hsDate(p.date_engaged__event_attended_date_),
    hubspot_owner_id: s(p.hubspot_owner_id), contact_sdr_owner_id: s(p.sdr_from_company),
  };
}

export interface EventRow { id: string; name: string; event_date: string | null; event_type: string | null; category: string; category_source: string }
export function mapEvent(r: any, props: { name: string; date: string; type: string }, rules: Rules): EventRow {
  const p = r.properties ?? {};
  const name = s(p[props.name]) ?? `Event ${r.id}`;
  const type = s(p[props.type]);
  const cat = categorizeEvent(String(r.id), name, type, rules);
  return { id: String(r.id), name, event_date: hsDate(p[props.date]), event_type: type, category: cat.category, category_source: cat.source };
}

export interface ActivityRow {
  id: string; object_type: ActivityType; hs_id: string; kind: ActivityKind; ts: string; owner_id: string | null;
  direction: string | null; channel: string | null; status: string | null; title: string | null;
}

/** Normalise any HubSpot engagement into an activity row. Returns null when it has no usable timestamp. */
export function mapActivity(type: ActivityType, r: any): ActivityRow | null {
  const p = r.properties ?? {};
  let kind: ActivityKind = "OTHER";
  let direction: string | null = null, channel: string | null = null, status: string | null = null, title: string | null = null;
  let ts = hsTimestamp(p.hs_timestamp);
  switch (type) {
    case "emails": {
      direction = s(p.hs_email_direction)?.toUpperCase() ?? null;
      kind = direction === "INCOMING_EMAIL" ? "INCOMING_EMAIL" : direction === "EMAIL" ? "EMAIL" : "OTHER";
      status = s(p.hs_email_status); title = s(p.hs_email_subject);
      break;
    }
    case "calls": {
      kind = "CALL"; direction = s(p.hs_call_direction)?.toUpperCase() ?? null; status = s(p.hs_call_status)?.toUpperCase() ?? null;
      title = s(p.hs_call_title);
      break;
    }
    case "meetings": {
      kind = "MEETING"; status = s(p.hs_meeting_outcome)?.toUpperCase() ?? null; title = s(p.hs_meeting_title);
      ts = hsTimestamp(p.hs_meeting_start_time) ?? ts;
      if (status === "CANCELED" || status === "NO_SHOW") kind = "OTHER";
      break;
    }
    case "communications": {
      channel = s(p.hs_communication_channel_type)?.toUpperCase() ?? null;
      kind = channel === "LINKEDIN_MESSAGE" || channel === "LINKEDIN" ? "LINKEDIN" : "OTHER";
      title = s(p.hs_body_preview)?.slice(0, 140) ?? null;
      break;
    }
    case "tasks": {
      kind = "TASK"; channel = s(p.hs_task_type)?.toUpperCase() ?? null; status = s(p.hs_task_status)?.toUpperCase() ?? null;
      title = s(p.hs_task_subject);
      // A completed task counts on the day it was completed, not the day it was due.
      if (status === "COMPLETED") ts = hsTimestamp(p.hs_task_completion_date) ?? ts;
      break;
    }
  }
  if (!ts) return null;
  return { id: `${type}:${r.id}`, object_type: type, hs_id: String(r.id), kind, ts, owner_id: s(p.hubspot_owner_id), direction, channel, status, title };
}

export interface TaskRow { id: string; due_at: string | null; status: string | null; task_type: string | null; owner_id: string | null; subject: string | null }
export function mapTask(r: any): TaskRow {
  const p = r.properties ?? {};
  return {
    id: String(r.id), due_at: hsTimestamp(p.hs_timestamp), status: s(p.hs_task_status)?.toUpperCase() ?? null,
    task_type: s(p.hs_task_type)?.toUpperCase() ?? null, owner_id: s(p.hubspot_owner_id), subject: s(p.hs_task_subject),
  };
}

export interface DealRow {
  id: string; name: string | null; stage: string | null; stage_label: string | null; is_closed: boolean; is_won: boolean;
  owner_id: string | null; amount: number | null; created_at: string | null; mql_date: string | null; sql_date: string | null;
  pipeline: string | null; pipeline_label: string | null; close_date: string | null; is_closed_lost: boolean;
  closed_lost_at: string | null; previous_stage_label: string | null;
  lost_reason: string | null; lost_sub_reason: string | null; lost_comment: string | null;
  stage_history: Array<{ stage: string; label: string; at: string }> | null;
}
export interface StageInfo { label: string; pipelineLabel: string; closedLost: boolean; closedWon: boolean }

/** Stage metadata from the deal pipelines API: closed-lost = isClosed and probability 0. */
export function stageInfoFromPipelines(pipelines: Array<{ label: string; stages?: Array<{ id: string; label: string; metadata?: Record<string, string> }> }>): Map<string, StageInfo> {
  const m = new Map<string, StageInfo>();
  for (const p of pipelines) for (const st of p.stages ?? []) {
    const closed = String(st.metadata?.isClosed ?? "").toLowerCase() === "true";
    const prob = Number(st.metadata?.probability ?? NaN);
    m.set(st.id, { label: st.label, pipelineLabel: p.label, closedLost: closed && prob === 0, closedWon: closed && prob === 1 });
  }
  return m;
}

export function mapDeal(r: any, stageLabels: Map<string, string>, mqlProp: string, sqlProp: string, stageInfo: Map<string, StageInfo> = new Map()): DealRow {
  const p = r.properties ?? {};
  const stage = s(p.dealstage);
  const amount = p.amount === undefined || p.amount === null || p.amount === "" ? null : Number(p.amount);
  const label = (id: string) => (stageInfo.get(id) ? `${stageInfo.get(id)!.label} (${stageInfo.get(id)!.pipelineLabel})` : stageLabels.get(id) ?? id);
  const isLost = (id: string | null) => !!id && (stageInfo.get(id)?.closedLost ?? false);

  // Stage history (oldest first) from HubSpot's property history for "dealstage".
  const raw: any[] | undefined = r.propertiesWithHistory?.dealstage;
  const history = raw?.length
    ? raw.filter((h) => h?.value && h?.timestamp)
      .map((h) => ({ stage: String(h.value), label: label(String(h.value)), at: hsTimestamp(h.timestamp) ?? String(h.timestamp) }))
      .sort((a, b) => a.at.localeCompare(b.at))
    : null;

  const closedLost = truthy(p.hs_is_closed_lost) || isLost(stage);
  let closedLostAt: string | null = null;
  let previous: string | null = null;
  if (closedLost && history?.length) {
    // the most recent move INTO a closed-lost stage, and the stage held right before it
    for (let i = history.length - 1; i >= 0; i--) {
      const cur = history[i]!;
      const prev = history[i - 1];
      if (isLost(cur.stage) && (!prev || !isLost(prev.stage))) { closedLostAt = cur.at; previous = prev ? prev.label : null; break; }
    }
  }
  if (closedLost && !closedLostAt) closedLostAt = hsTimestamp(p.closedate); // HubSpot sets the close date when a deal is closed

  return {
    id: String(r.id), name: s(p.dealname), stage, stage_label: stage ? label(stage) : null,
    is_closed: truthy(p.hs_is_closed), is_won: truthy(p.hs_is_closed_won), owner_id: s(p.hubspot_owner_id),
    amount: Number.isFinite(amount as number) ? amount : null, created_at: hsTimestamp(p.createdate),
    mql_date: hsDate(p[mqlProp]), sql_date: hsDate(p[sqlProp]),
    pipeline: s(p.pipeline), pipeline_label: stage ? stageInfo.get(stage)?.pipelineLabel ?? null : null,
    close_date: hsTimestamp(p.closedate), is_closed_lost: closedLost,
    closed_lost_at: closedLost ? closedLostAt : null, previous_stage_label: closedLost ? previous : null,
    lost_reason: closedLost ? s(p.closed_lost_reason_) : null,
    lost_sub_reason: closedLost ? s(p.closed_lost_sub_reason) : null,
    lost_comment: closedLost ? s(p.closed_lost_reason) : null,
    stage_history: history,
  };
}

/** Attendance snapshot: keep the attended date only while it falls inside this event's window. */
export function attendedForEvent(eventDate: string | null, attended: string | null, rules: Rules): string | null {
  if (!eventDate || !attended) return null;
  const diff = Math.round((Date.parse(attended) - Date.parse(eventDate)) / 86_400_000);
  return diff >= -rules.attendanceWindow.daysBefore && diff <= rules.attendanceWindow.daysAfter ? attended : null;
}
