import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDaemonApi } from "../testing.ts";
import { chatSummary, shellSummary, stamp } from "../fixtures.ts";
import type { ToolContext } from "../tool.ts";
import { catalogTools } from "./catalog.ts";

const tool = (name: string) => catalogTools.find((t) => t.name === name)!;
const ctx = (api: FakeDaemonApi): ToolContext => ({ api, todos: {} as never, files: {} as never, signal: new AbortController().signal, now: () => Date.parse("2026-09-22T12:00:00.000Z") });

test("list_projects flattens workspaces, hides archived by default, marks recency and open sessions, recent first", async () => {
  const api = new FakeDaemonApi()
    .on("GET", "/api/workspaces", { status: 200, body: [{ name: "acme", path: "/w/acme", projectCount: 2 }, { name: "old", path: "/w/old", projectCount: 1, isArchived: true }] })
    .on("GET", "/api/workspaces/acme/projects", { status: 200, body: [{ name: "api", workspace: "acme", path: "/w/acme/api" }, { name: "web", workspace: "acme", path: "/w/acme/web", isArchived: true }] })
    .on("GET", "/api/workspaces/old/projects", { status: 200, body: [{ name: "x", workspace: "old", path: "/w/old/x" }] })
    .on("GET", "/api/projects/recent", { status: 200, body: [{ name: "api", workspace: "acme", path: "/w/acme/api", lastInteractedAt: stamp(5), interactionCount: 3 }] })
    .on("GET", "/api/sessions", { status: 200, body: [chatSummary(), chatSummary({ id: "c2" })] });
  const r = await tool("list_projects").run({ includeArchived: false }, ctx(api));
  assert.deepEqual(r, { projects: [{ workspace: "acme", name: "api", path: "/w/acme/api", isArchived: false, lastInteractedAt: stamp(5), openSessions: 2 }] });
  const all = await tool("list_projects").run({ includeArchived: true }, ctx(api));
  assert.deepEqual((all.projects as { path: string }[]).map((p) => p.path), ["/w/acme/api", "/w/acme/web", "/w/old/x"]);
  const one = await tool("list_projects").run({ workspace: "old", includeArchived: true }, ctx(api));
  assert.equal((one.projects as unknown[]).length, 1);
});

test("list_projects reports a project of an archived workspace as archived (the daemon's project flag is per-project only)", async () => {
  const api = new FakeDaemonApi()
    .on("GET", "/api/workspaces", { status: 200, body: [{ name: "old", path: "/w/old", projectCount: 1, isArchived: true }] })
    .on("GET", "/api/workspaces/old/projects", { status: 200, body: [{ name: "x", workspace: "old", path: "/w/old/x", isArchived: false }] })
    .on("GET", "/api/projects/recent", { status: 200, body: [] })
    .on("GET", "/api/sessions", { status: 200, body: [] });
  const r = await tool("list_projects").run({ includeArchived: true }, ctx(api));
  assert.deepEqual(r, { projects: [{ workspace: "old", name: "x", path: "/w/old/x", isArchived: true, openSessions: 0 }] });
});

test("list_projects orders recent projects newest first, then the rest alphabetically", async () => {
  const api = new FakeDaemonApi()
    .on("GET", "/api/workspaces", { status: 200, body: [{ name: "zeta", path: "/w/zeta", projectCount: 1 }, { name: "acme", path: "/w/acme", projectCount: 3 }] })
    .on("GET", "/api/workspaces/zeta/projects", { status: 200, body: [{ name: "a", workspace: "zeta", path: "/w/zeta/a" }] })
    .on("GET", "/api/workspaces/acme/projects", { status: 200, body: [{ name: "d", workspace: "acme", path: "/w/acme/d" }, { name: "c", workspace: "acme", path: "/w/acme/c" }, { name: "b", workspace: "acme", path: "/w/acme/b" }] })
    .on("GET", "/api/projects/recent", { status: 200, body: [{ name: "c", workspace: "acme", path: "/w/acme/c", lastInteractedAt: stamp(3), interactionCount: 1 }, { name: "a", workspace: "zeta", path: "/w/zeta/a", lastInteractedAt: stamp(7), interactionCount: 1 }] })
    .on("GET", "/api/sessions", { status: 200, body: [] });
  const r = await tool("list_projects").run({ includeArchived: false }, ctx(api));
  assert.deepEqual((r.projects as { path: string }[]).map((p) => p.path), ["/w/zeta/a", "/w/acme/c", "/w/acme/b", "/w/acme/d"]);
});

