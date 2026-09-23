import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeDaemonApi } from "./testing.ts";
import { stamp } from "./fixtures.ts";
import { EFFORT_OPTION_IDS, findAgent, isProxyAgent, loadAgents, resolveModelSelection, validateAccountId, type AgentView } from "./agents.ts";

const registry = { shells: [], ides: [], fileExplorers: [], browsers: [], agents: [
  { id: "claude", kind: "agent", name: "Claude Code", bin: ["claude"], enabled: true, installState: "idle", version: "2.1.280", chat: { adapter: "claude" } },
  { id: "claudex", kind: "agent", name: "Claude Code × GPT/Kimi/Grok", bin: ["claude"], enabled: true, installState: "idle", chat: { adapter: "claude" } },
  { id: "grok", kind: "agent", name: "Grok Build", bin: ["grok"], enabled: false, installState: "idle", chat: { adapter: "grok" } },
  { id: "deepseek", kind: "agent", name: "DeepSeek", bin: ["deepseek"], enabled: false, installState: "idle" }
] };
const providers = { hostInstanceId: "h1", providers: [
  { id: "claude", refIds: ["claude", "claudex", "claudemix"], installed: true, version: "2.1.280", status: "ready", auth: { status: "authenticated", label: "system" }, checkedAt: stamp(0), slashCommands: [], skills: [],
    capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: true, showPlanModeToggle: true, reportsContextWindow: true, compaction: { type: "slash-command", command: "/compact" }, supportsBackgroundTasks: true },
    models: [
      { slug: "default", name: "Default · Opus", isDefault: true, capabilities: { optionDescriptors: [{ id: "effort", label: "Effort", type: "select", options: [{ id: "medium", label: "Medium", isDefault: true }, { id: "high", label: "High" }] }, { id: "thinking", label: "Thinking", type: "boolean" }] } },
      { slug: "haiku", name: "Haiku", capabilities: { optionDescriptors: [] } },
      { slug: "old", name: "Old", isLegacy: true, capabilities: null }
    ] },
  { id: "grok", refIds: ["grok"], installed: false, version: null, status: "unknown", auth: { status: "unknown" }, checkedAt: stamp(0), slashCommands: [], skills: [],
    capabilities: { sessionModelSwitch: "in-session", showPlanModeToggle: false, reportsContextWindow: true, compaction: { type: "slash-command", command: "/compact" } },
    models: [{ slug: "grok-4.6", name: "Grok 4.6", isDefault: true, capabilities: { optionDescriptors: [{ id: "reasoningEffort", label: "Reasoning", type: "select", options: [{ id: "high", label: "High", isDefault: true }, { id: "low", label: "Low" }] }] } }] }
] };
const accounts = { accounts: [
  { id: "acc-1", agent: "claude", label: "jasperclaude", email: null, plan: "max", needsReauth: false, createdAt: stamp(0), importedAt: stamp(0) },
  { id: "acc-2", agent: "codex", label: "eduard@x.io", email: "eduard@x.io", plan: null, needsReauth: true, createdAt: stamp(0), importedAt: stamp(0) },
  { id: "acc-3", agent: "codex", label: "unseeded@x.io", email: "unseeded@x.io", plan: null, needsReauth: false, createdAt: stamp(0), importedAt: stamp(0) }
], defaults: { claude: "acc-1", codex: "acc-2", grok: null } };
const cliproxy = { state: "healthy", reasons: [], detail: null, version: null, defaultModel: "gpt-5.6-sol", backgroundModel: "", modelOverrides: {}, providers: [], routerProviders: [], accounts: [{ id: "acc-2", provider: "codex", label: "eduard@x.io" }], activeSessionCount: 0, testedClaudeCliVersion: null, xai: { state: "none", email: null, expiredAt: null, lastQuotaError: null, lastLinkError: null, link: null } };

function api() {
  return new FakeDaemonApi().on("GET", "/api/registry", { status: 200, body: registry }).on("GET", "/api/agent/providers", { status: 200, body: providers })
    .on("GET", "/api/agent-accounts", { status: 200, body: accounts }).on("GET", "/api/cliproxy", { status: 200, body: cliproxy }).on("GET", "/api/cliproxy/models", { status: 200, body: { models: [], asOf: null } });
}

