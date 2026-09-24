import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDaemonApi } from "../testing.ts";
import { chatSummary, shellSummary, stamp } from "../fixtures.ts";
import { loadAgents } from "../agents.ts";
import { MAX_RESULT_BYTES, ok, resultBytes } from "../result.ts";
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
  for (const def of catalogTools) {
    const filter = (def.input as Record<string, { safeParse(v: unknown): { success: boolean } }>)[def.name === "list_projects" ? "workspace" : "agent"]!;
    assert.equal(filter.safeParse("").success, false, `${def.name}'s schema refuses ""`);
  }
});

// ---- Final fix wave F2: list_agents and list_conversations bound themselves under ok()'s 60 000-byte cap. ----

type ListedModel = { slug: string; isDefault: boolean; isLegacy?: boolean; options?: unknown[]; optionsOmitted?: true };
type ListedAgent = { id: string; models: ListedModel[]; modelsTruncated?: true; modelCount?: number; [key: string]: unknown };

const chatAgent = (id: string, name: string, adapter: string) => ({ id, kind: "agent", name, bin: [adapter === "claude" ? "claude" : id], enabled: true, installState: "idle", chat: { adapter } });
const allChatAgents = [chatAgent("claude", "Claude Code", "claude"), chatAgent("codex", "Codex", "codex"), chatAgent("opencode", "OpenCode", "opencode"), chatAgent("grok", "Grok Build", "grok"), chatAgent("claudex", "Claude Code × GPT/Kimi/Grok", "claude"), chatAgent("claudemix", "Claude Code × Mixed", "claude")];
const select = (id: string, label: string, values: string[], description?: string) => ({ id, label, type: "select", ...(description ? { description } : {}), options: values.map((v, i) => ({ id: v, label: v[0]!.toUpperCase() + v.slice(1), ...(i === 1 ? { isDefault: true } : {}) })) });

/** `n` OpenCode models, their option descriptors in 22 distinct sets (as on a real host: 389 models, a few dozen sets); `defaultAt` is flagged default, or none. */
function openCodeCatalogue(n: number, defaultAt: number | null) {
  const sets = Array.from({ length: 22 }, (_, s) => [
    select("variant", "Reasoning", ["low", "medium", "high", "xhigh", "max"].slice(0, 2 + (s % 4)), `Reasoning depth, profile ${s + 1}.`),
    select("agent", "Agent", ["plan", "build"]),
    ...(s >= 11 ? [{ id: "fast", label: "Fast mode", type: "boolean", description: `Trade depth for speed (tier ${s - 10}).` }] : [])
  ]);
  return Array.from({ length: n }, (_, i) => ({ slug: `openrouter/vendor-${i % 40}/model-${i}`, name: `Vendor ${i % 40} Model ${i}`, ...(i === defaultAt ? { isDefault: true } : {}), capabilities: { optionDescriptors: sets[i % 22] } }));
}

