import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { QueuedComposerMessage } from "./contracts";
import {
  drainQueue,
  EMPTY_QUEUE,
  enqueue,
  holdAtFront,
  isQueuedMessageDue,
  latestCompletedToolActivityId,
  nextDueQueuedMessage,
  removeQueued,
  shouldQueueSubmission,
  takeQueued,
  type QueueState
} from "./queue.logic";

let counter = 0;
const newId = (): string => `q${++counter}`;
const now = (): string => new Date(Date.UTC(2026, 0, 1, 0, 0, counter)).toISOString();

const draft = (text: string, anchor: string | null = null): Omit<QueuedComposerMessage, "id" | "queuedAt"> => ({
  text,
  attachments: [],
  context: [],
  interactionMode: "default",
  queuedAfterToolActivityId: anchor,
  holdUntilUserAction: false
});

function queueOf(...texts: string[]): { state: QueueState; ids: string[] } {
  let state = EMPTY_QUEUE;
  const ids: string[] = [];
  for (const text of texts) {
    const result = enqueue(state, draft(text, "boundary-0"), now, newId);
    state = result.state;
    ids.push(result.message.id);
  }
  return { state, ids };
}

describe("enqueue / take / re-anchor", () => {
  it("takes one message and re-anchors the rest to the new boundary", () => {
    const { state, ids } = queueOf("one", "two", "three");
    const result = takeQueued(state, ids[0]!, "boundary-1");
    assert.equal(result.message?.text, "one");
    assert.equal(result.state.messages.length, 2);
    for (const message of result.state.messages) {
      assert.equal(
        message.queuedAfterToolActivityId,
        "boundary-1",
        "exactly one message leaves per boundary"
      );
    }
  });

  it("answers null when another caller already took it", () => {
    const { state, ids } = queueOf("one");
    const first = takeQueued(state, ids[0]!, null);
    const second = takeQueued(first.state, ids[0]!, null);
    assert.equal(second.message, null);
    assert.equal(second.state, first.state);
  });

  it("removes one message without touching the others' anchors", () => {
    const { state, ids } = queueOf("one", "two");
    const result = removeQueued(state, ids[0]!);
    assert.equal(result.message?.text, "one");
    assert.equal(result.state.messages[0]?.queuedAfterToolActivityId, "boundary-0");
  });
});

describe("the three guards", () => {
  it("guard 1: draining bumps the generation so a late send can detect it", () => {
    const { state } = queueOf("one", "two");
    const before = state.drainGeneration;
    const drained = drainQueue(state);
    assert.equal(drained.messages.length, 2, "Stop returns EVERY queued message");
    assert.equal(drained.state.messages.length, 0);
    assert.equal(drained.state.drainGeneration, before + 1);
  });

  it("guard 1: draining an empty queue does not bump the generation", () => {
    const drained = drainQueue(EMPTY_QUEUE);
    assert.equal(drained.state, EMPTY_QUEUE);
  });

  it("guard 2: a failed send goes back to the FRONT, held for user action", () => {
    const { state, ids } = queueOf("one", "two");
    const taken = takeQueued(state, ids[0]!, "boundary-1");
    const held = holdAtFront(taken.state, taken.message!);
    assert.equal(held.messages[0]?.id, ids[0]);
    assert.equal(held.messages[0]?.holdUntilUserAction, true, "nothing overtakes it");
    assert.equal(held.messages.length, 2);
  });

  it("guard 3: nothing flushes while a request is pending", () => {
    assert.equal(
      isQueuedMessageDue({
        message: { queuedAfterToolActivityId: null, holdUntilUserAction: false },
        phase: "ready",
        latestToolActivityId: null,
        hasPendingRequests: true
      }),
      false
    );
  });
});

describe("isQueuedMessageDue", () => {
  const message = { queuedAfterToolActivityId: "a1", holdUntilUserAction: false };

  it("never sends a held message", () => {
    assert.equal(
      isQueuedMessageDue({
        message: { ...message, holdUntilUserAction: true },
        phase: "ready",
        latestToolActivityId: "a2"
      }),
      false
    );
  });

  it("never sends while connecting — the gap between a send and pick-up", () => {
    assert.equal(
      isQueuedMessageDue({ message, phase: "connecting", latestToolActivityId: "a2" }),
      false
    );
  });

  it("sends at turn end", () => {
    assert.equal(isQueuedMessageDue({ message, phase: "ready", latestToolActivityId: "a1" }), true);
  });

  it("sends mid-turn only once a LATER tool call finished", () => {
    assert.equal(
      isQueuedMessageDue({ message, phase: "running", latestToolActivityId: "a1" }),
      false
    );
    assert.equal(
      isQueuedMessageDue({ message, phase: "running", latestToolActivityId: "a2" }),
      true
    );
  });

  it("only the head is offered to the next boundary", () => {
    const { state } = queueOf("one", "two");
    const due = nextDueQueuedMessage(state, { phase: "ready", latestToolActivityId: null });
    assert.equal(due?.text, "one");
  });
});

describe("latestCompletedToolActivityId", () => {
  it("picks the newest completed tool call, ignoring position", () => {
    const id = latestCompletedToolActivityId([
      { id: "a3", activityKind: "tool.completed", createdAt: "2026-01-01T00:00:03.000Z" },
      { id: "a1", activityKind: "tool.completed", createdAt: "2026-01-01T00:00:01.000Z" },
      { id: "a2", activityKind: "tool.updated", createdAt: "2026-01-01T00:00:09.000Z" }
    ]);
    assert.equal(id, "a3");
  });

  it("is null when nothing has completed", () => {
    assert.equal(latestCompletedToolActivityId([]), null);
  });
});

describe("steer versus queue", () => {
  it("is one setting with a per-message inversion", () => {
    const run = (followUpBehavior: "steer" | "queue", intent: "foreground" | "alternate") =>
      shouldQueueSubmission({ followUpBehavior, submissionIntent: intent, isRunning: true });
    assert.equal(run("queue", "foreground"), true);
    assert.equal(run("queue", "alternate"), false);
    assert.equal(run("steer", "foreground"), false);
    assert.equal(run("steer", "alternate"), true);
  });

  it("never queues when no turn is running", () => {
    assert.equal(
      shouldQueueSubmission({
        followUpBehavior: "queue",
        submissionIntent: "foreground",
        isRunning: false
      }),
      false
    );
  });
});
