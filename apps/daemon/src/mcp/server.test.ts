import { test } from "node:test";
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { createDefaultClientConfig, createDefaultDaemonConfig } from "@orquester/config";
import { createServer } from "../index.ts";
import { chatSummary } from "./fixtures.ts";
import { FakeDaemonApi } from "./testing.ts";
import { allTools, registerMcp, SERVER_INSTRUCTIONS, SERVER_VERSION, type McpDeps } from "./server.ts";

const EXPECTED_TOOLS = ["list_projects", "list_agents", "list_conversations", "list_sessions", "get_session", "get_turn_diff", "create_session", "update_session", "interrupt_session", "stop_session", "close_session", "revert_session", "compact_session", "send_message", "implement_plan", "read_transcript", "answer_question", "dismiss_question", "resolve_approval", "wait_for_session", "get_usage", "get_cost", "list_files", "read_file", "list_todos", "create_todo", "update_todo", "delete_todo", "toggle_todo_item"];

// Spec §4.5's annotation rules, spelled out literally so a drifting constant fails here too.
const READ = { readOnlyHint: true, idempotentHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false };
const WRITE_IDEMPOTENT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true };
const DESTROY = { readOnlyHint: false, destructiveHint: true, idempotentHint: true };

/** Spec §12's tools/list snapshot: required params and annotations per tool — a guard against drift. */
const CONTRACT: Record<string, { required: string[]; annotations: object }> = {
  list_projects: { required: [], annotations: READ },
  list_agents: { required: [], annotations: READ },
  list_conversations: { required: ["project"], annotations: READ },
  list_sessions: { required: [], annotations: READ },
  get_session: { required: ["sessionId"], annotations: READ },
  get_turn_diff: { required: ["sessionId"], annotations: READ },
  create_session: { required: ["project"], annotations: WRITE },
  update_session: { required: ["sessionId"], annotations: WRITE_IDEMPOTENT },
  interrupt_session: { required: ["sessionId"], annotations: WRITE_IDEMPOTENT },
  stop_session: { required: ["sessionId"], annotations: WRITE_IDEMPOTENT },
  close_session: { required: ["sessionId"], annotations: DESTROY },
  revert_session: { required: ["sessionId", "keepTurns"], annotations: DESTROY },
  compact_session: { required: ["sessionId"], annotations: WRITE_IDEMPOTENT },
  send_message: { required: ["sessionId"], annotations: WRITE },
  implement_plan: { required: ["sessionId"], annotations: WRITE },
  read_transcript: { required: ["sessionId"], annotations: READ },
  answer_question: { required: ["sessionId", "answers"], annotations: WRITE },
  dismiss_question: { required: ["sessionId"], annotations: WRITE },
  resolve_approval: { required: ["sessionId", "decision"], annotations: WRITE },
  wait_for_session: { required: [], annotations: READ },
  get_usage: { required: [], annotations: READ },
  get_cost: { required: [], annotations: READ },
  list_files: { required: ["path"], annotations: READ },
  read_file: { required: ["path"], annotations: READ },
  list_todos: { required: [], annotations: READ },
  create_todo: { required: ["name"], annotations: WRITE },
  update_todo: { required: ["id"], annotations: WRITE_IDEMPOTENT },
  delete_todo: { required: ["id"], annotations: DESTROY },
  // Omitting `checked` flips the item, so a repeated call is not a no-op: not idempotent.
  toggle_todo_item: { required: ["id", "item"], annotations: WRITE }
};

type ListedTool = { name: string; title?: string; description: string; annotations?: object; inputSchema: { properties?: Record<string, { description?: string }>; required?: string[] } };

/**
 * light-my-request's mock request never reports `destroyed` once its body is consumed, so the MCP
 * transport's @hono/node-server layer arms a 500 ms drain timer per injected POST that later throws
 * `socket.destroySoon is not a function`. A real IncomingMessage whose body Fastify read IS destroyed
 * by then; marking the mock the same way makes it behave like the real object.
 */
async function markConsumed(request: FastifyRequest): Promise<void> {
  (request.raw as unknown as { destroyed: boolean }).destroyed = true;
}

