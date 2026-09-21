import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type {
  AgentChatCommandName,
  AgentChatStreamFrame
} from "@orquester/api/agent-chat";

import {
  createThreadStore,
  resetDismissedErrorBanners,
  type AgentChatThreadState
} from "./store";
import { AgentChatCommandError, type AgentChatTransport } from "./transport";
import { activity, ev, message, resetBuilders, snapshot, stamp } from "./test-helpers";

interface Posted {
  name: AgentChatCommandName;
  body: Record<string, unknown>;
}

function fakeTransport(): {
  transport: AgentChatTransport;
  posted: Posted[];
  push(frame: AgentChatStreamFrame): void;
  fail(error: unknown, times?: number): void;
  streamCount(): number;
} {
  const posted: Posted[] = [];
  let onFrame: ((frame: AgentChatStreamFrame) => void) | null = null;
  let streams = 0;
  let failures: { error: unknown; times: number } | null = null;

  const transport: AgentChatTransport = {
    stream(_sessionId, _options, handlers) {
      streams += 1;
      onFrame = handlers.onFrame;
      return { lastSeq: 0, hostInstanceId: null, close: () => {} };
    },
    async command(_sessionId, name, body) {
      if (failures && failures.times > 0) {
        failures.times -= 1;
        throw failures.error;
      }
      posted.push({ name, body: body as unknown as Record<string, unknown> });
      return { seq: posted.length };
    },
    async read() {
      return { kind: "snapshot", thread: snapshot() };
    },
    async readItem() {
      throw new Error("unused");
    },
    async turnDiff() {
      throw new Error("unused");
    },
    async providers() {
      return { providers: [], hostInstanceId: "h1" };
    },
    async refreshProvider() {
      throw new Error("unused");
    },
    async upload() {
      return { type: "file", id: "/a/b", name: "b", sizeBytes: 1 };
    }
  };

  return {
    transport,
    posted,
    push: (frame) => onFrame?.(frame),
    fail: (error, times = 1) => {
      failures = { error, times };
    },
    streamCount: () => streams
  };
}

const flush = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve));

async function store(): Promise<{
  api: ReturnType<typeof createThreadStore>;
  fake: ReturnType<typeof fakeTransport>;
  state: () => AgentChatThreadState;
}> {
  const fake = fakeTransport();
  const api = createThreadStore("s1", {
    transport: fake.transport,
    newId: (() => {
      let n = 0;
      return () => `id${++n}`;
    })(),
    now: () => stamp(1),
    delay: async () => {}
  });
  await flush();
  return { api, fake, state: () => api.getState() };
}

beforeEach(() => {
  resetBuilders();
});

describe("the per-thread slice", () => {
  it("opens its stream and projects frames into rows", async () => {
    const { fake, state } = await store();
    assert.equal(fake.streamCount(), 1);

    fake.push({
      kind: "snapshot",
      thread: snapshot({
        items: [message("user", "hello", { createdAt: stamp(1) })],
        seq: 2
      })
    });
    assert.equal(state().slice.entries.length, 1);
    assert.equal(state().rows.filter((row) => row.kind === "message").length, 1);
  });

  it("derives background liveness from the roster it already has", async () => {
    const { fake, state } = await store();
    fake.push({
      kind: "snapshot",
      thread: snapshot({
        seq: 1,
        roster: [
          {
            id: "bg",
            kind: "subagent",
            agentKind: "background",
            title: "watch",
            role: null,
            model: null,
            effort: null,
            status: "running",
            activationCount: 1,
            usage: null,
            progress: null,
            lastToolName: null,
            result: null,
            error: null,
            outputFile: null,
            parentAgentId: null,
            agentIndex: null,
            phaseIndex: null,
            phaseTitle: null,
            attempt: null,
            workflowName: null,
            phases: [],
            runHandles: null,
            recentActivity: [],
            firstSeenAt: stamp(1),
            startedAt: null,
            completedAt: null,
            updatedAt: stamp(1)
          }
        ]
      })
    });
    assert.equal(state().slice.backgroundLiveness, "monitoring");
  });

  it("reads the context window off the activity fold", async () => {
    const { fake, state } = await store();
    fake.push({
      kind: "snapshot",
      thread: snapshot({
        seq: 1,
        items: [activity("context-window.updated", { usedTokens: 42, maxTokens: 100 })]
      })
    });
    assert.equal(state().slice.contextWindow?.usedTokens, 42);
  });

  it("preserves row identity across a streamed token", async () => {
    const { fake, state } = await store();
    const user = message("user", "hi", { createdAt: stamp(1) });
    fake.push({ kind: "snapshot", thread: snapshot({ items: [user], seq: 1 }) });
    const firstRows = state().rows;

    fake.push({
      kind: "event",
      seq: 2,
      event: ev(
        "thread.message-sent",
        { messageId: "a1", role: "assistant", text: "par", streaming: true, turnId: null },
        { seq: 2 }
      )
    });
    const secondRows = state().rows;
    assert.equal(secondRows[0], firstRows[0], "the user row keeps its identity");
  });
});

