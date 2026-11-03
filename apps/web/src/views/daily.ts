import { api } from "../api.js";
import { openCustom, openLead } from "../drawer.js";
import { buildHash, filterParams, type Route } from "../state.js";
import { dealTable, fmt, h, hsLink, tempPill } from "../ui.js";

// Daily Command Centre: account-first. Each HubSpot company appears once, in its highest-priority bucket; every
// contact keeps its own action underneath. Event-level reporting (CMO overview, drill-downs) is unchanged.


const firstName = (n: string | null | undefined) => (n ?? "").split(" ")[0];
const today = () => new Date().toISOString().slice(0, 10);
/** Company intent pill: current HubSpot Account Intent Level, never the event-lead label. */
const intentPill = (it: any) => {
  const lv = it?.level ?? "unknown";
  const txt = !it?.synced ? "Intent: not synced" : lv === "unknown" ? "Intent: unknown" : `${lv === "hot" ? "Surging" : lv[0].toUpperCase() + lv.slice(1)}`;
  return h("span", { class: `ipill i-${it?.synced ? lv : "unknown"}`, title: it?.raw ? `Account Intent Level: ${it.raw}${it.since ? ` since ${it.since}` : ""}` : "No Account Intent Level recorded for this company" }, txt);
};
const intentWhy = (it: any) => {
  if (!it?.synced) return "Account intent not yet synced";
  const parts = [
    it.level === "unknown" ? "No Account Intent Level" : it.since ? `since ${fmt.day(it.since)}` : null,
    it.sdrCategory, it.icp,
    it.reason ? it.reason : it.recentSignals ? `signals: ${it.recentSignals}` : it.level !== "unknown" ? "detailed trigger not recorded" : null,
  ];
  return parts.filter(Boolean).join(" · ");
};
const who = (o: any) => (o ? `${o.name ?? "Unknown user"}${o.role ? ` (${o.role})` : ""}` : null);

// Account placement order (an account appears once, in the highest applicable bucket).
const BUCKETS = [
  { key: "respond", label: "Respond now", hint: "A prospect replied, or a HubSpot task is due" },
  { key: "first_outreach", label: "First outreach", hint: "Account not worked yet" },
  { key: "follow_up", label: "Follow up", hint: "Worked; a further touch is due with an active contact" },
  { key: "review", label: "Needs review", hint: "Missing or contradictory data" },
  { key: "progress", label: "Up to date / in progress", hint: "Worked; nothing due now (multithreading optional)" },
  { key: "paused", label: "Paused / closed", hint: "Verified company-wide disposition, or every worked contact paused" },
  { key: "low", label: "Lower priority", hint: "Not worked; Cold intent, no verified engagement" },
  { key: "qualified", label: "Qualified / handed off", hint: "Verified SQL; no outstanding SDR action" },
] as const;
const RANK: Record<string, number> = Object.fromEntries(BUCKETS.map((b, i) => [b.key, i]));
const SHORT: Record<string, [string, string]> = { respond: ["reply/task", "replies/tasks"], first_outreach: ["first outreach", "first outreach"], follow_up: ["follow-up", "follow-ups"],
  review: ["review", "reviews"], progress: ["in progress", "in progress"], low: ["lower priority", "lower priority"], qualified: ["qualified", "qualified"], paused: ["paused", "paused"] };
const ACC_PAGE = 50;

// Expanded state survives re-renders within the session (filters, navigation). Browser storage is optional.
const STATE_KEY = "ecc-daily-open-v1";
const openState: { buckets: Set<string> | null; accounts: Set<string> } = (() => {
  try { const v = JSON.parse(sessionStorage.getItem(STATE_KEY) ?? "null"); if (v) return { buckets: new Set<string>(v.buckets), accounts: new Set<string>(v.accounts) }; } catch { /* ignore */ }
  return { buckets: null, accounts: new Set<string>() };
})();
const saveState = () => { try { sessionStorage.setItem(STATE_KEY, JSON.stringify({ buckets: [...(openState.buckets ?? [])], accounts: [...openState.accounts] })); } catch { /* ignore */ } };

