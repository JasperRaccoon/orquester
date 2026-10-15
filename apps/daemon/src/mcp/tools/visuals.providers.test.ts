/**
 * `html_render` and `html_preview` through every provider (design 2026-10-14
 * §1.5, §2.1, §2.5; ported from `session-tools/html/providers.test.ts` to the
 * unified catalog, design 2026-10-15 §4): the catalog tool's REAL result, as
 * THE executor answers a chat caller, carried in each provider's
 * own recorded frame shape, through the adapter's normaliser and the host's
 * ingestion (with the chat catalog's names, as the host passes its tool
 * names) to the rows `events.ndjson` persists and the wire carries.
 *
 * An `html_render` row is a `visual` row exactly when
 * `htmlRenderReferenceOfActivityPayload` reads its reference — the UI's
 * `entries.logic.ts` emits the visual row from that reader alone.
 *
 * Frames are the providers' recorded ones with the tool swapped in:
 * - Claude: `test/fixtures/claude/02-tool-read-auto-allowed.ndjson`, its
 *   `Read` call renamed `mcp__orquester__…` and its `tool_result` replaced by
 *   what the CLI makes of an MCP result (text blocks; an image as a base64
 *   `source`, per the CLI's own MCP-content mapping);
 * - Codex: `test/fixtures/codex/15-mcp-elicitation-approval.ndjson`'s
 *   `serena` `mcpToolCall` started/completed pair, server `orquester`;
 * - OpenCode: `test/fixtures/opencode/03-permission-ask-reply-once.ndjson`'s
 *   tool part lifecycle, the tool `orquester-<16 hex>_…` with OpenCode's MCP
 *   result mapping (text joined into `output`, images as data-URL
 *   `attachments`, from the 1.18.34 bundle);
 * - Grok: `test/fixtures/grok/32-mcp-use-tool-call.ndjson`'s `use_tool`
 *   call — `use_tool` start, the `UseTool` update, and the end
 *   `rawOutput {type: "MCP", output: {OkayOutput}}` with NO ACP `content`,
 *   `OkayOutput` being the result text, a newline, and the structured JSON.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  htmlRenderReferenceOfActivityPayload,
  sessionToolNameOfData,
  slimActivityPayload,
  type HtmlRenderReference,
  type RuntimeEvent
} from "@orquester/api/agent-chat";

import { countingIds, fixedClock, readClaudeFixture } from "../../agent-host/adapters/claude/fixtures.ts";
import { ClaudeNormalizer } from "../../agent-host/adapters/claude/normalize.ts";
import { CodexNormaliser } from "../../agent-host/adapters/codex/normalise.ts";
import { CodexUsageTracker } from "../../agent-host/adapters/codex/usage.ts";
import type { SessionNotification } from "../../agent-host/adapters/grok/acp/_generated/schema.ts";
import { agentFrames, readCapture } from "../../agent-host/adapters/grok/fixtures.ts";
import { GrokNormalizer } from "../../agent-host/adapters/grok/normalize.ts";
import { normalizeOpenCodeEvent } from "../../agent-host/adapters/opencode/normalize.ts";
import { asRawEvent } from "../../agent-host/adapters/opencode/protocol.ts";
import { openCodeSessionToolsServerName } from "../../agent-host/adapters/opencode/session-tools.ts";
import { createSessionState } from "../../agent-host/adapters/opencode/state.ts";
import { createIngestion } from "../../agent-host/ingestion/index.ts";
import { FakeClock, RecordingLiveness, RecordingSink, counterIdGen } from "../../agent-host/ingestion/test-harness.ts";
import type { ThreadCaller } from "../catalog/contract.ts";
import { catalogFor } from "../catalog/index.ts";
import { executeToolCall } from "../executor.ts";
import { FakeDaemonApi } from "../testing.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../test/fixtures");
const THREAD = "thread-1";

const REFERENCE: HtmlRenderReference = {
  attachmentId: "thread_1-0f8fad5b-d9cb-469f-a165-70867728950e-html",
  title: "Revenue by quarter",
  height: 420,
  heights: [
    [320, 610],
    [728, 420],
    [1144, 380]
  ]
};
const RENDER_ARGS = { html: "<!doctype html><p>chart</p>", title: REFERENCE.title, height: 420 };
const PREVIEW_ARGS = { html: "<!doctype html><p>chart</p>", width: 728 };
// A screenshot-sized PNG payload (≈300 KB decoded).
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAtgAAAEs".padEnd(400_000, "Q");

/** The catalog tools' own answers, through the executor. */
async function toolResults(): Promise<{ render: CallToolResult; preview: CallToolResult }> {
  const api = new FakeDaemonApi()
    .onPublishHtml(() => ({ ok: true, value: REFERENCE }))
    .onPreviewHtml(() => ({
      ok: true,
      value: { screenshot: { data: PNG, mimeType: "image/png", width: 728, height: 300 }, width: 728, contentHeight: 300, capturedHeight: 300, consoleMessages: [{ level: "log", text: "ready" }] }
    }));
  const caller: ThreadCaller = {
    kind: "thread", threadId: THREAD, title: "Charts", projectPath: "", workspace: "", cwd: "/w/ws/p", agentId: "claude", callId: "c",
    runtimeMode: "approval-required", planning: false, workflowOwned: false, exchange: null
  };
  const env = { caller, api, signal: new AbortController().signal };
  const deps = { approvals: null, enabledToolsets: async () => new Set(["core"]) };
  const render = await executeToolCall(deps, { name: "html_render", arguments: RENDER_ARGS }, env);
  const preview = await executeToolCall(deps, { name: "html_preview", arguments: PREVIEW_ARGS }, env);
  assert.equal(render.isError, undefined);
  assert.equal(preview.isError, undefined);
  return { render, preview };
}

