// Web service entrypoint: runs migrations, then serves the API and the built frontend.
import { env } from "./env.js";
import { errMessage, log } from "./log.js";
import { migrate } from "./db/migrate.js";
import { closePool } from "./db/pool.js";
import { createApp } from "./api/server.js";
import { runSync } from "./sync/sync.js";
import { invalidateSnapshot } from "./api/cache.js";

async function main() {
  await migrate();
  const server = createApp();
  server.listen(env.port, "0.0.0.0", () => log.info("web service listening", { port: env.port, auth: !!env.appPassword, admin: !!env.adminToken }));
  // Scheduled refresh inside the web service (no separate worker needed). A Postgres advisory lock prevents
  // overlap with manual refreshes or a separate cron worker. Errors are logged; the last good data stays live.
  if (env.syncIntervalMinutes > 0) {
    const every = env.syncIntervalMinutes * 60_000;
    const tick = () => runSync("cron").then((r) => { log.info("scheduled sync done", { status: r.status, runId: r.runId }); invalidateSnapshot(); })
      .catch((e) => log.error("scheduled sync crashed", { error: errMessage(e) }));
    setTimeout(tick, 3 * 60_000).unref();          // first run 3 minutes after start-up
    setInterval(tick, every).unref();
    log.info("scheduled sync enabled", { everyMinutes: env.syncIntervalMinutes });
  }
  const stop = (sig: string) => {
    log.info("shutting down", { signal: sig });
    server.close(() => { closePool().finally(() => process.exit(0)); });
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

main().catch((e) => { log.error("web service failed to start", { error: errMessage(e) }); process.exit(1); });
