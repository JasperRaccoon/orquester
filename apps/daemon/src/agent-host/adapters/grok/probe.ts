/**
 * Grok adapter — the provider snapshot probe (spec §4.1, §4.6.2, §4.6.4).
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/provider/Layers/GrokProvider.ts` and
 * `apps/server/src/provider/Drivers/GrokSkills.ts`.
 *
 * Three steps, **none of which authenticate and none of which open a real
 * session** (§4.1, §6.3):
 *
 * 1. `grok --version` (4 s) — the only step whose failure is fatal.
 * 2. `grok models` (10 s) — its text carries BOTH the model list and the login
 *    sentence, and it exits 0 either way, so the text is the only signal. A
 *    failure here is not fatal; it yields `auth: unknown`.
 * 3. an **`initialize`-only ACP probe** (8 s) that deliberately sends no
 *    `authenticate` and no `session/new`, so it cannot open a browser login or
 *    boot the workspace's MCP servers — `session/new` starts every MCP server
 *    the host has configured (157 tools, ~3 s, discovered from the user's
 *    Claude Code config). Its failure is a **warning**, never an error: Grok
 *    is still usable, only the model metadata is thinner.
 *
 * Skills come from `grok inspect --json`, which beats a filesystem scan
 * because it honours Grok's own ignore lists and reaches plugin skills three
 * levels deep under `installed-plugins/`.
 */

import type {
  ProviderAuth,
  ProviderModel,
  ProviderOptionDescriptor,
  Skill,
  SlashCommand
} from "@orquester/api/agent-chat";

import { AGENT_HOST_DEADLINES } from "../../support/deadline.ts";
import { spawnProviderChild } from "../../support/spawn.ts";
import { AcpConnection } from "./acp/connection.ts";
import type { InitializeResponse } from "./acp/_generated/schema.ts";
import {
  GROK_EFFORT_OPTION_ID,
  GROK_EXTRA_ENV,
  VALIDATED_GROK_VERSION,
  parseGrokVersion
} from "./launch.ts";
import { modelStateOf } from "./xai-meta.ts";

/** Provider commands the host removes from the catalog (§4.6.2). */
export const FILTERED_SLASH_COMMANDS: ReadonlySet<string> = new Set([
  // Permission mode is a host chip; a provider-side change desynchronises it,
  // and `/always-approve off` is additionally a no-op on this CLI.
  "always-approve",
  // Its ACP handler completes in 15 ms with no output at all, so the user
  // would type it and see nothing happen.
  "context"
]);

/** Synthesised by the host on every provider that can serve it (§4.6.3). */
export const COMPACT_SLASH_COMMAND: SlashCommand = {
  name: "compact",
  description: "Summarize the conversation and reduce context usage"
};

export interface ProbeResult {
  installed: boolean;
  version: string | null;
  status: "ready" | "degraded" | "error" | "unknown";
  message?: string;
  auth: ProviderAuth;
  models: ProviderModel[];
  slashCommands: SlashCommand[];
  skills: Skill[];
  /**
   * Which catalogues this run could not read (§4.5: "typed probe errors so a
   * failure never caches an empty catalogue"). A caller MUST keep its previous
   * non-empty list for every entry named here — one timed-out
   * `grok inspect --json` otherwise blanks the Settings card and the composer
   * skill menu until a later refresh happens to succeed (R4 #5).
   */
  unavailable: { models: boolean; skills: boolean; slashCommands: boolean };
}

export interface ProbeDeps {
  /** Absolute path of the resolved `grok` binary, or null when not installed. */
  command: string | null;
  env: Record<string, string>;
  cwd: string;
  clientInfo: { name: string; version: string };
  homeDirs?: readonly string[];
  logger?: { warn(message: string, detail?: unknown): void };
}

interface CommandOutput {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  failed: boolean;
}

/** Run a short-lived child and collect its output under a deadline. */
export async function runCommand(
  command: string,
  args: readonly string[],
  env: Record<string, string>,
  cwd: string,
  timeoutMs: number
): Promise<CommandOutput> {
  const child = spawnProviderChild({ command, args, env, cwd });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    if (stdout.length < 1_000_000) {
      stdout += chunk.toString("utf8");
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < 100_000) {
      stderr += chunk.toString("utf8");
    }
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void child.kill("SIGTERM");
  }, timeoutMs);
  const reason = await child.exited;
  clearTimeout(timer);

  return {
    code: reason.kind === "exit" ? reason.code : null,
    stdout,
    stderr,
    timedOut,
    failed: reason.kind === "spawn-error"
  };
}

