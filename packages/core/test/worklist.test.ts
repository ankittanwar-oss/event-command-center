import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { computeLeadFacts, leadDimensions, leadWork, riskOf, worklist } from "../src/index.js";
import { act, AE, BOBBI, company, contact, dataset, deal, DISHA, event, rules } from "./fixtures.js";

const R = rules();
const T = "2026-10-30"; // Friday
const one = (ds: any, r = R, today = T) => leadWork(computeLeadFacts(ds, r, today)[0]!, today, r);

describe("daily worklist", () => {
  test("never worked past the first-touch SLA -> overdue first outreach with business days overdue", () => {
    const w = one(dataset());
    assert.equal(w.section, "overdue"); assert.equal(w.action, "Send first outreach");
    assert.equal(w.due, "2026-10-06"); assert.ok((w.overdueBusinessDays ?? 0) > 0);
  });
  test("first outreach due today", () => {
    const w = one(dataset({ events: [event({ date: "2026-10-27" })] }));
    assert.equal(w.section, "today"); assert.equal(w.due, T);
  });
  test("prospect reply with no answer -> respond; an AE answer after the reply clears it", () => {
    const reply = act({ ts: "2026-10-28", kind: "INCOMING_EMAIL", direction: "INCOMING_EMAIL", ownerId: null });
    assert.equal(one(dataset({ acts: [act({ ts: "2026-10-05" }), reply] })).section, "respond");
    const w = one(dataset({ acts: [act({ ts: "2026-10-05" }), reply, act({ ts: "2026-10-29", ownerId: AE })] }));
    assert.notEqual(w.section, "respond");
  });
  test("open opportunity -> monitor, but an SDR task with a due date still drives the action", () => {
    assert.equal(one(dataset({ deals: [deal()] })).section, "monitor");
    const ds = dataset({ deals: [deal()], tasks: [{ id: "t1", dueDate: "2026-10-30T10:00:00Z", status: "NOT_STARTED", taskType: "EMAIL", ownerId: BOBBI, subject: "Send deck", contactIds: ["c1"] }] });
    const w = one(ds);
    assert.equal(w.section, "today"); assert.equal(w.action, "Complete HubSpot task");
  });
  test("after first outreach there is no follow-up deadline: informational only, never overdue", () => {
    const w = one(dataset({ acts: [act({ ts: "2026-10-27" })] }));
    assert.equal(w.action, "Follow-up opportunity"); assert.equal(w.due, null); assert.equal(w.overdueBusinessDays, null);
    const old = one(dataset({ acts: [act({ ts: "2026-10-02" })] }));
    assert.notEqual(old.section, "overdue"); assert.equal(old.due, null);
  });
  test("an open deal WITHOUT a Became Qualified to Buy Date never takes the lead out of SDR follow-up", () => {
    const acctDeal = computeLeadFacts(dataset({ acts: [act({ ts: "2026-10-02" })], deals: [deal({ contactIds: [], sqlDate: null, stageLabel: "Discovery" })] }), R, T)[0]!;
    assert.notEqual(acctDeal.status, "in_play");
    assert.notEqual(leadDimensions(acctDeal, T, R).health, "on_track");
    const contactDeal = computeLeadFacts(dataset({ acts: [act({ ts: "2026-10-02" })], deals: [deal()] }), R, T)[0]!;
    assert.equal(riskOf(contactDeal, R)?.level, "healthy");
  });
  test("SLA, depth and follow-up are independent: one on-time touch has no follow-up deadline", () => {
    const f = computeLeadFacts(dataset({ acts: [act({ ts: "2026-10-02" })] }), R, T)[0]!;
    const d = leadDimensions(f, T, R);
    assert.equal(d.sla, "First-touch SLA met"); assert.equal(d.depth, "1");
    assert.match(d.followUp!, /no deadline/); assert.match(d.cadence!, /recommended/);
  });
  test("reassigned account: previous SDR touches kept as context, not credited; SLA runs from allocation", () => {
    const ds = dataset({ companies: [company({ allocationDate: "2026-10-26" })], acts: [act({ ts: "2026-10-05", ownerId: DISHA })] });
    const f = computeLeadFacts(ds, R, T)[0]!;
    assert.equal(f.currentSdrTouches, 0); assert.equal(f.otherSdrTouches, 1);
    const w = leadWork(f, T, R);
    assert.equal(w.action, "Send first outreach"); assert.equal(w.due, "2026-10-29");
  });
  test("eligible before the SLA start -> needs review, never invented as overdue", () => {
    const r = rules({ slaStartDate: "2026-10-30" });
    const w = one(dataset(), r);
    assert.equal(w.section, "monitor"); assert.equal(w.action, "Needs review"); assert.equal(w.due, null);
  });
  test("one row per account and every eligible account in exactly one section", () => {
    const ds = dataset({
      companies: [company(), company({ id: "co2", temperatureRaw: "Warm" })],
      contacts: [contact(), contact({ id: "c2" }), contact({ id: "c3", companyId: "co2" })],
      links: [["e1", "c1"], ["e1", "c2"], ["e1", "c3"]],
    });
    const facts = computeLeadFacts(ds, R, T);
    const wl = worklist(facts, T, R);
    assert.equal(wl.items.length, 2);
    assert.equal(Object.values(wl.counts).reduce((a, b) => a + b, 0), wl.items.length);
  });
});

