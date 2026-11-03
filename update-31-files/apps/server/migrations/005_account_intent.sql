-- Company-level account intent (HubSpot "Account Intent Level" + stage-entry dates + latest signal reason). Additive only.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS intent jsonb;
