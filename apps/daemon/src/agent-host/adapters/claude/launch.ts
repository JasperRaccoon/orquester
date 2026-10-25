/**
 * Claude adapter — the SDK launch configuration (spec §4.4, §4.5 "Launch").
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/provider/Layers/ClaudeAdapter.ts:4913-4965` (the whole
 * `Options` object). T3's launch-arg strip and folded permission mode
 * (`:4834-4838`, `:4886-4891`) are deliberately NOT ported: a registry row's
 * `args` are the terminal launcher's flags and never reach a chat launch, so
 * the permission mode is the runtime mode's alone and `effort` the model
 * selection's alone.
 *
 * This module is pure so every row of §4.4's Claude column is a test
 * (`launch.test.ts`) rather than something only a live CLI could show.
 */

import type { CanUseTool, Options as ClaudeQueryOptions } from "@anthropic-ai/claude-agent-sdk";
import type { ModelSelection, ProviderModel, RuntimeMode } from "@orquester/api/agent-chat";

import { isPlainObject } from "../../../agent-isolation/claude-names.ts";
import { CLAUDE_QUESTION_PREVIEW_FORMAT } from "./questions.ts";
import { CLAUDE_PROFILE_ENV, type ClaudeProfileLaunch, type ClaudeProfileLaunchFiles } from "./profile-launch.ts";
import { claudeDeniedMcpServers, claudeDisallowedTools, type ClaudeSessionToolsLaunch } from "./session-tools.ts";
import {
  CLAUDE_OPTION_IDS,
  findModel,
  resolveBooleanOption,
  resolveEffortLevel
} from "./models.ts";

/**
 * Session-level instructions appended to the `claude_code` preset. **Model and
 * effort are deliberately left out**: they change per turn, while this prompt
 * is fixed for the life of the session (§4.5).
 */
const CLAUDE_RUNTIME_INSTRUCTIONS = [
  "You are running inside Orquester's agent chat, not a terminal.",
  "Your output is rendered as structured chat rows: messages, reasoning, tool calls,",
  "command output, diffs and subagent activity. There is no TUI and no alternate screen.",
  "Write normal prose and Markdown; do not draw boxes, spinners or ANSI art,",
  "and do not ask the user to press a key.",
  "File edits, commands and subagents work exactly as they do in the CLI."
].join(" ");

/**
 * §4.4, Claude's column. `approval-required` is deliberately **absent**: the
 * mode is left undefined so gating is entirely `canUseTool`.
 */
const RUNTIME_MODE_TO_PERMISSION_MODE: Readonly<
  Record<RuntimeMode, "acceptEdits" | "auto" | "bypassPermissions" | undefined>
> = {
  "approval-required": undefined,
  "auto-accept-edits": "acceptEdits",
  auto: "auto",
  "full-access": "bypassPermissions"
};

