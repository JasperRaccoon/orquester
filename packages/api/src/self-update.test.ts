import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSelfUpdateRun } from "./self-update.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";

test("parseSelfUpdateRun reads the updater's status record and keeps only valid fields", () => {
  assert.deepEqual(
    parseSelfUpdateRun({ state: "reverted", from: SHA, startedAt: "s", finishedAt: "f", exitCode: 3, extra: 1 }),
    { state: "reverted", from: SHA, startedAt: "s", finishedAt: "f", exitCode: 3 }
  );
  assert.deepEqual(parseSelfUpdateRun({ state: "running", from: "", startedAt: "s", exitCode: "3" }), {
    state: "running",
    from: null,
    startedAt: "s"
  });
});

test("parseSelfUpdateRun rejects what is not a run", () => {
  for (const value of [null, "running", [], {}, { state: "exploded", startedAt: "s" }, { state: "running" }]) {
    assert.equal(parseSelfUpdateRun(value), null);
  }
});
