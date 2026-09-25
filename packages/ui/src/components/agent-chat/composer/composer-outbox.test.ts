/**
 * What a tab has on its way out survives a reload of that tab (§7.4): every
 * composer send still in flight and every queued message not yet delivered,
 * each with its `commandId`, kept in `sessionStorage` until it settles. The
 * page that wrote an entry owns it; what a previous page of the tab left is
 * handed, once, to the first thread store that asks for its thread.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { QueuedComposerMessage } from "../../../lib/agent-chat/contracts";
import {
  adoptOutboxLeftovers,
  COMPOSER_OUTBOX_KEY,
  holdOutboxQueuedAtFront,
  MAX_OUTBOX_ENTRIES,
  OUTBOX_QUEUE_ABSENCE_MAX_MS,
  outboxQueue,
  outboxQueueFresh,
  outboxQueueShownAt,
  parseComposerOutbox,
  recordOutboxQueuedPost,
  recordOutboxSend,
  removeOutboxEntry,
  resetComposerOutbox,
  stampOutboxQueueShown,
  writeOutboxQueue,
  type OutboxQueuedMessage
} from "./composer-outbox";

let backing = new Map<string, string>();

function installSessionStorage(): void {
  backing = new Map();
  (globalThis as unknown as { sessionStorage: unknown }).sessionStorage = {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => void backing.set(key, value),
    removeItem: (key: string) => void backing.delete(key),
    clear: () => backing.clear(),
    key: (index: number) => [...backing.keys()][index] ?? null,
    get length() {
      return backing.size;
    }
  };
}

const queued = (id: string, text: string, commandId = `c-${id}`): OutboxQueuedMessage => ({
  id,
  commandId,
  text,
  attachments: [],
  context: [],
  interactionMode: "default",
  queuedAfterToolActivityId: null,
  holdUntilUserAction: false,
  queuedAt: "2026-01-01T00:00:01.000Z"
});

/** A reload of this tab: the page forgets what it wrote, the storage stays. */
const reload = (): void => resetComposerOutbox();

/** One entry's shape, as the store reads it, without the page it came from. */
const summary = (entry: ReturnType<typeof adoptOutboxLeftovers>[number]): string =>
  entry.kind === "send"
    ? `send ${entry.commandId} "${entry.turn.input}"`
    : `queued ${entry.message.commandId} "${entry.message.text}"${entry.sentAt === undefined ? "" : " posted"}`;

