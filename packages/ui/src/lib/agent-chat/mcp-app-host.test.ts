/**
 * The MCP Apps bridge's host side (spec 2026-10-14 §3): every method an app
 * may send, the replay of the original call, and the bounds. Cases derived
 * from T3 Code (MIT): `packages/client-runtime/src/mcpApps/host.test.ts`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { MCP_APP_MAX_MESSAGE_BYTES, type McpAppReference } from "@orquester/api/agent-chat";

import {
  makeMcpAppHost,
  McpAppHostRefusal,
  mcpAppStyleVariables,
  mcpResourceBytes,
  type McpAppDownload,
  type McpAppHostContext,
  type McpAppHostOptions
} from "./mcp-app-host";

const app: McpAppReference = {
  attachmentId: "s1-0f8fad5b-d9cb-469f-a165-70867728950e-html",
  server: "weather",
  tool: "get_weather",
  resourceUri: "ui://weather/dashboard",
  csp: { connectDomains: ["https://api.weather.test"] }
};

// Lets the host settle the promises its callbacks return.
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(overrides: Partial<McpAppHostOptions> = {}) {
  const sent: Array<Record<string, unknown>> = [];
  let theme: "light" | "dark" = "dark";
  let mode: "inline" | "fullscreen" = "inline";
  const calls: string[] = [];
  const host = makeMcpAppHost({
    app,
    hostVersion: "1",
    post: (message) => sent.push(message as Record<string, unknown>),
    hostContext: (): McpAppHostContext => ({
      theme,
      styles: { variables: { "--color-background-primary": theme === "dark" ? "#000000" : "#ffffff" } },
      displayMode: mode,
      availableDisplayModes: ["inline", "fullscreen"],
      containerDimensions: { width: 600, maxHeight: 2000 },
      platform: "web"
    }),
    supportsModelContext: () => true,
    callTool: async (input) => {
      calls.push(`call:${input.name}`);
      return { content: [{ type: "text", text: `called ${input.name}` }] };
    },
    readResource: async (input) => {
      calls.push(`read:${input.uri}`);
      return { contents: [] };
    },
    openLink: async (url) => {
      calls.push(`link:${url}`);
    },
    sendMessage: async (text) => {
      calls.push(`message:${text}`);
    },
    updateModelContext: async () => {
      calls.push("context");
    },
    requestDisplayMode: async (next) => {
      mode = next === "fullscreen" ? "fullscreen" : "inline";
      return mode;
    },
    downloadFile: async () => undefined,
    onRequestTeardown: () => calls.push("teardown"),
    onSizeChanged: (size) => calls.push(`size:${size.height}`),
    ...overrides
  });
  return { host, sent, calls, setTheme: (next: "light" | "dark") => (theme = next) };
}

const initialize = (host: ReturnType<typeof makeMcpAppHost>, appCapabilities: Record<string, unknown> = {}) => {
  host.receive({ jsonrpc: "2.0", id: "init", method: "ui/initialize", params: { appCapabilities } });
  host.receive({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
};

test("initialize answers the host's capabilities and context, then replays the call once initialized", () => {
  const { host, sent } = setup();
  host.setToolCall({ arguments: { city: "Oslo" }, result: { content: [{ type: "text", text: "Sunny" }] } });
  host.receive({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { protocolVersion: "1999-01-01" } });
  assert.equal(sent.length, 1);
  const result = sent[0]!.result as Record<string, any>;
  assert.equal(result.protocolVersion, "2026-01-26");
  assert.deepEqual(result.hostInfo, { name: "orquester", version: "1" });
  assert.deepEqual(result.hostCapabilities.sandbox, { csp: app.csp });
  assert.deepEqual(result.hostCapabilities.updateModelContext, { text: {}, structuredContent: {} });
  assert.equal(result.hostContext.theme, "dark");

  host.receive({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
  assert.deepEqual(sent.slice(1), [
    { jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: { city: "Oslo" } } },
    { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [{ type: "text", text: "Sunny" }] } }
  ]);
  host.setToolCall({ arguments: { city: "Bergen" }, result: undefined });
  assert.equal(sent.length, 3, "the call is replayed once");
});

test("model context is not offered where the agent cannot take it", async () => {
  const { host, sent, calls } = setup({ supportsModelContext: () => false });
  host.receive({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} });
  const result = sent[0]!.result as Record<string, any>;
  assert.equal("updateModelContext" in result.hostCapabilities, false);
  host.receive({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
  host.receive({
    jsonrpc: "2.0",
    id: 2,
    method: "ui/update-model-context",
    params: { content: [{ type: "text", text: "x" }] }
  });
  await flush();
  assert.equal((sent.at(-1)!.error as { code: number }).code, -32601);
  assert.equal(calls.includes("context"), false);
});

test("tools/call and resources/read reach the callbacks; results are normalised", async () => {
  const { host, sent, calls } = setup({
    callTool: async () => ({ content: [], structuredContent: null, _meta: null }) as never
  });
  initialize(host);
  sent.length = 0;
  host.receive({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "refresh", arguments: { a: 1 } } });
  host.receive({ jsonrpc: "2.0", id: 8, method: "resources/read", params: { uri: "ui://weather/data" } });
  await flush();
  assert.deepEqual(sent.find((message) => message.id === 7), { jsonrpc: "2.0", id: 7, result: { content: [] } });
  assert.ok(calls.includes("read:ui://weather/data"));
  host.receive({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "", arguments: {} } });
  host.receive({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "x", arguments: [1] } });
  host.receive({ jsonrpc: "2.0", id: 11, method: "resources/read", params: {} });
  for (const id of [9, 10, 11]) {
    assert.equal((sent.find((message) => message.id === id)!.error as { code: number }).code, -32602);
  }
});

test("a refusal's message reaches the app as the error", async () => {
  const { host, sent } = setup({
    callTool: async () => {
      throw new McpAppHostRefusal("Declined by the user.");
    }
  });
  initialize(host);
  host.receive({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "delete_all" } });
  await flush();
  assert.deepEqual(sent.at(-1), { jsonrpc: "2.0", id: 3, error: { code: -32000, message: "Declined by the user." } });
});

test("only http(s) links open and only user text messages are sent", async () => {
  const { host, sent, calls } = setup();
  initialize(host);
  host.receive({ jsonrpc: "2.0", id: 1, method: "ui/open-link", params: { url: "javascript:alert(1)" } });
  host.receive({ jsonrpc: "2.0", id: 2, method: "ui/open-link", params: { url: "https://example.com" } });
  host.receive({
    jsonrpc: "2.0",
    id: 3,
    method: "ui/message",
    params: { role: "assistant", content: [{ type: "text", text: "hi" }] }
  });
  host.receive({
    jsonrpc: "2.0",
    id: 4,
    method: "ui/message",
    params: { role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }
  });
  host.receive({ jsonrpc: "2.0", id: 5, method: "ui/message", params: { role: "user", content: { type: "image" } } });
  await flush();
  assert.deepEqual(calls, ["link:https://example.com", "message:a\nb"]);
  for (const id of [1, 3, 5]) {
    assert.equal((sent.find((message) => message.id === id)!.error as { code: number }).code, -32602);
  }
});

test("display modes switch only between modes both sides offer", async () => {
  const { host, sent } = setup();
  initialize(host, { availableDisplayModes: ["inline", "fullscreen"] });
  host.receive({ jsonrpc: "2.0", id: 1, method: "ui/request-display-mode", params: { mode: "pip" } });
  host.receive({ jsonrpc: "2.0", id: 2, method: "ui/request-display-mode", params: { mode: "fullscreen" } });
  await flush();
  assert.deepEqual(sent.find((message) => message.id === 1)!.result, { mode: "inline" });
  assert.deepEqual(sent.find((message) => message.id === 2)!.result, { mode: "fullscreen" });

  const declined = setup();
  initialize(declined.host, { availableDisplayModes: ["inline"] });
  declined.host.receive({ jsonrpc: "2.0", id: 3, method: "ui/request-display-mode", params: { mode: "fullscreen" } });
  await flush();
  assert.deepEqual(declined.sent.find((message) => message.id === 3)!.result, { mode: "inline" });
});

test("host context changes are sent only after initialization, and only what changed", () => {
  const { host, sent, setTheme } = setup();
  setTheme("light");
  host.updateHostContext();
  assert.equal(sent.length, 0);
  initialize(host);
  sent.length = 0;
  host.updateHostContext();
  assert.equal(sent.length, 0, "nothing changed");
  setTheme("dark");
  host.updateHostContext();
  assert.deepEqual(sent, [
    {
      jsonrpc: "2.0",
      method: "ui/notifications/host-context-changed",
      params: { theme: "dark", styles: { variables: { "--color-background-primary": "#000000" } } }
    }
  ]);
});

test("size, teardown requests and unknown methods", async () => {
  const { host, sent, calls } = setup();
  initialize(host);
  host.receive({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 420 } });
  host.receive({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: "tall" } });
  host.receive({ jsonrpc: "2.0", method: "ui/notifications/request-teardown" });
  host.receive({ jsonrpc: "2.0", id: 9, method: "sampling/createMessage", params: {} });
  host.receive({ jsonrpc: "2.0", id: 10, method: "ping" });
  await flush();
  assert.deepEqual(calls, ["size:420", "teardown"]);
  assert.equal((sent.find((message) => message.id === 9)!.error as { code: number }).code, -32601);
  assert.deepEqual(sent.find((message) => message.id === 10)!.result, {});
});

test("an oversized message is refused and a disposed host posts nothing", async () => {
  const { host, sent } = setup();
  initialize(host);
  sent.length = 0;
  host.receive({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "x", arguments: { blob: "x".repeat(MCP_APP_MAX_MESSAGE_BYTES) } }
  });
  assert.equal((sent[0]!.error as { code: number }).code, -32600);
  host.dispose();
  host.receive({ jsonrpc: "2.0", id: 2, method: "ping" });
  assert.equal(sent.length, 1);
  // Not JSON-RPC at all.
  host.receive("hello");
});

test("teardown waits for the app's answer, or resolves at once before initialization", async () => {
  const early = setup();
  await early.host.teardown();
  assert.equal(early.sent.length, 0);

  const { host, sent } = setup();
  initialize(host);
  sent.length = 0;
  let done = false;
  const teardown = host.teardown().then(() => (done = true));
  const request = sent[0]!;
  assert.equal(request.method, "ui/resource-teardown");
  await flush();
  assert.equal(done, false);
  host.receive({ jsonrpc: "2.0", id: request.id, result: {} });
  await teardown;
  assert.equal(done, true);
});

test("too many requests in flight are refused, not queued", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { host, sent } = setup({
    readResource: async () => {
      await gate;
      return { contents: [] };
    }
  });
  initialize(host);
  sent.length = 0;
  for (let id = 1; id <= 17; id += 1) {
    host.receive({ jsonrpc: "2.0", id, method: "resources/read", params: { uri: "ui://x" } });
  }
  assert.deepEqual(sent.at(-1), { jsonrpc: "2.0", id: 17, error: { code: -32000, message: "Too many requests in flight." } });
  release();
  await flush();
});

test("downloads are read from embedded resources and links", async () => {
  let files: ReadonlyArray<McpAppDownload> = [];
  const { host, sent } = setup({
    downloadFile: async (next) => {
      files = next;
      if (next.length > 1) throw new McpAppHostRefusal("no");
    }
  });
  initialize(host);
  host.receive({
    jsonrpc: "2.0",
    id: 1,
    method: "ui/download-file",
    params: {
      contents: [{ type: "resource", resource: { uri: "ui://x/a/report.csv", mimeType: "text/csv", text: "a,b" } }]
    }
  });
  await flush();
  assert.equal(files[0]!.name, "report.csv");
  assert.deepEqual(sent.find((message) => message.id === 1)!.result, {});
  host.receive({
    jsonrpc: "2.0",
    id: 2,
    method: "ui/download-file",
    params: {
      contents: [
        { type: "resource_link", uri: "ui://x/b", name: "../../etc/passwd" },
        { type: "resource", resource: { uri: "ui://x/c", blob: Buffer.from("hi").toString("base64") } }
      ]
    }
  });
  await flush();
  assert.equal(files[0]!.name, "..-..-etc-passwd");
  assert.deepEqual(sent.find((message) => message.id === 2)!.result, { isError: true });
  host.receive({ jsonrpc: "2.0", id: 3, method: "ui/download-file", params: { contents: [] } });
  await flush();
  assert.equal((sent.find((message) => message.id === 3)!.error as { code: number }).code, -32602);
  assert.deepEqual([...mcpResourceBytes({ blob: Buffer.from("ok").toString("base64") })!], [111, 107]);
  assert.equal(mcpResourceBytes({}), undefined);
});

test("theme tokens map to the spec's standardized style names", () => {
  const variables = mcpAppStyleVariables({ "--background": "#000000", "--foreground": "#ffffff", "--radius": "0.5rem" });
  assert.deepEqual(variables, {
    "--color-background-primary": "#000000",
    "--color-background-inverse": "#ffffff",
    "--color-text-primary": "#ffffff",
    "--color-text-inverse": "#000000",
    "--border-radius-md": "0.5rem"
  });
});
