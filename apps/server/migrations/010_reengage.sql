-- SDR-chosen re-engage dates per account (dashboard-only; HubSpot is never changed).
CREATE TABLE IF NOT EXISTS reengage (
  account_key  text PRIMARY KEY,   -- HubSpot company id, or "contact:<id>" when there is no company
  reengage_on  date NOT NULL,
  set_by       text,
  set_at       timestamptz NOT NULL DEFAULT now()
);
