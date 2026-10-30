// Parse the "Mastersheet Virtual Roundtable" Google Sheet. Pure functions (unit-tested).
// One tab per roundtable, titled like "Roundtable 7 (27 Oct, 2026)". Column order and header wording differ per tab
// (e.g. "Attened" in RT1, "Email ID" vs "Email", "HS" vs "HS Link"), so columns are found by header text.

export interface SheetRow { row: number; contactId: string | null; email: string | null; attended: boolean | null; name: string; company: string | null }
export interface SheetTab { title: string; number: number | null; date: string | null; rows: SheetRow[]; missingColumns: string[] }

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

/** "Roundtable 7 (27 Oct, 2026)" -> { number: 7, date: "2026-10-27" } */
export function parseTabTitle(title: string): { number: number | null; date: string | null } {
  const n = /round\s*-?\s*table\s*#?\s*(\d+)/i.exec(title);
  const d = /(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/.exec(title);
  let date: string | null = null;
  if (d) {
    const m = MONTHS[d[2]!.toLowerCase().slice(0, 4)] ?? MONTHS[d[2]!.toLowerCase().slice(0, 3)];
    if (m) date = `${d[3]}-${String(m).padStart(2, "0")}-${String(Number(d[1])).padStart(2, "0")}`;
  }
  return { number: n ? Number(n[1]) : null, date };
}

/** HubSpot contact id from a record URL (…/record/0-1/12345…) or a bare numeric id. */
export function contactIdFrom(cell: string): string | null {
  const m = /record\/0-1\/(\d+)/.exec(cell) ?? /^\s*(\d{4,})\s*$/.exec(cell);
  return m ? m[1]! : null;
}

export function parseAttended(cell: string): boolean | null {
  const v = cell.trim().toLowerCase();
  if (["yes", "y", "attended", "true", "1"].includes(v)) return true;
  if (["no", "n", "no show", "no-show", "did not attend", "false", "0"].includes(v)) return false;
  return null;
}

export function parseTab(title: string, rows: string[][]): SheetTab {
  const { number, date } = parseTabTitle(title);
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  // header = first row that has an attendance or email header
  const hi = rows.findIndex((r) => r.some((c) => /^atten/.test(norm(c)) || /\bemail\b/.test(norm(c))));
  const header = hi >= 0 ? rows[hi]!.map(norm) : [];
  const col = (test: (h: string) => boolean) => header.findIndex(test);
  const cLink = col((h) => h === "hs" || h.startsWith("hs link") || h.includes("hubspot"));
  const cAtt = col((h) => h.startsWith("atten"));
  const cEmail = col((h) => /\bemail\b/.test(h));
  const cFirst = col((h) => h === "name" || h.startsWith("first name"));
  const cLast = col((h) => h.startsWith("last name"));
  const cCompany = col((h) => h.startsWith("company name") || h === "company");
  const missingColumns = [cAtt < 0 ? "Attended" : null, cEmail < 0 && cLink < 0 ? "HS Link / Email" : null].filter((x): x is string => !!x);
  const out: SheetRow[] = [];
  if (hi >= 0) {
    rows.slice(hi + 1).forEach((r, i) => {
      const cell = (c: number) => (c >= 0 ? (r[c] ?? "").trim() : "");
      // links can also sit in any cell of the row if the link column header differs
      const contactId = contactIdFrom(cell(cLink)) ?? r.map(contactIdFrom).find((x) => !!x) ?? null;
      const email = cell(cEmail).toLowerCase() || null;
      if (!contactId && !email) return; // blank / notes row
      out.push({
        row: hi + 2 + i, contactId, email: email && email.includes("@") ? email : null,
        attended: cAtt >= 0 ? parseAttended(cell(cAtt)) : null,
        name: [cell(cFirst), cell(cLast)].filter(Boolean).join(" "), company: cell(cCompany) || null,
      });
    });
  }
  return { title, number, date, rows: out, missingColumns };
}

/** Match a tab to a HubSpot roundtable event: same roundtable number in the name, event date within ±3 days. */
export function matchEvent<E extends { id: string; name: string; event_date: string | null; category: string }>(tab: SheetTab, events: E[]): E | null {
  if (tab.number === null) return null;
  const num = (name: string) => { const m = /round\s*-?\s*table\s*#?\s*(\d+)/i.exec(name) ?? /\brt\s*-?(\d+)\b/i.exec(name); return m ? Number(m[1]) : null; };
  const near = (d: string | null) => !tab.date || !d || Math.abs(Date.parse(d) - Date.parse(tab.date)) <= 3 * 86_400_000;
  const hits = events.filter((e) => num(e.name) === tab.number && near(e.event_date));
  return hits.length === 1 ? hits[0]! : hits.find((e) => e.event_date === tab.date) ?? null;
}

export interface SheetMerge { attended: Map<string, boolean | null>; fromSheet: Set<string>; fromHubspot: Set<string> }

/**
 * Apply parsed sheet tabs to the HubSpot registrant lists (mutates `eventContacts`).
 * authoritative = true: a matched tab REPLACES that event's registrants; false: sheet rows are added.
 */
export function applySheet<E extends { id: string; name: string; event_date: string | null; category: string }>(
  tabs: SheetTab[], events: E[], eventContacts: Map<string, string[]>, byEmail: Map<string, string>, authoritative: boolean,
) {
  const merged = new Map<string, SheetMerge>();
  const report: any[] = [];
  const unmatchedTabs: string[] = [];
  let rows = 0, added = 0;
  const used = new Set<string>();
  for (const tab of tabs) {
    const ev = matchEvent(tab, events);
    if (!ev || used.has(ev.id)) { unmatchedTabs.push(tab.title); continue; }
    used.add(ev.id);
    const hubspotIds = new Set(eventContacts.get(ev.id) ?? []);
    const attended = new Map<string, boolean | null>();
    const fromSheet = new Set<string>();
    const unresolved: Array<{ row: number; name: string; email: string | null }> = [];
    for (const r of tab.rows) {
      rows++;
      const id = r.contactId ?? (r.email ? byEmail.get(r.email) ?? null : null);
      if (!id) { unresolved.push({ row: r.row, name: r.name, email: r.email }); continue; }
      fromSheet.add(id);
      const prev = attended.get(id);
      attended.set(id, prev === true || r.attended === true ? true : prev === false || r.attended === false ? false : null); // listed twice: Yes wins
    }
    // A tab with no resolvable rows never wipes out HubSpot registrants.
    if (!fromSheet.size) { unmatchedTabs.push(`${tab.title} (no rows matched to HubSpot contacts)`); continue; }
    const hubspotOnly = [...hubspotIds].filter((id) => !fromSheet.has(id));
    const sheetOnly = [...fromSheet].filter((id) => !hubspotIds.has(id));
    added += sheetOnly.length;
    const list = authoritative ? [...fromSheet] : [...new Set([...hubspotIds, ...fromSheet])];
    eventContacts.set(ev.id, list);
    merged.set(ev.id, { attended, fromSheet, fromHubspot: hubspotIds });
    report.push({
      tab: tab.title, eventId: ev.id, eventName: ev.name, eventDate: ev.event_date, sheetRows: tab.rows.length, registrants: list.length,
      attendedYes: [...attended.values()].filter((v) => v === true).length, attendedNo: [...attended.values()].filter((v) => v === false).length,
      attendedBlank: [...attended.values()].filter((v) => v === null).length,
      sheetOnly: sheetOnly.length, hubspotOnly: hubspotOnly.length, hubspotOnlyIds: hubspotOnly.slice(0, 200),
      unresolved, missingColumns: tab.missingColumns,
    });
  }
  return { merged, report, unmatchedTabs, rows, added };
}
