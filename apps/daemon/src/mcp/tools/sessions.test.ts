import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDaemonApi } from "../testing.ts";
import { chatSummary, head, shellSummary, snapshot, stamp, turn } from "../fixtures.ts";
import { MAX_RESULT_BYTES, ok } from "../result.ts";
import type { ToolContext } from "../tool.ts";
import { sessionTools } from "./sessions.ts";

const tool = (name: string) => sessionTools.find((t) => t.name === name)!;
const registry = { shells: [], ides: [], fileExplorers: [], browsers: [], agents: [
  { id: "claude", kind: "agent", name: "Claude Code", bin: ["claude"], enabled: true, installState: "idle", chat: { adapter: "claude" } },
  { id: "claudex", kind: "agent", name: "Claude Code × GPT", bin: ["claude"], enabled: true, installState: "idle", chat: { adapter: "claude" } },
  { id: "grok", kind: "agent", name: "Grok Build", bin: ["grok"], enabled: false, installState: "idle", chat: { adapter: "grok" } }
] };
const providers = { hostInstanceId: "h", providers: [{ id: "claude", refIds: ["claude", "claudex"], installed: true, version: "2", status: "ready", auth: { status: "authenticated" }, checkedAt: stamp(0), slashCommands: [], skills: [],
  capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: true, showPlanModeToggle: true, reportsContextWindow: true, compaction: { type: "slash-command", command: "/compact" } },
  models: [{ slug: "default", name: "Default", isDefault: true, capabilities: { optionDescriptors: [{ id: "effort", label: "Effort", type: "select", options: [{ id: "medium", label: "Medium", isDefault: true }, { id: "high", label: "High" }] }] } }, { slug: "haiku", name: "Haiku", capabilities: null }] }] };
const accounts = { accounts: [{ id: "acc-1", agent: "claude", label: "jasperclaude", email: null, plan: null, needsReauth: false, createdAt: stamp(0), importedAt: stamp(0) }, { id: "acc-2", agent: "codex", label: "e@x.io", email: "e@x.io", plan: null, needsReauth: false, createdAt: stamp(0), importedAt: stamp(0) }], defaults: { claude: "acc-1", codex: "acc-2", grok: null } };
const cliproxy = { state: "healthy", reasons: [], detail: null, version: null, defaultModel: "gpt-5.6-sol", backgroundModel: "", modelOverrides: {}, providers: [], routerProviders: [], accounts: [{ id: "acc-2", provider: "codex", label: "e@x.io" }], activeSessionCount: 0, testedClaudeCliVersion: null, xai: { state: "none", email: null, expiredAt: null, lastQuotaError: null, lastLinkError: null, link: null } };

async function harness(sessions = [chatSummary(), shellSummary()], snap = snapshot()) {
  const root = await mkdtemp(join(tmpdir(), "mcp-sess-"));
  await mkdir(join(root, "acme", "api"), { recursive: true });
  const api = new FakeDaemonApi(); api.fsRoot = root; api.workspacesDir = root;
  const projectPath = join(root, "acme", "api");
  const fix = (s: ReturnType<typeof chatSummary>) => ({ ...s, projectPath, cwd: projectPath });
  api.on("GET", "/api/sessions", { status: 200, body: sessions.map(fix) })
    .on("GET", "/api/sessions/c1/thread", { status: 200, body: { kind: "snapshot", thread: { ...snap, head: { ...snap.head, projectPath, cwd: projectPath } } } })
    .on("GET", "/api/registry", { status: 200, body: registry }).on("GET", "/api/agent/providers", { status: 200, body: providers })
    .on("GET", "/api/agent-accounts", { status: 200, body: accounts }).on("GET", "/api/cliproxy", { status: 200, body: cliproxy }).on("GET", "/api/cliproxy/models", { status: 200, body: { models: [], asOf: null } });
  const ctx: ToolContext = { api, todos: {} as never, files: {} as never, signal: new AbortController().signal, now: () => Date.parse("2026-09-22T12:00:00.000Z") };
  return { api, ctx, projectPath, root, close: () => rm(root, { recursive: true, force: true }) };
}

