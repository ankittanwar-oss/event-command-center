import { api } from "../api.js";
import { openCustom } from "../drawer.js";
import { buildHash, filterParams, type Route } from "../state.js";
import { fmt, h, hsLink } from "../ui.js";

// CMO executive view: Hot & Warm event-lead coverage (contact level). All numbers come from /api/cmo-hotwarm and every
// number opens /api/cmo-hotwarm-drill with the same filters, so the list always matches the count.

const PART_LABEL: Record<string, string> = { "": "All eligible contacts", attended: "Verified attendees", registered: "Registered only", unknown: "Attendance unknown", sponsored_list: "Sponsored-event list only" };
const PSTAT: Record<string, string> = { attended: "Verified attendee", registered: "Registered only", unknown: "Attendance unknown", sponsored_list: "On sponsored-event list (not verified)", no_show: "Confirmed no-show" };
const METRIC_LABEL: Record<string, string> = {
  hot_total: "Hot contacts", hot_worked: "Hot contacts worked", hot_unworked: "Unworked Hot contacts", hot_cov: "Hot contacts (worked and unworked)",
  warm_total: "Warm contacts", warm_worked: "Warm contacts worked", warm_unworked: "Unworked Warm contacts", warm_cov: "Warm contacts (worked and unworked)",
  unworked: "Unworked Hot/Warm contacts", total: "Hot/Warm contacts",
};

