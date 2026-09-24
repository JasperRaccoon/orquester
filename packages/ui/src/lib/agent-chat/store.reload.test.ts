/**
 * A reload never loses or duplicates a message (§7.4).
 *
 * `submit` clears the draft before the send leaves, and a queued message lives
 * in the thread store: a reload used to take both with it. What was still
 * sending came back only if its post had reached the host; the queue did not
 * come back at all. Now every send in flight and every queued message not yet
 * delivered is kept in the tab's `sessionStorage` with its `commandId`, and
 * the thread's first store after the reload picks it up: a send is re-posted
 * under the SAME id — the host's receipt turns a delivered one into a no-op —
 * or, too old for that, comes back to the draft; the queue comes back as it
 * was.
 *
 * A reload is simulated in-process: every module-level memory of the page is
 * dropped (the thread stores, the send registry, the outbox's page identity)
 * and only the storage stays.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type {
  AgentChatCommandName,
  AgentChatStreamFrame,
  AttachmentRef
} from "@orquester/api/agent-chat";

import { registerComposerHandle } from "../../components/agent-chat/composer/composer-bridge";
import {
  COMPOSER_OUTBOX_KEY,
  OUTBOX_REPLAY_MAX_AGE_MS,
  resetComposerOutbox
} from "../../components/agent-chat/composer/composer-outbox";
import {
  isComposerSending,
  resetComposerSends
} from "../../components/agent-chat/composer/composer-sends";
import type { FailedSendRestore } from "../../components/agent-chat/composer/composer-submission";
import type { StagedAttachment } from "../../components/agent-chat/composer/ComposerAttachments";
import {
  createThreadStore,
  resetDismissedErrorBanners,
  resetThreadStores,
  retainThreadStore,
  type ThreadStore
} from "./store";
import { AgentChatCommandError, type AgentChatTransport } from "./transport";
import { head, snapshot, stamp } from "./test-helpers";

const DRAFTS_KEY = "orquester:agent-chat-drafts";

/** The clock every store here reads: `sentAt` and the bound are measured on it. */
const now = (): string => stamp(1);
const NOW = Date.parse(stamp(1));

let session = new Map<string, string>();
let local = new Map<string, string>();

function storage(backing: () => Map<string, string>) {
  return {
    getItem: (key: string) => backing().get(key) ?? null,
    setItem: (key: string, value: string) => void backing().set(key, value),
    removeItem: (key: string) => void backing().delete(key),
    clear: () => backing().clear(),
    key: (index: number) => [...backing().keys()][index] ?? null,
    get length() {
      return backing().size;
    }
  };
}

const flush = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve));
/** Let every queued microtask run — a command's whole await chain settles. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface Attempt {
  name: AgentChatCommandName;
  body: Record<string, unknown>;
  answer(): void;
  fail(error: unknown): void;
}

/**
 * A host behind a gate: every command attempt waits for the test to answer
 * it. An answered `turn` lands once per `commandId` — a repeated id is
 * answered from its receipt with the seq it recorded, and starts nothing
 * (§6.2) — so `turns` is what the agent actually received.
 */