test("SLA start date affects only the first-touch SLA; worked leads carry no follow-up risk", () => {
  const r = rules({ slaStartDate: "2026-10-30" });
  const f = computeLeadFacts(dataset({ acts: [act({ ts: "2026-10-26" })] }), r, T)[0]!;
  assert.equal(f.firstTouchSlaMet, null);
  assert.equal(riskOf(f, r)?.level, "neutral");
});

describe("14-business-day inactivity", () => {
  test("touched: counts from the last touch; never touched: from eligibility; not an SLA", async () => {
    const { inactivity } = await import("../src/index.js");
    const f = computeLeadFacts(dataset({ acts: [act({ ts: "2026-10-05" })] }), R, T)[0]!;
    const ia = inactivity(f, T, R);
    assert.equal(ia.since, "2026-10-05"); assert.equal(ia.stale, true); assert.equal(ia.kind, "sdr_action");
    const n = computeLeadFacts(dataset({ events: [event({ date: "2026-10-20" })] }), R, T)[0]!;
    assert.equal(inactivity(n, T, R).stale, false);
    const opp = computeLeadFacts(dataset({ acts: [act({ ts: "2026-10-05" })], deals: [deal()] }), R, T)[0]!;
    assert.equal(inactivity(opp, T, R).kind, "ae_or_pause");
  });
  test("overdue source is named; only tasks, replies and the first-touch SLA can be overdue", async () => {
    const { overdueSource } = await import("../src/index.js");
    const c = leadWork(computeLeadFacts(dataset({ acts: [act({ ts: "2026-10-05" })] }), R, T)[0]!, T, R);
    assert.equal(overdueSource(c), null);
    const ds = dataset({ acts: [act({ ts: "2026-10-26" })], tasks: [{ id: "t", dueDate: "2026-10-26T00:00:00Z", status: "NOT_STARTED", taskType: "CALL", ownerId: BOBBI, subject: "Call", contactIds: ["c1"] }] });
    assert.equal(overdueSource(leadWork(computeLeadFacts(ds, R, T)[0]!, T, R))!.label, "HubSpot task overdue by 4 business days");
  });
});

test("a HubSpot task due today is the primary action even with an account-level open deal", async () => {
  const { actionStatus } = await import("../src/index.js");
  const ds = dataset({ acts: [act({ ts: "2026-10-26" })], deals: [deal({ contactIds: [] })],
    tasks: [{ id: "t", dueDate: "2026-10-30T09:00:00Z", status: "NOT_STARTED", taskType: "CALL", ownerId: BOBBI, subject: "Call back", contactIds: ["c1"] }] });
  const a = actionStatus(computeLeadFacts(ds, R, T)[0]!, T, R);
  assert.equal(a.label, "HubSpot task due today"); assert.equal(a.color, "amber");
  assert.deepEqual(a.secondary, ["Open deal on company"]);
  const noTask = actionStatus(computeLeadFacts(dataset({ acts: [act({ ts: "2026-10-26" })], deals: [deal({ contactIds: [], sqlDate: null })] }), R, T)[0]!, T, R);
  assert.doesNotMatch(noTask.label, /In conversation|Review/); assert.deepEqual(noTask.secondary, ["Open deal on company"]);
});

