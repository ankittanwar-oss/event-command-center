import { api } from "./api.js";
import { openCustom } from "./drawer.js";
import { filterParams, type FilterState } from "./state.js";
import { fmt, h, hsLink } from "./ui.js";

// Drill-down behind an Account execution cell. The server applies the exact metric predicate used for the count,
// with the same filters and SDR attribution; this panel only searches/sorts/filters what it returns.
const BUCKET_LABEL: Record<string, string> = { respond: "Respond now", first_outreach: "First outreach", follow_up: "Follow-up opportunity", review: "Needs review",
  progress: "In progress", paused: "Paused / closed", low: "Lower priority", qualified: "Qualified" };
const INTENT_RANK: Record<string, number> = { hot: 0, warm: 1, unknown: 2, cold: 3 };
const URGENCY: Record<string, number> = { respond: 0, follow_up: 1, first_outreach: 2, review: 3, progress: 4, low: 5, paused: 6, qualified: 7 };
const PAGE = 50;
const who = (o: any) => (o ? `${o.name ?? "Unknown user"}${o.role ? ` (${o.role})` : ""}` : "owner not recorded");
const intentTxt = (it: any) => (!it?.synced ? "Intent not synced" : it.level === "unknown" ? "Unknown" : it.level === "hot" ? "Surging" : it.level[0].toUpperCase() + it.level.slice(1));

