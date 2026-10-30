// Browser API client. Talks only to this app's own /api – never to HubSpot, and holds no HubSpot credentials.

export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }

export async function api<T = any>(path: string, params?: Record<string, string>, init?: RequestInit): Promise<T> {
  const qs = params ? new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "" && v !== undefined)).toString() : "";
  const res = await fetch(`/api/${path}${qs ? `?${qs}` : ""}`, { credentials: "same-origin", ...init });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, body.error ? `${body.error}${body.details ? `: ${body.details.join("; ")}` : ""}` : `Request failed (${res.status})`);
  return body as T;
}

export function adminHeaders(): Record<string, string> {
  let t = "";
  try { t = sessionStorage.getItem("ecc-admin-token") || ""; } catch { /* storage unavailable */ }
  return { "x-admin-token": t, "Content-Type": "application/json" };
}
export function setAdminToken(t: string) { try { sessionStorage.setItem("ecc-admin-token", t); } catch { /* ignore */ } }
export function getAdminToken(): string { try { return sessionStorage.getItem("ecc-admin-token") || ""; } catch { return ""; } }
