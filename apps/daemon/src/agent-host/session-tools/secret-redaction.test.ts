/**
 * `request_secret` end to end (design 2026-10-14 §5 "Secrets"): the value
 * reaches the requesting call — and nothing the host persists or serves.
 *
 * The daemon's real tool and registry answer a call through the host's real
 * session-tools service; each provider's REAL normaliser then reports that
 * result the way its protocol carries it (Claude's `tool_result`, Codex's
 * `mcpToolCall` item, Grok's ACP `tool_call_update`, OpenCode's tool part);
 * the real ingestion writes it through the orchestrator to the real store and
 * the real SQLite index. Every byte under the store's root, every read the
 * host serves (snapshot, full item, tool output, search) and every log line
 * is then searched for the value. Each provider runs twice: with the host's
 * memory of the value (the live path) and without it (a host that restarted
 * between the answer and the provider's report — the structural strip alone).
 */

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  HISTORICAL_RAW_SOURCE,
  SECRET_REDACTED_TEXT,
  type AgentChatSecretRequestEventPayload,
  type RuntimeEvent
} from "@orquester/api/agent-chat";

import { SecretRequestRegistry } from "../../agent-chat/secret-requests.ts";
import { executeSessionToolCall } from "../../session-tools/executor.ts";
import { sessionToolRegistry } from "../../session-tools/index.ts";
import type { DaemonApi } from "../../mcp/daemon-api.ts";
import { createThreadIndex } from "../index/index.ts";
import { createIngestion } from "../ingestion/index.ts";
import { FakeClock, RecordingLiveness, counterIdGen } from "../ingestion/test-harness.ts";
import { createTestHost } from "../orchestration/testing/index.ts";
import { createRecordingLogger } from "../orchestration/testing/fakes.ts";
import { createThreadStore } from "../store/index.ts";
import { ClaudeNormalizer } from "../adapters/claude/normalize.ts";
import { countingIds, fixedClock, readClaudeFixture } from "../adapters/claude/fixtures.ts";
import { classifyItem, type CodexThreadItem } from "../adapters/codex/items.ts";
import type { SessionNotification } from "../adapters/grok/acp/_generated/schema.ts";
import { GrokNormalizer } from "../adapters/grok/normalize.ts";
import { normalizeOpenCodeEvent } from "../adapters/opencode/normalize.ts";
import { asRawEvent } from "../adapters/opencode/protocol.ts";
import { createSessionState } from "../adapters/opencode/state.ts";
import { createSessionToolsHost } from "./index.ts";
import { isDistinctiveSecret, SessionSecretRedactor } from "./secret-redaction.ts";

/** Matches no redaction pattern of `support/stderr.ts`: only this feature can mask it. */
const VALUE = "correct-horse-battery-staple-4711";

const ARGS = { name: "DEPLOY_KEY", prompt: "Paste the deploy key.", purpose: "Push the release" };

/** The daemon's real `request_secret`, answered by "the user" as soon as its card opens. */
async function answeredCall(threadId: string, redactor: SessionSecretRedactor, remember: boolean): Promise<CallToolResult> {
  let registry: SecretRequestRegistry;
  const opened: AgentChatSecretRequestEventPayload[] = [];
  registry = new SecretRequestRegistry({
    publish: (payload) => {
      opened.push(payload);
      if (payload.open) {
        queueMicrotask(() => registry.answer(payload.id, payload.request.requestId, { answer: "provide", value: VALUE }));
      }
    }
  });
  const host = createSessionToolsHost({
    registry: sessionToolRegistry(),
    forward: (call, signal) =>
      executeSessionToolCall(sessionToolRegistry(), call, {
        threadId: call.threadId,
        projectPath: "/work/project",
        cwd: "/work/project",
        agentId: "claude",
        callId: call.callId,
        signal,
        api: {} as DaemonApi,
        secretRequests: registry,
        now: Date.now
      }),
    ...(remember ? { onSecretValues: (id, values) => redactor.remember(id, values) } : {})
  });
  const result = await host.call({ threadId, name: "request_secret", arguments: ARGS });
  await host.stop();
  // The bus never carried it.
  assert.ok(!JSON.stringify(opened).includes(VALUE));
  return result;
}

