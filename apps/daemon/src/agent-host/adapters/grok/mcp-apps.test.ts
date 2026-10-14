/**
 * Grok adapter — MCP Apps (spec 2026-10-14 §3): the readers of what Grok
 * 1.0.46 says about a UI resource (frames from the 2026-10-14 probe, spec
 * appendix), and the REAL adapter against the scripted mock peer: a completed
 * `use_tool` call's resource captured through `_x.ai/mcp/read_resource` onto
 * its row ahead of the reply and the turn's end, a stop that lets a hanging
 * capture go, and an app's own requests.
 *
 * Nothing sleeps: every wait is on an emitted event or a logged frame.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, describe } from "node:test";

import { mcpAppReferenceOfActivityPayload, type RuntimeEvent } from "@orquester/api/agent-chat";

import type { AdapterContext } from "../../adapter.ts";
import { AGENT_HOST_DEADLINES } from "../../support/deadline.ts";
import type { SessionNotification } from "./acp/_generated/schema.ts";
import { createGrokAdapter } from "./index.ts";
import { grokCallToolResult, grokMcpAppCallOf, grokMcpTools, grokResourceContents, withGrokMcpApp } from "./mcp-apps.ts";

const MOCK = join(dirname(fileURLToPath(import.meta.url)), "testing/mock-grok.mjs");
const STORED_ID = "t1-0f8fad5b-d9cb-469f-a165-70867728950e-html";

/** The completed `use_tool` update the probe captured (session id shortened). */
const completedUpdate = (overrides: Record<string, unknown> = {}): SessionNotification =>
  ({
    sessionId: "s1",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "call-a0c1eb77-1",
      status: "completed",
      rawOutput: { type: "MCP", tool_name: "show_widget", server_name: "apps", output: { OkayOutput: 'widget shown\n{"n":1}' } },
      _meta: { ui: { resourceUri: "ui://stub/widget.html", visibility: ["model", "app"] }, "ui/resourceUri": "ui://stub/widget.html" },
      ...overrides
    }
  }) as unknown as SessionNotification;

describe("grok MCP Apps — readers", () => {
  test("a completed MCP call naming a ui:// resource is one to capture", () => {
    assert.deepEqual(grokMcpAppCallOf(completedUpdate()), {
      toolCallId: "call-a0c1eb77-1",
      server: "apps",
      tool: "show_widget",
      resourceUri: "ui://stub/widget.html"
    });
    assert.equal(grokMcpAppCallOf(completedUpdate({ status: "failed" })), null);
    assert.equal(grokMcpAppCallOf(completedUpdate({ _meta: undefined })), null);
    assert.equal(grokMcpAppCallOf(completedUpdate({ rawOutput: { type: "Bash", output: "x" } })), null);
    assert.equal(grokMcpAppCallOf(completedUpdate({ sessionUpdate: "tool_call" })), null);
    assert.equal(
      grokMcpAppCallOf(completedUpdate({ _meta: { ui: { resourceUri: "https://evil.example.com" } } })),
      null
    );
  });

  test("the extension answers are read wrapped or not", () => {
    const contents = [{ uri: "ui://stub/widget.html", mimeType: "text/html;profile=mcp-app", text: "<p>" }];
    assert.deepEqual(grokResourceContents({ result: { contents } }), contents);
    assert.deepEqual(grokResourceContents({ contents }), contents);
    assert.deepEqual(grokResourceContents({ result: {} }), []);
    assert.deepEqual(grokCallToolResult({ result: { content: [{ type: "text", text: "widget shown" }] } }), {
      content: [{ type: "text", text: "widget shown" }]
    });
    const listed = {
      result: {
        servers: [
          {
            name: "apps",
            session: {
              status: "ready",
              tools: [
                { name: "show_widget", description: "Shows a widget", _meta: { ui: { visibility: ["model", "app"] } }, enabled: true },
                { name: "off", enabled: false }
              ]
            }
          }
        ]
      }
    };
    assert.deepEqual(grokMcpTools(listed, "apps"), [
      {
        name: "show_widget",
        readOnly: false,
        meta: { ui: { visibility: ["model", "app"] } },
        definition: { name: "show_widget", description: "Shows a widget", _meta: { ui: { visibility: ["model", "app"] } }, enabled: true }
      }
    ]);
    assert.deepEqual(grokMcpTools(listed, "other"), []);
  });

  test("only the call's own completion takes the app", () => {
    const mcpApp = { attachmentId: STORED_ID, server: "apps", tool: "show_widget", resourceUri: "ui://stub/widget.html" };
    const patch = withGrokMcpApp("call-1", mcpApp);
    const completion = { type: "item.completed", itemId: "call-1", payload: { itemType: "dynamic_tool_call", data: { a: 1 } } } as unknown as RuntimeEvent;
    assert.deepEqual((patch(completion) as { payload: { data: unknown } }).payload.data, { a: 1, mcpApp });
    const other = { ...completion, itemId: "call-2" } as RuntimeEvent;
    assert.equal(patch(other), other);
  });
});

