/**
 * An assistant message's phase (§7.3 `messageKind`) is read from `data.phase`
 * on every path, never guessed from `detail` (final fix wave D3).
 *
 * `detail` means two things on an `assistant_message`. Codex's LIVE normaliser
 * mirrors the phase into it next to `data.phase` (`adapters/codex/items.ts`);
 * every history row, and OpenCode's live completion, carry the message TEXT in
 * it (`adapters/codex/history.ts`, `adapters/opencode/normalize.ts`). Reading
 * the phase from `detail` therefore filed a resumed Codex thread's commentary
 * as its answer, and demoted — then swallowed as a marker — a reply whose whole
 * text happened to be "commentary" or "final_answer".
 *
 * A message also keeps the kind of the item that OPENED it, so an item that
 * never completes must not lend its message to the next one (final fix wave
 * D4): Codex abandons an `agentMessage` mid-stream when the upstream stream is
 * cut and silently re-samples, and the re-sample's text — the final answer,
 * possibly — used to be glued onto the abandoned commentary and filed as
 * commentary with it.
 *
 * Everything is asserted on the REAL fold, because that is what the timeline
 * and the MCP's `lastReply` read. Nothing here sleeps: every test waits on
 * `drain()`.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";

import {
  HISTORICAL_RAW_SOURCE,
  applyDomainEvent,
  createEmptyThreadState,
  type DomainEvent,
  type RuntimeEvent,
  type ThreadMessageItem
} from "@orquester/api/agent-chat";

import { projectCodexHistory } from "../adapters/codex/history.ts";
import { CodexNormaliser } from "../adapters/codex/normalise.ts";
import { CodexUsageTracker } from "../adapters/codex/usage.ts";
import type { AppendableDomainEvent } from "../services.ts";
import { createIngestion } from "./index.ts";
import {
  FakeClock,
  FakeTimers,
  RecordingLiveness,
  RecordingSink,
  counterIdGen
} from "./test-harness.ts";

const THREAD_ID = "t1";
const CREATED_AT = "2026-09-21T10:00:00.000Z";

let eventCounter = 0;

/** One event as a live adapter delivers it. */
function live<TType extends RuntimeEvent["type"]>(
  type: TType,
  payload: Extract<RuntimeEvent, { type: TType }>["payload"],
  overrides: Partial<Omit<RuntimeEvent, "type" | "payload">> = {}
): RuntimeEvent {
  return {
    eventId: `pe${++eventCounter}`,
    threadId: THREAD_ID,
    createdAt: CREATED_AT,
    ...overrides,
    type,
    payload
  } as RuntimeEvent;
}

/**
 * The same, tagged the way every `projectHistory` tags a replayed row. Built
 * here rather than delegating to `live`: re-forwarding the generic collapses
 * the payload's type to `never`.
 */
function historical<TType extends RuntimeEvent["type"]>(
  type: TType,
  payload: Extract<RuntimeEvent, { type: TType }>["payload"],
  overrides: Partial<Omit<RuntimeEvent, "type" | "payload">> = {}
): RuntimeEvent {
  return {
    eventId: `pe${++eventCounter}`,
    threadId: THREAD_ID,
    createdAt: CREATED_AT,
    ...overrides,
    raw: { source: HISTORICAL_RAW_SOURCE, payload: null },
    type,
    payload
  } as RuntimeEvent;
}

/** Stamp an adapter draft into a runtime event, as the session does. */
function stamped(draft: object): RuntimeEvent {
  return {
    eventId: `pe${++eventCounter}`,
    threadId: THREAD_ID,
    createdAt: CREATED_AT,
    ...draft
  } as RuntimeEvent;
}

async function ingestAll(events: readonly RuntimeEvent[]): Promise<AppendableDomainEvent[]> {
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const sink = new RecordingSink();
  const ingestion = createIngestion({
    sink: sink.sink,
    liveness: new RecordingLiveness(),
    clock,
    idGen: counterIdGen(),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    slim: (payload) => payload
  });
  for (const event of events) {
    await ingestion.ingest(event);
  }
  await ingestion.drain();
  return sink.events();
}

/**
 * Stamp sequences the way the store does and fold. `thread.created` is the
 * host's, not ingestion's, so it is prepended here.
 */
