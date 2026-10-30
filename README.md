# Events Command Center

Event follow-up reporting for SpotDraft. A worker syncs HubSpot into Postgres every 2 hours, and a web app shows:

- **CMO overview**: Hot/Warm columns, an event-category table, an SDR summary and the quarter comparison.
- **SDR execution**: an SDR table, plus an account-first queue with expandable contacts and HubSpot links.
- **Event operations**: pre-event and post-event views for Owned, Sponsored, Webinars and Roundtables.
- **Event performance**: quarter over quarter, by category and by SDR.
- **Data quality**.
- **Admin**: sync history, manual refresh, business rules and contact lookup.

Every number is clickable and opens the exact records behind it. Each lead has an audit view showing every HubSpot activity and whether it counted as a touch.

- [Architecture](#architecture)
- [Metric definitions](#metric-definitions)
- [Business rules and assumptions](#business-rules-and-assumptions)
- [HubSpot private app](#1-create-the-hubspot-private-app-read-only)
- [Deploy: GitHub → Railway](#deploy-github--railway)
- [Verify after deploy](#verify-after-deploy)
- [Operations and troubleshooting](#operations-and-troubleshooting)
- [Local development](#local-development)
- [What was and was not tested](#what-was-and-was-not-tested)
- [docs/AUDIT.md](docs/AUDIT.md): root causes of the old dashboard's errors and the status of each known case

---

## Architecture

```
                ┌────────────────────────── one GitHub repo, one Docker image ──────────────────────────┐
HubSpot API ──► │ sync-worker (Railway cron, every 2 h)                                                 │
 (read-only)    │   node apps/server/dist/worker.js --cron                                              │
                │   migrate → advisory lock → sync owners, events, registrants, contacts, companies,    │
                │   activities, tasks, deals → compute lead_facts → swap in one transaction → exit      │
                │                                   │                                                   │
                │                              PostgreSQL                                               │
                │                                   │                                                   │
Browser ◄────── │ web (Railway service)  node apps/server/dist/index.js                                 │
 (no HubSpot    │   /api/* JSON (aggregates from lead_facts with @ecc/core)  +  static frontend         │
  credentials)  │   /api/health for Railway health checks                                               │
                └───────────────────────────────────────────────────────────────────────────────────────┘
```

| Path | What |
|------|------|
| `packages/core` | Pure TypeScript calculation layer: eligibility, touch detection, statuses, SLA, cadence, filters, aggregation and fiscal quarters. No I/O, fully unit-tested. The worker computes with it, and the API aggregates with the same functions, so a KPI and its drilldown always use the same predicate. |
| `apps/server` | Node 22 + TypeScript. `src/index.ts` is the web service. `src/worker.ts` is the sync worker. `src/hubspot/*` is the read-only client and mappers. `src/sync/sync.ts` is the sync. `src/api/*` is the HTTP API. `migrations/*.sql` is the schema. |
| `apps/web` | Frontend in TypeScript, bundled with esbuild. |
| `scripts/` | Build scripts, plus `validate-extracts.ts`, an offline cross-check against the old dashboard's JSON extracts. |
| `railway/` | Railway config-as-code for the two services. |

**Why no React or Express.** The app was built where the npm registry was not reachable. To make sure every part shipped had actually been compiled and tested, it uses only Node built-ins, `pg` and build-time tools (TypeScript, esbuild, tsx). The frontend is a small typed DOM layer (`apps/web/src/ui.ts`) in the same style a React app would use (pure views over JSON from the API). Moving it to React later is straightforward because all business logic lives in `@ecc/core` and the API, not the UI.

**Data safety**

- The HubSpot client refuses any POST that is not a search or a batch read, and has no create, update or delete methods.
- The HubSpot token is only read on the server, from environment variables.
- Lead facts are replaced in one transaction at the end of a successful sync. A failed sync leaves the last good numbers on screen, with a warning.
- A Postgres advisory lock prevents the cron sync and a manual refresh from overlapping.

---

## Metric definitions

**Eligible lead**: one row per (event, registrant contact) where all of the following hold:

- The event date has passed.
- The contact has a company.
- The company is not a direct competitor and not a customer.
- The contact is not do-not-contact.
- Company lead temperature is **Hot** or **Warm**.
- ICP tier is targetable or workable.
- The company's **SDR Owner** is on the approved roster.
- For **sponsored** events, the contact attended, or already had a conversation with us (a meeting or reply in the prior 12 months, or a deal that already existed).

**Eligibility date** = the later of the event date and the company's allocation date. All touch windows, SLA and ageing start here.

**Qualifying touch** = an activity logged on the **contact** by a roster SDR, of one of these kinds:

- An outbound sales email.
- A logged call that is not inbound, queued or cancelled.
- A LinkedIn message (communication).
- A **completed** LinkedIn task.

These never count:

- Inbound emails, opens, clicks or marketing emails.
- Meetings (they are outcomes, not touches).
- Open tasks.
- Duplicates: the same record, or the same kind, owner and minute.

Activity logged only on the company is shown separately and makes the lead "Unable to verify".

| Status | Rule (first match wins) |
|--------|-------------------------|
| Completed / In Play | Open opportunity (excluding inactive stages), a meeting or a prospect reply since eligibility, or the lead was disqualified. |
| Unable to Verify | Event date unknown, or outreach was logged on the company but not on this contact. |
| Never Worked | No qualifying touch since eligibility. |
| Follow-Up Stalled | No touch for more than the stall threshold (business days; Hot 7, Warm 10). |
| Actively Worked | At least 2 touches, at or above the expected cadence for the lead's age, and spread over 2 or more ISO weeks once the lead is 14 or more days old. |
| First Touch Completed | Everything else that has at least one touch. |

**Coverage, depth and consistency are reported separately and never combined into one score.**

- **Coverage**: share of eligible leads with at least one touch.
- **SLA**: business days from eligibility to the first touch (Hot 3, Warm 3).
- **Depth**: average and median touches, the touch distribution (1 / 2–3 / 4–7 / 8+), and *average touches in the first 30 days*. The 30-day average uses only leads eligible for 30 days or more, so recent leads don't distort it (age-normalised).
- **Consistency**: share of leads 14 or more days old touched in 2 or more distinct weeks, days since the last touch, and whether a next step is scheduled.

**Fiscal calendar**: the fiscal year starts on 1 May.

| Quarter | Months |
|---------|--------|
| Q1 MJJ | May–Jul |
| Q2 ASO | Aug–Oct |
| Q3 NDJ | Nov–Jan |
| Q4 FMA | Feb–Apr |

Keys look like `FY2027-Q2`. The fiscal year is named after the year it ends in; every label also shows the month range.

**Filters** (quarter, region, SDR, category, temperature, event and search) are applied to the records before any KPI is calculated. Picking a region clears an SDR who is not in that region.

---

## Business rules and assumptions

The defaults are in `packages/core/src/config.ts` (`DEFAULT_RULES`). They can be changed without a deploy on **Admin → Business rules**, which saves and recomputes from stored data. They can also be changed with the `RULES_JSON` variable. Check these assumptions before relying on the numbers:

| Rule | Default | Note |
|------|---------|------|
| SDR roster | NAM: Bobbi Bukovac, Jody Walker, Jonathan Hurt, Danielle Shannon, Adam Myers, Timothy Pierce · EMEA: Anshu Chaudhary · APAC: Disha Ojha, Manisha Sharma, Natasha Maheshwari, Anil Pillay, Pradyumna Pohekar, Lakshay Bahl | Owner IDs were resolved in HubSpot on 30 Oct 2026. To change the roster, edit `SDR_ROSTER` and deploy. |
| Temperature | Company property `event_leads___cold_warm_surging_hot`: Hot = `Hot`, Warm = `Warm` | Surging is not mapped. |
| First-touch SLA | Hot 3, Warm 3 business days | Weekends are excluded. Add holidays in `businessCalendar.holidays`. |
| Stall threshold | Hot 7, Warm 10 business days | Assumption, please confirm. |
| Expected cadence | 1 touch at day 0, 4 by day 30, 8 by day 56 (linear in between) | Based on the CMO discussion; not a finalised policy. |
| Eligible ICP tiers | Targetable Tier 1A / 1 / 2 / 3, Tier 1, Workable | |
| Sponsored events | Attendance required, unless there was a prior conversation | Attendance window: event date −1 to +3 days. |
| Touches by | Any roster SDR (`countAnyRosterSdrTouch: true`) | Set to `false` to count only the assigned SDR's touches. |
| Deal attribution | MQL date or create date within 90 days after the event | Open deals in Not Qualified, Disqualified, No Show or Closed Lost stages don't count as in play. Deals named `Test…` are ignored. |
| Event categories | Name rules (roundtable → webinar → owned → sponsored), with HubSpot `event_type` taking precedence | Unmatched events are "Uncategorized" and listed in Data Quality. Use `eventCategoryOverrides` (`{"<eventId>": "owned"}`) to fix any. |
| Dates | "Today" uses `REPORTING_TIMEZONE` (America/New_York). Activity days use UTC. | A touch logged late in the US evening can fall on the next UTC day. |

---

## Deploy: GitHub → Railway

You need: a GitHub account, a Railway account, and HubSpot super-admin access (to create a private app).

### 1. Create the HubSpot private app (read-only)

In HubSpot, go to **Settings → Integrations → Private Apps → Create a private app**, name it "Events Command Center", and add **only these read scopes**:

- `crm.objects.contacts.read`: contacts, plus calls, meetings, tasks and communications
- `crm.objects.companies.read`
- `crm.objects.deals.read`: deals and deal pipelines
- `crm.objects.owners.read`
- `crm.objects.custom.read`: the Marketing Events custom object `2-23538230`
- `crm.schemas.custom.read`
- `sales-email-read`: email engagement properties such as direction

Create the app and copy the access token. Treat it like a password.

> If a scope is missing, the first sync fails with a 403. The Admin page's sync history shows HubSpot's message, which names the missing scope.

### 2. Put the code on GitHub

1. Unzip `event-command-center.zip`.
2. Create an empty **private** repository on GitHub (for example `spotdraft/event-command-center`).
3. Push the code:

   ```bash
   cd event-command-center
   npm install              # creates package-lock.json – commit it
   npm test && npm run build
   git init && git add . && git commit -m "Events Command Center"
   git branch -M main
   git remote add origin git@github.com:<org>/event-command-center.git
   git push -u origin main
   ```

   Running `npm install` locally is recommended, because it creates the lockfile (the ZIP has none, see below). If you skip it, the Docker build runs `npm install` itself, using the exact versions pinned in `package.json`.

The included GitHub Actions workflow (`.github/workflows/ci.yml`) runs typecheck, tests and build on every push.

### 3. Create the Railway project

1. In Railway, click **New Project → Deploy PostgreSQL** to add a Postgres database.
2. In the same project, click **+ New → GitHub Repo** and pick the repo. Rename this service to **web**.
3. Click **+ New → GitHub Repo** again and pick the same repo. Rename this service to **sync-worker**.

### 4. Configure the **web** service

- **Settings → Config-as-code → Railway config file**: `/railway/web.json`. This uses the Dockerfile, sets the start command `node apps/server/dist/index.js` and the health check `/api/health`.
- **Variables:**

  | Name | Value |
  |------|-------|
  | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (reference variable) |
  | `APP_PASSWORD` | a strong shared password. Viewers log in with any username and this password. |
  | `ADMIN_TOKEN` | a long random string, e.g. `openssl rand -hex 24`. Needed for "Refresh now" and rule changes. |
  | `HUBSPOT_PRIVATE_APP_TOKEN` | the token. Only needed for the manual "Refresh now" button. |

- **Settings → Networking → Generate Domain** to get the public URL.

### 5. Configure the **sync-worker** service

- **Settings → Config-as-code → Railway config file**: `/railway/worker.json`. This uses the same Dockerfile, sets the start command `node apps/server/dist/worker.js --cron`, a cron schedule of `0 */2 * * *` (every 2 hours, UTC) and no restart.
- Check that **Settings → Cron Schedule** shows `0 */2 * * *`.
- Do **not** generate a domain for this service.
- **Variables:**

  | Name | Value |
  |------|-------|
  | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
  | `HUBSPOT_PRIVATE_APP_TOKEN` | the token |

### 6. Deploy and run the first sync

1. Deploy both services. Each one applies the database migrations on start; this is safe to repeat and protected by a lock.
2. Run the first sync **now** instead of waiting for the next cron slot. Either:
   - open the web app, go to **Admin**, enter the `ADMIN_TOKEN` and click **Full reconcile**, or
   - in Railway, open **sync-worker → Deployments → ⋯ → Run now** (if your plan shows it).
3. The first full sync reads every event in the last 400 days and their registrants, companies, activities and deals. Expect several minutes, depending on volume.
4. Watch the progress in **sync-worker → Logs**. Logs are JSON lines; search for `"sync finished"` or `"sync failed"`.

---

## Verify after deploy

1. `https://<web-domain>/api/health` returns `{"ok":true,"db":true,...}`.
2. **Admin → Sync history** shows the run as `success`, with record counts: events, registrations, contacts, companies, `emails_read`, `calls_read`, `communications_read`, `linkedin_messages_read` and deals.
3. **Admin → Stored records** shows non-zero activities and deals. If `linkedin_messages` is 0, see the LinkedIn note in [docs/AUDIT.md](docs/AUDIT.md).
4. **Data quality**: review uncategorized events, SDR owners not on the roster, and missing temperature or ICP.
5. Check the known cases. Use **Admin → Contact lookup** (for example Jane Jue's email), then open the lead and compare its activity list with HubSpot. Then check RT6, RT1 and Beacon Experience Boston with the Event filter. Their numbers are expected to differ from the old dashboard, because the rules are stricter and correct (see AUDIT.md). Use the audit drawer to confirm why each lead counts or does not.
6. Leave it for 2 hours, then confirm a second `cron` run appears in the sync history and the "Synced … ago" badge updates.

---

## Operations and troubleshooting

| Symptom | What to check |
|---------|---------------|
| Red "Data is stale" banner | The last successful sync was more than `STALE_AFTER_HOURS` (5) hours ago. Check sync-worker logs and Admin → Sync history. |
| Sync failed with 401 | The HubSpot token is wrong or was rotated. Update `HUBSPOT_PRIVATE_APP_TOKEN` on both services. |
| Sync failed with 403 | A scope is missing; see step 1. |
| Repeated 429 warnings | Lower `HUBSPOT_MAX_REQUESTS_PER_SECOND` (default 8). |
| "skipped – another sync was already running" | Expected if a manual refresh overlaps the cron run. |
| Web service unhealthy | `/api/health` returns 503 when Postgres is unreachable. Check `DATABASE_URL`. |
| Numbers look wrong for a lead | Open the lead's audit drawer. It shows every activity and the reason it did or did not count. |
| Need to recompute after changing code-level rules | Run `node apps/server/dist/worker.js --recompute` (Railway shell), or save rules on the Admin page. |

**Rotating the token**: create a new token in HubSpot, update the variable on both services, redeploy, then revoke the old token.

**Backups**: enable Railway Postgres backups. All data can also be rebuilt from HubSpot with a full reconcile, except the attendance snapshots, which build up over time.

---

## Local development

```bash
cp .env.example .env            # set DATABASE_URL (local Postgres) and HUBSPOT_PRIVATE_APP_TOKEN
npm install
npm run build
set -a; source .env; set +a
npm run sync:full               # one full sync
npm start                       # http://localhost:3000
npm test                        # unit tests (node:test via tsx)
npm run typecheck
```

Offline cross-check against the old dashboard's extracts (no HubSpot, no database):

```bash
npx tsx scripts/validate-extracts.ts "/path/to/Events Dash Refresh" --assume-temperature Warm --contact "jue"
```

The extracts don't contain the lead-temperature property, so this is only a logic check, not the source of truth.

---

## What was and was not tested

Tested where this was built:

- `npm run typecheck` (TypeScript 7.0.2, strict) passes.
- `npm test`: 62 unit tests pass. They cover SDR mapping, region filtering, event categorisation, attendance, temperature, eligibility, activity detection and de-duplication, contact vs account touches, allocation, the business-day SLA, statuses, age-normalised depth, fiscal quarters, QoQ, KPI/drilldown reconciliation, HubSpot mappers, client retry/paging/read-only guard, and API views.
- `npm run build`: the esbuild bundles for the web and server build.
- `validate-extracts.ts` ran the calculation layer on 5,104 real registrations, 34,353 activities and 33 events from the 30 Oct extracts.

**Not tested here; do these on first deploy:**

- **No live HubSpot sync was run** with the new worker. No private-app token was available, and only the read-only MCP connector was used for the audit. Endpoint shapes follow HubSpot's documented v3/v4 APIs.
- **No real PostgreSQL**: no database was available, so the migrations, upserts and queries have not run against Postgres.
- **The Railway cron schedule has not been exercised.**
- **The UI has not been visually checked in a browser** in this environment. It builds and type-checks; check every page after the first sync.
- **No lockfile is included**: the build environment had no npm registry access. Versions are pinned exactly in `package.json`; run `npm install` once and commit `package-lock.json`.
- **LinkedIn communications have not been checked against live data.**