export async function openAccountDrill(filters: FilterState, metric: string, rowSdr: string, rowName: string, label: string) {
  const box = h("div", { class: "cdrawer adrill" }, h("div", { class: "loading" }, "Loading…"));
  openCustom(`${rowName} · ${label}`, "Companies behind the number, with the dashboard filters applied", box);
  let d: any;
  try { d = await api("account-drill", { ...filterParams(filters), metric, rowSdr }); }
  catch (e) { box.replaceChildren(h("div", { class: "banner warn" }, (e as Error).message)); return; }
  const all: any[] = d.accounts;
  const search = h("input", { type: "search", placeholder: "Search company or contact" }) as HTMLInputElement;
  const opt = (pairs: Array<[string, string]>) => pairs.map(([v, l]) => h("option", { value: v }, l));
  const intentSel = h("select", null, opt([["", "Any intent"], ["hotwarm", "Hot + Warm"], ["hot", "Surging"], ["warm", "Warm"], ["cold", "Cold"], ["unknown", "Unknown"]])) as HTMLSelectElement;
  const icps = [...new Set(all.map((a) => a.intent?.icp).filter(Boolean))].sort() as string[];
  const icpSel = h("select", null, opt([["", "Any ICP tier"], ...icps.map((x) => [x, x] as [string, string])])) as HTMLSelectElement;
  const evs = new Map<string, string>(); for (const a of all) for (const e of a.events) evs.set(e.id, `${(e.name ?? "").slice(0, 36)} · ${fmt.day(e.date)}`);
  const evSel = h("select", null, opt([["", "Any event"], ...[...evs.entries()]])) as HTMLSelectElement;
  const stSel = h("select", null, opt([["", "Any status"], ...Object.entries(BUCKET_LABEL).filter(([k]) => all.some((a) => a.bucket === k))])) as HTMLSelectElement;
  const sortSel = h("select", null, opt([["urgency", "Sort: urgency"], ["intent", "Sort: intent"], ["last", "Sort: last outreach"], ["name", "Sort: company"]])) as HTMLSelectElement;
  const head = h("div", { class: "drillhead" });
  const list = h("div", { class: "wlist" });
  const more = h("button", { class: "btn more" }, "Show more");
  let data: any[] = [], shown = 0;
  const open = new Set<string>();

  const contactRow = (c: any) => h("div", { class: `ctrow c-${c.color}` },
    h("span", { class: "cdot2" }),
    h("div", { class: "ctn" }, c.contactName, " ", hsLink("contact", c.contactId), c.jobTitle ? h("span", { class: "faint" }, ` · ${c.jobTitle}`) : null,
      h("div", { class: "faint ctev" }, c.disposition ? `Disposition: ${c.reason}` : BUCKET_LABEL[c.group] ?? c.group)),
    h("div", { class: "ctl" }, h("div", null, `Last: ${c.lastOutboundAt ? `${fmt.day(c.lastOutboundAt)} · ${who(c.lastBy)}` : "Not contacted"}`),
      h("div", { class: "faint" }, `${c.yourTouches} qualifying SDR touch${c.yourTouches === 1 ? "" : "es"}${c.otherSdrTouches ? ` · ${c.otherSdrTouches} by another SDR (not credited)` : ""}`)),
    h("div", { class: "cta" }, h("span", { class: "cact" }, c.action), h("div", { class: "faint cwhy" }, c.reason)));
  const accountRow = (a: any) => {
    const body = h("div", { class: "acontacts" });
    const chev = h("span", { class: "chev" }, open.has(a.key) ? "▾" : "▸");
    const el = h("div", { class: `arow ${open.has(a.key) ? "open" : ""}` });
    const fill = () => { if (!body.childElementCount) body.append(...a.contacts.map(contactRow)); };
    if (open.has(a.key)) fill();
    const toggle = () => { const now = !el.classList.contains("open"); el.classList.toggle("open", now); chev.textContent = now ? "▾" : "▸"; if (now) { fill(); open.add(a.key); } else open.delete(a.key); };
    el.append(h("div", { class: `ahead c-${a.bucket === "paused" ? "grey" : a.top.color}`, tabindex: "0", onclick: toggle, onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter") toggle(); } },
      chev,
      h("div", { class: "aname" }, h("b", null, a.companyName ?? "(no company)"), " ", a.companyId ? h("span", { onclick: (e: Event) => e.stopPropagation() }, hsLink("company", a.companyId)) : null,
        h("div", { class: "faint awhy" }, [intentTxt(a.intent), a.intent?.sdrCategory, a.intent?.reason, a.intent?.icp].filter(Boolean).join(" · "))),
      h("div", { class: "astat" }, h("div", null, `${a.coverage.worked}/${a.coverage.available} contacts worked`), h("div", { class: "faint" }, a.lastSdrTouch ? `Last SDR outreach ${fmt.day(a.lastSdrTouch)}${a.daysSinceLast !== null && a.daysSinceLast !== undefined ? ` · ${a.daysSinceLast} bd ago` : ""}` : "No qualifying SDR outreach")),
      h("div", { class: "aact" }, h("div", { class: "cact" }, a.companyDisposition ? "Paused company-wide" : a.top.action), h("div", { class: "faint" }, [BUCKET_LABEL[a.bucket] ?? a.bucket, a.opportunities].filter(Boolean).join(" · ")))),
      body);
    return el;
  };
  const page = () => { list.append(...data.slice(shown, shown + PAGE).map(accountRow)); shown = Math.min(data.length, shown + PAGE); more.style.display = shown < data.length ? "" : "none"; more.textContent = `Show more (${data.length - shown} left)`; };
  more.addEventListener("click", page);
  const render = () => {
    const q = search.value.trim().toLowerCase();
    data = all.filter((a) =>
      (!q || (a.companyName ?? "").toLowerCase().includes(q) || a.contacts.some((c: any) => `${c.contactName} ${c.jobTitle ?? ""}`.toLowerCase().includes(q))) &&
      (!intentSel.value || (intentSel.value === "hotwarm" ? ["hot", "warm"].includes(a.intent?.level) : a.intent?.level === intentSel.value)) &&
      (!icpSel.value || a.intent?.icp === icpSel.value) && (!evSel.value || a.events.some((e: any) => e.id === evSel.value)) && (!stSel.value || a.bucket === stSel.value));
    const s = sortSel.value;
    data.sort((x, y) => s === "intent" ? (INTENT_RANK[x.intent?.level] ?? 2) - (INTENT_RANK[y.intent?.level] ?? 2)
      : s === "last" ? (y.lastSdrTouch ?? "").localeCompare(x.lastSdrTouch ?? "") : s === "name" ? (x.companyName ?? "").localeCompare(y.companyName ?? "")
      : (URGENCY[x.bucket] ?? 9) - (URGENCY[y.bucket] ?? 9));
    if (q) for (const a of data) if (a.contacts.some((c: any) => c.contactName.toLowerCase().includes(q))) open.add(a.key);
    const contacts = data.reduce((n, a) => n + a.contacts.length, 0);
    head.replaceChildren(h("span", { class: "dcount" }, d.contactMetric ? `${fmt.n(contacts)}` : fmt.n(data.length), h("small", null, d.contactMetric ? ` contacts in ${fmt.n(data.length)} companies` : ` account${data.length === 1 ? "" : "s"}`)),
      ...(data.length !== all.length ? [h("span", { class: "faint" }, ` (of ${fmt.n(d.contactMetric ? d.contactCount : d.accountCount)} — panel filters applied)`)] : []),
      h("span", { class: "chipx" }, d.filters.quarterLabel));
    list.replaceChildren(); shown = 0; page();
  };
  search.addEventListener("input", render);
  for (const el of [intentSel, icpSel, evSel, stSel, sortSel]) el.addEventListener("change", render);
  box.replaceChildren(head, h("div", { class: "rectools" }, search, intentSel, icpSel, evSel, stSel, sortSel), list, more);
  render();
}
