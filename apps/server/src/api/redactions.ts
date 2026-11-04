import { getPool } from "../db/pool.js";
import { getSetting } from "../db/repo.js";

export interface Redaction { contactId: string; contactName: string | null; companyName: string | null; events: string | null; reason: string | null; redactedBy: string | null; redactedAt: string }

export async function loadRedactions(): Promise<Redaction[]> {
  try {
    const r = await getPool().query("SELECT * FROM redacted_leads ORDER BY redacted_at DESC");
    return r.rows.map((x: any) => ({ contactId: x.contact_id, contactName: x.contact_name, companyName: x.company_name, events: x.events, reason: x.reason, redactedBy: x.redacted_by, redactedAt: new Date(x.redacted_at).toISOString() }));
  } catch { return []; }
}
export async function redactedIds(): Promise<Set<string>> { return new Set((await loadRedactions()).map((r) => r.contactId)); }

export async function saveRedaction(b: any): Promise<string | null> {
  if (!b?.contactId || !/^\d+$/.test(String(b.contactId))) return "contactId must be a HubSpot contact id";
  const s = (v: any, n: number) => (v ? String(v).slice(0, n) : null);
  await getPool().query(`INSERT INTO redacted_leads (contact_id, contact_name, company_name, events, reason, redacted_by) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (contact_id) DO UPDATE SET reason = EXCLUDED.reason, redacted_by = EXCLUDED.redacted_by, redacted_at = now()`,
    [String(b.contactId), s(b.contactName, 200), s(b.companyName, 200), s(b.events, 500), s(b.reason, 300), s(b.redactedBy, 80)]);
  return null;
}
export async function restoreRedaction(id: string) { await getPool().query("DELETE FROM redacted_leads WHERE contact_id = $1", [id]); }

/** Notes typed in the roundtable Google Sheet, keyed by HubSpot contact id (latest read of the sheet). */
export async function sheetNotes(): Promise<Map<string, Array<{ note: string; tab: string; eventId: string | null }>>> {
  const out = new Map<string, Array<{ note: string; tab: string; eventId: string | null }>>();
  const cache = await getSetting<{ tabs: Array<{ title: string; rows: Array<{ contactId: string | null; note?: string | null }> }> }>("roundtable_sheet_cache");
  const rep = await getSetting<{ tabs?: Array<{ tab: string; eventId: string }> }>("roundtable_sheet_report");
  const evByTab = new Map((rep?.tabs ?? []).map((t) => [t.tab, t.eventId]));
  for (const t of cache?.tabs ?? []) for (const r of t.rows) {
    if (!r.contactId || !r.note) continue;
    const l = out.get(r.contactId) ?? []; l.push({ note: r.note, tab: t.title, eventId: evByTab.get(t.title) ?? null }); out.set(r.contactId, l);
  }
  return out;
}

/** Re-engage dates chosen by SDRs. Nothing is scheduled automatically: the SDR decides. */
export async function loadReengage(): Promise<Map<string, string>> {
  try { const r = await getPool().query("SELECT account_key, to_char(reengage_on, 'YYYY-MM-DD') AS d FROM reengage"); return new Map(r.rows.map((x: any) => [x.account_key, x.d])); }
  catch { return new Map(); }
}
export async function saveReengage(b: any): Promise<string | null> {
  if (!b?.key || !/^(contact:)?\d+$/.test(String(b.key))) return "key must be a company id or contact:<id>";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date ?? ""))) return "date must be YYYY-MM-DD";
  await getPool().query(`INSERT INTO reengage (account_key, reengage_on, set_by) VALUES ($1,$2,$3)
    ON CONFLICT (account_key) DO UPDATE SET reengage_on = EXCLUDED.reengage_on, set_by = EXCLUDED.set_by, set_at = now()`, [String(b.key), b.date, b.by ? String(b.by).slice(0, 80) : null]);
  return null;
}
export async function clearReengage(key: string) { await getPool().query("DELETE FROM reengage WHERE account_key = $1", [key]); }
