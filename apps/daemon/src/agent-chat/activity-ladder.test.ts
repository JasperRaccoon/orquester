import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { AgentChatSessionSummaryFields, LatestTurnSummary, TurnState } from "@orquester/api";
import { pushTypeForFields, pushTypeForRung, resolveChatActivity } from "./activity-ladder.ts";

// The ONE ladder of §6.4. Every rung, in priority order, plus the two race
// fallbacks the spec calls non-optional — each of these encodes a bug T3 hit.

const turn = (state: TurnState, completedAt: string | null = null): LatestTurnSummary => ({
  turnId: "t1",
  state,
  startedAt: "2026-09-21T00:00:00.000Z",
  completedAt
});

test("rung 1: a pending approval outranks everything", () => {
  const resolved = resolveChatActivity({
    hasPendingApprovals: true,
    hasPendingUserInput: true,
    chatSessionStatus: "running",
    backgroundLiveness: "working",
    latestTurn: turn("running")
  });
  assert.equal(resolved.rung, "approval");
  assert.equal(resolved.state, "waiting");
  assert.equal(resolved.attention, "needs-input");
});

test("rung 2: a pending question outranks the session state", () => {
  const resolved = resolveChatActivity({
    hasPendingUserInput: true,
    chatSessionStatus: "running",
    latestTurn: turn("running")
  });
  assert.equal(resolved.rung, "question");
  assert.equal(resolved.state, "waiting");
});

test("rung 3: a failed session outranks lingering background liveness", () => {
  // T3's review finding: the user must see the failure, not a stale Working.
  const resolved = resolveChatActivity({
    chatSessionStatus: "error",
    backgroundLiveness: "working"
  });
  assert.equal(resolved.rung, "error");
  assert.equal(resolved.state, "idle");
  assert.equal(resolved.attention, "finished");
});

test("rung 3: a failed TURN is an error even with a ready session", () => {
  const resolved = resolveChatActivity({
    chatSessionStatus: "ready",
    latestTurn: turn("failed", "2026-09-21T00:01:00.000Z")
  });
  assert.equal(resolved.rung, "error");
});

test("rung 4: starting is working", () => {
  const resolved = resolveChatActivity({ chatSessionStatus: "starting" });
  assert.equal(resolved.rung, "starting");
  assert.equal(resolved.state, "working");
  assert.equal(resolved.attention, null);
});

test("rung 5: a running session or a running turn is working", () => {
  assert.equal(resolveChatActivity({ chatSessionStatus: "running" }).rung, "running");
  assert.equal(
    resolveChatActivity({ chatSessionStatus: "ready", latestTurn: turn("running") }).rung,
    "running"
  );
  // A turn between `/turn` and the provider's first `turn.started` has no id
  // yet; it must not read as idle while the user waits.
  assert.equal(
    resolveChatActivity({ chatSessionStatus: "ready", latestTurn: turn("pending") }).rung,
    "running"
  );
});

const settled = turn("completed", "2026-09-21T00:01:00.000Z");

test("rung 6: an actionable plan on a settled turn is waiting + needs-input", () => {
  // *T3: `Sidebar.logic.ts:1049-1066`.* The agent is done and the user owes it
  // a decision, so it is `waiting`, not `finished`.
  const resolved = resolveChatActivity({
    chatSessionStatus: "ready",
    hasActionableProposedPlan: true,
    latestTurn: settled
  });
  assert.equal(resolved.rung, "plan-ready");
  assert.equal(resolved.state, "waiting");
  assert.equal(resolved.attention, "needs-input");
});

test("rung 6 outranks background working and monitoring", () => {
  // T3's review finding: the plan needs a decision, liveness merely reports.
  for (const liveness of ["working", "monitoring"] as const) {
    assert.equal(
      resolveChatActivity({
        chatSessionStatus: "ready",
        backgroundLiveness: liveness,
        hasActionableProposedPlan: true,
        latestTurn: settled
      }).rung,
      "plan-ready",
      liveness
    );
  }
});

test("rung 6 sits BELOW approval, question, error and a running turn", () => {
  const base = { hasActionableProposedPlan: true, latestTurn: settled } as const;
  assert.equal(
    resolveChatActivity({ ...base, chatSessionStatus: "ready", hasPendingApprovals: true }).rung,
    "approval"
  );
  assert.equal(
    resolveChatActivity({ ...base, chatSessionStatus: "ready", hasPendingUserInput: true }).rung,
    "question"
  );
  assert.equal(resolveChatActivity({ ...base, chatSessionStatus: "error" }).rung, "error");
  // A still-running session means the turn is not settled, so there is nothing
  // to decide on yet.
  assert.equal(
    resolveChatActivity({
      hasActionableProposedPlan: true,
      chatSessionStatus: "running",
      latestTurn: settled
    }).rung,
    "running"
  );
});

