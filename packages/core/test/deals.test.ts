import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { computeLeadFacts, riskOf } from "../src/index.js";
import { company, contact, dataset, deal, event, rules } from "./fixtures.js";

const R = rules();
const one = (ds: ReturnType<typeof dataset>, today = "2026-10-30") => computeLeadFacts(ds, R, today)[0]!;
const ev = event({ date: "2026-10-01" });

describe("event attribution: MQL only, new deals only", () => {
  test("a deal created after the event with an MQL date in the window is attributed", () => {
    const f = one(dataset({ events: [ev], deals: [deal({ createdAt: "2026-10-05T00:00:00Z", mqlDate: "2026-10-06" })] }));
    assert.deepEqual(f.attributedDeals, ["d1"]);
  });
  test("a deal created in the window but with no MQL date is NOT counted (MQL only)", () => {
    const f = one(dataset({ events: [ev], deals: [deal({ createdAt: "2026-10-05T00:00:00Z", mqlDate: null })] }));
    assert.deepEqual(f.attributedDeals, []);
  });
  test("a deal record created early but MQL'd after the event is attributed (Menlo Security / RT7 shape)", () => {
    const f = one(dataset({ events: [event({ date: "2026-10-27" })], deals: [deal({ createdAt: "2026-05-08T00:00:00Z", mqlDate: "2026-10-29" })] }));
    assert.deepEqual(f.attributedDeals, ["d1"]);
    assert.equal(f.deals![0]!.timing, "after_event");
  });
  test("a historical deal (already MQL before the event) is never attributed, even if its SQL date falls in the window", () => {
    const f = one(dataset({ events: [ev], deals: [deal({ createdAt: "2025-11-24T10:10:45Z", mqlDate: "2026-02-01", sqlDate: "2026-10-04" })] }));
    assert.deepEqual(f.attributedDeals, []);
    assert.deepEqual(f.sqlDeals, []);
    assert.equal(f.deals![0]!.timing, "before_event");
  });
  test("a deal with no MQL date created before the event is pre-existing", () => {
    const f = one(dataset({ events: [ev], deals: [deal({ createdAt: "2025-11-24T10:10:45Z", mqlDate: null })] }));
    assert.equal(f.deals![0]!.timing, "before_event");
  });
});

describe("deal history as context", () => {
  // The Channel Company shape: closed lost 27 Aug 2026 after Proposal Shared / Negotiations, no reason recorded
  const lost = deal({
    id: "50152027684", name: "The Channel Company", stageLabel: "Closed lost (Sales Pipeline)", isClosed: true, isWon: false, isClosedLost: true,
    createdAt: "2025-11-24T10:10:45Z", mqlDate: null, closeDate: "2026-08-27T18:33:21.127Z", closedLostAt: "2026-08-27T18:33:21.127Z",
    previousStageLabel: "Proposal Shared / Negotiations (Sales Pipeline)", lostReason: null, lostSubReason: null, lostComment: null,
    contactIds: [], companyIds: ["co1"],
  });
  test("closed lost details come through unchanged; no reason is invented", () => {
    const f = one(dataset({ events: [ev], deals: [lost] }));
    const d = f.deals![0]!;
    assert.equal(f.dealStatus, "lost");
    assert.equal(d.status, "lost");
    assert.equal(d.closedAt, "2026-08-27T18:33:21.127Z");
    assert.equal(d.previousStageLabel, "Proposal Shared / Negotiations (Sales Pipeline)");
    assert.equal(d.lostReason, null);
    assert.equal(d.via, "company"); // company deal: not assumed to belong to this contact
  });
  test("closed lost never changes eligibility or attribution; within the recent window it shows as recently closed lost (grey)", () => {
    const withLost = one(dataset({ events: [ev], deals: [lost] }));
    const without = one(dataset({ events: [ev] }));
    assert.equal(withLost.eligible, without.eligible);
    assert.deepEqual(withLost.attributedDeals, []);
    assert.equal(withLost.status, "recently_lost");
    assert.equal(riskOf(withLost, R)?.level, "neutral");
    // with the window switched off, status and risk are exactly as without the deal
    const R0 = rules({ recentlyClosedLostDays: 0 });
    const a = computeLeadFacts(dataset({ events: [ev], deals: [lost] }), R0, "2026-10-30")[0]!;
    const b = computeLeadFacts(dataset({ events: [ev] }), R0, "2026-10-30")[0]!;
    assert.equal(a.status, b.status);
    assert.equal(riskOf(a, R0)?.level, riskOf(b, R0)?.level);
  });
  test("multiple deals: open first, then most recently closed; contact deals marked as the contact's", () => {
    const open = deal({ id: "d2", name: "Renewed", stageLabel: "Discovery", createdAt: "2026-10-10T00:00:00Z", mqlDate: null, contactIds: ["c1"], companyIds: ["co1"] });
    const won = deal({ id: "d3", isClosed: true, isWon: true, closeDate: "2025-01-10T00:00:00Z", createdAt: "2024-10-01T00:00:00Z", mqlDate: null, contactIds: [], companyIds: ["co1"] });
    const f = one(dataset({ events: [ev], deals: [lost, won, open] }));
    assert.deepEqual(f.deals!.map((d) => d.id), ["d2", "50152027684", "d3"]);
    assert.equal(f.dealStatus, "open");
    assert.equal(f.deals![0]!.via, "contact");
    assert.equal(f.deals![0]!.timing, "after_event");
  });
  test("no deal -> none", () => {
    assert.equal(one(dataset({ events: [ev] })).dealStatus, "none");
    assert.deepEqual(one(dataset({ events: [ev], companies: [company()], contacts: [contact()] })).deals, []);
  });
});
