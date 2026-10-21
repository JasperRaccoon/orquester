import assert from "node:assert/strict";
import test from "node:test";

import type { ThreadActivityItem, ThreadItem, ThreadMessageItem, Turn } from "./thread.ts";
import { usageLimitNoticeOf } from "./usage-limit.ts";

let clock = 0;
function at(): string {
  clock += 1;
  return new Date(Date.UTC(2026, 9, 20, 10, 0, clock)).toISOString();
}

function activity(activityKind: string, payload: unknown, extra: Partial<ThreadActivityItem> = {}): ThreadActivityItem {
  const stamp = at();
  return {
    kind: "activity",
    id: `a${clock}`,
    tone: activityKind === "runtime.error" ? "error" : "info",
    activityKind,
    summary: "row",
    payload,
    turnId: "t1",
    createdAt: stamp,
    updatedAt: stamp,
    ...extra
  };
}

function message(role: ThreadMessageItem["role"], extra: Partial<ThreadMessageItem> = {}): ThreadMessageItem {
  return { kind: "message", id: `m${++clock}`, role, text: "hi", turnId: "t1", ...extra } as ThreadMessageItem;
}

function turn(turnId: string | null, state: Turn["state"], requestedAt: string): Turn {
  return {
    turnId,
    state,
    turnCount: null,
    requestedAt,
    startedAt: requestedAt,
    completedAt: state === "running" ? null : requestedAt,
    assistantMessageId: null
  };
}

const limitRow = (extra: Partial<ThreadActivityItem> = {}) =>
  activity("runtime.error", { message: "Usage limit reached", reason: "usage_limit", resetsAt: "2026-10-20T15:40:00Z" }, extra);

test("a failed turn's usage-limit row is the notice, with its reset", () => {
  clock = 0;
  const start = at();
  const items: ThreadItem[] = [message("user"), message("assistant"), limitRow()];
  const notice = usageLimitNoticeOf(items, [turn("t1", "failed", start)]);
  assert.deepEqual(notice, {
    activityId: items[2]!.id,
    turnId: "t1",
    resetsAt: "2026-10-20T15:40:00.000Z",
    message: "Usage limit reached",
    at: items[2]!.createdAt,
    parked: false
  });
});

test("a parked (still running) turn is reported as parked", () => {
  clock = 0;
  const start = at();
  const items: ThreadItem[] = [message("user"), activity("runtime.warning", { message: "Claude usage limit reached.", reason: "usage_limit" })];
  const notice = usageLimitNoticeOf(items, [turn("t1", "running", start)]);
  assert.equal(notice?.parked, true);
  assert.equal(notice?.resetsAt, undefined);
});

test("the user speaking after the limit clears it", () => {
  clock = 0;
  const start = at();
  const items: ThreadItem[] = [limitRow(), message("user", { turnId: "t2" })];
  assert.equal(usageLimitNoticeOf(items, [turn("t1", "failed", start)]), null);
});

test("progress after a parked limit (the turn went on by itself) clears it", () => {
  clock = 0;
  const start = at();
  const withAssistant: ThreadItem[] = [message("user"), limitRow(), message("assistant")];
  assert.equal(usageLimitNoticeOf(withAssistant, [turn("t1", "running", start)]), null);
  const withTool: ThreadItem[] = [message("user"), limitRow(), activity("tool.started", { title: "Bash" })];
  assert.equal(usageLimitNoticeOf(withTool, [turn("t1", "running", start)]), null);
});

test("a newer turn that started after the limit (no user message) clears it", () => {
  clock = 0;
  const first = at();
  const row = limitRow();
  const later = at();
  assert.equal(usageLimitNoticeOf([row], [turn("t1", "failed", first), turn("t2", "running", later)]), null);
});

test("an auth failure, an unrelated warning and a subagent's user message are not limits nor stops", () => {
  clock = 0;
  const start = at();
  assert.equal(usageLimitNoticeOf([activity("runtime.error", { message: "x", reason: "auth" })], [turn("t1", "failed", start)]), null);
  const items: ThreadItem[] = [limitRow(), message("user", { agentId: "sub-1" }), activity("runtime.warning", { message: "stderr" })];
  assert.equal(usageLimitNoticeOf(items, [turn("t1", "failed", start)])?.activityId, items[0]!.id);
});

test("a legacy row without a reason is read by its documented prefix", () => {
  clock = 0;
  const start = at();
  const row = activity("runtime.warning", { message: "Grok usage limit reached. Try again later." });
  assert.equal(usageLimitNoticeOf([row], [turn("t1", "completed", start)])?.activityId, row.id);
});

test("no rows, no notice", () => {
  assert.equal(usageLimitNoticeOf([], []), null);
});
