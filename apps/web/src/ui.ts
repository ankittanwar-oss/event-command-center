// Tiny DOM helpers. All text goes through textContent, so data from HubSpot is never interpreted as HTML.

type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, unknown> & { class?: string; style?: string; onclick?: (e: MouseEvent) => void };

export function h(tag: string, attrs: Attrs | null = null, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener);
      else if (k === "class") el.className = String(v);
      else if (k === "value") (el as HTMLInputElement).value = String(v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: HTMLElement, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const fmt = {
  n: (x: number | null | undefined) => (x === null || x === undefined ? "–" : x.toLocaleString("en-US")),
  pct: (x: number | null | undefined) => (x === null || x === undefined ? "–" : `${x.toFixed(x % 1 === 0 ? 0 : 1)}%`),
  dec: (x: number | null | undefined) => (x === null || x === undefined ? "–" : x.toFixed(1)),
  day: (x: string | null | undefined) => {
    if (!x) return "–";
    const d = new Date(x.length === 10 ? `${x}T12:00:00Z` : x);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric", timeZone: "UTC" });
  },
  ago: (iso: string | null | undefined) => {
    if (!iso) return "never";
    const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m} min ago`;
    const hh = Math.round(m / 60);
    if (hh < 48) return `${hh} h ago`;
    return `${Math.round(hh / 24)} days ago`;
  },
};

export const STATUS_CLASS: Record<string, string> = {
  never_worked: "", stalled: "bad", unverifiable: "", first_touch: "", active: "good", in_play: "good", recently_lost: "",
};
/** Status label; colored by the lead's risk level when known, so color always means the same thing. */
export function statusPill(status: string, label: string, risk?: string | null) {
  const cls = risk ? ({ critical: "bad", at_risk: "warnr", healthy: "good", neutral: "" } as Record<string, string>)[risk] ?? "" : STATUS_CLASS[status] ?? "";
  return h("span", { class: `pill ${cls}` }, label);
}
export function tempPill(t: string | null, raw?: string | null) {
  const v = t ?? raw ?? null;
  return v ? h("span", { class: `pill ${v === "Hot" ? "hot" : v === "Warm" ? "warm" : "cold"}` }, v) : h("span", { class: "pill cold" }, "Temp not set");
}

let portalId = "7712708";
export function setPortal(id: string) { portalId = id; }
export function hsLink(kind: "contact" | "company" | "deal", id: string | null | undefined, label = "↗") {
  if (!id) return null;
  const type = kind === "contact" ? "0-1" : kind === "company" ? "0-2" : "0-3";
  return h("a", { class: "hs", href: `https://app.hubspot.com/contacts/${portalId}/record/${type}/${id}`, target: "_blank", rel: "noopener noreferrer", title: "Open in HubSpot" }, label);
}

export interface Col<T> { key: string; label: string; num?: boolean; render?: (r: T) => Child; sort?: (r: T) => string | number | null; title?: string; wrap?: boolean }

// ---- Risk system: color is always paired with a shape and a word, so it reads without color too.
export type Risk = "critical" | "at_risk" | "healthy" | "neutral";
export const RISK: Record<Risk, { label: string; icon: string; cls: string }> = {
  critical: { label: "Critical", icon: "▲", cls: "crit" },
  at_risk: { label: "At risk", icon: "◆", cls: "warnr" },
  healthy: { label: "Healthy", icon: "●", cls: "ok" },
  neutral: { label: "Not judged", icon: "○", cls: "neu" },
};
export function riskPill(level: string | null | undefined, label?: string, title?: string) {
  if (!level || !(level in RISK)) return h("span", { class: "rp neu", title: title ?? "Not eligible for follow-up" }, h("i", null, "–"), label ?? "Not eligible");
  const m = RISK[level as Risk];
  return h("span", { class: `rp ${m.cls}`, title }, h("i", { "aria-hidden": "true" }, m.icon), label ?? m.label);
}
/** Small inline marker for a number cell. Healthy/neutral stay quiet (no marker). */
export function flag(level: Risk | null, content: Child, title?: string) {
  if (!level || level === "healthy" || level === "neutral") return h("span", { title }, content);
  const m = RISK[level];
  return h("span", { class: `flag ${m.cls}`, title: title ?? m.label }, h("i", { "aria-hidden": "true" }, m.icon), content);
}
/** Compact horizontal stacked bar: critical / at risk / healthy / neutral. Each segment is clickable. */
export function riskBar(c: { eligible: number; critical: number; at_risk: number; healthy: number; neutral: number }, onPick?: (level: Risk) => void) {
  const seg = (level: Risk) => {
    const n = c[level];
    if (!n || !c.eligible) return null;
    const pctv = (n / c.eligible) * 100;
    return h("span", {
      class: `seg ${RISK[level].cls}`, style: `width:${pctv}%`, title: `${RISK[level].label}: ${n} (${pctv.toFixed(1)}%)`,
      onclick: onPick ? () => onPick(level) : undefined,
    });
  };
  return h("div", { class: "rbar", role: "img", "aria-label": `Critical ${c.critical}, at risk ${c.at_risk}, healthy ${c.healthy}, not yet due ${c.neutral}` },
    c.eligible ? [seg("critical"), seg("at_risk"), seg("healthy"), seg("neutral")] : h("span", { class: "seg empty", style: "width:100%" }));
}

/** Sortable table. Sorting is client-side on already-filtered rows. */
export function table<T>(cols: Col<T>[], rows: T[], opts: { empty?: string; initialSort?: string; desc?: boolean; rowClass?: (r: T) => string } = {}): HTMLElement {
  let sortKey = opts.initialSort ?? "";
  let desc = opts.desc ?? true;
  const wrap = h("div", { class: "tbl-wrap" });
  const render = () => {
    const col = cols.find((c) => c.key === sortKey);
    const data = [...rows];
    if (col) {
      const get = col.sort ?? ((r: T) => (r as any)[col.key]);
      data.sort((a, b) => {
        const x = get(a), y = get(b);
        if (x === y) return 0;
        if (x === null || x === undefined) return 1;
        if (y === null || y === undefined) return -1;
        return (x < y ? -1 : 1) * (desc ? -1 : 1);
      });
    }
    const thead = h("thead", null, h("tr", null, cols.map((c) => h("th", {
      class: `${c.num ? "n " : ""}sortable`, title: c.title,
      onclick: () => { if (sortKey === c.key) desc = !desc; else { sortKey = c.key; desc = true; } render(); },
    }, c.label, sortKey === c.key ? (desc ? " ↓" : " ↑") : ""))));
    const tbody = h("tbody", null, data.length ? data.map((r) => h("tr", { class: opts.rowClass?.(r) || undefined }, cols.map((c) => h("td", { class: `${c.num ? "n" : ""} ${c.wrap ? "wrap" : ""}` }, c.render ? c.render(r) : String((r as any)[c.key] ?? "–"))))) :
      h("tr", null, h("td", { colspan: cols.length, class: "empty" }, opts.empty ?? "No records")));
    wrap.replaceChildren(h("table", null, thead, tbody));
  };
  render();
  return wrap;
}

export function bar(pct: number | null) {
  return h("div", { class: "bar", title: fmt.pct(pct) }, h("i", { style: `width:${Math.max(0, Math.min(100, pct ?? 0))}%` }));
}

export function delta(cur: number | null, prev: number | null, unit = "pt", higherIsBetter = true) {
  if (cur === null || prev === null) return h("span", { class: "faint" }, "–");
  const d = Math.round((cur - prev) * 10) / 10;
  if (d === 0) return h("span", { class: "faint" }, "±0");
  const good = (d > 0) === higherIsBetter;
  return h("span", { class: `delta ${good ? "up" : "down"}` }, `${d > 0 ? "+" : ""}${d}${unit}`);
}

// ---- Deal history (context only: never part of the risk colors, never counted as event pipeline)
export const DEAL_LABEL: Record<string, string> = { open: "Open opportunity", won: "Closed won", lost: "Closed lost", none: "No associated deal" };

export function dealPill(status: string | null | undefined, detail?: string) {
  const st = status ?? "none";
  return h("span", { class: `dp ${st}`, title: detail ?? DEAL_LABEL[st] }, st === "lost" ? "✕ " : st === "won" ? "✓ " : st === "open" ? "◷ " : "", DEAL_LABEL[st] ?? st, detail ? h("span", { class: "dpd" }, ` · ${detail}`) : null);
}

/** Every deal on the account/contact, most relevant first, with closed-lost details exactly as recorded in HubSpot. */
export function dealTable(deals: any[]) {
  if (!deals?.length) return h("div", { class: "faint", style: "padding:6px 0" }, "No associated deal in HubSpot.");
  return table<any>([
    { key: "name", label: "Deal", wrap: true, render: (d) => [d.name ?? `Deal ${d.id}`, hsLink("deal", d.id)] },
    { key: "status", label: "Status", render: (d) => dealPill(d.status) },
    { key: "stageLabel", label: "Current stage", wrap: true, render: (d) => d.stageLabel ?? "–" },
    { key: "timing", label: "Relative to event", title: "Pre-existing = reached MQL (or, with no MQL date, was created) before the event", render: (d) => d.timing === "before_event" ? h("span", { class: "pill" }, "Pre-existing") : d.timing === "after_event" ? h("span", { class: "pill info" }, "New since event") : "–" },
    { key: "createdAt", label: "Created", render: (d) => fmt.day(d.createdAt) },
    { key: "closedAt", label: "Closed", render: (d) => fmt.day(d.closedAt) },
    { key: "previousStageLabel", label: "Stage before closed lost", wrap: true, render: (d) => (d.status === "lost" ? d.previousStageLabel ?? h("span", { class: "faint" }, "Not available") : "–") },
    { key: "lostReason", label: "Closed lost reason", wrap: true, render: (d) => d.status !== "lost" ? "–" :
      [d.lostReason, d.lostSubReason, d.lostComment].filter(Boolean).length ? [d.lostReason, d.lostSubReason, d.lostComment].filter(Boolean).join(" · ") : h("span", { class: "faint" }, "No reason recorded in HubSpot") },
    { key: "owner", label: "Deal owner", render: (d) => d.owner ? `${d.owner.name ?? "Unknown user"}${d.owner.role ? ` (${d.owner.role})` : ""}` : h("span", { class: "faint" }, "Not available") },
    { key: "via", label: "Associated with", render: (d) => d.via === "contact" ? "This contact" : d.via === "company" ? h("span", { class: "muted" }, "Company only") : d.via === "duplicate_company" ? h("span", { class: "warnr-t", title: "Deal on another HubSpot company record with the same name and SDR owner (likely duplicate). Merge the records in HubSpot." }, "Duplicate company record") : h("span", { class: "muted", title: "Linked to the company only; not necessarily this contact's deal" }, "Company only") },
  ], deals, { initialSort: "", desc: false });
}
