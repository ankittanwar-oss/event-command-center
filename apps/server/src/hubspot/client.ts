import { env } from "../env.js";
import { log } from "../log.js";

// Read-only HubSpot client. Every call is a GET or a read-only POST (search / batch read / association read).
// There is deliberately no method that creates, updates or deletes CRM data.

export class HubSpotError extends Error {
  constructor(message: string, public status: number, public body: string) { super(message); }
}

export interface ClientStats { requests: number; failed: number; retries: number }

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  status: number; ok: boolean; headers: { get(name: string): string | null }; text(): Promise<string>;
}>;

const READ_ONLY_POST = [/\/search$/, /\/batch\/read$/];

export class HubSpotClient {
  readonly stats: ClientStats = { requests: 0, failed: 0, retries: 0 };
  private nextSlot = 0;
  private readonly intervalMs: number;

  constructor(
    private readonly token: string,
    private readonly baseUrl = env.hubspotBaseUrl,
    maxRps = env.hubspotMaxRps,
    private readonly fetchImpl: FetchLike = (globalThis.fetch as unknown as FetchLike),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.intervalMs = Math.ceil(1000 / Math.max(1, maxRps));
  }

  private async throttle() {
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + this.intervalMs;
    if (wait) await this.sleep(wait);
  }

  async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    if (method === "POST" && !READ_ONLY_POST.some((r) => r.test(path.split("?")[0]!))) {
      throw new Error(`Refusing non read-only POST to ${path}`);
    }
    const url = `${this.baseUrl}${path}`;
    const maxAttempts = 6;
    for (let attempt = 1; ; attempt++) {
      await this.throttle();
      this.stats.requests++;
      let status = 0;
      let text = "";
      let retryAfter: string | null = null;
      try {
        const res = await this.fetchImpl(url, {
          method,
          headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json", Accept: "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        status = res.status;
        text = await res.text();
        retryAfter = res.headers.get("retry-after");
        if (res.ok) return (text ? JSON.parse(text) : {}) as T;
      } catch (e) {
        text = e instanceof Error ? e.message : String(e);
      }
      const retryable = status === 0 || status === 429 || status >= 500;
      if (!retryable || attempt >= maxAttempts) {
        this.stats.failed++;
        // Never log the token; the body is HubSpot's error message.
        throw new HubSpotError(`HubSpot ${method} ${path} failed with ${status || "network error"}: ${text.slice(0, 300)}`, status, text);
      }
      this.stats.retries++;
      const delay = retryAfter ? Math.min(30_000, Number(retryAfter) * 1000 || 1000) : Math.min(30_000, 500 * 2 ** (attempt - 1));
      log.warn("hubspot retry", { path, status, attempt, delayMs: delay });
      await this.sleep(delay);
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Convenience wrappers
  // ---------------------------------------------------------------------------------------------------------

  async listOwners(): Promise<Array<{ id: string; firstName?: string; lastName?: string; email?: string; archived?: boolean }>> {
    const out: any[] = [];
    for (const archived of [false, true]) {
      let after: string | undefined;
      do {
        const q = new URLSearchParams({ limit: "500", archived: String(archived) });
        if (after) q.set("after", after);
        const r = await this.request<any>("GET", `/crm/v3/owners?${q}`);
        for (const o of r.results ?? []) out.push({ ...o, archived });
        after = r.paging?.next?.after;
      } while (after);
    }
    return out;
  }

  /** CRM search with paging (HubSpot caps search at 10,000 results; callers keep windows small). */
  async searchAll(objectType: string, body: { filterGroups: unknown[]; properties: string[]; sorts?: unknown[] }): Promise<any[]> {
    const out: any[] = [];
    let after: string | undefined;
    do {
      const r = await this.request<any>("POST", `/crm/v3/objects/${objectType}/search`, { ...body, limit: 100, after });
      out.push(...(r.results ?? []));
      after = r.paging?.next?.after;
      if (out.length >= 10_000) { log.warn("search result cap reached", { objectType }); break; }
    } while (after);
    return out;
  }

  /** Batch read records by id (100 per request). */
  async batchRead(objectType: string, ids: string[], properties: string[], propertiesWithHistory: string[] = []): Promise<any[]> {
    const out: any[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const r = await this.request<any>("POST", `/crm/v3/objects/${objectType}/batch/read`, {
        inputs: chunk.map((id) => ({ id })), properties, propertiesWithHistory, archived: false,
      });
      out.push(...(r.results ?? []));
    }
    return out;
  }

  /**
   * Association ids from many records to one object type (v4 batch API, 1,000 inputs per request).
   * Records with more than one page of associations are completed with the per-record endpoint.
   */
  async associations(fromType: string, toType: string, ids: string[], maxPerRecord = 5000): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    for (let i = 0; i < ids.length; i += 1000) {
      const chunk = ids.slice(i, i + 1000);
      const r = await this.request<any>("POST", `/crm/v4/associations/${fromType}/${toType}/batch/read`, { inputs: chunk.map((id) => ({ id })) });
      for (const row of r.results ?? []) {
        const from = String(row.from?.id);
        if (row.paging?.next?.after) {
          // The batch endpoint's paging cursor is NOT valid for the per-record endpoint (HubSpot returns 400),
          // so records with more associations than one batch page are re-read from the start, one record at a time.
          out.set(from, [...(out.get(from) ?? []), ...(await this.associationsOf(fromType, from, toType, maxPerRecord))]);
          continue;
        }
        const list = out.get(from) ?? [];
        for (const t of row.to ?? []) list.push(String(t.toObjectId));
        out.set(from, list);
      }
    }
    for (const [k, v] of out) out.set(k, [...new Set(v)]);
    return out;
  }

  /** All associations for one record (used for event -> contacts, which can exceed batch page sizes). */
  async associationsOf(fromType: string, id: string, toType: string, max = Number.POSITIVE_INFINITY): Promise<string[]> {
    const out: string[] = [];
    let after: string | undefined;
    do {
      const q = new URLSearchParams({ limit: "500" });
      if (after) q.set("after", after);
      const r = await this.request<any>("GET", `/crm/v4/objects/${fromType}/${id}/associations/${toType}?${q}`);
      for (const t of r.results ?? []) out.push(String(t.toObjectId));
      after = r.paging?.next?.after;
      if (out.length >= max) { log.warn("association list capped", { fromType, id, toType, max }); break; }
    } while (after);
    return [...new Set(out)];
  }

  async dealPipelines(): Promise<Array<{ id: string; label: string; stages: Array<{ id: string; label: string; metadata?: Record<string, string> }> }>> {
    const r = await this.request<any>("GET", `/crm/v3/pipelines/deals`);
    return r.results ?? [];
  }

  async property(objectType: string, name: string): Promise<{ name: string; options?: Array<{ label: string; value: string }> } | null> {
    try {
      return await this.request<any>("GET", `/crm/v3/properties/${objectType}/${encodeURIComponent(name)}`);
    } catch (e) {
      if (e instanceof HubSpotError && e.status === 404) return null;
      throw e;
    }
  }
}
