/**
 * The §4.4 permission-mode table (Claude's column, every row), the §4.3
 * decision mapping (every row), and the model/version gate of §3.2 and §10.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { ModelSelection, ProviderModel, RuntimeMode } from "@orquester/api/agent-chat";
import { APPROVAL_FEEDBACK_MAX_CHARS } from "@orquester/api/agent-chat";

import { APPROVAL_REDIRECT_MESSAGE } from "../../adapter.ts";

import {
  permissionResultForDecision,
  toSessionPermissionUpdates
} from "./decisions.ts";
import {
  buildClaudeProbeOptions,
  buildClaudeQueryOptions,
  claudeToolSearchOverride
} from "./launch.ts";
import { claudeProfileLaunchFiles, type ClaudeProfileLaunch } from "./profile-launch.ts";
import type { ClaudeSessionToolsLaunch } from "./session-tools.ts";
import {
  compareVersions,
  meetsMinimumClaudeVersion,
  parseClaudeVersion,
  resolveEffortLevel,
  toProviderModels
} from "./models.ts";

it("the default row is named after the model it resolves to", () => {
  const named = toProviderModels([
    { value: "default", resolvedModel: "claude-opus-5[1m]", displayName: "Default (recommended)" },
    { value: "claude-opus-5[1m]", displayName: "Opus (1M context)" },
    { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet" }
  ]);
  assert.equal(named[0]?.slug, "default", "the launch still sends the CLI's own choice");
  assert.ok(named[0]?.name.includes("Opus (1M context)"));
  // No sibling lists the resolved id: the id itself is better than nothing.
  const bare = toProviderModels([
    { value: "default", resolvedModel: "claude-opus-4-8[1m]", displayName: "Default (recommended)" }
  ]);
  assert.ok(bare[0]?.name.includes("claude-opus-4-8[1m]"));
});

const noopCanUseTool: CanUseTool = async () => ({ behavior: "allow", updatedInput: {} });

const MODELS: ProviderModel[] = toProviderModels([
  {
    value: "default",
    resolvedModel: "claude-opus-4-8[1m]",
    displayName: "Default (recommended)",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsFastMode: true,
    supportsAutoMode: true
  },
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5",
    displayName: "Sonnet",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsAutoMode: true
  },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku" }
]);

function build(runtimeMode: RuntimeMode, modelSelection?: ModelSelection) {
  return buildClaudeQueryOptions({
    cwd: "/work/project",
    executablePath: "/usr/local/bin/claude",
    env: { PATH: "/usr/bin", HOME: "/home/orq", CLAUDE_CONFIG_DIR: "/homes/acc/home" },
    runtimeMode,
    ...(modelSelection !== undefined ? { modelSelection } : {}),
    models: MODELS,
    attachmentsDir: "/appdir/threads/t1/attachments",
    canUseTool: noopCanUseTool,
    sessionId: "11111111-2222-3333-4444-555555555555"
  });
}

describe("claude launch — §4.4 permission modes", () => {
  it("approval-required leaves permissionMode undefined so canUseTool is the gate", () => {
    const { options, basePermissionMode } = build("approval-required");
    assert.equal(options.permissionMode, undefined);
    assert.equal(options.allowDangerouslySkipPermissions, undefined);
    assert.equal(basePermissionMode, "default");
    assert.equal(typeof options.canUseTool, "function");
  });

  it("auto-accept-edits maps to acceptEdits", () => {
    const { options, basePermissionMode } = build("auto-accept-edits");
    assert.equal(options.permissionMode, "acceptEdits");
    assert.equal(options.allowDangerouslySkipPermissions, undefined);
    assert.equal(basePermissionMode, "acceptEdits");
  });

  it("auto maps to auto", () => {
    const { options } = build("auto");
    assert.equal(options.permissionMode, "auto");
    assert.equal(options.allowDangerouslySkipPermissions, undefined);
  });

  it("full access maps to bypassPermissions plus the dangerous flag", () => {
    const { options } = build("full-access");
    assert.equal(options.permissionMode, "bypassPermissions");
    assert.equal(options.allowDangerouslySkipPermissions, true);
  });
});

describe("claude launch — the options object (§4.5)", () => {
  it("sets exactly what §4.5 prescribes", () => {
    const { options } = build("approval-required", {
      model: "sonnet",
      options: [{ id: "effort", value: "xhigh" }]
    });
    assert.equal(options.cwd, "/work/project");
    assert.equal(options.model, "sonnet");
    assert.equal(options.pathToClaudeCodeExecutable, "/usr/local/bin/claude");
    assert.equal(typeof options.systemPrompt, "object");
    assert.equal((options.systemPrompt as { preset?: string }).preset, "claude_code");
    assert.deepEqual(options.settingSources, ["user", "project", "local"]);
    assert.equal(options.includePartialMessages, true);
    assert.deepEqual(options.additionalDirectories, [
      "/work/project",
      "/appdir/threads/t1/attachments"
    ]);
    assert.deepEqual(options.mcpServers, {});
    assert.equal(options.effort, "xhigh");
    assert.deepEqual(options.thinking, { type: "adaptive", display: "summarized" });
    assert.equal(options.sessionId, "11111111-2222-3333-4444-555555555555");
    assert.equal(options.resume, undefined);
    // The question card renders option previews as markdown: asked for explicitly.
    assert.deepEqual(options.toolConfig, { askUserQuestion: { previewFormat: "markdown" } });
  });

  it("sends resume OR sessionId, never both", () => {
    const both = buildClaudeQueryOptions({
      cwd: "/work",
      executablePath: "/bin/claude",
      env: {},
      runtimeMode: "approval-required",
      models: MODELS,
      attachmentsDir: "/a",
      canUseTool: noopCanUseTool,
      resume: "b46b654b-57bb-40e4-8c82-d3536bd06a28",
      sessionId: "11111111-2222-3333-4444-555555555555"
    });
    assert.equal(both.options.resume, "b46b654b-57bb-40e4-8c82-d3536bd06a28");
    assert.equal(both.options.sessionId, undefined);
  });

  it("ultracode is xhigh effort PLUS the setting", () => {
    const { options, effort } = build("approval-required", {
      model: "default",
      options: [
        { id: "ultracode", value: true },
        { id: "effort", value: "low" }
      ]
    });
    assert.equal(options.effort, "xhigh");
    assert.equal(effort, "xhigh");
    assert.equal((options.settings as Record<string, unknown>).ultracode, true);

    // Not offered on a model without xhigh support, so it cannot be set there.
    const haiku = MODELS.find((entry) => entry.slug === "haiku")!;
    assert.equal(haiku.capabilities, null);
    const off = build("approval-required", {
      model: "haiku",
      options: [{ id: "ultracode", value: true }]
    });
    assert.equal(off.options.effort, undefined);
    assert.equal((off.options.settings as Record<string, unknown> | undefined)?.ultracode, undefined);
  });

  it("gates a boolean option on the selected model's own capability", () => {
    // Haiku advertises no capability flags at all, so absence means "not
    // supported", not "unknown" (fixtures README observation 15).
    const { options } = build("approval-required", {
      model: "haiku",
      options: [
        { id: "fastMode", value: true },
        { id: "effort", value: "max" }
      ]
    });
    assert.equal(options.effort, undefined);
    const settings = options.settings as Record<string, unknown> | undefined;
    assert.equal(settings?.fastMode, undefined);
  });

  it("carries fastMode and thinking into settings where the model supports them", () => {
    const { options } = build("approval-required", {
      model: "default",
      options: [
        { id: "fastMode", value: true },
        { id: "thinking", value: true }
      ]
    });
    const settings = options.settings as Record<string, unknown>;
    assert.equal(settings.fastMode, true);
    assert.equal(settings.alwaysThinkingEnabled, true);
    assert.equal(settings.showThinkingSummaries, true);
  });

  it("the probe's options never run a hook and never open an MCP server", () => {
    const abort = new AbortController();
    const options = buildClaudeProbeOptions({
      executablePath: "/bin/claude",
      env: { PATH: "/usr/bin" },
      abortController: abort
    });
    assert.equal(options.persistSession, false);
    assert.deepEqual(options.settings, { disableAllHooks: true });
    assert.deepEqual(options.allowedTools, []);
    assert.deepEqual(options.mcpServers, {});
    assert.equal(options.strictMcpConfig, true);
    assert.equal(options.abortController, abort);
    assert.equal(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
    assert.equal(options.env?.CLAUDE_CODE_AUTO_CONNECT_IDE, "0");
    assert.equal(typeof options.stderr, "function");
    // The probe must not install the approval callback: it never runs a tool.
    assert.equal(options.canUseTool, undefined);
  });
});

describe("claude decisions — §4.3, every row of the Claude column", () => {
  const toolInput = { command: "rm -f scratch.txt" };

  it("accept allows with the original input", () => {
    const result = permissionResultForDecision({
      decision: "accept",
      toolName: "Bash",
      toolInput
    });
    assert.deepEqual(result, { behavior: "allow", updatedInput: toolInput });
  });

  it("acceptForSession allows and rescopes every suggestion to the session", () => {
    const result = permissionResultForDecision({
      decision: "acceptForSession",
      toolName: "Bash",
      toolInput,
      suggestions: [
        {
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "rm -f scratch.txt" }],
          behavior: "allow",
          destination: "localSettings"
        },
        { type: "setMode", mode: "acceptEdits", destination: "session" }
      ]
    });
    assert.equal(result.behavior, "allow");
    const updates = (result as { updatedPermissions?: Array<{ destination: string }> })
      .updatedPermissions;
    assert.equal(updates?.length, 2);
    // Echoing `localSettings` verbatim would write a permanent rule into
    // `.claude/settings.local.json`.
    assert.ok(updates?.every((update) => update.destination === "session"));
  });

  it("acceptForSession falls back to a whole-tool session rule", () => {
    // The live path for AskUserQuestion and ExitPlanMode, which arrive with no
    // `suggestions` key at all (fixtures README observation 11).
    assert.deepEqual(toSessionPermissionUpdates("Bash", undefined), [
      { type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow", destination: "session" }
    ]);
    assert.deepEqual(toSessionPermissionUpdates("Bash", []), [
      { type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow", destination: "session" }
    ]);
  });

  it("acceptAlways denies — Claude has no permanent grant through canUseTool", () => {
    const result = permissionResultForDecision({
      decision: "acceptAlways",
      toolName: "Bash",
      toolInput
    });
    assert.equal(result.behavior, "deny");
  });

  it("a decline with the user's words denies with them, trimmed and capped", () => {
    const feedback = permissionResultForDecision({
      decision: "decline",
      toolName: "Bash",
      toolInput,
      redirect: true,
      feedback: "  do it in a branch  "
    });
    assert.deepEqual(feedback, { behavior: "deny", message: "do it in a branch" });
    const long = permissionResultForDecision({
      decision: "decline",
      toolName: "Bash",
      toolInput,
      feedback: "x".repeat(APPROVAL_FEEDBACK_MAX_CHARS + 50)
    });
    assert.equal((long as { message: string }).message.length, APPROVAL_FEEDBACK_MAX_CHARS);
    // Blank words fall back to the redirect's own message.
    const blank = permissionResultForDecision({ decision: "decline", toolName: "Bash", toolInput, redirect: true, feedback: "   " });
    assert.deepEqual(blank, { behavior: "deny", message: APPROVAL_REDIRECT_MESSAGE });
    // Never on an approval.
    assert.equal(
      permissionResultForDecision({ decision: "accept", toolName: "Bash", toolInput, feedback: "words" }).behavior,
      "allow"
    );
  });

  it("decline and cancel are two answers, not two labels", () => {
    const decline = permissionResultForDecision({ decision: "decline", toolName: "Bash", toolInput });
    const cancel = permissionResultForDecision({ decision: "cancel", toolName: "Bash", toolInput });
    assert.equal(decline.behavior, "deny");
    assert.equal(cancel.behavior, "deny");
    assert.notDeepEqual(decline, cancel);
  });
});

describe("claude models and the version gate", () => {
  it("reads the CLI version out of its banner", () => {
    assert.equal(parseClaudeVersion("2.1.210 (Claude Code)"), "2.1.210");
    assert.equal(parseClaudeVersion("claude 2.2.0-beta.1"), "2.2.0-beta.1");
    assert.equal(parseClaudeVersion("no version here"), null);
  });

  it("compares versions numerically, not lexically", () => {
    assert.ok(compareVersions("2.1.210", "2.1.99") > 0);
    assert.ok(compareVersions("2.1.121", "2.1.121") === 0);
    assert.ok(compareVersions("2.0.999", "2.1.0") < 0);
  });

  it("refuses an unreadable version rather than passing it", () => {
    assert.equal(meetsMinimumClaudeVersion(null), false);
    assert.equal(meetsMinimumClaudeVersion("2.0.0"), false);
    assert.equal(meetsMinimumClaudeVersion("2.1.210"), true);
  });

  it("builds effort descriptors from the CLI's own per-model levels", () => {
    const model = MODELS.find((entry) => entry.slug === "default")!;
    const effort = model.capabilities?.optionDescriptors?.find((d) => d.id === "effort");
    assert.ok(effort && effort.type === "select");
    assert.deepEqual(
      effort.options.map((option) => option.id),
      ["low", "medium", "high", "xhigh", "max"]
    );
    // xhigh and max exist, so the descriptor must never be hard-coded to
    // low/medium/high.
    assert.ok(effort.options.some((option) => option.id === "xhigh"));
  });

  it("only offers boolean descriptors the model advertises", () => {
    const sonnet = MODELS.find((entry) => entry.slug === "sonnet")!;
    const ids = sonnet.capabilities?.optionDescriptors?.map((d) => d.id) ?? [];
    assert.ok(ids.includes("thinking"));
    assert.ok(!ids.includes("fastMode"));
    const haiku = MODELS.find((entry) => entry.slug === "haiku")!;
    assert.equal(haiku.capabilities, null);
  });

  it("drops an effort level the selected model does not support", () => {
    const haiku = MODELS.find((entry) => entry.slug === "haiku")!;
    assert.equal(resolveEffortLevel({ model: "haiku", options: [{ id: "effort", value: "max" }] }, haiku), undefined);
    const sonnet = MODELS.find((entry) => entry.slug === "sonnet")!;
    assert.equal(
      resolveEffortLevel({ model: "sonnet", options: [{ id: "effort", value: "max" }] }, sonnet),
      "max"
    );
    assert.equal(
      resolveEffortLevel({ model: "sonnet", options: [{ id: "effort", value: "ultra" }] }, sonnet),
      undefined
    );
  });

  it("keeps the CLI's resolved id beside the launch alias", () => {
    const model = MODELS.find((entry) => entry.slug === "default")!;
    assert.equal(model.subProvider, "claude-opus-4-8[1m]");
    assert.equal(model.isDefault, true);
  });
});

// ---------------------------------------------------------------------------
// Agent Profiles (spec 2026-10-18 §6.0, §6.1)
// ---------------------------------------------------------------------------

const SESSION_TOOLS: ClaudeSessionToolsLaunch = {
  server: { type: "sdk", name: "orquester", instance: {} as never },
  instructions: "ORQUESTER BLOCK",
  allowedTools: ["mcp__orquester__send_message"],
  deny: ["orquester-daemon"],
  names: () => new Set(["send_message"]),
  release: () => {}
};

function profileLaunch(overrides: Partial<ClaudeProfileLaunch> = {}): ClaudeProfileLaunch {
  return {
    plugins: [
      { type: "local", path: "/prepared/v-1/plugin" },
      { type: "local", path: "/prepared/v-1/plugins/pl1", skipMcpDiscovery: true }
    ],
    skills: ["dev:review", "toolbox:fmt", "workflow-authoring", "proj-skill"],
    instructions: "Be brief.",
    hooks: { Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }] },
    disableWorkflows: false,
    carriedSettings: {
      model: "opus",
      permissions: { allow: ["Bash(ls:*)"] },
      env: { TOKEN: "carried-secret" },
      alwaysThinkingEnabled: false,
      autoMemoryEnabled: true,
      deniedMcpServers: [{ serverCommand: ["evil"] }]
    },
    disabledPluginIds: ["gplug@mkt", "projplug@mkt"],
    mcpServers: { search: { type: "stdio", command: "s", env: { API_KEY: "mcp-secret" } } },
    ...overrides
  };
}

const FILES = claudeProfileLaunchFiles("/appdir/tmp", "t1");

function buildWith(profile: ClaudeProfileLaunch | undefined, modelSelection?: ModelSelection) {
  return buildClaudeQueryOptions({
    cwd: "/work/project",
    executablePath: "/usr/local/bin/claude",
    env: { PATH: "/usr/bin", HOME: "/home/orq", CLAUDE_CONFIG_DIR: "/homes/acc/home" },
    runtimeMode: "approval-required",
    models: MODELS,
    ...(modelSelection !== undefined ? { modelSelection } : {}),
    attachmentsDir: "/appdir/threads/t1/attachments",
    canUseTool: noopCanUseTool,
    sessionId: "11111111-2222-3333-4444-555555555555",
    sessionTools: SESSION_TOOLS,
    ...(profile !== undefined ? { profile: { launch: profile, files: FILES } } : {})
  });
}

describe("claude launch — NODE_OPTIONS (the plugins' tsc preload)", () => {
  const PRELOAD = '--require "/appdir/daemon/plugins/ts-rust/preload.cjs"';
  function withNodeOptions(profile: ClaudeProfileLaunch | undefined, settingsNodeOptions?: string) {
    return buildClaudeQueryOptions({
      cwd: "/work/project",
      executablePath: "/usr/local/bin/claude",
      env: { PATH: "/usr/bin", HOME: "/home/orq", NODE_OPTIONS: PRELOAD },
      ...(settingsNodeOptions !== undefined ? { settingsNodeOptions } : {}),
      runtimeMode: "approval-required",
      models: MODELS,
      attachmentsDir: "/appdir/threads/t1/attachments",
      canUseTool: noopCanUseTool,
      sessionId: "11111111-2222-3333-4444-555555555555",
      ...(profile !== undefined ? { profile: { launch: profile, files: FILES } } : {})
    });
  }

  it("rides the flag-tier env, which the SDK passes on (it deletes NODE_OPTIONS from options.env)", () => {
    const { options } = withNodeOptions(undefined);
    assert.deepEqual((options.settings as Record<string, unknown>).env, { NODE_OPTIONS: PRELOAD });
  });

  it("keeps the settings files' value in front, since the flag tier replaces it", () => {
    const { options } = withNodeOptions(undefined, "--max-old-space-size=4096");
    assert.deepEqual((options.settings as Record<string, unknown>).env, {
      NODE_OPTIONS: `--max-old-space-size=4096 ${PRELOAD}`
    });
  });

  it("is absent without a NODE_OPTIONS in the env", () => {
    const settings = build("approval-required", { model: "haiku" }).options.settings as Record<string, unknown> | undefined;
    assert.equal(settings !== undefined && "env" in settings, false);
  });

  it("a profile chat merges it into the carried env instead of replacing that", () => {
    const built = withNodeOptions(profileLaunch(), "--from-user");
    assert.deepEqual(built.profileFiles?.settings.env, {
      TOKEN: "carried-secret",
      NODE_OPTIONS: `--from-user ${PRELOAD}`
    });
  });
});

describe("claude launch — ENABLE_TOOL_SEARCH auto modes", () => {
  it("maps Claude Code's auto modes to on and leaves every other value alone", () => {
    const rows: Array<[string | undefined, "true" | undefined]> = [
      [undefined, undefined],
      ["", undefined],
      ["true", undefined],
      ["false", undefined],
      ["1", undefined],
      ["AUTO", undefined],
      [" auto", undefined],
      ["auto", "true"],
      ["auto:10", "true"],
      ["auto:50", "true"],
      ["auto:99", "true"],
      // auto:0 is already on, auto:100 already off; N clamps to 0..100.
      ["auto:0", undefined],
      ["auto:100", undefined],
      ["auto:-5", undefined],
      ["auto:150", undefined],
      // parseInt reads a leading integer; an unparsable N means plain auto.
      ["auto:5.5", "true"],
      ["auto:0.5", undefined],
      ["auto: 20 ", "true"],
      ["auto:", "true"],
      ["auto:abc", "true"],
      // Scientific notation counts only as an integer; grouped digits are joined.
      ["auto:1e1", "true"],
      ["auto:1e2", undefined],
      ["auto:1.5e0", "true"],
      ["auto:1_000", undefined],
      ["auto:1,000", undefined]
    ];
    for (const [value, expected] of rows) {
      assert.equal(claudeToolSearchOverride(value), expected, `ENABLE_TOOL_SEARCH=${String(value)}`);
    }
  });

  function withToolSearch(toolSearchSetting: string | undefined, profile?: ClaudeProfileLaunch, nodeOptions?: string) {
    return buildClaudeQueryOptions({
      cwd: "/work/project",
      executablePath: "/usr/local/bin/claude",
      env: { PATH: "/usr/bin", HOME: "/home/orq", ...(nodeOptions !== undefined ? { NODE_OPTIONS: nodeOptions } : {}) },
      ...(toolSearchSetting !== undefined ? { toolSearchSetting } : {}),
      runtimeMode: "approval-required",
      models: MODELS,
      attachmentsDir: "/appdir/threads/t1/attachments",
      canUseTool: noopCanUseTool,
      sessionId: "11111111-2222-3333-4444-555555555555",
      ...(profile !== undefined ? { profile: { launch: profile, files: FILES } } : {})
    });
  }

  it("turns an auto mode on at the flag tier, since settings env beats the process env", () => {
    const { options } = withToolSearch("auto");
    assert.deepEqual((options.settings as Record<string, unknown>).env, { ENABLE_TOOL_SEARCH: "true" });
    assert.equal(options.env?.ENABLE_TOOL_SEARCH, undefined, "the process env is left as built");
  });

  it("sits beside NODE_OPTIONS in the flag-tier env", () => {
    const { options } = withToolSearch("auto:25", undefined, "--preload");
    assert.deepEqual((options.settings as Record<string, unknown>).env, { NODE_OPTIONS: "--preload", ENABLE_TOOL_SEARCH: "true" });
  });

  it("leaves the user's own choice and the default untouched", () => {
    for (const value of [undefined, "true", "false", "auto:0", "auto:100"]) {
      const settings = withToolSearch(value).options.settings as Record<string, unknown> | undefined;
      assert.equal(settings !== undefined && "env" in settings, false, `ENABLE_TOOL_SEARCH=${String(value)}`);
    }
  });

  it("a profile chat overrides the carried user value in its settings file", () => {
    const carriedSettings = { env: { TOKEN: "carried-secret", ENABLE_TOOL_SEARCH: "auto" } };
    const built = withToolSearch("auto", profileLaunch({ carriedSettings }));
    assert.deepEqual(built.profileFiles?.settings.env, { TOKEN: "carried-secret", ENABLE_TOOL_SEARCH: "true" });
    const kept = withToolSearch("false", profileLaunch({ carriedSettings: { env: { ENABLE_TOOL_SEARCH: "false" } } }));
    assert.deepEqual(kept.profileFiles?.settings.env, { ENABLE_TOOL_SEARCH: "false" });
  });
});

describe("claude launch — Agent Profile chats (spec 2026-10-18 §6.1)", () => {
  it("a Global chat is untouched: user source, no strict MCP, no plugins, no skills, no launch files", () => {
    const built = buildWith(undefined, { model: "default", options: [{ id: "thinking", value: true }] });
    const { options } = built;
    assert.deepEqual(options.settingSources, ["user", "project", "local"]);
    assert.equal(options.strictMcpConfig, undefined);
    assert.equal(options.plugins, undefined);
    assert.equal(options.skills, undefined);
    assert.equal(built.profileFiles, undefined);
    assert.equal(typeof options.settings, "object");
    assert.deepEqual(options.settings, {
      alwaysThinkingEnabled: true,
      showThinkingSummaries: true,
      deniedMcpServers: [{ serverName: "orquester" }, { serverName: "orquester-daemon" }]
    });
    assert.equal(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS, undefined);
    assert.equal(options.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY, undefined);
    assert.deepEqual(options.extraArgs, { "thinking-display": "summarized" });
    assert.equal((options.systemPrompt as { append: string }).append.endsWith("ORQUESTER BLOCK"), true);
    assert.deepEqual(Object.keys(options).sort(), [
      "additionalDirectories",
      "agentProgressSummaries",
      "allowedTools",
      "canUseTool",
      "cwd",
      "disallowedTools",
      "env",
      "extraArgs",
      "includePartialMessages",
      "mcpServers",
      "model",
      "pathToClaudeCodeExecutable",
      "sessionId",
      "settingSources",
      "settings",
      "systemPrompt",
      "thinking",
      "toolConfig"
    ]);
  });

  it("a profile chat gets the §6.1 recipe", () => {
    const { options } = buildWith(profileLaunch());
    assert.deepEqual(options.settingSources, ["project", "local"]);
    assert.equal(options.strictMcpConfig, true);
    // Only Orquester's in-process server rides `mcpServers` (argv); the profile's are in the file.
    assert.deepEqual(Object.keys(options.mcpServers ?? {}), ["orquester"]);
    assert.deepEqual(options.allowedTools, ["mcp__orquester__send_message"]);
    assert.deepEqual(options.disallowedTools, ["mcp__orquester-daemon"]);
    assert.deepEqual(options.plugins, [
      { type: "local", path: "/prepared/v-1/plugin" },
      { type: "local", path: "/prepared/v-1/plugins/pl1", skipMcpDiscovery: true }
    ]);
    assert.deepEqual(options.skills, ["dev:review", "toolbox:fmt", "workflow-authoring", "proj-skill"]);
    assert.equal(
      (options.systemPrompt as { append: string }).append.endsWith("ORQUESTER BLOCK\n\nBe brief."),
      true,
      "the profile's instructions follow the runtime and Orquester blocks"
    );
    assert.equal(options.settings, FILES.settings, "settings ride a 0600 file, never argv");
    assert.equal(options.extraArgs?.["mcp-config"], FILES.mcpConfig);
    assert.equal(options.env?.CLAUDE_CONFIG_DIR, "/homes/acc/home", "the account's config dir stays");
    assert.equal(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
    assert.equal(options.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
  });

  it("no secret reaches the options themselves (argv)", () => {
    const serialized = JSON.stringify(buildWith(profileLaunch()).options, (_key, value) =>
      typeof value === "function" ? undefined : value
    );
    assert.equal(serialized.includes("mcp-secret"), false);
    assert.equal(serialized.includes("carried-secret"), false);
  });

  it("merges the settings: carried < chat keys < recipe; denials concatenated; plugins switched off", () => {
    const built = buildWith(profileLaunch(), { model: "default", options: [{ id: "thinking", value: true }] });
    assert.deepEqual(built.profileFiles?.settings, {
      model: "opus",
      permissions: { allow: ["Bash(ls:*)"] },
      env: { TOKEN: "carried-secret" },
      // The chat's chip beats the carried user setting.
      alwaysThinkingEnabled: true,
      showThinkingSummaries: true,
      deniedMcpServers: [{ serverCommand: ["evil"] }, { serverName: "orquester" }, { serverName: "orquester-daemon" }],
      enabledPlugins: { "gplug@mkt": false, "projplug@mkt": false },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }] },
      // The recipe beats the carried `autoMemoryEnabled: true`.
      autoMemoryEnabled: false,
      syncClaudeAiSkills: false,
      syncClaudeAiPlugins: false,
      disableClaudeAiConnectors: true
    });
    assert.deepEqual(built.profileFiles?.mcpConfig, {
      mcpServers: { search: { type: "stdio", command: "s", env: { API_KEY: "mcp-secret" } } }
    });
  });

  it("a profile without built-in tools passes tools: [] and loads MCP tools up front", () => {
    const off = buildWith(profileLaunch({ disableBuiltinTools: true }));
    assert.deepEqual(off.options.tools, []);
    assert.equal(off.options.env?.ENABLE_TOOL_SEARCH, "false");
    assert.equal(off.options.env?.MAX_MCP_OUTPUT_TOKENS, "60000", "its tool results are its work");
    assert.deepEqual(off.options.allowedTools, ["mcp__orquester__send_message"], "the session tools stay pre-approved");
    const on = buildWith(profileLaunch());
    assert.equal("tools" in on.options, false);
    assert.equal(on.options.env?.ENABLE_TOOL_SEARCH, undefined);
    assert.deepEqual(on.profileFiles?.settings.env, { TOKEN: "carried-secret" });
  });

  it("a profile without built-in tools keeps tool search off over a carried user value", () => {
    // The carried user env rides the flag tier, which beats the process env's "false".
    const carriedSettings = { env: { TOKEN: "carried-secret", ENABLE_TOOL_SEARCH: "true" } };
    const built = buildClaudeQueryOptions({
      cwd: "/work/project",
      executablePath: "/usr/local/bin/claude",
      env: { PATH: "/usr/bin", HOME: "/home/orq" },
      toolSearchSetting: "true",
      runtimeMode: "approval-required",
      models: MODELS,
      attachmentsDir: "/appdir/threads/t1/attachments",
      canUseTool: noopCanUseTool,
      sessionId: "11111111-2222-3333-4444-555555555555",
      profile: { launch: profileLaunch({ disableBuiltinTools: true, carriedSettings }), files: FILES }
    });
    assert.deepEqual(built.profileFiles?.settings.env, { TOKEN: "carried-secret", ENABLE_TOOL_SEARCH: "false" });
  });

  it("a profile without built-in tools loads no filesystem settings (no CLAUDE.md walked up from its cwd)", () => {
    assert.deepEqual(buildWith(profileLaunch({ disableBuiltinTools: true })).options.settingSources, []);
    assert.deepEqual(buildWith(profileLaunch()).options.settingSources, ["project", "local"]);
  });

  it("the Workflow tool off adds disableWorkflows; no MCP server means no --mcp-config", () => {
    const built = buildWith(profileLaunch({ disableWorkflows: true, mcpServers: {}, disabledPluginIds: [] }));
    assert.equal(built.profileFiles?.settings.disableWorkflows, true);
    assert.equal("enabledPlugins" in (built.profileFiles?.settings ?? {}), false);
    assert.equal(built.profileFiles?.mcpConfig, undefined);
    assert.equal(built.options.extraArgs?.["mcp-config"], undefined);
  });

  it("built-in skills shown: no `skills` option; no instructions: the append is unchanged", () => {
    const { skills: _skills, ...rest } = profileLaunch();
    const { options } = buildWith({ ...rest, instructions: "" });
    assert.equal("skills" in options, false);
    assert.equal((options.systemPrompt as { append: string }).append.endsWith("ORQUESTER BLOCK"), true);
  });
});
