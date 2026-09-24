/**
 * Grok goals (goals §6.3): the private channel's `goal_updated` mirrored as
 * `thread.goal.updated`, replayed goal rows held back, the one comparison after
 * a load, and the mapping of every status and `last_event`.
 *
 * Every frame is shaped on the real `goal_updated` rows of a goal session
 * written by `grok 1.0.3` (fixtures README observation 36; 1.0.34's binary
 * names the same fields): the field set and its order, the
 * byte-identical duplicates, the counters that move on every frame, the
 * `verifying_completion` window in which the PREVIOUS verdict is still on the
 * frame. The text is invented.
 */

import test from "node:test";
import assert from "node:assert/strict";

import type { AgentGoal, GoalUpdatedPayload, RuntimeEvent } from "@orquester/api/agent-chat";

import { GROK_GOAL_PROGRESS_THROTTLE_MS, goalCommandFromReminder, grokGoalStatus } from "./goal.ts";
import { GrokNormalizer } from "./normalize.ts";

const GOAL_ID = "3f6b2c1e-8a4d-4f0b-9c2e-7d5a1b9e0c44";
const OTHER_GOAL_ID = "9a1d7e55-2b3c-4d6e-8f70-1a2b3c4d5e6f";
const OBJECTIVE =
  "Audit every request handler for cross-clinic data access and fix each hole you find. Use subagents.";
const OTHER_OBJECTIVE = "Write the release notes for the audit fixes.";
const ROUND_ONE =
  "Handlers inventoried in {SCRATCH}/request-audit.md; the patient and invoice routes now scope by clinic.";
const ROUND_TWO = "The remaining write paths scope by clinic and the regression tests pass.";

/** One `goal_updated` body, in the real frame's field order. */
function frame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionUpdate: "goal_updated",
    goal_id: GOAL_ID,
    objective: OBJECTIVE,
    status: "active",
    phase: "executing",
    tokens_used: 0,
    elapsed_ms: 0,
    total_deliverables: 0,
    completed_deliverables: 0,
    total_worker_rounds: 0,
    total_verify_rounds: 0,
    token_baseline: 15509,
    finished_subagent_tokens: 0,
    last_event: "goal_created",
    last_event_timestamp: "2026-09-24T09:00:00.622415836+00:00",
    ...overrides
  };
}

/** A later event of the same goal: a new `last_event` stamped at `minute`. */
function at(minute: number, overrides: Record<string, unknown>): Record<string, unknown> {
  const stamp = `2026-09-24T${String(9 + Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.176452626+00:00`;
  return frame({ last_event_timestamp: stamp, ...overrides });
}

let eventCounter = 0;

function envelope(update: Record<string, unknown>, meta: Record<string, unknown> = {}): Record<string, unknown> {
  eventCounter += 1;
  return {
    sessionId: "01a05780-1220-7ee0-863c-3eed47284f9e",
    update,
    _meta: {
      eventId: `01a05780-1220-7ee0-863c-3eed47284f9e-${eventCounter}`,
      agentTimestampMs: 1790240400000 + eventCounter,
      ...meta
    }
  };
}

interface Rig {
  normalizer: GrokNormalizer;
  debug: Array<{ message: string; detail?: unknown }>;
  advance(ms: number): void;
  /** A live frame, on the live channel unless a method is named. */
  live(update: Record<string, unknown>, method?: string): RuntimeEvent[];
  /** A `session/load` replay frame. */
  replay(update: Record<string, unknown>, method?: string): RuntimeEvent[];
  /** Every `thread.goal.updated` payload a batch carries. */
  goals(events: readonly RuntimeEvent[]): GoalUpdatedPayload[];
}

function rig(options: { knownGoal?: AgentGoal | null; turnId?: string } = {}): Rig {
  let clock = 1_000_000;
  let n = 0;
  const debug: Array<{ message: string; detail?: unknown }> = [];
  const normalizer = new GrokNormalizer(
    {
      threadId: "t1",
      stamp: () => {
        n += 1;
        return { eventId: `e${n}`, createdAt: "2026-09-24T09:00:00.000Z" };
      },
      uuid: () => {
        n += 1;
        return `u${n}`;
      },
      activeTurnId: () => options.turnId,
      planHost: { platform: "linux", env: {} },
      ...(options.knownGoal === undefined ? {} : { knownGoal: options.knownGoal }),
      now: () => clock,
      debug: (message, detail) => {
        debug.push({ message, detail });
      }
    },
    "session-1"
  );
  return {
    normalizer,
    debug,
    advance: (ms) => {
      clock += ms;
    },
    live: (update, method = "_x.ai/session_notification") =>
      normalizer.handleXaiNotification(method, envelope(update)),
    replay: (update, method = "_x.ai/session/update") =>
      normalizer.handleXaiNotification(method, envelope(update, { isReplay: true })),
    goals: (events) =>
      events
        .filter(
          (event): event is Extract<RuntimeEvent, { type: "thread.goal.updated" }> =>
            event.type === "thread.goal.updated"
        )
        .map((event) => event.payload)
  };
}

/** Feed frames live, advancing the clock before each, and collect the payloads. */
function runLive(r: Rig, steps: ReadonlyArray<[advanceMs: number, update: Record<string, unknown>]>): GoalUpdatedPayload[] {
  const out: GoalUpdatedPayload[] = [];
  for (const [advanceMs, update] of steps) {
    r.advance(advanceMs);
    const events = r.live(update);
    assert.equal(
      events.some((event) => event.type === "runtime.warning"),
      false,
      "a goal frame is never a warning"
    );
    out.push(...r.goals(events));
  }
  return out;
}

const MINUTE = 60_000;

// ---------------------------------------------------------------------------
// §6.3 item 1 — recognised, never a warning, deduped
// ---------------------------------------------------------------------------