interface BuildClaudeQueryOptionsInput {
  cwd: string;
  /** The registry-resolved `claude`, never the SDK's bundled copy (§10). */
  executablePath: string;
  /** The complete child env, built by `support/env.ts` — never a spread. */
  env: Record<string, string>;
  /**
   * The `env.NODE_OPTIONS` the chat's own settings files set (the one the CLI would use), read only
   * while `env` carries a NODE_OPTIONS: the flag-tier value below replaces it, so it goes first.
   */
  settingsNodeOptions?: string;
  /**
   * The `ENABLE_TOOL_SEARCH` the CLI would otherwise run with: its settings files' over the process
   * env's (`settings-env.ts`). An auto mode is turned into `true` at the flag tier.
   */
  toolSearchSetting?: string;
  runtimeMode: RuntimeMode;
  modelSelection?: ModelSelection;
  /** The catalogue the snapshot published, for per-model option gating. */
  models: readonly ProviderModel[];
  /**
   * The thread's attachments dir, granted beside `cwd` as `[cwd,
   * attachmentsDir]`: every attachment path the turn text names — inserted by
   * the composer, or listed in the adapter's `Attached files:` block — points
   * into it (§4.1).
   */
  attachmentsDir: string;
  canUseTool: CanUseTool;
  onUserDialog?: NonNullable<ClaudeQueryOptions["onUserDialog"]>;
  /** stderr is captured, not discarded (§3.1). */
  stderr?: (data: string) => void;
  /** Resume an existing native session, or start a host-generated one. */
  resume?: string;
  /** A transcript uuid to resume at, set only by a rollback. */
  resumeSessionAt?: string;
  sessionId?: string;
  /**
   * The thread's `orquester` session-tool server and its instruction block
   * (design 2026-10-14 §1.2, §1.4) — present only when a toolkit is
   * registered. `session-tools.ts`.
   */
  sessionTools?: ClaudeSessionToolsLaunch;
  /**
   * An Agent Profile chat (spec 2026-10-18 §6.1, `profile-launch.ts`) and where its launch files
   * go. Absent = Global: the options are exactly what they were before profiles existed.
   */
  profile?: { launch: ClaudeProfileLaunch; files: ClaudeProfileLaunchFiles };
  /**
   * boxes (spec 2026-10-19 §8.5): the CLI runs in a box — the SDK's spawn hook starts the command
   * it built there (`boxes/claude-process.ts`), and `cwd`, `executablePath`, `env`,
   * `attachmentsDir` and the profile files above are already the BOX's.
   */
  spawnClaudeCodeProcess?: NonNullable<ClaudeQueryOptions["spawnClaudeCodeProcess"]>;
  /**
   * boxes (spec 2026-10-19 §8.4): the account's own stdio servers bridged to the host, under their
   * own names — a dynamic server replaces a same-named one of another scope.
   */
  bridgedMcpServers?: Record<string, Record<string, unknown>>;
}

interface BuiltClaudeQueryOptions {
  options: ClaudeQueryOptions;
  /**
   * The session's base permission mode, restored after a plan turn: the
   * runtime mode's (§4.4), or `"default"` where Supervised leaves it unset.
   * Typed as the SDK's own union because `setPermissionMode` takes that.
   */
  basePermissionMode: NonNullable<ClaudeQueryOptions["permissionMode"]>;
  effort: "low" | "medium" | "high" | "xhigh" | "max" | undefined;
  model: string | undefined;
  /**
   * A profile chat's launch files, to be written (0600) at `input.profile.files` BEFORE the query
   * starts: the flag-tier settings and, when there are servers, the `--mcp-config` file. They hold
   * secrets, which is why `options` names their paths instead of carrying them in argv.
   */
  profileFiles?: { settings: Record<string, unknown>; mcpConfig?: { mcpServers: Record<string, unknown> } };
}

/**
 * Env of a launch with no built-in tools (a managed profile that works through MCP tools only):
 * every MCP tool loaded up front (no tool search to reach a deferred one), and tool results up to
 * 60k tokens — such a chat's tool results ARE its work (the Knowledge indexer's tasks). Its
 * `ENABLE_TOOL_SEARCH` is also set at the flag tier, since the user env carried there beats this.
 */
export const CLAUDE_NO_BUILTIN_TOOLS_ENV: Readonly<Record<string, string>> = { ENABLE_TOOL_SEARCH: "false", MAX_MCP_OUTPUT_TOKENS: "60000" };

/**
 * What a chat's `ENABLE_TOOL_SEARCH` becomes at the flag tier: `true` for an auto mode, else
 * nothing. In auto mode Claude Code sends every MCP tool schema in full while they fit under a
 * share of the context window — on a 1M model the `orquester` tools do — so each request carries
 * them, and a server that connects late changes the tool list and misses the prompt cache.
 * `auto:0` already means on and `auto:100` off, so those stay; `true` (on) is the CLI's default.
 *
 * Claude Code 2.1.307's reading: `auto`, or `auto:N` with N clamped to 0..100 and an unparsable N
 * meaning `auto`.
 */
