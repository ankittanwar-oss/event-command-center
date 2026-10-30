import type { PoolClient } from "pg";
import type { Activity, Company, Contact, Dataset, Deal, EventContact, EventRecord, LeadFact, Rules, Task } from "@ecc/core";
import { getPool } from "./pool.js";

type Q = Pick<PoolClient, "query">;

/**
 * Bulk upsert via jsonb_to_recordset: one round trip per 1,000 rows, parameterised (no string-built values).
 * `columns` are "name type" pairs; the first `conflict` columns form the key.
 */
export async function upsert(
  db: Q, table: string, columns: string[], rows: Array<Record<string, unknown>>, conflict: string[], opts: { touchSyncedAt?: boolean; doNothing?: boolean; updateExpr?: Record<string, string> } = {},
): Promise<number> {
  if (!rows.length) return 0;
  const names = columns.map((c) => c.split(" ")[0]!);
  const update = names.filter((n) => !conflict.includes(n));
  const set = update.map((n) => `${n} = ${opts.updateExpr?.[n] ?? `EXCLUDED.${n}`}`);
  if (opts.touchSyncedAt !== false && !opts.doNothing) set.push("synced_at = now()");
  // Only rewrite rows whose values changed: unchanged rows produce no dead tuples and no WAL.
  const changed = update.length ? ` WHERE (${update.map((n) => `${table}.${n}`).join(", ")}) IS DISTINCT FROM (${update.map((n) => `EXCLUDED.${n}`).join(", ")})` : "";
  const onConflict = opts.doNothing || !set.length ? "DO NOTHING" : `DO UPDATE SET ${set.join(", ")}${opts.updateExpr ? "" : changed}`;
  let n = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const sql = `INSERT INTO ${table} (${names.join(", ")})
      SELECT ${names.join(", ")} FROM jsonb_to_recordset($1::jsonb) AS x(${columns.join(", ")})
      ON CONFLICT (${conflict.join(", ")}) ${onConflict}`;
    await db.query(sql, [JSON.stringify(chunk)]);
    n += chunk.length;
  }
  return n;
}

/** Replace association rows for a set of "from" ids. */
export async function replaceLinks(db: Q, table: string, fromCol: string, toCol: string, fromIds: string[], links: Array<[string, string]>) {
  for (let i = 0; i < fromIds.length; i += 5000) {
    await db.query(`DELETE FROM ${table} WHERE ${fromCol} = ANY($1::text[])`, [fromIds.slice(i, i + 5000)]);
  }
  const rows = links.map(([a, b]) => ({ [fromCol]: a, [toCol]: b }));
  await upsert(db, table, [`${fromCol} text`, `${toCol} text`], rows, [fromCol, toCol], { doNothing: true });
}

export async function existingIds(db: Q, table: string, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += 10000) {
    const r = await db.query<{ id: string }>(`SELECT id FROM ${table} WHERE id = ANY($1::text[])`, [ids.slice(i, i + 10000)]);
    for (const row of r.rows) out.add(row.id);
  }
  return out;
}

const d = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const ts = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