/** Every chat agent of a real registry over a catalogue whose OpenCode models are `openCodeModels`. */
function catalogueApi(openCodeModels: unknown[]): FakeDaemonApi {
  const claudeOptions = [select("effort", "Effort", ["low", "medium", "high", "max"], "How much reasoning the model spends on a turn."), { id: "thinking", label: "Thinking", type: "boolean", description: "Show the model's summarised reasoning." }];
  const claudeModels = [{ slug: "default", name: "Default (recommended)", isDefault: true, capabilities: { optionDescriptors: claudeOptions } }, { slug: "opus", name: "Opus", capabilities: { optionDescriptors: claudeOptions } }, { slug: "sonnet", name: "Sonnet", capabilities: { optionDescriptors: claudeOptions } }, { slug: "haiku", name: "Haiku", capabilities: { optionDescriptors: [] } }];
  const codexModels = ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.5"].map((slug, i) => ({ slug, name: slug.toUpperCase(), ...(i === 0 ? { isDefault: true } : {}), ...(i === 4 ? { isLegacy: true } : {}), capabilities: { optionDescriptors: [select("effort", "Effort", ["low", "medium", "high", "xhigh"]), select("serviceTier", "Service tier", ["flex", "default", "priority"])] } }));
  const grokModels = ["grok-4.6", "grok-4.5"].map((slug, i) => ({ slug, name: `Grok ${slug.slice(5)}`, ...(i === 0 ? { isDefault: true } : {}), capabilities: { optionDescriptors: [select("reasoningEffort", "Reasoning", ["low", "high"])] } }));
  const row = (id: string, models: unknown[]) => ({ id, refIds: [id], installed: true, version: "1.0.0", status: "ready", auth: { status: "authenticated" }, checkedAt: stamp(0), slashCommands: [], skills: [], capabilities: { sessionModelSwitch: "in-session", showPlanModeToggle: true, reportsContextWindow: true, compaction: { type: "native" } }, models });
  const cliproxy = { state: "healthy", reasons: [], detail: null, version: null, defaultModel: "gpt-5.6-sol", backgroundModel: "", modelOverrides: {}, providers: [], routerProviders: [], accounts: [], activeSessionCount: 0, testedClaudeCliVersion: null, xai: { state: "none", email: null, expiredAt: null, lastQuotaError: null, lastLinkError: null, link: null } };
  return new FakeDaemonApi()
    .on("GET", "/api/registry", { status: 200, body: { shells: [], ides: [], fileExplorers: [], browsers: [], agents: allChatAgents } })
    .on("GET", "/api/agent/providers", { status: 200, body: { hostInstanceId: "h", providers: [row("claude", claudeModels), row("codex", codexModels), row("opencode", openCodeModels), row("grok", grokModels)] } })
    .on("GET", "/api/agent-accounts", { status: 200, body: { accounts: [], defaults: { claude: null, codex: null, grok: null } } })
    .on("GET", "/api/cliproxy", { status: 200, body: cliproxy })
    .on("GET", "/api/cliproxy/models", { status: 200, body: { models: [], asOf: null } });
}

/** A model as the shed list shows it: its fields but its options, and the mark. */
const withoutOptions = ({ options: _options, ...model }: ListedModel): ListedModel => ({ ...model, optionsOmitted: true });
const agentsOf = (r: Record<string, unknown>) => r.agents as ListedAgent[];
const listAgents = (api: FakeDaemonApi, args: Record<string, unknown> = {}) => tool("list_agents").run({ includeLegacyModels: false, ...args }, ctx(api));

test("list_agents keeps within the result cap: 400 OpenCode models in 22 option sets shed only the options of non-default models, largest catalogue first, from its end", async () => {
  const models = openCodeCatalogue(400, 137);
  assert.equal(new Set(models.map((m) => JSON.stringify(m.capabilities.optionDescriptors))).size, 22);
  const api = catalogueApi(models);
  const whole = (await loadAgents(api)) as unknown as ListedAgent[]; // what create_session and update_session still read
  assert.ok(resultBytes({ agents: whole }) > 200_000, "the unbounded catalogue is far past the cap");
  const r = await listAgents(api);
  const agents = agentsOf(r);
  assert.deepEqual(agents.map((a) => a.id), ["claude", "codex", "opencode", "grok", "claudex", "claudemix"], "every agent is listed");
  assert.ok(resultBytes(r) <= MAX_RESULT_BYTES, `${resultBytes(r)} bytes`);
  assert.deepEqual(ok(r).structuredContent, r, "never cut by ok()'s last resort");
  // OpenCode's options alone make the room: every other agent comes back exactly as loadAgents built it.
  for (const [i, agent] of agents.entries()) if (agent.id !== "opencode") assert.deepEqual(agent, whole[i], agent.id);
  const opencode = agents[2]!;
  const source = whole[2]!;
  assert.deepEqual({ ...opencode, models: [] }, { ...source, models: [] }, "the header is whole, with no truncation flags: no model was left out");
  assert.deepEqual(opencode.models.map((m) => m.slug), source.models.map((m) => m.slug), "all 400 models are listed");
  const shed = opencode.models.map((m) => m.optionsOmitted === true);
  const first = shed.indexOf(true);
  assert.ok(first > 0 && first < 137, `options are dropped from the end of the list first, so the first ${first} keep theirs`);
  assert.deepEqual(shed, source.models.map((_, j) => j >= first && j !== 137), "a tail loses its options; the default keeps them");
  for (const [j, m] of opencode.models.entries()) assert.deepEqual(m, shed[j] ? withoutOptions(source.models[j]!) : source.models[j], `model ${j}`);
  assert.equal(opencode.models[137]!.isDefault, true);
  assert.ok(opencode.models[137]!.options!.length > 0, "the default keeps its options");
  // Tight: giving the last model stripped its options back would pass the cap. Measured exactly, not estimated.
  assert.ok(resultBytes(r) - resultBytes(opencode.models[first]) + resultBytes(source.models[first]) > MAX_RESULT_BYTES, "no more was shed than needed");
  // The one model the caller names comes back whole: its full options, even for a model the list shed.
  const named = await listAgents(api, { agent: "opencode", model: "openrouter/vendor-39/model-399" });
  assert.deepEqual(named, { agents: [{ ...source, models: [source.models[399]] }] });
  assert.ok((source.models[399]!.options ?? []).length > 0, "a model with options to show");
});

