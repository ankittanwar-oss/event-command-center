import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { computeLeadFacts, DEFAULT_RULES } from "@ecc/core";
import { applySheet, contactIdFrom, matchEvent, parseAttended, parseTab, parseTabTitle } from "../src/sheets/roundtables.js";
import { parseServiceAccount, signedAssertion } from "../src/sheets/google.js";
import { contact, dataset, event } from "../../../packages/core/test/fixtures.js";

// Header rows and sample rows exactly as they appear in "Mastersheet Virtual Roundtable" (30 Oct 2026)
const RT1 = [
  ["HS Link", "Attened ", "Name", "Last Name", "Email ID", "Company", "SDR Owner", "Company Owner", "ICP Category", "Lifecycle Stage", "Country"],
  ["https://app.hubspot.com/contacts/7712708/record/0-1/16220006", "No", "Tracy", "Kane", "tkane@endeavorbusinessmedia.com", "Endeavor Business Media", "Bobbi Bukovac", "Marshall Deutz", "Tier 1a", "Discovery", "United States"],
  ["https://app.hubspot.com/contacts/7712708/record/0-1/159539601047", "Yes", "Susan", "Sher", "susan.sher@faire.com", "Faire", "Bobbi Bukovac", "Elizabeth Doolittle", "Tier 1a", "Discovery", "United States"],
];
const RT4 = [
  ["HS", "Attended", "First Name", "Last Name", "Email", "Job Title", "Company name", "Notes", "SDR Owner (Company)", "Company owner", "Country/Region", "ICP Category 2.0", "Lifecycle Stage"],
  ["https://app.hubspot.com/contacts/7712708/record/0-1/4559846", "Yes", "Richard", "Sedory", "rsedory@wastequip.com", "CLO", "Wastequip, LLC", "", "Bobbi Bukovac", "Allison Green", "United States", "Targetable - Tier 2", "Discovery"],
  ["", "No", "No", "Link", "nolink@example.com", "", "Example", "", "", "", "", "", ""],
  ["", "", "", "", "", "", "", "a notes-only row", "", "", "", "", ""],
];
const RT6 = [ // Email is column F here (after Job Title)
  ["HS Link", "Attended", "First Name", "Last Name", "Job Title", "Email", "Company Name", "ICP Category 2.0", "Lifecycle Stage (Custom) (From Company)", "Company owner", "Company SDR owner", "Country/Region"],
  ["https://app.hubspot.com/contacts/7712708/record/0-1/161955757491", "Yes", "Joy", "Atkinson", "CLO", "jatkinson@minolusa.com", "Minol USA", "Targetable - Tier 2", "Discovery", "Elizabeth Doolittle", "Bobbi Bukovac", "United States"],
];
const RT7 = [
  ["HS Link", "Attended", "First name", "Last Name", "Email ID", "Job Title", "Person LI", "Company Name", "Company Owner", "SDR Owner", "Lifecycle Stage", "ICP 2.0", "Incumbent CLM"],
  ["https://app.hubspot.com/contacts/7712708/record/0-1/196306361696", "Yes", "Jane", "Jue", "jjue@omnissa.com", "Director", "http://www.linkedin.com/in/jane-j-25680541", "Omnissa", "Allison Green", "Bobbi Bukovac", "Discovery", "Targetable - Tier 1A", ""],
  ["https://app.hubspot.com/contacts/7712708/record/0-1/183300912042?eschref=%2Fsearch%2F7712708", "No", "Belinda", "luu", "belinda.luu@kp.org", "", "", "KP", "", "", "", "", ""],
];
const HUBSPOT_EVENTS = [ // names/dates as in HubSpot
  { id: "59457298588", name: "Round Table 1 : You Have a CLM. What Next? | July 15", event_date: "2026-07-15", category: "roundtable" },
  { id: "60804401033", name: "Round Table 4 : AI Governance Is a Contract Problem | Aug 26", event_date: "2026-08-26", category: "roundtable" },
  { id: "62799828053", name: "Round Table 6 : Should Legal Own Every Contract? | 29 Sep", event_date: "2026-09-29", category: "roundtable" },
  { id: "65050806052", name: "Round Table 7 : The Contracts That Haunt Legal | 27 Oct 2026", event_date: "2026-10-27", category: "roundtable" },
  { id: "x", name: "IHC Webinar : What Actually Speeds Up Contracting?", event_date: "2026-07-22", category: "webinar" },
];

