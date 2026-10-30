import type { EventCategory, Region, Temperature } from "./types.js";

/**
 * Approved SDR roster. HubSpot owner IDs were resolved with the HubSpot Owners API on 30 Oct 2026
 * (exact owner records, no partial-name matching). Only these people appear in SDR reporting.
 */
export const SDR_ROSTER: ReadonlyArray<{ ownerId: string; name: string; region: Region }> = [
  { ownerId: "87607260", name: "Bobbi Bukovac", region: "NAM" },
  { ownerId: "97411405", name: "Jody Walker", region: "NAM" },
  { ownerId: "97411438", name: "Jonathan Hurt", region: "NAM" },
  { ownerId: "92977365", name: "Danielle Shannon", region: "NAM" },
  { ownerId: "101731640", name: "Adam Myers", region: "NAM" },
  { ownerId: "102138930", name: "Timothy Pierce", region: "NAM" },
  { ownerId: "2125691021", name: "Anshu Chaudhary", region: "EMEA" },
  { ownerId: "88722653", name: "Disha Ojha", region: "APAC" },
  { ownerId: "1200648252", name: "Manisha Sharma", region: "APAC" },
  { ownerId: "77920055", name: "Natasha Maheshwari", region: "APAC" },
  { ownerId: "879250802", name: "Anil Pillay", region: "APAC" },
  { ownerId: "101025460", name: "Pradyumna Pohekar", region: "APAC" },
  { ownerId: "100015175", name: "Lakshay Bahl", region: "APAC" },
];

export interface CadenceRule {
  /** Business days after the eligibility date by which the first touch must happen. */
  firstTouchBusinessDays: number;
  /** A lead with no touch for this many business days (after starting) is "Follow-Up Stalled". */
  stallBusinessDays: number;
  /** Expected cumulative touches by lead age (calendar days since eligibility). Linear between checkpoints. */
  cadence: Array<{ day: number; touches: number }>;
  /** Touch count at which a lead with no response is flagged for intervention. */
  interventionTouches: number;
}

export interface Rules {
  temperature: {
    property: string;
    hotValues: string[];
    warmValues: string[];
  };
  cadence: Record<Temperature, CadenceRule>;
  /** Weekend days (0 = Sunday ... 6 = Saturday) and holidays (YYYY-MM-DD) excluded from business-day SLAs. */
  businessCalendar: { weekendDays: number[]; holidays: string[] };
  eligibleIcpTiers: string[];
  competitorValues: string[];
  customerLifecycleStages: string[];
  disqualifiedLeadStatuses: string[];
  sponsored: { requireAttendance: boolean; allowPriorConversation: boolean };
  attendanceWindow: { daysBefore: number; daysAfter: number };
  /** Touches on the event day count as post-event when this is 0; set to 1 to start the next day. */
  postEventStartOffsetDays: number;
  multiWeekMinWeeks: number;
  /** Count outbound touches by any approved roster SDR (true) or only by the account's assigned SDR (false). */
  countAnyRosterSdrTouch: boolean;
  dealAttributionDays: number;
  /** Accounts whose deal went closed lost within this many days (of today) show "Recently closed lost": grey, no SLA. 0 = off. */
  recentlyClosedLostDays: number;
  /** Treat a company with the same normalised name AND the same SDR owner as the same account for deal history (duplicate HubSpot records). */
  matchDuplicateCompanies: boolean;
  /** Touch-depth target. windowDays = days after eligibility by which the target should be reached; null = not yet confirmed (progress only, never a breach). */
  touchTarget: { minimum: number; bandMax: number; windowDays: number | null };
  /** Roundtable Google Sheet: when authoritative, a matched tab REPLACES the HubSpot registrant list for that event. */
  roundtableSheet: { authoritative: boolean };
  /** Companies hidden from every view and count: HubSpot company ids or company names (name match ignores Inc/LLC/"The"). */
  excludedCompanies: string[];
  /** Open deals in these stages (case-insensitive substring of the stage label) do NOT put a lead "in play". */
  inactiveDealStages: string[];
  /** Deals whose name matches this pattern (e.g. test records) are ignored entirely. */
  ignoredDealNamePattern: string;
  staleAfterHours: number;
  eventCategoryRules: Array<{ category: EventCategory; pattern: string }>;
  eventCategoryOverrides: Record<string, EventCategory>;
}

