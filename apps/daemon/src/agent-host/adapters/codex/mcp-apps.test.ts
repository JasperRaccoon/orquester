/**
 * Codex adapter — MCP Apps (spec 2026-10-14 §3), against the scripted mock
 * peer: the extension declared at `initialize`, a completed call's `ui://`
 * resource captured through `mcpServer/resource/read` and written on the
 * call's row, the frames after it held in order, a capture that fails or is
 * cut short by the exit, the app's own requests and the model context.
 *
 * Every wait is on an event or a frame, never a sleep.
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { afterEach, describe, it } from "node:test";

import { mcpAppReferenceOfActivityPayload, type RuntimeEvent } from "@orquester/api/agent-chat";

import { AsyncEventQueue } from "./event-queue.ts";
import { CodexSession, type CodexSessionOptions } from "./session.ts";
import { EventCollector, createFakeContext, writeMockCodexServer, type MockConfig } from "./testing.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const STORED_ID = "thread_1-0f8fad5b-d9cb-469f-a165-70867728950e-html";
const APP_HTML = "<!doctype html><h1>widget</h1>";

function rig(mock: Omit<MockConfig, "logPath">, overrides: Partial<CodexSessionOptions> = {}) {
  const server = writeMockCodexServer(mock);
  cleanups.push(() => rmSync(server.dir, { recursive: true, force: true }));
  const stored: Array<{ threadId: string; name: string; mimeType: string; bytes: string }> = [];
  const { context, logs } = createFakeContext({
    storeAttachment: async (threadId, input) => {
      stored.push({ threadId, ...input });
      return STORED_ID;
    }
  });
  const queue = new AsyncEventQueue<RuntimeEvent>();
  const events = new EventCollector(queue);
  let seq = 0;
  const session = new CodexSession({
    context,
    threadId: "thread-1",
    cwd: process.cwd(),
    bin: server.bin,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp" },
    runtimeMode: "approval-required",
    modelSelection: { model: "gpt-5.5" },
    emit: (draft) => {
      queue.push({ ...draft, eventId: `ev-${++seq}`, threadId: "thread-1", createdAt: "2026-10-14T00:00:00.000Z" } as RuntimeEvent);
    },
    onClosed: () => undefined,
    ...overrides
  });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await session.stop();
    queue.close();
  };
  cleanups.push(stop);
  return {
    session,
    events,
    stored,
    logs,
    received: () => server.received(),
    /** Push a notification; resolves once the session read past it. */
    notify: async (method: string, params: unknown) => {
      server.notify(method, params);
      await session.readThread();
    },
    stop
  };
}

const appCall = (overrides: Record<string, unknown> = {}) => ({
  type: "mcpToolCall",
  id: "call-app-1",
  server: "apps",
  tool: "show_widget",
  status: "completed",
  arguments: { n: 1 },
  appContext: { connectorId: "apps", linkId: null, resourceUri: "ui://apps/widget.html", appName: null, actionName: null },
  pluginId: null,
  readOnlyHint: true,
  result: { content: [{ type: "text", text: "shown" }], structuredContent: { n: 1 }, _meta: null },
  error: null,
  durationMs: 5,
  ...overrides
});

const agentMessage = (id: string, text: string) => ({
  type: "agentMessage",
  id,
  text,
  phase: null,
  memoryCitation: null,
  delivery: null,
  questions: null
});

const threadIdOf = (session: CodexSession) => (session.summary().resumeCursor as { threadId: string }).threadId;

const isCompletionOf = (itemId: string) => (event: RuntimeEvent) => event.type === "item.completed" && event.itemId === itemId;

const completedCall = (events: RuntimeEvent[], itemId = "call-app-1") =>
  events.findIndex((event) => event.type === "item.completed" && event.itemId === itemId);