test("current SDR's own touches before a later allocation date count; another SDR's do not", () => {
  // event Oct 1, allocation stamped Oct 27; Bobbi (current SDR) emailed Oct 21, Disha emailed Oct 20
  const ds = dataset({ companies: [company({ allocationDate: "2026-10-27" })], acts: [act({ ts: "2026-10-21" }), act({ ts: "2026-10-20", ownerId: DISHA })] });
  const f = computeLeadFacts(ds, R, T)[0]!;
  assert.equal(f.eligibilityDate, "2026-10-27");
  assert.equal(f.touchesSinceEligibility, 1);
  assert.equal(f.status === "never_worked", false);
  assert.equal(f.firstTouchSlaMet, true);
});

describe("contact worklist", () => {
  test("one row per contact; touches are distinct activities; groups are exclusive", async () => {
    const { contactWorklist } = await import("../src/index.js");
    const ds = dataset({ events: [event(), event({ id: "e2", date: "2026-10-05" })], links: [["e1", "c1"], ["e2", "c1"]], acts: [act({ ts: "2026-10-27" })] });
    const wl = contactWorklist(computeLeadFacts(ds, R, T), T, R);
    assert.equal(wl.items.length, 1);
    assert.equal(wl.items[0]!.sdrTouchesAny, 1);
    assert.equal(wl.items[0]!.events.length, 2);
    assert.equal(Object.values(wl.counts).reduce((a, b) => a + b, 0), 1);
  });
  test("your touches include the SDR's own work before a later allocation date, never another rep's", async () => {
    const { contactWorklist } = await import("../src/index.js");
    const ds = dataset({ companies: [company({ allocationDate: "2026-10-27" })], acts: [act({ ts: "2026-10-13" }), act({ ts: "2026-10-12", ownerId: DISHA })] });
    const i = contactWorklist(computeLeadFacts(ds, R, T), T, R).items[0]!;
    assert.equal(i.yourTouches, 1); assert.equal(i.otherSdrTouches, 1); assert.notEqual(i.action, "Send first outreach"); assert.equal(i.yourTouchesSinceAllocation, 0);
  });
  test("open deal WITHOUT SQL date: untouched -> First outreach, touched -> Follow up; SQL date -> Qualified", async () => {
    const { contactAction } = await import("../src/index.js");
    const pre = { contactIds: [], sqlDate: null, stageLabel: "Discovery" };
    const a = contactAction(computeLeadFacts(dataset({ deals: [deal(pre)] }), R, T)[0]!, T, R);
    assert.equal(a.group, "first_outreach"); assert.equal(a.action, "Send first outreach");
    const b = contactAction(computeLeadFacts(dataset({ deals: [deal(pre)], acts: [act({ ts: "2026-10-05" })] }), R, T)[0]!, T, R);
    assert.equal(b.group, "follow_up");
    const q = contactAction(computeLeadFacts(dataset({ deals: [deal({ contactIds: [], sqlDate: "2026-10-12" })] }), R, T)[0]!, T, R);
    assert.equal(q.group, "qualified"); assert.equal(q.color, "green");
    const t = contactAction(computeLeadFacts(dataset({ deals: [deal(pre)], tasks: [{ id: "t", dueDate: "2026-10-30T10:00:00Z", status: "NOT_STARTED", taskType: "CALL", ownerId: BOBBI, subject: "Call", contactIds: ["c1"] }] }), R, T)[0]!, T, R);
    assert.equal(t.group, "respond"); assert.equal(t.color, "amber");
  });
  test("a closed qualified (historical) deal does not suppress a new event lead", async () => {
    const { contactAction } = await import("../src/index.js");
    const a = contactAction(computeLeadFacts(dataset({ deals: [deal({ isClosed: true, isWon: false, sqlDate: "2025-03-01", closeDate: "2025-06-01" } as any)] }), R, T)[0]!, T, R);
    assert.equal(a.group, "first_outreach");
  });
  test("sponsored attendance is not verified engagement", async () => {
    const { engagementReason } = await import("../src/index.js");
    const f = computeLeadFacts(dataset({ events: [event({ category: "sponsored", name: "ACC EVENT 2026" })], links: [["e1", "c1", "2026-10-01"]] }), R, T)[0]!;
    assert.match(engagementReason(f).text, /unverified/);
  });
  test("zero touches with no SLA deadline is grey, not red", async () => {
    const { contactAction } = await import("../src/index.js");
    const a = contactAction(computeLeadFacts(dataset(), rules({ slaStartDate: "2026-10-30" }), T)[0]!, T, rules({ slaStartDate: "2026-10-30" }));
    assert.equal(a.group, "first_outreach"); assert.equal(a.color, "grey");
  });
});

