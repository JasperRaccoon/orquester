/**
 * The store's head projection must agree with the shared fold, event for
 * event — that agreement is the only thing keeping `meta.json` honest while
 * the two live in different packages (§5.1).
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { DomainEvent } from "@orquester/api/agent-chat";
import { applyDomainEvent, createEmptyThreadState } from "@orquester/api/agent-chat";

import { applyEventToHead } from "./head.ts";

let seq = 0;

function ev<T extends DomainEvent["type"]>(
  type: T,
  payload: Extract<DomainEvent, { type: T }>["payload"]
): DomainEvent {
  seq += 1;
  return {
    seq,
    eventId: `e${seq}`,
    threadId: "t1",
    type,
    payload,
    occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    commandId: null,
    causationEventId: null,
    metadata: {}
  } as DomainEvent;
}

function representativeLog(): DomainEvent[] {
  seq = 0;
  return [
    ev("thread.created", {
      projectPath: "/w/p",
      cwd: "/w/p",
      title: "New thread",
      adapter: "claude",
      refId: "claude",
      accountId: "acc-1",
      home: "account",
      modelSelection: { model: "sonnet" },
      runtimeMode: "approval-required"
    }),
    ev("thread.meta-updated", { title: "Renamed", modelSelection: { model: "opus" } }),
    ev("thread.runtime-mode-set", { runtimeMode: "auto" }),
    ev("thread.message-sent", {
      messageId: "user:1",
      role: "user",
      text: "hi",
      streaming: false,
      turnId: null
    }),
    ev("thread.turn-start-requested", {
      turnId: null,
      messageId: "user:1",
      interactionMode: "default"
    }),
    ev("thread.session-set", {
      session: { status: "running", activeTurnId: "T-1", providerThreadId: "p-1" }
    }),
    ev("thread.activity-appended", {
      activity: {
        kind: "activity",
        id: "a1",
        tone: "tool",
        activityKind: "tool.started",
        summary: "Bash",
        payload: { toolUseId: "tu" },
        turnId: "T-1",
        createdAt: "2026-01-01T00:00:06.000Z",
        updatedAt: "2026-01-01T00:00:06.000Z"
      }
    }),
    ev("thread.session-set", { session: { status: "ready", activeTurnId: null } }),
    ev("thread.turn-diff-completed", {
      turnCount: 1,
      turnId: "T-1",
      ref: "refs/orquester/checkpoints/x/turn/1",
      status: "ready",
      files: [],
      assistantMessageId: null,
      completedAt: "2026-01-01T00:00:08.000Z"
    }),
    ev("thread.turn-diff-completed", {
      turnCount: 2,
      turnId: "T-2",
      ref: "refs/orquester/checkpoints/x/turn/2",
      status: "ready",
      files: [],
      assistantMessageId: null,
      completedAt: "2026-01-01T00:00:09.000Z"
    }),
    ev("thread.reverted", { turnCount: 1 }),
    ev("thread.session-set", { session: { status: "stopped", activeTurnId: null } })
  ];
}

test("the store's head projection matches the shared fold's head", () => {
  const events = representativeLog();

  let foldState = createEmptyThreadState();
  let head = null as ReturnType<typeof applyEventToHead>;
  for (const event of events) {
    foldState = applyDomainEvent(foldState, event);
    head = applyEventToHead(head, event);
    assert.deepEqual(head, foldState.head, `diverged at ${event.type} (seq ${event.seq})`);
  }
});

test("an event before thread.created leaves the head null", () => {
  seq = 0;
  assert.equal(applyEventToHead(null, ev("thread.runtime-mode-set", { runtimeMode: "auto" })), null);
});

test("continueAfterRestart is carried forward, never minted", () => {
  const events = representativeLog();
  let head = applyEventToHead(null, events[0]!);
  head = { ...head!, continueAfterRestart: { turnId: "T-9", prepared: true } };
  for (const event of events.slice(1)) {
    head = applyEventToHead(head, event);
  }
  assert.deepEqual(head?.continueAfterRestart, { turnId: "T-9", prepared: true });
});
