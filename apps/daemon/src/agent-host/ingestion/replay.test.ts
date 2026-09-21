/**
 * Replay against a REAL protocol capture (§9).
 *
 * `apps/daemon/test/fixtures/claude/03-bash-approval-accept.ndjson` is a
 * verbatim recording of `claude 2.1.210` / `@anthropic-ai/claude-agent-sdk
 * 0.3.278` running one Bash turn through the approval callback. The Claude
 * adapter (W6) owns the real frame → {@link RuntimeEvent} mapping; until it
 * lands, {@link mapClaudeCapture} below is a **deliberately narrow hand
 * mapping** of exactly the frame kinds this capture contains, written from the
 * fixture's own bytes. It exists so the §5.1/§5.6 rules are exercised against
 * real provider timing — the token-by-token `input_json_delta` flood, the three
 * identical `system/status` frames per turn, the approval arriving after the
 * assistant has already produced text — rather than only against hand-built
 * events.
 *
 * When W6 lands, the mapper here should be replaced by the adapter's own
 * normaliser reading the same file.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import type { RuntimeEvent } from "@orquester/api/agent-chat";

import type { AppendableDomainEvent } from "../services.ts";
import { createIngestion } from "./index.ts";
import {
  FakeClock,
  FakeTimers,
  RecordingLiveness,
  RecordingSink,
  counterIdGen
} from "./test-harness.ts";

const FIXTURE = new URL(
  "../../../test/fixtures/claude/03-bash-approval-accept.ndjson",
  import.meta.url
);

interface CaptureFrame {
  t: number;
  kind: string;
  data: Record<string, unknown>;
}

function readCapture(): CaptureFrame[] {
  return readFileSync(FIXTURE, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CaptureFrame);
}

const THREAD_ID = "thread-claude-03";
const TURN_ID = "turn-1";

/**
 * The narrow hand mapping described in the file comment. Only the frame kinds
 * this capture actually contains are handled; anything else is ignored, which
 * is exactly what a stand-in should do.
 */
function mapClaudeCapture(frames: CaptureFrame[]): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  let seq = 0;
  const base = (): { eventId: string; threadId: string; createdAt: string; turnId: string } => ({
    eventId: `claude-${++seq}`,
    threadId: THREAD_ID,
    createdAt: new Date(Date.UTC(2026, 8, 21, 10, 0, 0) + seq).toISOString(),
    turnId: TURN_ID
  });
  let openToolId: string | null = null;

  for (const frame of frames) {
    const data = frame.data;
    if (frame.kind === "note") {
      continue;
    }
    if (frame.kind === "input") {
      events.push({ ...base(), type: "turn.started", payload: { model: "claude-sonnet-5" } });
      continue;
    }
    if (frame.kind === "canUseTool") {
      events.push({
        ...base(),
        requestId: "req-canUseTool-1",
        type: "request.opened",
        payload: {
          requestType: "command_execution_approval",
          // Every native-callback approval is non-dismissible (§4.2).
          dismissible: false,
          detail: String(
            (data.input as { command?: string } | undefined)?.command ?? "(no command)"
          )
        }
      });
      continue;
    }
    if (frame.kind === "canUseToolResult") {
      events.push({
        ...base(),
        requestId: "req-canUseTool-1",
        type: "request.resolved",
        payload: { requestType: "command_execution_approval", decision: "accept" }
      });
      continue;
    }
    if (frame.kind !== "sdk-message") {
      continue;
    }
    const type = data.type as string;
    if (type === "system" && data.subtype === "status") {
      // ~3 per turn, only ever "requesting" on this CLI.
      events.push({
        ...base(),
        type: "session.state.changed",
        payload: { state: "running" }
      });
      continue;
    }
    if (type === "system" && data.subtype === "init") {
      events.push({
        ...base(),
        type: "thread.started",
        payload: { providerThreadId: String(data.session_id) }
      });
      continue;
    }
    if (type === "stream_event") {
      const streamEvent = data.event as Record<string, unknown>;
      const streamType = streamEvent.type as string;
      if (streamType === "content_block_delta") {
        const delta = streamEvent.delta as Record<string, unknown>;
        if (delta.type === "text_delta") {
          events.push({
            ...base(),
            itemId: "msg-2",
            type: "content.delta",
            payload: { streamKind: "assistant_text", delta: String(delta.text) }
          });
        } else if (delta.type === "thinking_delta" && String(delta.thinking ?? "").length > 0) {
          events.push({
            ...base(),
            itemId: "msg-1",
            type: "content.delta",
            payload: {
              streamKind: "reasoning_summary_text",
              delta: String(delta.thinking)
            }
          });
        }
        // `input_json_delta` is the tool's own arguments streaming in; it is
        // not renderable content and produces no runtime event.
        continue;
      }
      if (streamType === "content_block_start") {
        const block = streamEvent.content_block as Record<string, unknown>;
        if (block.type === "tool_use") {
          openToolId = String(block.id);
          events.push({
            ...base(),
            itemId: openToolId,
            type: "item.started",
            payload: {
              itemType: "command_execution",
              status: "inProgress",
              title: String(block.name)
            }
          });
        }
        continue;
      }
      continue;
    }
    if (type === "user") {
      const content = (data.message as { content?: unknown })?.content;
      if (Array.isArray(content)) {
        for (const part of content as Record<string, unknown>[]) {
          if (part.type === "tool_result" && openToolId !== null) {
            events.push({
              ...base(),
              itemId: String(part.tool_use_id ?? openToolId),
              type: "item.completed",
              payload: {
                itemType: "command_execution",
                status: part.is_error === true ? "failed" : "completed",
                title: "Bash",
                data: part.content
              }
            });
            openToolId = null;
          }
        }
      }
      continue;
    }
    if (type === "result") {
      const usage = data.usage as Record<string, number> | undefined;
      events.push({
        ...base(),
        type: "thread.token-usage.updated",
        payload: {
          usage: {
            usedTokens: Number(usage?.input_tokens ?? 0) + Number(usage?.output_tokens ?? 0)
          }
        }
      });
      events.push({
        ...base(),
        type: "turn.completed",
        payload: {
          state: data.is_error === true ? "failed" : "completed",
          tokenUsage: {
            usageScope: "main_agent",
            usageStatus: "complete",
            inputTokens: Number(usage?.input_tokens ?? 0),
            outputTokens: Number(usage?.output_tokens ?? 0),
            hasSubagents: false
          }
        }
      });
      continue;
    }
  }
  return events;
}

