import assert from "node:assert/strict";
import test from "node:test";

import { anchorsCall, CALL_ROW_KINDS } from "./call-anchor.ts";
import type { ThreadActivityItem } from "./thread.ts";

function row(
  activityKind: string,
  extra: Partial<ThreadActivityItem> = {},
  payload: Record<string, unknown> = {}
): ThreadActivityItem {
  return {
    kind: "activity",
    id: `${activityKind}:1`,
    tone: "tool",
    activityKind,
    summary: activityKind,
    payload: { toolUseId: "toolu_1", ...payload },
    turnId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra
  };
}

test("a call's rows are its lifecycle rows and its streamed output, nothing else", () => {
  assert.deepEqual(
    [...CALL_ROW_KINDS].sort(),
    ["tool.completed", "tool.denied", "tool.output", "tool.started", "tool.updated"]
  );
});

test("a row anchors its call by its turn, by an owner on the row or on its payload, or as the call's close", () => {
  assert.equal(anchorsCall(row("tool.started", { turnId: "t1" })), true);
  assert.equal(anchorsCall(row("tool.output", { turnId: "t1" })), true);
  assert.equal(anchorsCall(row("tool.updated", { agentId: "agent-1" })), true);
  assert.equal(anchorsCall(row("tool.started", {}, { agentId: "agent-1" })), true);
  assert.equal(anchorsCall(row("tool.completed")), true);
  assert.equal(anchorsCall(row("tool.denied")), true);
});

test("a turnless, ownerless opening row or chunk anchors nothing — a blank owner is no owner", () => {
  // What a Claude parent call wrote before the next turn adopted it, in a log written before 2026-09-28: an
  // interrupted message's tail, or, before a woken parent's first message was held for its turn, any woken call.
  assert.equal(anchorsCall(row("tool.started")), false);
  assert.equal(anchorsCall(row("tool.updated")), false);
  assert.equal(anchorsCall(row("tool.output")), false);
  assert.equal(anchorsCall(row("tool.started", { agentId: " " })), false);
  assert.equal(anchorsCall(row("tool.started", { turnId: "" })), false);
});