function fakeHost() {
  const receipts = new Map<string, number>();
  const turns: string[] = [];
  const attempts: Attempt[] = [];
  let onFrame: ((frame: AgentChatStreamFrame) => void) | null = null;
  const land = (name: AgentChatCommandName, commandId: string): { seq: number } => {
    if (!receipts.has(commandId)) {
      receipts.set(commandId, receipts.size + 1);
      if (name === "turn") turns.push(commandId);
    }
    return { seq: receipts.get(commandId)! };
  };
  const unused = async (): Promise<never> => {
    throw new Error("unused");
  };
  const transport: AgentChatTransport = {
    stream(_sessionId, _options, handlers) {
      onFrame = handlers.onFrame;
      return { lastSeq: 0, hostInstanceId: null, resetCursor: () => {}, close: () => {} };
    },
    command(_sessionId, name, body) {
      const record = body as unknown as Record<string, unknown>;
      return new Promise((resolve, reject) => {
        attempts.push({
          name,
          body: record,
          answer: () => resolve(land(name, String(record.commandId))),
          fail: reject
        });
      });
    },
    switchAccount: unused,
    read: unused,
    readItem: unused,
    readHistory: unused,
    search: unused,
    turnDiff: unused,
    async providers() {
      return { providers: [], hostInstanceId: "h1" };
    },
    refreshProvider: unused,
    upload: unused,
    async fetchAttachment() {
      return new ArrayBuffer(0);
    }
  };
  return {
    transport,
    attempts,
    turns,
    /** A post of the previous page that reached the host before the page went away. */
    landed: (commandId: string) => void land("turn", commandId),
    push: (frame: AgentChatStreamFrame) => onFrame?.(frame),
    posted: () => attempts.map((attempt) => [attempt.body.input, attempt.body.commandId])
  };
}

const ids = (prefix: string): (() => string) => {
  let n = 0;
  return () => `${prefix}${++n}`;
};

function open(sessionId: string, host: ReturnType<typeof fakeHost>, idPrefix = "id"): ThreadStore {
  return createThreadStore(sessionId, {
    transport: host.transport,
    newId: ids(idPrefix),
    now,
    delay: async () => {}
  });
}

/**
 * The page a reload replaces: its store is the registry's, so the reload
 * below tears it down — nothing of it may act after, as nothing of a page
 * a browser reloaded does.
 */
function previousPage(sessionId: string, host: ReturnType<typeof fakeHost>): ThreadStore {
  return retainThreadStore(sessionId, {
    transport: host.transport,
    newId: ids("first-page-"),
    now,
    delay: async () => {}
  });
}

/** Everything the page held in memory is gone; the tab's storage is what survives. */
function reload(): void {
  resetThreadStores();
  resetComposerSends();
  resetComposerOutbox();
  resetDismissedErrorBanners();
}

const running = (sessionId: string): AgentChatStreamFrame => ({
  kind: "snapshot",
  thread: snapshot({ seq: 1, head: head({ id: sessionId, session: { status: "running", activeTurnId: "t1" } }) })
});
const ready = (sessionId: string, seq = 2): AgentChatStreamFrame => ({
  kind: "snapshot",
  thread: snapshot({ seq, head: head({ id: sessionId, session: { status: "ready", activeTurnId: null } }) })
});

const file = (id: string): AttachmentRef => ({ type: "file", id, name: `${id}.txt`, sizeBytes: 12 });

/** What a previous page of this tab left: its entries, as it stored them. */
function left(entries: unknown[]): void {
  session.set(COMPOSER_OUTBOX_KEY, JSON.stringify({ v: 1, entries }));
}
const sendLeft = (overrides: Record<string, unknown> = {}) => ({
  kind: "send",
  pageId: "previous-page",
  sessionId: "A",
  commandId: "c1",
  sentAt: NOW,
  turn: { input: "deploy the fix" },
  ...overrides
});
const queuedLeft = (id: string, text: string, overrides: Record<string, unknown> = {}) => ({
  kind: "queued",
  pageId: "previous-page",
  sessionId: "A",
  message: {
    id,
    commandId: `c-${id}`,
    text,
    attachments: [],
    context: [],
    interactionMode: "default",
    queuedAfterToolActivityId: null,
    holdUntilUserAction: false,
    queuedAt: stamp(1)
  },
  ...overrides
});

const stored = (): string | null => session.get(COMPOSER_OUTBOX_KEY) ?? null;
const persistedDraft = (sessionId: string): { text: string; attachments: AttachmentRef[] } | undefined =>
  JSON.parse(local.get(DRAFTS_KEY) ?? "{}")[sessionId];

