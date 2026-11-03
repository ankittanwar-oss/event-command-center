import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { applyFilters, computeLeadFacts, findings, inBucket, narrative, normalizeFilters, riskCounts, riskOf, sdrRisk, temperatureSummary } from "../src/index.js";
import { act, BOBBI, company, contact, dataset, deal, DISHA, event, rules } from "./fixtures.js";

const R = rules();
const one = (ds: ReturnType<typeof dataset>, today = "2026-10-30") => computeLeadFacts(ds, R, today)[0]!;

describe("risk levels reuse existing statuses and thresholds", () => {
  test("never worked: neutral inside SLA, at risk on the due day, critical after", () => {
    // event Thu 1 Oct, Hot SLA 3 business days -> due Tue 6 Oct
    assert.equal(riskOf(one(dataset(), "2026-10-02"), R)!.level, "neutral");
    assert.equal(riskOf(one(dataset(), "2026-10-06"), R)!.level, "at_risk");
    assert.equal(riskOf(one(dataset(), "2026-10-07"), R)!.level, "critical");
  });
  test("one email is never 'healthy'", () => {
    const early = one(dataset({ acts: [act({ ts: "2026-10-02" })] }), "2026-10-05");
    assert.equal(early.status, "first_touch");
    assert.notEqual(riskOf(early, R)!.level, "healthy");
    const late = one(dataset({ acts: [act({ ts: "2026-10-02" })] }), "2026-10-12");
    assert.equal(riskOf(late, R)!.level, "at_risk"); // one touch, more due, not yet stalled
  });
  test("a new lead is not critical for missing a long-range cadence", () => {
    const f = one(dataset({ acts: [act({ ts: "2026-10-02" })] }), "2026-10-03");
    assert.notEqual(riskOf(f, R)!.level, "critical");
  });
  test("stalled is critical; active and in play are healthy; unverifiable is neutral; ineligible has no risk", () => {
    assert.equal(riskOf(one(dataset({ acts: [act({ ts: "2026-10-02" })] }), "2026-10-14"), R)!.level, "critical");
    const acts = ["2026-10-02", "2026-10-06", "2026-10-13", "2026-10-20", "2026-10-27"].map((ts) => act({ ts }));
    assert.equal(riskOf(one(dataset({ acts })), R)!.level, "healthy");
    // in play with NO SDR touch is never "healthy"; with a touch it is
    assert.equal(riskOf(one(dataset({ deals: [deal()] })), R)!.level, "neutral");
    assert.equal(riskOf(one(dataset({ deals: [deal()], acts: [act({ ts: "2026-10-02" })] })), R)!.level, "healthy");
    assert.equal(riskOf(one(dataset({ acts: [act({ ts: "2026-10-02", contactIds: [], companyIds: ["co1"] })] })), R)!.level, "neutral");
    assert.equal(riskOf(one(dataset({ companies: [company({ competitorFlag: "Direct competitor" })] })), R), null);
  });
  test("critical equals the existing 'attention' bucket", () => {
    const ds = dataset({
      contacts: [contact(), contact({ id: "c2" }), contact({ id: "c3" })],
      links: [["e1", "c1"], ["e1", "c2"], ["e1", "c3"]],
      acts: [act({ ts: "2026-10-02", contactIds: ["c2"] })],
    });
    for (const f of computeLeadFacts(ds, R, "2026-10-30")) assert.equal(riskOf(f, R)?.level === "critical", inBucket(f, "attention"));
  });
});

