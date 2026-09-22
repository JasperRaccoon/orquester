/**
 * The §4.4 permission-mode table (Claude's column, every row), the §4.3
 * decision mapping (every row), and the model/version gate of §3.2 and §10.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { ModelSelection, ProviderModel, RuntimeMode } from "@orquester/api/agent-chat";
import { RUNTIME_MODES } from "@orquester/api/agent-chat";

import {
  ACCEPT_ALWAYS_UNSUPPORTED_MESSAGE,
  CANCEL_MESSAGE,
  DECLINE_MESSAGE,
  permissionResultForDecision,
  shouldShortCircuitToAllow,
  toSessionPermissionUpdates
} from "./decisions.ts";
import {
  CLAUDE_NEVER_SET_OPTIONS,
  CLAUDE_SESSION_ALLOWED_DESPITE_SPEC,
  CLAUDE_RUNTIME_INSTRUCTIONS,
  buildClaudeProbeOptions,
  buildClaudeQueryOptions,
  parseClaudeLaunchArgs
} from "./launch.ts";
import {
  MINIMUM_CLAUDE_CLI_VERSION,
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
  assert.equal(named[0]?.name, "Default · Opus (1M context)");
  assert.equal(named[0]?.shortName, "Default · Opus (1M context)");
  // No sibling lists the resolved id: the id itself is better than nothing.
  const bare = toProviderModels([
    { value: "default", resolvedModel: "claude-opus-4-8[1m]", displayName: "Default (recommended)" }
  ]);
  assert.equal(bare[0]?.name, "Default · claude-opus-4-8[1m]");
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

  it("covers every RuntimeMode", () => {
    for (const mode of RUNTIME_MODES) {
      assert.doesNotThrow(() => build(mode), mode);
    }
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
    assert.deepEqual(options.systemPrompt, {
      type: "preset",
      preset: "claude_code",
      append: CLAUDE_RUNTIME_INSTRUCTIONS
    });
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
  });

  it("never sets the forbidden options, with one declared exception", () => {
    const { options } = build("full-access", { model: "default" });
    const record = options as unknown as Record<string, unknown>;
    const allowed = new Set<string>(CLAUDE_SESSION_ALLOWED_DESPITE_SPEC);
    // The constant is the SPEC's list, verbatim; the exception is named
    // separately so a regression on any other entry still fails here.
    assert.ok(CLAUDE_NEVER_SET_OPTIONS.includes("stderr"));
    for (const key of CLAUDE_NEVER_SET_OPTIONS) {
      if (allowed.has(key)) {
        continue;
      }
      assert.equal(record[key], undefined, `${key} must never be set`);
    }
    // …and the exception really is only stderr, which §3.1 requires captured.
    assert.deepEqual([...allowed], ["stderr"]);
    const withCapture = buildClaudeQueryOptions({
      cwd: "/work",
      executablePath: "/bin/claude",
      env: {},
      runtimeMode: "approval-required",
      models: MODELS,
      attachmentsDir: "/a",
      canUseTool: noopCanUseTool,
      stderr: () => {}
    });
    assert.equal(typeof withCapture.options.stderr, "function");
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

  it("does not leave the model empty when none is selected", () => {
    const { options } = build("approval-required");
    assert.equal(options.model, undefined);
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

  it("folds a permission launch arg into the mode instead of argv", () => {
    const parsed = parseClaudeLaunchArgs([
      "--dangerously-skip-permissions",
      "--verbose",
      "--effort",
      "high",
      "--permission-mode=acceptEdits"
    ]);
    assert.equal(parsed.permissionMode, "acceptEdits");
    assert.equal(parsed.skipPermissions, true);
    assert.deepEqual(parsed.extraArgs, { verbose: null, effort: "high" });

    const built = buildClaudeQueryOptions({
      cwd: "/work",
      executablePath: "/bin/claude",
      env: {},
      runtimeMode: "approval-required",
      models: MODELS,
      attachmentsDir: "/a",
      canUseTool: noopCanUseTool,
      launchArgs: ["--permission-mode=acceptEdits", "--verbose"]
    });
    assert.equal(built.options.permissionMode, "acceptEdits");
    const extra = built.options.extraArgs as Record<string, unknown>;
    assert.equal(extra["permission-mode"], undefined);
    assert.equal(extra["dangerously-skip-permissions"], undefined);
    assert.equal(extra.verbose, null);
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
    assert.deepEqual(result, {
      behavior: "deny",
      message: ACCEPT_ALWAYS_UNSUPPORTED_MESSAGE
    });
  });

  it("decline and cancel are two answers, not two labels", () => {
    assert.deepEqual(
      permissionResultForDecision({ decision: "decline", toolName: "Bash", toolInput }),
      { behavior: "deny", message: DECLINE_MESSAGE }
    );
    assert.deepEqual(
      permissionResultForDecision({ decision: "cancel", toolName: "Bash", toolInput }),
      { behavior: "deny", message: CANCEL_MESSAGE }
    );
    assert.notEqual(DECLINE_MESSAGE, CANCEL_MESSAGE);
  });

  it("only full-access short-circuits", () => {
    assert.equal(shouldShortCircuitToAllow("full-access"), true);
    for (const mode of ["approval-required", "auto-accept-edits", "auto"]) {
      assert.equal(shouldShortCircuitToAllow(mode), false, mode);
    }
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
    assert.equal(meetsMinimumClaudeVersion(MINIMUM_CLAUDE_CLI_VERSION), true);
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
