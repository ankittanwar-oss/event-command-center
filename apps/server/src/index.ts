// Web service entrypoint: runs migrations, then serves the API and the built frontend.
import { env } from "./env.js";
import { errMessage, log } from "./log.js";
import { migrate } from "./db/migrate.js";
import { closePool } from "./db/pool.js";
import { createApp } from "./api/server.js";

async function main() {
  await migrate();
  const server = createApp();
  server.listen(env.port, "0.0.0.0", () => log.info("web service listening", { port: env.port, auth: !!env.appPassword, admin: !!env.adminToken }));
  const stop = (sig: string) => {
    log.info("shutting down", { signal: sig });
    server.close(() => { closePool().finally(() => process.exit(0)); });
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

main().catch((e) => { log.error("web service failed to start", { error: errMessage(e) }); process.exit(1); });