function mcpApp(deps: Partial<McpDeps> & Pick<McpDeps, "createApi">): FastifyInstance {
  const app = Fastify();
  registerMcp(app, { todos: {} as never, files: {} as never, ...deps });
  app.addHook("preHandler", markConsumed);
  return app;
}

async function postMcp(app: FastifyInstance, payload: object, authorization = "Bearer abc") {
  const response = await app.inject({ method: "POST", url: "/mcp", headers: { accept: "application/json, text/event-stream", "content-type": "application/json", authorization }, payload });
  assert.equal(response.statusCode, 200, response.body);
  return JSON.parse(response.body);
}

const call = (id: number, name: string, args: Record<string, unknown>) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

test("tools/list is exactly the 29 spec tools, each with a title, annotations and described params", async () => {
  const app = mcpApp({ createApi: () => new FakeDaemonApi() });
  try {
    const list = await postMcp(app, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const tools = list.result.tools as ListedTool[];
    assert.deepEqual(tools.map((t) => t.name), EXPECTED_TOOLS);
    for (const t of tools) {
      assert.ok(t.title, `${t.name} has a title`);
      assert.ok(t.annotations, `${t.name} has annotations`);
      assert.ok(t.description.length <= 600, `${t.name} description is ${t.description.length} chars`);
      assert.doesNotMatch(t.description, /❯|Escape|keystroke/i, `${t.name} carries no TUI guidance`);
      for (const [p, s] of Object.entries(t.inputSchema.properties ?? {})) assert.ok(s.description, `${t.name}.${p} is described`);
    }
    assert.equal(allTools().length, EXPECTED_TOOLS.length);
    assert.equal(new Set(allTools().map((t) => t.name)).size, EXPECTED_TOOLS.length, "no tool is registered twice");
  } finally { await app.close(); }
});

test("tools/list pins every tool's required params and annotations (spec §12 snapshot)", async () => {
  const app = mcpApp({ createApi: () => new FakeDaemonApi() });
  try {
    const list = await postMcp(app, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const actual = Object.fromEntries((list.result.tools as ListedTool[]).map((t) => [t.name, { required: [...(t.inputSchema.required ?? [])].sort(), annotations: t.annotations }]));
    const expected = Object.fromEntries(Object.entries(CONTRACT).map(([name, c]) => [name, { required: [...c.required].sort(), annotations: c.annotations }]));
    assert.deepEqual(actual, expected);
  } finally { await app.close(); }
});

test("initialize names the server orquester 2.0.0 and carries the instructions", async () => {
  const app = mcpApp({ createApi: () => new FakeDaemonApi() });
  try {
    const init = await postMcp(app, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
    assert.deepEqual(init.result.serverInfo, { name: "orquester", version: "2.0.0" });
    assert.equal(SERVER_VERSION, "2.0.0");
    assert.equal(init.result.instructions, SERVER_INSTRUCTIONS);
  } finally { await app.close(); }
});

test("a tool call returns structuredContent + text; a ToolError becomes isError with a code; the api is built with the caller's bearer", async () => {
  const api = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [chatSummary()] })
    .on("GET", "/api/registry", { status: 200, body: { shells: [], ides: [], fileExplorers: [], browsers: [], agents: [] } })
    .on("GET", "/api/agent-accounts", { status: 200, body: { accounts: [], defaults: {} } }).on("GET", "/api/agent/providers", { status: 503, body: null });
  const seenAuth: (string | undefined)[] = [];
  const app = mcpApp({ createApi: (authorization) => { seenAuth.push(authorization); return api; } });
  try {
    const r = await postMcp(app, call(2, "list_sessions", { kind: "all" }));
    assert.deepEqual(seenAuth, ["Bearer abc"]);
    assert.equal(r.result.isError, undefined);
    assert.equal(r.result.structuredContent.sessions[0].id, "c1");
    assert.equal(JSON.parse(r.result.content[0].text).sessions[0].id, "c1");
    const e = await postMcp(app, call(3, "get_session", { sessionId: "nope" }));
    assert.equal(e.result.isError, true);
    assert.equal(e.result.structuredContent.code, "SESSION_NOT_FOUND");
    assert.match(e.result.content[0].text, /^SESSION_NOT_FOUND: /);
  } finally { await app.close(); }
});

test("the SDK applies each tool's zod defaults before run(): list_sessions {} answers with kind all, attention off", async () => {
  const api = new FakeDaemonApi()
    .on("GET", "/api/sessions", { status: 200, body: [chatSummary({ activity: { state: "idle", attention: null, lastOutputAt: null, needsAttentionAt: null } }), chatSummary({ id: "t9", kind: "shell", refId: "bash", title: "bash", order: 2, activity: { state: "idle", attention: null, lastOutputAt: null, needsAttentionAt: null } })] })
    .on("GET", "/api/registry", { status: 200, body: { shells: [], ides: [], fileExplorers: [], browsers: [], agents: [] } })
    .on("GET", "/api/agent-accounts", { status: 200, body: { accounts: [], defaults: {} } }).on("GET", "/api/agent/providers", { status: 503, body: null });
  const app = mcpApp({ createApi: () => api });
  try {
    const r = await postMcp(app, call(4, "list_sessions", {}));
    assert.equal(r.result.isError, undefined, r.result.content?.[0]?.text);
    // Without the defaults `kind` would be undefined, which drops every chat tab (only t9 would come back).
    assert.deepEqual((r.result.structuredContent.sessions as { id: string }[]).map((s) => s.id), ["c1", "t9"]);
  } finally { await app.close(); }
});

test("todo and file tools reach the injected TodoTools and FsTools", async () => {
  const seen: unknown[] = [];
  const todos = { list: (sel: unknown) => { seen.push(["list", sel]); return [{ id: "td1", name: "Plan", scope: "workspace", body: "", createdAt: "x", updatedAt: "x" }]; } };
  const files = { readFileWindow: async (path: string, opts: unknown) => { seen.push(["read", path, opts]); return { path: "/w/a.txt", text: "hello", size: 5, offset: 0, truncated: false }; } };
  const app = mcpApp({ createApi: () => new FakeDaemonApi(), todos: todos as never, files: files as never });
  try {
    const listed = await postMcp(app, call(5, "list_todos", { workspace: "acme" }));
    assert.deepEqual(listed.result.structuredContent, { todos: [{ id: "td1", name: "Plan", scope: "workspace", body: "", createdAt: "x", updatedAt: "x" }] });
    const read = await postMcp(app, call(6, "read_file", { path: "a.txt" }));
    assert.deepEqual(read.result.structuredContent, { path: "/w/a.txt", text: "hello", size: 5, offset: 0, truncated: false });
    assert.deepEqual(seen, [["list", { workspace: "acme" }], ["read", "a.txt", { offset: 0, maxBytes: 65536 }]]);
  } finally { await app.close(); }
});

test("GET and DELETE /mcp answer 405 with Allow: POST", async () => {
  const app = mcpApp({ createApi: () => new FakeDaemonApi() });
  try {
    for (const method of ["GET", "DELETE"] as const) {
      const res = await app.inject({ method, url: "/mcp" });
      assert.equal(res.statusCode, 405);
      assert.equal(res.headers.allow, "POST");
      assert.equal(JSON.parse(res.body).error.message, "Method not allowed.");
    }
  } finally { await app.close(); }
});

test("POST /mcp answers 406 unless Accept lists both application/json and text/event-stream", async () => {
  const app = mcpApp({ createApi: () => new FakeDaemonApi() });
  try {
    const res = await app.inject({ method: "POST", url: "/mcp", headers: { accept: "application/json", "content-type": "application/json" }, payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} } });
    assert.equal(res.statusCode, 406);
    assert.match(JSON.parse(res.body).error.message, /Not Acceptable/);
  } finally { await app.close(); }
});

