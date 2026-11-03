-- All company associations of a contact (the primary company stays in company_id). Additive only.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_ids jsonb;