export async function hotWarmSection(route: Route): Promise<HTMLElement> {
  const f = route.filters;
  const part = route.extra.get("part") ?? "";
  const d = await api("cmo-hotwarm", { ...filterParams(f), part });
  const T = d.thresholds ?? { green: 80, amber: 50 };
  const cls = (v: number | null) => (v === null ? "cv-na" : v >= T.green ? "cv-g" : v >= T.amber ? "cv-a" : "cv-r");
  const go = (patch: Record<string, string>) => { location.hash = buildHash(route.view, f, { ...Object.fromEntries(route.extra), ...patch }); };
  const drill = (scope: string, id: string, metric: string, name: string) => () => openDrill(f, part, scope, id, metric, name);

  const num = (n: number, scope: string, id: string, metric: string, name: string) =>
    h("td", { class: "n hwn" }, n ? h("span", { class: "link", onclick: drill(scope, id, metric, name) }, fmt.n(n)) : h("span", { class: "faint" }, "0"));
  const cov = (v: number | null, total: number, scope: string, id: string, metric: string, name: string) =>
    h("td", { class: `n hwc ${cls(total ? v : null)}`, title: total ? "Click for the full population, worked and unworked" : "No contacts: not measurable" },
      total ? h("span", { class: "link", onclick: drill(scope, id, metric, name) }, h("span", { class: "bar" }, h("i", { style: `width:${Math.min(100, v ?? 0)}%` })), `${Math.round(v ?? 0)}%`) : "N/A");
  const row = (r: any, scope: string, id: string, name: any, label: string, total = false) => h("tr", { class: total ? "hwtot" : "" },
    h("td", { class: "hwname" }, name),
    num(r.hotTotal, scope, id, "hot_total", label), num(r.hotWorked, scope, id, "hot_worked", label), cov(r.hotCoverage, r.hotTotal, scope, id, "hot_cov", label),
    num(r.warmTotal, scope, id, "warm_total", label), num(r.warmWorked, scope, id, "warm_worked", label), cov(r.warmCoverage, r.warmTotal, scope, id, "warm_cov", label),
    num(r.unworked, scope, id, "unworked", label));
  const head = (first: string) => h("thead", null, h("tr", null, h("th", null, first), ...["Hot total", "Hot worked", "Hot coverage", "Warm total", "Warm worked", "Warm coverage", "Total unworked"].map((x) => h("th", { class: "n" }, x))));

  // ---- event table (ALL EVENTS pinned; default sort: most unworked Hot, then Warm)
  const esort = route.extra.get("esort") ?? "gap";
  const evs: any[] = [...d.events];
  const lowCov = (e: any) => Math.min(e.hotTotal ? e.hotCoverage : 101, e.warmTotal ? e.warmCoverage : 101);
  evs.sort((a, b) => esort === "date" ? (b.date ?? "").localeCompare(a.date ?? "")
    : esort === "hot" ? b.hotTotal - a.hotTotal : esort === "warm" ? b.warmTotal - a.warmTotal
    : esort === "hotcov" ? (a.hotTotal ? a.hotCoverage : 101) - (b.hotTotal ? b.hotCoverage : 101)
    : esort === "warmcov" ? (a.warmTotal ? a.warmCoverage : 101) - (b.warmTotal ? b.warmCoverage : 101)
    : esort === "unworked" ? b.unworked - a.unworked : esort === "lowest" ? lowCov(a) - lowCov(b)
    : b.hotUnworked - a.hotUnworked || b.warmUnworked - a.warmUnworked || b.unworked - a.unworked);
  const sel = (key: string, cur: string, opts: Array<[string, string]>) => h("select", { class: "hwsel", onchange: (e: Event) => go({ [key]: (e.target as HTMLSelectElement).value }) },
    opts.map(([v, l]) => { const o = h("option", { value: v }, l) as HTMLOptionElement; if (v === cur) o.selected = true; return o; }));
  const legend = h("div", { class: "hwlegend" }, h("span", { class: "sw cv-g" }), ` ${T.green}%+ worked `, h("span", { class: "sw cv-a" }), ` ${T.amber}–${T.green - 1}% `, h("span", { class: "sw cv-r" }), ` below ${T.amber}% `, h("span", { class: "sw cv-na" }), " not measurable");
  const eventTable = h("section", { class: "card hwcard" },
    h("div", { class: "hwh" }, h("div", null, h("h2", null, "Hot & Warm Event Lead Coverage"), h("div", { class: "hwsub" }, "Are we working the high-priority people coming through our events?")),
      h("div", { class: "hwctl" }, sel("part", part, Object.entries(PART_LABEL) as Array<[string, string]>),
        sel("esort", esort, [["gap", "Sort: most unworked Hot, then Warm"], ["unworked", "Total unworked"], ["lowest", "Lowest coverage"], ["hotcov", "Hot coverage (low first)"], ["warmcov", "Warm coverage (low first)"], ["hot", "Hot total"], ["warm", "Warm total"], ["date", "Event date (newest)"]]))),
    h("div", { class: "tbl-wrap" }, h("table", { class: "hwtable" }, head("Event"),
      h("tbody", null,
        row(d.all, "all", "", h("span", { title: "Event rows may overlap because one contact can engage with multiple events. ALL EVENTS counts unique contacts." }, "ALL EVENTS ", h("span", { class: "faint" }, "ⓘ unique contacts")), "All events", true),
        evs.map((e) => row(e, "event", e.eventId, h("div", null, h("div", { class: "evn" }, e.name), h("div", { class: "faint evs" }, `${fmt.day(e.date)} · ${e.category}`)), e.name))))),
    h("div", { class: "hwfoot" }, legend, h("div", { class: "faint" }, `Showing: ${PART_LABEL[part]} · ${d.filters.quarterLabel}. Event rows may overlap; ALL EVENTS counts each contact once.`)));

  // ---- SDR table (ALL SDRs pinned; current Company SDR Owner)
  const ssort = route.extra.get("ssort") ?? "gap";
  const sdrs: any[] = [...d.sdrs];
  sdrs.sort((a, b) => ssort === "cov" ? lowCov(a) - lowCov(b) : b.hotUnworked - a.hotUnworked || b.warmUnworked - a.warmUnworked);
  const sdrTable = h("section", { class: "card hwcard" },
    h("div", { class: "hwh" }, h("div", null, h("h2", null, "Hot & Warm Coverage by SDR"), h("div", { class: "hwsub" }, "Are we following up with the high-priority leads assigned to each SDR?")),
      h("div", { class: "hwctl" }, sel("ssort", ssort, [["gap", "Sort: most unworked Hot, then Warm"], ["cov", "Lowest coverage"]]))),
    h("div", { class: "tbl-wrap" }, h("table", { class: "hwtable" }, head("SDR (current HubSpot owner)"),
      h("tbody", null, row(d.all, "all", "", "ALL SDRs", "All SDRs", true), sdrs.map((s) => row(s, "sdr", s.ownerId, s.name, s.name))))),
    h("div", { class: "hwfoot" }, legend, h("div", { class: "faint" }, "Owner = current Company SDR Owner in HubSpot. Worked = outreach by that current SDR; earlier owners' outreach is visible in the drill-down but not credited.")));

  const gaps = h("section", { class: "card hwcard hwgaps" }, h("h2", null, "Where we're leaving opportunities behind"),
    d.gaps.length ? h("ul", null, d.gaps.map((g: any) => h("li", null, h("span", { class: "link", onclick: drill(g.scope, g.id, g.metric, g.text) }, g.text)))) : h("div", { class: "faint" }, "No material gaps in this view."));

  const defs = h("details", { class: "hwdefs" }, h("summary", null, "How Hot, Warm and Worked are defined"),
    h("ul", null, Object.values(d.definitions).map((t: any) => h("li", null, t))));
  return h("div", null, eventTable, sdrTable, gaps, defs);
}

