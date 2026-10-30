import { api } from "../api.js";
import { leadTable, openCustom, openLeads } from "../drawer.js";
import { buildHash, filterParams, type Route } from "../state.js";
import { fmt, h, riskBar, table, type Col } from "../ui.js";

export async function eventsView(route: Route): Promise<HTMLElement> {
  const f = route.filters;
  const d = await api("events", filterParams(f));
  const tab = route.extra.get("tab") || d.groups[0]?.category || "owned";
  const phase = route.extra.get("phase") || "post";
  const g = d.groups.find((x: any) => x.category === tab);
  const ev = (r: any, bucket: string, label: string | number) =>
    h("span", { class: "link", onclick: () => openLeads({ ...f, eventId: r.eventId, quarter: "all" }, bucket) }, String(label));

  const nameCol: Col<any> = {
    key: "name", label: "Event", wrap: true,
    render: (r) => h("span", { class: "link", onclick: () => openEvent(r.eventId, r.name) }, r.name),
  };

  const pre: Col<any>[] = [
    nameCol,
    { key: "date", label: "Date", render: (r) => fmt.day(r.date) },
    { key: "registered", label: "Registered", num: true, render: (r) => ev(r, "registered", r.registered) },
    { key: "targetable", label: "Targetable ICP", num: true },
    { key: "sdrAssigned", label: "SDR assigned", num: true },
    { key: "preEventOutreach", label: "Pre-event outreach", num: true, title: "Registrants with a qualifying SDR touch in the 30 days before the event" },
    { key: "unworkedPriority", label: "Priority accounts not yet worked", num: true, title: "Tier 1A/1/2 with an assigned SDR and no pre-event touch" },
    { key: "existingConversations", label: "Existing conversations", num: true },
    { key: "tiers", label: "ICP mix", wrap: true, sort: (r) => r.registered, render: (r) => Object.entries(r.tierCounts).sort((a: any, b: any) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k}: ${v}`).join(" · ") },
  ];

  const post: Col<any>[] = [
    nameCol,
    { key: "date", label: "Date", render: (r) => fmt.day(r.date) },
    { key: "registered", label: "Registered", num: true, render: (r) => ev(r, "registered", r.registered) },
    { key: "attended", label: "Attended", num: true, render: (r) => r.attendanceRate === null ? h("span", { class: "faint", title: "No attendance recorded in HubSpot for this event" }, "not recorded") : [ev(r, "attended", r.attended), h("span", { class: "faint" }, ` ${fmt.pct(r.attendanceRate)}`), r.attendanceSuspect ? h("span", { class: "pill bad", title: "Every registrant is marked attended – check the attendance upload" }, " check") : null] },
    { key: "eligibleHot", label: "Hot", num: true, render: (r) => r.eligibleHot ? h("span", { class: "link", onclick: () => openLeads({ ...f, eventId: r.eventId, quarter: "all", temperature: "Hot" }, "eligible") }, `${r.hotWorked}/${r.eligibleHot}`) : "0", sort: (r) => r.eligibleHot, title: "Worked / eligible" },
    { key: "eligibleWarm", label: "Warm", num: true, render: (r) => r.eligibleWarm ? h("span", { class: "link", onclick: () => openLeads({ ...f, eventId: r.eventId, quarter: "all", temperature: "Warm" }, "eligible") }, `${r.warmWorked}/${r.eligibleWarm}`) : "0", sort: (r) => r.eligibleWarm, title: "Worked / eligible" },
    { key: "coverage", label: "Coverage", num: true, render: (r) => fmt.pct(r.coverage) },
    { key: "health", label: "Follow-up health", sort: (r) => r.risk?.critical ?? 0, title: "Critical / at risk / healthy / not yet due among eligible leads",
      render: (r) => r.risk?.eligible ? h("div", { class: "cbar left" }, riskBar(r.risk, (l) => openLeads({ ...f, eventId: r.eventId, quarter: "all" }, `risk_${l}`)),
        r.risk.critical ? h("span", { class: "link crit-t strong", onclick: () => openLeads({ ...f, eventId: r.eventId, quarter: "all" }, "risk_critical") }, `▲ ${r.risk.critical}`) : null) : h("span", { class: "faint" }, "–") },
    { key: "avgTouches", label: "Avg touches", num: true, render: (r) => fmt.dec(r.avgTouches) },
    { key: "slaBreaches", label: "SLA missed", num: true, render: (r) => r.slaBreaches ? h("span", { class: "crit-t" }, ev(r, "sla_missed", r.slaBreaches)) : h("span", { class: "faint" }, "0") },
    { key: "neverWorked", label: "Never worked", num: true, render: (r) => r.neverWorked ? ev(r, "never_worked", r.neverWorked) : "0" },
    { key: "stalled", label: "Stalled", num: true, render: (r) => r.stalled ? h("span", { class: "crit-t" }, ev(r, "stalled", r.stalled)) : h("span", { class: "faint" }, "0") },
    { key: "multiWeek", label: "Multi-week", num: true },
    { key: "opportunities", label: "MQLs", num: true, title: "Deals whose MQL date is within 90 days after the event" },
    { key: "sqls", label: "SQLs", num: true, title: "Deals whose SQL date is within 90 days after the event, excluding deals that were already MQL before the event" },
  ];

  const tabs = h("div", { class: "tabs" }, d.groups.map((x: any) => h("button", {
    class: x.category === tab ? "on" : "", onclick: () => { location.hash = buildHash("events", f, { tab: x.category, phase }); },
  }, `${x.label} · ${x.upcoming.length + x.past.length}`)));
  const phases = h("div", { class: "chips" },
    h("button", { class: phase === "pre" ? "on" : "", onclick: () => { location.hash = buildHash("events", f, { tab, phase: "pre" }); } }, `Pre-event · ${g?.upcoming.length ?? 0} upcoming`),
    h("button", { class: phase === "post" ? "on" : "", onclick: () => { location.hash = buildHash("events", f, { tab, phase: "post" }); } }, `Post-event · ${g?.past.length ?? 0} completed`));

  return h("div", null,
    h("h2", null, "Event operations", h("span", { class: "sub" }, "Owned, sponsored, webinars and roundtables · each event counted in one category")),
    tabs, phases,
    !g ? h("div", { class: "empty" }, "No events match the filters") :
      h("div", { class: "card" }, phase === "pre"
        ? table(pre, g.upcoming, { initialSort: "date", desc: false, empty: "No upcoming events in this period. Choose “All quarters” or a later quarter to plan ahead." })
        : table(post, g.past, { initialSort: "date", empty: "No completed events in this period", rowClass: (r) => (r.risk?.critical ? "row-crit" : "") })),
    tab === "sponsored" ? h("p", { class: "legend" }, "Sponsored events: only attendees (or contacts with a prior conversation) are eligible for follow-up. Registrants without recorded attendance are excluded.") : null,
  );
}

async function openEvent(id: string, name: string) {
  const d = await api(`events/${id}`);
  const s = d.summary;
  const box = h("div", null,
    h("div", { class: "kv" },
      ...[["Date", fmt.day(s.date)], ["Category", s.category], ["Registered", s.registered], ["Attended", s.attendanceRate === null ? "Not recorded" : `${s.attended} (${fmt.pct(s.attendanceRate)})`],
        ["Eligible hot / warm", `${s.eligibleHot} / ${s.eligibleWarm}`], ["Coverage", fmt.pct(s.coverage)], ["MQLs / SQLs (≤90 days)", `${s.opportunities} / ${s.sqls}`]]
        .flatMap(([k, v]) => [h("div", { class: "k" }, String(k)), h("div", null, String(v))]),
      d.risk?.eligible ? [h("div", { class: "k" }, "Follow-up health"), h("div", { class: "kvbar" }, riskBar(d.risk),
        `▲ ${d.risk.critical} critical · ◆ ${d.risk.at_risk} at risk · ● ${d.risk.healthy} healthy · ○ ${d.risk.neutral} not yet due`)] : null),
    leadTable(d.leads));
  openCustom(name, "All registrants, eligible and not", box);
}
