import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { env } from "../env.js";

export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

export function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(json);
}

export async function readJson(req: IncomingMessage, limit = 256 * 1024): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, "Request body too large");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HttpError(400, "Invalid JSON"); }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Optional shared password for the whole app (HTTP Basic auth; any username). */
export function checkAppAuth(req: IncomingMessage): boolean {
  if (!env.appPassword) return true;
  const h = req.headers.authorization || "";
  if (!h.startsWith("Basic ")) return false;
  const decoded = Buffer.from(h.slice(6), "base64").toString("utf8");
  const pass = decoded.slice(decoded.indexOf(":") + 1);
  return safeEqual(pass, env.appPassword);
}

/** Admin actions (manual refresh, rule changes) require ADMIN_TOKEN. Disabled entirely when it is not set. */
export function requireAdmin(req: IncomingMessage) {
  if (!env.adminToken) throw new HttpError(403, "Admin actions are disabled: set ADMIN_TOKEN on the web service");
  const t = String(req.headers["x-admin-token"] || "");
  if (!t || !safeEqual(t, env.adminToken)) throw new HttpError(401, "Invalid admin token");
}

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'",
};
