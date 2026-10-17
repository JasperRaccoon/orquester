/**
 * The daemon's socket-only session-tool route, driven by the agent host's own
 * forwarder over a real unix socket (design 2026-10-14 §1.1): the context is
 * derived server-side, the host's bearer is required, a cancelled call aborts
 * its handler, and a daemon that is gone is an error result — never a throw
 * or a hang.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import Fastify, { type FastifyInstance } from "fastify";

import { agentHostAuthValue } from "../agent-host/host-protocol.ts";
import { createDaemonForwarder } from "../agent-host/session-tools/forwarder.ts";
import { agentChatRoutes } from "@orquester/api/agent-chat";
import type { DaemonApi } from "../mcp/daemon-api.ts";
import { chatSummary, head, message, snapshot, turn } from "../mcp/fixtures.ts";
import { defineTool, READ_ONLY, type AnyOrquesterTool } from "../mcp/catalog/contract.ts";
import { toolByName } from "../mcp/catalog/index.ts";
import { z } from "zod";
import { FakeDaemonApi } from "../mcp/testing.ts";
import { DAEMON_UNAVAILABLE_MESSAGE, jsonResult } from "./results.ts";
import { buildThreadCaller, registerSessionToolsRoute, type SessionToolThread } from "./route.ts";
import { TEST_CHAT_TOOLS, TEST_PNG_BASE64, testChatTool } from "./testing.ts";
import { SecretRequestRegistry } from "../agent-chat/secret-requests.ts";
import type { AgentChatSecretRequestEventPayload } from "@orquester/api/agent-chat";

const TOKEN = "host-token-0123456789";
// A real project directory: the route canonicalises the caller's project (and "" for none).
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "st-route-ws-")));
const WS = join(ROOT, "ws");
const PROJECT = join(WS, "w/proj-a");
mkdirSync(join(PROJECT, "sub"), { recursive: true });
test.after(() => rmSync(ROOT, { recursive: true, force: true }));
const THREADS: Record<string, SessionToolThread> = {
  "thread-a": { projectPath: PROJECT, cwd: join(PROJECT, "sub"), agentId: "codex" },
  "thread-gone": { projectPath: join(WS, "w/removed"), cwd: join(WS, "w/removed"), agentId: "codex" }
};
/** The daemon's view of thread-a: its tab and its snapshot (the route builds the caller from them). */
function fakeApiFor(): FakeDaemonApi {
  const api = new FakeDaemonApi()
    .on("GET", "/api/sessions", {
      status: 200,
      body: [
        chatSummary({ id: "thread-a", projectPath: PROJECT, cwd: join(PROJECT, "sub") }),
        chatSummary({ id: "thread-gone", projectPath: join(WS, "w/removed"), cwd: join(WS, "w/removed") })
      ]
    })
    .on("GET", agentChatRoutes.thread("thread-a"), { status: 200, body: { kind: "snapshot", thread: snapshot({ head: head({ id: "thread-a", runtimeMode: "auto" }) }) } })
    .on("GET", agentChatRoutes.thread("thread-gone"), { status: 200, body: { kind: "snapshot", thread: snapshot({ head: head({ id: "thread-gone" }) }) } });
  api.fsRoot = ROOT;
  api.workspacesDir = WS;
  return api;
}
const fakeApi = fakeApiFor();

/** The chat tools the route serves, by name. */
const lookupOf = (tools: readonly AnyOrquesterTool[]) => {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return (name: string) => byName.get(name);
};

/** A tool that parks until its call is cancelled, and says when the handler saw the abort. */
function holdingTools() {
  let sawAbort!: () => void;
  const aborted = new Promise<void>((resolve) => {
    sawAbort = resolve;
  });
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const tools = [
    testChatTool({
      name: "hold",
      title: "Hold",
      description: "Parks until cancelled.",
      input: {},
      run: (_args, ctx) =>
        new Promise((resolve) => {
          started();
          ctx.signal.addEventListener("abort", () => {
            sawAbort();
            resolve(jsonResult({ late: true }));
          });
        })
    })
  ];
  return { tools, aborted, running };
}

