import { api } from "../api.js";
import { openCustom, openLead } from "../drawer.js";
import { buildHash, filterParams, type Route } from "../state.js";
import { dealTable, fmt, h, hsLink, tempPill } from "../ui.js";

// Daily Command Centre: one row per contact, grouped by what to do next.
// Respond · Reach out · Follow up · Coordinate with AE, plus "In progress / no action now" kept out of the way.
// Event-level reporting (CMO overview, drill-downs) is unchanged; this view only regroups the same records.

const ACTION_GROUPS = ["respond", "reach_out", "follow_up", "coordinate"];
const PAGE = 100;

const who = (o: any) => (o ? `${o.name ?? "Unknown user"}${o.role ? ` (${o.role})` : ""}` : null);

export async function dailyView(route: Route, meta: any): Promise<HTMLElement> {
  const f = route.filters;
  const x = route.extra;
  const d = await api("daily", filterParams(f));
  const C = d.contacts;
  const go = (patch: Record<string, string>) => { location.hash = buildHash("daily", f, { ...Object.fromEntries(x), ...patch }); };
  const grp = x.get("g") ?? "";
  const q = (x.get("q") ?? "").toLowerCase(), temp = x.get("temp") ?? "", ev = x.get("ev") ?? "";

  const base: any[] = C.items.filter((i: any) =>
    (!q || [i.companyName, i.contactName, i.jobTitle, ...i.events.map((e: any) => e.name)].some((v) => (v ?? "").toLowerCase().includes(q))) &&
    (!temp || (temp === "HotWarm" ? i.temperature === "Hot" || i.temperature === "Warm" : i.temperature === temp)) &&
    (!ev || i.events.some((e: any) => e.id === ev)));
  const count = (k: string) => base.filter((i) => i.group === k).length;

  // ---- group tabs (counts reflect search/temperature/event filters)
  const tab = (k: string, label: string, hint: string) => h("button", { class: `gtab g-${k} ${grp === k ? "sel" : ""}`, title: hint, onclick: () => go({ g: grp === k ? "" : k }) },
    h("span", { class: "gv" }, fmt.n(count(k))), h("span", { class: "gl" }, label));
  const groups: any[] = C.groups;
  const tabs = h("div", { class: "gtabs" },
    groups.filter((g) => ACTION_GROUPS.includes(g.key)).map((g) => tab(g.key, g.label, g.hint)),
    h("span", { class: "gsep" }),
    (() => { const g = groups.find((y) => y.key === "progress"); return tab(g.key, g.label, g.hint); })());

  // ---- controls
  const search = h("input", { type: "search", placeholder: "Search company, contact, title, event", value: x.get("q") ?? "" }) as HTMLInputElement;
  search.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") go({ q: search.value.trim() }); });
  const sel = (key: string, cur: string, opts: Array<[string, string]>) => h("select", { onchange: (e: Event) => go({ [key]: (e.target as HTMLSelectElement).value }) },
    opts.map(([v, l]) => { const o = h("option", { value: v }, l) as HTMLOptionElement; if (v === cur) o.selected = true; return o; }));
  const evs = new Map<string, string>();
  for (const i of C.items) for (const e of i.events) evs.set(e.id, `${(e.name ?? "").slice(0, 40)} · ${fmt.day(e.date)}`);
  const controls = h("div", { class: "wctl" }, search,
    sel("temp", temp, [["", "Any temperature"], ["HotWarm", "Hot + Warm"], ["Hot", "Hot"], ["Warm", "Warm"]]),
    sel("ev", ev, [["", "All events"], ...[...evs.entries()]]));

  // ---- one compact row per contact
  const row = (i: any) => {
    const last = i.lastOutboundAt ? `${fmt.day(i.lastOutboundAt)} · ${who(i.lastBy) ?? "owner not recorded"}` : "Not contacted yet";
    const earlier = !i.yourTouches && i.otherSdrTouches ? `earlier: ${i.otherSdrTouches} by ${i.otherBy?.name ?? "another SDR"}` : null;
    return h("div", { class: `crow2 c-${i.color}`, tabindex: "0", onclick: () => details(i), onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter") details(i); } },
      h("span", { class: "cdot2" }),
      h("div", { class: "cwho" },
        h("div", { class: "cl1" }, h("b", null, i.companyName ?? "(no company)"), " · ", i.contactName),
        h("div", { class: "cl2" }, i.jobTitle ?? "")),
      h("div", { class: "cdo" },
        h("div", { class: "cact" }, i.action),
        h("div", { class: "cwhy" }, i.reason)),
      h("div", { class: "cmeta2" },
        h("div", null, !f.sdr ? `${i.sdrName ?? "No SDR"} · ` : "", h("span", { title: "Current SDR's qualifying touches since the event" }, `${i.yourTouches} your touch${i.yourTouches === 1 ? "" : "es"}`)),
        h("div", { class: "faint", title: "Last outbound contact by anyone (SDR, AE or other)" }, `Last: ${last}`),
        earlier ? h("div", { class: "faint" }, earlier) : null),
      h("div", { class: "ctags" }, tempPill(i.temperature), i.deal ? h("span", { class: "sbadge", title: i.deal.via === "contact" ? "Deal associated with this contact" : "Deal on the company; this contact may not be involved" }, i.deal.via === "contact" ? "Deal with contact" : "Open deal on company") : null));
  };

  const section = (g: any) => {
    const list = base.filter((i) => i.group === g.key);
    const wrap = h("div", { class: "wlist" });
    let shown = 0;
    const more = h("button", { class: "btn more" }, "Show more");
    const add = () => {
      wrap.append(...list.slice(shown, shown + PAGE).map(row));
      shown = Math.min(list.length, shown + PAGE);
      more.textContent = `Show more (${list.length - shown} left)`;
      more.style.display = shown < list.length ? "" : "none";
    };
    more.addEventListener("click", (e) => { e.stopPropagation(); add(); });
    if (list.length) add();
    return h("div", { class: "wsec" },
      h("div", { class: "wsh" }, h("span", { class: "wst" }, g.label), h("span", { class: "wsn" }, fmt.n(list.length)), h("span", { class: "faint wsh-h" }, g.hint)),
      list.length ? [wrap, more] : h("div", { class: "wempty" }, g.key === "respond" ? "No replies or HubSpot tasks due. Nice." : "Nothing here."));
  };

  const shownGroups = grp ? groups.filter((g) => g.key === grp) : groups.filter((g) => ACTION_GROUPS.includes(g.key));
  const done = base.filter((i) => i.yourTouches > 0).length;
  return h("div", { class: "wpage" },
    h("div", { class: "dlive" }, h("span", { class: "dot" }), `Live from HubSpot · synced ${fmt.ago(meta?.freshness?.lastSuccessAt)} · ${fmt.n(base.length)} contacts · `,
      h("b", null, `${fmt.n(done)} already contacted by their SDR`)),
    tabs, controls,
    grp ? h("div", { class: "faint", style: "margin:4px 0 8px" }, "Showing one group · ", h("span", { class: "link", onclick: () => go({ g: "" }) }, "show today's work")) : null,
    shownGroups.map(section),
    !grp ? h("div", { class: "faint", style: "margin-top:10px;font-size:12px" }, `${fmt.n(count("progress"))} contacts are in progress or need no action now. `, h("span", { class: "link", onclick: () => go({ g: "progress" }) }, "View them")) : null);
}

/** Right-side drawer: next action first, then contact, outreach history, ownership, events, commercial context. */
async function details(i: any) {
  const box = h("div", { class: "cdrawer" });
  openCustom(i.contactName, `${i.companyName ?? ""}${i.jobTitle ? ` · ${i.jobTitle}` : ""}`, box);
  const kv = (k: string, v: any) => (v === null || v === undefined || v === "" ? null : [h("div", { class: "k" }, k), h("div", null, v)]);
  const sec = (t: string, ...c: any[]) => h("div", { class: "dsec2" }, h("div", { class: "dt" }, t), ...c);
  box.append(
    h("div", { class: `nextbox c-${i.color}` }, h("div", { class: "na" }, i.action), h("div", { class: "nr" }, i.reason), i.due ? h("div", { class: "faint" }, `Due ${fmt.day(i.due)}`) : null),
    sec("Contact", h("div", { class: "kv tight" },
      kv("Contact", [i.contactName, " ", hsLink("contact", i.contactId, "Open in HubSpot ↗")]),
      kv("Company", [i.companyName ?? "–", " ", hsLink("company", i.companyId, "Open in HubSpot ↗")]),
      kv("Email", i.contactEmail), kv("Temperature", tempPill(i.temperature)))),
    sec("Outreach", h("div", { class: "kv tight" },
      kv("Your touches", `${i.yourTouches} by ${i.sdrName ?? "the current SDR"} since the event`),
      kv("Last contacted", i.lastOutboundAt ? `${fmt.day(i.lastOutboundAt)} · ${who(i.lastBy) ?? "owner not recorded"}` : "Not contacted yet"),
      kv("Other SDR outreach", i.otherSdrTouches ? `${i.otherSdrTouches} touch${i.otherSdrTouches === 1 ? "" : "es"}${i.lastOtherSdrTouch ? `, last ${fmt.day(i.lastOtherSdrTouch.at)} by ${who(i.otherBy) ?? "another SDR"}` : ""} (not credited to ${i.sdrName ?? "the current SDR"})` : null)),
      h("div", { class: "histbox" }, h("div", { class: "faint" }, "Loading activity…"))),
    sec("Ownership", h("div", { class: "kv tight" },
      kv("Current SDR", `${i.sdrName ?? "Not assigned"}${i.sdrSource === "pod_ae" ? " (via the company's AE pod)" : ""}`),
      kv("Allocated", i.allocationDate ? fmt.day(i.allocationDate) : "Allocation date not recorded"))),
    sec(i.events.length > 1 ? `Events (${i.events.length})` : "Event", h("div", null, i.events.map((e: any) =>
      h("div", { class: "evline" }, h("span", { class: "link", onclick: () => openLead(e.id, i.contactId) }, e.name), h("span", { class: "faint" }, ` · ${fmt.day(e.date)} · ${e.attendance === "attended" ? "attended" : e.attendance === "no_show" ? "no-show" : "attendance not recorded"}`))))),
    sec("Commercial", i.deal ? h("div", { class: "kv tight" },
      kv("Open deal", [i.deal.name ?? `Deal ${i.deal.id}`, " ", hsLink("deal", i.deal.id, "↗")]),
      kv("Stage", i.deal.stage), kv("Deal owner", who(i.dealOwner) ?? "Not available"),
      kv("Linked to", i.deal.via === "contact" ? "This contact" : "The company only: this contact may not be involved")) : h("div", { class: "faint" }, "No open deal")));
  // Outreach history from the stored activities (same source as the lead audit). Most useful first; full list collapsed.
  try {
    const r = await api(`leads/${i.eventId}/${i.contactId}`);
    const acts: any[] = (r.activities ?? []).filter((a: any) => a.via === "contact");
    const line = (a: any) => h("div", { class: "actline" }, h("span", null, fmt.day(a.timestamp)), h("span", null, `${a.kind.toLowerCase().replace("_", " ")}`), h("span", null, a.ownerName ?? "–"),
      h("span", { class: a.counted ? "ok-t" : "faint" }, a.counted ? "SDR touch" : a.why));
    const hist = box.querySelector(".histbox")!;
    hist.replaceChildren(acts.length ? h("div", null, acts.slice(0, 5).map(line),
      acts.length > 5 ? h("details", null, h("summary", { class: "link" }, `Full history (${acts.length})`), acts.slice(5).map(line)) : null) : h("div", { class: "faint" }, "No activity logged on this contact"));
    if (r.enriched?.deals?.length) box.append(sec("All deals", dealTable(r.enriched.deals)));
  } catch { box.querySelector(".histbox")!.replaceChildren(h("div", { class: "faint" }, "Activity history unavailable")); }
}
