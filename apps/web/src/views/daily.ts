import { api } from "../api.js";
import { leadTable } from "../drawer.js";
import { buildHash, filterParams, type Route } from "../state.js";
import { fmt, h, hsLink, table, tempPill } from "../ui.js";

// Daily Command Centre: is every event account being worked on time? Three colours, minimal text.
//   green = reached out on time · amber = awaiting outreach / late / gone quiet · red = not reached out (SLA missed)
const COLORS = [
  { key: "red", label: "Not reached out", hint: "No SDR touch and the first-touch SLA has passed, or a prospect reply is waiting" },
  { key: "amber", label: "Awaiting outreach", hint: "First touch still inside the SLA, or reached out late, or gone quiet" },
  { key: "green", label: "Reached out on time", hint: "First SDR touch within the SLA and still being worked" },
] as const;

export async function dailyView(route: Route, meta: any): Promise<HTMLElement> {
  const f = route.filters;
  const col = route.extra.get("color") ?? "";
  const d = await api("daily", filterParams(f));
  const s = d.summary;
  const go = (patch: Record<string, string>) => { location.hash = buildHash("daily", f, { ...Object.fromEntries(route.extra), ...patch }); };
  const pct = (n: number) => (s.accounts ? `${Math.round((n / s.accounts) * 100)}%` : "–");

  const tiles = h("div", { class: "ctiles" }, COLORS.map((c) =>
    h("button", { class: `ctile ${c.key} ${col === c.key ? "sel" : ""}`, title: c.hint, onclick: () => go({ color: col === c.key ? "" : c.key }) },
      h("span", { class: "cv" }, fmt.n(s[c.key])), h("span", { class: "cl" }, c.label), h("span", { class: "cp" }, `${pct(s[c.key])} of ${fmt.n(s.accounts)} accounts`))));

  const bar = h("div", { class: "cbar3" }, COLORS.map((c) => s[c.key] ? h("span", { class: c.key, style: `flex:${s[c.key]}`, title: `${c.label}: ${s[c.key]}` }) : null));

  const scoreboard = !f.sdr ? h("div", { class: "card", style: "margin-top:14px" }, table<any>([
    { key: "name", label: "SDR", render: (r) => h("span", { class: "link", onclick: () => { location.hash = buildHash("daily", { ...f, sdr: r.ownerId, region: "" }); } }, r.name) },
    { key: "accounts", label: "Accounts", num: true },
    { key: "red", label: "Not reached out", num: true, render: (r) => r.red ? h("span", { class: "crit-t strong" }, String(r.red)) : h("span", { class: "faint" }, "0") },
    { key: "amber", label: "Awaiting", num: true, render: (r) => r.amber ? h("span", { class: "warnr-t strong" }, String(r.amber)) : h("span", { class: "faint" }, "0") },
    { key: "green", label: "On time", num: true, render: (r) => r.green ? h("span", { class: "ok-t strong" }, String(r.green)) : h("span", { class: "faint" }, "0") },
    { key: "mix", label: "", sort: (r) => (r.accounts ? r.red / r.accounts : 0), render: (r) => h("div", { class: "cbar3 mini" },
      ["red", "amber", "green"].map((k) => r[k] ? h("span", { class: k, style: `flex:${r[k]}` }) : null)) },
  ], d.bySdr, { initialSort: "red", rowClass: (r) => (r.red ? "row-crit" : "") })) : null;

  const list = d.accounts.filter((a: any) => !col || a.color === col);
  const row = (a: any) => {
    const el = h("div", { class: `crow ${a.color}` });
    const body = h("div", { class: "dcontacts" });
    let loaded = false;
    const first = a.firstTouch ? `1st touch day ${a.businessDaysToFirstTouch ?? "–"}` : "No touch yet";
    el.append(
      h("div", { class: "cmain", onclick: () => { el.classList.toggle("open"); if (!loaded) { loaded = true; body.replaceChildren(leadTable(a.contacts)); } } },
        h("span", { class: "cdot" }),
        h("span", { class: "cname" }, h("b", null, a.companyName ?? "(no company)"), hsLink("company", a.companyId)),
        tempPill(a.temperature),
        !f.sdr ? h("span", { class: "csdr" }, a.sdrName ?? "–") : null,
        h("span", { class: `cstate ${a.color}` }, a.colorLabel),
        h("span", { class: "cmeta" }, first),
        h("span", { class: "cmeta" }, a.lastTouch ? `last ${a.daysSinceLast}d ago` : ""),
        h("span", { class: "cmeta" }, a.dealStatus === "open" ? "open opp" : "")),
      body);
    return el;
  };

  return h("div", null,
    h("div", { class: "dlive" }, h("span", { class: "dot" }), `Live from HubSpot · synced ${fmt.ago(meta?.freshness?.lastSuccessAt)} · updates every 2 hours`),
    tiles, bar,
    scoreboard,
    h("h2", null, col ? COLORS.find((c) => c.key === col)!.label : "All event accounts", h("span", { class: "sub" }, `${fmt.n(list.length)} · red first · click for contacts`),
      col ? h("span", { class: "link", style: "font-size:12px;cursor:pointer", onclick: () => go({ color: "" }) }, "Show all") : null),
    list.length ? h("div", { class: "card" }, list.slice(0, 600).map(row)) : h("div", { class: "empty" }, "No event accounts match the filters."),
  );
}