test("rung 6 needs a SETTLED turn: no turn, or one still open, is not plan-ready", () => {
  assert.equal(
    resolveChatActivity({ chatSessionStatus: "ready", hasActionableProposedPlan: true }).rung,
    "completed",
    "no turn row at all — race fallback 2, not a plan prompt"
  );
  assert.equal(
    resolveChatActivity({
      chatSessionStatus: "ready",
      hasActionableProposedPlan: true,
      latestTurn: turn("completed", null)
    }).rung,
    "completed"
  );
});

test("rung 7: background liveness `working` keeps the thread working after the turn", () => {
  const resolved = resolveChatActivity({
    chatSessionStatus: "ready",
    backgroundLiveness: "working",
    latestTurn: turn("completed", "2026-09-21T00:01:00.000Z")
  });
  assert.equal(resolved.rung, "background-working");
  assert.equal(resolved.state, "working");
  assert.equal(resolved.attention, null);
});

test("rung 8: monitoring is idle WITHOUT a finished stamp", () => {
  const resolved = resolveChatActivity({
    chatSessionStatus: "ready",
    backgroundLiveness: "monitoring",
    latestTurn: turn("completed", "2026-09-21T00:01:00.000Z")
  });
  assert.equal(resolved.rung, "monitoring");
  assert.equal(resolved.state, "idle");
  assert.equal(resolved.attention, null, "a settled turn whose watch loops run is not finished");
});

test("rung 9: a completed turn is idle + finished", () => {
  const resolved = resolveChatActivity({
    chatSessionStatus: "ready",
    latestTurn: turn("completed", "2026-09-21T00:01:00.000Z")
  });
  assert.equal(resolved.rung, "completed");
  assert.equal(resolved.state, "idle");
  assert.equal(resolved.attention, "finished");
});

test("race fallback 1: `interrupted` WITH a completedAt is finished", () => {
  // Session teardown settles still-running turns by session status and that
  // write races turn.completed; completedAt survives the race.
  const resolved = resolveChatActivity({
    chatSessionStatus: "stopped",
    latestTurn: turn("interrupted", "2026-09-21T00:01:00.000Z")
  });
  assert.equal(resolved.rung, "completed");
  assert.equal(resolved.attention, "finished");
});

test("race fallback 1 does NOT fire without a completedAt", () => {
  const resolved = resolveChatActivity({
    chatSessionStatus: "stopped",
    latestTurn: turn("interrupted", null)
  });
  assert.equal(resolved.rung, "unknown");
  assert.equal(resolved.attention, null);
});

test("race fallback 2: a live `ready` session with nothing pending is finished", () => {
  // A turn that changed no files leaves no turn row to read.
  const resolved = resolveChatActivity({ chatSessionStatus: "ready" });
  assert.equal(resolved.rung, "completed");
  assert.equal(resolved.attention, "finished");
  assert.equal(resolveChatActivity({ chatSessionStatus: "idle" }).rung, "completed");
});

test("an empty summary resolves to nothing rather than to finished", () => {
  const resolved = resolveChatActivity({});
  assert.equal(resolved.rung, "unknown");
  assert.equal(resolved.state, "idle");
  assert.equal(resolved.attention, null);
});

test("push copy follows the rung", () => {
  assert.equal(pushTypeForRung("approval"), "needs-input");
  assert.equal(pushTypeForRung("question"), "needs-input");
  assert.equal(pushTypeForRung("completed"), "finished");
  assert.equal(pushTypeForRung("error"), "finished");
  // Its own kind, not a `needs-input` with different words: nothing is blocked
  // on an answer, and the work is not finished either.
  assert.equal(pushTypeForRung("plan-ready"), "plan-ready");
  for (const rung of [
    "starting",
    "running",
    "goal-continuing",
    "background-working",
    "monitoring",
    "unknown"
  ] as const) {
    assert.equal(pushTypeForRung(rung), null, rung);
  }
});

test("a plan-ready thread pushes even while background work is live", () => {
  // Only a `finished` push is suppressed by liveness; being asked to decide is
  // not a claim that the thread is done.
  assert.equal(
    pushTypeForFields({
      chatSessionStatus: "ready",
      hasActionableProposedPlan: true,
      backgroundLiveness: "working",
      latestTurn: { turnId: "t1", state: "completed", startedAt: "2026-09-21T00:00:00.000Z", completedAt: "2026-09-21T00:01:00.000Z" }
    }),
    "plan-ready"
  );
});

// --- goals §4.7: a goal the provider keeps working on by itself ---------------

const continuing = { objective: "ship it", status: "active" as const, continuing: true };

test("a continuing goal keeps a settled turn from reading as finished", () => {
  // Codex starts the next turn itself while its goal is active: the settle
  // between two of those turns is a pause, not the end of the work.
  const resolved = resolveChatActivity({
    chatSessionStatus: "ready",
    latestTurn: settled,
    goal: continuing
  });
  assert.equal(resolved.rung, "goal-continuing");
  assert.equal(resolved.state, "working");
  assert.equal(resolved.attention, null, "no finished stamp");
  assert.equal(
    pushTypeForFields({ chatSessionStatus: "ready", latestTurn: settled, goal: continuing }),
    null,
    "and no finished push"
  );
});

