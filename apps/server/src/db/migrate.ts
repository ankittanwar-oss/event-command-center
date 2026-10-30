import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { getPool } from "./pool.js";
import { log } from "../log.js";

function migrationsDir(): string {
  const candidates = [
    process.env.MIGRATIONS_DIR,
    path.resolve(process.cwd(), "apps/server/migrations"),
    path.resolve(process.cwd(), "migrations"),
  ].filter((x): x is string => !!x);
  const found = candidates.find((d) => existsSync(d));
  if (!found) throw new Error(`Migrations folder not found (looked in ${candidates.join(", ")})`);
  return found;
}

/** Applies every *.sql file in order, once. Safe to run on every deploy and every worker start. */
export async function migrate(): Promise<string[]> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    // Serialise concurrent migrators (web + worker starting together).
    await client.query("SELECT pg_advisory_lock(424242)");
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await client.query<{ id: string }>("SELECT id FROM schema_migrations")).rows.map((r: { id: string }) => r.id));
    const dir = migrationsDir();
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    const applied: string[] = [];
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = readFileSync(path.join(dir, f), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [f]);
        await client.query("COMMIT");
        applied.push(f);
        log.info("migration applied", { file: f });
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock(424242)").catch(() => undefined);
    client.release();
  }
}
