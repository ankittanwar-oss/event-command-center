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
  in_play: "Completed / in play", unverifiable: "Unable to verify", recently_lost: "Recently closed lost", one_touch: "One touch only", multi_week: "Multi-week follow-up",
  sla_met: "First-touch SLA met", sla_missed: "First-touch SLA missed", attention: "Needs attention", no_next_step: "No next step scheduled",
  one_touch_due: "One touch only, more outreach due",
  multi_touch: "Multi-touch (2+ touches)", untouched: "No touch yet", in_play_touched: "In play, worked by SDR", in_play_untouched: "In play, no SDR touch",
  risk_critical: "Critical", risk_at_risk: "At risk", risk_healthy: "Healthy", risk_neutral: "Not yet due / unverified",
  ineligible: "Not eligible", registered: "Registrations", attended: "Attended", no_show: "Did not attend", attendance_unknown: "Attendance unknown",
};

export async function openLeads(filters: FilterState, bucket: string, extra: Record<string, string> = {}, title?: string) {
  const body = openShell(title ?? BUCKET_LABEL[bucket] ?? "Leads", "Records behind the number, with the dashboard filters applied");
  try {
    const r = await api("leads", { ...filterParams(filters), bucket, ...extra, limit: "3000" });
    const active = [
      filters.region && `Region: ${filters.region}`, filters.sdr && `SDR: ${sdrNames.get(filters.sdr) ?? filters.sdr}`,
      filters.category && `Category: ${filters.category}`, filters.temperature && `Temperature: ${filters.temperature}`,
      filters.eventId && `Event: ${r.rows[0]?.eventName ?? filters.eventId}`, filters.search && `Search: “${filters.search}”`,
    ].filter(Boolean) as string[];
    // Surface records whose status may look surprising for this KPI, without changing the KPI itself.
    const inPlayNoTouch = r.rows.filter((x: any) => x.status === "in_play" && x.touchesSinceEligibility === 0).length;
    const note = (bucket === "untouched" || bucket === "never_worked") && inPlayNoTouch
      ? h("div", { class: "dnote" }, `${inPlayNoTouch} of these have no SDR touch but are already commercially active (open opportunity, meeting, reply or DQ). They are counted here because no SDR touch is logged.`)
      : null;
    body.replaceChildren(
      h("div", { class: "dhead" },
        h("span", { class: "dcount" }, fmt.n(r.total), h("small", null, r.total === 1 ? " record" : " records"), r.total > r.rows.length ? h("small", null, ` (showing ${r.rows.length})`) : null),
        h("span", { class: "chipx" }, r.filters.quarterLabel),
        active.map((a) => h("span", { class: "chipx" }, a)),
        r.filters.sdrCleared ? h("span", { class: "chipx warnr-t" }, "SDR filter cleared: not in this region") : null,
        h("span", { class: "dmix" }, riskSummary(r.rows))),
      note ?? "",
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
  return h("div", { class: "kvbar" }, riskBar(c as any), levels.map((l) => h("span", { class: `li ${RISK[l].cls}` }, h("i", null, RISK[l].icon), `${RISK[l].label} ${c[l]}`)));
}

/** Short, scannable follow-up state for a record. Colour: red overdue/stalled, amber action due, green on track, grey informational. */
export function shortStatus(r: any): { label: string; cls: "crit" | "warnr" | "ok" | "neu" } {
  if (!r.eligible) return { label: "Not eligible", cls: "neu" };
  switch (r.status) {
    case "never_worked":
      if (r.firstTouchOverdue) return { label: "Overdue · never worked", cls: "crit" };
      if (r.risk === "at_risk") return { label: "Due today", cls: "warnr" };
      return { label: "Not yet due", cls: "neu" };
    case "stalled": return { label: "Stalled", cls: "crit" };
    case "first_touch": return r.insufficientFollowUp ? { label: "Follow-up due", cls: "warnr" } : { label: "Touched · next not due", cls: "neu" };
    case "active": return { label: "On track", cls: "ok" };
    case "in_play": {
      const kind = /^Open opportunity/.test(r.inPlayReason ?? "") ? "Open opportunity" : /^Meeting/.test(r.inPlayReason ?? "") ? "Meeting" : /^Prospect replied/.test(r.inPlayReason ?? "") ? "Replied" : /Disqualified/.test(r.inPlayReason ?? "") ? "Disqualified" : "In play";
      return r.touchesSinceEligibility > 0 ? { label: `In play · ${kind}`, cls: "ok" } : { label: `${kind} · no SDR touch`, cls: "neu" };
    }
    case "unverifiable": return { label: "Unverified · company-level activity", cls: "neu" };
    case "recently_lost": return { label: "Recently closed lost", cls: "neu" };
    default: return { label: r.statusLabel ?? r.status, cls: "neu" };
  }
}

const URGENCY: Record<string, number> = { crit: 0, warnr: 1, neu: 2, ok: 3 };
/** Short next action: first clause only; the full text is in the expanded details. */
const shortAction = (t: string | null | undefined) => (t ?? "").split(/ – |: |\. /)[0]!.trim();

/** Compact record list used by every KPI drill-down (replaces the wide table). No horizontal scrolling. */
export function leadTable(rows: any[]) {
  const wrap = h("div", { class: "reclist" });
  const search = h("input", { class: "text", type: "search", placeholder: "Search contact, company, event, SDR" }) as HTMLInputElement;
  const sortSel = h("select", { class: "text" },
    [["urgency", "Sort: urgency"], ["touches", "Sort: fewest touches"], ["event", "Sort: event date (newest)"], ["sdr", "Sort: SDR"], ["company", "Sort: company"]].map(([v, l]) => h("option", { value: v }, l))) as HTMLSelectElement;
  const sdrs = [...new Set(rows.map((r) => r.sdrName ?? sdrNames.get(r.sdrOwnerId) ?? null).filter(Boolean))].sort() as string[];
  const events = [...new Map(rows.map((r) => [r.eventId, r.eventName])).entries()];
  const sdrSel = h("select", { class: "text" }, h("option", { value: "" }, "All SDRs"), sdrs.map((n) => h("option", { value: n }, n))) as HTMLSelectElement;
  const evSel = h("select", { class: "text" }, h("option", { value: "" }, "All events"), events.map(([id, n]) => h("option", { value: id }, (n ?? "").slice(0, 50)))) as HTMLSelectElement;
  const statuses = [...new Set(rows.map((r) => shortStatus(r).label))];
  const stSel = h("select", { class: "text" }, h("option", { value: "" }, "All statuses"), statuses.map((s) => h("option", { value: s }, s))) as HTMLSelectElement;
  const list = h("div", { class: "recs" });
  const shown = h("span", { class: "muted" });

  const sdrOf = (r: any) => r.sdrName ?? sdrNames.get(r.sdrOwnerId) ?? null;
  const render = () => {
    const q = search.value.trim().toLowerCase();
    let data = rows.filter((r) =>
      (!q || `${r.contactName} ${r.companyName ?? ""} ${r.eventName ?? ""} ${sdrOf(r) ?? ""} ${r.contactEmail ?? ""}`.toLowerCase().includes(q)) &&
      (!sdrSel.value || sdrOf(r) === sdrSel.value) && (!evSel.value || r.eventId === evSel.value) && (!stSel.value || shortStatus(r).label === stSel.value));
    const by = sortSel.value;
    data = [...data].sort((a, b) =>
      by === "touches" ? a.touchesSinceEligibility - b.touchesSinceEligibility
      : by === "event" ? (b.eventDate ?? "").localeCompare(a.eventDate ?? "")
      : by === "sdr" ? (sdrOf(a) ?? "~").localeCompare(sdrOf(b) ?? "~")
      : by === "company" ? (a.companyName ?? "~").localeCompare(b.companyName ?? "~")
      : URGENCY[shortStatus(a).cls]! - URGENCY[shortStatus(b).cls]! || (b.priority ?? 0) - (a.priority ?? 0));
    shown.textContent = data.length === rows.length ? "" : `${data.length} of ${rows.length} shown`;
    list.replaceChildren(...(data.length ? data.slice(0, 1500).map(record) : [h("div", { class: "empty" }, "No records match")]));
  };
  for (const el of [search]) el.addEventListener("input", render);
  for (const el of [sortSel, sdrSel, evSel, stSel]) el.addEventListener("change", render);

  function record(r: any): HTMLElement {
    const st = shortStatus(r);
    const sdr = sdrOf(r) ?? (r.sdrOwnerRaw ? `Not on roster (${r.sdrOwnerRaw})` : "No SDR");
    const details = h("div", { class: "recd" });
    let loaded = false;
    const toggle = h("button", { class: "recx", "aria-expanded": "false", onclick: () => {
      const open = el.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(open));
      toggle.textContent = open ? "Hide details" : "Details";
      if (open && !loaded) { loaded = true; details.replaceChildren(detailBody(r)); }
    } }, "Details");
    const el = h("div", { class: `rec ${st.cls}` },
      h("div", { class: "rl1" },
        h("span", { class: "rname" }, h("span", { class: "link", onclick: () => openLead(r.eventId, r.contactId), title: "Open lead audit" }, r.contactName), hsLink("contact", r.contactId)),
        h("span", { class: "rco" }, r.companyName ?? "No company", hsLink("company", r.companyId)),
        h("span", { class: "rsdr muted" }, sdr),
        h("span", { class: `rst ${st.cls}`, title: r.statusReason ?? "" }, st.label)),
      h("div", { class: "rl2 muted" },
        h("span", { class: "rev", title: r.eventName }, r.eventName ?? "–"), h("span", null, fmt.day(r.eventDate)),
        r.temperature ? tempPill(r.temperature) : null,
        h("span", null, r.attendance === "attended" ? "Attended" : r.attendance === "no_show" ? "Did not attend" : "Attendance unknown"),
        h("span", { class: `rtouch ${r.touchesSinceEligibility ? "" : "zero"}` }, `${r.touchesSinceEligibility} SDR touch${r.touchesSinceEligibility === 1 ? "" : "es"}`),
        r.lastTouchAt ? h("span", null, `last ${fmt.day(r.lastTouchAt)}`) : null),
      h("div", { class: "rl3" }, h("span", { class: "ract", title: r.nextAction ?? "" }, r.eligible ? shortAction(r.nextAction) : `Excluded: ${r.ineligibleReason ?? ""}`), toggle),
      details);
    return el;
  }
  wrap.append(h("div", { class: "rectools" }, search, stSel, sdrSel, evSel, sortSel, shown), list);
  render();
  return wrap;
}

/** Expanded record: the full CRM context that was previously in the wide table, plus deals. */
function detailBody(r: any): HTMLElement {
  const kv = (k: string, v: any) => (v === null || v === undefined || v === "" ? null : [h("div", { class: "k" }, k), h("div", null, v)]);
  return h("div", null,
    h("div", { class: "kv tight" },
      kv("Status", [statusPill(r.status, r.statusLabel ?? r.status, r.risk), " ", r.statusReason ?? ""]),
      kv("In play because", r.inPlayReason),
      kv("Next action", r.nextAction),
      kv("Touches", `${r.touchesSinceEligibility} since eligibility · ${r.touchesPostEvent} since event · ${r.touchesSinceAllocation ?? "–"} since allocation`),
      kv("First / last touch", `${fmt.day(r.firstTouchAt)} / ${fmt.day(r.lastTouchAt)}`),
      kv("Days to first touch", r.businessDaysToFirstTouch !== null ? `${r.businessDaysToFirstTouch} business days${r.firstTouchSlaMet === false ? " (SLA missed)" : r.firstTouchSlaMet ? " (SLA met)" : ""}` : r.firstTouchOverdue ? "Not touched, SLA missed" : "Not touched yet"),
      kv("Consistency", `${r.distinctTouchDays} day(s) · ${r.distinctTouchWeeks} week(s) · longest gap ${r.maxGapDays ?? "–"} d`),
      kv("Next task", r.nextTaskDue ? fmt.day(r.nextTaskDue) : "None scheduled"),
      kv("Eligibility", r.eligible ? `Eligible since ${fmt.day(r.eligibilityDate)} (allocated ${fmt.day(r.allocationDate)})` : `Not eligible: ${r.ineligibleReason}`),
      kv("ICP / title", [r.icpTier ?? "–", r.jobTitle ? ` · ${r.jobTitle}` : ""]),
      kv("Email", r.contactEmail)),
    r.deals?.length ? h("div", { style: "margin-top:6px" }, dealTable(r.deals)) : null,
    h("button", { class: "btn", style: "margin-top:8px", onclick: () => openLead(r.eventId, r.contactId) }, "Full activity audit →"));
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
        kv("Health", [riskPill(r.risk, f.status === "recently_lost" ? "Recently closed lost" : undefined, r.riskReason ?? undefined), " ", h("span", { class: "muted" }, r.riskReason ?? (f.eligible ? "" : "Not eligible for follow-up"))]),
        kv("Status", [statusPill(f.status, f.status.replace("_", " "), r.risk), " ", f.statusReason]),
        kv("Next action", r.nextAction ?? "–"),
        kv("Touches (since eligibility / since event / since allocation)", [`${f.touchesSinceEligibility} / ${f.touchesPostEvent} / `, f.touchesSinceAllocation ?? h("span", { class: "warnr-t", title: "No allocation date in HubSpot" }, "allocation date missing")]),
        kv("Consistency", `${f.distinctTouchDays} distinct days · ${f.distinctTouchWeeks} week(s) · avg gap ${f.avgGapDays ?? "–"} d · longest gap ${f.maxGapDays ?? "–"} d · last touch ${f.daysSinceLastTouch ?? "–"} d ago`),
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
