# HubSpot integration audit (30 Oct 2026)

This is what was wrong with the previous dashboard (Claude-session refresh + static HTML), what the new application does instead, and the status of each case that was raised. "Verified" means it was checked against HubSpot records in portal 7712708. "By design + tested" means the logic is covered by unit tests but the new app has not yet been run against live HubSpot.

## Root causes in the previous system

| # | Problem | Effect | Fix in this app |
|---|---------|--------|-----------------|
| 1 | Refresh depended on a Claude desktop session with folder access. The scheduled run failed without it, and `last_success` was empty until 30 Oct. | Activity store was empty or out of date, so worked leads showed as never worked (the Jane Jue case). | A separate Railway cron worker syncs every 2 hours through the HubSpot API. Every run is logged in `sync_runs`, and the UI warns when data is stale. |
| 2 | Extractor parsing bugs: JSON-format results ignored, contact rows misread as meetings, `Label (raw)` enum values, empty result sets causing the previous event's contacts to be tagged. | Missing companies, events and deals. Wrong lifecycle stages. Contacts attached to the wrong event. | Typed mappers over the official REST API (`apps/server/src/hubspot/mappers.ts`), with unit tests. |
| 3 | Deals were pulled once and never refreshed. | New MQLs (RT7: Menlo Security, JLL India) were missing. | Deals associated with event contacts and their companies are re-read on every sync. |
| 4 | LinkedIn activity was never read. The MCP connector blocks the `COMMUNICATION` object. | LinkedIn touches were invisible, so leads were under-counted. | The sync reads `communications` (channel `LINKEDIN_MESSAGE`) and completed LinkedIn tasks. **Not yet verified against live data.** The first full sync reports `linkedin_messages_read`. |
| 5 | Follow-up counted only touches strictly after the event day, because only dates were available. | Same-day follow-up was marked "Unable to verify". | Full timestamps are used. Touches on the event day count (`postEventStartOffsetDays = 0`, configurable). |
| 6 | The HubSpot lead-temperature property was not used. | Hot/Warm was inferred, not taken from the source of truth. | The company property `event_leads___cold_warm_surging_hot` is used. Hot = "Hot", Warm = "Warm". "Surging" is defined but has 0 records; it is not mapped and is flagged as a data issue. |
| 7 | Earlier versions used the contact owner or AE fields as the SDR. | AEs appeared as SDRs, and APAC SDRs appeared under NAM. | The SDR is always the company's **SDR Owner** (`sdr_owner`), and only the 13 approved roster owner IDs count. Region comes from the roster, not from team or owner properties. Anyone else is excluded and listed in Data Quality. |
| 8 | "Event Attended Date" is a single contact field that later events overwrite. | Attendance at earlier events disappeared. | `event_contacts.attended_at` stores a snapshot while the value matches that event (−1/+3 days), and later syncs never clear it. Before the first sync there are no snapshots, so the backfill can only see current values. |
| 9 | Open "Not Qualified" deals and a "Test \| Inbound" deal associated with many contacts. | Leads could be wrongly treated as in play. | `inactiveDealStages` and `ignoredDealNamePattern` rules, with tests. |

## Known cases

| Case | Status | Evidence |
|------|--------|----------|
| Jane Jue (Omnissa, RT7) / Bobbi | **Verified** (30 Oct, read-only queries) | Outbound email from Bobbi Bukovac on 28 Oct. After the fixed refresh the old dashboard showed her as worked. The new calculation layer on the same extracts gives "First Touch Completed", 1 touch, SLA met. Root cause: #1 (refresh never succeeded, so no activities). |
| RT7 MQLs (Menlo Security 60097042359, JLL India 67078189467) | **Verified** | Both are attributed to RT7 (event 65050806052) after the deal re-pull (#3). |
| RT6 | Partially verified | After the full refresh the old dashboard showed 28 of 35 followed up. The new app uses stricter rules (company SDR, roster, contact-level touches, Hot/Warm property), so its numbers will differ. Confirm after the first live sync with the RT6 event filter and the lead audit drawer. |
| Danielle's RT1 | Not verified | The registrant extract for RT1 (59457298588) is empty, so it can't be checked offline. Check after the first live sync. |
| Beacon Experience Boston | Not verified in the new app | The old dashboard (after refresh) showed N 52 / F 36 / U 28. Check after the first live sync. Each lead's audit drawer shows every activity and why it did or did not count. |
| AEs appearing as SDRs | **By design + tested** | `core.test.ts` → "an AE in the SDR Owner field is not reported as an SDR". |
| APAC SDRs under NAM | **By design + tested** | `core.test.ts` → region-filtering tests. A region filter clears an SDR from another region. |
| LinkedIn activity | **Not verified** | See #4. If SDRs log LinkedIn through a tool that creates notes or tasks instead of communications, those won't count. Check the first sync's `linkedin_messages_read` and some known LinkedIn touches. |

## How to verify a case after deployment

1. Go to **Admin → Contact lookup** and enter the email address.
2. Open the lead. The audit drawer lists every stored activity (contact-level and company-level). Each one shows whether it counted and why not: wrong owner, inbound, before the eligibility date, or logged on the company only.
3. Compare with the HubSpot record using the "Open in HubSpot" link.
