import { addDays, computeLeadFacts, isRosterSdr, normalizeCompanyName, type Rules } from "@ecc/core";
import { env, today } from "../env.js";
import { errMessage, log } from "../log.js";
import { getPool, tx } from "../db/pool.js";
import { existingIds, loadDataset, replaceLeadFacts, replaceLinks, upsert } from "../db/repo.js";
import { HubSpotClient } from "../hubspot/client.js";
import {
  ACTIVITY_PROPERTIES, ACTIVITY_TYPES, COMPANY_PROPERTIES, CONTACT_PROPERTIES, DEAL_PROPERTIES_BASE,
  attendedForEvent, stageInfoFromPipelines, mapActivity, mapCompany, mapContact, COMPANY_LABELLED, type LabelMaps, mapDeal, mapEvent, mapOwner, mapTask, type ActivityRow, type ActivityType,
} from "../hubspot/mappers.js";
import { loadRules } from "../rules.js";
import { getSetting, setSetting } from "../db/repo.js";
import { readAllTabs } from "../sheets/google.js";
import { applySheet, parseTab, type SheetMerge, type SheetTab } from "../sheets/roundtables.js";

const SYNC_LOCK = 778_001;

export type Trigger = "cron" | "manual" | "startup" | "cli";
export interface SyncResult { runId: number | null; status: "success" | "failed" | "skipped"; mode?: string; error?: string; records?: Record<string, number>; warnings?: string[] }

/**
 * One complete HubSpot → Postgres synchronisation followed by a recomputation of lead facts.
 * A Postgres advisory lock guarantees that two syncs (cron + manual) never overlap.
 * Facts are swapped in one transaction at the end, so a failed sync never leaves partial numbers on screen.
 */
export async function runSync(trigger: Trigger, opts: { forceFull?: boolean } = {}): Promise<SyncResult> {
  const pool = getPool();
  const lockClient = await pool.connect();
  lockClient.on("error", (e: Error) => log.error("sync lock connection lost", { error: e.message }));
  let runId: number | null = null;
  try {
    const got = (await lockClient.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [SYNC_LOCK])).rows[0]?.ok;
    if (!got) {
      const r = await pool.query<{ id: number }>(
        "INSERT INTO sync_runs (trigger, status, finished_at, duration_ms, error) VALUES ($1, 'skipped', now(), 0, 'Another sync was already running') RETURNING id", [trigger]);
      log.warn("sync skipped: another sync holds the lock", { trigger });
      return { runId: r.rows[0]?.id ?? null, status: "skipped" };
    }

    // We hold the lock, so any run still marked "running" was interrupted (service restart, database restart).
    await pool.query("UPDATE sync_runs SET status = 'failed', finished_at = now(), error = 'Interrupted (service or database restarted)' WHERE status = 'running'");

    const lastFull = (await pool.query<{ started_at: Date }>(
      "SELECT started_at FROM sync_runs WHERE mode = 'full' AND status = 'success' ORDER BY started_at DESC LIMIT 1")).rows[0]?.started_at;
    const full = !!opts.forceFull || !lastFull || Date.now() - new Date(lastFull).getTime() > env.fullSyncIntervalHours * 3_600_000;
    const mode = full ? "full" : "incremental";
    runId = (await pool.query<{ id: number }>("INSERT INTO sync_runs (trigger, mode, status) VALUES ($1, $2, 'running') RETURNING id", [trigger, mode])).rows[0]!.id;
    const started = Date.now();
    log.info("sync started", { runId, trigger, mode });

    const hs = new HubSpotClient(env.hubspotToken);
    const warnings: string[] = [];
    const records: Record<string, number> = {};
    try {
      const rules = await loadRules();
      await syncAll(hs, rules, full, records, warnings);
      const asOf = today();
      const ds = await loadDataset();
      const facts = computeLeadFacts(ds, rules, asOf);
      records.lead_facts = facts.length;
      await tx((c) => replaceLeadFacts(c, facts, runId, asOf, rules));
      await pool.query(
        `UPDATE sync_runs SET status='success', finished_at=now(), duration_ms=$2, records=$3::jsonb, requests=$4, failed_requests=$5, warnings=$6::jsonb WHERE id=$1`,
        [runId, Date.now() - started, JSON.stringify(records), hs.stats.requests, hs.stats.failed, JSON.stringify(warnings)],
      );
      log.info("sync finished", { runId, mode, durationMs: Date.now() - started, records, requests: hs.stats.requests, retries: hs.stats.retries, warnings: warnings.length });
      return { runId, status: "success", mode, records, warnings };
    } catch (e) {
      const msg = errMessage(e);
      await pool.query(
        `UPDATE sync_runs SET status='failed', finished_at=now(), duration_ms=$2, records=$3::jsonb, requests=$4, failed_requests=$5, warnings=$6::jsonb, error=$7 WHERE id=$1`,
        [runId, Date.now() - started, JSON.stringify(records), hs.stats.requests, hs.stats.failed, JSON.stringify(warnings), msg],
      ).catch(() => undefined);
      log.error("sync failed – previous dataset kept", { runId, error: msg });
      return { runId, status: "failed", mode, error: msg, records, warnings };
    }
  } finally {
    await lockClient.query("SELECT pg_advisory_unlock($1)", [SYNC_LOCK]).catch(() => undefined);
    lockClient.release();
  }
}