// ---------------------------------------------------------------------------
// `grok models`
// ---------------------------------------------------------------------------

/**
 * ```
 * You are logged in with grok.com.
 *
 * Default model: grok-4.6
 *
 * Available models:
 *   * grok-4.6 (default)
 *   - grok-4.5
 * ```
 *
 * `authenticated` is **tri-state**: `true`/`false` when the CLI printed a
 * login line, `null` when it printed neither — and `null` must NOT read as
 * "not logged in", because the command exits 0 regardless.
 */
export function parseGrokModelsOutput(output: string): {
  authenticated: boolean | null;
  models: ProviderModel[];
} {
  const authenticated = /you are logged in/i.test(output)
    ? true
    : /not authenticated|not logged in/i.test(output)
      ? false
      : null;

  const seen = new Set<string>();
  const models: ProviderModel[] = [];
  for (const line of output.split(/\r?\n/)) {
    // Whitespace after the bullet is required, so a `--flag` in help text is
    // not read as a model slug.
    const match = /^\s*[*-]\s+(\S+)(.*)$/.exec(line);
    if (match === null) {
      continue;
    }
    const slug = match[1].trim();
    if (slug.length === 0 || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    models.push({
      slug,
      name: displayNameFromSlug(slug),
      // `(default)` is matched in the trailing remainder only, never inside
      // the slug.
      ...(/\(default\)/i.test(match[2] ?? "") ? { isDefault: true } : {}),
      capabilities: null
    });
  }
  return { authenticated, models };
}

export function displayNameFromSlug(slug: string): string {
  return slug
    .split(/[-_]/)
    .map((part) => (part.toLowerCase() === "grok" ? "Grok" : part))
    .join(" ");
}

// ---------------------------------------------------------------------------
// `initialize._meta`
// ---------------------------------------------------------------------------

/** `_meta.modelState` → the model catalog, with its effort descriptor. */
export function modelsFromInitialize(initialize: InitializeResponse): ProviderModel[] {
  const state = modelStateOf(initialize._meta);
  if (state === null || typeof state !== "object") {
    return [];
  }
  const record = state as Record<string, unknown>;
  const available = record["availableModels"];
  if (!Array.isArray(available)) {
    return [];
  }
  const currentModelId = typeof record["currentModelId"] === "string" ? record["currentModelId"] : undefined;

  const models: ProviderModel[] = [];
  const seen = new Set<string>();
  for (const entry of available) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const model = entry as Record<string, unknown>;
    const slug = typeof model["modelId"] === "string" ? model["modelId"].trim() : "";
    if (slug.length === 0 || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    const name = typeof model["name"] === "string" && model["name"].trim().length > 0 ? model["name"].trim() : slug;
    const descriptors = effortDescriptors(model["_meta"]);
    models.push({
      slug,
      name,
      ...(slug === currentModelId ? { isDefault: true } : {}),
      capabilities: descriptors === null ? null : { optionDescriptors: [descriptors] }
    });
  }
  return models;
}

/**
 * `_meta.reasoningEfforts[]` → the `reasoningEffort` select descriptor. Both
 * `default` and `isDefault` spellings are accepted; 1.0.34 uses `default`.
 */
export function effortDescriptors(meta: unknown): ProviderOptionDescriptor | null {
  if (meta === null || typeof meta !== "object") {
    return null;
  }
  const record = meta as Record<string, unknown>;
  if (record["supportsReasoningEffort"] === false) {
    return null;
  }
  const efforts = record["reasoningEfforts"];
  if (!Array.isArray(efforts) || efforts.length === 0) {
    return null;
  }
  const options: Array<{ id: string; label: string; description?: string; isDefault?: boolean }> = [];
  const seen = new Set<string>();
  for (const entry of efforts) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const effort = entry as Record<string, unknown>;
    const id =
      typeof effort["value"] === "string" && effort["value"].trim().length > 0
        ? effort["value"].trim()
        : typeof effort["id"] === "string"
          ? effort["id"].trim()
          : "";
    if (id.length === 0 || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const label = typeof effort["label"] === "string" && effort["label"].trim().length > 0 ? effort["label"].trim() : id;
    const description = typeof effort["description"] === "string" ? effort["description"].trim() : "";
    const isDefault = effort["default"] === true || effort["isDefault"] === true;
    options.push({
      id,
      label,
      ...(description.length === 0 ? {} : { description }),
      ...(isDefault ? { isDefault: true } : {})
    });
  }
  if (options.length === 0) {
    return null;
  }
  const current = typeof record["reasoningEffort"] === "string" ? record["reasoningEffort"].trim() : "";
  return {
    id: GROK_EFFORT_OPTION_ID,
    label: "Reasoning",
    type: "select",
    options,
    ...(options.some((option) => option.id === current) ? { currentValue: current } : {})
  };
}

/** `_meta.availableCommands` → the machine-level catalog, filtered (§4.6.2). */
export function slashCommandsFromInitialize(initialize: InitializeResponse): SlashCommand[] {
  const meta = initialize._meta as Record<string, unknown> | undefined | null;
  const entries = meta?.["availableCommands"];
  const byName = new Map<string, SlashCommand>([[COMPACT_SLASH_COMMAND.name, COMPACT_SLASH_COMMAND]]);
  if (!Array.isArray(entries)) {
    return [...byName.values()];
  }
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const command = entry as Record<string, unknown>;
    const name = typeof command["name"] === "string" ? command["name"].trim() : "";
    if (name.length === 0 || FILTERED_SLASH_COMMANDS.has(name.toLowerCase())) {
      continue;
    }
    const description = typeof command["description"] === "string" ? command["description"].trim() : "";
    const input = command["input"];
    const hint =
      input !== null && typeof input === "object" && typeof (input as Record<string, unknown>)["hint"] === "string"
        ? ((input as Record<string, unknown>)["hint"] as string)
        : undefined;
    byName.set(name, {
      name,
      ...(description.length === 0 ? {} : { description }),
      ...(hint === undefined ? {} : { input: { hint } })
    });
  }
  return [...byName.values()];
}