const textOf = (result: CallToolResult): string =>
  result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");

/** Ingest runtime events as the host does, and answer the persisted rows of `itemId`. */
async function ingest(events: readonly RuntimeEvent[], itemId: string) {
  const sink = new RecordingSink();
  const ingestion = createIngestion({
    sink: sink.sink,
    liveness: new RecordingLiveness(),
    clock: new FakeClock(),
    idGen: counterIdGen(),
    sessionToolNames: new Set(catalogFor("chat").map((tool) => tool.name))
  });
  for (const event of events) await ingestion.ingest(event);
  await ingestion.drain();
  const rows = sink
    .activities()
    .map((event) => event.payload.activity)
    .filter((activity) => (activity.payload as { toolUseId?: unknown }).toolUseId === itemId);
  assert.ok(rows.length > 0, `no row for ${itemId}`);
  const completed = rows.find((row) => row.activityKind === "tool.completed");
  assert.ok(completed, `no tool.completed for ${itemId}: ${rows.map((row) => row.activityKind)}`);
  return { rows, completed };
}

/** The persisted render row reads the reference, and so does the wire's slim of it (twice). */
function assertVisual(rows: Awaited<ReturnType<typeof ingest>>): void {
  for (const row of rows.rows) {
    assert.equal((row.payload as { itemType?: unknown }).itemType, "mcp_tool_call", row.activityKind);
    assert.equal(sessionToolNameOfData((row.payload as { data?: unknown }).data), "html_render", row.activityKind);
  }
  const payload = rows.completed.payload;
  assert.equal((payload as { status?: unknown }).status, "completed");
  assert.deepEqual(htmlRenderReferenceOfActivityPayload(payload), REFERENCE);
  const wire = slimActivityPayload(payload);
  assert.deepEqual(htmlRenderReferenceOfActivityPayload(wire), REFERENCE);
  assert.deepEqual(htmlRenderReferenceOfActivityPayload(slimActivityPayload(wire)), REFERENCE);
}