// ---------------------------------------------------------------------------
// The real adapter against the mock peer
// ---------------------------------------------------------------------------

const rigs: Array<() => Promise<void>> = [];
after(async () => {
  for (const dispose of rigs) await dispose();
});

async function rig(scenario: string, env: Record<string, string> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "grok-mcp-apps-"));
  const events: RuntimeEvent[] = [];
  const waiters: Array<{ predicate: (event: RuntimeEvent) => boolean; resolve: (event: RuntimeEvent) => void }> = [];
  const sent: Array<{ method?: string; params?: unknown }> = [];
  const sentWaiters: Array<{ method: string; resolve: () => void }> = [];
  const stored: Array<{ name: string; bytes: string }> = [];
  const controller = new AbortController();
  let ids = 0;
  const noop = () => undefined;
  const context: AdapterContext = {
    logger: { debug: noop, info: noop, warn: noop, error: noop },
    clock: { now: () => new Date(0), nowIso: () => "2026-10-14T00:00:00.000Z" },
    ids: { eventId: () => `e${(ids += 1)}`, messageId: (prefix) => `${prefix}-${(ids += 1)}`, uuid: () => `u${(ids += 1)}` },
    resolveAttachmentPath: async () => cwd,
    attachmentsDir: () => cwd,
    storeAttachment: async (_threadId, input) => {
      stored.push({ name: input.name, bytes: input.bytes });
      return STORED_ID;
    },
    logRawFrame: (_threadId, entry) => {
      const { direction, frame } = entry as { direction: string; frame: { method?: string; params?: unknown } };
      if (direction !== "send") return;
      sent.push(frame);
      for (let index = sentWaiters.length - 1; index >= 0; index -= 1) {
        if (sentWaiters[index]!.method === frame.method) sentWaiters.splice(index, 1)[0]!.resolve();
      }
    },
    buildEnv: () => ({ PATH: process.env.PATH ?? "", HOME: cwd, TMPDIR: cwd, GROK_MOCK_SCENARIO: scenario, ...env }),
    resolveBin: async () => MOCK,
    sessionPath: () => process.env.PATH ?? "",
    tmpDir: () => cwd,
    signal: controller.signal
  };
  const adapter = await createGrokAdapter(context);
  void (async () => {
    for await (const event of adapter.events) {
      events.push(event);
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        if (waiters[index]!.predicate(event)) waiters.splice(index, 1)[0]!.resolve(event);
      }
    }
  })();
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    controller.abort();
    await adapter.stopAll();
    await rm(cwd, { recursive: true, force: true, maxRetries: 3 });
  };
  rigs.push(dispose);
  await adapter.startSession({
    threadId: "t1",
    cwd,
    home: { kind: "system", path: cwd },
    modelSelection: { model: "grok-4.6" },
    runtimeMode: "approval-required"
  });
  return {
    adapter,
    events,
    stored,
    sent,
    dispose,
    drain: async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    waitFor: (predicate: (event: RuntimeEvent) => boolean) =>
      new Promise<RuntimeEvent>((resolve) => {
        const existing = events.find(predicate);
        if (existing !== undefined) resolve(existing);
        else waiters.push({ predicate, resolve });
      }),
    waitForSent: (method: string) =>
      new Promise<void>((resolve) => {
        if (sent.some((frame) => frame.method === method)) resolve();
        else sentWaiters.push({ method, resolve });
      })
  };
}

