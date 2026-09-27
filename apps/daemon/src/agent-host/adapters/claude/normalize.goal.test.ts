/**
 * The Claude normaliser's goal surface (goals §6.1): never-streamed synthetic
 * text renders at once (item 1), the `/goal` command's output (2), Stop-hook
 * feedback and the check-in (3), what the transcript said after a turn and on
 * resume (4, 5), and `active_goal` (6).
 *
 * The frames are shaped like the CLI's own (Claude Code 2.1.280, goals §3.1);
 * the conditions are invented.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentGoal, RuntimeEvent } from "@orquester/api/agent-chat";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { Clock } from "../../adapter.ts";
import { countingIds, fixedClock } from "./fixtures.ts";
import {
  GOAL_PROGRESS_THROTTLE_MS,
  GOAL_WAITING_BACKGROUND_PHASE,
  parseGoalStatusRow,
  transcriptGoalFromLastRow,
  type ClaudeGoalStatusRow
} from "./goal.ts";
import { ClaudeNormalizer, type NormalizerOptions } from "./normalize.ts";

type GoalEvent = Extract<RuntimeEvent, { type: "thread.goal.updated" }>;

let frameSeq = 0;

function movableClock(startIso = "2026-09-24T10:00:00.000Z"): Clock & { advance(ms: number): void } {
  let ms = Date.parse(startIso);
  return {
    now: () => new Date(ms),
    nowIso: () => new Date(ms).toISOString(),
    advance: (delta: number) => {
      ms += delta;
    }
  };
}

function make(options: Partial<NormalizerOptions> = {}): {
  normalizer: ClaudeNormalizer;
  feed: (frame: unknown) => RuntimeEvent[];
} {
  const normalizer = new ClaudeNormalizer({
    threadId: "t",
    clock: fixedClock("2026-09-24T10:00:00.000Z"),
    ids: countingIds(),
    ...options
  });
  // The first frame carrying a session id also announces the thread; spend
  // that on bookkeeping so each test sees only its own frame's events.
  normalizer.handleMessage({ type: "keep_alive", session_id: "s" } as unknown as SDKMessage);
  return { normalizer, feed: (frame) => normalizer.handleMessage(frame as SDKMessage) };
}

/** A never-streamed, CLI-synthesised assistant frame (`message.model: "<synthetic>"`). */
function synthetic(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  frameSeq += 1;
  return {
    type: "assistant",
    message: {
      id: `f764ad36-0000-4000-8000-${String(frameSeq).padStart(12, "0")}`,
      container: null,
      model: "<synthetic>",
      role: "assistant",
      stop_reason: "end_turn",
      stop_sequence: null,
      type: "message",
      content: [{ type: "text", text }],
      context_management: null
    },
    parent_tool_use_id: null,
    session_id: "s",
    uuid: `4bdfff3e-0000-4000-8000-${String(frameSeq).padStart(12, "0")}`,
    ...extra
  };
}

/** The `/goal` command's own output frame. */
function goalOutput(text: string, args = ""): Record<string, unknown> {
  return synthetic(text, {
    local_command_source: `<local-command-stdout>${text}</local-command-stdout>`,
    local_command_run: { command: "goal", args }
  });
}

function syntheticUser(content: string): Record<string, unknown> {
  frameSeq += 1;
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    session_id: "s",
    uuid: `7a1c0000-0000-4000-8000-${String(frameSeq).padStart(12, "0")}`,
    isSynthetic: true
  };
}

function result(): Record<string, unknown> {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 10,
    duration_api_ms: 10,
    num_turns: 0,
    result: "",
    stop_reason: null,
    session_id: "s",
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    permission_denials: [],
    uuid: "u-result"
  };
}

function goalEvents(events: readonly RuntimeEvent[]): GoalEvent[] {
  return events.filter((event): event is GoalEvent => event.type === "thread.goal.updated");
}

function types(events: readonly RuntimeEvent[]): string[] {
  return events.map((event) =>
    event.type === "item.started" || event.type === "item.completed"
      ? `${event.type}:${(event.payload as { itemType?: string }).itemType}`
      : event.type === "content.delta"
        ? `${event.type}:${(event.payload as { streamKind?: string }).streamKind}`
        : event.type
  );
}

function row(attachment: Record<string, unknown>): ClaudeGoalStatusRow {
  const parsed = parseGoalStatusRow({ type: "attachment", attachment: { type: "goal_status", ...attachment } });
  assert.ok(parsed, "a goal_status row");
  return parsed;
}