describe("codex — MCP Apps", () => {
  it("captures a completed call's resource onto its row, ahead of what came after it", async () => {
    const r = rig({
      turns: [],
      mcpApps: {
        contents: [
          {
            uri: "ui://apps/widget.html",
            mimeType: "text/html;profile=mcp-app",
            text: APP_HTML,
            _meta: { ui: { csp: { connectDomains: ["https://api.example.com"] }, prefersBorder: true } }
          }
        ]
      }
    });
    await r.session.start();
    const initialize = r.received().find((frame) => frame.method === "initialize");
    const capabilities = (initialize?.params as { capabilities?: { extensions?: Record<string, unknown> } }).capabilities;
    assert.deepEqual(capabilities?.extensions?.["io.modelcontextprotocol/ui"], { mimeTypes: ["text/html;profile=mcp-app"] });
    const threadId = threadIdOf(r.session);
    await r.notify("item/completed", { item: appCall(), threadId, turnId: "turn-x", completedAtMs: 1 });
    await r.notify("item/completed", { item: agentMessage("msg-after", "after the app"), threadId, turnId: "turn-x", completedAtMs: 2 });
    await r.events.waitFor((event) => event.type === "item.completed" && event.itemId === "msg-after", "the later message");

    const read = r.received().find((frame) => frame.method === "mcpServer/resource/read");
    // The originating call names the app Codex reads the resource for.
    assert.deepEqual(read?.params, { threadId, originCallId: "call-app-1", server: "apps", uri: "ui://apps/widget.html" });
    assert.equal(r.stored.length, 1);
    assert.equal(r.stored[0]!.name, "show_widget.html");
    assert.equal(r.stored[0]!.mimeType, "text/html");
    assert.match(r.stored[0]!.bytes, /^<!doctype html><meta http-equiv="Content-Security-Policy"/);
    assert.match(r.stored[0]!.bytes, /connect-src https:\/\/api\.example\.com/);

    const events = r.events.events;
    const index = completedCall(events);
    const completed = events[index] as Extract<RuntimeEvent, { type: "item.completed" }>;
    const data = completed.payload.data as Record<string, unknown>;
    assert.deepEqual(data.mcpApp, {
      attachmentId: STORED_ID,
      server: "apps",
      tool: "show_widget",
      resourceUri: "ui://apps/widget.html",
      csp: { connectDomains: ["https://api.example.com"] },
      prefersBorder: true
    });
    // The app replays the call's result: it is kept for an app's call.
    assert.deepEqual(data.result, { content: [{ type: "text", text: "shown" }], structuredContent: { n: 1 }, _meta: null });
    assert.ok(index < completedCall(events, "msg-after"), "the call's row keeps its place before the later frame");
  });

  it("another tool sharing the resource gets its own reference from the cached snapshot", async () => {
    const r = rig({
      turns: [],
      mcpApps: { contents: [{ uri: "ui://apps/widget.html", mimeType: "text/html;profile=mcp-app", text: APP_HTML }] }
    });
    await r.session.start();
    const threadId = threadIdOf(r.session);
    await r.notify("item/completed", { item: appCall(), threadId, turnId: "t", completedAtMs: 1 });
    await r.events.waitFor(isCompletionOf("call-app-1"), "the first call");
    await r.notify("item/completed", {
      item: appCall({ id: "call-other", tool: "edit_widget" }),
      threadId,
      turnId: "t",
      completedAtMs: 2
    });
    const other = (await r.events.waitFor(isCompletionOf("call-other"), "the other tool's call")) as Extract<
      RuntimeEvent,
      { type: "item.completed" }
    >;
    assert.equal(r.received().filter((frame) => frame.method === "mcpServer/resource/read").length, 1, "the snapshot is shared");
    assert.equal(r.stored.length, 1, "the cached resource is stored once");
    assert.equal(((other.payload.data as Record<string, unknown>).mcpApp as { attachmentId: string }).attachmentId, STORED_ID);
    const data = other.payload.data as Record<string, unknown>;
    assert.equal((data.mcpApp as { tool: string }).tool, "edit_widget");
    // The row's own-call check accepts it, so the app renders and its requests resolve.
    assert.deepEqual(mcpAppReferenceOfActivityPayload({ itemType: "mcp_tool_call", data }), data.mcpApp);
  });

  it("a resource that is no app leaves an ordinary row, still in order", async () => {
    const r = rig({ turns: [], mcpApps: { contents: [{ uri: "ui://apps/widget.html", mimeType: "text/plain", text: "no" }] } });
    await r.session.start();
    const threadId = threadIdOf(r.session);
    await r.notify("item/completed", { item: appCall(), threadId, turnId: "turn-x", completedAtMs: 1 });
    await r.notify("item/completed", { item: agentMessage("msg-after", "x"), threadId, turnId: "turn-x", completedAtMs: 2 });
    await r.events.waitFor((event) => event.type === "item.completed" && event.itemId === "msg-after", "the later message");
    const events = r.events.events;
    const completed = events[completedCall(events)] as Extract<RuntimeEvent, { type: "item.completed" }>;
    assert.equal("mcpApp" in (completed.payload.data as Record<string, unknown>), false);
    assert.equal(r.stored.length, 0);
    assert.ok(r.logs.some((entry) => entry.level === "warn" && /no app document/.test(entry.message)));
    assert.ok(completedCall(events) < completedCall(events, "msg-after"));
  });

  it("a call without a ui:// resource and a failed call are never captured", async () => {
    const r = rig({ turns: [] });
    await r.session.start();
    const threadId = threadIdOf(r.session);
    await r.notify("item/completed", { item: appCall({ id: "plain", appContext: null }), threadId, turnId: "t", completedAtMs: 1 });
    await r.notify("item/completed", {
      item: appCall({ id: "failed", status: "failed", result: null, error: { message: "boom" } }),
      threadId,
      turnId: "t",
      completedAtMs: 1
    });
    await r.events.waitFor((event) => event.type === "item.completed" && event.itemId === "failed", "the failed call");
    assert.equal(r.received().some((frame) => frame.method === "mcpServer/resource/read"), false);
    const plain = r.events.events[completedCall(r.events.events, "plain")] as Extract<RuntimeEvent, { type: "item.completed" }>;
    // Not an app's call: its result stays dropped, as every other server's.
    assert.equal("result" in (plain.payload.data as Record<string, unknown>), false);
  });

  it("a session tool's call is never an app, even one naming a ui:// resource; its result is still kept", async () => {
    // A thread with Orquester's server registered (a grant): `orquester` is ours.
    const r = rig({ turns: [] }, { sessionTools: { url: "http://127.0.0.1:9/mcp", instructions: "", revoke: () => undefined } });
    await r.session.start();
    const threadId = threadIdOf(r.session);
    const reference = { htmlRender: { attachmentId: STORED_ID, title: "Chart", height: 420 } };
    const sessionToolCall = appCall({
      id: "session-tool",
      server: "orquester",
      tool: "html_render",
      appContext: { connectorId: "orquester", linkId: null, resourceUri: "ui://orquester/page.html", appName: null, actionName: null },
      result: { content: [{ type: "text", text: JSON.stringify(reference) }], structuredContent: reference, _meta: null }
    });
    await r.notify("item/completed", { item: sessionToolCall, threadId, turnId: "t", completedAtMs: 1 });
    await r.notify("item/completed", { item: agentMessage("msg-after", "x"), threadId, turnId: "t", completedAtMs: 2 });
    await r.events.waitFor((event) => event.type === "item.completed" && event.itemId === "msg-after", "the later message");
    assert.equal(r.received().some((frame) => frame.method === "mcpServer/resource/read"), false, "never read");
    assert.equal(r.stored.length, 0);
    const completed = r.events.events[completedCall(r.events.events, "session-tool")] as Extract<
      RuntimeEvent,
      { type: "item.completed" }
    >;
    const data = completed.payload.data as Record<string, unknown>;
    assert.equal("mcpApp" in data, false);
    // Task 1's rule stands: the session tool's result carries its reference.
    assert.deepEqual((data.result as { structuredContent?: unknown }).structuredContent, reference);
  });

  it("without a grant no live row is Orquester's: a user's own `orquester` MCP App is captured like any other", async () => {
    const r = rig({ turns: [], mcpApps: { contents: [{ uri: "ui://orquester/page.html", mimeType: "text/html;profile=mcp-app", text: "<p>mine</p>" }] } });
    await r.session.start();
    const threadId = threadIdOf(r.session);
    const userApp = appCall({
      id: "user-orquester",
      server: "orquester",
      tool: "show",
      appContext: { connectorId: "orquester", linkId: null, resourceUri: "ui://orquester/page.html", appName: null, actionName: null }
    });
    await r.notify("item/completed", { item: userApp, threadId, turnId: "t", completedAtMs: 1 });
    const completed = (await r.events.waitFor(
      (event) => event.type === "item.completed" && event.itemId === "user-orquester",
      "the user's call"
    )) as Extract<RuntimeEvent, { type: "item.completed" }>;
    const data = completed.payload.data as Record<string, unknown>;
    assert.equal(data.sessionToolsServer, false, "never Orquester's");
    assert.ok(r.received().some((frame) => frame.method === "mcpServer/resource/read"), "its app resource is read");
  });

  it("the session's end lets go of a capture in flight: the call completes plain before the exit", async () => {
    const r = rig({ turns: [], mcpApps: { contents: "hang" } });
    await r.session.start();
    const threadId = threadIdOf(r.session);
    await r.notify("item/completed", { item: appCall(), threadId, turnId: "turn-x", completedAtMs: 1 });
    assert.equal(completedCall(r.events.events), -1, "the completion waits for its capture");
    await r.stop();
    await r.events.waitForType("session.exited");
    const events = r.events.events;
    const index = completedCall(events);
    assert.ok(index !== -1, "the completion was written");
    assert.equal("mcpApp" in ((events[index] as Extract<RuntimeEvent, { type: "item.completed" }>).payload.data as object), false);
    assert.ok(index < events.findIndex((event) => event.type === "session.exited"), "before the exit");
    assert.equal(r.stored.length, 0);
  });

  it("an app's requests go through the live session to its server", async () => {
    const r = rig({
      turns: [],
      mcpApps: {
        tools: {
          show_widget: {
            name: "show_widget",
            title: "Show widget",
            inputSchema: { type: "object" },
            annotations: { readOnlyHint: true },
            _meta: { ui: { resourceUri: "ui://apps/widget.html", visibility: ["model", "app"] } }
          },
          reset: { name: "reset", inputSchema: { type: "object" }, annotations: {} }
        },
        contents: [{ uri: "ui://apps/data.json", mimeType: "application/json", text: "{}" }]
      }
    });
    await r.session.start();
    const tools = await r.session.mcpListTools("apps");
    assert.deepEqual(
      tools.map((tool) => [tool.name, tool.title ?? null, tool.readOnly]),
      [
        ["show_widget", "Show widget", true],
        ["reset", null, false]
      ]
    );
    assert.deepEqual(await r.session.mcpListTools("other"), []);
    // `tool-info` then `call-tool` list the same server: the second is the cache's.
    await r.session.mcpListTools("apps");
    assert.equal(r.received().filter((frame) => frame.method === "mcpServerStatus/list").length, 2, "apps once, other once");
    const result = await r.session.mcpCallTool({ server: "apps", tool: "reset", arguments: { hard: true } });
    assert.deepEqual(result, { content: [{ type: "text", text: "called reset" }], structuredContent: { arguments: { hard: true } } });
    const call = r.received().find((frame) => frame.method === "mcpServer/tool/call");
    assert.deepEqual(call?.params, { threadId: threadIdOf(r.session), server: "apps", tool: "reset", arguments: { hard: true } });
    const read = await r.session.mcpReadResource({ server: "apps", uri: "ui://apps/data.json" });
    assert.deepEqual(read.contents, [{ uri: "ui://apps/data.json", mimeType: "application/json", text: "{}" }]);
  });

  it("an app's model context updates between turns as untrusted context beside the session tools", async () => {
    const contexts = new Map([["mcp-app:item-1", "initial app view"]]);
    const r = rig({ turns: [{ kind: "text", text: "ok" }] }, {
      appContext: () => contexts,
      sessionTools: { url: "http://127.0.0.1:1/mcp", instructions: "Orquester tools block", revoke: () => undefined }
    });
    await r.session.start();
    await r.session.sendTurn({ input: "first", attachments: [], interactionMode: "default" });
    await r.events.waitForType("turn.completed");
    contexts.set("mcp-app:item-1", "MCP app apps/show_widget (mcp-app:item-1):\nboard has 3 cards");
    await r.session.sendTurn({ input: "second", attachments: [], interactionMode: "default" });
    const starts = r.received().filter((frame) => frame.method === "turn/start");
    assert.equal(starts.length, 2);
    assert.deepEqual((starts[0]!.params as { additionalContext?: unknown }).additionalContext, {
      "mcp-app:item-1": { kind: "untrusted", value: "initial app view" },
      orquester: { kind: "application", value: "Orquester tools block" }
    });
    assert.deepEqual((starts[1]!.params as { additionalContext?: unknown }).additionalContext, {
      "mcp-app:item-1": { kind: "untrusted", value: "MCP app apps/show_widget (mcp-app:item-1):\nboard has 3 cards" },
      orquester: { kind: "application", value: "Orquester tools block" }
    });
  });
});
