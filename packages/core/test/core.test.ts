import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  accountQueue, accountTouches, applyFilters, BUCKETS, businessDaysBetween, categorizeEvent, computeLeadFacts, contactTouches, expectedTouches,
  fiscalQuarterOf, inBucket, normalizeFilters, parseQuarterKey, quarterMetrics, quartersBetween, sdrRow, sdrTable, temperatureSummary, touchKind,
  type LeadFact,
} from "../src/index.js";
import { act, AE, ANSHU, BOBBI, company, contact, dataset, deal, DISHA, event, rules } from "./fixtures.js";

const R = rules();
const one = (ds: ReturnType<typeof dataset>, today = "2026-10-30", r = R): LeadFact => {
  const f = computeLeadFacts(ds, r, today);
  assert.equal(f.length, 1);
  return f[0]!;
};

describe("pod routing via the company's AE owner", () => {
  test("SDR Owner is the outreach pseudo-SDR (Anna S) and the AE is Aditya Deepak -> Jonathan", () => {
    const f = one(dataset({ companies: [company({ sdrOwnerId: "86492694", hubspotOwnerId: "95241225" })] }));
    assert.equal(f.sdrOwnerId, "97411438");
    assert.equal(f.sdrSource, "pod_ae");
  });
  test("empty SDR Owner with a pod AE -> pod SDR; a pod SDR already set is kept", () => {
    assert.equal(one(dataset({ companies: [company({ sdrOwnerId: null, hubspotOwnerId: "79976078" })] })).sdrOwnerId, "87607260");
    const kept = one(dataset({ companies: [company({ sdrOwnerId: "92977365", hubspotOwnerId: "79976078" })] }));
    assert.equal(kept.sdrOwnerId, "92977365");
    assert.equal(kept.sdrSource, "company");
  });
  test("non-pod AE and non-roster SDR stays unassigned", () => {
    const f = one(dataset({ companies: [company({ sdrOwnerId: "86492694", hubspotOwnerId: "1" })] }));
    assert.equal(f.sdrOwnerId, null);
  });
});

describe("SDR mapping", () => {
  test("uses the company SDR Owner and only roster SDRs", () => {
    const f = one(dataset());
    assert.equal(f.sdrOwnerId, BOBBI);
    assert.equal(f.sdrRegion, "NAM");
    assert.equal(f.eligible, true);
  });
  test("an AE in the SDR Owner field is not reported as an SDR", () => {
    const f = one(dataset({ companies: [company({ sdrOwnerId: AE })] }));
    assert.equal(f.sdrOwnerId, null);
    assert.equal(f.sdrOwnerRaw, AE);
    assert.equal(f.eligible, false);
    assert.equal(f.ineligibleReason, "SDR not on approved roster");
    assert.ok(f.dataQuality.includes("sdr_not_on_roster"));
  });
  test("missing SDR is flagged", () => {
    const f = one(dataset({ companies: [company({ sdrOwnerId: null })] }));
    assert.equal(f.ineligibleReason, "No SDR assigned");
    assert.ok(f.dataQuality.includes("sdr_missing"));
  });
  test("APAC SDR maps to APAC, EMEA to EMEA", () => {
    assert.equal(one(dataset({ companies: [company({ sdrOwnerId: DISHA })] })).sdrRegion, "APAC");
    assert.equal(one(dataset({ companies: [company({ sdrOwnerId: ANSHU })] })).sdrRegion, "EMEA");
  });
});

describe("region filtering", () => {
  const ds = dataset({
    companies: [company(), company({ id: "co2", sdrOwnerId: DISHA })],
    contacts: [contact(), contact({ id: "c2", companyId: "co2" })],
    links: [["e1", "c1"], ["e1", "c2"]],
  });
  const facts = computeLeadFacts(ds, R, "2026-10-30");
  test("filters records before KPIs", () => {
    const nf = normalizeFilters({ quarter: "all", region: "APAC" }, "2026-10-30");
    const rows = applyFilters(facts, nf);
    assert.deepEqual(rows.map((r) => r.contactId), ["c2"]);
    assert.equal(temperatureSummary(rows, "Hot").eligible, 1);
  });
  test("an SDR outside the selected region is cleared", () => {
    const nf = normalizeFilters({ quarter: "all", region: "APAC", sdr: BOBBI }, "2026-10-30");
    assert.equal(nf.sdr, "");
    assert.equal(nf.sdrCleared, true);
  });
  test("the SDR table only lists roster SDRs of the region", () => {
    const nf = normalizeFilters({ quarter: "all", region: "NAM" }, "2026-10-30");
    const t = sdrTable(applyFilters(facts, nf), nf);
    assert.equal(t.length, 6);
    assert.ok(t.every((r) => r.region === "NAM"));
    assert.equal(t.find((r) => r.ownerId === BOBBI)!.hotAssigned, 1);
  });
  test("a non-roster SDR id in the filter is cleared", () => {
    assert.equal(normalizeFilters({ sdr: AE }, "2026-10-30").sdr, "");
  });
});