const resultText = (result: CallToolResult): string => (result.content[0] as { text: string }).text;

// ---------------------------------------------------------------------------
// Each provider's report of the call, through its real normaliser
// ---------------------------------------------------------------------------

/** Fixture 02's first `Read` call, captured whole, re-aimed at `request_secret` with this result. */
const CLAUDE_CALL = "toolu_01VQm59wRkdm9WX5rYRBzkrD";

function claudeEvents(threadId: string, result: CallToolResult): RuntimeEvent[] {
  const reaim = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(reaim);
    if (value === null || typeof value !== "object") return value;
    const record = Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, reaim(entry)]));
    if (record.type === "tool_use" && record.id === CLAUDE_CALL) {
      return { ...record, name: "mcp__orquester__request_secret", input: ARGS };
    }
    if (record.type === "tool_result" && record.tool_use_id === CLAUDE_CALL) {
      return { ...record, content: result.content };
    }
    if (record.type === "user" && "tool_use_result" in record) {
      // The SDK's own copy of the result rides beside the block.
      return { ...record, tool_use_result: result.content };
    }
    return record;
  };
  const normalizer = new ClaudeNormalizer({ threadId, clock: fixedClock(), ids: countingIds() });
  const events: RuntimeEvent[] = [];
  for (const line of readClaudeFixture("02-tool-read-auto-allowed.ndjson")) {
    if (line.kind === "input") {
      const uuid = (line.data as { uuid?: string }).uuid ?? "turn-1";
      events.push(...normalizer.beginTurn({ turnId: uuid, anchorUuid: uuid }));
    } else if (line.kind === "sdk-message") {
      events.push(...normalizer.handleMessage(reaim(line.data) as SDKMessage));
    }
  }
  return events.filter((event) => event.itemId === CLAUDE_CALL);
}

function codexEvents(threadId: string, result: CallToolResult): RuntimeEvent[] {
  const item = {
    type: "mcpToolCall",
    id: "call_secret",
    server: "orquester",
    tool: "request_secret",
    status: "completed",
    arguments: ARGS,
    appContext: null,
    result: { content: result.content, structuredContent: result.structuredContent ?? null, _meta: null },
    error: null,
    durationMs: 1200,
    readOnlyHint: false
  } as unknown as CodexThreadItem;
  const started = classifyItem({ ...item, status: "inProgress", result: null } as unknown as CodexThreadItem);
  const completed = classifyItem(item);
  const envelope = (type: "item.started" | "item.completed", payload: unknown, n: number) =>
    ({
      eventId: `codex-${n}`,
      threadId,
      createdAt: "2026-10-14T10:00:00.000Z",
      type,
      itemId: "call_secret",
      turnId: "turn-1",
      // The adapter keeps the provider's frame beside the event.
      raw: { source: "codex.app-server.notification", method: "item/completed", payload: { item } },
      payload
    }) as unknown as RuntimeEvent;
  return [envelope("item.started", started, 1), envelope("item.completed", completed, 2)];
}

function grokEvents(threadId: string, result: CallToolResult): RuntimeEvent[] {
  const session = "01a0c1a7-1185-7171-9447-3aa38569088c";
  let counter = 0;
  const grok = new GrokNormalizer(
    {
      threadId,
      stamp: () => ({ eventId: `g${(counter += 1)}`, createdAt: "2026-10-14T10:00:00.000Z" }),
      uuid: () => `gu${(counter += 1)}`,
      activeTurnId: () => "turn-1",
      planHost: { platform: "linux", env: { GROK_HOME: "~/home" } },
      launchNonce: "launch-1"
    },
    session
  );
  grok.beginTurn();
  const frame = (update: Record<string, unknown>) =>
    ({ sessionId: session, update, _meta: { promptId: "prompt-1" } }) as unknown as SessionNotification;
  // Every captured call names its tool and kind here (fixtures under `test/fixtures/grok/`).
  const meta = { "x.ai/tool": { version: 1, name: "orquester__request_secret", kind: "other", namespace: "orquester", read_only: false } };
  return [
    ...grok.handleSessionUpdate(
      frame({ sessionUpdate: "tool_call", toolCallId: "call-secret", title: "orquester__request_secret", rawInput: ARGS, _meta: meta })
    ),
    ...grok.handleSessionUpdate(
      frame({
        sessionUpdate: "tool_call_update",
        toolCallId: "call-secret",
        status: "completed",
        _meta: meta,
        content: [{ type: "content", content: { type: "text", text: resultText(result) } }],
        rawOutput: { type: "Mcp", ...result.structuredContent }
      })
    )
  ];
}

