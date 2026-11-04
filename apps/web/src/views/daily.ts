import { api } from "../api.js";
import { openCustom } from "../drawer.js";
import { buildHash, filterParams, type Route } from "../state.js";
import { dealTable, fmt, h, hsLink } from "../ui.js";

// =====================================================================================================================
// Daily Command Centre — SDR execution workspace (three layers)
//   1. MY WORK TODAY: three action blocks (Reply now · First outreach · Reconnect), counts = unique accounts
//   2. WORKLIST: one compact card per account: account intent, recommended contact, exact engagement source,
//      why it is prioritised, one next action
//   3. ACCOUNT PANEL (right side): overview, next action, intent vs engagement, event history, other contacts, activity
// Data comes from /api/daily (same account model as the CMO overview). Nothing here changes HubSpot.
// =====================================================================================================================

type Queue = "reply" | "first" | "reconnect" | "qualified" | "paused" | "review";
const QUEUES: Array<{ key: Queue; label: string; desc: string; buckets: string[] }> = [
  { key: "reply", label: "Reply now", desc: "A prospect replied to you, or a HubSpot task / commitment is due", buckets: ["respond"] },
  { key: "first", label: "First outreach", desc: "Accounts you have not reached yet, strongest signals first", buckets: ["first_outreach", "low"] },
  { key: "reconnect", label: "Reconnect", desc: "Accounts you have worked: pick up where you left off (no deadlines)", buckets: ["follow_up", "progress"] },
  { key: "qualified", label: "Qualified / handed off", desc: "Verified SQL with the AE", buckets: ["qualified"] },
  { key: "paused", label: "Paused / closed", desc: "Verified reason to stop routine outreach", buckets: ["paused"] },
  { key: "review", label: "Needs review", desc: "Missing or contradictory data", buckets: ["review"] },
];
const queueOf = (bucket: string): Queue => QUEUES.find((q) => q.buckets.includes(bucket))?.key ?? "review";
const PAGE = 25;

const firstName = (n: string | null | undefined) => (n ?? "").split(" ")[0] ?? "";
const who = (o: any) => (o ? `${o.name ?? "Unknown user"}${o.role ? ` (${o.role})` : ""}` : null);
const short = (n: string | null | undefined) => (n ?? "").replace(/\s*\|\s*\d{1,2}[\s-]\w+[\s-]\d{4}\s*$/, "").trim();

/** ACCOUNT INTENT (company property "Account Intent Level"). */
function intentInfo(it: any): { text: string; cls: string } {
  if (!it?.synced) return { text: "Not synced", cls: "unknown" };
  if (it.level === "hot") return { text: it.raw?.replace(/\s*account$/i, "") || "Hot", cls: "hot" };
  if (it.level === "warm") return { text: "Warm", cls: "warm" };
  if (it.level === "cold") return { text: "Cold", cls: "cold" };
  return { text: it.raw ? it.raw.replace(/\s*account$/i, "") : "Not set", cls: "unknown" };
}