test("auto-replies are not prospect replies", () => {
  const ds = dataset({ acts: [act({ ts: "2026-10-27T16:20:31Z" }), act({ ts: "2026-10-27T16:20:45Z", kind: "INCOMING_EMAIL", direction: "INCOMING_EMAIL", title: "Automatic reply: Invitation to Beacon Event" })] });
  const f = computeLeadFacts(ds, R, T)[0]!;
  assert.equal(f.lastReplyAt, null); assert.notEqual(f.status, "in_play");
});

describe("conversation recency, account intent and stale snapshots", () => {
  const NOV = "2026-11-03";
  test("Bhavna case: 2025 meeting + Discovery deal without SQL + 0 touches -> First outreach, not In conversation", async () => {
    const { contactAction } = await import("../src/index.js");
    const ds = dataset({ events: [event({ date: "2026-08-12" })], companies: [company({ allocationDate: "2026-10-27" })],
      acts: [act({ ts: "2025-03-03", kind: "MEETING", objectType: "meetings", direction: null, ownerId: AE })],
      deals: [deal({ contactIds: [], sqlDate: null, stageLabel: "Discovery" })] });
    const f = computeLeadFacts(ds, R, NOV)[0]!;
    assert.notEqual(f.status, "in_play");
    const a = contactAction(f, NOV, R);
    assert.equal(a.group, "first_outreach"); assert.notEqual(a.action, "In conversation");
  });
  test("old reply is history; recent reply needs a response; future meeting is in conversation", async () => {
    const { contactAction } = await import("../src/index.js");
    const old = computeLeadFacts(dataset({ acts: [act({ ts: "2026-10-02" }), act({ ts: "2026-10-03", kind: "INCOMING_EMAIL", direction: "INCOMING_EMAIL", title: "Re: hi" })] }), R, NOV)[0]!;
    assert.notEqual(contactAction(old, NOV, R).group, "respond");
    const recent = computeLeadFacts(dataset({ acts: [act({ ts: "2026-10-28" }), act({ ts: "2026-10-30", kind: "INCOMING_EMAIL", direction: "INCOMING_EMAIL", title: "Re: hi" })] }), R, NOV)[0]!;
    assert.equal(contactAction(recent, NOV, R).group, "respond");
    const fut = computeLeadFacts(dataset({ acts: [act({ ts: "2026-10-28" }), act({ ts: "2026-11-10", kind: "MEETING", objectType: "meetings", direction: null })] }), R, NOV)[0]!;
    assert.equal(contactAction(fut, NOV, R).action, "In conversation");
  });
  test("a stale snapshot that says 'in play' because of an unqualified deal is re-evaluated", async () => {
    const { contactAction } = await import("../src/index.js");
    const f = { ...computeLeadFacts(dataset(), R, NOV)[0]!, status: "in_play", inPlayReason: "Open opportunity: X (Discovery)" } as any;
    assert.equal(contactAction(f, NOV, R).group, "first_outreach");
  });
  test("company intent drives priority: Cold + no engagement -> Lower priority; Warm -> First outreach", async () => {
    const { contactAction } = await import("../src/index.js");
    const base = computeLeadFacts(dataset(), rules({ slaStartDate: "2026-11-01" }), NOV)[0]!;
    const intent = (level: string) => ({ level, raw: `${level} Account`, since: "2026-03-20", warmAt: null, surgingAt: null, coldAt: null, reason: null, recentSignals: null });
    assert.equal(contactAction({ ...base, accountIntent: intent("Cold") }, NOV, R).group, "low");
    const w = contactAction({ ...base, accountIntent: intent("Warm") }, NOV, R);
    assert.equal(w.group, "first_outreach"); assert.equal(w.color, "amber");
    assert.equal(contactAction({ ...base, accountIntent: null }, NOV, R).group, "first_outreach"); // unknown is not penalised
  });
});

