/**
 * Claude adapter — the SDK launch configuration (spec §4.4, §4.5 "Launch").
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/provider/Layers/ClaudeAdapter.ts:4834-4965` (the whole
 * `Options` object, the extraArgs strip and the folded permission mode).
 *
 * This module is pure so every row of §4.4's Claude column is a test
 * (`launch.test.ts`) rather than something only a live CLI could show.
 */

import type { CanUseTool, Options as ClaudeQueryOptions } from "@anthropic-ai/claude-agent-sdk";
import type { ModelSelection, ProviderModel, RuntimeMode } from "@orquester/api/agent-chat";

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
export const CLAUDE_RUNTIME_INSTRUCTIONS = [
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
export const RUNTIME_MODE_TO_PERMISSION_MODE: Readonly<
  Record<RuntimeMode, "acceptEdits" | "auto" | "bypassPermissions" | undefined>
> = {
  "approval-required": undefined,
  "auto-accept-edits": "acceptEdits",
  auto: "auto",
  "full-access": "bypassPermissions"
};

/**
 * §4.5's "Never set" list, **verbatim**. It is the spec's list, not a
 * description of the code: editing it to match the code is what would let a
 * regression through the test that reads it.
 */
export const CLAUDE_NEVER_SET_OPTIONS = [
  "hooks",
  "allowedTools",
  "disallowedTools",
  "maxTurns",
  "fallbackModel",
  "agents",
  "stderr",
  "abortController",
  "executable",
  "strictMcpConfig",
  "maxThinkingTokens"
] as const;

/**
 * The one entry of that list this adapter **does** set on a session, and why.
 *
 * §3.1 requires a provider child's stderr to be "captured, not discarded",
 * classified and redacted before it reaches the user or `events.ndjson`; the
 * SDK's `stderr` callback is the only access to the CLI's stderr there is. It
 * is a passive observer — it changes nothing about how the CLI runs — so the
 * §3.1 requirement wins over the §4.5 list, and the deviation is recorded in
 * INTEGRATION-NOTES for the eventual spec amendment.
 *
 * `abortController` and `strictMcpConfig` are likewise set on the **probe**
 * options, which §4.5 explicitly prescribes; the list above governs a session.
 */
export const CLAUDE_SESSION_ALLOWED_DESPITE_SPEC = ["stderr"] as const;

/**
 * A user's launch args, tokenised into SDK `extraArgs`. `permission-mode` and
 * `dangerously-skip-permissions` are **removed** and folded into
 * `permissionMode` instead, because the CLI resolves both inputs together and
 * argv order would otherwise decide which wins.
 */
export function parseClaudeLaunchArgs(args: readonly string[]): {
  extraArgs: Record<string, string | null>;
  permissionMode?: string;
  skipPermissions: boolean;
} {
  const extraArgs: Record<string, string | null> = {};
  let permissionMode: string | undefined;
  let skipPermissions = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith("--")) {
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    const name = eq >= 0 ? body.slice(0, eq) : body;
    let value: string | null = eq >= 0 ? body.slice(eq + 1) : null;
    if (eq < 0) {
      const next = args[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        index += 1;
      }
    }
    if (name === "permission-mode") {
      if (value !== null) {
        permissionMode = value;
      }
      continue;
    }
    if (name === "dangerously-skip-permissions") {
      skipPermissions = value === null || value === "true";
      continue;
    }
    extraArgs[name] = value;
  }

  return {
    extraArgs,
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    skipPermissions
  };
}

export interface BuildClaudeQueryOptionsInput {
  cwd: string;
  /** The registry-resolved `claude`, never the SDK's bundled copy (§10). */
  executablePath: string;
  /** The complete child env, built by `support/env.ts` — never a spread. */
  env: Record<string, string>;
  runtimeMode: RuntimeMode;
  modelSelection?: ModelSelection;
  /** The catalogue the snapshot published, for per-model option gating. */
  models: readonly ProviderModel[];
  /** `[cwd, attachmentsDir]` — the dir pasted images live in (§4.1). */
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
  /** The user's launch args, if the host ever supplies them. */
  launchArgs?: readonly string[];
  /** cliproxy's `autoCompactWindow`, when the launcher env carries one. */
  autoCompactWindow?: number;
}