test("list_agents sheds whole models only once every catalogue has shed its options: the largest keeps its oldest-listed models and its default, and says modelsTruncated of modelCount", async () => {
  const api = catalogueApi(openCodeCatalogue(1_500, 900));
  const whole = (await loadAgents(api)) as unknown as ListedAgent[];
  const r = await listAgents(api);
  const agents = agentsOf(r);
  assert.deepEqual(agents.map((a) => a.id), ["claude", "codex", "opencode", "grok", "claudex", "claudemix"]);
  assert.ok(resultBytes(r) <= MAX_RESULT_BYTES, `${resultBytes(r)} bytes`);
  assert.deepEqual(ok(r).structuredContent, r);
  for (const [i, agent] of agents.entries()) {
    const source = whole[i]!;
    if (agent.id === "opencode") continue;
    // Every other agent keeps every model, and its header whole; each non-default model with options is shown without them.
    assert.deepEqual({ ...agent, models: [] }, { ...source, models: [] }, `${agent.id}: header`);
    assert.deepEqual(agent.models, source.models.map((m) => (m.isDefault || !m.options?.length ? m : withoutOptions(m))), `${agent.id}: models`);
  }
  // A model with no options has nothing to shed and is never marked: Claude's haiku.
  const haiku = agents[0]!.models.find((m) => m.slug === "haiku")!;
  assert.deepEqual([haiku.options, haiku.optionsOmitted], [[], undefined]);
  // claudex's proxy models carry the Claude default's options, and shed them like any other model.
  assert.ok(agents[4]!.models.some((m) => m.optionsOmitted === true), "claudex's non-default models shed their options too");
  const opencode = agents[2]!;
  const source = whole[2]!;
  assert.equal(opencode.modelsTruncated, true);
  assert.equal(opencode.modelCount, 1_500);
  assert.deepEqual({ ...opencode, models: [], modelsTruncated: undefined, modelCount: undefined }, { ...source, models: [], modelsTruncated: undefined, modelCount: undefined }, "the rest of the header is whole");
  const kept = opencode.models.length - 1; // the oldest-listed models, then the default
  assert.ok(kept > 100 && kept < 900, `${kept} models kept`);
  assert.deepEqual(opencode.models.map((m) => m.slug), [...source.models.slice(0, kept), source.models[900]!].map((m) => m.slug), "dropped from the end of the list, the default spared");
  assert.deepEqual(opencode.models[kept], source.models[900], "the default keeps its options");
  assert.ok(opencode.models.slice(0, kept).every((m) => m.optionsOmitted === true && !("options" in m)), "every kept non-default model is shown without its options");
  // Tight: the next model in list order would not fit.
  assert.ok(resultBytes(r) + resultBytes(withoutOptions(source.models[kept]!)) + 1 > MAX_RESULT_BYTES, "no more was shed than needed");
  // One agent alone is bounded the same way, and has more room.
  const one = await listAgents(api, { agent: "opencode" });
  const alone = agentsOf(one)[0]!;
  assert.ok(resultBytes(one) <= MAX_RESULT_BYTES, `${resultBytes(one)} bytes`);
  assert.equal(alone.modelsTruncated, true);
  assert.equal(alone.modelCount, 1_500);
  assert.ok(alone.models.length > opencode.models.length, `${alone.models.length} models alone`);
});

