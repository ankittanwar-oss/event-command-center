-- Roundtable Google Sheet: attendance and registration source per (event, contact). Additive only.
ALTER TABLE event_contacts ADD COLUMN IF NOT EXISTS sheet_attended boolean;   -- Yes/No from the sheet; null = not in sheet / blank
ALTER TABLE event_contacts ADD COLUMN IF NOT EXISTS source text;              -- 'hubspot' | 'sheet' | 'both'
