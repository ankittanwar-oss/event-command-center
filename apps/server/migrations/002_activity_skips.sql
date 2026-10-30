-- Ids of activities older than the reporting window. Kept so incremental syncs do not re-read them every run.
CREATE TABLE IF NOT EXISTS activity_skips (
  id text PRIMARY KEY
);