test("goal_updated is recognised under every xAI method name the adapter routes, never as a warning", () => {
  // The session registers `x.ai/session_notification` (live) and
  // `x.ai/session/update` (replay), each in both spellings. A frame that is
  // not a replay is LIVE whichever of them carried it.
  for (const method of [
    "x.ai/session_notification",
    "_x.ai/session_notification",
    "x.ai/session/update",
    "_x.ai/session/update"
  ]) {
    const r = rig({ turnId: "turn-1" });
    const events = r.live(frame(), method);
    assert.deepEqual(
      events.map((event) => event.type),
      ["thread.goal.updated"],
      `${method}: exactly one goal row, no runtime.warning`
    );
    const [event] = events as Array<Extract<RuntimeEvent, { type: "thread.goal.updated" }>>;
    assert.equal(event.payload.change, "set");
    assert.equal(event.turnId, "turn-1", "stamped with the turn the goal runs in");
    assert.equal(event.threadId, "t1");
    assert.equal(event.raw?.source, "acp.grok.extension");
    assert.equal(event.raw?.method, method);
  }
});

test("identical consecutive frames are dropped", () => {
  const r = rig();
  const created = frame();
  assert.equal(r.goals(r.live(created)).length, 1);
  // The real session repeats frames byte for byte (`goal_completed` three times).
  assert.deepEqual(r.live({ ...created }), []);
  assert.deepEqual(r.live({ ...created }), []);
});

test("frames whose counters alone moved emit nothing", () => {
  const r = rig();
  r.live(frame());
  // Tokens, time and the `live_*` block move on nearly every real frame; none
  // of them is goal STATE (`sameGoalState`).
  assert.deepEqual(r.live(frame({ tokens_used: 67845, elapsed_ms: 222518, planning: true })), []);
  assert.deepEqual(
    r.live(
      frame({
        tokens_used: 117745,
        elapsed_ms: 412588,
        finished_subagent_tokens: 50000,
        live_subagent_tokens: 165352,
        live_context_pct: 33,
        live_turn_count: 1,
        live_tool_call_count: 124
      })
    ),
    []
  );
});

test("a malformed goal_updated is dropped with a debug line, never a warning", () => {
  const r = rig();
  for (const bad of [
    { sessionUpdate: "goal_updated" },
    frame({ objective: "" }),
    frame({ objective: 42 }),
    frame({ status: 7 })
  ]) {
    assert.deepEqual(r.live(bad), []);
  }
  assert.ok(r.debug.length >= 4, "every dropped frame says why at debug level");
});

// ---------------------------------------------------------------------------
// §6.3 item 2 — the mapping
// ---------------------------------------------------------------------------

test("every Grok status maps onto the goal status set", () => {
  const cases: Array<[unknown, string | undefined]> = [
    ["active", "active"],
    ["complete", "complete"],
    ["paused", "paused"],
    ["user_paused", "paused"],
    ["back_off_paused", "paused"],
    ["no_progress_paused", "paused"],
    ["infra_paused", "paused"],
    ["interrupted", "paused"],
    ["blocked", "blocked"],
    ["budget_limited", "budget-limited"],
    ["failed", "failed"],
    ["reticulating", undefined],
    ["", undefined],
    [undefined, undefined],
    [null, undefined],
    [3, undefined]
  ];
  for (const [raw, expected] of cases) {
    assert.equal(grokGoalStatus(raw), expected, JSON.stringify(raw));
  }
});

test("an unknown status keeps the tracked status, with a debug line", () => {
  const r = rig();
  r.live(frame());
  r.advance(MINUTE);
  const [progress] = r.goals(
    r.live(at(40, { status: "reticulating", last_event: "worker_completed", total_worker_rounds: 1 }))
  );
  assert.equal(progress.change, "progress");
  assert.equal(progress.goal?.status, "active", "the status the thread already shows");
  assert.equal(progress.goal?.rounds, 1);
  assert.ok(
    r.debug.some((line) => JSON.stringify(line).includes("reticulating")),
    "the unknown status is named at debug level"
  );
});

test("an unknown status with nothing tracked emits nothing rather than guess one", () => {
  const r = rig();
  assert.deepEqual(r.live(frame({ status: "reticulating" })), []);
  assert.ok(r.debug.some((line) => JSON.stringify(line).includes("reticulating")));
});

test("the frame maps field by field", () => {
  const r = rig();
  const [set] = r.goals(r.live(frame({ tokens_used: 12, elapsed_ms: 34 })));
  assert.deepEqual(set, {
    goal: {
      objective: OBJECTIVE,
      status: "active",
      goalId: GOAL_ID,
      phase: "executing",
      rounds: 0,
      tokensUsed: 12,
      elapsedMs: 34,
      // The creating event's own timestamp (nanoseconds cut to what an ISO
      // string holds): the frames carry no `created_at`.
      setAt: "2026-09-24T09:00:00.622Z"
    },
    change: "set"
  });

  r.advance(MINUTE);
  const [progress] = r.goals(
    r.live(
      at(54, {
        last_event: "worker_completed",
        last_event_detail: ROUND_ONE,
        total_worker_rounds: 1,
        tokens_used: 1951592,
        elapsed_ms: 3253451,
        token_budget: 5000000,
        classifier_runs_attempted: 1,
        classifier_max_runs: 6,
        verifying_completion: true
      })
    )
  );
  assert.deepEqual(progress.goal, {
    objective: OBJECTIVE,
    status: "active",
    goalId: GOAL_ID,
    phase: "executing",
    rounds: 1,
    lastCheck: ROUND_ONE,
    tokensUsed: 1951592,
    tokenBudget: 5000000,
    elapsedMs: 3253451,
    setAt: "2026-09-24T09:00:00.622Z"
  });
});

test("a null token_budget is kept as 'no budget', and a malformed field is dropped, not guessed", () => {
  const r = rig();
  const [set] = r.goals(
    r.live(frame({ token_budget: null, tokens_used: -5, elapsed_ms: "soon", phase: "", last_event_timestamp: "whenever" }))
  );
  assert.equal(set.goal?.tokenBudget, null);
  assert.equal(set.goal?.tokensUsed, undefined);
  assert.equal(set.goal?.elapsedMs, undefined);
  assert.equal(set.goal?.phase, undefined);
  assert.equal(set.goal?.setAt, undefined);
});