test("SERVER_INSTRUCTIONS stays under the ~2KB budget and names the load-bearing rules", () => {
  assert.ok(SERVER_INSTRUCTIONS.length <= 2048, `${SERVER_INSTRUCTIONS.length} chars`);
  for (const needle of ["list_agents", "wait_for_session", "cursor", "% USED", "sessionId"]) assert.ok(SERVER_INSTRUCTIONS.includes(needle), needle);
  assert.doesNotMatch(SERVER_INSTRUCTIONS, /❯|Escape|keystroke|read_terminal|send_keys/i);
});

// --- The daemon's own mount (index.ts), driven through `inject` only: nothing listens. ---

type CreateServerArgs = Parameters<typeof createServer>;
const USERNAME = "admin";
// authorizeCredential sha256-compares the stored hash string with the credential's hash half, so any string works.
const PASSWORD_HASH = "$2a$12$0123456789012345678901uFAKEfakeFAKEfakeFAKEfa";
const BEARER = `Bearer ${Buffer.from(`${USERNAME}:${PASSWORD_HASH}`).toString("base64")}`;

function daemonApp(mode: "local" | "remote", services: Record<string, unknown>): FastifyInstance {
  const config = createDefaultDaemonConfig({ env: {} });
  config.transports.http.username = USERNAME;
  config.transports.http.passwordHash = PASSWORD_HASH;
  const root = "/nonexistent-orquester-mcp-test";
  const resolved = { daemonDir: root, workspacesDir: root, workspacesMetaFile: `${root}/workspaces.json`, fsRoot: root } as unknown as CreateServerArgs[1];
  const app = createServer(config, resolved, createDefaultClientConfig(`${root}/daemon.sock`), createWriteStream("/dev/null"), services as unknown as CreateServerArgs[4], { authRequired: mode === "remote", mode });
  app.addHook("preHandler", markConsumed);
  return app;
}

