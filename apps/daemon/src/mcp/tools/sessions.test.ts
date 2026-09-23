import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ThreadActivityItem, ThreadItem, ThreadSnapshotPayload } from "@orquester/api/agent-chat";
import type { DaemonResponse } from "../daemon-api.ts";
import type { ToolError } from "../errors.ts";
import { busEvent, FakeDaemonApi } from "../testing.ts";
import { activity, chatSummary, head, message, shellSummary, snapshot, stamp, turn } from "../fixtures.ts";
import { MAX_RESULT_BYTES, ok } from "../result.ts";
import type { ToolContext } from "../tool.ts";
import { REWIND_RECHECK_MS, REWIND_WAIT_MS, sessionTools } from "./sessions.ts";

const tool = (name: string) => sessionTools.find((t) => t.name === name)!;
const registry = { shells: [], ides: [], fileExplorers: [], browsers: [], agents: [
  { id: "claude", kind: "agent", name: "Claude Code", bin: ["claude"], enabled: true, installState: "idle", chat: { adapter: "claude" } },
  { id: "claudex", kind: "agent", name: "Claude Code × GPT", bin: ["claude"], enabled: true, installState: "idle", chat: { adapter: "claude" } },
  { id: "claudemix", kind: "agent", name: "Claude Code × Mixed", bin: ["claude"], enabled: true, installState: "idle", chat: { adapter: "claude" } },
  { id: "grok", kind: "agent", name: "Grok Build", bin: ["grok"], enabled: false, installState: "idle", chat: { adapter: "grok" } }
] };
const providers = { hostInstanceId: "h", providers: [{ id: "claude", refIds: ["claude", "claudex", "claudemix"], installed: true, version: "2", status: "ready", auth: { status: "authenticated" }, checkedAt: stamp(0), slashCommands: [], skills: [],
  capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: true, showPlanModeToggle: true, reportsContextWindow: true, compaction: { type: "slash-command", command: "/compact" } },
  models: [{ slug: "default", name: "Default", isDefault: true, capabilities: { optionDescriptors: [{ id: "effort", label: "Effort", type: "select", options: [{ id: "medium", label: "Medium", isDefault: true }, { id: "high", label: "High" }] }] } }, { slug: "haiku", name: "Haiku", capabilities: null },
    // Not the default, and it takes options: an options-only change on it must keep it. (haiku takes none.)
    { slug: "opus", name: "Opus", capabilities: { optionDescriptors: [{ id: "effort", label: "Effort", type: "select", options: [{ id: "low", label: "Low" }, { id: "medium", label: "Medium", isDefault: true }, { id: "high", label: "High" }] }, { id: "thinking", label: "Thinking", type: "boolean" }] } }] }] };
const accounts = { accounts: [{ id: "acc-1", agent: "claude", label: "jasperclaude", email: null, plan: null, needsReauth: false, createdAt: stamp(0), importedAt: stamp(0) }, { id: "acc-2", agent: "codex", label: "e@x.io", email: "e@x.io", plan: null, needsReauth: false, createdAt: stamp(0), importedAt: stamp(0) }], defaults: { claude: "acc-1", codex: "acc-2", grok: null } };
// acc-2 (codex) and acc-1 (claude) are seeded, so both proxy launchers have a seeded family default: claudex acc-2, claudemix acc-1.
const cliproxy = { state: "healthy", reasons: [], detail: null, version: null, defaultModel: "gpt-5.6-sol", backgroundModel: "", modelOverrides: {}, providers: [], routerProviders: [], accounts: [{ id: "acc-2", provider: "codex", label: "e@x.io" }, { id: "acc-1", provider: "claude", label: "jasperclaude" }], activeSessionCount: 0, testedClaudeCliVersion: null, xai: { state: "none", email: null, expiredAt: null, lastQuotaError: null, lastLinkError: null, link: null } };

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

test("list_sessions attention:true orders as wait_for_session does: by the attention instant, a tie to the newer tab", async (t) => {
  const flagged = (id: string, needsAttentionAt: string, createdAt: string, order: number) => chatSummary({ id, order, createdAt, activity: { state: "idle", attention: "finished", lastOutputAt: null, needsAttentionAt } });
  // 2026-09-21T23:00:05Z: the oldest instant of the three, yet the greatest string.
  const h = await harness([flagged("offset", "2026-09-22T01:00:05.000+02:00", stamp(0), 1), flagged("older", stamp(6), stamp(0), 2), flagged("newer", stamp(6), stamp(2), 3)]); t.after(h.close);
  const r = await tool("list_sessions").run({ kind: "all", attention: true }, h.ctx);
  assert.deepEqual((r.sessions as { id: string }[]).map((s) => s.id), ["newer", "older", "offset"]);
});