test("a verification check reads the verdict — with its attempt when both counts are known — never the worker's summary", () => {
  // On a verdict frame `last_event_detail` is still the WORKER's summary of its
  // own round, not why the verifier said no.
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ classifier_runs_attempted: 1, classifier_max_runs: 6 }, "Verification: not achieved (attempt 1 of 6)"],
    [{ classifier_runs_attempted: 1 }, "Verification: not achieved"],
    [{ classifier_max_runs: 6 }, "Verification: not achieved"],
    [{}, "Verification: not achieved"]
  ];
  for (const [counts, expected] of cases) {
    const r = rig();
    r.live(frame());
    const [checked] = r.goals(
      r.live(
        at(20, {
          last_event: "worker_completed",
          total_worker_rounds: 1,
          last_event_detail: ROUND_ONE,
          last_classifier_verdict: "not_achieved",
          last_classifier_details_path: "/scratch/goal-classifier-1.md",
          ...counts
        })
      )
    );
    assert.equal(checked.change, "checked", JSON.stringify(counts));
    assert.equal(checked.goal?.lastCheck, expected, JSON.stringify(counts));
  }
});

test("the frames that repeat a check's verdict keep it; the next round's summary replaces it", () => {
  const r = rig();
  const round = { last_event: "worker_completed", total_worker_rounds: 1, last_event_detail: ROUND_ONE };
  const verdict = {
    ...round,
    classifier_runs_attempted: 1,
    classifier_max_runs: 6,
    last_classifier_verdict: "not_achieved",
    last_classifier_details_path: "/scratch/goal-classifier-1.md"
  };
  const perFrame = [
    [0, frame()],
    [MINUTE, at(54, { ...round, classifier_runs_attempted: 1, classifier_max_runs: 6, verifying_completion: true })],
    [MINUTE, at(54, verdict)],
    // The real CLI re-sends the verdict frame with its counters moved: the
    // worker's summary is still on it, and it must not become news again.
    [MINUTE, at(54, { ...verdict, tokens_used: 2435790, elapsed_ms: 4402054 })],
    [MINUTE, at(89, { ...verdict, total_worker_rounds: 2, last_event_detail: ROUND_TWO, classifier_runs_attempted: 2, verifying_completion: true })]
  ] as const;
  const rows = perFrame.map(([advance, update]) =>
    runLive(r, [[advance, update]]).map((payload) => [payload.change, payload.goal?.lastCheck])
  );
  assert.deepEqual(rows, [
    [["set", undefined]],
    [["progress", ROUND_ONE]],
    [["checked", "Verification: not achieved (attempt 1 of 6)"]],
    [],
    [["progress", ROUND_TWO]]
  ]);
});

// ---------------------------------------------------------------------------
// §6.3 item 3 — the change, from `last_event`
// ---------------------------------------------------------------------------

test("every last_event maps onto its change", () => {
  const r = rig();
  const changes = runLive(r, [
    [0, frame()],
    [MINUTE, at(10, { last_event: "goal_paused", status: "user_paused" })],
    [MINUTE, at(11, { last_event: "goal_resumed", status: "active" })],
    [
      MINUTE,
      at(12, {
        last_event: "premature_stop_detected",
        last_event_detail: "The worker stopped before running the verification plan."
      })
    ],
    [MINUTE, at(13, { last_event: "budget_exceeded", status: "budget_limited", token_budget: 2000000 })],
    [MINUTE, at(14, { last_event: "goal_resumed", status: "active" })],
    [MINUTE, at(15, { last_event: "goal_completed", status: "complete", phase: "idle" })]
  ]);
  assert.deepEqual(
    changes.map((payload) => [payload.change, payload.goal?.status]),
    [
      ["set", "active"],
      ["paused", "paused"],
      ["resumed", "active"],
      ["checked", "active"],
      ["limited", "budget-limited"],
      ["resumed", "active"],
      ["achieved", "complete"]
    ]
  );
  assert.equal(changes[3].goal?.lastCheck, "The worker stopped before running the verification plan.");
});

test("goal_created replaces an unfinished goal and sets over a finished one", () => {
  const r = rig();
  const changes = runLive(r, [
    [0, frame()],
    [MINUTE, at(10, { goal_id: OTHER_GOAL_ID, objective: OTHER_OBJECTIVE })],
    [MINUTE, at(20, { goal_id: OTHER_GOAL_ID, objective: OTHER_OBJECTIVE, last_event: "goal_completed", status: "complete", phase: "idle" })],
    [MINUTE, at(30, {})]
  ]);
  assert.deepEqual(
    changes.map((payload) => [payload.change, payload.goal?.objective]),
    [
      ["set", OBJECTIVE],
      ["replaced", OTHER_OBJECTIVE],
      ["achieved", OTHER_OBJECTIVE],
      ["set", OBJECTIVE]
    ]
  );
});

test("goal_cleared clears the goal, carrying it as it ended", () => {
  const r = rig();
  const changes = runLive(r, [
    [0, frame()],
    [MINUTE, at(10, { last_event: "worker_completed", total_worker_rounds: 1, last_event_detail: ROUND_ONE })],
    [MINUTE, at(11, { last_event: "goal_cleared", total_worker_rounds: 1 })]
  ]);
  const cleared = changes.at(-1)!;
  assert.equal(cleared.change, "cleared");
  assert.equal(cleared.goal, null);
  assert.equal(cleared.previous?.objective, OBJECTIVE);
  assert.equal(cleared.previous?.goalId, GOAL_ID);
  assert.equal(cleared.previous?.rounds, 1);
  // Nothing tracked any more: a repeat is not a second clear.
  r.advance(MINUTE);
  assert.deepEqual(r.goals(r.live(at(11, { last_event: "goal_cleared", total_worker_rounds: 1, tokens_used: 9 }))), []);
});

test("a goal_cleared for a goal the thread never showed emits nothing", () => {
  const r = rig();
  assert.deepEqual(r.goals(r.live(at(5, { last_event: "goal_cleared" }))), []);
});

