import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  autoCompactionSentence,
  contextWindowSnapshot,
  formatContextWindowTokens,
  hasUnseenCompletion,
  latestContextWindowActivity,
  markUnreadVisitStamp,
  nextVisitStamp,
  isCompactingThread,
  resolveActivityLabel,
  resolveSidebarThreadStatus,
  shouldRecedeSidebarThread
} from "./status.logic";
import { activity, resetBuilders, stamp } from "./test-helpers";

beforeEach(() => {
  resetBuilders();
});

describe("recede (T3 `Sidebar.logic.ts:820-833`)", () => {
  const recede = (
    status: Parameters<typeof shouldRecedeSidebarThread>[0]["status"],
    extra: { isUnread?: boolean; isSelected?: boolean } = {}
  ): boolean =>
    shouldRecedeSidebarThread({
      status,
      isUnread: extra.isUnread ?? false,
      isSelected: extra.isSelected ?? false
    });

  it("never recedes a row something is blocked on", () => {
    assert.equal(recede("input"), false);
    assert.equal(recede("input", { isUnread: false, isSelected: false }), false);
  });

  it("never recedes the selected row, whatever it is doing", () => {
    for (const status of ["approval", "input", "working", "monitoring", "ready"] as const) {
      assert.equal(recede(status, { isSelected: true }), false, status);
    }
  });

  it("always recedes a busy row — a working agent wants nothing from you", () => {
    assert.equal(recede("working", { isUnread: true }), true);
    assert.equal(recede("monitoring", { isUnread: true }), true);
  });

  it("recedes ready and approval only once there is nothing unseen about them", () => {
    assert.equal(recede("ready"), true);
    assert.equal(recede("approval"), true);
    assert.equal(recede("ready", { isUnread: true }), false);
    assert.equal(recede("approval", { isUnread: true }), false);
  });

  it("buckets a row from its summary fields, approvals first", () => {
    assert.equal(
      resolveSidebarThreadStatus({ hasPendingApprovals: true, hasPendingUserInput: true }),
      "approval"
    );
    assert.equal(resolveSidebarThreadStatus({ hasPendingUserInput: true }), "input");
    assert.equal(resolveSidebarThreadStatus({ chatSessionStatus: "running" }), "working");
    assert.equal(resolveSidebarThreadStatus({ chatSessionStatus: "starting" }), "working");
    assert.equal(resolveSidebarThreadStatus({ backgroundLiveness: "working" }), "working");
    assert.equal(resolveSidebarThreadStatus({ backgroundLiveness: "monitoring" }), "monitoring");
    assert.equal(resolveSidebarThreadStatus({ chatSessionStatus: "ready" }), "ready");
    assert.equal(resolveSidebarThreadStatus({}), "ready");
  });

  it("a question outranks lingering background work, so the row stays loud", () => {
    assert.equal(
      recede(
        resolveSidebarThreadStatus({
          hasPendingUserInput: true,
          backgroundLiveness: "working"
        })
      ),
      false
    );
  });
});

describe("unread", () => {
  it("is a completion newer than this client's last visit", () => {
    const latestTurn = { turnId: "t", state: "completed" as const, startedAt: stamp(1), completedAt: stamp(5) };
    assert.equal(hasUnseenCompletion({ latestTurn, lastVisitedAt: stamp(4) }), true);
    assert.equal(hasUnseenCompletion({ latestTurn, lastVisitedAt: stamp(6) }), false);
    assert.equal(hasUnseenCompletion({ latestTurn, lastVisitedAt: null }), false);
    assert.equal(hasUnseenCompletion({ latestTurn: null, lastVisitedAt: stamp(1) }), false);
  });

  it("treats a malformed last-visit stamp as unread", () => {
    assert.equal(
      hasUnseenCompletion({
        latestTurn: { turnId: "t", state: "completed", startedAt: null, completedAt: stamp(5) },
        lastVisitedAt: "not a date"
      }),
      true
    );
  });

  it("marks unread by stamping one millisecond before the completion", () => {
    const stampBefore = markUnreadVisitStamp("2026-01-01T00:00:05.000Z");
    assert.equal(stampBefore, "2026-01-01T00:00:04.999Z");
    assert.equal(markUnreadVisitStamp(null), null);
    assert.equal(markUnreadVisitStamp("garbage"), null);
  });

  it("only ever moves a visit stamp forward", () => {
    assert.equal(nextVisitStamp(stamp(5), stamp(3)), stamp(5));
    assert.equal(nextVisitStamp(stamp(3), stamp(5)), stamp(5));
    assert.equal(nextVisitStamp(null, stamp(1)), stamp(1));
    assert.equal(nextVisitStamp(stamp(3), "garbage"), stamp(3));
  });
});

