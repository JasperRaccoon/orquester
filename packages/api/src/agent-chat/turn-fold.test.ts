/**
 * `applyTurnEvent` — the fold's turn arms on their own (design 2026-09-23
 * "thread index and lazy boot": the thread index numbers turns with it).
 *
 * It is the same code the fold runs for `turns`, fed only what `turns` and the
 * event hold. Four arms also read the rest of the fold; the parity below holds
 * for every log in which those four do not come into play, and the tests after
 * it pin what each of them does when they do.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";

import type { DomainEvent } from "./domain-events.ts";
import { applyDomainEvent, applyTurnEvent, createEmptyThreadState, foldThread } from "./fold.ts";
import type { Turn } from "./thread.ts";
import { activity, created, ev, resetActivityIds, resetSeq, session } from "./test-helpers.ts";

function reset(): void {
  resetSeq();
  resetActivityIds();
}

/** The turn-only fold, spelled exactly as the plan pins it. */
function turnFold(events: readonly DomainEvent[]): Turn[] {
  return events.reduce<Turn[]>((turns, event) => applyTurnEvent(turns, event), []);
}

/** Every event index after which the turn-only fold and the fold's turns disagree. */
function divergences(
  events: readonly DomainEvent[],
  project: (turns: Turn[]) => unknown = (turns) => turns
): number[] {
  let turns: Turn[] = [];
  let state = createEmptyThreadState();
  const diverged: number[] = [];
  events.forEach((event, index) => {
    turns = applyTurnEvent(turns, event);
    state = applyDomainEvent(state, event);
    if (!isDeepStrictEqual(turns, project(state.turns))) {
      diverged.push(index);
    }
  });
  return diverged;
}

const OPUS = { model: "opus" };
const USAGE = {
  usageScope: "main_agent" as const,
  usageStatus: "complete" as const,
  inputTokens: 10,
  outputTokens: 20,
  hasSubagents: false
};

function diff(turnCount: number, turnId: string | null, assistantMessageId: string | null = null) {
  return ev("thread.turn-diff-completed", {
    turnCount,
    turnId,
    ref: `refs/orquester/checkpoints/x/turn/${turnCount}`,
    status: "ready",
    files: [],
    assistantMessageId,
    completedAt: `2026-02-0${turnCount}T00:00:00.000Z`
  });
}

/**
 * Every turn arm of the fold, in the order a real thread meets them. Every
 * turn start names its model (see "a turn start that names no model").
 */