async function openCodeEvents(threadId: string, result: CallToolResult): Promise<RuntimeEvent[]> {
  const sessionId = "ses_secret";
  const state = createSessionState({ threadId, openCodeSessionId: sessionId, directory: "/repo", runtimeMode: "approval-required" });
  state.activeTurnId = "turn-1";
  let counter = 0;
  const ctx = { eventId: () => `oc-${(counter += 1)}`, nowIso: () => "2026-10-14T10:00:00.000Z" };
  const part = (status: "running" | "completed") => ({
    id: "prt_secret",
    sessionID: sessionId,
    messageID: "msg_secret",
    type: "tool",
    tool: "orquester-0123456789abcdef_request_secret",
    callID: "call_secret",
    state:
      status === "running"
        ? { status, input: ARGS, title: "request_secret", time: { start: 1 } }
        : {
            status,
            input: ARGS,
            // OpenCode keeps the MCP result's text as the output the model reads.
            output: resultText(result),
            metadata: { truncated: false },
            title: "request_secret",
            time: { start: 1, end: 2 }
          }
  });
  const events: RuntimeEvent[] = [];
  for (const status of ["running", "completed"] as const) {
    const raw = asRawEvent({ id: `evt_${status}`, type: "message.part.updated", properties: { sessionID: sessionId, part: part(status) } });
    assert.ok(raw);
    events.push(...normalizeOpenCodeEvent(state, raw, ctx).events);
  }
  return events;
}

const PROVIDERS = {
  claude: async (threadId: string, result: CallToolResult) => claudeEvents(threadId, result),
  codex: async (threadId: string, result: CallToolResult) => codexEvents(threadId, result),
  grok: async (threadId: string, result: CallToolResult) => grokEvents(threadId, result),
  opencode: openCodeEvents
} as const;

// ---------------------------------------------------------------------------
// The host: real ingestion → orchestrator → real store + real index
// ---------------------------------------------------------------------------

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(path)));
    else if ((await stat(path)).isFile()) out.push(path);
  }
  return out;
}

async function pipeline(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "orq-secret-redaction-"));
  const store = createThreadStore({ rootDir: join(root, "threads") });
  const indexLogger = createRecordingLogger();
  const index = createThreadIndex({ filePath: join(root, "index.sqlite"), logger: indexLogger });
  assert.equal(index.available, true);
  const host = createTestHost({ store, index });
  const redactor = new SessionSecretRedactor();
  const warnings: unknown[] = [];
  const ingestion = createIngestion({
    sink: (threadId, events) => host.orchestrator.ingestionSink(threadId, events),
    liveness: new RecordingLiveness(),
    clock: new FakeClock(),
    idGen: counterIdGen(),
    sessionToolNames: new Set(sessionToolRegistry().tools.map((tool) => tool.name)),
    secrets: redactor,
    logger: { warn: (message, detail) => warnings.push([message, detail]) }
  });
  t.after(async () => {
    await host.stop();
    await index.stop();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, store, index, host, redactor, ingestion, warnings, logs: [host.logger, indexLogger] };
}