describe("account-first execution and dispositions", () => {
  const NOV = "2026-11-03";
  const mixed = () => dataset({
    contacts: [contact(), contact({ id: "c2" }), contact({ id: "c3" }), contact({ id: "c4" })],
    links: [["e1", "c1"], ["e1", "c2"], ["e1", "c3"], ["e1", "c4"]],
    acts: [act({ ts: "2026-10-30" }), act({ ts: "2026-10-05", contactIds: ["c3"] }), act({ ts: "2026-10-06", contactIds: ["c4"] })],
  });
  test("one worked contact makes the account worked; untouched contacts are optional multithreading", async () => {
    const { contactWorklist, accountWorklist, emptyDispositions } = await import("../src/index.js");
    const disp = emptyDispositions();
    disp.contact.set("c4", { scope: "contact", id: "c4", code: "competitor_satisfied", reason: "Uses Ironclad", evidence: "reply", revisitDate: null, confirmedBy: "Bobbi", confirmedAt: null, source: "dashboard" });
    const items = contactWorklist(computeLeadFacts(mixed(), R, NOV), NOV, R, disp).items;
    const [a] = accountWorklist(items);
    assert.equal(a!.worked, true);
    assert.equal(a!.coverage.available, 4); assert.equal(a!.coverage.worked, 3); assert.equal(a!.coverage.paused, 1);
    assert.notEqual(a!.bucket, "first_outreach");
    assert.equal(a!.bucket, "follow_up"); // c3 is overdue for follow-up
    const c2 = a!.contacts.find((c: any) => c.contactId === "c2")! as any;
    assert.ok(c2.multithread || c2.group === "review"); // untouched stakeholder: never makes the account "first outreach"
    assert.equal(a!.companyDisposition, null); // a contact disposition never closes the account
  });
  test("a company-wide disposition pauses the account but a reply still surfaces", async () => {
    const { contactWorklist, accountWorklist, emptyDispositions } = await import("../src/index.js");
    const disp = emptyDispositions();
    disp.company.set("co1", { scope: "company", id: "co1", code: "no_current_need", reason: "No CLM project this year", evidence: "call", revisitDate: "2027-03-01", confirmedBy: "Bobbi", confirmedAt: null, source: "dashboard" });
    assert.equal(accountWorklist(contactWorklist(computeLeadFacts(mixed(), R, NOV), NOV, R, disp).items)[0]!.bucket, "paused");
  });
  test("structured HubSpot Lead Status establishes a contact disposition without confirmation", async () => {
    const { contactAction } = await import("../src/index.js");
    const f = computeLeadFacts(dataset({ contacts: [contact({ leadStatus: "NOT_INTERESTED" })], acts: [act({ ts: "2026-10-02" })] }), R, NOV)[0]!;
    const a = contactAction(f, NOV, R);
    assert.equal(a.group, "paused"); assert.match(a.reason, /from HubSpot/);
  });
});

test("Zest AI / Michelle Chen pattern: pre-allocation touches are 'since the event', not 'since eligibility'; disposition stops cadence alerts", async () => {
  const { contactAction, contactWorklist, accountWorklist, emptyDispositions } = await import("../src/index.js");
  const NOV = "2026-11-03";
  // Roundtable 26 Aug; company allocated to Bobbi 29 Oct; Bobbi emailed 27 & 28 Aug; Michelle replied 27 Aug (competitor).
  const ds = dataset({ events: [event({ date: "2026-08-26" })], companies: [company({ allocationDate: "2026-10-29", temperatureRaw: "Warm" })],
    acts: [act({ ts: "2026-08-27T20:48:35Z" }), act({ ts: "2026-08-27T23:26:39Z", kind: "INCOMING_EMAIL", direction: "INCOMING_EMAIL", title: "Re: Great having you at yesterday's roundtable" }), act({ ts: "2026-08-28T16:44:29Z" })] });
  const f = computeLeadFacts(ds, R, NOV)[0]!;
  assert.equal(f.eligibilityDate, "2026-10-29");
  assert.equal(f.currentSdrTouches, 2); assert.equal(f.currentSdrTouchesSinceAllocation, 0);
  assert.equal(contactAction(f, NOV, R).group, "follow_up");               // without a disposition: follow-up is due
  const disp = emptyDispositions();
  disp.contact.set("c1", { scope: "contact", id: "c1", code: "competitor_satisfied", reason: "Uses Ironclad", evidence: "Email reply 27 Aug 2026", revisitDate: null, confirmedBy: "Bobbi", confirmedAt: null, source: "dashboard" });
  const a = contactAction(f, NOV, R, disp);
  assert.equal(a.group, "paused"); assert.equal(a.overdueBusinessDays, null);
  const acc = accountWorklist(contactWorklist([f], NOV, R, disp).items)[0]!;
  assert.equal(acc.worked, true); assert.equal(acc.bucket, "paused"); assert.equal(acc.companyDisposition, null);
});

