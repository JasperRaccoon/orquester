/**
 * MCP Apps' consent gating (spec 2026-10-14 §3): which of an app's requests
 * wait on the user, what is asked, and what the app is told — through the
 * real consent queue the banner dock answers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { McpAppOperation, McpAppReference } from "@orquester/api/agent-chat";

import { MCP_APP_MAX_DOWNLOAD_BYTES, mcpAppActions, type McpAppActionDeps } from "./mcp-app-actions";
import { McpAppConsentQueue } from "./mcp-app-consent";
import { McpAppHostRefusal } from "./mcp-app-host";

const app: McpAppReference = {
  attachmentId: "s1-0f8fad5b-d9cb-469f-a165-70867728950e-html",
  server: "tracker",
  tool: "board",
  resourceUri: "ui://tracker/board"
};

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(options: { readOnly?: boolean; callable?: boolean; dock?: boolean; overrides?: Partial<McpAppActionDeps> } = {}) {
  const queue = new McpAppConsentQueue();
  const detach = options.dock === false ? () => undefined : queue.attachDock("s1");
  const requests: Array<{ operation: McpAppOperation; body: Record<string, unknown> }> = [];
  const sent: string[] = [];
  const saved: string[] = [];
  const deps: McpAppActionDeps = {
    app,
    request: async <T>(operation: McpAppOperation, body: Record<string, unknown>): Promise<T> => {
      requests.push({ operation, body });
      if (operation === "tool-info") {
        return {
          callable: options.callable ?? true,
          readOnly: options.readOnly ?? false,
          title: "Move card",
          modelContext: true
        } as T;
      }
      if (operation === "read-resource") {
        return { contents: [{ uri: body.uri, mimeType: "text/plain", text: "linked" }] } as T;
      }
      return { content: [{ type: "text", text: "done" }] } as T;
    },
    ask: (input) => queue.ask("frame-1", { ...input, sessionId: "s1", appName: app.server }),
    sendMessage: async (text) => {
      sent.push(text);
    },
    linkAllowed: () => true,
    openLink: () => undefined,
    saveFile: (file) => saved.push(`${file.name}:${file.mimeType}:${file.bytes.byteLength}`),
    ...options.overrides
  };
  return { actions: mcpAppActions(deps), queue, requests, sent, saved, detach };
}

const refusalOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof McpAppHostRefusal, `expected a refusal, got ${String(error)}`);
    return error.message;
  }
  assert.fail("expected the request to be refused");
};

test("a read-only tool runs without asking", async () => {
  const { actions, queue, requests } = setup({ readOnly: true });
  const call = actions.callTool({ name: "list", arguments: {} });
  await flush();
  assert.equal(queue.pending("s1").length, 0);
  const result = await call;
  assert.deepEqual(result, { content: [{ type: "text", text: "done" }] });
  assert.deepEqual(
    requests.map((entry) => entry.operation),
    ["tool-info", "call-tool"]
  );
});

test("any other tool waits on the user's consent, with its arguments shown", async () => {
  const { actions, queue, requests } = setup();
  const call = actions.callTool({ name: "move", arguments: { card: 7, to: "done" } });
  await flush();
  const [request] = queue.pending("s1");
  assert.ok(request);
  assert.equal(request.kind, "tool");
  assert.equal(request.title, "Run Move card?");
  assert.equal(request.appName, "tracker");
  assert.match(request.detail, /"card": 7/);
  assert.equal(requests.some((entry) => entry.operation === "call-tool"), false, "nothing runs before consent");
  queue.answer(request.id, true);
  assert.deepEqual(await call, { content: [{ type: "text", text: "done" }] });
  assert.deepEqual(requests.at(-1), { operation: "call-tool", body: { name: "move", arguments: { card: 7, to: "done" } } });
});

test("a declined tool never runs", async () => {
  const { actions, queue, requests } = setup();
  const call = actions.callTool({ name: "move", arguments: {} });
  await flush();
  queue.answer(queue.pending("s1")[0]!.id, false);
  assert.equal(await refusalOf(call), "Declined by the user.");
  assert.equal(requests.some((entry) => entry.operation === "call-tool"), false);
});

test("a tool hidden from apps is refused before anyone is asked", async () => {
  const { actions, queue } = setup({ callable: false });
  const refused = refusalOf(actions.callTool({ name: "admin", arguments: {} }));
  await flush();
  assert.equal(queue.pending("s1").length, 0);
  assert.equal(await refused, "This app cannot call that tool.");
});

test("with no dock to ask, nothing runs and the app is told so", async () => {
  const { actions, requests } = setup({ dock: false });
  assert.equal(
    await refusalOf(actions.callTool({ name: "move", arguments: {} })),
    "Orquester could not ask for approval here."
  );
  assert.equal(await refusalOf(actions.sendMessage("hi")), "Orquester could not ask for approval here.");
  assert.equal(requests.some((entry) => entry.operation === "call-tool"), false);
});

test("a message always asks, then is sent as the user", async () => {
  const { actions, queue, sent } = setup();
  const message = actions.sendMessage("Ship it");
  await flush();
  const [request] = queue.pending("s1");
  assert.equal(request?.kind, "message");
  assert.equal(request?.detail, "Ship it");
  queue.answer(request!.id, true);
  await message;
  assert.deepEqual(sent, ["Ship it"]);
  const readOnly = setup({ overrides: { sendMessage: undefined } });
  assert.equal(await refusalOf(readOnly.actions.sendMessage("x")), "Messages cannot be sent from here.");
  // Read at each request: a row that became read-only refuses before anyone is asked.
  let writable = true;
  const live = setup({ overrides: { canSendMessage: () => writable } });
  writable = false;
  const refused = refusalOf(live.actions.sendMessage("x"));
  await flush();
  assert.equal(live.queue.pending("s1").length, 0);
  assert.deepEqual(live.sent, []);
  assert.equal(await refused, "Messages cannot be sent from here.");
});

test("a download asks, reads a linked file from the app's server, and keeps the size bound", async () => {
  const { actions, queue, saved, requests } = setup();
  const download = actions.downloadFile([
    { kind: "embedded", name: "a.txt", mimeType: "text/plain", bytes: new Uint8Array([1, 2]) },
    { kind: "link", name: "b.txt", uri: "ui://tracker/b" }
  ]);
  await flush();
  const [request] = queue.pending("s1");
  assert.equal(request?.title, "Save 2 files?");
  queue.answer(request!.id, true);
  await download;
  assert.deepEqual(saved, ["a.txt:text/plain:2", "b.txt:text/plain:6"]);
  assert.deepEqual(requests.at(-1), { operation: "read-resource", body: { uri: "ui://tracker/b" } });

  const big = actions.downloadFile([
    { kind: "embedded", name: "big.bin", mimeType: "application/octet-stream", bytes: new Uint8Array(MCP_APP_MAX_DOWNLOAD_BYTES + 1) }
  ]);
  await flush();
  queue.answer(queue.pending("s1")[0]!.id, true);
  assert.equal(await refusalOf(big), "big.bin is too large to save.");
});

test("reads and model context ask nothing; daemon refusals reach the app verbatim", async () => {
  const { actions, queue, requests } = setup({
    overrides: {
      request: async <T>(operation: McpAppOperation, body: Record<string, unknown>): Promise<T> => {
        requests.push({ operation, body });
        if (operation === "model-context") throw new Error("This agent cannot take context from an MCP app.");
        return { contents: [] } as T;
      }
    }
  });
  await actions.readResource({ uri: "ui://tracker/data" });
  assert.equal(
    await refusalOf(actions.updateModelContext({ content: [{ type: "text", text: "board: 3 cards" }] })),
    "This agent cannot take context from an MCP app."
  );
  assert.deepEqual(requests, [
    { operation: "read-resource", body: { uri: "ui://tracker/data" } },
    { operation: "model-context", body: { content: [{ type: "text", text: "board: 3 cards" }] } }
  ]);
  assert.equal(queue.pending("s1").length, 0);
});

test("links open only while the app may act", async () => {
  const opened: string[] = [];
  const { actions } = setup({ overrides: { linkAllowed: () => false, openLink: (url) => opened.push(url) } });
  assert.equal(await refusalOf(actions.openLink("https://x.example.com")), "Links open only from a click in the app.");
  assert.deepEqual(opened, []);
});

test("the queue: one session's requests, withdrawn with their frame, unanswerable once the dock goes", async () => {
  const queue = new McpAppConsentQueue();
  const unavailable = queue.ask("f", { sessionId: "s1", kind: "tool", appName: "a", title: "t", detail: "" });
  assert.equal(queue.pending("s1").length, 0, "no prompt without a dock that can answer it");
  assert.equal(await unavailable, undefined);
  const detach = queue.attachDock("s1");
  const second = queue.attachDock("s1");
  const first = queue.ask("f1", { sessionId: "s1", kind: "tool", appName: "a", title: "one", detail: "" });
  const other = queue.ask("f2", { sessionId: "s1", kind: "message", appName: "a", title: "two", detail: "" });
  const view = queue.pending("s1");
  assert.deepEqual(
    view.map((request) => request.title),
    ["one", "two"]
  );
  assert.equal(queue.pending("s1"), view, "stable until the next change");
  assert.equal(queue.pending("s2").length, 0);
  let notified = 0;
  const unsubscribe = queue.subscribe(() => (notified += 1));
  queue.withdraw("f1");
  assert.equal(await first, false);
  assert.equal(notified, 1);
  detach();
  assert.equal(queue.pending("s1").length, 1, "another dock of the session is still mounted");
  second();
  assert.equal(await other, undefined);
  assert.equal(queue.pending("s1").length, 0);
  unsubscribe();
});
