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
  resolveActivityLabel
} from "./status.logic";
import { activity, resetBuilders, stamp } from "./test-helpers";

beforeEach(() => {
  resetBuilders();
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

  it("falls back to the liveness words, then to nothing", () => {
    assert.equal(resolveActivityLabel({ ...base, backgroundLiveness: "working" }), "Background work");
    assert.equal(resolveActivityLabel({ ...base, backgroundLiveness: "monitoring" }), "Monitoring");
    assert.equal(resolveActivityLabel(base), null);
  });
});
