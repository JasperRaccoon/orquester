import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { AgentChatSessionSummaryFields } from "@orquester/api";
import { pushTypeForFields, pushTypeForRung, resolveChatActivity } from "./activity-ladder.ts";

// The ONE ladder of §6.4. Every rung, in priority order, plus the two race
// fallbacks the spec calls non-optional — each of these encodes a bug T3 hit.

const turn = (
  state: AgentChatSessionSummaryFields["latestTurn"] extends infer T
    ? NonNullable<T>["state"]
    : never,
  completedAt: string | null = null
): NonNullable<AgentChatSessionSummaryFields["latestTurn"]> => ({
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

test("rung 6: background liveness `working` keeps the thread working after the turn", () => {
  const resolved = resolveChatActivity({
    chatSessionStatus: "ready",
    backgroundLiveness: "working",
    latestTurn: turn("completed", "2026-09-21T00:01:00.000Z")
  });
  assert.equal(resolved.rung, "background-working");
  assert.equal(resolved.state, "working");
  assert.equal(resolved.attention, null);
});

test("rung 7: monitoring is idle WITHOUT a finished stamp", () => {
  const resolved = resolveChatActivity({
    chatSessionStatus: "ready",
    backgroundLiveness: "monitoring",
    latestTurn: turn("completed", "2026-09-21T00:01:00.000Z")
  });
  assert.equal(resolved.rung, "monitoring");
  assert.equal(resolved.state, "idle");
  assert.equal(resolved.attention, null, "a settled turn whose watch loops run is not finished");
});

test("rung 8: a completed turn is idle + finished", () => {
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
  for (const rung of ["starting", "running", "background-working", "monitoring", "unknown"] as const) {
    assert.equal(pushTypeForRung(rung), null, rung);
  }
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