// ---------------------------------------------------------------------------
// `grok inspect --json`
// ---------------------------------------------------------------------------

/**
 * Skips a row with no `name` or no `source.path` — without a filesystem path
 * a skill has no source badge and nothing to open. `userInvocable: false` rows
 * are **kept but marked disabled**, so a picker filtering on `enabled` hides
 * them while other surfaces can still see that they exist.
 */
export function parseGrokInspectSkills(stdout: string): Skill[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") {
    return null;
  }
  const entries = (parsed as Record<string, unknown>)["skills"];
  if (!Array.isArray(entries)) {
    return null;
  }
  const byName = new Map<string, Skill>();
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record["name"] === "string" ? record["name"].trim() : "";
    const source = record["source"];
    const sourceRecord = source !== null && typeof source === "object" ? (source as Record<string, unknown>) : undefined;
    const path = typeof sourceRecord?.["path"] === "string" ? (sourceRecord["path"] as string).trim() : "";
    if (name.length === 0 || path.length === 0) {
      continue;
    }
    const scope = typeof sourceRecord?.["type"] === "string" ? (sourceRecord["type"] as string).trim() : "";
    const description = typeof record["description"] === "string" ? record["description"].trim() : "";
    byName.set(name, {
      name,
      path,
      // `!== false` so a MISSING field means enabled. `compatibilityStatus`
      // is Grok's own vendor-compat verdict and disables the row too.
      enabled: record["userInvocable"] !== false && record["compatibilityStatus"] !== "disabled",
      ...(record["userInvocable"] === false ? { userInvocable: false } : {}),
      ...(scope.length === 0 ? {} : { scope }),
      ...(description.length === 0 ? {} : { description })
    });
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