export interface BuiltClaudeQueryOptions {
  options: ClaudeQueryOptions;
  /**
   * The session's base permission mode, restored after a plan turn. It is the
   * SDK's own union because a user launch arg may name any of them.
   */
  basePermissionMode: NonNullable<ClaudeQueryOptions["permissionMode"]>;
  effort: "low" | "medium" | "high" | "xhigh" | "max" | undefined;
  model: string | undefined;
}

export function buildClaudeQueryOptions(
  input: BuildClaudeQueryOptionsInput
): BuiltClaudeQueryOptions {
  const parsed = parseClaudeLaunchArgs(input.launchArgs ?? []);
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

  // A permission launch arg is folded into the mode rather than passed
  // through: the CLI resolves both inputs together, so argv order must never
  // let the user's flag win by accident.
  const permissionMode =
    (parsed.permissionMode as ClaudeQueryOptions["permissionMode"] | undefined) ??
    (parsed.skipPermissions
      ? ("bypassPermissions" as const)
      : RUNTIME_MODE_TO_PERMISSION_MODE[input.runtimeMode]);

  // Summaries are what §4.2's `reasoning_summary_text` carries; Claude never
  // returns the raw chain of thought.
  const wantsThinkingSummaries =
    thinking !== false && parsed.extraArgs["thinking-display"] !== "omitted";

  const settings: Record<string, unknown> = {
    ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
    ...(wantsThinkingSummaries ? { showThinkingSummaries: true } : {}),
    ...(fastMode === true ? { fastMode: true } : {}),
    // Ultracode is xhigh effort PLUS the setting, exactly as T3's manifest
    // paired them; the SDK requires an xhigh-capable model for it.
    ...(ultracode === true ? { ultracode: true } : {}),
    ...(input.autoCompactWindow !== undefined
      ? { autoCompactWindow: input.autoCompactWindow }
      : {})
  };
  const effectiveEffort = ultracode === true ? ("xhigh" as const) : effort;

  const extraArgs = { ...parsed.extraArgs };
  if (wantsThinkingSummaries && extraArgs["thinking-display"] === undefined) {
    extraArgs["thinking-display"] = "summarized";
  }

  const options: ClaudeQueryOptions = {
    cwd: input.cwd,
    ...(modelSlug !== undefined && modelSlug.length > 0 ? { model: modelSlug } : {}),
    pathToClaudeCodeExecutable: input.executablePath,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: CLAUDE_RUNTIME_INSTRUCTIONS
    },
    settingSources: ["user", "project", "local"],
    ...(effectiveEffort !== undefined ? { effort: effectiveEffort } : {}),
    ...(wantsThinkingSummaries
      ? { thinking: { type: "adaptive" as const, display: "summarized" as const } }
      : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
    ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
    // §4.5: `resume` (cursor uuid) **or** `sessionId` (a fresh v4 uuid), never
    // both — the CLI's behaviour with both is undefined. Enforced here, in the
    // pure module the rows are tested against, rather than only in the caller.
    ...(input.resume !== undefined ? { resume: input.resume } : {}),
    ...(input.resumeSessionAt !== undefined ? { resumeSessionAt: input.resumeSessionAt } : {}),
    ...(input.resume === undefined && input.sessionId !== undefined
      ? { sessionId: input.sessionId }
      : {}),
    includePartialMessages: true,
    canUseTool: input.canUseTool,
    ...(input.onUserDialog !== undefined
      ? { onUserDialog: input.onUserDialog, supportedDialogKinds: ["resume_return"] }
      : {}),
    env: input.env,
    // The attachments grant lets the agent read a pasted image at the path the
    // turn text names, without an approval prompt. It is a leaf directory
    // holding only attachment files.
    additionalDirectories: [input.cwd, input.attachmentsDir],
    // No SDK-registered MCP server: the daemon's terminal-shaped `/mcp` server
    // is out of scope (§2). `strictMcpConfig` stays unset so the user's own
    // `.mcp.json` keeps working.
    mcpServers: {},
    ...(Object.keys(extraArgs).length > 0 ? { extraArgs } : {}),
    ...(input.stderr !== undefined ? { stderr: input.stderr } : {})
  };

  return {
    options,
    basePermissionMode: permissionMode ?? "default",
    effort: effectiveEffort,
    model: modelSlug
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