test("a status change with no new event is named by the status it moved to", () => {
  // The spec's event list names no event for `blocked` or `failed`; the status
  // alone is the news, and a status change is never a hidden `progress` row.
  const r = rig();
  const changes = runLive(r, [
    [0, frame()],
    [MINUTE, at(10, { last_event: "worker_failed", status: "blocked", last_event_detail: "The deploy key is missing." })],
    [MINUTE, at(11, { last_event: "worker_started", status: "active" })],
    [MINUTE, at(11, { last_event: "worker_started", status: "budget_limited" })],
    [MINUTE, at(12, { last_event: "worker_started", status: "active" })],
    [MINUTE, at(13, { last_event: "planning_failed", status: "failed", last_event_detail: "No plan satisfies the objective." })]
  ]);
  assert.deepEqual(
    changes.map((payload) => [payload.change, payload.goal?.status]),
    [
      ["set", "active"],
      ["blocked", "blocked"],
      ["resumed", "active"],
      ["limited", "budget-limited"],
      ["resumed", "active"],
      ["failed", "failed"]
    ]
  );
  assert.equal(changes[1].goal?.lastCheck, "The deploy key is missing.");
});

test("every other last_event is progress, emitted only when the goal state moved", () => {
  for (const event of [
    "planning_completed",
    "planning_failed",
    "worker_started",
    "worker_completed",
    "worker_failed",
    "context_rotated",
    "something_new"
  ]) {
    const r = rig();
    r.live(frame());
    r.advance(MINUTE);
    const moved = r.goals(r.live(at(10, { last_event: event, phase: "verifying" })));
    assert.deepEqual(
      moved.map((payload) => payload.change),
      ["progress"],
      `${event} with a new phase`
    );
    r.advance(MINUTE);
    assert.deepEqual(
      r.goals(r.live(at(11, { last_event: event, phase: "verifying" }))),
      [],
      `${event} with nothing new`
    );
  }
});

test("progress is throttled to one per 30 s per thread; a status change never is", () => {
  const r = rig();
  const steps: Array<[number, Record<string, unknown>]> = [
    [0, frame()],
    [10_000, at(10, { last_event: "worker_completed", total_worker_rounds: 1, last_event_detail: ROUND_ONE })],
    // Ten seconds later: throttled, and NOT recorded as shown.
    [10_000, at(11, { last_event: "worker_completed", total_worker_rounds: 2, last_event_detail: ROUND_TWO })],
    // A counters-only frame after the window: the round-two state it still
    // carries is finally shown.
    [GROK_GOAL_PROGRESS_THROTTLE_MS - 9_000, at(11, { last_event: "worker_completed", total_worker_rounds: 2, last_event_detail: ROUND_TWO, tokens_used: 5 })],
    // Four seconds after that progress: a status change goes out at once.
    [4_000, at(12, { last_event: "goal_paused", status: "user_paused", total_worker_rounds: 2, last_event_detail: ROUND_TWO })]
  ];
  // Per frame, so WHICH frame carried an update is part of the assertion.
  const perFrame = steps.map(([advanceMs, update]) =>
    runLive(r, [[advanceMs, update]]).map((payload) => [payload.change, payload.goal?.rounds])
  );
  assert.deepEqual(perFrame, [
    [["set", 0]],
    [["progress", 1]],
    [],
    [["progress", 2]],
    [["paused", 2]]
  ]);
});

// ---------------------------------------------------------------------------
// A whole goal run, shaped on the real session
// ---------------------------------------------------------------------------

test("a whole goal run: set, round one, a failed verification, round two, achieved", () => {
  // The real run, frame for frame in kind: three identical-but-for-counters
  // `goal_created` frames while planning, round one's `worker_completed` with
  // the verification running, the verdict landing on the same event, round
  // two carrying the STALE verdict while its own verification runs — which is
  // not a second check — and `goal_completed` three times, once verbatim.
  const r = rig();
  const created = frame();
  const roundOne = at(54, {
    tokens_used: 1951592,
    elapsed_ms: 3253451,
    total_worker_rounds: 1,
    finished_subagent_tokens: 1633215,
    last_event: "worker_completed",
    last_event_detail: ROUND_ONE,
    classifier_runs_attempted: 1,
    classifier_max_runs: 6,
    verifying_completion: true
  });
  const verdict = {
    ...roundOne,
    tokens_used: 2435790,
    elapsed_ms: 4402008,
    verifying_completion: undefined,
    last_classifier_verdict: "not_achieved",
    last_classifier_details_path: "/scratch/grok-goal-059a0802bf82/goal-classifier-059a0802bf82-1.md"
  };
  const roundTwo = at(89, {
    tokens_used: 2468118,
    elapsed_ms: 4749573,
    total_worker_rounds: 2,
    last_event: "worker_completed",
    last_event_detail: ROUND_TWO,
    classifier_runs_attempted: 2,
    classifier_max_runs: 6,
    last_classifier_verdict: "not_achieved",
    last_classifier_details_path: "/scratch/grok-goal-059a0802bf82/goal-classifier-059a0802bf82-1.md",
    verifying_completion: true
  });
  const completed = at(106, {
    status: "complete",
    phase: "idle",
    tokens_used: 2786282,
    elapsed_ms: 5431463,
    total_worker_rounds: 2,
    last_event: "goal_completed",
    classifier_runs_attempted: 2,
    classifier_max_runs: 6,
    last_classifier_verdict: "achieved",
    last_classifier_details_path: "/home/sessions/goal/goal-classifier-059a0802bf82-2.md"
  });

  const changes = runLive(r, [
    [0, created],
    [0, { ...created, planning: true }],
    [19, { ...created, planning: true, elapsed_ms: 19 }],
    [222_499, { ...created, planning: true, tokens_used: 67845, elapsed_ms: 222518 }],
    [64, { ...created, tokens_used: 67845, elapsed_ms: 222582 }],
    [3_030_869, roundOne],
    [0, { ...roundOne }],
    [1_148_391, { ...roundOne, tokens_used: 2435790, elapsed_ms: 4401842, live_subagent_tokens: 165352, live_context_pct: 33 }],
    [166, verdict],
    [46, { ...verdict, elapsed_ms: 4402054 }],
    [347_519, roundTwo],
    [681_880, { ...roundTwo, tokens_used: 2786282, elapsed_ms: 5431453 }],
    [10, completed],
    [0, { ...completed }],
    [0, { ...completed, tokens_used: 2817072 }]
  ]);

  assert.deepEqual(
    changes.map((payload) => payload.change),
    ["set", "progress", "checked", "progress", "achieved"]
  );
  const [, first, checked, second, achieved] = changes;
  assert.equal(first.goal?.rounds, 1);
  assert.equal(first.goal?.lastCheck, ROUND_ONE);
  assert.equal(checked.goal?.rounds, 1, "`Goal check 1: not met`");
  assert.equal(
    checked.goal?.lastCheck,
    "Verification: not achieved (attempt 1 of 6)",
    "the verdict, never the worker's own summary still on the frame"
  );
  assert.equal(second.goal?.rounds, 2);
  assert.equal(second.goal?.lastCheck, ROUND_TWO);
  assert.deepEqual(achieved.goal, {
    objective: OBJECTIVE,
    status: "complete",
    goalId: GOAL_ID,
    phase: "idle",
    rounds: 2,
    tokensUsed: 2786282,
    elapsedMs: 5431463,
    setAt: "2026-09-24T09:00:00.622Z"
  });
  assert.equal(achieved.previous, undefined, "the achieved goal is the row's own goal");
});