test("the daemon mounts /mcp on the HTTP transport behind the bearer hook, and every tool's daemon call carries the caller's bearer", async () => {
  const usageCalls: boolean[] = [];
  const app = daemonApp("remote", {
    sessions: { list: () => [chatSummary()] },
    registry: { list: () => ({ shells: [], ides: [], fileExplorers: [], browsers: [], agents: [] }) },
    agentAccounts: { list: () => ({ accounts: [], defaults: {} }) },
    usage: { snapshot: async (force: boolean) => { usageCalls.push(force); return { agents: [{ id: "claude", available: true, stale: false, session: { percent: 51, resetsAt: null }, weekly: null }] }; } }
  });
  try {
    const anonymous = await app.inject({ method: "POST", url: "/mcp", headers: { accept: "application/json, text/event-stream", "content-type": "application/json" }, payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} } });
    assert.equal(anonymous.statusCode, 401);
    assert.equal(JSON.parse(anonymous.body).code, "UNAUTHORIZED");
    const wrong = await app.inject({ method: "POST", url: "/mcp", headers: { accept: "application/json, text/event-stream", "content-type": "application/json", authorization: "Bearer d3Jvbmc6d3Jvbmc=" }, payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} } });
    assert.equal(wrong.statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: "/mcp", headers: { authorization: BEARER } })).statusCode, 405);

    const list = await postMcp(app, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, BEARER);
    assert.equal(list.result.tools.length, EXPECTED_TOOLS.length);
    // Each call below reaches the real routes through InjectDaemonApi; without the forwarded bearer they would answer 401.
    const sessions = await postMcp(app, call(3, "list_sessions", {}), BEARER);
    assert.equal(sessions.result.isError, undefined, sessions.result.content?.[0]?.text);
    assert.deepEqual((sessions.result.structuredContent.sessions as { id: string }[]).map((s) => s.id), ["c1"]);
    const usage = await postMcp(app, call(4, "get_usage", {}), BEARER);
    assert.equal(usage.result.isError, undefined, usage.result.content?.[0]?.text);
    assert.deepEqual(usageCalls, [false]);
    assert.equal(usage.result.structuredContent.agents[0].id, "claude");
  } finally { await app.close(); }
});

test("the unix-socket transport never serves /mcp", async () => {
  const app = daemonApp("local", {});
  try {
    const res = await app.inject({ method: "POST", url: "/mcp", headers: { accept: "application/json, text/event-stream", "content-type": "application/json" }, payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} } });
    assert.equal(res.statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: "/mcp" })).statusCode, 404);
  } finally { await app.close(); }
});
