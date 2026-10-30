import { api } from "../api.js";
import { openCustom, openLeads } from "../drawer.js";
import { buildHash, filterParams, type Route } from "../state.js";
import { fmt, h, table, type Col } from "../ui.js";

// SDR touch depth: volume, distribution and consistency side by side. No blended score.

const BAND_TONE: Record<string, string> = { b0: "d0", b1: "d1", b23: "d2", b45: "d3", b67: "d4", b8: "d5" };

function bandBar(stats: any, bands: any[]) {
  const total = stats.measuredLeads || 0;
  return h("div", { class: "dbar", title: bands.map((b) => `${b.label} touches: ${stats.bands[b.key]}`).join(" · ") },
    total ? bands.map((b) => stats.bands[b.key] ? h("span", { class: `seg ${BAND_TONE[b.key]}`, style: `width:${(stats.bands[b.key] / total) * 100}%` }) : null) : h("span", { class: "seg empty", style: "width:100%" }));
}

export async function depthSection(route: Route): Promise<HTMLElement> {
  const f = route.filters;
  const w = route.extra.get("window") || "eligibility";
  const d = await api("depth", { ...filterParams(f), window: w });
  const tgt = d.target;
  const drill = (ownerId: string, bucket: string) => () => openLeads({ ...f, sdr: ownerId, region: "" }, bucket);

  const cols: Col<any>[] = [
    { key: "name", label: "SDR", render: (r) => [h("span", { class: "link", onclick: () => openDetails(r, d) }, r.name), h("span", { class: "faint" }, ` ${r.region}`)] },
    { key: "accounts", label: "Accounts", num: true, sort: (r) => r.all.accounts, render: (r) => fmt.n(r.all.accounts) },
    { key: "hot", label: "Hot", num: true, sort: (r) => r.all.hotLeads, render: (r) => fmt.n(r.all.hotLeads) },
    { key: "warm", label: "Warm", num: true, sort: (r) => r.all.warmLeads, render: (r) => fmt.n(r.all.warmLeads) },
    { key: "total", label: "Total touches", num: true, sort: (r) => r.all.totalTouches, title: "Distinct HubSpot activities (one email to three contacts = 1)", render: (r) => fmt.n(r.all.totalTouches) },
    { key: "perAcct", label: "Avg / account", num: true, sort: (r) => r.all.avgPerAccount, render: (r) => fmt.dec(r.all.avgPerAccount) },
    { key: "perLead", label: "Avg / lead", num: true, sort: (r) => r.all.avgPerLead, render: (r) => fmt.dec(r.all.avgPerLead) },
    { key: "dist", label: "Leads by touches (0 · 1 · 2–3 · 4–5 · 6–7 · 8+)", sort: (r) => r.all.atTargetPct, render: (r) => h("div", { class: "distcell" }, bandBar(r.all, d.bands),
      h("span", { class: "mono faint" }, d.bands.map((b: any) => r.all.bands[b.key]).join(" · "))) },
    { key: "target", label: `% at ${tgt.minimum}+`, num: true, sort: (r) => r.all.atTargetPct, title: `Leads with at least ${tgt.minimum} qualifying touches in the window`, render: (r) => fmt.pct(r.all.atTargetPct) },
    { key: "one", label: "1-touch %", num: true, sort: (r) => r.all.oneTouchPct, render: (r) => r.all.oneTouchPct ? h("span", { class: "link", onclick: drill(r.ownerId, "one_touch") }, fmt.pct(r.all.oneTouchPct)) : fmt.pct(r.all.oneTouchPct) },
    { key: "conc", label: "Top-25% share", num: true, sort: (r) => r.all.top25Share, title: "Share of this SDR's contact touches that went to their most-touched quarter of leads. High = touches concentrated on a few leads.", render: (r) => r.all.top25Share === null ? "–" : fmt.pct(r.all.top25Share) },
    { key: "mw", label: "Multi-week", num: true, sort: (r) => r.all.multiWeekPct, render: (r) => fmt.pct(r.all.multiWeekPct) },
    { key: "overdue", label: "Overdue", num: true, sort: (r) => r.all.overdue, render: (r) => r.all.overdue ? h("span", { class: "link crit-t strong", onclick: drill(r.ownerId, "overdue") }, String(r.all.overdue)) : h("span", { class: "faint" }, "0") },
  ];
  const team = d.team;

  return h("div", null,
    h("h2", null, "Touch depth", h("span", { class: "sub" }, `Target ${tgt.minimum}–${tgt.bandMax} qualifying touches per eligible lead · ${tgt.windowDays ? `expected within ${tgt.windowDays} days of eligibility` : "time window not yet configured, so shown as progress, never as a breach"}`)),
    h("div", { class: "chips" }, h("span", { class: "muted", style: "align-self:center;margin-right:4px" }, "Measure touches:"),
      d.windows.map((x: any) => h("button", { class: w === x.key ? "on" : "", title: x.label, onclick: () => { location.hash = buildHash(route.view, f, { ...Object.fromEntries(route.extra), window: x.key }); } }, x.label))),
    h("div", { class: "card" }, table(cols, d.rows, { initialSort: "total" })),
    h("p", { class: "legend" },
      h("b", null, "Team: "), `${fmt.n(team.accounts)} accounts · ${fmt.n(team.leads)} eligible leads · ${fmt.n(team.totalTouches)} touches · ${fmt.dec(team.avgPerLead)} per lead · ${fmt.pct(team.atTargetPct)} at ${tgt.minimum}+ · ${fmt.n(team.untouchedAccounts)} accounts with no touch in this window. `,
      team.missingWindow ? h("span", { class: "warnr-t" }, `${team.missingWindow} leads excluded: no allocation date in HubSpot. `) : null,
      "Total touches count each HubSpot activity once per account; per-lead counts use the contact the activity is logged on. Click an SDR for Hot vs Warm and consistency details."),
  );
}

