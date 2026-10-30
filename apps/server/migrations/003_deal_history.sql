-- Deal history for the follow-up views. Additive only: new nullable columns, no data rewritten.
ALTER TABLE deals ADD COLUMN IF NOT EXISTS pipeline text;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS pipeline_label text;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS close_date timestamptz;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS is_closed_lost boolean;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS closed_lost_at timestamptz;     -- when the deal entered its closed-lost stage (stage history)
ALTER TABLE deals ADD COLUMN IF NOT EXISTS previous_stage_label text;      -- stage held immediately before closed lost (stage history)
ALTER TABLE deals ADD COLUMN IF NOT EXISTS lost_reason text;               -- HubSpot "Closed Lost Reason custom" (closed_lost_reason_)
ALTER TABLE deals ADD COLUMN IF NOT EXISTS lost_sub_reason text;           -- HubSpot "Closed Lost Sub-Reason"
ALTER TABLE deals ADD COLUMN IF NOT EXISTS lost_comment text;              -- HubSpot "Closed Lost Comment" (closed_lost_reason)
ALTER TABLE deals ADD COLUMN IF NOT EXISTS stage_history jsonb;            -- [{stage, label, at}] oldest first