describe("event categorisation", () => {
  const cat = (name: string, type: string | null = null, id = "x") => categorizeEvent(id, name, type, R).category;
  test("known event names", () => {
    assert.equal(cat("Beacon Experience Boston"), "owned");
    assert.equal(cat("Puppy Yoga - NYC | 28 July 2026"), "owned");
    assert.equal(cat("Round Table 6 : Should Legal Own Every Contract? | 29 Sep"), "roundtable");
    assert.equal(cat("IHC webinar : Contracts That Think"), "webinar");
    assert.equal(cat("Counselwell webinar : Contract Governance Blueprint"), "webinar");
    assert.equal(cat("ACC EVENT 2026"), "sponsored");
    assert.equal(cat("RLLB 2026"), "sponsored");
    assert.equal(cat("Legal Geek London | 14-15 October, 2026"), "sponsored");
  });
  test("event_type beats name; override beats both; unknown is never guessed", () => {
    assert.equal(cat("Something", "Virtual Roundtable"), "roundtable");
    assert.equal(categorizeEvent("42", "ACC EVENT", null, rules({ eventCategoryOverrides: { "42": "owned" } })).category, "owned");
    assert.equal(cat("Quarterly gathering"), "uncategorized");
  });
});

describe("attendance", () => {
  const sponsored = event({ category: "sponsored", name: "ACC EVENT 2026" });
  test("sponsored attendee is eligible", () => {
    const f = one(dataset({ events: [sponsored], contacts: [contact({ attendedDate: "2026-10-01" })] }));
    assert.equal(f.attendance, "attended");
    assert.equal(f.eligible, true);
  });
  test("attendance snapshot survives a later overwrite of the contact property", () => {
    const f = one(dataset({ events: [sponsored], contacts: [contact({ attendedDate: "2026-10-27" })], links: [["e1", "c1", "2026-10-02"]] }));
    assert.equal(f.attendance, "attended");
  });
  test("no-show when the event has attendance and the contact does not", () => {
    const ds = dataset({ events: [sponsored], contacts: [contact(), contact({ id: "c2", attendedDate: "2026-10-01" })], links: [["e1", "c1"], ["e1", "c2"]] });
    const f = computeLeadFacts(ds, R, "2026-10-30").find((x) => x.contactId === "c1")!;
    assert.equal(f.attendance, "no_show");
    assert.equal(f.ineligibleReason, "Sponsored event: did not attend");
  });
  test("unknown when the event has no attendance recorded at all", () => {
    const f = one(dataset({ events: [sponsored] }));
    assert.equal(f.attendance, "unknown");
    assert.equal(f.ineligibleReason, "Sponsored event: attendance not confirmed");
  });
  test("prior conversation keeps a sponsored non-attendee eligible", () => {
    const f = one(dataset({ events: [sponsored], acts: [act({ ts: "2026-08-01", kind: "MEETING", objectType: "meetings" })] }));
    assert.equal(f.priorConversation, true);
    assert.equal(f.eligible, true);
  });
  test("owned events do not require attendance", () => {
    assert.equal(one(dataset({ events: [event({ category: "owned", name: "Beacon" })] })).eligible, true);
  });
});