const SHIP: AgentGoal = { objective: "ship the release", status: "active", rounds: 0 };

describe("claude normaliser — never-streamed synthetic text renders at once (goals §6.1.1)", () => {
  it("completes a <synthetic> frame's text at the frame, not at the result", () => {
    const { normalizer, feed } = make();
    normalizer.beginTurn({ turnId: "turn-1" });
    const atFrame = feed(synthetic("There's an issue with the selected model (x). It may not exist."));
    assert.deepEqual(types(atFrame), [
      "item.started:assistant_message",
      "content.delta:assistant_text",
      "item.completed:assistant_message"
    ]);
    const delta = atFrame.find((event) => event.type === "content.delta");
    assert.equal(
      (delta?.payload as { delta?: string }).delta,
      "There's an issue with the selected model (x). It may not exist."
    );
    for (const event of atFrame) {
      assert.equal(event.turnId, "turn-1");
    }
    const atResult = feed(result());
    assert.equal(
      atResult.filter((event) => event.type === "content.delta" || event.type === "item.completed").length,
      0,
      "the result has nothing left to flush"
    );
  });

  it("opens a turn for a <synthetic> frame that arrives between turns, and still completes it at once", () => {
    const { feed } = make();
    const events = feed(synthetic("Goal cleared: ship it", { local_command_run: { command: "goal", args: "clear" } }));
    assert.deepEqual(types(events).slice(0, 5), [
      "turn.started",
      "session.state.changed",
      "item.started:assistant_message",
      "content.delta:assistant_text",
      "item.completed:assistant_message"
    ]);
  });

  it("leaves an ordinary snapshot-only frame as it was: its text still waits for the result", () => {
    const { normalizer, feed } = make();
    normalizer.beginTurn({ turnId: "turn-1" });
    const frame = synthetic("A real model's answer that never streamed.");
    (frame.message as { model: string }).model = "claude-opus-5";
    assert.deepEqual(types(feed(frame)), ["item.started:assistant_message"]);
    const atResult = types(feed(result()));
    assert.ok(atResult.includes("content.delta:assistant_text"), "the text lands at the result");
    assert.ok(atResult.includes("item.completed:assistant_message"), "and completes there");
  });
});

