// Sync worker entrypoint. Railway runs this on a cron schedule (every 2 hours): it migrates, performs one
// HubSpot sync, recomputes lead facts and exits. Exit code 1 marks the cron run as failed in Railway.
//
//   node apps/server/dist/worker.js            incremental (full reconcile automatically every SYNC_FULL_RECONCILE_HOURS)
//   node apps/server/dist/worker.js --full     force a full reconcile
//   node apps/server/dist/worker.js --recompute  recompute facts from stored data only (no HubSpot calls)
import { errMessage, log } from "./log.js";
import { migrate } from "./db/migrate.js";
import { closePool } from "./db/pool.js";
import { recomputeFacts, runSync } from "./sync/sync.js";

async function main(): Promise<number> {
  await migrate();
  if (process.argv.includes("--recompute")) {
    const n = await recomputeFacts();
    log.info("recomputed lead facts", { leads: n });
    return 0;
  }
  const r = await runSync(process.argv.includes("--cron") ? "cron" : "cli", { forceFull: process.argv.includes("--full") });
  if (r.status === "failed") return 1;
  return 0;
}

main()
  .then(async (code) => { await closePool(); process.exit(code); })
  .catch(async (e) => { log.error("worker crashed", { error: errMessage(e) }); await closePool().catch(() => undefined); process.exit(1); });
