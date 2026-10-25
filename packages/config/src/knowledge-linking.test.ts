import assert from "node:assert/strict";
import test from "node:test";
import {
  parseKnowledgeLinkingState,
  readKnowledgeLinkingState,
  serializeKnowledgeLinkingState
} from "./knowledge-linking.ts";

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

const NEWER_RUN = {
  id: "kr_9",
  mode: "update",
  startedAt: "2026-10-23T09:00:00.000Z",
  finishedAt: "2026-10-23T09:01:00.000Z",
  durationMs: 60000,
  entries: 1,
  tasks: 2,
  tokensIn: 10,
  tokensOut: 4,
  outcome: "ok",
  error: null,
  verdict: { kept: "by a newer build" }
};

test("a newer version's state reads what this build knows and keeps its version and unknown fields on rewrite", () => {
  const raw = {
    version: 2,
    session: "2026-10-23T08-00-00",
    pendingEntryIds: ["ke_aaaaaaaaaaaa"],
    recentRuns: [NEWER_RUN],
    futureField: { kept: true }
  };
  const read = readKnowledgeLinkingState(structuredClone(raw));
  assert.equal(read.kind, "newer");
  if (read.kind !== "newer") return;
  assert.equal(read.version, 2);
  assert.equal(read.intact, true, "every field this build knows read as written");
  assert.equal(read.state.session, "2026-10-23T08-00-00");
  assert.deepEqual(read.state.recentRuns.map((run) => run.id), ["kr_9"]);
  read.state.pendingEntryIds.push("ke_bbbbbbbbbbbb");
  const written = JSON.parse(serializeKnowledgeLinkingState(read.state, read.version)) as Record<string, unknown>;
  assert.equal(written.version, 2, "the newer version stays on the file");
  assert.deepEqual(written.futureField, { kept: true });
  assert.deepEqual((written.recentRuns as Record<string, unknown>[])[0]!.verdict, { kept: "by a newer build" });
  assert.deepEqual(written.pendingEntryIds, ["ke_aaaaaaaaaaaa", "ke_bbbbbbbbbbbb"]);
});

test("a newer version's state with a known field this build cannot read is not intact", () => {
  for (const bad of [{ session: 42 }, { recentRuns: [NEWER_RUN, "garbage"] }, { pendingEntryIds: "nope" }, { currentRun: { id: "kr_1", mode: "someday", startedAt: "t" } }]) {
    const read = readKnowledgeLinkingState({ version: 3, session: "s1", ...bad });
    assert.equal(read.kind, "newer");
    assert.equal(read.kind === "newer" && read.intact, false, JSON.stringify(bad));
  }
});

test("readKnowledgeLinkingState: a current file reads as current; an older, odd or missing version still throws", () => {
  const read = readKnowledgeLinkingState({ version: 1, session: "s1" });
  assert.equal(read.kind, "current");
  assert.equal(read.state.session, "s1");
  assert.throws(() => readKnowledgeLinkingState({ version: 0 }));
  assert.throws(() => readKnowledgeLinkingState({ version: "2" }));
  assert.throws(() => readKnowledgeLinkingState({ version: 2.5 }));
  assert.throws(() => readKnowledgeLinkingState({ session: "s1" }));
  assert.throws(() => readKnowledgeLinkingState([{ version: 2 }]));
});
