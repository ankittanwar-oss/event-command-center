-- Contact-level engagement signals from HubSpot (read-only copy): Event Attendance Score, Event Registration Score,
-- Contact Engagement Score, HeyReach Intent. Additive only.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS scores jsonb;