test("a second not_achieved verdict is a second check", () => {
  const r = rig();
  const changes = runLive(r, [
    [0, frame()],
    [MINUTE, at(10, { last_event: "worker_completed", total_worker_rounds: 1, classifier_runs_attempted: 1, verifying_completion: true })],
    [MINUTE, at(10, { last_event: "worker_completed", total_worker_rounds: 1, classifier_runs_attempted: 1, last_classifier_verdict: "not_achieved", last_classifier_details_path: "/s/c-1.md" })],
    [MINUTE, at(20, { last_event: "worker_completed", total_worker_rounds: 2, classifier_runs_attempted: 2, last_classifier_verdict: "not_achieved", last_classifier_details_path: "/s/c-1.md", verifying_completion: true })],
    [MINUTE, at(20, { last_event: "worker_completed", total_worker_rounds: 2, classifier_runs_attempted: 2, last_classifier_verdict: "not_achieved", last_classifier_details_path: "/s/c-2.md" })]
  ]);
  assert.deepEqual(
    changes.map((payload) => [payload.change, payload.goal?.rounds, payload.goal?.lastCheck]),
    [
      ["set", 0, undefined],
      ["progress", 1, undefined],
      ["checked", 1, "Verification: not achieved"],
      ["progress", 2, "Verification: not achieved"],
      ["checked", 2, "Verification: not achieved"]
    ]
  );
});

test("a verdict is keyed on its details file: a moved run count alone is not a second check", () => {
  // `last_classifier_details_path` names the verifier's run
  // (`…/goal-classifier-<id>-<n>.md`); `classifier_runs_attempted` moves when
  // the NEXT run starts, before that run has said anything.
  const r = rig();
  const verdict = {
    last_event: "worker_completed",
    total_worker_rounds: 1,
    last_classifier_verdict: "not_achieved",
    last_classifier_details_path: "/s/goal-classifier-059a0802bf82-1.md"
  };
  const changes = runLive(r, [
    [0, frame()],
    [MINUTE, at(10, { ...verdict, classifier_runs_attempted: 1 })],
    [MINUTE, at(10, { ...verdict, classifier_runs_attempted: 2 })]
  ]);
  assert.deepEqual(
    changes.map((payload) => payload.change),
    ["set", "checked"]
  );
});

// ---------------------------------------------------------------------------
// Reviewer edges: dropped frames, objectives, the identical-frame drop
// ---------------------------------------------------------------------------

test("a dropped goal_created leaves no trace: the next valid one is still a set, not a restore", () => {
  for (const dropped of [frame({ status: "reticulating" }), frame({ objective: "" })]) {
    const r = rig();
    assert.deepEqual(r.live(dropped), [], "unusable: nothing tracked to borrow a status or objective from");
    assert.deepEqual(
      r.goals(r.live(frame({ tokens_used: 5 }))).map((payload) => payload.change),
      ["set"],
      "its event was never recorded, so it is still new"
    );
  }
});

test("a new objective under the same goal_id is a replacement, at once, not throttled progress", () => {
  const r = rig();
  const changes = runLive(r, [
    [0, frame()],
    [1_000, at(10, { last_event: "worker_completed", total_worker_rounds: 1, last_event_detail: ROUND_ONE })],
    // One second after a progress row: inside the throttle window.
    [1_000, at(10, { last_event: "worker_completed", total_worker_rounds: 1, last_event_detail: ROUND_ONE, objective: OTHER_OBJECTIVE })]
  ]);
  assert.deepEqual(
    changes.map((payload) => [payload.change, payload.goal?.objective]),
    [
      ["set", OBJECTIVE],
      ["progress", OBJECTIVE],
      ["replaced", OTHER_OBJECTIVE]
    ]
  );
});

test("a named event carrying a new objective under the same goal_id is a replacement, not the event", () => {
  // The objective moving is the bigger news: whatever else the event says, the
  // user now has a different goal.
  for (const [event, fields] of [
    ["goal_resumed", { status: "active" }],
    ["goal_paused", { status: "user_paused" }],
    ["premature_stop_detected", { last_event_detail: "The worker stopped early." }],
    ["budget_exceeded", { status: "budget_limited" }],
    ["goal_completed", { status: "complete", phase: "idle" }],
    ["goal_created", {}]
  ] as const) {
    const r = rig();
    const changes = runLive(r, [
      [0, frame()],
      [MINUTE, at(10, { last_event: event, objective: OTHER_OBJECTIVE, ...fields })]
    ]);
    assert.deepEqual(
      changes.map((payload) => [payload.change, payload.goal?.objective]),
      [
        ["set", OBJECTIVE],
        ["replaced", OTHER_OBJECTIVE]
      ],
      event
    );
  }
});