export function claudeToolSearchOverride(value: string | undefined): "true" | undefined {
  if (value === undefined) return undefined;
  if (value === "auto") return "true";
  if (!value.startsWith("auto:")) return undefined;
  const percent = parseClaudeInteger(value.slice("auto:".length));
  if (Number.isNaN(percent)) return "true";
  const clamped = Math.min(100, Math.max(0, percent));
  return clamped > 0 && clamped < 100 ? "true" : undefined;
}

// Claude Code 2.1.307's integer parsing for auto:N: scientific notation counts only as an integer,
// grouped digits (1_000, 1,000, 1 000) are joined, and anything else goes to parseInt.
const CLAUDE_SCIENTIFIC_INTEGER = /^[+-]?(\d+(\.\d*)?|\.\d+)[eE][+-]?\d+$/;
const CLAUDE_GROUPED_INTEGER = /^[+-]?\d{1,3}([_,\u00A0\u202F ])\d{3}(?:\1\d{3})*$/;
function parseClaudeInteger(text: string): number {
  const value = text.trim();
  if (value.length <= 32 && CLAUDE_SCIENTIFIC_INTEGER.test(value)) {
    const number = Number(value);
    return Number.isInteger(number) ? number : Number.NaN;
  }
  if (value.length <= 32 && CLAUDE_GROUPED_INTEGER.test(value)) {
    return Number.parseInt(value.replace(/[_,\u00A0\u202F ]/g, ""), 10);
  }
  return Number.parseInt(value, 10);
}