async function daemon(
  t: { after(fn: () => Promise<void>): void },
  tools: readonly AnyOrquesterTool[],
  api: DaemonApi | null = fakeApi,
  secretRequests?: SecretRequestRegistry
) {
  const dir = await mkdtemp(join(tmpdir(), "st-route-"));
  const socketPath = join(dir, "d.sock");
  const app: FastifyInstance = Fastify();
  registerSessionToolsRoute(app, {
    authorizeHost: (authorization) => authorization === agentHostAuthValue(TOKEN),
    resolveThread: (threadId) => THREADS[threadId] ?? null,
    api: () => api,
    lookup: lookupOf(tools),
    ...(secretRequests !== undefined ? { secretRequests } : {})
  });
  await app.listen({ path: socketPath });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { app, socketPath };
}

const forwarderFor = (socketPath: string, token = TOKEN) => createDaemonForwarder({ socketPath: () => socketPath, token });
const textOf = (result: { content: unknown[] }) => (result.content[0] as { text?: string }).text ?? "";

test("a call runs with the context the daemon derived — thread record, not arguments", async (t) => {
  const { socketPath } = await daemon(t, TEST_CHAT_TOOLS);
  const forward = forwarderFor(socketPath);
  const result = await forward(
    { threadId: "thread-a", callId: "toolu_1", name: "echo", arguments: { text: "hi" } },
    new AbortController().signal
  );
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    text: "hi",
    threadId: "thread-a",
    projectPath: PROJECT,
    cwd: join(PROJECT, "sub"),
    agentId: "codex",
    callId: "toolu_1"
  });
  // A tab whose project was removed has no own project: "" (the contract), never the stale path.
  const gone = await forward({ threadId: "thread-gone", callId: "c", name: "echo", arguments: { text: "x" } }, new AbortController().signal);
  assert.equal((gone.structuredContent as { projectPath: string }).projectPath, "");
  // A caller cannot smuggle an identity in as an argument: arguments are strict.
  const smuggled = await forward(
    { threadId: "thread-a", callId: "c", name: "echo", arguments: { text: "hi", threadId: "thread-b" } },
    new AbortController().signal
  );
  assert.equal(smuggled.isError, true);
  assert.match(textOf(smuggled), /^INVALID_ARGUMENT: .*threadId/);
});

test("results: image content, a coded handler error, an unknown tool", async (t) => {
  const { socketPath } = await daemon(t, TEST_CHAT_TOOLS);
  const forward = forwarderFor(socketPath);
  const signal = new AbortController().signal;
  const pixel = await forward({ threadId: "thread-a", callId: "c", name: "pixel", arguments: {} }, signal);
  assert.deepEqual(pixel.content[0], { type: "image", data: TEST_PNG_BASE64, mimeType: "image/png" });
  assert.deepEqual(pixel.structuredContent, { width: 1, height: 1 });
  const failed = await forward({ threadId: "thread-a", callId: "c", name: "fail", arguments: {} }, signal);
  assert.equal(failed.isError, true);
  assert.equal(textOf(failed), "CONFLICT: This tool always fails.");
  const unknown = await forward({ threadId: "thread-a", callId: "c", name: "nope", arguments: {} }, signal);
  assert.equal(unknown.isError, true);
  assert.match(textOf(unknown), /^TOOL_NOT_FOUND/);
});

test("only the host's bearer is honoured, and only for a thread the daemon knows", async (t) => {
  const { app, socketPath } = await daemon(t, TEST_CHAT_TOOLS);
  const signal = new AbortController().signal;
  const wrong = await forwarderFor(socketPath, "not-the-token")(
    { threadId: "thread-a", callId: "c", name: "echo", arguments: { text: "x" } },
    signal
  );
  assert.equal(wrong.isError, true);
  assert.match(textOf(wrong), /^UNAUTHORIZED/);
  const bare = await app.inject({ method: "POST", url: "/api/agent-host/session-tools/call", payload: { threadId: "thread-a", name: "echo" } });
  assert.equal(bare.statusCode, 401);
  const unknownThread = await forwarderFor(socketPath)(
    { threadId: "thread-zzz", callId: "c", name: "echo", arguments: { text: "x" } },
    signal
  );
  assert.equal(unknownThread.isError, true);
  assert.match(textOf(unknownThread), /^THREAD_NOT_FOUND/);
});

