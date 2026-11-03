import { api, ApiError } from "./api.js";
import { closeDrawer, sdrNames } from "./drawer.js";
import { buildHash, parseHash, type FilterState, type Route } from "./state.js";
import { fmt, h, setPortal } from "./ui.js";
import { adminView } from "./views/admin.js";
import { eventsView } from "./views/events.js";
import { overviewView } from "./views/overview.js";
import { performanceView } from "./views/performance.js";
import { qualityView } from "./views/quality.js";
import { sdrView } from "./views/sdr.js";
import { dailyView } from "./views/daily.js";


const VIEWS: Record<string, { label: string; title: string; render: (r: Route, meta: any) => Promise<HTMLElement>; filters: boolean }> = {
  overview: { label: "CMO overview", title: "CMO overview", render: overviewView, filters: true },
  sdr: { label: "SDR execution", title: "SDR execution", render: sdrView, filters: true },
  events: { label: "Event operations", title: "Event operations", render: eventsView, filters: true },
  performance: { label: "Event performance", title: "Event performance", render: performanceView, filters: true },
  daily: { label: "Daily Command Centre", title: "Daily Command Centre", render: dailyView, filters: true },
  quality: { label: "Data quality", title: "Data quality", render: qualityView, filters: true },
  admin: { label: "Admin", title: "Admin & diagnostics", render: adminView, filters: false },
};

let meta: any = null;
let renderSeq = 0;

async function loadMeta() {
  meta = await api("meta");
  setPortal(meta.portalId);
  for (const s of meta.roster) sdrNames.set(s.ownerId, s.name);
}

function filterBar(route: Route): HTMLElement {
  const f = route.filters;
  const go = (patch: Partial<FilterState>) => {
    const next = { ...f, ...patch };
    // Region change clears an SDR who does not belong to the new region.
    if (patch.region !== undefined && next.sdr) {
      const sdr = meta.roster.find((s: any) => s.ownerId === next.sdr);
      if (patch.region && sdr?.region !== patch.region) next.sdr = "";
    }
    location.hash = buildHash(route.view, next, Object.fromEntries(route.extra));
  };
  const sel = (key: keyof FilterState, options: Array<[string, string]>, label: string) =>
    h("select", { "aria-label": label, onchange: (e: Event) => go({ [key]: (e.target as HTMLSelectElement).value }) },
      options.map(([v, l]) => { const o = h("option", { value: v }, l) as HTMLOptionElement; if (f[key] === v) o.selected = true; return o; }));

  const roster = meta.roster.filter((s: any) => !f.region || s.region === f.region);
  const search = h("input", { type: "search", placeholder: "Search contact, company, event", value: f.search }) as HTMLInputElement;
  search.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") go({ search: search.value.trim() }); });

  return h("div", { class: "filters" },
    sel("quarter", [["this", `This quarter (${meta.currentQuarter.key.slice(-2)})`], ...meta.quarters.map((q: any) => [q.key, q.label] as [string, string]), ["all", "All quarters"]], "Quarter"),
    sel("region", [["", "All regions"], ["NAM", "NAM"], ["EMEA", "EMEA"], ["APAC", "APAC"]], "Region"),
    sel("sdr", [["", f.region ? `All ${f.region} SDRs` : "All SDRs"], ...roster.map((s: any) => [s.ownerId, s.name] as [string, string])], "SDR"),
    sel("category", [["", "All categories"], ["owned", "Owned"], ["sponsored", "Sponsored"], ["webinar", "Webinars"], ["roundtable", "Roundtables"]], "Category"),
    sel("eventId", [["", "All events"], ...meta.events.slice(0, 300).map((e: any) => [e.id, `${(e.name ?? "").slice(0, 40)} · ${fmt.day(e.date)}`] as [string, string])], "Event"),
    search,
    h("button", { class: "reset", onclick: () => { location.hash = buildHash(route.view, { quarter: "this" }); } }, "Reset"),
  );
}

function freshnessBadge(): HTMLElement {
  const fr = meta.freshness;
  return h("div", { class: "fresh", title: fr.lastSuccessAt ? new Date(fr.lastSuccessAt).toLocaleString() : "No successful sync yet" },
    h("span", { class: `dot ${fr.stale ? "stale" : ""}` }), `Synced ${fmt.ago(fr.lastSuccessAt)}`);
}

function banners(): HTMLElement[] {
  const out: HTMLElement[] = [];
  const fr = meta.freshness;
  if (!fr.lastSuccessAt) out.push(h("div", { class: "banner warn" }, "No successful HubSpot sync yet. Numbers will appear after the first sync completes (see Admin)."));
  else if (fr.stale) out.push(h("div", { class: "banner warn" }, `Data is stale: the last successful sync was ${fmt.ago(fr.lastSuccessAt)} (expected every 2 hours). Check Admin → Sync history.`));
  if (fr.lastRun?.status === "failed") out.push(h("div", { class: "banner warn" }, `The most recent sync failed (${fmt.ago(fr.lastRun.started_at)}): ${fr.lastRun.error ?? "unknown error"}. Showing the last good snapshot.`));
  return out;
}

async function render() {
  const seq = ++renderSeq;
  closeDrawer();
  const route = parseHash();
  const view = VIEWS[route.view] ?? VIEWS.overview!;
  const root = document.getElementById("app")!;
  try { await loadMeta(); } catch (e) {
    root.replaceChildren(h("div", { class: "content" }, h("div", { class: "banner warn" }, `Could not load the application: ${(e as Error).message}`)));
    return;
  }
  const content = h("div", { class: "content" }, ...banners(), h("div", { class: "loading" }, "Loading…"));
  const nav = h("nav", { class: "nav" }, Object.entries(VIEWS).map(([k, v]) => [
    k === "quality" ? h("div", { class: "sep" }) : null,
    h("a", { href: buildHash(k, route.filters), class: k === route.view ? "active" : "" }, v.label),
  ]));
  root.replaceChildren(h("div", { class: "app" },
    h("aside", { class: "sidebar" },
      h("div", { class: "brand" }, "Events Command Center", h("small", null, "SpotDraft · event follow-up")),
      nav,
      h("div", { class: "foot" }, `${fmt.n(meta.leadCount)} registrations · as of ${meta.today}`)),
    h("main", { class: "main" },
      h("div", { class: "topbar" }, h("span", { class: "title" }, view.title), view.filters ? filterBar(route) : null, freshnessBadge()),
      content)));
  try {
    const el = await view.render(route, meta);
    if (seq !== renderSeq) return;
    content.replaceChildren(...banners(), el);
  } catch (e) {
    if (seq !== renderSeq) return;
    const msg = e instanceof ApiError ? e.message : `Something went wrong: ${(e as Error).message}`;
    content.replaceChildren(...banners(), h("div", { class: "banner warn" }, msg));
  }
}

window.addEventListener("hashchange", render);
render();
// Pick up new snapshots without a manual reload (cheap: meta only).
setInterval(async () => {
  if (document.hidden || !meta) return;
  try {
    const m = await api("meta");
    if (m.computedAt !== meta.computedAt) render();
  } catch { /* ignore */ }
}, 5 * 60_000);