export function buildClaudeQueryOptions(
  input: BuildClaudeQueryOptionsInput
): BuiltClaudeQueryOptions {
  const model = findModel(input.models, input.modelSelection?.model);
  const modelSlug = input.modelSelection?.model?.trim();
  const effort = resolveEffortLevel(input.modelSelection, model);
  const thinking = resolveBooleanOption(input.modelSelection, model, CLAUDE_OPTION_IDS.thinking);
  const fastMode = resolveBooleanOption(input.modelSelection, model, CLAUDE_OPTION_IDS.fastMode);
  const ultracode = resolveBooleanOption(
    input.modelSelection,
    model,
    CLAUDE_OPTION_IDS.ultracode
  );

  // The runtime mode is the ONLY authority (§4.4). A registry row's
  // `--dangerously-skip-permissions` is the terminal launcher's and never
  // reaches this function; `full-access` keeps its meaning through the
  // `bypassPermissions` + `allowDangerouslySkipPermissions` pair below.
  const permissionMode = RUNTIME_MODE_TO_PERMISSION_MODE[input.runtimeMode];

  // Summaries are what §4.2's `reasoning_summary_text` carries; Claude never
  // returns the raw chain of thought.
  const wantsThinkingSummaries = thinking !== false;

  // The SDK deletes NODE_OPTIONS from the CLI's env (0.3.278 `sdk.mjs`), so the host's value — the
  // plugins' tsc preload — reaches the CLI's commands, hooks and MCP servers through the flag-tier
  // `env` instead. That tier wins per key over the settings files, so their value is kept in front.
  const nodeOptions =
    input.env.NODE_OPTIONS === undefined
      ? undefined
      : input.settingsNodeOptions !== undefined && input.settingsNodeOptions.trim().length > 0
        ? `${input.settingsNodeOptions} ${input.env.NODE_OPTIONS}`
        : input.env.NODE_OPTIONS;

  // Settings env beats the process env in the CLI, so the tool-search choice rides the flag tier too:
  // off for a chat without built-in tools (no ToolSearch to reach a deferred tool), and on in place
  // of an auto mode.
  const profile = input.profile;
  const toolSearch =
    profile?.launch.disableBuiltinTools === true ? "false" : claudeToolSearchOverride(input.toolSearchSetting);
  const settingsEnv: Record<string, string> = {
    ...(nodeOptions !== undefined ? { NODE_OPTIONS: nodeOptions } : {}),
    ...(toolSearch !== undefined ? { ENABLE_TOOL_SEARCH: toolSearch } : {})
  };

  const settings: Record<string, unknown> = {
    ...(Object.keys(settingsEnv).length > 0 ? { env: settingsEnv } : {}),
    ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
    ...(wantsThinkingSummaries ? { showThinkingSummaries: true } : {}),
    ...(fastMode === true ? { fastMode: true } : {}),
    // Ultracode is xhigh effort PLUS the setting, exactly as T3's manifest
    // paired them; the SDK requires an xhigh-capable model for it.
    ...(ultracode === true ? { ultracode: true } : {}),
    // Unified MCP §12.1: the daemon-pointing servers never connect in this chat, and a user server
    // named `orquester` never races ours (`session-tools.ts`). `deniedMcpServers` merges from every
    // settings source, so the user's own denials stay.
    ...(input.sessionTools !== undefined ? { deniedMcpServers: claudeDeniedMcpServers(input.sessionTools.deny) } : {})
  };
  const effectiveEffort = ultracode === true ? ("xhigh" as const) : effort;

  // Only flags the adapter authors itself. `effort` rides the SDK's own option
  // above: the SDK appends `extraArgs` after its own flags and the CLI keeps
  // the LAST `--effort`, so a second one here would overrule the chip.
  const extraArgs: Record<string, string | null> = {};
  if (wantsThinkingSummaries) {
    extraArgs["thinking-display"] = "summarized";
  }

  // The "Orquester" block rides the same non-user-visible channel as the
  // runtime instructions: the preset's `append`, never a user message.
  const append =
    input.sessionTools !== undefined && input.sessionTools.instructions.length > 0
      ? `${CLAUDE_RUNTIME_INSTRUCTIONS}\n\n${input.sessionTools.instructions}`
      : CLAUDE_RUNTIME_INSTRUCTIONS;

  const profileFiles = profile !== undefined ? buildProfileFiles(profile.launch, settings) : undefined;
  if (profile !== undefined && profileFiles?.mcpConfig !== undefined) {
    extraArgs["mcp-config"] = profile.files.mcpConfig;
  }

  const options: ClaudeQueryOptions = {
    cwd: input.cwd,
    ...(modelSlug !== undefined && modelSlug.length > 0 ? { model: modelSlug } : {}),
    pathToClaudeCodeExecutable: input.executablePath,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append:
        profile !== undefined && profile.launch.instructions.length > 0
          ? `${append}\n\n${profile.launch.instructions}`
          : append
    },
    // A profile chat drops the user source: no user CLAUDE.md, rules, skills, commands, agents,
    // MCP servers, hooks or settings (its runtime settings come back through `settings`, §6.0).
    // A managed profile without built-in tools (the Knowledge indexer) loads NO filesystem settings
    // (SDK isolation mode, `[]`): no CLAUDE.md walked up from its cwd (a `~/CLAUDE.md` above a
    // `~/.orquester` appdir), no project hooks or settings. Its own settings ride `settings`.
    settingSources:
      profile === undefined ? ["user", "project", "local"] : profile.launch.disableBuiltinTools === true ? [] : ["project", "local"],
    ...(effectiveEffort !== undefined ? { effort: effectiveEffort } : {}),
    ...(wantsThinkingSummaries
      ? { thinking: { type: "adaptive" as const, display: "summarized" as const } }
      : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
    ...(profile !== undefined
      ? { settings: profile.files.settings }
      : Object.keys(settings).length > 0
        ? { settings }
        : {}),
    // §4.5: `resume` (cursor uuid) **or** `sessionId` (a fresh v4 uuid), never
    // both — the CLI's behaviour with both is undefined. Enforced here, in the
    // pure module the rows are tested against, rather than only in the caller.
    ...(input.resume !== undefined ? { resume: input.resume } : {}),
    ...(input.resumeSessionAt !== undefined ? { resumeSessionAt: input.resumeSessionAt } : {}),
    ...(input.resume === undefined && input.sessionId !== undefined
      ? { sessionId: input.sessionId }
      : {}),
    includePartialMessages: true,
    // A model-written one-liner per `task_progress` ("Analyzing the auth
    // module…") for the roster's activity line; forks the subagent's cache,
    // so the cost is small. SDK 0.3.278 `agentProgressSummaries`.
    agentProgressSummaries: true,
    // Said explicitly rather than left to the CLI's default: the question card
    // renders option previews in this format (`questions.ts`), and a default
    // that moved would hand it fragments it shows as the wrong thing.
    toolConfig: { askUserQuestion: { previewFormat: CLAUDE_QUESTION_PREVIEW_FORMAT } },
    canUseTool: input.canUseTool,
    ...(input.onUserDialog !== undefined
      ? { onUserDialog: input.onUserDialog, supportedDialogKinds: ["resume_return"] }
      : {}),
    // A profile without built-in tools also loads its MCP tools up front: with no ToolSearch to
    // reach deferred ones, a deferred tool could never be called.
    env:
      profile !== undefined
        ? { ...input.env, ...CLAUDE_PROFILE_ENV, ...(profile.launch.disableBuiltinTools === true ? CLAUDE_NO_BUILTIN_TOOLS_ENV : {}) }
        : input.env,
    // The attachments grant lets the agent read every attachment it does not
    // get inline — a PDF, a CSV, a pasted-text file — at the absolute path the
    // turn text names (§4.1), without an approval prompt. It is a leaf
    // directory holding only attachment files.
    additionalDirectories: [input.cwd, input.attachmentsDir],
    // The only SDK-registered MCP server is the thread's own in-process
    // `orquester` session-tool server (design 2026-10-14 §1.2) — none without
    // a registered toolkit. The daemon's terminal-shaped `/mcp` server stays
    // out of scope (§2). `strictMcpConfig` stays unset so the user's own
    // `.mcp.json` and user-scope servers keep loading as before.
    //
    // A profile chat sets `strictMcpConfig`: only `mcpServers` and the `--mcp-config` file (the
    // profile's servers, its plugins' lifted ones and the project's `.mcp.json`) load — no user,
    // local, plugin or claude.ai server. The in-process `orquester` server rides `mcpServers` as
    // ever, so the session tools and their `allowedTools`/`disallowedTools` work unchanged.
    mcpServers: {
      // boxes: first, so the session tools' own entry can never be replaced by one.
      ...((input.bridgedMcpServers ?? {}) as NonNullable<ClaudeQueryOptions["mcpServers"]>),
      ...(input.sessionTools !== undefined ? { [input.sessionTools.server.name]: input.sessionTools.server } : {})
    },
    ...(profile !== undefined ? { strictMcpConfig: true } : {}),
    ...(profile !== undefined && profile.launch.plugins.length > 0 ? { plugins: [...profile.launch.plugins] } : {}),
    ...(profile?.launch.skills !== undefined ? { skills: [...profile.launch.skills] } : {}),
    // A managed profile that works only through MCP tools (the Knowledge Graph indexer): no
    // built-in tool (Bash, Read, Edit, Agent, Skill…) is offered at all — SDK `tools: []`.
    ...(profile?.launch.disableBuiltinTools === true ? { tools: [] } : {}),
    // Session tools never raise an approval card (§1.3): each one is
    // pre-approved by name in every permission mode (`session-tools.ts`).
    ...(input.sessionTools !== undefined ? { allowedTools: [...input.sessionTools.allowedTools] } : {}),
    // ...and the server-level rule of every denied server (§12.1): no tool of it reaches the model.
    ...(input.sessionTools !== undefined && claudeDisallowedTools(input.sessionTools.deny).length > 0
      ? { disallowedTools: claudeDisallowedTools(input.sessionTools.deny) }
      : {}),
    ...(Object.keys(extraArgs).length > 0 ? { extraArgs } : {}),
    ...(input.stderr !== undefined ? { stderr: input.stderr } : {}),
    // boxes:
    ...(input.spawnClaudeCodeProcess !== undefined ? { spawnClaudeCodeProcess: input.spawnClaudeCodeProcess } : {})
  };

  return {
    options,
    basePermissionMode: permissionMode ?? "default",
    effort: effectiveEffort,
    model: modelSlug,
    ...(profileFiles !== undefined ? { profileFiles } : {})
  };
}

