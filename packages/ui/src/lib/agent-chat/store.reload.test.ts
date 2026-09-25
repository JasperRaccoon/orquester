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

function open(
  sessionId: string,
  host: ReturnType<typeof fakeHost>,
  idPrefix = "id",
  clock: () => string = now
): ThreadStore {
  return createThreadStore(sessionId, {
    transport: host.transport,
    newId: ids(idPrefix),
    now: clock,
    delay: async () => {}
  });
}

/** A clock stopped at `ms`. */
const at = (ms: number) => (): string => new Date(ms).toISOString();
const MINUTE = 60_000;

/**
 * The page's lifecycle, as a browser drives it: the document hides and shows,
 * the window gets `pagehide`. Installed per test, removed after.
 */
function fakePage(): { hide(): void; hiddenWithoutEvent(): void; pagehide(): void } {
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const win = new EventTarget();
  (globalThis as unknown as { document: unknown }).document = doc;
  (globalThis as unknown as { window: unknown }).window = win;
  return {
    hide: () => {
      doc.visibilityState = "hidden";
      doc.dispatchEvent(new Event("visibilitychange"));
    },
    hiddenWithoutEvent: () => {
      doc.visibilityState = "hidden";
    },
    pagehide: () => void win.dispatchEvent(new Event("pagehide"))
  };
}

/**
 * The page a reload replaces: its store is the registry's, so the reload
 * below tears it down — nothing of it may act after, as nothing of a page
 * a browser reloaded does.
 */