/** Recompute lead facts from what is already stored (used after a rules change; no HubSpot calls). */
export async function recomputeFacts(): Promise<number> {
  const rules = await loadRules();
  const asOf = today();
  const ds = await loadDataset();
  const facts = computeLeadFacts(ds, rules, asOf);
  const last = (await getPool().query<{ id: number }>("SELECT id FROM sync_runs WHERE status='success' ORDER BY started_at DESC LIMIT 1")).rows[0]?.id ?? null;
  await tx((c) => replaceLeadFacts(c, facts, last, asOf, rules));
  return facts.length;
}

async function syncAll(hs: HubSpotClient, rules: Rules, full: boolean, records: Record<string, number>, warnings: string[]) {
  const db = getPool();
  const asOf = today();

  // 1. Owners (names for display; roster membership is fixed in code)
  const owners = (await hs.listOwners()).map(mapOwner);
  records.owners = await upsert(db, "owners", ["id text", "name text", "email text", "active boolean"], owners as any, ["id"]);

  // 2. Events in the reporting window (plus recently created events with no date, for data-quality visibility)
  const from = addDays(asOf, -env.eventLookbackDays);
  const to = addDays(asOf, env.eventLookaheadDays);
  const ms = (day: string) => String(Date.parse(`${day}T00:00:00Z`));
  const evProps = { name: env.eventNameProperty, date: env.eventDateProperty, type: env.eventTypeProperty };
  const rawEvents = await hs.searchAll(env.eventObjectType, {
    filterGroups: [
      { filters: [{ propertyName: evProps.date, operator: "BETWEEN", value: ms(from), highValue: ms(to) }] },
      { filters: [{ propertyName: evProps.date, operator: "NOT_HAS_PROPERTY" }, { propertyName: "hs_createdate", operator: "GTE", value: ms(addDays(asOf, -120)) }] },
    ],
    properties: [evProps.name, evProps.date, evProps.type],
  });
  const events = rawEvents.map((r) => mapEvent(r, evProps, rules));
  records.events = await upsert(db, "events", ["id text", "name text", "event_date date", "event_type text", "category text", "category_source text"], events as any, ["id"]);
  const unc = events.filter((e) => e.category === "uncategorized");
  if (unc.length) warnings.push(`${unc.length} event(s) could not be categorised: ${unc.slice(0, 5).map((e) => e.name).join("; ")}`);

  // 3. Event registrants (event → contact associations)
  const eventContacts = new Map<string, string[]>();
  for (const e of events) eventContacts.set(e.id, await hs.associationsOf(env.eventObjectType, e.id, "contacts"));

  // 3b. Roundtable Google Sheet: registrations and attendance (source of truth for matched roundtables)
  const sheetInfo = await roundtableSheet(hs, rules, events, eventContacts, records, warnings);

  const contactIds = [...new Set([...eventContacts.values()].flat())];
  records.registrations = [...eventContacts.values()].reduce((a, l) => a + l.length, 0);

  // 4. Contacts
  const contacts = (await hs.batchRead("contacts", contactIds, CONTACT_PROPERTIES)).map(mapContact);
  // Company join uses HubSpot ASSOCIATIONS, never a name match. The primary company (associatedcompanyid) is used when
  // set; a contact with no primary but exactly one associated company uses that one; all associations are stored.
  const contactCompanies = contactIds.length ? await hs.associations("contacts", "companies", contactIds) : new Map<string, string[]>();
  let multiCompany = 0;
  for (const c of contacts) {
    const assoc = contactCompanies.get(c.id) ?? [];
    c.company_ids = assoc;
    if (!c.company_id && assoc.length === 1) c.company_id = assoc[0]!;
    if (assoc.length > 1) multiCompany++;
  }
  if (multiCompany) warnings.push(`${multiCompany} contact(s) are associated with more than one company; the primary company is used`);
  records.contacts = await upsert(db, "contacts", [
    "id text", "first_name text", "last_name text", "email text", "job_title text", "country text", "company_id text", "lifecycle_stage text",
    "lead_status text", "do_not_contact boolean", "attended_date date", "hubspot_owner_id text", "contact_sdr_owner_id text", "company_ids jsonb", "scores jsonb",
  ], contacts as any, ["id"]);
  const contactById = new Map(contacts.map((c) => [c.id, c]));
  if (contacts.length < contactIds.length) warnings.push(`${contactIds.length - contacts.length} registrant contact(s) could not be read (deleted or merged)`);

  // 5. Event contacts with the attendance snapshot. The attended date survives later overwrites of the single
  //    HubSpot "Event Attended Date" property because an existing in-window value is never replaced with null.
  const ecRows: Array<Record<string, unknown>> = [];
  for (const e of events) {
    for (const cid of eventContacts.get(e.id) ?? []) {
      const sheet = sheetInfo.get(e.id);
      ecRows.push({
        event_id: e.id, contact_id: cid, attended_at: attendedForEvent(e.event_date, contactById.get(cid)?.attended_date ?? null, rules),
        sheet_attended: sheet ? sheet.attended.get(cid) ?? null : null,
        source: sheet ? (sheet.fromSheet.has(cid) ? (sheet.fromHubspot.has(cid) ? "both" : "sheet") : "hubspot") : "hubspot",
      });
    }
  }
  await upsert(db, "event_contacts", ["event_id text", "contact_id text", "attended_at date", "sheet_attended boolean", "source text"], ecRows, ["event_id", "contact_id"], {
    touchSyncedAt: false, updateExpr: { attended_at: "COALESCE(event_contacts.attended_at, EXCLUDED.attended_at)", sheet_attended: "EXCLUDED.sheet_attended", source: "EXCLUDED.source" },
  });
  await db.query("UPDATE event_contacts SET last_seen_at = now() WHERE event_id = ANY($1::text[])", [events.map((e) => e.id)]);
  // Registrants removed from an event in HubSpot are removed here too.
  for (const e of events) {
    await db.query("DELETE FROM event_contacts WHERE event_id = $1 AND NOT (contact_id = ANY($2::text[]))", [e.id, eventContacts.get(e.id) ?? []]);
  }

  // 6. Companies (with SDR Owner history for allocation dates)
  const companyIds = [...new Set(contacts.map((c) => c.company_id).filter((x): x is string => !!x))];
  const companies: ReturnType<typeof mapCompany>[] = [];
  const labels: LabelMaps = {};
  for (const name of COMPANY_LABELLED) {
    const def = await hs.property("companies", name).catch(() => null);
    labels[name] = new Map((def?.options ?? []).map((o) => [o.value, o.label]));
  }
  for (let i = 0; i < companyIds.length; i += 50) {
    const batch = await hs.batchRead("companies", companyIds.slice(i, i + 50), COMPANY_PROPERTIES.includes(rules.temperature.property) ? COMPANY_PROPERTIES : [...COMPANY_PROPERTIES, rules.temperature.property], ["sdr_owner"]);
    companies.push(...batch.map((r) => mapCompany(r, rules.temperature.property, labels)));
  }
  // Ownership audit: how many accounts changed Company SDR Owner since the last sync (fresh HubSpot values every run).
  try {
    const prev = await db.query<{ id: string; sdr_owner_id: string | null }>("SELECT id, sdr_owner_id FROM companies WHERE id = ANY($1)", [companies.map((c) => c.id)]);
    const before = new Map(prev.rows.map((r) => [r.id, r.sdr_owner_id]));
    const moved = companies.filter((c) => before.has(c.id) && (before.get(c.id) ?? null) !== (c.sdr_owner_id ?? null));
    if (moved.length) warnings.push(`${moved.length} account(s) changed SDR Owner in HubSpot since the last sync; worklists now follow the new owner`);
  } catch { /* first run */ }
  records.companies = await upsert(db, "companies", [
    "id text", "name text", "domain text", "country text", "sdr_owner_id text", "allocation_date date", "allocation_source text", "unassignment_date date",
    "icp_tier text", "competitor_flag text", "temperature_raw text", "lifecycle_stage text", "hubspot_owner_id text", "sdr_team text", "sdr_history jsonb", "intent jsonb",
  ], companies as any, ["id"]);
  const offRoster = companies.filter((c) => c.sdr_owner_id && !isRosterSdr(c.sdr_owner_id)).length;
  if (offRoster) warnings.push(`${offRoster} compan(ies) have an SDR Owner who is not on the approved roster (shown in Data Quality)`);

  // 7. Activities: contact-level (complete) and company-level (capped)
  const contactLinks: Array<[string, string]> = []; // [activity id, contact id]
  const companyLinks: Array<[string, string]> = []; // [activity id, company id]
  const taskContactLinks: Array<[string, string]> = [];
  let companyLinksComplete = env.companyActivityAssociations;
  // Company-level activity is only needed to spot "outreach logged on the company, not the contact" for leads that
  // can be eligible (roster SDR + Hot/Warm). Reading it for every company is very large and adds nothing to the numbers.
  // Oldest activity that can matter: 365 days before the earliest event in the window (prior-conversation check).
  const activityCutoff = `${addDays(asOf, -(env.eventLookbackDays + 365))}T00:00:00.000Z`;
  const hotWarm = new Set([...rules.temperature.hotValues, ...rules.temperature.warmValues].map((v) => v.toLowerCase()));
  const activityCompanyIds = companies
    .filter((c) => isRosterSdr(c.sdr_owner_id) && !!c.temperature_raw && hotWarm.has(c.temperature_raw.toLowerCase()))
    .map((c) => c.id);
  records.companies_for_activity = activityCompanyIds.length;
  for (const type of ACTIVITY_TYPES) {
    const byContact = await hs.associations("contacts", type, contactIds);
    const ids = new Set<string>();
    for (const [cid, list] of byContact) for (const id of list) { ids.add(id); contactLinks.push([`${type}:${id}`, cid]); if (type === "tasks") taskContactLinks.push([id, cid]); }

    if (env.companyActivityAssociations && activityCompanyIds.length) {
      const byCompany = await hs.associations("companies", type, activityCompanyIds, 2000);
      let added = 0;
      for (const [coid, list] of byCompany) for (const id of list) {
        if (!ids.has(id)) {
          if (added >= env.maxCompanyActivityAssociations) { companyLinksComplete = false; continue; }
          added++; ids.add(id);
        }
        companyLinks.push([`${type}:${id}`, coid]);
      }
    }

    const all = [...ids];
    const prefixed = all.map((id) => `${type}:${id}`);
    const have = full ? new Set<string>() : new Set([...(await existingIds(db, "activities", prefixed)), ...(await existingIds(db, "activity_skips", prefixed))]);
    let toRead = all.filter((id) => !have.has(`${type}:${id}`));
    if (!full && (type === "tasks" || type === "meetings" || type === "calls")) {
      // statuses and outcomes change after creation: re-read open tasks and recent calls/meetings every run
      const r = await db.query<{ hs_id: string }>(
        `SELECT hs_id FROM activities WHERE object_type = $1 AND id = ANY($2::text[]) AND (status IS DISTINCT FROM 'COMPLETED' OR ts > now() - interval '14 days')`,
        [type, prefixed]);
      toRead = [...new Set([...toRead, ...r.rows.map((x: { hs_id: string }) => x.hs_id)])];
    }
    const raw = await hs.batchRead(type, toRead, ACTIVITY_PROPERTIES[type]);
    const mapped = raw.map((r) => mapActivity(type as ActivityType, r)).filter((x): x is ActivityRow => !!x);
    // Activities older than the reporting window can never affect a number; only their ids are kept (so they are not
    // re-read every run). This keeps the database small.
    const rows = mapped.filter((a) => a.ts >= activityCutoff);
    const skipped = mapped.filter((a) => a.ts < activityCutoff).map((a) => ({ id: a.id }));
    await upsert(db, "activity_skips", ["id text"], skipped, ["id"], { doNothing: true });
    records[`${type}_too_old`] = skipped.length;
    await upsert(db, "activities", ["id text", "object_type text", "hs_id text", "kind text", "ts timestamptz", "owner_id text", "direction text", "channel text", "status text", "title text"], rows as any, ["id"]);
    if (type === "tasks") {
      await upsert(db, "tasks", ["id text", "due_at timestamptz", "status text", "task_type text", "owner_id text", "subject text"], raw.map(mapTask) as any, ["id"]);
    }
    if (full) {
      // records that no longer exist in HubSpot (deleted) are removed during the full reconcile
      const returned = new Set(raw.map((r) => String(r.id)));
      const gone = toRead.filter((id) => !returned.has(id)).map((id) => `${type}:${id}`);
      if (gone.length) await db.query("DELETE FROM activities WHERE id = ANY($1::text[])", [gone]);
    }
    records[`${type}_associated`] = all.length;
    records[`${type}_read`] = raw.length;
    if (type === "communications") {
      const li = rows.filter((r) => r.kind === "LINKEDIN").length;
      records.linkedin_messages_read = li;
      if (!li && full) warnings.push("No LinkedIn communications were found on event contacts. If SDRs log LinkedIn via Sales Navigator or an extension, confirm those records are associated with contacts.");
    }
  }
  // activity ids in links must exist (FK); keep only links whose activity row was stored
  const storedActs = await existingIds(db, "activities", [...new Set([...contactLinks, ...companyLinks].map((l) => l[0]))]);
  await tx(async (c) => {
    await replaceLinks(c, "activity_contacts", "contact_id", "activity_id", contactIds, contactLinks.filter((l) => storedActs.has(l[0])).map(([a, b]) => [b, a]));
    if (companyLinksComplete) {
      await replaceLinks(c, "activity_companies", "company_id", "activity_id", activityCompanyIds, companyLinks.filter((l) => storedActs.has(l[0])).map(([a, b]) => [b, a]));
    } else {
      await upsert(c, "activity_companies", ["activity_id text", "company_id text"], companyLinks.filter((l) => storedActs.has(l[0])).map(([a, b]) => ({ activity_id: a, company_id: b })), ["activity_id", "company_id"], { doNothing: true });
    }
    const storedTasks = await existingIds(c, "tasks", [...new Set(taskContactLinks.map((l) => l[0]))]);
    await replaceLinks(c, "task_contacts", "contact_id", "task_id", contactIds, taskContactLinks.filter((l) => storedTasks.has(l[0])).map(([t, ct]) => [ct, t]));
  });
  if (!companyLinksComplete && env.companyActivityAssociations) {
    warnings.push(`Company-level activity associations were capped at ${env.maxCompanyActivityAssociations} per activity type; "Unable to Verify" may be under-reported.`);
  }
  records.activity_contact_links = contactLinks.length;
  records.activity_company_links = companyLinks.length;

  // 8. Deals associated with event contacts or their companies
  const dealsByContact = await hs.associations("contacts", "deals", contactIds);
  const dealsByCompany = companyIds.length ? await hs.associations("companies", "deals", companyIds) : new Map<string, string[]>();
  const dealIds = [...new Set([...dealsByContact.values(), ...dealsByCompany.values()].flat())];
  const stageLabels = new Map<string, string>();
  const pipelines = await hs.dealPipelines();
  for (const p of pipelines) for (const s of p.stages ?? []) stageLabels.set(s.id, `${s.label} (${p.label})`);
  const stageInfo = stageInfoFromPipelines(pipelines);
  const dealProps = [...new Set([...DEAL_PROPERTIES_BASE, env.dealMqlProperty, env.dealSqlProperty])];
  const deals: ReturnType<typeof mapDeal>[] = [];
  // 50 per request when property history is requested (deal stage history drives the closed-lost details)
  for (let i = 0; i < dealIds.length; i += 50) {
    const batch = await hs.batchRead("deals", dealIds.slice(i, i + 50), dealProps, ["dealstage"]);
    deals.push(...batch.map((r) => mapDeal(r, stageLabels, env.dealMqlProperty, env.dealSqlProperty, stageInfo)));
  }
  records.deals = await upsert(db, "deals", [
    "id text", "name text", "stage text", "stage_label text", "is_closed boolean", "is_won boolean", "owner_id text", "amount numeric",
    "created_at timestamptz", "mql_date date", "sql_date date",
    "pipeline text", "pipeline_label text", "close_date timestamptz", "is_closed_lost boolean", "closed_lost_at timestamptz", "previous_stage_label text",
    "lost_reason text", "lost_sub_reason text", "lost_comment text", "stage_history jsonb",
  ], deals as any, ["id"]);
  records.deals_closed_lost = deals.filter((x) => x.is_closed_lost).length;
  const storedDeals = new Set(deals.map((x) => x.id));
  await tx(async (c) => {
    const dc: Array<[string, string]> = [];
    for (const [cid, list] of dealsByContact) for (const did of list) if (storedDeals.has(did)) dc.push([cid, did]);
    await replaceLinks(c, "deal_contacts", "contact_id", "deal_id", contactIds, dc);
    const dco: Array<[string, string]> = [];
    for (const [coid, list] of dealsByCompany) for (const did of list) if (storedDeals.has(did)) dco.push([coid, did]);
    await replaceLinks(c, "deal_companies", "company_id", "deal_id", companyIds, dco);
  });

  // 9. Recently closed-lost deals on DUPLICATE company records: a company with the same normalised name and the same
  //    SDR owner as a registrant's company (e.g. two HubSpot records for "The Channel Company"). Only those deals and
  //    companies are stored; they feed "Recently closed lost" and deal-history context, never attribution.
  if (rules.recentlyClosedLostDays > 0 && rules.matchDuplicateCompanies) {
    const since = String(Date.parse(`${addDays(asOf, -rules.recentlyClosedLostDays)}T00:00:00Z`));
    const lost = await hs.searchAll("deals", {
      filterGroups: [{ filters: [{ propertyName: "hs_is_closed_lost", operator: "EQ", value: "true" }, { propertyName: "closedate", operator: "GTE", value: since }] }],
      properties: ["dealname"],
    });
    const newLost = lost.map((r) => String(r.id)).filter((id) => !storedDeals.has(id));
    const lostCompanies = newLost.length ? await hs.associations("deals", "companies", newLost) : new Map<string, string[]>();
    const registrantKeys = new Set(companies.filter((c) => c.sdr_owner_id).map((c) => `${normalizeCompanyName(c.name)}|${c.sdr_owner_id}`));
    const known = new Set(companyIds);
    const candidateIds = [...new Set([...lostCompanies.values()].flat())].filter((id) => !known.has(id));
    const candidates = candidateIds.length ? (await hs.batchRead("companies", candidateIds, COMPANY_PROPERTIES.includes(rules.temperature.property) ? COMPANY_PROPERTIES : [...COMPANY_PROPERTIES, rules.temperature.property])).map((r) => mapCompany(r, rules.temperature.property)) : [];
    const dupCompanies = candidates.filter((c) => c.sdr_owner_id && normalizeCompanyName(c.name) && registrantKeys.has(`${normalizeCompanyName(c.name)}|${c.sdr_owner_id}`));
    const dupIds = new Set(dupCompanies.map((c) => c.id));
    const dupDealIds = newLost.filter((id) => (lostCompanies.get(id) ?? []).some((c) => dupIds.has(c)));
    if (dupCompanies.length && dupDealIds.length) {
      await upsert(db, "companies", [
        "id text", "name text", "domain text", "country text", "sdr_owner_id text", "allocation_date date", "allocation_source text", "unassignment_date date",
        "icp_tier text", "competitor_flag text", "temperature_raw text", "lifecycle_stage text", "hubspot_owner_id text", "sdr_team text", "sdr_history jsonb", "intent jsonb",
      ], dupCompanies as any, ["id"]);
      const dupDeals: ReturnType<typeof mapDeal>[] = [];
      for (let i = 0; i < dupDealIds.length; i += 50) {
        const batch = await hs.batchRead("deals", dupDealIds.slice(i, i + 50), dealProps, ["dealstage"]);
        dupDeals.push(...batch.map((r) => mapDeal(r, stageLabels, env.dealMqlProperty, env.dealSqlProperty, stageInfo)));
      }
      await upsert(db, "deals", [
        "id text", "name text", "stage text", "stage_label text", "is_closed boolean", "is_won boolean", "owner_id text", "amount numeric",
        "created_at timestamptz", "mql_date date", "sql_date date",
        "pipeline text", "pipeline_label text", "close_date timestamptz", "is_closed_lost boolean", "closed_lost_at timestamptz", "previous_stage_label text",
        "lost_reason text", "lost_sub_reason text", "lost_comment text", "stage_history jsonb",
      ], dupDeals as any, ["id"]);
      const links: Array<[string, string]> = [];
      for (const did of dupDeals.map((x) => x.id)) for (const coid of lostCompanies.get(did) ?? []) if (dupIds.has(coid)) links.push([coid, did]);
      await tx((c) => replaceLinks(c, "deal_companies", "company_id", "deal_id", [...dupIds], links));
    }
    records.duplicate_company_lost_deals = dupDealIds.length;
    if (dupCompanies.length) warnings.push(`${dupCompanies.length} duplicate company record(s) found with recent closed-lost deals (same name and SDR owner as an event account): ${dupCompanies.slice(0, 5).map((c) => c.name).join("; ")}. Consider merging them in HubSpot.`);
  }
}


