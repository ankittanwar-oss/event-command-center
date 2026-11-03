import { test } from "node:test";
import assert from "node:assert/strict";
import { mapIntent } from "../src/hubspot/mappers.js";

test("Phillips 66 (live HubSpot values) maps to the dashboard's account-intent fields", () => {
  // Raw API values as returned by HubSpot on 3 Nov 2026 for company 10412590716.
  const p = { account_type: "Warm Account", newtags___sdr: "3rd Party Signals", tam_bucket: "Sales Ready", icp_category_20: "Targetable - Tier 2",
    total_engagement_score: "1.875", unify_intent_level: "", date_entered__warm_stage_: "1790035200000", latest_clay_signal_reason: "" };
  const labels = { tam_bucket: new Map([["Sales Ready", "Sales Ready Account"]]) };
  const i = mapIntent(p, labels);
  assert.equal(i.level, "Warm"); assert.equal(i.raw, "Warm Account"); assert.equal(i.since, "2026-09-22");
  assert.equal(i.sdrCategory, "3rd Party Signals"); assert.equal(i.lifecycleCustom, "Sales Ready Account");
  assert.equal(i.icp, "Targetable - Tier 2"); assert.equal(i.engagementScore, 1.875);
  assert.equal(i.factorsIntent, null); assert.equal(i.reason, null);
});
