/**
 * A session-tool secret split across streamed chunks (design 2026-10-14 §5
 * "Secrets"): ingestion joins assistant deltas and tool output into the rows
 * it writes, and the redactor masks AFTER that join, holding back a tail that
 * could still begin a value — across the 250 ms flush boundary too. Native
 * timer mocks; nothing sleeps.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { SECRET_REDACTED_TEXT } from "@orquester/api/agent-chat";

import { SessionSecretRedactor } from "../session-tools/secret-redaction.ts";
import { createIngestion } from "./index.ts";
import {
  FakeClock,
  RecordingLiveness,
  RecordingSink,
  counterIdGen,
  resetRuntimeEventCounter,
  runtimeEvent,
  settle
} from "./test-harness.ts";

const VALUE = "Zq7-tango-4711-Kx";

function harness() {
  const clock = new FakeClock();
  const sink = new RecordingSink();
  const redactor = new SessionSecretRedactor();
  redactor.remember("t1", [VALUE]);
  const ingestion = createIngestion({
    sink: sink.sink,
    liveness: new RecordingLiveness(),
    clock,
    idGen: counterIdGen(),
    secrets: redactor
  });
  const advance = (ms: number) => {
    clock.advance(ms);
    mock.timers.tick(ms);
  };
  return { ingestion, sink, redactor, advance };
}

const messageText = (sink: RecordingSink) =>
  sink
    .messages()
    .map((event) => event.payload.text)
    .join("");
const outputText = (sink: RecordingSink, toolUseId: string) =>
  sink
    .activities()
    .filter((event) => event.payload.activity.activityKind === "tool.output")
    .map((event) => event.payload.activity.payload as { toolUseId: string; delta: string })
    .filter((payload) => payload.toolUseId === toolUseId)
    .map((payload) => payload.delta)
    .join("");

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout"] });
  resetRuntimeEventCounter();
});
afterEach(() => mock.timers.reset());

describe("streamed text is masked after it is joined", () => {
  it("a value split across two assistant deltas in one flush", async () => {
    const { ingestion, sink } = harness();
    const turn = { turnId: "turn-1", itemId: "item-1" };
    await ingestion.ingest(runtimeEvent("content.delta", { streamKind: "assistant_text", delta: `Using ${VALUE.slice(0, 6)}` }, turn));
    await ingestion.ingest(runtimeEvent("content.delta", { streamKind: "assistant_text", delta: `${VALUE.slice(6)} now.` }, turn));
    await ingestion.ingest(runtimeEvent("turn.completed", { state: "completed" }, turn));
    await ingestion.drain();
    assert.equal(messageText(sink), `Using ${SECRET_REDACTED_TEXT} now.`);
  });

  it("a value split across a flush boundary: the tail waits for the next chunk", async () => {
    const { ingestion, sink, advance } = harness();
    const turn = { turnId: "turn-1", itemId: "item-1" };
    await ingestion.ingest(runtimeEvent("content.delta", { streamKind: "assistant_text", delta: `The key is ${VALUE.slice(0, 9)}` }, turn));
    advance(250);
    await settle();
    // The first flush went out without the tail that could begin the value.
    assert.equal(messageText(sink), "The key is ");
    await ingestion.ingest(runtimeEvent("content.delta", { streamKind: "assistant_text", delta: `${VALUE.slice(9)}, done.` }, turn));
    advance(250);
    await settle();
    await ingestion.ingest(runtimeEvent("turn.completed", { state: "completed" }, turn));
    await ingestion.drain();
    const all = messageText(sink);
    assert.ok(!all.includes(VALUE));
    assert.equal(all, `The key is ${SECRET_REDACTED_TEXT}, done.`);
    assert.ok(!JSON.stringify(sink.batches).includes(VALUE));
  });

  it("a held tail that turns out not to be the value is released at the message's end", async () => {
    const { ingestion, sink, advance } = harness();
    const turn = { turnId: "turn-1", itemId: "item-1" };
    await ingestion.ingest(runtimeEvent("content.delta", { streamKind: "assistant_text", delta: "ends with Zq7" }, turn));
    advance(250);
    await settle();
    await ingestion.ingest(runtimeEvent("turn.completed", { state: "completed" }, turn));
    await ingestion.drain();
    assert.equal(messageText(sink), "ends with Zq7");
    const last = sink.messages().at(-1)!;
    assert.equal(last.payload.streaming, false, "the closing row still comes last");
  });

  it("a value split across two tool.output chunks, across a flush", async () => {
    const { ingestion, sink, advance } = harness();
    const call = { turnId: "turn-1", itemId: "call-1" };
    await ingestion.ingest(runtimeEvent("item.started", { itemType: "command_execution", status: "inProgress", data: { command: "env" } }, call));
    await ingestion.ingest(runtimeEvent("content.delta", { streamKind: "command_output", delta: `TOKEN=${VALUE.slice(0, 5)}` }, call));
    advance(250);
    await settle();
    await ingestion.ingest(runtimeEvent("content.delta", { streamKind: "command_output", delta: `${VALUE.slice(5)}\nHOME=/x\n` }, call));
    advance(250);
    await settle();
    await ingestion.ingest(runtimeEvent("item.completed", { itemType: "command_execution", status: "completed", data: { command: "env" } }, call));
    await ingestion.drain();
    assert.equal(outputText(sink, "call-1"), `TOKEN=${SECRET_REDACTED_TEXT}\nHOME=/x\n`);
    assert.ok(!JSON.stringify(sink.batches).includes(VALUE));
  });

  it("a tool's held tail is released when its call ends", async () => {
    const { ingestion, sink, advance } = harness();
    const call = { turnId: "turn-1", itemId: "call-3" };
    await ingestion.ingest(runtimeEvent("content.delta", { streamKind: "command_output", delta: "tail Zq7" }, call));
    advance(250);
    await settle();
    await ingestion.ingest(runtimeEvent("item.completed", { itemType: "command_execution", status: "completed", data: {} }, call));
    await ingestion.drain();
    assert.equal(outputText(sink, "call-3"), "tail Zq7");
    const kinds = sink.activities().map((event) => event.payload.activity.activityKind);
    assert.ok(kinds.lastIndexOf("tool.output") < kinds.lastIndexOf("tool.completed"), "released before the call's closing row");
  });

  it("a tool's held tail is released at the thread's flush", async () => {
    const { ingestion, sink, advance } = harness();
    const call = { turnId: "turn-1", itemId: "call-2" };
    await ingestion.ingest(runtimeEvent("content.delta", { streamKind: "command_output", delta: "last bytes Zq7-t" }, call));
    advance(250);
    await settle();
    assert.equal(outputText(sink, "call-2"), "last bytes ", "the tail is held");
    await ingestion.flushThread("t1");
    await ingestion.drain();
    assert.equal(outputText(sink, "call-2"), "last bytes Zq7-t", "released, nothing lost");
  });

  it("a value split across two stream kinds of one call is still one value", async () => {
    const { ingestion, sink, advance } = harness();
    const call = { turnId: "turn-1", itemId: "call-two-kinds" };
    await ingestion.ingest(runtimeEvent("item.started", { itemType: "command_execution", status: "inProgress", data: {} }, call));
    await ingestion.ingest(runtimeEvent("content.delta", { streamKind: "command_output", delta: `TOKEN=${VALUE.slice(0, 7)}` }, call));
    advance(250);
    await settle();
    await ingestion.ingest(runtimeEvent("content.delta", { streamKind: "file_change_output", delta: `${VALUE.slice(7)}\n` }, call));
    advance(250);
    await settle();
    await ingestion.ingest(runtimeEvent("item.completed", { itemType: "command_execution", status: "completed", data: {} }, call));
    await ingestion.drain();
    assert.equal(outputText(sink, call.itemId), `TOKEN=${SECRET_REDACTED_TEXT}\n`);
    assert.ok(!JSON.stringify(sink.batches).includes(VALUE.slice(7)), "neither half went out in clear");
  });

  // A running call's own rows land between its output chunks: OpenCode sends
  // an `item.updated` per running frame, Codex a `patchUpdated` (file change)
  // update, Grok an `item.updated` per running `tool_call_update`, and a
  // Claude subagent's call a `tool.progress` heartbeat (`tool_progress`, its
  // `taskId` the owning agent — the only progress ingestion writes a row
  // for). None of them ends the stream, so none may release the held tail.
  const interleavings = [
    { provider: "opencode", itemType: "command_execution" as const, streamKind: "command_output" as const, progress: false },
    { provider: "codex", itemType: "file_change" as const, streamKind: "file_change_output" as const, progress: false },
    { provider: "claude", itemType: "command_execution" as const, streamKind: "command_output" as const, progress: true }
  ];
  for (const shape of interleavings) {
    it(`${shape.provider}: running-call rows between two chunks do not release the tail`, async () => {
      const { ingestion, sink, advance } = harness();
      const call = { turnId: "turn-1", itemId: `call-${shape.provider}` };
      const running = () =>
        runtimeEvent("item.updated", { itemType: shape.itemType, status: "inProgress", data: { note: "running" } }, call);
      await ingestion.ingest(runtimeEvent("item.started", { itemType: shape.itemType, status: "inProgress", data: {} }, call));
      await ingestion.ingest(runtimeEvent("content.delta", { streamKind: shape.streamKind, delta: `TOKEN=${VALUE.slice(0, 6)}` }, call));
      // The running row reaches the outbox at once; the chunk waits in the 250 ms buffer.
      await ingestion.ingest(running());
      if (shape.progress) {
        await ingestion.ingest(
          runtimeEvent("tool.progress", { toolUseId: call.itemId, toolName: "Bash", elapsedSeconds: 1, taskId: "agent-1" }, call)
        );
      }
      advance(250);
      await settle();
      await ingestion.ingest(running());
      await ingestion.ingest(runtimeEvent("content.delta", { streamKind: shape.streamKind, delta: `${VALUE.slice(6)}\n` }, call));
      advance(250);
      await settle();
      await ingestion.ingest(running());
      await ingestion.ingest(runtimeEvent("item.completed", { itemType: shape.itemType, status: "completed", data: {} }, call));
      await ingestion.drain();
      assert.ok(!JSON.stringify(sink.batches).includes(VALUE), "the value never went out in clear");
      assert.equal(outputText(sink, call.itemId), `TOKEN=${SECRET_REDACTED_TEXT}\n`);
      if (shape.progress) {
        assert.ok(
          sink.activities().some((event) => event.payload.activity.activityKind === "tool.progress"),
          "the heartbeat row was written between the chunks"
        );
      }
    });
  }

  it("the host's teardown (a final drain) releases a held tail; an ordinary drain does not", async () => {
    const { ingestion, sink, advance } = harness();
    const call = { turnId: "turn-1", itemId: "call-t" };
    await ingestion.ingest(runtimeEvent("content.delta", { streamKind: "command_output", delta: "end Zq7-ta" }, call));
    advance(250);
    await settle();
    await ingestion.drain();
    assert.equal(outputText(sink, "call-t"), "end ", "a mid-turn drain is a sync point, not the stream's end");
    await ingestion.drain({ final: true });
    assert.equal(outputText(sink, "call-t"), "end Zq7-ta");
  });

  it("a thread without a remembered value streams untouched", async () => {
    const { ingestion, sink, redactor } = harness();
    redactor.forget("t1");
    const turn = { turnId: "turn-1", itemId: "item-1" };
    await ingestion.ingest(runtimeEvent("content.delta", { streamKind: "assistant_text", delta: `x ${VALUE.slice(0, 9)}` }, turn));
    await ingestion.ingest(runtimeEvent("turn.completed", { state: "completed" }, turn));
    await ingestion.drain();
    assert.equal(messageText(sink), `x ${VALUE.slice(0, 9)}`);
  });
});