/**
 * Read the roundtable sheet, match tabs to HubSpot roundtable events, resolve each row to a HubSpot contact
 * (HS Link id, else exact email lookup), and – when authoritative – replace that event's registrant list.
 * Never fails the sync: if the sheet cannot be read, the last successfully read copy is reused; with no copy,
 * HubSpot registrations are used unchanged.
 */
async function roundtableSheet(
  hs: HubSpotClient, rules: Rules, events: Array<{ id: string; name: string; event_date: string | null; category: string }>,
  eventContacts: Map<string, string[]>, records: Record<string, number>, warnings: string[],
): Promise<Map<string, SheetMerge>> {
  if (!env.googleServiceAccountJson) return new Map();
  const before = new Map([...eventContacts].map(([k, v]) => [k, [...v]]));
  try {
    let tabs: SheetTab[];
    let readError: string | null = null;
    try {
      tabs = (await readAllTabs(env.googleServiceAccountJson, env.roundtableSheetId)).map((t) => parseTab(t.title, t.rows));
      await setSetting("roundtable_sheet_cache", { readAt: new Date().toISOString(), tabs });
    } catch (e) {
      readError = errMessage(e);
      const cache = await getSetting<{ readAt: string; tabs: SheetTab[] }>("roundtable_sheet_cache");
      warnings.push(`Roundtable sheet could not be read (${readError}).${cache ? ` Using the copy read at ${cache.readAt}.` : " HubSpot registrations used instead."}`);
      if (!cache) { await setSetting("roundtable_sheet_report", { readAt: null, error: readError, tabs: [], unmatchedTabs: [] }); return new Map(); }
      tabs = cache.tabs;
    }

    // rows without an HS link -> exact HubSpot contact lookup by email
    const needEmail = [...new Set(tabs.flatMap((t) => t.rows.filter((r) => !r.contactId && r.email).map((r) => r.email!)))];
    const byEmail = new Map<string, string>();
    for (let i = 0; i < needEmail.length; i += 100) {
      const found = await hs.searchAll("contacts", { filterGroups: [{ filters: [{ propertyName: "email", operator: "IN", values: needEmail.slice(i, i + 100) }] }], properties: ["email"] });
      for (const c of found) if (c.properties?.email) byEmail.set(String(c.properties.email).toLowerCase(), String(c.id));
    }

    const r = applySheet(tabs, events, eventContacts, byEmail, rules.roundtableSheet.authoritative);
    records.sheet_tabs_matched = r.report.length;
    records.sheet_rows = r.rows;
    records.sheet_registrants_added = r.added;
    if (r.unmatchedTabs.length) warnings.push(`Roundtable sheet tabs not matched to a HubSpot event: ${r.unmatchedTabs.join("; ")}`);
    const unresolved = r.report.reduce((a: number, t: any) => a + t.unresolved.length, 0);
    if (unresolved) warnings.push(`${unresolved} roundtable sheet row(s) could not be matched to a HubSpot contact (no HS link and email not found)`);
    await setSetting("roundtable_sheet_report", {
      readAt: readError ? null : new Date().toISOString(), error: readError, authoritative: rules.roundtableSheet.authoritative,
      tabs: r.report, unmatchedTabs: r.unmatchedTabs,
    });
    return r.merged;
  } catch (e) {
    // anything unexpected: restore HubSpot registrants and carry on with the sync
    for (const [k, v] of before) eventContacts.set(k, v);
    warnings.push(`Roundtable sheet skipped: ${errMessage(e)}`);
    return new Map();
  }
}