describe("context window", () => {
  it("degrades to a bare total without maxTokens — never zeros", () => {
    const snapshot = contextWindowSnapshot({ usedTokens: 1_234 });
    assert.equal(snapshot?.usedTokens, 1_234);
    assert.equal(snapshot?.maxTokens, null);
    assert.equal(snapshot?.usedPercentage, null);
    assert.equal(snapshot?.remainingTokens, null);
  });

  it("computes the ring when maxTokens is present", () => {
    const snapshot = contextWindowSnapshot({ usedTokens: 50, maxTokens: 200 });
    assert.equal(snapshot?.usedPercentage, 25);
    assert.equal(snapshot?.remainingTokens, 150);
    assert.equal(snapshot?.remainingPercentage, 75);
  });

  it("clamps an over-full window at 100 %", () => {
    assert.equal(contextWindowSnapshot({ usedTokens: 300, maxTokens: 200 })?.usedPercentage, 100);
  });

  it("is null for a missing or negative reading", () => {
    assert.equal(contextWindowSnapshot(null), null);
    assert.equal(contextWindowSnapshot({ usedTokens: -1 }), null);
  });

  it("reads the newest context-window activity and skips malformed ones", () => {
    const found = latestContextWindowActivity([
      activity("context-window.updated", { usedTokens: 10, maxTokens: 100 }, { createdAt: stamp(1) }),
      activity("context-window.updated", { usedTokens: "nope" }, { createdAt: stamp(2) })
    ]);
    assert.equal(found?.usage.usedTokens, 10);
    assert.equal(latestContextWindowActivity([]), null);
  });

  it("formats tokens the way the meter reads them", () => {
    assert.equal(formatContextWindowTokens(999), "999");
    assert.equal(formatContextWindowTokens(1_500), "1.5k");
    assert.equal(formatContextWindowTokens(120_000), "120k");
    assert.equal(formatContextWindowTokens(1_500_000), "1.5m");
    assert.equal(formatContextWindowTokens(null), "0");
  });

  it("writes the auto-compaction sentence only when the provider reports one", () => {
    assert.equal(autoCompactionSentence(contextWindowSnapshot({ usedTokens: 10, maxTokens: 100 })), null);
    assert.match(
      autoCompactionSentence(
        contextWindowSnapshot({ usedTokens: 10, maxTokens: 100, autoCompactAtTokens: 80 })
      ) ?? "",
      /Compacts automatically at 80 tokens/
    );
    assert.match(
      autoCompactionSentence(
        contextWindowSnapshot({ usedTokens: 90, maxTokens: 100, autoCompactAtTokens: 80 })
      ) ?? "",
      /past 80 tokens/
    );
  });
});

describe("the activity label", () => {
  const base = {
    connection: "synchronized" as const,
    sessionStatus: null,
    turnStatus: null,
    backgroundLiveness: null,
    pendingApprovals: 0,
    pendingQuestions: 0
  };

  it("names the connection problem first", () => {
    assert.equal(resolveActivityLabel({ ...base, connection: "reconnecting" }), "Reconnecting…");
    assert.equal(resolveActivityLabel({ ...base, connection: "error" }), "Disconnected");
  });

  it("names what the user is waiting on", () => {
    assert.equal(resolveActivityLabel({ ...base, pendingApprovals: 1 }), "Waiting for approval");
    assert.equal(resolveActivityLabel({ ...base, pendingApprovals: 3 }), "3 approvals");
    assert.equal(resolveActivityLabel({ ...base, pendingQuestions: 1 }), "Waiting for your answer");
  });

  it("prefers the live tool label while a turn runs", () => {
    assert.equal(
      resolveActivityLabel({ ...base, turnStatus: "running", liveToolLabel: "Running pnpm" }),
      "Running pnpm"
    );
    assert.equal(resolveActivityLabel({ ...base, turnStatus: "running" }), "Working");
  });

  it("says what the compaction is doing rather than a generic Working", () => {
    assert.equal(
      resolveActivityLabel({ ...base, turnStatus: "running", isCompacting: true }),
      "Compacting\u2026"
    );
    assert.equal(
      resolveActivityLabel({
        ...base,
        turnStatus: "running",
        liveToolLabel: "Running pnpm",
        isCompacting: true
      }),
      "Compacting\u2026",
      "it outranks the live tool label"
    );
    assert.equal(
      resolveActivityLabel({ ...base, sessionStatus: "running", isCompacting: true }),
      "Compacting\u2026"
    );
  });

  it("keeps the connection, approval, question and error checks above it", () => {
    assert.equal(
      resolveActivityLabel({ ...base, connection: "reconnecting", turnStatus: "running", isCompacting: true }),
      "Reconnecting\u2026"
    );
    assert.equal(
      resolveActivityLabel({ ...base, pendingApprovals: 1, turnStatus: "running", isCompacting: true }),
      "Waiting for approval"
    );
    assert.equal(
      resolveActivityLabel({ ...base, pendingQuestions: 1, turnStatus: "running", isCompacting: true }),
      "Waiting for your answer"
    );
    assert.equal(
      resolveActivityLabel({ ...base, sessionStatus: "error", isCompacting: true }),
      "Session error"
    );
  });

  it("says nothing about compaction once the turn is not running", () => {
    assert.equal(resolveActivityLabel({ ...base, isCompacting: true }), null);
  });

  it("falls back to the liveness words, then to nothing", () => {
    assert.equal(resolveActivityLabel({ ...base, backgroundLiveness: "working" }), "Background work");
    assert.equal(resolveActivityLabel({ ...base, backgroundLiveness: "monitoring" }), "Monitoring");
    assert.equal(resolveActivityLabel(base), null);
  });
});

