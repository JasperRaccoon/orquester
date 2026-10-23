import assert from "node:assert/strict";
import test from "node:test";

import {
  IDLE_COMPACTION_LEAD_MS,
  IDLE_COMPACTION_MIN_TOKENS,
  idleCompactionCandidateOf,
  idleCompactionWindow,
  type IdleCompactionCandidate,
  type IdleCompactionTab
} from "./idle-compaction.ts";
import type { ThreadActivityItem, ThreadItem, ThreadMessageItem, Turn } from "./thread.ts";

const EXPIRES = "2026-10-22T11:00:00.000Z";
const EXPIRES_MS = Date.parse(EXPIRES);

let seq = 0;
function stamp(): string {
  seq += 1;
  return new Date(Date.UTC(2026, 9, 22, 10, 0, seq)).toISOString();
}

function activity(activityKind: string, payload: unknown, extra: Partial<ThreadActivityItem> = {}): ThreadActivityItem {
  const at = stamp();
  return { kind: "activity", id: `a${seq}`, tone: "info", activityKind, summary: "row", payload, turnId: "t1", createdAt: at, updatedAt: at, ...extra };
}

function usage(usedTokens: number, extra: Record<string, unknown> = { promptCacheTtlMs: 3_600_000, promptCacheExpiresAt: EXPIRES }): ThreadActivityItem {
  return activity("context-window.updated", { usedTokens, maxTokens: 1_000_000, ...extra });
}

function message(text: string, extra: Partial<ThreadMessageItem> = {}): ThreadMessageItem {
  const at = stamp();
  return { kind: "message", id: `m${seq}`, role: "user", text, turnId: "t1", streaming: false, createdAt: at, updatedAt: at, ...extra };
}

function turn(turnId: string | null, state: Turn["state"]): Turn {
  return {
    turnId,
    state,
    turnCount: null,
    requestedAt: "2026-10-22T10:00:00.000Z",
    startedAt: "2026-10-22T10:00:00.000Z",
    completedAt: state === "running" ? null : "2026-10-22T10:01:00.000Z",
    assistantMessageId: null
  };
}

const TURNS = [turn("t0", "completed"), turn("t1", "completed")];

test("the candidate is the latest completed turn with the newest reading's cache expiry", () => {
  const items: ThreadItem[] = [message("hello"), usage(150_000), usage(250_000), activity("tool.completed", {})];
  assert.deepEqual(idleCompactionCandidateOf(items, TURNS), {
    turnId: "t1",
    usedTokens: 250_000,
    promptCacheExpiresAt: EXPIRES,
    promptCacheTtlMs: 3_600_000
  });
});

test("no candidate unless the latest turn completed", () => {
  const items = [message("hello"), usage(250_000)];
  for (const state of ["running", "pending", "failed", "interrupted", "cancelled"] as const) {
    assert.equal(idleCompactionCandidateOf(items, [turn("t1", state)]), null, state);
  }
  assert.equal(idleCompactionCandidateOf(items, []), null);
  assert.equal(idleCompactionCandidateOf(items, [turn(null, "completed")]), null);
});

test("never a compaction of a compaction: the newest user message is /compact", () => {
  assert.equal(idleCompactionCandidateOf([message("hi"), usage(250_000), message("  /COMPACT ")], TURNS), null);
  assert.equal(idleCompactionCandidateOf([message("/compact"), usage(250_000)], TURNS), null);
  // An older /compact does not count; nor does a subagent's message.
  assert.notEqual(idleCompactionCandidateOf([message("/compact"), message("next"), usage(250_000)], TURNS), null);
  assert.notEqual(
    idleCompactionCandidateOf([message("next"), usage(250_000), message("/compact", { agentId: "sub" })], TURNS),
    null
  );
});

test("a reading without an expiry (served whole from cache, or not Claude) leaves the expiry unknown", () => {
  assert.equal(idleCompactionCandidateOf([message("hi"), usage(250_000, {})], TURNS), null);
  assert.equal(idleCompactionCandidateOf([message("hi"), usage(250_000, { promptCacheExpiresAt: "soon" })], TURNS), null);
  assert.equal(idleCompactionCandidateOf([message("hi")], TURNS), null);
});

test("a restarted session's own context read (outside any turn) keeps the last request's expiry", () => {
  const restartRead = usage(251_000, {});
  restartRead.turnId = null;
  assert.deepEqual(idleCompactionCandidateOf([message("hi"), usage(250_000), restartRead], TURNS), {
    turnId: "t1",
    usedTokens: 251_000,
    promptCacheExpiresAt: EXPIRES,
    promptCacheTtlMs: 3_600_000
  });
  // Inside a turn, a reading without an expiry is a request that wrote no cache: unknown.
  assert.equal(idleCompactionCandidateOf([message("hi"), usage(250_000), usage(251_000, {})], TURNS), null);
  // Out-of-turn reads alone name no expiry.
  assert.equal(idleCompactionCandidateOf([message("hi"), restartRead], TURNS), null);
  // A switch between the request and the restart still voids it.
  assert.equal(
    idleCompactionCandidateOf([message("hi"), usage(250_000), activity("session.identity-changed", {}), restartRead], TURNS),
    null
  );
});