describe("the composer outbox", () => {
  beforeEach(() => {
    installSessionStorage();
    resetComposerOutbox();
  });

  afterEach(() => {
    delete (globalThis as unknown as { sessionStorage?: unknown }).sessionStorage;
  });

  it("hands what this page is sending to the next page of the tab, once — never back to this page", () => {
    recordOutboxSend({ sessionId: "A", commandId: "c1", sentAt: 1_000, turn: { input: "deploy the fix" } });
    assert.deepEqual(adoptOutboxLeftovers("A"), [], "this page's own send is in flight here, not a leftover");

    reload();
    assert.deepEqual(adoptOutboxLeftovers("A").map(summary), ['send c1 "deploy the fix"']);
    assert.deepEqual(adoptOutboxLeftovers("A"), [], "the page that took it over owns it now");

    reload();
    assert.deepEqual(
      adoptOutboxLeftovers("A").map(summary),
      ['send c1 "deploy the fix"'],
      "still kept until it settles, so a second reload finds it again"
    );
  });

  it("hands a thread its own leftovers only, and leaves every other thread's for that thread", () => {
    recordOutboxSend({ sessionId: "A", commandId: "c1", sentAt: 1_000, turn: { input: "to A" } });
    recordOutboxSend({ sessionId: "B", commandId: "c2", sentAt: 1_000, turn: { input: "to B" } });
    reload();
    assert.deepEqual(adoptOutboxLeftovers("A").map(summary), ['send c1 "to A"']);
    assert.deepEqual(adoptOutboxLeftovers("B").map(summary), ['send c2 "to B"']);
  });

  it("forgets an entry once it settles, for this page and the next", () => {
    recordOutboxSend({ sessionId: "A", commandId: "c1", sentAt: 1_000, turn: { input: "landed" } });
    recordOutboxSend({ sessionId: "A", commandId: "c2", sentAt: 1_000, turn: { input: "still going" } });
    removeOutboxEntry("c1");
    reload();
    assert.deepEqual(adoptOutboxLeftovers("A").map(summary), ['send c2 "still going"']);
    removeOutboxEntry("c2");
    assert.equal(backing.has(COMPOSER_OUTBOX_KEY), false, "nothing left, nothing stored");
  });

  it("forgets a settled entry even while it is still stored under the page that left it", () => {
    // The adoption's rewrite of the entry did not land (a full storage): the
    // settle must forget it anyway, or every later generation re-posts it.
    recordOutboxSend({ sessionId: "A", commandId: "c1", sentAt: 1_000, turn: { input: "landed" } });
    reload();
    removeOutboxEntry("c1");
    assert.equal(backing.has(COMPOSER_OUTBOX_KEY), false);
  });

  it("writes a queue over any stored copy of its messages, whichever page stored it", () => {
    writeOutboxQueue("A", [queued("q1", "one")]);
    reload();
    // This page holds the message now, but its adoption never reached the storage.
    writeOutboxQueue("A", [queued("q1", "one"), queued("q2", "two")]);
    assert.deepEqual(outboxQueue("A").map((message) => message.text), ["one", "two"]);
    reload();
    assert.deepEqual(adoptOutboxLeftovers("A").map(summary), ['queued c-q1 "one"', 'queued c-q2 "two"']);
  });

  it("mirrors a thread's queue in order, keeping the send in flight and every other thread's queue", () => {
    writeOutboxQueue("A", [queued("q1", "one"), queued("q2", "two"), queued("q3", "three")]);
    writeOutboxQueue("B", [queued("qb", "b's")]);
    // The head goes out: marked as posted BEFORE the queue drops it.
    recordOutboxQueuedPost("A", queued("q1", "one"), 5_000);
    writeOutboxQueue("A", [queued("q2", "two"), queued("q3", "three")]);

    assert.deepEqual(
      outboxQueue("A").map((message) => message.text),
      ["two", "three"],
      "this page's queue of the thread: what is still waiting, in order"
    );

    reload();
    assert.deepEqual(adoptOutboxLeftovers("A").map(summary), [
      'queued c-q1 "one" posted',
      'queued c-q2 "two"',
      'queued c-q3 "three"'
    ]);
    assert.deepEqual(adoptOutboxLeftovers("B").map(summary), ['queued c-qb "b\'s"']);
  });

  it("gives a cold generation of this page the thread's queue, and a next page none of it until adopted", () => {
    writeOutboxQueue("A", [queued("q1", "one"), queued("q2", "two")]);
    assert.deepEqual(outboxQueue("A").map((message) => message.commandId), ["c-q1", "c-q2"]);
    reload();
    assert.deepEqual(outboxQueue("A"), [], "a previous page's queue is a leftover, not this page's queue");
    adoptOutboxLeftovers("A");
    assert.deepEqual(outboxQueue("A").map((message) => message.text), ["one", "two"]);
  });

  it("never drops a send in flight to stay under the cap — only messages still waiting, oldest first", () => {
    recordOutboxSend({ sessionId: "A", commandId: "on-its-way", sentAt: 1_000, turn: { input: "sent" } });
    writeOutboxQueue("B", [queued("posted", "queued, on its way")]);
    recordOutboxQueuedPost("B", queued("posted", "queued, on its way"), 2_000);
    const waiting = Array.from({ length: MAX_OUTBOX_ENTRIES }, (_, index) => queued(`w${index + 1}`, `w${index + 1}`));
    writeOutboxQueue("C", waiting);

    assert.deepEqual(
      outboxQueue("C").map((message) => message.text).slice(0, 2),
      ["w3", "w4"],
      "the two oldest waiting messages made room"
    );
    assert.equal(outboxQueue("C").length, MAX_OUTBOX_ENTRIES - 2);
    reload();
    assert.deepEqual(adoptOutboxLeftovers("A").map(summary), ['send on-its-way "sent"']);
    assert.deepEqual(adoptOutboxLeftovers("B").map(summary), ['queued c-posted "queued, on its way" posted']);
  });

  it("holds a message at the front of a thread's kept queue, reason and all, and says whether it could", () => {
    writeOutboxQueue("A", [queued("q2", "two"), queued("q3", "three")]);
    const held = { ...queued("q1", "one"), holdUntilUserAction: true, holdReason: "The agent host is restarting." };
    assert.equal(holdOutboxQueuedAtFront("A", held), true);
    assert.deepEqual(
      outboxQueue("A").map((message) => [message.text, message.holdUntilUserAction, message.holdReason]),
      [
        ["one", true, "The agent host is restarting."],
        ["two", false, undefined],
        ["three", false, undefined]
      ]
    );

    delete (globalThis as unknown as { sessionStorage?: unknown }).sessionStorage;
    assert.equal(holdOutboxQueuedAtFront("A", held), false, "no tab storage: the caller keeps it elsewhere");
  });

  it("keeps a thread's last-shown stamp while it has queued messages, and forgets it with them", () => {
    stampOutboxQueueShown("A", 5_000);
    assert.equal(outboxQueueShownAt("A"), null, "no queue, nothing to stamp");

    writeOutboxQueue("A", [queued("q1", "one")]);
    stampOutboxQueueShown("A", 6_000);
    assert.equal(outboxQueueShownAt("A"), 6_000);
    reload();
    assert.equal(outboxQueueShownAt("A"), 6_000, "the next page reads what this one stamped");

    adoptOutboxLeftovers("A");
    writeOutboxQueue("A", []);
    assert.equal(outboxQueueShownAt("A"), null, "the queue is gone, and its stamp with it");
  });

  it("is fresh while the later of the queue's last showing and the message's queueing is within the bound", () => {
    const queuedAt = new Date(10_000).toISOString();
    const bound = OUTBOX_QUEUE_ABSENCE_MAX_MS;
    assert.equal(outboxQueueFresh({ shownAt: 20_000, queuedAt, now: 20_000 + bound }), true, "at the bound");
    assert.equal(outboxQueueFresh({ shownAt: 20_000, queuedAt, now: 20_000 + bound + 1 }), false);
    assert.equal(
      outboxQueueFresh({ shownAt: null, queuedAt, now: 10_000 + bound }),
      true,
      "never stamped: queued in plain sight, so its queueing counts"
    );
    assert.equal(outboxQueueFresh({ shownAt: 5_000, queuedAt, now: 10_000 + bound }), true, "the later of the two");
    assert.equal(outboxQueueFresh({ shownAt: null, queuedAt: "", now: 10_000 }), false, "nothing to measure from");
    assert.equal(outboxQueueFresh({ shownAt: 20_000, queuedAt, now: 19_000 }), false, "a clock that ran backwards");
  });

  it("keeps every send in flight even past the cap: the bound only ever drops a waiting message", () => {
    for (let index = 0; index <= MAX_OUTBOX_ENTRIES; index += 1) {
      recordOutboxSend({ sessionId: "A", commandId: `c${index}`, sentAt: 1_000, turn: { input: `m${index}` } });
    }
    reload();
    const kept = adoptOutboxLeftovers("A");
    assert.equal(kept.length, MAX_OUTBOX_ENTRIES + 1);
    assert.equal(summary(kept[0]!), 'send c0 "m0"');
  });

  describe("loads field-wise, with a fallback (AGENTS.md: an old bundle's payload outlives a deploy)", () => {
    const send = {
      kind: "send",
      pageId: "previous",
      sessionId: "A",
      commandId: "c1",
      sentAt: 1_000,
      turn: { input: "deploy the fix" }
    };
    const queuedEntry = {
      kind: "queued",
      pageId: "previous",
      sessionId: "A",
      message: queued("q1", "later")
    };
    const parse = (entries: unknown[]) => parseComposerOutbox(JSON.stringify({ v: 1, entries }));

    it("reads nothing out of a value that is not a v1 outbox", () => {
      for (const raw of [null, "", "{nope", "[]", "42", '{"v":2,"entries":[]}', '{"v":1}', '{"v":1,"entries":{}}']) {
        assert.deepEqual(parseComposerOutbox(raw), [], `${raw}`);
      }
    });

    it("keeps the entries it can read, and drops each one it cannot", () => {
      const entries = parse([
        send,
        "a string",
        null,
        { ...send, kind: "draft" },
        { ...send, commandId: "" },
        { ...send, commandId: 7 },
        { ...send, sessionId: undefined },
        { ...send, pageId: 3 },
        { ...send, sentAt: "yesterday" },
        { ...send, sentAt: Number.NaN },
        { ...send, turn: { input: 12 } },
        { ...send, turn: null },
        { ...queuedEntry, message: { ...queued("q9", "x"), text: undefined } },
        { ...queuedEntry, message: { ...queued("q9", "x"), id: "" } },
        { ...queuedEntry, message: { ...queued("q9", "x"), commandId: null } },
        { ...queuedEntry, sentAt: "soon" },
        queuedEntry
      ]);
      assert.deepEqual(
        entries.map((entry) => (entry.kind === "send" ? entry.commandId : entry.message.id)),
        ["c1", "q1"]
      );
    });

    it("drops a malformed optional field, never the message it belongs to", () => {
      const [entry] = parse([
        {
          ...send,
          turn: {
            input: "deploy the fix",
            attachments: [
              { type: "file", id: "f1", name: "notes.txt", sizeBytes: 12 },
              { type: "file", id: 5 },
              "junk"
            ],
            context: [{ kind: "file", label: "a.ts", ref: "/w/p/a.ts" }, { kind: 1 }],
            interactionMode: "turbo",
            modelSelection: { model: 7 }
          },
          generatedPrompt: "yes"
        }
      ]);
      assert.equal(entry?.kind, "send");
      if (entry?.kind !== "send") return;
      assert.deepEqual(entry.turn, {
        input: "deploy the fix",
        attachments: [{ type: "file", id: "f1", name: "notes.txt", sizeBytes: 12 }],
        context: [{ kind: "file", label: "a.ts", ref: "/w/p/a.ts" }]
      });
      assert.equal(entry.generatedPrompt, undefined);

      const [message] = parse([
        {
          ...queuedEntry,
          message: {
            ...queued("q1", "later"),
            attachments: [{ type: "image" }],
            context: "none",
            interactionMode: 3,
            queuedAfterToolActivityId: 9,
            holdUntilUserAction: "yes",
            queuedAt: 12
          }
        }
      ]);
      assert.equal(message?.kind, "queued");
      if (message?.kind !== "queued") return;
      assert.deepEqual(message.message, {
        id: "q1",
        commandId: "c-q1",
        text: "later",
        attachments: [],
        context: [],
        interactionMode: "default",
        queuedAfterToolActivityId: null,
        holdUntilUserAction: false,
        queuedAt: ""
      } satisfies QueuedComposerMessage);
    });

    it("keeps a model selection and a plan-mode turn it can read", () => {
      const [entry] = parse([
        {
          ...send,
          turn: {
            input: "plan it",
            interactionMode: "plan",
            modelSelection: { model: "sonnet", instanceId: "claude", options: [{ id: "effort", value: "high" }, { id: 1 }] }
          },
          generatedPrompt: true
        }
      ]);
      assert.equal(entry?.kind, "send");
      if (entry?.kind !== "send") return;
      assert.deepEqual(entry.turn, {
        input: "plan it",
        interactionMode: "plan",
        modelSelection: { model: "sonnet", instanceId: "claude", options: [{ id: "effort", value: "high" }] }
      });
      assert.equal(entry.generatedPrompt, true);
    });

    it("reads a held message's reason, and the last-shown stamps, field-wise", () => {
      const raw = JSON.stringify({
        v: 1,
        entries: [
          { ...queuedEntry, message: { ...queued("q1", "held"), holdUntilUserAction: true, holdReason: "no" } },
          { ...queuedEntry, sessionId: "B", message: { ...queued("q2", "x"), holdReason: 42 } },
          { ...queuedEntry, sessionId: "C", message: queued("q3", "y") },
          { ...queuedEntry, sessionId: "D", message: queued("q4", "z") }
        ],
        shown: { A: 7_000, B: "yesterday", C: null, "": 5 }
      });
      const entries = parseComposerOutbox(raw);
      assert.deepEqual(
        entries.map((entry) => (entry.kind === "queued" ? entry.message.holdReason : "?")),
        ["no", undefined, undefined, undefined]
      );
      backing.set(COMPOSER_OUTBOX_KEY, raw);
      assert.deepEqual(
        ["A", "B", "C", "D"].map((sessionId) => outboxQueueShownAt(sessionId)),
        [7_000, null, null, null]
      );
      backing.set(COMPOSER_OUTBOX_KEY, JSON.stringify({ v: 1, entries: [queuedEntry], shown: [1, 2] }));
      assert.equal(outboxQueueShownAt("A"), null, "a stamp map that is not one reads as none");
      assert.equal(parseComposerOutbox(backing.get(COMPOSER_OUTBOX_KEY)!).length, 1, "and costs no entry");
    });

    it("keeps the first of two entries under one commandId", () => {
      const entries = parse([send, { ...send, turn: { input: "a copy" } }]);
      assert.deepEqual(
        entries.map((entry) => (entry.kind === "send" ? entry.turn.input : "")),
        ["deploy the fix"]
      );
    });
  });
});