function foldMessages(events: readonly AppendableDomainEvent[]): Map<string, ThreadMessageItem> {
  const created: DomainEvent = {
    seq: 1,
    eventId: "created",
    threadId: THREAD_ID,
    occurredAt: "2026-09-21T09:59:00.000Z",
    commandId: null,
    causationEventId: null,
    metadata: {},
    type: "thread.created",
    payload: {
      projectPath: "/w/p",
      cwd: "/w/p",
      title: "New thread",
      adapter: "codex",
      refId: "codex",
      accountId: "acc1",
      home: "system",
      modelSelection: { model: "gpt-5.5" },
      runtimeMode: "approval-required"
    }
  };
  let state = applyDomainEvent(createEmptyThreadState(), created);
  let seq = 1;
  for (const event of events) {
    seq += 1;
    state = applyDomainEvent(state, { ...event, seq } as DomainEvent);
  }
  const messages = state.items.filter(
    (item): item is ThreadMessageItem => item.kind === "message"
  );
  return new Map(messages.map((message) => [message.id, message]));
}

/** What the user sees of one message: its text and which kind of bubble. */
function seen(
  message: ThreadMessageItem | undefined
): { text: string; messageKind: string | undefined } | undefined {
  return message === undefined
    ? undefined
    : { text: message.text, messageKind: message.messageKind };
}

/**
 * What the MCP's `lastReply` / `send_message.reply` return for a turn:
 * `assistantTextForTurn` (`apps/daemon/src/mcp/views.ts`) joins the turn's own
 * assistant messages — no subagent's, no commentary — in timeline order.
 * Mirrored rather than imported: that module pulls in the daemon's
 * agent-chat service, which the host's tests have no business loading.
 */
function answerText(messages: Iterable<ThreadMessageItem>, turnId: string): string {
  return [...messages]
    .filter(
      (message) =>
        message.role === "assistant" &&
        message.turnId === turnId &&
        !message.agentId &&
        message.messageKind !== "commentary"
    )
    .map((message) => message.text)
    .filter(Boolean)
    .join("\n\n");
}

/**
 * A Codex `agentMessage`: complete, as `thread/turns/list` returns it, or as
 * the live `item/*` notifications carry it (`text` empty on `item/started`).
 */
function agentMessage(id: string, text: string, phase: "commentary" | "final_answer") {
  return { type: "agentMessage", id, text, phase, memoryCitation: null, delivery: null, questions: null };
}

/** Server notifications through a fresh, REAL Codex normaliser, stamped as the session stamps them. */
function throughCodexNormaliser(
  notifications: readonly { method: string; params: unknown }[]
): RuntimeEvent[] {
  const normaliser = new CodexNormaliser({ usage: new CodexUsageTracker() });
  return notifications.flatMap(({ method, params }) =>
    normaliser.notification(method as never, params).map(stamped)
  );
}

/** A `turn/started` / `turn/completed` turn object, shaped as fixture 05 records it. */
function codexTurn(id: string, status: "inProgress" | "completed") {
  const settled = status === "completed";
  return {
    id,
    items: [],
    itemsView: "notLoaded",
    status,
    error: null,
    startedAt: 1789961264,
    completedAt: settled ? 1789961294 : null,
    durationMs: settled ? 29575 : null
  };
}

// ---------------------------------------------------------------------------
// (a) Codex history: the phase comes from `data.phase`, `detail` is the text
// ---------------------------------------------------------------------------

