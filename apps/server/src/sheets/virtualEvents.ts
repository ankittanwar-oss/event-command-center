// "Virtual events data" Google Sheet. Tab "Marketing event" is the index: one row per event with its date, the
// landing-page title (topic, speaker, partner) and the HubSpot marketing-event record link. Every other tab is that
// event's post-event list; its comment columns ("Anwesh comments", "Comments from event", "Assignment Notes", "Temp",
// "Hot/warm") are per-contact context for the SDR. Pure functions (unit-tested). Read-only.

export interface EventContext { eventId: string; date: string | null; topic: string; partner: string | null }
export interface VirtualEventsData { events: EventContext[]; notes: Array<{ eventId: string; contactId: string; note: string }>; unmatchedTabs: string[] }

const MON: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9/]+/g, " ").trim();

/** "25 Aug" / "9 Sept" / "10/29/2026" / "14 Oct - Demo Day (IHC)" -> "2026-08-25" (year defaults to `year`). */
export function parseLooseDate(s: string, year = 2026): string | null {
  const us = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (us) return `${us[3]}-${us[1]!.padStart(2, "0")}-${us[2]!.padStart(2, "0")}`;
  const m = /(\d{1,2})\s*[-–]?\s*([A-Za-z]{3,9})/.exec(s);
  if (!m) return null;
  const mo = MON[m[2]!.toLowerCase().slice(0, 3)];
  if (!mo) return null;
  const y = /\b(20\d\d)\b/.exec(s)?.[1] ?? String(year);
  return `${y}-${String(mo).padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
}

/** Topic text from the landing-page cell: collapse whitespace, drop a leading "Topic:" label. */
export function cleanTopic(s: string): string {
  return s.replace(/\s+/g, " ").replace(/\bTopic:\s*/i, "").replace(/\s+-\s*$/, "").trim();
}
const PARTNERS = ["IHC", "Legal tech hub", "Counselwell", "ITGC", "Mango cloud", "How to contract", "Sarah ouis", "Sarah Irwin", "Laura Frederick", "Linsey Olga Mack", "Astronomer"];

export function parseVirtualEvents(tabs: Array<{ title: string; rows: string[][] }>): VirtualEventsData {
  const idx = tabs.find((t) => /marketing\s*event/i.test(t.title));
  const events: EventContext[] = [];
  if (idx) {
    const hi = idx.rows.findIndex((r) => r.some((c) => /landing page/i.test(c)));
    const head = (idx.rows[hi] ?? []).map(norm);
    const cDate = head.findIndex((h) => h === "date"), cTopic = head.findIndex((h) => h.startsWith("landing page")), cEv = head.findIndex((h) => h.startsWith("marketing event"));
    for (const r of idx.rows.slice(hi + 1)) {
      const id = /record\/2-\d+\/(\d+)/.exec(r[cEv] ?? "")?.[1] ?? r.map((c) => /record\/2-\d+\/(\d+)/.exec(c)?.[1]).find(Boolean);
      if (!id) continue;
      const topic = cleanTopic(r[cTopic] ?? "");
      events.push({ eventId: id, date: parseLooseDate(r[cDate] ?? ""), topic, partner: PARTNERS.find((p) => topic.toLowerCase().includes(p.toLowerCase())) ?? null });
    }
  }
  // Per-contact comments from each event tab, matched to an index row by date (and title words when two share a date).
  const notes: VirtualEventsData["notes"] = [];
  const unmatchedTabs: string[] = [];
  for (const t of tabs) {
    if (t === idx) continue;
    const d = parseLooseDate(t.title);
    const same = events.filter((e) => e.date === d);
    const words = new Set(norm(t.title).split(" ").filter((w) => w.length > 3));
    const score = (e: EventContext) => norm(e.topic).split(" ").filter((w) => words.has(w)).length;
    const ev = same.length <= 1 ? same[0] : [...same].sort((a, b) => score(b) - score(a))[0];
    if (!ev) { unmatchedTabs.push(t.title); continue; }
    const hi = t.rows.findIndex((r) => r.some((c) => /record id\s*-\s*contact/i.test(c)));
    if (hi < 0) continue;
    const head = t.rows[hi]!.map(norm);
    const cId = head.findIndex((h) => h.startsWith("record id contact"));
    const noteCols = head.map((h, i) => ({ h: t.rows[hi]![i]!.trim(), i })).filter(({ h }) => /comment|notes?\b|^temp$|hot\s*\/\s*warm|warm\s*\/\s*cold/i.test(h));
    for (const r of t.rows.slice(hi + 1)) {
      const cid = (r[cId] ?? "").trim();
      if (!/^\d+$/.test(cid)) continue;
      const parts = noteCols.map(({ h, i }) => ({ h, v: (r[i] ?? "").trim() })).filter((p) => p.v);
      if (!parts.length) continue;
      notes.push({ eventId: ev.eventId, contactId: cid, note: parts.map((p) => (/^temp$|hot|warm/i.test(p.h) ? `${p.h}: ${p.v}` : p.v)).join(" · ").slice(0, 400) });
    }
  }
  return { events, notes, unmatchedTabs };
}
