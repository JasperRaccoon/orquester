import { test,type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,mkdir,realpath,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeDaemonApi } from "../testing.ts";
import { chatSummary,head,shellSummary,snapshot,stamp } from "../fixtures.ts";
import { ok } from "../result.ts";
import type { AnyOrquesterTool, CallContext, ThreadCaller } from "../catalog/contract.ts";
import { FakeApprovalPort } from "../catalog/approval-double.ts";
import { executeToolCall } from "../executor.ts";
import { catalogFamily } from "./catalog.ts";

const resultBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

/** A catalog tool whose `run` answers a record (every tool of this family does). */
const tool = (name: string) => {
  const def: AnyOrquesterTool = catalogFamily.find((t) => t.name === name)!;
  return { input: def.input, run: async (args: Record<string, unknown>, c: CallContext) => (await def.run(args, c)) as Record<string, any> };
};
const ctx = (api: FakeDaemonApi, caller: CallContext["caller"] = { kind: "external" }): CallContext => ({
  api, signal: new AbortController().signal, now: () => Date.parse("2026-09-22T12:00:00.000Z"), caller,
  turn: { interactionMode: "default", provenance: (_origin, text) => text }
});
const thread = (over: Partial<ThreadCaller> = {}): ThreadCaller => ({
  kind: "thread", threadId: "c1", title: "Claude Code", projectPath: "/w/acme/api", workspace: "acme", cwd: "/w/acme/api", agentId: "claude", callId: "call-1",
  runtimeMode: "auto", planning: false, workflowOwned: false, exchange: null, ...over
});

