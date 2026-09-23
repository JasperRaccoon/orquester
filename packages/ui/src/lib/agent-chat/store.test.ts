import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";

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
import { activity, ev, head, message, resetBuilders, snapshot, stamp } from "./test-helpers";

interface Posted {
  /** `"account"` is the daemon-owned §3.4 route, not a §6.2 command name. */
  name: AgentChatCommandName | "account";
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
      return { lastSeq: 0, hostInstanceId: null, resetCursor: () => {}, close: () => {} };
    },
    async command(_sessionId, name, body) {
      if (failures && failures.times > 0) {
        failures.times -= 1;
        throw failures.error;
      }
      posted.push({ name, body: body as unknown as Record<string, unknown> });
      return { seq: posted.length };
    },
    // §3.4's account switch: a daemon-owned route, recorded under its own name
    // so a test can assert it never travels as a §6.2 command.
    async switchAccount(_sessionId, body) {
      if (failures && failures.times > 0) {
        failures.times -= 1;
        throw failures.error;
      }
      posted.push({ name: "account", body: body as unknown as Record<string, unknown> });
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
    },
    async fetchAttachment() {
      return new ArrayBuffer(0);
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

async function store(sessionId = "s1"): Promise<{
  api: ReturnType<typeof createThreadStore>;
  fake: ReturnType<typeof fakeTransport>;
  state: () => AgentChatThreadState;
}> {
  const fake = fakeTransport();
  const api = createThreadStore(sessionId, {
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
            exitCode: null,
            isBackgrounded: null,
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

  it("setAccount posts the daemon-owned route with a minted commandId (§3.4)", async () => {
    const { api, fake, state } = await store();
    await api.getState().actions.setAccount({ accountId: "acc-2" });
    assert.equal(fake.posted.length, 1);
    assert.equal(fake.posted[0]?.name, "account", "never a §6.2 command");
    assert.deepEqual(fake.posted[0]?.body, { commandId: "id1", accountId: "acc-2" });
    // Applied on the next message: nothing optimistic, no row, no head edit.
    assert.equal(state().slice.entries.length, 0);
    assert.equal(state().slice.errorBanner, null);
  });

  it("setAccount retries HOST_UNAVAILABLE with the same id and banners a refusal", async () => {
    const retrying = await store();
    retrying.fake.fail(new AgentChatCommandError(503, "HOST_UNAVAILABLE", "restarting"), 2);
    await retrying.api.getState().actions.setAccount({ accountId: "acc-2" });
    assert.equal(retrying.fake.posted.length, 1);
    assert.equal(retrying.fake.posted[0]?.body.commandId, "id1");

    const refused = await store();
    refused.fake.fail(
      new AgentChatCommandError(409, "COMMAND_REJECTED", "Wait for the agent to finish."),
      99
    );
    await assert.rejects(() => refused.api.getState().actions.setAccount({ accountId: "acc-2" }));
    assert.equal(refused.state().slice.errorBanner, "Wait for the agent to finish.");
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

  it("holds `reverting` for the length of the revert and clears it even on failure", async () => {
    // §7.5's ONE reason the composer goes inert. It used to be hard-coded
    // `false` in the view with nothing to set it, so a turn could be typed and
    // sent into the middle of the host rewriting the thread.
    const { api, state } = await store();
    assert.equal(state().reverting, false);
    const inFlight = api.getState().actions.revert({ targetTurnCount: 1 });
    assert.equal(state().reverting, true, "inert while the command is out");
    await inFlight;
    assert.equal(state().reverting, false);

    const failing = await store();
    failing.fake.fail(new AgentChatCommandError(409, "COMMAND_REJECTED", "no"), 99);
    await assert.rejects(() => failing.api.getState().actions.revert({ targetTurnCount: 1 }));
    assert.equal(failing.state().reverting, false, "a refusal must not leave it inert forever");
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
    // A RUNNING turn, so the message waits on the next boundary and its anchor
    // is observable — on an idle thread the drive loop sends it at once (R7-1).
    fake.push({
      kind: "snapshot",
      thread: snapshot({
        items: [completed],
        seq: 1,
        head: head({ session: { status: "running", activeTurnId: "t1" } })
      })
    });

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
    fake.push({
      kind: "snapshot",
      thread: snapshot({
        items: [completed],
        seq: 1,
        head: head({ session: { status: "running", activeTurnId: "t1" } })
      })
    });
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

/**
 * The composer's unsent draft lives here, not in the component (§7.4).
 *
 * The composer mounts, loads this, and writes back on every change — so the
 * two halves that have to hold are "a save reaches `localStorage` under this
 * thread's id" and "a store built from nothing finds it again", which is
 * exactly the shape of a reload.
 */
describe("the persisted composer draft", () => {
  const DRAFTS_KEY = "orquester:agent-chat-drafts";
  let backing: Record<string, string> = {};

  const attachment = {
    type: "file" as const,
    id: "a1",
    name: "notes.txt",
    sizeBytes: 12
  };

  beforeEach(() => {
    backing = {};
    const stub = {
      getItem: (key: string) => backing[key] ?? null,
      setItem: (key: string, value: string) => {
        backing[key] = value;
      },
      removeItem: (key: string) => {
        delete backing[key];
      },
      clear: () => {
        backing = {};
      },
      key: (index: number) => Object.keys(backing)[index] ?? null,
      get length() {
        return Object.keys(backing).length;
      }
    };
    (globalThis as unknown as { localStorage: unknown }).localStorage = stub;
  });

  after(() => {
    delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
  });

  const persisted = (): Record<string, { text: string; attachments: { id: string }[] }> =>
    JSON.parse(backing[DRAFTS_KEY] ?? "{}");

  it("writes a saved draft straight through to storage, under its own thread id", async () => {
    const { api, state } = await store("draft-1");
    api.getState().actions.saveDraft({
      text: "half a thought",
      attachments: [attachment],
      context: []
    });
    assert.equal(state().draft.text, "half a thought");
    assert.equal(persisted()["draft-1"]?.text, "half a thought");
    assert.deepEqual(persisted()["draft-1"]?.attachments.map((ref) => ref.id), ["a1"]);
  });

  it("seeds a fresh store from storage — which is what a reload is", async () => {
    backing[DRAFTS_KEY] = JSON.stringify({
      "draft-2": { text: "typed, never sent", attachments: [attachment], context: [] }
    });
    const { state } = await store("draft-2");
    assert.equal(state().draft.text, "typed, never sent");
    assert.deepEqual(
      state().draft.attachments.map((ref) => ref.id),
      ["a1"],
      "an uploaded attachment comes back as a reference the composer can re-stage"
    );
  });

  it("drops the entry when the draft is cleared, so a sent message never returns", async () => {
    backing[DRAFTS_KEY] = JSON.stringify({
      "draft-3": { text: "about to be sent", attachments: [], context: [] }
    });
    const { api, state } = await store("draft-3");
    assert.equal(state().draft.text, "about to be sent");

    api.getState().actions.saveDraft({ text: "", attachments: [], context: [] });
    assert.equal(state().draft.text, "");
    assert.equal(persisted()["draft-3"], undefined);
  });

  it("leaves another thread's draft alone", async () => {
    backing[DRAFTS_KEY] = JSON.stringify({
      other: { text: "someone else's", attachments: [], context: [] }
    });
    const { api } = await store("draft-4");
    api.getState().actions.saveDraft({ text: "mine", attachments: [], context: [] });
    assert.equal(persisted().other?.text, "someone else's");
    assert.equal(persisted()["draft-4"]?.text, "mine");
  });
});
