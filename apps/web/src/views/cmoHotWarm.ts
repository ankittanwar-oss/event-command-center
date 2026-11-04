import { api } from "../api.js";
import { openCustom } from "../drawer.js";
import { buildHash, filterParams, type Route } from "../state.js";
import { fmt, h, hsLink } from "../ui.js";

// CMO executive view: Hot & Warm event-lead coverage (contact level). All numbers come from /api/cmo-hotwarm and every
// number opens /api/cmo-hotwarm-drill with the same filters, so the list always matches the count.

const PART_LABEL: Record<string, string> = { "": "All eligible contacts", attended: "Verified attendees", registered: "Registered only", unknown: "Attendance unknown", sponsored_list: "Sponsored-event list only" };
const PSTAT: Record<string, string> = { attended: "Attended (check-in or organiser list)", registered: "Registered only", unknown: "Attendance unknown", sponsored_list: "On sponsored-event list (not verified)", no_show: "Confirmed no-show" };
const METRIC_LABEL: Record<string, string> = {
  hot_total: "Hot contacts", hot_worked: "Hot contacts worked", hot_unworked: "Hot leads to target", hot_cov: "Hot contacts (worked and unworked)",
  warm_total: "Warm contacts", warm_worked: "Warm contacts worked", warm_unworked: "Warm leads to target", warm_cov: "Warm contacts (worked and unworked)",
  unworked: "Leads to target", total: "Hot/Warm leads",
};