function turnLog(): DomainEvent[] {
  reset();
  return [
    created(),
    // 1. A live turn: pending, adopted, answered, settled with usage, captured.
    ev("thread.message-sent", { messageId: "user:1", role: "user", text: "one", streaming: false, turnId: null }),
    ev("thread.turn-start-requested", {
      turnId: null,
      messageId: "user:1",
      interactionMode: "default",
      modelSelection: OPUS
    }),
    ev("thread.session-set", { session: session("running", "T-1") }),
    // Reasoning and a subagent's prose never become the turn's anchor…
    ev("thread.message-sent", { messageId: "reasoning:1", role: "reasoning", text: "hmm", streaming: true, turnId: "T-1" }),
    ev("thread.message-sent", {
      messageId: "assistant:1:sub",
      role: "assistant",
      text: "sub",
      streaming: false,
      turnId: "T-1",
      agentId: "sub"
    }),
    // …the first assistant message of the turn does, and a later one does not.
    ev("thread.message-sent", { messageId: "assistant:1", role: "assistant", text: "Hel", streaming: true, turnId: "T-1" }),
    ev("thread.message-sent", { messageId: "assistant:1", role: "assistant", text: "lo", streaming: true, turnId: "T-1" }),
    ev("thread.message-sent", { messageId: "assistant:1", role: "assistant", text: "", streaming: false, turnId: "T-1" }),
    ev("thread.message-sent", { messageId: "assistant:1b", role: "assistant", text: "more", streaming: false, turnId: "T-1" }),
    ev("thread.activity-appended", { activity: activity("tool.completed", { toolUseId: "tu" }, { turnId: "T-1" }) }),
    ev("thread.session-set", {
      session: session("ready", null),
      turn: { turnId: "T-1", tokenUsage: USAGE, totalCostUsd: 0.5 }
    }),
    diff(1, "T-1", "assistant:1"),
    // 2. A turn replayed from the provider's transcript, already over.
    ev("thread.turn-start-requested", {
      turnId: "H-1",
      messageId: "",
      interactionMode: "default",
      modelSelection: OPUS,
      settled: {
        state: "completed",
        completedAt: "2026-01-01T00:00:00.000Z",
        tokenUsage: USAGE,
        assistantMessageId: "history:assistant"
      }
    }),
    // 3. A turn-less answer anchors the pending turn; then it is interrupted.
    ev("thread.message-sent", { messageId: "user:3", role: "user", text: "three", streaming: false, turnId: null }),
    ev("thread.turn-start-requested", {
      turnId: null,
      messageId: "user:3",
      interactionMode: "plan",
      modelSelection: { model: "sonnet" }
    }),
    ev("thread.message-sent", { messageId: "assistant:3", role: "assistant", text: "early", streaming: false, turnId: null }),
    ev("thread.session-set", { session: session("running", "T-3") }),
    ev("thread.turn-interrupt-requested", { turnId: "T-3" }),
    ev("thread.session-set", { session: session("stopped", null) }),
    // 4. A turn the host never commanded (a continuation), which fails.
    ev("thread.session-set", { session: session("running", "T-cont") }),
    ev("thread.session-set", { session: session("error", null, { lastError: "boom" }) }),
    // 5. A turn requested under a known id: running at once, adoption a no-op.
    ev("thread.turn-start-requested", {
      turnId: "T-5",
      messageId: "user:5",
      interactionMode: "default",
      modelSelection: OPUS
    }),
    ev("thread.session-set", { session: session("running", "T-5") }),
    // A settle naming an already-settled turn never rewrites its numbers.
    ev("thread.session-set", { session: session("ready", null), turn: { turnId: "T-1", totalCostUsd: 99 } }),
    diff(2, "T-5"),
    diff(3, null),
    // An event type this build has never heard of (a newer host wrote it).
    { ...ev("thread.meta-updated", {}), type: "thread.from-the-future" } as unknown as DomainEvent,
    // 6. A rewind to the first two started turns.
    ev("thread.checkpoint-revert-requested", { targetTurnCount: 2 }),
    ev("thread.reverted", { turnCount: 2 }),
    // 7. Life after the rewind, then a rewind to nothing.
    ev("thread.message-sent", { messageId: "user:7", role: "user", text: "seven", streaming: false, turnId: null }),
    ev("thread.turn-start-requested", {
      turnId: null,
      messageId: "user:7",
      interactionMode: "default",
      modelSelection: OPUS
    }),
    ev("thread.session-set", { session: session("running", "T-7") }),
    ev("thread.message-sent", { messageId: "assistant:7", role: "assistant", text: "after", streaming: false, turnId: "T-7" }),
    ev("thread.session-set", { session: session("ready", null) }),
    diff(3, "T-7", "assistant:7"),
    ev("thread.reverted", { turnCount: -1 })
  ];
}

// --- parity ------------------------------------------------------------------

test("foldThread(events).turns equals the reduce of applyTurnEvent — after every event", () => {
  const events = turnLog();
  assert.deepEqual(divergences(events), []);
  assert.deepEqual(turnFold(events), foldThread(events).turns);
});

test("the log really exercises every turn arm", () => {
  const events = turnLog();
  const beforeRevert = foldThread(events.slice(0, events.findIndex((e) => e.type === "thread.reverted")));
  assert.deepEqual(
    beforeRevert.turns.map((turn) => [
      turn.turnId,
      turn.state,
      turn.turnCount,
      turn.assistantMessageId,
      turn.userMessageId ?? null,
      turn.totalCostUsd ?? null
    ]),
    [
      ["T-1", "completed", 1, "assistant:1", "user:1", 0.5],
      ["H-1", "completed", null, "history:assistant", null, null],
      ["T-3", "interrupted", null, "assistant:3", "user:3", null],
      ["T-cont", "failed", null, null, null, null],
      ["T-5", "completed", 2, null, "user:5", null]
    ]
  );
  const afterFirstRevert = foldThread(
    events.slice(0, events.findIndex((e) => e.type === "thread.reverted") + 1)
  );
  assert.deepEqual(afterFirstRevert.turns.map((turn) => turn.turnId), ["T-1", "H-1"]);
  const beforeLast = foldThread(events.slice(0, -1));
  assert.deepEqual(beforeLast.turns.map((turn) => [turn.turnId, turn.turnCount]), [
    ["T-1", 1],
    ["H-1", null],
    ["T-7", 3]
  ]);
  assert.deepEqual(foldThread(events).turns, []);
});