test("list_agents returns the catalogue, optionally one agent", async () => {
  const api = new FakeDaemonApi()
    .on("GET", "/api/registry", { status: 200, body: { shells: [], ides: [], fileExplorers: [], browsers: [], agents: [{ id: "claude", kind: "agent", name: "Claude Code", bin: ["claude"], enabled: true, installState: "idle", chat: { adapter: "claude" } }, { id: "grok", kind: "agent", name: "Grok Build", bin: ["grok"], enabled: true, installState: "idle", chat: { adapter: "grok" } }] } })
    .on("GET", "/api/agent/providers", { status: 200, body: { hostInstanceId: "h", providers: [] } })
    .on("GET", "/api/agent-accounts", { status: 200, body: { accounts: [], defaults: { claude: null, codex: null, grok: null } } });
  const r = await tool("list_agents").run({ includeLegacyModels: false }, ctx(api));
  assert.deepEqual((r.agents as { id: string }[]).map((a) => a.id), ["claude", "grok"]);
  const one = await tool("list_agents").run({ agent: "grok", includeLegacyModels: false }, ctx(api));
  assert.deepEqual((one.agents as { id: string }[]).map((a) => a.id), ["grok"]);
  await assert.rejects(tool("list_agents").run({ agent: "nope", includeLegacyModels: false }, ctx(api)), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
});

test("list_conversations resolves the project, maps homes to launch agents and flags resumability", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mcp-cat-")); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "acme", "api"), { recursive: true });
  const api = new FakeDaemonApi(); api.fsRoot = root; api.workspacesDir = root;
  api.on("GET", "/api/registry", { status: 200, body: { shells: [], ides: [], fileExplorers: [], browsers: [], agents: [{ id: "claude", kind: "agent", name: "Claude Code", bin: ["claude"], enabled: true, installState: "idle", chat: { adapter: "claude" } }, { id: "claudex", kind: "agent", name: "Claude Code × GPT", bin: ["claude"], enabled: true, installState: "idle", chat: { adapter: "claude" } }] } })
    .on("GET", "/api/agents/conversations", ({ query }) => ({ status: 200, body: { conversations: [
      { id: "s1", agentRefId: "claude", title: "Fix build", updatedAt: stamp(9), home: "account", accountId: "acc-1" },
      { id: "s2", agentRefId: "claude", title: "Proxy chat", updatedAt: stamp(8), home: "cliproxy", proxyRefId: "claudex" },
      { id: "s3", agentRefId: "deepseek", title: "Old", updatedAt: stamp(7) },
      { id: "s4", agentRefId: "claude", title: "Other", preview: "p", updatedAt: stamp(6), home: "system" }
    ].filter(() => query?.path === join(root, "acme", "api")) } }));
  const r = await tool("list_conversations").run({ project: "acme/api", limit: 3 }, ctx(api));
  assert.deepEqual(r, { conversations: [
    { id: "s1", agent: "claude", title: "Fix build", updatedAt: stamp(9), home: "account", accountId: "acc-1", resumable: true },
    { id: "s2", agent: "claudex", title: "Proxy chat", updatedAt: stamp(8), home: "cliproxy", resumable: true },
    { id: "s3", agent: "deepseek", title: "Old", updatedAt: stamp(7), home: "system", resumable: false }
  ] });
  const only = await tool("list_conversations").run({ project: join(root, "acme", "api"), agent: "claudex", limit: 20 }, ctx(api));
  assert.deepEqual((only.conversations as { id: string }[]).map((c) => c.id), ["s2"]);
});