// ---------------------------------------------------------------------------
// The compaction phase
// ---------------------------------------------------------------------------

describe("the compaction phase", () => {
  const compacting = () =>
    activity("context-compaction", { state: "compacting" }, {
      tone: "info",
      summary: "Compacting context",
      createdAt: stamp(1)
    });

  const live = { sessionStatus: "running" as const, turnStatus: "running" as const };

  it("is on from the `compacting` marker until a terminal one lands", () => {
    assert.equal(isCompactingThread({ activities: [compacting()], ...live }), true);
  });

  it("ends on `compacted`", () => {
    assert.equal(
      isCompactingThread({
        activities: [
          compacting(),
          activity("context-compaction", { state: "compacted", beforeTokens: 800, afterTokens: 11 }, {
            summary: "Context compacted",
            createdAt: stamp(2)
          })
        ],
        ...live
      }),
      false
    );
  });

  it("ends on `compaction-failed`", () => {
    assert.equal(
      isCompactingThread({
        activities: [
          compacting(),
          activity("context-compaction", { state: "compaction-failed", error: "quota" }, {
            tone: "error",
            summary: "Context compaction failed",
            createdAt: stamp(2)
          })
        ],
        ...live
      }),
      false
    );
  });

  it("ends when the turn settles even though no terminal marker ever arrived", () => {
    // The host may abandon a compaction after a deadline; a phase that only a
    // marker could end would then shimmer forever.
    assert.equal(
      isCompactingThread({ activities: [compacting()], sessionStatus: "running", turnStatus: "completed" }),
      false
    );
  });

  it("ends when the session is no longer live", () => {
    for (const sessionStatus of ["ready", "stopped", "error"] as const) {
      assert.equal(
        isCompactingThread({ activities: [compacting()], sessionStatus, turnStatus: "running" }),
        false,
        sessionStatus
      );
    }
    assert.equal(
      isCompactingThread({ activities: [compacting()], sessionStatus: "starting", turnStatus: null }),
      true,
      "a starting session is still live"
    );
  });

  it("is off for an old log, which only ever recorded the settled marker", () => {
    assert.equal(
      isCompactingThread({
        activities: [
          activity("thread.state.changed", { state: "compacted", beforeTokens: 800, afterTokens: 11 }, {
            summary: "Compacted",
            createdAt: stamp(1)
          })
        ],
        ...live
      }),
      false
    );
    assert.equal(isCompactingThread({ activities: [], ...live }), false);
  });

  it("reads the LATEST marker, so a second compaction re-enters the phase", () => {
    assert.equal(
      isCompactingThread({
        activities: [
          compacting(),
          activity("context-compaction", { state: "compacted" }, { createdAt: stamp(2) }),
          activity("context-compaction", { state: "compacting" }, { createdAt: stamp(3) })
        ],
        ...live
      }),
      true
    );
  });

  it("ignores everything that is not a compaction marker", () => {
    assert.equal(
      isCompactingThread({
        activities: [
          compacting(),
          activity("tool.completed", { itemType: "command_execution", command: "ls" }, {
            createdAt: stamp(2)
          })
        ],
        ...live
      }),
      true
    );
  });
});
