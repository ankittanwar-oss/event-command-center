// Global filter state lives in the URL hash (#/view?quarter=...&region=...), so every view is linkable and
// the browser back button works.

export const FILTER_KEYS = ["quarter", "region", "sdr", "category", "temperature", "eventId", "search"] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];
export type FilterState = Record<FilterKey, string>;

export interface Route { view: string; filters: FilterState; extra: URLSearchParams }

export function parseHash(): Route {
  const raw = location.hash.replace(/^#\/?/, "");
  const [view = "overview", qs = ""] = raw.split("?");
  const p = new URLSearchParams(qs);
  const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, p.get(k) ?? ""])) as FilterState;
  if (!filters.quarter) filters.quarter = "q2on";
  const extra = new URLSearchParams();
  for (const [k, v] of p) if (!(FILTER_KEYS as readonly string[]).includes(k)) extra.set(k, v);
  return { view: view || "overview", filters, extra };
}

export function buildHash(view: string, filters: Partial<FilterState>, extra?: Record<string, string>): string {
  const p = new URLSearchParams();
  for (const k of FILTER_KEYS) {
    const v = filters[k];
    if (v && !(k === "quarter" && v === "q2on")) p.set(k, v);
  }
  for (const [k, v] of Object.entries(extra ?? {})) if (v) p.set(k, v);
  const s = p.toString();
  return `#/${view}${s ? `?${s}` : ""}`;
}

export function filterParams(f: FilterState): Record<string, string> {
  const o: Record<string, string> = {};
  for (const k of FILTER_KEYS) if (f[k]) o[k] = f[k];
  return o;
}
