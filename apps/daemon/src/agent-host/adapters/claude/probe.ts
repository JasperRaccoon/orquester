/**
 * Claude adapter — the capability probe and the provider snapshot
 * (spec §4.1, §4.5 "Probe", §4.6.2, §3.2 "snapshots refresh on a slow
 * interval").
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/provider/Layers/ClaudeProvider.ts:172-401`
 * (the never-yielding prompt generator, the probe options and the command
 * dedupe), translated from Effect into plain promises.
 *
 * **The probe never authenticates and never opens a real session.** The prompt
 * async-generator never yields, so the CLI finishes its local initialisation
 * IPC and never starts an API request; the adapter then reads
 * `initializationResult()` and aborts the child. Usage has its own deadline so
 * a slow optional call cannot discard the initialisation that already
 * succeeded.
 */

import type { Query, SlashCommand as SdkSlashCommand } from "@anthropic-ai/claude-agent-sdk";
import type {
  AdapterCapabilities,
  ProviderAuth,
  ProviderSnapshot,
  SlashCommand,
  WorkspaceSnapshot
} from "@orquester/api/agent-chat";

import { AGENT_HOST_DEADLINES, withDeadline } from "../../support/deadline.ts";
import type { ClaudeAdapterDeps } from "./deps.ts";
import { buildClaudeProbeOptions } from "./launch.ts";
import {
  FALLBACK_CLAUDE_MODELS,
  MINIMUM_CLAUDE_CLI_VERSION,
  meetsMinimumClaudeVersion,
  parseClaudeVersion,
  toProviderModels
} from "./models.ts";
import { discoverClaudeSkills } from "./skills.ts";
import { usageResponseToLimits, type ClaudeScopedLimitNames } from "./usage.ts";

/** Bedrock initialises far slower than first-party auth (T3's 25 s budget). */
export const CLAUDE_PROBE_TIMEOUT_MS = 25_000;
/** The usage call took 8.9 s in the capture, even with the behaviour scan on. */
export const CLAUDE_USAGE_PROBE_TIMEOUT_MS = 20_000;
/** `binaryPath\0configDir\0cwd` for this long (§4.5). */
export const CLAUDE_PROBE_CACHE_MS = 5 * 60_000;

/** The registry ids this one adapter serves (§4.1 `refIds`). */
export const CLAUDE_REF_IDS = ["claude", "claudex", "claudemix"] as const;

/** §4.1. Claude switches model in session and compacts with a slash command. */
export const CLAUDE_CAPABILITIES: AdapterCapabilities = {
  sessionModelSwitch: "in-session",
  supportsConversationRollback: true,
  showPlanModeToggle: true,
  reportsContextWindow: true,
  compaction: { type: "slash-command", command: "/compact" }
};

export interface ClaudeProbeResult {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  apiProvider?: string;
  slashCommands: SlashCommand[];
  models: unknown;
  usage?: unknown;
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Case-insensitive dedupe, first wins, with a missing description or hint
 * filled in from the loser.
 */
export function dedupeSlashCommands(commands: readonly SlashCommand[]): SlashCommand[] {
  const byName = new Map<string, SlashCommand>();
  for (const command of commands) {
    const name = nonEmpty(command.name);
    if (name === undefined) {
      continue;
    }
    const key = name.toLowerCase();
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, { ...command, name });
      continue;
    }
    byName.set(key, {
      ...existing,
      ...(existing.description === undefined && command.description !== undefined
        ? { description: command.description }
        : {}),
      ...(existing.input?.hint === undefined && command.input?.hint !== undefined
        ? { input: { hint: command.input.hint } }
        : {})
    });
  }
  return [...byName.values()];
}

export function parseInitializationCommands(commands: unknown): SlashCommand[] {
  if (!Array.isArray(commands)) {
    return [];
  }
  const parsed: SlashCommand[] = [];
  for (const entry of commands as SdkSlashCommand[]) {
    const name = nonEmpty(entry?.name);
    if (name === undefined) {
      continue;
    }
    const description = nonEmpty(entry?.description);
    const hint = nonEmpty((entry as { argumentHint?: unknown } | undefined)?.argumentHint);
    parsed.push({
      name,
      ...(description !== undefined ? { description } : {}),
      ...(hint !== undefined ? { input: { hint } } : {})
    });
  }
  return dedupeSlashCommands(parsed);
}

/**
 * §4.6.3: `/compact` is a host route with no CLI equivalent on this surface,
 * so it is synthesised for every provider that can serve it. It is prepended
 * and deduped, so a CLI that ever advertises its own `/compact` wins.
 */