test("loadAgents lists only chat-capable entries with models, options, accounts and defaults", async () => {
  const agents = await loadAgents(api());
  assert.deepEqual(agents.map((a) => a.id), ["claude", "claudex", "grok"]);
  const claude = agents[0];
  assert.equal(claude.adapter, "claude"); assert.equal(claude.enabled, true); assert.equal(claude.version, "2.1.280"); assert.equal(claude.auth.status, "authenticated");
  assert.deepEqual(claude.models.map((m) => m.slug), ["default", "haiku"]);
  assert.equal(claude.models[0].isDefault, true);
  assert.deepEqual(claude.models[0].options[0], { id: "effort", label: "Effort", type: "select", values: [{ id: "medium", label: "Medium", isDefault: true }, { id: "high", label: "High" }] });
  assert.deepEqual(claude.models[0].options[1], { id: "thinking", label: "Thinking", type: "boolean" });
  assert.equal(claude.effortOptionId, "effort");
  assert.deepEqual(claude.supports, { planMode: true, rollback: true, compaction: true, backgroundTasks: true, contextWindow: true });
  assert.deepEqual(claude.accounts, [{ id: "system", label: "System", email: null, plan: null, needsReauth: false, isDefault: false }, { id: "acc-1", label: "jasperclaude", email: null, plan: "max", needsReauth: false, isDefault: true }]);
  assert.equal(claude.defaultAccountId, "acc-1");
  const grok = agents[2];
  assert.equal(grok.enabled, false); assert.equal(grok.installed, false); assert.equal(grok.effortOptionId, "reasoningEffort"); assert.equal(grok.defaultAccountId, "system");
  assert.deepEqual(grok.accounts, [{ id: "system", label: "System", email: null, plan: null, needsReauth: false, isDefault: true }]);
  assert.equal((await loadAgents(api(), { includeLegacyModels: true }))[0].models.length, 3);
});

test("a proxy launcher lists the proxy catalogue and only SEEDED accounts of its backing family", async () => {
  const claudex = (await loadAgents(api()))[1];
  assert.ok(claudex.models.some((m) => m.slug === "gpt-5.6-sol" && m.isDefault));
  assert.deepEqual(claudex.accounts.map((a) => a.id), ["system", "acc-2"]);
  assert.equal(claudex.defaultAccountId, "acc-2");
  assert.equal(isProxyAgent("claudex"), true); assert.equal(isProxyAgent("claude"), false);
});

test("findAgent names the valid ids on a miss", async () => {
  const agents = await loadAgents(api());
  assert.equal(findAgent(agents, "grok").id, "grok");
  assert.throws(() => findAgent(agents, "gemini"), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && /claude, claudex, grok/.test(e.message));
});

test("resolveModelSelection: defaults, validation, effort alias, merge with current, drop foreign options", async () => {
  const claude = (await loadAgents(api()))[0];
  assert.deepEqual(resolveModelSelection(claude, {}), { model: "default", options: [] });
  assert.deepEqual(resolveModelSelection(claude, { model: "default", options: { effort: "high", thinking: true } }), { model: "default", options: [{ id: "effort", value: "high" }, { id: "thinking", value: true }] });
  assert.deepEqual(resolveModelSelection(claude, { model: "default", options: { effort: "High" } }).options, [{ id: "effort", value: "high" }]);
  assert.throws(() => resolveModelSelection(claude, { model: "sonnet-9" }), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && /default, haiku/.test(e.message));
  assert.throws(() => resolveModelSelection(claude, { model: "default", options: { effort: "ultra" } }), (e: { message: string }) => /medium, high/.test(e.message));
  assert.throws(() => resolveModelSelection(claude, { model: "default", options: { thinking: "yes" } }), (e: { message: string }) => /boolean/.test(e.message));
  assert.throws(() => resolveModelSelection(claude, { model: "default", options: { turbo: true } }), (e: { message: string }) => /effort, thinking/.test(e.message));
  const merged = resolveModelSelection(claude, { options: { effort: "high" }, current: { model: "default", options: [{ id: "thinking", value: true }] } });
  assert.deepEqual(merged, { model: "default", options: [{ id: "thinking", value: true }, { id: "effort", value: "high" }] });
  const switched = resolveModelSelection(claude, { model: "haiku", current: { model: "default", options: [{ id: "effort", value: "high" }] } });
  assert.deepEqual(switched, { model: "haiku", options: [] });
  const grok = (await loadAgents(api()))[2];
  assert.deepEqual(resolveModelSelection(grok, { options: { effort: "low" } }), { model: "grok-4.6", options: [{ id: "reasoningEffort", value: "low" }] });
  assert.equal(EFFORT_OPTION_IDS.opencode, "variant");
});

