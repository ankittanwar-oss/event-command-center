import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLooseDate, parseVirtualEvents } from "../src/sheets/virtualEvents.js";

test("virtual events index + per-contact comments", () => {
  assert.equal(parseLooseDate("9 Sept"), "2026-09-09"); assert.equal(parseLooseDate("10/29/2026"), "2026-10-29"); assert.equal(parseLooseDate("14 Oct - Demo Day (IHC)"), "2026-10-14");
  const idx = { title: "Marketing event", rows: [["Date", "Landing Page", "Allocated Sheet", "Marketing event"],
    ["9 Sept", "Customer Webinar - Nicole ducharme (Astronomer GC) and IRfan", "x.xlsx", "https://app.hubspot.com/contacts/7712708/record/2-23538230/61645772391?eschref=x"],
    ["9 Sept", "Counselwell - webinar - Contract Governance Blueprint: Master Your Lifecycle", "y.xlsx", "https://app.hubspot.com/contacts/7712708/record/2-23538230/61649672545?e"],
    ["21 Oct", "ITGC webinar - \nTopic: We Bought a CLM. Now What?", "z", "https://app.hubspot.com/contacts/7712708/record/2-23538230/64507878486"]] };
  const t1 = { title: "9 Sep - Contract Governance Blueprint(Counselwell)", rows: [["Record ID - Contact", "First Name", "Anwesh comments"], ["123", "A", "Evaluating CLMs in Q1"], ["456", "B", ""]] };
  const t2 = { title: "21 Oct - We Bought a CLM. Now What? (ITGC)", rows: [["Record ID - Contact", "Temp", "Assignment Notes"], ["789", "Hot", "Asked for a demo"]] };
  const d = parseVirtualEvents([idx, t1, t2]);
  assert.equal(d.events.length, 3);
  assert.equal(d.events[2]!.topic, "ITGC webinar - We Bought a CLM. Now What?"); assert.equal(d.events[2]!.partner, "ITGC");
  assert.deepEqual(d.notes, [{ eventId: "61649672545", contactId: "123", note: "Evaluating CLMs in Q1" }, { eventId: "64507878486", contactId: "789", note: "Temp: Hot · Asked for a demo" }]);
});
