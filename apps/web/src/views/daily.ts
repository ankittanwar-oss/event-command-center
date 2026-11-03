import { api } from "../api.js";
import { leadTable } from "../drawer.js";
import { buildHash, filterParams, type Route } from "../state.js";
import { dealPill, fmt, h, hsLink, table, tempPill } from "../ui.js";

// Daily Command Centre: are SDRs working every event account in a timely manner? Live from the synced data.
export async function dailyView(route: Route, meta: any): Promise<HTMLElement> {
  const f = route.filters;
  const grp = route.extra.get("group") ?? "";
  const d = await api("daily", filterParams(f));
  const s = d.summary;
  const sdrName = f.sdr ? d.bySdr.find((x: any) => x.ownerId === f.sdr)?.name : null;
  const go = (patch: Record<string, string>) => { location.hash = buildHash("daily", f, { ...Object.fromEntries(route.extra), ...patch }); };

  const tile = (key: string) => {
    const g = d.groups.find((x: any) => x.key === key);
    return h("button", { class: `htile ${g.cls} ${grp === key ? "sel" : ""}`, onclick: () => go({ group: grp === key ? "" : key }), title: g.hint },
      h("span", { class: "hl" }, g.label), h("span", { class: "hv" }, fmt.n(s.groups[key] ?? 0)), h("span", { class: "hp" }, "accounts"), h("span", { class: "hh" }, g.hint));
  };
  const stat = (v: any, l: string, hint?: string) => h("div", { class: "dstat", title: hint }, h("b", null, v), h("span", null, l));

  const scoreboard = !f.sdr ? h("div", null,
    h("h2", null, "By SDR", h("span", { class: "sub" }, "Click a name to see that SDR's accounts")),
    h("div", { class: "card" }, table<any>([
      { key: "name", label: "SDR", render: (r) => [h("span", { class: "link", onclick: () => { location.hash = buildHash("daily", { ...f, sdr: r.ownerId, region: "" }); } }, r.name), h("span", { class: "faint" }, ` ${r.region}`)] },
      { key: "accounts", label: "Event accounts", num: true },
      { key: "worked", label: "Worked", num: true, render: (r) => `${r.worked} (${r.accounts ? Math.round((r.worked / r.accounts) * 100) : 0}%)` },
      { key: "withinSlaPct", label: "First touch within SLA", num: true, render: (r) => fmt.pct(r.withinSlaPct) },
      { key: "medianDaysToFirst", label: "Median days to 1st touch", num: true, render: (r) => r.medianDaysToFirst ?? "–" },
      { key: "touchedLast7", label: "Touched last 7 days", num: true },
      { key: "respond", label: "Respond now", num: true, sort: (r) => r.groups.respond, render: (r) => r.groups.respond ? h("span", { class: "crit-t strong" }, String(r.groups.respond)) : h("span", { class: "faint" }, "0") },
      { key: "overdue", label: "Overdue", num: true, sort: (r) => r.groups.overdue, render: (r) => r.groups.overdue ? h("span", { class: "crit-t strong" }, String(r.groups.overdue)) : h("span", { class: "faint" }, "0") },
      { key: "stalled", label: "Stalled", num: true, sort: (r) => r.groups.stalled, render: (r) => r.groups.stalled ? h("span", { class: "crit-t" }, String(r.groups.stalled)) : h("span", { class: "faint" }, "0") },
      { key: "due", label: "Due now", num: true, sort: (r) => r.groups.due, render: (r) => r.groups.due ? h("span", { class: "warnr-t" }, String(r.groups.due)) : h("span", { class: "faint" }, "0") },
    ], d.bySdr, { initialSort: "overdue", rowClass: (r) => (r.groups.respond || r.groups.overdue ? "row-crit" : "") }))) : null;

  const list = d.accounts.filter((a: any) => !grp || a.group === grp);
  const groupsShown = d.groups.filter((g: any) => list.some((a: any) => a.group === g.key));
  const acctRow = (a: any) => {
    const el = h("div", { class: `drow ${d.groups.find((g: any) => g.key === a.group).cls}` });
    const body = h("div", { class: "dcontacts" });
    let loaded = false;
    const sla = a.firstTouch ? `${a.businessDaysToFirstTouch ?? "–"} bd to 1st${a.firstTouchWithinSla === false ? " · SLA missed" : ""}` : a.firstTouchWithinSla === false ? "Never touched · SLA missed" : "Not touched yet";
    el.append(
      h("div", { class: "dmain", onclick: () => { el.classList.toggle("open"); if (!loaded) { loaded = true; body.replaceChildren(leadTable(a.contacts)); } } },
        h("div", { class: "dacct" }, h("b", null, a.companyName ?? "(no company)"), hsLink("company", a.companyId), " ", tempPill(a.temperature),
          h("div", { class: "faint small" }, [a.icpTier, a.sdrName, a.events.length === 1 ? `${a.events[0].name}` : `${a.events.length} events`].filter(Boolean).join(" · "))),
        h("div", { class: "dnext" }, h("b", null, a.nextAction), a.lastReply ? h("div", { class: "crit-t small" }, `Replied ${fmt.day(a.lastReply)}`) : null),
        h("div", { class: "dwhen" }, h("div", { class: a.firstTouchWithinSla === false ? "crit-t" : "" }, sla), h("div", { class: "faint small" }, `Eligible ${fmt.day(a.eligibleSince)}`)),
        h("div", { class: "dlast" }, a.lastTouch ? [h("div", null, fmt.day(a.lastTouch)), h("div", { class: "faint small" }, `${a.daysSinceLast}d ago`)] : h("span", { class: "faint" }, "Never")),
        h("div", { class: "dtouch" }, h("b", null, String(a.touches)), h("div", { class: "faint small" }, `${a.contactsWorked}/${a.eligibleContacts} contacts`)),
        h("div", { class: "ddeal" }, a.dealStatus && a.dealStatus !== "none" ? dealPill(a.dealStatus) : null)),
      body);
    return el;
  };

  return h("div", null,
    h("div", { class: "dlive" }, h("span", { class: "dot" }), `Live from HubSpot · last sync ${fmt.ago(meta?.freshness?.lastSuccessAt)} · refreshes every 2 hours automatically`),
    h("h2", { style: "margin-top:4px" }, sdrName ? `${sdrName}: event accounts` : "All SDRs: event accounts", h("span", { class: "sub" }, `${d.filters.quarterLabel} · eligible Hot and Warm event accounts`)),
    h("div", { class: "htiles" }, ["respond", "overdue", "stalled", "due"].map(tile)),
    h("div", { class: "dstats card" },
      stat(fmt.n(s.accounts), "event accounts", `${s.hot} Hot`),
      stat(`${fmt.n(s.worked)} (${s.accounts ? Math.round((s.worked / s.accounts) * 100) : 0}%)`, "worked at least once"),
      stat(fmt.pct(s.withinSlaPct), "first touch within SLA"),
      stat(s.medianDaysToFirst ?? "–", "median business days to 1st touch"),
      stat(fmt.n(s.touchedLast7), "touched in the last 7 days"),
      stat(fmt.n(s.groups.ontrack), "on track"), stat(fmt.n(s.groups.inplay), "in play"), stat(fmt.n(s.groups.notdue), "not yet due")),
    scoreboard,
    h("h2", null, "Work queue", h("span", { class: "sub" }, `${fmt.n(list.length)} accounts${grp ? ` · ${d.groups.find((g: any) => g.key === grp).label}` : ""} · most urgent first · click an account for its contacts`),
      grp ? h("span", { class: "link", style: "font-size:12px;cursor:pointer", onclick: () => go({ group: "" }) }, "Show all") : null),
    h("div", { class: "dhead-row" }, h("span", null, "Account"), h("span", null, "Next action"), h("span", null, "First touch"), h("span", null, "Last touch"), h("span", null, "Touches"), h("span")),
    list.length ? groupsShown.map((g: any) => [
      h("div", { class: `dgroup ${g.cls}` }, h("b", null, g.label), h("span", { class: "faint" }, ` ${list.filter((a: any) => a.group === g.key).length} · ${g.hint}`)),
      h("div", { class: "card" }, list.filter((a: any) => a.group === g.key).slice(0, 300).map(acctRow)),
    ]) : h("div", { class: "empty" }, "No event accounts match the filters."),
  );
}
