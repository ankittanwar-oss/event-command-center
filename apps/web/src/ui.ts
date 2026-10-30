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
  never_worked: "bad", stalled: "bad", unverifiable: "info", first_touch: "warm", active: "good", in_play: "accent",
};
export function statusPill(status: string, label: string) { return h("span", { class: `pill ${STATUS_CLASS[status] ?? ""}` }, label); }
export function tempPill(t: string | null) { return t ? h("span", { class: `pill ${t === "Hot" ? "hot" : "warm"}` }, t) : h("span", { class: "faint" }, "–"); }

let portalId = "7712708";
export function setPortal(id: string) { portalId = id; }
export function hsLink(kind: "contact" | "company" | "deal", id: string | null | undefined, label = "↗") {
  if (!id) return null;
  const type = kind === "contact" ? "0-1" : kind === "company" ? "0-2" : "0-3";
  return h("a", { class: "hs", href: `https://app.hubspot.com/contacts/${portalId}/record/${type}/${id}`, target: "_blank", rel: "noopener noreferrer", title: "Open in HubSpot" }, label);
}

export interface Col<T> { key: string; label: string; num?: boolean; render?: (r: T) => Child; sort?: (r: T) => string | number | null; title?: string; wrap?: boolean }

/** Sortable table. Sorting is client-side on already-filtered rows. */
export function table<T>(cols: Col<T>[], rows: T[], opts: { empty?: string; initialSort?: string; desc?: boolean } = {}): HTMLElement {
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
    const tbody = h("tbody", null, data.length ? data.map((r) => h("tr", null, cols.map((c) => h("td", { class: `${c.num ? "n" : ""} ${c.wrap ? "wrap" : ""}` }, c.render ? c.render(r) : String((r as any)[c.key] ?? "–"))))) :
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