test("an event that moves no turn returns the same array, and the input is never mutated", () => {
  const events = turnLog();
  let turns: Turn[] = [];
  let unchanged = 0;
  for (const event of events) {
    const frozen = deepFreeze(turns);
    const next = applyTurnEvent(frozen, event);
    const moved = !isDeepStrictEqual(next, turns);
    if (!moved) {
      assert.equal(next, frozen, `${event.type} (seq ${event.seq}) moved nothing: same array`);
      unchanged += 1;
    }
    turns = next;
  }
  assert.ok(unchanged >= 10, "the log has plenty of turn-neutral events");
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const field of Object.values(value as Record<string, unknown>)) {
      deepFreeze(field);
    }
  }
  return value;
}

// --- the four arms that read the rest of the fold -----------------------------

test("a turn start that names no model: the fold inherits the head's, applyTurnEvent records none", () => {
  // The host's usual case (`/answer` and history replay never name one). The
  // head is not in `turns`, so the turn-only fold cannot inherit it; every
  // other field still agrees, after every event.
  const events = turnLog().map((event) => {
    if (event.type !== "thread.turn-start-requested") return event;
    const { modelSelection: _unnamed, ...payload } = event.payload;
    return { ...event, payload };
  });
  const withoutModel = (turns: Turn[]): Turn[] => turns.map(({ model: _model, ...turn }) => turn);
  assert.deepEqual(divergences(events, withoutModel), []);

  const firstTurn = events.slice(0, events.findIndex((e) => e.type === "thread.reverted"));
  assert.equal(foldThread(firstTurn).turns[0]?.model, "sonnet", "the fold: the head's model");
  assert.equal("model" in turnFold(firstTurn)[0]!, false, "applyTurnEvent: none");
});

test("a checkpoint the fold refuses (a missing placeholder over a ready capture) moves no turn in the fold only", () => {
  reset();
  const events = [
    created(),
    ev("thread.turn-start-requested", { turnId: "T-1", messageId: "u", interactionMode: "default", modelSelection: OPUS }),
    ev("thread.session-set", { session: session("ready", null) }),
    diff(1, "T-1", "assistant:real"),
    ev("thread.turn-diff-completed", {
      turnCount: 2,
      turnId: "T-1",
      ref: "provider-diff:e9",
      status: "missing",
      files: [],
      assistantMessageId: "assistant:placeholder",
      completedAt: "2026-02-09T00:00:00.000Z"
    })
  ];
  const folded = foldThread(events).turns[0]!;
  assert.deepEqual([folded.turnCount, folded.assistantMessageId], [1, "assistant:real"]);
  // The turn-only fold cannot see the checkpoint list, so it stamps the placeholder.
  const alone = turnFold(events)[0]!;
  assert.deepEqual([alone.turnCount, alone.assistantMessageId], [2, "assistant:placeholder"]);
});

test("a delta merges onto its message's first role and owner in the fold; applyTurnEvent reads the delta", () => {
  reset();
  const events = [
    created(),
    ev("thread.turn-start-requested", { turnId: "T-1", messageId: "u", interactionMode: "default", modelSelection: OPUS }),
    ev("thread.message-sent", { messageId: "m", role: "reasoning", text: "a", streaming: true, turnId: "T-1" }),
    ev("thread.message-sent", { messageId: "m", role: "assistant", text: "b", streaming: true, turnId: "T-1" })
  ];
  assert.equal(foldThread(events).turns[0]?.assistantMessageId, null, "the row stays reasoning");
  assert.equal(turnFold(events)[0]?.assistantMessageId, "m");
});

test("a legacy rewind (no started turn, only checkpoints) synthesises the latest turn in the fold only", () => {
  reset();
  // A log written before turns were recorded: the fold falls back to the
  // checkpoint list, which the turn-only fold does not have.
  const events = [created(), diff(1, "T-1"), diff(2, "T-2"), ev("thread.reverted", { turnCount: 1 })];
  assert.deepEqual(foldThread(events).turns.map((turn) => [turn.turnId, turn.state]), [["T-1", "completed"]]);
  assert.deepEqual(turnFold(events), []);
});

test("applyTurnEvent has no sequence or thread guard: the caller feeds one thread's log, once, in order", () => {
  reset();
  const head = created();
  const start = ev("thread.turn-start-requested", {
    turnId: "T-1",
    messageId: "u",
    interactionMode: "default",
    modelSelection: OPUS
  });
  const events = [head, start, start];
  assert.equal(foldThread(events).turns.length, 1, "the fold drops the replayed seq");
  assert.equal(turnFold(events).length, 2, "the turn-only fold applies it again");
});
