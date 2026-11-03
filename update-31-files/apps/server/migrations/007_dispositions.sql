-- Commercial dispositions confirmed in the dashboard (contact or company scope). HubSpot stays read-only.
CREATE TABLE IF NOT EXISTS dispositions (
  scope text NOT NULL CHECK (scope IN ('contact', 'company')),
  hs_id text NOT NULL,
  code text NOT NULL,
  reason text,
  evidence text,
  revisit_date date,
  confirmed_by text NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, hs_id)
);
CREATE TABLE IF NOT EXISTS disposition_log (
  id bigserial PRIMARY KEY, scope text NOT NULL, hs_id text NOT NULL, code text, reason text, evidence text, revisit_date date,
  confirmed_by text, action text NOT NULL, at timestamptz NOT NULL DEFAULT now()
);