test("a daemon that cannot serve yet, or is not there at all, answers the restart message", async (t) => {
  const { socketPath } = await daemon(t, TEST_CHAT_TOOLS, null);
  const signal = new AbortController().signal;
  const starting = await forwarderFor(socketPath)({ threadId: "thread-a", callId: "c", name: "echo", arguments: { text: "x" } }, signal);
  assert.deepEqual(starting, { content: [{ type: "text", text: DAEMON_UNAVAILABLE_MESSAGE }], isError: true });
  const gone = await forwarderFor(join(tmpdir(), "no-such-orquester-daemon.sock"))(
    { threadId: "thread-a", callId: "c", name: "echo", arguments: { text: "x" } },
    signal
  );
  assert.deepEqual(gone, { content: [{ type: "text", text: DAEMON_UNAVAILABLE_MESSAGE }], isError: true });
});

test("a daemon that dies mid-call answers the restart message", async (t) => {
  const hold = holdingTools();
  const { app, socketPath } = await daemon(t, hold.tools);
  const pending = forwarderFor(socketPath)({ threadId: "thread-a", callId: "c", name: "hold", arguments: {} }, new AbortController().signal);
  await hold.running;
  app.server.closeAllConnections();
  const result = await pending;
  assert.deepEqual(result, { content: [{ type: "text", text: DAEMON_UNAVAILABLE_MESSAGE }], isError: true });
  // …and the handler was cancelled with the connection.
  await hold.aborted;
});

test("cancelling the call on the host aborts the daemon-side handler", async (t) => {
  const hold = holdingTools();
  const { socketPath } = await daemon(t, hold.tools);
  const controller = new AbortController();
  const pending = forwarderFor(socketPath)({ threadId: "thread-a", callId: "c", name: "hold", arguments: {} }, controller.signal);
  await hold.running;
  controller.abort();
  const result = await pending;
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^CANCELLED/);
  await hold.aborted;
});

test("request_secret over the socket: the answer reaches the call; the host's cancel closes the card", async (t) => {
  const events: AgentChatSecretRequestEventPayload[] = [];
  const waiters: Array<(payload: AgentChatSecretRequestEventPayload) => void> = [];
  const secretRequests = new SecretRequestRegistry({
    publish: (payload) => {
      events.push(payload);
      for (const waiter of waiters.splice(0)) waiter(payload);
    }
  });
  const nextEvent = () => new Promise<AgentChatSecretRequestEventPayload>((resolve) => waiters.push(resolve));
  const { socketPath } = await daemon(t, [toolByName("request_secret", "chat")!], fakeApi, secretRequests);
  const forward = forwarderFor(socketPath);
  const args = { name: "API_KEY", prompt: "Paste it." };

  // Answered: the value comes back in this call's result, as the route's 200.
  let opened = nextEvent();
  const answered = forward({ threadId: "thread-a", callId: "c1", name: "request_secret", arguments: args }, new AbortController().signal);
  const card = (await opened).request;
  assert.equal(card.sessionId, "thread-a", "the card is the CALLER's thread's");
  const outcome = secretRequests.answer("thread-a", card.requestId, { answer: "provide", value: "v-123456" });
  assert.equal(((await answered).structuredContent as { value?: string }).value, "v-123456");
  // `provided` only once the route's reply actually went out.
  assert.equal(await outcome, "provided");
  assert.equal(events.at(-1)?.outcome, "provided");

  // Cancelled on the host (the provider's cancel, a Stop, the session ending): the card closes.
  opened = nextEvent();
  const controller = new AbortController();
  const cancelled = forward({ threadId: "thread-a", callId: "c2", name: "request_secret", arguments: args }, controller.signal);
  await opened;
  const closed = nextEvent();
  controller.abort();
  assert.deepEqual([(await closed).open, (await closed).outcome], [false, "cancelled"]);
  assert.equal((await cancelled).isError, true);
  assert.deepEqual(secretRequests.list("thread-a"), []);
});

