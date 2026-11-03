import type { LeadFact, Rules } from "@ecc/core";
import { DEFAULT_RULES, isExcludedCompany, mergeRules } from "@ecc/core";
import { getPool } from "../db/pool.js";
import { loadLeadFacts } from "../db/repo.js";

// The API keeps the latest computed lead facts in memory (a few thousand rows) and reloads them whenever the
// worker publishes a new snapshot. Every endpoint aggregates from this one array with the shared core functions.

interface Snapshot { facts: LeadFact[]; computedAt: string | null; asOf: string | null; rules: Rules; runId: number | null }
import { ownerNames } from "./owners.js";
export { ownerNames };
let snap: Snapshot = { facts: [], computedAt: null, asOf: null, rules: DEFAULT_RULES, runId: null };
let lastCheck = 0;
let loading: Promise<void> | null = null;

export async function getSnapshot(): Promise<Snapshot> {
  if (Date.now() - lastCheck < 15_000 && snap.computedAt) return snap;
  if (!loading) {
    loading = (async () => {
      const r = await getPool().query<{ computed_at: Date }>("SELECT computed_at FROM facts_meta WHERE id = 1");
      const at = r.rows[0]?.computed_at ? new Date(r.rows[0].computed_at).toISOString() : null;
      if (at && at !== snap.computedAt) {
        const { facts: all, meta } = await loadLeadFacts();
        // Rules saved with an older snapshot may lack settings added later: fill gaps from the current defaults.
        const rules = mergeRules(DEFAULT_RULES, meta?.rules ?? {});
        // Companies on the exclusion list are removed before anything is counted or shown.
        const facts = all.filter((f) => !isExcludedCompany(f, rules));
        // HubSpot owner names (read from the synced owners table) for "Last contacted by".
        try {
          const o = await getPool().query<{ id: string; name: string | null }>("SELECT id, name FROM owners");
          ownerNames.clear(); for (const r of o.rows) if (r.name) ownerNames.set(r.id, r.name);
        } catch { /* owners table unavailable: names fall back to the roster */ }
        snap = {
          facts, computedAt: at, asOf: meta?.as_of_date ? new Date(meta.as_of_date).toISOString().slice(0, 10) : null,
          rules, runId: meta?.run_id ?? null,
        };
      }
      lastCheck = Date.now();
    })().finally(() => { loading = null; });
  }
  await loading;
  return snap;
}

export function invalidateSnapshot() { lastCheck = 0; }
