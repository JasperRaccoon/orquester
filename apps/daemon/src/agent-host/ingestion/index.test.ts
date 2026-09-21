/**
 * The stateful half: message identity and the streaming merge (§5.1), the
 * 250 ms / 8 KB batcher and every mandatory flush point (§5.6), the 50 ms
 * coalescing window, and the rules that need memory across events.
 *
 * Every timing assertion drives {@link FakeTimers}; nothing here sleeps.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { AppendableDomainEvent } from "../services.ts";
import { BATCH_INTERVAL_MS, BATCH_MAX_CHARS, createIngestion, type IngestionOptions } from "./index.ts";
import {
  FakeClock,
  FakeTimers,
  RecordingLiveness,
  RecordingSink,
  counterIdGen,
  resetRuntimeEventCounter,
  runtimeEvent,
  settle
} from "./test-harness.ts";

interface Harness {
  ingestion: ReturnType<typeof createIngestion>;
  sink: RecordingSink;
  liveness: RecordingLiveness;
  clock: FakeClock;
  timers: FakeTimers;
}

function harness(overrides: Partial<IngestionOptions> = {}): Harness {
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const sink = new RecordingSink();
  const liveness = new RecordingLiveness();
  const ingestion = createIngestion({
    sink: sink.sink,
    liveness,
    clock,
    idGen: counterIdGen(),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    // W2 owns the real one; identity keeps these tests about ingestion.
    slim: (payload) => payload,
    ...overrides
  });
  return { ingestion, sink, liveness, clock, timers };
}

function messageTexts(sink: RecordingSink): { id: string; text: string; streaming: boolean }[] {
  return sink
    .messages()
    .map((event) => ({
      id: event.payload.messageId,
      text: event.payload.text,
      streaming: event.payload.streaming
    }));
}

function activityOfKind(
  sink: RecordingSink,
  kind: string
): Extract<AppendableDomainEvent, { type: "thread.activity-appended" }>[] {
  return sink.activities().filter((event) => event.payload.activity.activityKind === kind);
}

beforeEach(() => {
  resetRuntimeEventCounter();
});

// ---------------------------------------------------------------------------
// §5.1 message identity and the streaming merge
// ---------------------------------------------------------------------------

describe("message identity (§5.1)", () => {
  it("mints assistant:<itemId> for the first segment of a turn", async () => {
    const { ingestion, sink } = harness();
    await ingestion.ingest(
      runtimeEvent(
        "content.delta",
        { streamKind: "assistant_text", delta: "hello\n\n" },
        { turnId: "turn-1", itemId: "item-1" }
      )
    );
    await ingestion.drain();
    assert.deepEqual(
      messageTexts(sink).map((m) => m.id),
      ["assistant:item-1"]
    );
  });

  it("falls back to the turn id, then the event id", async () => {
    const a = harness();
    await a.ingestion.ingest(
      runtimeEvent(
        "content.delta",
        { streamKind: "assistant_text", delta: "x\n\n" },
        { turnId: "turn-7" }
      )
    );
    await a.ingestion.drain();
    assert.equal(messageTexts(a.sink)[0]?.id, "assistant:turn-7");

    const b = harness();
    await b.ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "assistant_text", delta: "x\n\n" }, {
        eventId: "ev-42"
      })
    );
    await b.ingestion.drain();
    assert.equal(messageTexts(b.sink)[0]?.id, "assistant:ev-42");
  });

  it("a second assistant block in one turn gets :segment:1", async () => {
    const { ingestion, sink } = harness();
    const turn = { turnId: "turn-1" };
    await ingestion.ingest(
      runtimeEvent(
        "content.delta",
        { streamKind: "assistant_text", delta: "first" },
        { ...turn, itemId: "item-1" }
      )
    );
    await ingestion.ingest(
      runtimeEvent("item.completed", { itemType: "assistant_message" }, { ...turn, itemId: "item-1" })
    );
    await ingestion.ingest(
      runtimeEvent(
        "content.delta",
        { streamKind: "assistant_text", delta: "second" },
        { ...turn, itemId: "item-2" }
      )
    );
    await ingestion.flushTurn("t1", "turn-1");
    const ids = [...new Set(messageTexts(sink).map((m) => m.id))];
    assert.deepEqual(ids, ["assistant:item-1", "assistant:item-2"]);
  });

  it("a summary trace and a raw trace over one item become two reasoning messages", async () => {
    const { ingestion, sink } = harness();
    const turn = { turnId: "turn-1", itemId: "item-1" };
    await ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "reasoning_summary_text", delta: "sum" }, turn)
    );
    await ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "reasoning_text", delta: "raw" }, turn)
    );
    await ingestion.flushTurn("t1", "turn-1");
    const ids = [...new Set(messageTexts(sink).map((m) => m.id))];
    // Reasoning never resets the segment index on a new base key: summary ->
    // raw -> summary must not reuse the id of the first, finished block.
    assert.deepEqual(ids, ["reasoning:summary:item-1", "reasoning:raw:item-1:segment:1"]);
  });

  it("a delta carries ONLY the new text and a completion carries empty text", async () => {
    const { ingestion, sink, timers } = harness();
    const turn = { turnId: "turn-1", itemId: "item-1" };
    await ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "assistant_text", delta: "one\n\n" }, turn)
    );
    timers.advance(BATCH_INTERVAL_MS);
    await settle();
    await ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "assistant_text", delta: "two\n\n" }, turn)
    );
    await ingestion.ingest(runtimeEvent("turn.completed", { state: "completed" }, turn));
    await ingestion.drain();
    assert.deepEqual(messageTexts(sink), [
      { id: "assistant:item-1", text: "one\n\n", streaming: true },
      { id: "assistant:item-1", text: "two\n\n", streaming: true },
      { id: "assistant:item-1", text: "", streaming: false }
    ]);
  });

  it("a completion with nothing buffered and nothing projected writes no message at all", async () => {
    const { ingestion, sink } = harness();
    await ingestion.ingest(
      runtimeEvent(
        "item.completed",
        { itemType: "assistant_message" },
        { turnId: "turn-1", itemId: "item-1" }
      )
    );
    await ingestion.drain();
    assert.deepEqual(messageTexts(sink), []);
  });

  it("an item.completed snapshot stands in for deltas that never arrived", async () => {
    const { ingestion, sink } = harness();
    await ingestion.ingest(
      runtimeEvent(
        "item.completed",
        { itemType: "assistant_message", detail: "the whole answer" },
        { turnId: "turn-1", itemId: "item-1" }
      )
    );
    await ingestion.drain();
    assert.deepEqual(messageTexts(sink), [
      { id: "assistant:item-1", text: "the whole answer", streaming: true },
      { id: "assistant:item-1", text: "", streaming: false }
    ]);
  });

  it("an item.completed snapshot NEVER duplicates text that already streamed", async () => {
    const { ingestion, sink } = harness();
    const turn = { turnId: "turn-1", itemId: "item-1" };
    await ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "assistant_text", delta: "streamed" }, turn)
    );
    await ingestion.ingest(
      runtimeEvent("item.completed", { itemType: "assistant_message", detail: "streamed" }, turn)
    );
    await ingestion.drain();
    assert.deepEqual(messageTexts(sink), [
      { id: "assistant:item-1", text: "streamed", streaming: true },
      { id: "assistant:item-1", text: "", streaming: false }
    ]);
  });

  it("a whole-block reasoning snapshot with no stream gets its own snapshot id", async () => {
    const { ingestion, sink } = harness();
    await ingestion.ingest(
      runtimeEvent(
        "item.completed",
        { itemType: "reasoning", detail: "I thought about it" },
        { turnId: "turn-1", itemId: "item-1" }
      )
    );
    await ingestion.drain();
    assert.deepEqual(
      messageTexts(sink).map((m) => m.id),
      ["reasoning:snapshot:item-1", "reasoning:snapshot:item-1"]
    );
  });
});

// ---------------------------------------------------------------------------
// §5.6 batching
// ---------------------------------------------------------------------------

describe("batching (§5.6, 250 ms / 8 KB)", () => {
  it("holds a partial line until the 250 ms window expires", async () => {
    const { ingestion, sink, timers } = harness();
    const turn = { turnId: "turn-1", itemId: "item-1" };
    await ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "assistant_text", delta: "par" }, turn)
    );
    await ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "assistant_text", delta: "tial" }, turn)
    );
    assert.equal(sink.messages().length, 0, "nothing should have been written yet");
    timers.advance(BATCH_INTERVAL_MS);
    await settle();
    assert.deepEqual(messageTexts(sink), [
      { id: "assistant:item-1", text: "partial", streaming: true }
    ]);
  });

  it("delivers early on a paragraph boundary once the pacing window has passed", async () => {
    const { ingestion, sink, timers } = harness();
    const turn = { turnId: "turn-1", itemId: "item-1" };
    await ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "assistant_text", delta: "one\n\n" }, turn)
    );
    // First delivery is unpaced: the buffer has never delivered.
    assert.equal(messageTexts(sink)[0]?.text, "one\n\n");
    sink.reset();
    await ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "assistant_text", delta: "two\n\n" }, turn)
    );
    assert.equal(sink.messages().length, 0, "a second paragraph inside 250 ms stays buffered");
    timers.advance(BATCH_INTERVAL_MS);
    await settle();
    assert.equal(messageTexts(sink)[0]?.text, "two\n\n");
  });

  it("never splits a code block: an open fence holds past the window", async () => {
    const { ingestion, sink, timers } = harness();
    const turn = { turnId: "turn-1", itemId: "item-1" };
    await ingestion.ingest(
      runtimeEvent(
        "content.delta",
        { streamKind: "assistant_text", delta: "```ts\nconst a = 1;\n" },
        turn
      )
    );
    timers.advance(BATCH_INTERVAL_MS * 4);
    await settle();
    assert.equal(sink.messages().length, 0, "an unclosed fence must not be flushed");
    await ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "assistant_text", delta: "```\n" }, turn)
    );
    timers.advance(BATCH_INTERVAL_MS);
    await settle();
    assert.equal(messageTexts(sink)[0]?.text, "```ts\nconst a = 1;\n```\n");
  });

  it("the 8 KB valve wins over the fence rule", async () => {
    const { ingestion, sink } = harness();
    const turn = { turnId: "turn-1", itemId: "item-1" };
    await ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "assistant_text", delta: "```ts\n" }, turn)
    );
    await ingestion.ingest(
      runtimeEvent(
        "content.delta",
        { streamKind: "assistant_text", delta: "x".repeat(BATCH_MAX_CHARS + 1) },
        turn
      )
    );
    assert.equal(sink.messages().length, 1);
    assert.ok(messageTexts(sink)[0]!.text.length > BATCH_MAX_CHARS);
  });

  it("a token-by-token provider becomes a handful of events per second", async () => {
    const { ingestion, sink, timers } = harness();
    const turn = { turnId: "turn-1", itemId: "item-1" };
    for (let i = 0; i < 200; i += 1) {
      await ingestion.ingest(
        runtimeEvent("content.delta", { streamKind: "assistant_text", delta: `tok${i} ` }, turn)
      );
      timers.advance(5);
      await settle();
    }
    await ingestion.drain();
    assert.ok(
      sink.messages().length <= 6,
      `200 tokens over 1 s became ${sink.messages().length} events`
    );
    const joined = messageTexts(sink)
      .map((m) => m.text)
      .join("");
    assert.ok(joined.startsWith("tok0 "));
    assert.ok(joined.endsWith("tok199 "));
  });

  it("reasoning deltas are buffered on the same machinery", async () => {
    const { ingestion, sink, timers } = harness();
    const turn = { turnId: "turn-1", itemId: "item-1" };
    await ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "reasoning_text", delta: "thin" }, turn)
    );
    await ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "reasoning_text", delta: "king" }, turn)
    );
    assert.equal(sink.messages().length, 0);
    timers.advance(BATCH_INTERVAL_MS);
    await settle();
    assert.deepEqual(messageTexts(sink), [
      { id: "reasoning:raw:item-1", text: "thinking", streaming: true }
    ]);
  });

  it("a new reasoning part index inserts the blank line that separates traces", async () => {
    const { ingestion, sink } = harness();
    const turn = { turnId: "turn-1", itemId: "item-1" };
    await ingestion.ingest(
      runtimeEvent(
        "content.delta",
        { streamKind: "reasoning_text", delta: "part one", contentIndex: 0 },
        turn
      )
    );
    await ingestion.ingest(
      runtimeEvent(
        "content.delta",
        { streamKind: "reasoning_text", delta: "part two", contentIndex: 1 },
        turn
      )
    );
    await ingestion.flushTurn("t1", "turn-1");
    assert.equal(
      messageTexts(sink)
        .map((m) => m.text)
        .join(""),
      "part one\n\npart two"
    );
  });

  it("command output deltas are buffered per item id (§5.6)", async () => {
    const { ingestion, sink, timers } = harness();
    const turn = { turnId: "turn-1" };
    await ingestion.ingest(
      runtimeEvent(
        "content.delta",
        { streamKind: "command_output", delta: "line 1\n" },
        { ...turn, itemId: "call-a" }
      )
    );
    await ingestion.ingest(
      runtimeEvent(
        "content.delta",
        { streamKind: "command_output", delta: "line 2\n" },
        { ...turn, itemId: "call-b" }
      )
    );
    timers.advance(BATCH_INTERVAL_MS);
    await settle();
    const rows = activityOfKind(sink, "tool.output");
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => (row.payload.activity.payload as { toolUseId: string }).toolUseId).sort(),
      ["call-a", "call-b"]
    );
  });
});

// ---------------------------------------------------------------------------
// §5.6 mandatory flush points
// ---------------------------------------------------------------------------

describe("mandatory flush points (§5.6)", () => {
  it("request.opened flushes AND finalises before the approval row is appended", async () => {
    const { ingestion, sink } = harness();
    const turn = { turnId: "turn-1", itemId: "item-1" };
    await ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "assistant_text", delta: "about to run" }, turn)
    );
    assert.equal(sink.messages().length, 0, "buffered, not yet written");
    await ingestion.ingest(
      runtimeEvent(
        "request.opened",
        { requestType: "command_execution_approval", dismissible: false },
        { ...turn, requestId: "req-1" }
      )
    );
    const types = sink.events().map((event) =>
      event.type === "thread.activity-appended"
        ? event.payload.activity.activityKind
        : `${event.type}:${
            event.type === "thread.message-sent" ? String(event.payload.streaming) : ""
          }`
    );
    assert.deepEqual(types, [
      "thread.message-sent:true",
      "thread.message-sent:false",
      "approval.requested"
    ]);
  });

  it("a BLOCKING user-input.requested flushes; a message-mode one does not", async () => {
    const blocking = harness();
    const turn = { turnId: "turn-1", itemId: "item-1" };
    await blocking.ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "assistant_text", delta: "text" }, turn)
    );
    await blocking.ingestion.ingest(
      runtimeEvent("user-input.requested", { questions: [], dismissible: false }, turn)
    );
    assert.equal(blocking.sink.messages().length, 2);

    const message = harness();
    await message.ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "assistant_text", delta: "text" }, turn)
    );
    await message.ingestion.ingest(
      runtimeEvent(
        "user-input.requested",
        { questions: [], dismissible: true, responseMode: "message" },
        turn
      )
    );
    assert.equal(
      message.sink.messages().length,
      0,
      "a message-mode question does not block the provider, so it must not force a flush"
    );
  });

  it("a tool item.started closes the active reasoning segment", async () => {
    const { ingestion, sink } = harness();
    const turn = { turnId: "turn-1", itemId: "item-1" };
    await ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "reasoning_text", delta: "pondering" }, turn)
    );
    await ingestion.ingest(
      runtimeEvent(
        "item.started",
        { itemType: "command_execution", title: "ls" },
        { turnId: "turn-1", itemId: "call-1" }
      )
    );
    assert.deepEqual(messageTexts(sink), [
      { id: "reasoning:raw:item-1", text: "pondering", streaming: true },
      { id: "reasoning:raw:item-1", text: "", streaming: false }
    ]);
    // Post-tool thinking opens a NEW block rather than reopening the closed one.
    await ingestion.ingest(
      runtimeEvent(
        "content.delta",
        { streamKind: "reasoning_text", delta: "after" },
        { turnId: "turn-1", itemId: "item-2" }
      )
    );
    await ingestion.flushTurn("t1", "turn-1");
    assert.equal(messageTexts(sink).at(-1)?.id, "reasoning:raw:item-2:segment:1");
  });

  it("a NON-tool item.started leaves the thinking block open", async () => {
    const { ingestion, sink } = harness();
    const turn = { turnId: "turn-1", itemId: "item-1" };
    await ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "reasoning_text", delta: "pondering" }, turn)
    );
    await ingestion.ingest(
      // `review_entered` is classified and then dropped (§2/§4.2); it produces
      // no row, so it must not break a thinking block either.
      runtimeEvent("item.started", { itemType: "review_entered" }, {
        turnId: "turn-1",
        itemId: "review-1"
      })
    );
    assert.equal(sink.messages().length, 0);
    await ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "reasoning_text", delta: " more" }, turn)
    );
    await ingestion.flushTurn("t1", "turn-1");
    assert.equal(
      messageTexts(sink)
        .map((m) => m.text)
        .join(""),
      "pondering more"
    );
  });

  it("assistant text closes the thinking block that preceded it", async () => {
    const { ingestion, sink } = harness();
    const turn = { turnId: "turn-1", itemId: "item-1" };
    await ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "reasoning_text", delta: "hmm" }, turn)
    );
    await ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "assistant_text", delta: "answer" }, turn)
    );
    assert.deepEqual(
      messageTexts(sink).map((m) => `${m.id}/${m.streaming}`),
      ["reasoning:raw:item-1/true", "reasoning:raw:item-1/false"]
    );
  });

  it("a settled turn flushes and closes everything it opened", async () => {
    const { ingestion, sink } = harness();
    const turn = { turnId: "turn-1", itemId: "item-1" };
    await ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "assistant_text", delta: "trailing" }, turn)
    );
    await ingestion.ingest(
      runtimeEvent("turn.completed", { state: "completed" }, { turnId: "turn-1" })
    );
    const order = sink.events().map((event) => event.type);
    assert.deepEqual(order, [
      "thread.message-sent",
      "thread.message-sent",
      "thread.session-set"
    ]);
    assert.equal(
      sink.ofType("thread.session-set")[0]?.payload.session.activeTurnId,
      null,
      "the text must land before the status change that settles the turn"
    );
  });
});

// ---------------------------------------------------------------------------
// §5.6 coalescing
// ---------------------------------------------------------------------------

describe("item.updated coalescing (§5.6, 50 ms window)", () => {
  function update(itemId: string, turnId: string, detail: string) {
    return runtimeEvent(
      "item.updated",
      { itemType: "command_execution", status: "inProgress", detail },
      { turnId, itemId }
    );
  }

  it("collapses a burst for one call to the latest row", async () => {
    const { ingestion, sink, timers } = harness();
    for (const detail of ["a", "b", "c"]) {
      await ingestion.ingest(update("call-1", "turn-1", detail));
    }
    assert.equal(sink.activities().length, 0, "the window is still open");
    timers.advance(50);
    await settle();
    const rows = activityOfKind(sink, "tool.updated");
    assert.equal(rows.length, 1);
    assert.equal((rows[0]!.payload.activity.payload as { detail: string }).detail, "c");
  });

  it("coalesces per turn, not per thread", async () => {
    const { ingestion, sink, timers } = harness();
    await ingestion.ingest(update("call-1", "turn-1", "a"));
    await ingestion.ingest(update("call-1", "turn-2", "b"));
    timers.advance(50);
    await settle();
    assert.equal(activityOfKind(sink, "tool.updated").length, 2);
  });

  it("a call with no stable id passes through unchanged", async () => {
    const { ingestion, sink, timers } = harness();
    for (const detail of ["a", "b"]) {
      await ingestion.ingest(
        runtimeEvent(
          "item.updated",
          { itemType: "command_execution", detail },
          { turnId: "turn-1" }
        )
      );
    }
    timers.advance(50);
    await settle();
    assert.equal(activityOfKind(sink, "tool.updated").length, 2);
  });

  it("any non-update event closes the window immediately, so ordering is preserved", async () => {
    const { ingestion, sink } = harness();
    await ingestion.ingest(update("call-1", "turn-1", "a"));
    await ingestion.ingest(update("call-1", "turn-1", "b"));
    await ingestion.ingest(
      runtimeEvent(
        "item.completed",
        { itemType: "command_execution", status: "completed" },
        { turnId: "turn-1", itemId: "call-1" }
      )
    );
    assert.deepEqual(sink.activityKinds(), ["tool.updated", "tool.completed"]);
  });

  it("512 pending rows close the window early", async () => {
    const { ingestion, sink } = harness();
    for (let i = 0; i < 512; i += 1) {
      await ingestion.ingest(update(`call-${i}`, "turn-1", "x"));
    }
    assert.equal(
      activityOfKind(sink, "tool.updated").length,
      512,
      "the cap must flush without waiting for the timer"
    );
  });

  it("drain flushes a window that has not expired", async () => {
    const { ingestion, sink } = harness();
    await ingestion.ingest(update("call-1", "turn-1", "a"));
    assert.equal(sink.activities().length, 0);
    await ingestion.drain();
    assert.equal(activityOfKind(sink, "tool.updated").length, 1);
  });
});

// ---------------------------------------------------------------------------
// §5.6 slimming, §5.1 title, §3.1 liveness, §10 robustness
// ---------------------------------------------------------------------------

describe("tool.updated is persisted already slimmed (§5.6)", () => {
  it("runs the slimmer on tool.updated and on nothing else", async () => {
    const slimmed: unknown[] = [];
    const { ingestion, sink } = harness({
      slim: (payload) => {
        slimmed.push(payload);
        return { slimmed: true };
      }
    });
    const item = { turnId: "turn-1", itemId: "call-1" };
    await ingestion.ingest(
      runtimeEvent("item.updated", { itemType: "command_execution", data: "x".repeat(100) }, item)
    );
    await ingestion.ingest(
      runtimeEvent(
        "item.completed",
        { itemType: "command_execution", data: "x".repeat(100) },
        item
      )
    );
    await ingestion.drain();
    assert.equal(slimmed.length, 1);
    const [updated, completed] = sink.activities();
    assert.deepEqual(updated!.payload.activity.payload, { slimmed: true });
    assert.equal(
      (completed!.payload.activity.payload as { data: string }).data.length,
      100,
      "the completion keeps the full payload — it is what a 'load full output' fetch reads"
    );
  });

  it("a throwing slimmer costs the row nothing", async () => {
    const warnings: string[] = [];
    const { ingestion, sink } = harness({
      slim: () => {
        throw new Error("W2 has not landed");
      },
      logger: { warn: (message) => warnings.push(message) }
    });
    await ingestion.ingest(
      runtimeEvent(
        "item.updated",
        { itemType: "command_execution", detail: "keep me" },
        { turnId: "turn-1", itemId: "call-1" }
      )
    );
    await ingestion.drain();
    assert.equal(activityOfKind(sink, "tool.updated").length, 1);
    assert.ok(warnings.some((message) => message.includes("slimActivityPayload")));
  });
});

describe("the §7.3 badge fields (reasoningKind / messageKind)", () => {
  const reasoningCases: [
    "reasoning_text" | "reasoning_summary_text",
    "text" | "summary"
  ][] = [
    ["reasoning_text", "text"],
    ["reasoning_summary_text", "summary"]
  ];
  for (const [streamKind, expected] of reasoningCases) {
    it(`${streamKind} -> reasoningKind ${expected}`, async () => {
      const { ingestion, sink } = harness();
      const turn = { turnId: "turn-1", itemId: "item-1" };
      await ingestion.ingest(
        runtimeEvent("content.delta", { streamKind, delta: "thinking" }, turn)
      );
      await ingestion.flushTurn("t1", "turn-1");
      const rows = sink.messages();
      assert.ok(rows.length >= 2, "a delta and a completion");
      for (const row of rows) {
        assert.equal(row.payload.role, "reasoning");
        assert.equal(row.payload.reasoningKind, expected, "every row must carry the badge");
        assert.equal(row.payload.messageKind, undefined, "messageKind is assistant-only");
      }
    });
  }

  it("a whole-block reasoning snapshot carries NO reasoningKind", async () => {
    const { ingestion, sink } = harness();
    await ingestion.ingest(
      runtimeEvent(
        "item.completed",
        { itemType: "reasoning", detail: "I thought about it" },
        { turnId: "turn-1", itemId: "item-1" }
      )
    );
    await ingestion.drain();
    // The stream kind was never observed, so the row renders without a badge
    // rather than guessing.
    for (const row of sink.messages()) {
      assert.equal(row.payload.reasoningKind, undefined);
    }
  });

  it("an assistant message defaults to messageKind 'answer'", async () => {
    const { ingestion, sink } = harness();
    const turn = { turnId: "turn-1", itemId: "item-1" };
    await ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "assistant_text", delta: "Done." }, turn)
    );
    await ingestion.flushTurn("t1", "turn-1");
    const rows = sink.messages();
    assert.ok(rows.length >= 2);
    for (const row of rows) {
      assert.equal(row.payload.messageKind, "answer");
      assert.equal(row.payload.reasoningKind, undefined, "reasoningKind is reasoning-only");
    }
  });

  const phaseCases: [string | undefined, "answer" | "commentary"][] = [
    ["commentary", "commentary"],
    ["COMMENTARY ", "commentary"],
    ["final_answer", "answer"],
    ["some real detail text", "answer"],
    [undefined, "answer"]
  ];
  for (const [detail, expected] of phaseCases) {
    it(`item detail ${JSON.stringify(detail)} -> messageKind ${expected}`, async () => {
      const { ingestion, sink } = harness();
      const turn = { turnId: "turn-1", itemId: "item-1" };
      await ingestion.ingest(
        runtimeEvent(
          "item.started",
          { itemType: "assistant_message", ...(detail !== undefined ? { detail } : {}) },
          turn
        )
      );
      await ingestion.ingest(
        runtimeEvent("content.delta", { streamKind: "assistant_text", delta: "text" }, turn)
      );
      await ingestion.flushTurn("t1", "turn-1");
      for (const row of sink.messages()) {
        assert.equal(row.payload.messageKind, expected);
      }
    });
  }

  it("the phase stamps a message that ALREADY started streaming", async () => {
    const { ingestion, sink } = harness();
    const turn = { turnId: "turn-1", itemId: "item-1" };
    await ingestion.ingest(
      runtimeEvent(
        "content.delta",
        { streamKind: "assistant_text", delta: "I'll read the file next.\n\n" },
        turn
      )
    );
    assert.equal(sink.messages()[0]?.payload.messageKind, "answer", "not known yet");
    sink.reset();
    await ingestion.ingest(
      runtimeEvent(
        "item.completed",
        { itemType: "assistant_message", detail: "commentary" },
        turn
      )
    );
    await ingestion.drain();
    const rows = sink.messages();
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.equal(row.payload.messageKind, "commentary");
    }
  });

  it("a phase-marker detail is metadata, NOT the message text", async () => {
    const { ingestion, sink } = harness();
    await ingestion.ingest(
      runtimeEvent(
        "item.completed",
        { itemType: "assistant_message", detail: "commentary" },
        { turnId: "turn-1", itemId: "item-1" }
      )
    );
    await ingestion.drain();
    assert.deepEqual(
      sink.messages().map((row) => row.payload.text),
      [],
      "the phase marker must never be rendered as the answer"
    );
  });

  it("a real detail still stands in for deltas that never arrived", async () => {
    const { ingestion, sink } = harness();
    await ingestion.ingest(
      runtimeEvent(
        "item.completed",
        { itemType: "assistant_message", detail: "the whole answer" },
        { turnId: "turn-1", itemId: "item-1" }
      )
    );
    await ingestion.drain();
    assert.equal(sink.messages()[0]?.payload.text, "the whole answer");
    assert.equal(sink.messages()[0]?.payload.messageKind, "answer");
  });

  it("commentary on one item does not leak onto the turn's next message", async () => {
    const { ingestion, sink } = harness();
    const turn = { turnId: "turn-1" };
    await ingestion.ingest(
      runtimeEvent(
        "item.started",
        { itemType: "assistant_message", detail: "commentary" },
        { ...turn, itemId: "item-1" }
      )
    );
    await ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "assistant_text", delta: "narration" }, {
        ...turn,
        itemId: "item-1"
      })
    );
    await ingestion.ingest(
      runtimeEvent(
        "item.completed",
        { itemType: "assistant_message", detail: "commentary" },
        { ...turn, itemId: "item-1" }
      )
    );
    await ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "assistant_text", delta: "the answer" }, {
        ...turn,
        itemId: "item-2"
      })
    );
    await ingestion.flushTurn("t1", "turn-1");
    const byMessage = new Map<string, string | undefined>();
    for (const row of sink.messages()) {
      byMessage.set(row.payload.messageId, row.payload.messageKind);
    }
    assert.equal(byMessage.get("assistant:item-1"), "commentary");
    assert.equal(byMessage.get("assistant:item-2"), "answer");
  });

  it("a dead session forgets the remembered phases", async () => {
    const { ingestion, sink } = harness();
    await ingestion.ingest(
      runtimeEvent(
        "item.started",
        { itemType: "assistant_message", detail: "commentary" },
        { turnId: "turn-1", itemId: "item-1" }
      )
    );
    await ingestion.ingest(
      runtimeEvent("session.exited", { recoverable: true, exitKind: "graceful" })
    );
    sink.reset();
    await ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "assistant_text", delta: "fresh" }, {
        turnId: "turn-2",
        itemId: "item-1"
      })
    );
    await ingestion.flushTurn("t1", "turn-2");
    for (const row of sink.messages()) {
      assert.equal(row.payload.messageKind, "answer");
    }
  });
});

describe("account events are provider-snapshot facts (§5.1)", () => {
  it("writes nothing to the thread and hands them to the host instead", async () => {
    const routed: string[] = [];
    const { ingestion, sink } = harness({
      onAccountEvent: (event) => routed.push(event.type)
    });
    await ingestion.ingest(runtimeEvent("auth.status", { isAuthenticating: true }));
    await ingestion.ingest(
      runtimeEvent("account.rate-limits.updated", {
        limits: {
          windows: [
            { id: "5h", kind: "session", label: "5 hours", usedPercent: 42 }
          ]
        }
      })
    );
    await ingestion.drain();
    assert.equal(sink.events().length, 0, "neither event is a thread fact");
    assert.deepEqual(routed, ["auth.status", "account.rate-limits.updated"]);
  });

  it("a throwing host hook never escapes ingest", async () => {
    const warnings: string[] = [];
    const { ingestion } = harness({
      onAccountEvent: () => {
        throw new Error("registry exploded");
      },
      logger: { warn: (m) => warnings.push(m) }
    });
    await ingestion.ingest(runtimeEvent("auth.status", {}));
    await ingestion.drain();
    assert.ok(warnings.some((message) => message.includes("onAccountEvent")));
  });
});

describe("integration with W2's real slimmer (§5.6)", () => {
  it("a tool.updated row reaches the log slimmed, the completion in full", async () => {
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const sink = new RecordingSink();
    // No `slim` override: this is the shipped default, `slimActivityPayload`.
    const ingestion = createIngestion({
      sink: sink.sink,
      liveness: new RecordingLiveness(),
      clock,
      idGen: counterIdGen(),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer
    });
    const item = { turnId: "turn-1", itemId: "call-1" };
    const data = {
      item: {
        command: "pnpm test",
        aggregatedOutput: `${"noise line\n".repeat(4000)}`
      }
    };
    await ingestion.ingest(
      runtimeEvent("item.updated", { itemType: "command_execution", data }, item)
    );
    await ingestion.ingest(
      runtimeEvent(
        "item.completed",
        { itemType: "command_execution", status: "completed", data },
        item
      )
    );
    await ingestion.drain();
    const [updated, completed] = sink.activities();
    const updatedJson = JSON.stringify(updated!.payload.activity.payload);
    const completedJson = JSON.stringify(completed!.payload.activity.payload);
    assert.ok(
      updatedJson.length < 2_000,
      `the streaming update must not persist the whole output (was ${updatedJson.length} bytes)`
    );
    assert.ok(
      completedJson.length > 40_000,
      "the completion is what a 'load full output' fetch reads, so it keeps everything"
    );
    // The fields the roster fold and the presentation resolver read survive.
    assert.equal(
      (updated!.payload.activity.payload as { toolUseId?: string }).toolUseId,
      "call-1"
    );
    assert.equal(
      (updated!.payload.activity.payload as { itemType?: string }).itemType,
      "command_execution"
    );
  });
});

describe("the provider title rule (§5.1)", () => {
  it("retitles an auto-generated thread", async () => {
    const { ingestion, sink } = harness();
    await ingestion.ingest(runtimeEvent("thread.metadata.updated", { name: "Fix the parser" }));
    await ingestion.drain();
    assert.deepEqual(sink.ofType("thread.meta-updated")[0]?.payload, {
      title: "Fix the parser"
    });
  });

  it("NEVER overwrites a manual rename", async () => {
    const { ingestion, sink } = harness({ threadContext: () => ({ titleManual: true }) });
    await ingestion.ingest(runtimeEvent("thread.metadata.updated", { name: "Provider guess" }));
    await ingestion.drain();
    assert.equal(sink.ofType("thread.meta-updated").length, 0);
  });

  it("an empty name is not a rename", async () => {
    const { ingestion, sink } = harness();
    await ingestion.ingest(runtimeEvent("thread.metadata.updated", { name: "   " }));
    await ingestion.drain();
    assert.equal(sink.ofType("thread.meta-updated").length, 0);
  });
});

describe("background liveness is fed on every task transition (§3.1)", () => {
  it("forwards task.* and clears on session.exited", async () => {
    const { ingestion, liveness } = harness();
    await ingestion.ingest(
      runtimeEvent("task.started", { taskId: "task-1", taskType: "subagent" })
    );
    await ingestion.ingest(
      runtimeEvent("task.progress", { taskId: "task-1", description: "working" })
    );
    await ingestion.ingest(runtimeEvent("task.updated", { taskId: "task-1", status: "idle" }));
    await ingestion.ingest(
      runtimeEvent("task.completed", { taskId: "task-1", status: "completed" })
    );
    assert.deepEqual(
      liveness.observed.map((event) => event.type),
      ["task.started", "task.progress", "task.updated", "task.completed"]
    );
    await ingestion.ingest(
      runtimeEvent("session.exited", { recoverable: false, exitKind: "graceful" })
    );
    assert.deepEqual(liveness.cleared, ["t1"]);
  });

  it("remembers a task description so the completion row is titled", async () => {
    const { ingestion, sink } = harness();
    await ingestion.ingest(
      runtimeEvent("task.started", { taskId: "task-1", description: "Audit the fold" })
    );
    await ingestion.ingest(
      runtimeEvent("task.completed", { taskId: "task-1", status: "completed" })
    );
    await ingestion.drain();
    const completion = activityOfKind(sink, "task.completed")[0]!;
    assert.equal(
      (completion.payload.activity.payload as { title: string }).title,
      "Audit the fold"
    );
  });
});

describe("session status (§5.1)", () => {
  it("dedupes an unchanged status, so Claude's 3-per-turn status frames write one row", async () => {
    const { ingestion, sink } = harness();
    for (let i = 0; i < 3; i += 1) {
      await ingestion.ingest(
        runtimeEvent("session.state.changed", { state: "running" }, { turnId: "turn-1" })
      );
    }
    await ingestion.drain();
    assert.equal(sink.ofType("thread.session-set").length, 1);
  });

  it("runtime.error writes BOTH a session-set and an activity row", async () => {
    const { ingestion, sink } = harness();
    await ingestion.ingest(
      runtimeEvent("runtime.error", { message: "provider died", class: "provider_error" })
    );
    await ingestion.drain();
    assert.equal(sink.ofType("thread.session-set")[0]?.payload.session.status, "error");
    assert.equal(activityOfKind(sink, "runtime.error").length, 1);
  });

  it("session.exited flushes buffered text before the stop and forgets the turn state", async () => {
    const { ingestion, sink } = harness();
    await ingestion.ingest(
      runtimeEvent(
        "content.delta",
        { streamKind: "assistant_text", delta: "half a thought" },
        { turnId: "turn-1", itemId: "item-1" }
      )
    );
    await ingestion.ingest(
      runtimeEvent("session.exited", { recoverable: false, exitKind: "error", reason: "exit 1" })
    );
    assert.deepEqual(sink.types(), [
      "thread.message-sent",
      "thread.message-sent",
      "thread.session-set"
    ]);
    sink.reset();
    // Nothing is left buffered for the dead session.
    await ingestion.drain();
    assert.equal(sink.events().length, 0);
  });

  it("the head SEEDS the session state, so a restart keeps the active turn", async () => {
    const { ingestion, sink } = harness({
      threadContext: () => ({
        session: { status: "running", activeTurnId: "turn-restored" }
      })
    });
    await ingestion.ingest(runtimeEvent("thread.started", { providerThreadId: "p1" }));
    await ingestion.drain();
    const session = sink.ofType("thread.session-set")[0]!.payload.session;
    assert.equal(session.status, "running");
    assert.equal(session.activeTurnId, "turn-restored");
  });

  it("after seeding, ingestion's own memory wins over a head W1 has not applied yet", async () => {
    // The head is written FROM these events. Re-reading a stale one per event
    // would map the next session frame to `ready` and drop the active turn.
    const { ingestion, sink } = harness({
      threadContext: () => ({ session: { status: "idle", activeTurnId: null } })
    });
    await ingestion.ingest(runtimeEvent("turn.started", {}, { turnId: "turn-9" }));
    await ingestion.ingest(runtimeEvent("session.started", {}));
    await ingestion.drain();
    const sessions = sink.ofType("thread.session-set").map((e) => e.payload.session);
    assert.deepEqual(sessions, [{ status: "running", activeTurnId: "turn-9" }]);
  });
});

describe("proposals (§5.1 plan buffer)", () => {
  it("buffers turn.proposed deltas onto one stable row and completes it", async () => {
    const { ingestion, sink } = harness();
    const turn = { turnId: "turn-1" };
    await ingestion.ingest(runtimeEvent("turn.proposed.delta", { delta: "# Plan\n" }, turn));
    await ingestion.ingest(runtimeEvent("turn.proposed.delta", { delta: "- step one\n" }, turn));
    await ingestion.ingest(
      runtimeEvent("turn.proposed.completed", { planMarkdown: "ignored" }, turn)
    );
    await ingestion.drain();
    const rows = sink
      .activities()
      .filter((event) => event.payload.activity.activityKind.startsWith("turn.proposed"));
    const ids = new Set(rows.map((row) => row.payload.activity.id));
    assert.equal(ids.size, 1, "one stable id, so the card is replaced rather than appended to");
    const last = rows.at(-1)!;
    assert.equal(last.payload.activity.activityKind, "turn.proposed.completed");
    assert.equal(
      (last.payload.activity.payload as { planMarkdown: string }).planMarkdown,
      "# Plan\n- step one\n"
    );
  });

  it("plan deltas are BATCHED: a token-by-token plan is not one row per token", async () => {
    const { ingestion, sink, timers } = harness();
    const turn = { turnId: "turn-1" };
    for (let i = 0; i < 40; i += 1) {
      await ingestion.ingest(runtimeEvent("turn.proposed.delta", { delta: `w${i} ` }, turn));
      timers.advance(5);
      await settle();
    }
    await ingestion.drain();
    const rows = sink
      .activities()
      .filter((event) => event.payload.activity.activityKind.startsWith("turn.proposed"));
    assert.ok(rows.length <= 4, `40 plan tokens became ${rows.length} rows`);
    // Every row is the whole accumulation so far, under one stable id.
    assert.equal(new Set(rows.map((row) => row.payload.activity.id)).size, 1);
    assert.ok(
      (rows.at(-1)!.payload.activity.payload as { planMarkdown: string }).planMarkdown.endsWith(
        "w39 "
      )
    );
  });

  it("plan_text content deltas feed the same buffer", async () => {
    const { ingestion, sink } = harness();
    const turn = { turnId: "turn-1" };
    await ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "plan_text", delta: "from content" }, turn)
    );
    await ingestion.ingest(runtimeEvent("turn.proposed.completed", { planMarkdown: "" }, turn));
    await ingestion.drain();
    const last = sink.activities().at(-1)!;
    assert.equal(
      (last.payload.activity.payload as { planMarkdown: string }).planMarkdown,
      "from content"
    );
  });

  it("the completion's markdown stands in when nothing was streamed", async () => {
    const { ingestion, sink } = harness();
    await ingestion.ingest(
      runtimeEvent("turn.proposed.completed", { planMarkdown: "# Whole plan" }, { turnId: "t" })
    );
    await ingestion.drain();
    assert.equal(
      (sink.activities()[0]!.payload.activity.payload as { planMarkdown: string }).planMarkdown,
      "# Whole plan"
    );
  });
});

describe("the placeholder checkpoint (§5.4)", () => {
  it("emits thread.turn-diff-completed when the host resolves a turn count", async () => {
    const { ingestion, sink } = harness({
      placeholderCheckpoint: () => ({ turnCount: 4 })
    });
    await ingestion.ingest(
      runtimeEvent("turn.diff.updated", { unifiedDiff: "diff" }, {
        turnId: "turn-1",
        itemId: "item-1",
        eventId: "ev-9"
      })
    );
    await ingestion.drain();
    const [event] = sink.ofType("thread.turn-diff-completed");
    assert.ok(event);
    assert.equal(event.payload.turnCount, 4);
    assert.equal(event.payload.status, "missing");
    assert.equal(event.payload.ref, "provider-diff:ev-9");
    assert.deepEqual(event.payload.files, []);
  });

  it("emits nothing when the host declines, and nothing when no hook is wired", async () => {
    const declined = harness({ placeholderCheckpoint: () => null });
    await declined.ingestion.ingest(
      runtimeEvent("turn.diff.updated", { unifiedDiff: "d" }, { turnId: "turn-1" })
    );
    await declined.ingestion.drain();
    assert.equal(declined.sink.events().length, 0);

    const unwired = harness();
    await unwired.ingestion.ingest(
      runtimeEvent("turn.diff.updated", { unifiedDiff: "d" }, { turnId: "turn-1" })
    );
    await unwired.ingestion.drain();
    assert.equal(unwired.sink.events().length, 0);
  });
});

describe("fix-wave regressions", () => {
  it("R5 #3: the placeholder checkpoint never synthesises an assistantMessageId", async () => {
    const { ingestion, sink } = harness({ placeholderCheckpoint: () => ({ turnCount: 4 }) });
    // The `itemId` on a turn.diff.updated frame names the DIFF item, so
    // `assistant:<itemId>` used to name a message that never exists — and the
    // fold's `?? turn.assistantMessageId` then made the phantom permanent,
    // because `stampAssistantMessage` only ever fills a null.
    await ingestion.ingest(
      runtimeEvent("turn.diff.updated", { unifiedDiff: "d" }, {
        turnId: "turn-1",
        itemId: "diff-item-1"
      })
    );
    await ingestion.drain();
    assert.equal(
      sink.ofType("thread.turn-diff-completed")[0]?.payload.assistantMessageId,
      null
    );
  });

  it("R5 #3: it DOES carry the turn's real anchor when one is open", async () => {
    const { ingestion, sink } = harness({ placeholderCheckpoint: () => ({ turnCount: 4 }) });
    await ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "assistant_text", delta: "hi" }, {
        turnId: "turn-1",
        itemId: "msg-1"
      })
    );
    await ingestion.ingest(
      runtimeEvent("turn.diff.updated", { unifiedDiff: "d" }, {
        turnId: "turn-1",
        itemId: "diff-item-1"
      })
    );
    await ingestion.drain();
    assert.equal(
      sink.ofType("thread.turn-diff-completed")[0]?.payload.assistantMessageId,
      "assistant:msg-1"
    );
  });

  it("R5 #7: reasoning with NO turn id is buffered, not silently discarded", async () => {
    const { ingestion, sink } = harness();
    // grok streams reasoning before `turn.started`; T3 drops it, §5.1 does not.
    await ingestion.ingest(
      runtimeEvent(
        "content.delta",
        { streamKind: "reasoning_summary_text", delta: "early thought" },
        { itemId: "item-1" }
      )
    );
    await ingestion.flushThread("t1");
    assert.deepEqual(messageTexts(sink), [
      { id: "reasoning:summary:item-1", text: "early thought", streaming: true },
      { id: "reasoning:summary:item-1", text: "", streaming: false }
    ]);
    assert.equal(sink.messages()[0]?.payload.turnId, null);
    assert.equal(sink.messages()[0]?.payload.reasoningKind, "summary");
  });

  it("R5 #8: a proposal streamed by a subagent keeps its agentId", async () => {
    const { ingestion, sink } = harness();
    await ingestion.ingest(
      runtimeEvent("turn.proposed.delta", { delta: "# Plan\n" }, {
        turnId: "turn-1",
        agentId: "agent-7"
      })
    );
    // The completion arrives WITHOUT an agentId; the buffer remembers it.
    await ingestion.ingest(
      runtimeEvent("turn.proposed.completed", { planMarkdown: "" }, { turnId: "turn-1" })
    );
    await ingestion.drain();
    const rows = sink
      .activities()
      .filter((event) => event.payload.activity.activityKind.startsWith("turn.proposed"));
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.equal(row.payload.activity.agentId, "agent-7");
    }
  });

  it("R5 #9: both output streams of ONE item share one buffer and one row", async () => {
    const { ingestion, sink, timers } = harness();
    const item = { turnId: "turn-1", itemId: "call-1" };
    await ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "command_output", delta: "a" }, item)
    );
    await ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "file_change_output", delta: "b" }, item)
    );
    timers.advance(BATCH_INTERVAL_MS);
    await settle();
    const rows = activityOfKind(sink, "tool.output");
    assert.equal(rows.length, 1, "keyed by item id, not by streamKind + item id");
    assert.equal((rows[0]!.payload.activity.payload as { delta: string }).delta, "ab");
  });

  it("R5 #17: every event is stamped with the thread's adapterKey", async () => {
    const { ingestion, sink } = harness({ threadContext: () => ({ adapter: "codex" }) });
    await ingestion.ingest(runtimeEvent("runtime.warning", { message: "hi" }));
    await ingestion.drain();
    assert.equal(sink.events()[0]?.metadata.adapterKey, "codex");
  });

  it("R5 #17: no adapter in context leaves adapterKey absent", async () => {
    const { ingestion, sink } = harness();
    await ingestion.ingest(runtimeEvent("runtime.warning", { message: "hi" }));
    await ingestion.drain();
    assert.equal(sink.events()[0]?.metadata.adapterKey, undefined);
  });

  it("Q1 #9: forget() releases a thread, drops its buffers and clears liveness", async () => {
    const { ingestion, sink, liveness } = harness();
    await ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "assistant_text", delta: "x" }, {
        turnId: "turn-1",
        itemId: "item-1"
      })
    );
    await ingestion.forget("t1");
    assert.deepEqual(liveness.cleared, ["t1"]);
    sink.reset();
    // The buffered text is DROPPED, not flushed: the thread's log is gone.
    await ingestion.drain();
    assert.equal(sink.events().length, 0);
    // Forgetting a thread ingestion never saw is a no-op.
    await ingestion.forget("never-seen");
  });

  it("Q1 #9: a settled turn releases `projected`, so a later bare completion is inert", async () => {
    const { ingestion, sink } = harness();
    const item = { itemId: "item-1" };
    await ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "assistant_text", delta: "turn one" }, {
        ...item,
        turnId: "turn-1"
      })
    );
    await ingestion.ingest(
      runtimeEvent("turn.completed", { state: "completed" }, { turnId: "turn-1" })
    );
    await ingestion.drain();
    sink.reset();
    // A provider that re-uses the item id in a LATER turn and completes it
    // with no text: `projected` used to still hold `assistant:item-1` from
    // turn one, so `streamed` read true and a ghost empty assistant bubble was
    // written. It must now be recognised as "nothing to complete".
    await ingestion.ingest(
      runtimeEvent("item.completed", { itemType: "assistant_message" }, {
        ...item,
        turnId: "turn-2"
      })
    );
    await ingestion.drain();
    assert.deepEqual(messageTexts(sink), []);
  });
});

describe("robustness (§10: never throws on a provider event)", () => {
  it("a malformed payload becomes a runtime.warning activity, not a throw", async () => {
    const { ingestion, sink } = harness();
    const broken = {
      eventId: "ev-bad",
      threadId: "t1",
      createdAt: "2026-09-21T10:00:00.000Z",
      type: "item.updated",
      payload: null
    } as never;
    await ingestion.ingest(broken);
    await ingestion.drain();
    const rows = activityOfKind(sink, "runtime.warning");
    assert.equal(rows.length, 1);
    assert.match(rows[0]!.payload.activity.summary, /could not decode/);
  });

  it("an event with no thread id is logged and dropped, never thrown", async () => {
    const warnings: string[] = [];
    const { ingestion, sink } = harness({ logger: { warn: (m) => warnings.push(m) } });
    await ingestion.ingest({ type: "session.started" } as never);
    assert.equal(sink.events().length, 0);
    assert.equal(warnings.length, 1);
  });

  it("a failing sink never escapes ingest", async () => {
    const warnings: string[] = [];
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    const ingestion = createIngestion({
      sink: async () => {
        throw new Error("disk full");
      },
      liveness: new RecordingLiveness(),
      clock,
      idGen: counterIdGen(),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      slim: (p) => p,
      logger: { warn: (m) => warnings.push(m) }
    });
    await ingestion.ingest(
      runtimeEvent("runtime.warning", { message: "hi" }, { turnId: "turn-1" })
    );
    await ingestion.drain();
    assert.ok(warnings.some((message) => message.includes("sink failed")));
  });

  it("a throwing liveness registry never escapes ingest", async () => {
    const warnings: string[] = [];
    const { ingestion, sink } = harness({
      liveness: {
        observe: () => {
          throw new Error("registry exploded");
        },
        liveness: () => null,
        liveAgentCount: () => 0,
        clear: () => undefined
      },
      logger: { warn: (m) => warnings.push(m) }
    });
    await ingestion.ingest(runtimeEvent("task.started", { taskId: "task-1" }));
    await ingestion.drain();
    assert.ok(warnings.some((message) => message.includes("liveness.observe")));
    assert.equal(activityOfKind(sink, "task.started").length, 1, "the row is still written");
  });
});

describe("ordering", () => {
  it("delivers domain events to the sink in the order they were produced", async () => {
    const { ingestion, sink } = harness();
    const turn = { turnId: "turn-1", itemId: "item-1" };
    await ingestion.ingest(runtimeEvent("turn.started", {}, { turnId: "turn-1" }));
    await ingestion.ingest(
      runtimeEvent("content.delta", { streamKind: "assistant_text", delta: "a\n\n" }, turn)
    );
    await ingestion.ingest(
      runtimeEvent(
        "item.started",
        { itemType: "command_execution", title: "ls" },
        { turnId: "turn-1", itemId: "call-1" }
      )
    );
    await ingestion.ingest(
      runtimeEvent("turn.completed", { state: "completed" }, { turnId: "turn-1" })
    );
    await ingestion.drain();
    assert.deepEqual(
      sink.events().map((event) =>
        event.type === "thread.activity-appended"
          ? event.payload.activity.activityKind
          : event.type
      ),
      [
        "thread.session-set",
        "thread.message-sent",
        "tool.started",
        "thread.message-sent",
        "thread.session-set"
      ]
    );
  });

  it("keeps threads independent", async () => {
    const { ingestion, sink } = harness();
    await ingestion.ingest(
      runtimeEvent("runtime.warning", { message: "one" }, { threadId: "t1" })
    );
    await ingestion.ingest(
      runtimeEvent("runtime.warning", { message: "two" }, { threadId: "t2" })
    );
    await ingestion.drain();
    assert.deepEqual(
      sink.batches.map((batch) => batch.threadId),
      ["t1", "t2"]
    );
  });
});