test("list_projects flattens workspaces, hides archived by default, marks recency and open sessions, recent first", async () => {
  const api = new FakeDaemonApi()
    .on("GET", "/api/workspaces", { status: 200, body: [{ name: "acme", path: "/w/acme", projectCount: 2 }, { name: "old", path: "/w/old", projectCount: 1, isArchived: true }] })
    .on("GET", "/api/workspaces/acme/projects", { status: 200, body: [{ name: "api", workspace: "acme", path: "/w/acme/api" }, { name: "web", workspace: "acme", path: "/w/acme/web", isArchived: true }] })
    .on("GET", "/api/workspaces/old/projects", { status: 200, body: [{ name: "x", workspace: "old", path: "/w/old/x" }] })
    .on("GET", "/api/projects/recent", { status: 200, body: [{ name: "api", workspace: "acme", path: "/w/acme/api", lastInteractedAt: stamp(5), interactionCount: 3 }] })
    .on("GET", "/api/sessions", { status: 200, body: [chatSummary(), chatSummary({ id: "c2" })] });
  const r = await tool("list_projects").run({ includeArchived: false }, ctx(api));
  assert.deepEqual(r, { projects: [{ workspace: "acme", name: "api", path: "/w/acme/api", isArchived: false, lastInteractedAt: stamp(5), openSessions: 2 }], workspaces: [{ name: "acme", gitAccount: null }] });
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
  assert.deepEqual(r, { projects: [{ workspace: "old", name: "x", path: "/w/old/x", isArchived: true, openSessions: 0 }], workspaces: [{ name: "old", isArchived: true, gitAccount: null }] });
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
  for (const def of catalogFamily) {
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

// ---- Unified MCP Task 9: repoId, git accounts, chat current/sameRepo; the picker view; chat views ----

test("list_projects: repoId per project, each workspace's git account joined from /api/accounts (label, login, provider only), query filter", async () => {
  const account = { id: "acct-1", label: "Work GitHub", provider: "github", login: "jasper", githubLogin: "jasper", host: "github.com", gitName: "J", gitEmail: "j@x.io", publicKey: "ssh-ed25519 AAAA", repoAccess: true, createdAt: stamp(0) };
  const api = new FakeDaemonApi()
    .on("GET", "/api/workspaces", { status: 200, body: [{ name: "acme", path: "/w/acme", projectCount: 2, gitAccountId: "acct-1" }, { name: "solo", path: "/w/solo", projectCount: 1, gitAccountId: "gone" }, { name: "free", path: "/w/free", projectCount: 1 }] })
    .on("GET", "/api/workspaces/acme/projects", { status: 200, body: [{ name: "orquester", workspace: "acme", path: "/w/acme/orquester", repoId: "github.com/acme/orquester" }, { name: "orquester-3", workspace: "acme", path: "/w/acme/orquester-3", repoId: "github.com/acme/orquester" }] })
    .on("GET", "/api/workspaces/solo/projects", { status: 200, body: [{ name: "orq", workspace: "solo", path: "/w/solo/orq", repoId: "github.com/acme/orquester" }] })
    .on("GET", "/api/workspaces/free/projects", { status: 200, body: [{ name: "notes", workspace: "free", path: "/w/free/notes" }] })
    .on("GET", "/api/projects/recent", { status: 200, body: [] })
    .on("GET", "/api/sessions", { status: 200, body: [] })
    .on("GET", "/api/accounts", { status: 200, body: [account] });
  const r = await tool("list_projects").run({ includeArchived: false }, ctx(api));
  assert.ok(!JSON.stringify(r).includes("ssh-ed25519") && !JSON.stringify(r).includes("j@x.io"), "no key, no git email");
  assert.deepEqual(r.workspaces, [
    { name: "acme", gitAccount: { label: "Work GitHub", login: "jasper", provider: "github" } },
    { name: "solo", gitAccount: null },
    { name: "free", gitAccount: null }
  ]);
  const byName = new Map((r.projects as { workspace: string; name: string; repoId?: string; current?: true; sameRepo?: true }[]).map((p) => [`${p.workspace}/${p.name}`, p]));
  assert.equal(byName.get("acme/orquester")!.repoId, "github.com/acme/orquester");
  assert.equal(byName.get("free/notes")!.repoId, undefined);
  for (const p of byName.values()) assert.equal(p.current ?? p.sameRepo, undefined, "external callers get no current/sameRepo");
  const filtered = await tool("list_projects").run({ query: "ORQ", includeArchived: false }, ctx(api));
  assert.deepEqual((filtered.projects as { name: string }[]).map((p) => p.name).sort(), ["orq", "orquester", "orquester-3"]);
  assert.deepEqual((filtered.workspaces as { name: string }[]).map((w) => w.name), ["acme", "solo"], "only workspaces with a listed project");
  // A daemon row that already carries gitAccount is taken as it is (never a key from anywhere).
  api.on("GET", "/api/workspaces", { status: 200, body: [{ name: "free", path: "/w/free", projectCount: 1, gitAccount: { label: "Bitbucket", login: "jb", provider: "bitbucket-cloud" } }] });
  assert.deepEqual((await tool("list_projects").run({ includeArchived: false }, ctx(api))).workspaces, [{ name: "free", gitAccount: { label: "Bitbucket", login: "jb", provider: "bitbucket-cloud" } }]);
});

test("list_projects for a chat: `current` marks its project and `sameRepo` every other clone of its repository, in any workspace", async () => {
  const api = new FakeDaemonApi()
    .on("GET", "/api/workspaces", { status: 200, body: [{ name: "acme", path: "/w/acme", projectCount: 3 }, { name: "solo", path: "/w/solo", projectCount: 1 }] })
    .on("GET", "/api/workspaces/acme/projects", { status: 200, body: [
      { name: "orquester", workspace: "acme", path: "/w/acme/orquester", repoId: "r1" },
      { name: "orquester-3", workspace: "acme", path: "/w/acme/orquester-3", repoId: "r1", isArchived: true },
      { name: "site", workspace: "acme", path: "/w/acme/site", repoId: "r2" }
    ] })
    .on("GET", "/api/workspaces/solo/projects", { status: 200, body: [{ name: "fork", workspace: "solo", path: "/w/solo/fork", repoId: "r1" }] })
    .on("GET", "/api/projects/recent", { status: 200, body: [] })
    .on("GET", "/api/sessions", { status: 200, body: [] });
  // The caller's canonical path may be spelt differently from the listing's: matched by workspace/name.
  // Full access: every workspace is listed (below it, other workspaces are only counted — the S13 ruling test below).
  const caller = thread({ projectPath: "/real/w/acme/orquester", workspace: "acme", runtimeMode: "full-access" });
  const rows = (await tool("list_projects").run({ includeArchived: true }, ctx(api, caller))).projects as { name: string; current?: true; sameRepo?: true }[];
  assert.deepEqual(rows.map((p) => [p.name, p.current === true, p.sameRepo === true]), [["orquester", true, false], ["orquester-3", false, true], ["site", false, false], ["fork", false, true]]);
  // An archived own project still names the repository its listed siblings share.
  const hidden = await tool("list_projects").run({ includeArchived: false }, ctx(api, thread({ projectPath: "/w/acme/orquester-3", runtimeMode: "full-access" })));
  // The repository is the own project's whatever the filter lists: naming another workspace still marks its clones.
  const filtered = await tool("list_projects").run({ workspace: "solo", includeArchived: false }, ctx(api, thread({ projectPath: "/w/acme/orquester", runtimeMode: "full-access" })));
  assert.deepEqual((filtered.projects as { name: string; sameRepo?: true }[]).map((p) => [p.name, p.sameRepo]), [["fork", true]]);
  assert.deepEqual((hidden.projects as { name: string; sameRepo?: true }[]).filter((p) => p.sameRepo).map((p) => p.name), ["orquester", "fork"]);
  // A chat with no project: nothing is current, nothing sameRepo.
  const none = await tool("list_projects").run({ includeArchived: true }, ctx(api, thread({ projectPath: "", workspace: "", runtimeMode: "full-access" })));
  assert.ok((none.projects as { current?: true; sameRepo?: true }[]).every((p) => p.current === undefined && p.sameRepo === undefined));
});

/** A catalogue with a legacy default-flagged model, a sub-provider, a chip label and option defaults. */
function pickerApi(): FakeDaemonApi {
  const effort = { id: "effort", label: "Effort", type: "select", options: [{ id: "low", label: "Low" }, { id: "high", label: "High", isDefault: true }] };
  const fast = { id: "fastMode", label: "Fast", type: "boolean", currentValue: false };
  const codexModels = [
    { slug: "gpt-5.5", name: "GPT-5.5", isDefault: true, isLegacy: true, capabilities: { optionDescriptors: [effort] } },
    { slug: "gpt-6-sol", name: "GPT-6 Sol", shortName: "Sol", capabilities: { optionDescriptors: [effort, fast] } },
    { slug: "openai/gpt-6-luna", name: "GPT-6 Luna", subProvider: "OpenRouter", capabilities: { optionDescriptors: [] } }
  ];
  const row = (id: string, models: unknown[], auth: object) => ({ id, refIds: [id], installed: true, version: "1.0.0", status: "ready", auth, checkedAt: stamp(0), slashCommands: [], skills: [], capabilities: { sessionModelSwitch: "in-session", showPlanModeToggle: true }, models });
  return new FakeDaemonApi()
    .on("GET", "/api/registry", { status: 200, body: { shells: [], ides: [], fileExplorers: [], browsers: [], agents: [chatAgent("claude", "Claude Code", "claude"), chatAgent("codex", "Codex", "codex")] } })
    .on("GET", "/api/agent/providers", { status: 200, body: { hostInstanceId: "h", providers: [row("claude", [], { status: "authenticated", email: "me@x.io" }), row("codex", codexModels, { status: "authenticated", email: "me@x.io" })] } })
    .on("GET", "/api/agent-accounts", { status: 200, body: { accounts: [{ id: "acc-9", agent: "codex", label: "Work", email: "work@x.io", plan: "pro", needsReauth: false, createdAt: stamp(0), importedAt: stamp(0) }], defaults: { claude: null, codex: "acc-9", grok: null } } })
    .on("GET", "/api/sessions", { status: 200, body: [chatSummary({ id: "c1", refId: "codex", accountId: "acc-9" })] })
    .on("GET", "/api/sessions/c1/thread", { status: 200, body: { kind: "snapshot", thread: snapshot({ head: head({ modelSelection: { model: "gpt-6-sol", options: [{ id: "effort", value: "low" }] } }) }) } });
}

test("list_agents is the composer picker's view: the launch default (never a legacy model), chip labels, hints, option defaults; legacy only on request", async () => {
  const codex = (r: Record<string, any>) => (r.agents as ListedAgent[]).find((a) => a.id === "codex")! as ListedAgent & { defaultModel: string | null; catalogueLoading: boolean };
  const listed = await tool("list_agents").run({}, ctx(pickerApi()));
  const view = codex(listed);
  assert.equal(view.defaultModel, "gpt-6-sol", "the default flag sits on a legacy model: the launch default is the first non-legacy one");
  assert.deepEqual(view.models.map((m) => [m.slug, m.isDefault]), [["gpt-6-sol", true], ["openai/gpt-6-luna", false]]);
  const sol = view.models[0] as unknown as { shortName: string; options: { id: string; default?: unknown }[] };
  assert.equal(sol.shortName, "Sol");
  assert.deepEqual(sol.options.map((o) => [o.id, o.default]), [["effort", "high"], ["fastMode", false]]);
  assert.equal((view.models[1] as unknown as { hint: string }).hint, "OpenRouter");
  assert.equal(view.catalogueLoading, false);
  assert.equal((listed.agents as (ListedAgent & { catalogueLoading: boolean })[]).find((a) => a.id === "claude")!.catalogueLoading, true, "a ready provider with no models is still loading");
  assert.deepEqual((listed.permissionModes as { id: string; label: string }[]).map((m) => m.label), ["Supervised", "Accept edits", "Auto", "Full access"]);
  // Legacy: listed only with includeLegacy (or the old includeLegacyModels), always marked; found when named.
  for (const flag of [{ includeLegacy: true }, { includeLegacyModels: true }]) {
    const all = codex(await tool("list_agents").run(flag, ctx(pickerApi())));
    assert.deepEqual(all.models.map((m) => [m.slug, m.isLegacy === true, m.isDefault]), [["gpt-5.5", true, false], ["gpt-6-sol", false, true], ["openai/gpt-6-luna", false, false]]);
  }
  const named = codex(await tool("list_agents").run({ agent: "codex", model: "gpt-5.5" }, ctx(pickerApi())));
  assert.deepEqual(named.models.map((m) => [m.slug, m.isLegacy]), [["gpt-5.5", true]]);
  // query: slug, name, chip label or sub-provider.
  for (const [query, slugs] of [["sol", ["gpt-6-sol"]], ["openrouter", ["openai/gpt-6-luna"]], ["GPT-6", ["gpt-6-sol", "openai/gpt-6-luna"]]] as const) {
    const r = await tool("list_agents").run({ query }, ctx(pickerApi()));
    assert.deepEqual((r.agents as ListedAgent[]).map((a) => [a.id, a.models.map((m) => m.slug)]), [["codex", slugs]], query);
  }
});

test("list_agents for a chat: thisThread, allowedRuntimeModes, and no email anywhere (accounts as id, label, plan, needsReauth, isDefault)", async () => {
  const api = pickerApi();
  const r = await tool("list_agents").run({}, ctx(api, thread({ runtimeMode: "auto-accept-edits", agentId: "codex" })));
  assert.deepEqual(r.thisThread, { agent: "codex", model: "gpt-6-sol", options: { effort: "low" }, runtimeMode: "auto-accept-edits", accountId: "acc-9" });
  assert.deepEqual(r.allowedRuntimeModes, ["approval-required", "auto-accept-edits"]);
  const codex = (r.agents as Record<string, any>[]).find((a) => a.id === "codex")!;
  assert.ok(!JSON.stringify(r).includes("@x.io"), "no email in the chat view");
  assert.deepEqual(codex.accounts, [{ id: "system", label: "System", plan: null, needsReauth: false, isDefault: false }, { id: "acc-9", label: "Work", plan: "pro", needsReauth: false, isDefault: true }]);
  assert.equal(codex.runtimeModes, undefined);
  assert.equal(codex.defaultRuntimeMode, undefined);
  // The external view keeps them, as it always did.
  const external = await tool("list_agents").run({}, ctx(api));
  assert.ok(JSON.stringify(external).includes("work@x.io"));
  assert.equal(external.thisThread, undefined);
});

test("list_conversations: a chat's project defaults to its own; an external caller must name one", async (t) => {
  const api = await projectApi(t);
  api.on("GET", "/api/registry", { status: 200, body: chatRegistry })
    .on("GET", "/api/agents/conversations", ({ query }) => ({ status: 200, body: { conversations: query?.path === join(api.workspacesDir, "acme", "api") ? [{ id: "s1", agentRefId: "claude", title: "A", updatedAt: stamp(1) }] : [] } }));
  const caller = thread({ projectPath: join(api.workspacesDir, "acme", "api"), workspace: "acme" });
  assert.deepEqual((await tool("list_conversations").run({ limit: 20 }, ctx(api, caller))).conversations, [{ id: "s1", agent: "claude", title: "A", updatedAt: stamp(1), home: "system", resumable: true }]);
  await assert.rejects(tool("list_conversations").run({ limit: 20 }, ctx(api)), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
  await assert.rejects(tool("list_conversations").run({ limit: 20 }, ctx(api, thread({ projectPath: "", workspace: "" }))), (e: { code: string }) => e.code === "PROJECT_NOT_FOUND");
});

test("list_projects below Full access (ruling S13): its own workspace whole, the others only counted; naming another workspace raises the cross-workspace metadata card", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mcp-cat-s13-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ["acme/api", "acme/web", "beta/app", "beta/old", "gamma/x"]) await mkdir(join(root, dir), { recursive: true });
  const api = new FakeDaemonApi(); api.fsRoot = root; api.workspacesDir = root;
  const project = (ws: string, name: string, over: object = {}) => ({ name, workspace: ws, path: join(root, ws, name), ...over });
  api.on("GET", "/api/workspaces", { status: 200, body: [
    { name: "acme", path: join(root, "acme"), projectCount: 2 },
    { name: "beta", path: join(root, "beta"), projectCount: 2, archivedProjectCount: 1 },
    { name: "gamma", path: join(root, "gamma"), projectCount: 1, isArchived: true }
  ] })
    .on("GET", "/api/workspaces/acme/projects", { status: 200, body: [project("acme", "api"), project("acme", "web")] })
    .on("GET", "/api/workspaces/beta/projects", { status: 200, body: [project("beta", "app"), project("beta", "old", { isArchived: true })] })
    .on("GET", "/api/workspaces/gamma/projects", { status: 200, body: [project("gamma", "x")] })
    .on("GET", "/api/projects/recent", { status: 200, body: [] })
    .on("GET", "/api/sessions", { status: 200, body: [] });
  const me = thread({ projectPath: join(root, "acme", "api"), workspace: "acme", cwd: join(root, "acme", "api"), runtimeMode: "auto" });
  const listed = await tool("list_projects").run({ includeArchived: false }, ctx(api, me));
  assert.deepEqual((listed.projects as { workspace: string; name: string }[]).map((p) => `${p.workspace}/${p.name}`), ["acme/api", "acme/web"]);
  assert.deepEqual(listed.excludedWorkspaces, [{ workspace: "beta", projectCount: 1 }]);
  assert.ok(!api.calls.some((c) => c.path === "/api/workspaces/beta/projects"), "an excluded workspace's projects are never read");
  assert.deepEqual((await tool("list_projects").run({ includeArchived: true }, ctx(api, me))).excludedWorkspaces, [{ workspace: "beta", projectCount: 2 }, { workspace: "gamma", projectCount: 1 }]);
  // A chat with no project has no own workspace: everything is counted, nothing listed.
  const loose = await tool("list_projects").run({ includeArchived: false }, ctx(api, thread({ projectPath: "", workspace: "", runtimeMode: "auto" })));
  assert.deepEqual([loose.projects, (loose.excludedWorkspaces as { workspace: string }[]).map((w) => w.workspace)], [[], ["acme", "beta"]]);
  // Full access and external callers list everything.
  for (const who of [thread({ ...me, runtimeMode: "full-access" }), { kind: "external" } as const]) {
    const all = await tool("list_projects").run({ includeArchived: false }, ctx(api, who));
    assert.deepEqual((all.projects as { workspace: string; name: string }[]).map((p) => `${p.workspace}/${p.name}`), ["acme/api", "acme/web", "beta/app"]);
    assert.equal(all.excludedWorkspaces, undefined);
  }

  // Naming another workspace: its projects are the call's targets, so the gate cards it (approved → listed); own: no card.
  const port = new FakeApprovalPort({ outcome: "approved", approvalId: "a1" });
  const call = (args: Record<string, unknown>, caller: ThreadCaller = me) =>
    executeToolCall({ approvals: port }, { name: "list_projects", arguments: args }, { caller, api, signal: new AbortController().signal });
  const named = await call({ workspace: "beta" });
  assert.equal(named.isError, undefined, JSON.stringify(named.content));
  assert.equal(port.cards.length, 1);
  assert.equal(port.cards[0]!.kind, "boundary");
  assert.deepEqual(port.cards[0]!.scope.projects?.map((p) => p.workspace), ["acme", "beta"]);
  assert.deepEqual(((named.structuredContent as { projects: { name: string }[] }).projects).map((p) => p.name), ["app"]);
  await call({ workspace: "acme" });
  await call({ workspace: "beta" }, thread({ ...me, runtimeMode: "full-access" }));
  await call({});
  assert.equal(port.cards.length, 1, "own workspace, Full access and the unnamed list raise no card");
  port.answerWith({ outcome: "denied", approvalId: "a2", reason: "no" });
  assert.equal((((await call({ workspace: "beta" })).structuredContent) as { code: string }).code, "APPROVAL_DENIED");
});