const chatRegistry = { shells: [], ides: [], fileExplorers: [], browsers: [], agents: [
  { id: "claude", kind: "agent", name: "Claude Code", bin: ["claude"], enabled: true, installState: "idle", chat: { adapter: "claude" } },
  { id: "claudex", kind: "agent", name: "Claude Code × GPT", bin: ["claude"], enabled: true, installState: "idle", chat: { adapter: "claude" } },
  { id: "deepseek", kind: "agent", name: "DeepSeek", bin: ["deepseek"], enabled: false, installState: "idle" }
] };

/** A fake whose sandbox holds the project directory acme/api, as resolveProject needs. */
async function projectApi(t: TestContext): Promise<FakeDaemonApi> {
  const root = await mkdtemp(join(tmpdir(), "mcp-cat-")); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "acme", "api"), { recursive: true });
  const api = new FakeDaemonApi(); api.fsRoot = root; api.workspacesDir = root;
  return api;
}

test("list_projects counts each project's own open sessions, terminal tabs included", async () => {
  const api = new FakeDaemonApi()
    .on("GET", "/api/workspaces", { status: 200, body: [{ name: "acme", path: "/w/acme", projectCount: 3 }] })
    .on("GET", "/api/workspaces/acme/projects", { status: 200, body: [{ name: "api", workspace: "acme", path: "/w/acme/api" }, { name: "web", workspace: "acme", path: "/w/acme/web" }, { name: "docs", workspace: "acme", path: "/w/acme/docs" }] })
    .on("GET", "/api/projects/recent", { status: 200, body: [] })
    .on("GET", "/api/sessions", { status: 200, body: [chatSummary(), shellSummary(), chatSummary({ id: "c2", projectPath: "/w/acme/web", cwd: "/w/acme/web" })] });
  const r = await tool("list_projects").run({ includeArchived: false }, ctx(api));
  assert.deepEqual((r.projects as { path: string; openSessions: number }[]).map((p) => [p.path, p.openSessions]), [["/w/acme/api", 2], ["/w/acme/docs", 0], ["/w/acme/web", 1]]);
});

test("list_projects leaves out a workspace whose projects cannot be read and names it in warnings; the rest is listed", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const api = new FakeDaemonApi()
    .on("GET", "/api/workspaces", { status: 200, body: [{ name: "acme", path: "/w/acme", projectCount: 1 }, { name: "gone", path: "/w/gone", projectCount: 1 }, { name: "zeta", path: "/w/zeta", projectCount: 1 }] })
    .on("GET", "/api/workspaces/acme/projects", { status: 200, body: [{ name: "api", workspace: "acme", path: "/w/acme/api" }] })
    .on("GET", "/api/workspaces/gone/projects", { status: 500, body: { statusCode: 500, code: "EACCES", error: "Internal Server Error", message: "EACCES: permission denied, scandir '/w/gone'" } })
    .on("GET", "/api/workspaces/zeta/projects", () => { throw new Error("socket hang up /w/zeta"); })
    .on("GET", "/api/projects/recent", { status: 200, body: [] })
    .on("GET", "/api/sessions", { status: 200, body: [] });
  const r = await tool("list_projects").run({ includeArchived: false }, ctx(api));
  assert.deepEqual(r, {
    projects: [{ workspace: "acme", name: "api", path: "/w/acme/api", isArchived: false, openSessions: 0 }],
    warnings: [
      "Workspace \"gone\" was left out: its projects could not be read (INTERNAL: The daemon failed handling the request.).",
      "Workspace \"zeta\" was left out: its projects could not be read (HOST_UNAVAILABLE: The daemon call failed.)."
    ]
  });
  assert.equal(logged.mock.callCount(), 1, "a thrown read is logged server-side, its text never returned");
  assert.match(String(logged.mock.calls[0].arguments[1]), /socket hang up/);
});

