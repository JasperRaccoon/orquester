import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { WORKFLOW_LIMITS } from "@orquester/api";

import { canPin, outputReference, parsePinnedText, pinDraftText, pinnableValue, testStartedNote } from "./inspector-data.ts";
import { node } from "./testing.ts";

describe("canPin", () => {
  it("pins blocks that finish on a plain success output", () => {
    for (const type of ["agent", "code", "shell", "http", "merge", "wait", "workflow"] as const) {
      assert.equal(canPin(node("n", type)), true, type);
    }
  });

  it("never pins triggers, branching blocks, Stop or notes (the engine would ignore the pin)", () => {
    for (const type of ["trigger.manual", "trigger.schedule", "trigger.git", "if", "switch", "stop", "note"] as const) {
      assert.equal(canPin(node("n", type)), false, type);
    }
  });
});

describe("pinDraftText", () => {
  it("starts from the latest output when it is whole", () => {
    assert.equal(pinDraftText({ output: { text: "hi" } }), '{\n  "text": "hi"\n}');
    assert.equal(pinDraftText({ output: 0 }), "0");
    assert.equal(pinDraftText({ output: null }), "{}", "null can't be pinned, so it is no starting point");
  });

  it("starts from an empty object without an output, or with only a preview", () => {
    assert.equal(pinDraftText(undefined), "{}");
    assert.equal(pinDraftText({}), "{}");
    assert.equal(pinDraftText({ output: "prev…", outputTruncated: true }), "{}");
  });
});

describe("parsePinnedText limits", () => {
  it("refuses JSON over the pinned-data limit", () => {
    const big = JSON.stringify("x".repeat(WORKFLOW_LIMITS.maxPinnedBytes));
    const parsed = parsePinnedText(big);
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? "" : parsed.error, /Too big to pin: pinned data is limited to 1024 KiB/);
  });

  it("refuses null, which set_pinned would read as unpin", () => {
    const parsed = parsePinnedText(" null ");
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? "" : parsed.error, /null can't be pinned/);
    assert.deepEqual(parsePinnedText("false"), { ok: true, value: false });
    assert.deepEqual(parsePinnedText("0"), { ok: true, value: 0 });
  });

  it("explains a syntax error", () => {
    const parsed = parsePinnedText('{ "a": }');
    assert.equal(parsed.ok, false);
    assert.match(parsed.ok ? "" : parsed.error, /^Not valid JSON: /);
  });
});

describe("outputReference / testStartedNote", () => {
  it("writes the template reference to a block's output", () => {
    assert.equal(outputReference("Review"), "{{ nodes.Review.output }}");
  });

  it("says why a test did not start, in words", () => {
    assert.equal(testStartedNote({ runId: "r1" }), "Test run started.");
    assert.match(testStartedNote({ runId: null, skipped: "overlap" }), /already running/);
    assert.match(testStartedNote({ runId: null }), /no run/);
  });
});

describe("pinnableValue", () => {
  it("anything but null / undefined", () => {
    assert.deepEqual([null, undefined, 0, false, "", {}].map(pinnableValue), [false, false, true, true, true, true]);
  });
});