function previousPage(
  sessionId: string,
  host: ReturnType<typeof fakeHost>,
  clock: () => string = now
): ThreadStore {
  return retainThreadStore(sessionId, {
    transport: host.transport,
    newId: ids("first-page-"),
    now: clock,
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
    delete (globalThis as unknown as { document?: unknown }).document;
    delete (globalThis as unknown as { window?: unknown }).window;
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
    const banner = thread.getState().slice.errorBanner ?? "";
    assert.match(banner, /reload/i, "it says the message dates from before the reload");
    assert.match(banner, /The thread is being rewound\./, "and why the host refused it");
    assert.equal(isComposerSending("A"), false);
    assert.equal(stored(), null);
    assert.deepEqual(host.turns, []);
  });

  it("tells the composer that shows the thread why a refused re-post is back — a message from before the reload", async () => {
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
      left([sendLeft({ turn: { input: "deploy the fix" } })]);
      const host = fakeHost();
      open("A", host);
      await flush();
      host.attempts[0]!.fail(new AgentChatCommandError(409, "COMMAND_REJECTED", "The thread is being rewound."));
      await settle();
      assert.equal(restored.length, 1);
      assert.match(restored[0]!.outcome.notice, /reload/i);
      assert.match(restored[0]!.outcome.notice, /The thread is being rewound\./);
    } finally {
      unregister();
    }
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

  /** A page that queued "one" and "two" behind a running turn, at `NOW` on its clock. */
  async function pageWithQueue(clock: () => string = now) {
    const before = fakeHost();
    const page = previousPage("A", before, clock);
    await flush();
    before.push(running("A"));
    page.getState().actions.queueMessage(queuedInput("one"));
    page.getState().actions.queueMessage(queuedInput("two"));
    return page.getState().slice.queue.map((message) => message.commandId);
  }

  const queueOf = (thread: ThreadStore) =>
    thread.getState().slice.queue.map((message) => [message.text, message.commandId, message.holdUntilUserAction]);

  it("brings back a queue its page showed less than ten minutes ago as it was, to go out by itself", async () => {
    const [one, two] = await pageWithQueue();
    reload();
    const host = fakeHost();
    const thread = open("A", host, "second-page-", at(NOW + 9 * MINUTE));
    await flush();
    assert.deepEqual(queueOf(thread), [
      ["one", one, false],
      ["two", two, false]
    ]);
    host.push(ready("A"));
    await settle();
    assert.deepEqual(host.posted(), [["one", one]], "an ordinary reload: the queue goes on as it would have");
  });

  it("holds a queue its page last showed more than ten minutes ago, in order, under its commandIds — nothing goes out by itself", async () => {
    const [one, two] = await pageWithQueue();
    reload();
    const host = fakeHost();
    const thread = open("A", host, "second-page-", at(NOW + 11 * MINUTE));
    await flush();
    assert.deepEqual(queueOf(thread), [
      ["one", one, true],
      ["two", two, true]
    ]);
    assert.match(thread.getState().slice.errorBanner ?? "", /Send now/, "the banner says why they wait");
    host.push(ready("A"));
    await settle();
    assert.equal(host.attempts.length, 0, "a stale message never posts on the thread's first frame");

    const sending = thread.getState().actions.sendQueuedNow(thread.getState().slice.queue[0]!.id);
    await settle();
    host.attempts[0]!.answer();
    await sending;
    assert.deepEqual(host.posted(), [["one", one]], "the user sends it, under the id it was queued with");
    await settle();
    assert.equal(host.attempts.length, 1, "and the next still waits for its own Send now");
  });

  it("measures that absence from when the page last showed the queue, never from when a message was queued", async () => {
    let pageNow = NOW;
    await pageWithQueue(() => new Date(pageNow).toISOString());
    // The page kept showing the queue behind a long turn for twenty minutes.
    pageNow = NOW + 20 * MINUTE;
    reload();
    const thread = open("A", fakeHost(), "second-page-", at(NOW + 21 * MINUTE));
    await flush();
    assert.deepEqual(
      thread.getState().slice.queue.map((message) => message.holdUntilUserAction),
      [false, false],
      "queued twenty-one minutes ago, but on screen a minute ago: still live"
    );
  });

  it("stamps the queue as last shown when the page is hidden", async () => {
    const page = fakePage();
    let pageNow = NOW;
    await pageWithQueue(() => new Date(pageNow).toISOString());
    pageNow = NOW + 20 * MINUTE;
    page.hide();
    pageNow = NOW + 40 * MINUTE;
    reload();
    const thread = open("A", fakeHost(), "second-page-", at(NOW + 25 * MINUTE));
    await flush();
    assert.deepEqual(
      thread.getState().slice.queue.map((message) => message.holdUntilUserAction),
      [false, false],
      "on screen until the page was hidden five minutes ago"
    );
  });

  it("does not move that stamp at a teardown while the page is hidden", async () => {
    const page = fakePage();
    let pageNow = NOW;
    await pageWithQueue(() => new Date(pageNow).toISOString());
    pageNow = NOW + MINUTE;
    page.hide();
    pageNow = NOW + 30 * MINUTE;
    reload();
    const thread = open("A", fakeHost(), "second-page-", at(NOW + 31 * MINUTE));
    await flush();
    assert.deepEqual(
      thread.getState().slice.queue.map((message) => message.holdUntilUserAction),
      [true, true],
      "hidden thirty minutes before the tab came back"
    );
  });

  it("stamps the queue as last shown on pagehide", async () => {
    const page = fakePage();
    let pageNow = NOW;
    await pageWithQueue(() => new Date(pageNow).toISOString());
    pageNow = NOW + 20 * MINUTE;
    page.pagehide();
    page.hiddenWithoutEvent();
    pageNow = NOW + 40 * MINUTE;
    reload();
    const thread = open("A", fakeHost(), "second-page-", at(NOW + 25 * MINUTE));
    await flush();
    assert.deepEqual(
      thread.getState().slice.queue.map((message) => message.holdUntilUserAction),
      [false, false],
      "on screen until the page went away five minutes ago"
    );
  });

  it("lets a queue kept in the page go on by itself when its thread comes back within ten minutes", async () => {
    const [one] = await pageWithQueue();
    // The thread's generation is gone and nothing is retained; the page is the same.
    resetThreadStores();
    const host = fakeHost();
    const thread = open("A", host, "next-", at(NOW + 9 * MINUTE));
    await flush();
    assert.deepEqual(thread.getState().slice.queue.map((message) => message.holdUntilUserAction), [false, false]);
    host.push(ready("A"));
    await settle();
    assert.deepEqual(host.posted(), [["one", one]]);
  });

  it("holds a queue kept in the page when its thread comes back more than ten minutes later", async () => {
    const [one, two] = await pageWithQueue();
    resetThreadStores();
    const host = fakeHost();
    const thread = open("A", host, "next-", at(NOW + 11 * MINUTE));
    await flush();
    assert.deepEqual(queueOf(thread), [
      ["one", one, true],
      ["two", two, true]
    ]);
    assert.match(thread.getState().slice.errorBanner ?? "", /Send now/);
    host.push(ready("A"));
    await settle();
    assert.equal(host.attempts.length, 0);
  });

  /** "first queued" on its way from a generation that is then torn down — retained or not. */
  async function queuedSendOutWhenTornDown(retain: boolean) {
    const host = fakeHost();
    const first = open("A", host, "first-");
    await flush();
    host.push(running("A"));
    first.getState().actions.queueMessage(queuedInput("first queued"));
    first.getState().actions.queueMessage(queuedInput("second queued"));
    host.push(ready("A"));
    await settle();
    assert.deepEqual(host.posted().map(([input]) => input), ["first queued"]);
    (first as ThreadStore & { destroy?: (options?: { retain?: boolean }) => void }).destroy?.({ retain });
    return host;
  }

  it("holds a queued send that fails with no live generation at the front of the kept queue, reason and all — the next generation shows it there", async () => {
    const host = await queuedSendOutWhenTornDown(true);
    host.attempts[0]!.fail(new AgentChatCommandError(409, "COMMAND_REJECTED", "no"));
    await settle();

    const next = open("A", host, "next-");
    await flush();
    assert.deepEqual(
      next.getState().slice.queue.map((message) => [message.text, message.holdUntilUserAction]),
      [
        ["first queued", true],
        ["second queued", false]
      ],
      "held ahead of the rest even though a snapshot was retained without it"
    );
    assert.equal(next.getState().slice.errorBanner, "no", "with the reason it waits");
    host.push(ready("A", 5));
    await settle();
    assert.equal(host.attempts.length, 1, "nothing overtakes it");
    assert.equal(persistedDraft("A"), undefined, "and it is not in the draft as well");
  });

  it("does the same when nothing was retained", async () => {
    const host = await queuedSendOutWhenTornDown(false);
    host.attempts[0]!.fail(new AgentChatCommandError(409, "COMMAND_REJECTED", "no"));
    await settle();
    const next = open("A", host, "next-");
    await flush();
    assert.deepEqual(
      next.getState().slice.queue.map((message) => [message.text, message.holdUntilUserAction]),
      [
        ["first queued", true],
        ["second queued", false]
      ]
    );
  });

  it("brings a message held before the reload back held, with the reason it waits", async () => {
    const before = fakeHost();
    const page = previousPage("A", before);
    await flush();
    before.push(running("A"));
    page.getState().actions.queueMessage(queuedInput("one"));
    page.getState().actions.queueMessage(queuedInput("two"));
    before.push(ready("A"));
    await settle();
    before.attempts[0]!.fail(new AgentChatCommandError(409, "COMMAND_REJECTED", "no"));
    await settle();
    assert.deepEqual(page.getState().slice.queue.map((message) => message.holdUntilUserAction), [true, false]);

    reload();
    const thread = open("A", fakeHost(), "second-page-");
    await flush();
    assert.deepEqual(
      thread.getState().slice.queue.map((message) => [message.text, message.holdUntilUserAction]),
      [
        ["one", true],
        ["two", false]
      ]
    );
    assert.equal(thread.getState().slice.errorBanner, "no");
  });

  it("re-posts a thread's in-flight leftovers one at a time, in the order they were posted — a composer send among them", async () => {
    left([
      queuedLeft("q2", "two", { sentAt: NOW - 2_000 }),
      sendLeft({ commandId: "c1", sentAt: NOW - 3_000, turn: { input: "one" } }),
      queuedLeft("q3", "three", { sentAt: NOW - 1_000 }),
      queuedLeft("q4", "four")
    ]);
    const host = fakeHost();
    const thread = open("A", host);
    await flush();
    host.push(ready("A"));
    await settle();
    assert.deepEqual(host.posted(), [["one", "c1"]], "the oldest post first, and nothing else yet");
    assert.equal(isComposerSending("A"), true);
    assert.deepEqual(thread.getState().slice.queue.map((message) => message.text), ["four"]);

    host.attempts[0]!.answer();
    await settle();
    assert.equal(isComposerSending("A"), false);
    assert.deepEqual(host.posted().map(([input]) => input), ["one", "two"]);
    host.attempts[1]!.answer();
    await settle();
    assert.deepEqual(host.posted().map(([input]) => input), ["one", "two", "three"]);
    host.attempts[2]!.answer();
    await settle();
    assert.deepEqual(
      host.posted().map(([input]) => input),
      ["one", "two", "three", "four"],
      "the waiting queue goes only once every one on its way has settled"
    );
  });

  it("holds the in-flight leftovers whose re-posts fail in the order they were posted, ahead of the rest", async () => {
    left([
      queuedLeft("q1", "one", { sentAt: NOW - 2_000 }),
      queuedLeft("q2", "two", { sentAt: NOW - 1_000 }),
      queuedLeft("q3", "three")
    ]);
    const host = fakeHost();
    const thread = open("A", host);
    await flush();
    host.push(ready("A"));
    await settle();
    host.attempts[0]!.fail(new AgentChatCommandError(409, "COMMAND_REJECTED", "no"));
    await settle();
    host.attempts[1]!.fail(new AgentChatCommandError(409, "COMMAND_REJECTED", "no"));
    await settle();
    assert.deepEqual(
      thread.getState().slice.queue.map((message) => [message.text, message.holdUntilUserAction]),
      [
        ["one", true],
        ["two", true],
        ["three", false]
      ]
    );
    assert.equal(host.attempts.length, 2);
  });

  const destroy = (thread: ThreadStore, retain = true): void =>
    (thread as ThreadStore & { destroy?: (options?: { retain?: boolean }) => void }).destroy?.({ retain });

  /** A tab storage that refuses every write while `full`. */
  function fillableSessionStorage(): { full(value: boolean): void } {
    let full = false;
    const base = storage(() => session);
    (globalThis as unknown as { sessionStorage: unknown }).sessionStorage = {
      ...base,
      getItem: base.getItem,
      removeItem: base.removeItem,
      setItem: (key: string, value: string) => {
        if (full) throw new Error("QuotaExceededError");
        session.set(key, value);
      }
    };
    return { full: (value) => void (full = value) };
  }

  it("stores the queue as it stands when its first microtask runs — a message held into it just before included", async () => {
    const host = fakeHost();
    const first = open("A", host, "first-");
    await flush();
    host.push(running("A"));
    first.getState().actions.queueMessage(queuedInput("one"));
    destroy(first, false);

    const next = retainThreadStore("A", { transport: host.transport, newId: ids("next-"), now, delay: async () => {} });
    // What a torn-down generation's failing queued send does to the live one
    // (`holdQueuedMessageInThread`) — landing before `next`'s creation microtask.
    (next as unknown as { holdQueuedAtFront(message: unknown, reason?: string): void }).holdQueuedAtFront(
      {
        id: "q-held",
        commandId: "c-held",
        text: "held",
        attachments: [],
        context: [],
        interactionMode: "default",
        queuedAfterToolActivityId: null,
        holdUntilUserAction: true,
        holdReason: "no",
        queuedAt: stamp(1)
      },
      "no"
    );
    await flush();

    reload();
    const after = open("A", fakeHost(), "after-");
    await flush();
    assert.deepEqual(
      after.getState().slice.queue.map((message) => [message.text, message.holdUntilUserAction]),
      [
        ["held", true],
        ["one", false]
      ]
    );
  });

  it("never holds a failed re-post behind a waiting message once the user has sent the one held before it", async () => {
    left([
      queuedLeft("q0", "stale", { sentAt: NOW - OUTBOX_REPLAY_MAX_AGE_MS - 1 }),
      queuedLeft("q1", "young", { sentAt: NOW }),
      queuedLeft("q2", "waiting")
    ]);
    const host = fakeHost();
    const thread = open("A", host);
    await flush();
    assert.deepEqual(thread.getState().slice.queue.map((message) => message.text), ["stale", "waiting"]);
    void thread.getState().actions.sendQueuedNow(thread.getState().slice.queue[0]!.id).catch(() => {});
    await settle();
    host.attempts[0]!.fail(new AgentChatCommandError(409, "COMMAND_REJECTED", "no"));
    await settle();
    assert.deepEqual(
      thread.getState().slice.queue.map((message) => [message.text, message.holdUntilUserAction]),
      [
        ["young", true],
        ["waiting", false]
      ]
    );
  });

  it("holds a failed re-post ahead of messages queued after it, even ones held because nobody saw them", async () => {
    const later = NOW + 11 * MINUTE;
    left([
      queuedLeft("q0", "stale", { sentAt: later - OUTBOX_REPLAY_MAX_AGE_MS - 1 }),
      queuedLeft("q1", "young", { sentAt: later - 1_000 }),
      queuedLeft("q2", "waiting")
    ]);
    const host = fakeHost();
    const thread = open("A", host, "id", at(later));
    await flush();
    assert.deepEqual(
      thread.getState().slice.queue.map((message) => [message.text, message.holdUntilUserAction]),
      [
        ["stale", true],
        ["waiting", true]
      ]
    );
    void thread.getState().actions.sendQueuedNow(thread.getState().slice.queue[0]!.id).catch(() => {});
    await settle();
    host.attempts[0]!.fail(new AgentChatCommandError(409, "COMMAND_REJECTED", "no"));
    await settle();
    assert.deepEqual(
      thread.getState().slice.queue.map((message) => message.text),
      ["young", "waiting"],
      "it was on its way before that one was queued"
    );
  });

  it("keeps the order of consecutive failures that land with no live generation", async () => {
    left([
      queuedLeft("q1", "first", { sentAt: NOW - 2_000 }),
      queuedLeft("q2", "second", { sentAt: NOW - 1_000 }),
      queuedLeft("q3", "waiting")
    ]);
    const host = fakeHost();
    const thread = open("A", host);
    await flush();
    destroy(thread);
    host.attempts[0]!.fail(new AgentChatCommandError(409, "COMMAND_REJECTED", "no"));
    await settle();
    host.attempts[1]!.fail(new AgentChatCommandError(409, "COMMAND_REJECTED", "no"));
    await settle();

    const next = open("A", host, "next-");
    await flush();
    assert.deepEqual(
      next.getState().slice.queue.map((message) => [message.text, message.holdUntilUserAction]),
      [
        ["first", true],
        ["second", true],
        ["waiting", false]
      ]
    );
  });

  it("never leaves a thread reading Sending when giving a refused re-post back throws — and still re-posts the rest", async () => {
    const unregister = registerComposerHandle("A", {
      insertText: () => {},
      stageAttachment: () => false,
      returnMessage: () => [],
      focusAtEnd: () => {},
      openControl: () => {},
      restoreFailedSend: () => {
        throw new Error("the composer could not take it");
      }
    });
    try {
      left([
        sendLeft({ commandId: "c1", sentAt: NOW - 2_000, turn: { input: "one" } }),
        sendLeft({ commandId: "c2", sentAt: NOW - 1_000, turn: { input: "two" } })
      ]);
      const host = fakeHost();
      open("A", host);
      await flush();
      host.attempts[0]!.fail(new AgentChatCommandError(409, "COMMAND_REJECTED", "no"));
      await settle();
      assert.deepEqual(host.posted(), [
        ["one", "c1"],
        ["two", "c2"]
      ]);
      host.attempts[1]!.answer();
      await settle();
      assert.equal(isComposerSending("A"), false);
    } finally {
      unregister();
    }
  });

  it("opens the thread's stream even when giving a stale send back throws: the outbox is a safety net, never a failure", async () => {
    const unregister = registerComposerHandle("A", {
      insertText: () => {},
      stageAttachment: () => false,
      returnMessage: () => [],
      focusAtEnd: () => {},
      openControl: () => {},
      restoreFailedSend: () => {
        throw new Error("the composer could not take it");
      }
    });
    const warned: unknown[][] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void warned.push(args);
    try {
      left([sendLeft({ sentAt: NOW - OUTBOX_REPLAY_MAX_AGE_MS - 1, turn: { input: "check first" } })]);
      const host = fakeHost();
      const thread = open("A", host);
      await flush();
      host.push(ready("A"));
      assert.equal(thread.getState().slice.head?.id, "A", "the stream opened, and its first frame landed");
      assert.equal(warned.length, 1, "the failure is said once, in the console");
    } finally {
      console.warn = warn;
      unregister();
    }
  });

  it("does not trust a kept queue whose last write failed: the retained snapshot has what came after", async () => {
    const storageFill = fillableSessionStorage();
    const host = fakeHost();
    const first = open("A", host, "first-");
    await flush();
    host.push(running("A"));
    first.getState().actions.queueMessage(queuedInput("one"));
    storageFill.full(true);
    first.getState().actions.queueMessage(queuedInput("two"));
    destroy(first);

    const next = open("A", host, "next-");
    await flush();
    assert.deepEqual(next.getState().slice.queue.map((message) => message.text), ["one", "two"]);
  });

  it("takes a held message only the kept queue has into the snapshot's queue after a failed write", async () => {
    const storageFill = fillableSessionStorage();
    const host = fakeHost();
    const first = open("A", host, "first-");
    await flush();
    host.push(running("A"));
    first.getState().actions.queueMessage(queuedInput("first"));
    host.push(ready("A"));
    await settle();
    assert.deepEqual(host.posted().map(([input]) => input), ["first"]);
    storageFill.full(true);
    first.getState().actions.queueMessage(queuedInput("second"));
    destroy(first);
    storageFill.full(false);
    host.attempts[0]!.fail(new AgentChatCommandError(409, "COMMAND_REJECTED", "no"));
    await settle();

    const next = open("A", host, "next-");
    await flush();
    assert.deepEqual(
      next.getState().slice.queue.map((message) => [message.text, message.holdUntilUserAction]),
      [
        ["first", true],
        ["second", false]
      ]
    );
  });

  it("repaints nothing on a warm remount whose queue is the one it retained", async () => {
    const host = fakeHost();
    const first = open("A", host, "first-");
    await flush();
    host.push(running("A"));
    first.getState().actions.queueMessage(queuedInput("one"));
    const rows = first.getState().rows;
    const message = first.getState().slice.queue[0];
    destroy(first);

    const next = open("A", host, "next-");
    assert.equal(next.getState().rows, rows, "the retained rows, not a projection of stored copies");
    assert.equal(next.getState().slice.queue[0], message);
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