test("a filter naming nothing that exists is refused, not answered with an empty list; an archived workspace says why it is empty", async (t) => {
  const api = new FakeDaemonApi()
    .on("GET", "/api/workspaces", { status: 200, body: [{ name: "acme", path: "/w/acme", projectCount: 1 }, { name: "old", path: "/w/old", projectCount: 1, isArchived: true }] })
    .on("GET", "/api/workspaces/acme/projects", { status: 200, body: [{ name: "api", workspace: "acme", path: "/w/acme/api" }] })
    .on("GET", "/api/workspaces/old/projects", { status: 200, body: [{ name: "x", workspace: "old", path: "/w/old/x" }] })
    .on("GET", "/api/projects/recent", { status: 200, body: [] })
    .on("GET", "/api/sessions", { status: 200, body: [] });
  await assert.rejects(tool("list_projects").run({ workspace: "acm", includeArchived: false }, ctx(api)),
    (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && e.message === "Unknown workspace \"acm\". Workspaces: acme, old.");
  assert.ok(!api.calls.some((c) => c.path.endsWith("/projects")), "refused before any project read");
  assert.deepEqual(await tool("list_projects").run({ workspace: "old", includeArchived: false }, ctx(api)),
    { projects: [], warnings: ["Workspace \"old\" is archived; pass includeArchived: true to list its projects."] });
  assert.deepEqual((await tool("list_projects").run({ workspace: "old", includeArchived: true }, ctx(api))).projects, [{ workspace: "old", name: "x", path: "/w/old/x", isArchived: true, openSessions: 0 }]);
  const conv = await projectApi(t);
  conv.on("GET", "/api/registry", { status: 200, body: chatRegistry })
    .on("GET", "/api/agents/conversations", { status: 200, body: { conversations: [{ id: "s1", agentRefId: "claude", title: "A", updatedAt: stamp(1) }, { id: "s2", agentRefId: "gemini", title: "Legacy", updatedAt: stamp(0) }] } });
  await assert.rejects(tool("list_conversations").run({ project: "acme/api", agent: "cluade", limit: 20 }, ctx(conv)),
    (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && e.message === "Unknown agent \"cluade\". Valid agents: claude, claudex, deepseek.");
  // Known ids answer honestly: an agent with nothing recorded is an empty list, and an agent a row names is a valid filter.
  assert.deepEqual(await tool("list_conversations").run({ project: "acme/api", agent: "claudex", limit: 20 }, ctx(conv)), { conversations: [] });
  assert.deepEqual((await tool("list_conversations").run({ project: "acme/api", agent: "gemini", limit: 20 }, ctx(conv))).conversations, [{ id: "s2", agent: "gemini", title: "Legacy", updatedAt: stamp(0), home: "system", resumable: false }]);
});

test("list_agents hides legacy models unless includeLegacyModels", async () => {
  const providers = { hostInstanceId: "h", providers: [{ id: "claude", refIds: ["claude"], installed: true, version: "2", status: "ready", auth: { status: "authenticated" }, checkedAt: stamp(0), slashCommands: [], skills: [], capabilities: null,
    models: [{ slug: "fable", name: "Fable", isDefault: true, capabilities: null }, { slug: "sonnet-4", name: "Sonnet 4", isLegacy: true, capabilities: null }] }] };
  const api = new FakeDaemonApi()
    .on("GET", "/api/registry", { status: 200, body: { shells: [], ides: [], fileExplorers: [], browsers: [], agents: [chatRegistry.agents[0]] } })
    .on("GET", "/api/agent/providers", { status: 200, body: providers })
    .on("GET", "/api/agent-accounts", { status: 200, body: { accounts: [], defaults: { claude: null, codex: null, grok: null } } });
  const models = async (includeLegacyModels: boolean) => ((await tool("list_agents").run({ includeLegacyModels }, ctx(api))).agents as { models: { slug: string; isLegacy?: boolean }[] }[])[0]!.models.map((m) => [m.slug, m.isLegacy ?? false]);
  assert.deepEqual(await models(false), [["fable", false]]);
  assert.deepEqual(await models(true), [["fable", false], ["sonnet-4", true]]);
});

test("list_conversations: a proxy-home row resumes only through its launcher, preview is kept, and the agent filter runs before the limit", async (t) => {
  const api = await projectApi(t);
  api.on("GET", "/api/registry", { status: 200, body: chatRegistry }).on("GET", "/api/agents/conversations", { status: 200, body: { conversations: [
    { id: "s1", agentRefId: "claude", title: "Proxy home, launcher unknown", updatedAt: stamp(9), home: "cliproxy" },
    { id: "s2", agentRefId: "claude", title: "Proxy", preview: "the long blurb", updatedAt: stamp(8), home: "cliproxy", proxyRefId: "claudex" },
    { id: "s3", agentRefId: "deepseek", title: "Detect-only", updatedAt: stamp(7) },
    { id: "s4", agentRefId: "claude", title: "Mine", updatedAt: stamp(6), home: "system" },
    { id: "s5", agentRefId: "claude", title: "Proxy again", updatedAt: stamp(5), home: "cliproxy", proxyRefId: "claudex" }
  ] } });
  const all = await tool("list_conversations").run({ project: "acme/api", limit: 20 }, ctx(api));
  assert.deepEqual((all.conversations as { id: string; agent: string; resumable: boolean }[]).map((c) => [c.id, c.agent, c.resumable]),
    [["s1", "claude", false], ["s2", "claudex", true], ["s3", "deepseek", false], ["s4", "claude", true], ["s5", "claudex", true]]);
  // Filtered first, then cut: claudex's first row, not the first row overall.
  assert.deepEqual(await tool("list_conversations").run({ project: "acme/api", agent: "claudex", limit: 1 }, ctx(api)),
    { conversations: [{ id: "s2", agent: "claudex", title: "Proxy", preview: "the long blurb", updatedAt: stamp(8), home: "cliproxy", resumable: true }] });
});

test("list_conversations fails INTERNAL when the registry cannot be read, as list_agents does, instead of calling every row unresumable", async (t) => {
  const api = await projectApi(t);
  api.on("GET", "/api/registry", { status: 500, body: null })
    .on("GET", "/api/agents/conversations", { status: 200, body: { conversations: [{ id: "s1", agentRefId: "claude", title: "A", updatedAt: stamp(1) }] } });
  for (const name of ["list_conversations", "list_agents"]) {
    await assert.rejects(tool(name).run({ project: "acme/api", limit: 20, includeLegacyModels: false }, ctx(api)),
      (e: { code: string; message: string }) => e.code === "INTERNAL" && e.message === "Could not read the agent registry.", name);
  }
});

test("an empty filter is refused like any unknown one, never read as \"no filter\"", async (t) => {
  const api = await projectApi(t);
  api.on("GET", "/api/workspaces", { status: 200, body: [{ name: "acme", path: "/w/acme", projectCount: 1 }] })
    .on("GET", "/api/workspaces/acme/projects", { status: 200, body: [{ name: "api", workspace: "acme", path: "/w/acme/api" }] })
    .on("GET", "/api/projects/recent", { status: 200, body: [] }).on("GET", "/api/sessions", { status: 200, body: [] })
    .on("GET", "/api/registry", { status: 200, body: chatRegistry })
    .on("GET", "/api/agent/providers", { status: 200, body: { hostInstanceId: "h", providers: [] } })
    .on("GET", "/api/agent-accounts", { status: 200, body: { accounts: [], defaults: { claude: null, codex: null, grok: null } } })
    .on("GET", "/api/agents/conversations", { status: 200, body: { conversations: [{ id: "s1", agentRefId: "claude", title: "A", updatedAt: stamp(1) }] } });
  const refused = (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && /^Unknown (workspace|agent) ""\./.test(e.message);
  await assert.rejects(tool("list_projects").run({ workspace: "", includeArchived: false }, ctx(api)), refused, "list_projects");
  await assert.rejects(tool("list_agents").run({ agent: "", includeLegacyModels: false }, ctx(api)), refused, "list_agents");
  await assert.rejects(tool("list_conversations").run({ project: "acme/api", agent: "", limit: 20 }, ctx(api)), refused, "list_conversations");
  for (const t of catalogTools) {
    const filter = (t.input as Record<string, { safeParse(v: unknown): { success: boolean } }>)[t.name === "list_projects" ? "workspace" : "agent"]!;
    assert.equal(filter.safeParse("").success, false, `${t.name}'s schema refuses ""`);
  }
});