const isAppCompletion = (event: RuntimeEvent) => event.type === "item.completed" && event.itemId === "call-app-1";

describe("grok MCP Apps — the adapter", () => {
  test("a completed use_tool call's app is captured onto its row, ahead of the reply and the turn's end", async () => {
    const r = await rig("mcp-app");
    await r.adapter.sendTurn({ threadId: "t1", input: "show it", attachments: [], interactionMode: "default" });
    await r.waitFor((event) => event.type === "turn.completed");
    const read = r.sent.find((frame) => frame.method === "_x.ai/mcp/read_resource");
    assert.deepEqual((read?.params as Record<string, unknown>) ?? {}, {
      sessionId: "01a0c19e-de22-78c0-a72a-7e230ccfbec0",
      server: "apps",
      uri: "ui://apps/widget.html"
    });
    assert.equal(r.stored.length, 1);
    assert.match(r.stored[0]!.bytes, /^<!doctype html><meta http-equiv="Content-Security-Policy"/);
    const index = r.events.findIndex(isAppCompletion);
    const completion = r.events[index] as Extract<RuntimeEvent, { type: "item.completed" }>;
    assert.deepEqual((completion.payload.data as Record<string, unknown>).mcpApp, {
      attachmentId: STORED_ID,
      server: "apps",
      tool: "show_widget",
      resourceUri: "ui://apps/widget.html",
      prefersBorder: true
    });
    // The mock's reply streams `echo:show it` after the call.
    const reply = r.events.findIndex(
      (event) =>
        event.type === "content.delta" &&
        (event.payload as { delta?: string }).delta === "echo:show it"
    );
    assert.ok(reply !== -1, "the reply was emitted");
    assert.ok(index < reply, "before the reply");
    assert.ok(index < r.events.findIndex((event) => event.type === "turn.completed"), "before the turn's end");
    await r.dispose();
  });

  test("a read slower than the 4 s probe deadline is still captured, and a second turn reuses it without reading", async (t) => {
    // The second turn calls ANOTHER tool of the server that shares the resource.
    const r = await rig("mcp-app-slow", { GROK_MOCK_SECOND_TOOL: "edit_widget" });
    // The read's deadline runs on a mocked clock: 4.5 s pass at once, and the
    // mock answers the read only when the next `_x.ai/mcp/list` arrives.
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await r.adapter.sendTurn({ threadId: "t1", input: "show it", attachments: [], interactionMode: "default" });
    await r.waitForSent("_x.ai/mcp/read_resource");
    t.mock.timers.tick(AGENT_HOST_DEADLINES.probeMs + 500);
    const listed = r.adapter.mcpApps!.listTools("t1", "apps");
    await r.waitFor((event) => event.type === "turn.completed");
    t.mock.timers.reset();
    await listed;
    const first = r.events.find(isAppCompletion) as Extract<RuntimeEvent, { type: "item.completed" }>;
    assert.equal(((first.payload.data as Record<string, unknown>).mcpApp as { attachmentId?: string })?.attachmentId, STORED_ID);
    await r.adapter.sendTurn({ threadId: "t1", input: "again", attachments: [], interactionMode: "default" });
    await r.waitFor((event) => event.type === "turn.completed" && r.events.filter((e) => e.type === "turn.completed").length === 2);
    assert.equal(r.sent.filter((frame) => frame.method === "_x.ai/mcp/read_resource").length, 1, "read once");
    assert.equal(r.stored.length, 1, "stored once");
    const second = r.events.find(
      (event) => event.type === "item.completed" && event.itemId === "call-app-2"
    ) as Extract<RuntimeEvent, { type: "item.completed" }> | undefined;
    assert.ok(second, "the second turn's call completed");
    assert.equal(r.events.filter((event) => event.type === "item.completed" && /^call-app-/.test(event.itemId ?? "")).length, 2);
    const data = second.payload.data as Record<string, unknown>;
    // The reused snapshot, as the second call's own reference: the row's own-call check accepts it.
    assert.deepEqual(data.mcpApp, {
      attachmentId: STORED_ID,
      server: "apps",
      tool: "edit_widget",
      resourceUri: "ui://apps/widget.html",
      prefersBorder: true
    });
    assert.deepEqual(mcpAppReferenceOfActivityPayload({ itemType: "dynamic_tool_call", data }), data.mcpApp);
    await r.dispose();
  });

  test("a stop lets a hanging capture go: the call completes plain, in order, before the turn's end", async () => {
    const r = await rig("mcp-app-hang");
    void r.adapter.sendTurn({ threadId: "t1", input: "show it", attachments: [], interactionMode: "default" });
    await r.waitForSent("_x.ai/mcp/read_resource");
    assert.equal(r.events.findIndex(isAppCompletion), -1, "the completion waits for its capture");
    await r.adapter.stopSession("t1");
    await r.waitFor((event) => event.type === "session.exited");
    const index = r.events.findIndex(isAppCompletion);
    assert.ok(index !== -1);
    const completion = r.events[index] as Extract<RuntimeEvent, { type: "item.completed" }>;
    assert.equal("mcpApp" in (completion.payload.data as Record<string, unknown>), false);
    assert.ok(index < r.events.findIndex((event) => event.type === "turn.completed"));
    assert.equal(r.stored.length, 0);
    await r.dispose();
  });

  test("an app's requests go through the CLI's own MCP client; no model context is offered", async () => {
    const r = await rig("happy");
    const apps = r.adapter.mcpApps!;
    assert.equal(apps.modelContext, false);
    assert.deepEqual(
      (await apps.listTools("t1", "apps")).map((tool) => [tool.name, tool.readOnly]),
      [["show_widget", false]]
    );
    assert.deepEqual(await apps.callTool("t1", { server: "apps", tool: "show_widget", arguments: { n: 2 } }), {
      content: [{ type: "text", text: "called show_widget" }]
    });
    const call = r.sent.find((frame) => frame.method === "_x.ai/mcp/call");
    assert.deepEqual(call?.params, {
      sessionId: "01a0c19e-de22-78c0-a72a-7e230ccfbec0",
      server: "apps",
      tool: "show_widget",
      arguments: { n: 2 }
    });
    assert.equal((await apps.readResource("t1", { server: "apps", uri: "ui://apps/x" })).contents.length, 1);
    // One listing serves `tool-info` and `call-tool`; the CLI's `tools_changed`
    // (sent by the mock on `_x.ai/mcp/call`) drops it, with no warning.
    await apps.listTools("t1", "apps");
    const lists = () => r.sent.filter((frame) => frame.method === "_x.ai/mcp/list").length;
    assert.equal(lists(), 2, "listed again after the call's tools_changed");
    await apps.listTools("t1", "apps");
    assert.equal(lists(), 2, "then cached");
    await r.drain();
    assert.equal(
      r.events.some((event) => event.type === "runtime.warning" && JSON.stringify(event.payload).includes("tools_changed")),
      false
    );
    await assert.rejects(apps.listTools("nope", "apps"), /session is not running/);
    await r.dispose();
  });
});
