import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { computeLeadFacts, DEFAULT_RULES } from "@ecc/core";
import { HubSpotClient, HubSpotError } from "../src/hubspot/client.js";
import { attendedForEvent, hsDate, hsTimestamp, mapActivity, mapCompany, mapContact, mapDeal, mapEvent } from "../src/hubspot/mappers.js";
import * as views from "../src/api/views.js";
import { act, company, contact, dataset, DISHA, BOBBI } from "../../../packages/core/test/fixtures.js";

describe("HubSpot mappers", () => {
  test("dates in all HubSpot formats", () => {
    assert.equal(hsDate("2026-10-27"), "2026-10-27");
    assert.equal(hsDate("2026-10-27T00:00:00.000Z"), "2026-10-27");
    assert.equal(hsDate("1793059200000"), "2026-10-27");
    assert.equal(hsDate(""), null);
    assert.equal(hsTimestamp("1793059200000"), "2026-10-27T00:00:00.000Z");
  });
  test("company: SDR from sdr_owner, never from hubspot_owner_id; allocation from history when missing", () => {
    const c = mapCompany({
      id: "1", properties: { name: "Omnissa", sdr_owner: "87607260", hubspot_owner_id: "95421364", event_leads___cold_warm_surging_hot: "Hot", icp_category_20: "Tier 1" },
      propertiesWithHistory: { sdr_owner: [
        { value: "87607260", timestamp: "2026-09-15T10:00:00Z" },
        { value: "92977365", timestamp: "2026-06-01T10:00:00Z" },
      ] },
    });
    assert.equal(c.sdr_owner_id, "87607260");
    assert.equal(c.hubspot_owner_id, "95421364");
    assert.equal(c.allocation_date, "2026-09-15");
    assert.equal(c.allocation_source, "history");
    assert.equal(c.temperature_raw, "Hot");
    const withProp = mapCompany({ id: "2", properties: { sdr_owner: "1", allocation_date: "2026-08-01" } });
    assert.equal(withProp.allocation_date, "2026-08-01");
    assert.equal(withProp.allocation_source, "property");
  });
  test("contact", () => {
    const c = mapContact({ id: "9", properties: { firstname: "Jane", lastname: "Jue", associatedcompanyid: "77", dnc: "true", date_engaged__event_attended_date_: "2026-10-27" } });
    assert.equal(c.company_id, "77");
    assert.equal(c.do_not_contact, true);
    assert.equal(c.attended_date, "2026-10-27");
  });
  test("activities", () => {
    assert.equal(mapActivity("emails", { id: "1", properties: { hs_timestamp: "2026-10-28T14:00:00Z", hs_email_direction: "EMAIL" } })!.kind, "EMAIL");
    assert.equal(mapActivity("emails", { id: "2", properties: { hs_timestamp: "2026-10-28T14:00:00Z", hs_email_direction: "INCOMING_EMAIL" } })!.kind, "INCOMING_EMAIL");
    assert.equal(mapActivity("emails", { id: "3", properties: { hs_timestamp: "2026-10-28T14:00:00Z", hs_email_direction: "FORWARDED_EMAIL" } })!.kind, "OTHER");
    const li = mapActivity("communications", { id: "4", properties: { hs_timestamp: "2026-10-28T14:00:00Z", hs_communication_channel_type: "LINKEDIN_MESSAGE" } })!;
    assert.equal(li.kind, "LINKEDIN");
    assert.equal(li.id, "communications:4");
    assert.equal(mapActivity("communications", { id: "5", properties: { hs_timestamp: "2026-10-28T14:00:00Z", hs_communication_channel_type: "SMS" } })!.kind, "OTHER");
    const task = mapActivity("tasks", { id: "6", properties: { hs_timestamp: "2026-11-30T00:00:00Z", hs_task_status: "COMPLETED", hs_task_type: "LINKED_IN", hs_task_completion_date: "2026-10-29T09:00:00Z" } })!;
    assert.equal(task.ts, "2026-10-29T09:00:00.000Z");
    assert.equal(mapActivity("meetings", { id: "7", properties: { hs_timestamp: "2026-10-28T14:00:00Z", hs_meeting_outcome: "CANCELED" } })!.kind, "OTHER");
    assert.equal(mapActivity("emails", { id: "8", properties: {} }), null);
  });
  test("deals and events", () => {
    const d = mapDeal({ id: "60097042359", properties: { dealname: "Menlo", dealstage: "s1", hs_is_closed: "false", hs_v2_date_entered_144930627: "2026-10-28T10:00:00Z" } }, new Map([["s1", "Scheduled (Sales)"]]), "hs_v2_date_entered_144930627", "x");
    assert.equal(d.mql_date, "2026-10-28");
    assert.equal(d.stage_label, "Scheduled (Sales)");
    assert.equal(d.is_closed, false);
    const e = mapEvent({ id: "1", properties: { marketing_event_name: "Beacon Experience Boston", date_of_the_event: "2026-10-05" } }, { name: "marketing_event_name", date: "date_of_the_event", type: "event_type" }, DEFAULT_RULES);
    assert.equal(e.category, "owned");
  });
  test("attendance snapshot window", () => {
    assert.equal(attendedForEvent("2026-10-27", "2026-10-27", DEFAULT_RULES), "2026-10-27");
    assert.equal(attendedForEvent("2026-10-27", "2026-10-30", DEFAULT_RULES), "2026-10-30");
    assert.equal(attendedForEvent("2026-10-05", "2026-10-27", DEFAULT_RULES), null);
  });
});

