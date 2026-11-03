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
  test("fewer than 6-7 touches alone is not overdue: follow-up due from the cadence rule", () => {
    const w = one(dataset({ acts: [act({ ts: "2026-10-27" })] }));
    assert.equal(w.action, "Follow up"); assert.notEqual(w.section, "overdue");
    // below the expected-touch curve for its age -> due (amber), matching the existing insufficientFollowUp rule
    const f = computeLeadFacts(dataset({ acts: [act({ ts: "2026-10-27" })] }), R, T)[0]!;
    assert.equal(w.section === "today", f.insufficientFollowUp);
    // a new lead with one touch and nothing due yet is "not yet due", never overdue
    const n = one(dataset({ events: [event({ date: "2026-10-28" })], acts: [act({ ts: "2026-10-28" })] }));
    assert.equal(n.section, "upcoming");
  });
  test("one touch + open opportunity only on the account is not 'healthy'; a deal on the contact is", () => {
    const acctDeal = computeLeadFacts(dataset({ acts: [act({ ts: "2026-10-02" })], deals: [deal({ contactIds: [] })] }), R, T)[0]!;
    assert.equal(acctDeal.status, "in_play");
    assert.equal(riskOf(acctDeal, R)?.level, "neutral");
    assert.equal(leadDimensions(acctDeal, T, R).health, "unverified");
    const contactDeal = computeLeadFacts(dataset({ acts: [act({ ts: "2026-10-02" })], deals: [deal()] }), R, T)[0]!;
    assert.equal(riskOf(contactDeal, R)?.level, "healthy");
  });
  test("SLA, depth and follow-up are independent: one on-time touch can still have follow-up due", () => {
    const f = computeLeadFacts(dataset({ acts: [act({ ts: "2026-10-02" })] }), R, T)[0]!;
    const d = leadDimensions(f, T, R);
    assert.equal(d.sla, "First-touch SLA met"); assert.equal(d.depth, "1");
    assert.match(d.followUp!, /Follow-up (due|overdue)/); assert.match(d.cadence!, /incomplete/);
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

test("SLA start date affects only the first-touch SLA, not follow-up cadence", () => {
  const r = rules({ slaStartDate: "2026-10-30" });
  const f = computeLeadFacts(dataset({ acts: [act({ ts: "2026-10-26" })] }), r, T)[0]!;
  assert.equal(f.firstTouchSlaMet, null);
  assert.equal(f.insufficientFollowUp, true);
  assert.equal(riskOf(f, r)?.level, "at_risk");
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
  test("overdue source is named: cadence vs task", async () => {
    const { overdueSource } = await import("../src/index.js");
    const c = leadWork(computeLeadFacts(dataset({ acts: [act({ ts: "2026-10-05" })] }), R, T)[0]!, T, R);
    assert.match(overdueSource(c)!.label, /^Follow-up cadence overdue by \d+ business day/);
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
  const noTask = actionStatus(computeLeadFacts(dataset({ acts: [act({ ts: "2026-10-26" })], deals: [deal({ contactIds: [] })] }), R, T)[0]!, T, R);
  assert.equal(noTask.label, "Review next action"); assert.equal(noTask.color, "grey");
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