function shape(events: AppendableDomainEvent[]): string[] {
  return events.map((event) => {
    if (event.type === "thread.activity-appended") {
      return `activity:${event.payload.activity.activityKind}`;
    }
    if (event.type === "thread.message-sent") {
      return `message:${event.payload.role}:${event.payload.streaming ? "delta" : "complete"}`;
    }
    if (event.type === "thread.session-set") {
      return `session:${event.payload.session.status}`;
    }
    return event.type;
  });
}

describe("replay: claude 03-bash-approval-accept (real capture)", () => {
  it("the fixture still has the frames this mapping was written against", () => {
    const frames = readCapture();
    const kinds = new Set(frames.map((frame) => frame.kind));
    assert.ok(kinds.has("canUseTool"), "the approval callback frame is gone from the fixture");
    assert.ok(kinds.has("canUseToolResult"));
    const statusFrames = frames.filter(
      (frame) => frame.data?.type === "system" && frame.data?.subtype === "status"
    );
    assert.ok(
      statusFrames.length >= 2,
      "the repeated system/status frames the dedupe rule exists for are gone"
    );
    const inputJsonDeltas = frames.filter((frame) => {
      const event = frame.data?.event as { delta?: { type?: string } } | undefined;
      return event?.delta?.type === "input_json_delta";
    });
    assert.ok(inputJsonDeltas.length > 3, "the token flood this batches is gone");
  });

  it("normalises the whole turn into the §5.1 domain shape", async () => {
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

    for (const event of mapClaudeCapture(readCapture())) {
      await ingestion.ingest(event);
    }
    await ingestion.drain();

    assert.deepEqual(shape(sink.events()), [
      // turn.started
      "session:running",
      // system/init -> thread.started; the session is already running, so the
      // only new fact is the provider thread id.
      "session:running",
      // three identical system/status frames collapse into nothing further
      // the tool call opens…
      "activity:tool.started",
      // …and the approval arrives. §5.6: a request.opened flushes and
      // finalises the turn's buffered text BEFORE the approval row.
      "activity:approval.requested",
      "activity:approval.resolved",
      "activity:tool.completed",
      // The final "Done." never reaches a paragraph boundary and the turn ends
      // inside the 250 ms window, so it is delivered by the turn-end flush —
      // after the usage row the provider sent first, and still BEFORE the
      // session row that settles the turn.
      "activity:context-window.updated",
      "message:assistant:delta",
      "message:assistant:complete",
      "session:ready"
    ]);
  });

  it("the repeated system/status frames write exactly one session row", async () => {
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
    for (const event of mapClaudeCapture(readCapture())) {
      await ingestion.ingest(event);
    }
    await ingestion.drain();
    const statuses = sink.ofType("thread.session-set").map((e) => e.payload.session.status);
    assert.deepEqual(statuses, ["running", "running", "ready"]);
  });

  it("the tool call keeps ONE stable toolUseId across its lifecycle", async () => {
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
    for (const event of mapClaudeCapture(readCapture())) {
      await ingestion.ingest(event);
    }
    await ingestion.drain();
    const toolRows = sink
      .activities()
      .filter((event) => event.payload.activity.activityKind.startsWith("tool."))
      .map((event) => (event.payload.activity.payload as { toolUseId?: string }).toolUseId);
    assert.equal(toolRows.length, 2);
    assert.equal(toolRows[0], "toolu_01PAyGGZivdMxWBKbRjnyRi8");
    assert.equal(toolRows[1], toolRows[0]);
  });
});
