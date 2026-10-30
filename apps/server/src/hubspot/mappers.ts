import { categorizeEvent, toDate, type ActivityKind, type Rules } from "@ecc/core";

// Pure functions translating HubSpot API records into database rows. Unit-tested without network access.

export const CONTACT_PROPERTIES = [
  "firstname", "lastname", "email", "jobtitle", "country", "associatedcompanyid", "lifecyclestage", "hs_lead_status",
  "dnc", "hs_email_optout", "date_engaged__event_attended_date_", "hubspot_owner_id", "sdr_from_company",
];

export const COMPANY_PROPERTIES = [
  "name", "domain", "country", "sdr_owner", "allocation_date", "date_of_unassignment", "icp_category_20",
  "competitor_check__clay", "event_leads___cold_warm_surging_hot", "lifecyclestage", "hubspot_owner_id", "team___sdr_company",
];

export const ACTIVITY_TYPES = ["emails", "calls", "meetings", "communications", "tasks"] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const ACTIVITY_PROPERTIES: Record<ActivityType, string[]> = {
  emails: ["hs_timestamp", "hubspot_owner_id", "hs_email_direction", "hs_email_subject", "hs_email_status"],
  calls: ["hs_timestamp", "hubspot_owner_id", "hs_call_direction", "hs_call_status", "hs_call_title", "hs_call_disposition"],
  meetings: ["hs_timestamp", "hs_meeting_start_time", "hubspot_owner_id", "hs_meeting_outcome", "hs_meeting_title"],
  communications: ["hs_timestamp", "hubspot_owner_id", "hs_communication_channel_type", "hs_communication_logged_from", "hs_body_preview"],
  tasks: ["hs_timestamp", "hubspot_owner_id", "hs_task_status", "hs_task_type", "hs_task_subject", "hs_task_completion_date"],
};

export const DEAL_PROPERTIES_BASE = ["dealname", "dealstage", "pipeline", "hs_is_closed", "hs_is_closed_won", "hubspot_owner_id", "amount", "createdate"];

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
  hubspot_owner_id: string | null; sdr_team: string | null; sdr_history: unknown;
}
/**
 * Allocation date: the "Allocation date" property when present; otherwise the timestamp at which the current
 * SDR Owner value was set (property history), flagged as allocation_source = 'history'.
 */
export function mapCompany(r: any, temperatureProperty = "event_leads___cold_warm_surging_hot"): CompanyRow {
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
  };
}

export interface ContactRow {
  id: string; first_name: string | null; last_name: string | null; email: string | null; job_title: string | null; country: string | null;
  company_id: string | null; lifecycle_stage: string | null; lead_status: string | null; do_not_contact: boolean; attended_date: string | null;
  hubspot_owner_id: string | null; contact_sdr_owner_id: string | null;
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
}
export function mapDeal(r: any, stageLabels: Map<string, string>, mqlProp: string, sqlProp: string): DealRow {
  const p = r.properties ?? {};
  const stage = s(p.dealstage);
  const amount = p.amount === undefined || p.amount === null || p.amount === "" ? null : Number(p.amount);
  return {
    id: String(r.id), name: s(p.dealname), stage, stage_label: stage ? stageLabels.get(stage) ?? stage : null,
    is_closed: truthy(p.hs_is_closed), is_won: truthy(p.hs_is_closed_won), owner_id: s(p.hubspot_owner_id),
    amount: Number.isFinite(amount as number) ? amount : null, created_at: hsTimestamp(p.createdate),
    mql_date: hsDate(p[mqlProp]), sql_date: hsDate(p[sqlProp]),
  };
}

/** Attendance snapshot: keep the attended date only while it falls inside this event's window. */
export function attendedForEvent(eventDate: string | null, attended: string | null, rules: Rules): string | null {
  if (!eventDate || !attended) return null;
  const diff = Math.round((Date.parse(attended) - Date.parse(eventDate)) / 86_400_000);
  return diff >= -rules.attendanceWindow.daysBefore && diff <= rules.attendanceWindow.daysAfter ? attended : null;
}
