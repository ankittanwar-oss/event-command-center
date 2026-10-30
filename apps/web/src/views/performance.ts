import { api } from "../api.js";
import { filterParams, type Route } from "../state.js";
import { delta, fmt, h, table } from "../ui.js";

const METRICS: Array<{ key: string; label: string; kind: "n" | "pct" | "dec"; better?: boolean }> = [
  { key: "events", label: "Events", kind: "n" },
  { key: "registered", label: "Registrations", kind: "n" },
  { key: "attendanceRate", label: "Attendance rate (events with attendance recorded)", kind: "pct" },
  { key: "eligible", label: "Eligible leads", kind: "n" },
  { key: "hot", label: "Hot eligible", kind: "n" },
  { key: "warm", label: "Warm eligible", kind: "n" },
  { key: "coverage", label: "Coverage", kind: "pct", better: true },
  { key: "slaCompliance", label: "First-touch SLA met", kind: "pct", better: true },
  { key: "avgTouchesFirst30", label: "Avg touches, first 30 days*", kind: "dec", better: true },
  { key: "multiWeekPct", label: "Multi-week follow-up*", kind: "pct", better: true },
  { key: "opportunities", label: "Opportunities (≤90 days)", kind: "n", better: true },
  { key: "sqls", label: "SQLs (≤90 days)", kind: "n", better: true },
];

const val = (q: any, m: (typeof METRICS)[number]) => (m.kind === "pct" ? fmt.pct(q[m.key]) : m.kind === "dec" ? fmt.dec(q[m.key]) : fmt.n(q[m.key]));

export async function performanceView(route: Route): Promise<HTMLElement> {
  const d = await api("performance", filterParams(route.filters));
  const qs: any[] = d.quarters;
  if (!qs.length) return h("div", { class: "empty" }, "No events in range");

  const qoqTable = (quarters: any[]) => table<any>([
    { key: "label", label: "Metric", wrap: true },
    ...quarters.map((q, i) => ({
      key: `q${i}`, label: `${q.key.slice(-2)} FY${q.key.slice(4, 6)}${q.complete ? "" : " (to date)"}`, num: true, title: q.label,
      render: (r: any) => [val(q, r.m), i < quarters.length - 1 && r.m.better !== undefined ? h("span", { style: "margin-left:6px" }, delta(q[r.m.key], quarters[i + 1][r.m.key], r.m.kind === "pct" ? "pt" : "", r.m.better)) : null],
    })),
  ], METRICS.map((m) => ({ label: m.label, m })));

  return h("div", null,
    h("h2", null, "Quarter over quarter", h("span", { class: "sub" }, "Fiscal year starts in May · Q1 MJJ, Q2 ASO, Q3 NDJ, Q4 FMA · all filters except quarter apply")),
    h("div", { class: "card" }, qoqTable(qs)),
    h("p", { class: "legend" }, "* Age-normalised: only leads eligible for at least 30 days, so an in-progress quarter is comparable with a completed one. Changes are versus the previous quarter."),
    h("h2", null, "Coverage by category and quarter"),
    h("div", { class: "card" }, table<any>([
      { key: "label", label: "Category" },
      ...qs.map((q, i) => ({ key: `c${i}`, label: `${q.key.slice(-2)} FY${q.key.slice(4, 6)}`, num: true, render: (r: any) => `${fmt.pct(r.quarters[i].coverage)} · ${fmt.n(r.quarters[i].eligible)}` })),
    ], d.byCategory)),
    h("p", { class: "legend" }, "Shown as coverage · eligible leads."),
    h("h2", null, "SDR coverage and depth by quarter"),
    h("div", { class: "card" }, table<any>([
      { key: "name", label: "SDR" }, { key: "region", label: "Region" },
      ...qs.map((q, i) => ({ key: `s${i}`, label: `${q.key.slice(-2)} FY${q.key.slice(4, 6)}`, num: true, render: (r: any) => {
        const x = r.quarters[i];
        return x.eligible ? `${fmt.pct(x.coverage)} · ${fmt.dec(x.avgTouchesFirst30)} · ${fmt.n(x.eligible)}` : "–";
      } })),
    ], d.bySdr)),
    h("p", { class: "legend" }, "Shown as coverage · avg touches in first 30 days · eligible leads."),
  );
}
