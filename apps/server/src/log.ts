// Structured JSON logs (one line per event) – readable in Railway's log viewer and easy to search.
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = ORDER[(process.env.LOG_LEVEL as Level) || "info"] ?? 20;

function write(level: Level, msg: string, data?: Record<string, unknown>) {
  if (ORDER[level] < min) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(data ?? {}) });
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
}

export const log = {
  debug: (m: string, d?: Record<string, unknown>) => write("debug", m, d),
  info: (m: string, d?: Record<string, unknown>) => write("info", m, d),
  warn: (m: string, d?: Record<string, unknown>) => write("warn", m, d),
  error: (m: string, d?: Record<string, unknown>) => write("error", m, d),
};

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
