import assert from "node:assert/strict";
import { describe,it } from "node:test";

import type { QueuedComposerMessage } from "./contracts";
import {
EMPTY_QUEUE,
enqueue,
holdAtFront,
isQueuedMessageDue,
latestCompletedToolActivityId,
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

  it("answers null when another caller already took it", () => {
    const { state, ids } = queueOf("one");
    const first = takeQueued(state, ids[0]!, null);
    const second = takeQueued(first.state, ids[0]!, null);
    assert.equal(second.message, null);
  });
});

describe("the three guards", () => {

  it("guard 2, in order: a later failure is held behind the ones held before it, still ahead of the rest", () => {
    const { state, ids } = queueOf("one", "two", "three");
    const first = takeQueued(state, ids[0]!, "boundary-1");
    const second = takeQueued(first.state, ids[1]!, "boundary-1");
    const heldFirst = holdAtFront(second.state, first.message!);
    const heldBoth = holdAtFront(heldFirst, second.message!, new Set([ids[0]!]));
    assert.deepEqual(
      heldBoth.messages.map((message) => [message.id, message.holdUntilUserAction]),
      [
        [ids[0], true],
        [ids[1], true],
        [ids[2], false]
      ]
    );
  });

  it("guard 2, in order: with the ones it follows gone, a failure goes to the very front — never behind one queued after it", () => {
    const { state, ids } = queueOf("one", "two", "three");
    const taken = takeQueued(state, ids[1]!, "boundary-1");
    // A message queued later, but held for another reason, sits at the front.
    const later = { ...taken.state.messages[1]!, holdUntilUserAction: true };
    const withHeldLater = { ...taken.state, messages: [later, taken.state.messages[0]!] };
    const held = holdAtFront(withHeldLater, taken.message!, new Set(["gone"]));
    assert.deepEqual(
      held.messages.map((message) => message.id),
      [ids[1], ids[2], ids[0]]
    );
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
});