describe("(a) a resumed Codex thread reads the phase from data.phase", () => {
  it("files commentary as commentary and the answer as the answer, both texts intact", async () => {
    const drafts = projectCodexHistory({
      threadId: THREAD_ID,
      turns: [
        {
          id: "turn-1",
          items: [
            agentMessage("a1", "I'll read the config first.", "commentary"),
            agentMessage("a2", "It listens on port 8080.", "final_answer")
          ]
        }
      ]
    });
    const events = drafts.map(stamped);
    // The ambiguous shape itself: the TEXT in `detail`, the phase in `data`.
    assert.deepEqual(
      events.flatMap((event) =>
        event.type === "item.completed" && event.payload.itemType === "assistant_message"
          ? [{ detail: event.payload.detail, data: event.payload.data }]
          : []
      ),
      [
        { detail: "I'll read the config first.", data: { phase: "commentary" } },
        { detail: "It listens on port 8080.", data: { phase: "final_answer" } }
      ]
    );

    const messages = foldMessages(await ingestAll(events));
    assert.deepEqual(seen(messages.get("assistant:a1")), {
      text: "I'll read the config first.",
      messageKind: "commentary"
    });
    assert.deepEqual(seen(messages.get("assistant:a2")), {
      text: "It listens on port 8080.",
      messageKind: "answer"
    });
  });

  it("reads the same shape on the LIVE completion path the same way", async () => {
    // No live adapter sends the history shape today; this pins that the live
    // path reads `data.phase` too, and that a `detail` which does not mirror
    // the phase is the message's text there as well.
    const messages = foldMessages(
      await ingestAll([
        live(
          "item.completed",
          {
            itemType: "assistant_message",
            detail: "I'll read the config first.",
            data: { phase: "commentary" }
          },
          { turnId: "turn-1", itemId: "a1" }
        )
      ])
    );
    assert.deepEqual(seen(messages.get("assistant:a1")), {
      text: "I'll read the config first.",
      messageKind: "commentary"
    });
  });

  it("never drops a replayed message whose whole text is its own phase word", async () => {
    // On a replayed row `detail` IS the text, even when it spells the phase.
    // The live stream keeps the same message (its text arrives as deltas), so
    // treating it as a marker here would lose it from the resumed thread only.
    const drafts = projectCodexHistory({
      threadId: THREAD_ID,
      turns: [
        {
          id: "turn-1",
          items: [
            agentMessage("a1", "commentary", "commentary"),
            agentMessage("a2", "final_answer", "final_answer")
          ]
        }
      ]
    });
    const messages = foldMessages(await ingestAll(drafts.map(stamped)));
    assert.deepEqual(seen(messages.get("assistant:a1")), {
      text: "commentary",
      messageKind: "commentary"
    });
    assert.deepEqual(seen(messages.get("assistant:a2")), {
      text: "final_answer",
      messageKind: "answer"
    });
  });
});

// ---------------------------------------------------------------------------
// (b) No `data.phase`: `detail` is text, whatever it says
// ---------------------------------------------------------------------------

describe("(b) a reply whose whole text is a phase word, with no data.phase, is an answer", () => {
  for (const text of ["commentary", "Final_Answer"]) {
    it(`live, streamed then completed (OpenCode's shape): ${JSON.stringify(text)}`, async () => {
      const turn = { turnId: "turn-1", itemId: "part-1" };
      const messages = foldMessages(
        await ingestAll([
          live("content.delta", { streamKind: "assistant_text", delta: text }, turn),
          // `adapters/opencode/normalize.ts`: the completion repeats the text.
          live(
            "item.completed",
            {
              itemType: "assistant_message",
              status: "completed",
              title: "Assistant message",
              detail: text
            },
            turn
          )
        ])
      );
      assert.deepEqual(seen(messages.get("assistant:part-1")), { text, messageKind: "answer" });
    });

    it(`live, a completion standing in for deltas that never came: ${JSON.stringify(text)}`, async () => {
      const messages = foldMessages(
        await ingestAll([
          live(
            "item.completed",
            {
              itemType: "assistant_message",
              status: "completed",
              title: "Assistant message",
              detail: text
            },
            { turnId: "turn-1", itemId: "part-1" }
          )
        ])
      );
      assert.deepEqual(seen(messages.get("assistant:part-1")), { text, messageKind: "answer" });
    });

    it(`history (Grok's and OpenCode's shape): ${JSON.stringify(text)}`, async () => {
      const messages = foldMessages(
        await ingestAll([
          historical("turn.started", {}, { turnId: "turn-1" }),
          historical(
            "item.completed",
            { itemType: "assistant_message", status: "completed", detail: text },
            { turnId: "turn-1", itemId: "a1" }
          ),
          historical("turn.completed", { state: "completed" }, { turnId: "turn-1" })
        ])
      );
      assert.deepEqual(seen(messages.get("assistant:a1")), { text, messageKind: "answer" });
    });
  }
});

// ---------------------------------------------------------------------------
// (c) Codex live, the phase in BOTH fields: unchanged, on the real captures
// ---------------------------------------------------------------------------

const CODEX_FIXTURES = new URL("../../../test/fixtures/codex/", import.meta.url);

/**
 * Feed a capture's server notifications through the REAL Codex normaliser, as
 * the transport delivers them, and read what the capture itself says about
 * each `agentMessage` — its phase, the whole text its `item/completed`
 * carries, and the deltas it streamed — as the expectation.
 */
