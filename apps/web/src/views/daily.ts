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
  if (e.participation === "attended") return e.category === "sponsored" ? "Conference attendee (organiser list)" : "Attended";
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
    if (e?.participation === "attended" && e.category !== "sponsored") return { text: `Consider reaching out to ${n}, a verified attendee`, tone: c.color === "red" ? "red" : "amber" };
    if (e?.category === "sponsored" && e.participation !== "attended") return { text: `Check the ${short(e.name)} context before reaching out to ${n}`, tone: "neutral" };
    return { text: c.color === "red" ? `First-touch SLA has passed: reach out to ${n}` : `Consider reaching out to ${n}`, tone: c.color === "red" ? "red" : "neutral" };
  }
  if (q === "reconnect") return { text: a.primary?.action === "Recently contacted" ? `You're in touch with ${n}; continue when it makes sense` : `Could be a good time to reconnect with ${n}`, tone: "neutral" };
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
    : e?.participation === "attended" ? (e.category === "sponsored" ? `${short(e.name)} conference attendee` : `verified ${short(e.name)} attendee`)
    : e ? `registered for ${short(e.name)}; attendance not verified` : "no contact-level engagement";
  const work = q === "first" ? (c.color === "red" ? "first-touch SLA passed" : "no outreach yet") : a.daysSinceLast !== null && a.daysSinceLast !== undefined ? `last contacted ${a.daysSinceLast} business days ago` : "";
  return [intent, sig, work].filter(Boolean).join(" + ").replace(/^./, (x) => x.toUpperCase());
}