describe("claude normaliser — the /goal command's output (goals §6.1.2)", () => {
  it("a set emits `set` after the text, with the whole goal and the set time", () => {
    const setPoints: number[] = [];
    const { normalizer, feed } = make({ onGoalSetPoint: () => setPoints.push(1) });
    normalizer.beginTurn({ turnId: "turn-1" });
    const events = feed(goalOutput("Goal set: ship the release", "ship the release"));
    assert.deepEqual(types(events), [
      "item.started:assistant_message",
      "content.delta:assistant_text",
      "item.completed:assistant_message",
      "thread.goal.updated"
    ]);
    const [goal] = goalEvents(events);
    assert.deepEqual(goal?.payload, {
      goal: { ...SHIP, setAt: "2026-09-24T10:00:00.000Z" },
      change: "set"
    });
    assert.equal(goal?.turnId, "turn-1");
    assert.equal(setPoints.length, 1, "the transcript's set point is marked");
    assert.deepEqual(normalizer.goals.goal, { ...SHIP, setAt: "2026-09-24T10:00:00.000Z" });
  });

  it("a set over a different running goal is `replaced`; the same goal again is no change", () => {
    const { normalizer, feed } = make({ knownGoal: SHIP });
    normalizer.beginTurn({ turnId: "turn-1" });
    assert.deepEqual(goalEvents(feed(goalOutput("Goal set: ship the release"))), []);
    const [replaced] = goalEvents(feed(goalOutput("Goal set: fix every flaky test")));
    assert.equal(replaced?.payload.change, "replaced");
    assert.equal(replaced?.payload.goal?.objective, "fix every flaky test");
  });

  it("a bare /goal reports rounds and the last check as progress on the tracked goal", () => {
    const { normalizer, feed } = make({ knownGoal: SHIP });
    normalizer.beginTurn({ turnId: "turn-1" });
    assert.deepEqual(
      goalEvents(feed(goalOutput("Goal active: ship the release (not yet evaluated)"))),
      [],
      "nothing moved"
    );
    const [progress] = goalEvents(
      feed(goalOutput("Goal active: ship the release (2 turns)\nLast check: the changelog is missing"))
    );
    assert.deepEqual(progress?.payload, {
      goal: { ...SHIP, rounds: 2, lastCheck: "the changelog is missing" },
      change: "progress"
    });
  });

  it("a bare /goal naming a goal nobody tracked is `restored`", () => {
    const { normalizer, feed } = make();
    normalizer.beginTurn({ turnId: "turn-1" });
    const [restored] = goalEvents(feed(goalOutput("Goal active: ship the release (1 turn)")));
    assert.deepEqual(restored?.payload, {
      goal: { ...SHIP, rounds: 1 },
      change: "restored"
    });
  });

  it("a clear is `cleared` with the goal that ended; 'No goal set' clears only a tracked goal", () => {
    const { normalizer, feed } = make({ knownGoal: { ...SHIP, rounds: 3 } });
    normalizer.beginTurn({ turnId: "turn-1" });
    const [cleared] = goalEvents(feed(goalOutput("Goal cleared: ship the release", "clear")));
    assert.deepEqual(cleared?.payload, {
      goal: null,
      change: "cleared",
      previous: { ...SHIP, rounds: 3 }
    });
    assert.equal(normalizer.goals.goal, null);
    assert.deepEqual(goalEvents(feed(goalOutput("No goal set", "clear"))), []);
    assert.deepEqual(goalEvents(feed(goalOutput("No goal set. Usage: `/goal <condition>`"))), []);

    const tracked = make({ knownGoal: SHIP });
    tracked.normalizer.beginTurn({ turnId: "turn-1" });
    const [stale] = goalEvents(tracked.feed(goalOutput("No goal set")));
    assert.deepEqual(stale?.payload, { goal: null, change: "cleared", previous: SHIP });
  });

  it("the refusals change nothing, and their text still renders", () => {
    const { normalizer, feed } = make({ knownGoal: SHIP });
    normalizer.beginTurn({ turnId: "turn-1" });
    for (const text of [
      "Goal condition is limited to 4000 characters (got 4012)",
      "/goal can't run while hooks are restricted (disableAllHooks or allowManagedHooksOnly is set in settings or by policy)."
    ]) {
      const events = feed(goalOutput(text, "x"));
      assert.deepEqual(goalEvents(events), []);
      assert.ok(types(events).includes("content.delta:assistant_text"), `the refusal renders: ${text}`);
    }
    assert.deepEqual(normalizer.goals.goal, SHIP);
  });

  it("another local command's output is never read as a goal", () => {
    const { normalizer, feed } = make();
    normalizer.beginTurn({ turnId: "turn-1" });
    const events = feed(
      synthetic("Goal set: this is a /context printout", {
        local_command_run: { command: "context", args: "" }
      })
    );
    assert.deepEqual(goalEvents(events), []);
    assert.equal(normalizer.goals.goal, null);
  });

  it("falls back to local_command_source when the content carries no text", () => {
    const { normalizer, feed } = make();
    normalizer.beginTurn({ turnId: "turn-1" });
    const frame = goalOutput("Goal set: ship the release");
    (frame.message as { content: unknown[] }).content = [];
    const [set] = goalEvents(feed(frame));
    assert.equal(set?.payload.goal?.objective, "ship the release");
  });
});