test("a subagent's reading is not the conversation's", () => {
  const items = [message("hi"), usage(250_000), usage(10_000, { promptCacheExpiresAt: EXPIRES, agentId: "sub" })];
  const subRow = items[2] as ThreadActivityItem;
  subRow.agentId = "sub";
  assert.equal(idleCompactionCandidateOf(items, TURNS)?.usedTokens, 250_000);
});

test("a compaction, an account switch or a profile switch after the reading voids it", () => {
  for (const kind of ["context-compaction", "session.identity-changed", "session.profile-changed"]) {
    assert.equal(idleCompactionCandidateOf([message("hi"), usage(250_000), activity(kind, {})], TURNS), null, kind);
  }
  // Before the reading they do not matter.
  assert.notEqual(idleCompactionCandidateOf([message("hi"), activity("session.identity-changed", {}), usage(250_000)], TURNS), null);
});

const CANDIDATE: IdleCompactionCandidate = {
  turnId: "t1",
  usedTokens: 250_000,
  promptCacheExpiresAt: EXPIRES,
  promptCacheTtlMs: 3_600_000
};

function tab(extra: Partial<IdleCompactionTab> = {}): IdleCompactionTab {
  return {
    id: "s1",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    backgroundLiveness: null,
    latestTurn: { turnId: "t1", state: "completed", startedAt: null, completedAt: null },
    chatSessionStatus: "ready",
    goal: null,
    ...extra
  };
}

test("the window is the two minutes before the cache expires, for 1h and 5m lifetimes alike", () => {
  const now = EXPIRES_MS - 30 * 60_000;
  assert.deepEqual(idleCompactionWindow(tab(), CANDIDATE, now), {
    turnId: "t1",
    startMs: EXPIRES_MS - IDLE_COMPACTION_LEAD_MS,
    endMs: EXPIRES_MS
  });
  assert.equal(IDLE_COMPACTION_LEAD_MS, 120_000);
  // Inside the window: still due.
  assert.notEqual(idleCompactionWindow(tab(), CANDIDATE, EXPIRES_MS - 1), null);
  // At or past the expiry: the cache is gone, nothing to save.
  assert.equal(idleCompactionWindow(tab(), CANDIDATE, EXPIRES_MS), null);
  assert.equal(idleCompactionWindow(tab(), CANDIDATE, EXPIRES_MS + 60_000), null);
});

test("every guard keeps the window shut", () => {
  const now = EXPIRES_MS - 10 * 60_000;
  const shut: Array<[string, IdleCompactionTab, IdleCompactionCandidate | null]> = [
    ["no candidate", tab(), null],
    ["under 200k tokens", tab(), { ...CANDIDATE, usedTokens: IDLE_COMPACTION_MIN_TOKENS - 1 }],
    ["a delegate (subagent) chat", tab({ lineage: { relation: "delegate" } }), CANDIDATE],
    ["a workflow's chat", tab({ workflowOwned: true }), CANDIDATE],
    ["a newer turn", tab({ latestTurn: { turnId: "t2", state: "completed", startedAt: null, completedAt: null } }), CANDIDATE],
    ["a turn running", tab({ latestTurn: { turnId: "t1", state: "running", startedAt: null, completedAt: null } }), CANDIDATE],
    ["no turn", tab({ latestTurn: null }), CANDIDATE],
    ["session starting", tab({ chatSessionStatus: "starting" }), CANDIDATE],
    ["session running", tab({ chatSessionStatus: "running" }), CANDIDATE],
    ["a pending approval", tab({ hasPendingApprovals: true }), CANDIDATE],
    ["a pending question", tab({ hasPendingUserInput: true }), CANDIDATE],
    ["a plan to implement", tab({ hasActionableProposedPlan: true }), CANDIDATE],
    ["background work", tab({ backgroundLiveness: "working" }), CANDIDATE],
    ["a watch loop", tab({ backgroundLiveness: "monitoring" }), CANDIDATE],
    ["a continuing goal", tab({ goal: { objective: "x", status: "active", continuing: true } }), CANDIDATE],
    [
      "a queued merge for it",
      tab({ pendingMerges: [{ parentSessionId: "s1", state: "queued" }] }),
      CANDIDATE
    ]
  ];
  for (const [why, input, candidate] of shut) {
    assert.equal(idleCompactionWindow(input, candidate, now), null, why);
  }
  // Exactly at the minimum is enough; a merge this chat sent its parent, a failed one, a fork and a
  // paused goal do not hold it.
  const open: Array<[string, IdleCompactionTab, IdleCompactionCandidate]> = [
    ["200k tokens", tab(), { ...CANDIDATE, usedTokens: IDLE_COMPACTION_MIN_TOKENS }],
    ["its own merge to the parent", tab({ pendingMerges: [{ parentSessionId: "p", state: "queued" }] }), CANDIDATE],
    ["a failed merge", tab({ pendingMerges: [{ parentSessionId: "s1", state: "failed" }] }), CANDIDATE],
    ["a fork", tab({ lineage: { relation: "fork" } }), CANDIDATE],
    ["a paused goal", tab({ goal: { objective: "x", status: "paused", continuing: false } }), CANDIDATE],
    ["a stopped session", tab({ chatSessionStatus: "stopped" }), CANDIDATE]
  ];
  for (const [why, input, candidate] of open) {
    assert.notEqual(idleCompactionWindow(input, candidate, now), null, why);
  }
});