describe("temperature and eligibility", () => {
  const RH = rules({ requireHotWarm: true });
  const oneR = (ds: ReturnType<typeof dataset>, r = RH) => computeLeadFacts(ds, r, "2026-10-30")[0]!;
  test("default: every temperature is eligible; temperature is shown, not filtered", () => {
    const c = one(dataset({ companies: [company({ temperatureRaw: "Cold" })] }));
    assert.equal(c.eligible, true);
    assert.equal(c.temperature, null);
    assert.equal(c.temperatureRaw, "Cold");
  });
  test("with requireHotWarm: Hot and Warm map; Surging is not mapped and is flagged", () => {
    assert.equal(oneR(dataset({ companies: [company({ temperatureRaw: "Warm" })] })).temperature, "Warm");
    const s2 = oneR(dataset({ companies: [company({ temperatureRaw: "Surging" })] }));
    assert.equal(s2.temperature, null);
    assert.equal(s2.eligible, false);
    assert.ok(s2.dataQuality.includes("temperature_unmapped_value"));
  });
  test("with requireHotWarm: Cold is excluded but not a data issue; missing temperature is", () => {
    const c = oneR(dataset({ companies: [company({ temperatureRaw: "Cold" })] }));
    assert.equal(c.ineligibleReason, "Lead temperature is Cold");
    assert.ok(!c.dataQuality.includes("temperature_unmapped_value"));
    assert.ok(oneR(dataset({ companies: [company({ temperatureRaw: null })] })).dataQuality.includes("temperature_missing"));
  });
  test("exclusions", () => {
    assert.equal(one(dataset({ companies: [company({ competitorFlag: "Direct competitor" })] })).ineligibleReason, "Competitor");
    assert.equal(one(dataset({ companies: [company({ lifecycleStage: "customer" })] })).ineligibleReason, "Existing customer");
    assert.equal(one(dataset({ contacts: [contact({ doNotContact: true })] })).ineligibleReason, "Do not contact");
    assert.match(one(dataset({ companies: [company({ icpTier: "Low Fit" })] })).ineligibleReason!, /Not targetable/);
    assert.equal(one(dataset({ events: [event({ date: "2026-11-15" })] })).ineligibleReason, "Upcoming event");
    assert.equal(one(dataset({ contacts: [contact({ companyId: null })] })).ineligibleReason, "No associated company");
  });
});

describe("activity detection", () => {
  const k = (p: Parameters<typeof act>[0]) => touchKind(act(p), BOBBI, R);
  test("outbound email, call and LinkedIn count", () => {
    assert.equal(k({ ts: "2026-10-02" }), "Email");
    assert.equal(k({ ts: "2026-10-02", kind: "CALL", objectType: "calls", direction: "OUTBOUND", status: "COMPLETED" }), "Call");
    assert.equal(k({ ts: "2026-10-02", kind: "LINKEDIN", objectType: "communications", channel: "LINKEDIN_MESSAGE", direction: null }), "LinkedIn");
    assert.equal(k({ ts: "2026-10-02", kind: "TASK", objectType: "tasks", channel: "LINKED_IN", status: "COMPLETED", direction: null }), "LinkedIn");
  });
  test("inbound email, uncompleted tasks, queued calls, meetings and non-roster owners do not", () => {
    assert.equal(k({ ts: "2026-10-02", kind: "INCOMING_EMAIL", direction: "INCOMING_EMAIL" }), null);
    assert.equal(k({ ts: "2026-10-02", kind: "TASK", objectType: "tasks", channel: "LINKED_IN", status: "NOT_STARTED" }), null);
    assert.equal(k({ ts: "2026-10-02", kind: "TASK", objectType: "tasks", channel: "EMAIL", status: "COMPLETED" }), null);
    assert.equal(k({ ts: "2026-10-02", kind: "CALL", objectType: "calls", status: "QUEUED" }), null);
    assert.equal(k({ ts: "2026-10-02", kind: "CALL", objectType: "calls", direction: "INBOUND" }), null);
    assert.equal(k({ ts: "2026-10-02", kind: "MEETING", objectType: "meetings" }), null);
    assert.equal(k({ ts: "2026-10-02", ownerId: AE }), null);
    assert.equal(k({ ts: "2026-10-02", ownerId: null }), null);
  });
  test("only the assigned SDR counts when configured", () => {
    const r = rules({ countAnyRosterSdrTouch: false });
    assert.equal(touchKind(act({ ts: "2026-10-02", ownerId: DISHA }), BOBBI, r), null);
    assert.equal(touchKind(act({ ts: "2026-10-02", ownerId: DISHA }), BOBBI, R), "Email");
  });
  test("duplicates collapse; genuine same-day touches stay", () => {
    const a = act({ ts: "2026-10-02T15:00:10Z" });
    const dup = { ...a };                                       // same record twice
    const bcc = act({ ts: "2026-10-02T15:00:40Z" });           // same minute, same owner
    const later = act({ ts: "2026-10-02T17:30:00Z" });
    assert.equal(contactTouches([a, dup, bcc, later], "c1", BOBBI, R).length, 2);
  });
});

