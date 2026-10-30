import { api } from "./api.js";
import { filterParams, type FilterState } from "./state.js";
import { dealTable, fmt, h, hsLink, RISK, riskBar, riskPill, statusPill, table, tempPill, type Col, type Risk } from "./ui.js";

// Drilldowns. Every KPI opens the exact records behind it: the same bucket predicate on the server produces
// both the count and this list.

let current: HTMLElement | null = null;

export function closeDrawer() { current?.remove(); current = null; }

function openShell(title: string, sub?: string): HTMLElement {
  closeDrawer();
  const body = h("div", { class: "db" }, h("div", { class: "loading" }, "Loading…"));
  const root = h("div", null,
    h("div", { class: "drawer-bg", onclick: closeDrawer }),
    h("div", { class: "drawer", role: "dialog", "aria-label": title },
      h("div", { class: "dh" }, h("div", null, h("div", { class: "t" }, title), sub ? h("div", { class: "muted" }, sub) : null),
        h("button", { class: "close", onclick: closeDrawer }, "Close")),
      body));
  document.body.append(root);
  current = root;
  return body;
}

document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

export const BUCKET_LABEL: Record<string, string> = {
  eligible: "Eligible leads", worked: "Worked (≥1 touch)", never_worked: "Never worked", overdue: "First touch overdue",
  insufficient: "Insufficient follow-up", active: "Actively worked", first_touch: "First touch completed", stalled: "Follow-up stalled",
  in_play: "Completed / in play", unverifiable: "Unable to verify", one_touch: "One touch only", multi_week: "Multi-week follow-up",
  sla_met: "First-touch SLA met", sla_missed: "First-touch SLA missed", attention: "Needs attention", no_next_step: "No next step scheduled",
  one_touch_due: "One touch only, more outreach due",
  risk_critical: "Critical", risk_at_risk: "At risk", risk_healthy: "Healthy", risk_neutral: "Not yet due / unverified",
  ineligible: "Not eligible", registered: "Registrations", attended: "Attended", no_show: "Did not attend", attendance_unknown: "Attendance unknown",
};

export async function openLeads(filters: FilterState, bucket: string, extra: Record<string, string> = {}, title?: string) {
  const body = openShell(title ?? BUCKET_LABEL[bucket] ?? "Leads", "Records behind the number, with the current filters applied");
  try {
    const r = await api("leads", { ...filterParams(filters), bucket, ...extra, limit: "3000" });
    body.replaceChildren(
      h("div", { class: "kv" }, h("div", { class: "k" }, "Records"), h("div", null, fmt.n(r.total), r.total > r.rows.length ? ` (showing ${r.rows.length})` : ""),
        h("div", { class: "k" }, "Period"), h("div", null, r.filters.quarterLabel),
        r.filters.sdrCleared ? [h("div", { class: "k" }, "Note"), h("div", null, "The selected SDR is not in this region, so the SDR filter was cleared.")] : null,
        riskSummary(r.rows)),
      leadTable(r.rows));
  } catch (e) { body.replaceChildren(h("div", { class: "banner warn" }, String((e as Error).message))); }
}

const RISK_RANK: Record<string, number> = { critical: 0, at_risk: 1, neutral: 2, healthy: 3 };

/** Risk mix of the listed records (only shown when the list mixes levels). */
function riskSummary(rows: any[]) {
  const c = { eligible: 0, critical: 0, at_risk: 0, healthy: 0, neutral: 0 } as Record<string, number>;
  for (const r of rows) if (r.risk) { c.eligible!++; c[r.risk]!++; }
  const levels = (["critical", "at_risk", "healthy", "neutral"] as Risk[]).filter((l) => c[l]);
  if (levels.length < 2) return null;
  return [h("div", { class: "k" }, "Health"), h("div", { class: "kvbar" }, riskBar(c as any), levels.map((l) => h("span", { class: `li ${RISK[l].cls}` }, h("i", null, RISK[l].icon), `${RISK[l].label} ${c[l]}`)))];
}

export function leadTable(rows: any[]) {
  const cols: Col<any>[] = [
    { key: "risk", label: "Health", sort: (r) => (r.risk ? RISK_RANK[r.risk] ?? 9 : 9), render: (r) => riskPill(r.risk, undefined, r.riskReason ?? r.ineligibleReason ?? undefined) },
    { key: "contactName", label: "Contact", render: (r) => [h("span", { class: "link", onclick: () => openLead(r.eventId, r.contactId) }, r.contactName), hsLink("contact", r.contactId)] },
    { key: "companyName", label: "Company", render: (r) => [r.companyName ?? "–", hsLink("company", r.companyId)] },
    { key: "eventName", label: "Event", render: (r) => h("span", { title: r.eventName }, (r.eventName ?? "").slice(0, 38)) },
    { key: "eventDate", label: "Date", render: (r) => fmt.day(r.eventDate) },
    { key: "temperature", label: "Temp", render: (r) => tempPill(r.temperature) },
    { key: "sdrOwnerId", label: "SDR", render: (r) => r.sdrName ?? sdrNames.get(r.sdrOwnerId) ?? (r.sdrOwnerRaw ? h("span", { class: "faint" }, `Not on roster (${r.sdrOwnerRaw})`) : "–") },
    { key: "status", label: "Status", render: (r) => r.eligible ? statusPill(r.status, r.statusLabel ?? r.status, r.risk) : h("span", { class: "faint" }, r.ineligibleReason) },
    { key: "touchesSinceEligibility", label: "Touches", num: true },
    { key: "lastTouchAt", label: "Last touch", render: (r) => fmt.day(r.lastTouchAt) },
    { key: "businessDaysToFirstTouch", label: "Days to 1st", num: true, title: "Business days from eligibility to first touch", render: (r) => r.businessDaysToFirstTouch ?? "–" },
    { key: "attendance", label: "Attendance", render: (r) => r.attendance.replace("_", " ") },
    { key: "nextAction", label: "Next action", wrap: true },
  ];
  return table(cols, rows, { initialSort: "risk", desc: false, rowClass: (r) => (r.risk === "critical" ? "row-crit" : "") });
}

