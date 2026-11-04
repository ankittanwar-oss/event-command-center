-- Leads hidden from the dashboard by a person (wrong / irrelevant). Dashboard-only; HubSpot is never changed.
CREATE TABLE IF NOT EXISTS redacted_leads (
  contact_id   text PRIMARY KEY,
  contact_name text,
  company_name text,
  events       text,
  reason       text,
  redacted_by  text,
  redacted_at  timestamptz NOT NULL DEFAULT now()
);