describe("contact-level vs company-level activity", () => {
  test("company-only outreach is Unable to Verify, not Worked", () => {
    const f = one(dataset({ acts: [act({ ts: "2026-10-02", contactIds: [], companyIds: ["co1"] })] }));
    assert.equal(f.touchesSinceEligibility, 0);
    assert.equal(f.status, "unverifiable");
    assert.equal(f.companyOutreachOnly, true);
    assert.equal(BUCKETS.worked(f), false);
  });
  test("account touches count one email to two contacts once", () => {
    const e = act({ ts: "2026-10-02", contactIds: ["c1", "c2"] });
    assert.equal(accountTouches([e], "co1", new Set(["c1", "c2"]), BOBBI, R).length, 1);
  });
  test("account queue de-duplicates touches across contacts", () => {
    const e = act({ ts: "2026-10-02", contactIds: ["c1", "c2"] });
    const ds = dataset({ contacts: [contact(), contact({ id: "c2" })], links: [["e1", "c1"], ["e1", "c2"]], acts: [e] });
    const q = accountQueue(computeLeadFacts(ds, R, "2026-10-06"), R);
    assert.equal(q.length, 1);
    assert.equal(q[0]!.touches, 1);
    assert.equal(q[0]!.contactsWorked, 2);
  });
});

describe("allocation and touch windows", () => {
  test("eligibility starts at the later of event date and allocation date", () => {
    const ds = dataset({
      companies: [company({ allocationDate: "2026-10-10" })],
      acts: [act({ ts: "2026-10-05" }), act({ ts: "2026-10-12" })],
    });
    const f = one(ds);
    assert.equal(f.eligibilityDate, "2026-10-10");
    assert.equal(f.touchesSinceEligibility, 1);
    assert.equal(f.touchesPostEvent, 2);
    assert.equal(f.touchesSinceAllocation, 1);
  });
  test("same-day touches on the event day count as post-event", () => {
    assert.equal(one(dataset({ acts: [act({ ts: "2026-10-01T20:00:00Z" })] })).touchesSinceEligibility, 1);
  });
  test("missing allocation date is flagged but does not block", () => {
    const f = one(dataset({ companies: [company({ allocationDate: null })] }));
    assert.ok(f.dataQuality.includes("allocation_date_missing"));
    assert.equal(f.eligibilityDate, "2026-10-01");
  });
});

describe("business-day SLA", () => {
  const cal = R.businessCalendar;
  test("business days skip weekends", () => {
    assert.equal(businessDaysBetween("2026-10-01", "2026-10-06", cal), 3); // Thu -> Tue: Fri, Mon, Tue
    assert.equal(businessDaysBetween("2026-10-02", "2026-10-05", cal), 1); // Fri -> Mon
    assert.equal(businessDaysBetween("2026-10-03", "2026-10-04", cal), 0); // Sat -> Sun
  });
  test("holidays are excluded", () => {
    assert.equal(businessDaysBetween("2026-10-01", "2026-10-06", { ...cal, holidays: ["2026-10-05"] }), 2);
  });
  test("met at 3 business days, missed at 4 (Hot)", () => {
    assert.equal(one(dataset({ acts: [act({ ts: "2026-10-06" })] })).firstTouchSlaMet, true);
    assert.equal(one(dataset({ acts: [act({ ts: "2026-10-07" })] })).firstTouchSlaMet, false);
  });
  test("overdue only after the window", () => {
    assert.equal(one(dataset(), "2026-10-06").firstTouchOverdue, false);
    const f = one(dataset(), "2026-10-07");
    assert.equal(f.firstTouchOverdue, true);
    assert.equal(f.status, "never_worked");
    assert.equal(BUCKETS.overdue(f), true);
  });
  test("Hot and Warm thresholds are separate and configurable", () => {
    const r = rules({ cadence: { Warm: { firstTouchBusinessDays: 5 } } });
    const warm = dataset({ companies: [company({ temperatureRaw: "Warm" })] });
    assert.equal(one(warm, "2026-10-07", r).firstTouchOverdue, false);
    assert.equal(one(dataset(), "2026-10-07", r).firstTouchOverdue, true);
  });
});

