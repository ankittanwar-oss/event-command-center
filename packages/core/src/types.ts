// Shared domain types. These mirror the rows the sync worker stores in Postgres and are the only inputs to the
// calculation layer, so the API and the worker always compute from the same shapes.

export type Region = "NAM" | "EMEA" | "APAC";
export type EventCategory = "owned" | "sponsored" | "webinar" | "roundtable" | "uncategorized";
export type Temperature = "Hot" | "Warm";
export type AttendanceStatus = "attended" | "no_show" | "unknown";

export type FollowUpStatus =
  | "never_worked"
  | "first_touch"
  | "active"
  | "stalled"
  | "in_play"
  | "unverifiable";

export interface Company {
  id: string;
  name: string | null;
  domain: string | null;
  country: string | null;
  sdrOwnerId: string | null;          // Company property "SDR Owner (Company)" (sdr_owner) – the only SDR source of truth
  allocationDate: string | null;      // YYYY-MM-DD, Company property "Allocation date"
  allocationSource: "property" | "history" | null;
  unassignmentDate: string | null;
  icpTier: string | null;             // Company property "ICP Category 2.0" (icp_category_20)
  competitorFlag: string | null;      // Company property "Competitor check (clay)"
  temperatureRaw: string | null;      // Company property "Event Leads - Cold/Warm/Surging/Hot"
  lifecycleStage: string | null;
}

export interface Contact {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  jobTitle: string | null;
  country: string | null;
  companyId: string | null;
  lifecycleStage: string | null;
  leadStatus: string | null;
  doNotContact: boolean;
  attendedDate: string | null;        // Contact property "Date Engaged 'Event Attended Date'" (single value, overwritten by later events)
}

export interface EventRecord {
  id: string;
  name: string;
  date: string | null;                // YYYY-MM-DD
  eventType: string | null;
  category: EventCategory;
  categorySource: "rule" | "override" | "none";
}

export interface EventContact {
  eventId: string;
  contactId: string;
  attendedAt: string | null;          // attendance date captured while it matched THIS event (survives later overwrites)
}

export type ActivityKind = "EMAIL" | "INCOMING_EMAIL" | "CALL" | "MEETING" | "LINKEDIN" | "TASK" | "OTHER";

export interface Activity {
  id: string;                         // "<objectType>:<hubspot id>" so ids never collide across object types
  kind: ActivityKind;
  objectType: "emails" | "calls" | "meetings" | "communications" | "tasks";
  timestamp: string;                  // ISO timestamp
  ownerId: string | null;
  direction: string | null;           // hs_email_direction / hs_call_direction
  channel: string | null;             // hs_communication_channel_type / hs_task_type
  status: string | null;              // hs_call_status / hs_task_status / hs_meeting_outcome
  title: string | null;
  contactIds: string[];
  companyIds: string[];
}

export interface Task {
  id: string;
  dueDate: string | null;             // ISO
  status: string | null;
  taskType: string | null;
  ownerId: string | null;
  subject: string | null;
  contactIds: string[];
}

export interface Deal {
  id: string;
  name: string | null;
  stage: string | null;
  stageLabel: string | null;
  isClosed: boolean;
  isWon: boolean;
  ownerId: string | null;
  amount: number | null;
  createdAt: string | null;
  mqlDate: string | null;
  sqlDate: string | null;
  contactIds: string[];
  companyIds: string[];
}

export interface Owner {
  id: string;
  name: string;
  email: string | null;
  active: boolean;
}

export interface Touch {
  activityId: string;
  kind: "Email" | "Call" | "LinkedIn";
  timestamp: string;
  ownerId: string | null;
  source: "contact" | "company";
}

/** One row per (event, contact). This is the record behind every number in the application. */
export interface LeadFact {
  eventId: string;
  contactId: string;
  companyId: string | null;
  eventName: string;
  eventDate: string | null;
  eventCategory: EventCategory;
  fiscalQuarter: string | null;       // e.g. "FY2027-Q2"
  contactName: string;
  contactEmail: string | null;
  jobTitle: string | null;
  companyName: string | null;
  icpTier: string | null;
  temperature: Temperature | null;
  temperatureRaw: string | null;
  sdrOwnerId: string | null;          // roster SDR only; null when unmapped
  sdrOwnerRaw: string | null;
  sdrRegion: Region | null;
  registered: true;
  attendance: AttendanceStatus;
  eligible: boolean;
  ineligibleReason: string | null;
  allocationDate: string | null;
  eligibilityDate: string | null;     // max(event date, allocation date)
  ageDays: number | null;             // calendar days since eligibility date
  firstTouchAt: string | null;
  lastTouchAt: string | null;
  touchesSinceAllocation: number | null; // null when allocation date unknown
  touchesPostEvent: number;
  touchesSinceEligibility: number;
  touchesFirst30Days: number;
  distinctTouchDays: number;
  distinctTouchWeeks: number;
  avgGapDays: number | null;
  maxGapDays: number | null;
  daysSinceLastTouch: number | null;
  businessDaysToFirstTouch: number | null;
  businessDaysSinceEligibility: number | null;
  firstTouchSlaMet: boolean | null;
  firstTouchOverdue: boolean;
  expectedTouches: number;
  insufficientFollowUp: boolean;
  multiWeek: boolean;
  nextTaskDue: string | null;
  hasNextStep: boolean;
  status: FollowUpStatus;
  statusReason: string;
  inPlayReason: string | null;
  companyOutreachOnly: boolean;
  touchKinds: string[];
  touchDates: string[];
  touchIds: string[];                 // activity ids of qualifying touches (account-level de-duplication)
  priorConversation: boolean;
  isUpcoming: boolean;
  preEventTouches: number;            // qualifying touches in the 30 days before the event (invitations / pre-event outreach)
  icpPriority: boolean;               // Tier 1A / Tier 1 / Tier 2
  attributedDeals: string[];
  sqlDeals: string[];
  dataQuality: string[];
  priority: number;                   // higher = more urgent
}