describe("request_secret — the value reaches the call and nothing the host keeps", () => {
  for (const [provider, eventsOf] of Object.entries(PROVIDERS)) {
    for (const live of [true, false]) {
      it(`${provider}, ${live ? "live (the host remembers the value)" : "after a host restart (shape alone)"}`, async (t) => {
        const { root, store, index, host, redactor, ingestion, warnings, logs } = await pipeline(t);
        const threadId = await host.createThread({ threadId: `${provider}-${live ? "live" : "restart"}` });

        const result = await answeredCall(threadId, redactor, live);
        // Delivered: the call that asked gets the value, once.
        assert.equal((result.structuredContent as { value?: string }).value, VALUE);
        assert.ok(resultText(result).includes(VALUE));
        assert.equal(redactor.holds(threadId), live);

        const events = await eventsOf(threadId, result);
        const completed = events.find((event) => event.type === "item.completed");
        assert.ok(completed, `${provider}'s normaliser completed the call`);
        assert.ok(JSON.stringify(events).includes(VALUE), "the provider's report carries the value");

        // The provider's raw frames, as `raw.ndjson` gets them.
        store.logRawFrame(threadId, redactor.redactFrame(threadId, { reported: events, result }));

        for (const event of events) await ingestion.ingest(event);
        await ingestion.drain();
        await host.settle();
        await index.drain();

        // Every read the host serves.
        const snapshot = await host.orchestrator.readThread(threadId);
        assert.ok(snapshot.kind === "snapshot");
        assert.ok(!JSON.stringify(snapshot).includes(VALUE), "snapshot");
        const wire = [...snapshot.thread.items].reverse().find(
          (item) =>
            item.kind === "activity" &&
            (item.payload as { toolUseId?: string; itemType?: string }).toolUseId === completed.itemId &&
            (item.payload as { itemType?: string }).itemType === "mcp_tool_call"
        );
        assert.ok(wire, "the call's row is in the snapshot");
        const row = await host.orchestrator.readItem(threadId, wire.id);
        assert.ok(row, "the full item reads back");
        assert.ok(!JSON.stringify(row).includes(VALUE), "full item read");
        assert.ok(!JSON.stringify(await host.orchestrator.readToolOutput(threadId, wire.id)).includes(VALUE), "tool output");
        assert.deepEqual(host.orchestrator.searchThreads({ q: VALUE, limit: 5 }).hits, [], "search");
        for (const logger of logs) assert.ok(!JSON.stringify(logger).includes(VALUE), "host log");
        assert.ok(!JSON.stringify(warnings).includes(VALUE), "ingestion warnings");

        // Every file under the store's root — events.ndjson, state.json, raw.ndjson — and the index.
        store.close();
        await index.stop();
        const files = [...(await filesUnder(join(root, "threads"))), ...(await filesUnder(root)).filter((file) => file.includes("index.sqlite"))];
        assert.ok(files.some((file) => file.endsWith("events.ndjson")));
        assert.ok(files.some((file) => file.endsWith("raw.ndjson")));
        for (const file of files) {
          assert.ok(!(await readFile(file)).includes(VALUE), `${file} holds the value`);
        }

        // What the row keeps: the request and its outcome — the card's record.
        const references = ((wire?.kind === "activity" ? wire.payload : null) as { data?: { sessionTool?: { name: string; references?: Record<string, unknown> } } } | null)
          ?.data?.sessionTool;
        assert.equal(references?.name, "request_secret");
        assert.deepEqual(references?.references?.secretRequest, { name: "DEPLOY_KEY", purpose: "Push the release", outcome: "provided" });
      });
    }
  }

  it("a value the agent repeats later is masked too — while the host remembers it", async (t) => {
    const { host, redactor, ingestion, store } = await pipeline(t);
    const threadId = await host.createThread({ threadId: "echo" });
    await answeredCall(threadId, redactor, true);
    const echoed = {
      eventId: "cmd-1",
      threadId,
      createdAt: "2026-10-14T10:00:00.000Z",
      type: "item.completed",
      itemId: "cmd-1",
      payload: {
        itemType: "command_execution",
        status: "completed",
        title: "curl",
        data: { command: `curl -H "Authorization: Token ${VALUE}" https://example.test`, output: `token=${VALUE}\n` }
      }
    } as unknown as RuntimeEvent;
    await ingestion.ingest(echoed);
    await ingestion.drain();
    await host.settle();
    const row = await host.orchestrator.readItem(threadId, "cmd-1");
    const text = JSON.stringify(row);
    assert.ok(!text.includes(VALUE));
    assert.ok(text.includes(SECRET_REDACTED_TEXT));
    store.close();
  });
});