export async function dailyView(route: Route, meta: any): Promise<HTMLElement> {
  const f = route.filters;
  const x = route.extra;
  const d = await api("daily", filterParams(f));
  const C = d.contacts;
  const go = (patch: Record<string, string>) => { location.hash = buildHash("daily", f, { ...Object.fromEntries(x), ...patch }); };
  const qRaw = x.get("q") ?? "", q = qRaw.toLowerCase(), intentF = x.get("intent") ?? "", ev = x.get("ev") ?? "";

  // ---- filters (search matches company OR contact; a matching contact brings its whole account so context stays visible)
  const matchContact = (i: any) => !!q && [i.contactName, i.jobTitle, i.contactEmail, ...i.events.map((e: any) => e.name)].some((v) => (v ?? "").toLowerCase().includes(q));
  // Accounts come from the server (grouped by HubSpot company id). Filters keep an account when any of its contacts match.
  const okContact = (i: any) => (!intentF || (intentF === "hotwarm" ? ["hot", "warm"].includes(i.intent?.level) : i.intent?.level === intentF)) && (!ev || i.events.some((e: any) => e.id === ev));
  const accounts: any[] = d.accountView.items.filter((a: any) => a.contacts.some(okContact) &&
    (!q || (a.companyName ?? "").toLowerCase().includes(q) || a.contacts.some(matchContact)));
  const base: any[] = accounts.flatMap((a) => a.contacts);
  const hits = new Set(base.filter(matchContact).map((i) => i.contactId));

  // ---- progress: ACCOUNT coverage first, contact depth second
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const accWorked = accounts.filter((a) => a.worked).length;
  const touched = base.filter((i) => i.yourTouches > 0).length, two = base.filter((i) => i.yourTouches >= 2).length;
  const week = base.filter((i) => i.yourLastTouchAt && i.yourLastTouchAt.slice(0, 10) >= weekAgo).length;
  const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "–");
  const stat = (v: any, l: string, sub?: string) => h("div", { class: "pt" }, h("b", null, typeof v === "number" ? fmt.n(v) : v), h("span", null, l), sub ? h("small", null, sub) : null);
  const progress = h("div", { class: "ptrack" },
    h("div", { class: "pg main" }, h("div", { class: "pgt" }, "Accounts"), stat(accounts.length, "assigned & eligible"), stat(accWorked, "worked", pct(accWorked, accounts.length) + " coverage"),
      stat(accounts.length - accWorked, "not worked"), stat(accounts.filter((a) => a.bucket === "follow_up").length, "need follow-up"),
      stat(accounts.filter((a) => a.conversation).length, "in conversation"), stat(accounts.filter((a) => a.bucket === "paused").length, "paused / closed"), stat(accounts.filter((a) => a.bucket === "qualified").length, "qualified")),
    h("div", { class: "pg" }, h("div", { class: "pgt" }, "Eligible event contacts"), stat(base.length, "contacts"), stat(touched, "worked", pct(touched, base.length)), stat(two, "2+ touches"), stat(week, "touched last 7 days")));

  // ---- top counters: unique accounts per primary bucket + contacts with that contact-level action
  const accIn = (k: string) => accounts.filter((a) => a.bucket === k);
  const conIn = (k: string) => accIn(k).reduce((n, a) => n + a.contacts.length, 0);
  const counters = h("div", { class: "gtabs" }, BUCKETS.slice(0, 3).concat(BUCKETS.filter((b) => b.key === "qualified") as any).map((b) =>
    h("button", { class: `gtab g-${b.key}`, title: b.hint, onclick: () => { setOpen(b.key, true); document.getElementById(`bk-${b.key}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); } },
      h("span", { class: "gv" }, fmt.n(accIn(b.key).length)), h("span", { class: "gl" }, `${b.label} accounts`, h("br"), h("small", null, `${fmt.n(conIn(b.key))} contacts in these accounts`)))));

  // ---- controls
  const search = h("input", { type: "search", placeholder: "Search company or contact", value: qRaw }) as HTMLInputElement;
  search.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") go({ q: search.value.trim() }); });
  const sel = (key: string, cur: string, opts: Array<[string, string]>) => h("select", { onchange: (e: Event) => go({ [key]: (e.target as HTMLSelectElement).value }) },
    opts.map(([v, l]) => { const o = h("option", { value: v }, l) as HTMLOptionElement; if (v === cur) o.selected = true; return o; }));
  const evs = new Map<string, string>();
  for (const i of C.items) for (const e of i.events) evs.set(e.id, `${(e.name ?? "").slice(0, 40)} · ${fmt.day(e.date)}`);
  const controls = h("div", { class: "wctl" }, search,
    sel("intent", intentF, [["", "Any account intent"], ["hotwarm", "Hot + Warm"], ["hot", "Hot (Surging)"], ["warm", "Warm"], ["cold", "Cold"], ["unknown", "Unknown"]]),
    sel("ev", ev, [["", "All events"], ...[...evs.entries()]]),
    h("span", { class: "xall" }, h("button", { class: "linkbtn", onclick: () => { for (const b of BUCKETS) setOpen(b.key, true); } }, "Expand all"), " · ",
      h("button", { class: "linkbtn", onclick: () => { for (const b of BUCKETS) setOpen(b.key, false); } }, "Collapse all")));

  // ---- contact row (nested under its account)
  const contactRow = (i: any) => {
    if (i.multithread) i = { ...i, color: "grey" };
    const last = i.lastOutboundAt ? `${fmt.day(i.lastOutboundAt)} · ${who(i.lastBy) ?? "owner not recorded"}` : "Not contacted";
    const timing = i.overdueBusinessDays ? ` · ${i.overdueBusinessDays} bd overdue` : i.due ? (i.due === today() ? " · due today" : ` · due ${fmt.day(i.due)}`) : "";
    const prev = i.otherSdrTouches ? ` · ${i.otherSdrTouches} by ${i.otherBy?.name ?? "another SDR"}` : "";
    return h("div", { class: `ctrow c-${i.color} ${hits.has(i.contactId) ? "hit" : ""}` },
      h("span", { class: "cdot2" }),
      h("div", { class: "ctn" }, h("span", { class: "link", onclick: () => details(i) }, i.contactName), " ", hsLink("contact", i.contactId), i.jobTitle ? h("span", { class: "faint" }, ` · ${i.jobTitle}`) : null,
        h("div", { class: "faint ctev" }, i.engagement)),
      h("div", { class: "ctl" }, h("div", null, `Last: ${last}`), h("div", { class: "faint" }, `${i.yourTouches} by ${firstName(i.sdrName) || "SDR"}${prev}`)),
      h("div", { class: "cta" }, h("span", { class: "cact" }, i.multithread ? "Optional: multithread" : i.action), h("span", { class: "ctime" }, i.multithread ? "" : timing),
        h("div", { class: "faint cwhy" }, i.multithread ? "Account already worked; another stakeholder you could engage" : i.reason)));
  };

  // ---- account row (click to expand its contacts)
  const accountRow = (a: any) => {
    const secondary = BUCKETS.filter((b) => a.actions[b.key]).map((b) => `${a.actions[b.key]} ${SHORT[b.key]![a.actions[b.key] === 1 ? 0 : 1]}`).join(" · ");
    const autoOpen = q && a.contacts.some((c: any) => hits.has(c.contactId));
    const isOpen = openState.accounts.has(a.key) || !!autoOpen;
    const body = h("div", { class: "acontacts" });
    const chev = h("span", { class: "chev" }, isOpen ? "▾" : "▸");
    const el = h("div", { class: `arow ${isOpen ? "open" : ""}` });
    const render = () => { if (!body.childElementCount) body.append(
      h("div", { class: "acov faint" }, `Eligible event contacts: ${a.coverage.available} · worked ${a.coverage.worked} · not worked ${a.coverage.notWorked} · in conversation ${a.coverage.active} · paused ${a.coverage.paused}${a.coverage.qualified ? ` · qualified ${a.coverage.qualified}` : ""}`,
        a.companyId ? [" · ", h("span", { class: "link", onclick: (e: Event) => { e.stopPropagation(); dispositionForm("company", a.companyId, a.companyName, a.companyDisposition); } }, a.companyDisposition ? "Edit account disposition" : "Set account disposition")] : null),
      ...(a.companyDisposition ? [h("div", { class: "adisp" }, `Account ${a.companyDispositionLabel}: ${a.companyDisposition.reason ?? ""}${a.companyDisposition.source === "hubspot" ? " (from HubSpot)" : ` · confirmed by ${a.companyDisposition.confirmedBy}`}${a.companyDisposition.revisitDate ? ` · revisit ${fmt.day(a.companyDisposition.revisitDate)}` : ""}`)] : []),
      ...a.contacts.map(contactRow)); };
    const toggle = () => {
      const now = !el.classList.contains("open");
      el.classList.toggle("open", now); chev.textContent = now ? "▾" : "▸";
      if (now) { render(); openState.accounts.add(a.key); } else openState.accounts.delete(a.key);
      saveState();
    };
    if (isOpen) render();
    const t = a.top;
    const status = a.companyDisposition ? a.companyDispositionLabel : a.worked ? "Worked" : "Not worked";
    el.append(
      h("div", { class: `ahead c-${a.bucket === "paused" ? "grey" : t.color}`, tabindex: "0", onclick: toggle, onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter") toggle(); } },
        chev,
        h("div", { class: "aname" }, h("b", null, a.companyName ?? "(no company)"), " ", a.companyId ? h("span", { onclick: (e: Event) => e.stopPropagation() }, hsLink("company", a.companyId)) : null, " ", intentPill(a.intent),
          h("div", { class: "faint awhy" }, intentWhy(a.intent))),
        h("div", { class: "astat" }, h("div", null, h("span", { class: `wk ${a.worked ? "y" : "n"}` }, status), ` · ${a.coverage.worked}/${a.coverage.available} contacts worked`),
          h("div", { class: "faint" }, a.lastSdrTouch ? `Last SDR touch ${fmt.day(a.lastSdrTouch)}` : "No SDR touch yet", !f.sdr && a.sdrName ? ` · ${a.sdrName}` : "")),
        h("div", { class: "aact" }, h("div", { class: "cact" }, a.bucket === "paused" ? "No routine outreach" : a.bucket === "progress" && a.coverage.notWorked ? `On track · ${a.coverage.notWorked} more contact${a.coverage.notWorked === 1 ? "" : "s"} available` : t.action,
          t.overdueBusinessDays && a.bucket !== "paused" ? h("span", { class: "ctime" }, ` · ${t.overdueBusinessDays} bd overdue`) : null),
          h("div", { class: "faint" }, secondary))),
      body);
    return el;
  };

  // ---- collapsible buckets (independent; counts always visible)
  const bucketEls = new Map<string, { el: HTMLElement; fill: () => void; chev: HTMLElement }>();
  const defaultOpen = () => { const first = BUCKETS.find((b) => accIn(b.key).length); return new Set(first ? [first.key] : []); };
  if (!openState.buckets) openState.buckets = defaultOpen();
  if (q) for (const a of accounts) openState.buckets.add(a.bucket); // a search opens the buckets that contain matches
  function setOpen(k: string, open: boolean) {
    const b = bucketEls.get(k); if (!b) return;
    b.el.classList.toggle("open", open); b.chev.textContent = open ? "▾" : "▸";
    if (open) { b.fill(); openState.buckets!.add(k); } else openState.buckets!.delete(k);
    saveState();
  }
  const bucket = (b: (typeof BUCKETS)[number]) => {
    const list = accIn(b.key);
    const contacts = list.reduce((n, a) => n + a.contacts.length, 0);
    const chev = h("span", { class: "chev" }, "▸");
    const body = h("div", { class: "bbody" });
    let shown = 0;
    const more = h("button", { class: "btn more", style: "display:none" }, "Show more");
    const addPage = () => { body.insertBefore(h("div", null, list.slice(shown, shown + ACC_PAGE).map(accountRow)), more); shown = Math.min(list.length, shown + ACC_PAGE); more.textContent = `Show more accounts (${list.length - shown} left)`; more.style.display = shown < list.length ? "" : "none"; };
    more.addEventListener("click", addPage);
    body.append(more);
    const fill = () => { if (!shown && list.length) addPage(); if (!list.length && !body.querySelector(".wempty")) body.prepend(h("div", { class: "wempty" }, "Nothing here.")); };
    const el = h("div", { class: `bucket b-${b.key}`, id: `bk-${b.key}` },
      h("button", { class: "bhead", onclick: () => setOpen(b.key, !el.classList.contains("open")) },
        chev, h("span", { class: "wst" }, b.label), h("span", { class: "bcount" }, `${fmt.n(list.length)} account${list.length === 1 ? "" : "s"} · ${fmt.n(contacts)} contact${contacts === 1 ? "" : "s"}`), h("span", { class: "faint wsh-h" }, b.hint)),
      body);
    bucketEls.set(b.key, { el, fill, chev });
    return el;
  };
  const page = h("div", { class: "wpage" },
    h("div", { class: "dlive" }, h("span", { class: "dot" }), `Live from HubSpot · synced ${fmt.ago(meta?.freshness?.lastSuccessAt)} · accounts grouped by HubSpot company · `, h("span", { class: "faint", title: d.accountView.window }, "Worked = 1+ qualifying SDR outreach to any eligible event contact (hover for details)")),
    progress, counters, controls,
    BUCKETS.map(bucket));
  for (const k of openState.buckets) setOpen(k, true);
  return page;
}

/** Right-side drawer: A. next action · B. outreach history · C. qualification & deal. Details collapsed. */
async function details(i: any) {
  const box = h("div", { class: "cdrawer" });
  openCustom(i.contactName, `${i.companyName ?? ""}${i.jobTitle ? ` · ${i.jobTitle}` : ""}`, box);
  const kv = (k: string, v: any) => (v === null || v === undefined || v === "" ? null : [h("div", { class: "k" }, k), h("div", null, v)]);
  const sec = (t: string, ...c: any[]) => h("div", { class: "dsec2" }, h("div", { class: "dt" }, t), ...c);
  const more = (t: string, ...c: any[]) => h("details", { class: "dmore" }, h("summary", null, t), ...c);
  const kindTxt = (k: string | null) => (k ? ({ EMAIL: "email", CALL: "call", MEETING: "meeting", LINKEDIN: "LinkedIn" } as Record<string, string>)[k] ?? k.toLowerCase() : null);
  const sqlTxt = i.deal?.sqlDate ? `Yes · qualified ${fmt.day(i.deal.sqlDate)}` : i.deal ? "No · the open deal has no Became Qualified to Buy Date" : "No · no open deal";
  const it = i.intent ?? {};
  box.append(
    h("div", { class: `nextbox c-${i.color}` },
      h("div", { class: "na" }, i.action), h("div", { class: "nr" }, i.reason),
      h("div", { class: "faint" }, [i.due ? `Due ${fmt.day(i.due)}` : null, `SDR: ${i.sdrName ?? "not assigned"}${i.sdrSource === "pod_ae" ? " (via AE pod)" : ""}`, i.allocationDate ? `allocated ${fmt.day(i.allocationDate)}` : null].filter(Boolean).join(" · ")),
      h("div", { class: "nlinks" }, hsLink("contact", i.contactId, "Contact in HubSpot ↗"), " ", hsLink("company", i.companyId, "Company ↗"), i.contactEmail ? h("span", { class: "faint" }, ` · ${i.contactEmail}`) : null)),
    // 1. ACCOUNT INTENT (company level, current)
    sec("Account intent · company", h("div", { class: "kv tight" },
      kv("Current level", [intentPill(it), it.raw ? h("span", { class: "faint" }, ` ${it.raw}`) : null]),
      kv("Since", it.since ? fmt.day(it.since) : it.synced && it.level !== "unknown" ? "Date not recorded" : null),
      kv("SDR signal category", it.sdrCategory ?? (it.synced ? "Not set" : null)),
      kv("Detailed trigger", it.synced ? (it.reason ?? "Not recorded in HubSpot (the category above is the only signal context)") : "Not yet synced"),
      kv("ICP tier", it.icp),
      kv("Lifecycle stage (custom)", it.lifecycleCustom),
      kv("Total engagement score", it.engagementScore !== null && it.engagementScore !== undefined ? `${it.engagementScore} (supporting only)` : null),
      kv("Factors intent", it.synced ? (it.factorsIntent ?? "Not populated") : null),
      kv("Recent signals (30 days)", it.recentSignals),
      kv("History", [it.coldAt ? `Cold ${fmt.day(it.coldAt)}` : null, it.warmAt ? `Warm ${fmt.day(it.warmAt)}` : null, it.surgingAt ? `Surging ${fmt.day(it.surgingAt)}` : null].filter(Boolean).join(" → ") || null),
      kv("Source", "HubSpot company: Account Intent Level (account_type) and Date entered Cold/Warm/Surging Stage"),
      kv("Event-lead label", i.temperature ? `${i.temperature} (event classification, kept separate from current intent)` : null))),
    sec("Ownership", h("div", { class: "kv tight" },
      kv("Assigned SDR (used here)", `${i.sdrName ?? "Not assigned"}${i.sdrSource === "pod_ae" ? " (via the company AE's pod)" : ""}`),
      kv("Company SDR owner", who(i.own?.companySdr) ?? "Not set"),
      kv("Company owner (AE)", who(i.own?.companyOwner) ?? "Not set"),
      kv("Contact owner", who(i.own?.contactOwner) ?? "Not set"),
      kv("Contact SDR field", who(i.own?.contactSdr) ?? "Not set"),
      kv("Company allocation date", i.allocationDate ? fmt.day(i.allocationDate) : "Not recorded"),
      kv("Associated companies", i.own ? (i.own.companyCount > 1 ? `${i.own.companyCount} (primary company used)` : String(i.own.companyCount)) : null))),
    sec("Disposition", h("div", { class: "kv tight" },
      kv("Contact", i.disposition ? `${i.disposition.reason ?? ""}${i.disposition.source === "hubspot" ? " (from HubSpot)" : ` · confirmed by ${i.disposition.confirmedBy}`}` : "Active"),
      kv("Account", i.companyDisposition ? `${i.companyDisposition.reason ?? ""} (company-wide)` : "No company-wide disposition")),
      h("div", null, h("span", { class: "link", onclick: () => dispositionForm("contact", i.contactId, i.contactName, i.disposition) }, i.disposition ? "Edit contact disposition" : "Set contact disposition"))),
    // 2. CONTACT ENGAGEMENT
    sec("Contact engagement", h("div", { class: "kv tight" },
      kv("Event engagement", i.engagement),
      kv("Active conversation", i.conversation ?? "None in the last 30 days"),
      kv("Last contacted", i.lastOutboundAt ? `${fmt.day(i.lastOutboundAt)} · ${who(i.lastBy) ?? "owner not recorded"}${kindTxt(i.lastOutboundKind) ? ` · ${kindTxt(i.lastOutboundKind)}` : ""}` : "Not contacted yet"),
      kv("Last prospect reply", i.lastReplyAt ? fmt.day(i.lastReplyAt) : "None recorded"),
      kv(`${firstName(i.sdrName) || "SDR"}'s touches`, `${i.yourTouches} since the event${i.yourTouchesSinceAllocation !== null && i.yourTouchesSinceAllocation !== i.yourTouches ? ` · ${i.yourTouchesSinceAllocation} since allocation (${fmt.day(i.allocationDate)})` : ""}`),
      kv("Previous SDR outreach", i.otherSdrTouches ? `${i.otherSdrTouches} touch${i.otherSdrTouches === 1 ? "" : "es"} by ${who(i.otherBy) ?? "another SDR"}${i.lastOtherSdrTouch ? `, last ${fmt.day(i.lastOtherSdrTouch.at)}` : ""} (not credited)` : "None"),
      kv("Open task", i.nextTask ? `${i.nextTask.subject ?? "HubSpot task"} · due ${fmt.day(i.nextTask.due)}` : "None")),
      h("div", { class: "histbox" }, h("div", { class: "faint" }, "Loading recent activity…"))),
    // 3. DEAL QUALIFICATION
    sec("Deal qualification", h("div", { class: "kv tight" },
      kv("SQL", sqlTxt),
      i.deal ? kv("Relevant deal", [i.deal.name ?? `Deal ${i.deal.id}`, " ", hsLink("deal", i.deal.id, "↗")]) : null,
      i.deal ? kv("Stage", i.deal.stage ?? "–") : null,
      i.deal ? kv("AE / deal owner", who(i.dealOwner) ?? "Not available") : null,
      i.deal ? kv("Associated with", i.deal.via === "contact" ? "This contact" : "The company only (contact may not be involved)") : null,
      i.deal ? kv("Documented next step", "Not synced from HubSpot") : null)),
    more(`Events (${i.events.length})`, h("div", null, i.events.map((e: any) =>
      h("div", { class: "evline" }, h("span", { class: "link", onclick: () => openLead(e.id, i.contactId) }, e.name), h("span", { class: "faint" }, ` · ${fmt.day(e.date)} · ${e.category} · ${e.attendance === "attended" ? "attended" : e.attendance === "no_show" ? "no-show" : "attendance not recorded"}`))))),
    ...(i.deals?.length ? [more(`All deals (${i.deals.length})`, h("div", { class: "tbl-scroll" }, dealTable(i.deals)))] : []));
  try {
    const r = await api(`leads/${i.eventId}/${i.contactId}`);
    const acts: any[] = (r.activities ?? []).filter((a: any) => a.via === "contact");
    const line = (a: any) => h("div", { class: "actline" }, h("span", null, fmt.day(a.timestamp)), h("span", null, (a.kind ?? "").toLowerCase().replace("_", " ")), h("span", { class: "ow" }, a.ownerName ?? "–"),
      h("span", { class: a.counted ? "ok-t" : "faint" }, a.counted ? "qualifying touch" : a.why));
    box.querySelector(".histbox")!.replaceChildren(acts.length ? h("div", null, h("div", { class: "faint", style: "margin:6px 0 2px" }, "Recent activity on this contact"), acts.slice(0, 5).map(line),
      acts.length > 5 ? more(`Full history (${acts.length})`, acts.slice(5).map(line)) : null) : h("div", { class: "faint" }, "No activity logged on this contact"));
  } catch { box.querySelector(".histbox")!.replaceChildren(h("div", { class: "faint" }, "Activity history unavailable")); }
}

/** Confirm a commercial disposition (contact or company scope). Stored in the dashboard; HubSpot is not modified. */
const CODES: Array<[string, string]> = [
  ["competitor_satisfied", "Paused: competitor satisfied"], ["no_current_need", "Paused: not evaluating / no current need"], ["revisit_later", "Paused: revisit later"],
  ["not_interested", "Closed: not interested"], ["not_qualified", "Closed: not a fit / not qualified"], ["left_company", "Closed: contact left / bad contact data"],
  ["do_not_contact", "Do not contact"], ["other", "Paused: other verified reason"],
];
export function dispositionForm(scope: "contact" | "company", id: string, name: string, current: any) {
  const box = h("div", { class: "cdrawer" });
  openCustom(scope === "company" ? `Account disposition · ${name}` : `Contact disposition · ${name}`,
    scope === "company" ? "Applies to the whole company: use only when the evidence covers the organisation (e.g. standardised on a competitor, no project this year)." : "Applies to this contact only; the account stays worked and other contacts stay available.", box);
  const code = h("select", null, CODES.map(([v, l]) => { const o = h("option", { value: v }, l) as HTMLOptionElement; if (current?.code === v) o.selected = true; return o; })) as HTMLSelectElement;
  const reason = h("input", { type: "text", placeholder: "Reason, e.g. Uses Ironclad and happy with it", value: current?.source === "dashboard" ? current.reason ?? "" : "" }) as HTMLInputElement;
  const evidence = h("input", { type: "text", placeholder: "Evidence, e.g. Email reply 27 Aug 2026", value: current?.source === "dashboard" ? current.evidence ?? "" : "" }) as HTMLInputElement;
  const revisit = h("input", { type: "date", value: current?.revisitDate ?? "" }) as HTMLInputElement;
  const by = h("input", { type: "text", placeholder: "Your name", value: (() => { try { return localStorage.getItem("ecc-name") ?? ""; } catch { return ""; } })() }) as HTMLInputElement;
  const msg = h("div", { class: "faint" });
  const call = async (method: "POST" | "DELETE") => {
    try { localStorage.setItem("ecc-name", by.value.trim()); } catch { /* ignore */ }
    try {
      await api("dispositions", undefined, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scope, id, code: code.value, reason: reason.value.trim(), evidence: evidence.value.trim() || null, revisitDate: revisit.value || null, confirmedBy: by.value.trim() }) });
      msg.textContent = "Saved. Refreshing…"; setTimeout(() => window.dispatchEvent(new HashChangeEvent("hashchange")), 300);
    } catch (e) { msg.textContent = (e as Error).message; }
  };
  const kv = (k: string, v: any) => [h("div", { class: "k" }, k), h("div", null, v)];
  box.append(
    current ? h("div", { class: "nextbox" }, h("div", { class: "na" }, `Current: ${current.source === "hubspot" ? "from HubSpot" : `confirmed by ${current.confirmedBy}`}`), h("div", { class: "nr" }, current.reason ?? "")) : null as any,
    h("div", { class: "kv tight dform" }, kv("Disposition", code), kv("Reason", reason), kv("Evidence", evidence), kv("Revisit on (optional)", revisit), kv("Confirmed by", by)),
    h("div", { style: "display:flex;gap:8px;margin-top:10px" },
      h("button", { class: "btn primary", onclick: () => call("POST") }, "Confirm disposition"),
      current?.source === "dashboard" ? h("button", { class: "btn", onclick: () => call("DELETE") }, "Clear") : null as any),
    msg,
    h("div", { class: "faint", style: "margin-top:10px;font-size:12px" }, "Confirmed dispositions stop routine cadence alerts and keep the outreach credit already earned. They do not change the company's Account Intent Level. They are stored in this dashboard (HubSpot is read-only for this app)."));
}
