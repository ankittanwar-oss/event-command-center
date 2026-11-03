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
  in_play: "In play (opportunity, meeting, reply, DQ)",
  health_overdue: "Overdue actions", health_due_today: "Due today", health_upcoming: "Upcoming (next 5 business days)", health_not_yet_due: "Not yet due",
  health_on_track: "On track", health_unverified: "Unable to verify / paused", follow_overdue: "Follow-up overdue", follow_due: "Follow-up due",
  depth_0: "0 touches", depth_1: "1 touch", depth_23: "2–3 touches", depth_45: "4–5 touches", depth_67: "6–7 touches", depth_8: "8+ touches", unverifiable: "Unable to verify", recently_lost: "Recently closed lost", one_touch: "One touch only", multi_week: "Multi-week follow-up",
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
      filters.eventId && (filters.eventId.includes(",") ? `Events: ${filters.eventId.split(",").length} selected` : `Event: ${r.rows[0]?.eventName ?? filters.eventId}`), filters.search && `Search: “${filters.search}”`,
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
        h("span", { class: "dmix" }, dimSummary(r.rows))),
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

/** Header mix for a drill-down: three separate dimensions, never one blended "healthy". */
function dimSummary(rows: any[]) {
  const el = rows.filter((r) => r.dims);
  if (!el.length) return riskSummary(rows);
  const tally = (key: string, norm: (v: string) => string = (v) => v) => {
    const m = new Map<string, number>();
    for (const r of el) { const v = r.dims[key]; if (v) m.set(norm(v), (m.get(norm(v)) ?? 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const line = (title: string, entries: Array<[string, number]>) => entries.length
    ? h("div", { class: "dimline" }, h("b", null, `${title}: `), entries.map(([k, n], i) => [i ? " · " : "", `${k} ${n}`])) : null;
  return h("div", { class: "dims" },
    line("First touch", tally("sla")),
    line("Follow-up", tally("followUp", (v) => v.replace(/ \(.*$/, ""))),
    line("Cadence", tally("cadence", (v) => v.startsWith("Cadence incomplete") ? "Incomplete" : "Complete")),
    line("Deadline", tally("deadlineLabel")));
}

/** Short, scannable follow-up state for a record. Colour: red overdue/stalled, amber action due, green on track, grey informational. */
export function shortStatus(r: any): { label: string; cls: "crit" | "warnr" | "ok" | "neu" } {
  if (!r.eligible) return { label: "Not eligible", cls: "neu" };
  if (r.dims?.followUp && r.status !== "in_play") {
    const fu: string = r.dims.followUp.replace(/ \(by .*\)$/, "");
    const cls = /overdue/i.test(fu) ? "crit" : /due|awaiting/i.test(fu) ? "warnr" : "neu";
    return { label: fu, cls };
  }
  switch (r.status) {
    case "never_worked":
      if (r.firstTouchOverdue) return { label: "Overdue · never worked", cls: "crit" };
      if (r.risk === "at_risk") return { label: "Due today", cls: "warnr" };
      return { label: "Not yet due", cls: "neu" };
    case "stalled": return { label: "Stalled", cls: "crit" };
    case "first_touch": return r.insufficientFollowUp ? { label: "Follow-up due", cls: "warnr" } : { label: "Touched · next not due", cls: "neu" };
    case "active": return { label: "On track", cls: "ok" };
    case "in_play": {
      const kind = /^Qualified \(SQL/.test(r.inPlayReason ?? "") ? "Qualified (SQL)" : /^Meeting/.test(r.inPlayReason ?? "") ? "Meeting" : /^Prospect replied/.test(r.inPlayReason ?? "") ? "Replied" : /Disqualified/.test(r.inPlayReason ?? "") ? "Disqualified" : "In play";
      if (r.touchesSinceEligibility === 0) return { label: `${kind} · no SDR touch`, cls: "neu" };
      return r.risk === "healthy" ? { label: `In play · ${kind}`, cls: "ok" } : { label: "Review next action", cls: "neu" };
    }
    case "unverifiable": return { label: "Unverified · company-level activity", cls: "neu" };
    case "recently_lost": return { label: "Recently closed lost", cls: "neu" };
    default: return { label: r.statusLabel ?? r.status, cls: "neu" };
  }
}

const URGENCY: Record<string, number> = { crit: 0, warnr: 1, neu: 2, ok: 3 };
const COLOR_RANK: Record<string, number> = { red: 0, amber: 1, green: 2, grey: 3 };
const COLOR_GROUP: Record<string, string> = { red: "Overdue", amber: "Due now", green: "On track / done", grey: "Info / review" };

/** Who last contacted: "30 Oct · Jonathan (SDR)". Name/role only when verified; never invented. */
export function lastContactText(lc: any): string {
  if (!lc?.at) return "Not contacted yet";
  const who = lc.by ? `${lc.by.name ?? "Unknown user"}${lc.by.role ? ` (${lc.by.role})` : ""}` : "owner unknown";
  return `${fmt.day(lc.at)} · ${who}`;
}
const firstName = (n: string | null | undefined) => (n ?? "").split(" ")[0];

/** Merge event-lead records of the same HubSpot contact (action views only; reporting counts are unaffected). */
export function groupByContact(rows: any[]): any[] {
  const by = new Map<string, any[]>();
  for (const r of rows) (by.get(r.contactId) ?? by.set(r.contactId, []).get(r.contactId)!).push(r);
  return [...by.values()].map((rs) => {
    if (rs.length === 1) return rs[0];
    rs.sort((x, y) => (COLOR_RANK[x.action?.color] ?? 9) - (COLOR_RANK[y.action?.color] ?? 9) || (x.dims?.due ?? "9").localeCompare(y.dims?.due ?? "9"));
    const top = rs[0];
    // Distinct qualifying activities across the events (the same email is not counted once per event).
    const ids = new Set(rs.flatMap((r) => r.touchIds ?? []));
    const last = rs.map((r) => r.lastContact).filter((l) => l?.at).sort((x, y) => y.at.localeCompare(x.at))[0] ?? top.lastContact;
    return { ...top, grouped: rs, groupedTouches: ids.size, groupedCurrentSdr: Math.max(...rs.map((r) => r.currentSdrTouches ?? 0)), lastContact: last,
      eventsList: rs.map((r) => ({ id: r.eventId, name: r.eventName, date: r.eventDate, attendance: r.attendance })) };
  });
}

/** Short, explicit next action. */
const shortAction = (t: string | null | undefined) => (t ?? "").split(/ – |\. /)[0]!.trim();

/** Compact record list used by every drill-down. One coloured action badge per record; temperature separate. */
export function leadTable(rows: any[], opts: { group?: boolean } = {}) {
  const wrap = h("div", { class: "reclist" });
  const search = h("input", { class: "text", type: "search", placeholder: "Search contact, company, event, SDR" }) as HTMLInputElement;
  const sortSel = h("select", { class: "text" },
    [["urgency", "Sort: urgency"], ["touches", "Sort: fewest touches"], ["event", "Sort: event date (newest)"], ["sdr", "Sort: SDR"], ["company", "Sort: company"]].map(([v, l]) => h("option", { value: v }, l))) as HTMLSelectElement;
  const sdrOf = (r: any) => r.sdrName ?? sdrNames.get(r.sdrOwnerId) ?? null;
  const sdrs = [...new Set(rows.map(sdrOf).filter(Boolean))].sort() as string[];
  const events = [...new Map(rows.map((r) => [r.eventId, r.eventName])).entries()];
  const sdrSel = h("select", { class: "text" }, h("option", { value: "" }, "All SDRs"), sdrs.map((n) => h("option", { value: n }, n))) as HTMLSelectElement;
  const evSel = h("select", { class: "text" }, h("option", { value: "" }, "All events"), events.map(([id, n]) => h("option", { value: id }, (n ?? "").slice(0, 50)))) as HTMLSelectElement;
  const stSel = h("select", { class: "text" }, h("option", { value: "" }, "All actions"), Object.entries(COLOR_GROUP).map(([k, l]) => h("option", { value: k }, l))) as HTMLSelectElement;
  const dupes = rows.length - new Set(rows.map((r) => r.contactId)).size;
  const grp = h("input", { type: "checkbox" }) as HTMLInputElement;
  grp.checked = opts.group ?? false;
  const grpLabel = dupes ? h("label", { class: "grpt", title: "Show one entry per HubSpot contact (events listed inside). Counts in reports are not affected." }, grp, ` One row per contact (${dupes} repeat${dupes === 1 ? "" : "s"})`) : null;
  const list = h("div", { class: "recs" });
  const shown = h("span", { class: "muted" });
  const render = () => {
    const q = search.value.trim().toLowerCase();
    let data = rows.filter((r) =>
      (!q || `${r.contactName} ${r.companyName ?? ""} ${r.eventName ?? ""} ${sdrOf(r) ?? ""} ${r.contactEmail ?? ""}`.toLowerCase().includes(q)) &&
      (!sdrSel.value || sdrOf(r) === sdrSel.value) && (!evSel.value || r.eventId === evSel.value));
    if (grp.checked && dupes) data = groupByContact(data);
    if (stSel.value) data = data.filter((r) => (r.action?.color ?? "grey") === stSel.value);
    const by = sortSel.value;
    data = [...data].sort((a, b) =>
      by === "touches" ? a.touchesSinceEligibility - b.touchesSinceEligibility
      : by === "event" ? (b.eventDate ?? "").localeCompare(a.eventDate ?? "")
      : by === "sdr" ? (sdrOf(a) ?? "~").localeCompare(sdrOf(b) ?? "~")
      : by === "company" ? (a.companyName ?? "~").localeCompare(b.companyName ?? "~")
      : (COLOR_RANK[a.action?.color] ?? URGENCY[shortStatus(a).cls]!) - (COLOR_RANK[b.action?.color] ?? URGENCY[shortStatus(b).cls]!) || (a.dims?.due ?? "9").localeCompare(b.dims?.due ?? "9") || (b.priority ?? 0) - (a.priority ?? 0));
    shown.textContent = `${data.length} ${grp.checked && dupes ? "contacts" : "records"}`;
    list.replaceChildren(...(data.length ? data.slice(0, 1500).map(record) : [h("div", { class: "empty" }, "No records match")]));
  };
  search.addEventListener("input", render);
  for (const el of [sortSel, sdrSel, evSel, stSel, grp]) el.addEventListener("change", render);

  function record(r: any): HTMLElement {
    const act = r.action ?? { label: shortStatus(r).label, color: ({ crit: "red", warnr: "amber", ok: "green", neu: "grey" } as any)[shortStatus(r).cls], next: r.nextAction, secondary: [] };
    const sdr = sdrOf(r) ?? (r.sdrOwnerRaw ? `Not on roster (${r.sdrOwnerRaw})` : "No SDR");
    const touches = r.grouped ? r.groupedTouches : r.touchesSinceEligibility;
    const details = h("div", { class: "recd" });
    let loaded = false;
    const toggle = h("button", { class: "recx", "aria-expanded": "false", onclick: () => {
      const open = el.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(open));
      toggle.textContent = open ? "Hide" : "Details";
      if (open && !loaded) { loaded = true; details.replaceChildren(detailBody(r)); }
    } }, "Details");
    const sdrLast = r.lastContact?.sdrAt && r.lastContact.sdrAt.slice(0, 10) !== (r.lastContact.at ?? "").slice(0, 10) ? ` · ${firstName(sdr)} last ${fmt.day(r.lastContact.sdrAt)}` : "";
    const el = h("div", { class: `rec a-${act.color}` },
      h("div", { class: "rl1" },
        h("span", { class: "rname" }, h("span", { class: "link", onclick: () => openLead(r.eventId, r.contactId), title: "Open lead audit" }, r.contactName), hsLink("contact", r.contactId)),
        h("span", { class: "rco" }, r.companyName ?? "No company", hsLink("company", r.companyId)),
        h("span", { class: "rsdr muted" }, sdr),
        h("span", { class: `abadge ${act.color}`, title: act.next ?? "" }, act.label)),
      h("div", { class: "rl2 muted" },
        r.grouped ? h("span", { class: "rev", title: r.eventsList.map((e: any) => `${e.name} (${fmt.day(e.date)})`).join("\n") }, `${r.eventsList.length} events`)
          : [h("span", { class: "rev", title: r.eventName }, r.eventName ?? "–"), h("span", null, fmt.day(r.eventDate))],
        tempPill(r.temperature, r.temperatureRaw),
        r.grouped ? null : h("span", null, r.attendance === "attended" ? "Attended" : r.attendance === "no_show" ? "No-show" : "Attendance unknown"),
        h("span", { class: `rtouch ${touches ? "" : "zero"}` }, `${touches} SDR touch${touches === 1 ? "" : "es"}`),
        h("span", null, `Last contacted: ${lastContactText(r.lastContact)}${sdrLast}`)),
      h("div", { class: "rl3" },
        h("span", { class: "ract" }, r.eligible ? shortAction(act.next) : act.next),
        (act.secondary ?? []).map((x: string) => h("span", { class: "sbadge" }, x)),
        toggle),
      details);
    return el;
  }
  wrap.append(h("div", { class: "rectools" }, search, stSel, sdrSel, evSel, sortSel, grpLabel, shown), list);
  render();
  return wrap;
}

/** Expanded record: action source, contact history, tasks, deals and every event association. */
function detailBody(r: any): HTMLElement {
  const kv = (k: string, v: any) => (v === null || v === undefined || v === "" ? null : [h("div", { class: "k" }, k), h("div", null, v)]);
  const src = ({ task: "HubSpot task due date", reply: "Prospect reply (respond within 1 business day)", sla: "First-touch SLA", cadence: "Follow-up cadence rule", engagement: "Verified engagement on this contact", none: "No reliable deadline" } as Record<string, string>)[r.action?.source ?? "none"];
  const lc = r.lastContact;
  const evs = r.grouped ? r.grouped : [r];
  return h("div", null,
    h("div", { class: "kv tight" },
      kv("Action", r.action ? [h("span", { class: `abadge ${r.action.color}` }, r.action.label), " ", r.action.next] : r.nextAction),
      kv("Why / source", src),
      kv("Last contacted", lc?.at ? `${lastContactText(lc)}${lc.sdrAt ? ` · current SDR's last qualifying touch ${fmt.day(lc.sdrAt)}` : " · no qualifying touch by the current SDR"}` : "No outbound contact logged"),
      kv("SDR touches", r.grouped ? `${r.groupedTouches} distinct qualifying touches across ${evs.length} events · ${r.groupedCurrentSdr} by the current SDR since allocation` : `${r.touchesSinceEligibility} counted (current SDR: since the event date; other SDRs: since eligibility ${fmt.day(r.eligibilityDate)}) · ${r.currentSdrTouchesSinceAllocation ?? "–"} by the current SDR since allocation (${fmt.day(r.allocationDate)})${r.otherSdrTouches ? ` · ${r.otherSdrTouches} by another SDR (not credited)` : ""}`),
      kv("HubSpot task", r.nextTaskDue ? `${r.nextTaskSubject ?? "Open task"} · due ${fmt.day(r.nextTaskDue)}${r.nextTaskOwnerId ? ` · ${sdrNames.get(r.nextTaskOwnerId) ?? "assigned to another user"}` : ""}` : "None open"),
      kv("First-touch SLA", r.dims?.sla ?? null),
      kv("Cadence", r.dims?.cadence ?? null),
      kv(evs.length > 1 ? "Events" : "Event", h("div", null, evs.map((e: any) => h("div", null, `${e.eventName} · ${fmt.day(e.eventDate)} · ${e.attendance === "attended" ? "attended" : e.attendance === "no_show" ? "no-show" : "attendance unknown"} · ${e.action?.label ?? ""}`)))),
      kv("SDR assignment", r.sdrSource === "pod_ae" ? "Pod SDR via the company's AE owner" : r.sdrSource === "company" ? "Company SDR Owner" : null),
      kv("Eligibility", r.eligible ? `Eligible since ${fmt.day(r.eligibilityDate)} (allocated ${fmt.day(r.allocationDate)})` : `Not eligible: ${r.ineligibleReason}`),
      kv("ICP / title", [r.icpTier ?? "–", r.jobTitle ? ` · ${r.jobTitle}` : ""]),
      kv("Email", r.contactEmail)),
    r.deals?.length ? h("div", { style: "margin-top:6px" }, h("div", { class: "muted", style: "font-size:12px;margin-bottom:4px" }, "Deals: an open deal on the company does not mean this contact is involved or that SDR follow-up is done."), dealTable(r.deals)) : null,
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
