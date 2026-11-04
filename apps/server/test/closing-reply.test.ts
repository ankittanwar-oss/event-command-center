import { test } from "node:test";
import assert from "node:assert/strict";
import { isClosingReply } from "../src/hubspot/mappers.js";

test("thank-you / closing replies are not treated as replies waiting on the SDR", () => {
  assert.equal(isClosingReply("So sweet, thank you Spotdraft team :) On Fri, Oct 23, 2026 at 3:37 PM Jessica Rosen wrote: &gt; Hi Constance"), true); // Atoms
  assert.equal(isClosingReply("Great, thanks!"), true);
});
test("replies with a question, a request or real content still count", () => {
  assert.equal(isClosingReply("Thanks! Can we set up a call next week?"), false);
  assert.equal(isClosingReply("Thanks, interested in a demo"), false);
  assert.equal(isClosingReply("Hi Bobbi, Happy Friday! That is so kind -- a small concession since I was so bummed I couldn't attend! My mailing address is: 399 Clermont Ave #4 Brooklyn"), false);
  assert.equal(isClosingReply(null), false);
});