describe("roundtable sheet parsing", () => {
  test("tab titles", () => {
    assert.deepEqual(parseTabTitle("Roundtable 1 (15 July, 2026)"), { number: 1, date: "2026-07-15" });
    assert.deepEqual(parseTabTitle("Roundtable 4 (26 August, 2026)"), { number: 4, date: "2026-08-26" });
    assert.deepEqual(parseTabTitle("Roundtable 5 (16 Sept, 2026)"), { number: 5, date: "2026-09-16" });
    assert.deepEqual(parseTabTitle("Roundtable 7 (27 Oct, 2026)"), { number: 7, date: "2026-10-27" });
  });
  test("contact ids and attendance values", () => {
    assert.equal(contactIdFrom("https://app.hubspot.com/contacts/7712708/record/0-1/183300912042?eschref=x"), "183300912042");
    assert.equal(contactIdFrom("https://www.linkedin.com/in/jane"), null);
    assert.equal(parseAttended("Yes"), true);
    assert.equal(parseAttended(" no "), false);
    assert.equal(parseAttended(""), null);
  });
  test("different column layouts per tab, including the 'Attened' typo and Email in column F", () => {
    const t1 = parseTab("Roundtable 1 (15 July, 2026)", RT1);
    assert.equal(t1.rows.length, 2);
    assert.deepEqual(t1.rows.map((r) => [r.contactId, r.attended, r.email]), [["16220006", false, "tkane@endeavorbusinessmedia.com"], ["159539601047", true, "susan.sher@faire.com"]]);
    const t4 = parseTab("Roundtable 4 (26 August, 2026)", RT4);
    assert.equal(t4.rows.length, 2); // notes-only row skipped
    assert.equal(t4.rows[1]!.contactId, null);
    assert.equal(t4.rows[1]!.email, "nolink@example.com");
    const t6 = parseTab("Roundtable 6 (29 Sept, 2026)", RT6);
    assert.equal(t6.rows[0]!.email, "jatkinson@minolusa.com");
    assert.equal(t6.rows[0]!.contactId, "161955757491");
    assert.deepEqual(t6.missingColumns, []);
  });
  test("tabs match HubSpot roundtables by number and date (never a webinar)", () => {
    assert.equal(matchEvent(parseTab("Roundtable 7 (27 Oct, 2026)", RT7), HUBSPOT_EVENTS)!.id, "65050806052");
    assert.equal(matchEvent(parseTab("Roundtable 1 (15 July, 2026)", RT1), HUBSPOT_EVENTS)!.id, "59457298588");
    assert.equal(matchEvent(parseTab("Roundtable 9 (1 Dec, 2026)", RT1), HUBSPOT_EVENTS), null);
    assert.equal(matchEvent(parseTab("Roundtable 7 (27 Nov, 2026)", RT7), HUBSPOT_EVENTS), null); // date too far
  });
});

describe("applying the sheet", () => {
  const tabs = () => [parseTab("Roundtable 7 (27 Oct, 2026)", RT7), parseTab("Roundtable 4 (26 August, 2026)", RT4)];
  test("authoritative: the sheet replaces the registrant list; email lookup fills missing links; report reconciles", () => {
    const ec = new Map<string, string[]>([["65050806052", ["196306361696", "999"]], ["60804401033", ["4559846"]]]);
    const r = applySheet(tabs(), HUBSPOT_EVENTS, ec, new Map([["nolink@example.com", "777"]]), true);
    assert.deepEqual(ec.get("65050806052")!.sort(), ["183300912042", "196306361696"]);
    assert.deepEqual(ec.get("60804401033")!.sort(), ["4559846", "777"]);
    const rt7 = r.report.find((t: any) => t.eventId === "65050806052");
    assert.equal(rt7.hubspotOnly, 1);   // contact 999 was only in HubSpot
    assert.equal(rt7.sheetOnly, 1);     // Belinda was only in the sheet
    assert.equal(rt7.attendedYes, 1);
    assert.equal(rt7.attendedNo, 1);
    assert.equal(r.merged.get("65050806052")!.attended.get("196306361696"), true);
  });
  test("non-authoritative: sheet rows are added, nobody removed", () => {
    const ec = new Map<string, string[]>([["65050806052", ["196306361696", "999"]]]);
    applySheet(tabs(), HUBSPOT_EVENTS, ec, new Map(), false);
    assert.deepEqual(ec.get("65050806052")!.sort(), ["183300912042", "196306361696", "999"]);
  });
  test("a tab where nothing resolves never wipes HubSpot registrants", () => {
    const ec = new Map<string, string[]>([["65050806052", ["1", "2"]]]);
    const r = applySheet([parseTab("Roundtable 7 (27 Oct, 2026)", [RT7[0]!, ["", "Yes", "A", "B", "unknown@x.com"]])], HUBSPOT_EVENTS, ec, new Map(), true);
    assert.deepEqual(ec.get("65050806052"), ["1", "2"]);
    assert.equal(r.report.length, 0);
  });
  test("sheet attendance overrides HubSpot attendance in the lead facts", () => {
    const ev = event({ category: "roundtable" });
    const yes = computeLeadFacts({ ...dataset({ events: [ev], contacts: [contact({ attendedDate: null })] }), eventContacts: [{ eventId: "e1", contactId: "c1", attendedAt: null, sheetAttended: true }] }, DEFAULT_RULES, "2026-10-30")[0]!;
    assert.equal(yes.attendance, "attended");
    const no = computeLeadFacts({ ...dataset({ events: [ev], contacts: [contact({ attendedDate: "2026-10-01" })] }), eventContacts: [{ eventId: "e1", contactId: "c1", attendedAt: "2026-10-01", sheetAttended: false }] }, DEFAULT_RULES, "2026-10-30")[0]!;
    assert.equal(no.attendance, "no_show");
  });
});

describe("Google service account auth", () => {
  test("produces a correctly signed RS256 JWT; rejects bad JSON clearly", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const sa = parseServiceAccount(JSON.stringify({ client_email: "ecc@proj.iam.gserviceaccount.com", private_key: pem.replace(/\n/g, "\\n") }));
    const jwt = signedAssertion(sa, 1_800_000_000);
    const [h, c, sig] = jwt.split(".");
    const v = createVerify("RSA-SHA256"); v.update(`${h}.${c}`);
    assert.ok(v.verify(publicKey, Buffer.from(sig!.replace(/-/g, "+").replace(/_/g, "/"), "base64")));
    const claims = JSON.parse(Buffer.from(c!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
    assert.equal(claims.scope, "https://www.googleapis.com/auth/spreadsheets.readonly");
    assert.equal(claims.iss, "ecc@proj.iam.gserviceaccount.com");
    assert.throws(() => parseServiceAccount("not json"), /not valid JSON/);
    assert.throws(() => parseServiceAccount("{}"), /client_email/);
  });
});