describe("commands", () => {
  it("mints a commandId per command and sends no optimistic row", async () => {
    const { api, fake, state } = await store();
    await api.getState().actions.sendTurn({ text: "go" });
    assert.equal(fake.posted[0]?.name, "turn");
    assert.equal(fake.posted[0]?.body.commandId, "id1");
    assert.equal(state().slice.entries.length, 0, "the message appears when its event arrives");
  });

  it("retries HOST_UNAVAILABLE with the SAME commandId", async () => {
    const { api, fake } = await store();
    fake.fail(new AgentChatCommandError(503, "HOST_UNAVAILABLE", "restarting"), 2);
    await api.getState().actions.compact();
    assert.equal(fake.posted.length, 1);
    assert.equal(fake.posted[0]?.body.commandId, "id1", "the receipt makes the retry free");
  });

  it("surfaces a non-retryable failure in the error banner", async () => {
    const { api, state } = await store();
    const { fake } = await store();
    void fake;
    const failing = await store();
    failing.fake.fail(new AgentChatCommandError(409, "COMMAND_REJECTED", "no"), 99);
    await assert.rejects(() => failing.api.getState().actions.revert({ targetTurnCount: 1 }));
    assert.equal(failing.state().slice.errorBanner, "no");
    void api;
    void state;
  });

  it("locks the row while a decision is in flight and clears it in a finally", async () => {
    const { api, fake, state } = await store();
    fake.fail(new AgentChatCommandError(409, "COMMAND_REJECTED", "stale"), 99);
    await assert.rejects(() =>
      api.getState().actions.respondApproval({ requestId: "r1", decision: "accept" })
    );
    assert.deepEqual(state().slice.respondingRequestIds, [], "cleared even on failure");
  });

  it("omits turnId unless the session is running", async () => {
    const { api, fake } = await store();
    await api.getState().actions.interrupt();
    assert.equal("turnId" in (fake.posted[0]?.body ?? {}), false);
  });
});

describe("the queued-message model", () => {
  const draft = (text: string) => ({
    text,
    attachments: [],
    context: [],
    interactionMode: "default" as const,
    queuedAfterToolActivityId: null,
    holdUntilUserAction: false
  });

  it("stamps the anchor from the latest completed tool activity", async () => {
    const { api, fake, state } = await store();
    const completed = activity("tool.completed", { itemType: "command_execution", command: "ls" });
    fake.push({ kind: "snapshot", thread: snapshot({ items: [completed], seq: 1 }) });

    api.getState().actions.queueMessage(draft("later"));
    assert.equal(
      state().slice.queue[0]?.queuedAfterToolActivityId,
      completed.id,
      "the composer does not observe activities; the store stamps it"
    );
  });

  it("returns every queued message to the composer on interrupt", async () => {
    const { api, state } = await store();
    api.getState().actions.queueMessage(draft("one"));
    api.getState().actions.queueMessage(draft("two"));
    await api.getState().actions.interrupt();
    assert.equal(state().slice.queue.length, 0);
    assert.equal(state().draft.text, "one\n\ntwo");
  });

  it("holds a failed send at the FRONT so nothing overtakes it", async () => {
    const { api, fake, state } = await store();
    api.getState().actions.queueMessage(draft("one"));
    api.getState().actions.queueMessage(draft("two"));
    const headId = state().slice.queue[0]!.id;
    fake.fail(new AgentChatCommandError(409, "COMMAND_REJECTED", "no"), 99);

    await assert.rejects(() => api.getState().actions.sendQueuedNow(headId));
    assert.equal(state().slice.queue[0]?.id, headId);
    assert.equal(state().slice.queue[0]?.holdUntilUserAction, true);
    assert.equal(state().slice.queue.length, 2);
  });

  it("re-anchors the remainder when one message leaves", async () => {
    const { api, fake, state } = await store();
    const completed = activity("tool.completed", { itemType: "command_execution", command: "ls" });
    fake.push({ kind: "snapshot", thread: snapshot({ items: [completed], seq: 1 }) });
    api.getState().actions.queueMessage(draft("one"));
    api.getState().actions.queueMessage(draft("two"));
    const headId = state().slice.queue[0]!.id;

    await api.getState().actions.sendQueuedNow(headId);
    assert.equal(state().slice.queue.length, 1);
    assert.equal(state().slice.queue[0]?.queuedAfterToolActivityId, completed.id);
  });

  it("returns one queued message to the composer", async () => {
    const { api, state } = await store();
    api.getState().actions.queueMessage(draft("one"));
    api.getState().actions.returnQueuedToComposer(state().slice.queue[0]!.id);
    assert.equal(state().slice.queue.length, 0);
    assert.equal(state().draft.text, "one");
  });
});