test("no session tool reads an empty string as omitted: an empty project, agent, model or cwd is refused, never a default", async (t) => {
  const h = await harness(); t.after(h.close);
  // list_sessions refuses an empty project the way wait_for_session does — never "every project".
  await assert.rejects(tool("list_sessions").run({ project: "", kind: "all", attention: false }, h.ctx),
    (e: { code: string; message: string }) => e.code === "PROJECT_NOT_FOUND" && /^project is required/.test(e.message));
  await assert.rejects(tool("list_sessions").run({ project: "  ", kind: "all", attention: false }, h.ctx), (e: { code: string }) => e.code === "PROJECT_NOT_FOUND");
  assert.ok(!h.api.calls.some((c) => c.path === "/api/sessions"), "nothing was listed");
  // The schema refuses an empty agent, model or cwd: each would otherwise fall back to the default one.
  const refuses = (name: string, args: Record<string, unknown>, field: string) => {
    const parsed = z.object(tool(name).input).safeParse(args);
    assert.equal(parsed.success, false, `${name}.${field}: ""`);
    assert.deepEqual((parsed as z.SafeParseError<unknown>).error.issues.map((i) => i.path.join(".")), [field], `${name}.${field}`);
  };
  refuses("create_session", { project: "acme/api", agent: "" }, "agent");
  refuses("create_session", { project: "acme/api", agent: "claude", model: "" }, "model");
  refuses("create_session", { project: "acme/api", agent: "claude", cwd: "" }, "cwd");
  refuses("update_session", { sessionId: "c1", model: "" }, "model");
  // An empty accountId reaches the account check, which names the valid ones.
  await assert.rejects(tool("create_session").run({ project: "acme/api", agent: "claude", accountId: "", runtimeMode: "full-access" }, h.ctx),
    (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && /^Account "" is not usable with claude\. Valid: system, acc-1\.$/.test(e.message));
  await assert.rejects(tool("update_session").run({ sessionId: "c1", accountId: "", force: false }, h.ctx), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
  assert.ok(!h.api.calls.some((c) => c.method !== "GET"), "nothing was created or changed");
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

test("create_session: claudemix is the Claude main loop through the proxy — a Claude-catalogue selection, no top-level model, the seeded Claude default", async (t) => {
  const h = await harness(); t.after(h.close);
  h.api.on("POST", "/api/sessions", ({ body }) => ({ status: 200, body: chatSummary({ id: "c1", refId: (body as { refId: string }).refId }) }));
  await tool("create_session").run({ project: "acme/api", agent: "claudemix", options: { effort: "high" }, runtimeMode: "full-access" }, h.ctx);
  // A top-level model becomes ANTHROPIC_MODEL (acc-prefixed once several accounts are seeded); for claudemix the daemon
  // resolves its own Claude default there instead, exactly as the '+' menu leaves it.
  assert.ok(!("model" in lastCreate(h.api)), "no top-level model");
  assert.equal(lastCreate(h.api).accountId, "acc-1", "no accountId → the seeded Claude family default");
  assert.deepEqual(lastCreate(h.api).chat, { accountId: "acc-1", modelSelection: { model: "default", options: [{ id: "effort", value: "high" }] }, runtimeMode: "full-access" });
  await tool("create_session").run({ project: "acme/api", agent: "claudemix", model: "haiku", runtimeMode: "full-access" }, h.ctx);
  assert.ok(!("model" in lastCreate(h.api)));
  assert.deepEqual(lastCreate(h.api).chat.modelSelection, { model: "haiku", options: [] });
  const posts = h.api.calls.filter((c) => c.method === "POST").length;
  await assert.rejects(tool("create_session").run({ project: "acme/api", agent: "claudemix", model: "gpt-5.6-sol", runtimeMode: "full-access" }, h.ctx),
    (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && /default, haiku/.test(e.message));
  assert.equal(h.api.calls.filter((c) => c.method === "POST").length, posts, "claudex's proxy models are not claudemix's: nothing was created");
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

test("create_session refuses to resume a proxy-home conversation that names no launcher (list_conversations says resumable:false)", async (t) => {
  const h = await harness(); t.after(h.close);
  h.api.on("POST", "/api/sessions", ({ body }) => ({ status: 200, body: chatSummary({ id: "c1", refId: (body as { refId: string }).refId }) }))
    .on("GET", "/api/agents/conversations", { status: 200, body: { conversations: [{ id: "conv-orphan", agentRefId: "claude", title: "Proxy, launcher unknown", updatedAt: stamp(2), home: "cliproxy" }] } });
  for (const agent of [undefined, "claude"]) {
    await assert.rejects(tool("create_session").run({ project: "acme/api", ...(agent ? { agent } : {}), resume: { conversationId: "conv-orphan" }, runtimeMode: "full-access" }, h.ctx),
      (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && e.message === "Conversation \"conv-orphan\" is not resumable: it lives in a proxy home with no launcher. Pick a row with resumable: true from list_conversations.", String(agent));
  }
  assert.ok(!h.api.calls.some((c) => c.method === "POST"), "nothing was created — plain claude would have opened an empty session");
});

test("create_session: a disabled agent's refusal carries the registry's disabledReason when there is one", async (t) => {
  const h = await harness(); t.after(h.close);
  const down = { ...registry, agents: registry.agents.map((a) => (a.id === "claudex" ? { ...a, enabled: false, disabledReason: "proxy down" } : a)) };
  h.api.on("GET", "/api/registry", { status: 200, body: down });
  await assert.rejects(tool("create_session").run({ project: "acme/api", agent: "claudex", runtimeMode: "full-access" }, h.ctx),
    (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && e.message === "claudex is not available on this host: proxy down.");
  assert.ok(!h.api.calls.some((c) => c.method === "POST"), "nothing was created");
});

test("create_session: a registry read that fails while naming the reason leaves the plain refusal, never an INTERNAL", async (t) => {
  const h = await harness(); t.after(h.close);
  const down = { ...registry, agents: registry.agents.map((a) => (a.id === "claudex" ? { ...a, enabled: false, disabledReason: "proxy down" } : a)) };
  const plain = (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && e.message === "claudex is not available on this host (not installed or disabled).";
  // The catalogue's own read succeeds; the second one, for the reason, fails three ways.
  for (const second of [() => { throw new Error("socket hang up"); }, () => ({ status: 500, body: null }), () => ({ status: 200, body: { agents: { claudex: {} } } })]) {
    let reads = 0;
    h.api.on("GET", "/api/registry", () => ((reads += 1) === 1 ? { status: 200, body: down } : second()));
    await assert.rejects(tool("create_session").run({ project: "acme/api", agent: "claudex", runtimeMode: "full-access" }, h.ctx), plain);
    assert.equal(reads, 2);
  }
  assert.ok(!h.api.calls.some((c) => c.method === "POST"), "nothing was created");
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
  await assert.rejects(run({ project: "acme/api", agent: "grok" }), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && e.message === "grok is not available on this host (not installed or disabled).");
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

test("create_session: a read that fails after the create names the created session, so a retry does not open a second one", async (t) => {
  const h = await harness(); t.after(h.close);
  h.api.on("POST", "/api/sessions", { status: 200, body: chatSummary() })
    .on("GET", "/api/sessions/c1/thread", { status: 503, body: { error: { code: "HOST_UNAVAILABLE", message: "The agent host is restarting. Retry the same commandId.", detail: { retryAfterMs: 500 } } } });
  const create = () => tool("create_session").run({ project: "acme/api", agent: "claude", runtimeMode: "full-access" }, h.ctx);
  await assert.rejects(create(), (e: { code: string; message: string; detail: unknown }) => {
    assert.equal(e.code, "HOST_UNAVAILABLE", "the read's own code");
    assert.equal(e.message, "Session c1 was created but could not be read: The agent host is restarting. Retry the same commandId.");
    assert.deepEqual(e.detail, { sessionId: "c1", created: true, retryAfterMs: 500 });
    return true;
  });
  // A thrown failure keeps its safe INTERNAL message (logged, never echoed) and still names the created session.
  const logged = t.mock.method(console, "error", () => {});
  h.api.on("GET", "/api/sessions/c1/thread", () => { throw new Error("socket hang up /var/lib/orquester/daemon/agent-host.sock"); });
  await assert.rejects(create(), (e: { code: string; message: string; detail: unknown }) => {
    assert.equal(e.code, "INTERNAL");
    assert.equal(e.message, "Session c1 was created but could not be read: Internal error handling the tool call.");
    assert.deepEqual(e.detail, { sessionId: "c1", created: true });
    return true;
  });
  assert.equal(logged.mock.callCount(), 1);
  assert.equal(h.api.calls.filter((c) => c.method === "POST" && c.path === "/api/sessions").length, 2, "one create per call: the tool never retries it");
});

test("create_session: a failed read's own detail can never hide which tab was created — sessionId and created:true win a key clash", async (t) => {
  const h = await harness(); t.after(h.close);
  h.api.on("POST", "/api/sessions", { status: 200, body: chatSummary() })
    .on("GET", "/api/sessions/c1/thread", { status: 503, body: { error: { code: "HOST_UNAVAILABLE", message: "The agent host is restarting.", detail: { retryAfterMs: 250, created: false, sessionId: "some-other-tab" } } } });
  await assert.rejects(tool("create_session").run({ project: "acme/api", agent: "claude", runtimeMode: "full-access" }, h.ctx), (e: { code: string; detail: unknown }) => {
    assert.equal(e.code, "HOST_UNAVAILABLE");
    assert.deepEqual(e.detail, { retryAfterMs: 250, sessionId: "c1", created: true });
    return true;
  });
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

test("update_session during a turn: a call whose every field already holds its value is a no-op, not SESSION_BUSY", async (t) => {
  const running = chatSummary({ chatSessionStatus: "running", latestTurn: { turnId: "t2", state: "running", startedAt: stamp(2), completedAt: null } });
  const h = await harness([running], snapshot({ head: head({ session: { status: "running", activeTurnId: "t2" }, modelSelection: { model: "default", options: [{ id: "effort", value: "high" }] } }) })); t.after(h.close);
  const r = await tool("update_session").run({ sessionId: "c1", title: "Claude Code", model: "default", options: { effort: "high" }, runtimeMode: "full-access", accountId: "system", force: false }, h.ctx);
  assert.deepEqual(r.applied, []);
  assert.equal((r.session as { id: string }).id, "c1");
  assert.ok(!h.api.calls.some((c) => c.method === "PUT" || c.method === "POST"), "nothing was written");
  // A value that would change still restarts the agent, so it is still refused mid-turn.
  await assert.rejects(tool("update_session").run({ sessionId: "c1", options: { effort: "medium" }, force: false }, h.ctx), (e: { code: string }) => e.code === "SESSION_BUSY");
});

test("update_session: an options-only change keeps the head's model and merges onto the head's options", async (t) => {
  // "opus" is not the catalogue default: without the head's selection the model would silently become "default".
  const h = await harness([chatSummary()], snapshot({ head: head({ modelSelection: { model: "opus", options: [{ id: "effort", value: "low" }, { id: "thinking", value: true }] } }) })); t.after(h.close);
  h.api.on("POST", "/api/sessions/c1/mode", { status: 200, body: { seq: 6 } });
  const r = await tool("update_session").run({ sessionId: "c1", options: { effort: "high" }, force: false }, h.ctx);
  assert.deepEqual(r.applied, ["options"]);
  const modes = h.api.calls.filter((c) => c.path === "/api/sessions/c1/mode");
  assert.equal(modes.length, 1);
  const { commandId, ...mode } = modes[0].body as Record<string, unknown>;
  assert.equal(typeof commandId, "string");
  assert.deepEqual(mode, { modelSelection: { model: "opus", options: [{ id: "effort", value: "high" }, { id: "thinking", value: true }] } });
});

test("update_session on a claudemix thread: the Claude catalogue applies, and an options-only change keeps the head's Claude model", async (t) => {
  const h = await harness([chatSummary({ refId: "claudemix", accountId: "acc-1" })], snapshot({ head: head({ refId: "claudemix", accountId: "acc-1", modelSelection: { model: "opus", options: [{ id: "thinking", value: true }] } }) })); t.after(h.close);
  h.api.on("POST", "/api/sessions/c1/mode", { status: 200, body: { seq: 5 } });
  await assert.rejects(tool("update_session").run({ sessionId: "c1", model: "gpt-5.6-sol", force: false }, h.ctx), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && /default, haiku/.test(e.message));
  const r = await tool("update_session").run({ sessionId: "c1", options: { effort: "high" }, force: false }, h.ctx);
  assert.deepEqual(r.applied, ["options"]);
  const modes = h.api.calls.filter((c) => c.path === "/api/sessions/c1/mode");
  assert.equal(modes.length, 1, "one /mode, and none for the refused proxy model");
  const { commandId, ...mode } = modes[0].body as Record<string, unknown>;
  assert.equal(typeof commandId, "string");
  assert.deepEqual(mode, { modelSelection: { model: "opus", options: [{ id: "thinking", value: true }, { id: "effort", value: "high" }] } });
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

test("interrupt_session names the running turn, and with none stops the background work; stop_session posts session/stop", async (t) => {
  const running = chatSummary({ chatSessionStatus: "running", latestTurn: { turnId: "t2", state: "running", startedAt: stamp(2), completedAt: null } });
  const three = [turn(), turn({ turnId: "t2", turnCount: 2, requestedAt: stamp(2), startedAt: stamp(2), completedAt: stamp(3) }), turn({ turnId: "t3", turnCount: 3, requestedAt: stamp(4), startedAt: stamp(4), completedAt: null, state: "running" })];
  const h = await harness([running, shellSummary()], snapshot({ head: head({ session: { status: "running", activeTurnId: "t3" }, turnCount: 3 }), turns: three })); t.after(h.close);
  for (const name of ["interrupt", "session/stop"]) h.api.on("POST", `/api/sessions/c1/${name}`, { status: 200, body: { seq: 7 } });
  const i = await tool("interrupt_session").run({ sessionId: "c1" }, h.ctx);
  assert.equal(i.seq, 7);
  assert.deepEqual(commandBodies(h.api, "interrupt"), [{ turnId: "t3" }]);
  const stopped = await tool("stop_session").run({ sessionId: "c1" }, h.ctx);
  assert.equal(stopped.seq, 7);
  assert.deepEqual(commandBodies(h.api, "session/stop"), [{}]);
  const idle = await harness([chatSummary()], snapshot({ head: head({ turnCount: 3 }), turns: three.map((x) => ({ ...x, state: "completed" as const, completedAt: stamp(5) })) })); t.after(idle.close);
  idle.api.on("POST", "/api/sessions/c1/interrupt", { status: 200, body: { seq: 9 } });
  await tool("interrupt_session").run({ sessionId: "c1" }, idle.ctx);
  assert.deepEqual(commandBodies(idle.api, "interrupt"), [{}], "no running turn → stop background work");
});

test("close_session sends the DELETE for the tab it names, chat or terminal, and refuses an unknown id without sending one", async (t) => {
  const h = await harness(); t.after(h.close);
  h.api.on("DELETE", "/api/sessions/c1", { status: 204, body: null }).on("DELETE", "/api/sessions/t1", { status: 204, body: null });
  assert.deepEqual(await tool("close_session").run({ sessionId: "t1" }, h.ctx), { closed: true, sessionId: "t1" });
  assert.deepEqual(await tool("close_session").run({ sessionId: "c1" }, h.ctx), { closed: true, sessionId: "c1" });
  assert.deepEqual(h.api.calls.filter((c) => c.method === "DELETE").map((c) => c.path), ["/api/sessions/t1", "/api/sessions/c1"]);
  await assert.rejects(tool("close_session").run({ sessionId: "zz" }, h.ctx), (e: { code: string }) => e.code === "SESSION_NOT_FOUND");
  assert.equal(h.api.calls.filter((c) => c.method === "DELETE").length, 2, "no DELETE for an unknown id");
  // A DELETE the daemon refuses is its answer, never a { closed: true }.
  h.api.on("DELETE", "/api/sessions/c1", { status: 409, body: { code: "SESSION_BUSY", message: "The tab is being moved." } });
  await assert.rejects(tool("close_session").run({ sessionId: "c1" }, h.ctx), (e: { code: string; message: string }) => e.code === "SESSION_BUSY" && e.message === "The tab is being moved.");
});

test("compact_session posts exactly the compact command, returns its seq with the session, and passes a host refusal through", async (t) => {
  const h = await harness(); t.after(h.close);
  h.api.on("POST", "/api/sessions/c1/compact", { status: 200, body: { seq: 12 } });
  const r = await tool("compact_session").run({ sessionId: "c1" }, h.ctx);
  assert.equal(r.seq, 12);
  assert.equal((r.session as { id: string }).id, "c1");
  assert.deepEqual(h.api.calls.filter((c) => c.method === "POST").map((c) => c.path), ["/api/sessions/c1/compact"]);
  assert.deepEqual(commandBodies(h.api, "compact"), [{}]);
  await assert.rejects(tool("compact_session").run({ sessionId: "t1" }, h.ctx), (e: { code: string }) => e.code === "NOT_A_CHAT_SESSION");
  h.api.on("POST", "/api/sessions/c1/compact", { status: 409, body: { error: { code: "COMPACTION_UNAVAILABLE", message: "A turn is running." } } });
  await assert.rejects(tool("compact_session").run({ sessionId: "c1" }, h.ctx), (e: { code: string; message: string }) => e.code === "COMPACTION_UNAVAILABLE" && e.message === "A turn is running.");
});

/** Three settled turns, each opened by its own user message: the thread a rewind starts from. */
function threeTurns(over: { items?: ThreadItem[]; pending?: ThreadSnapshotPayload["pending"] } = {}): ThreadSnapshotPayload {
  const turns = [1, 2, 3].map((n) => turn({ turnId: `t${n}`, turnCount: n, userMessageId: `u${n}`, requestedAt: stamp(n * 10), startedAt: stamp(n * 10), completedAt: stamp(n * 10 + 5) }));
  const items = over.items ?? threeTurnRows();
  return snapshot({ head: head({ turnCount: 3 }), turns, items, ...(over.pending ? { pending: over.pending } : {}) });
}
/** Each turn's user message and reply, in order: u1 a1 u2 a2 u3 a3. */
const threeTurnRows = (): ThreadItem[] => [1, 2, 3].flatMap((n) => [message("user", `ask ${n}`, { id: `u${n}`, turnId: `t${n}` }), message("assistant", `answer ${n}`, { id: `a${n}`, turnId: `t${n}` })]);

/** The thread after a rewind that kept `kept` turns, as the fold leaves it: those turns and their rows. */
function rewound(snap: ThreadSnapshotPayload, kept: number): ThreadSnapshotPayload {
  const keptIds = new Set(snap.turns.slice(0, kept).map((x) => x.turnId));
  return { ...snap, head: { ...snap.head, turnCount: kept }, turns: snap.turns.slice(0, kept), items: snap.items.filter((i) => i.turnId === null || keptIds.has(i.turnId)) };
}

type Harness = Awaited<ReturnType<typeof harness>>;
/**
 * The host behind a /revert: the thread reads `before` until the command is posted, then `after(n)` for the n-th read
 * since (1-based) — the rewind's progress as the tool reads it.
 */
function revertHost(h: Harness, before: ThreadSnapshotPayload, after: (read: number) => ThreadSnapshotPayload | DaemonResponse): { reads: () => number } {
  let posted = false;
  let reads = 0;
  const body = (snap: ThreadSnapshotPayload) => ({ status: 200, body: { kind: "snapshot", thread: { ...snap, head: { ...snap.head, projectPath: h.projectPath, cwd: h.projectPath } } } });
  const answer = (read: ThreadSnapshotPayload | DaemonResponse): DaemonResponse => ("status" in read ? read : body(read));
  h.api.on("POST", "/api/sessions/c1/revert", () => { posted = true; return { status: 200, body: { seq: 8 } }; });
  h.api.on("GET", "/api/sessions/c1/thread", () => (posted ? answer(after((reads += 1))) : body(before)));
  return { reads: () => reads };
}

/**
 * Holds every setTimeout armed while it is on: recorded, and never fired unless the test fires it — so a wait is really
 * paused, and only its other wake-ups (a bus event, an abort) can resume it. `restore()` puts the real timers back.
 */
function holdTimers(): { held: { ms: number; cleared: boolean; fired: boolean; fire: () => void }[]; restore: () => void; releaseAll: () => void } {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const held: { ms: number; cleared: boolean; fired: boolean; fire: () => void }[] = [];
  globalThis.setTimeout = ((callback: () => void, ms?: number) => {
    const timer = { ms: ms ?? 0, cleared: false, fired: false, fire: () => { if (timer.cleared || timer.fired) return; timer.fired = true; callback(); } };
    held.push(timer);
    return timer;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((handle?: unknown) => {
    const timer = held.find((h) => h === handle);
    if (timer) timer.cleared = true;
    else realClear(handle as Parameters<typeof clearTimeout>[0]);
  }) as typeof clearTimeout;
  return { held, restore: () => { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; }, releaseAll: () => { for (const timer of held) timer.fire(); } };
}

/** Up to `turns` macrotask turns for `done()` to come true; whether it did. Nothing sleeps. */
async function until(done: () => boolean, turns = 100): Promise<boolean> {
  for (let i = 0; i < turns && !done(); i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  return done();
}

/**
 * revert_session run while every timer is held: it is paused on its re-read timer when `paused()` resolves, and
 * `settled()` says whether it has answered since. The caller releases the timers and awaits `done` at the end.
 */
function pausedRevert(h: Harness, keepTurns: number, ctx: ToolContext = h.ctx) {
  const timers = holdTimers();
  let outcome: PromiseSettledResult<Record<string, unknown>> | undefined;
  const done = tool("revert_session").run({ sessionId: "c1", keepTurns }, ctx).then(
    (value) => { outcome = { status: "fulfilled", value }; },
    (reason: unknown) => { outcome = { status: "rejected", reason }; }
  );
  return {
    timers,
    paused: () => until(() => timers.held.length === 1),
    settled: () => until(() => outcome !== undefined),
    outcome: () => outcome!,
    finish: async () => { timers.restore(); timers.releaseAll(); await done; }
  };
}

/** The bodies posted to a chat command, without their minted commandId. */
function commandBodies(api: FakeDaemonApi, name: string): Record<string, unknown>[] {
  return api.calls.filter((c) => c.method === "POST" && c.path === `/api/sessions/c1/${name}`).map((c) => {
    const { commandId, ...rest } = c.body as Record<string, unknown>;
    assert.equal(typeof commandId, "string");
    return rest;
  });
}

/**
 * `fn` with every setTimeout it arms recorded and fired a macrotask later instead of after its delay, so a wait's timed
 * re-read runs without the test sleeping; `delays` lists what was armed.
 */
async function instantTimers<T>(fn: () => Promise<T>): Promise<{ outcome: PromiseSettledResult<T>; delays: number[] }> {
  const real = globalThis.setTimeout;
  const delays: number[] = [];
  globalThis.setTimeout = ((callback: () => void, ms?: number) => { delays.push(ms ?? 0); return real(callback, 0); }) as unknown as typeof setTimeout;
  try {
    const [outcome] = await Promise.allSettled([fn()]);
    return { outcome: outcome!, delays };
  } finally {
    globalThis.setTimeout = real;
  }
}
const resolvedValue = <T>(outcome: PromiseSettledResult<T>): T => { assert.equal(outcome.status, "fulfilled", String((outcome as PromiseRejectedResult).reason)); return (outcome as PromiseFulfilledResult<T>).value; };
const rejection = (outcome: PromiseSettledResult<unknown>): ToolError => { assert.equal(outcome.status, "rejected"); return (outcome as PromiseRejectedResult).reason as ToolError; };

test("revert_session waits for the rewind: the session comes back once the host has dropped the turns, nothing left listening", async (t) => {
  const before = threeTurns();
  const h = await harness([chatSummary()], before); t.after(h.close);
  revertHost(h, before, () => rewound(before, 1));
  const { outcome, delays } = await instantTimers(() => tool("revert_session").run({ sessionId: "c1", keepTurns: 1 }, h.ctx));
  const r = resolvedValue(outcome);
  assert.equal(r.seq, 8);
  assert.equal((r.session as { chat: { turnCount: number } }).chat.turnCount, 1, "the detail is read after the rewind");
  assert.deepEqual(commandBodies(h.api, "revert"), [{ targetTurnCount: 1 }]);
  assert.deepEqual(delays, [], "the first read after the POST saw it: nothing waited");
  assert.equal(h.api.listenerCount(), 0);
});

test("revert_session: a bus event about the session re-reads the thread at once, no timer armed", async (t) => {
  const before = threeTurns();
  const h = await harness([chatSummary()], before); t.after(h.close);
  const host = revertHost(h, before, (read) => {
    if (read > 1) return rewound(before, 0);
    h.api.emit(busEvent("session.updated", { id: "c1" })); // the summary moved while the tool was reading
    return before;
  });
  const { outcome, delays } = await instantTimers(() => tool("revert_session").run({ sessionId: "c1", keepTurns: 0 }, h.ctx));
  assert.equal((resolvedValue(outcome).session as { chat: { turnCount: number } }).chat.turnCount, 0);
  assert.deepEqual(delays, [], "the event woke the wait: no timed re-read");
  assert.equal(host.reads(), 3, "two reads to see the rewind, then the detail's own");
  assert.equal(h.api.listenerCount(), 0);
});

test("revert_session: a rewind the adapter refuses answers COMMAND_REJECTED with the host's reason; an older failure row is not this one", async (t) => {
  const old = activity("checkpoint.revert.failed", { detail: "An earlier rewind failed.", turnCount: 2 }, { tone: "error", summary: "Rewind failed", turnId: "t2" });
  const before = threeTurns({ items: [...threeTurnRows(), old] });
  const h = await harness([chatSummary()], before); t.after(h.close);
  const refusal = activity("checkpoint.revert.failed", { detail: "Cannot rewind: turn t2 is not in the transcript.", turnCount: 1 }, { tone: "error", summary: "Rewind failed", turnId: "t3" });
  revertHost(h, before, (read) => {
    if (read > 1) return { ...before, items: [...before.items, refusal] };
    h.api.emit(busEvent("session.updated", { id: "c9" })); // another session's news wakes nothing
    return before;
  });
  const { outcome, delays } = await instantTimers(() => tool("revert_session").run({ sessionId: "c1", keepTurns: 1 }, h.ctx));
  const e = rejection(outcome);
  assert.equal(e.code, "COMMAND_REJECTED");
  assert.equal(e.message, "Rewind failed: Cannot rewind: turn t2 is not in the transcript.");
  assert.deepEqual(e.detail, { seq: 8, activityId: refusal.id, reason: "Cannot rewind: turn t2 is not in the transcript." });
  assert.deepEqual(delays, [REWIND_RECHECK_MS], "no event about this session: one timed re-read found the refusal");
  assert.equal(h.api.listenerCount(), 0);
});

test("revert_session gives up after its deadline with SESSION_BUSY, and a request that closes ends the wait at once", async (t) => {
  const before = threeTurns();
  const h = await harness([chatSummary()], before); t.after(h.close);
  revertHost(h, before, () => before); // the host never finishes
  // Every look at the clock is 6 s later: the first re-read is still inside the deadline, the second is past it.
  let clock = h.ctx.now();
  const late = await instantTimers(() => tool("revert_session").run({ sessionId: "c1", keepTurns: 1 }, { ...h.ctx, now: () => (clock += 6_000) }));
  const busy = rejection(late.outcome);
  assert.equal(busy.code, "SESSION_BUSY");
  assert.equal(busy.message, "The rewind is still in progress — do not call revert_session again. It has landed once get_session's chat.turnCount comes down to keepTurns (1); if it failed, read_transcript shows a \"Rewind failed\" error.");
  assert.deepEqual(busy.detail, { seq: 8 });
  assert.deepEqual(late.delays, [REWIND_RECHECK_MS], "one timed re-read, then the deadline");
  assert.ok(REWIND_WAIT_MS >= 5_000 && REWIND_WAIT_MS <= 15_000, `${REWIND_WAIT_MS} ms`);
  assert.equal(h.api.listenerCount(), 0);
  // The client goes away mid-wait: no timer, no listener left behind.
  const ctrl = new AbortController();
  revertHost(h, before, () => { ctrl.abort(); return before; });
  const gone = await instantTimers(() => tool("revert_session").run({ sessionId: "c1", keepTurns: 1 }, { ...h.ctx, signal: ctrl.signal }));
  assert.equal(rejection(gone.outcome).code, "SESSION_BUSY");
  assert.deepEqual(gone.delays, []);
  assert.equal(h.api.listenerCount(), 0);
});

test("revert_session: a bus event wakes a PAUSED wait at once — its timer cleared, never fired", async (t) => {
  const before = threeTurns();
  const h = await harness([chatSummary()], before); t.after(h.close);
  let landed = false;
  const host = revertHost(h, before, () => (landed ? rewound(before, 1) : before));
  const run = pausedRevert(h, 1);
  try {
    assert.ok(await run.paused(), "the wait paused on its re-read timer");
    assert.equal(run.timers.held[0]!.ms, REWIND_RECHECK_MS);
    landed = true;
    h.api.emit(busEvent("session.updated", { id: "c1" }));
    assert.ok(await run.settled(), "the event resumed the wait: nothing but the bus could, with the timer held");
    assert.equal(resolvedValue(run.outcome()).seq, 8);
    assert.deepEqual([run.timers.held[0]!.cleared, run.timers.held[0]!.fired], [true, false]);
    assert.equal(host.reads(), 3, "the read that paused, the read the event woke, the detail's own");
  } finally {
    await run.finish();
  }
  assert.equal(h.api.listenerCount(), 0);
});

test("revert_session: a request that closes DURING the pause ends the wait at once — SESSION_BUSY, the timer cleared, nothing read again", async (t) => {
  const before = threeTurns();
  const h = await harness([chatSummary()], before); t.after(h.close);
  const host = revertHost(h, before, () => before);
  const ctrl = new AbortController();
  const run = pausedRevert(h, 1, { ...h.ctx, signal: ctrl.signal });
  try {
    assert.ok(await run.paused(), "the wait paused on its re-read timer");
    ctrl.abort();
    assert.ok(await run.settled(), "the abort resumed the wait: nothing else could, with the timer held");
    const busy = rejection(run.outcome());
    assert.equal(busy.code, "SESSION_BUSY");
    assert.deepEqual(busy.detail, { seq: 8 });
    assert.deepEqual([run.timers.held[0]!.cleared, run.timers.held[0]!.fired], [true, false]);
    assert.equal(host.reads(), 1, "no read after the abort");
  } finally {
    await run.finish();
  }
  assert.equal(h.api.listenerCount(), 0);
});

test("revert_session: the session closing mid-wait answers SESSION_NOT_FOUND, with the seq", async (t) => {
  const before = threeTurns();
  const h = await harness([chatSummary()], before); t.after(h.close);
  const host = revertHost(h, before, () => before);
  const run = pausedRevert(h, 1);
  try {
    assert.ok(await run.paused(), "the wait paused on its re-read timer");
    h.api.emit(busEvent("session.closed", { id: "c1" }));
    assert.ok(await run.settled(), "the close ended the wait");
    const closed = rejection(run.outcome());
    assert.equal(closed.code, "SESSION_NOT_FOUND");
    assert.equal(closed.message, "Session \"c1\" was closed while rewinding.");
    assert.deepEqual(closed.detail, { seq: 8 });
    assert.equal(host.reads(), 1, "no read after the close");
  } finally {
    await run.finish();
  }
  assert.equal(h.api.listenerCount(), 0);
});

test("revert_session: a failure after the POST keeps its code and message and gains the seq — in the wait, and reading the detail after it", async (t) => {
  const before = threeTurns();
  const h = await harness([chatSummary()], before); t.after(h.close);
  const unavailable = { status: 503, body: { error: { code: "HOST_UNAVAILABLE", message: "The agent host is restarting.", detail: { retryAfterMs: 500, seq: 99 } } } };
  // The wait's own thread read fails.
  revertHost(h, before, () => unavailable);
  await assert.rejects(tool("revert_session").run({ sessionId: "c1", keepTurns: 1 }, h.ctx), (e: ToolError) => {
    assert.equal(e.code, "HOST_UNAVAILABLE");
    assert.equal(e.message, "The agent host is restarting.");
    assert.deepEqual(e.detail, { retryAfterMs: 500, seq: 8 }, "merged into the host's detail; the command's seq wins");
    return true;
  });
  // The rewind landed; reading the detail after it fails.
  revertHost(h, before, (read) => (read === 1 ? rewound(before, 1) : unavailable));
  await assert.rejects(tool("revert_session").run({ sessionId: "c1", keepTurns: 1 }, h.ctx), (e: ToolError) => e.code === "HOST_UNAVAILABLE" && (e.detail as { seq: number }).seq === 8);
  // A thrown failure keeps its safe INTERNAL message (logged, never echoed), and the seq still rides it.
  const logged = t.mock.method(console, "error", () => {});
  revertHost(h, before, () => { throw new Error("socket hang up /var/lib/orquester/daemon/agent-host.sock"); });
  await assert.rejects(tool("revert_session").run({ sessionId: "c1", keepTurns: 1 }, h.ctx), (e: ToolError) => {
    assert.equal(e.code, "INTERNAL");
    assert.equal(e.message, "Internal error handling the tool call.");
    assert.deepEqual(e.detail, { seq: 8 });
    return true;
  });
  assert.equal(logged.mock.callCount(), 1);
  assert.equal(h.api.listenerCount(), 0);
});

test("revert_session refuses up front a target before the last settled compaction — the GUI's rule — and nothing is posted", async (t) => {
  const rows = threeTurnRows(); // u1 a1 u2 a2 u3 a3
  const marker = (payload: unknown, over: Partial<ThreadActivityItem> = {}) => activity("context-compaction", payload, { turnId: "t1", ...over });
  const h = await harness([chatSummary()], threeTurns()); t.after(h.close);
  const refused = async (items: ThreadItem[], keepTurns: number, message: string | RegExp) => {
    revertHost(h, threeTurns({ items }), () => assert.fail("nothing is posted"));
    await assert.rejects(tool("revert_session").run({ sessionId: "c1", keepTurns }, h.ctx), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && (typeof message === "string" ? e.message === message : message.test(e.message)));
  };
  const allowed = async (items: ThreadItem[], keepTurns: number) => {
    const before = threeTurns({ items });
    revertHost(h, before, () => rewound(before, keepTurns));
    await tool("revert_session").run({ sessionId: "c1", keepTurns }, h.ctx);
  };
  // A settled marker between turns 1 and 2: the agent remembers nothing before turn 2, so turn 1 must be kept.
  const settled = [...rows.slice(0, 2), marker({ state: "compacted", beforeTokens: 9_000, afterTokens: 900 }), ...rows.slice(2)];
  await refused(settled, 0, "Cannot rewind past the last context compaction — the agent no longer holds what came before it. keepTurns must be between 1 and 2.");
  await allowed(settled, 1);
  // An unreadable state is a settled marker (an old log only recorded those); so is the legacy spelling.
  await refused([...rows.slice(0, 2), marker({}), ...rows.slice(2)], 0, /between 1 and 2/);
  await refused([...rows.slice(0, 2), activity("thread.state.changed", { state: "compacted" }, { turnId: "t1" }), ...rows.slice(2)], 0, /between 1 and 2/);
  // Only the LAST marker counts; one in the latest turn leaves nothing to rewind to.
  await refused([...rows.slice(0, 2), marker({ state: "compacted" }), ...rows.slice(2, 4), marker({ state: "compacted" }, { turnId: "t2" }), ...rows.slice(4)], 1, /between 2 and 2/);
  await refused([...rows, marker({ state: "compacted" }, { turnId: "t3" })], 2, "Cannot rewind past the last context compaction — the agent no longer holds what came before it, and it happened in the latest turn: there is no turn to rewind to.");
  // A compaction still running or failed dropped nothing; a subagent's own marker is not the conversation's.
  await allowed([...rows.slice(0, 2), marker({ state: "compacting" }), ...rows.slice(2)], 0);
  await allowed([...rows.slice(0, 2), marker({ state: "compaction-failed", error: "x" }), ...rows.slice(2)], 0);
  await allowed([...rows.slice(0, 2), marker({ state: "compacted" }, { agentId: "sub-1" }), ...rows.slice(2)], 0);
  assert.deepEqual(commandBodies(h.api, "revert"), [{ targetTurnCount: 1 }, { targetTurnCount: 0 }, { targetTurnCount: 0 }, { targetTurnCount: 0 }]);
});

test("revert_session places a turn with no user message by its first row, and one with no row left before the marker", async (t) => {
  const h = await harness([chatSummary()], threeTurns()); t.after(h.close);
  const rows = threeTurnRows();
  const marker = activity("context-compaction", { state: "compacted" }, { turnId: "t1" });
  // Turn 2 was opened by nothing the host saw (a continuation): its first row, a2, is after the marker.
  const noPrompt = (snap: ThreadSnapshotPayload): ThreadSnapshotPayload => ({ ...snap, turns: snap.turns.map((x) => (x.turnId === "t2" ? { ...x, userMessageId: undefined } : x)) });
  const placed = noPrompt(threeTurns({ items: [...rows.slice(0, 2), marker, ...rows.slice(3)] }));
  revertHost(h, placed, () => rewound(placed, 1));
  await tool("revert_session").run({ sessionId: "c1", keepTurns: 1 }, h.ctx);
  // Turn 2 has no row left at all: it cannot be placed after the marker, so a cut there is refused.
  const unplaced = noPrompt(threeTurns({ items: [...rows.slice(0, 2), marker, ...rows.slice(4)] }));
  revertHost(h, unplaced, () => assert.fail("nothing is posted"));
  await assert.rejects(tool("revert_session").run({ sessionId: "c1", keepTurns: 1 }, h.ctx), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && /between 2 and 2/.test(e.message));
  assert.deepEqual(commandBodies(h.api, "revert"), [{ targetTurnCount: 1 }]);
});

test("revert_session refuses while a request is open (PENDING_REQUEST, like send_message), a turn is active (SESSION_BUSY), rollback is missing or the count is out of range", async (t) => {
  const question = { requestId: "q3", createdAt: stamp(41), dismissible: true, responseMode: "message" as const, questions: [{ id: "x", header: "H", question: "X?", options: [], multiSelect: false, allowCustomAnswer: true }] };
  const pending = await harness([chatSummary({ hasPendingApprovals: true, hasPendingUserInput: true })], threeTurns({ pending: { approvals: [{ requestId: "r1", requestKind: "command", createdAt: stamp(40) }], userInputs: [question] } })); t.after(pending.close);
  await assert.rejects(tool("revert_session").run({ sessionId: "c1", keepTurns: 1 }, pending.ctx), (e: { code: string; message: string; detail: unknown }) => {
    assert.equal(e.code, "PENDING_REQUEST");
    assert.equal(e.message, "Resolve the agent's open request before rewinding: it is waiting on approval r1 (resolve_approval) and question q3 (answer_question or dismiss_question). get_session shows the details.");
    assert.deepEqual(e.detail, { approvals: ["r1"], questions: ["q3"] });
    return true;
  });
  // A message-mode question outlives its turn: open on an idle session, it still refuses.
  const async_ = await harness([chatSummary({ hasPendingUserInput: true })], threeTurns({ pending: { approvals: [], userInputs: [question] } })); t.after(async_.close);
  await assert.rejects(tool("revert_session").run({ sessionId: "c1", keepTurns: 0 }, async_.ctx), (e: { code: string }) => e.code === "PENDING_REQUEST");
  const running = chatSummary({ chatSessionStatus: "running", latestTurn: { turnId: "t3", state: "running", startedAt: stamp(30), completedAt: null } });
  const busy = await harness([running], threeTurns()); t.after(busy.close);
  await assert.rejects(tool("revert_session").run({ sessionId: "c1", keepTurns: 1 }, busy.ctx), (e: { code: string; message: string }) => e.code === "SESSION_BUSY" && e.message === "Stop the current turn before rewinding.");
  const idle = await harness([chatSummary()], threeTurns()); t.after(idle.close);
  await assert.rejects(tool("revert_session").run({ sessionId: "c1", keepTurns: 3 }, idle.ctx), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && e.message === "keepTurns must be between 0 and 2: this conversation has 3 started turns.");
  const grok = await harness([chatSummary({ refId: "grok" })]); t.after(grok.close);
  await assert.rejects(tool("revert_session").run({ sessionId: "c1", keepTurns: 0 }, grok.ctx), (e: { message: string }) => /rollback/.test(e.message));
  const fresh = await harness([chatSummary({ latestTurn: null })], snapshot({ head: head({ turnCount: 0 }), turns: [] })); t.after(fresh.close);
  await assert.rejects(tool("revert_session").run({ sessionId: "c1", keepTurns: 0 }, fresh.ctx), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && /no turns/.test(e.message));
  for (const h of [pending, async_, busy, idle, grok, fresh]) assert.ok(!h.api.calls.some((c) => c.method === "POST"), "nothing was posted");
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
  assert.equal("filesTruncated" in small, false, "a short file list is whole and says nothing");
  // A turn with no checkpoint of its own: the host's 404 (agent-host http-server.ts) passes through as it is.
  h.api.on("GET", "/api/sessions/c1/turns/5/diff", { status: 404, body: { error: { code: "THREAD_NOT_FOUND", message: "No checkpoint for turn 5." } } });
  await assert.rejects(tool("get_turn_diff").run({ sessionId: "c1", turn: 5 }, h.ctx), (e: { code: string; message: string }) => e.code === "THREAD_NOT_FOUND" && e.message === "No checkpoint for turn 5.");
});

test("get_turn_diff: a small diff leaves its room to the file list — a 400-file rename is listed whole", async (t) => {
  const renamed = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `packages/some-long-package-name/src/renamed/directory/module-${String(i).padStart(4, "0")}.ts`, additions: 0, deletions: 0 }));
  const checkpoint = (files: ReturnType<typeof renamed>) => snapshot({ head: head({ turnCount: 2 }), checkpoints: [{ turnId: "t2", checkpointTurnCount: 2, checkpointRef: "r", status: "ready", files, assistantMessageId: null, completedAt: stamp(3) }] });
  const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8");
  const four = renamed(400);
  assert.ok(bytes(four) > 20_000, `${bytes(four)} bytes: more than the list's floor`);
  const h = await harness([chatSummary()], checkpoint(four)); t.after(h.close);
  const small = "r".repeat(1_000);
  h.api.on("GET", "/api/sessions/c1/turns/2/diff", { status: 200, body: { fromTurnCount: 1, toTurnCount: 2, diff: small } });
  const r = await tool("get_turn_diff").run({ sessionId: "c1" }, h.ctx);
  assert.deepEqual(r.files, four, "every file");
  assert.equal("filesTruncated" in r, false);
  assert.deepEqual([r.diff, r.truncated], [small, false], "the diff whole too");
  assert.deepEqual(ok(r).structuredContent, r);
  // More files than the whole result holds: the list fills what the small diff leaves, the diff still whole.
  const thousand = renamed(1_000);
  h.api.on("GET", "/api/sessions/c1/thread", { status: 200, body: { kind: "snapshot", thread: { ...checkpoint(thousand), head: { ...checkpoint(thousand).head, projectPath: h.projectPath, cwd: h.projectPath } } } });
  const full = await tool("get_turn_diff").run({ sessionId: "c1" }, h.ctx);
  const listed = full.files as typeof thousand;
  assert.ok(listed.length > 450 && listed.length < 1_000, `${listed.length} files listed`);
  assert.deepEqual(listed, thousand.slice(0, listed.length));
  assert.deepEqual([full.filesTruncated, full.omittedFiles, full.diff, full.truncated], [true, 1_000 - listed.length, small, false]);
  assert.ok(bytes(full) <= MAX_RESULT_BYTES && bytes(full) > MAX_RESULT_BYTES - 250, `${bytes(full)} bytes: the list filled the room`);
});

test("get_turn_diff with no turn named and no checkpoint yet refuses on its own, before asking the host for a diff", async (t) => {
  const h = await harness([chatSummary()], snapshot({ checkpoints: [] })); t.after(h.close);
  await assert.rejects(tool("get_turn_diff").run({ sessionId: "c1" }, h.ctx), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && e.message === "This session has no checkpointed turn yet.");
  assert.ok(!h.api.calls.some((c) => c.path.endsWith("/diff")), "no diff was asked for");
});

test("get_turn_diff bounds a huge file list too: the head that fits, filesTruncated and omittedFiles, and the diff keeps the rest of the budget", async (t) => {
  const files = Array.from({ length: 5_000 }, (_, i) => ({ path: `src/generated/module-${i}/index.ts`, additions: i, deletions: 1 }));
  const snap = snapshot({ head: head({ turnCount: 2 }), checkpoints: [{ turnId: "t2", checkpointTurnCount: 2, checkpointRef: "r", status: "ready", files, assistantMessageId: null, completedAt: stamp(3) }] });
  const h = await harness([chatSummary()], snap); t.after(h.close);
  h.api.on("GET", "/api/sessions/c1/turns/2/diff", { status: 200, body: { fromTurnCount: 1, toTurnCount: 2, diff: "d".repeat(90_000) } });
  const r = await tool("get_turn_diff").run({ sessionId: "c1" }, h.ctx);
  const listed = r.files as typeof files;
  assert.ok(listed.length > 100 && listed.length < files.length, `${listed.length} files listed`);
  assert.deepEqual(listed, files.slice(0, listed.length), "the head of the list, in the checkpoint's order");
  assert.equal(r.filesTruncated, true);
  assert.equal(r.omittedFiles, files.length - listed.length);
  const bytes = Buffer.byteLength(JSON.stringify(r), "utf8");
  assert.ok(bytes <= MAX_RESULT_BYTES && bytes > MAX_RESULT_BYTES - 8, `${bytes} bytes: within one result, the diff filling the rest`);
  assert.ok((r.diff as string).length > 25_000, "the file list leaves the diff most of the result");
  assert.deepEqual(ok(r).structuredContent, r, "ok() passes it through");
});

test("every session tool parameter is described, nested ones included; revert_session's keepTurns counts from the first turn", () => {
  const undescribed = (shape: z.ZodRawShape, path: string): string[] => Object.entries(shape).flatMap(([key, field]) => {
    let type: z.ZodTypeAny = field;
    let described = type.description !== undefined;
    while (type instanceof z.ZodOptional || type instanceof z.ZodDefault) {
      type = type._def.innerType;
      described ||= type.description !== undefined;
    }
    return [...(described ? [] : [`${path}.${key}`]), ...(type instanceof z.ZodObject ? undescribed(type.shape, `${path}.${key}`) : [])];
  });
  assert.deepEqual(sessionTools.flatMap((d) => undescribed(d.input, d.name)), []);
  assert.match(tool("revert_session").input.keepTurns.description ?? "", /0 = rewind to before the first turn; N = keep turns 1\.\.N/);
  // The field a caller reads is chat.sessionStatus; OpenCode history is never listed; the file list is bounded too.
  assert.match(tool("stop_session").description, /whose chat\.sessionStatus is error/);
  assert.match(tool("close_session").description, /stays resumable via list_conversations for Claude, Codex and Grok \(and claudex\/claudemix from their proxy homes\); OpenCode history is not listed\./);
  assert.doesNotMatch(tool("get_turn_diff").description, /every changed file/);
  assert.match(tool("get_turn_diff").description, /filesTruncated/);
  for (const d of sessionTools) assert.ok(d.description.length <= 400, `${d.name}: ${d.description.length} characters`);
});
