import { api } from "../api.js";
import { depthSection } from "./depth.js";
import { openLead, openLeads } from "../drawer.js";
import { buildHash, filterParams, type Route } from "../state.js";
import { dealPill, dealTable, flag, fmt, h, hsLink, riskPill, statusPill, table, tempPill, type Col, type Risk } from "../ui.js";

const HEALTH = [
  ["", "All"], ["never_worked", "Never worked"], ["stalled", "Stalled"], ["unverifiable", "Unable to verify"],
  ["first_touch", "First touch"], ["active", "Active"], ["in_play", "In play"], ["recently_lost", "Recently closed lost"],
] as const;

export async function sdrView(route: Route): Promise<HTMLElement> {
  const f = route.filters;
  const health = route.extra.get("health") ?? "";
  const deal = route.extra.get("deal") ?? "";
  const [s, a, depthEl] = await Promise.all([api("sdr", filterParams(f)), api("accounts", { ...filterParams(f), health, deal, limit: "400" }), depthSection(route)]);
  const dealBadge = (acc: any) => {
    if (!acc.deals) return null; // snapshot computed before deal history existed
    const top = acc.deals[0];
    const lost = acc.deals.find((x: any) => x.status === "lost");
    const detail = !top ? undefined : top.status === "open" ? (top.stageLabel ?? "").replace(/\s*\(.*\)$/, "") || undefined : top.closedAt ? fmt.day(top.closedAt) : undefined;
    return [dealPill(acc.dealStatus, detail), top && top.status !== "lost" && lost ? h("span", { class: "faint", title: "This account also has a closed-lost deal" }, " +lost") : null,
      acc.deals.length > 1 ? h("span", { class: "faint" }, ` ${acc.deals.length} deals`) : null];
  };
  const drill = (ownerId: string, bucket: string) => () => openLeads({ ...f, sdr: ownerId, region: "" }, bucket);
  const cnt = (r: any, key: string, bucket: string, level: Risk | null = null) =>
    (r[key] ? h("span", { class: `link ${level === "critical" ? "crit-t strong" : level === "at_risk" ? "warnr-t" : ""}`, onclick: drill(r.ownerId, bucket) }, String(r[key])) : h("span", { class: "faint" }, "0"));
  const healthRank = (r: any) => ({ critical: 0, at_risk: 1, neutral: 2, healthy: 3, none: 4 } as Record<string, number>)[r.risk.health] ?? 3;

  const cols: Col<any>[] = [
    { key: "name", label: "SDR", render: (r) => h("span", { class: "link", onclick: drill(r.ownerId, "eligible") }, r.name) },
    { key: "region", label: "Region" },
    { key: "health", label: "Health", sort: healthRank, title: "Critical = a Hot lead past SLA or stalled · At risk = a Warm lead past SLA or stalled, or any lead at risk · Healthy = none of those and at least one lead healthily engaged",
      render: (r) => r.risk.health === "none" ? h("span", { class: "faint" }, "No leads") : riskPill(r.risk.health) },
    { key: "hotAssigned", label: "Hot assigned", num: true },
    { key: "hotContacted", label: "Hot contacted", num: true },
    { key: "hotCoverage", label: "Hot coverage", num: true, render: (r) => flag(r.risk.hotOverdue ? "critical" : null, fmt.pct(r.hotCoverage), r.risk.hotOverdue ? `${r.risk.hotOverdue} Hot leads past SLA with no outreach` : undefined) },
    { key: "warmAssigned", label: "Warm assigned", num: true },
    { key: "warmContacted", label: "Warm contacted", num: true },
    { key: "warmCoverage", label: "Warm coverage", num: true, render: (r) => flag(r.risk.warmOverdue ? "critical" : null, fmt.pct(r.warmCoverage), r.risk.warmOverdue ? `${r.risk.warmOverdue} Warm leads past SLA with no outreach` : undefined) },
    { key: "hotSla", label: "Hot SLA", num: true, sort: (r) => r.hotSla.pct, render: (r) => r.hotSla.decided ? `${fmt.pct(r.hotSla.pct)} (${r.hotSla.met}/${r.hotSla.decided})` : "–" },
    { key: "warmSla", label: "Warm SLA", num: true, sort: (r) => r.warmSla.pct, render: (r) => r.warmSla.decided ? `${fmt.pct(r.warmSla.pct)} (${r.warmSla.met}/${r.warmSla.decided})` : "–" },
    { key: "avgTouches", label: "Avg touches", num: true, render: (r) => fmt.dec(r.avgTouches) },
    { key: "medianTouches", label: "Median", num: true, render: (r) => r.medianTouches ?? "–" },
    { key: "avgTouchesFirst30", label: "First 30d*", num: true, title: "Avg touches in first 30 days (leads eligible ≥30 days)", render: (r) => r.mature30Leads ? `${fmt.dec(r.avgTouchesFirst30)}` : "–" },
    { key: "dist", label: "1 / 2–3 / 4–7 / 8+", sort: (r) => r.oneTouchPct, title: "Distribution of touches among worked leads", render: (r) => flag(r.risk.oneTouchDue ? "at_risk" : null, `${fmt.pct(r.oneTouchPct)} · ${fmt.pct(r.twoToThreePct)} · ${fmt.pct(r.fourToSevenPct)} · ${fmt.pct(r.eightPlusPct)}`, r.risk.oneTouchDue ? `${r.risk.oneTouchDue} one-touch leads where more outreach is due` : undefined) },
    { key: "multiWeekPct", label: "Multi-week*", num: true, render: (r) => flag(r.risk.stalled ? "critical" : null, r.mature14Leads ? fmt.pct(r.multiWeekPct) : "–", r.risk.stalled ? `${r.risk.stalled} stalled leads` : undefined) },
    { key: "nextStepPct", label: "Next step", num: true, render: (r) => fmt.pct(r.nextStepPct) },
    { key: "daysSinceLastOutreach", label: "Days since outreach", num: true, render: (r) => r.daysSinceLastOutreach ?? "–" },
    { key: "neverWorked", label: "Never worked", num: true, render: (r) => cnt(r, "neverWorked", "never_worked") },
    { key: "overdue", label: "Overdue", num: true, render: (r) => cnt(r, "overdue", "overdue", "critical") },
    { key: "stalled", label: "Stalled", num: true, render: (r) => cnt(r, "stalled", "stalled", "critical") },
    { key: "oneTouchOnly", label: "1 touch only", num: true, render: (r) => cnt(r, "oneTouchOnly", "one_touch") },
    { key: "oneTouchDue", label: "1 touch, more due", num: true, sort: (r) => r.risk.oneTouchDue, title: "One touch only and below expected cadence", render: (r) => r.risk.oneTouchDue ? h("span", { class: "link warnr-t", onclick: drill(r.ownerId, "one_touch_due") }, String(r.risk.oneTouchDue)) : h("span", { class: "faint" }, "0") },
    { key: "active", label: "Active", num: true },
    { key: "inPlay", label: "In play", num: true },
  ];

  const queue = h("div", { class: "card" },
    h("div", { class: "acct-head" }, h("span"), h("span", null, "Account"), h("span", null, "Events"), h("span", null, "SDR"), h("span", null, "Contacts"), h("span", null, "Touches"), h("span", null, "Health"), h("span", null, "Next action")),
    a.rows.length ? a.rows.map((acc: any) => {
      const el = h("div", { class: `acct ${acc.risk === "critical" ? "acct-crit" : acc.risk === "at_risk" ? "acct-warn" : ""}` });
      const contacts = h("div", { class: "contacts" },
        acc.deals ? [h("div", { class: "subhead" }, "Deal history (context only, not counted as event pipeline)"), dealTable(acc.deals), h("div", { class: "subhead" }, "Contacts")] : null,
        table<any>([
        { key: "contactName", label: "Contact", render: (c) => [h("span", { class: "link", onclick: () => openLead(c.eventId, c.contactId) }, c.contactName), hsLink("contact", c.contactId)] },
        { key: "jobTitle", label: "Title", render: (c) => c.jobTitle ?? "–" },
        { key: "eventName", label: "Event", render: (c) => `${(c.eventName ?? "").slice(0, 32)} · ${fmt.day(c.eventDate)}` },
        { key: "temperature", label: "Temp", render: (c) => tempPill(c.temperature) },
        { key: "attendance", label: "Attended", render: (c) => c.attendance.replace("_", " ") },
        { key: "risk", label: "Health", render: (c) => riskPill(c.risk, c.status === "recently_lost" ? "Recently closed lost" : undefined, c.riskReason ?? undefined) },
        { key: "status", label: "Status", render: (c) => statusPill(c.status, c.statusLabel, c.risk) },
        { key: "touches", label: "Touches", num: true },
        { key: "lastTouchAt", label: "Last touch", render: (c) => fmt.day(c.lastTouchAt) },
        { key: "nextTaskDue", label: "Next task", render: (c) => fmt.day(c.nextTaskDue) },
        { key: "nextAction", label: "Next action", wrap: true },
      ], acc.contacts, { rowClass: (c) => (c.risk === "critical" ? "row-crit" : "") }));
      el.append(
        h("div", { class: "row", onclick: () => el.classList.toggle("open") },
          h("span", { class: "chev" }, "›"),
          h("span", null, h("b", null, acc.companyName ?? "(no company)"), hsLink("company", acc.companyId), " ", tempPill(acc.temperature), acc.icpTier ? h("span", { class: "faint" }, ` ${acc.icpTier}`) : null,
            h("div", { style: "margin-top:3px" }, dealBadge(acc))),
          h("span", { class: "muted", title: acc.events.map((e: any) => e.name).join("\n") }, acc.events.length === 1 ? (acc.events[0].name ?? "").slice(0, 28) : `${acc.events.length} events`),
          h("span", null, acc.sdrName ?? "–"),
          h("span", null, `${acc.contactsWorked}/${acc.eligibleContacts} worked`),
          h("span", { title: acc.depth ? `${acc.depth.touches} distinct touches on ${acc.depth.distinctDays} days across ${acc.depth.distinctWeeks} week(s), since eligibility` : undefined },
            `${acc.depth?.touches ?? acc.touches}`, acc.depth ? h("span", { class: "faint" }, ` · ${acc.depth.distinctWeeks}w`) : null, acc.lastTouch ? h("span", { class: "faint" }, ` · ${fmt.day(acc.lastTouch)}`) : null),
          h("span", { title: acc.healthLabel }, riskPill(acc.risk, acc.health === "recently_lost" ? "Recently closed lost" : undefined, `Worst contact status: ${acc.healthLabel}`)),
          h("span", { class: "muted" }, acc.nextAction)),
        contacts);
      return el;
    }) : h("div", { class: "empty" }, "No accounts match the filters"));

  return h("div", null,
    h("h2", null, "SDR execution", h("span", { class: "sub" }, "Coverage, SLA, depth and consistency side by side · * age-adjusted")),
    h("div", { class: "card" }, table(cols, s.rows, { initialSort: "health", desc: false, rowClass: (r) => (r.risk.health === "critical" ? "row-crit" : r.risk.health === "at_risk" ? "row-warn" : "") })),
    depthEl,
    h("h2", null, "Account queue", h("span", { class: "sub" }, `${fmt.n(a.total)} accounts · prioritised by temperature, overdue and stalled leads · touches de-duplicated across contacts`)),
    h("div", { class: "chips" }, HEALTH.map(([k, label]) => h("button", { class: health === k ? "on" : "", onclick: () => { location.hash = buildHash("sdr", f, { health: k, deal }); } }, label))),
    h("div", { class: "chips" }, h("span", { class: "muted", style: "align-self:center;margin-right:4px" }, "Deal history:"),
      ([["", "All"], ["open", "Open opportunity"], ["lost", "Has closed lost"], ["won", "Closed won"], ["none", "No deal"]] as const).map(([k, label]) =>
        h("button", { class: deal === k ? "on" : "", onclick: () => { location.hash = buildHash("sdr", f, { health, deal: k }); } }, label))),
    queue,
    a.total > a.rows.length ? h("p", { class: "legend" }, `Showing the top ${a.rows.length} accounts. Narrow with filters to see the rest.`) : null,
  );
}
