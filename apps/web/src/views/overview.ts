import { api } from "../api.js";
import { hotWarmSection } from "./cmoHotWarm.js";
import { openAccountDrill } from "../accountDrill.js";
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
  const [d, hw] = await Promise.all([api("overview", filterParams(f)), hotWarmSection(route)]);
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
  // ---- 1. Outreach execution scorecard. Percent + count, coloured against editable targets (Admin → performanceColors).
  const pcTxt = (n: number, of: number) => (of ? `${(Math.round((n / of) * 1000) / 10).toFixed(1).replace(/\.0$/, "")}%` : "–");
  const pcv = (n: number, of: number) => (of ? (n / of) * 100 : null);
  const PC = d.performanceColors ?? { coverageTarget: 80, followUpTarget: 50, amberFraction: 0.75 };
  const IA = d.inactivityDays ?? 14;
  const colour = (v: number | null, target: number) => v === null ? "sc-n" : v >= target ? "sc-g" : v >= target * PC.amberFraction ? "sc-a" : "sc-r";
  const all = d.dimsAll ?? { leads: 0, touched: 0, multi: 0, k: {}, depth: {} };
  const K = (c: any, key: string) => c.k?.[key] ?? 0;
  const cell = (big: string, small: any, bucket: string, patch: Partial<FilterState>, title: string, cls = "sc-n", tip = "") =>
    h("td", { class: `sc ${cls}`, title: tip, onclick: () => open(bucket, patch, title) }, h("div", { class: "scb" }, big), small ? h("div", { class: "scs" }, small) : null);
  const coreRow = (name: any, c: any, patch: Partial<FilterState>, label: string, total = false) => {
    const cov = pcv(c.touched, c.leads), fu = pcv(c.multi, c.touched);
    return h("tr", { class: total ? "tot" : "" }, h("td", null, name),
      cell(fmt.n(c.leads), K(c, "recent") ? `${fmt.n(K(c, "recent"))} still inside first-touch SLA` : "", "eligible", patch, `${label}: eligible leads`),
      cell(pcTxt(c.touched, c.leads), `${fmt.n(c.touched)} of ${fmt.n(c.leads)}`, "worked", patch, `${label}: first touch done`, colour(cov, PC.coverageTarget), `Target ${PC.coverageTarget}% · amber from ${PC.coverageTarget * PC.amberFraction}%`),
      cell(pcTxt(c.multi, c.touched), `${fmt.n(c.multi)} of ${fmt.n(c.touched)} touched`, "multi_touch", patch, `${label}: followed up (2+ touches)`, colour(fu, PC.followUpTarget), `Target ${PC.followUpTarget}% · amber from ${PC.followUpTarget * PC.amberFraction}%`),
      cell(fmt.n(K(c, "stale")), `${pcTxt(K(c, "stale"), c.leads)} · ${fmt.n(K(c, "stale_sdr_action"))} need SDR action`, "cmo_stale", patch, `${label}: no touch in ${IA}+ business days`));
  };
  const scorecard = h("div", { class: "card scard" },
    h("div", { class: "hd" }, h("span", { class: "t" }, "Event-lead execution"), h("span", { class: "muted", style: "margin-left:auto" }, `Qualifying SDR touches since eligibility · targets: first touch ${PC.coverageTarget}%, follow-up ${PC.followUpTarget}% · click any number`)),
    scRows.length ? h("div", { class: "tbl-wrap" }, h("table", { class: "sctable coretable" },
      h("thead", null, h("tr", null, h("th", null, "SDR"), h("th", { class: "n" }, "Eligible event leads"),
        h("th", { class: "n", title: "1+ qualifying SDR touch · % of eligible leads" }, "First touch done"),
        h("th", { class: "n", title: "2+ qualifying SDR touches · % of touched leads" }, "Followed up"),
        h("th", { class: "n", title: `No qualifying SDR touch for ${IA}+ business days (since last touch, or since eligibility if never touched). Not an SLA.` }, `No touch in ${IA}+ bd`))),
      h("tbody", null, scRows.map(({ r, c }: any) => coreRow(h("span", { class: "link", onclick: () => open("eligible", { sdr: r.ownerId, region: "" }, r.name) }, r.name), c, { sdr: r.ownerId, region: "" }, r.name)),
        scRows.length > 1 ? coreRow(h("b", null, "All leads in view"), all, {}, "All", true) : null))) : h("div", { class: "empty" }, "No SDR has eligible leads in this view."),
    h("div", { class: "legend", style: "padding: 8px 14px" }, `Green at/above target · amber from ${Math.round(PC.amberFraction * 100)}% of target · red below. "Still inside first-touch SLA" = recently eligible or allocated leads that are not yet due, so a low % there is expected.`));

  // ---- ACCOUNT EXECUTION (primary): unique HubSpot companies per SDR. Worked = 1+ qualifying SDR outreach to any eligible event contact.
  const AX = d.accountExec;
  // Every number opens the companies behind it (same predicate, filters and SDR attribution as the count).
  const drill = (metric: string, r: any, rowName: string, label: string) => (e: Event) => { e.stopPropagation(); openAccountDrill(f, metric, r.ownerId ?? "", rowName, label); };
  const ax = (metric: string, r: any, rowName: string, label: string, big: string, small = "", cls = "sc-n", tip = "") =>
    h("td", { class: `sc ${cls}`, title: tip || `Show the ${label.toLowerCase()}`, onclick: drill(metric, r, rowName, label) }, h("div", { class: "scb" }, big), small ? h("div", { class: "scs" }, small) : null);
  const axRow = (name: any, r: any, rowName: string) => h("tr", null, h("td", null, name),
    ax("eligible", r, rowName, "Eligible accounts", fmt.n(r.accounts)),
    ax("worked", r, rowName, "Accounts worked", fmt.n(r.worked), `${fmt.pct(r.coveragePct)} coverage`, colour(r.coveragePct, PC.coverageTarget), "Accounts worked / eligible accounts"),
    ax("not_worked", r, rowName, "Not worked", fmt.n(r.notWorked)),
    ax("stale14", r, rowName, "Worked, no outreach in 14+ business days", fmt.n(r.stale14), r.medianDaysSinceLast !== null && r.medianDaysSinceLast !== undefined ? `median ${r.medianDaysSinceLast} bd since last` : "", "sc-n", "Informational: worked accounts with no qualifying SDR outreach in 14+ business days (not an SLA)"),
    ax("sla_breach", r, rowName, "First-touch SLA breached", fmt.n(r.slaBreach), "", r.slaBreach ? "sc-r" : "sc-n", "Not worked and past the Hot 2 / Warm 4 business-day first-touch SLA"),
    ax("overdue_commitment", r, rowName, "Overdue HubSpot task / reply", fmt.n(r.overdueCommitment), "", r.overdueCommitment ? "sc-r" : "sc-n", "Verified overdue HubSpot task or unanswered prospect reply"),
    ax("contacts_worked", r, rowName, "Contacts worked", fmt.n(r.contactsWorked), `of ${fmt.n(r.contacts)} · ${fmt.pct(r.contactCoveragePct)}`),
    h("td", { class: "sc sc-n" }, h("div", { class: "scb" },
      h("span", { class: "link", onclick: drill("one_contact", r, rowName, "Accounts with 1 contact worked") }, fmt.n(r.oneContactWorked)), " / ",
      h("span", { class: "link", onclick: drill("two_plus", r, rowName, "Accounts with 2+ contacts worked") }, fmt.n(r.twoPlusWorked)))),
    ax("active", r, rowName, "In conversation", fmt.n(r.active)),
    h("td", { class: "sc sc-n", onclick: drill("paused", r, rowName, "Paused / closed") }, h("div", { class: "scb" }, fmt.n(r.paused)),
      h("div", { class: "scs" }, h("span", { class: "link", onclick: drill("paused_company", r, rowName, "Paused company-wide") }, `${fmt.n(r.pausedCompanyWide)} company-wide`))),
    ax("qualified", r, rowName, "Qualified", fmt.n(r.qualified)));
  const dispList = (m: Record<string, number>) => Object.entries(m).length ? Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, n]) => h("div", null, `${AX?.dispositionCodes?.[k] ?? k}: ${fmt.n(n)}`)) : h("div", { class: "faint" }, "None recorded");
  const accountExec = AX ? h("div", { class: "card scard" },
    h("div", { class: "hd" }, h("span", { class: "t" }, "Account execution"), h("span", { class: "muted", style: "margin-left:auto" }, "Primary measure · unique HubSpot companies · worked = 1+ qualifying SDR outreach to any eligible event contact")),
    h("div", { class: "tbl-wrap" }, h("table", { class: "sctable" },
      h("thead", null, h("tr", null, ["SDR", "Eligible accounts", "Accounts worked", "Not worked", "No outreach 14+ bd", "First-touch SLA breached", "Overdue tasks / replies", "Contacts worked", "Accounts 1 / 2+ contacts", "In conversation", "Paused / closed", "Qualified"].map((x, i) => h("th", { class: i ? "n" : "" }, x)))),
      h("tbody", null, AX.perSdr.map((r: any) => axRow(r.name, r, r.name)), AX.perSdr.length > 1 ? axRow(h("b", null, "All"), AX.all, "All SDRs") : null))),
    h("details", { class: "dmore", style: "padding: 0 14px 10px" }, h("summary", null, "Why worked accounts are not being pursued (verified dispositions)"),
      h("div", { class: "grid2" }, h("div", null, h("b", null, "Account-level (company-wide)"), dispList(AX.all.dispositions.company)), h("div", null, h("b", null, "Contact-level"), dispList(AX.all.dispositions.contact)))),
    h("div", { class: "legend", style: "padding: 8px 14px" }, "Contacts = eligible event contacts (not every CRM contact at the company). The event-lead table below keeps the original event-lead denominators.")) : null;

  // ---- A. Outreach timeliness (verified deadlines only)
  const trow = (name: any, c: any, patch: Partial<FilterState>, label: string) => h("tr", null, h("td", null, name),
    cell(fmt.n(K(c, "t_ft_breach")), "", "cmo_t_ft_breach", patch, `${label}: first-touch SLA breaches`, K(c, "t_ft_breach") ? "sc-r" : "sc-n"),
    cell(fmt.n(K(c, "t_fu_overdue")), K(c, "t_fu_overdue") ? `task ${K(c, "t_fu_overdue_task")} · reply ${K(c, "t_fu_overdue_reply")}` : "", "cmo_t_fu_overdue", patch, `${label}: verified follow-up overdue`, K(c, "t_fu_overdue") ? "sc-r" : "sc-n"),
    cell(fmt.n(K(c, "t_due_today")), "", "cmo_t_due_today", patch, `${label}: due today`),
    cell(fmt.n(K(c, "t_upcoming")), "", "cmo_t_upcoming", patch, `${label}: upcoming`));
  const timeliness = h("div", { class: "card scard" },
    h("div", { class: "hd" }, h("span", { class: "t" }, "A · Outreach timeliness"), h("span", { class: "muted", style: "margin-left:auto" }, `Only records with a verified deadline · first-touch SLA applies from ${fmt.day(d.slaStartDate ?? "2026-10-30")}`)),
    h("div", { class: "tbl-wrap" }, h("table", { class: "sctable" },
      h("thead", null, h("tr", null, h("th", null, "SDR"),
        h("th", { class: "n", title: "No touch and past the first-touch SLA (business days)" }, "First-touch SLA breaches"),
        h("th", { class: "n", title: "Overdue HubSpot task, unanswered reply, or no touch beyond the stall limit" }, "Overdue tasks / replies"),
        h("th", { class: "n", title: "First touch due today, or a HubSpot task / reply due today" }, "Due today"),
        h("th", { class: "n" }, "Upcoming"))),
      h("tbody", null, scRows.map(({ r, c }: any) => trow(r.name, c, { sdr: r.ownerId, region: "" }, r.name)), scRows.length > 1 ? trow(h("b", null, "All leads in view"), all, {}, "All") : null))));

  // ---- B. Engagement consistency (collapsed)
  const B: Array<[string, string, string]> = [["1", "1 touch", "depth_1"], ["2–3", "2–3", "depth_23"], ["4–5", "4–5", "depth_45"], ["6–7", "6–7", "depth_67"], ["8+", "8+", "depth_8"]];
  const brow = (name: any, c: any, patch: Partial<FilterState>, label: string) => h("tr", null, h("td", null, name),
    B.map(([k, l, bucket]) => cell(fmt.n(c.depth?.[k] ?? 0), "", bucket, patch, `${label}: ${l} touches`)),
    cell(fmt.n(K(c, "stale_sdr_action")), "", "cmo_stale_sdr_action", patch, `${label}: ${IA}+ bd, SDR action`),
    cell(fmt.n(K(c, "stale_ae_or_pause")), "", "cmo_stale_ae_or_pause", patch, `${label}: ${IA}+ bd, AE-led or paused`),
    cell(fmt.n(K(c, "stale_review")), "", "cmo_stale_review", patch, `${label}: ${IA}+ bd, needs review`));
  const engagement = h("details", { class: "card scard dsec" },
    h("summary", { class: "hd" }, h("span", { class: "t" }, "B · Engagement consistency"), h("span", { class: "muted", style: "margin-left:auto" }, "Touch depth and staleness · click to expand")),
    h("div", { class: "tbl-wrap" }, h("table", { class: "sctable" },
      h("thead", null,
        h("tr", null, h("th", { rowspan: 2 }, "SDR"), h("th", { class: "grp", colspan: 5 }, "Leads by qualifying touches"), h("th", { class: "grp sepl", colspan: 3 }, `No touch in ${IA}+ business days`)),
        h("tr", null, B.map(([, l]) => h("th", { class: "n" }, l)), h("th", { class: "n sepl" }, "Requires SDR action"), h("th", { class: "n" }, "AE-led / paused"), h("th", { class: "n" }, "Needs review"))),
      h("tbody", null, scRows.map(({ r, c }: any) => brow(r.name, c, { sdr: r.ownerId, region: "" }, r.name)), scRows.length > 1 ? brow(h("b", null, "All leads in view"), all, {}, "All") : null))),
    h("div", { style: "padding: 0 14px 14px" }, depthHead));

  // ---- C. Data quality / exceptions (collapsed)
  const ex = (n: number, label: string, hint: string, bucket: string) => h("button", { class: "exb", title: hint, onclick: () => open(bucket, {}, label) }, h("span", { class: "exv" }, fmt.n(n)), h("span", { class: "exl" }, label), h("span", { class: "exh" }, hint));
  const exceptions = h("details", { class: "card scard dsec" },
    h("summary", { class: "hd" }, h("span", { class: "t" }, "C · Data quality / exceptions"), h("span", { class: "muted", style: "margin-left:auto" }, "Records the timeliness figures cannot judge · click to expand")),
    h("div", { class: "exgrid" },
      ex(K(all, "x_no_deadline"), "No verifiable due date", "No touch yet and eligible before the SLA start, so no first-touch deadline applies", "cmo_x_no_deadline"),
      ex(d.missingOwner ?? 0, "Missing ownership", "Registrations not counted as eligible because no roster SDR owns the company", "cmo_x_missing_owner"),
      ex(K(all, "x_unverified_activity"), "Unverified activity", "Outreach logged on the company, not on this contact", "cmo_x_unverified_activity"),
      ex(K(all, "x_uncertain_handoff"), "Open deal, not yet SQL", "Open deal without a Became Qualified to Buy Date: SDR outreach continues, deal shown as context", "cmo_x_uncertain_handoff")),
    h("div", { class: "exgrid" },
      ex(K(all, "dl_not_yet_due"), "Not yet due", "Verified deadline still ahead", "cmo_dl_not_yet_due"),
      ex(K(all, "dl_commercial"), "Active commercial engagement", "Qualified deal (SQL), meeting or reply", "cmo_dl_commercial"),
      ex(K(all, "dl_paused"), "Paused / not actionable", "Recently closed lost, disqualified, or cadence complete", "cmo_dl_paused"),
      ex(K(all, "dl_missing_data"), "Missing data", "Event date or activity date unknown", "cmo_dl_missing_data")));

  // ---- Factual banner (no verdict)
  const banner = h("div", { class: "fbanner" },
    `${fmt.n(all.leads)} eligible event leads · ${fmt.n(all.touched)} first touched (${pcTxt(all.touched, all.leads)}) · ${fmt.n(all.multi)} followed up (${pcTxt(all.multi, all.touched)} of touched) · ${fmt.n(all.leads - all.touched)} not yet touched · ${fmt.n(K(all, "stale"))} no touch in ${IA}+ business days`);

  // Executive view first (contact-level Hot/Warm), then the account-level operational detail, collapsed.
  return h("div", null,
    hw,
    h("details", { class: "card acctsec" }, h("summary", { class: "hd" }, h("span", { class: "t" }, "Account Coverage & SDR Activity"),
      h("span", { class: "muted", style: "margin-left:auto" }, "Account-level and event-lead reporting (different denominators from the tables above) · click to expand")),
    banner,
    accountExec,
    scorecard,
    timeliness,
    engagement,
    exceptions,
    h("details", { class: "moresec" }, h("summary", null, "More analysis: focus list, Hot vs Warm, SDR detail, categories, regions"),
    h("h2", null, "Where leadership should focus", h("span", { class: "sub" }, "Verified gaps, ordered by severity, temperature and volume · click to see the records")),
    focus,
    dealLine,
    h("h2", null, "By company event label (Hot vs Warm ACCOUNTS)", h("span", { class: "sub" }, "Uses the company property \"Event Leads - Cold/Warm/Surging/Hot\", not the people-level Hot/Warm leads above")),
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
    ], d.regions))),
    ),
  );
}