function openDetails(r: any, d: any) {
  const tgt = d.target;
  const block = (label: string, s: any) => ({ label, ...s });
  const rows = [block("Hot", r.Hot), block("Warm", r.Warm), block("All", r.all)];
  const metric = (label: string, get: (s: any) => any, title?: string) => ({ label, get, title });
  const metrics = [
    metric("Eligible accounts", (s) => fmt.n(s.accounts)), metric("Eligible leads", (s) => fmt.n(s.leads)),
    metric("Total touches (distinct activities)", (s) => fmt.n(s.totalTouches)), metric("Contact-level touches", (s) => fmt.n(s.contactTouches)),
    metric("Avg touches / account", (s) => fmt.dec(s.avgPerAccount)), metric("Avg touches / lead", (s) => fmt.dec(s.avgPerLead)),
    ...d.bands.map((b: any) => metric(`Leads with ${b.label} touches`, (s: any) => `${fmt.n(s.bands[b.key])} (${fmt.pct(s.bandPct[b.key])})`)),
    metric(`Accounts with 0 touches`, (s) => fmt.n(s.untouchedAccounts)),
    metric(`Target ${tgt.minimum}+ reached`, (s) => fmt.n(s.target.achieved)), metric("Target in progress", (s) => fmt.n(s.target.inProgress)),
    metric("Behind target (window passed)", (s) => (tgt.windowDays ? fmt.n(s.target.behind) : "window not configured")),
    metric("Multi-week engagement (leads ≥14 days)", (s) => fmt.pct(s.multiWeekPct)),
    metric("Avg business days to first touch", (s) => fmt.dec(s.daysToFirstAvg)), metric("Avg distinct outreach days / worked lead", (s) => fmt.dec(s.distinctDaysAvg)),
    metric("Average gap between touches (days)", (s) => fmt.dec(s.avgGap)), metric("Longest gap (days)", (s) => s.maxGap ?? "–"),
    metric("Days since most recent touch", (s) => s.daysSinceLastMin ?? "–"),
    metric("Top-25% share of touches", (s) => (s.top25Share === null ? "–" : fmt.pct(s.top25Share))),
    metric("Overdue first touch", (s) => fmt.n(s.overdue)), metric("Stalled", (s) => fmt.n(s.stalled)),
    metric("Excluded (window start unknown)", (s) => fmt.n(s.missingWindow)),
  ];
  const t = table<any>([{ key: "label", label: "Metric", wrap: true }, ...rows.map((b, i) => ({ key: `c${i}`, label: b.label, num: true, render: (m: any) => m.get(b) }))], metrics, { initialSort: "" });
  openCustom(`${r.name}: touch depth`, `${d.windowLabel}${d.period ? ` · events ${d.period.start} to ${d.period.end}` : ""}`, h("div", { style: "padding: 8px 18px" }, t));
}