export const sdrNames = new Map<string, string>();

export async function openLead(eventId: string, contactId: string) {
  const body = openShell("Lead audit", "Every stored activity and whether it counted as a touch");
  try {
    const r = await api(`leads/${eventId}/${contactId}`);
    const f = r.lead;
    const kv = (k: string, v: unknown) => [h("div", { class: "k" }, k), h("div", null, v as any)];
    body.replaceChildren(
      h("div", { class: "kv" },
        kv("Contact", [f.contactName, " ", f.contactEmail ? h("span", { class: "muted" }, f.contactEmail) : null, hsLink("contact", f.contactId, "Open in HubSpot ↗")]),
        kv("Company", [f.companyName ?? "–", hsLink("company", f.companyId, "Open in HubSpot ↗")]),
        kv("Event", `${f.eventName} · ${fmt.day(f.eventDate)} · ${f.eventCategory}`),
        kv("Temperature / ICP", `${f.temperatureRaw ?? "not set"} · ${f.icpTier ?? "ICP tier missing"}`),
        kv("SDR (company SDR owner)", sdrNames.get(f.sdrOwnerId) ?? (f.sdrOwnerRaw ? `Not on roster (${f.sdrOwnerRaw})` : "Not assigned")),
        kv("Eligible", f.eligible ? "Yes" : `No – ${f.ineligibleReason}`),
        kv("Allocation / eligibility date", `${fmt.day(f.allocationDate)} / ${fmt.day(f.eligibilityDate)}`),
        kv("Health", [riskPill(r.risk, undefined, r.riskReason ?? undefined), " ", h("span", { class: "muted" }, r.riskReason ?? (f.eligible ? "" : "Not eligible for follow-up"))]),
        kv("Status", [statusPill(f.status, f.status.replace("_", " "), r.risk), " ", f.statusReason]),
        kv("Next action", r.nextAction ?? "–"),
        kv("Touches (since eligibility / post-event / since allocation)", `${f.touchesSinceEligibility} / ${f.touchesPostEvent} / ${f.touchesSinceAllocation ?? "–"}`),
        kv("First-touch SLA", f.firstTouchSlaMet === null ? "Pending" : f.firstTouchSlaMet ? `Met (${f.businessDaysToFirstTouch} business days)` : "Missed"),
        kv("Expected touches by now", f.expectedTouches),
        kv("Attendance", f.attendance),
        kv("Data quality", f.dataQuality.length ? f.dataQuality.join(", ") : "No issues"),
        kv("MQLs attributed to this event", f.attributedDeals.length ? f.attributedDeals.map((d: string) => hsLink("deal", d, `Deal ${d} ↗ `)) : "None"),
      ),
      h("div", null, f.deals ? [h("h2", { style: "padding: 0 18px" }, "Deal history", h("span", { class: "sub" }, "Contact and company deals in HubSpot · context only, not event pipeline")),
        h("div", { style: "padding: 0 18px" }, dealTable(f.deals))] : null),
      h("h2", { style: "padding: 0 18px" }, "Activities", h("span", { class: "sub" }, "Contact-level activity first; company-level shown separately")),
      table<any>([
        { key: "timestamp", label: "When", render: (a) => new Date(a.timestamp).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) },
        { key: "kind", label: "Type", render: (a) => `${a.objectType}${a.direction ? ` · ${a.direction}` : ""}${a.channel ? ` · ${a.channel}` : ""}` },
        { key: "ownerName", label: "Owner" },
        { key: "via", label: "Logged on" },
        { key: "title", label: "Subject", wrap: true, render: (a) => a.title ?? "–" },
        { key: "counted", label: "Counted?", render: (a) => a.counted ? h("span", { class: "pill good" }, "Counted") : h("span", { class: "faint" }, a.why) },
      ], r.activities, { initialSort: "timestamp" }),
    );
  } catch (e) { body.replaceChildren(h("div", { class: "banner warn" }, String((e as Error).message))); }
}

export function openCustom(title: string, sub: string, content: HTMLElement) {
  const body = openShell(title, sub);
  body.replaceChildren(content);
}