test("the identical-frame drop is observable: a repeat never delivers a throttled update, a moved counter does", () => {
  // Byte-identical repeats are dropped before they are read (goals §6.3 item
  // 1). The one place that shows: a throttled `progress` is not shown by an
  // identical repeat even once the window has passed — only by a frame that
  // actually differs.
  const r = rig();
  const roundTwo = at(11, { last_event: "worker_completed", total_worker_rounds: 2, last_event_detail: ROUND_TWO });
  const perFrame = [
    [0, frame()],
    [1_000, at(10, { last_event: "worker_completed", total_worker_rounds: 1, last_event_detail: ROUND_ONE })],
    [1_000, roundTwo],
    [GROK_GOAL_PROGRESS_THROTTLE_MS, { ...roundTwo }],
    [1_000, { ...roundTwo, tokens_used: 5 }]
  ] as const;
  assert.deepEqual(
    perFrame.map(([advance, update]) => runLive(r, [[advance, update]]).map((payload) => [payload.change, payload.goal?.rounds])),
    [[["set", 0]], [["progress", 1]], [], [], [["progress", 2]]]
  );
});

test("an identical repeat of an unreadable frame is not read twice", () => {
  const r = rig();
  const unknown = frame({ status: "reticulating" });
  r.live(unknown);
  const lines = r.debug.length;
  assert.ok(lines > 0);
  r.live({ ...unknown });
  assert.equal(r.debug.length, lines, "dropped before it is interpreted: no second debug line");
});

// ---------------------------------------------------------------------------
// §6.3 item 4 — replay, and the one comparison after the load
// ---------------------------------------------------------------------------

/** The goal the thread would show after the replayed round-one frame. */
const ROUND_ONE_GOAL: AgentGoal = {
  objective: OBJECTIVE,
  status: "active",
  goalId: GOAL_ID,
  phase: "executing",
  rounds: 1,
  lastCheck: ROUND_ONE
};

function replayRoundOne(r: Rig): RuntimeEvent[] {
  return [
    ...r.replay(frame()),
    ...r.replay(frame({ planning: true, tokens_used: 67845 })),
    ...r.replay(at(54, { last_event: "worker_completed", total_worker_rounds: 1, last_event_detail: ROUND_ONE, verifying_completion: true }))
  ];
}

test("replayed goal rows emit nothing as they arrive, on every method name", () => {
  for (const method of [
    "x.ai/session/update",
    "_x.ai/session/update",
    "x.ai/session_notification",
    "_x.ai/session_notification"
  ]) {
    const r = rig();
    assert.deepEqual(r.replay(frame(), method), [], method);
    assert.deepEqual(r.replay(at(20, { last_event: "goal_completed", status: "complete", phase: "idle" }), method), [], method);
  }
});

test("after a load, a replayed goal the thread lacks is restored — once", () => {
  const r = rig({ knownGoal: null });
  assert.deepEqual(replayRoundOne(r), []);
  const first = r.goals(r.normalizer.reconcileGoal("load"));
  assert.equal(first.length, 1);
  assert.equal(first[0].change, "restored");
  assert.equal(first[0].goal?.rounds, 1);
  assert.equal(first[0].goal?.lastCheck, ROUND_ONE);
  assert.deepEqual(r.normalizer.reconcileGoal("load"), [], "the comparison runs once");
});

test("after a load, the goal the thread already shows emits nothing", () => {
  const r = rig({ knownGoal: ROUND_ONE_GOAL });
  replayRoundOne(r);
  assert.deepEqual(r.normalizer.reconcileGoal("load"), []);
});

test("after a load, the same goal with only its progress moved is a hidden progress row", () => {
  const r = rig({ knownGoal: { ...ROUND_ONE_GOAL, rounds: 0, lastCheck: undefined } });
  replayRoundOne(r);
  assert.deepEqual(
    r.goals(r.normalizer.reconcileGoal("load")).map((payload) => [payload.change, payload.goal?.rounds]),
    [["progress", 1]]
  );
});

test("after a load, the same goal in another status is restored in that status", () => {
  const r = rig({ knownGoal: ROUND_ONE_GOAL });
  replayRoundOne(r);
  r.replay(at(60, { last_event: "goal_paused", status: "user_paused", total_worker_rounds: 1, last_event_detail: ROUND_ONE }));
  assert.deepEqual(
    r.goals(r.normalizer.reconcileGoal("load")).map((payload) => [payload.change, payload.goal?.status]),
    [["restored", "paused"]]
  );
});

test("after a load that replayed NO goal row, the goal the thread shows is left alone — absence is not a clear", () => {
  // Ruling: 1.0.34 persisting `goal_updated` rows is unverified live, so a
  // load with no goal row proves nothing — and a false `cleared` would hide a
  // paused or blocked goal after every restart.
  for (const status of ["active", "paused", "blocked", "budget-limited"] as const) {
    const r = rig({ knownGoal: { ...ROUND_ONE_GOAL, status } });
    // Other replayed traffic is not goal evidence either.
    r.replay({ sessionUpdate: "turn_completed", prompt_id: "p1", stop_reason: "end_turn" });
    assert.deepEqual(r.normalizer.reconcileGoal("load"), [], status);
  }
});

test("after a load whose last goal row is goal_cleared, the goal is cleared", () => {
  const r = rig({ knownGoal: ROUND_ONE_GOAL });
  replayRoundOne(r);
  r.replay(at(60, { last_event: "goal_cleared", total_worker_rounds: 1 }));
  assert.deepEqual(
    r.goals(r.normalizer.reconcileGoal("load")).map((payload) => [payload.change, payload.goal]),
    [["cleared", null]]
  );
});

test("after a load, a goal that finished while the thread showed it running is achieved or failed", () => {
  for (const [status, change] of [
    ["complete", "achieved"],
    ["failed", "failed"]
  ] as const) {
    const r = rig({ knownGoal: ROUND_ONE_GOAL });
    replayRoundOne(r);
    r.replay(at(90, { last_event: status === "complete" ? "goal_completed" : "worker_failed", status, phase: "idle", total_worker_rounds: 2 }));
    assert.deepEqual(
      r.goals(r.normalizer.reconcileGoal("load")).map((payload) => [payload.change, payload.goal?.status]),
      [[change, status === "complete" ? "complete" : "failed"]]
    );
  }
});

