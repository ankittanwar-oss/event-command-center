import { api } from "../api.js";
import { openLeads } from "../drawer.js";
import { buildHash, filterParams, type FilterState, type Route } from "../state.js";
import { bar, delta, flag, fmt, h, RISK, riskBar, riskPill, table, type Col, type Risk } from "../ui.js";

const LEVELS: Risk[] = ["critical", "at_risk", "healthy", "neutral"];
const LEVEL_HINT: Record<Risk, string> = {
  critical: "SLA breached with no outreach, or follow-up stalled",
  at_risk: "First touch due today, or below expected cadence",
  healthy: "Actively worked across weeks, or in play after real SDR touches",
  neutral: "Inside SLA window, next touch not yet due, unverified, or recently closed lost",
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

  // ---- 1b. Follow-up depth headline: are leads getting more than one touch?
  const sdrName = f.sdr ? d.sdrs.find((x: any) => x.ownerId === f.sdr)?.name ?? null : null;
  const hm = (t: any) => ({ eligible: t.eligible, multi: t.multiTouch?.count ?? 0, one: t.oneTouch?.count ?? 0, none: t.untouched?.count ?? 0 });
  const H = hm(d.hot), W = hm(d.warm);
  const A = d.allTemps;
  const T = A ? { eligible: A.eligible, multi: A.multiTouch, one: A.oneTouch, none: A.untouched } : { eligible: H.eligible + W.eligible, multi: H.multi + W.multi, one: H.one + W.one, none: H.none + W.none };
  const pctTxt = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "–");
  const depthCol = (label: string, x: typeof T, temp?: "Hot" | "Warm") => {
    const p = temp ? { temperature: temp } : {};
    const cell = (cls: string, n: number, lab: string, bucket: string, hint: string) =>
      h("button", { class: `dh-cell ${cls}`, onclick: () => open(bucket, p, `${label}: ${lab}`), title: hint },
        h("span", { class: "dv" }, fmt.n(n)), h("span", { class: "dl" }, lab), h("span", { class: "dpc" }, `${pctTxt(n, x.eligible)} of ${fmt.n(x.eligible)}`));
    return h("div", { class: "dh-col" },
      h("div", { class: "dh-head" }, temp ? h("span", { class: `pill ${temp === "Hot" ? "hot" : "warm"}` }, temp) : h("b", null, "All"), h("span", { class: "muted" }, ` ${fmt.n(x.eligible)} eligible leads`)),
      h("div", { class: "dh-row" },
        cell("ok", x.multi, "Multi-touch (2+)", "multi_touch", "Two or more qualifying SDR touches (email, call or LinkedIn) since the lead became eligible"),
        cell("warnr", x.one, "One touch only", "one_touch", "Exactly one qualifying SDR touch"),
        cell("neu", x.none, "No touch yet", "untouched", "No qualifying SDR touch since the lead became eligible (includes leads still inside their first-touch window)")));
  };
  const depthHead = h("div", { class: "card dh" },
    h("div", { class: "hd" }, h("span", { class: "t" }, sdrName ? `${sdrName}: follow-up depth` : "Follow-up depth"),
      h("span", { class: "muted", style: "margin-left:auto" }, "Qualifying SDR touches since each lead became eligible · click a number for the leads")),
    h("div", { class: "dh-grid" }, depthCol("Hot", H, "Hot"), depthCol("Warm", W, "Warm"), depthCol(A?.otherTemps ? `All (incl. ${A.otherTemps} Cold / not set)` : "All", T)));

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
          t.inPlayTouched ? row("In play, worked by SDR", "Meeting, reply, open deal or DQ, after SDR touches", t.inPlayTouched, "healthy") : row("Completed / in play", "Meeting, reply, open deal or disqualified", t.inPlay, "healthy"),
          t.inPlayUntouched ? row("In play, no SDR touch", "Open deal, meeting, reply or DQ, but the SDR has not logged a touch", t.inPlayUntouched, "neutral") : null,
          row("Unable to verify", "Outreach logged on the company, not the contact", t.unverifiable, "neutral"),
          t.recentlyLost ? row("Recently closed lost", `Account closed lost recently; no SLA`, t.recentlyLost, "neutral") : null,
        )));
  };

  // ---- 5. SDR comparison: coverage, depth and consistency side by side; risk markers come from statuses
  const sr = (id: string) => d.sdrRisk[id];
  const sdrOpen = (r: any, bucket: string, patch: Partial<FilterState> = {}) => () => open(bucket, { sdr: r.ownerId, region: "", ...patch }, `${r.name}`);
  const dp = (id: string) => d.depth?.[id];
  const tgtMin = d.touchTarget?.minimum ?? 6;
  const sdrCols: Col<any>[] = [
    { key: "name", label: "SDR", render: (r) => [h("span", { class: "link", onclick: sdrOpen(r, "eligible") }, r.name), h("span", { class: "faint" }, ` ${r.region}`)] },
    { key: "hotCoverage", label: "Hot coverage", num: true, title: "Hot leads with at least one touch. ▲ marks Hot leads past SLA with no outreach.",
      render: (r) => flag(sr(r.ownerId).hotOverdue ? "critical" : null, [fmt.pct(r.hotCoverage), h("span", { class: "faint" }, ` ${r.hotContacted}/${r.hotAssigned}`)], sr(r.ownerId).hotOverdue ? `${sr(r.ownerId).hotOverdue} Hot leads past SLA with no outreach` : undefined) },
    { key: "warmCoverage", label: "Warm coverage", num: true,
      render: (r) => flag(sr(r.ownerId).warmOverdue ? "critical" : null, [fmt.pct(r.warmCoverage), h("span", { class: "faint" }, ` ${r.warmContacted}/${r.warmAssigned}`)], sr(r.ownerId).warmOverdue ? `${sr(r.ownerId).warmOverdue} Warm leads past SLA with no outreach` : undefined) },
    { key: "perLead", label: "Avg touches / lead", num: true, sort: (r) => dp(r.ownerId)?.avgPerLead ?? null, title: "Qualifying contact touches since eligibility ÷ eligible leads",
      render: (r) => fmt.dec(dp(r.ownerId)?.avgPerLead ?? null) },
    { key: "target", label: `% at ${tgtMin}+`, num: true, sort: (r) => dp(r.ownerId)?.atTargetPct ?? null, title: `Eligible leads with at least ${tgtMin} touches since eligibility (progress toward the ${tgtMin}–${d.touchTarget?.bandMax ?? 7} target)`,
      render: (r) => fmt.pct(dp(r.ownerId)?.atTargetPct ?? null) },
    { key: "oneTouch", label: "1-touch only", num: true, sort: (r) => dp(r.ownerId)?.oneTouchPct ?? null, title: "Share of eligible leads with exactly one touch. ◆ marks one-touch leads where more outreach is due.",
      render: (r) => flag(sr(r.ownerId).oneTouchDue ? "at_risk" : null, fmt.pct(dp(r.ownerId)?.oneTouchPct ?? null), sr(r.ownerId).oneTouchDue ? `${sr(r.ownerId).oneTouchDue} one-touch leads where more outreach is due` : undefined) },
    { key: "multiWeekPct", label: "Multi-week", num: true, title: "Leads ≥14 days old touched in 2+ distinct weeks. ▲ marks stalled leads.",
      render: (r) => flag(sr(r.ownerId).stalled ? "critical" : null, r.mature14Leads ? fmt.pct(r.multiWeekPct) : "–", sr(r.ownerId).stalled ? `${sr(r.ownerId).stalled} stalled leads` : undefined) },
    { key: "overdue", label: "Overdue", num: true, render: (r) => r.overdue ? h("span", { class: "link crit-t strong", onclick: sdrOpen(r, "overdue") }, String(r.overdue)) : h("span", { class: "faint" }, "0") },
    { key: "crit", label: "Critical", num: true, sort: (r) => sr(r.ownerId).all.critical, render: (r) => sr(r.ownerId).all.critical ? h("span", { class: "link crit-t strong", onclick: sdrOpen(r, "risk_critical") }, String(sr(r.ownerId).all.critical)) : h("span", { class: "faint" }, "0") },
    { key: "health", label: "Health", sort: (r) => ({ critical: 0, at_risk: 1, neutral: 2, healthy: 3, none: 4 } as Record<string, number>)[sr(r.ownerId).health] ?? 4,
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

  // ---- SDR scorecard (top of page): every cell coloured against a target, so gaps jump out
  const tg = { followUp: { green: 50, amber: 25, higherIsBetter: true }, ...(d.scorecardTargets ?? {}) };
  const grade = (key: string, v: number | null) => {
    const t = (tg as any)[key];
    if (v === null || v === undefined || !t) return "sc-n";
    if (t.higherIsBetter) return v >= t.green ? "sc-g" : v >= t.amber ? "sc-a" : "sc-r";
    return v <= t.green ? "sc-g" : v <= t.amber ? "sc-a" : "sc-r";
  };
  const pc = (n: number, of: number) => (of ? Math.round((n / of) * 100) : null);
  // Same population as every drill-down: eligible leads for the SDR under the current filters (event-lead records).
  const scRows = d.sdrs.map((r: any) => ({ r, c: d.dims?.[r.ownerId] })).filter((x: any) => x.c && x.c.leads > 0)
    .sort((a: any, b: any) => (b.c.firstOverdue + b.c.followOverdue) - (a.c.firstOverdue + a.c.followOverdue) || b.c.leads - a.c.leads);
  const num = (big: string, small: string, bucket: string, ownerId: string, cls = "sc-n", tip = "") =>
    h("td", { class: `sc ${cls}`, title: tip, onclick: () => open(bucket, { sdr: ownerId, region: "" }) }, h("div", { class: "scb" }, big), small ? h("div", { class: "scs" }, small) : null);
  const BANDS = [["0", "0"], ["1", "1"], ["2–3", "23"], ["4–5", "45"], ["6–7", "67"], ["8+", "8"]] as const;
  const depthBar = (c: any, ownerId: string) => h("td", { class: "sc sc-n" }, h("div", { class: "dbar" },
    BANDS.map(([k, key]) => c.depth[k] ? h("span", { class: `db b${key}`, style: `flex:${c.depth[k]}`, title: `${k} touches: ${c.depth[k]} leads`, onclick: () => open(`depth_${key}`, { sdr: ownerId, region: "" }) }) : null)),
    h("div", { class: "scs" }, BANDS.filter(([k]) => c.depth[k]).map(([k]) => `${k}:${c.depth[k]}`).join(" ")));
  const slaCls = (met: number, dec: number) => dec ? grade("sla", pc(met, dec)) : "sc-n";
  const odCls = (n: number) => grade("overdue", n);
  const scorecard = h("div", { class: "card scard" },
    h("div", { class: "hd" }, h("span", { class: "t" }, "SDR scorecard"),
      h("span", { class: "muted", style: "margin-left:auto" }, "Colour only on deadlines (SLA, overdue) · coverage and depth are shown, not graded · click any cell")),
    scRows.length ? h("div", { class: "tbl-wrap" }, h("table", { class: "sctable" },
      h("thead", null,
        h("tr", null, h("th", { rowspan: 2 }, "SDR"), h("th", { class: "n", rowspan: 2 }, "Eligible leads"),
          h("th", { class: "grp", colspan: 3 }, "A · First touch"), h("th", { class: "grp", colspan: 2 }, "B · Follow-up depth"), h("th", { class: "grp", colspan: 2 }, "C · Follow-up timing")),
        h("tr", null,
          h("th", { class: "n", title: "Leads with ≥1 qualifying SDR touch since eligibility" }, "Touched"),
          h("th", { class: "n", title: `First touch within the SLA; only leads eligible since ${fmt.day(d.slaStartDate ?? "2026-10-30")} are judged` }, "On time"),
          h("th", { class: "n", title: "No touch and past the first-touch SLA" }, "Overdue"),
          h("th", { class: "n", title: "Leads with 2 or more qualifying SDR touches since eligibility" }, "2+ touches"),
          h("th", { title: "Leads by qualifying touches: 0 · 1 · 2–3 · 4–5 · 6–7 · 8+" }, "Touch bands"),
          h("th", { class: "n", title: "Below the expected-touch curve for the lead's age, not yet stalled" }, "Due"),
          h("th", { class: "n", title: "No touch for longer than the stall threshold" }, "Overdue"))),
      h("tbody", null, scRows.map(({ r, c }: any) => h("tr", null,
        h("td", null, h("span", { class: "link", onclick: () => open("eligible", { sdr: r.ownerId, region: "" }, r.name) }, r.name)),
        num(`${c.leads}`, "", "eligible", r.ownerId),
        num(`${c.touched}`, `of ${c.leads}`, "worked", r.ownerId),
        c.slaMet + c.slaMissed ? num(`${c.slaMet}`, `of ${c.slaMet + c.slaMissed}`, "sla_missed", r.ownerId, slaCls(c.slaMet, c.slaMet + c.slaMissed), `${c.slaMissed} first touched late or not at all`)
          : h("td", { class: "sc sc-n", title: "No lead has reached its first-touch deadline under the SLA yet" }, h("div", { class: "scb faint" }, "–"), h("div", { class: "scs" }, "none due")),
        num(`${c.firstOverdue}`, "", "overdue", r.ownerId, odCls(c.firstOverdue)),
        num(`${c.multi}`, `of ${c.touched} touched`, "multi_touch", r.ownerId),
        depthBar(c, r.ownerId),
        num(`${c.followDue}`, "", "follow_due", r.ownerId, c.followDue ? "sc-a" : "sc-n"),
        num(`${c.followOverdue}`, "", "follow_overdue", r.ownerId, odCls(c.followOverdue))))))) : h("div", { class: "empty" }, "No SDR has eligible leads in this view."),
    h("div", { class: "legend", style: "padding: 8px 14px" },
      "Counts are event-lead records (a contact registered for two events counts twice), the same population as every drill-down. ",
      "Touches = qualifying outbound SDR touches since eligibility (later of event date and SDR allocation). ",
      "A lead with one touch can be on time and still need follow-up: depth is never coloured."));
  const HL: Array<[string, string]> = [["overdue", "Overdue"], ["due_today", "Due today"], ["upcoming", "Upcoming ≤5 bd"], ["not_yet_due", "Not yet due"], ["on_track", "On track"], ["unverified", "Unable to verify / paused"]];
  const healthCard = scRows.length ? h("div", { class: "card scard" },
    h("div", { class: "hd" }, h("span", { class: "t" }, "Action health"), h("span", { class: "muted", style: "margin-left:auto" }, "Each eligible lead in exactly one column · from SLA, cadence and verified task/reply dates")),
    h("div", { class: "tbl-wrap" }, h("table", { class: "sctable" },
      h("thead", null, h("tr", null, h("th", null, "SDR"), HL.map(([, l]) => h("th", { class: "n" }, l)))),
      h("tbody", null, scRows.map(({ r, c }: any) => h("tr", null, h("td", null, r.name),
        HL.map(([k]) => num(`${c.health[k]}`, "", `health_${k}`, r.ownerId, k === "overdue" && c.health[k] ? "sc-r" : "sc-n"))))))),
    h("div", { class: "legend", style: "padding: 8px 14px" }, "On track = cadence complete, or in play with a meeting, reply or deal on this contact. Open opportunities that sit only on the account are \"Unable to verify\", not on track.")) : null;

  return h("div", null,
    narrative,
    scorecard,
    healthCard,
    depthHead,
    summary,
    h("h2", null, "Where leadership should focus", h("span", { class: "sub" }, "Verified gaps, ordered by severity, temperature and volume · click to see the records")),
    focus,
    dealLine,
    h("h2", null, "Hot vs Warm follow-up", h("span", { class: "sub" }, "Coverage, overdue and engagement health by lead temperature")),
    h("div", { class: "grid2" }, tempCol(d.hot), tempCol(d.warm)),
    h("h2", null, "SDR performance", h("span", { class: "sub" }, "Coverage, depth and consistency side by side; never blended into one score · full touch-depth view in SDR execution")),
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