describe("secrets × the other agent-visuals tasks", () => {
  it("the secret is masked BEFORE a session tool's result is bounded: a cut never keeps part of a value", async (t) => {
    const { host, redactor, ingestion, root } = await pipeline(t);
    const threadId = await host.createThread({ threadId: "bounded" });
    redactor.remember(threadId, [VALUE]);
    // A session tool's result string past the 64 KiB cut, the value straddling the cut.
    // (Words, not one long run: a base64-looking run would be dropped whole.)
    const text = `${"lorem ipsum ".repeat(6000).slice(0, 64 * 1024 - 20)}${VALUE} and more`;
    const item = {
      type: "mcpToolCall",
      id: "call_big",
      server: "orquester",
      tool: "html_preview",
      status: "completed",
      arguments: { html: "<p>x</p>" },
      appContext: null,
      result: { content: [{ type: "text", text }], structuredContent: null, _meta: null },
      error: null,
      durationMs: 5,
      readOnlyHint: true
    } as unknown as CodexThreadItem;
    await ingestion.ingest({
      eventId: "call_big",
      threadId,
      createdAt: "2026-10-14T10:00:00.000Z",
      type: "item.completed",
      itemId: "call_big",
      turnId: "turn-1",
      payload: classifyItem(item)
    } as unknown as RuntimeEvent);
    await ingestion.drain();
    await host.settle();
    const snapshot = await host.orchestrator.readThread(threadId);
    assert.ok(snapshot.kind === "snapshot");
    const wire = snapshot.thread.items.find(
      (entry) => entry.kind === "activity" && (entry.payload as { toolUseId?: string }).toolUseId === "call_big"
    );
    assert.ok(wire, "the call's row is in the snapshot");
    const row = JSON.stringify(await host.orchestrator.readItem(threadId, wire.id));
    assert.ok(row.includes('"html_preview"') && row.includes("lorem ipsum"), "the row was written");
    assert.ok(!row.includes(VALUE.slice(0, 16)), "no part of the value survives the cut");
    for (const file of await filesUnder(root)) {
      assert.ok(!(await readFile(file, "utf8")).includes(VALUE.slice(0, 16)), file);
    }
  });

  it("a fork's child: the parent's turns its replay carries over are stored masked, the child given nothing", async (t) => {
    const { host, redactor, ingestion, root } = await pipeline(t);
    const parent = await host.createThread({ threadId: "parent" });
    const child = await host.createThread({ threadId: "child" });
    redactor.remember(parent, [VALUE]);
    redactor.link(child, parent);
    await ingestion.ingest({
      eventId: "replay-1",
      threadId: child,
      createdAt: "2026-10-14T10:00:00.000Z",
      type: "item.completed",
      itemId: "cmd-1",
      turnId: "turn-1",
      raw: { source: HISTORICAL_RAW_SOURCE, method: "history", payload: {} },
      payload: {
        itemType: "command_execution",
        status: "completed",
        title: "curl",
        data: { command: `curl -H "Authorization: Token ${VALUE}" https://example.test`, output: `token=${VALUE}\n` }
      }
    } as unknown as RuntimeEvent);
    await ingestion.drain();
    await host.settle();
    assert.equal(redactor.holds(child), false);
    const snapshot = await host.orchestrator.readThread(child);
    assert.ok(!JSON.stringify(snapshot).includes(VALUE));
    for (const file of await filesUnder(join(root, "threads"))) {
      assert.ok(!(await readFile(file, "utf8")).includes(VALUE), file);
    }
  });
});

