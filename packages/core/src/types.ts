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
  | "unverifiable"
  | "recently_lost";

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
  hubspotOwnerId?: string | null;     // company owner (AE) – used for pod-based SDR routing only
  previousSdrOwnerId?: string | null; // prior value of SDR Owner (from HubSpot property history), context only
  intent?: AccountIntent | null;      // current company-level account intent (separate from the event-lead temperature)
}

/** Company-level buying intent from HubSpot "Account Intent Level" (account_type). Fluid; dates show when it changed. */
export interface AccountIntent {
  level: string | null;               // "Surging" | "Warm" | "Cold" | other value as recorded
  raw: string | null;
  since: string | null;               // date the company entered its current level
  warmAt: string | null; surgingAt: string | null; coldAt: string | null;
  reason: string | null;              // Latest Clay Signal Reason (as recorded)
  recentSignals: string | null;       // HubSpot Recent Intent Signals (rolling 30 days)
  sdrCategory?: string | null;        // TAGS- SDR Categories (newtags___sdr)
  lifecycleCustom?: string | null;    // Lifecycle Stage (Custom) (tam_bucket)
  icp?: string | null;                // ICP Category 2.0 (label)
  engagementScore?: number | null;    // Total Engagement Score (supporting only)
  factorsIntent?: string | null;      // Factors Intent Level (unify_intent_level)
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
  companyIds?: string[];              // every associated company (HubSpot associations); companyId is the primary
  ownerId?: string | null;            // contact owner (hubspot_owner_id)
  sdrOwnerId?: string | null;         // contact-level SDR field (sdr_from_company)
  scores?: ContactScores;
}

/** HubSpot contact-level engagement signals, exactly as recorded (no thresholds invented). */
export interface ContactScores { attendance: number | null; registration: number | null; engagement: number | null; heyreachIntent: string | null; registeredDate: string | null }

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
  sheetAttended?: boolean | null;     // roundtable Google Sheet "Attended" Yes/No (authoritative when present)
  source?: "hubspot" | "sheet" | "both" | null;
}

export type ActivityKind = "EMAIL" | "INCOMING_EMAIL" | "CALL" | "MEETING" | "LINKEDIN" | "TASK" | "NOTE" | "OTHER";

export interface Activity {
  id: string;                         // "<objectType>:<hubspot id>" so ids never collide across object types
  kind: ActivityKind;
  objectType: "emails" | "calls" | "meetings" | "communications" | "tasks" | "notes";
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
  // Deal history (filled by the sync from HubSpot; null for records synced before this was added)
  pipelineLabel?: string | null;
  closeDate?: string | null;
  isClosedLost?: boolean | null;
  closedLostAt?: string | null;
  previousStageLabel?: string | null;
  lostReason?: string | null;
  lostSubReason?: string | null;
  lostComment?: string | null;
}

export type DealStatus = "open" | "won" | "lost" | "none";

/** A deal shown as context on a lead. Context only: never counted as event pipeline unless it is in attributedDeals. */
export interface DealRef {
  id: string;
  name: string | null;
  status: Exclude<DealStatus, "none">;
  stageLabel: string | null;
  createdAt: string | null;
  closedAt: string | null;            // closed-lost date (stage history) or close date for won/lost deals
  previousStageLabel: string | null;  // stage held before closed lost, when known
  lostReason: string | null;
  lostSubReason: string | null;
  lostComment: string | null;
  timing: "before_event" | "after_event" | "unknown";   // pre-existing (MQL, or creation if never MQL, before the event) / new since the event
  via: "contact" | "company" | "duplicate_company"; // this contact / this company only / a same-name company record with the same SDR
  ownerId?: string | null;            // HubSpot deal owner (optional: absent on older snapshots)
  sqlDate?: string | null;            // verified "Became Qualified to Buy Date" (SQL milestone)
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
  /** How the SDR was determined: the company SDR Owner, or the pod SDR of the company's AE owner. */
  sdrSource?: "company" | "pod_ae" | null;
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
  /** Most relevant deal status across the contact's and company's deals (context only). Optional for old snapshots. */
  dealStatus?: DealStatus;
  deals?: DealRef[];
  /** Account closed lost within rules.recentlyClosedLostDays: shown grey, no SLA. Optional for old snapshots. */
  recentlyLost?: { dealId: string; dealName: string | null; closedAt: string; via: DealRef["via"] } | null;
  /** Every qualifying contact touch (any date), used for allocation / event / reporting-period windows. */
  allTouchDates?: string[];
  allTouchIds?: string[];
  /** Daily worklist context (optional: absent on snapshots computed before this field existed). */
  lastReplyAt?: string | null;          // latest prospect reply since eligibility
  lastOutboundAt?: string | null;       // latest outbound email/call/meeting by anyone (SDR, AE, other)
  lastOutboundOwnerId?: string | null;
  lastOutboundKind?: string | null;
  currentSdrTouchesSinceAllocation?: number | null;
  lastMeetingAt?: string | null;
  currentSdrTouches?: number | null;    // touches by the CURRENT SDR since the event date (other reps not credited)
  otherSdrTouches?: number;             // qualifying touches by OTHER roster SDRs since the event (context, never credited)
  otherRepTouch?: { at: string; ownerId: string | null } | null; // latest outreach by another SDR/AE since the event
  lastOtherSdrTouch?: { at: string; ownerId: string | null } | null;
  lastTouchOwnerId?: string | null;
  currentSdrLastTouchAt?: string | null; // last qualifying touch by the CURRENT SDR (any date)
  nextTaskSubject?: string | null;
  nextTaskOwnerId?: string | null;
  slaApplies?: boolean;
  accountIntent?: AccountIntent | null;
  contactLeadStatus?: string | null;
  contactScores?: ContactScores | null;
  /** Per event: verified participation (never infers a no-show from missing data). */
  participation?: "attended" | "registered_only" | "no_show" | "unknown";
  participationSource?: string | null;    // HubSpot contact Lead Status (structured disposition source)
  nextMeetingAt?: string | null;
  /** A note logged on this contact around the event by a SpotDraft user (evidence of an event conversation). */
  eventNote?: { at: string; text: string | null; ownerId: string | null } | null;
  /** Ownership as recorded on each record (for reconciliation; the SDR used everywhere is sdrOwnerId). */
  ownership?: { previousSdrId?: string | null; companySdrId: string | null; companyOwnerId: string | null; contactOwnerId: string | null; contactSdrId: string | null; companyCount: number; allocationDate: string | null };        // a scheduled meeting in the future (verified commitment)
  dataQuality: string[];
  priority: number;                   // higher = more urgent
}
