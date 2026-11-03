import { DISPOSITION_CODES, emptyDispositions, type Disposition, type DispositionSet } from "@ecc/core";
import { getPool } from "../db/pool.js";

/** Dashboard-confirmed dispositions (small table, read per request). */
export async function loadDispositions(): Promise<DispositionSet> {
  const set = emptyDispositions();
  try {
    const r = await getPool().query("SELECT * FROM dispositions");
    for (const row of r.rows) {
      const d: Disposition = { scope: row.scope, id: row.hs_id, code: row.code, reason: row.reason, evidence: row.evidence,
        revisitDate: row.revisit_date ? new Date(row.revisit_date).toISOString().slice(0, 10) : null, confirmedBy: row.confirmed_by,
        confirmedAt: row.confirmed_at ? new Date(row.confirmed_at).toISOString() : null, source: "dashboard" };
      (d.scope === "company" ? set.company : set.contact).set(d.id, d);
    }
  } catch { /* table not migrated yet: no dashboard dispositions */ }
  return set;
}

export async function saveDisposition(b: any): Promise<string | null> {
  if (!["contact", "company"].includes(b?.scope)) return "scope must be contact or company";
  if (!b?.id || !/^\d+$/.test(String(b.id))) return "id must be a HubSpot record id";
  if (!(b?.code in DISPOSITION_CODES)) return "unknown disposition code";
  if (!b?.confirmedBy || String(b.confirmedBy).trim().length < 2) return "confirmedBy (your name) is required";
  if (!b?.reason || String(b.reason).trim().length < 3) return "a reason is required";
  if (b.revisitDate && !/^\d{4}-\d{2}-\d{2}$/.test(b.revisitDate)) return "revisitDate must be YYYY-MM-DD";
  const vals = [b.scope, String(b.id), b.code, String(b.reason).slice(0, 500), b.evidence ? String(b.evidence).slice(0, 500) : null, b.revisitDate || null, String(b.confirmedBy).slice(0, 80)];
  await getPool().query(`INSERT INTO dispositions (scope, hs_id, code, reason, evidence, revisit_date, confirmed_by, confirmed_at) VALUES ($1,$2,$3,$4,$5,$6,$7, now())
    ON CONFLICT (scope, hs_id) DO UPDATE SET code = EXCLUDED.code, reason = EXCLUDED.reason, evidence = EXCLUDED.evidence, revisit_date = EXCLUDED.revisit_date, confirmed_by = EXCLUDED.confirmed_by, confirmed_at = now()`, vals);
  await getPool().query("INSERT INTO disposition_log (scope, hs_id, code, reason, evidence, revisit_date, confirmed_by, action) VALUES ($1,$2,$3,$4,$5,$6,$7,'set')", vals);
  return null;
}

export async function clearDisposition(scope: string, id: string, by: string) {
  await getPool().query("DELETE FROM dispositions WHERE scope = $1 AND hs_id = $2", [scope, id]);
  await getPool().query("INSERT INTO disposition_log (scope, hs_id, confirmed_by, action) VALUES ($1,$2,$3,'cleared')", [scope, id, by]);
}