test("list_agents: an agent with no flagged default spares its first model, the one a launch that names none gets", async () => {
  const api = catalogueApi(openCodeCatalogue(1_500, null));
  const whole = (await loadAgents(api)) as unknown as ListedAgent[];
  const opencode = agentsOf(await listAgents(api))[2]!;
  assert.deepEqual(opencode.models[0], whole[2]!.models[0], "whole, with its options");
  assert.ok(opencode.models.slice(1).every((m) => m.optionsOmitted === true), "every other model is shown without its options");
  assert.equal(opencode.modelsTruncated, true);
});

test("list_agents {agent, model}: one model with its full options; a model needs an agent, an unknown one is refused naming valid slugs", async () => {
  const api = catalogueApi(openCodeCatalogue(400, 137));
  const whole = (await loadAgents(api, { includeLegacyModels: true })) as unknown as ListedAgent[];
  const codex = whole[1]!;
  assert.deepEqual(await listAgents(api, { agent: "codex", model: "gpt-6-sol" }), { agents: [{ ...codex, models: [codex.models[1]] }] });
  // A model named outright is found even when legacy: the flag only trims a listing.
  assert.deepEqual(agentsOf(await listAgents(api, { agent: "codex", model: "gpt-5.5" }))[0]!.models, [codex.models[4]]);
  assert.equal(codex.models[4]!.isLegacy, true);
  await assert.rejects(listAgents(api, { model: "gpt-6-sol" }), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && /model.*agent/i.test(e.message));
  await assert.rejects(listAgents(api, { agent: "opencode", model: "nope" }),
    (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && e.message.startsWith("Unknown model \"nope\" for opencode. Valid models: openrouter/vendor-0/model-0, openrouter/vendor-1/model-1, ") && e.message.endsWith(", ….") && e.message.length < 4_000);
  await assert.rejects(listAgents(api, { agent: "nope", model: "x" }), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && /Unknown agent "nope"/.test(e.message));
  // Still probing: nothing to look up yet, and the refusal says so.
  const probing = catalogueApi([]);
  await assert.rejects(listAgents(probing, { agent: "opencode", model: "x" }), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && /Still loading opencode's models/.test(e.message));
  const def = tool("list_agents");
  assert.equal((def.input as Record<string, { safeParse(v: unknown): { success: boolean } }>).model!.safeParse("").success, false, "an empty model is refused like an empty agent");
});

test("list_agents' description says how to read a shed model's options, and that only enabled agents open", () => {
  const def = tool("list_agents");
  assert.ok(def.description.length <= 400, `${def.description.length} characters`);
  assert.match(def.description, /list_agents \{agent, model\}/);
  assert.match(def.description, /optionsOmitted/);
  assert.match(def.description, /modelsTruncated/);
  assert.match(def.description, /disabledReason/);
  assert.doesNotMatch(def.description, /agents you can open/);
  // The registry sets no reason for an agent whose CLI was not found.
  assert.match(def.description, /disabledReason, when known/);
  const model = (def.input as Record<string, { description?: string }>).model!;
  assert.match(model.description ?? "", /agent/);
  assert.match(model.description ?? "", /options/);
  // A legacy model is found by name, but create_session refuses it (it loads no legacy models); update_session takes it.
  assert.match(model.description ?? "", /legacy/i);
  assert.match(model.description ?? "", /create_session refuses/);
  assert.match(model.description ?? "", /update_session/);
});

test("list_conversations keeps within the result cap: 200 long rows lose the oldest ones, and truncated/omitted say how many", async (t) => {
  const api = await projectApi(t);
  const long = (i: number) => `会話 ${i} ${"長いタイトルの説明".repeat(9)}`.slice(0, 80);
  const conversations = Array.from({ length: 200 }, (_, i) => ({ id: `0f6d2c5e-8a1b-4c3d-9e7f-${String(i).padStart(12, "0")}`, agentRefId: "claude", title: long(i), preview: long(i + 1_000), updatedAt: stamp(1_000 - i), home: "account", accountId: "acc-1" }));
  api.on("GET", "/api/registry", { status: 200, body: chatRegistry }).on("GET", "/api/agents/conversations", { status: 200, body: { conversations } });
  const projected = (c: (typeof conversations)[number]) => ({ id: c.id, agent: "claude", title: c.title, preview: c.preview, updatedAt: c.updatedAt, home: "account", accountId: "acc-1", resumable: true });
  assert.ok(resultBytes({ conversations: conversations.map(projected) }) > 100_000, "the unbounded list is far past the cap");
  const r = await tool("list_conversations").run({ project: "acme/api", limit: 200 }, ctx(api));
  const rows = r.conversations as ReturnType<typeof projected>[];
  assert.ok(resultBytes(r) <= MAX_RESULT_BYTES, `${resultBytes(r)} bytes`);
  assert.deepEqual(ok(r).structuredContent, r);
  assert.ok(rows.length > 50 && rows.length < 200, `${rows.length} rows`);
  assert.deepEqual(r, { conversations: conversations.slice(0, rows.length).map(projected), truncated: true, omitted: 200 - rows.length }, "the newest rows, in order");
  // Tight: the next-oldest row would not have fitted.
  assert.ok(resultBytes({ conversations: [...rows, projected(conversations[rows.length]!)], truncated: true, omitted: 200 - rows.length - 1 }) > MAX_RESULT_BYTES, "no more was left out than needed");
  // A list that fits is returned as before, unflagged.
  assert.deepEqual(await tool("list_conversations").run({ project: "acme/api", limit: 20 }, ctx(api)), { conversations: conversations.slice(0, 20).map(projected) });
});

test("list_conversations: a row is resumable only through an ENABLED chat agent, as the GUI's resume lists require (create_session refuses a disabled one)", async (t) => {
  const api = await projectApi(t);
  api.on("GET", "/api/registry", { status: 200, body: { ...chatRegistry, agents: chatRegistry.agents.map((a) => (a.id === "claudex" ? { ...a, enabled: false, disabledReason: "proxy down" } : a)) } })
    .on("GET", "/api/agents/conversations", { status: 200, body: { conversations: [
      { id: "s1", agentRefId: "claude", title: "Through the proxy", updatedAt: stamp(3), home: "cliproxy", proxyRefId: "claudex" },
      { id: "s2", agentRefId: "claude", title: "Mine", updatedAt: stamp(2), home: "system" }
    ] } });
  const r = await tool("list_conversations").run({ project: "acme/api", limit: 20 }, ctx(api));
  assert.deepEqual((r.conversations as { id: string; agent: string; resumable: boolean }[]).map((c) => [c.id, c.agent, c.resumable]), [["s1", "claudex", false], ["s2", "claude", true]]);
  // The filter still names the disabled agent's rows: it lists them, it just cannot resume them.
  assert.deepEqual((await tool("list_conversations").run({ project: "acme/api", agent: "claudex", limit: 20 }, ctx(api))).conversations, [{ id: "s1", agent: "claudex", title: "Through the proxy", updatedAt: stamp(3), home: "cliproxy", resumable: false }]);
});