test("after a load, ANOTHER goal that finished means the one the thread shows is gone: cleared, nothing more", () => {
  for (const status of ["complete", "failed"] as const) {
    const r = rig({ knownGoal: ROUND_ONE_GOAL });
    replayRoundOne(r);
    r.replay(at(90, { goal_id: OTHER_GOAL_ID, objective: OTHER_OBJECTIVE, last_event: "goal_created" }));
    r.replay(at(95, { goal_id: OTHER_GOAL_ID, objective: OTHER_OBJECTIVE, last_event: "goal_completed", status, phase: "idle" }));
    const updates = r.goals(r.normalizer.reconcileGoal("load"));
    assert.deepEqual(updates, [{ goal: null, change: "cleared", previous: ROUND_ONE_GOAL }], status);
  }
});

test("after a load, a new objective under the same goal_id is restored, not a hidden progress row", () => {
  const r = rig({ knownGoal: ROUND_ONE_GOAL });
  replayRoundOne(r);
  r.replay(at(60, { last_event: "worker_completed", total_worker_rounds: 1, last_event_detail: ROUND_ONE, objective: OTHER_OBJECTIVE }));
  assert.deepEqual(
    r.goals(r.normalizer.reconcileGoal("load")).map((payload) => [payload.change, payload.goal?.objective]),
    [["restored", OTHER_OBJECTIVE]]
  );
});

test("after a load, a finished goal the thread never showed running emits nothing", () => {
  for (const knownGoal of [null, { ...ROUND_ONE_GOAL, status: "complete" as const }]) {
    const r = rig({ knownGoal });
    replayRoundOne(r);
    r.replay(at(90, { last_event: "goal_completed", status: "complete", phase: "idle", total_worker_rounds: 2 }));
    assert.deepEqual(r.normalizer.reconcileGoal("load"), []);
  }
});

test("a finished goal the thread never showed stays out of the live stream too", () => {
  // The real CLI re-sends a completed goal's frame, counters moved, during
  // LATER turns of the session. After a load that rightly kept it out, that
  // frame must not turn into a "Goal restored" row either.
  const r = rig({ knownGoal: null });
  const completed = at(90, { last_event: "goal_completed", status: "complete", phase: "idle", total_worker_rounds: 2 });
  r.replay(frame());
  r.replay(completed);
  assert.deepEqual(r.normalizer.reconcileGoal("load"), []);
  r.advance(MINUTE);
  assert.deepEqual(r.live({ ...completed, tokens_used: 2817072 }), []);
  // A goal created afterwards is news as usual.
  r.advance(MINUTE);
  assert.deepEqual(
    r.goals(r.live(at(120, { goal_id: OTHER_GOAL_ID, objective: OTHER_OBJECTIVE }))).map((payload) => payload.change),
    ["set"]
  );
});

test("a finished goal the thread shows is left alone when nothing was replayed", () => {
  const r = rig({ knownGoal: { ...ROUND_ONE_GOAL, status: "complete" } });
  assert.deepEqual(r.normalizer.reconcileGoal("load"), []);
  const none = rig({ knownGoal: null });
  assert.deepEqual(none.normalizer.reconcileGoal("load"), []);
});

test("the comparison emits at most one update, whatever was replayed", () => {
  const knowns: Array<AgentGoal | null> = [null, ROUND_ONE_GOAL, { ...ROUND_ONE_GOAL, status: "complete" }];
  const replays: Array<Array<Record<string, unknown>>> = [
    [],
    [frame()],
    [frame(), at(10, { last_event: "goal_cleared" })],
    [frame(), at(10, { last_event: "goal_completed", status: "complete", phase: "idle" })],
    [frame(), at(10, { goal_id: OTHER_GOAL_ID, objective: OTHER_OBJECTIVE })]
  ];
  for (const knownGoal of knowns) {
    for (const frames of replays) {
      const r = rig({ knownGoal });
      for (const update of frames) {
        assert.deepEqual(r.replay(update), []);
      }
      assert.ok(r.normalizer.reconcileGoal("load").length <= 1);
      assert.deepEqual(r.normalizer.reconcileGoal("load"), []);
    }
  }
});

test("after the comparison, live frames continue from the replayed state, not from scratch", () => {
  const r = rig({ knownGoal: ROUND_ONE_GOAL });
  replayRoundOne(r);
  assert.deepEqual(r.normalizer.reconcileGoal("load"), []);
  const last = at(54, { last_event: "worker_completed", total_worker_rounds: 1, last_event_detail: ROUND_ONE, verifying_completion: true });
  // The CLI repeating its current state live is not news…
  assert.deepEqual(r.live(last), []);
  assert.deepEqual(r.live({ ...last, tokens_used: 99 }), []);
  // …and the verdict that lands next is the check it is.
  r.advance(MINUTE);
  const verdict = r.goals(
    r.live({ ...last, verifying_completion: undefined, last_classifier_verdict: "not_achieved", last_classifier_details_path: "/s/c-1.md" })
  );
  assert.deepEqual(verdict.map((payload) => payload.change), ["checked"]);
});

test("a goal loaded while still planning is not set a second time by its next live frame", () => {
  const created: AgentGoal = { objective: OBJECTIVE, status: "active", goalId: GOAL_ID, phase: "executing", rounds: 0 };
  const r = rig({ knownGoal: created });
  r.replay(frame());
  r.replay(frame({ planning: true, tokens_used: 67845 }));
  assert.deepEqual(r.normalizer.reconcileGoal("load"), []);
  // Its `last_event` is still the replayed `goal_created`: not a new event.
  assert.deepEqual(r.live(frame({ planning: true, tokens_used: 117745, elapsed_ms: 412588 })), [], "no second `Goal set`");
  assert.deepEqual(r.live(frame({ tokens_used: 117745, elapsed_ms: 412609 })), []);
});