// ---- Opportunity buckets (one per account, deterministic precedence) -------------------------------------------------
type Bucket = "pickup" | "fresh" | "sponsored" | "momentum" | "radar" | "handled";
const BUCKETS2: Array<{ key: Bucket; label: string; desc: string }> = [
  { key: "pickup", label: "Conversations to pick up", desc: "A prospect replied in your thread, or a HubSpot task or commitment is due." },
  { key: "fresh", label: "Hot & Warm opportunities", desc: "Not contacted yet. Attended a SpotDraft-hosted event, showed direct intent, or a sponsored-event contact with additional verified engagement." },
  { key: "sponsored", label: "Sponsored event opportunities", desc: "Not contacted yet. Attended or spoke with us at a sponsored conference (ACC, RLLB, CLOC…), without enough other intent to be Warm." },
  { key: "momentum", label: "Contacted · re-engage", desc: "Already contacted since the event (by you or a colleague). You choose when to re-engage; nothing is scheduled for you." },
  { key: "radar", label: "Early signals · worth exploring", desc: "Registration only, organiser lists, unverified attendance, or data to check." },
  { key: "handled", label: "Already handled", desc: "Qualified / handed off to the AE, or paused for a verified reason." },
];
/** Precedence: verified pickup > handled (SQL / paused) > worked > verified fresh signal > everything else (radar). */
function bucketOf(a: any, c: any): Bucket {
  if (a.bucket === "respond") return "pickup";
  if (a.bucket === "qualified" || a.bucket === "paused") return "handled";
  if (a.worked || a.workedByOther) return "momentum";
  if (a.bucket === "review" || a.bucket === "low") return "radar";
  // Contact engagement decides the level, never the company's intent (Account Intent is shown separately on the card).
  const strongest = Math.min(...a.contacts.map((x: any) => x.engagementStrength ?? 4));
  if (strongest <= 1 || c?.color === "red") return "fresh";
  if (strongest === 2) return "sponsored";
  return "radar";
}
/** Conversational, evidence-backed nudge. Direct and precise for genuine replies / tasks; neutral when evidence is thin. */
function nudge(a: any, c: any, b: Bucket): { text: string; tone: "urgent" | "soft" | "plain" } {
  const n = firstName(c.contactName) || c.contactName;
  const e = strongestEvent(c);
  const ev = e ? short(e.name) : "";
  const it = intentInfo(a.intent);
  const engaged = a.contacts.filter((x: any) => (x.engagementStrength ?? 4) <= 1).length;
  if (b === "pickup") {
    if (/task/i.test(c.action)) return { text: `HubSpot task ${c.color === "red" ? "is overdue" : "is due today"}${c.nextTask?.subject ? `: "${c.nextTask.subject}"` : ""}.`, tone: "urgent" };
    return { text: `${n} replied ${fmt.day(c.lastReplyAt)} and appears to be waiting for your response.`, tone: "urgent" };
  }
  if (b === "handled") return { text: a.bucket === "qualified" ? "Qualified and with the AE." : `Paused: ${a.companyDisposition?.reason ?? c.disposition?.reason ?? "verified reason recorded"}.`, tone: "plain" };
  if (a.workedByOther) { const w = a.workedByOther; const who = w.by ? `${w.by.name ?? "Another rep"}${w.by.role ? ` (${w.by.role})` : ""}` : "Another rep";
    return { text: `Already being worked: ${who} reached out to ${w.contactName ?? "a contact"} here on ${fmt.day(w.at)}. Coordinate before adding outreach.`, tone: "plain" }; }
  if (b === "momentum") {
    const d = a.daysSinceLast;
    if (c.conversation) return { text: `There's an active conversation with ${n}. Might be worth checking where it stands.`, tone: "soft" };
    if (d !== null && d !== undefined && d < 7) return { text: `You reached this account ${d} business day${d === 1 ? "" : "s"} ago.`, tone: "plain" };
    const more = a.coverage.notWorked ? ` ${a.coverage.notWorked} other contact${a.coverage.notWorked === 1 ? "" : "s"} here you haven't reached.` : "";
    return { text: `Last contact ${d} business days ago. Might be worth revisiting the conversation.${more}`, tone: "soft" };
  }
  if (engaged >= 2) return { text: `Interesting signal: ${engaged} people from this account engaged with SpotDraft events.`, tone: "soft" };
  if (c.engagementStrength === 0) return { text: `Worth a look: ${c.engagement}.`, tone: "soft" };
  if (c.bestEventCategory === "sponsored" && c.engagementStrength <= 2) return { text: c.engagement, tone: c.engagementStrength === 1 ? "soft" : "plain" };
  if (e?.participation === "attended" && e.category !== "sponsored") return { text: `Worth a look: ${n} attended ${ev} and hasn't been contacted yet.`, tone: "soft" };
  if (e?.participation === "attended") return { text: `${n} attended ${ev} (organiser's attendee list). No conversation with us recorded yet.`, tone: "soft" };
  if (it.cls === "hot" || it.cls === "warm") return { text: `${it.text} account, but ${n}'s attendance at ${ev || "the event"} isn't verified. Worth checking the event context.`, tone: "plain" };
  if (e?.category === "sponsored") return { text: `On the ${ev} list. Attendance isn't verified.`, tone: "plain" };
  return { text: e ? `Registered for ${ev}. No attendance or reply recorded.` : "No verified engagement recorded yet.", tone: "plain" };
}
/** Small, factual highlights (no gamification). */
function highlights(a: any, c: any): string[] {
  const out: string[] = [];
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  if (a.contacts.some((x: any) => (x.events ?? []).some((e: any) => e.participation === "attended" && (e.date ?? "") >= weekAgo)) || (c.lastReplyAt ?? "") >= weekAgo) out.push("New signal");
  if (a.contacts.filter((x: any) => (x.engagementStrength ?? 4) <= 1).length >= 2) out.push("Multiple contacts engaged");
  const prev = a.contacts[0]?.own?.previousSdr;
  if (prev && a.contacts[0]?.allocationDate && a.contacts[0].allocationDate >= new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10)) out.push(`Recently reassigned from ${firstName(prev.name)}`);
  return out;
}