describe("the redactor", () => {
  const event = (threadId: string, itemType: string, data: unknown) =>
    ({
      eventId: "e",
      threadId,
      createdAt: "2026-10-14T10:00:00.000Z",
      type: "item.completed",
      itemId: "i",
      payload: { itemType, status: "completed", data }
    }) as unknown as RuntimeEvent;

  it("masks a thread's values in that thread only, and returns untouched events as they were", () => {
    const redactor = new SessionSecretRedactor();
    redactor.remember("a", [VALUE]);
    const leaked = event("a", "command_execution", { output: `x${VALUE}y`, nested: [VALUE] });
    assert.deepEqual((redactor.redactEvent(leaked).payload as { data: unknown }).data, {
      output: `x${SECRET_REDACTED_TEXT}y`,
      nested: [SECRET_REDACTED_TEXT]
    });
    assert.ok(JSON.stringify(leaked).includes(VALUE), "the input is not mutated");
    const other = event("b", "command_execution", { output: VALUE });
    assert.equal(redactor.redactEvent(other), other, "another thread's events are not touched");
    const clean = event("a", "command_execution", { output: "nothing here" });
    assert.equal(redactor.redactEvent(clean), clean);
  });

  it("by-value masking outside MCP rows is for distinctive values only; MCP rows mask any value", () => {
    assert.equal(isDistinctiveSecret("hunter22"), true, "8 characters, two classes");
    assert.equal(isDistinctiveSecret("password"), false, "a plain word");
    assert.equal(isDistinctiveSecret("abcdefghijklmnop"), true, "16 characters of any kind");
    assert.equal(isDistinctiveSecret("Ab1!"), false, "too short");
    const redactor = new SessionSecretRedactor();
    redactor.remember("a", ["password", "1234"]);
    const command = event("a", "command_execution", { output: "enter password 1234" });
    assert.equal(redactor.redactEvent(command), command, "plain words would shred the transcript");
    const mcp = event("a", "mcp_tool_call", { result: "password 1234" });
    const masked = JSON.stringify(redactor.redactEvent(mcp));
    assert.ok(!masked.includes("password") && !masked.includes("1234"));
    // Raw frames: only distinctive values by value; the shape strip still applies.
    assert.deepEqual(redactor.redactFrame("a", { line: "password 1234" }), { line: "password 1234" });
    const result = { secretRequest: { name: "PIN", outcome: "provided" }, value: "1234" };
    assert.ok(!JSON.stringify(redactor.redactFrame("a", { text: JSON.stringify(result) })).includes("1234"));
  });

  it("fails closed: an MCP row or a raw frame too deep to check is not kept", () => {
    const redactor = new SessionSecretRedactor();
    redactor.remember("a", [VALUE]);
    let deep: Record<string, unknown> = { leaf: VALUE };
    for (let i = 0; i < 100; i += 1) deep = { inner: deep };
    const mcp = redactor.redactEvent(event("a", "mcp_tool_call", deep));
    assert.equal((mcp.payload as { data: unknown }).data, SECRET_REDACTED_TEXT);
    assert.equal(redactor.redactFrame("a", deep), SECRET_REDACTED_TEXT);
    // Without a value to look for, the shape strip still refuses to pass an unwalked tail through.
    assert.ok(!JSON.stringify(new SessionSecretRedactor().redactFrame("b", deep)).includes(VALUE));
  });

  it("a pasted value's stray spaces: the trimmed value is masked too", () => {
    const redactor = new SessionSecretRedactor();
    redactor.remember("a", [`  ${VALUE}\t`]);
    const echoed = event("a", "command_execution", { output: `export K=${VALUE}` });
    assert.ok(!JSON.stringify(redactor.redactEvent(echoed)).includes(VALUE));
  });

  it("fails closed for any event of a thread holding a value when it is too deep to check", () => {
    const redactor = new SessionSecretRedactor();
    redactor.remember("a", [VALUE]);
    let deep: Record<string, unknown> = { leaf: VALUE };
    for (let i = 0; i < 100; i += 1) deep = { inner: deep };
    const command = redactor.redactEvent(event("a", "command_execution", deep));
    const payload = command.payload as { itemType: string; data: unknown };
    assert.equal(payload.itemType, "command_execution", "identity kept");
    assert.equal(payload.data, SECRET_REDACTED_TEXT, "nothing nested kept");
    assert.ok(!JSON.stringify(command).includes(VALUE));
  });

  it("a raw frame loses a request_secret result's value by shape alone", () => {
    const redactor = new SessionSecretRedactor();
    const frame = { method: "item/completed", params: { item: { result: { structuredContent: { secretRequest: { name: "K", outcome: "provided" }, value: VALUE } } } } };
    assert.ok(!JSON.stringify(redactor.redactFrame("a", frame)).includes(VALUE));
  });

  it("a fork's child is masked with its parent's values, read live — never given them", () => {
    const redactor = new SessionSecretRedactor();
    redactor.remember("parent", [VALUE]);
    redactor.link("child", "parent");
    redactor.link("grandchild", "child");
    for (const threadId of ["child", "grandchild"]) {
      const replayed = event(threadId, "agent_message", { text: `the key is ${VALUE}` });
      assert.ok(!JSON.stringify(redactor.redactEvent(replayed)).includes(VALUE), threadId);
      assert.equal(redactor.holds(threadId), false, `${threadId} holds nothing of its own`);
    }
    // A sibling, and a link onto itself, change nothing.
    const sibling = event("other", "agent_message", { text: VALUE });
    assert.equal(redactor.redactEvent(sibling), sibling);
    redactor.link("parent", "parent");
    redactor.link("parent", "grandchild"); // a cycle: the walk still ends
    assert.ok(!JSON.stringify(redactor.redactEvent(event("parent", "agent_message", { text: VALUE }))).includes(VALUE));
    // A forgotten child loses its link with the rest.
    redactor.forget("child");
    const after = event("child", "agent_message", { text: VALUE });
    assert.equal(redactor.redactEvent(after), after);
  });

  it("an MCP App's call through Grok's use_tool is an MCP row: any value masked; its snapshot and proxied answers too", () => {
    const redactor = new SessionSecretRedactor();
    redactor.remember("a", ["1234"]);
    redactor.remember("a", [VALUE]);
    const grokApp = event("a", "dynamic_tool_call", {
      vendorTool: "use_tool",
      rawInput: { variant: "UseTool", tool_name: "apps__show_widget", tool_input: { pin: "1234" } },
      rawOutput: { type: "MCP", server_name: "apps", tool_name: "show_widget", output: { OkayOutput: `pin 1234 ${VALUE}` } }
    });
    const masked = JSON.stringify(redactor.redactEvent(grokApp));
    assert.ok(!masked.includes("1234") && !masked.includes(VALUE));
    // The snapshot document: distinctive values only, as a raw frame.
    assert.equal(redactor.maskText("a", `<p>${VALUE}</p><p>1234</p>`), `<p>${SECRET_REDACTED_TEXT}</p><p>1234</p>`);
    // A proxied answer bound for the app: as an MCP row.
    assert.deepEqual(redactor.maskValue("a", { content: [{ type: "text", text: `pin 1234` }] }), {
      content: [{ type: "text", text: `pin ${SECRET_REDACTED_TEXT}` }]
    });
    assert.deepEqual(redactor.maskValue("b", { content: [{ type: "text", text: "pin 1234" }] }), {
      content: [{ type: "text", text: "pin 1234" }]
    });
  });

  it("forgets a released thread's values", async (t) => {
    const { redactor, ingestion } = await pipeline(t);
    redactor.remember("gone", [VALUE]);
    await ingestion.forget("gone");
    assert.equal(redactor.holds("gone"), false);
  });
});

describe("the host's teardown", () => {
  it("drains ingestion with `final`, so held tails are released (masked) before the stop; an ordinary drain is not final", async () => {
    const host = createTestHost();
    const calls: Array<{ final?: boolean } | undefined> = [];
    const drain = host.ingestion.drain.bind(host.ingestion);
    host.ingestion.drain = async (options?: { final?: boolean }) => {
      calls.push(options);
      await drain();
    };
    await host.orchestrator.drain();
    assert.deepEqual(calls, [undefined]);
    await host.stop();
    assert.deepEqual(calls.at(-1), { final: true });
  });
});