export function withSynthesisedCommands(commands: readonly SlashCommand[]): SlashCommand[] {
  return dedupeSlashCommands([
    ...commands,
    {
      name: "compact",
      description: "Compact this conversation's context.",
      input: { hint: "[instructions]" }
    }
  ]);
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Open a never-yielding `query()` and read everything the CLI can answer
 * locally. Returns `undefined` when the probe itself failed.
 */
export async function probeClaudeCapabilities(input: {
  deps: Pick<ClaudeAdapterDeps, "query">;
  executablePath: string;
  env: Record<string, string>;
  cwd?: string;
  onStderr?: (data: string) => void;
}): Promise<ClaudeProbeResult | undefined> {
  const abort = new AbortController();
  let session: Query | undefined;
  try {
    const q = input.deps.query({
      // Never yields: this is what stops any prompt reaching the API.
      prompt: (async function* neverYields(): AsyncGenerator<never> {
        await waitForAbort(abort.signal);
      })(),
      options: buildClaudeProbeOptions({
        executablePath: input.executablePath,
        env: input.env,
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        abortController: abort,
        ...(input.onStderr !== undefined ? { stderr: input.onStderr } : {})
      })
    });
    session = q;

    const init = await withDeadline(q.initializationResult(), {
      label: "claude/probe/initializationResult",
      timeoutMs: CLAUDE_PROBE_TIMEOUT_MS,
      onTimeout: () => abort.abort()
    });

    const account = (init as { account?: unknown }).account as
      | {
          email?: unknown;
          organization?: unknown;
          subscriptionType?: unknown;
          apiProvider?: unknown;
        }
      | undefined;

    // `initializationResult()` already carries the model list; `supportedModels()`
    // is the fallback for a CLI that does not put it there.
    let models: unknown = (init as { models?: unknown }).models;
    if (!Array.isArray(models) || models.length === 0) {
      models = await withDeadline(q.supportedModels(), {
        label: "claude/probe/supportedModels",
        timeoutMs: AGENT_HOST_DEADLINES.probeMs
      }).catch(() => []);
    }

    // `skipBehaviors` skips the scan of local transcripts that dominated the
    // 8.9 s the capture measured; the plan rate limits are all this needs.
    const usage = await withDeadline(
      q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
      { label: "claude/probe/usage", timeoutMs: CLAUDE_USAGE_PROBE_TIMEOUT_MS }
    ).catch(() => undefined);

    return {
      ...(nonEmpty(account?.email) !== undefined ? { email: nonEmpty(account?.email)! } : {}),
      ...(nonEmpty(account?.organization) !== undefined
        ? { organization: nonEmpty(account?.organization)! }
        : {}),
      ...(nonEmpty(account?.subscriptionType) !== undefined
        ? { subscriptionType: nonEmpty(account?.subscriptionType)! }
        : {}),
      ...(nonEmpty(account?.apiProvider) !== undefined
        ? { apiProvider: nonEmpty(account?.apiProvider)! }
        : {}),
      slashCommands: parseInitializationCommands((init as { commands?: unknown }).commands),
      models,
      ...(usage !== undefined ? { usage } : {})
    };
  } catch {
    return undefined;
  } finally {
    if (!abort.signal.aborted) {
      abort.abort();
    }
    try {
      session?.close();
    } catch {
      // The abort above is what ends the child; a close that races it is fine.
    }
  }
}

/** `claude --version`, through the same explicit-env spawn every child uses. */
export async function probeClaudeVersion(input: {
  deps: Pick<ClaudeAdapterDeps, "spawn">;
  executablePath: string;
  env: Record<string, string>;
  cwd: string;
}): Promise<string | null> {
  const child = input.deps.spawn({
    command: input.executablePath,
    args: ["--version"],
    env: input.env,
    cwd: input.cwd
  });
  let out = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    out += chunk;
  });
  const reason = await withDeadline(child.exited, {
    label: "claude/probe/version",
    timeoutMs: AGENT_HOST_DEADLINES.probeMs,
    onTimeout: () => {
      void child.kill();
    }
  }).catch(() => null);
  if (reason === null || reason.kind !== "exit" || reason.code !== 0) {
    return null;
  }
  return parseClaudeVersion(out);
}

export interface BuildSnapshotInput {
  checkedAt: string;
  binaryPath: string | null;
  version: string | null;
  probe: ClaudeProbeResult | undefined;
  cwd?: string;
  configDir?: string;
  /** Workspace overlays already collected for other cwds (§4.6.4). */
  workspaceSnapshots?: WorkspaceSnapshot[];
}