const UIKEY = "ecc-opps-v1";
const st: { open: Bucket[] | null; shown: Record<string, number>; progress: boolean; advanced: boolean } = (() => {
  try { return { open: null, shown: {}, progress: false, advanced: false, ...JSON.parse(sessionStorage.getItem(UIKEY) ?? "{}") }; } catch { return { open: null, shown: {}, progress: false, advanced: false }; }
})();
const persist = () => { try { sessionStorage.setItem(UIKEY, JSON.stringify(st)); } catch { /* ignore */ } };
const FIRST_PAGE = 8, MORE = 10;

export async function dailyView(route: Route, meta: any): Promise<HTMLElement> {
  const f = route.filters;
  const x = route.extra;
  const d = await api("daily", filterParams(f));
  const go = (patch: Record<string, string>) => { location.hash = buildHash("daily", f, { ...Object.fromEntries(x), ...patch }); };
  const all: any[] = d.accountView.items;

  // ---- filters (all optional; the SDR decides how to explore)
  const qRaw = x.get("q") ?? "", q = qRaw.toLowerCase();
  const part = x.get("part") ?? "", evF = x.get("ev") ?? "", cat = x.get("cat") ?? "", intentF = x.get("intent") ?? "", engF = x.get("eng") ?? "",
    icpF = x.get("icp") ?? "", workF = x.get("work") ?? "", sort = x.get("sort") ?? "rec";
  const cOk = (c: any) =>
    (!evF || c.events.some((e: any) => e.id === evF)) && (!cat || c.events.some((e: any) => e.category === cat)) &&
    (!engF || String(c.engagementStrength) === engF) &&
    (!part || (part === "attended" ? c.events.some((e: any) => e.participation === "attended") : part === "registered" ? !c.events.some((e: any) => e.participation === "attended") && c.events.some((e: any) => e.participation === "registered_only") : c.events.every((e: any) => e.participation === "unknown")));
  const filtered = all.filter((a) =>
    a.contacts.some(cOk) &&
    (!q || (a.companyName ?? "").toLowerCase().includes(q) || a.contacts.some((c: any) => `${c.contactName} ${c.jobTitle ?? ""}`.toLowerCase().includes(q) || c.events.some((e: any) => (e.name ?? "").toLowerCase().includes(q)))) &&
    (!intentF || (intentF === "hotwarm" ? ["hot", "warm"].includes(a.intent?.level) : a.intent?.level === intentF)) &&
    (!icpF || a.intent?.icp === icpF) && (!workF || (workF === "worked" ? a.worked : !a.worked)));
  const IR: Record<string, number> = { hot: 0, warm: 1, unknown: 2, cold: 3 };
  const rows = filtered.map((a, i) => { const c = recommend(a); return { a, c, i, b: bucketOf(a, c) }; });
  rows.sort((p, r) =>
    sort === "intent" ? (IR[p.a.intent?.level] ?? 2) - (IR[r.a.intent?.level] ?? 2) || p.i - r.i
    : sort === "eng" ? (p.c.engagementStrength ?? 4) - (r.c.engagementStrength ?? 4) || p.i - r.i
    : sort === "recent" ? (strongestEvent(r.c)?.date ?? "").localeCompare(strongestEvent(p.c)?.date ?? "")
    : sort === "oldest" ? (p.a.worked ? 1 : 0) - (r.a.worked ? 1 : 0) || (strongestEvent(p.c)?.date ?? "9").localeCompare(strongestEvent(r.c)?.date ?? "9")
    : p.i - r.i);
  const inB = (k: Bucket) => rows.filter((r) => r.b === k);
  if (!st.open) { st.open = [inB("pickup").length ? "pickup" : "fresh"]; persist(); }
  if (q) for (const r of rows) if (!st.open.includes(r.b)) st.open.push(r.b);

  // ---- compact card
  const card = ({ a, c, b }: { a: any; c: any; b: Bucket }) => {
    const it = intentInfo(a.intent);
    const src = sourceLine(c);
    const nd = nudge(a, c, b);
    const hl = highlights(a, c);
    const open = () => accountPanel(a, c);
    return h("article", { class: `ocard n-${nd.tone}`, tabindex: "0", onclick: open, onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter") open(); } },
      h("div", { class: "oc1" }, hideBox(a), h("span", { class: "ocname" }, a.companyName ?? "(no company)"),
        a.reengageOn ? h("span", { class: `ore ${a.reengageOn <= todayIso() ? "due" : ""}` }, a.reengageOn <= todayIso() ? `Re-engage due (${fmt.day(a.reengageOn)})` : `Re-engage ${fmt.day(a.reengageOn)}`) : null, h("span", { class: `oint i-${it.cls}` }, it.cls === "unknown" ? `Account intent: ${it.text.toLowerCase()}` : `${it.text} account`),
        ...hl.map((t) => h("span", { class: "ohl" }, t)), !f.sdr && a.sdrName ? h("span", { class: "ocown" }, a.sdrName) : null),
      h("div", { class: "oc2" }, h("b", null, c.contactName), c.jobTitle ? ` · ${c.jobTitle}` : "",
        h("span", { class: "osrc" }, ` — ${src.text}`, src.more > 0 ? h("span", { class: "more" }, ` +${src.more} more`) : null)),
      (() => { const se = strongestEvent(c); const note = (c.events ?? []).map((e: any) => e.eventNote).find(Boolean);
        return se?.topic || note ? h("div", { class: "octopic" }, se?.topic ? `Session: ${se.topic.length > 100 ? se.topic.slice(0, 100) + "…" : se.topic}` : "",
          se?.about?.hook ? h("div", { class: "ochook" }, `Talking point: ${se.about.hook}`) : null, note ? h("span", { class: "ocnote" }, `${se?.topic ? " · " : ""}Note: ${note.length > 90 ? note.slice(0, 90) + "…" : note}`) : null) : null; })(),
      h("div", { class: "oc3" }, h("span", { class: `onudge t-${nd.tone}` }, nd.text),
        b === "momentum" ? reengagePicker(a) : null,
        h("button", { class: "oexp", onclick: (e: Event) => { e.stopPropagation(); open(); } }, "Explore account →")));
  };

  // ---- collapsible buckets
  const bucketEl = (bk: (typeof BUCKETS2)[number]) => {
    const list = inB(bk.key);
    const isOpen = st.open!.includes(bk.key);
    const body = h("div", { class: "obody" });
    const more = h("button", { class: "omore" });
    let shown = 0;
    const page = (n: number) => { body.insertBefore(h("div", { class: "ocards" }, list.slice(shown, shown + n).map(card)), more); shown = Math.min(list.length, shown + n); st.shown[bk.key] = shown; persist(); more.style.display = shown < list.length ? "" : "none"; more.textContent = `Show ${Math.min(MORE, list.length - shown)} more (${list.length - shown} left)`; };
    more.addEventListener("click", () => page(MORE));
    body.append(more);
    if (bk.key === "momentum") {
      const ms = x.get("msort") ?? "longest";
      const lastOf = (r: any) => r.a.lastSdrTouch ?? r.a.workedByOther?.at ?? "";
      const today = todayIso();
      const due = list.filter((r) => r.a.reengageOn && r.a.reengageOn <= today).sort((p, q) => p.a.reengageOn.localeCompare(q.a.reengageOn));
      const none = list.filter((r) => !r.a.reengageOn).sort((p, q) => ms === "recent" ? lastOf(q).localeCompare(lastOf(p)) : lastOf(p).localeCompare(lastOf(q)));
      const later = list.filter((r) => r.a.reengageOn && r.a.reengageOn > today).sort((p, q) => p.a.reengageOn.localeCompare(q.a.reengageOn));
      list.splice(0, list.length, ...due, ...none, ...later);
      const msel = h("select", { class: "msort", onclick: (e: Event) => e.stopPropagation(), onchange: (e: Event) => go({ msort: (e.target as HTMLSelectElement).value }) },
        [["longest", "Longest since contact first"], ["recent", "Most recently contacted first"]].map(([v, l]) => { const o = h("option", { value: v }, l) as HTMLOptionElement; if (v === ms) o.selected = true; return o; }));
      const sec = (t: string, l: any[], cls: string) => l.length ? [h("div", { class: `msub ${cls}` }, `${t} (${l.length})`), h("div", { class: "ocards" }, l.slice(0, 60).map(card)),
        l.length > 60 ? h("div", { class: "faint" }, `${l.length - 60} more: use search or filters`) : null] : [];
      const mfill = () => { if (body.dataset.f) return; body.dataset.f = "1"; more.style.display = "none";
        body.prepend(...((list.length ? [h("div", { class: "mbar" }, h("span", { class: "faint" }, "Accounts with no re-engage date: "), msel),
          ...sec("Re-engage due", due, "due"), ...sec("No re-engage date chosen yet", none, "none"), ...sec("Re-engage scheduled", later, "later")] : [h("div", { class: "wempty" }, "Nothing here right now.")]) as any[]).filter((n) => !!n)); };
      (body as any)._fill = mfill;
    }
    const fill = () => { if ((body as any)._fill) return (body as any)._fill(); if (!shown) { if (list.length) page(Math.max(FIRST_PAGE, Math.min(st.shown[bk.key] ?? 0, 60))); else body.prepend(h("div", { class: "wempty" }, "Nothing here right now.")); } };
    const el = h("section", { class: `obucket b-${bk.key} ${isOpen ? "open" : ""} ${list.length ? "" : "empty"}` });
    const chev = h("span", { class: "chev" }, isOpen ? "▾" : "▸");
    const toggle = () => { const now = !el.classList.contains("open"); el.classList.toggle("open", now); chev.textContent = now ? "▾" : "▸"; st.open = now ? [...new Set([...st.open!, bk.key])] : st.open!.filter((k) => k !== bk.key); persist(); if (now) fill(); };
    el.append(h("button", { class: "ohead", onclick: toggle, "aria-expanded": String(isOpen) }, chev,
      h("span", { class: "otitle" }, bk.label), h("span", { class: "ocount" }, `${fmt.n(list.length)} account${list.length === 1 ? "" : "s"}`), h("span", { class: "odesc" }, bk.desc)), body);
    if (isOpen) fill();
    (el as any)._toggle = (want: boolean) => { if (el.classList.contains("open") !== want) toggle(); };
    return el;
  };
  const bucketEls = BUCKETS2.map(bucketEl);

  // ---- controls (search, participation, sort; the rest under Advanced)
  const search = h("input", { type: "search", class: "dsearch", placeholder: "Search a company, person or event", value: qRaw }) as HTMLInputElement;
  search.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") go({ q: search.value.trim() }); });
  const sel = (key: string, cur: string, opts: Array<[string, string]>) => h("select", { onchange: (e: Event) => go({ [key]: (e.target as HTMLSelectElement).value }) },
    opts.map(([v, l]) => { const o = h("option", { value: v }, l) as HTMLOptionElement; if (v === cur) o.selected = true; return o; }));
  const evs = new Map<string, string>(); const icps = new Set<string>();
  for (const a of all) { if (a.intent?.icp) icps.add(a.intent.icp); for (const c of a.contacts) for (const e of c.events) evs.set(e.id, `${short(e.name)} · ${fmt.day(e.date)}`); }
  const adv = h("details", { class: "advf", ...(st.advanced ? { open: true } : {}) }, h("summary", null, "More filters"),
    h("div", { class: "advg" },
      sel("ev", evF, [["", "Any event"], ...[...evs.entries()].sort((p1, p2) => p1[1].localeCompare(p2[1]))]),
      sel("cat", cat, [["", "Any event type"], ["owned", "Beacon / owned events"], ["webinar", "Webinars"], ["roundtable", "Roundtables"], ["sponsored", "Sponsored conferences"]]),
      sel("intent", intentF, [["", "Any account intent"], ["hotwarm", "Hot + Warm"], ["hot", "Hot / Surging"], ["warm", "Warm"], ["cold", "Cold"], ["unknown", "Not set"]]),
      sel("eng", engF, [["", "Any contact engagement"], ["0", "Replied / meeting"], ["1", "Verified attendee"], ["2", "Sponsored event signal"], ["3", "Registered only"], ["4", "Company intent only"]]),
      sel("icp", icpF, [["", "Any ICP tier"], ...[...icps].sort().map((v) => [v, v] as [string, string])]),
      sel("work", workF, [["", "Contacted or not"], ["worked", "Already contacted"], ["unworked", "Not contacted yet"]]),
      h("button", { class: "linkbtn", onclick: () => go({ ev: "", cat: "", intent: "", eng: "", icp: "", work: "" }) }, "Clear")));
  adv.addEventListener("toggle", () => { st.advanced = (adv as HTMLDetailsElement).open; persist(); });
  const S = d.accountView.summary;
  const prog = h("details", { class: "myprog", ...(st.progress ? { open: true } : {}) }, h("summary", null, "Your progress"),
    h("div", { class: "mpg" }, ...([
      ["Accounts", fmt.n(S.accounts), (a: any) => true],
      ["Contacted", `${fmt.n(S.worked)} (${fmt.pct(S.coveragePct)})`, (a: any) => a.worked || !!a.workedByOther],
      ["Not contacted yet", fmt.n(S.notWorked), (a: any) => !a.worked && !a.workedByOther],
      ["People contacted", `${fmt.n(S.contactsWorked)} of ${fmt.n(S.contacts)}`, (a: any) => a.coverage.contacted > 0],
      ["Qualified", fmt.n(S.qualified), (a: any) => a.bucket === "qualified"],
      ["Paused", fmt.n(S.paused), (a: any) => a.bucket === "paused"],
    ] as Array<[string, string, (a: any) => boolean]>).map(([l, v, test]) => h("button", { class: "mp mpbtn", onclick: () => progressList(l, all.filter(test)) }, h("b", null, v), h("span", null, l)))));
  prog.addEventListener("toggle", () => { st.progress = (prog as HTMLDetailsElement).open; persist(); });

  const fr = meta?.freshness;
  return h("div", { class: "dcc" },
    h("div", { class: "dcchead" },
      h("div", null, h("h1", null, "Your Opportunities"), h("div", { class: "osub" }, "Good places to start. You choose where to focus."),
        h("div", { class: "faint", style: "font-size:12.5px;margin-top:4px" }, `${fmt.n(rows.length)} eligible accounts${filtered.length !== all.length ? " match your filters" : ""} · grouped by HubSpot company, owned by the company SDR Owner`)),
      h("div", { class: `syncst ${fr?.stale ? "stale" : ""}` }, fr?.lastSuccessAt ? `HubSpot synced ${fmt.ago(fr.lastSuccessAt)}` : "No successful HubSpot sync yet",
        fr?.lastSuccessAt ? h("div", { class: "faint" }, new Date(fr.lastSuccessAt).toLocaleString()) : null,
        fr?.stale ? h("div", null, "Data may be stale") : null, fr?.lastRun?.status === "failed" ? h("div", null, "Last sync failed; showing the last good data") : null)),
    h("div", { class: "dctl" }, search,
      sel("part", part, [["", "Attended or registered"], ["attended", "Verified attendees"], ["registered", "Registered only"], ["unknown", "Attendance unknown"]]),
      sel("sort", sort, [["rec", "Sort: recommended"], ["intent", "Highest account intent"], ["eng", "Strongest contact engagement"], ["recent", "Most recent event"], ["oldest", "Oldest not contacted"]]),
      h("span", { class: "xall" }, h("button", { class: "linkbtn", onclick: () => bucketEls.forEach((el: any) => el._toggle(true)) }, "Expand all"), " · ",
        h("button", { class: "linkbtn", onclick: () => bucketEls.forEach((el: any) => el._toggle(false)) }, "Collapse all"))),
    adv,
    h("div", { class: "obuckets" }, bucketEls),
    prog);
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
      blockEl("Suggested next step",
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
      ...(() => {
        const withCtx = evs.filter((e: any) => e.about || e.topic || e.eventNote);
        if (!withCtx.length) return [];
        const top = strongestEvent(c);
        const list = top && withCtx.includes(top) ? [top, ...withCtx.filter((e: any) => e !== top)] : withCtx;
        return [blockEl("Event context", ...list.slice(0, 3).map((e: any, i: number) => h("div", { class: `ectx ${i ? "sec" : ""}` },
          h("div", { class: "ectitle" }, h("b", null, e.about?.title ?? e.topic ?? short(e.name)), h("span", { class: "faint" }, ` · ${fmt.day(e.date)} · ${partText(e)}`)),
          e.about ? h("div", { class: "ecspk" }, e.about.speakers) : null,
          e.about ? h("div", { class: "ecsum" }, e.about.summary) : null,
          e.about ? h("div", { class: "evhook" }, h("b", null, "Conversation starter: "), e.about.hook) : null,
          e.eventNote ? h("div", { class: "evnote" }, `Event team note: ${e.eventNote}`) : null)))];
      })(),
      h("div", { class: "pduo" },
        h("div", { class: `pbig i-${it.cls}` }, h("small", null, "ACCOUNT INTENT"), h("b", null, it.text),
          h("div", null, [a.intent?.since ? `since ${fmt.day(a.intent.since)}` : null, a.intent?.sdrCategory, a.intent?.reason ?? "detailed trigger not recorded"].filter(Boolean).join(" · ")),
          h("div", { class: "faint" }, "Company-level (HubSpot Account Intent Level). It does not mean every contact is engaged.")),
        h("div", { class: `pbig e${c.engagementStrength}` }, h("small", null, "CONTACT ENGAGEMENT"), h("b", null, c.engagementLabel),
          h("div", null, c.engagement),
          h("div", { class: "faint" }, "This person's own evidence: replies, meetings, verified attendance or registration."))),
      ...(c.scoring?.length ? [blockEl("Why this priority", h("ul", { class: "scorebd" }, c.scoring.map((t: string) => h("li", null, t))))] : []),
      blockEl("Event & engagement history",
        evs.length ? h("div", { class: "evh" }, evs.map((e: any) => h("div", { class: "evrow2" },
          h("div", null, h("b", null, short(e.name)), h("span", { class: "faint" }, ` · ${e.category} · ${fmt.day(e.date)}`)),
          h("div", null, h("span", { class: `pp p-${e.participation}` }, partText(e)), h("span", { class: "faint" }, e.participationSource ? ` · ${e.participationSource}` : "")),
          e.topic ? h("div", { class: "evtopic" }, `Topic: ${e.topic}`) : null,

          null))) : h("div", { class: "faint" }, "No event records")),
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
        const cb = h("input", { type: "checkbox", class: "redact", title: "Hide this lead (wrong or irrelevant)" }) as HTMLInputElement;
        cb.addEventListener("click", (e) => e.stopPropagation());
        cb.addEventListener("change", async () => {
          if (!cb.checked) return;
          const reason = prompt(`Hide ${c.contactName}? Optional reason:`, "");
          if (reason === null) { cb.checked = false; return; }
          try { await redact(c, a, reason); (cb.closest(".pc") as HTMLElement | null)?.remove(); refresh(); } catch (e) { cb.checked = false; alert((e as Error).message); }
        });
        return h("button", { class: "pc", onclick: () => { render(c); box.parentElement?.scrollTo?.({ top: 0 }); } },
          h("div", null, cb, " ", h("b", null, c.contactName), c.jobTitle ? h("span", { class: "faint" }, ` · ${c.jobTitle}`) : null),
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

const todayIso = () => new Date().toISOString().slice(0, 10);
const addDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const myName = () => { try { return localStorage.getItem("ecc-name") ?? ""; } catch { return ""; } };
const refresh = () => setTimeout(() => window.dispatchEvent(new HashChangeEvent("hashchange")), 200);

/** SDR picks when to re-engage this account (no default: the SDR decides). */
function reengagePicker(a: any) {
  const key = a.companyId ?? a.key;
  const date = h("input", { type: "date", class: "redate", value: a.reengageOn ?? "" }) as HTMLInputElement;
  const save = async (d: string | null) => {
    try {
      await api("reengage", undefined, { method: d ? "POST" : "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, date: d, by: myName() }) });
      refresh();
    } catch (e) { alert((e as Error).message); }
  };
  const sel = h("select", { class: "resel" }, [["", a.reengageOn ? "Change re-engage…" : "Re-engage in…"], ["3", "3 days"], ["7", "7 days"], ["14", "14 days"], ["30", "30 days"], ["date", "Pick a date…"], ...(a.reengageOn ? [["clear", "Clear date"]] : [])]
    .map(([v, l]) => h("option", { value: v }, l))) as HTMLSelectElement;
  sel.addEventListener("change", () => {
    const v = sel.value;
    if (v === "clear") return save(null);
    if (v === "date") { date.style.display = ""; date.focus(); try { (date as any).showPicker?.(); } catch { /* ignore */ } return; }
    if (v) save(addDays(Number(v)));
  });
  date.style.display = "none";
  date.addEventListener("change", () => { if (date.value) save(date.value); });
  return h("span", { class: "rewrap", onclick: (e: Event) => e.stopPropagation(), onkeydown: (e: Event) => e.stopPropagation() }, sel, date);
}

/** Tick box: hide this account's leads (wrong / irrelevant). They move to Redacted leads and leave every list. */
function hideBox(a: any) {
  const cb = h("input", { type: "checkbox", class: "redact", title: "Hide this account's leads (wrong or irrelevant). They move to Redacted leads." }) as HTMLInputElement;
  cb.addEventListener("click", (e) => e.stopPropagation());
  cb.addEventListener("change", async () => {
    if (!cb.checked) return;
    const reason = prompt(`Hide ${a.contacts.length} lead${a.contacts.length === 1 ? "" : "s"} at ${a.companyName ?? "this account"}? Optional reason:`, "");
    if (reason === null) { cb.checked = false; return; }
    try {
      for (const c of a.contacts) await redact(c, a, reason);
      const card = cb.closest(".ocard") as HTMLElement | null; if (card) { card.classList.add("gone"); setTimeout(() => card.remove(), 250); }
    } catch (e) { cb.checked = false; alert((e as Error).message); }
  });
  return cb;
}
async function redact(c: any, a: any, reason: string) {
  await api("redactions", undefined, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contactId: c.contactId, contactName: c.contactName, companyName: a.companyName, events: (c.events ?? []).map((e: any) => e.name).join(", "), reason, redactedBy: myName() }) });
}

/** "Your progress" tiles open the accounts behind the number; each opens the account panel. */
function progressList(label: string, accounts: any[]) {
  const box = h("div", { class: "apanel" });
  openCustom(`${label} (${accounts.length})`, "Accounts behind this number, with your current filters", box);
  const name = (a: any) => (a.companyName ?? "").toLowerCase();
  box.append(h("div", { class: "plist" }, accounts.length ? [...accounts].sort((x, y) => name(x).localeCompare(name(y))).map((a) => {
    const c = recommend(a);
    const last = a.lastSdrTouch ?? a.workedByOther?.at ?? null;
    return h("button", { class: "plrow", onclick: () => accountPanel(a, c) },
      h("div", null, h("b", null, a.companyName ?? "(no company)"), h("span", { class: "faint" }, ` · ${intentInfo(a.intent).text}`)),
      h("div", { class: "faint" }, [`${a.coverage.contacted}/${a.coverage.available} contacts reached`,
        last ? `last contact ${fmt.day(last)}${a.workedByOther && !a.worked ? ` by ${a.workedByOther.by?.name ?? "another rep"}` : ""}` : "not contacted yet",
        a.reengageOn ? `re-engage ${fmt.day(a.reengageOn)}` : null].filter(Boolean).join(" · ")));
  }) : [h("div", { class: "faint" }, "No accounts.")]));
}
