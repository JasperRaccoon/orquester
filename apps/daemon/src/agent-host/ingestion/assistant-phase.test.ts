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

/** A Codex `agentMessage`, complete, as `thread/turns/list` returns it. */
function agentMessage(id: string, text: string, phase: "commentary" | "final_answer") {
  return { type: "agentMessage", id, text, phase, memoryCitation: null, delivery: null, questions: null };
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
 * each `agentMessage` — its phase, and the whole text its `item/completed`
 * carries — as the expectation.
 */
function replayCodexCapture(name: string): {
  events: RuntimeEvent[];
  phases: Map<string, string | null>;
  completedTexts: Map<string, string>;
} {
  const normaliser = new CodexNormaliser({ usage: new CodexUsageTracker() });
  const events: RuntimeEvent[] = [];
  const phases = new Map<string, string | null>();
  const completedTexts = new Map<string, string>();
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
    for (const draft of normaliser.notification(frame.method as never, frame.params)) {
      events.push(stamped(draft));
    }
  }
  return { events, phases, completedTexts };
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

  it("every capture: each assistant bubble is a recorded agentMessage, of its recorded phase", async () => {
    const names = readdirSync(CODEX_FIXTURES)
      .filter((name) => name.endsWith(".ndjson"))
      .sort();
    const checked = { commentary: 0, answer: 0 };
    for (const name of names) {
      const { events, phases, completedTexts } = replayCodexCapture(name);
      for (const bubble of foldMessages(await ingestAll(events)).values()) {
        if (bubble.role !== "assistant") {
          continue;
        }
        const itemId = bubble.id.replace(/^assistant:/, "");
        // A phase marker never becomes a bubble of its own.
        assert.ok(phases.has(itemId), `${name}: ${bubble.id} is not a recorded agentMessage`);
        const expected = phases.get(itemId) === "commentary" ? "commentary" : "answer";
        assert.equal(bubble.messageKind, expected, `${name} ${bubble.id}`);
        // …and never becomes its text. (05 abandons one agentMessage without an
        // `item/completed`, and the next one streams into that still-open
        // segment — the segment rule, not the phase's — so that one bubble has
        // no single recorded text to compare.)
        const text = completedTexts.get(itemId);
        if (text !== undefined) {
          assert.equal(bubble.text, text, `${name} ${bubble.id}`);
        }
        checked[expected] += 1;
      }
    }
    // The corpus really exercises both phases.
    assert.deepEqual(checked, { commentary: 13, answer: 18 });
  });
});
