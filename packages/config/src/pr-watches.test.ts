import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePullRequestWatchFile, pullRequestWatchesPath, serializePullRequestWatchFile } from "./index.ts";

const good = {
  id: "w1",
  sessionId: "s1",
  projectPath: "/ws/a/p",
  repoUrl: "https://github.com/o/r",
  repository: "o/r",
  number: 7,
  url: "https://github.com/o/r/pull/7",
  startedAt: "2026-10-14T10:00:00.000Z",
  told: { remarksThrough: "2026-10-14T10:00:00.000Z" }
};

test("pr-watches path sits in the daemon dir", () => {
  assert.equal(pullRequestWatchesPath("/home/u/.orquester"), "/home/u/.orquester/daemon/pr-watches.json");
});

test("a minimal watch reads with every progress field defaulted", () => {
  const file = parsePullRequestWatchFile({ watches: [good] });
  assert.equal(file.unreadable.length, 0);
  const watch = file.watches[0]!;
  assert.deepEqual(watch.told, {
    remarksThrough: "2026-10-14T10:00:00.000Z",
    headSha: null,
    failedChecks: [],
    passed: false,
    passedChecks: [],
    remarkIds: [],
    conflicting: false,
    wakes: 0
  });
  assert.equal(watch.pendingWake, null);
  assert.equal(watch.endedAt, null);
  assert.equal(watch.failures, 0);
  assert.equal(watch.lastStatus, null);
});

test("malformed entries are kept verbatim, unknown fields survive, bad progress falls back", () => {
  const broken = { id: "w2", number: "seven" };
  const file = parsePullRequestWatchFile({
    watches: [
      { ...good, futureField: { x: 1 }, failures: "many", lastStatus: 3, endReason: "exploded" },
      broken
    ]
  });
  assert.equal(file.watches.length, 1);
  assert.deepEqual(file.unreadable, [broken]);
  const watch = file.watches[0] as Record<string, unknown>;
  assert.deepEqual(watch.futureField, { x: 1 });
  assert.equal(watch.failures, 0);
  assert.equal(watch.lastStatus, null);
  assert.equal(watch.endReason, null);
  const round = JSON.parse(serializePullRequestWatchFile(file)) as { version: number; watches: unknown[] };
  assert.equal(round.version, 1);
  assert.equal(round.watches.length, 2);
  assert.deepEqual(round.watches[1], broken);
  assert.deepEqual((round.watches[0] as Record<string, unknown>).futureField, { x: 1 });
});

test("anything that is not a watch file reads as empty", () => {
  for (const value of [null, 3, "x", { watches: "no" }, []]) {
    assert.deepEqual(parsePullRequestWatchFile(value), { watches: [], unreadable: [] });
  }
});