export function buildClaudeAuth(probe: ClaudeProbeResult | undefined): ProviderAuth {
  if (!probe) {
    return { status: "unknown" };
  }
  if (probe.email === undefined && probe.subscriptionType === undefined) {
    return {
      status: "unauthenticated",
      ...(probe.apiProvider !== undefined ? { type: probe.apiProvider } : {})
    };
  }
  return {
    status: "authenticated",
    ...(probe.apiProvider !== undefined ? { type: probe.apiProvider } : {}),
    ...(probe.subscriptionType !== undefined ? { label: probe.subscriptionType } : {}),
    ...(probe.email !== undefined ? { email: probe.email } : {})
  };
}

/** Assemble the §4.1 snapshot from one probe. */
export function buildClaudeSnapshot(input: BuildSnapshotInput): {
  snapshot: ProviderSnapshot;
  scopedLimitNames: ClaudeScopedLimitNames;
} {
  const installed = input.binaryPath !== null;
  const versionOk = meetsMinimumClaudeVersion(input.version);
  const usage =
    input.probe?.usage !== undefined
      ? usageResponseToLimits({ response: input.probe.usage, checkedAt: input.checkedAt })
      : undefined;

  const models = input.probe ? toProviderModels(input.probe.models) : [];
  const status: ProviderSnapshot["status"] = !installed
    ? "error"
    : !versionOk
      ? "degraded"
      : input.probe === undefined
        ? "degraded"
        : "ready";
  const message = !installed
    ? "The claude CLI is not installed. Install it from Settings → Agents."
    : !versionOk
      ? `Claude CLI ${input.version ?? "(unknown)"} is below the ${MINIMUM_CLAUDE_CLI_VERSION} Orquester chat requires.`
      : input.probe === undefined
        ? "Could not read the Claude CLI's capabilities. Chat will still try to start a session."
        : undefined;

  const snapshot: ProviderSnapshot = {
    id: "claude",
    refIds: [...CLAUDE_REF_IDS],
    installed,
    version: input.version,
    status,
    ...(message !== undefined ? { message } : {}),
    auth: buildClaudeAuth(input.probe),
    checkedAt: input.checkedAt,
    models: models.length > 0 ? models : [...FALLBACK_CLAUDE_MODELS],
    slashCommands: withSynthesisedCommands(input.probe?.slashCommands ?? []),
    skills: [],
    ...(input.workspaceSnapshots !== undefined && input.workspaceSnapshots.length > 0
      ? { workspaceSnapshots: input.workspaceSnapshots }
      : {}),
    ...(usage !== undefined ? { usageLimits: usage.limits } : {}),
    versionAdvisory: {
      status: input.version === null ? "unknown" : versionOk ? "current" : "behind_latest",
      currentVersion: input.version,
      latestVersion: null,
      updateCommand: "npm install -g @anthropic-ai/claude-code",
      canUpdate: true,
      checkedAt: input.checkedAt,
      message: versionOk ? null : (message ?? null)
    },
    capabilities: CLAUDE_CAPABILITIES
  };

  return { snapshot, scopedLimitNames: usage?.names ?? {} };
}

/**
 * The per-cwd overlay of §4.6.4. Only **skills** are re-scoped for Claude: its
 * command list is machine-level, already merged by the CLI.
 */
export async function buildClaudeWorkspaceSnapshot(input: {
  cwd: string;
  configDir: string;
  checkedAt: string;
}): Promise<WorkspaceSnapshot> {
  const skills = await discoverClaudeSkills({ configDir: input.configDir, cwd: input.cwd });
  return {
    cwd: input.cwd,
    checkedAt: input.checkedAt,
    // Machine-level; the overlay carries an empty list so a merge never blanks
    // the snapshot's own commands (§4.6.4 "a probe that comes back empty never
    // blanks a non-empty cached list").
    slashCommands: [],
    skills
  };
}

/** At most 16 cwds are retained per provider, oldest evicted (§4.6.4). */
export const MAX_WORKSPACE_SNAPSHOTS = 16;

export function mergeWorkspaceSnapshot(
  existing: readonly WorkspaceSnapshot[],
  next: WorkspaceSnapshot
): WorkspaceSnapshot[] {
  const previous = existing.find((entry) => entry.cwd === next.cwd);
  // A probe that comes back empty never blanks a non-empty cached list.
  const merged: WorkspaceSnapshot =
    previous !== undefined && next.skills.length === 0 && previous.skills.length > 0
      ? { ...next, skills: previous.skills }
      : next;
  const without = existing.filter((entry) => entry.cwd !== next.cwd);
  return [...without, merged].slice(-MAX_WORKSPACE_SNAPSHOTS);
}
