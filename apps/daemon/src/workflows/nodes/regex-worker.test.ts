import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { sharedRegexMatcher } from "./regex-worker.ts";

describe("the matches operator runs in a worker with a hard timeout", () => {
  const matcher = sharedRegexMatcher();
  after(() => matcher.close());

  test("an ordinary pattern answers", async () => {
    assert.deepEqual(await matcher.match({ source: "^fe(at)?", flags: "i", text: "Feature/x" }), { result: true });
    assert.deepEqual(await matcher.match({ source: "^fix", flags: "", text: "feature/x" }), { result: false });
  });

  test("a catastrophic pattern is stopped at the deadline, the loop stays free, and the next search works", async () => {
    let loopProgress = false;
    const probe = setImmediate(() => { loopProgress = true; });
    const slow = await matcher.match({ source: "a*a*a*a*a*a*a*b", flags: "", text: "a".repeat(100_000) })
      .finally(() => clearImmediate(probe));
    assert.equal(slow.result, false);
    assert.match(slow.warning ?? "", /pattern took longer than \d+ ms to search and was stopped/);
    assert.ok(loopProgress, "the event loop progresses before the search settles");
    assert.deepEqual(await matcher.match({ source: "b$", flags: "", text: "ab" }), { result: true }, "a fresh worker answers");
  });
});