/** The body of the latest `POST /api/sessions`. */
function lastCreate(api: FakeDaemonApi): Record<string, unknown> & { chat: Record<string, unknown> } {
  return api.calls.filter((c) => c.method === "POST" && c.path === "/api/sessions").at(-1)!.body as Record<string, unknown> & { chat: Record<string, unknown> };
}

test("list_sessions: kind filter, project filter, attention ordering", async (t) => {
  // Tab orders are unique per project (the daemon assigns max+1), so the third tab is order 3.
  const waiting = chatSummary({ id: "c9", order: 3, hasPendingUserInput: true, activity: { state: "waiting", attention: "needs-input", lastOutputAt: null, needsAttentionAt: stamp(9) } });
  const h = await harness([chatSummary(), shellSummary(), waiting]); t.after(h.close);
  const all = await tool("list_sessions").run({ kind: "all", attention: false }, h.ctx);
  assert.deepEqual((all.sessions as { id: string; kind: string }[]).map((s) => [s.id, s.kind]), [["c1", "chat"], ["t1", "terminal"], ["c9", "chat"]]);
  const chats = await tool("list_sessions").run({ kind: "chat", attention: false, project: "acme/api" }, h.ctx);
  assert.deepEqual((chats.sessions as { id: string }[]).map((s) => s.id), ["c1", "c9"]);
  assert.deepEqual(h.api.calls.filter((c) => c.path === "/api/sessions").at(-1)?.query, { projectPath: h.projectPath });
  const att = await tool("list_sessions").run({ kind: "all", attention: true }, h.ctx);
  assert.deepEqual((att.sessions as { id: string; reason: string }[]).map((s) => [s.id, s.reason]), [["c9", "question"], ["c1", "completed"]]);
});

test("get_session returns a detail for a chat and a view for a terminal; unknown id errors", async (t) => {
  const h = await harness(); t.after(h.close);
  const chat = await tool("get_session").run({ sessionId: "c1" }, h.ctx);
  assert.equal((chat.session as { chat: { model: string } }).chat.model, "claude-fable-5-1[1m]");
  const term = await tool("get_session").run({ sessionId: "t1" }, h.ctx);
  assert.equal((term.session as { kind: string }).kind, "terminal");
  await assert.rejects(tool("get_session").run({ sessionId: "zz" }, h.ctx), (e: { code: string }) => e.code === "SESSION_NOT_FOUND");
});

test("create_session validates everything up front and posts the GUI's body (claude, then claudex, then a resume)", async (t) => {
  const h = await harness(); t.after(h.close);
  h.api.on("POST", "/api/sessions", ({ body }) => ({ status: 200, body: chatSummary({ id: "c1", refId: (body as { refId: string }).refId }) }));
  const r = await tool("create_session").run({ project: "acme/api", agent: "claude", model: "default", options: { effort: "high" }, runtimeMode: "approval-required", accountId: "acc-1", title: "Fixer" }, h.ctx);
  assert.equal((r.session as { id: string }).id, "c1");
  const created = h.api.calls.find((c) => c.method === "POST" && c.path === "/api/sessions")!.body;
  assert.deepEqual(created, { kind: "agent-chat", refId: "claude", projectPath: h.projectPath, cwd: h.projectPath, title: "Fixer", accountId: "acc-1",
    chat: { accountId: "acc-1", modelSelection: { model: "default", options: [{ id: "effort", value: "high" }] }, runtimeMode: "approval-required" } });
  h.api.calls.length = 0;
  await tool("create_session").run({ project: h.projectPath, agent: "claudex", runtimeMode: "full-access" }, h.ctx);
  const proxy = h.api.calls.find((c) => c.method === "POST" && c.path === "/api/sessions")!.body as Record<string, unknown>;
  assert.equal(proxy.model, "gpt-5.6-sol"); assert.equal(proxy.title, "Claude Code × GPT");
  assert.deepEqual(proxy.chat, { accountId: "acc-2", modelSelection: { model: "gpt-5.6-sol", options: [] }, runtimeMode: "full-access" });
  assert.equal(proxy.accountId, "acc-2", "no accountId → the seeded family default, pinned as the '+' menu does");
  h.api.on("GET", "/api/agents/conversations", { status: 200, body: { conversations: [{ id: "conv-1", agentRefId: "claude", title: "Earlier", updatedAt: stamp(1), home: "account", accountId: "acc-1" }] } });
  h.api.calls.length = 0;
  await tool("create_session").run({ project: "acme/api", resume: { conversationId: "conv-1" }, runtimeMode: "full-access" }, h.ctx);
  const resumed = h.api.calls.find((c) => c.method === "POST" && c.path === "/api/sessions")!.body as Record<string, unknown>;
  assert.equal(resumed.refId, "claude"); assert.equal(resumed.title, "Earlier"); assert.equal(resumed.accountId, "acc-1");
  assert.deepEqual((resumed.chat as { resume: unknown }).resume, { home: "account", conversationId: "conv-1" });
});