async function openDrill(f: any, part: string, scope: string, id: string, metric: string, name: string) {
  const box = h("div", { class: "apanel" }, h("div", { class: "loading" }, "Loading…"));
  openCustom(`${name}: ${METRIC_LABEL[metric] ?? metric}`, "Exact records behind the number, with the dashboard filters applied", box);
  let d: any;
  try { d = await api("cmo-hotwarm-drill", { ...filterParams(f), part, scope, id, metric }); } catch (e) { box.replaceChildren(h("div", { class: "banner warn" }, (e as Error).message)); return; }
  const rowsAll: any[] = d.rows;
  const search = h("input", { type: "search", placeholder: "Search person, company or event" }) as HTMLInputElement;
  const opt = (pairs: Array<[string, string]>) => pairs.map(([v, l]) => h("option", { value: v }, l));
  const evs = new Map<string, string>(); const sdrsSet = new Set<string>();
  for (const r of rowsAll) { sdrsSet.add(r.sdrName); for (const e of r.events) evs.set(e.id, `${e.name} · ${fmt.day(e.date)}`); }
  const wSel = h("select", null, opt([["", "Worked and unworked"], ["n", "Unworked"], ["y", "Worked"]])) as HTMLSelectElement;
  const cSel = h("select", null, opt([["", "Hot and Warm"], ["hot", "Hot"], ["warm", "Warm"]])) as HTMLSelectElement;
  const eSel = h("select", null, opt([["", "Any event"], ...[...evs.entries()]])) as HTMLSelectElement;
  const sSel = h("select", null, opt([["", "Any SDR"], ...[...sdrsSet].sort().map((x) => [x, x] as [string, string])])) as HTMLSelectElement;
  const head = h("div", { class: "drillhead" });
  const list = h("div", { class: "hwlist" });
  const render = () => {
    const q = search.value.trim().toLowerCase();
    const rows = rowsAll.filter((r) => (!q || `${r.contactName} ${r.companyName ?? ""} ${r.events.map((e: any) => e.name).join(" ")}`.toLowerCase().includes(q))
      && (!wSel.value || (wSel.value === "y" ? r.worked : !r.worked)) && (!cSel.value || r.cls === cSel.value)
      && (!eSel.value || r.events.some((e: any) => e.id === eSel.value)) && (!sSel.value || r.sdrName === sSel.value));
    head.replaceChildren(h("span", { class: "dcount" }, fmt.n(rows.length), h("small", null, rows.length === 1 ? " contact" : " contacts")),
      rows.length !== d.count ? h("span", { class: "faint" }, ` of ${fmt.n(d.count)} (filters in this panel)`) : h("span", { class: "faint" }, ` · ${rowsAll.filter((r) => r.worked).length} worked · ${rowsAll.filter((r) => !r.worked).length} unworked`));
    list.replaceChildren(...rows.slice(0, 500).map((r) => h("div", { class: `hwrow ${r.worked ? "w" : "u"}` },
      h("div", { class: "hw1" }, h("b", null, r.contactName), " ", hsLink("contact", r.contactId), r.jobTitle ? h("span", { class: "faint" }, ` · ${r.jobTitle}`) : null,
        h("span", { class: `hwcls ${r.cls}` }, r.cls === "hot" ? "Hot" : "Warm"), h("span", { class: `hwst ${r.worked ? "w" : "u"}` }, r.worked ? "Worked" : "Unworked")),
      h("div", { class: "hw2" }, r.companyName ?? "(no company)", " ", r.companyId ? hsLink("company", r.companyId) : null,
        h("span", { class: "faint" }, ` · Company intent: ${r.companyIntent ?? "not set"} · SDR: ${r.sdrName}`)),
      h("div", { class: "hw2 faint" }, `Why ${r.cls === "hot" ? "Hot" : "Warm"}: ${r.evidence}`),
      h("div", { class: "hw2 faint" }, r.events.map((e: any) => `${e.name} (${fmt.day(e.date)}): ${PSTAT[e.participation] ?? e.participation}`).join(" · ")),
      h("div", { class: "hw2 faint" }, r.lastSdrOutreach ? `Last outreach by current SDR: ${fmt.day(r.lastSdrOutreach)}` : "No outreach by the current SDR",
        r.otherSdrTouches ? ` · ${r.otherSdrTouches} touch(es) by an earlier/other SDR (not credited)` : ""))));
  };
  search.addEventListener("input", render);
  for (const el of [wSel, cSel, eSel, sSel]) el.addEventListener("change", render);
  box.replaceChildren(head, h("div", { class: "rectools" }, search, wSel, cSel, eSel, sSel), list);
  render();
}
