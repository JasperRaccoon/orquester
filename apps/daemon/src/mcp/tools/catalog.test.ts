import { test,type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,mkdir,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDaemonApi } from "../testing.ts";
import { chatSummary,shellSummary,stamp } from "../fixtures.ts";
import { ok } from "../result.ts";
import type { ToolContext } from "../tool.ts";
import { catalogTools } from "./catalog.ts";

const resultBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

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

test("list_conversations resolves the project, names each row's agent and flags resumability", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mcp-cat-")); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "acme", "api"), { recursive: true });
  const api = new FakeDaemonApi(); api.fsRoot = root; api.workspacesDir = root;
  api.on("GET", "/api/registry", { status: 200, body: { shells: [], ides: [], fileExplorers: [], browsers: [], agents: [{ id: "claude", kind: "agent", name: "Claude Code", bin: ["claude"], enabled: true, installState: "idle", chat: { adapter: "claude" } }, { id: "codex", kind: "agent", name: "Codex", bin: ["codex"], enabled: true, installState: "idle", chat: { adapter: "codex" } }] } })
    .on("GET", "/api/agents/conversations", ({ query }) => ({ status: 200, body: { conversations: [
      { id: "s1", agentRefId: "claude", title: "Fix build", updatedAt: stamp(9), home: "account", accountId: "acc-1" },
      { id: "s2", agentRefId: "codex", title: "Codex chat", updatedAt: stamp(8), home: "system" },
      { id: "s3", agentRefId: "deepseek", title: "Old", updatedAt: stamp(7) },
      { id: "s4", agentRefId: "claude", title: "Other", preview: "p", updatedAt: stamp(6), home: "system" }
    ].filter(() => query?.path === join(root, "acme", "api")) } }));
  const r = await tool("list_conversations").run({ project: "acme/api", limit: 3 }, ctx(api));
  assert.deepEqual(r, { conversations: [
    { id: "s1", agent: "claude", title: "Fix build", updatedAt: stamp(9), home: "account", accountId: "acc-1", resumable: true },
    { id: "s2", agent: "codex", title: "Codex chat", updatedAt: stamp(8), home: "system", resumable: true },
    { id: "s3", agent: "deepseek", title: "Old", updatedAt: stamp(7), home: "system", resumable: false }
  ] });
  const only = await tool("list_conversations").run({ project: join(root, "acme", "api"), agent: "codex", limit: 20 }, ctx(api));
  assert.deepEqual((only.conversations as { id: string }[]).map((c) => c.id), ["s2"]);
});

const chatRegistry = { shells: [], ides: [], fileExplorers: [], browsers: [], agents: [
  { id: "claude", kind: "agent", name: "Claude Code", bin: ["claude"], enabled: true, installState: "idle", chat: { adapter: "claude" } },
  { id: "codex", kind: "agent", name: "Codex", bin: ["codex"], enabled: true, installState: "idle", chat: { adapter: "codex" } },
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
  t.mock.method(console, "error", () => {});
  const api = new FakeDaemonApi()
    .on("GET", "/api/workspaces", { status: 200, body: [{ name: "acme", path: "/w/acme", projectCount: 1 }, { name: "gone", path: "/w/gone", projectCount: 1 }, { name: "zeta", path: "/w/zeta", projectCount: 1 }] })
    .on("GET", "/api/workspaces/acme/projects", { status: 200, body: [{ name: "api", workspace: "acme", path: "/w/acme/api" }] })
    .on("GET", "/api/workspaces/gone/projects", { status: 500, body: { statusCode: 500, code: "EACCES", error: "Internal Server Error", message: "EACCES: permission denied, scandir '/w/gone'" } })
    .on("GET", "/api/workspaces/zeta/projects", () => { throw new Error("socket hang up /w/zeta"); })
    .on("GET", "/api/projects/recent", { status: 200, body: [] })
    .on("GET", "/api/sessions", { status: 200, body: [] });
  const r = await tool("list_projects").run({ includeArchived: false }, ctx(api));
  assert.deepEqual(r.projects, [{ workspace: "acme", name: "api", path: "/w/acme/api", isArchived: false, openSessions: 0 }]);
  const warnings = r.warnings as string[];
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((warning) => warning.includes("gone") && warning.includes("INTERNAL")));
  assert.ok(warnings.some((warning) => warning.includes("zeta") && warning.includes("HOST_UNAVAILABLE")));
  assert.ok(warnings.every((warning) => !warning.includes("/w/")));
});