/** No persisted preview row holds the screenshot, every one stays small, and the measurements stay. */
function assertNoScreenshot(rows: Awaited<ReturnType<typeof ingest>>): void {
  for (const row of rows.rows) {
    const json = JSON.stringify(row.payload);
    assert.ok(!json.includes(PNG.slice(0, 1000)), `${row.activityKind} persisted the PNG`);
    assert.ok(json.length < 20_000, `${row.activityKind}: ${json.length} bytes`);
    assert.equal(sessionToolNameOfData((row.payload as { data?: unknown }).data), "html_preview");
  }
  assert.ok(JSON.stringify(rows.completed.payload).includes("contentHeight"), "the measurements stay");
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

/** What the Claude CLI makes of an MCP result in its `tool_result` block. */
function claudeContent(result: CallToolResult): unknown[] {
  return result.content.map((block) =>
    block.type === "image"
      ? { type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } }
      : { type: "text", text: (block as { text: string }).text }
  );
}

function claudeEvents(tool: string, args: Record<string, unknown>, result: CallToolResult): RuntimeEvent[] {
  const READ_ID = "toolu_01FBhJ4wLVN7hz7KLvfUhams";
  const lines = readClaudeFixture("02-tool-read-auto-allowed.ndjson");
  const normalizer = new ClaudeNormalizer({ threadId: THREAD, clock: fixedClock(), ids: countingIds() });
  const events: RuntimeEvent[] = [];
  let readBlockIndex: number | undefined;
  let fedInput = false;
  for (const line of lines) {
    if (line.kind === "input") {
      const turnId = (line.data as { uuid: string }).uuid;
      events.push(...normalizer.beginTurn({ turnId, anchorUuid: turnId }));
      continue;
    }
    if (line.kind !== "sdk-message") continue;
    const message = structuredClone(line.data) as Record<string, any>;
    if (message.type === "stream_event") {
      const event = message.event;
      if (event.type === "content_block_start" && event.content_block?.id === READ_ID) {
        event.content_block.name = tool;
        readBlockIndex = event.index;
      } else if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta" && event.index === readBlockIndex) {
        // The call's whole input streams as one delta.
        if (fedInput) continue;
        event.delta.partial_json = JSON.stringify(args);
        fedInput = true;
      } else if (event.type === "content_block_stop" && event.index === readBlockIndex) {
        readBlockIndex = undefined;
      }
    } else if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "tool_use" && block.id === READ_ID) {
          block.name = tool;
          block.input = args;
        }
      }
    } else if (message.type === "user") {
      for (const block of message.message.content) {
        if (block.type === "tool_result" && block.tool_use_id === READ_ID) {
          block.content = claudeContent(result);
          message.tool_use_result = claudeContent(result);
        }
      }
    }
    events.push(...normalizer.handleMessage(message as SDKMessage));
  }
  return events;
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