describe("follow-up status", () => {
  test("stalled uses the temperature-specific threshold", () => {
    const acts = [act({ ts: "2026-10-02" })];
    // last touch Fri 2 Oct; 30 Oct is 20 business days later
    assert.equal(one(dataset({ acts }), "2026-10-13").status, "first_touch");   // 7 business days
    assert.equal(one(dataset({ acts }), "2026-10-14").status, "stalled");       // 8 > 7 (Hot)
    const warm = dataset({ companies: [company({ temperatureRaw: "Warm" })], acts });
    assert.equal(one(warm, "2026-10-14").status, "first_touch");                // 8 <= 10 (Warm)
  });
  test("actively worked needs cadence across multiple weeks once 14+ days old", () => {
    const acts = ["2026-10-02", "2026-10-06", "2026-10-13", "2026-10-20", "2026-10-27"].map((ts) => act({ ts }));
    const f = one(dataset({ acts }), "2026-10-30");
    assert.equal(f.status, "active");
    assert.equal(f.multiWeek, true);
    const bunched = ["2026-10-02", "2026-10-02T18:00:00Z", "2026-10-02T19:00:00Z", "2026-10-02T20:00:00Z"].map((ts) => act({ ts }));
    assert.equal(one(dataset({ acts: bunched }), "2026-10-09").status, "active");     // under 14 days old: one week is enough
    const warm = dataset({ companies: [company({ temperatureRaw: "Warm" })], acts: bunched });
    assert.equal(one(warm, "2026-10-16").status, "first_touch");                       // 15 days old, all touches in one week
  });
  test("in play: meeting, reply, open deal", () => {
    assert.equal(one(dataset({ acts: [act({ ts: "2026-10-08", kind: "MEETING", objectType: "meetings" })] })).status, "in_play");
    assert.equal(one(dataset({ acts: [act({ ts: "2026-10-08", kind: "INCOMING_EMAIL", direction: "INCOMING_EMAIL" })] })).status, "in_play");
    assert.equal(one(dataset({ deals: [deal()] })).status, "in_play");
  });
  test("Not Qualified and test deals do not make a lead in play", () => {
    assert.equal(one(dataset({ deals: [deal({ stageLabel: "Not Qualified (Sales Pipeline)" })] })).status, "never_worked");
    assert.equal(one(dataset({ deals: [deal({ name: "Test | Inbound" })] })).status, "never_worked");
  });
  test("next step from open tasks", () => {
    const f = one(dataset({ tasks: [{ id: "t1", dueDate: "2026-11-02T10:00:00Z", status: "NOT_STARTED", taskType: "EMAIL", ownerId: BOBBI, subject: null, contactIds: ["c1"] }] }));
    assert.equal(f.hasNextStep, true);
    assert.equal(f.nextTaskDue, "2026-11-02T10:00:00Z");
  });
});

describe("depth (age-normalised)", () => {
  test("expected touches by age", () => {
    const c = R.cadence.Hot;
    assert.equal(expectedTouches(0, c), 1);
    assert.equal(expectedTouches(15, c), 2);
    assert.equal(expectedTouches(30, c), 4);
    assert.equal(expectedTouches(56, c), 8);
    assert.equal(expectedTouches(120, c), 8);
  });
  test("first-30-day average only uses leads at least 30 days old", () => {
    const ds = dataset({
      events: [event(), event({ id: "e2", date: "2026-10-20" })],
      contacts: [contact(), contact({ id: "c2" })],
      links: [["e1", "c1"], ["e2", "c2"]],
      acts: [act({ ts: "2026-10-02" }), act({ ts: "2026-10-09" }), act({ ts: "2026-10-21", contactIds: ["c2"] })],
    });
    const facts = computeLeadFacts(ds, R, "2026-11-05");
    const row = sdrRow(facts, BOBBI);
    assert.equal(row.mature30Leads, 1);
    assert.equal(row.avgTouchesFirst30, 2);
    assert.equal(row.hotCoverage, 100);
  });
  test("coverage and depth are separate fields (never blended)", () => {
    const row = sdrRow(computeLeadFacts(dataset({ acts: [act({ ts: "2026-10-02" })] }), R, "2026-10-30"), BOBBI);
    assert.equal(row.hotCoverage, 100);
    assert.equal(row.oneTouchPct, 100);
    assert.equal(row.multiWeekPct, 0);
  });
});