describe("client-local view state", () => {
  it("toggles interaction mode, follow and disclosures without a command", async () => {
    const { api, fake, state } = await store();
    api.getState().actions.setInteractionMode("plan");
    api.getState().actions.setFollow(false);
    api.getState().actions.setDisclosure({ expandedTurnIds: ["t1"] });
    assert.equal(state().slice.interactionMode, "plan");
    assert.equal(state().slice.follow, false);
    assert.deepEqual(state().slice.disclosures.expandedTurnIds, ["t1"]);
    assert.equal(fake.posted.length, 0);
  });

  it("dismisses the error banner", async () => {
    resetDismissedErrorBanners();
    const { api, fake, state } = await store();
    fake.fail(new AgentChatCommandError(409, "COMMAND_REJECTED", "no"), 99);
    await assert.rejects(() => api.getState().actions.compact());
    assert.equal(state().slice.errorBanner, "no");
    api.getState().actions.dismissErrorBanner();
    assert.equal(state().slice.errorBanner, null);
  });

  it("remembers a dismissal per (thread, message) — a DIFFERENT error still shows", async () => {
    resetDismissedErrorBanners();
    const { api, fake, state } = await store();
    fake.fail(new AgentChatCommandError(409, "COMMAND_REJECTED", "same"), 1);
    await assert.rejects(() => api.getState().actions.compact());
    api.getState().actions.dismissErrorBanner();

    fake.fail(new AgentChatCommandError(409, "COMMAND_REJECTED", "same"), 1);
    await assert.rejects(() => api.getState().actions.compact());
    assert.equal(state().slice.errorBanner, null, "the closed banner stays closed");

    fake.fail(new AgentChatCommandError(409, "COMMAND_REJECTED", "different"), 1);
    await assert.rejects(() => api.getState().actions.compact());
    assert.equal(state().slice.errorBanner, "different");
  });

  it("retries a lost response with the SAME commandId", async () => {
    const { api, fake } = await store();
    // A transport-level throw: the response never arrived (§6.6).
    fake.fail(new Error("socket hang up"), 1);
    await api.getState().actions.stopSession();
    assert.equal(fake.posted.length, 1);
    assert.equal(fake.posted[0]?.body.commandId, "id1");
  });

  it("writes the scroll/disclosure LRU and mirrors follow from atEnd", async () => {
    const { api, state } = await store();
    api.getState().actions.rememberScroll({ rowId: "r9", scrollOffset: 120, atEnd: false });
    assert.equal(state().slice.scroll?.rowId, "r9");
    assert.equal(state().slice.scroll?.scrollOffset, 120);
    assert.equal(state().slice.follow, false);

    api.getState().actions.rememberScroll({ atEnd: true });
    assert.equal(state().slice.follow, true);
    assert.equal(state().slice.scroll?.rowId, "r9", "unspecified fields are kept");
  });
});
