import { createSign } from "node:crypto";
import { log } from "../log.js";

// Minimal, dependency-free Google Sheets reader using a service account (read-only scope).
// The service-account JSON lives only in the GOOGLE_SERVICE_ACCOUNT_JSON environment variable on the server.

const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
let cached: { token: string; exp: number } | null = null;

interface ServiceAccount { client_email: string; private_key: string; token_uri?: string }

export function parseServiceAccount(json: string): ServiceAccount {
  let sa: any;
  try { sa = JSON.parse(json); } catch { throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON (paste the whole key file)"); }
  if (!sa.client_email || !sa.private_key) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON must contain client_email and private_key");
  return { client_email: sa.client_email, private_key: String(sa.private_key).replace(/\\n/g, "\n"), token_uri: sa.token_uri };
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** Signed JWT assertion for the OAuth token exchange (RS256). Exported for tests. */
export function signedAssertion(sa: ServiceAccount, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: sa.token_uri ?? "https://oauth2.googleapis.com/token", iat: nowSec, exp: nowSec + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${b64url(signer.sign(sa.private_key))}`;
}

async function accessToken(sa: ServiceAccount): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const res = await fetch(sa.token_uri ?? "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signedAssertion(sa) }).toString(),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`Google auth failed (${res.status}): ${body.error_description ?? body.error ?? "unknown"}`);
  cached = { token: body.access_token, exp: Date.now() + (Number(body.expires_in) || 3600) * 1000 };
  return cached.token;
}

async function get(sa: ServiceAccount, url: string): Promise<any> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${await accessToken(sa)}` } });
  const text = await res.text();
  if (!res.ok) {
    const hint = res.status === 403 ? ` Share the sheet with ${sa.client_email} (Viewer) and enable the Google Sheets API.` : res.status === 404 ? " Check ROUNDTABLE_SHEET_ID." : "";
    throw new Error(`Google Sheets ${res.status}: ${text.slice(0, 200)}.${hint}`);
  }
  return JSON.parse(text);
}

/** All tabs of a spreadsheet as { title, rows } (rows = arrays of cell strings, header included). */
export async function readAllTabs(serviceAccountJson: string, spreadsheetId: string): Promise<Array<{ title: string; rows: string[][] }>> {
  const sa = parseServiceAccount(serviceAccountJson);
  const meta = await get(sa, `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties.title`);
  const titles: string[] = (meta.sheets ?? []).map((s: any) => s.properties?.title).filter(Boolean);
  if (!titles.length) return [];
  const q = new URLSearchParams({ valueRenderOption: "FORMATTED_VALUE", majorDimension: "ROWS" });
  for (const t of titles) q.append("ranges", `'${t.replace(/'/g, "''")}'`);
  const data = await get(sa, `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchGet?${q}`);
  const out = (data.valueRanges ?? []).map((vr: any, i: number) => ({ title: titles[i]!, rows: (vr.values ?? []).map((r: any[]) => r.map((c) => String(c ?? ""))) }));
  log.info("roundtable sheet read", { tabs: out.length, rows: out.reduce((a: number, t: any) => a + t.rows.length, 0) });
  return out;
}