describe("claude normaliser — Stop-hook feedback and the check-in (goals §6.1.3)", () => {
  it("the tracked goal's feedback is `checked`, one round more, and never a user message", () => {
    const { normalizer, feed } = make({
      knownGoal: { ...SHIP, rounds: 1, phase: GOAL_WAITING_BACKGROUND_PHASE }
    });
    normalizer.beginTurn({ turnId: "turn-1" });
    const itemsBefore = normalizer.turnState?.items.length;
    const events = feed(
      syntheticUser("Stop hook feedback:\n[ship the release]: the changelog is still missing")
    );
    assert.deepEqual(types(events), ["thread.goal.updated"], "nothing else: no row for the frame");
    assert.deepEqual(goalEvents(events)[0]?.payload, {
      goal: { ...SHIP, rounds: 2, lastCheck: "the changelog is still missing" },
      change: "checked"
    });
    assert.equal(goalEvents(events)[0]?.turnId, "turn-1");
    assert.equal(normalizer.turnState?.items.length, itemsBefore, "not a conversation item either");
  });

  it("matches a condition the CLI cut to 500 characters", () => {
    const objective = `${"keep going ".repeat(60)}until it is done`;
    const { normalizer, feed } = make({ knownGoal: { objective, status: "active", rounds: 0 } });
    normalizer.beginTurn({ turnId: "turn-1" });
    const cut = objective.slice(0, 500);
    const [checked] = goalEvents(
      feed(syntheticUser(`Stop hook feedback:\n[${cut}… [+${objective.length - 500} chars]]: not yet`))
    );
    assert.equal(checked?.payload.change, "checked");
    assert.equal(checked?.payload.goal?.rounds, 1);
  });

  it("another hook's feedback keeps today's behaviour: no goal change, no row", () => {
    const { normalizer, feed } = make({ knownGoal: SHIP });
    normalizer.beginTurn({ turnId: "turn-1" });
    const events = feed(syntheticUser("Stop hook feedback:\n[lint is clean]: 3 errors remain"));
    assert.deepEqual(events, []);
    assert.deepEqual(normalizer.goals.goal, SHIP);
  });

  it("feedback with no tracked goal changes nothing", () => {
    const { normalizer, feed } = make();
    normalizer.beginTurn({ turnId: "turn-1" });
    assert.deepEqual(feed(syntheticUser("Stop hook feedback:\n[ship the release]: no")), []);
  });

  it("a check-in is `progress` waiting on background work, and never a user message", () => {
    const { normalizer, feed } = make({ knownGoal: SHIP });
    normalizer.beginTurn({ turnId: "turn-1" });
    const events = feed(
      syntheticUser(
        "Goal check-in: «ship the release» is still active, and evaluation has been deferred for 31 min because background work is still running:\n- b1 · shell · npm test\nCheck on their progress (e.g. read their output)."
      )
    );
    assert.deepEqual(types(events), ["thread.goal.updated"]);
    assert.deepEqual(goalEvents(events)[0]?.payload, {
      goal: { ...SHIP, phase: GOAL_WAITING_BACKGROUND_PHASE },
      change: "progress"
    });
    // Consumed even with no goal tracked.
    const idle = make();
    idle.normalizer.beginTurn({ turnId: "turn-1" });
    assert.deepEqual(idle.feed(syntheticUser("Goal check-in: «x» is still active.")), []);
  });

  it("the re-prompt after a turn that ended early is progress WITHOUT the waiting phase", () => {
    const { normalizer, feed } = make({
      knownGoal: { ...SHIP, phase: GOAL_WAITING_BACKGROUND_PHASE }
    });
    normalizer.beginTurn({ turnId: "turn-1" });
    const events = feed(
      syntheticUser(
        "Goal check-in: «ship the release» is still active. The last turn ended before the goal could be evaluated: the API was unavailable or the connection dropped. Continue toward the goal."
      )
    );
    assert.deepEqual(types(events), ["thread.goal.updated"], "consumed, never a user message");
    assert.deepEqual(goalEvents(events)[0]?.payload, { goal: SHIP, change: "progress" });
    // Without a phase to drop, the same re-prompt is no news at all.
    assert.deepEqual(
      feed(
        syntheticUser(
          "Goal check-in: «ship the release» is still active. The last turn ended before the goal could be evaluated: x. Continue toward the goal."
        )
      ),
      []
    );
  });

  it("a compaction summary is still the marker's body, never a goal frame", () => {
    const { normalizer, feed } = make({ knownGoal: SHIP });
    normalizer.beginTurn({ turnId: "turn-1" });
    feed({
      type: "system",
      subtype: "compact_boundary",
      session_id: "s",
      uuid: "b-1",
      compact_metadata: {
        trigger: "auto",
        pre_tokens: 10,
        preserved_messages: { anchor_uuid: "summary-1", all_uuids: [] }
      }
    });
    const events = feed({
      ...syntheticUser("This session is being continued from a previous conversation that ran out of context."),
      uuid: "summary-1"
    });
    assert.deepEqual(goalEvents(events), []);
    assert.ok(
      events.some(
        (event) =>
          event.type === "thread.state.changed" &&
          (event.payload as { summary?: string }).summary !== undefined
      ),
      "the summary rides the compaction marker"
    );
  });
});