export async function probeGrok(deps: ProbeDeps): Promise<ProbeResult> {
  const notInstalled: ProbeResult = {
    installed: false,
    version: null,
    status: "error",
    message: "Grok CLI (`grok`) is not installed or not on PATH.",
    auth: { status: "unknown" },
    models: [],
    slashCommands: [COMPACT_SLASH_COMMAND],
    skills: [],
    // A binary that is genuinely absent has no catalogue to keep; that is a
    // fact about the host, not a failed read.
    unavailable: { models: false, skills: false, slashCommands: false }
  };
  if (deps.command === null) {
    return notInstalled;
  }

  const env = { ...deps.env, ...GROK_EXTRA_ENV };

  // 1. version — the one fatal step.
  const versionOut = await runCommand(deps.command, ["--version"], env, deps.cwd, AGENT_HOST_DEADLINES.probeMs);
  if (versionOut.failed) {
    return notInstalled;
  }
  if (versionOut.timedOut) {
    return {
      ...notInstalled,
      installed: true,
      message: "Grok CLI is installed but timed out while running `grok --version`.",
      // A timeout IS a failed read: keep whatever the card already showed.
      unavailable: { models: true, skills: true, slashCommands: true }
    };
  }
  const version = parseGrokVersion(`${versionOut.stdout}\n${versionOut.stderr}`);
  if (versionOut.code !== 0) {
    return {
      ...notInstalled,
      installed: true,
      version,
      message: "Grok CLI is installed but failed to run.",
      unavailable: { models: true, skills: true, slashCommands: true }
    };
  }

  // 2. models + login state. Only a CLEAN exit is parsed: a failed invocation
  //    prints help or error text that must not be read as model slugs or as a
  //    login verdict.
  const modelsOut = await runCommand(deps.command, ["models"], env, deps.cwd, AGENT_HOST_DEADLINES.authProbeMs);
  const cli =
    !modelsOut.failed && !modelsOut.timedOut && modelsOut.code === 0
      ? parseGrokModelsOutput(modelsOut.stdout)
      : { authenticated: null as boolean | null, models: [] as ProviderModel[] };

  // 3. the initialize-only ACP probe.
  let acpModels: ProviderModel[] = [];
  let acpCommands: SlashCommand[] | null = null;
  let acpFailed = false;
  try {
    const initialize = await probeInitialize(deps.command, env, deps);
    acpModels = modelsFromInitialize(initialize);
    acpCommands = slashCommandsFromInitialize(initialize);
  } catch (error) {
    acpFailed = true;
    deps.logger?.warn("grok: ACP initialize probe failed", {
      error: error instanceof Error ? error.message : String(error)
    });
  }

  const probedSkills = await probeSkills(deps.command, env, deps.cwd);
  const skills = probedSkills ?? [];

  const auth: ProviderAuth =
    cli.authenticated === true
      ? { status: "authenticated", type: "cached_token", label: "Grok account" }
      : cli.authenticated === false
        ? { status: "unauthenticated" }
        : { status: "unknown" };

  const models = acpModels.length > 0 ? acpModels : cli.models;
  const unavailable = {
    models: models.length === 0,
    skills: probedSkills === null,
    slashCommands: acpCommands === null
  };

  if (cli.authenticated === false) {
    return {
      installed: true,
      version,
      status: "error",
      message: "Grok CLI is installed but not logged in. Run `grok login`.",
      auth,
      models,
      slashCommands: acpCommands ?? [COMPACT_SLASH_COMMAND],
      skills,
      unavailable
    };
  }

  return {
    installed: true,
    version,
    // A failed metadata probe degrades the model picker; it does not make
    // chats fail.
    status: acpFailed ? "degraded" : "ready",
    ...(acpFailed
      ? { message: "Grok CLI is installed but ACP initialize failed. Model options may be incomplete." }
      : version !== null && version !== VALIDATED_GROK_VERSION
        ? {
            message: `Grok ${version} differs from the version this adapter was validated against (${VALIDATED_GROK_VERSION}).`
          }
        : {}),
    auth,
    models,
    slashCommands: acpCommands ?? [COMPACT_SLASH_COMMAND],
    skills,
    unavailable
  };
}

async function probeInitialize(
  command: string,
  env: Record<string, string>,
  deps: ProbeDeps
): Promise<InitializeResponse> {
  const connection = AcpConnection.spawn({
    command,
    // No runtime mode: the probe inherits whatever the CLI config says and
    // never expresses a permission posture of its own.
    args: ["agent", "stdio"],
    env,
    cwd: deps.cwd,
    clientInfo: deps.clientInfo,
    homeDirs: deps.homeDirs,
    handshakeTimeoutMs: 8_000,
    onWarning: (message, detail) => deps.logger?.warn(message, detail)
  });
  try {
    // `skipAuthenticate` is the whole point: the probe must never be able to
    // open a browser login.
    return await connection.handshake({ skipAuthenticate: true });
  } finally {
    await connection.stop();
  }
}

/**
 * Per-cwd when a cwd is given — only SKILLS are re-scoped for Grok (§4.6.4).
 *
 * `null` means **the catalogue could not be read**, which is a different thing
 * from "this directory has no skills"; the caller keeps whatever it had.
 */
export async function probeSkills(
  command: string,
  env: Record<string, string>,
  cwd: string
): Promise<Skill[] | null> {
  const output = await runCommand(command, ["inspect", "--json"], env, cwd, AGENT_HOST_DEADLINES.probeMs);
  if (output.failed || output.timedOut || output.code !== 0) {
    return null;
  }
  return parseGrokInspectSkills(output.stdout);
}
