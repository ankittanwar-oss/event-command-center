import { api } from "../api.js";
import { lastContactText, leadTable, openLead } from "../drawer.js";
import { buildHash, filterParams, type Route } from "../state.js";
import { fmt, h, hsLink, tempPill } from "../ui.js";

// Daily Command Centre: the SDR's worklist. One row per account, one next action, placed in exactly one section.
// Timeliness reporting (reached out on time / late / not reached) lives in the CMO overview and SDR execution views.

const BLOCKS = [
  { key: "respond", label: "Replies needing attention" },
  { key: "overdue", label: "Overdue actions" },
  { key: "today", label: "Due today" },
  { key: "upcoming", label: "Upcoming actions" },
] as const;
const PRIMARY = new Set(["respond", "overdue", "today"]);
const ACTIONS = ["Respond", "Send first outreach", "Follow up", "Complete HubSpot task", "Monitor", "Paused", "Review next step", "Needs review"];

export async function dailyView(route: Route, meta: any): Promise<HTMLElement> {
  const f = route.filters;
  const x = route.extra;
  const d = await api("daily", filterParams(f));
  const w = d.work;
  const today: string = d.today ?? meta?.today;
  const go = (patch: Record<string, string>) => { location.hash = buildHash("daily", f, { ...Object.fromEntries(x), ...patch }); };

  // ---- local controls (do not change the global filters)
  const q = (x.get("q") ?? "").toLowerCase();
  const act = x.get("act") ?? "", ev = x.get("ev") ?? "", temp = x.get("temp") ?? "", sort = x.get("sort") ?? "urgency", only = x.get("sec") ?? "";
  const items: any[] = w.items.filter((i: any) =>
    (!q || [i.companyName, i.contactName, i.jobTitle, i.eventName].some((v) => (v ?? "").toLowerCase().includes(q))) &&
    (!act || i.action === act) && (!ev || i.events.some((e: any) => e.id === ev)) &&
    (!temp || (temp === "HotWarm" ? i.temperature === "Hot" || i.temperature === "Warm" : i.temperature === temp)));
  if (sort === "due") items.sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"));
  const count = (k: string) => items.filter((i) => i.section === k).length;

  const blocks = h("div", { class: "wblocks" }, BLOCKS.map((b) =>
    h("button", { class: `wblock ${b.key} ${only === b.key ? "sel" : ""}`, title: w.sections.find((s: any) => s.key === b.key)?.hint,
      onclick: () => go({ sec: only === b.key ? "" : b.key }) },
      h("span", { class: "wv" }, fmt.n(count(b.key))), h("span", { class: "wl" }, b.label))));

  const search = h("input", { type: "search", placeholder: "Search account, contact, event", value: x.get("q") ?? "" }) as HTMLInputElement;
  search.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") go({ q: search.value.trim() }); });
  const sel = (key: string, cur: string, opts: Array<[string, string]>) => {
    const s = h("select", { onchange: (e: Event) => go({ [key]: (e.target as HTMLSelectElement).value }) },
      opts.map(([v, l]) => { const o = h("option", { value: v }, l) as HTMLOptionElement; if (v === cur) o.selected = true; return o; }));
    return s;
  };
  const evs = new Map<string, string>();
  for (const i of w.items) for (const e of i.events) evs.set(e.id, `${(e.name ?? "").slice(0, 38)} · ${fmt.day(e.date)}`);
  const controls = h("div", { class: "wctl" }, search,
    sel("act", act, [["", "All actions"], ...ACTIONS.map((a) => [a, a] as [string, string])]),
    sel("ev", ev, [["", "All events in list"], ...[...evs.entries()]]),
    sel("temp", temp, [["", "Any temperature"], ["HotWarm", "Hot + Warm"], ["Hot", "Hot"], ["Warm", "Warm"]]),
    sel("sort", sort, [["urgency", "Sort: urgency"], ["due", "Sort: due date"]]));

  const dueText = (i: any) => {
    if (i.section === "overdue") return h("span", { class: "wdue od" }, `${i.overdueBusinessDays} bd overdue`);
    if (i.section === "respond") return h("span", { class: "wdue od" }, `replied ${fmt.day(i.replyAt)}`);
    if (i.section === "today") return h("span", { class: "wdue td" }, "due today");
    if (i.due) return h("span", { class: "wdue" }, `due ${fmt.day(i.due)}`);
    return h("span", { class: "wdue faint" }, "no due date");
  };

  const row = (i: any) => {
    const el = h("div", { class: `wrow s-${i.section}` });
    const more = h("div", { class: "wmore" });
    let open = false;
    const toggle = () => {
      open = !open; el.classList.toggle("open", open);
      if (open && !more.childElementCount) more.append(
        h("div", null, h("b", null, "Why: "), i.why, i.dueSource ? h("span", { class: "faint" }, ` · due date from ${({ reply: "reply date + 1 business day", task: "HubSpot task", sla: `${i.temperature ?? "Warm"} first-touch SLA from eligibility`, cadence: "follow-up cadence from last touch" } as any)[i.dueSource]}`) : null),
        h("div", null, h("b", null, "Event: "), i.events.map((e: any) => `${e.name} (${fmt.day(e.date)})`).join(" · ")),
        h("div", null, h("b", null, "Engagement: "), i.engagement ?? "No verified reply or meeting", " · ", i.attendance === "attended" ? "attended" : i.attendance === "no_show" ? "did not attend" : "attendance not recorded",
          i.eventCategory === "sponsored" && i.attendance === "attended" && !i.engagement ? h("span", { class: "faint" }, " (sponsored-event attendance alone is not verified engagement)") : null),
        h("div", null, h("b", null, "SDR: "), i.sdrName ?? "–", i.sdrSource === "pod_ae" ? h("span", { class: "faint" }, " (via AE pod)") : null,
          i.otherSdrTouches ? h("span", { class: "faint" }, ` · ${i.otherSdrTouches} touch(es) by a previous/other SDR, not credited`) : null),
        h("div", { class: "wcontacts" }, (() => { const box = h("div", { class: "faint" }, "Loading contacts…");
          api("leads", { ...filterParams(f), bucket: "eligible", search: i.companyName ?? "", limit: "300" }).then((r: any) => {
            const rows = r.rows.filter((x: any) => (x.companyId ?? `contact:${x.contactId}`) === i.key);
            box.replaceWith(rows.length ? leadTable(rows, { group: true }) : h("div", { class: "faint" }, "No contact records in the current filters"));
          }).catch(() => { box.textContent = "Could not load contacts"; });
          return box; })()),
        h("div", { class: "wlinks" },
          h("span", { class: "link", onclick: () => openLead(i.eventId, i.contactId) }, "Full history (activity, deals, ownership) →"),
          i.contacts > 1 ? h("span", { class: "faint" }, ` · ${i.contacts} contacts on this account${i.otherActions ? `, ${i.otherActions} with their own action` : ""}`) : null));
    };
    el.append(
      h("div", { class: "wmain", onclick: toggle },
        h("span", { class: "wdot" }),
        h("div", { class: "wco" },
          h("div", { class: "wl1" }, h("b", null, i.companyName ?? "(no company)"), hsLink("company", i.companyId), tempPill(i.temperature),
            i.engagement ? h("span", { class: "wtag eng" }, i.engagement) : null),
          h("div", { class: "wl2" }, h("span", { class: `abadge ${i.status?.color ?? "grey"}` }, i.status?.label ?? i.action), h("span", { class: "wwhy" }, i.status?.next ?? i.why),
            (i.status?.secondary ?? []).map((x: string) => h("span", { class: "sbadge" }, x)))),
        h("div", { class: "wct" },
          h("div", null, i.contactName, " ", hsLink("contact", i.contactId)),
          h("div", { class: "faint" }, (i.jobTitle ?? "").slice(0, 40))),
        h("div", { class: "wsd" },
          !f.sdr ? h("div", null, i.sdrName ?? "–") : null,
          h("div", { class: "faint" }, `${i.currentSdrTouches ?? "–"} touch${i.currentSdrTouches === 1 ? "" : "es"} by SDR`)),
        h("div", { class: "wlast" },
          dueText(i),
          h("div", { class: "faint", title: "Last qualifying outbound contact on this contact, by anyone" }, `Last: ${lastContactText(i.lastContact)}`))),
      more);
    return el;
  };

  const section = (s: any) => {
    const list = items.filter((i) => i.section === s.key);
    const collapsed = !PRIMARY.has(s.key) && only !== s.key && x.get(`open_${s.key}`) !== "1";
    const cap = 150;
    return h("div", { class: `wsec ${collapsed ? "closed" : ""}` },
      h("div", { class: "wsh", onclick: () => !PRIMARY.has(s.key) && go({ [`open_${s.key}`]: collapsed ? "1" : "" }) },
        !PRIMARY.has(s.key) ? h("span", { class: "chev" }, collapsed ? "▸" : "▾") : null,
        h("span", { class: "wst" }, s.label), h("span", { class: "wsn" }, fmt.n(list.length)), h("span", { class: "faint wsh-h" }, s.hint)),
      collapsed ? null : list.length ? h("div", { class: "wlist" }, list.slice(0, cap).map(row),
        list.length > cap ? h("div", { class: "faint", style: "padding:8px 12px" }, `Showing ${cap} of ${list.length}. Use search or filters to narrow.`) : null)
        : h("div", { class: "wempty" }, "Nothing here."));
  };

  const sections = (w.sections as any[]).filter((s) => !only || s.key === only);
  return h("div", { class: "wpage" },
    h("div", { class: "dlive" }, h("span", { class: "dot" }), `Live from HubSpot · synced ${fmt.ago(meta?.freshness?.lastSuccessAt)} · ${fmt.n(w.total)} event accounts · today ${fmt.day(today)}`),
    blocks, controls,
    only ? h("div", { class: "faint", style: "margin:4px 0 8px" }, "Filtered to one section · ", h("span", { class: "link", onclick: () => go({ sec: "" }) }, "show all")) : null,
    sections.map(section),
    h("div", { class: "faint", style: "margin-top:12px;font-size:12px" }, "Timeliness reporting (reached on time, late, not reached) is in CMO overview → SDR scorecard. Actions complete when the touch is logged in HubSpot and the next sync runs."));
}
