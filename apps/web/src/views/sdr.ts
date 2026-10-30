import { api } from "../api.js";
import { openLead, openLeads } from "../drawer.js";
import { buildHash, filterParams, type Route } from "../state.js";
import { fmt, h, hsLink, statusPill, table, tempPill, type Col } from "../ui.js";

const HEALTH = [
  ["", "All"], ["never_worked", "Never worked"], ["stalled", "Stalled"], ["unverifiable", "Unable to verify"],
  ["first_touch", "First touch"], ["active", "Active"], ["in_play", "In play"],
] as const;

export async function sdrView(route: Route): Promise<HTMLElement> {
  const f = route.filters;
  const health = route.extra.get("health") ?? "";
  const [s, a] = await Promise.all([api("sdr", filterParams(f)), api("accounts", { ...filterParams(f), health, limit: "400" })]);
  const drill = (ownerId: string, bucket: string) => () => openLeads({ ...f, sdr: ownerId, region: "" }, bucket);
  const cnt = (r: any, key: string, bucket: string) => (r[key] ? h("span", { class: "link", onclick: drill(r.ownerId, bucket) }, String(r[key])) : "0");

  const cols: Col<any>[] = [
    { key: "name", label: "SDR", render: (r) => h("span", { class: "link", onclick: drill(r.ownerId, "eligible") }, r.name) },
    { key: "region", label: "Region" },
    { key: "hotAssigned", label: "Hot assigned", num: true },
    { key: "hotContacted", label: "Hot contacted", num: true },
    { key: "hotCoverage", label: "Hot coverage", num: true, render: (r) => fmt.pct(r.hotCoverage) },
    { key: "warmAssigned", label: "Warm assigned", num: true },
    { key: "warmContacted", label: "Warm contacted", num: true },
    { key: "warmCoverage", label: "Warm coverage", num: true, render: (r) => fmt.pct(r.warmCoverage) },
    { key: "hotSla", label: "Hot SLA", num: true, sort: (r) => r.hotSla.pct, render: (r) => r.hotSla.decided ? `${fmt.pct(r.hotSla.pct)} (${r.hotSla.met}/${r.hotSla.decided})` : "–" },
    { key: "warmSla", label: "Warm SLA", num: true, sort: (r) => r.warmSla.pct, render: (r) => r.warmSla.decided ? `${fmt.pct(r.warmSla.pct)} (${r.warmSla.met}/${r.warmSla.decided})` : "–" },
    { key: "avgTouches", label: "Avg touches", num: true, render: (r) => fmt.dec(r.avgTouches) },
    { key: "medianTouches", label: "Median", num: true, render: (r) => r.medianTouches ?? "–" },
    { key: "avgTouchesFirst30", label: "First 30d*", num: true, title: "Avg touches in first 30 days (leads eligible ≥30 days)", render: (r) => r.mature30Leads ? `${fmt.dec(r.avgTouchesFirst30)}` : "–" },
    { key: "dist", label: "1 / 2–3 / 4–7 / 8+", sort: (r) => r.oneTouchPct, title: "Distribution of touches among worked leads", render: (r) => `${fmt.pct(r.oneTouchPct)} · ${fmt.pct(r.twoToThreePct)} · ${fmt.pct(r.fourToSevenPct)} · ${fmt.pct(r.eightPlusPct)}` },
    { key: "multiWeekPct", label: "Multi-week*", num: true, render: (r) => r.mature14Leads ? fmt.pct(r.multiWeekPct) : "–" },
    { key: "nextStepPct", label: "Next step", num: true, render: (r) => fmt.pct(r.nextStepPct) },
    { key: "daysSinceLastOutreach", label: "Days since outreach", num: true, render: (r) => r.daysSinceLastOutreach ?? "–" },
    { key: "neverWorked", label: "Never worked", num: true, render: (r) => cnt(r, "neverWorked", "never_worked") },
    { key: "overdue", label: "Overdue", num: true, render: (r) => cnt(r, "overdue", "overdue") },
    { key: "stalled", label: "Stalled", num: true, render: (r) => cnt(r, "stalled", "stalled") },
    { key: "oneTouchOnly", label: "1 touch only", num: true, render: (r) => cnt(r, "oneTouchOnly", "one_touch") },
    { key: "active", label: "Active", num: true },
    { key: "inPlay", label: "In play", num: true },
  ];

  const queue = h("div", { class: "card" },
    h("div", { class: "acct-head" }, h("span"), h("span", null, "Account"), h("span", null, "Events"), h("span", null, "SDR"), h("span", null, "Contacts"), h("span", null, "Touches"), h("span", null, "Health"), h("span", null, "Next action")),
    a.rows.length ? a.rows.map((acc: any) => {
      const el = h("div", { class: "acct" });
      const contacts = h("div", { class: "contacts" }, table<any>([
        { key: "contactName", label: "Contact", render: (c) => [h("span", { class: "link", onclick: () => openLead(c.eventId, c.contactId) }, c.contactName), hsLink("contact", c.contactId)] },
        { key: "jobTitle", label: "Title", render: (c) => c.jobTitle ?? "–" },
        { key: "eventName", label: "Event", render: (c) => `${(c.eventName ?? "").slice(0, 32)} · ${fmt.day(c.eventDate)}` },
        { key: "temperature", label: "Temp", render: (c) => tempPill(c.temperature) },
        { key: "attendance", label: "Attended", render: (c) => c.attendance.replace("_", " ") },
        { key: "status", label: "Status", render: (c) => statusPill(c.status, c.statusLabel) },
        { key: "touches", label: "Touches", num: true },
        { key: "lastTouchAt", label: "Last touch", render: (c) => fmt.day(c.lastTouchAt) },
        { key: "nextTaskDue", label: "Next task", render: (c) => fmt.day(c.nextTaskDue) },
        { key: "nextAction", label: "Next action", wrap: true },
      ], acc.contacts));
      el.append(
        h("div", { class: "row", onclick: () => el.classList.toggle("open") },
          h("span", { class: "chev" }, "›"),
          h("span", null, h("b", null, acc.companyName ?? "(no company)"), hsLink("company", acc.companyId), " ", tempPill(acc.temperature), acc.icpTier ? h("span", { class: "faint" }, ` ${acc.icpTier}`) : null),
          h("span", { class: "muted", title: acc.events.map((e: any) => e.name).join("\n") }, acc.events.length === 1 ? (acc.events[0].name ?? "").slice(0, 28) : `${acc.events.length} events`),
          h("span", null, acc.sdrName ?? "–"),
          h("span", null, `${acc.contactsWorked}/${acc.eligibleContacts} worked`),
          h("span", null, `${acc.touches}`, acc.lastTouch ? h("span", { class: "faint" }, ` · ${fmt.day(acc.lastTouch)}`) : null),
          h("span", null, statusPill(acc.health, acc.healthLabel)),
          h("span", { class: "muted" }, acc.nextAction)),
        contacts);
      return el;
    }) : h("div", { class: "empty" }, "No accounts match the filters"));

  return h("div", null,
    h("h2", null, "SDR execution", h("span", { class: "sub" }, "Coverage, SLA, depth and consistency side by side · * age-adjusted")),
    h("div", { class: "card" }, table(cols, s.rows, { initialSort: "neverWorked" })),
    h("h2", null, "Account queue", h("span", { class: "sub" }, `${fmt.n(a.total)} accounts · prioritised by temperature, overdue and stalled leads · touches de-duplicated across contacts`)),
    h("div", { class: "chips" }, HEALTH.map(([k, label]) => h("button", { class: health === k ? "on" : "", onclick: () => { location.hash = buildHash("sdr", f, { health: k }); } }, label))),
    queue,
    a.total > a.rows.length ? h("p", { class: "legend" }, `Showing the top ${a.rows.length} accounts. Narrow with filters to see the rest.`) : null,
  );
}
