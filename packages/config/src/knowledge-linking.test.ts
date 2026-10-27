import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyKnowledgePairChecksFile,
  parseKnowledgeLinkingState,
  readKnowledgePairChecksFile,
  serializeKnowledgePairChecksFile,
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

test("re-linking state: absent from an older file reads empty; a bad part costs only that part; unknown fields survive", () => {
  const older = parseKnowledgeLinkingState({ version: 1, session: "s" });
  assert.deepEqual(older.relink, { done: 0, gapQueue: [], gapPairs: {}, prepared: [], attempts: {} });
  const parsed = parseKnowledgeLinkingState({
    version: 1,
    relink: { done: 3, gapQueue: "nope", gapPairs: { "ke_a ke_b": "h1 h2" }, prepared: ["ke_c"], future: 1 },
    currentRun: { id: "kr_1", mode: "update", startedAt: "t", session: "s1", entryIds: ["ke_c"], relinkEntryIds: ["ke_c"] }
  });
  assert.deepEqual(parsed.relink, { done: 3, gapQueue: [], gapPairs: { "ke_a ke_b": "h1 h2" }, prepared: ["ke_c"], attempts: {}, future: 1 });
  assert.deepEqual(parsed.currentRun?.relinkEntryIds, ["ke_c"]);
  const noRelink = parseKnowledgeLinkingState({ version: 1, currentRun: { id: "kr_1", mode: "update", startedAt: "t", relinkEntryIds: 5 } });
  assert.equal(noRelink.currentRun?.relinkEntryIds, undefined, "a bad value reads as none");
  assert.deepEqual(parseKnowledgeLinkingState({ version: 1, relink: "x" }).relink.prepared, []);
  assert.deepEqual(JSON.parse(serializeKnowledgeLinkingState(parsed)).relink.future, 1);
});

test("re-link attempts and a run's context entries: read tolerantly, an unreadable attempt dropped alone, written back", () => {
  const parsed = parseKnowledgeLinkingState({
    version: 1,
    relink: {
      attempts: {
        ke_a: { version: 1, contentHash: "h1", failures: 0, by: "future" },
        ke_b: { version: 1, contentHash: "h2", failures: "two" },
        ke_c: { version: "1", contentHash: "h3", failures: 0 },
        ke_d: "x",
        ["__proto__"]: { version: 1, contentHash: "h4", failures: 2 }
      }
    },
    currentRun: { id: "kr_1", mode: "update", startedAt: "t", contextEntryIds: ["ke_a"] }
  });
  assert.deepEqual(Object.keys(parsed.relink.attempts).sort(), ["__proto__", "ke_a", "ke_b"]);
  assert.deepEqual(parsed.relink.attempts.ke_a, { version: 1, contentHash: "h1", failures: 0, by: "future" });
  assert.deepEqual(parsed.relink.attempts.ke_b, { version: 1, contentHash: "h2", failures: 0 }, "a bad count reads as 0");
  assert.equal(Object.getPrototypeOf(parsed.relink.attempts), Object.prototype);
  assert.deepEqual(parsed.currentRun?.contextEntryIds, ["ke_a"]);
  assert.equal(parseKnowledgeLinkingState({ version: 1, currentRun: { id: "kr_1", mode: "update", startedAt: "t", contextEntryIds: 3 } }).currentRun?.contextEntryIds, undefined);
  assert.deepEqual(parseKnowledgeLinkingState({ version: 1, relink: { attempts: [1] } }).relink.attempts, {});
  const again = parseKnowledgeLinkingState(JSON.parse(serializeKnowledgeLinkingState(parsed)));
  assert.deepEqual(again.relink.attempts, parsed.relink.attempts);
});

test("pair-checks.json: unreadable records and unknown keys are kept for the rewrite; a newer file is read-only", () => {
  const record = { a: "ke_a", b: "ke_b", hashA: "h1", hashB: "h2", verdict: "contradicts", note: "48h vs 72h", checkedAt: "t", model: "x" };
  const file = readKnowledgePairChecksFile({ version: 1, checks: [record, { a: "ke_c", verdict: "maybe" }], future: { kept: true } });
  assert.equal(file.readOnly, false);
  assert.deepEqual(file.checks, [record]);
  assert.deepEqual(file.rejected, [{ a: "ke_c", verdict: "maybe" }]);
  assert.deepEqual(JSON.parse(serializeKnowledgePairChecksFile(file)), { version: 1, checks: [record, { a: "ke_c", verdict: "maybe" }], future: { kept: true } });
  assert.deepEqual(readKnowledgePairChecksFile("garbage"), emptyKnowledgePairChecksFile());
  const newer = readKnowledgePairChecksFile({ version: 2, checks: [record] });
  assert.equal(newer.readOnly, true);
  assert.deepEqual(newer.attempts, [], "an older file has no attempts");
  assert.equal(newer.version, 2);
  assert.equal(newer.checks.length, 1);
});

test("pair-checks.json: a check's input version reads when valid, an older record has none, a bad one costs only the field", () => {
  const base = { a: "ke_a", b: "ke_b", hashA: "h1", hashB: "h2", verdict: "consistent", note: "n", checkedAt: "t" };
  const file = readKnowledgePairChecksFile({
    version: 1,
    checks: [base, { ...base, b: "ke_c", inputVersion: 2, future: true }, { ...base, b: "ke_d", inputVersion: "two" }, { ...base, b: "ke_e", inputVersion: 0 }]
  });
  assert.equal(file.rejected.length, 0, "every record stays readable");
  assert.deepEqual(
    file.checks.map((c) => [c.b, c.inputVersion]),
    [
      ["ke_b", undefined],
      ["ke_c", 2],
      ["ke_d", undefined],
      ["ke_e", undefined]
    ]
  );
  assert.equal("inputVersion" in file.checks[0]!, false, "an older record is not given one");
  const written = JSON.parse(serializeKnowledgePairChecksFile(file)) as { checks: Record<string, unknown>[] };
  assert.deepEqual(written.checks[0], base, "an older record is written as it was");
  assert.deepEqual(written.checks[1], { ...base, b: "ke_c", inputVersion: 2, future: true }, "unknown fields kept");
});

test("pair-checks.json: round task attempts read tolerantly, unknown fields and unreadable records kept for the rewrite", () => {
  const attempt = { key: "pair ke_a ke_b h1 h2", step: "pair-check", label: "pair-check ke_a ke_b", failures: 2, lastAt: "t", gaveUpAt: null, model: "x" };
  const given = { key: "abc", step: "cluster-name", failures: 3, lastAt: "t", gaveUpAt: "t2" };
  const file = readKnowledgePairChecksFile({ version: 1, checks: [], attempts: [attempt, given, { key: "", failures: -1 }] });
  assert.deepEqual(file.attempts, [attempt, { ...given, label: "" }]);
  assert.deepEqual(file.rejectedAttempts, [{ key: "", failures: -1 }]);
  assert.deepEqual(JSON.parse(serializeKnowledgePairChecksFile(file)).attempts, [attempt, { ...given, label: "" }, { key: "", failures: -1 }]);
  assert.equal("attempts" in JSON.parse(serializeKnowledgePairChecksFile(emptyKnowledgePairChecksFile())), false, "no attempts: no key");
  const odd = readKnowledgePairChecksFile({ version: 1, checks: [], attempts: "not a list" });
  assert.deepEqual(odd.attempts, []);
  assert.equal(JSON.parse(serializeKnowledgePairChecksFile(odd)).attempts, "not a list", "kept as it was");
});
