import pg, { type Pool, type PoolClient } from "pg";
import { env } from "../env.js";
import { log } from "../log.js";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const url = env.databaseUrl;
    // Railway's internal network (postgres.railway.internal) does not use TLS; the public proxy URL does.
    const internal = /\.railway\.internal|localhost|127\.0\.0\.1/.test(url);
    pool = new pg.Pool({
      connectionString: url,
      max: Number(process.env.PG_POOL_MAX || 8),
      ssl: internal || process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false },
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
    });
    pool.on("error", (e: Error) => log.error("postgres pool error", { error: e.message }));
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) { await pool.end(); pool = null; }
}

/** Run `fn` inside a transaction on a dedicated connection. */
export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
