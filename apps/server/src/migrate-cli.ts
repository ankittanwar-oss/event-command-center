import { errMessage, log } from "./log.js";
import { migrate } from "./db/migrate.js";
import { closePool } from "./db/pool.js";

migrate()
  .then(async (applied) => { log.info("migrations complete", { applied }); await closePool(); process.exit(0); })
  .catch(async (e) => { log.error("migration failed", { error: errMessage(e) }); await closePool().catch(() => undefined); process.exit(1); });
