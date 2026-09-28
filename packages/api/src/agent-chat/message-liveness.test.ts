import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { foldThread, type ThreadFoldState } from "./fold.ts";
import {
  isMessageStreaming,
  messageStreamingContext,
  NOTHING_STREAMS,
  type MessageStreamingContext
} from "./message-liveness.ts";
import { activity, agentTask, created, ev, resetActivityIds, resetSeq, session } from "./test-helpers.ts";
import type { DomainEvent } from "./domain-events.ts";
import type { ThreadMessageItem } from "./thread.ts";

beforeEach(() => {
  resetSeq();
  resetActivityIds();
});

function chunk(
  messageId: string,
  role: ThreadMessageItem["role"],
  turnId: string | null,
  agentId?: string
): DomainEvent {
  return ev("thread.message-sent", {
    messageId,
    role,
    text: `${messageId} so far`,
    streaming: true,
    turnId,
    ...(agentId !== undefined ? { agentId } : {})
  });
}

function taskRow(
  activityKind: "task.started" | "task.completed" | "task.updated",
  taskId: string,
  extra: Record<string, unknown> = {},
  turnId: string | null = null
): DomainEvent {
  return ev("thread.activity-appended", {
    activity: activity(activityKind, agentTask(taskId, extra), { turnId })
  });
}

function message(state: ThreadFoldState, id: string): ThreadMessageItem {
  const item = state.items.find((candidate) => candidate.id === id);
  assert.ok(item?.kind === "message", `message ${id}`);
  return item;
}

/**
 * An old log: a turn a dead host left mid-answer, a subagent fleet whose words
 * were never closed (turnless, before ingestion settled them), and the turn
 * running now. Every message still says `streaming: true` but the last one.
 */
function oldLog(): DomainEvent[] {
  return [
    created(),
    ev("thread.session-set", { session: session("running", "t1") }),
    chunk("p1", "assistant", "t1"),
    taskRow("task.started", "done", {}, "t1"),
    taskRow("task.started", "live", {}, "t1"),
    ev("thread.session-set", { session: session("ready") }),
    taskRow("task.completed", "done", { status: "completed" }),
    chunk("done-words", "reasoning", null, "done"),
    chunk("live-words", "reasoning", null, "live"),
    ev("thread.session-set", { session: session("running", "t2") }),
    chunk("p2", "assistant", "t2"),
    ev("thread.message-sent", {
      messageId: "p3",
      role: "assistant",
      text: "A settled one",
      streaming: false,
      turnId: "t2"
    })
  ];
}

test("a turnless agent message reads settled once its agent completed, streaming while it runs", () => {
  const state = foldThread(oldLog());
  const context = messageStreamingContext(state);
  assert.equal(isMessageStreaming(message(state, "done-words"), context), false);
  assert.equal(isMessageStreaming(message(state, "live-words"), context), true);
});

test("a parent message of a completed turn reads settled, of the running turn streaming", () => {
  const state = foldThread(oldLog());
  const context = messageStreamingContext(state);
  assert.equal(isMessageStreaming(message(state, "p1"), context), false, "its turn settled long ago");
  assert.equal(isMessageStreaming(message(state, "p2"), context), true);
  assert.equal(isMessageStreaming(message(state, "p3"), context), false, "a settled flag is never streaming");
});

test("nothing reads streaming while the session is not live", () => {
  const stopped = foldThread([...oldLog(), ev("thread.session-set", { session: session("stopped") })]);
  const context = messageStreamingContext(stopped);
  assert.equal(context.sessionLive, false);
  for (const id of ["p1", "p2", "p3", "done-words", "live-words"]) {
    assert.equal(isMessageStreaming(message(stopped, id), context), false, id);
  }

  // The conjunct on its own: whatever the turn and the roster say, no process
  // is left to finish a stream.
  const dead: MessageStreamingContext = {
    sessionLive: false,
    activeTurnId: "t2",
    activeAgentIds: new Set(["live"])
  };
  const running = foldThread(oldLog());
  assert.equal(isMessageStreaming(message(running, "p2"), dead), false);
  assert.equal(isMessageStreaming(message(running, "live-words"), dead), false);
  assert.equal(messageStreamingContext({ head: null, roster: [] }).sessionLive, false, "no head, no session");
  // The fallback of a reader handed no thread to ask.
  assert.equal(isMessageStreaming(message(running, "p2"), NOTHING_STREAMS), false);
  assert.equal(isMessageStreaming(message(running, "live-words"), NOTHING_STREAMS), false);
});

test("an agent is active while pending, running or waiting — never idle or settled", () => {
  const words = (agentId: string): Pick<ThreadMessageItem, "streaming" | "turnId" | "agentId"> => ({
    streaming: true,
    turnId: null,
    agentId
  });
  const context = messageStreamingContext({
    head: { session: { status: "ready", activeTurnId: null } },
    roster: [
      { id: "pending", status: "pending" },
      { id: "running", status: "running" },
      { id: "waiting", status: "waiting" },
      { id: "idle", status: "idle" },
      { id: "completed", status: "completed" },
      { id: "failed", status: "failed" },
      { id: "cancelled", status: "cancelled" },
      { id: "interrupted", status: "interrupted" }
    ]
  });
  for (const id of ["pending", "running", "waiting"]) {
    assert.equal(isMessageStreaming(words(id), context), true, id);
  }
  for (const id of ["idle", "completed", "failed", "cancelled", "interrupted", "unknown"]) {
    assert.equal(isMessageStreaming(words(id), context), false, id);
  }
  assert.equal(
    isMessageStreaming({ streaming: true, turnId: null }, context),
    false,
    "a turnless message nobody owns: no turn and no agent can still be writing it"
  );
});
