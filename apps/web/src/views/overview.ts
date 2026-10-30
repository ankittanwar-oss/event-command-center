import { api } from "../api.js";
import { openLeads } from "../drawer.js";
import { filterParams, type Route } from "../state.js";
import { bar, delta, fmt, h, table, type Col } from "../ui.js";

export async function overviewView(route: Route): Promise<HTMLElement> {
  const f = route.filters;
  const d = await api("overview", filterParams(f));
  const open = (bucket: string, temperature?: string, extra: Record<string, string> = {}) =>
    openLeads(temperature ? { ...f, temperature } : f, bucket, extra);

  const tempCol = (t: any) => {
    const cls = t.temperature === "Hot" ? "hot" : "warm";
    const row = (label: string, hint: string, m: any) => [
      h("div", { class: "lab click", onclick: () => open(m.bucket, t.temperature) }, label, h("small", null, hint)),
      h("div", { class: "num click", onclick: () => open(m.bucket, t.temperature) }, fmt.n(m.count)),
      h("div", { class: "pct" }, fmt.pct(m.pct)),
    ];
    return h("div", { class: "card temp-col" },
      h("div", { class: "hd" }, h("span", { class: `pill ${cls}` }, t.temperature), h("span", { class: "t" }, `${t.temperature} leads`),
        h("span", { class: "muted", style: "margin-left:auto" }, `${fmt.n(t.uniqueContacts)} unique contacts`)),
      h("div", { class: "bd" },
        h("div", { class: "big" },
          h("div", { class: "kpi", onclick: () => open("eligible", t.temperature) }, h("span", { class: "v" }, fmt.n(t.eligible)), h("span", { class: "l" }, "Eligible")),
          h("div", { class: "kpi", onclick: () => open("worked", t.temperature) }, h("span", { class: "v" }, fmt.pct(t.worked.pct)), h("span", { class: "l" }, `Coverage · ${fmt.n(t.worked.count)} worked`)),
          h("div", { class: "kpi", onclick: () => open("overdue", t.temperature) }, h("span", { class: "v" }, fmt.n(t.overdue.count)), h("span", { class: "l" }, "First touch overdue"))),
        h("div", { class: "rows" },
          row("Never worked", "No qualifying touch since eligibility", t.neverWorked),
          row("Insufficient follow-up", "Touched, but below the expected cadence for its age", t.insufficient),
          row("Follow-up stalled", "No touch beyond the stall threshold", t.stalled),
          row("Actively worked", "Meeting cadence across multiple weeks", t.active),
          row("Completed / in play", "Meeting, reply, open deal or disqualified", t.inPlay),
          row("Unable to verify", "Outreach logged on the company, not the contact", t.unverifiable),
        )));
  };

  const cmp = d.comparison;
  const cmpCard = cmp ? h("div", { class: "card" },
    h("div", { class: "hd" }, h("span", { class: "t" }, "Versus previous quarter"), h("span", { class: "muted" }, `${cmp.previous.label}${cmp.previous.complete ? "" : " (in progress)"}`)),
    table<any>([
      { key: "m", label: "Metric" },
      { key: "c", label: "This quarter", num: true },
      { key: "p", label: "Previous", num: true },
      { key: "d", label: "Change", num: true, render: (r) => r.d },
    ], [
      { m: "Eligible leads", c: fmt.n(cmp.current.eligible), p: fmt.n(cmp.previous.eligible), d: delta(cmp.current.eligible, cmp.previous.eligible, "") },
      { m: "Coverage (≥1 touch)", c: fmt.pct(cmp.current.coverage), p: fmt.pct(cmp.previous.coverage), d: delta(cmp.current.coverage, cmp.previous.coverage) },
      { m: "First-touch SLA met", c: fmt.pct(cmp.current.slaCompliance), p: fmt.pct(cmp.previous.slaCompliance), d: delta(cmp.current.slaCompliance, cmp.previous.slaCompliance) },
      { m: "Avg touches, first 30 days*", c: fmt.dec(cmp.current.avgTouchesFirst30), p: fmt.dec(cmp.previous.avgTouchesFirst30), d: delta(cmp.current.avgTouchesFirst30, cmp.previous.avgTouchesFirst30, "") },
      { m: "Multi-week follow-up*", c: fmt.pct(cmp.current.multiWeekPct), p: fmt.pct(cmp.previous.multiWeekPct), d: delta(cmp.current.multiWeekPct, cmp.previous.multiWeekPct) },
      { m: "Opportunities (MQL ≤90d)", c: fmt.n(cmp.current.opportunities), p: fmt.n(cmp.previous.opportunities), d: delta(cmp.current.opportunities, cmp.previous.opportunities, "") },
    ]),
    h("div", { class: "legend", style: "padding: 8px 14px" }, "* Depth uses only leads eligible for 30+ days, so a quarter in progress is compared on the same footing.")) : null;

  const catCols: Col<any>[] = [
    { key: "label", label: "Category", render: (r) => h("span", { class: "link", onclick: () => openLeads({ ...f, category: r.category }, "eligible") }, r.label) },
    { key: "events", label: "Events", num: true },
    { key: "hotLeads", label: "Hot eligible", num: true },
    { key: "hotWorked", label: "Hot worked", num: true },
    { key: "hotCoverage", label: "Hot coverage", num: true, render: (r) => fmt.pct(r.hotCoverage) },
    { key: "warmLeads", label: "Warm eligible", num: true },
    { key: "warmWorked", label: "Warm worked", num: true },
    { key: "warmCoverage", label: "Warm coverage", num: true, render: (r) => fmt.pct(r.warmCoverage) },
  ];

  const sdrCols: Col<any>[] = [
    { key: "name", label: "SDR", render: (r) => h("span", { class: "link", onclick: () => openLeads({ ...f, sdr: r.ownerId, region: "" }, "eligible") }, r.name) },
    { key: "region", label: "Region" },
    { key: "hotAssigned", label: "Hot", num: true },
    { key: "hotCoverage", label: "Hot coverage", num: true, render: (r) => fmt.pct(r.hotCoverage) },
    { key: "warmAssigned", label: "Warm", num: true },
    { key: "warmCoverage", label: "Warm coverage", num: true, render: (r) => fmt.pct(r.warmCoverage) },
    { key: "sla", label: "Hot SLA met", num: true, sort: (r) => r.hotSla.pct, render: (r) => fmt.pct(r.hotSla.pct) },
    { key: "avgTouchesFirst30", label: "Touches · first 30d", num: true, title: "Average touches in the first 30 days, leads eligible ≥30 days", render: (r) => fmt.dec(r.avgTouchesFirst30) },
    { key: "multiWeekPct", label: "Multi-week", num: true, title: "Share of leads eligible ≥14 days touched in 2+ distinct weeks", render: (r) => fmt.pct(r.multiWeekPct) },
    { key: "attention", label: "Needs attention", num: true, render: (r) => r.attention ? h("span", { class: "link", onclick: () => openLeads({ ...f, sdr: r.ownerId, region: "" }, "attention") }, String(r.attention)) : "0" },
  ];

  return h("div", null,
    h("div", { class: "grid2" }, tempCol(d.hot), tempCol(d.warm)),
    h("p", { class: "legend" }, h("b", null, "Coverage"), " = share of eligible leads with at least one qualifying touch. ",
      h("b", null, "Depth"), " and ", h("b", null, "consistency"), " are reported separately below and are never blended into one score."),
    cmpCard ? [h("h2", null, "Quarter comparison"), cmpCard] : null,
    h("h2", null, "By event category", h("span", { class: "sub" }, "Each event belongs to exactly one category")),
    h("div", { class: "card" }, table(catCols, d.categories)),
    h("h2", null, "SDR summary", h("span", { class: "sub" }, "Approved roster only · assignment from the company SDR Owner")),
    h("div", { class: "card" }, table(sdrCols, d.sdrs, { initialSort: "attention" })),
    h("h2", null, "By region"),
    h("div", { class: "card" }, table<any>([
      { key: "region", label: "Region" }, { key: "eligible", label: "Eligible", num: true }, { key: "hot", label: "Hot", num: true }, { key: "warm", label: "Warm", num: true },
      { key: "coverage", label: "Coverage", num: true, render: (r) => h("div", { style: "display:flex;gap:8px;align-items:center;justify-content:flex-end" }, bar(r.coverage), fmt.pct(r.coverage)) },
      { key: "multiWeekPct", label: "Multi-week", num: true, render: (r) => fmt.pct(r.multiWeekPct) },
    ], d.regions)),
    h("p", { class: "legend" }, `${fmt.n(d.totals.registrations)} registrations across ${fmt.n(d.totals.events)} events · `,
      h("span", { class: "link", style: "cursor:pointer;text-decoration:underline", onclick: () => openLeads(f, "ineligible") }, `${fmt.n(d.totals.ineligible)} not eligible`),
      " (competitors, customers, cold, non-targetable, no SDR, sponsored non-attendees, upcoming)"),
  );
}