test("a live frame during the load leaves the comparison nothing to add", () => {
  const r = rig({ knownGoal: null });
  replayRoundOne(r);
  // Live, before the load completed: the thread learns the goal here…
  const live = r.goals(
    r.live(at(55, { last_event: "worker_started", total_worker_rounds: 1, last_event_detail: ROUND_ONE, verifying_completion: true }))
  );
  assert.deepEqual(live.map((payload) => payload.change), ["restored"]);
  // …so the comparison has nothing left to report.
  assert.deepEqual(r.normalizer.reconcileGoal("load"), []);
});

test("a FRESH session (session/new) has no goal by definition: an unfinished goal the thread shows is cleared", () => {
  // Ruling: unlike a load — whose replay may simply not carry goal rows — a
  // brand-new Grok session is known to have no goal, as the Claude adapter
  // treats a cursor-less new session.
  for (const status of ["active", "paused", "blocked", "budget-limited"] as const) {
    const known: AgentGoal = { ...ROUND_ONE_GOAL, status };
    const r = rig({ knownGoal: known });
    assert.deepEqual(
      r.goals(r.normalizer.reconcileGoal("new")),
      [{ goal: null, change: "cleared", previous: known }],
      status
    );
    assert.deepEqual(r.normalizer.reconcileGoal("new"), [], "once");
  }
});

test("a fresh session with no goal, or a finished one, to show says nothing", () => {
  for (const knownGoal of [null, { ...ROUND_ONE_GOAL, status: "complete" as const }, { ...ROUND_ONE_GOAL, status: "failed" as const }]) {
    const r = rig({ knownGoal });
    assert.deepEqual(r.normalizer.reconcileGoal("new"), []);
  }
});

test("the same known goal: a load with no goal row keeps it, a fresh session clears it", () => {
  const load = rig({ knownGoal: ROUND_ONE_GOAL });
  assert.deepEqual(load.normalizer.reconcileGoal("load"), [], "no replayed evidence");
  const fresh = rig({ knownGoal: ROUND_ONE_GOAL });
  assert.deepEqual(
    fresh.goals(fresh.normalizer.reconcileGoal("new")).map((payload) => payload.change),
    ["cleared"]
  );
});

// ---------------------------------------------------------------------------
// §6.3 item 5 — the replayed goal user message
// ---------------------------------------------------------------------------

const REMINDER_TAIL =
  "\n\nYou are working directly on this goal across multiple turns. Deliver\nEVERYTHING the user asked for yourself — no follow-up questions, no manual\nsteps left for the user.\n\nA structured plan for this goal is on disk — the source of truth for \"done\".\nRead it first and keep it open.\n\nPlan: /home/sessions/goal/plan.md\n\nStart now.\n</system-reminder>\n\n";

test("the goal <system-reminder> block reads as the /goal command that set it", () => {
  assert.equal(
    goalCommandFromReminder(`<system-reminder>\nA goal has been set: ${OBJECTIVE}${REMINDER_TAIL}`),
    `/goal ${OBJECTIVE}`
  );
  // An objective of several lines, even one with a blank line in it, is kept
  // whole: the block's own next sentence is what ends it.
  assert.equal(
    goalCommandFromReminder(`<system-reminder>\nA goal has been set: Fix the audit.\n\nThen ship it.${REMINDER_TAIL}`),
    "/goal Fix the audit.\n\nThen ship it."
  );
  // Without that sentence, whichever comes FIRST ends it — a blank line or
  // the closing tag — and never a blank line after the block has closed.
  assert.equal(
    goalCommandFromReminder("<system-reminder>\nA goal has been set: Fix the audit\n\nSomething else entirely.</system-reminder>"),
    "/goal Fix the audit"
  );
  assert.equal(
    goalCommandFromReminder("<system-reminder>\nA goal has been set: Fix the audit</system-reminder>"),
    "/goal Fix the audit"
  );
  assert.equal(
    goalCommandFromReminder("<system-reminder>\nA goal has been set: Fix the audit</system-reminder>\n\n"),
    "/goal Fix the audit"
  );
  assert.equal(goalCommandFromReminder("  \n<system-reminder>\nA goal has been set: x\n\nYou are working directly on this goal"), "/goal x");
  assert.equal(goalCommandFromReminder("<system-reminder>\nA goal has been set: \n\nYou are working directly on this goal"), "/goal");
});

test("text after the goal block stays, beneath the /goal line", () => {
  assert.equal(
    goalCommandFromReminder(`<system-reminder>\nA goal has been set: ${OBJECTIVE}${REMINDER_TAIL}Also keep the changelog current.\n`),
    `/goal ${OBJECTIVE}\n\nAlso keep the changelog current.`
  );
  assert.equal(
    goalCommandFromReminder("<system-reminder>\nA goal has been set: Fix the audit</system-reminder>\n\nand then\n\nship it"),
    "/goal Fix the audit\n\nand then\n\nship it"
  );
});

test("only a LEADING block whose first line sets the goal is a goal block", () => {
  // Another reminder that merely quotes the phrase further down.
  assert.equal(
    goalCommandFromReminder(
      "<system-reminder>\nThe user switched models.\nEarlier: A goal has been set: Fix the audit\n</system-reminder>"
    ),
    undefined
  );
  // The phrase after the block has closed.
  assert.equal(
    goalCommandFromReminder("<system-reminder>\nThe user switched models.\n</system-reminder>\nA goal has been set: Fix the audit"),
    undefined
  );
  // A goal block that does not lead the message.
  assert.equal(
    goalCommandFromReminder(`Before anything else:\n<system-reminder>\nA goal has been set: ${OBJECTIVE}${REMINDER_TAIL}`),
    undefined
  );
});

test("anything else is not a goal block", () => {
  assert.equal(goalCommandFromReminder("Please remember: A goal has been set: nothing"), undefined);
  assert.equal(goalCommandFromReminder("<system-reminder>\nThe user switched models.\n</system-reminder>"), undefined);
  assert.equal(goalCommandFromReminder("/goal Fix the audit"), undefined);
  assert.equal(goalCommandFromReminder(""), undefined);
});