/**
 * A profile chat's flag-tier settings (spec §6.0, §6.1): the account's carried runtime settings,
 * then the chat's own keys (thinking, fast mode, …), then the recipe's — the recipe wins.
 * `deniedMcpServers` is the one list merged rather than replaced: the user's server-command/URL
 * denials (policy) and the session tools' denials both stay. Every plugin the account installed
 * or the project enables is switched off; the profile's own load by path and are unaffected.
 */
function buildProfileFiles(
  launch: ClaudeProfileLaunch,
  chatSettings: Readonly<Record<string, unknown>>
): NonNullable<BuiltClaudeQueryOptions["profileFiles"]> {
  const carried = launch.carriedSettings;
  const denied = [
    ...(Array.isArray(carried.deniedMcpServers) ? carried.deniedMcpServers : []),
    ...(Array.isArray(chatSettings.deniedMcpServers) ? chatSettings.deniedMcpServers : [])
  ];
  // The chat's NODE_OPTIONS joins the carried env rather than replacing it.
  const env = {
    ...(isPlainObject(carried.env) ? carried.env : {}),
    ...(isPlainObject(chatSettings.env) ? chatSettings.env : {})
  };
  const settings: Record<string, unknown> = {
    ...carried,
    ...chatSettings,
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(denied.length > 0 ? { deniedMcpServers: denied } : {}),
    ...(launch.disabledPluginIds.length > 0
      ? { enabledPlugins: Object.fromEntries(launch.disabledPluginIds.map((id) => [id, false])) }
      : {}),
    hooks: launch.hooks,
    autoMemoryEnabled: false,
    syncClaudeAiSkills: false,
    syncClaudeAiPlugins: false,
    disableClaudeAiConnectors: true,
    ...(launch.disableWorkflows ? { disableWorkflows: true } : {})
  };
  return {
    settings,
    ...(Object.keys(launch.mcpServers).length > 0 ? { mcpConfig: { mcpServers: { ...launch.mcpServers } } } : {})
  };
}

/**
 * The probe's options (§4.5 "Probe"). Every one of them matters: the probe
 * fires every few minutes, so a `SessionStart` hook would run on every health
 * check, and an MCP connection would be opened for nothing.
 */
export function buildClaudeProbeOptions(input: {
  executablePath: string;
  env: Record<string, string>;
  cwd?: string;
  abortController: AbortController;
  stderr?: (data: string) => void;
}): ClaudeQueryOptions {
  return {
    persistSession: false,
    pathToClaudeCodeExecutable: input.executablePath,
    abortController: input.abortController,
    // Filesystem setting sources are kept so slash-command discovery is the
    // real merged list the CLI would use...
    settingSources: ["user", "project", "local"],
    // ...but the user's hooks must not run on a health check.
    settings: { disableAllHooks: true },
    allowedTools: [],
    mcpServers: {},
    strictMcpConfig: true,
    env: {
      ...input.env,
      // Connected claude.ai MCP servers are discovered outside filesystem
      // config; disable them independently for this health check.
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      // A noninteractive health check cannot learn anything from IDE
      // discovery, and skipping it avoids a process tree per refresh.
      CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
      CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1"
    },
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    stderr: input.stderr ?? ((): void => {})
  };
}