/** Participation wording; sponsored conferences never read as SpotDraft engagement. */
function partText(e: any): string {
  if (e.participation === "attended") return e.category === "sponsored" ? "Attended conference (SpotDraft interaction not verified)" : "Attended";
  if (e.participation === "no_show") return "Confirmed no-show";
  if (e.category === "sponsored") return "On conference list · attendance not verified";
  if (e.participation === "registered_only") return "Registered only";
  return "Registered · attendance unknown";
}
const PART_RANK: Record<string, number> = { attended: 0, registered_only: 2, unknown: 3, no_show: 4 };
/** Strongest event for a contact (verified attendance beats recency; SpotDraft-run beats sponsored). */
function strongestEvent(c: any) {
  return [...(c.events ?? [])].sort((a, b) =>
    (PART_RANK[a.participation] ?? 5) + (a.category === "sponsored" ? 1 : 0) - ((PART_RANK[b.participation] ?? 5) + (b.category === "sponsored" ? 1 : 0)) ||
    (b.date ?? "").localeCompare(a.date ?? ""))[0] ?? null;
}
/** One-line source: "Attended · Beacon LIVE Bangalore · Aug 12" / "Replied to SDR · Oct 26". */
function sourceLine(c: any): { text: string; more: number } {
  if (c.engagementStrength === 0) return { text: c.engagement, more: c.events?.length ?? 0 };
  const e = strongestEvent(c);
  if (!e) return { text: "No event engagement recorded", more: 0 };
  return { text: `${partText(e)} · ${short(e.name)} · ${fmt.day(e.date)}`, more: (c.events?.length ?? 1) - 1 };
}
const TITLE_RELEVANT = /general counsel|\bgc\b|legal|counsel|contract|clm|compliance|attorney|lawyer|paralegal/i;
/** Recommended contact: action urgency, then verified engagement, then role relevance, then recency. */
function recommend(a: any) {
  const rank = (c: any) => [
    c.group === "respond" ? 0 : 1,
    c.disposition ? 1 : 0,
    c.engagementStrength ?? 4,
    TITLE_RELEVANT.test(c.jobTitle ?? "") ? 0 : 1,
    queueOf(a.bucket) === "first" ? (c.yourTouches > 0 ? 1 : 0) : 0,
    -Date.parse(strongestEvent(c)?.date ?? "1970-01-01"),
  ];
  return [...a.contacts].sort((x, y) => { const p = rank(x), q = rank(y); for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return p[i]! - q[i]!; return 0; })[0];
}
/** One specific next action for the account. */
function nextAction(a: any, c: any): { text: string; tone: "red" | "amber" | "green" | "neutral" } {
  const q = queueOf(a.bucket);
  const n = c.contactName;
  if (q === "reply") {
    if (/task/i.test(c.action)) return { text: `Complete HubSpot task for ${n}${c.nextTask?.subject ? `: ${c.nextTask.subject}` : ""}`, tone: c.color === "red" ? "red" : "amber" };
    return { text: `Reply to ${n}`, tone: c.color === "red" ? "red" : "amber" };
  }
  if (q === "first") {
    const e = strongestEvent(c);
    if (e?.participation === "attended" && e.category !== "sponsored") return { text: `First outreach to ${n} (verified attendee)`, tone: c.color === "red" ? "red" : "amber" };
    if (e?.category === "sponsored" && e.participation !== "attended") return { text: `Review ${short(e.name)} list, then first outreach to ${n}`, tone: "neutral" };
    return { text: `First outreach to ${n}`, tone: c.color === "red" ? "red" : "amber" };
  }
  if (q === "reconnect") return { text: a.primary?.action === "Recently contacted" ? `Continue the conversation with ${n}` : `Reconnect with ${n}`, tone: "neutral" };
  if (q === "qualified") return { text: "Coordinate with the AE", tone: "green" };
  if (q === "paused") return { text: "No routine outreach", tone: "neutral" };
  return { text: c.action ?? "Review data", tone: "neutral" };
}
/** Why the account is prioritised, in plain words. */
function whyLine(a: any, c: any): string {
  const q = queueOf(a.bucket);
  const it = intentInfo(a.intent);
  const intent = it.cls === "unknown" ? "" : `${it.text} account`;
  if (q === "reply") return /task/i.test(c.action) ? `${c.reason}` : `Prospect replied ${fmt.day(c.lastReplyAt)} and is awaiting a response`;
  if (q === "paused") return a.companyDisposition ? `${a.companyDisposition.reason ?? "Company-wide disposition"}` : "Every worked contact has a verified disposition";
  if (q === "qualified") return c.reason;
  const e = strongestEvent(c);
  const sig = c.engagementStrength === 0 ? c.engagement.toLowerCase()
    : e?.participation === "attended" ? (e.category === "sponsored" ? `${short(e.name)} attendee (not verified with SpotDraft)` : `verified ${short(e.name)} attendee`)
    : e ? `registered for ${short(e.name)}; attendance not verified` : "no contact-level engagement";
  const work = q === "first" ? (c.color === "red" ? "first-touch SLA passed" : "no outreach yet") : a.daysSinceLast !== null && a.daysSinceLast !== undefined ? `last contacted ${a.daysSinceLast} business days ago` : "";
  return [intent, sig, work].filter(Boolean).join(" + ").replace(/^./, (x) => x.toUpperCase());
}

// Expanded/collapsed UI state kept within the session (browser storage optional).
const KEY = "ecc-daily-v3";
const ui: { progress: boolean; advanced: boolean } = (() => { try { return { progress: false, advanced: false, ...JSON.parse(sessionStorage.getItem(KEY) ?? "{}") }; } catch { return { progress: false, advanced: false }; } })();
const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify(ui)); } catch { /* ignore */ } };