function replayCodexCapture(name: string): {
  events: RuntimeEvent[];
  phases: Map<string, string | null>;
  completedTexts: Map<string, string>;
  streamedTexts: Map<string, string>;
} {
  const normaliser = new CodexNormaliser({ usage: new CodexUsageTracker() });
  const events: RuntimeEvent[] = [];
  const phases = new Map<string, string | null>();
  const completedTexts = new Map<string, string>();
  const streamedTexts = new Map<string, string>();
  for (const line of readFileSync(new URL(name, CODEX_FIXTURES), "utf8").split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    const entry = JSON.parse(line) as { dir: string; frame: unknown };
    if (entry.dir !== "recv" || typeof entry.frame !== "object" || entry.frame === null) {
      continue;
    }
    const frame = entry.frame as { id?: unknown; method?: unknown; params?: unknown };
    // Notifications only: a frame with an id is a request (the session's to
    // answer) or a response.
    if (typeof frame.method !== "string" || (frame.id !== undefined && frame.id !== null)) {
      continue;
    }
    if (frame.method === "item/started" || frame.method === "item/completed") {
      const { item } = frame.params as {
        item: { type: string; id: string; phase?: string | null; text?: string };
      };
      if (item.type === "agentMessage") {
        phases.set(item.id, item.phase ?? null);
        if (frame.method === "item/completed") {
          completedTexts.set(item.id, item.text ?? "");
        }
      }
    }
    if (frame.method === "item/agentMessage/delta") {
      const { itemId, delta } = frame.params as { itemId: string; delta: string };
      streamedTexts.set(itemId, `${streamedTexts.get(itemId) ?? ""}${delta}`);
    }
    for (const draft of normaliser.notification(frame.method as never, frame.params)) {
      events.push(stamped(draft));
    }
  }
  return { events, phases, completedTexts, streamedTexts };
}

describe("(c) Codex live items carry the phase in detail AND data.phase: unchanged", () => {
  it("04: the commentary narration and the answer, exactly as recorded", async () => {
    const { events } = replayCodexCapture("04-file-change-approval.ndjson");
    const messages = foldMessages(await ingestAll(events));
    assert.deepEqual(
      seen(messages.get("assistant:msg_08cb0c44904aa080016ab08b6508b487d288518aedf654caab")),
      {
        text: "I’ll create `fixture.txt` directly with the requested exact content.",
        messageKind: "commentary"
      }
    );
    assert.deepEqual(
      seen(messages.get("assistant:msg_08cb0c44904aa080016ab08b686ff887d2a81babe29aeae0e7")),
      { text: "Created `fixture.txt` containing exactly `banana`.", messageKind: "answer" }
    );
  });

  it("every capture: each assistant bubble is ONE recorded agentMessage, of its phase, with its own text", async () => {
    const names = readdirSync(CODEX_FIXTURES)
      .filter((name) => name.endsWith(".ndjson"))
      .sort();
    const checked = { commentary: 0, answer: 0 };
    for (const name of names) {
      const { events, phases, completedTexts, streamedTexts } = replayCodexCapture(name);
      const bubbles = foldMessages(await ingestAll(events));
      for (const bubble of bubbles.values()) {
        if (bubble.role !== "assistant") {
          continue;
        }
        const itemId = bubble.id.replace(/^assistant:/, "");
        // A phase marker never becomes a bubble of its own.
        assert.ok(phases.has(itemId), `${name}: ${bubble.id} is not a recorded agentMessage`);
        const expected = phases.get(itemId) === "commentary" ? "commentary" : "answer";
        assert.equal(bubble.messageKind, expected, `${name} ${bubble.id}`);
        // …and never becomes its text — nor does another item's (D4). A
        // completed item reads exactly what its `item/completed` recorded; the
        // one item the corpus abandons (05) reads exactly the deltas it
        // streamed before its re-sample opened a bubble of its own.
        assert.equal(
          bubble.text,
          completedTexts.get(itemId) ?? streamedTexts.get(itemId),
          `${name} ${bubble.id}`
        );
        checked[expected] += 1;
      }
      // Every agentMessage that said anything has a bubble: none of them
      // vanished into another's.
      for (const [itemId, text] of [...streamedTexts, ...completedTexts]) {
        if (text.trim().length > 0) {
          assert.ok(bubbles.has(`assistant:${itemId}`), `${name}: ${itemId} has no bubble`);
        }
      }
    }
    // The corpus really exercises both phases. 14 commentary bubbles where D3
    // counted 13: 05's abandoned agentMessage (…0bfd06c10b98) and its re-sample
    // (…2840b954d7ce) are two bubbles now — the re-sample used to be glued onto
    // the abandoned one and was never counted on its own.
    assert.deepEqual(checked, { commentary: 14, answer: 18 });
  });
});

