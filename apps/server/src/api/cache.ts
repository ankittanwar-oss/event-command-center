import type { LeadFact, Rules } from "@ecc/core";
import { DEFAULT_RULES } from "@ecc/core";
import { getPool } from "../db/pool.js";
import { loadLeadFacts } from "../db/repo.js";

// The API keeps the latest computed lead facts in memory (a few thousand rows) and reloads them whenever the
// worker publishes a new snapshot. Every endpoint aggregates from this one array with the shared core functions.

interface Snapshot { facts: LeadFact[]; computedAt: string | null; asOf: string | null; rules: Rules; runId: number | null }
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
        const { facts, meta } = await loadLeadFacts();
        snap = {
          facts, computedAt: at, asOf: meta?.as_of_date ? new Date(meta.as_of_date).toISOString().slice(0, 10) : null,
          rules: (meta?.rules as Rules) ?? DEFAULT_RULES, runId: meta?.run_id ?? null,
        };
      }
      lastCheck = Date.now();
    })().finally(() => { loading = null; });
  }
  await loading;
  return snap;
}

export function invalidateSnapshot() { lastCheck = 0; }
