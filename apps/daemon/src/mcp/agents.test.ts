import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeDaemonApi } from "./testing.ts";
import { stamp } from "./fixtures.ts";
import { findAgent,loadAgents,resolveModelSelection,validateAccountId,type AgentView } from "./agents.ts";

const registry = { shells: [], ides: [], fileExplorers: [], browsers: [], agents: [
  { id: "claude", kind: "agent", name: "Claude Code", bin: ["claude"], enabled: true, installState: "idle", version: "2.1.280", chat: { adapter: "claude" } },
  { id: "codex", kind: "agent", name: "Codex", bin: ["codex"], enabled: true, installState: "idle", chat: { adapter: "codex" } },
  { id: "grok", kind: "agent", name: "Grok Build", bin: ["grok"], enabled: false, installState: "idle", chat: { adapter: "grok" } },
  { id: "deepseek", kind: "agent", name: "DeepSeek", bin: ["deepseek"], enabled: false, installState: "idle" }
] };
const providers = { hostInstanceId: "h1", providers: [
  { id: "claude", refIds: ["claude"], installed: true, version: "2.1.280", status: "ready", auth: { status: "authenticated", label: "system" }, checkedAt: stamp(0), slashCommands: [], skills: [],
    capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: true, showPlanModeToggle: true, reportsContextWindow: true, compaction: { type: "slash-command", command: "/compact" }, supportsBackgroundTasks: true, supportsTaskStop: true },
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
  { id: "acc-3", agent: "codex", label: "other@x.io", email: "other@x.io", plan: null, needsReauth: false, createdAt: stamp(0), importedAt: stamp(0) }
], defaults: { claude: "acc-1", codex: "acc-2", grok: null } };

function api() {
  return new FakeDaemonApi().on("GET", "/api/registry", { status: 200, body: registry }).on("GET", "/api/agent/providers", { status: 200, body: providers })
    .on("GET", "/api/agent-accounts", { status: 200, body: accounts });
}

test("loadAgents lists only chat-capable entries with models, options, accounts and defaults", async () => {
  const agents = await loadAgents(api());
  assert.deepEqual(agents.map((a) => a.id), ["claude", "codex", "grok"]);
  const claude = agents[0];
  assert.equal(claude.adapter, "claude"); assert.equal(claude.enabled, true); assert.equal(claude.version, "2.1.280"); assert.equal(claude.auth.status, "authenticated");
  assert.deepEqual(claude.models.map((m) => m.slug), ["default", "haiku"]);
  assert.equal(claude.models[0].isDefault, true);
  assert.deepEqual(claude.models[0].options[0], { id: "effort", label: "Effort", type: "select", values: [{ id: "medium", label: "Medium", isDefault: true }, { id: "high", label: "High" }] });
  assert.deepEqual(claude.models[0].options[1], { id: "thinking", label: "Thinking", type: "boolean" });
  assert.equal(claude.effortOptionId, "effort");
  assert.deepEqual(claude.supports, { planMode: true, rollback: true, compaction: true, backgroundTasks: true, taskStop: true, goals: null, contextWindow: true });
  assert.deepEqual(claude.accounts, [{ id: "system", label: "System", email: null, plan: null, needsReauth: false, isDefault: false }, { id: "acc-1", label: "jasperclaude", email: null, plan: "max", needsReauth: false, isDefault: true }]);
  assert.equal(claude.defaultAccountId, "acc-1");
  const grok = agents[2];
  assert.equal(grok.enabled, false); assert.equal(grok.installed, false); assert.equal(grok.effortOptionId, "reasoningEffort"); assert.equal(grok.defaultAccountId, "system");
  assert.deepEqual(grok.accounts, [{ id: "system", label: "System", email: null, plan: null, needsReauth: false, isDefault: true }]);
  assert.equal((await loadAgents(api(), { includeLegacyModels: true }))[0].models.length, 3);
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
});

