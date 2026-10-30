-- Event Command Center – initial schema.
-- Every HubSpot record is keyed by its HubSpot id, so repeated syncs upsert instead of duplicating.

CREATE TABLE IF NOT EXISTS owners (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  email       text,
  active      boolean NOT NULL DEFAULT true,
  synced_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS companies (
  id                 text PRIMARY KEY,
  name               text,
  domain             text,
  country            text,
  sdr_owner_id       text,          -- "SDR Owner (Company)" – SDR source of truth
  allocation_date    date,
  allocation_source  text,          -- 'property' | 'history'
  unassignment_date  date,
  icp_tier           text,
  competitor_flag    text,
  temperature_raw    text,          -- "Event Leads - Cold/Warm/Surging/Hot"
  lifecycle_stage    text,
  hubspot_owner_id   text,          -- company owner (usually an AE) – stored for reference, never used as SDR
  sdr_team           text,
  sdr_history        jsonb,
  synced_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contacts (
  id                    text PRIMARY KEY,
  first_name            text,
  last_name             text,
  email                 text,
  job_title             text,
  country               text,
  company_id            text,
  lifecycle_stage       text,
  lead_status           text,
  do_not_contact        boolean NOT NULL DEFAULT false,
  attended_date         date,
  hubspot_owner_id      text,       -- contact owner – reference only
  contact_sdr_owner_id  text,       -- "SDR owner (Contact)" – reference only, used for mismatch checks
  synced_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contacts_company_idx ON contacts (company_id);

CREATE TABLE IF NOT EXISTS events (
  id               text PRIMARY KEY,
  name             text NOT NULL,
  event_date       date,
  event_type       text,
  category         text NOT NULL,
  category_source  text,
  synced_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS event_contacts (
  event_id       text NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  contact_id     text NOT NULL,
  attended_at    date,             -- captured while "Event Attended Date" matched this event; never cleared by later events
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, contact_id)
);
CREATE INDEX IF NOT EXISTS event_contacts_contact_idx ON event_contacts (contact_id);

CREATE TABLE IF NOT EXISTS activities (
  id           text PRIMARY KEY,   -- "<objectType>:<hubspot id>"
  object_type  text NOT NULL,
  hs_id        text NOT NULL,
  kind         text NOT NULL,
  ts           timestamptz NOT NULL,
  owner_id     text,
  direction    text,
  channel      text,
  status       text,
  title        text,
  synced_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activities_ts_idx ON activities (ts);

CREATE TABLE IF NOT EXISTS activity_contacts (
  activity_id  text NOT NULL REFERENCES activities (id) ON DELETE CASCADE,
  contact_id   text NOT NULL,
  PRIMARY KEY (activity_id, contact_id)
);
CREATE INDEX IF NOT EXISTS activity_contacts_contact_idx ON activity_contacts (contact_id);

CREATE TABLE IF NOT EXISTS activity_companies (
  activity_id  text NOT NULL REFERENCES activities (id) ON DELETE CASCADE,
  company_id   text NOT NULL,
  PRIMARY KEY (activity_id, company_id)
);
CREATE INDEX IF NOT EXISTS activity_companies_company_idx ON activity_companies (company_id);

CREATE TABLE IF NOT EXISTS tasks (
  id         text PRIMARY KEY,
  due_at     timestamptz,
  status     text,
  task_type  text,
  owner_id   text,
  subject    text,
  synced_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS task_contacts (
  task_id     text NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  contact_id  text NOT NULL,
  PRIMARY KEY (task_id, contact_id)
);
CREATE INDEX IF NOT EXISTS task_contacts_contact_idx ON task_contacts (contact_id);

CREATE TABLE IF NOT EXISTS deals (
  id           text PRIMARY KEY,
  name         text,
  stage        text,
  stage_label  text,
  is_closed    boolean NOT NULL DEFAULT false,
  is_won       boolean NOT NULL DEFAULT false,
  owner_id     text,
  amount       numeric,
  created_at   timestamptz,
  mql_date     date,
  sql_date     date,
  synced_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS deal_contacts (
  deal_id     text NOT NULL REFERENCES deals (id) ON DELETE CASCADE,
  contact_id  text NOT NULL,
  PRIMARY KEY (deal_id, contact_id)
);
CREATE INDEX IF NOT EXISTS deal_contacts_contact_idx ON deal_contacts (contact_id);
CREATE TABLE IF NOT EXISTS deal_companies (
  deal_id     text NOT NULL REFERENCES deals (id) ON DELETE CASCADE,
  company_id  text NOT NULL,
  PRIMARY KEY (deal_id, company_id)
);
CREATE INDEX IF NOT EXISTS deal_companies_company_idx ON deal_companies (company_id);

-- Computed reporting records. Replaced atomically at the end of every successful sync,
-- so the dashboard keeps showing the last good snapshot if a refresh fails.
CREATE TABLE IF NOT EXISTS lead_facts (
  event_id      text NOT NULL,
  contact_id    text NOT NULL,
  sdr_owner_id  text,
  sdr_region    text,
  event_date    date,
  temperature   text,
  eligible      boolean NOT NULL,
  status        text NOT NULL,
  data          jsonb NOT NULL,
  PRIMARY KEY (event_id, contact_id)
);

CREATE TABLE IF NOT EXISTS facts_meta (
  id           integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  computed_at  timestamptz NOT NULL,
  run_id       bigint,
  lead_count   integer NOT NULL,
  as_of_date   date NOT NULL,
  rules        jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id               bigserial PRIMARY KEY,
  trigger          text NOT NULL,         -- 'cron' | 'manual' | 'startup'
  mode             text,                  -- 'incremental' | 'full'
  status           text NOT NULL,         -- 'running' | 'success' | 'failed' | 'skipped'
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  duration_ms      integer,
  records          jsonb NOT NULL DEFAULT '{}'::jsonb,
  requests         integer NOT NULL DEFAULT 0,
  failed_requests  integer NOT NULL DEFAULT 0,
  warnings         jsonb NOT NULL DEFAULT '[]'::jsonb,
  error            text
);
CREATE INDEX IF NOT EXISTS sync_runs_started_idx ON sync_runs (started_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