describe("fiscal quarters", () => {
  test("May fiscal year: Q1 MJJ, Q2 ASO, Q3 NDJ, Q4 FMA", () => {
    assert.equal(fiscalQuarterOf("2026-05-01").key, "FY2027-Q1");
    assert.equal(fiscalQuarterOf("2026-07-31").key, "FY2027-Q1");
    assert.equal(fiscalQuarterOf("2026-08-01").key, "FY2027-Q2");
    assert.equal(fiscalQuarterOf("2026-10-30").key, "FY2027-Q2");
    assert.equal(fiscalQuarterOf("2026-11-01").key, "FY2027-Q3");
    assert.equal(fiscalQuarterOf("2027-01-31").key, "FY2027-Q3");
    assert.equal(fiscalQuarterOf("2027-02-01").key, "FY2027-Q4");
    assert.equal(fiscalQuarterOf("2026-04-30").key, "FY2026-Q4");
  });
  test("ranges and labels", () => {
    const q = parseQuarterKey("FY2027-Q3")!;
    assert.equal(q.start, "2026-11-01");
    assert.equal(q.end, "2027-01-31");
    assert.match(q.label, /Q3 NDJ/);
    assert.deepEqual(quartersBetween("2026-06-01", "2026-12-01").map((x) => x.key), ["FY2027-Q3", "FY2027-Q2", "FY2027-Q1"]);
  });
  test("'this' quarter filter", () => {
    const nf = normalizeFilters({ quarter: "this" }, "2026-10-30");
    assert.deepEqual(nf.quarterRange, { start: "2026-08-01", end: "2026-10-31" });
  });
});

describe("QoQ", () => {
  test("quarter metrics use only that quarter's events and flag incomplete quarters", () => {
    const ds = dataset({
      companies: [company({ allocationDate: "2026-07-01" })],
      events: [event({ date: "2026-07-10" }), event({ id: "e2", date: "2026-10-01" })],
      contacts: [contact(), contact({ id: "c2" })],
      links: [["e1", "c1"], ["e2", "c2"]],
      acts: [act({ ts: "2026-07-13" })],
    });
    const facts = computeLeadFacts(ds, R, "2026-10-30");
    const q1 = quarterMetrics(facts, parseQuarterKey("FY2027-Q1")!, "2026-10-30");
    const q2 = quarterMetrics(facts, parseQuarterKey("FY2027-Q2")!, "2026-10-30");
    assert.equal(q1.eligible, 1);
    assert.equal(q1.coverage, 100);
    assert.equal(q1.complete, true);
    assert.equal(q2.coverage, 0);
    assert.equal(q2.complete, false);
  });
});

describe("KPI / drilldown reconciliation", () => {
  test("every summary count equals the size of its drilldown", () => {
    const ds = dataset({
      companies: [company(), company({ id: "co2", temperatureRaw: "Warm", sdrOwnerId: DISHA })],
      contacts: [contact(), contact({ id: "c2", companyId: "co2" }), contact({ id: "c3" })],
      links: [["e1", "c1"], ["e1", "c2"], ["e1", "c3"]],
      acts: [act({ ts: "2026-10-02" }), act({ ts: "2026-10-03", contactIds: [], companyIds: ["co2"] })],
    });
    const facts = computeLeadFacts(ds, R, "2026-10-30");
    for (const t of ["Hot", "Warm"] as const) {
      const s = temperatureSummary(facts, t);
      const rows = facts.filter((f) => f.temperature === t);
      for (const m of [s.worked, s.neverWorked, s.overdue, s.insufficient, s.active, s.stalled, s.inPlay, s.unverifiable]) {
        assert.equal(m.count, rows.filter((f) => inBucket(f, m.bucket)).length, `${t} ${m.bucket}`);
      }
    }
  });
});