export async function dailyView(route: Route, meta: any): Promise<HTMLElement> {
  const f = route.filters;
  const x = route.extra;
  const d = await api("daily", filterParams(f));
  const go = (patch: Record<string, string>) => { location.hash = buildHash("daily", f, { ...Object.fromEntries(x), ...patch }); };
  const all: any[] = d.accountView.items;

  // ---- filters (simple + advanced). Account kept when any contact matches; counts follow the visible accounts.
  const qRaw = x.get("q") ?? "", q = qRaw.toLowerCase();
  const queue = (x.get("queue") as Queue) || "";
  const part = x.get("part") ?? "", evF = x.get("ev") ?? "", cat = x.get("cat") ?? "", intentF = x.get("intent") ?? "", engF = x.get("eng") ?? "",
    icpF = x.get("icp") ?? "", workF = x.get("work") ?? "", lastF = x.get("last") ?? "", sort = x.get("sort") ?? "rec";
  const cOk = (c: any) =>
    (!evF || c.events.some((e: any) => e.id === evF)) && (!cat || c.events.some((e: any) => e.category === cat)) &&
    (!engF || String(c.engagementStrength) === engF) &&
    (!part || (part === "attended" ? c.events.some((e: any) => e.participation === "attended") : part === "registered" ? !c.events.some((e: any) => e.participation === "attended") && c.events.some((e: any) => e.participation === "registered_only") : c.events.every((e: any) => e.participation === "unknown")));
  const filtered = all.filter((a) =>
    a.contacts.some(cOk) &&
    (!q || (a.companyName ?? "").toLowerCase().includes(q) || a.contacts.some((c: any) => `${c.contactName} ${c.jobTitle ?? ""}`.toLowerCase().includes(q) || c.events.some((e: any) => (e.name ?? "").toLowerCase().includes(q)))) &&
    (!intentF || (intentF === "hotwarm" ? ["hot", "warm"].includes(a.intent?.level) : a.intent?.level === intentF)) &&
    (!icpF || a.intent?.icp === icpF) && (!workF || (workF === "worked" ? a.worked : !a.worked)) &&
    (!lastF || (a.daysSinceLast !== null && a.daysSinceLast !== undefined && a.daysSinceLast >= Number(lastF))));
  const inQueue = (k: Queue) => filtered.filter((a) => queueOf(a.bucket) === k);

  // ---- LAYER 1: my work today
  const block = (k: Queue) => {
    const qm = QUEUES.find((z) => z.key === k)!;
    const n = inQueue(k).length;
    return h("button", { class: `mw q-${k} ${queue === k ? "sel" : ""} ${n ? "" : "zero"}`, onclick: () => go({ queue: queue === k ? "" : k }) },
      h("span", { class: "mwn" }, fmt.n(n)), h("span", { class: "mwl" }, qm.label), h("span", { class: "mwd" }, qm.desc));
  };
  const others = (["qualified", "paused", "review"] as Queue[]).map((k) => h("button", { class: `mwo ${queue === k ? "sel" : ""}`, onclick: () => go({ queue: queue === k ? "" : k }) }, `${QUEUES.find((z) => z.key === k)!.label} · ${fmt.n(inQueue(k).length)}`));
  const S = d.accountView.summary;
  const prog = h("details", { class: "myprog", ...(ui.progress ? { open: true } : {}) }, h("summary", null, "My progress"),
    h("div", { class: "mpg" }, ...[
      ["Eligible accounts", fmt.n(S.accounts)], ["Accounts worked", `${fmt.n(S.worked)} (${fmt.pct(S.coveragePct)})`], ["Not worked", fmt.n(S.notWorked)],
      ["Contacts worked", `${fmt.n(S.contactsWorked)} of ${fmt.n(S.contacts)}`], ["Qualified / handed off", fmt.n(S.qualified)], ["Paused / closed", fmt.n(S.paused)],
    ].map(([l, v]) => h("div", { class: "mp" }, h("b", null, v), h("span", null, l)))));
  prog.addEventListener("toggle", () => { ui.progress = (prog as HTMLDetailsElement).open; save(); });

  // ---- controls: search · queue · participation (+ advanced)
  const search = h("input", { type: "search", class: "dsearch", placeholder: "Search company, person or event", value: qRaw }) as HTMLInputElement;
  search.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") go({ q: search.value.trim() }); });
  const sel = (key: string, cur: string, opts: Array<[string, string]>) => h("select", { onchange: (e: Event) => go({ [key]: (e.target as HTMLSelectElement).value }) },
    opts.map(([v, l]) => { const o = h("option", { value: v }, l) as HTMLOptionElement; if (v === cur) o.selected = true; return o; }));
  const evs = new Map<string, string>(); const icps = new Set<string>();
  for (const a of all) { if (a.intent?.icp) icps.add(a.intent.icp); for (const c of a.contacts) for (const e of c.events) evs.set(e.id, `${short(e.name)} · ${fmt.day(e.date)}`); }
  const adv = h("details", { class: "advf", ...(ui.advanced ? { open: true } : {}) }, h("summary", null, "Advanced filters"),
    h("div", { class: "advg" },
      sel("ev", evF, [["", "Any event"], ...[...evs.entries()].sort((p1, p2) => p1[1].localeCompare(p2[1]))]),
      sel("cat", cat, [["", "Any event type"], ["owned", "Beacon / owned events"], ["webinar", "Webinars"], ["roundtable", "Roundtables"], ["sponsored", "Sponsored conferences"]]),
      sel("intent", intentF, [["", "Any account intent"], ["hotwarm", "Hot + Warm"], ["hot", "Hot / Surging"], ["warm", "Warm"], ["cold", "Cold"], ["unknown", "Not set"]]),
      sel("eng", engF, [["", "Any contact engagement"], ["0", "High intent (replied / meeting)"], ["1", "Verified attendee"], ["2", "Conference attendee"], ["3", "Registered only"], ["4", "Company intent only"]]),
      sel("icp", icpF, [["", "Any ICP tier"], ...[...icps].sort().map((v) => [v, v] as [string, string])]),
      sel("work", workF, [["", "Worked or not"], ["worked", "Worked"], ["unworked", "Not worked"]]),
      sel("last", lastF, [["", "Any last contact"], ["7", "Last contacted 7+ business days ago"], ["14", "14+ business days ago"], ["30", "30+ business days ago"]]),
      h("button", { class: "linkbtn", onclick: () => go({ ev: "", cat: "", intent: "", eng: "", icp: "", work: "", last: "" }) }, "Clear")));
  adv.addEventListener("toggle", () => { ui.advanced = (adv as HTMLDetailsElement).open; save(); });
  const controls = h("div", { class: "dctl" }, search,
    sel("queue", queue, [["", "Today's work (all three queues)"], ...QUEUES.map((z) => [z.key, z.label] as [string, string])]),
    sel("part", part, [["", "Attended or registered"], ["attended", "Verified attendees"], ["registered", "Registered only"], ["unknown", "Attendance unknown"]]),
    sel("sort", sort, [["rec", "Sort: recommended"], ["intent", "Highest account intent"], ["eng", "Strongest contact engagement"], ["recent", "Most recent event"], ["oldest", "Oldest unworked"]]));

  // ---- LAYER 2: account cards
  const visible = queue ? filtered.filter((a) => queueOf(a.bucket) === queue) : filtered.filter((a) => ["reply", "first", "reconnect"].includes(queueOf(a.bucket)));
  const qOrder: Record<string, number> = { reply: 0, first: 1, reconnect: 2, qualified: 3, paused: 4, review: 5 };
  const IR: Record<string, number> = { hot: 0, warm: 1, unknown: 2, cold: 3 };
  const withRec = visible.map((a, i) => ({ a, c: recommend(a), i }));
  withRec.sort((p, r) =>
    sort === "intent" ? (IR[p.a.intent?.level] ?? 2) - (IR[r.a.intent?.level] ?? 2) || p.i - r.i
    : sort === "eng" ? (p.c.engagementStrength ?? 4) - (r.c.engagementStrength ?? 4) || p.i - r.i
    : sort === "recent" ? (strongestEvent(r.c)?.date ?? "").localeCompare(strongestEvent(p.c)?.date ?? "")
    : sort === "oldest" ? (p.a.worked ? 1 : 0) - (r.a.worked ? 1 : 0) || (strongestEvent(p.c)?.date ?? "9").localeCompare(strongestEvent(r.c)?.date ?? "9")
    : (qOrder[queueOf(p.a.bucket)] ?? 9) - (qOrder[queueOf(r.a.bucket)] ?? 9) || p.i - r.i);

  const card = ({ a, c }: { a: any; c: any }) => {
    const it = intentInfo(a.intent);
    const src = sourceLine(c);
    const act = nextAction(a, c);
    return h("article", { class: `acard t-${act.tone}`, tabindex: "0", onclick: () => accountPanel(a, c), onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter") accountPanel(a, c); } },
      h("div", { class: "ac1" },
        h("span", { class: "acname" }, a.companyName ?? "(no company)"),
        h("span", { class: `aint i-${it.cls}` }, h("small", null, "ACCOUNT INTENT"), it.text),
        !f.sdr && a.sdrName ? h("span", { class: "acown" }, a.sdrName) : null),
      h("div", { class: "ac2" },
        h("div", { class: "acwho" }, h("b", null, c.contactName), c.jobTitle ? h("span", null, ` · ${c.jobTitle}`) : null,
          h("span", { class: `ceng e${c.engagementStrength}` }, c.engagementLabel)),
        h("div", { class: "acsrc" }, src.text, src.more > 0 ? h("span", { class: "more" }, ` +${src.more} more event${src.more === 1 ? "" : "s"}`) : null)),
      h("div", { class: "acwhy" }, whyLine(a, c)),
      h("div", { class: "ac3" },
        h("span", { class: `acnext n-${act.tone}` }, h("small", null, "NEXT ACTION"), act.text),
        h("span", { class: "acbtns" },
          h("button", { class: "btn sm", onclick: (e: Event) => { e.stopPropagation(); accountPanel(a, c); } }, "View details"),
          h("a", { class: "btn sm", href: `https://app.hubspot.com/contacts/${meta?.portalId ?? ""}/record/0-1/${c.contactId}`, target: "_blank", rel: "noopener", onclick: (e: Event) => e.stopPropagation() }, "Open in HubSpot"))));
  };
  const list = h("div", { class: "acards" });
  const more = h("button", { class: "btn more" }, "Show more accounts");
  let shown = 0;
  const page = () => { list.append(...withRec.slice(shown, shown + PAGE).map(card)); shown = Math.min(withRec.length, shown + PAGE); more.style.display = shown < withRec.length ? "" : "none"; more.textContent = `Show more accounts (${withRec.length - shown} left)`; };
  more.addEventListener("click", page);
  page();

  const fr = meta?.freshness;
  return h("div", { class: "dcc" },
    h("div", { class: "dcchead" },
      h("div", null, h("h1", null, "My work today"), h("div", { class: "faint" }, "Accounts are grouped by HubSpot company and assigned by the company SDR Owner. Counts are unique accounts.")),
      h("div", { class: `syncst ${fr?.stale ? "stale" : ""}` }, fr?.lastSuccessAt ? `HubSpot synced ${fmt.ago(fr.lastSuccessAt)} (${new Date(fr.lastSuccessAt).toLocaleString()})` : "No successful HubSpot sync yet",
        fr?.stale ? h("div", null, "Data may be stale: the last sync is older than expected") : null,
        fr?.lastRun?.status === "failed" ? h("div", null, "Last sync failed; showing the last good data") : null)),
    h("div", { class: "mwrow" }, block("reply"), block("first"), block("reconnect")),
    h("div", { class: "mworow" }, others),
    prog,
    controls, adv,
    h("div", { class: "listhead" }, h("b", null, queue ? QUEUES.find((z) => z.key === queue)!.label : "Today's work"), h("span", { class: "faint" }, ` · ${fmt.n(withRec.length)} account${withRec.length === 1 ? "" : "s"}`),
      queue ? h("span", { class: "linkbtn", style: "margin-left:8px", onclick: () => go({ queue: "" }) }, "Show all three queues") : null),
    withRec.length ? list : h("div", { class: "wempty" }, "Nothing here with these filters."),
    more);
}

// ---- LAYER 3: account detail panel ----------------------------------------------------------------------------------
function accountPanel(a: any, initial: any) {
  const box = h("div", { class: "apanel" });
  openCustom(a.companyName ?? "Account", a.sdrName ? `SDR Owner: ${a.sdrName}` : "No SDR Owner", box);
  const it = intentInfo(a.intent);
  const kv = (k: string, v: any) => (v === null || v === undefined || v === "" ? null : [h("div", { class: "k" }, k), h("div", null, v)]);
  const blockEl = (t: string, ...c: any[]) => h("section", { class: "pblk" }, h("h3", null, t), ...c);
  const contactArea = h("div");
  const render = (c: any) => {
    const act = nextAction(a, c);
    const src = sourceLine(c);
    const evs = [...(c.events ?? [])].sort((p: any, q: any) => (q.date ?? "").localeCompare(p.date ?? ""));
    const timeline = h("div", { class: "faint" }, "Loading activity…");
    contactArea.replaceChildren(
      blockEl("Recommended next action",
        h("div", { class: `pnext n-${act.tone}` }, act.text),
        h("div", { class: "pwhy" }, whyLine(a, c)),
        h("div", { class: "kv tight" },
          kv("Contact", [c.contactName, c.jobTitle ? ` · ${c.jobTitle}` : "", " ", hsLink("contact", c.contactId, "Open in HubSpot ↗")]),
          kv("Evidence", src.text),
          kv("Last contacted", c.lastOutboundAt ? `${fmt.day(c.lastOutboundAt)} · ${who(c.lastBy) ?? "owner not recorded"}` : "Not contacted yet"),
          kv("Last reply", c.lastReplyAt ? fmt.day(c.lastReplyAt) : null),
          kv("Open HubSpot task", c.nextTask ? `${c.nextTask.subject ?? "Task"} · due ${fmt.day(c.nextTask.due)}` : null),
          kv("Your touches", `${c.yourTouches} by ${firstName(a.sdrName) || "the SDR"}${c.otherSdrTouches ? ` · ${c.otherSdrTouches} by another SDR earlier (not credited)` : ""}`),
          kv("Disposition", c.disposition ? `${c.disposition.reason ?? ""}${c.disposition.source === "hubspot" ? " (HubSpot)" : ` · confirmed by ${c.disposition.confirmedBy}`}` : null)),
        h("div", null, h("span", { class: "linkbtn", onclick: () => dispositionForm("contact", c.contactId, c.contactName, c.disposition) }, c.disposition ? "Edit contact disposition" : "Record a disposition for this contact"))),
      h("div", { class: "pduo" },
        h("div", { class: `pbig i-${it.cls}` }, h("small", null, "ACCOUNT INTENT"), h("b", null, it.text),
          h("div", null, [a.intent?.since ? `since ${fmt.day(a.intent.since)}` : null, a.intent?.sdrCategory, a.intent?.reason ?? "detailed trigger not recorded"].filter(Boolean).join(" · ")),
          h("div", { class: "faint" }, "Company-level (HubSpot Account Intent Level). It does not mean every contact is engaged.")),
        h("div", { class: `pbig e${c.engagementStrength}` }, h("small", null, "CONTACT ENGAGEMENT"), h("b", null, c.engagementLabel),
          h("div", null, c.engagement),
          h("div", { class: "faint" }, "This person's own evidence: replies, meetings, verified attendance or registration."))),
      blockEl("Event & engagement history",
        evs.length ? h("div", { class: "evh" }, evs.map((e: any) => h("div", { class: "evrow2" },
          h("div", null, h("b", null, short(e.name)), h("span", { class: "faint" }, ` · ${e.category} · ${fmt.day(e.date)}`)),
          h("div", null, h("span", { class: `pp p-${e.participation}` }, partText(e)), h("span", { class: "faint" }, e.participationSource ? ` · ${e.participationSource}` : ""))))) : h("div", { class: "faint" }, "No event records")),
      h("details", { class: "pblk" }, h("summary", null, h("h3", { style: "display:inline" }, "Activity history")), timeline),
    );
    api(`leads/${c.eventId}/${c.contactId}`).then((r: any) => {
      const acts: any[] = (r.activities ?? []).filter((y: any) => y.via === "contact");
      timeline.replaceChildren(...(acts.length ? acts.slice(0, 40).map((y: any) => h("div", { class: "actline" }, h("span", null, fmt.day(y.timestamp)),
        h("span", null, (y.kind ?? "").toLowerCase().replace("_", " ")), h("span", { class: "ow" }, `${y.ownerName ?? "–"}${y.title ? ` · ${String(y.title).slice(0, 60)}` : ""}`),
        h("span", { class: y.counted ? "ok-t" : "faint" }, y.counted ? "qualifying" : y.why))) : [h("div", { class: "faint" }, "No activity logged on this contact")]));
    }).catch(() => { timeline.textContent = "Activity history unavailable"; });
  };
  const dealC = a.contacts.find((c: any) => c.deal);
  box.append(
    blockEl("Account",
      h("div", { class: "kv tight" },
        kv("Company", [a.companyName, " ", hsLink("company", a.companyId, "Open in HubSpot ↗")]),
        kv("SDR Owner (HubSpot)", a.sdrName ?? "Unassigned"),
        kv("Previous SDR Owner", who(a.contacts[0]?.own?.previousSdr)),
        kv("Account intent", it.text),
        kv("ICP Category 2.0", a.intent?.icp),
        kv("Worked", a.worked ? `Yes · ${a.coverage.worked}/${a.coverage.available} contacts · last ${fmt.day(a.lastSdrTouch)}${a.daysSinceLast !== null && a.daysSinceLast !== undefined ? ` (${a.daysSinceLast} business days ago)` : ""}` : "Not yet"),
        kv("Disposition", a.companyDisposition ? `${a.companyDisposition.reason ?? ""} (company-wide)` : null),
        kv("Deal", dealC ? [dealC.deal.name ?? "Deal", dealC.deal.stage ? ` · ${dealC.deal.stage}` : "", dealC.deal.sqlDate ? ` · SQL ${fmt.day(dealC.deal.sqlDate)}` : " · not SQL", " ", hsLink("deal", dealC.deal.id, "↗")] : null)),
      h("div", null, h("span", { class: "linkbtn", onclick: () => dispositionForm("company", a.companyId, a.companyName, a.companyDisposition) }, a.companyDisposition ? "Edit account disposition" : "Record an account-wide disposition"))),
    contactArea,
    blockEl(`Contacts at this account (${a.contacts.length})`,
      h("div", { class: "pother" }, a.contacts.map((c: any) => {
        const e = strongestEvent(c);
        return h("button", { class: "pc", onclick: () => { render(c); box.parentElement?.scrollTo?.({ top: 0 }); } },
          h("div", null, h("b", null, c.contactName), c.jobTitle ? h("span", { class: "faint" }, ` · ${c.jobTitle}`) : null),
          h("div", { class: "faint" }, [c.engagementLabel, e ? `${partText(e)} · ${short(e.name)}` : null, c.lastOutboundAt ? `last contacted ${fmt.day(c.lastOutboundAt)}` : "not contacted", c.yourTouches ? "worked" : "unworked", c.disposition ? "paused" : null].filter(Boolean).join(" · ")));
      }))),
    ...(a.contacts.some((c: any) => c.deals?.length) ? [h("details", { class: "pblk" }, h("summary", null, h("h3", { style: "display:inline" }, "Deals")), h("div", { class: "tbl-scroll" }, dealTable(a.contacts.flatMap((c: any) => c.deals ?? []).filter((dl: any, i: number, arr: any[]) => arr.findIndex((y) => y.id === dl.id) === i))))] : []),
  );
  render(initial);
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
    scope === "company" ? "Applies to the whole company: use only when the evidence covers the organisation." : "Applies to this contact only; the account stays worked and other contacts stay available.", box);
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
    ...(current ? [h("div", { class: "nextbox" }, h("div", { class: "na" }, `Current: ${current.source === "hubspot" ? "from HubSpot" : `confirmed by ${current.confirmedBy}`}`), h("div", { class: "nr" }, current.reason ?? ""))] : []),
    h("div", { class: "kv tight dform" }, kv("Disposition", code), kv("Reason", reason), kv("Evidence", evidence), kv("Revisit on (optional)", revisit), kv("Confirmed by", by)),
    h("div", { style: "display:flex;gap:8px;margin-top:10px" },
      h("button", { class: "btn primary", onclick: () => call("POST") }, "Confirm disposition"),
      ...(current?.source === "dashboard" ? [h("button", { class: "btn", onclick: () => call("DELETE") }, "Clear")] : [])),
    msg,
    h("div", { class: "faint", style: "margin-top:10px;font-size:12px" }, "Confirmed dispositions stop routine outreach suggestions and keep the outreach credit already earned. They do not change HubSpot."));
}
