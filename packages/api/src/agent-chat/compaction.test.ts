import assert from "node:assert/strict";
import test from "node:test";

import {
  compactionMarkerState,
  isAgentOwnedActivity,
  isCompactionActivity,
  isConversationCompactionActivity,
  isSettledConversationCompaction
} from "./compaction.ts";
import type { ThreadActivityItem, ThreadMessageItem } from "./thread.ts";

function activity(
  activityKind: string,
  payload: unknown,
  extra: Partial<ThreadActivityItem> = {}
): ThreadActivityItem {
  return {
    kind: "activity",
    id: `${activityKind}:1`,
    tone: "info",
    activityKind,
    summary: activityKind,
    payload,
    turnId: "t1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra
  };
}

function message(extra: Partial<ThreadMessageItem> = {}): ThreadMessageItem {
  return {
    kind: "message",
    id: "m1",
    role: "user",
    text: "/compact",
    turnId: "t1",
    streaming: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra
  };
}

test("a context-compaction row is settled unless it says it is running or failed", () => {
  const settled = (payload: unknown) =>
    isSettledConversationCompaction(activity("context-compaction", payload));
  // An old log recorded only the settled marker, with no state at all.
  assert.equal(settled({}), true);
  assert.equal(settled(null), true);
  assert.equal(settled({ state: "compacted", beforeTokens: 9_000, afterTokens: 900 }), true);
  assert.equal(settled({ state: "compacting" }), false);
  assert.equal(settled({ state: "compaction-failed", error: "x" }), false);
  // An unreadable state is settled, never an in-flight phase.
  assert.equal(settled({ state: "wat" }), true);
});

test("the legacy thread.state.changed marker counts only when it says compacted", () => {
  assert.equal(
    isSettledConversationCompaction(activity("thread.state.changed", { state: "compacted" })),
    true
  );
  assert.equal(
    isSettledConversationCompaction(activity("thread.state.changed", { state: "running" })),
    false
  );
  assert.equal(isSettledConversationCompaction(activity("thread.state.changed", {})), false);
  assert.equal(isCompactionActivity(activity("thread.state.changed", { state: "compacted" })), true);
  assert.equal(isCompactionActivity(activity("thread.state.changed", { state: "idle" })), false);
});

test("a subagent's own compaction is not the conversation's: agentId on the row or on its payload", () => {
  const onRow = activity("context-compaction", { state: "compacted" }, { agentId: "sub-1" });
  const onPayload = activity("context-compaction", { state: "compacted", agentId: "sub-1" });
  const legacy = activity("thread.state.changed", { state: "compacted", agentId: "sub-1" });
  for (const row of [onRow, onPayload, legacy]) {
    assert.equal(isCompactionActivity(row), true, "still a compaction marker");
    assert.equal(isAgentOwnedActivity(row), true);
    assert.equal(isConversationCompactionActivity(row), false);
    assert.equal(isSettledConversationCompaction(row), false);
  }
});

test("a blank or non-string agentId owns nothing — the UI's quiet-timeline rule", () => {
  for (const row of [
    activity("context-compaction", { state: "compacted" }, { agentId: "" }),
    activity("context-compaction", { state: "compacted" }, { agentId: "   " }),
    activity("context-compaction", { state: "compacted", agentId: "  " }),
    activity("context-compaction", { state: "compacted", agentId: 7 })
  ]) {
    assert.equal(isAgentOwnedActivity(row), false);
    assert.equal(isSettledConversationCompaction(row), true);
  }
});

test("every phase of the conversation's own marker is a conversation compaction; only compacted is settled", () => {
  for (const state of ["compacting", "compacted", "compaction-failed"] as const) {
    const row = activity("context-compaction", { state });
    assert.equal(isConversationCompactionActivity(row), true);
    assert.equal(compactionMarkerState(row), state);
    assert.equal(isSettledConversationCompaction(row), state === "compacted");
  }
});

test("a message is never a compaction marker, whatever it says or whoever owns it", () => {
  assert.equal(isSettledConversationCompaction(message()), false);
  assert.equal(isSettledConversationCompaction(message({ role: "assistant", text: "Context compacted" })), false);
});

test("an activity of any other kind is not one, even with a compacted state", () => {
  assert.equal(isSettledConversationCompaction(activity("tool.completed", { state: "compacted" })), false);
  assert.equal(isCompactionActivity(activity("runtime.warning", { state: "compacted" })), false);
});