describe("cadence deadlines restart from the latest qualifying touch", () => {
  const NOV = "2026-11-03";
  test("Ashley Spencer / MediaKind: 26 Oct touch kept; no invented follow-up deadline; days since last contact shown", async () => {
    const { contactAction } = await import("../src/index.js");
    const ds = dataset({ events: [event({ date: "2026-08-25", category: "webinar" })], companies: [company({ allocationDate: "2026-08-31", temperatureRaw: "Warm" })],
      acts: [act({ ts: "2026-10-26T21:45:58Z" })] });
    const f = computeLeadFacts(ds, R, NOV)[0]!;
    assert.equal(f.currentSdrTouches, 1);
    const w = leadWork(f, NOV, R);
    assert.equal(w.due, null); assert.notEqual(w.section, "overdue"); assert.notEqual(w.section, "today");
    const a = contactAction(f, NOV, R);
    assert.equal(a.group, "progress"); assert.match(a.reason, /Last contacted 6 business days ago/);
    assert.notEqual(a.color, "red"); assert.notEqual(a.color, "amber");
  });
  test("long inactivity is a neutral follow-up opportunity; reply / task / disposition still take precedence", async () => {
    const { contactAction, emptyDispositions } = await import("../src/index.js");
    const stale = computeLeadFacts(dataset({ events: [event({ date: "2026-08-20" })], acts: [act({ ts: "2026-09-01" }), act({ ts: "2026-09-15" })] }), R, NOV)[0]!;
    const sa = contactAction(stale, NOV, R);
    assert.equal(sa.group, "follow_up"); assert.equal(sa.color, "grey"); assert.equal(sa.overdueBusinessDays, null);
    const reply = computeLeadFacts(dataset({ acts: [act({ ts: "2026-10-20" }), act({ ts: "2026-10-30", kind: "INCOMING_EMAIL", direction: "INCOMING_EMAIL", title: "Re: hi" })] }), R, NOV)[0]!;
    assert.equal(contactAction(reply, NOV, R).group, "respond");
    const task = computeLeadFacts(dataset({ acts: [act({ ts: "2026-11-02" })], tasks: [{ id: "t", dueDate: "2026-10-28T09:00:00Z", status: "NOT_STARTED", taskType: "CALL", ownerId: BOBBI, subject: "Call back as promised", contactIds: ["c1"] }] }), R, NOV)[0]!;
    const ta = contactAction(task, NOV, R);
    assert.equal(ta.group, "respond"); assert.equal(ta.color, "red");
    const disp = emptyDispositions();
    disp.contact.set("c1", { scope: "contact", id: "c1", code: "revisit_later", reason: "Asked to reconnect in Q1", evidence: "call", revisitDate: "2027-01-15", confirmedBy: "Bobbi", confirmedAt: null, source: "dashboard" });
    assert.equal(contactAction(stale, NOV, R, disp).group, "paused");
  });
});

test("first-touch SLA with the policy defaults: Hot 2, Warm 4 business days, effective 1 Nov 2026", async () => {
  const { DEFAULT_RULES, mergeRules } = await import("../src/index.js");
  const P = mergeRules(DEFAULT_RULES, { minEventDate: null });
  assert.equal(P.cadence.Hot.firstTouchBusinessDays, 2); assert.equal(P.cadence.Warm.firstTouchBusinessDays, 4);
  assert.equal(P.slaStartDate, "2026-11-01");
  const mk = (temp: string) => computeLeadFacts(dataset({ events: [event({ date: "2026-11-02" })], companies: [company({ allocationDate: "2026-11-02", temperatureRaw: temp })] }), P, "2026-11-09")[0]!;
  assert.equal(leadWork(mk("Hot"), "2026-11-09", P).due, "2026-11-04");   // Mon 2 Nov + 2 bd
  assert.equal(leadWork(mk("Warm"), "2026-11-09", P).due, "2026-11-06");  // + 4 bd
  assert.equal(leadWork(mk("Hot"), "2026-11-09", P).section, "overdue");
  // before the effective date: no breach
  const old = computeLeadFacts(dataset({ events: [event({ date: "2026-10-20" })], companies: [company({ allocationDate: "2026-10-20" })] }), P, "2026-11-09")[0]!;
  assert.equal(old.firstTouchOverdue, false);
});