describe("claude normaliser — active_goal (goals §6.1.6)", () => {
  function activeGoal(value: unknown): Record<string, unknown> {
    return { type: "active_goal", value, uuid: "ag-1", session_id: "s" };
  }

  it("is recognised before the exhaustiveness switch, never a warning", () => {
    const { normalizer, feed } = make({ knownGoal: SHIP });
    normalizer.beginTurn({ turnId: "turn-1" });
    const events = feed(
      activeGoal({
        condition: "ship the release",
        iterations: 1,
        set_at: 1_790_000_000_000,
        tokens_at_start: 10,
        last_reason: "tests fail"
      })
    );
    assert.equal(events.filter((event) => event.type === "runtime.warning").length, 0);
    assert.deepEqual(goalEvents(events)[0]?.payload, {
      goal: { ...SHIP, rounds: 1, lastCheck: "tests fail" },
      change: "checked"
    });
  });

  it("a value that moves nothing but the counters is progress, or nothing at all", () => {
    const { normalizer, feed } = make({ knownGoal: { ...SHIP, rounds: 2, lastCheck: "x" } });
    normalizer.beginTurn({ turnId: "turn-1" });
    assert.deepEqual(
      goalEvents(feed(activeGoal({ condition: "ship the release", iterations: 2, last_reason: "x" }))),
      []
    );
  });

  it("a value naming an untracked goal is `restored`", () => {
    const { normalizer, feed } = make();
    normalizer.beginTurn({ turnId: "turn-1" });
    const [restored] = goalEvents(
      feed(activeGoal({ condition: "ship the release", iterations: 0, set_at: 1_790_000_000_000 }))
    );
    assert.equal(restored?.payload.change, "restored");
    assert.equal(restored?.payload.goal?.setAt, new Date(1_790_000_000_000).toISOString());
  });

  it("null asks the session for the transcript check, and emits nothing itself", () => {
    let checks = 0;
    const { normalizer, feed } = make({
      knownGoal: SHIP,
      onGoalTranscriptCheck: () => {
        checks += 1;
      }
    });
    normalizer.beginTurn({ turnId: "turn-1" });
    assert.deepEqual(feed(activeGoal(null)), []);
    assert.equal(checks, 1);
    assert.deepEqual(normalizer.goals.goal, SHIP, "the transcript decides what ended it");
  });

  it("a malformed value is ignored, not warned about", () => {
    const { normalizer, feed } = make({ knownGoal: SHIP });
    normalizer.beginTurn({ turnId: "turn-1" });
    assert.deepEqual(feed(activeGoal({ condition: 42 })), []);
  });
});

