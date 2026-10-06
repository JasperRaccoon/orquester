import assert from "node:assert/strict";
import { describe,it } from "node:test";

import type { QueuedComposerMessage } from "./contracts";
import {
EMPTY_QUEUE,
enqueue,
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
    assert.equal(first.message?.text, "one");
    const second = takeQueued(first.state, ids[0]!, null);
    assert.equal(second.message, null);
  });
});

describe("the three guards", () => {
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

  it("never sends while connecting — the gap between a send and pick-up", () => {
    assert.equal(
      isQueuedMessageDue({ message, phase: "connecting", latestToolActivityId: "a2" }),
      false
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