test("the caller is built from the thread's tab and snapshot: title, mode, planning, exchange, workflow-owned; a tool of any group runs", async (t) => {
  const whoami = defineTool({
    name: "whoami", title: "Who am I", description: "d", input: {}, audiences: ["chat"], toolset: "core", tier: "read",
    scope: async () => ({ projects: [], sessions: [], reads: "none", writes: false, causesTurnIn: [] }),
    annotations: READ_ONLY, resultKind: "json",
    run: async (_args, ctx) => {
      const { delivered: _delivered, ...caller } = ctx.caller as typeof ctx.caller & { delivered?: unknown };
      return { caller };
    }
  });
  const notes = defineTool({
    name: "notes_only", title: "Notes", description: "d", input: { x: z.string().optional() }, audiences: ["chat"], toolset: "notes", tier: "read",
    scope: async () => ({ projects: [], sessions: [], reads: "none", writes: false, causesTurnIn: [] }),
    annotations: READ_ONLY, resultKind: "json", run: async () => ({ ran: true })
  });
  const api = new FakeDaemonApi()
    .on("GET", "/api/sessions", {
      status: 200,
      body: [
        chatSummary({ id: "wf-chat", owner: { kind: "workflow", workflowId: "wf", runId: "r", nodeId: "n" } }),
        chatSummary({ id: "thread-a", title: "Auth work", projectPath: PROJECT, lineage: { parentThreadId: "wf-chat", relation: "delegate", createdAt: "x", agentCreated: true } })
      ]
    })
    .on("GET", agentChatRoutes.thread("thread-a"), {
      status: 200,
      body: {
        kind: "snapshot",
        thread: snapshot({
          head: head({ id: "thread-a", runtimeMode: "auto", session: { status: "running", activeTurnId: "t2" } }),
          turns: [turn(), turn({ turnId: "t2", state: "running", interactionMode: "plan", causedBy: { threadId: "peer", exchangeId: "ex-9", hop: 2 } })]
        })
      }
    });
  api.fsRoot = ROOT;
  api.workspacesDir = WS;
  const dir = await mkdtemp(join(tmpdir(), "st-route-"));
  const socketPath = join(dir, "d.sock");
  const app: FastifyInstance = Fastify();
  const tools = new Map([whoami, notes].map((tool) => [tool.name, tool]));
  registerSessionToolsRoute(app, {
    authorizeHost: (authorization) => authorization === agentHostAuthValue(TOKEN),
    resolveThread: (threadId) => THREADS[threadId] ?? null,
    api: () => api,
    lookup: (name) => tools.get(name)
  });
  await app.listen({ path: socketPath });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const forward = forwarderFor(socketPath);
  const result = await forward({ threadId: "thread-a", callId: "toolu_9", name: "whoami", arguments: {} }, new AbortController().signal);
  assert.deepEqual((result.structuredContent as { caller: unknown }).caller, {
    kind: "thread",
    threadId: "thread-a",
    title: "Auth work",
    projectPath: PROJECT,
    workspace: "w",
    cwd: join(PROJECT, "sub"),
    agentId: "codex",
    callId: "toolu_9",
    runtimeMode: "auto",
    planning: true,
    workflowOwned: true,
    exchange: { id: "ex-9", hop: 2 }
  });
  // A `notes` tool (a group once off by default) runs: no per-chat tool switch exists.
  const notesCall = await forward({ threadId: "thread-a", callId: "c", name: "notes_only", arguments: {} }, new AbortController().signal);
  assert.notEqual(notesCall.isError, true, textOf(notesCall));
  assert.deepEqual(notesCall.structuredContent, { ran: true });
});

test("a session-tool call builds its caller from the thread's HEAD, never its snapshot", async () => {
  // A running default-mode turn a steer switched to plan, caused by another chat's exchange at hop 2.
  const running = turn({ turnId: "t2", state: "running", completedAt: null, interactionMode: "default", causedBy: { threadId: "other", exchangeId: "ex-1", hop: 2 } });
  const api = new FakeDaemonApi()
    .on("GET", "/api/sessions", { status: 200, body: [chatSummary({ id: "thread-a", projectPath: PROJECT, cwd: join(PROJECT, "sub") })] })
    .on("GET", agentChatRoutes.thread("thread-a"), {
      status: 200,
      body: {
        kind: "snapshot",
        thread: snapshot({
          head: head({ id: "thread-a", runtimeMode: "auto-accept-edits", session: { status: "running", activeTurnId: "t2" } }),
          turns: [turn(), running],
          items: [message("user", "plan it instead", { turnId: "t2", interactionMode: "plan" })]
        })
      }
    });
  api.fsRoot = ROOT;
  api.workspacesDir = WS;
  const caller = await buildThreadCaller(api, "thread-a", THREADS["thread-a"]!, "call-1");
  assert.equal(caller.runtimeMode, "auto-accept-edits");
  assert.equal(caller.planning, true);
  assert.deepEqual(caller.exchange, { id: "ex-1", hop: 2 });
  assert.deepEqual(
    api.calls.filter((call) => call.path.startsWith("/api/sessions/thread-a/")).map((call) => call.path),
    [agentChatRoutes.threadHead("thread-a")]
  );
});