const queuedInput = (text: string) => ({
  text,
  attachments: [],
  context: [],
  interactionMode: "default" as const,
  queuedAfterToolActivityId: null,
  holdUntilUserAction: false
});

describe("a reload never loses or duplicates a message", () => {
  beforeEach(() => {
    session = new Map();
    local = new Map();
    (globalThis as unknown as { sessionStorage: unknown }).sessionStorage = storage(() => session);
    (globalThis as unknown as { localStorage: unknown }).localStorage = storage(() => local);
    reload();
  });

  afterEach(() => {
    reload();
    delete (globalThis as unknown as { sessionStorage?: unknown }).sessionStorage;
    delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
  });

  it("re-posts a send the page was still posting under the SAME commandId, once, the thread reading Sending meanwhile", async () => {
    const before = fakeHost();
    const page = previousPage("A", before);
    await flush();
    void page.getState().actions.sendTurn({ text: "deploy the fix", attachments: [file("f1")] }).catch(() => {});
    await settle();
    assert.equal(before.attempts.length, 1);
    const commandId = before.attempts[0]!.body.commandId;

    reload();
    const host = fakeHost();
    const thread = open("A", host, "second-page-");
    await flush();
    assert.deepEqual(host.posted(), [["deploy the fix", commandId]], "the same command, never a new one");
    assert.deepEqual(
      (host.attempts[0]!.body.attachments as AttachmentRef[]).map((ref) => ref.id),
      ["f1"],
      "with what it carried"
    );
    assert.equal(isComposerSending("A"), true, "a composer showing the thread reads Sending, and refuses Enter");

    // Once: the thread's next generation in this page does not post it again.
    open("A", host, "third-generation-");
    await flush();
    assert.equal(host.attempts.length, 1);

    host.attempts[0]!.answer();
    await settle();
    assert.equal(isComposerSending("A"), false);
    assert.equal(thread.getState().draft.text, "", "a delivered send gives nothing back");
    assert.equal(stored(), null, "settled: nothing left for another reload");
  });

  it("does not deliver twice a send that had landed: the host's receipt answers the re-post", async () => {
    const host = fakeHost();
    host.landed("c1");
    left([sendLeft({ commandId: "c1" })]);

    const thread = open("A", host);
    await flush();
    assert.deepEqual(host.posted(), [["deploy the fix", "c1"]]);
    host.attempts[0]!.answer();
    await settle();

    assert.deepEqual(host.turns, ["c1"], "one turn: the re-post was answered from its receipt");
    assert.equal(thread.getState().draft.text, "", "nothing comes back to the draft");
    assert.equal(isComposerSending("A"), false);
    assert.equal(stored(), null);
  });

  it("does not re-post a send older than the replay bound: it comes back to the thread's draft", async () => {
    left([
      sendLeft({
        commandId: "stale",
        sentAt: NOW - OUTBOX_REPLAY_MAX_AGE_MS - 1,
        turn: { input: "too old to replay", attachments: [file("f1")] }
      }),
      sendLeft({ commandId: "edge", sentAt: NOW - OUTBOX_REPLAY_MAX_AGE_MS, turn: { input: "just in time" } })
    ]);
    const host = fakeHost();
    const thread = open("A", host);
    await flush();

    assert.deepEqual(host.posted(), [["just in time", "edge"]], "exactly at the bound it is still re-posted");
    assert.equal(thread.getState().draft.text, "too old to replay");
    assert.deepEqual(thread.getState().draft.attachments.map((ref) => ref.id), ["f1"], "its files with it");
    assert.equal(persistedDraft("A")?.text, "too old to replay", "where the next mount loads it");
    assert.deepEqual(
      JSON.parse(stored()!).entries.map((entry: { commandId: string }) => entry.commandId),
      ["edge"],
      "the stale one is settled; the re-post is kept until it settles"
    );
  });

  it("says why a stale send is back on the thread itself, for whoever opens it next", async () => {
    left([sendLeft({ sentAt: NOW - OUTBOX_REPLAY_MAX_AGE_MS - 1 })]);
    const thread = open("A", fakeHost());
    await flush();
    assert.equal(thread.getState().draft.text, "deploy the fix");
    assert.match(
      thread.getState().slice.errorBanner ?? "",
      /reload/i,
      "no composer was mounted to show a notice: the banner says it"
    );
  });

  it("gives several stale sends back in the order they were sent, ahead of what the draft holds", async () => {
    local.set(DRAFTS_KEY, JSON.stringify({ A: { text: "typed after", attachments: [], context: [] } }));
    left([
      sendLeft({ commandId: "first", sentAt: NOW - OUTBOX_REPLAY_MAX_AGE_MS - 2, turn: { input: "first" } }),
      sendLeft({ commandId: "second", sentAt: NOW - OUTBOX_REPLAY_MAX_AGE_MS - 1, turn: { input: "second" } })
    ]);
    const thread = open("A", fakeHost());
    await flush();
    assert.equal(thread.getState().draft.text, "first\n\nsecond\n\ntyped after");
  });

  it("hands a stale send to the composer that shows the thread, saying why it is back", async () => {
    const restored: FailedSendRestore<StagedAttachment>[] = [];
    const unregister = registerComposerHandle("A", {
      insertText: () => {},
      stageAttachment: () => false,
      returnMessage: () => [],
      focusAtEnd: () => {},
      openControl: () => {},
      restoreFailedSend: (restore) => {
        restored.push(restore);
        return true;
      }
    });
    try {
      left([sendLeft({ sentAt: NOW - OUTBOX_REPLAY_MAX_AGE_MS - 1, turn: { input: "check first", attachments: [file("f1")] } })]);
      const thread = open("A", fakeHost());
      await flush();

      assert.equal(restored.length, 1);
      const [restore] = restored;
      assert.equal(restore!.outcome.kind, "failed");
      assert.equal(restore!.outcome.kind === "failed" ? restore!.outcome.text : null, "check first");
      assert.match(restore!.outcome.notice, /reload/i, "the notice says why it did not go out by itself");
      assert.deepEqual(restore!.sent.map((chip) => chip.ref?.id), ["f1"]);
      assert.equal(thread.getState().draft.text, "", "nothing parked behind the composer that took it");
    } finally {
      unregister();
    }
  });

  it("gives nothing back for a stale Implement: its prompt was the composer's, and the plan is still there", async () => {
    left([
      sendLeft({
        sentAt: NOW - OUTBOX_REPLAY_MAX_AGE_MS - 1,
        turn: { input: "PLEASE IMPLEMENT THIS PLAN:\n- step" },
        generatedPrompt: true
      })
    ]);
    const host = fakeHost();
    const thread = open("A", host);
    await flush();
    assert.equal(host.attempts.length, 0);
    assert.equal(thread.getState().draft.text, "");
    assert.equal(stored(), null);
  });

  it("puts a refused re-post back into the draft, as any send that did not go out", async () => {
    left([sendLeft({ turn: { input: "deploy the fix" } })]);
    const host = fakeHost();
    const thread = open("A", host);
    await flush();
    assert.equal(host.attempts.length, 1);
    host.attempts[0]!.fail(new AgentChatCommandError(409, "COMMAND_REJECTED", "The thread is being rewound."));
    await settle();

    assert.equal(thread.getState().draft.text, "deploy the fix");
    assert.equal(thread.getState().slice.errorBanner, "The thread is being rewound.");
    assert.equal(isComposerSending("A"), false);
    assert.equal(stored(), null);
    assert.deepEqual(host.turns, []);
  });

  it("brings queued messages back as queued, in order, under the commandIds they were queued with", async () => {
    const before = fakeHost();
    const page = previousPage("A", before);
    await flush();
    before.push(running("A"));
    for (const text of ["one", "two", "three"]) page.getState().actions.queueMessage(queuedInput(text));
    const queuedWith = page.getState().slice.queue.map((message) => message.commandId);
    assert.equal(new Set(queuedWith).size, 3, "each queued message has its own commandId");
    assert.equal(before.attempts.length, 0, "a running turn: nothing was due");

    reload();
    const host = fakeHost();
    const thread = open("A", host, "second-page-");
    await flush();
    assert.deepEqual(
      thread.getState().slice.queue.map((message) => [message.text, message.commandId]),
      [
        ["one", queuedWith[0]],
        ["two", queuedWith[1]],
        ["three", queuedWith[2]]
      ]
    );
    assert.equal(host.attempts.length, 0, "nothing goes out before the thread says it may");

    // The turn is over: the queue drains one message at a time, in order.
    host.push(ready("A"));
    await settle();
    assert.deepEqual(host.posted(), [["one", queuedWith[0]]]);
    host.attempts[0]!.answer();
    await settle();
    assert.deepEqual(host.posted(), [
      ["one", queuedWith[0]],
      ["two", queuedWith[1]]
    ]);
    host.attempts[1]!.answer();
    await settle();
    host.attempts[2]!.answer();
    await settle();
    assert.deepEqual(host.turns, queuedWith);
    assert.deepEqual(thread.getState().slice.queue, []);
    assert.equal(stored(), null);
  });

  it("leaves nothing for a reload once a send settled — delivered, or given back to the draft", async () => {
    const before = fakeHost();
    const page = previousPage("A", before);
    await flush();
    const delivered = page.getState().actions.sendTurn({ text: "landed" });
    const refused = page.getState().actions.sendTurn({ text: "given back" }).catch(() => {});
    await settle();
    before.attempts[0]!.answer();
    before.attempts[1]!.fail(new AgentChatCommandError(409, "COMMAND_REJECTED", "no"));
    await delivered;
    await refused;
    assert.equal(stored(), null);

    reload();
    const host = fakeHost();
    open("A", host, "second-page-");
    await flush();
    assert.equal(host.attempts.length, 0, "the composer already gave the refused one back: never twice");
  });

  it("re-posts first, under its own id, the queued send a page was posting when it reloaded", async () => {
    const before = fakeHost();
    const page = previousPage("A", before);
    await flush();
    before.push(running("A"));
    page.getState().actions.queueMessage(queuedInput("one"));
    page.getState().actions.queueMessage(queuedInput("two"));
    const [one, two] = page.getState().slice.queue.map((message) => message.commandId);
    before.push(ready("A"));
    await settle();
    assert.deepEqual(before.posted(), [["one", one]], "the head is on its way");

    reload();
    const host = fakeHost();
    const thread = open("A", host, "second-page-");
    await flush();
    host.push(ready("A"));
    await settle();
    assert.deepEqual(host.posted(), [["one", one]], "the head again, the same command — and nothing else yet");
    assert.deepEqual(thread.getState().slice.queue.map((message) => message.text), ["two"]);
    host.attempts[0]!.answer();
    await settle();
    assert.deepEqual(host.posted(), [
      ["one", one],
      ["two", two]
    ]);
  });

  it("starts a generation that has nothing retained from the queue this page kept", async () => {
    const host = fakeHost();
    const first = open("A", host, "first-");
    await flush();
    host.push(running("A"));
    first.getState().actions.queueMessage(queuedInput("one"));
    first.getState().actions.queueMessage(queuedInput("two"));
    const queuedWith = first.getState().slice.queue.map((message) => message.commandId);
    // Torn down with its retained snapshot gone — what the 5-minute idle TTL does.
    (first as ThreadStore & { destroy?: (options?: { retain?: boolean }) => void }).destroy?.({
      retain: false
    });

    const next = open("A", host, "next-");
    assert.deepEqual(
      next.getState().slice.queue.map((message) => [message.text, message.commandId]),
      [
        ["one", queuedWith[0]],
        ["two", queuedWith[1]]
      ]
    );
  });

  it("does not bring back as queued what Stop returned to the composer", async () => {
    const before = fakeHost();
    const page = previousPage("A", before);
    await flush();
    before.push(running("A"));
    page.getState().actions.queueMessage(queuedInput("one"));
    page.getState().actions.drainQueueToComposer();
    assert.equal(page.getState().draft.text, "one");

    reload();
    const thread = open("A", fakeHost(), "second-page-");
    await flush();
    assert.deepEqual(thread.getState().slice.queue, [], "it is in the draft, once");
    assert.equal(thread.getState().draft.text, "one");
  });

  it("re-posts first the queued send the page was posting, and holds the rest of the queue until it settles", async () => {
    left([queuedLeft("q1", "one", { sentAt: NOW }), queuedLeft("q2", "two"), queuedLeft("q3", "three")]);
    const host = fakeHost();
    const thread = open("A", host);
    await flush();
    host.push(ready("A"));
    await settle();

    assert.deepEqual(host.posted(), [["one", "c-q1"]], "the one on its way goes on, under its own id");
    assert.deepEqual(thread.getState().slice.queue.map((message) => message.text), ["two", "three"]);
    host.attempts[0]!.answer();
    await settle();
    assert.deepEqual(host.posted(), [
      ["one", "c-q1"],
      ["two", "c-q2"]
    ]);
  });

  it("holds a queued send whose re-post failed at the front, and the rest of the queue behind it", async () => {
    left([queuedLeft("q1", "one", { sentAt: NOW }), queuedLeft("q2", "two")]);
    const host = fakeHost();
    const thread = open("A", host);
    await flush();
    host.push(ready("A"));
    assert.deepEqual(host.posted(), [["one", "c-q1"]]);
    host.attempts[0]!.fail(new AgentChatCommandError(409, "COMMAND_REJECTED", "no"));
    await settle();

    assert.deepEqual(
      thread.getState().slice.queue.map((message) => [message.text, message.holdUntilUserAction]),
      [
        ["one", true],
        ["two", false]
      ]
    );
    assert.equal(host.attempts.length, 1, "nothing overtakes it");
    assert.notEqual(
      thread.getState().slice.queue[0]!.commandId,
      "c-q1",
      "its next send is the user's own new command — a refused id would only be refused again"
    );
  });

  it("holds a stale queued send at the front instead of re-posting it, the queue behind it", async () => {
    left([
      queuedLeft("q1", "one", { sentAt: NOW - OUTBOX_REPLAY_MAX_AGE_MS - 1 }),
      queuedLeft("q2", "two")
    ]);
    const host = fakeHost();
    const thread = open("A", host);
    await flush();
    host.push(ready("A"));
    await settle();

    assert.equal(host.attempts.length, 0);
    assert.deepEqual(
      thread.getState().slice.queue.map((message) => [message.text, message.holdUntilUserAction]),
      [
        ["one", true],
        ["two", false]
      ]
    );
    assert.match(thread.getState().slice.errorBanner ?? "", /reload/i, "the banner says why it waits");
  });

  it("ignores a stored value it cannot read, and still resumes every entry it can", async () => {
    session.set(COMPOSER_OUTBOX_KEY, "{not json");
    const host = fakeHost();
    const thread = open("A", host);
    await flush();
    assert.equal(host.attempts.length, 0);
    assert.deepEqual(thread.getState().slice.queue, []);

    left([
      { ...sendLeft({ sessionId: "B" }), commandId: 5 },
      { ...sendLeft({ sessionId: "B", commandId: "c2" }), turn: "deploy" },
      "junk",
      sendLeft({ sessionId: "B", commandId: "c3", turn: { input: "the readable one" } })
    ]);
    open("B", host);
    await flush();
    assert.deepEqual(host.posted(), [["the readable one", "c3"]]);
  });
});