// ---------------------------------------------------------------------------
// (D4) An abandoned assistant message is closed before the next one starts
// ---------------------------------------------------------------------------

/** An `agentMessage` phase exactly as Codex's live normaliser reports it: in `detail` AND in `data.phase`. */
function codexLive(phase: "commentary" | "final_answer"): { detail: string; data: unknown } {
  return { detail: phase, data: { phase, delivery: null, questions: null } };
}

/** Every `thread.message-sent` of one message, in log order: its deltas and its close. */
function messageRows(
  events: readonly AppendableDomainEvent[],
  messageId: string
): { index: number; streaming: boolean; text: string }[] {
  return events.flatMap((event, index) =>
    event.type === "thread.message-sent" && event.payload.messageId === messageId
      ? [{ index, streaming: event.payload.streaming, text: event.payload.text }]
      : []
  );
}

describe("(D4) a live assistant item.started closes the abandoned message of its turn and owner", () => {
  it("(a) abandoned commentary, then the final answer: two messages, and lastReply reads the answer alone", async () => {
    const at = { threadId: "codex-thread", turnId: "turn-1" };
    const fragment = "I'll keep the plan self-contained and mark the one repo-derived";
    const answer = "LICENSE is MIT, held by the project authors.";
    const events = throughCodexNormaliser([
      { method: "turn/started", params: { threadId: at.threadId, turn: codexTurn("turn-1", "inProgress") } },
      { method: "item/started", params: { ...at, startedAtMs: 1, item: agentMessage("msg-a", "", "commentary") } },
      { method: "item/agentMessage/delta", params: { ...at, itemId: "msg-a", delta: "I'll keep the plan self-contained " } },
      { method: "item/agentMessage/delta", params: { ...at, itemId: "msg-a", delta: "and mark the one repo-derived" } },
      // The upstream stream is cut here: `msg-a` never completes, and Codex
      // silently re-samples — fixture 05's own shape (t 17754–21063), with the
      // re-sample being the final answer, the case that lost the answer.
      { method: "item/started", params: { ...at, startedAtMs: 2, item: agentMessage("msg-b", "", "final_answer") } },
      { method: "item/agentMessage/delta", params: { ...at, itemId: "msg-b", delta: "LICENSE is MIT, " } },
      { method: "item/agentMessage/delta", params: { ...at, itemId: "msg-b", delta: "held by the project authors." } },
      { method: "item/completed", params: { ...at, completedAtMs: 3, item: agentMessage("msg-b", answer, "final_answer") } },
      { method: "turn/completed", params: { threadId: at.threadId, turn: codexTurn("turn-1", "completed") } }
    ]);
    // The adapter really abandons `msg-a`: its only completion is the empty
    // one the normaliser synthesises for an open item when the turn settles.
    assert.deepEqual(
      events.flatMap((event) =>
        event.type === "item.completed" && event.itemId === "msg-a" ? [event.payload] : []
      ),
      [{ itemType: "assistant_message", status: "completed" }]
    );

    const domain = await ingestAll(events);
    const messages = foldMessages(domain);
    assert.deepEqual(
      [...messages.values()].filter((message) => message.role === "assistant").map((message) => message.id),
      ["assistant:msg-a", "assistant:msg-b"]
    );
    assert.deepEqual(seen(messages.get("assistant:msg-a")), { text: fragment, messageKind: "commentary" });
    assert.deepEqual(seen(messages.get("assistant:msg-b")), { text: answer, messageKind: "answer" });
    // The abandoned message is closed BEFORE the answer's first row: it ends
    // with the text it had, exactly as its own completion would have ended it.
    const closeA = messageRows(domain, "assistant:msg-a").filter((row) => !row.streaming);
    assert.equal(closeA.length, 1);
    assert.ok(closeA[0]!.index < messageRows(domain, "assistant:msg-b")[0]!.index);
    // lastReply's input: the answer, whole, and nothing of the fragment.
    assert.equal(answerText(messages.values(), "turn-1"), answer);
  });

  it("(b) fixture 05: the interrupted agentMessage and its re-sample are two bubbles, each its own text", async () => {
    const abandoned = "msg_0d0d102f2f46ad5c016ab0a4422a1087d287b60bfd06c10b98";
    const resample = "msg_0d0d102f2f46ad5c016ab0a44574f887d28d6b2840b954d7ce";
    const { events, completedTexts, streamedTexts } = replayCodexCapture(
      "05-tool-request-user-input.ndjson"
    );
    // What the capture records: the first streams 27 deltas and never
    // completes; ~3 s later the second starts in the same turn, and completes.
    assert.equal(completedTexts.has(abandoned), false);
    assert.equal(completedTexts.has(resample), true);

    const messages = foldMessages(await ingestAll(events));
    assert.deepEqual(seen(messages.get(`assistant:${abandoned}`)), {
      text: "The read-only command batch was rejected by the sandbox approval layer, so I’ll keep the plan self-contained and mark the one repo-derived",
      messageKind: "commentary"
    });
    assert.equal(messages.get(`assistant:${abandoned}`)?.text, streamedTexts.get(abandoned));
    assert.deepEqual(seen(messages.get(`assistant:${resample}`)), {
      text: completedTexts.get(resample),
      messageKind: "commentary"
    });
  });

  it("(c) a restarted SAME item keeps its one message", async () => {
    const item = { turnId: "turn-1", itemId: "msg-a" };
    const domain = await ingestAll([
      live("item.started", { itemType: "assistant_message", ...codexLive("commentary") }, item),
      live("content.delta", { streamKind: "assistant_text", delta: "Hello, " }, item),
      // The same item announced again — the same base key, so nothing was
      // abandoned.
      live("item.started", { itemType: "assistant_message", ...codexLive("commentary") }, item),
      live("content.delta", { streamKind: "assistant_text", delta: "world." }, item),
      live("item.completed", { itemType: "assistant_message", ...codexLive("commentary") }, item),
      live("turn.completed", { state: "completed" }, { turnId: "turn-1" })
    ]);
    const messages = foldMessages(domain);
    assert.deepEqual([...messages.keys()], ["assistant:msg-a"]);
    assert.deepEqual(seen(messages.get("assistant:msg-a")), {
      text: "Hello, world.",
      messageKind: "commentary"
    });
    // Closed once, by its own completion — never by its own restart.
    const rows = messageRows(domain, "assistant:msg-a");
    assert.deepEqual(
      rows.filter((row) => !row.streaming).map((row) => row.index),
      [rows.at(-1)!.index]
    );
  });

  it("(c) an item.started that names no item proves no abandonment", async () => {
    const item = { turnId: "turn-1", itemId: "msg-a" };
    const domain = await ingestAll([
      live("content.delta", { streamKind: "assistant_text", delta: "Hello, " }, item),
      // No item id: nothing says this is another item, so nothing is closed.
      live("item.started", { itemType: "assistant_message", status: "inProgress" }, { turnId: "turn-1" }),
      live("content.delta", { streamKind: "assistant_text", delta: "world." }, item),
      live("item.completed", { itemType: "assistant_message", status: "completed" }, item)
    ]);
    assert.deepEqual(seen(foldMessages(domain).get("assistant:msg-a")), {
      text: "Hello, world.",
      messageKind: "answer"
    });
    const rows = messageRows(domain, "assistant:msg-a");
    assert.deepEqual(
      rows.filter((row) => !row.streaming).map((row) => row.index),
      [rows.at(-1)!.index]
    );
  });

  it("(c) a subagent's assistant item leaves the parent's open message alone", async () => {
    const parent = { turnId: "turn-1", itemId: "msg-p" };
    const agent = { turnId: "turn-1", itemId: "msg-s", agentId: "task-1" };
    const domain = await ingestAll([
      live("item.started", { itemType: "assistant_message", status: "inProgress" }, parent),
      live("content.delta", { streamKind: "assistant_text", delta: "Parent, " }, parent),
      // A subagent narrates inside the parent's turn: Claude's nested block,
      // every event stamped with the agent (`nestedMessageEvents`).
      live("item.started", { itemType: "assistant_message", status: "inProgress", agentId: "task-1" }, agent),
      live("content.delta", { streamKind: "assistant_text", delta: "Agent says" }, agent),
      live("item.completed", { itemType: "assistant_message", status: "completed", agentId: "task-1" }, agent),
      live("content.delta", { streamKind: "assistant_text", delta: "continued." }, parent),
      live("item.completed", { itemType: "assistant_message", status: "completed" }, parent),
      live("turn.completed", { state: "completed" }, { turnId: "turn-1" })
    ]);
    const messages = foldMessages(domain);
    assert.deepEqual(seen(messages.get("assistant:msg-p")), {
      text: "Parent, continued.",
      messageKind: "answer"
    });
    assert.equal(messages.get("assistant:agent:task-1:msg-s")?.text, "Agent says");
    assert.equal(messages.get("assistant:agent:task-1:msg-s")?.agentId, "task-1");
    const rows = messageRows(domain, "assistant:msg-p");
    assert.deepEqual(
      rows.filter((row) => !row.streaming).map((row) => row.index),
      [rows.at(-1)!.index],
      "the parent's message is closed once, by its own completion"
    );
  });

  it("(c) …and a parent's new item leaves a subagent's open message alone", async () => {
    const agent = { turnId: "turn-1", itemId: "msg-s", agentId: "task-1" };
    const domain = await ingestAll([
      live("item.started", { itemType: "assistant_message", status: "inProgress", agentId: "task-1" }, agent),
      live("content.delta", { streamKind: "assistant_text", delta: "Agent " }, agent),
      live("item.started", { itemType: "assistant_message", status: "inProgress" }, { turnId: "turn-1", itemId: "msg-p" }),
      live("content.delta", { streamKind: "assistant_text", delta: "Parent." }, { turnId: "turn-1", itemId: "msg-p" }),
      live("content.delta", { streamKind: "assistant_text", delta: "continues." }, agent),
      live("item.completed", { itemType: "assistant_message", status: "completed", agentId: "task-1" }, agent),
      live("turn.completed", { state: "completed" }, { turnId: "turn-1" })
    ]);
    const messages = foldMessages(domain);
    assert.equal(messages.get("assistant:agent:task-1:msg-s")?.text, "Agent continues.");
    assert.equal(messages.get("assistant:msg-p")?.text, "Parent.");
    const rows = messageRows(domain, "assistant:agent:task-1:msg-s");
    assert.deepEqual(
      rows.filter((row) => !row.streaming).map((row) => row.index),
      [rows.at(-1)!.index],
      "the agent's message is closed once, by its own completion"
    );
  });
});