describe("summary reconciliation", () => {
  const ds = dataset({
    companies: [company(), company({ id: "co2", sdrOwnerId: DISHA, temperatureRaw: "Warm" }), company({ id: "co3", temperatureRaw: "Cold" })],
    contacts: [contact(), contact({ id: "c2", companyId: "co2" }), contact({ id: "c3" }), contact({ id: "c4", companyId: "co3" }), contact({ id: "c5", companyId: "co2" })],
    links: [["e1", "c1"], ["e1", "c2"], ["e1", "c3"], ["e1", "c4"], ["e1", "c5"]],
    acts: [act({ ts: "2026-10-02" }), act({ ts: "2026-10-28", contactIds: ["c5"], companyIds: ["co2"] })],
  });
  const facts = computeLeadFacts(ds, R, "2026-10-30");
  test("critical + at risk + healthy + neutral = eligible, overall and per temperature", () => {
    const c = riskCounts(facts, R);
    assert.equal(c.critical + c.at_risk + c.healthy + c.neutral, c.eligible);
    assert.equal(c.eligible, facts.filter((f) => f.eligible).length);
    for (const t of ["Hot", "Warm"] as const) {
      const ct = riskCounts(facts.filter((f) => f.temperature === t), R);
      assert.equal(ct.eligible, temperatureSummary(facts, t).eligible);
    }
  });
  test("risk counts respect filters applied first", () => {
    const nf = normalizeFilters({ quarter: "all", region: "APAC" }, "2026-10-30");
    const c = riskCounts(applyFilters(facts, nf), R);
    assert.equal(c.eligible, 2);
  });
  test("each finding's drilldown returns exactly its count", () => {
    const fs = findings(facts, R);
    assert.ok(fs.length > 0);
    for (const x of fs) {
      const nf = normalizeFilters({ quarter: "all", ...x.drill.patch } as any, "2026-10-30");
      const rows = applyFilters(facts, nf).filter((f) => x.drill.bucket.startsWith("risk_") ? riskOf(f, R)?.level === x.drill.bucket.slice(5) : inBucket(f, x.drill.bucket));
      if (x.id === "sdr-backlog" || x.id === "event-gap" || x.id.endsWith("overdue") || x.id.endsWith("stalled") || x.id.endsWith("one-touch")) assert.equal(rows.length, x.count, x.id);
    }
    assert.equal(fs[0]!.severity, "critical");
  });
  test("SDR health rule is transparent: Hot critical -> critical", () => {
    assert.equal(sdrRisk(facts, BOBBI, R).health, "critical");
    assert.ok(["at_risk", "healthy", "critical", "neutral"].includes(sdrRisk(facts, DISHA, R).health));
  });
  test("an SDR whose leads are all not yet due is never shown as healthy", () => {
    const fresh = computeLeadFacts(dataset(), R, "2026-10-02");
    assert.equal(sdrRisk(fresh, BOBBI, R).health, "neutral");
  });
  test("narrative is deterministic and reports insufficient data explicitly", () => {
    const n = narrative(facts, R, findings(facts, R));
    assert.match(n, /^Event follow-up needs intervention: \d+ of \d+ eligible leads/);
    assert.equal(narrative(facts, R, findings(facts, R)), n);
    assert.match(narrative([], R, []), /cannot be assessed/);
  });
});

describe("touch-based headline buckets", () => {
  test("multi-touch / one-touch / untouched partition eligible leads; in-play split by SDR touches", async () => {
    const { BUCKETS, temperatureSummary } = await import("../src/index.js");
    const ds = dataset({
      contacts: [contact(), contact({ id: "c2" }), contact({ id: "c3" }), contact({ id: "c4" })],
      links: [["e1", "c1"], ["e1", "c2"], ["e1", "c3"], ["e1", "c4"]],
      acts: [act({ ts: "2026-10-02" }), act({ ts: "2026-10-09" }), act({ ts: "2026-10-02", contactIds: ["c2"] })],
      deals: [deal({ id: "d9", contactIds: ["c4"], companyIds: [] })],
    });
    const facts = computeLeadFacts(ds, R, "2026-10-30");
    const t = temperatureSummary(facts, "Hot");
    assert.equal(t.multiTouch.count, 1);
    assert.equal(t.oneTouch.count, 1);
    assert.equal(t.untouched.count, 2);
    assert.equal(t.multiTouch.count + t.oneTouch.count + t.untouched.count, t.eligible);
    const c4 = facts.find((f) => f.contactId === "c4")!;
    assert.equal(c4.status, "in_play");
    assert.equal(BUCKETS.in_play_untouched(c4), true);
    assert.equal(riskOf(c4, R)!.level, "neutral");
  });
});