test("a model without option descriptors takes no options, as the GUI shows it no chips: any is refused; an empty catalogue refuses", async () => {
  const [claude] = await loadAgents(api());
  const noOptions = (model: string) => (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && e.message === `${model} takes no options.`;
  assert.throws(() => resolveModelSelection(claude, { model: "haiku", options: { effort: "max" } }), noOptions("haiku"));
  assert.throws(() => resolveModelSelection(claude, { model: "haiku", options: { thinking: true } }), noOptions("haiku"), "not even an option the agent's other models take");
  // update_session's options-only change on such a model: the head's model, and still nothing to set.
  assert.throws(() => resolveModelSelection(claude, { options: { effort: "high" }, current: { model: "haiku", options: [] } }), noOptions("haiku"));
  // No options at all is fine, and an empty object is none.
  assert.deepEqual(resolveModelSelection(claude, { model: "haiku" }), { model: "haiku", options: [] });
  assert.deepEqual(resolveModelSelection(claude, { model: "haiku", options: {} }), { model: "haiku", options: [] });
  const empty: AgentView = { ...claude, models: [] };
  assert.throws(() => resolveModelSelection(empty, {}), (e: { message: string }) => /Still loading/.test(e.message));
});

test("validateAccountId accepts system and family accounts, refuses the rest with the valid list", async () => {
  const agents = await loadAgents(api());
  assert.equal(validateAccountId(agents[0], undefined), undefined);
  assert.equal(validateAccountId(agents[0], "system"), "system");
  assert.equal(validateAccountId(agents[0], "acc-1"), "acc-1");
  assert.throws(() => validateAccountId(agents[0], "acc-2"), (e: { code: string; message: string }) => e.code === "INVALID_ARGUMENT" && /acc-1/.test(e.message));
  assert.equal(validateAccountId(agents[1], "acc-3"), "acc-3", "every account of the family, none held back");
  assert.throws(() => validateAccountId(agents[1], "acc-1"), (e: { code: string }) => e.code === "INVALID_ARGUMENT");
});

test("supports.goals projects the provider's goal capability into the MCP catalogue", async () => {
  const codexGoals = { command: "host", actions: ["pause", "resume", "clear"], continuesAcrossTurns: true };
  const codexCaps = { sessionModelSwitch: "in-session", supportsConversationRollback: true, showPlanModeToggle: true, reportsContextWindow: true, compaction: { type: "native" }, promptlessTurnContinuation: true };
  const codex = { id: "codex", refIds: ["codex"], installed: true, version: "0.130.0", status: "ready", auth: { status: "authenticated" }, checkedAt: stamp(0), slashCommands: [], skills: [], models: [], capabilities: { ...codexCaps, goals: codexGoals } };
  const daemon = api().on("GET", "/api/agent/providers", { status: 200, body: { ...providers, providers: [...providers.providers, codex] } });
  assert.deepEqual(findAgent(await loadAgents(daemon), "codex").supports, { planMode: true, rollback: true, compaction: true, backgroundTasks: false, taskStop: false, goals: codexGoals, contextWindow: true });
});

test("an empty model never wins: an empty current or input model resolves like an omitted one, and its options are validated", async () => {
  const claude = (await loadAgents(api()))[0];
  assert.deepEqual(resolveModelSelection(claude, { options: { effort: "high" }, current: { model: "", options: [] } }), { model: "default", options: [{ id: "effort", value: "high" }] });
  assert.throws(() => resolveModelSelection(claude, { options: { effort: "ultra" }, current: { model: "", options: [] } }), (e: { message: string }) => /medium, high/.test(e.message));
  assert.deepEqual(resolveModelSelection(claude, { model: "" }), { model: "default", options: [] });
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

test("a degraded provider row (an older host's) is normalised field by field, never thrown on", async () => {
  const degraded = api().on("GET", "/api/agent/providers", { status: 200, body: { hostInstanceId: "h0", providers: [
    null,
    "junk",
    // No models, no auth, no capabilities at all.
    { id: "claude", refIds: ["claude"], installed: true, version: "2.0.0", status: "ready" },
    { id: "grok", refIds: ["grok"], installed: "yes", version: 7, status: 3, auth: { status: 42, label: 9 }, message: { x: 1 },
      capabilities: { showPlanModeToggle: "yes", supportsConversationRollback: 1, compaction: null, reportsContextWindow: "true", supportsBackgroundTasks: {} }, models: [
      null,
      { name: "no slug" },
      { slug: "grok-4.6", name: "Grok 4.6", isDefault: true, capabilities: { optionDescriptors: [
        { id: "reasoningEffort", label: "Reasoning", type: "select" }, // a select with no choices: nothing to pick, left out
        { id: "fast", label: "Fast", type: "boolean" },
        { id: "tier", label: "Tier", type: "select", options: [{ id: "flex", label: "Flex" }, null, { label: "no id" }] },
        "junk"
      ] } },
      { slug: "grok-mini", name: "Grok mini", capabilities: { optionDescriptors: "not a list" } }
    ] }
  ] } });
  const agents = await loadAgents(degraded);
  const claude = findAgent(agents, "claude");
  assert.deepEqual([claude.models, claude.auth, claude.installed, claude.status], [[], { status: "unknown" }, true, "ready"]);
  assert.deepEqual(claude.supports, { planMode: false, rollback: false, compaction: false, backgroundTasks: false, taskStop: false, goals: null, contextWindow: false });
  const grok = findAgent(agents, "grok");
  assert.deepEqual([grok.auth, grok.installed, grok.status, grok.message, grok.version], [{ status: "unknown" }, false, "unknown", undefined, null]);
  assert.deepEqual(grok.supports, { planMode: false, rollback: false, compaction: false, backgroundTasks: false, taskStop: false, goals: null, contextWindow: false }, "a flag counts only when it is really true");
  assert.deepEqual(grok.models.map((m) => [m.slug, m.options]), [
    ["grok-4.6", [{ id: "fast", label: "Fast", type: "boolean" }, { id: "tier", label: "Tier", type: "select", values: [{ id: "flex", label: "Flex" }] }]],
    ["grok-mini", []]
  ]);
  // A providers body that is no list at all reads like a failed read: no snapshot.
  for (const body of [{ hostInstanceId: "h0", providers: "x" }, null, "not json"]) {
    const broken = api().on("GET", "/api/agent/providers", { status: 200, body });
    assert.deepEqual(findAgent(await loadAgents(broken), "claude").auth, { status: "unknown" }, JSON.stringify(body));
  }
});
