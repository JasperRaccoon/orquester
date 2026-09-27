/**
 * The Claude `/goal` mirror's pure half (goals §3.1, §6.1): every text the
 * CLI prints for `/goal`, the Stop-hook feedback and check-in frames,
 * `active_goal`, the transcript's `goal_status` rows with the CLI's own
 * restore rule, and the tracker that decides what is worth an update (§6).
 *
 * The texts are the CLI's own (Claude Code 2.1.280, read out of the installed
 * binary for the goals spec); the conditions are invented.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentGoal } from "@orquester/api/agent-chat";

import type { Clock } from "../../adapter.ts";
import {
  ClaudeGoalTracker,
  GOAL_PROGRESS_THROTTLE_MS,
  GOAL_WAITING_BACKGROUND_PHASE,
  STOP_HOOK_CONDITION_CUT,
  localCommandOutputText,
  matchGoalStopHookFeedback,
  parseActiveGoalValue,
  parseGoalCheckIn,
  parseGoalCommandOutput,
  parseGoalStatusRow,
  transcriptGoalFromLastRow
} from "./goal.ts";

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

function goalStatusRow(attachment: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "attachment",
    uuid: "63d6e40a-0000-4000-8000-000000000000",
    parentUuid: "708e8045-0000-4000-8000-000000000000",
    sessionId: "08f59265-0000-4000-8000-000000000000",
    attachment: { type: "goal_status", ...attachment }
  };
}

describe("claude goal — the /goal command's own output (goals §6.1.2)", () => {
  it("reads a set", () => {
    assert.deepEqual(parseGoalCommandOutput("Goal set: ship the release with green tests"), {
      kind: "set",
      objective: "ship the release with green tests"
    });
  });

  it("reads a replace, which prints exactly what a set prints", () => {
    assert.deepEqual(parseGoalCommandOutput("Goal set: a different goal", "the old goal"), {
      kind: "set",
      objective: "a different goal"
    });
  });

  it("keeps a multi-line condition whole and ignores surrounding whitespace", () => {
    assert.deepEqual(parseGoalCommandOutput("  Goal set: line one\nline two \n"), {
      kind: "set",
      objective: "line one\nline two"
    });
  });

  it("reads a bare /goal that has not been evaluated yet", () => {
    assert.deepEqual(parseGoalCommandOutput("Goal active: ship it (not yet evaluated)"), {
      kind: "active",
      objective: "ship it",
      rounds: 0
    });
  });

  it("reads a bare /goal with rounds, singular and plural, and its last check", () => {
    assert.deepEqual(parseGoalCommandOutput("Goal active: ship it (1 turn)"), {
      kind: "active",
      objective: "ship it",
      rounds: 1
    });
    assert.deepEqual(
      parseGoalCommandOutput("Goal active: ship it (3 turns)\nLast check: the e2e suite still fails"),
      {
        kind: "active",
        objective: "ship it",
        rounds: 3,
        lastCheck: "the e2e suite still fails"
      }
    );
  });

  it("finds the status suffix behind a condition that has parentheses of its own", () => {
    assert.deepEqual(parseGoalCommandOutput("Goal active: fix (all of) the bugs (2 turns)"), {
      kind: "active",
      objective: "fix (all of) the bugs",
      rounds: 2
    });
    // With the tracked objective the parse is anchored on it.
    const tricky = "stop at (1 turn) please";
    assert.deepEqual(parseGoalCommandOutput(`Goal active: ${tricky} (4 turns)`, tricky), {
      kind: "active",
      objective: tricky,
      rounds: 4
    });
  });

  it("reads a clear, and both spellings of 'no goal'", () => {
    assert.deepEqual(parseGoalCommandOutput("Goal cleared: ship it"), {
      kind: "cleared",
      objective: "ship it"
    });
    assert.deepEqual(parseGoalCommandOutput("No goal set"), { kind: "none" });
    assert.deepEqual(parseGoalCommandOutput("No goal set. Usage: `/goal <condition>`"), {
      kind: "none"
    });
  });

  it("reads both refusals, and any other text, as no goal change", () => {
    assert.deepEqual(
      parseGoalCommandOutput("Goal condition is limited to 4000 characters (got 4012)"),
      { kind: "other" }
    );
    assert.deepEqual(
      parseGoalCommandOutput(
        "/goal can't run while hooks are restricted (disableAllHooks or allowManagedHooksOnly is set in settings or by policy)."
      ),
      { kind: "other" }
    );
    assert.deepEqual(parseGoalCommandOutput("Total cost: $0.42"), { kind: "other" });
    assert.deepEqual(parseGoalCommandOutput("Goal active: no status suffix here"), {
      kind: "other"
    });
  });

  it("takes the text from the content, falling back to the tagged local_command_source", () => {
    assert.equal(
      localCommandOutputText([{ type: "text", text: "Goal set: x" }], undefined),
      "Goal set: x"
    );
    assert.equal(
      localCommandOutputText([], "<local-command-stdout>Goal set: x</local-command-stdout>"),
      "Goal set: x"
    );
    assert.equal(
      localCommandOutputText(undefined, "<local-command-stdout>No goal set</local-command-stdout>"),
      "No goal set"
    );
    assert.equal(localCommandOutputText([], undefined), undefined);
    assert.equal(localCommandOutputText("not blocks", 42), undefined);
  });
});

describe("claude goal — Stop-hook feedback and the check-in (goals §6.1.3)", () => {
  it("matches the tracked goal's feedback and reads the evaluator's reason", () => {
    assert.deepEqual(
      matchGoalStopHookFeedback(
        "Stop hook feedback:\n[ship the release]: the changelog is still missing",
        "ship the release"
      ),
      { reason: "the changelog is still missing" }
    );
  });

  it("does not claim another prompt hook's feedback", () => {
    assert.equal(
      matchGoalStopHookFeedback("Stop hook feedback:\n[lint is clean]: 3 errors", "ship it"),
      undefined
    );
    // A plain prefix is not a match either: only a CUT condition may be shorter.
    assert.equal(
      matchGoalStopHookFeedback("Stop hook feedback:\n[ship]: not yet", "ship it"),
      undefined
    );
  });

  it("matches a condition the CLI cut to 500 characters, marker and all", () => {
    const objective = `${"a".repeat(700)} and then stop`;
    const cut = objective.slice(0, STOP_HOOK_CONDITION_CUT);
    const hidden = objective.length - cut.length;
    assert.deepEqual(
      matchGoalStopHookFeedback(
        `Stop hook feedback:\n[${cut}… [+${hidden} chars]]: nothing is done yet`,
        objective
      ),
      { reason: "nothing is done yet" }
    );
    // An older spelling that only cut, without a marker.
    assert.deepEqual(
      matchGoalStopHookFeedback(`Stop hook feedback:\n[${cut}]: still not`, objective),
      { reason: "still not" }
    );
  });

  it("finds the condition's end even when the condition itself contains ']: '", () => {
    assert.deepEqual(
      matchGoalStopHookFeedback("Stop hook feedback:\n[a]: b]: the reason", "a]: b"),
      { reason: "the reason" }
    );
  });

  it("ignores text that is not a Stop-hook feedback frame", () => {
    assert.equal(matchGoalStopHookFeedback("[ship it]: no", "ship it"), undefined);
    assert.equal(matchGoalStopHookFeedback("Stop hook feedback: ship it", "ship it"), undefined);
  });

  it("reads the turn-end check-in and the idle one", () => {
    assert.deepEqual(
      parseGoalCheckIn(
        "Goal check-in: «ship it» is still active, and evaluation has been deferred for 31 min because background work is still running:\n- b1 · shell · npm test\nCheck on their progress (e.g. read their output)."
      ),
      { backgroundRunning: true }
    );
    assert.deepEqual(
      parseGoalCheckIn(
        "Goal check-in: «ship it» is still active. Its evaluation was deferred for 12 min while background work ran, and that work is no longer running (it finished or was stopped without reporting back). Continue toward the goal."
      ),
      { backgroundRunning: false }
    );
    assert.equal(parseGoalCheckIn("Goal set: x"), undefined);
  });

  it("reads the re-prompt after a turn that ended early as NOT waiting on background work", () => {
    // Claude Code 2.1.280 sends this after a turn an API error cut short: the
    // goal was never evaluated, and nothing is running in the background.
    assert.deepEqual(
      parseGoalCheckIn(
        "Goal check-in: «ship it» is still active. The last turn ended before the goal could be evaluated: the API returned an unexpected response. Continue toward the goal."
      ),
      { backgroundRunning: false }
    );
    // Only the turn-end deferral's own words mean background work: the idle
    // cap's appended sentence changes nothing.
    assert.deepEqual(
      parseGoalCheckIn(
        "Goal check-in: «ship it» is still active, and evaluation has been deferred for 64 min because background work is still running:\n- b1 · monitor · tail\nCheck on their progress. Claude Code won't wake this session for another check-in until the user sends a message, so say clearly where things stand."
      ),
      { backgroundRunning: true }
    );
  });
});

describe("claude goal — active_goal (goals §6.1.6)", () => {
  it("reads a value field-wise", () => {
    assert.deepEqual(
      parseActiveGoalValue({
        condition: "ship it",
        iterations: 2,
        set_at: Date.parse("2026-09-24T09:00:00.000Z"),
        tokens_at_start: 1200,
        last_reason: "tests fail"
      }),
      {
        condition: "ship it",
        iterations: 2,
        setAt: "2026-09-24T09:00:00.000Z",
        lastReason: "tests fail"
      }
    );
    assert.deepEqual(parseActiveGoalValue({ condition: "ship it", iterations: 0 }), {
      condition: "ship it",
      iterations: 0
    });
  });

  it("drops a set_at outside the Date range instead of throwing", () => {
    // `new Date(ms).toISOString()` throws a RangeError past 8.64e15 ms.
    for (const setAt of [9e15, 8.64e15 + 1, Number.MAX_SAFE_INTEGER, -1, 0, Number.NaN]) {
      assert.deepEqual(
        parseActiveGoalValue({ condition: "ship it", iterations: 1, set_at: setAt }),
        { condition: "ship it", iterations: 1 },
        String(setAt)
      );
    }
    assert.equal(
      parseActiveGoalValue({ condition: "ship it", iterations: 1, set_at: 8.64e15 })?.setAt,
      new Date(8.64e15).toISOString(),
      "the last representable instant is still a time"
    );
  });

  it("reads null (and a missing value) as 'no goal', and a malformed one as nothing", () => {
    assert.equal(parseActiveGoalValue(null), null);
    assert.equal(parseActiveGoalValue(undefined), null);
    assert.equal(parseActiveGoalValue({ condition: "", iterations: 1 }), undefined);
    assert.equal(parseActiveGoalValue({ condition: "x", iterations: -1 }), undefined);
    assert.equal(parseActiveGoalValue({ condition: 7, iterations: 1 }), undefined);
    assert.equal(parseActiveGoalValue("ship it"), undefined);
  });
});

describe("claude goal — goal_status rows and the restore rule (goals §3.1, §6.1.4-5)", () => {
  it("reads the set sentinel, a check, a met, an impossible and a clear", () => {
    assert.deepEqual(
      parseGoalStatusRow(goalStatusRow({ met: false, sentinel: true, condition: "ship it" })),
      { met: false, sentinel: true, failed: false, condition: "ship it" }
    );
    assert.deepEqual(
      parseGoalStatusRow(goalStatusRow({ met: false, condition: "ship it", reason: "not yet" })),
      { met: false, sentinel: false, failed: false, condition: "ship it", reason: "not yet" }
    );
    assert.deepEqual(
      parseGoalStatusRow(
        goalStatusRow({
          met: true,
          condition: "ship it",
          reason: "all green",
          iterations: 3,
          durationMs: 5_400_000,
          tokens: 812_000
        })
      ),
      {
        met: true,
        sentinel: false,
        failed: false,
        condition: "ship it",
        reason: "all green",
        iterations: 3,
        durationMs: 5_400_000,
        tokens: 812_000
      }
    );
    assert.deepEqual(
      parseGoalStatusRow(
        goalStatusRow({ met: false, failed: true, condition: "ship it", reason: "no repo", iterations: 1 })
      ),
      { met: false, sentinel: false, failed: true, condition: "ship it", reason: "no repo", iterations: 1 }
    );
    assert.deepEqual(
      parseGoalStatusRow(goalStatusRow({ met: true, sentinel: true, condition: "ship it" })),
      { met: true, sentinel: true, failed: false, condition: "ship it" }
    );
  });

  it("ignores every other row and drops malformed numbers", () => {
    assert.equal(parseGoalStatusRow({ type: "attachment", attachment: { type: "date" } }), undefined);
    assert.equal(parseGoalStatusRow({ type: "user", attachment: { type: "goal_status" } }), undefined);
    assert.equal(parseGoalStatusRow(null), undefined);
    assert.equal(parseGoalStatusRow("goal_status"), undefined);
    assert.deepEqual(
      parseGoalStatusRow(goalStatusRow({ met: true, condition: "x", iterations: -2, tokens: "9" })),
      { met: true, sentinel: false, failed: false, condition: "x" }
    );
  });

  it("applies restoreGoalFromTranscript's rule: the LAST row decides", () => {
    const row = (attachment: Record<string, unknown>) => parseGoalStatusRow(goalStatusRow(attachment));
    assert.deepEqual(transcriptGoalFromLastRow(undefined), { kind: "none" });
    assert.deepEqual(transcriptGoalFromLastRow(row({ met: false, sentinel: true, condition: "a" })), {
      kind: "active",
      objective: "a"
    });
    assert.deepEqual(transcriptGoalFromLastRow(row({ met: false, condition: "a", reason: "r" })), {
      kind: "active",
      objective: "a"
    });
    const met = row({ met: true, condition: "a", iterations: 2 });
    assert.deepEqual(transcriptGoalFromLastRow(met), { kind: "ended", row: met });
    const failed = row({ met: false, failed: true, condition: "a" });
    assert.deepEqual(transcriptGoalFromLastRow(failed), { kind: "ended", row: failed });
    const cleared = row({ met: true, sentinel: true, condition: "a" });
    assert.deepEqual(transcriptGoalFromLastRow(cleared), { kind: "ended", row: cleared });
    assert.deepEqual(transcriptGoalFromLastRow(row({ met: false, condition: "" })), { kind: "none" });
  });
});

describe("claude goal — the tracker (goals §6 preamble)", () => {
  const active = (extra: Partial<AgentGoal> = {}): AgentGoal => ({
    objective: "ship it",
    status: "active",
    rounds: 0,
    ...extra
  });

  it("is seeded from knownGoal, so repeating it is not a change", () => {
    const tracker = new ClaudeGoalTracker({ clock: movableClock(), knownGoal: active() });
    assert.deepEqual(tracker.goal, active());
    assert.deepEqual(tracker.apply("set", active()), { kind: "unchanged" });
    assert.deepEqual(tracker.apply("progress", active()), { kind: "unchanged" });
  });

  it("drops a seeded goal's updatedAt: the fold's stamp is not provider state", () => {
    const tracker = new ClaudeGoalTracker({
      clock: movableClock(),
      knownGoal: { ...active(), updatedAt: "2026-09-24T00:00:00.000Z" } as AgentGoal
    });
    assert.deepEqual(tracker.goal, active());
  });

  it("emits a real change with the whole goal", () => {
    const tracker = new ClaudeGoalTracker({ clock: movableClock() });
    assert.deepEqual(tracker.apply("set", active()), {
      kind: "emit",
      payload: { goal: active(), change: "set" }
    });
    assert.deepEqual(tracker.lastEmitted, active());
  });

  it("always emits achieved, failed and cleared, with the goal that ended", () => {
    const tracker = new ClaudeGoalTracker({ clock: movableClock(), knownGoal: active() });
    const ended = active({ status: "complete", rounds: 3 });
    assert.deepEqual(tracker.apply("achieved", null, ended), {
      kind: "emit",
      payload: { goal: null, change: "achieved", previous: ended }
    });
    assert.equal(tracker.goal, null);
    // A clear of nothing is still reported: the CLI said so.
    assert.equal(tracker.apply("cleared", null, active()).kind, "emit");
  });

  it("throttles progress to one per 30 s and flushes the latest one when due", () => {
    const clock = movableClock();
    const tracker = new ClaudeGoalTracker({ clock, knownGoal: active() });
    const first = active({ phase: GOAL_WAITING_BACKGROUND_PHASE });
    assert.equal(tracker.apply("progress", first).kind, "emit");

    clock.advance(10_000);
    const second = active({ rounds: 2 });
    const deferred = tracker.apply("progress", second);
    assert.deepEqual(deferred, {
      kind: "deferred",
      dueAtMs: Date.parse("2026-09-24T10:00:00.000Z") + GOAL_PROGRESS_THROTTLE_MS
    });
    assert.deepEqual(tracker.goal, second, "the latest state is kept for the next decision");
    assert.deepEqual(tracker.lastEmitted, first, "but nothing was emitted");
    assert.equal(tracker.pendingProgressDueAtMs, deferred.kind === "deferred" ? deferred.dueAtMs : 0);

    clock.advance(20_000);
    assert.deepEqual(tracker.flushProgress(), {
      kind: "emit",
      payload: { goal: second, change: "progress" }
    });
    assert.equal(tracker.pendingProgressDueAtMs, undefined);
    assert.deepEqual(tracker.flushProgress(), { kind: "unchanged" });

    clock.advance(GOAL_PROGRESS_THROTTLE_MS);
    assert.equal(tracker.apply("progress", active({ rounds: 3 })).kind, "emit");
  });

  it("never throttles anything but progress, and a real change supersedes a deferred one", () => {
    const clock = movableClock();
    const tracker = new ClaudeGoalTracker({ clock, knownGoal: active() });
    assert.equal(tracker.apply("progress", active({ phase: GOAL_WAITING_BACKGROUND_PHASE })).kind, "emit");
    clock.advance(1_000);
    assert.equal(tracker.apply("progress", active({ rounds: 5 })).kind, "deferred");
    clock.advance(1_000);
    const checked = active({ rounds: 6, lastCheck: "not yet" });
    assert.deepEqual(tracker.apply("checked", checked), {
      kind: "emit",
      payload: { goal: checked, change: "checked" }
    });
    assert.equal(tracker.pendingProgressDueAtMs, undefined);
    assert.deepEqual(tracker.flushProgress(), { kind: "unchanged" });
  });

  it("a progress back to the emitted state cancels the deferred one", () => {
    const clock = movableClock();
    const tracker = new ClaudeGoalTracker({ clock, knownGoal: active() });
    assert.equal(tracker.apply("progress", active({ rounds: 1 })).kind, "emit");
    assert.equal(tracker.apply("progress", active({ rounds: 2 })).kind, "deferred");
    assert.deepEqual(tracker.apply("progress", active({ rounds: 1 })), { kind: "unchanged" });
    assert.equal(tracker.pendingProgressDueAtMs, undefined);
    assert.deepEqual(tracker.flushProgress(), { kind: "unchanged" });
  });
});
