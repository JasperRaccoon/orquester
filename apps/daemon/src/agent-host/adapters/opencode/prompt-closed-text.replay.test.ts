/**
 * Regression: a text part that a prompt closes BEFORE its closing snapshot
 * renders once — replayed from a committed capture through the real
 * normaliser, the real ingestion and the real fold.
 *
 * With OpenRouter models OpenCode flushes a part's closing `time.end` snapshot
 * after the tool call that follows it, so that tool's ask lands first: fixture
 * 05 records the pre-tool block's closing snapshot AFTER `question.asked`. The
 * ask finalised the message, and the snapshot's `item.completed` then appended
 * the whole text again — the bubble read twice. Fixture 05's pre-tool block is
 * `reasoning`; ONE field (`part.type` → `"text"`) turns it into the commentary
 * this happens to, with every frame and its order untouched.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  applyDomainEvent,
  createEmptyThreadState,
  type DomainEvent,
  type ThreadMessageItem
} from "@orquester/api/agent-chat";

import { createIngestion } from "../../ingestion/index.ts";
import {
  FakeClock,
  FakeTimers,
  RecordingLiveness,
  RecordingSink,
  counterIdGen,
  runtimeEvent
} from "../../ingestion/test-harness.ts";
import { normalizeOpenCodeEvent } from "./normalize.ts";
import { asRawEvent } from "./protocol.ts";
import { createSessionState, makeTurnTokenUsageAccumulator } from "./state.ts";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../test/fixtures/opencode/05-question-asked-reply-and-reject.ndjson"
);

interface FixtureRecord {
  t: number;
  kind: "sse" | "http" | "stdout" | "note";
  data: unknown;
}

interface HttpRecord {
  method: string;
  path: string;
  responseBody?: unknown;
}

interface PartFrame {
  type: string;
  properties: {
    part: { id: string; type: string; text?: string; time?: { end?: number } };
  };
}

function partFrame(record: FixtureRecord): PartFrame | undefined {
  if (record.kind !== "sse") {
    return undefined;
  }
  const frame = record.data as PartFrame;
  return frame.type === "message.part.updated" ? frame : undefined;
}

test("fixture 05: commentary closed by the question ask folds to its text exactly once", async () => {
  const records = readFileSync(FIXTURE, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FixtureRecord);
  const parent = records
    .filter((record) => record.kind === "http")
    .map((record) => record.data as HttpRecord)
    .find((http) => http.method === "POST" && /^\/session(\?|$)/.test(http.path))
    ?.responseBody as { id: string };
  const preToolPartId = records
    .map(partFrame)
    .find((frame) => frame?.properties.part.type === "reasoning")!.properties.part.id;

  const mutated = records.map((record) => {
    if (partFrame(record)?.properties.part.id !== preToolPartId) {
      return record;
    }
    const copy = structuredClone(record);
    (copy.data as PartFrame).properties.part.type = "text";
    return copy;
  });
  const closingIndex = mutated.findIndex(
    (record) =>
      partFrame(record)?.properties.part.id === preToolPartId &&
      partFrame(record)?.properties.part.time?.end !== undefined
  );
  const askIndex = mutated.findIndex(
    (record) => record.kind === "sse" && (record.data as { type: string }).type === "question.asked"
  );
  assert.ok(
    askIndex !== -1 && askIndex < closingIndex,
    "the capture's own order: the ask lands before the pre-tool part's closing snapshot"
  );
  const closingText = partFrame(mutated[closingIndex]!)!.properties.part.text!;

  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const sink = new RecordingSink();
  const ingestion = createIngestion({
    sink: sink.sink,
    liveness: new RecordingLiveness(),
    clock,
    idGen: counterIdGen(),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  });
  const state = createSessionState({
    threadId: "t1",
    openCodeSessionId: parent.id,
    directory: "/repo",
    runtimeMode: "approval-required"
  });
  let counter = 0;
  const ctx = { eventId: () => `evt-${(counter += 1)}`, nowIso: () => clock.nowIso() };
  let turnSeq = 0;

  // The runtime's half, as in `normalize.replay.test.ts`: a submitted prompt
  // opens a turn, the first idle signal settles it.
  for (const record of mutated) {
    clock.advance(1);
    if (record.kind === "http") {
      const http = record.data as HttpRecord;
      if (http.method === "POST" && http.path.includes("/prompt_async") && http.path.includes(parent.id)) {
        turnSeq += 1;
        state.activeTurnId = `turn-${turnSeq}`;
        state.promptGeneration += 1;
        state.turnTokenUsage = makeTurnTokenUsageAccumulator();
        await ingestion.ingest(runtimeEvent("turn.started", {}, { turnId: state.activeTurnId }));
      }
      continue;
    }
    const raw = record.kind === "sse" ? asRawEvent(record.data) : null;
    if (raw === null) {
      continue;
    }
    const result = normalizeOpenCodeEvent(state, raw, ctx);
    for (const event of result.events) {
      await ingestion.ingest(event);
    }
    for (const signal of result.signals) {
      if (
        (signal.kind === "status-idle" || signal.kind === "session-idle") &&
        state.activeTurnId !== undefined
      ) {
        const turnId = state.activeTurnId;
        state.activeTurnId = undefined;
        state.turnTokenUsage = undefined;
        await ingestion.ingest(runtimeEvent("turn.completed", { state: "completed" }, { turnId }));
      }
    }
  }
  await ingestion.drain();

  const created: DomainEvent = {
    seq: 1,
    eventId: "created",
    threadId: "t1",
    occurredAt: "2026-09-21T09:59:00.000Z",
    commandId: null,
    causationEventId: null,
    metadata: {},
    type: "thread.created",
    payload: {
      projectPath: "/repo",
      cwd: "/repo",
      title: "New thread",
      adapter: "opencode",
      refId: "opencode",
      accountId: "acc1",
      home: "system",
      modelSelection: { model: "openrouter/google/gemini-3.1-flash-lite" },
      runtimeMode: "approval-required"
    }
  };
  let folded = applyDomainEvent(createEmptyThreadState(), created);
  let seq = 1;
  for (const event of sink.events()) {
    seq += 1;
    folded = applyDomainEvent(folded, { ...event, seq } as DomainEvent);
  }
  const assistant = folded.items.filter(
    (item): item is ThreadMessageItem => item.kind === "message" && item.role === "assistant"
  );

  assert.equal(assistant.length, 2, "the commentary and the answer, nothing else");
  assert.equal(assistant[0]!.id, `assistant:${preToolPartId}`);
  assert.equal(
    assistant[0]!.text,
    closingText,
    "the commentary holds its text exactly once, not the snapshot appended again"
  );
  assert.equal(assistant[0]!.streaming, false);
  assert.notEqual(assistant[1]!.id, assistant[0]!.id, "the answer stays the turn's last message");
});