export const DEFAULT_RULES: Rules = {
  temperature: {
    // Verified in HubSpot (portal 7712708) on 30 Oct 2026: Company property, options Cold/Warm/Surging/Hot.
    // Records currently carry Hot, Warm and Cold; "Surging" is defined but unused, so it is NOT mapped to Hot or Warm.
    property: "event_leads___cold_warm_surging_hot",
    hotValues: ["Hot"],
    warmValues: ["Warm"],
  },
  cadence: {
    // Operating expectations discussed with the CMO (not a finalized policy): ~3 business days to first touch,
    // >=4 touches in ~30 days, >=8 touches in ~8 weeks, intervention at 6 touches. All configurable.
    Hot: {
      firstTouchBusinessDays: 3,
      stallBusinessDays: 7,
      cadence: [{ day: 0, touches: 1 }, { day: 30, touches: 4 }, { day: 56, touches: 8 }],
      interventionTouches: 6,
    },
    Warm: {
      firstTouchBusinessDays: 3,
      stallBusinessDays: 10,
      cadence: [{ day: 0, touches: 1 }, { day: 30, touches: 4 }, { day: 56, touches: 8 }],
      interventionTouches: 6,
    },
  },
  businessCalendar: { weekendDays: [0, 6], holidays: [] },
  eligibleIcpTiers: ["Targetable - Tier 1A", "Tier 1", "Targetable - Tier 1", "Targetable - Tier 2", "Targetable - Tier 3", "Workable"],
  competitorValues: ["direct competitor"],
  customerLifecycleStages: ["customer"],
  disqualifiedLeadStatuses: ["UNQUALIFIED"],
  sponsored: { requireAttendance: true, allowPriorConversation: true },
  attendanceWindow: { daysBefore: 1, daysAfter: 3 },
  postEventStartOffsetDays: 0,
  multiWeekMinWeeks: 2,
  countAnyRosterSdrTouch: true,
  dealAttributionDays: 90,
  recentlyClosedLostDays: 90,
  matchDuplicateCompanies: true,
  touchTarget: { minimum: 6, bandMax: 7, windowDays: null },
  roundtableSheet: { authoritative: true },
  excludedCompanies: ["The Channel Company"],
  inactiveDealStages: ["not qualified", "disqualified", "no show", "closed lost"],
  ignoredDealNamePattern: "^test\\b",
  staleAfterHours: 5,
  eventCategoryRules: [
    { category: "roundtable", pattern: "round ?table|\\brt ?\\d" },
    { category: "webinar", pattern: "webinar|masterclass|demo day|virtual" },
    { category: "owned", pattern: "beacon|puppy yoga|spotdraft experience|spotdraft dinner" },
    { category: "sponsored", pattern: "\\bacc\\b|rllb|\\bllb\\b|lextalk|legal geek|crafty|counselwell|et legal|legaltech|conference|summit|clo(c)?\\b|mixer|workshop|expo|forum|congress" },
  ],
  eventCategoryOverrides: {},
};

export function mergeRules(base: Rules, patch: unknown): Rules {
  if (!patch || typeof patch !== "object") return base;
  const out: any = structuredClone(base);
  const walk = (dst: any, src: any) => {
    for (const [k, v] of Object.entries(src)) {
      if (v && typeof v === "object" && !Array.isArray(v) && dst[k] && typeof dst[k] === "object" && !Array.isArray(dst[k])) walk(dst[k], v);
      else dst[k] = v;
    }
  };
  walk(out, patch);
  return out as Rules;
}

export const rosterById = new Map(SDR_ROSTER.map((s) => [s.ownerId, s]));

export function sdrRegion(ownerId: string | null | undefined): Region | null {
  return (ownerId && rosterById.get(ownerId)?.region) || null;
}

export function isRosterSdr(ownerId: string | null | undefined): boolean {
  return !!ownerId && rosterById.has(ownerId);
}

export function rosterForRegion(region: Region | null): typeof SDR_ROSTER {
  return region ? SDR_ROSTER.filter((s) => s.region === region) : SDR_ROSTER;
}