test("a continuing goal also covers both race fallbacks", () => {
  // No turn row at all (a turn that changed nothing), and a torn-down turn
  // that still carries its completion stamp.
  assert.equal(resolveChatActivity({ chatSessionStatus: "ready", goal: continuing }).rung, "goal-continuing");
  assert.equal(
    resolveChatActivity({
      chatSessionStatus: "ready",
      latestTurn: turn("interrupted", "2026-09-21T00:01:00.000Z"),
      goal: continuing
    }).rung,
    "goal-continuing"
  );
});

test("a failed TURN alone does not end a continuing goal — the goal's own status does", () => {
  // Continuation is the provider's, at every turn's end (Codex fixtures
  // README, observation 19). A provider that stops its goal reports it in a
  // goal update; until then the goal continues, and the failure surfaces the
  // moment `continuing` ends.
  const failed = turn("failed", "2026-09-21T00:01:00.000Z");
  assert.equal(
    resolveChatActivity({ chatSessionStatus: "ready", latestTurn: failed, goal: continuing }).rung,
    "goal-continuing"
  );
  assert.equal(
    resolveChatActivity({
      chatSessionStatus: "ready",
      latestTurn: failed,
      goal: { ...continuing, status: "blocked", continuing: false }
    }).rung,
    "error"
  );
});

test("an errored session is an error unless the HOST says the goal still continues", () => {
  // Without a pending resume the host never reports an errored session's goal
  // as continuing, so an error is an error — the goal masks nothing.
  const notContinuing = { ...continuing, continuing: false };
  assert.equal(resolveChatActivity({ chatSessionStatus: "error", goal: notContinuing }).rung, "error");
  assert.equal(pushTypeForFields({ chatSessionStatus: "error", goal: notContinuing }), "finished");
  assert.equal(resolveChatActivity({ chatSessionStatus: "error", goal: null }).rung, "error");
  // With one pending (goals §5.5: a goal turn killed by a restart, settled as
  // an error while its session is being resumed), the host's `continuing` is
  // authoritative: no finished stamp, no push — the ladder re-derives nothing.
  const gap = resolveChatActivity({
    chatSessionStatus: "error",
    latestTurn: turn("failed", "2026-09-21T00:01:00.000Z"),
    goal: continuing
  });
  assert.equal(gap.rung, "goal-continuing");
  assert.equal(gap.state, "working");
  assert.equal(gap.attention, null);
  assert.equal(pushTypeForFields({ chatSessionStatus: "error", goal: continuing }), null);
});

test("a continuing goal never outranks the user or a running turn", () => {
  // The agent blocked on the user outranks everything.
  assert.equal(
    resolveChatActivity({ chatSessionStatus: "ready", hasPendingApprovals: true, goal: continuing }).rung,
    "approval"
  );
  assert.equal(
    resolveChatActivity({ chatSessionStatus: "ready", hasPendingUserInput: true, goal: continuing }).rung,
    "question"
  );
  // A running turn is still named as one.
  assert.equal(
    resolveChatActivity({ chatSessionStatus: "running", latestTurn: turn("running"), goal: continuing }).rung,
    "running"
  );
});

test("a continuing goal outranks a plan prompt and lingering liveness: the thread is working", () => {
  assert.equal(
    resolveChatActivity({
      chatSessionStatus: "ready",
      hasActionableProposedPlan: true,
      latestTurn: settled,
      goal: continuing
    }).rung,
    "goal-continuing"
  );
  const monitoring = resolveChatActivity({
    chatSessionStatus: "ready",
    backgroundLiveness: "monitoring",
    latestTurn: settled,
    goal: continuing
  });
  assert.equal(monitoring.rung, "goal-continuing");
  assert.equal(monitoring.state, "working");
});

test("a goal that is not continuing changes nothing", () => {
  for (const goal of [
    null,
    { objective: "ship it", status: "active" as const, continuing: false },
    { objective: "ship it", status: "paused" as const, continuing: false }
  ]) {
    const resolved = resolveChatActivity({ chatSessionStatus: "ready", latestTurn: settled, goal });
    assert.equal(resolved.rung, "completed", JSON.stringify(goal));
    assert.equal(resolved.attention, "finished");
  }
  assert.equal(pushTypeForRung("goal-continuing"), null);
});

test("never a `finished` push while background liveness is non-null", () => {
  // The working/monitoring rungs already answer null, so the only way to reach
  // "finished" with live work is the error rung, which outranks liveness.
  assert.equal(
    pushTypeForFields({ chatSessionStatus: "error", backgroundLiveness: "monitoring" }),
    null
  );
  assert.equal(
    pushTypeForFields({ chatSessionStatus: "error", backgroundLiveness: "working" }),
    null
  );
  assert.equal(pushTypeForFields({ chatSessionStatus: "error" }), "finished");
  // A question still pushes: the user is being asked something right now.
  assert.equal(
    pushTypeForFields({ hasPendingUserInput: true, backgroundLiveness: "working" }),
    "needs-input"
  );
});
