// All configuration comes from environment variables (Railway "Variables"). Nothing secret is ever sent to the browser.

function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback === undefined) throw new Error(`Missing required environment variable ${name}`);
    return fallback;
  }
  return v;
}
function num(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}
function bool(name: string, fallback: boolean): boolean {
  const v = (process.env[name] || "").toLowerCase();
  if (!v) return fallback;
  return ["1", "true", "yes", "on"].includes(v);
}

export const env = {
  get databaseUrl() { return str("DATABASE_URL"); },
  get hubspotToken() { return str("HUBSPOT_PRIVATE_APP_TOKEN"); },
  port: num("PORT", 3000),
  appPassword: process.env.APP_PASSWORD || "",
  adminToken: process.env.ADMIN_TOKEN || "",
  hubspotPortalId: str("HUBSPOT_PORTAL_ID", "7712708"),
  hubspotBaseUrl: str("HUBSPOT_BASE_URL", "https://api.hubapi.com"),
  hubspotMaxRps: num("HUBSPOT_MAX_REQUESTS_PER_SECOND", 8),
  eventObjectType: str("HUBSPOT_EVENT_OBJECT_TYPE", "2-23538230"),
  eventNameProperty: str("HUBSPOT_EVENT_NAME_PROPERTY", "marketing_event_name"),
  eventDateProperty: str("HUBSPOT_EVENT_DATE_PROPERTY", "date_of_the_event"),
  eventTypeProperty: str("HUBSPOT_EVENT_TYPE_PROPERTY", "event_type"),
  eventLookbackDays: num("SYNC_EVENT_LOOKBACK_DAYS", 400),
  eventLookaheadDays: num("SYNC_EVENT_LOOKAHEAD_DAYS", 180),
  companyActivityAssociations: bool("SYNC_COMPANY_ACTIVITIES", true),
  maxCompanyActivityAssociations: num("SYNC_MAX_COMPANY_ACTIVITY_ASSOCIATIONS", 3000),
  fullSyncIntervalHours: num("SYNC_FULL_RECONCILE_HOURS", 22),
  dealMqlProperty: str("HUBSPOT_DEAL_MQL_PROPERTY", "hs_v2_date_entered_144930627"),
  dealSqlProperty: str("HUBSPOT_DEAL_SQL_PROPERTY", "became_qualified_to_buy__sales_pipeline_"),
  staleAfterHours: num("STALE_AFTER_HOURS", 5),
  /** The web service runs the HubSpot sync itself every N minutes (0 = off, e.g. when a separate cron worker exists). */
  syncIntervalMinutes: num("SYNC_INTERVAL_MINUTES", 120),
  // Roundtable Google Sheet (read-only). The key is only ever read on the server.
  get googleServiceAccountJson() { return process.env.GOOGLE_SERVICE_ACCOUNT_JSON || ""; },
  roundtableSheetId: str("ROUNDTABLE_SHEET_ID", "1Cpf0eLWVt37ic4Qa2jC5CdG5J2g-4QCcgvUEtmBQId4"),
  virtualEventsSheetId: str("VIRTUAL_EVENTS_SHEET_ID", "13HuxacNKddnGwAeGtLUj0b5Ppph2o4C8MkECrifVIXU"),
  rulesJson: process.env.RULES_JSON || "",
  timezone: str("REPORTING_TIMEZONE", "America/New_York"),
  logLevel: str("LOG_LEVEL", "info"),
};

/** "Today" for business rules, in the reporting timezone (YYYY-MM-DD). */
export function today(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: env.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return parts; // en-CA formats as YYYY-MM-DD
}