test("create_session: a proxy launcher whose family default is not seeded launches under an explicit System", async (t) => {
  const h = await harness(); t.after(h.close);
  // acc-2 (the codex family default) is no longer seeded into the proxy, so list_agents reports claudex's default as "system".
  h.api.on("GET", "/api/cliproxy", { status: 200, body: { ...cliproxy, accounts: [] } })
    .on("POST", "/api/sessions", ({ body }) => ({ status: 200, body: chatSummary({ id: "c1", refId: (body as { refId: string }).refId }) }));
  await tool("create_session").run({ project: "acme/api", agent: "claudex", runtimeMode: "full-access" }, h.ctx);
  assert.equal(lastCreate(h.api).accountId, "system");
  assert.equal(lastCreate(h.api).chat.accountId, "system");
});

test("create_session resume: a system-home row never forces System, a cliproxy row launches under its launcher, a mismatched agent is refused", async (t) => {
  const h = await harness(); t.after(h.close);
  h.api.on("POST", "/api/sessions", ({ body }) => ({ status: 200, body: chatSummary({ id: "c1", refId: (body as { refId: string }).refId }) }))
    .on("GET", "/api/agents/conversations", { status: 200, body: { conversations: [
      { id: "conv-sys", agentRefId: "claude", title: "", updatedAt: stamp(1), home: "system" },
      { id: "conv-proxy", agentRefId: "claude", proxyRefId: "claudex", title: "Via the proxy", updatedAt: stamp(2), home: "cliproxy" },
      { id: "conv-acc", agentRefId: "claude", title: "Earlier", updatedAt: stamp(3), home: "account", accountId: "acc-1" }
    ] } });
  await tool("create_session").run({ project: "acme/api", resume: { conversationId: "conv-sys" }, runtimeMode: "full-access" }, h.ctx);
  // Every managed home sees the system transcripts, so the family default (what the GUI's chip pre-selects) may resume it.
  assert.equal(lastCreate(h.api).accountId, undefined);
  assert.equal(lastCreate(h.api).chat.accountId, undefined);
  assert.deepEqual(lastCreate(h.api).chat.resume, { home: "system", conversationId: "conv-sys" });
  assert.equal(lastCreate(h.api).title, "Claude Code", "an untitled conversation falls back to the agent's name");
  await tool("create_session").run({ project: "acme/api", resume: { conversationId: "conv-sys" }, accountId: "system", runtimeMode: "full-access" }, h.ctx);
  assert.equal(lastCreate(h.api).accountId, "system");
  await tool("create_session").run({ project: "acme/api", resume: { conversationId: "conv-proxy" }, runtimeMode: "full-access" }, h.ctx);
  assert.equal(lastCreate(h.api).refId, "claudex"); assert.equal(lastCreate(h.api).model, "gpt-5.6-sol");
  assert.deepEqual(lastCreate(h.api).chat.resume, { home: "cliproxy", conversationId: "conv-proxy" });
  assert.equal(lastCreate(h.api).accountId, "acc-2", "a proxy launcher resumes under the account its '+' row pins");
  assert.equal(lastCreate(h.api).chat.accountId, "acc-2");
  const before = h.api.calls.length;
  await assert.rejects(tool("create_session").run({ project: "acme/api", agent: "claudex", resume: { conversationId: "conv-acc" }, runtimeMode: "full-access" }, h.ctx),
    (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && /belongs to claude/.test(e.message));
  assert.ok(!h.api.calls.slice(before).some((c) => c.method === "POST"), "nothing was created");
});

test("create_session cwd: resolved against the project, and it must be an existing directory inside the sandbox", async (t) => {
  const h = await harness(); t.after(h.close);
  await mkdir(join(h.projectPath, "src"));
  await writeFile(join(h.projectPath, "README.md"), "x");
  h.api.on("POST", "/api/sessions", { status: 200, body: chatSummary() });
  const run = (cwd: string) => tool("create_session").run({ project: "acme/api", agent: "claude", cwd, runtimeMode: "full-access" }, h.ctx);
  await run("src");
  assert.equal(lastCreate(h.api).cwd, join(h.projectPath, "src"));
  await run(join(h.projectPath, "src"));
  assert.equal(lastCreate(h.api).cwd, join(h.projectPath, "src"));
  const posts = h.api.calls.filter((c) => c.method === "POST").length;
  await assert.rejects(run("missing"), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
  await assert.rejects(run("README.md"), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
  await assert.rejects(run("../../.."), (e: { code: string }) => e.code === "PATH_NOT_ALLOWED");
  assert.equal(h.api.calls.filter((c) => c.method === "POST").length, posts, "nothing was created");
});

test("create_session refusals: unknown project, disabled agent, bad model, wrong-family account, cwd escape, unknown conversation, session cap", async (t) => {
  const h = await harness(); t.after(h.close);
  const run = (a: Record<string, unknown>) => tool("create_session").run({ runtimeMode: "full-access", ...a }, h.ctx);
  await assert.rejects(run({ project: "acme/nope", agent: "claude" }), (e: { code: string }) => e.code === "PROJECT_NOT_FOUND");
  await assert.rejects(run({ project: "acme/api", agent: "grok" }), (e: { message: string }) => /not available/.test(e.message));
  await assert.rejects(run({ project: "acme/api", agent: "claude", model: "gpt-9" }), (e: { message: string }) => /default, haiku/.test(e.message));
  await assert.rejects(run({ project: "acme/api", agent: "claude", accountId: "acc-2" }), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && /acc-1/.test(e.message));
  await assert.rejects(run({ project: "acme/api", agent: "claude", cwd: "/etc" }), (e: { code: string }) => e.code === "PATH_NOT_ALLOWED");
  h.api.on("GET", "/api/agents/conversations", { status: 200, body: { conversations: [] } });
  await assert.rejects(run({ project: "acme/api", agent: "claude", resume: { conversationId: "missing" } }), (e: { message: string }) => /list_conversations/.test(e.message));
  const many = Array.from({ length: 24 }, (_, i) => chatSummary({ id: `c${i}` }));
  const full = await harness(many); t.after(full.close);
  await assert.rejects(tool("create_session").run({ project: "acme/api", agent: "claude", runtimeMode: "full-access" }, full.ctx), (e: { code: string }) => e.code === "SESSION_BUSY");
  assert.ok(!h.api.calls.some((c) => c.method === "POST"), "nothing was created");
});

test("update_session: one /mode body for model+effort+runtimeMode, rename via PUT, account via /account, no-ops skipped", async (t) => {
  const h = await harness(); t.after(h.close);
  h.api.on("PUT", "/api/sessions/c1", { status: 200, body: chatSummary({ title: "New" }) }).on("POST", "/api/sessions/c1/mode", { status: 200, body: { seq: 11 } }).on("POST", "/api/sessions/c1/account", { status: 200, body: { seq: 12 } });
  const r = await tool("update_session").run({ sessionId: "c1", title: "New", model: "default", options: { effort: "medium" }, runtimeMode: "auto", accountId: "system", force: false }, h.ctx);
  assert.deepEqual(r.applied, ["title", "model", "options", "runtimeMode"]);
  const mode = h.api.calls.find((c) => c.path === "/api/sessions/c1/mode")!.body as Record<string, unknown>;
  assert.deepEqual(mode.modelSelection, { model: "default", options: [{ id: "effort", value: "medium" }] }); assert.equal(mode.runtimeMode, "auto");
  assert.ok(!h.api.calls.some((c) => c.path === "/api/sessions/c1/account"), "system → system is a no-op");
  assert.deepEqual(h.api.calls.find((c) => c.method === "PUT")!.body, { title: "New" });
  h.api.calls.length = 0;
  const acc = await tool("update_session").run({ sessionId: "c1", accountId: "acc-1", force: false }, h.ctx);
  assert.deepEqual(acc.applied, ["accountId"]);
  assert.deepEqual(h.api.calls.find((c) => c.path === "/api/sessions/c1/account")!.body, { commandId: (h.api.calls.find((c) => c.path === "/api/sessions/c1/account")!.body as { commandId: string }).commandId, accountId: "acc-1" });
});

test("update_session gates: busy without force, idle gate for accounts, opencode has no account, wrong family", async (t) => {
  const running = chatSummary({ chatSessionStatus: "running", latestTurn: { turnId: "t2", state: "running", startedAt: stamp(2), completedAt: null } });
  const h = await harness([running]); t.after(h.close);
  h.api.on("POST", "/api/sessions/c1/mode", { status: 200, body: { seq: 1 } });
  await assert.rejects(tool("update_session").run({ sessionId: "c1", runtimeMode: "auto", force: false }, h.ctx), (e: { code: string; message: string }) => e.code === "SESSION_BUSY" && /force/.test(e.message));
  await tool("update_session").run({ sessionId: "c1", runtimeMode: "auto", force: true }, h.ctx);
  await assert.rejects(tool("update_session").run({ sessionId: "c1", accountId: "acc-1", force: true }, h.ctx), (e: { code: string }) => e.code === "SESSION_BUSY");
  const oc = await harness([chatSummary({ refId: "opencode" })]); t.after(oc.close);
  await assert.rejects(tool("update_session").run({ sessionId: "c1", accountId: "acc-1", force: false }, oc.ctx), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && /OpenCode/.test(e.message));
  const idle = await harness(); t.after(idle.close);
  await assert.rejects(tool("update_session").run({ sessionId: "c1", accountId: "acc-2", force: false }, idle.ctx), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
});

test("update_session skips every field that already holds the requested value", async (t) => {
  const h = await harness([chatSummary()], snapshot({ head: head({ modelSelection: { model: "default", options: [{ id: "effort", value: "high" }] } }) })); t.after(h.close);
  const r = await tool("update_session").run({ sessionId: "c1", title: "Claude Code", model: "default", options: { effort: "high" }, runtimeMode: "full-access", accountId: "system", force: false }, h.ctx);
  assert.deepEqual(r.applied, []);
  assert.ok(!h.api.calls.some((c) => c.method === "PUT" || c.method === "POST"), "nothing was written");
});

test("update_session: a rename needs no catalogue entry; a write that fails mid-way reports only what landed", async (t) => {
  const retired = await harness([chatSummary({ refId: "retired-agent" })]); t.after(retired.close);
  retired.api.on("PUT", "/api/sessions/c1", { status: 200, body: chatSummary({ title: "Renamed" }) });
  assert.deepEqual((await tool("update_session").run({ sessionId: "c1", title: "Renamed", force: false }, retired.ctx)).applied, ["title"]);
  const h = await harness(); t.after(h.close);
  h.api.on("PUT", "/api/sessions/c1", { status: 200, body: chatSummary({ title: "New" }) })
    .on("POST", "/api/sessions/c1/mode", { status: 409, body: { error: { code: "COMMAND_REJECTED", message: "The thread is being reverted." } } });
  await assert.rejects(tool("update_session").run({ sessionId: "c1", title: "New", model: "haiku", runtimeMode: "auto", force: false }, h.ctx),
    (e: { code: string; detail: unknown }) => { assert.equal(e.code, "COMMAND_REJECTED"); assert.deepEqual(e.detail, { applied: ["title"] }); return true; });
});

test("interrupt/stop/close/compact/revert map to their commands with the right gates", async (t) => {
  const running = chatSummary({ chatSessionStatus: "running", latestTurn: { turnId: "t2", state: "running", startedAt: stamp(2), completedAt: null } });
  const three = [turn(), turn({ turnId: "t2", turnCount: 2, requestedAt: stamp(2), startedAt: stamp(2), completedAt: stamp(3) }), turn({ turnId: "t3", turnCount: 3, requestedAt: stamp(4), startedAt: stamp(4), completedAt: null, state: "running" })];
  const h = await harness([running, shellSummary()], snapshot({ head: head({ session: { status: "running", activeTurnId: "t3" }, turnCount: 3 }), turns: three })); t.after(h.close);
  for (const name of ["interrupt", "session/stop", "compact", "revert"]) h.api.on("POST", `/api/sessions/c1/${name}`, { status: 200, body: { seq: 7 } });
  h.api.on("DELETE", "/api/sessions/c1", { status: 204, body: null }).on("DELETE", "/api/sessions/t1", { status: 204, body: null });
  const i = await tool("interrupt_session").run({ sessionId: "c1" }, h.ctx);
  assert.equal(i.seq, 7); assert.deepEqual((h.api.calls.find((c) => c.path === "/api/sessions/c1/interrupt")!.body as { turnId: string }).turnId, "t3");
  await tool("stop_session").run({ sessionId: "c1" }, h.ctx);
  assert.ok(h.api.calls.some((c) => c.path === "/api/sessions/c1/session/stop"));
  assert.deepEqual(await tool("close_session").run({ sessionId: "t1" }, h.ctx), { closed: true, sessionId: "t1" });
  await tool("compact_session").run({ sessionId: "c1" }, h.ctx);
  await assert.rejects(tool("revert_session").run({ sessionId: "c1", keepTurns: 1 }, h.ctx), (e: { code: string }) => e.code === "SESSION_BUSY");
  const settled = [turn(), turn({ turnId: "t2", turnCount: 2, requestedAt: stamp(2), startedAt: stamp(2), completedAt: stamp(3) }), turn({ turnId: "t3", turnCount: 3, requestedAt: stamp(4), startedAt: stamp(4), completedAt: stamp(5) })];
  const idle = await harness([chatSummary()], snapshot({ head: head({ turnCount: 3 }), turns: settled })); t.after(idle.close);
  idle.api.on("POST", "/api/sessions/c1/revert", { status: 200, body: { seq: 8 } }).on("POST", "/api/sessions/c1/interrupt", { status: 200, body: { seq: 9 } });
  await tool("revert_session").run({ sessionId: "c1", keepTurns: 1 }, idle.ctx);
  assert.deepEqual((idle.api.calls.find((c) => c.path === "/api/sessions/c1/revert")!.body as { targetTurnCount: number }).targetTurnCount, 1);
  await assert.rejects(tool("revert_session").run({ sessionId: "c1", keepTurns: 3 }, idle.ctx), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
  await tool("interrupt_session").run({ sessionId: "c1" }, idle.ctx);
  assert.equal((idle.api.calls.find((c) => c.path === "/api/sessions/c1/interrupt")!.body as { turnId?: string }).turnId, undefined, "no running turn → stop background work");
  const grok = await harness([chatSummary({ refId: "grok" })]); t.after(grok.close);
  await assert.rejects(tool("revert_session").run({ sessionId: "c1", keepTurns: 0 }, grok.ctx), (e: { message: string }) => /rollback/.test(e.message));
  const fresh = await harness([chatSummary({ latestTurn: null })], snapshot({ head: head({ turnCount: 0 }), turns: [] })); t.after(fresh.close);
  await assert.rejects(tool("revert_session").run({ sessionId: "c1", keepTurns: 0 }, fresh.ctx), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && /no turns/.test(e.message));
});

test("interrupt_session and the busy gates read the thread head, not only the (lagging) summary", async (t) => {
  // The summary still says "ready"; the head just read says a turn is running.
  const h = await harness([chatSummary()], snapshot({ head: head({ session: { status: "running", activeTurnId: "t2" } }) })); t.after(h.close);
  h.api.on("POST", "/api/sessions/c1/interrupt", { status: 200, body: { seq: 3 } });
  await tool("interrupt_session").run({ sessionId: "c1" }, h.ctx);
  assert.equal((h.api.calls.find((c) => c.path === "/api/sessions/c1/interrupt")!.body as { turnId?: string }).turnId, "t2");
  await assert.rejects(tool("update_session").run({ sessionId: "c1", runtimeMode: "auto", force: false }, h.ctx), (e: { code: string }) => e.code === "SESSION_BUSY");
  await assert.rejects(tool("revert_session").run({ sessionId: "c1", keepTurns: 0 }, h.ctx), (e: { code: string }) => e.code === "SESSION_BUSY");
});

test("get_turn_diff defaults to the latest checkpointed turn, includes the checkpoint files and bounds the diff to the result budget", async (t) => {
  const snap = snapshot({ head: head({ turnCount: 5 }), checkpoints: [{ turnId: "t2", checkpointTurnCount: 2, checkpointRef: "r", status: "ready", files: [{ path: "a.ts", additions: 1, deletions: 0 }], assistantMessageId: null, completedAt: stamp(3) }] });
  const h = await harness([chatSummary()], snap); t.after(h.close);
  const big = "x".repeat(90_000);
  h.api.on("GET", "/api/sessions/c1/turns/2/diff", { status: 200, body: { fromTurnCount: 1, toTurnCount: 2, diff: big } });
  const r = await tool("get_turn_diff").run({ sessionId: "c1" }, h.ctx);
  assert.equal(r.turn, 2); assert.equal(r.fromTurn, 1); assert.deepEqual(r.files, [{ path: "a.ts", additions: 1, deletions: 0 }]); assert.equal(r.truncated, true);
  const diff = r.diff as string;
  assert.ok(big.startsWith(diff) && diff.length > 59_000, `kept ${diff.length} chars`);
  const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8");
  assert.ok(bytes(r) <= MAX_RESULT_BYTES, `${bytes(r)} bytes`);
  assert.deepEqual(ok(r).structuredContent, r, "the tool bounds itself: ok() never has to shed it");
  assert.deepEqual(h.api.calls.find((c) => c.path.endsWith("/diff"))!.query, { ignoreWhitespace: "1" });
  // Escapes and multibyte characters are paid at their JSON-escaped UTF-8 size, not their length.
  const heavy = "é\"\n".repeat(30_000);
  h.api.on("GET", "/api/sessions/c1/turns/2/diff", { status: 200, body: { fromTurnCount: 1, toTurnCount: 2, diff: heavy } });
  const hr = await tool("get_turn_diff").run({ sessionId: "c1", turn: 2 }, h.ctx);
  assert.equal(hr.truncated, true); assert.ok(heavy.startsWith(hr.diff as string));
  assert.ok(bytes(hr) <= MAX_RESULT_BYTES && bytes(hr) > MAX_RESULT_BYTES - 8, `${bytes(hr)} bytes`);
  h.api.on("GET", "/api/sessions/c1/turns/2/diff", { status: 200, body: { fromTurnCount: 1, toTurnCount: 2, diff: "+a\n" } });
  const small = await tool("get_turn_diff").run({ sessionId: "c1", turn: 2 }, h.ctx);
  assert.equal(small.diff, "+a\n"); assert.equal(small.truncated, false);
  await assert.rejects(tool("get_turn_diff").run({ sessionId: "c1", turn: 5 }, h.ctx), (e: { code: string }) => e.code === "THREAD_NOT_FOUND" || e.code === "NOT_FOUND" || e.code === "INVALID_ARGUMENT");
});