export async function hotWarmSection(route: Route): Promise<HTMLElement> {
  const f = route.filters;
  const part = route.extra.get("part") ?? "";
  const olist = route.extra.get("olist") ?? "";
  const d = await api("cmo-hotwarm", { ...filterParams(f), part, olist });
  const T = d.thresholds ?? { green: 80, amber: 50 };
  const cls = (v: number | null) => (v === null ? "cv-na" : v >= T.green ? "cv-g" : v >= T.amber ? "cv-a" : "cv-r");
  const go = (patch: Record<string, string>) => { location.hash = buildHash(route.view, f, { ...Object.fromEntries(route.extra), ...patch }); };
  const drill = (scope: string, id: string, metric: string, name: string) => () => openDrill(f, part, olist, scope, id, metric, name);

  const num = (n: number, scope: string, id: string, metric: string, name: string) =>
    h("td", { class: "n hwn" }, n ? h("span", { class: "link", onclick: drill(scope, id, metric, name) }, fmt.n(n)) : h("span", { class: "faint" }, "0"));
  // Simple executive row: Leads (Hot · Warm on hover/click) · Worked · Unworked · Coverage (the only coloured cell).
  const leads = (r: any, scope: string, id: string, name: string) => h("td", { class: "n hwn", title: `${r.hotTotal} Hot · ${r.warmTotal} Warm` },
    r.total ? [h("span", { class: "link", onclick: drill(scope, id, "total", name) }, fmt.n(r.total)),
      h("div", { class: "hwsplit" }, h("span", { class: "link", onclick: drill(scope, id, "hot_total", name) }, `${r.hotTotal} Hot`), " · ", h("span", { class: "link", onclick: drill(scope, id, "warm_total", name) }, `${r.warmTotal} Warm`))] : h("span", { class: "faint" }, "0"));
  const cov = (r: any, scope: string, id: string, name: string) =>
    h("td", { class: `n hwc ${cls(r.total ? r.coverage : null)}`, title: r.total ? `Hot ${r.hotCoverage ?? "N/A"}% · Warm ${r.warmCoverage ?? "N/A"}%` : "No leads: not measurable" },
      r.total ? h("span", { class: "link", onclick: drill(scope, id, "cov", name) }, `${Math.round(r.coverage ?? 0)}%`) : "N/A");
  const row = (r: any, scope: string, id: string, name: any, label: string, total = false) => h("tr", { class: total ? "hwtot" : "" },
    h("td", { class: "hwname" }, name), leads(r, scope, id, label), num(r.worked, scope, id, "worked", label), num(r.unworked, scope, id, "unworked", label), cov(r, scope, id, label));
  const head = (first: string) => h("thead", null, h("tr", null, h("th", null, first),
    h("th", { class: "n", title: "People with a documented conversation (Hot) or who attended (Warm). Not the company's intent." }, "Hot/Warm leads"),
    h("th", { class: "n" }, "Worked"), h("th", { class: "n" }, "To target"), h("th", { class: "n" }, "Coverage")));

  // ---- event table (ALL EVENTS pinned; default sort: most unworked Hot, then Warm)
  const esort = route.extra.get("esort") ?? "gap";
  const evs: any[] = [...d.events];
  const lowCov = (e: any) => (e.total ? e.coverage : 101);
  evs.sort((a, b) => esort === "date" ? (b.date ?? "").localeCompare(a.date ?? "")
    : esort === "hot" ? b.hotTotal - a.hotTotal : esort === "warm" ? b.warmTotal - a.warmTotal
    : esort === "hotcov" ? (a.hotTotal ? a.hotCoverage : 101) - (b.hotTotal ? b.hotCoverage : 101)
    : esort === "warmcov" ? (a.warmTotal ? a.warmCoverage : 101) - (b.warmTotal ? b.warmCoverage : 101)
    : esort === "unworked" ? b.unworked - a.unworked : esort === "lowest" ? lowCov(a) - lowCov(b)
    : b.unworked - a.unworked || b.hotUnworked - a.hotUnworked);
  const sel = (key: string, cur: string, opts: Array<[string, string]>) => h("select", { class: "hwsel", onchange: (e: Event) => go({ [key]: (e.target as HTMLSelectElement).value }) },
    opts.map(([v, l]) => { const o = h("option", { value: v }, l) as HTMLOptionElement; if (v === cur) o.selected = true; return o; }));
  const legend = h("div", { class: "hwlegend" }, h("span", { class: "sw cv-g" }), ` ${T.green}%+ worked `, h("span", { class: "sw cv-a" }), ` ${T.amber}–${T.green - 1}% `, h("span", { class: "sw cv-r" }), ` below ${T.amber}% `, h("span", { class: "sw cv-na" }), " not measurable");
  // ---- 1. Snapshot: six solid blocks, number + short label only (unique contacts across all events).
  const A = d.all;
  const block = (n: number, label: string, tone: string, metric: string) => h("div", { class: `kblock ${tone}`, onclick: n ? drill("all", "", metric, "All events") : undefined }, h("div", { class: "kbn" }, fmt.n(n)), h("div", { class: "kbl" }, label));
  const snapshot = h("section", { class: "kgrid" },
    block(A.hotTotal, "Total Hot", "tot hot", "hot_total"), block(A.hotWorked, "Hot worked", "ok", "hot_worked"), block(A.hotUnworked, "Hot to target", "bad", "hot_unworked"),
    block(A.warmTotal, "Total Warm", "tot warm", "warm_total"), block(A.warmWorked, "Warm worked", "ok", "warm_worked"), block(A.warmUnworked, "Warm to target", "bad", "warm_unworked"));

  // ---- 2. Event summary: one clean row per event; click a row for the lead list.
  const pct = (v: number | null, n: number) => (n ? h("span", { class: `pc ${cls(v)}` }, `${Math.round(v ?? 0)}%`) : h("span", { class: "faint" }, "–"));
  const eventTable = h("section", { class: "card hwcard" },
    h("div", { class: "hwh" }, h("h2", null, "By event"),
      h("div", { class: "hwctl" }, sel("esort", esort, [["gap", "Most unworked"], ["lowest", "Lowest coverage"], ["hot", "Most Hot"], ["warm", "Most Warm"], ["date", "Newest event"]]))),
    h("div", { class: "tbl-wrap" }, h("table", { class: "hwtable simple" },
      h("thead", null, h("tr", null, h("th", null, "Event"), h("th", { class: "n" }, "Hot"), h("th", { class: "n" }, "Hot worked"), h("th", { class: "n" }, "Warm"), h("th", { class: "n" }, "Warm worked"), h("th", { class: "n" }, "To target"))),
      ...[["Our events (check-ins)", evs.filter((e) => e.category !== "sponsored")], ["Conferences (organiser attendee lists)", evs.filter((e) => e.category === "sponsored")]]
        .filter(([, l]) => (l as any[]).length).map(([title, l]) => h("tbody", null,
          h("tr", { class: "grprow" }, h("td", { colspan: "6" }, title as string)),
          (l as any[]).map((e) => h("tr", { class: "clickrow", onclick: drill("event", e.eventId, "total", e.name) },
            h("td", null, e.name), h("td", { class: "n" }, fmt.n(e.hotTotal)), h("td", { class: "n" }, pct(e.hotCoverage, e.hotTotal)),
            h("td", { class: "n" }, fmt.n(e.warmTotal)), h("td", { class: "n" }, pct(e.warmCoverage, e.warmTotal)), h("td", { class: "n b" }, fmt.n(e.unworked)))))))),
    h("div", { class: "hwfoot faint" }, "Click an event to see its leads. Top blocks count each person once; event rows can overlap."));

  // ---- SDR table (ALL SDRs pinned; current Company SDR Owner)
  const ssort = route.extra.get("ssort") ?? "gap";
  const sdrs: any[] = [...d.sdrs];
  sdrs.sort((a, b) => ssort === "cov" ? lowCov(a) - lowCov(b) : b.unworked - a.unworked || b.hotUnworked - a.hotUnworked);
  const sdrTable = h("section", { class: "card hwcard" },
    h("div", { class: "hwh" }, h("div", null, h("h2", null, "Hot & Warm Coverage by SDR"), h("div", { class: "hwsub" }, "Are we following up with the high-priority leads assigned to each SDR?")),
      h("div", { class: "hwctl" }, sel("ssort", ssort, [["gap", "Sort: most unworked"], ["cov", "Lowest coverage"]]))),
    h("div", { class: "tbl-wrap" }, h("table", { class: "hwtable" }, head("SDR (current HubSpot owner)"),
      h("tbody", null, row(d.all, "all", "", "ALL SDRs", "All SDRs", true), sdrs.map((s) => row(s, "sdr", s.ownerId, s.name, s.name))))),
    h("div", { class: "hwfoot" }, legend, h("div", { class: "faint" }, "Owner = current Company SDR Owner in HubSpot. Worked = outreach by that current SDR; earlier owners' outreach is visible in the drill-down but not credited.")));

  const gaps = h("section", { class: "card hwcard hwgaps" }, h("h2", null, "Where we're leaving opportunities behind"),
    d.gaps.length ? h("ul", null, d.gaps.map((g: any) => h("li", null, h("span", { class: "link", onclick: drill(g.scope, g.id, g.metric, g.text) }, g.text)))) : h("div", { class: "faint" }, "No material gaps in this view."));

  const defs = h("details", { class: "hwdefs" }, h("summary", null, "How Hot, Warm and Worked are defined"),
    h("ul", null, Object.values(d.definitions).map((t: any) => h("li", null, t))));
  return h("div", null, h("div", { class: "kbar" }, h("span", { class: "faint" }, "Showing: "), sel("olist", olist, [["", "All attendees"], ["ours", "Our events only"], ["lists", "Conference lists only"], ["icp", "Conference lists: ICP-fit accounts only"]])), snapshot, eventTable, sdrTable, gaps, defs);
}

