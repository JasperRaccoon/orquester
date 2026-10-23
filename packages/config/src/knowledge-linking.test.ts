import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyKnowledgeLinkingState,
  parseKnowledgeLinkingState,
  serializeKnowledgeLinkingState
} from "./knowledge-linking.ts";

test("an empty state round-trips", () => {
  const state = emptyKnowledgeLinkingState();
  assert.deepEqual(parseKnowledgeLinkingState(JSON.parse(serializeKnowledgeLinkingState(state))), state);
});

test("a bad field costs that field only; unknown fields and records survive", () => {
  const parsed = parseKnowledgeLinkingState({
    version: 1,
    session: 42,
    pendingSince: "2026-10-23T10:00:00.000Z",
    pendingEntryIds: "nope",
    futureField: { kept: true },
    currentRun: { id: "kr_1", mode: "update", startedAt: "t", session: "s1", entryIds: ["ke_a"], pid: -3, extra: 1 },
    recentRuns: [
      { id: "kr_0", mode: "full", startedAt: "t0", finishedAt: "t1", durationMs: 5, entries: 2, tasks: 3, tokensIn: 10, tokensOut: 4, outcome: "ok", error: null },
      { id: "", mode: "full" },
      "garbage"
    ],
    tokens: { total: { in: 5, out: "x" }, byDay: { "2026-10-23": { in: 1, out: 2 } } },
    lastError: { message: "boom", at: "t" }
  });
  assert.equal(parsed.session, null);
  assert.deepEqual(parsed.pendingEntryIds, []);
  assert.equal(parsed.pendingSince, "2026-10-23T10:00:00.000Z");
  assert.deepEqual((parsed as Record<string, unknown>).futureField, { kept: true });
  assert.equal(parsed.currentRun?.pid, null);
  assert.equal((parsed.currentRun as Record<string, unknown> | null)?.extra, 1);
  assert.deepEqual(parsed.recentRuns.map((run) => run.id), ["kr_0"]);
  assert.deepEqual(parsed.tokens.total, { in: 5, out: 0 });
  assert.equal(parsed.lastError?.message, "boom");
  assert.equal(parsed.rebuildRequested, false);
});

test("not a version-1 object throws (the caller keeps the file aside)", () => {
  assert.throws(() => parseKnowledgeLinkingState({ version: 2 }));
  assert.throws(() => parseKnowledgeLinkingState("x"));
});
