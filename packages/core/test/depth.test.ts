import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { computeLeadFacts, depthStats, inBucket, riskOf, sdrRisk, targetStatus, windowTouches } from "../src/index.js";
import { act, BOBBI, company, contact, dataset, deal, event, rules } from "./fixtures.js";

const R = rules();
const TODAY = "2026-10-30";

describe("recently closed lost: grey, no SLA", () => {
  const lostOn = (at: string, extra: any = {}) => deal({ id: "L", name: "Lost", stageLabel: "Closed lost", isClosed: true, isWon: false, isClosedLost: true, closedLostAt: at, closeDate: at, createdAt: "2025-11-24T00:00:00Z", mqlDate: null, contactIds: [], companyIds: ["co1"], ...extra });
  test("own company deal lost within the window -> recently_lost, neutral, not overdue, still eligible", () => {
    const f = computeLeadFacts(dataset({ deals: [lostOn("2026-08-27T18:33:21Z")] }), R, TODAY)[0]!;
    assert.equal(f.eligible, true);
    assert.equal(f.status, "recently_lost");
    assert.equal(f.firstTouchOverdue, false);
    assert.equal(f.firstTouchSlaMet, null);
    assert.equal(riskOf(f, R)!.level, "neutral");
    assert.equal(inBucket(f, "attention"), false);
    assert.equal(sdrRisk([f], BOBBI, R).health, "neutral");
  });
  test("loss older than the window -> normal rules apply (critical when overdue)", () => {
    const f = computeLeadFacts(dataset({ deals: [lostOn("2026-06-01T00:00:00Z")] }), R, TODAY)[0]!;
    assert.equal(f.status, "never_worked");
    assert.equal(riskOf(f, R)!.level, "critical");
  });
  test("window is configurable; 0 turns it off", () => {
    const f = computeLeadFacts(dataset({ deals: [lostOn("2026-08-27T18:33:21Z")] }), rules({ recentlyClosedLostDays: 0 }), TODAY)[0]!;
    assert.equal(f.status, "never_worked");
  });
  test("The Channel Company: lost deal on a DUPLICATE company record (same name + same SDR) is recognised", () => {
    const ds = dataset({
      companies: [company({ id: "44450868483", name: "The Channel Company" }), company({ id: "42702800922", name: "The Channel Company" })],
      contacts: [contact({ companyId: "44450868483" })],
      deals: [lostOn("2026-08-27T18:33:21.127Z", { id: "50152027684", companyIds: ["42702800922"] })],
    });
    const f = computeLeadFacts(ds, R, TODAY)[0]!;
    assert.equal(f.status, "recently_lost");
    assert.equal(f.recentlyLost!.via, "duplicate_company");
    assert.equal(f.deals!.find((d) => d.id === "50152027684")!.via, "duplicate_company");
    assert.equal(f.dealStatus, "none"); // own-record deal status is not taken from the duplicate
  });
  test("same name but a different SDR owner is NOT treated as the same account", () => {
    const ds = dataset({
      companies: [company({ id: "a", name: "Acme Inc" }), company({ id: "b", name: "Acme", sdrOwnerId: "97411405" })],
      contacts: [contact({ companyId: "a" })],
      deals: [lostOn("2026-08-27T18:33:21Z", { companyIds: ["b"] })],
    });
    assert.equal(computeLeadFacts(ds, R, TODAY)[0]!.status, "never_worked");
  });
  test("an open opportunity still takes precedence (in play)", () => {
    const f = computeLeadFacts(dataset({ deals: [lostOn("2026-08-27T18:33:21Z"), deal({ id: "O", mqlDate: null })] }), R, TODAY)[0]!;
    assert.equal(f.status, "in_play");
  });
});

describe("touch depth", () => {
  test("one email to three contacts = 1 account touch and 1 contact touch each", () => {
    const ds = dataset({
      contacts: [contact(), contact({ id: "c2" }), contact({ id: "c3" })],
      links: [["e1", "c1"], ["e1", "c2"], ["e1", "c3"]],
      acts: [act({ ts: "2026-10-02", contactIds: ["c1", "c2", "c3"] })],
    });
    const s = depthStats(computeLeadFacts(ds, R, TODAY), R, "eligibility", null);
    assert.equal(s.accounts, 1);
    assert.equal(s.totalTouches, 1);
    assert.equal(s.contactTouches, 3);
    assert.equal(s.avgPerAccount, 1);
    assert.equal(s.avgPerLead, 1);
    assert.equal(s.bands.b1, 3);
  });
  test("SDR A (concentrated) vs SDR B (spread) is visible without a blended score", () => {
    const mk = (n: number, perLead: number[]) => {
      const contacts = Array.from({ length: n }, (_, i) => contact({ id: `x${i}`, companyId: `co${i}` }));
      const companies = contacts.map((c) => company({ id: c.companyId! }));
      const acts = perLead.flatMap((k, i) => Array.from({ length: k }, (_, j) => act({ ts: `2026-10-${String(2 + j * 3).padStart(2, "0")}`, contactIds: [`x${i}`], companyIds: [`co${i}`] })));
      return depthStats(computeLeadFacts(dataset({ companies, contacts, links: contacts.map((c) => ["e1", c.id] as [string, string]), acts }), R, TODAY), R, "eligibility", null);
    };
    const A = mk(20, [8, 8, 8, 8, 8, ...Array(15).fill(0)]); // 40 touches on 5 accounts
    const B = mk(20, Array(20).fill(5));                      // 100 touches spread evenly
    assert.equal(A.untouchedAccounts, 15);
    assert.equal(B.untouchedAccounts, 0);
    assert.ok(A.top25Share! > B.top25Share!);
    assert.equal(B.bands.b45, 20);
    assert.equal(A.bands.b8, 5);
  });
  test("windows: allocation date missing is flagged, not invented; period window filters by touch date", () => {
    const ds = dataset({ companies: [company({ allocationDate: null })], acts: [act({ ts: "2026-09-20" }), act({ ts: "2026-10-05" })] });
    const f = computeLeadFacts(ds, R, TODAY)[0]!;
    assert.equal(windowTouches(f, "allocation", null), null);
    assert.equal(depthStats([f], R, "allocation", null).missingWindow, 1);
    assert.equal(windowTouches(f, "period", { start: "2026-10-01", end: "2026-10-31" })!.length, 1);
    assert.equal(windowTouches(f, "event", null)!.length, 1);
  });
  test("target: progress only until a window is configured; never 'behind' without one", () => {
    const f = computeLeadFacts(dataset({ acts: [act({ ts: "2026-10-02" })] }), R, TODAY)[0]!;
    assert.equal(targetStatus(f, 1, R), "in_progress");
    assert.equal(targetStatus(f, 6, R), "achieved");
    assert.equal(targetStatus(f, 1, rules({ touchTarget: { windowDays: 21 } })), "behind");
  });
});
