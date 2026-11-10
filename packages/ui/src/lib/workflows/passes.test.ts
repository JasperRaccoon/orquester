import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { WorkflowBlockRun } from "@orquester/api";

import { blockAtPass, latestPassOf, passChips, passNotes, shownPass } from "./passes.ts";
import { node } from "./testing.ts";

const review = node("rev", "if", {}, { name: "Review" });

const looped: WorkflowBlockRun = {
  nodeId: "rev",
  name: "Review",
  type: "if",
  status: "running",
  attempt: 3,
  pass: 3,
  startedAt: "2026-11-10T10:10:00.000Z",
  sessionId: "s3",
  sessionNote: "new chat: previous session unavailable (archived)",
  loopFeedback: "  Tests still fail on CI  ",
  passes: [
    {
      pass: 1,
      status: "succeeded",
      attempt: 1,
      handle: "false",
      startedAt: "2026-11-10T10:00:00.000Z",
      endedAt: "2026-11-10T10:04:00.000Z",
      sessionId: "s1",
      output: { result: false }
    },
    { pass: 2, status: "failed", attempt: 2, handle: "error", sessionId: "s2", error: { kind: "agent_error", message: "Boom" } }
  ]
};

describe("block passes", () => {
  it("the latest pass: `pass`, else one more than those kept", () => {
    assert.equal(latestPassOf(looped), 3);
    assert.equal(latestPassOf({ passes: [{ pass: 1, status: "succeeded", attempt: 1 }] }), 2);
    assert.equal(latestPassOf({}), 1);
    assert.equal(latestPassOf(undefined), 1);
  });

  it("one pass as a block record: the block's identity, that pass's state", () => {
    const first = blockAtPass(looped, 1)!;
    assert.equal(first.nodeId, "rev");
    assert.equal(first.name, "Review");
    assert.equal(first.type, "if");
    assert.equal(first.status, "succeeded");
    assert.equal(first.sessionId, "s1");
    assert.deepEqual(first.output, { result: false });
    assert.equal(first.passes, undefined);
    assert.equal(first.sessionNote, undefined, "an earlier pass's notes are its own");
    assert.equal(blockAtPass(looped, 2)!.error?.message, "Boom");
  });

  it("the latest pass is the block itself — for null, its number, or a pass not kept", () => {
    assert.equal(blockAtPass(looped, null), looped);
    assert.equal(blockAtPass(looped, 3), looped);
    assert.equal(blockAtPass(looped, 9), looped);
    assert.equal(blockAtPass(undefined, 1), undefined);
  });

  it("a selection follows the latest pass until an earlier one is picked", () => {
    assert.equal(shownPass(looped, null), 3);
    assert.equal(shownPass(looped, 1), 1);
    assert.equal(shownPass(looped, 7), 3, "a pass the run does not have shows the latest");
  });

  it("chips: one per pass, oldest first, with the state and the handle each ended on", () => {
    const now = Date.parse("2026-11-10T10:12:00.000Z");
    const chips = passChips(looped, review, now);
    assert.deepEqual(
      chips.map((chip) => [chip.label, chip.latest, chip.view.label]),
      [
        ["#1", false, "Succeeded"],
        ["#2", false, "Failed"],
        ["#3", true, "Running"]
      ]
    );
    assert.equal(chips[0]!.description, "Pass 1 · Succeeded · false");
    assert.equal(chips[0]!.durationMs, 4 * 60_000);
    assert.equal(chips[1]!.description, "Pass 2 · Failed · failure");
    assert.equal(chips[2]!.durationMs, 2 * 60_000, "the running pass ticks");
  });

  it("no chips for a block that ran once", () => {
    assert.deepEqual(passChips({ ...looped, pass: undefined, passes: undefined }, review, 0), []);
    assert.deepEqual(passChips(undefined, review, 0), []);
  });

  it("notes: the feedback the loop carried in, and why it is in a new chat", () => {
    assert.deepEqual(passNotes(looped), {
      feedback: "Tests still fail on CI",
      sessionNote: "new chat: previous session unavailable (archived)"
    });
    assert.deepEqual(passNotes({ loopFeedback: "   " }), { feedback: null, sessionNote: null });
  });
});