async function openDrill(f: any, part: string, olist: string, scope: string, id: string, metric: string, name: string) {
  const box = h("div", { class: "apanel" }, h("div", { class: "loading" }, "Loading…"));
  openCustom(`${name}: ${METRIC_LABEL[metric] ?? metric}`, "Exact records behind the number, with the dashboard filters applied", box);
  let d: any;
  try { d = await api("cmo-hotwarm-drill", { ...filterParams(f), part, olist, scope, id, metric }); } catch (e) { box.replaceChildren(h("div", { class: "banner warn" }, (e as Error).message)); return; }
  const rowsAll: any[] = d.rows;
  const search = h("input", { type: "search", placeholder: "Search person, company or event" }) as HTMLInputElement;
  const opt = (pairs: Array<[string, string]>) => pairs.map(([v, l]) => h("option", { value: v }, l));
  const evs = new Map<string, string>(); const sdrsSet = new Set<string>();
  for (const r of rowsAll) { sdrsSet.add(r.sdrName); for (const e of r.events) evs.set(e.id, `${e.name} · ${fmt.day(e.date)}`); }
  const wSel = h("select", null, opt([["", "Worked and unworked"], ["n", "Good leads to target"], ["y", "Worked"]])) as HTMLSelectElement;
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
    const nice = (v: string | null) => (v ? v.toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "–");
    const partOf = (e: any) => (e.participation === "attended" ? "Attended" : e.participation === "registered" ? "Registered" : PSTAT[e.participation] ?? "Unknown");
    const groups = new Map<string, { name: string; date: string | null; items: Array<{ r: any; e: any }> }>();
    for (const r of rows) for (const e of r.events) {
      if (eSel.value && e.id !== eSel.value) continue;
      const g = groups.get(e.id) ?? { name: e.name, date: e.date, items: [] as Array<{ r: any; e: any }> }; g.items.push({ r, e }); groups.set(e.id, g);
    }
    const gl = [...groups.values()].sort((x, y) => y.items.filter((i) => !i.r.worked).length - x.items.filter((i) => !i.r.worked).length);
    list.replaceChildren(...gl.map((g, i) => {
      const un = g.items.filter((x) => !x.r.worked).length;
      const det = h("details", { class: "evgrp" }, h("summary", null, h("b", null, g.name), h("span", { class: "faint" }, ` · ${g.items.length} leads · `), h("span", { class: un ? "unw" : "faint" }, `${un} to target`)),
        ...[["Good leads to target", g.items.filter((x) => !x.r.worked)], ["Already worked", g.items.filter((x) => x.r.worked)]].filter(([, l]) => (l as any[]).length).flatMap(([t, l]) => [
          h("div", { class: `subhd ${t === "Already worked" ? "done" : "go"}` }, `${t} (${(l as any[]).length})`),
          ...(l as Array<{ r: any; e: any }>).map(({ r, e }) => h("div", { class: `lead ${r.worked ? "w" : "t"}` },
          h("div", { class: "l1" }, redactBox(r), h("b", null, r.contactName), h("span", { class: `hwcls ${r.cls}` }, r.cls === "hot" ? "Hot" : "Warm"),
            r.worked ? h("span", { class: "hwst w" }, r.workedByOther ? `Worked by ${r.workedByOther.by}` : "Worked") : null, h("span", { class: "sp" }), hsLink("contact", r.contactId)),
          h("div", { class: "l2" }, `${r.companyName ?? "No company"} · Account intent: ${r.companyIntent ?? "–"} · Status: ${nice(r.contactStatus)}`),
          r.sheetNotes?.length ? h("div", { class: "l2 snote" }, `Sheet note: ${r.sheetNotes.join(" · ")}`) : null,
          r.workedByOther ? h("div", { class: "l2 byo" }, r.workedByOther.sameContact ? `${r.workedByOther.by} reached out to this person on ${fmt.day(r.workedByOther.at)}` : `Account being worked: ${r.workedByOther.by} contacted ${r.workedByOther.contactName ?? "a colleague"} at this company on ${fmt.day(r.workedByOther.at)}`) : null,
          h("div", { class: "l2 faint" }, `${partOf(e)} · Last contacted: ${r.lastContacted ? fmt.day(r.lastContacted) : "Never"} · Owner: ${r.sdrName}`)))]));
      if (gl.length === 1 || i === 0) (det as HTMLDetailsElement).open = true;
      return det;
    }));
  };
  search.addEventListener("input", render);
  for (const el of [wSel, cSel, eSel, sSel]) el.addEventListener("change", render);
  box.replaceChildren(head, h("div", { class: "rectools" }, search, wSel, cSel, eSel, sSel), list);
  render();
}

/** Checkbox in front of every lead: tick = hide this lead (wrong / irrelevant). It moves to the Redacted leads tab. */
function redactBox(r: any) {
  const cb = h("input", { type: "checkbox", class: "redact", title: "Hide this lead (wrong or irrelevant). It moves to Redacted leads." }) as HTMLInputElement;
  cb.addEventListener("change", async () => {
    if (!cb.checked) return;
    const reason = prompt(`Hide ${r.contactName}? Optional reason (e.g. wrong person, not a fit):`, "");
    if (reason === null) { cb.checked = false; return; }
    const card = cb.closest(".lead") as HTMLElement | null;
    try {
      await api("redactions", undefined, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactId: r.contactId, contactName: r.contactName, companyName: r.companyName, events: r.events.map((e: any) => e.name).join(", "), reason }) });
      if (card) { card.classList.add("gone"); setTimeout(() => card.remove(), 250); }
    } catch (e) { cb.checked = false; alert((e as Error).message); }
  });
  return cb;
}
