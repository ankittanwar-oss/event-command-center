import { api, ApiError } from "./api.js";
import { redactedView } from "./views/redacted.js";
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


// Theme is chosen in the dashboard (Light by default) and never follows the operating-system setting.
type Theme = "light" | "dark";
const getTheme = (): Theme => { try { return localStorage.getItem("ecc-theme") === "dark" ? "dark" : "light"; } catch { return "light"; } };
const applyTheme = (t: Theme) => { document.documentElement.setAttribute("data-theme", t); try { localStorage.setItem("ecc-theme", t); } catch { /* ignore */ } };
applyTheme(getTheme());
function themeToggle() {
  const mk = (t: Theme, label: string) => h("button", { class: getTheme() === t ? "on" : "", onclick: (e: Event) => {
    applyTheme(t); const box = (e.currentTarget as HTMLElement).parentElement!; for (const b of Array.from(box.children)) b.classList.toggle("on", b === e.currentTarget);
  } }, label);
  return h("div", { class: "themetog", role: "group", "aria-label": "Theme" }, mk("light", "☀ Light"), mk("dark", "☾ Dark"));
}

const VIEWS: Record<string, { label: string; title: string; render: (r: Route, meta: any) => Promise<HTMLElement>; filters: boolean }> = {
  overview: { label: "CMO overview", title: "CMO overview", render: overviewView, filters: true },
  sdr: { label: "SDR execution", title: "SDR execution", render: sdrView, filters: true },
  events: { label: "Event operations", title: "Event operations", render: eventsView, filters: true },
  performance: { label: "Event performance", title: "Event performance", render: performanceView, filters: true },
  daily: { label: "Daily Command Centre", title: "Daily Command Centre", render: dailyView, filters: true },
  redacted: { label: "Redacted leads", title: "Redacted leads", render: () => redactedView(), filters: false },
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
    sel("quarter", [["q2on", "Q2 onwards (Aug 2026 → today)"], ["this", `This quarter (${meta.currentQuarter.key.slice(-2)})`], ...meta.quarters.map((q: any) => [q.key, q.label] as [string, string]), ["all", "All quarters"]], "Quarter"),
    sel("region", [["", "All regions"], ["NAM", "NAM"], ["EMEA", "EMEA"], ["APAC", "APAC"]], "Region"),
    sel("sdr", [["", f.region ? `All ${f.region} SDRs` : "All SDRs"], ...roster.map((s: any) => [s.ownerId, s.name] as [string, string])], "SDR"),
    // The Daily Command Centre keeps only Quarter / Region / SDR here; its own panel has search, queue and event filters.
    route.view === "daily" ? null : sel("category", [["", "All categories"], ["owned", "Owned"], ["sponsored", "Sponsored"], ["webinar", "Webinars"], ["roundtable", "Roundtables"]], "Category"),
    route.view === "daily" ? null : eventPicker(f.eventId, (v) => go({ eventId: v })),
    route.view === "daily" ? null : search,
    h("button", { class: "reset", onclick: () => { location.hash = buildHash(route.view, { quarter: "q2on" }); } }, "Reset"),
  );
}

/** Compact searchable multi-select for events. Stored as comma-separated event ids; Apply/Clear set the filter. */
function eventPicker(current: string, apply: (v: string) => void): HTMLElement {
  const chosen = new Set(current ? current.split(",") : []);
  const evs: any[] = meta.events.slice(0, 500);
  const label = () => chosen.size === 0 ? "All events" : chosen.size === 1 ? (evs.find((e) => chosen.has(e.id))?.name ?? "1 event") : `${chosen.size} events`;
  const btnText = h("span", { class: "evbt" }, label());
  const badge = h("span", { class: "evbadge" }, chosen.size ? String(chosen.size) : "");
  const btn = h("button", { type: "button", class: `evtrig ${chosen.size ? "on" : ""}`, "aria-haspopup": "listbox" }, btnText, badge, h("span", { class: "evcaret" }, "▾"));
  const sync = () => { btnText.textContent = label(); badge.textContent = chosen.size ? String(chosen.size) : ""; count.textContent = chosen.size ? `${chosen.size} selected` : "None selected · all events"; };
  const search = h("input", { type: "search", class: "evsearch", placeholder: "Search events" }) as HTMLInputElement;
  const rows = evs.map((e) => {
    const cb = h("input", { type: "checkbox" }) as HTMLInputElement;
    cb.checked = chosen.has(e.id);
    cb.addEventListener("change", () => { if (cb.checked) chosen.add(e.id); else chosen.delete(e.id); row.classList.toggle("sel", cb.checked); sync(); });
    const row = h("label", { class: `evrow ${cb.checked ? "sel" : ""}`, title: e.name ?? "" }, cb,
      h("span", { class: "evtxt" }, h("span", { class: "evname" }, e.name ?? "(unnamed event)"), h("span", { class: "evdate" }, fmt.day(e.date))));
    return { e, cb, row };
  });
  const list = h("div", { class: "evlist", role: "listbox" }, rows.map((r) => r.row));
  const empty = h("div", { class: "evempty", style: "display:none" }, "No events match");
  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase(); let n = 0;
    for (const r of rows) { const show = !q || (r.e.name ?? "").toLowerCase().includes(q); r.row.style.display = show ? "" : "none"; if (show) n++; }
    empty.style.display = n ? "none" : "";
  });
  const visible = () => rows.filter((r) => r.row.style.display !== "none");
  const count = h("span", { class: "evcount" });
  const menu = h("div", { class: "evmenu", style: "display:none" },
    h("div", { class: "evhead" }, search,
      h("div", { class: "evbulk" },
        h("button", { type: "button", class: "evlink", onclick: () => { for (const r of visible()) { r.cb.checked = true; chosen.add(r.e.id); r.row.classList.add("sel"); } sync(); } }, "Select all"),
        h("button", { type: "button", class: "evlink", onclick: () => { for (const r of rows) { r.cb.checked = false; r.row.classList.remove("sel"); } chosen.clear(); sync(); } }, "Clear"),
        count)),
    list, empty,
    h("div", { class: "evfoot" },
      h("button", { type: "button", class: "evsec", onclick: () => apply("") }, "Reset to all"),
      h("button", { type: "button", class: "evapply", onclick: () => apply([...chosen].join(",")) }, "Apply")));
  sync();
  const wrap = h("div", { class: "evpick" }, btn, menu);
  const place = () => {
    // keep inside the viewport: open to the left when there is no room on the right
    menu.style.left = "0"; menu.style.right = "auto";
    const r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth - 8) { menu.style.left = "auto"; menu.style.right = "0"; }
  };
  btn.addEventListener("click", (e) => { e.stopPropagation(); const show = menu.style.display === "none"; menu.style.display = show ? "flex" : "none"; if (show) { place(); search.focus(); } });
  menu.addEventListener("click", (e) => e.stopPropagation());
  menu.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Escape") menu.style.display = "none"; });
  document.addEventListener("click", () => { menu.style.display = "none"; });
  return wrap;
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
      themeToggle(),
      h("div", { class: "foot" }, `${fmt.n(meta.leadCount)} registrations · as of ${meta.today} · ${meta.build ?? "build unknown"}`)),
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