test("a model without descriptors passes options through; an empty catalogue refuses", async () => {
  const claude = (await loadAgents(api()))[0];
  assert.deepEqual(resolveModelSelection(claude, { model: "haiku", options: { effort: "max" } }).options, [{ id: "effort", value: "max" }]);
  const empty: AgentView = { ...claude, models: [] };
  assert.throws(() => resolveModelSelection(empty, {}), (e: { message: string }) => /Still loading/.test(e.message));
});

test("validateAccountId accepts system and family accounts, refuses the rest with the valid list", async () => {
  const agents = await loadAgents(api());
  assert.equal(validateAccountId(agents[0], undefined), undefined);
  assert.equal(validateAccountId(agents[0], "system"), "system");
  assert.equal(validateAccountId(agents[0], "acc-1"), "acc-1");
  assert.throws(() => validateAccountId(agents[0], "acc-2"), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && /acc-1/.test(e.message));
  assert.throws(() => validateAccountId(agents[1], "acc-3"), (e: { message: string }) => /seeded/.test(e.message));
});

test("supports.rollback is offered only on an explicit true: an absent flag reads false", async () => {
  const caps = { sessionModelSwitch: "in-session", showPlanModeToggle: true, reportsContextWindow: true, compaction: { type: "native" } };
  const withCaps = (capabilities: Record<string, unknown>) => api().on("GET", "/api/agent/providers", { status: 200, body: { hostInstanceId: "h1", providers: [{ ...providers.providers[0], capabilities }] } });
  assert.equal((await loadAgents(withCaps(caps)))[0].supports.rollback, false);
  assert.equal((await loadAgents(withCaps({ ...caps, supportsConversationRollback: true })))[0].supports.rollback, true);
});

test("an empty model never wins: an empty current or input model resolves like an omitted one, and its options are validated", async () => {
  const claude = (await loadAgents(api()))[0];
  assert.deepEqual(resolveModelSelection(claude, { options: { effort: "high" }, current: { model: "", options: [] } }), { model: "default", options: [{ id: "effort", value: "high" }] });
  assert.throws(() => resolveModelSelection(claude, { options: { effort: "ultra" }, current: { model: "", options: [] } }), (e: { message: string }) => /medium, high/.test(e.message));
  assert.deepEqual(resolveModelSelection(claude, { model: "" }), resolveModelSelection(claude, {}));
  assert.deepEqual(resolveModelSelection(claude, { model: "", current: { model: "haiku" } }), { model: "haiku", options: [] });
});

test("a model switch carries an option only when the new model advertises it and accepts the carried value", async () => {
  const claude = (await loadAgents(api()))[0];
  const effort = (ids: string[]) => ({ id: "effort", label: "Effort", type: "select" as const, values: ids.map((id) => ({ id, label: id })) });
  const agent: AgentView = { ...claude, models: [
    { slug: "opus", name: "Opus", isDefault: true, options: [effort(["low", "medium", "high", "max"])] },
    { slug: "sonnet", name: "Sonnet", isDefault: false, options: [effort(["low", "medium", "high"]), { id: "thinking", label: "Thinking", type: "boolean" }] }
  ] };
  assert.deepEqual(resolveModelSelection(agent, { model: "sonnet", current: { model: "opus", options: [{ id: "effort", value: "max" }, { id: "thinking", value: true }] } }), { model: "sonnet", options: [{ id: "thinking", value: true }] });
  assert.deepEqual(resolveModelSelection(agent, { model: "sonnet", current: { model: "opus", options: [{ id: "effort", value: "high" }, { id: "thinking", value: "on" }] } }), { model: "sonnet", options: [{ id: "effort", value: "high" }] });
});
