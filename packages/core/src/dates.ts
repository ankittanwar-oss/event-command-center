// Date helpers. All business logic works on calendar dates (YYYY-MM-DD) in UTC to avoid DST drift.

export const DAY_MS = 86_400_000;

export function toDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{10,14}$/.test(s)) return new Date(Number(s)).toISOString().slice(0, 10);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function parseDay(day: string): number {
  return Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
}

export function formatDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  return formatDay(parseDay(day) + n * DAY_MS);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((parseDay(to) - parseDay(from)) / DAY_MS);
}

export function maxDay(...days: Array<string | null | undefined>): string | null {
  const v = days.filter((d): d is string => !!d).sort();
  return v.length ? v[v.length - 1]! : null;
}

/** ISO week key (YYYY-Www) used to count distinct outreach weeks. */
export function isoWeek(day: string): string {
  const t = parseDay(day);
  const d = new Date(t);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  const thursday = t + (3 - dow) * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  const jan4 = Date.UTC(year, 0, 4);
  const jan4dow = (new Date(jan4).getUTCDay() + 6) % 7;
  const week1Monday = jan4 - jan4dow * DAY_MS;
  const week = Math.floor((thursday - week1Monday) / (7 * DAY_MS)) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export interface BusinessCalendar {
  weekendDays: number[];
  holidays: string[];
}

export function isBusinessDay(day: string, cal: BusinessCalendar): boolean {
  const dow = new Date(parseDay(day)).getUTCDay();
  return !cal.weekendDays.includes(dow) && !cal.holidays.includes(day);
}

/**
 * Number of business days AFTER `from` up to and including `to`. Same day = 0.
 * Friday -> Monday = 1, so "within 3 business days" means businessDaysBetween(...) <= 3.
 */
export function businessDaysBetween(from: string, to: string, cal: BusinessCalendar): number {
  if (to <= from) return 0;
  let n = 0;
  let cur = parseDay(from) + DAY_MS;
  const end = parseDay(to);
  while (cur <= end) {
    if (isBusinessDay(formatDay(cur), cal)) n++;
    cur += DAY_MS;
  }
  return n;
}

// ---------------------------------------------------------------------------------------------------------------
// SpotDraft fiscal calendar: the fiscal year starts on 1 May.
//   Q1 (MJJ) May–Jul, Q2 (ASO) Aug–Oct, Q3 (NDJ) Nov–Jan, Q4 (FMA) Feb–Apr.
// A fiscal year is named after the calendar year in which it ENDS (FY2027 = 1 May 2026 – 30 Apr 2027).
// ---------------------------------------------------------------------------------------------------------------

export interface FiscalQuarter {
  key: string;        // "FY2027-Q2"
  fiscalYear: number; // 2027
  quarter: 1 | 2 | 3 | 4;
  label: string;      // "Q2 FY27 (ASO)"
  start: string;      // inclusive
  end: string;        // inclusive
}

const QUARTER_CODES = ["MJJ", "ASO", "NDJ", "FMA"] as const;

export function fiscalQuarterOf(day: string): FiscalQuarter {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7)); // 1-12
  const fyStartYear = m >= 5 ? y : y - 1;
  const monthsIntoFy = (m - 5 + 12) % 12; // May=0
  const q = (Math.floor(monthsIntoFy / 3) + 1) as 1 | 2 | 3 | 4;
  return buildQuarter(fyStartYear + 1, q);
}

export function buildQuarter(fiscalYear: number, q: 1 | 2 | 3 | 4): FiscalQuarter {
  const fyStartYear = fiscalYear - 1;
  const startMonthIndex = 4 + (q - 1) * 3; // 0-based month, May = 4
  const start = Date.UTC(fyStartYear, startMonthIndex, 1);
  const end = Date.UTC(fyStartYear, startMonthIndex + 3, 1) - DAY_MS;
  const mon = (ms: number) => new Date(ms).toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const sy = new Date(start).getUTCFullYear();
  const ey = new Date(end).getUTCFullYear();
  const range = sy === ey ? `${mon(start)}–${mon(end)} ${sy}` : `${mon(start)} ${sy}–${mon(end)} ${ey}`;
  return {
    key: `FY${fiscalYear}-Q${q}`,
    fiscalYear,
    quarter: q,
    // The month range is always shown so the label is unambiguous regardless of fiscal-year naming convention.
    label: `Q${q} ${QUARTER_CODES[q - 1]} · ${range}`,
    start: formatDay(start),
    end: formatDay(end),
  };
}

export function parseQuarterKey(key: string): FiscalQuarter | null {
  const m = /^FY(\d{4})-Q([1-4])$/.exec(key);
  return m ? buildQuarter(Number(m[1]), Number(m[2]) as 1 | 2 | 3 | 4) : null;
}

export function previousQuarter(q: FiscalQuarter): FiscalQuarter {
  return q.quarter === 1 ? buildQuarter(q.fiscalYear - 1, 4) : buildQuarter(q.fiscalYear, (q.quarter - 1) as 1 | 2 | 3);
}

export function quarterIsComplete(q: FiscalQuarter, today: string): boolean {
  return today > q.end;
}

export function quartersBetween(fromDay: string, toDay: string): FiscalQuarter[] {
  const out: FiscalQuarter[] = [];
  let q = fiscalQuarterOf(toDay);
  const first = fiscalQuarterOf(fromDay).key;
  for (let i = 0; i < 40; i++) {
    out.push(q);
    if (q.key === first) break;
    q = previousQuarter(q);
  }
  return out;
}