function fakeFetch(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const fn = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    calls.push({ url, ...init });
    const r = responses.shift() ?? { status: 200, body: {} };
    return { status: r.status, ok: r.status >= 200 && r.status < 300, headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null }, text: async () => JSON.stringify(r.body ?? {}) };
  };
  return { fn, calls };
}

describe("HubSpot client", () => {
  test("retries 429 with Retry-After and succeeds", async () => {
    const sleeps: number[] = [];
    const f = fakeFetch([{ status: 429, headers: { "retry-after": "2" } }, { status: 200, body: { results: [{ id: "1" }] } }]);
    const c = new HubSpotClient("secret-token", "https://api.test", 100, f.fn, async (ms) => { sleeps.push(ms); });
    const r = await c.batchRead("contacts", ["1"], ["email"]);
    assert.equal(r.length, 1);
    assert.equal(c.stats.retries, 1);
    assert.ok(sleeps.includes(2000));
    assert.equal(f.calls[0]!.headers.Authorization, "Bearer secret-token");
  });
  test("fails after repeated 5xx and does not leak the token in the error", async () => {
    const f = fakeFetch(Array.from({ length: 10 }, () => ({ status: 502, body: { message: "bad gateway" } })));
    const c = new HubSpotClient("secret-token", "https://api.test", 100, f.fn, async () => undefined);
    await assert.rejects(() => c.request("GET", "/crm/v3/owners"), (e: unknown) => e instanceof HubSpotError && !e.message.includes("secret-token"));
    assert.equal(c.stats.failed, 1);
  });
  test("does not retry 4xx client errors", async () => {
    const f = fakeFetch([{ status: 403, body: { message: "missing scope" } }]);
    const c = new HubSpotClient("t", "https://api.test", 100, f.fn, async () => undefined);
    await assert.rejects(() => c.request("GET", "/crm/v3/owners"), /403/);
    assert.equal(f.calls.length, 1);
  });
  test("refuses any POST that is not a search or batch read (read-only guarantee)", async () => {
    const f = fakeFetch([]);
    const c = new HubSpotClient("t", "https://api.test", 100, f.fn, async () => undefined);
    await assert.rejects(() => c.request("POST", "/crm/v3/objects/contacts", {}), /Refusing/);
    await assert.rejects(() => c.request("POST", "/crm/v3/objects/contacts/batch/update", {}), /Refusing/);
    assert.equal(f.calls.length, 0);
  });
  test("association batch read follows per-record paging", async () => {
    const f = fakeFetch([
      { status: 200, body: { results: [{ from: { id: "c1" }, to: [{ toObjectId: 1 }, { toObjectId: 2 }], paging: { next: { after: "x" } } }, { from: { id: "c2" }, to: [{ toObjectId: 2 }] }] } },
      { status: 200, body: { results: [{ toObjectId: 3 }] } },
    ]);
    const c = new HubSpotClient("t", "https://api.test", 100, f.fn, async () => undefined);
    const m = await c.associations("contacts", "emails", ["c1", "c2"]);
    assert.deepEqual(m.get("c1"), ["1", "2", "3"]);
    assert.deepEqual(m.get("c2"), ["2"]);
    assert.match(f.calls[1]!.url, /\/crm\/v4\/objects\/contacts\/c1\/associations\/emails\?limit=500&after=x/);
  });
});

describe("API views", () => {
  const ds = dataset({
    companies: [company(), company({ id: "co2", sdrOwnerId: DISHA, temperatureRaw: "Warm" })],
    contacts: [contact(), contact({ id: "c2", companyId: "co2" })],
    links: [["e1", "c1"], ["e1", "c2"]],
    acts: [act({ ts: "2026-10-02" })],
  });
  const facts = computeLeadFacts(ds, DEFAULT_RULES, "2026-10-30");
  test("unknown filter values are ignored", () => {
    const f = views.parseFilters(new URLSearchParams("region=MARS&category=bogus&temperature=Cold&status=x"));
    assert.equal(f.region, "");
    assert.equal(f.category, "");
    assert.equal(f.temperature, "");
    assert.equal(f.status, "");
  });
  test("overview honours region filter before KPIs and clears off-region SDR", () => {
    const o = views.overview(facts, new URLSearchParams(`region=APAC&sdr=${BOBBI}`), "2026-10-30");
    assert.equal(o.filters.sdrCleared, true);
    assert.equal(o.hot.eligible, 0);
    assert.equal(o.warm.eligible, 1);
    assert.ok(o.sdrs.every((s) => s.region === "APAC"));
    assert.ok(o.comparison);
  });
  test("lead drilldown count equals KPI count", () => {
    const o = views.overview(facts, new URLSearchParams(""), "2026-10-30");
    const l = views.leads(facts, new URLSearchParams("bucket=worked&temperature=Hot"), "2026-10-30", DEFAULT_RULES);
    assert.equal(l.total, o.hot.worked.count);
    const nw = views.leads(facts, new URLSearchParams("bucket=never_worked&temperature=Warm"), "2026-10-30", DEFAULT_RULES);
    assert.equal(nw.total, o.warm.neverWorked.count);
  });
  test("events grouped by category with pre/post split; performance gives quarters", () => {
    const e = views.events(facts, new URLSearchParams("quarter=all"), "2026-10-30");
    assert.equal(e.groups[0]!.category, "roundtable");
    assert.equal(e.groups[0]!.past.length, 1);
    const p = views.performance(facts, new URLSearchParams(""), "2026-10-30");
    assert.equal(p.quarters[0]!.key, "FY2027-Q2");
  });
});