test("a filter naming nothing that exists is refused, not answered with an empty list; an archived workspace says why it is empty", async (t) => {
  const api = new FakeDaemonApi()
    .on("GET", "/api/workspaces", { status: 200, body: [{ name: "acme", path: "/w/acme", projectCount: 1 }, { name: "old", path: "/w/old", projectCount: 1, isArchived: true }] })
    .on("GET", "/api/workspaces/acme/projects", { status: 200, body: [{ name: "api", workspace: "acme", path: "/w/acme/api" }] })
    .on("GET", "/api/workspaces/old/projects", { status: 200, body: [{ name: "x", workspace: "old", path: "/w/old/x" }] })
    .on("GET", "/api/projects/recent", { status: 200, body: [] })
    .on("GET", "/api/sessions", { status: 200, body: [] });
  await assert.rejects(tool("list_projects").run({ workspace: "acm", includeArchived: false }, ctx(api)),
    (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && ["acm", "acme", "old"].every((name) => e.message.includes(name)));
  assert.ok(!api.calls.some((c) => c.path.endsWith("/projects")), "refused before any project read");
  const archived = await tool("list_projects").run({ workspace: "old", includeArchived: false }, ctx(api));
  assert.deepEqual(archived.projects, []);
  assert.ok((archived.warnings as string[]).some((warning) => warning.includes("old") && warning.includes("includeArchived")));
  assert.deepEqual((await tool("list_projects").run({ workspace: "old", includeArchived: true }, ctx(api))).projects, [{ workspace: "old", name: "x", path: "/w/old/x", isArchived: true, openSessions: 0 }]);
  const conv = await projectApi(t);
  conv.on("GET", "/api/registry", { status: 200, body: chatRegistry })
    .on("GET", "/api/agents/conversations", { status: 200, body: { conversations: [{ id: "s1", agentRefId: "claude", title: "A", updatedAt: stamp(1) }, { id: "s2", agentRefId: "gemini", title: "Legacy", updatedAt: stamp(0) }] } });
  await assert.rejects(tool("list_conversations").run({ project: "acme/api", agent: "cluade", limit: 20 }, ctx(conv)),
    (e: { code: string }) => e.code === "INVALID_ARGUMENT");
  // Known ids answer honestly: an agent with nothing recorded is an empty list, and an agent a row names is a valid filter.
  assert.deepEqual(await tool("list_conversations").run({ project: "acme/api", agent: "codex", limit: 20 }, ctx(conv)), { conversations: [] });
  assert.deepEqual((await tool("list_conversations").run({ project: "acme/api", agent: "gemini", limit: 20 }, ctx(conv))).conversations, [{ id: "s2", agent: "gemini", title: "Legacy", updatedAt: stamp(0), home: "system", resumable: false }]);
});

test("list_conversations: preview is kept, a detect-only agent's row is not resumable, and the agent filter runs before the limit", async (t) => {
  const api = await projectApi(t);
  api.on("GET", "/api/registry", { status: 200, body: chatRegistry }).on("GET", "/api/agents/conversations", { status: 200, body: { conversations: [
    { id: "s1", agentRefId: "claude", title: "In an account home", updatedAt: stamp(9), home: "account", accountId: "acc-1" },
    { id: "s2", agentRefId: "codex", title: "Codex", preview: "the long blurb", updatedAt: stamp(8), home: "system" },
    { id: "s3", agentRefId: "deepseek", title: "Detect-only", updatedAt: stamp(7) },
    { id: "s4", agentRefId: "claude", title: "Mine", updatedAt: stamp(6), home: "system" },
    { id: "s5", agentRefId: "codex", title: "Codex again", updatedAt: stamp(5), home: "system" }
  ] } });
  // Filtered first, then cut: codex's first row, not the first row overall.
  assert.deepEqual(await tool("list_conversations").run({ project: "acme/api", agent: "codex", limit: 1 }, ctx(api)),
    { conversations: [{ id: "s2", agent: "codex", title: "Codex", preview: "the long blurb", updatedAt: stamp(8), home: "system", resumable: true }] });
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
const allChatAgents = [chatAgent("claude", "Claude Code", "claude"), chatAgent("codex", "Codex", "codex"), chatAgent("opencode", "OpenCode", "opencode"), chatAgent("grok", "Grok Build", "grok")];
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
  return new FakeDaemonApi()
    .on("GET", "/api/registry", { status: 200, body: { shells: [], ides: [], fileExplorers: [], browsers: [], agents: allChatAgents } })
    .on("GET", "/api/agent/providers", { status: 200, body: { hostInstanceId: "h", providers: [row("claude", claudeModels), row("codex", codexModels), row("opencode", openCodeModels), row("grok", grokModels)] } })
    .on("GET", "/api/agent-accounts", { status: 200, body: { accounts: [], defaults: { claude: null, codex: null, grok: null } } });
}

const agentsOf = (r: Record<string, unknown>) => r.agents as ListedAgent[];
const listAgents = (api: FakeDaemonApi, args: Record<string, unknown> = {}) => tool("list_agents").run({ includeLegacyModels: false, ...args }, ctx(api));

test("list_agents bounds large catalogues, preserves every model and the default options, and restores named model options", async () => {
  const api = catalogueApi(openCodeCatalogue(400, 137));
  const r = await listAgents(api);
  assert.ok(Buffer.byteLength(JSON.stringify(r)) <= 60_000);
  const agents = agentsOf(r);
  assert.deepEqual(agents.map((a) => a.id), ["claude", "codex", "opencode", "grok"]);
  const models = agents.find((a) => a.id === "opencode")!.models;
  assert.deepEqual(models.map((m) => m.slug), Array.from({ length: 400 }, (_, i) => "openrouter/vendor-" + i % 40 + "/model-" + i));
  assert.equal(models[137]!.isDefault, true);
  assert.ok(models[137]!.options!.length > 0);
  assert.ok(models.some((m) => m.optionsOmitted === true));
  const named = agentsOf(await listAgents(api, { agent: "opencode", model: "openrouter/vendor-39/model-399" }))[0]!.models;
  assert.equal(named.length, 1);
  assert.equal(named[0]!.slug, "openrouter/vendor-39/model-399");
  assert.equal(named[0]!.optionsOmitted, undefined);
  assert.deepEqual((named[0]!.options as { id: string; values: { id: string }[] }[]).map((o) => [o.id, o.values.map((v) => v.id)]), [["variant", ["low", "medium", "high", "xhigh", "max"]], ["agent", ["plan", "build"]]]);
});

test("list_agents reports omitted models while preserving the default and keeping a bounded result", async () => {
  const api = catalogueApi(openCodeCatalogue(1_500, 900));
  const r = await listAgents(api);
  assert.ok(Buffer.byteLength(JSON.stringify(r)) <= 60_000);
  const opencode = agentsOf(r).find((a) => a.id === "opencode")!;
  assert.equal(opencode.modelsTruncated, true);
  assert.equal(opencode.modelCount, 1_500);
  assert.ok(opencode.models.length > 0 && opencode.models.length < 1_500);
  const selected = opencode.models.find((m) => m.slug === "openrouter/vendor-20/model-900")!;
  assert.equal(selected.isDefault, true);
  assert.ok(selected.options!.length > 0);
  assert.ok(opencode.models.filter((m) => !m.isDefault).every((m) => m.optionsOmitted === true && m.options === undefined));
  const haiku = agentsOf(r).find((a) => a.id === "claude")!.models.find((m) => m.slug === "haiku")!;
  assert.deepEqual([haiku.options, haiku.optionsOmitted], [[], undefined]);
  const one = await listAgents(api, { agent: "opencode" });
  assert.ok(Buffer.byteLength(JSON.stringify(one)) <= 60_000);
  assert.equal(agentsOf(one)[0]!.modelCount, 1_500);
  assert.ok(agentsOf(one)[0]!.models.length > opencode.models.length);
});

test("list_agents preserves launch-default options when no model has an explicit default flag", async () => {
  const api = catalogueApi(openCodeCatalogue(1_500, null));
  const opencode = agentsOf(await listAgents(api)).find((a) => a.id === "opencode")!;
  assert.equal(opencode.models[0]!.slug, "openrouter/vendor-0/model-0");
  assert.deepEqual((opencode.models[0]!.options as { id: string; values: { id: string }[] }[]).map((o) => [o.id, o.values.map((v) => v.id)]), [["variant", ["low", "medium"]], ["agent", ["plan", "build"]]]);
  assert.ok(opencode.models.slice(1).every((m) => m.optionsOmitted === true));
  assert.equal(opencode.modelsTruncated, true);
});

test("list_agents {agent, model}: one model with its full options; a model needs an agent, an unknown one is refused naming valid slugs", async () => {
  const api = catalogueApi(openCodeCatalogue(400, 137));
  const named = agentsOf(await listAgents(api, { agent: "codex", model: "gpt-6-sol" }))[0]!.models;
  assert.equal(named.length, 1);
  assert.equal(named[0]!.slug, "gpt-6-sol");
  assert.deepEqual((named[0]!.options as { id: string }[]).map((o) => o.id), ["effort", "serviceTier"]);
  // A model named outright is found even when legacy: the flag only trims a listing.
  const legacy = agentsOf(await listAgents(api, { agent: "codex", model: "gpt-5.5" }))[0]!.models;
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0]!.slug, "gpt-5.5");
  assert.equal(legacy[0]!.isLegacy, true);
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

test("list_conversations keeps within the result cap: 200 long rows lose the oldest ones, and truncated/omitted say how many", async (t) => {
  const api = await projectApi(t);
  const long = (i: number) => `会話 ${i} ${"長いタイトルの説明".repeat(9)}`.slice(0, 80);
  const conversations = Array.from({ length: 200 }, (_, i) => ({ id: `0f6d2c5e-8a1b-4c3d-9e7f-${String(i).padStart(12, "0")}`, agentRefId: "claude", title: long(i), preview: long(i + 1_000), updatedAt: stamp(1_000 - i), home: "account", accountId: "acc-1" }));
  api.on("GET", "/api/registry", { status: 200, body: chatRegistry }).on("GET", "/api/agents/conversations", { status: 200, body: { conversations } });
  const projected = (c: (typeof conversations)[number]) => ({ id: c.id, agent: "claude", title: c.title, preview: c.preview, updatedAt: c.updatedAt, home: "account", accountId: "acc-1", resumable: true });
  assert.ok(resultBytes({ conversations: conversations.map(projected) }) > 100_000, "the unbounded list is far past the cap");
  const r = await tool("list_conversations").run({ project: "acme/api", limit: 200 }, ctx(api));
  const rows = r.conversations as ReturnType<typeof projected>[];
  assert.ok(resultBytes(r) <= 60_000, `${resultBytes(r)} bytes`);
  assert.deepEqual(ok(r).structuredContent, r);
  assert.ok(rows.length > 50 && rows.length < 200, `${rows.length} rows`);
  assert.deepEqual(r, { conversations: conversations.slice(0, rows.length).map(projected), truncated: true, omitted: 200 - rows.length }, "the newest rows, in order");
  // Tight: the next-oldest row would not have fitted.
  // A list that fits is returned as before, unflagged.
  assert.deepEqual(await tool("list_conversations").run({ project: "acme/api", limit: 20 }, ctx(api)), { conversations: conversations.slice(0, 20).map(projected) });
});

test("list_conversations: a row is resumable only through an ENABLED chat agent, as the GUI's resume lists require (create_session refuses a disabled one)", async (t) => {
  const api = await projectApi(t);
  api.on("GET", "/api/registry", { status: 200, body: { ...chatRegistry, agents: chatRegistry.agents.map((a) => (a.id === "codex" ? { ...a, enabled: false } : a)) } })
    .on("GET", "/api/agents/conversations", { status: 200, body: { conversations: [
      { id: "s1", agentRefId: "codex", title: "Codex chat", updatedAt: stamp(3), home: "system" },
      { id: "s2", agentRefId: "claude", title: "Mine", updatedAt: stamp(2), home: "system" }
    ] } });
  const r = await tool("list_conversations").run({ project: "acme/api", limit: 20 }, ctx(api));
  assert.deepEqual((r.conversations as { id: string; agent: string; resumable: boolean }[]).map((c) => [c.id, c.agent, c.resumable]), [["s1", "codex", false], ["s2", "claude", true]]);
  // The filter still names the disabled agent's rows: it lists them, it just cannot resume them.
  assert.deepEqual((await tool("list_conversations").run({ project: "acme/api", agent: "codex", limit: 20 }, ctx(api))).conversations, [{ id: "s1", agent: "codex", title: "Codex chat", updatedAt: stamp(3), home: "system", resumable: false }]);
});