describe("claude normaliser — what the transcript said after a turn (goals §6.1.4)", () => {
  it("a met row is `achieved`, with the CLI's own totals on the goal that ended", () => {
    const { normalizer } = make({ knownGoal: { ...SHIP, rounds: 2, lastCheck: "not yet" } });
    const events = normalizer.applyGoalTranscriptRows(
      [
        row({ met: false, sentinel: true, condition: "ship the release" }),
        row({
          met: true,
          condition: "ship the release",
          reason: "everything is green",
          iterations: 3,
          durationMs: 5_400_000,
          tokens: 812_000
        })
      ],
      { turnId: "turn-7", backgroundLive: false, atTurnEnd: true }
    );
    assert.deepEqual(types(events), ["thread.goal.updated"]);
    assert.deepEqual(goalEvents(events)[0]?.payload, {
      goal: null,
      change: "achieved",
      previous: {
        objective: "ship the release",
        status: "complete",
        rounds: 3,
        lastCheck: "everything is green",
        tokensUsed: 812_000,
        elapsedMs: 5_400_000
      }
    });
    assert.equal(events[0]?.turnId, "turn-7", "attributed to the turn that ended");
    assert.equal(normalizer.goals.goal, null);
  });

  it("a failed row is `failed`, with the evaluator's reason", () => {
    const { normalizer } = make({ knownGoal: SHIP });
    const [failed] = goalEvents(
      normalizer.applyGoalTranscriptRows(
        [row({ met: false, failed: true, condition: "ship the release", reason: "there is no repo", iterations: 1 })],
        { atTurnEnd: true, backgroundLive: false }
      )
    );
    assert.deepEqual(failed?.payload, {
      goal: null,
      change: "failed",
      previous: {
        objective: "ship the release",
        status: "failed",
        rounds: 1,
        lastCheck: "there is no repo"
      }
    });
  });

  it("a clear by an unrecoverable error — a met sentinel — is `cleared`", () => {
    const { normalizer } = make({ knownGoal: SHIP });
    const [cleared] = goalEvents(
      normalizer.applyGoalTranscriptRows([row({ met: true, sentinel: true, condition: "ship the release" })], {
        atTurnEnd: true,
        backgroundLive: false
      })
    );
    assert.deepEqual(cleared?.payload, { goal: null, change: "cleared", previous: SHIP });
  });

  it("rows about another condition, and checks already seen on stdout, change nothing", () => {
    const { normalizer } = make({ knownGoal: SHIP });
    assert.deepEqual(
      normalizer.applyGoalTranscriptRows(
        [
          row({ met: true, condition: "an older goal", iterations: 4 }),
          row({ met: false, condition: "ship the release", reason: "not yet" }),
          row({ met: false, sentinel: true, condition: "ship the release" })
        ],
        { atTurnEnd: true, backgroundLive: false }
      ),
      []
    );
    assert.deepEqual(normalizer.goals.goal, SHIP);
  });

  it("still unmet with background work live at turn end is `waiting-background`, and back when it is not", () => {
    const clock = movableClock();
    const { normalizer } = make({ clock, knownGoal: SHIP });
    const [waiting] = goalEvents(
      normalizer.applyGoalTranscriptRows([], { turnId: "turn-1", backgroundLive: true, atTurnEnd: true })
    );
    assert.deepEqual(waiting?.payload, {
      goal: { ...SHIP, phase: GOAL_WAITING_BACKGROUND_PHASE },
      change: "progress"
    });
    assert.deepEqual(
      normalizer.applyGoalTranscriptRows([], { turnId: "turn-2", backgroundLive: true, atTurnEnd: true }),
      [],
      "still waiting is no news"
    );
    clock.advance(GOAL_PROGRESS_THROTTLE_MS);
    const [resumed] = goalEvents(
      normalizer.applyGoalTranscriptRows([], { turnId: "turn-3", backgroundLive: false, atTurnEnd: true })
    );
    assert.deepEqual(resumed?.payload, { goal: SHIP, change: "progress" });
  });

  it("a phase change inside the throttle window is deferred, then flushed when due", () => {
    const clock = movableClock();
    const deferred: number[] = [];
    const { normalizer } = make({
      clock,
      knownGoal: SHIP,
      onGoalProgressDeferred: (dueAtMs) => deferred.push(dueAtMs)
    });
    assert.equal(
      goalEvents(normalizer.applyGoalTranscriptRows([], { backgroundLive: true, atTurnEnd: true })).length,
      1
    );
    clock.advance(5_000);
    assert.deepEqual(
      normalizer.applyGoalTranscriptRows([], { backgroundLive: false, atTurnEnd: true }),
      []
    );
    assert.deepEqual(deferred, [Date.parse("2026-09-24T10:00:00.000Z") + GOAL_PROGRESS_THROTTLE_MS]);
    clock.advance(25_000);
    const [flushed] = goalEvents(normalizer.flushGoalProgress());
    assert.deepEqual(flushed?.payload, { goal: SHIP, change: "progress" });
    assert.deepEqual(normalizer.flushGoalProgress(), []);
  });

  it("an `active_goal: null` re-read applies ended rows but never touches the phase", () => {
    const { normalizer } = make({ knownGoal: SHIP });
    assert.deepEqual(
      normalizer.applyGoalTranscriptRows([], { backgroundLive: true, atTurnEnd: false }),
      []
    );
  });

  it("a read asked for before the same goal was set again is moot", () => {
    const { normalizer, feed } = make({ knownGoal: SHIP });
    normalizer.beginTurn({ turnId: "turn-1" });
    const askedAt = normalizer.goalEpoch;
    // `/goal ship the release` again while the read is in flight: a new run.
    feed(goalOutput("Goal set: ship the release"));
    assert.deepEqual(
      normalizer.applyGoalTranscriptRows([row({ met: true, condition: "ship the release", iterations: 9 })], {
        atTurnEnd: true,
        backgroundLive: false,
        epoch: askedAt
      }),
      [],
      "the previous run's verdict never ends the new run"
    );
    assert.equal(normalizer.goals.goal?.status, "active");
  });

  it("with no goal tracked, nothing is read into it", () => {
    const { normalizer } = make();
    assert.deepEqual(
      normalizer.applyGoalTranscriptRows([row({ met: true, condition: "ship the release" })], {
        atTurnEnd: true,
        backgroundLive: true
      }),
      []
    );
  });
});

