import { api } from "../api.js";
import { openLeads } from "../drawer.js";
import { buildHash, filterParams, type FilterState, type Route } from "../state.js";
import { bar, delta, flag, fmt, h, RISK, riskBar, riskPill, table, type Col, type Risk } from "../ui.js";

const LEVELS: Risk[] = ["critical", "at_risk", "healthy", "neutral"];
const LEVEL_HINT: Record<Risk, string> = {
  critical: "SLA breached with no outreach, or follow-up stalled",
  at_risk: "First touch due today, or below expected cadence",
  healthy: "Actively worked across weeks, or in play",
  neutral: "Inside SLA window, next touch not yet due, or unverified",
};

export async function overviewView(route: Route): Promise<HTMLElement> {
  const f = route.filters;
  const d = await api("overview", filterParams(f));
  const open = (bucket: string, patch: Partial<FilterState> = {}, title?: string) => openLeads({ ...f, ...patch }, bucket, {}, title);
  const pctOf = (n: number, of: number) => (of ? fmt.pct(Math.round((n / of) * 1000) / 10) : "–");
  const risk = d.risk.all;

  // ---- 1. Narrative
  const verdict: Risk = risk.critical > 0 ? "critical" : risk.at_risk > 0 ? "at_risk" : risk.eligible ? "healthy" : "neutral";
  const narrative = h("div", { class: `narrative ${RISK[verdict].cls}` }, h("span", { class: "nicon", "aria-hidden": "true" }, RISK[verdict].icon), h("p", null, d.narrative));

  // ---- 2. Health summary (mutually exclusive; totals reconcile to eligible)
  const tile = (level: Risk) => h("button", { class: `htile ${RISK[level].cls}`, onclick: () => open(`risk_${level}`, {}, `${RISK[level].label} leads`), title: LEVEL_HINT[level] },
    h("span", { class: "hl" }, h("i", { "aria-hidden": "true" }, RISK[level].icon), level === "neutral" ? "Not yet due / unverified" : RISK[level].label),
    h("span", { class: "hv" }, fmt.n(risk[level])),
    h("span", { class: "hp" }, `${pctOf(risk[level], risk.eligible)} of eligible`),
    h("span", { class: "hh" }, LEVEL_HINT[level]));
  const summary = h("div", null,
    h("div", { class: "htiles" }, LEVELS.map(tile)),
    h("div", { class: "hfoot" },
      riskBar(risk, (l) => open(`risk_${l}`, {}, `${RISK[l].label} leads`)),
      h("span", { class: "muted" }, `${fmt.n(risk.eligible)} eligible leads · `,
        h("span", { class: "link", onclick: () => open("ineligible", {}, "Not eligible") }, `${fmt.n(d.totals.ineligible)} not eligible`),
        ` · ${fmt.n(d.totals.registrations)} registrations across ${fmt.n(d.totals.events)} events`)));

  // ---- 3. Where leadership should focus
  const focus = h("div", { class: "card focus" },
    d.focus.length ? d.focus.map((x: any, i: number) => h("div", { class: `frow ${x.severity === "critical" ? "crit" : "warnr"}`, onclick: () => open(x.drill.bucket, x.drill.patch, x.title) },
      h("span", { class: "fnum" }, String(i + 1)),
      riskPill(x.severity),
      h("div", { class: "ftext" }, h("div", { class: "ft" }, x.title), x.detail ? h("div", { class: "fd" }, x.detail) : null),
      h("span", { class: "ftemp" }, x.temperature ? h("span", { class: `pill ${x.temperature === "Hot" ? "hot" : "warm"}` }, x.temperature) : null),
      h("span", { class: "fgo" }, `${fmt.n(x.count)} →`))) :
      h("div", { class: "empty" }, risk.eligible ? "No critical or at-risk follow-up gaps in this view." : "No eligible leads in this view."));

  // ---- Deal context (one line; historical deals are context only and never counted as event pipeline)
  const dc = d.dealContext;
  const toAccounts = (deal: string) => () => { location.hash = buildHash("sdr", f, { deal }); };
  const dealLine = dc && dc.hasHistory && dc.accounts ? h("div", { class: "dealctx" },
    h("b", null, "Deal history on eligible accounts:"),
    h("span", { class: "link", onclick: toAccounts("open") }, `${fmt.n(dc.open)} with an open opportunity`),
    h("span", { class: "link", onclick: toAccounts("lost") }, `${fmt.n(dc.lost)} most recently closed lost`, dc.lostLast90 ? ` (${fmt.n(dc.lostLast90)} accounts lost a deal in the last 90 days)` : ""),
    h("span", { class: "link", onclick: toAccounts("won") }, `${fmt.n(dc.won)} closed won`),
    h("span", null, `${fmt.n(dc.none)} with no deal`),
    h("span", { class: "faint" }, "Context only: not counted as event pipeline and does not change follow-up eligibility.")) : null;

  // ---- 4. Hot / Warm follow-up
  const tempCol = (t: any) => {
    const temp: "Hot" | "Warm" = t.temperature;
    const rc = d.risk[temp];
    const row = (label: string, hint: string, m: any, level: Risk | null) => [
      h("div", { class: "lab click", onclick: () => open(m.bucket, { temperature: temp }) }, flag(level, label), h("small", null, hint)),
      h("div", { class: `num click ${level && m.count ? RISK[level].cls + "-t" : ""}`, onclick: () => open(m.bucket, { temperature: temp }) }, fmt.n(m.count)),
      h("div", { class: "pct" }, fmt.pct(m.pct)),
    ];
    return h("div", { class: "card temp-col" },
      h("div", { class: "hd" }, h("span", { class: `pill ${temp === "Hot" ? "hot" : "warm"}` }, temp), h("span", { class: "t" }, `${temp} follow-up`),
        h("span", { class: "muted", style: "margin-left:auto" }, `SLA ${d.slaDays[temp]} business days · ${fmt.n(t.uniqueContacts)} unique contacts`)),
      h("div", { class: "bd" },
        h("div", { class: "big" },
          h("div", { class: "kpi", onclick: () => open("eligible", { temperature: temp }) }, h("span", { class: "v" }, fmt.n(t.eligible)), h("span", { class: "l" }, "Eligible")),
          h("div", { class: "kpi", onclick: () => open("worked", { temperature: temp }) }, h("span", { class: "v" }, fmt.pct(t.worked.pct)), h("span", { class: "l" }, `Coverage · ${fmt.n(t.worked.count)} worked`)),
          h("div", { class: `kpi ${t.overdue.count ? "crit-t" : ""}`, onclick: () => open("overdue", { temperature: temp }) }, h("span", { class: "v" }, fmt.n(t.overdue.count)), h("span", { class: "l" }, "Overdue first touch")),
          h("div", { class: `kpi ${rc.healthy ? "ok-t" : ""}`, onclick: () => open("risk_healthy", { temperature: temp }) }, h("span", { class: "v" }, fmt.n(rc.healthy)), h("span", { class: "l" }, "Healthy engagement"))),
        h("div", { class: "barline" }, riskBar(rc, (l) => open(`risk_${l}`, { temperature: temp }, `${temp} · ${RISK[l].label}`)),
          h("span", { class: "legend-inline" }, LEVELS.map((l) => h("span", { class: `li ${RISK[l].cls}` }, h("i", null, RISK[l].icon), `${RISK[l].label} ${fmt.n(rc[l])}`)))),
        h("div", { class: "rows" },
          row("Never worked", "No qualifying touch since eligibility", t.neverWorked, null),
          row("Overdue first touch", `No outreach after ${d.slaDays[temp]} business days`, t.overdue, "critical"),
          row("Follow-up stalled", "No touch beyond the stall threshold", t.stalled, "critical"),
          row("Insufficient follow-up", "Touched, but below expected cadence for its age", t.insufficient, "at_risk"),
          row("Actively worked", "Meeting cadence across multiple weeks", t.active, "healthy"),
          row("Completed / in play", "Meeting, reply, open deal or disqualified", t.inPlay, "healthy"),
          row("Unable to verify", "Outreach logged on the company, not the contact", t.unverifiable, "neutral"),
        )));
  };

  // ---- 5. SDR comparison: coverage, depth and consistency side by side; risk markers come from statuses
  const sr = (id: string) => d.sdrRisk[id];
  const sdrOpen = (r: any, bucket: string, patch: Partial<FilterState> = {}) => () => open(bucket, { sdr: r.ownerId, region: "", ...patch }, `${r.name}`);
  const sdrCols: Col<any>[] = [
    { key: "name", label: "SDR", render: (r) => [h("span", { class: "link", onclick: sdrOpen(r, "eligible") }, r.name), h("span", { class: "faint" }, ` ${r.region}`)] },
    { key: "hotCoverage", label: "Hot coverage", num: true, title: "Hot leads with at least one touch. ▲ marks Hot leads past SLA with no outreach.",
      render: (r) => flag(sr(r.ownerId).hotOverdue ? "critical" : null, [fmt.pct(r.hotCoverage), h("span", { class: "faint" }, ` ${r.hotContacted}/${r.hotAssigned}`)], sr(r.ownerId).hotOverdue ? `${sr(r.ownerId).hotOverdue} Hot leads past SLA with no outreach` : undefined) },
    { key: "warmCoverage", label: "Warm coverage", num: true,
      render: (r) => flag(sr(r.ownerId).warmOverdue ? "critical" : null, [fmt.pct(r.warmCoverage), h("span", { class: "faint" }, ` ${r.warmContacted}/${r.warmAssigned}`)], sr(r.ownerId).warmOverdue ? `${sr(r.ownerId).warmOverdue} Warm leads past SLA with no outreach` : undefined) },
    { key: "depth", label: "Follow-up depth", num: true, sort: (r) => r.avgTouchesFirst30, title: "Avg touches in first 30 days (leads ≥30 days old) · share of worked leads with one touch. ◆ marks one-touch leads where more outreach is due.",
      render: (r) => flag(sr(r.ownerId).oneTouchDue ? "at_risk" : null, [r.mature30Leads ? fmt.dec(r.avgTouchesFirst30) : "–", r.oneTouchPct === null ? null : h("span", { class: "faint" }, ` · ${fmt.pct(r.oneTouchPct)} 1-touch`)], sr(r.ownerId).oneTouchDue ? `${sr(r.ownerId).oneTouchDue} one-touch leads where more outreach is due` : undefined) },
    { key: "multiWeekPct", label: "Multi-week", num: true, title: "Leads ≥14 days old touched in 2+ distinct weeks. ▲ marks stalled leads.",
      render: (r) => flag(sr(r.ownerId).stalled ? "critical" : null, r.mature14Leads ? fmt.pct(r.multiWeekPct) : "–", sr(r.ownerId).stalled ? `${sr(r.ownerId).stalled} stalled leads` : undefined) },
    { key: "overdue", label: "Overdue", num: true, render: (r) => r.overdue ? h("span", { class: "link crit-t strong", onclick: sdrOpen(r, "overdue") }, String(r.overdue)) : h("span", { class: "faint" }, "0") },
    { key: "crit", label: "Critical", num: true, sort: (r) => sr(r.ownerId).all.critical, render: (r) => sr(r.ownerId).all.critical ? h("span", { class: "link crit-t strong", onclick: sdrOpen(r, "risk_critical") }, String(sr(r.ownerId).all.critical)) : h("span", { class: "faint" }, "0") },
    { key: "risk", label: "At risk", num: true, sort: (r) => sr(r.ownerId).all.at_risk, render: (r) => sr(r.ownerId).all.at_risk ? h("span", { class: "link warnr-t", onclick: sdrOpen(r, "risk_at_risk") }, String(sr(r.ownerId).all.at_risk)) : h("span", { class: "faint" }, "0") },
    { key: "health", label: "Health", sort: (r) => ({ critical: 0, at_risk: 1, neutral: 2, healthy: 3, none: 4 } as Record<string, number>)[sr(r.ownerId).health] ?? 3,
      render: (r) => sr(r.ownerId).health === "none" ? h("span", { class: "faint" }, "No eligible leads") : riskPill(sr(r.ownerId).health) },
  ];

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
      { m: "MQLs (≤90 days)", c: fmt.n(cmp.current.opportunities), p: fmt.n(cmp.previous.opportunities), d: delta(cmp.current.opportunities, cmp.previous.opportunities, "") },
    ]),
    h("div", { class: "legend", style: "padding: 8px 14px" }, "* Depth uses only leads eligible for 30+ days, so a quarter in progress is compared on the same footing.")) : null;

  const catCols: Col<any>[] = [
    { key: "label", label: "Category", render: (r) => h("span", { class: "link", onclick: () => openLeads({ ...f, category: r.category }, "eligible") }, r.label) },
    { key: "events", label: "Events", num: true },
    { key: "hotLeads", label: "Hot eligible", num: true },
    { key: "hotWorked", label: "Hot worked", num: true },
    { key: "hotCoverage", label: "Hot coverage", num: true, render: (r) => h("div", { class: "cbar" }, bar(r.hotCoverage), fmt.pct(r.hotCoverage)) },
    { key: "warmLeads", label: "Warm eligible", num: true },
    { key: "warmWorked", label: "Warm worked", num: true },
    { key: "warmCoverage", label: "Warm coverage", num: true, render: (r) => h("div", { class: "cbar" }, bar(r.warmCoverage), fmt.pct(r.warmCoverage)) },
  ];

  return h("div", null,
    narrative,
    summary,
    h("h2", null, "Where leadership should focus", h("span", { class: "sub" }, "Verified gaps, ordered by severity, temperature and volume · click to see the records")),
    focus,
    dealLine,
    h("h2", null, "Hot vs Warm follow-up", h("span", { class: "sub" }, "Coverage, overdue and engagement health by lead temperature")),
    h("div", { class: "grid2" }, tempCol(d.hot), tempCol(d.warm)),
    h("h2", null, "SDR performance", h("span", { class: "sub" }, "Coverage, depth and consistency side by side; never blended into one score")),
    h("div", { class: "card" }, table(sdrCols, d.sdrs, { initialSort: "crit", rowClass: (r) => (sr(r.ownerId).health === "critical" ? "row-crit" : sr(r.ownerId).health === "at_risk" ? "row-warn" : "") })),
    h("p", { class: "legend" }, h("b", null, "Health"), ": Critical = at least one Hot lead past SLA or stalled · At risk = a Warm lead past SLA or stalled, or any lead at risk · Healthy = none of those and at least one lead healthily engaged · Not yet due = nothing to judge yet. ",
      "▲ critical, ◆ at risk; markers come from lead statuses, not from coverage thresholds."),
    cmpCard ? [h("h2", null, "Quarter comparison"), cmpCard] : null,
    h("h2", null, "By event category", h("span", { class: "sub" }, "Each event belongs to exactly one category")),
    h("div", { class: "card" }, table(catCols, d.categories)),
    h("h2", null, "By region"),
    h("div", { class: "card" }, table<any>([
      { key: "region", label: "Region" }, { key: "eligible", label: "Eligible", num: true }, { key: "hot", label: "Hot", num: true }, { key: "warm", label: "Warm", num: true },
      { key: "coverage", label: "Coverage", num: true, render: (r) => h("div", { class: "cbar" }, bar(r.coverage), fmt.pct(r.coverage)) },
      { key: "multiWeekPct", label: "Multi-week", num: true, render: (r) => fmt.pct(r.multiWeekPct) },
    ], d.regions)),
  );
}