/** Load everything the calculation layer needs from Postgres into the shapes defined in @ecc/core. */
export async function loadDataset(db: Q = getPool()): Promise<Dataset> {
  const [companies, contacts, events, ecs, acts, actContacts, actCompanies, tasks, taskContacts, deals, dealContacts, dealCompanies] = await Promise.all([
    db.query("SELECT * FROM companies"),
    db.query("SELECT * FROM contacts WHERE id IN (SELECT contact_id FROM event_contacts)"),
    db.query("SELECT * FROM events"),
    db.query("SELECT event_id, contact_id, attended_at FROM event_contacts"),
    db.query("SELECT id, object_type, kind, ts, owner_id, direction, channel, status, title FROM activities"),
    db.query("SELECT activity_id, contact_id FROM activity_contacts"),
    db.query("SELECT activity_id, company_id FROM activity_companies"),
    db.query("SELECT * FROM tasks"),
    db.query("SELECT task_id, contact_id FROM task_contacts"),
    db.query("SELECT * FROM deals"),
    db.query("SELECT deal_id, contact_id FROM deal_contacts"),
    db.query("SELECT deal_id, company_id FROM deal_companies"),
  ]);

  const ds: Dataset = {
    companies: new Map(), contacts: new Map(), events: new Map(), eventContacts: [],
    activitiesByContact: new Map(), activitiesByCompany: new Map(), tasksByContact: new Map(), dealsByContact: new Map(), dealsByCompany: new Map(),
  };
  for (const r of companies.rows) {
    const c: Company = {
      id: r.id, name: r.name, domain: r.domain, country: r.country, sdrOwnerId: r.sdr_owner_id, allocationDate: d(r.allocation_date),
      allocationSource: r.allocation_source, unassignmentDate: d(r.unassignment_date), icpTier: r.icp_tier, competitorFlag: r.competitor_flag,
      temperatureRaw: r.temperature_raw, lifecycleStage: r.lifecycle_stage,
    };
    ds.companies.set(c.id, c);
  }
  for (const r of contacts.rows) {
    const c: Contact = {
      id: r.id, firstName: r.first_name, lastName: r.last_name, email: r.email, jobTitle: r.job_title, country: r.country,
      companyId: r.company_id, lifecycleStage: r.lifecycle_stage, leadStatus: r.lead_status, doNotContact: !!r.do_not_contact,
      attendedDate: d(r.attended_date),
    };
    ds.contacts.set(c.id, c);
  }
  for (const r of events.rows) {
    const e: EventRecord = { id: r.id, name: r.name, date: d(r.event_date), eventType: r.event_type, category: r.category, categorySource: r.category_source ?? "none" };
    ds.events.set(e.id, e);
  }
  ds.eventContacts = ecs.rows.map((r: any): EventContact => ({ eventId: r.event_id, contactId: r.contact_id, attendedAt: d(r.attended_at) }));

  const actById = new Map<string, Activity>();
  for (const r of acts.rows) {
    actById.set(r.id, {
      id: r.id, kind: r.kind, objectType: r.object_type, timestamp: ts(r.ts)!, ownerId: r.owner_id, direction: r.direction,
      channel: r.channel, status: r.status, title: r.title, contactIds: [], companyIds: [],
    });
  }
  for (const r of actContacts.rows) {
    const a = actById.get(r.activity_id);
    if (!a) continue;
    a.contactIds.push(r.contact_id);
    push(ds.activitiesByContact, r.contact_id, a);
  }
  for (const r of actCompanies.rows) {
    const a = actById.get(r.activity_id);
    if (!a) continue;
    a.companyIds.push(r.company_id);
    push(ds.activitiesByCompany, r.company_id, a);
  }
  for (const list of ds.activitiesByContact.values()) list.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  for (const list of ds.activitiesByCompany.values()) list.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const taskById = new Map<string, Task>();
  for (const r of tasks.rows) taskById.set(r.id, { id: r.id, dueDate: ts(r.due_at), status: r.status, taskType: r.task_type, ownerId: r.owner_id, subject: r.subject, contactIds: [] });
  for (const r of taskContacts.rows) {
    const t = taskById.get(r.task_id);
    if (!t) continue;
    t.contactIds.push(r.contact_id);
    push(ds.tasksByContact, r.contact_id, t);
  }

  const dealById = new Map<string, Deal>();
  for (const r of deals.rows) {
    dealById.set(r.id, {
      id: r.id, name: r.name, stage: r.stage, stageLabel: r.stage_label, isClosed: !!r.is_closed, isWon: !!r.is_won, ownerId: r.owner_id,
      amount: r.amount == null ? null : Number(r.amount), createdAt: ts(r.created_at), mqlDate: d(r.mql_date), sqlDate: d(r.sql_date), contactIds: [], companyIds: [],
      pipelineLabel: r.pipeline_label ?? null, closeDate: ts(r.close_date), isClosedLost: r.is_closed_lost ?? null, closedLostAt: ts(r.closed_lost_at),
      previousStageLabel: r.previous_stage_label ?? null, lostReason: r.lost_reason ?? null, lostSubReason: r.lost_sub_reason ?? null, lostComment: r.lost_comment ?? null,
    });
  }
  for (const r of dealContacts.rows) { const x = dealById.get(r.deal_id); if (x) { x.contactIds.push(r.contact_id); push(ds.dealsByContact, r.contact_id, x); } }
  for (const r of dealCompanies.rows) { const x = dealById.get(r.deal_id); if (x) { x.companyIds.push(r.company_id); push(ds.dealsByCompany, r.company_id, x); } }
  return ds;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const list = m.get(k);
  if (list) list.push(v); else m.set(k, [v]);
}

/** Atomically replace the computed lead facts. On failure the previous snapshot stays in place. */
export async function replaceLeadFacts(client: PoolClient, facts: LeadFact[], runId: number | null, asOf: string, rules: Rules) {
  await client.query("DELETE FROM lead_facts");
  const rows = facts.map((f) => ({
    event_id: f.eventId, contact_id: f.contactId, sdr_owner_id: f.sdrOwnerId, sdr_region: f.sdrRegion, event_date: f.eventDate,
    temperature: f.temperature, eligible: f.eligible, status: f.status, data: f,
  }));
  await upsert(client, "lead_facts",
    ["event_id text", "contact_id text", "sdr_owner_id text", "sdr_region text", "event_date date", "temperature text", "eligible boolean", "status text", "data jsonb"],
    rows, ["event_id", "contact_id"], { touchSyncedAt: false });
  await client.query(
    `INSERT INTO facts_meta (id, computed_at, run_id, lead_count, as_of_date, rules) VALUES (1, now(), $1, $2, $3, $4::jsonb)
     ON CONFLICT (id) DO UPDATE SET computed_at = now(), run_id = EXCLUDED.run_id, lead_count = EXCLUDED.lead_count, as_of_date = EXCLUDED.as_of_date, rules = EXCLUDED.rules`,
    [runId, facts.length, asOf, JSON.stringify(rules)],
  );
}

export async function loadLeadFacts(db: Q = getPool()): Promise<{ facts: LeadFact[]; meta: any | null }> {
  const meta = (await db.query("SELECT * FROM facts_meta WHERE id = 1")).rows[0] ?? null;
  const rows = (await db.query<{ data: LeadFact }>("SELECT data FROM lead_facts")).rows;
  return { facts: rows.map((r) => r.data), meta };
}

export async function getSetting<T>(key: string, db: Q = getPool()): Promise<T | null> {
  const r = await db.query<{ value: T }>("SELECT value FROM settings WHERE key = $1", [key]);
  return r.rows[0]?.value ?? null;
}
export async function setSetting(key: string, value: unknown, db: Q = getPool()) {
  await db.query(
    "INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
    [key, JSON.stringify(value)],
  );
}