describe("claude normaliser — the restore rule on resume (goals §6.1.5)", () => {
  const last = (attachment: Record<string, unknown> | undefined) =>
    transcriptGoalFromLastRow(attachment === undefined ? undefined : row(attachment));

  it("a goal the CLI re-arms but the fold lacks is `restored`", () => {
    let setPoints = 0;
    const { normalizer } = make({
      onGoalSetPoint: () => {
        setPoints += 1;
      }
    });
    const epoch = normalizer.goalEpoch;
    const [restored] = goalEvents(
      normalizer.reconcileTranscriptGoal(last({ met: false, sentinel: true, condition: "ship the release" }))
    );
    assert.deepEqual(restored?.payload, { goal: SHIP, change: "restored" });
    assert.equal(restored?.turnId, undefined, "a session event, not a turn's");
    // The scan that found it ended at the transcript's tail: that IS the set
    // point, and a read queued behind it belongs to this very run.
    assert.equal(setPoints, 0, "no second set point");
    assert.equal(normalizer.goalEpoch, epoch, "no new run: the CLI's own run was found");
  });

  it("any goal news off stdout makes a scan asked for before it moot: a clear is never resurrected", () => {
    let setPoints = 0;
    const { normalizer, feed } = make({
      knownGoal: SHIP,
      onGoalSetPoint: () => {
        setPoints += 1;
      }
    });
    normalizer.beginTurn({ turnId: "turn-1" });
    const askedAt = normalizer.goalEpoch;
    feed(goalOutput("Goal cleared: ship the release", "clear"));
    assert.ok(normalizer.goalEpoch > askedAt, "a clear moves the epoch");
    assert.equal(setPoints, 0, "but it starts no run: no set point");
    // The slow resume scan lands now, still reading the goal as running.
    assert.deepEqual(
      normalizer.reconcileTranscriptGoal(last({ met: false, sentinel: true, condition: "ship the release" }), {
        epoch: askedAt
      }),
      [],
      "the stale scan must not restore the goal the user just cleared"
    );
    assert.equal(normalizer.goals.goal, null);
  });

  it("every stdout-derived change moves the epoch: a check, a check-in, an active_goal", () => {
    const { normalizer, feed } = make({ knownGoal: SHIP });
    normalizer.beginTurn({ turnId: "turn-1" });
    let epoch = normalizer.goalEpoch;
    feed(syntheticUser("Stop hook feedback:\n[ship the release]: not yet"));
    assert.ok(normalizer.goalEpoch > epoch, "checked");
    epoch = normalizer.goalEpoch;
    feed(
      syntheticUser(
        "Goal check-in: «ship the release» is still active, and evaluation has been deferred for 31 min because background work is still running:\n- b1"
      )
    );
    assert.ok(normalizer.goalEpoch > epoch, "check-in");
    epoch = normalizer.goalEpoch;
    feed({
      type: "active_goal",
      value: { condition: "ship the release", iterations: 5, last_reason: "x" },
      uuid: "ag",
      session_id: "s"
    });
    assert.ok(normalizer.goalEpoch > epoch, "active_goal");
    // What the transcript itself says moves nothing: it is the read.
    epoch = normalizer.goalEpoch;
    normalizer.applyGoalTranscriptRows([], { backgroundLive: true, atTurnEnd: true });
    assert.equal(normalizer.goalEpoch, epoch);
  });

  it("a stdout frame that changes nothing moves nothing — not even the epoch", () => {
    const clock = movableClock();
    const { normalizer, feed } = make({
      clock,
      knownGoal: { ...SHIP, phase: GOAL_WAITING_BACKGROUND_PHASE }
    });
    normalizer.beginTurn({ turnId: "turn-1" });
    const epoch = normalizer.goalEpoch;
    // The same waiting check-in again, and a bare /goal repeating the goal:
    // no update, so a turn-end re-read still pending must stay valid.
    assert.deepEqual(
      feed(
        syntheticUser(
          "Goal check-in: «ship the release» is still active, and evaluation has been deferred for 31 min because background work is still running:\n- b1"
        )
      ),
      []
    );
    assert.deepEqual(goalEvents(feed(goalOutput("Goal active: ship the release (not yet evaluated)"))), []);
    assert.equal(normalizer.goalEpoch, epoch, "unchanged goal news is no news");

    // A progress the throttle holds back is not emitted either.
    assert.equal(goalEvents(feed(goalOutput("Goal active: ship the release (1 turn)"))).length, 1);
    const afterEmit = normalizer.goalEpoch;
    assert.ok(afterEmit > epoch, "an emitted update moves it");
    clock.advance(1_000);
    assert.deepEqual(goalEvents(feed(goalOutput("Goal active: ship the release (2 turns)"))), []);
    assert.equal(normalizer.goalEpoch, afterEmit, "a deferred progress is not emitted yet");
  });

  it("a `restored` read off stdout starts a run: set point and epoch both move", () => {
    let setPoints = 0;
    const { normalizer, feed } = make({
      onGoalSetPoint: () => {
        setPoints += 1;
      }
    });
    normalizer.beginTurn({ turnId: "turn-1" });
    const epoch = normalizer.goalEpoch;
    feed(goalOutput("Goal active: ship the release (1 turn)"));
    assert.equal(setPoints, 1);
    assert.equal(normalizer.goalEpoch, epoch + 1);
  });

  it("the same goal on both sides is no news", () => {
    const { normalizer } = make({ knownGoal: { ...SHIP, rounds: 4 } });
    assert.deepEqual(
      normalizer.reconcileTranscriptGoal(last({ met: false, condition: "ship the release", reason: "x" })),
      []
    );
  });

  it("a different goal in the transcript replaces the fold's", () => {
    const { normalizer } = make({ knownGoal: { ...SHIP, objective: "an older goal" } });
    const [restored] = goalEvents(
      normalizer.reconcileTranscriptGoal(last({ met: false, sentinel: true, condition: "ship the release" }))
    );
    assert.equal(restored?.payload.change, "restored");
    assert.equal(restored?.payload.goal?.objective, "ship the release");
  });

  it("the fold's goal that the transcript ended is `achieved`, `failed` or `cleared`", () => {
    const met = make({ knownGoal: SHIP });
    assert.equal(
      goalEvents(met.normalizer.reconcileTranscriptGoal(last({ met: true, condition: "ship the release", iterations: 2 })))[0]
        ?.payload.change,
      "achieved"
    );
    const failed = make({ knownGoal: SHIP });
    assert.equal(
      goalEvents(
        failed.normalizer.reconcileTranscriptGoal(last({ met: false, failed: true, condition: "ship the release" }))
      )[0]?.payload.change,
      "failed"
    );
    const cleared = make({ knownGoal: SHIP });
    assert.equal(
      goalEvents(
        cleared.normalizer.reconcileTranscriptGoal(last({ met: true, sentinel: true, condition: "ship the release" }))
      )[0]?.payload.change,
      "cleared"
    );
  });

  it("the fold's goal with no goal_status at all is `cleared`; no goal on either side is nothing", () => {
    const tracked = make({ knownGoal: SHIP });
    assert.deepEqual(goalEvents(tracked.normalizer.reconcileTranscriptGoal(last(undefined)))[0]?.payload, {
      goal: null,
      change: "cleared",
      previous: SHIP
    });
    const none = make();
    assert.deepEqual(none.normalizer.reconcileTranscriptGoal(last(undefined)), []);
    const finished = make({ knownGoal: { ...SHIP, status: "complete" } });
    assert.deepEqual(finished.normalizer.reconcileTranscriptGoal(last(undefined)), []);
  });

  it("a session that ends takes its background work with it: the waiting phase is dropped at once", () => {
    const clock = movableClock();
    const deferred: number[] = [];
    const { normalizer } = make({
      clock,
      knownGoal: SHIP,
      onGoalProgressDeferred: (dueAtMs) => deferred.push(dueAtMs)
    });
    assert.equal(
      goalEvents(normalizer.applyGoalTranscriptRows([], { backgroundLive: true, atTurnEnd: true })).length,
      1,
      "waiting-background is reported"
    );
    clock.advance(1_000);
    // Inside the throttle window: an ordinary progress would be deferred, but
    // a session going away cannot wait for a timer it is about to cancel.
    const [ended] = goalEvents(normalizer.goalAtSessionEnd());
    assert.deepEqual(ended?.payload, { goal: SHIP, change: "progress" });
    assert.deepEqual(deferred, [], "emitted now, not deferred");
    assert.deepEqual(normalizer.goalAtSessionEnd(), [], "and only once");
  });

  it("a session that ends flushes a throttled progress rather than dropping it", () => {
    const clock = movableClock();
    const { normalizer, feed } = make({ clock, knownGoal: SHIP });
    normalizer.beginTurn({ turnId: "turn-1" });
    assert.equal(goalEvents(feed(goalOutput("Goal active: ship the release (1 turn)"))).length, 1);
    clock.advance(1_000);
    assert.deepEqual(goalEvents(feed(goalOutput("Goal active: ship the release (2 turns)"))), []);
    const [flushed] = goalEvents(normalizer.goalAtSessionEnd());
    assert.deepEqual(flushed?.payload, { goal: { ...SHIP, rounds: 2 }, change: "progress" });
    // No goal, or a finished one: nothing to settle.
    assert.deepEqual(make().normalizer.goalAtSessionEnd(), []);
  });

  it("a new process has nothing in the background: a stale waiting phase is dropped", () => {
    const { normalizer } = make({ knownGoal: { ...SHIP, phase: GOAL_WAITING_BACKGROUND_PHASE } });
    const [progress] = goalEvents(
      normalizer.reconcileTranscriptGoal(last({ met: false, sentinel: true, condition: "ship the release" }))
    );
    assert.deepEqual(progress?.payload, { goal: SHIP, change: "progress" });
  });
});