function codexEvents(tool: string, args: Record<string, unknown>, result: CallToolResult): RuntimeEvent[] {
  const CALL = "call_RQtUSyd2ORQJwZCCcjYZWCMV";
  const normaliser = new CodexNormaliser({ usage: new CodexUsageTracker() });
  const events: RuntimeEvent[] = [];
  let n = 0;
  for (const line of readFileSync(join(FIXTURES, "codex/15-mcp-elicitation-approval.ndjson"), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as { dir: string; frame: { id?: unknown; method?: string; params?: any } };
    const frame = record.frame;
    if (record.dir !== "recv" || frame.method === undefined || (frame.id !== undefined && frame.id !== null)) continue;
    const item = frame.params?.item;
    // The turn and this one call; the fixture's other items stay out.
    if (item !== undefined && item.id !== CALL) continue;
    if (!["turn/started", "item/started", "item/completed", "turn/completed"].includes(frame.method)) continue;
    const params = structuredClone(frame.params);
    if (params.item) {
      params.item.server = "orquester";
      params.item.tool = tool;
      params.item.arguments = args;
      if (frame.method === "item/completed") params.item.result = { ...result, _meta: null };
    }
    for (const draft of normaliser.notification(frame.method as never, params)) {
      events.push({ ...draft, eventId: `cx-${++n}`, threadId: THREAD, createdAt: "2026-09-21T00:00:00.000Z" } as RuntimeEvent);
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// OpenCode
// ---------------------------------------------------------------------------

/** OpenCode's MCP result mapping: text joined into `output`, images as data-URL attachments. */
function openCodeState(result: CallToolResult): Record<string, unknown> {
  const attachments = result.content.flatMap((block) =>
    block.type === "image" ? [{ type: "file", mime: block.mimeType, url: `data:${block.mimeType};base64,${block.data}` }] : []
  );
  return { output: textOf(result), ...(attachments.length > 0 ? { attachments } : {}) };
}

function openCodeEvents(tool: string, args: Record<string, unknown>, result: CallToolResult): RuntimeEvent[] {
  const CALL = "tool_bash_hUFbWmc0v5dvHJZ6lgfR";
  const qualified = `${openCodeSessionToolsServerName(THREAD)}_${tool}`;
  const records = readFileSync(join(FIXTURES, "opencode/03-permission-ask-reply-once.ndjson"), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { kind: string; data: any });
  const parts = records.filter(
    (record) => record.kind === "sse" && record.data?.type === "message.part.updated" && record.data.properties?.part?.callID === CALL
  );
  assert.ok(parts.length >= 2);
  const sessionId = parts[0]!.data.properties.part.sessionID as string;
  const state = createSessionState({ threadId: THREAD, openCodeSessionId: sessionId, directory: "/repo", runtimeMode: "full-access" });
  state.activeTurnId = "turn-1";
  let n = 0;
  const ctx = { eventId: () => `oc-${++n}`, nowIso: () => "2026-09-21T00:00:00.000Z" };
  const events: RuntimeEvent[] = [];
  for (const record of parts) {
    const data = structuredClone(record.data);
    const part = data.properties.part;
    part.tool = qualified;
    part.state.input = args;
    if (part.state.status === "completed") {
      Object.assign(part.state, openCodeState(result), { title: "", metadata: { truncated: false } });
    }
    const raw = asRawEvent(data);
    assert.ok(raw);
    events.push(...normalizeOpenCodeEvent(state, raw, ctx).events);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Grok
// ---------------------------------------------------------------------------

const GROK_CALL = "call-a0c1eb77-5628-4b27-8ca9-1061c28e4d33-1";

/** Grok's `OkayOutput` for an MCP result, as recorded: the text, a newline, the structured JSON. */
function grokOkayOutput(result: CallToolResult): string {
  const text = textOf(result);
  return result.structuredContent === undefined ? text : `${text}\n${JSON.stringify(result.structuredContent)}`;
}

function grokEvents(tool: string, args: Record<string, unknown>, result: CallToolResult): RuntimeEvent[] {
  // Fixture 32's call (an `apps__show_widget` call through `use_tool`, grok
  // 1.0.46): the same frames, the tool and its arguments swapped in, the
  // output joined as the CLI joins it. The captured call carried an MCP
  // Apps `_meta.ui`, which the session tools' results never do.
  const frames = agentFrames(readCapture("32-mcp-use-tool-call.ndjson"))
    .filter((entry) => entry.method === "session/update")
    .map((entry) => entry.params as SessionNotification)
    .filter((params) => (params.update as { toolCallId?: string }).toolCallId === GROK_CALL);
  assert.equal(frames.length, 3, "tool_call, the retitling update, the end");
  const sessionId = (frames[0] as unknown as { sessionId: string }).sessionId;
  let counter = 0;
  const normalizer = new GrokNormalizer(
    {
      threadId: THREAD,
      stamp: () => ({ eventId: `gk-${++counter}`, createdAt: "2026-09-24T00:00:00.000Z" }),
      uuid: () => `u${++counter}`,
      activeTurnId: () => "turn-1",
      planHost: { platform: "linux", env: { GROK_HOME: "~/home" } },
      launchNonce: "launch-1"
    },
    sessionId
  );
  normalizer.beginTurn();
  return frames.flatMap((params) => {
    const frame = JSON.parse(JSON.stringify(params).replaceAll("apps__show_widget", `orquester__${tool}`)) as {
      update: Record<string, any>;
    };
    const update = frame.update;
    if (update.rawInput) update.rawInput.tool_input = args;
    if (update.rawOutput) {
      assert.equal(update.rawOutput.output?.OkayOutput, 'widget shown\n{"n":1}', "the captured join");
      update.rawOutput.tool_name = tool;
      update.rawOutput.server_name = "orquester";
      update.rawOutput.output = { OkayOutput: grokOkayOutput(result) };
      delete update._meta;
    }
    return normalizer.handleSessionUpdate(frame as unknown as SessionNotification);
  });
}

// ---------------------------------------------------------------------------

describe("html_render lands as a visual row on every provider", () => {
  it("Claude", async () => {
    const { render } = await toolResults();
    assertVisual(await ingest(claudeEvents("mcp__orquester__html_render", RENDER_ARGS, render), "toolu_01FBhJ4wLVN7hz7KLvfUhams"));
  });

  it("Codex", async () => {
    const { render } = await toolResults();
    assertVisual(await ingest(codexEvents("html_render", RENDER_ARGS, render), "call_RQtUSyd2ORQJwZCCcjYZWCMV"));
  });

  it("OpenCode", async () => {
    const { render } = await toolResults();
    assertVisual(await ingest(openCodeEvents("html_render", RENDER_ARGS, render), "tool_bash_hUFbWmc0v5dvHJZ6lgfR"));
  });

  it("Grok", async () => {
    const { render } = await toolResults();
    assertVisual(await ingest(grokEvents("html_render", RENDER_ARGS, render), GROK_CALL));
  });

  it("Grok: the row is the session tool's MCP call from its first frame, whatever the reader finds", async () => {
    const { render } = await toolResults();
    const rows = await ingest(grokEvents("html_render", RENDER_ARGS, render), GROK_CALL);
    for (const row of rows.rows) {
      assert.equal((row.payload as { itemType?: unknown }).itemType, "mcp_tool_call", row.activityKind);
      assert.equal(sessionToolNameOfData((row.payload as { data?: unknown }).data), "html_render", row.activityKind);
    }
  });
});

describe("html_preview's screenshot never reaches events.ndjson", () => {
  it("Claude", async () => {
    const { preview } = await toolResults();
    assertNoScreenshot(await ingest(claudeEvents("mcp__orquester__html_preview", PREVIEW_ARGS, preview), "toolu_01FBhJ4wLVN7hz7KLvfUhams"));
  });

  it("Codex", async () => {
    const { preview } = await toolResults();
    assertNoScreenshot(await ingest(codexEvents("html_preview", PREVIEW_ARGS, preview), "call_RQtUSyd2ORQJwZCCcjYZWCMV"));
  });

  it("OpenCode", async () => {
    const { preview } = await toolResults();
    assertNoScreenshot(await ingest(openCodeEvents("html_preview", PREVIEW_ARGS, preview), "tool_bash_hUFbWmc0v5dvHJZ6lgfR"));
  });

  it("Grok, even were its output text to carry the image bytes", async () => {
    const { preview } = await toolResults();
    // How Grok renders an MCP image into `OkayOutput` is unrecorded; a text
    // that carried the base64 is the worst case: the run is dropped whole.
    const withBytes: CallToolResult = { ...preview, content: [{ type: "text", text: PNG }, ...preview.content.slice(1)] };
    assertNoScreenshot(await ingest(grokEvents("html_preview", PREVIEW_ARGS, withBytes), GROK_CALL));
  });

  it("a user's own MCP server keeps its result as before (no session tool, no bounding)", async () => {
    const { preview } = await toolResults();
    const events = codexEvents("html_preview", PREVIEW_ARGS, preview).map((event) => {
      const data = (event.payload as { data?: Record<string, unknown> }).data;
      return data?.server === "orquester"
        ? ({ ...event, payload: { ...event.payload, data: { ...data, server: "orquester_remote" } } } as RuntimeEvent)
        : event;
    });
    const rows = await ingest(events, "call_RQtUSyd2ORQJwZCCcjYZWCMV");
    assert.equal(sessionToolNameOfData((rows.completed.payload as { data?: unknown }).data), null);
    assert.ok(JSON.stringify(rows.completed.payload).includes(PNG.slice(0, 1000)));
  });
});