// ---------------------------------------------------------------------------
// (D4) The completion drops a phase-marker `detail`, never `data.text`
// ---------------------------------------------------------------------------

describe("(D4) a phase-marker detail is dropped from the completion, never data.text", () => {
  it("data.text stands in for deltas that never arrived, even beside a marker detail", async () => {
    // Codex does not forward `item.text` today; the day it does, it rides
    // `data.text` next to the marker, and the marker must not take it along.
    const messages = foldMessages(
      await ingestAll([
        live(
          "item.completed",
          {
            itemType: "assistant_message",
            detail: "commentary",
            data: { phase: "commentary", text: "I'll read the config first.", delivery: null, questions: null }
          },
          { turnId: "turn-1", itemId: "a1" }
        )
      ])
    );
    assert.deepEqual(seen(messages.get("assistant:a1")), {
      text: "I'll read the config first.",
      messageKind: "commentary"
    });
  });

  it("…and never prints a streamed message twice", async () => {
    const item = { turnId: "turn-1", itemId: "a1" };
    const messages = foldMessages(
      await ingestAll([
        live("item.started", { itemType: "assistant_message", ...codexLive("commentary") }, item),
        live("content.delta", { streamKind: "assistant_text", delta: "I'll read the config first." }, item),
        live(
          "item.completed",
          {
            itemType: "assistant_message",
            detail: "commentary",
            data: { phase: "commentary", text: "I'll read the config first.", delivery: null, questions: null }
          },
          item
        )
      ])
    );
    assert.deepEqual(seen(messages.get("assistant:a1")), {
      text: "I'll read the config first.",
      messageKind: "commentary"
    });
  });
});
