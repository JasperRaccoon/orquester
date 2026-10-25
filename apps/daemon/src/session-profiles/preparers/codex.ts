/**
 * Agent Profiles — Codex's preparer (spec §6.0, §6.2): one prepared `CODEX_HOME` per (account,
 * profile), built in the staging dir and published as an immutable version (`../lifecycle.ts`).
 *
 * Layout of the prepared home (the version dir `ctx.preparedDir`):
 *
 *   auth.json      → SYMLINK to the account home's `auth.json` (System: the system `CODEX_HOME`'s).
 *                    Never copied; Codex's own token refresh writes THROUGH it (verified, §6.2).
 *   sessions       → SYMLINK to the account's `sessions/` (which links to the shared one): history,
 *                    usage scans and resume see every profile's rollouts. Placed only after the
 *                    state DB was seeded against an EMPTY real `sessions/` (`seedCodexHome`).
 *   config.toml    the Global `config.toml` minus its item keys (`codexRuntimeConfig`, §6.0: model,
 *                  approvals, sandbox, `projects.*` trust, `notify`, … carry over) plus the recipe:
 *                  `[features] apps = false, remote_plugin = false` (+ `plugins = false` without a
 *                  Codex plugin item), `[skills.bundled] enabled = false` when built-ins are hidden,
 *                  the profile's `[mcp_servers]`, `[plugins."<name>@<marketplace>"] enabled = true`,
 *                  and `[hooks.state]` trust for every hook keyed by THIS home's `hooks.json`
 *                  (`ctx.preparedDir`, the path Codex opens it from). 0600: MCP secrets.
 *   AGENTS.md      the profile's instructions (absent when it has none).
 *   skills/<name>/ the profile's skills, and its commands converted to skills (`git/pr` → `git-pr`,
 *                  `agent-profile/convert.ts`'s `commandToSkillDocument`).
 *   hooks.json     the profile's Codex hooks, then Orquester's managed status hooks (`agent-hooks.ts`,
 *                  the same groups account homes get).
 *   plugins/cache/<marketplace>/<name>/<version|local>/  each profile Codex plugin, copied whole.
 *   state_5.sqlite (…)  Codex's state DB, seeded by one `codex app-server` `initialize`.
 *   .personality_migration, .sandbox_migration  copied from the system home when present (as account
 *                  homes do), so Codex runs no one-time config migration in here.
 *
 * Seeding runs in the staging dir: the state DB it creates records no path of its home (checked on
 * codex-cli 0.159.0: after a seed the DBs hold only migrations, the backfill state and a default
 * section), so the rename to the version dir keeps it valid, and nothing can launch on the home
 * before its first `initialize` returned (it is not published yet). `auth.json` is linked AFTER the
 * seed, so preparation never runs Codex with the account's login.
 *
 * Per thread (not here): the adapter switches off every skill Codex reads from `$HOME/.agents/skills`
 * (`skills.config`, re-sent at every `thread/resume`), see `agent-host/adapters/codex/profile.ts`.
 */

import { copyFile, lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify as stringifyToml } from "@decimalturn/toml-patch";
import type { McpServerDraft } from "@orquester/api";
import { daemonConfigDir } from "@orquester/config";
import { eventSnake, codexHookHash, stateKey, type CodexHookHandler } from "../../agent-profile/adapters/codex/hooks.ts";
import { mcpEntryFromDraft } from "../../agent-profile/adapters/codex/mcp.ts";
import { parseToml } from "../../agent-profile/adapters/grok/toml-patch.ts";
import { commandToSkillDocument } from "../../agent-profile/convert.ts";
import { copyTree, isValidSkillName, parseMarkdownDocument, serializeMarkdownDocument } from "../../agent-profile/infra/index.ts";
import { CODEX_MANAGED_HOOK_EVENTS, agentHookScriptPath, codexManagedHookGroup, ensureAgentHookScript } from "../../agent-hooks.ts";
import { CODEX_STATE_DB_FILE, codexRuntimeConfig, codexStateDbPresent, seedCodexHome } from "../../agent-isolation/index.ts";
import type { CodexPreparedSection } from "../manifest/codex.ts";
import type { SessionProfilePrepareContext, SessionProfilePreparer } from "../preparer.ts";
import type { ResolvedHook, ResolvedMcpServer } from "../resolve.ts";

/** Bump when the prepared home changes for the same inputs. */
const CODEX_PREPARER_VERSION = "1";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
/** Codex's one-time migration markers; account homes copy them from the system home too. */
const MIGRATION_MARKERS = [".personality_migration", ".sandbox_migration"] as const;
/** A plugin's marketplace, name or version as one path segment. */
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

type Doc = Record<string, unknown>;
type CodexPrepareContext = SessionProfilePrepareContext<"codex">;

/** The Global `config.toml` every prepared home carries over from (§6.0); `inputs()` names it. */
function codexGlobalConfigPath(ctx: Pick<CodexPrepareContext, "systemHomes">): string {
  return join(ctx.systemHomes.codexHome, "config.toml");
}

/** The roots Codex reads user skills (and plugin marketplaces) from outside `CODEX_HOME`. */
export function codexUserSkillRoots(home: string): string[] {
  return [join(home, ".agents", "skills"), join(home, ".agents", "plugins")];
}

export const codexPreparer: SessionProfilePreparer<"codex"> = {
  agent: "codex",
  perAccount: true,
  version: CODEX_PREPARER_VERSION,
  inputs: (ctx) => [codexGlobalConfigPath(ctx)],
  prepare: prepareCodexHome,
  validate: validateCodexHome,
  async unusableReason(preparedDir) {
    return (await codexStateDbPresent(preparedDir)) ? null : `its Codex state DB (${CODEX_STATE_DB_FILE}) is missing`;
  }
};

async function prepareCodexHome(ctx: CodexPrepareContext): Promise<CodexPreparedSection> {
  const { resolved, stagingDir: home } = ctx;
  if (ctx.accountHome === null) {
    throw new Error("Codex profile homes are per account, but no account home was given.");
  }
  if (!ctx.cliBin) {
    throw new Error("Codex is not installed (no codex binary was found), so its profile home cannot be seeded.");
  }

  const skills = await writeSkills(ctx);
  const plugins = await copyPlugins(ctx);
  const hooks = await writeHooks(ctx);
  const mcpServers = buildMcpServers(ctx);
  const config = await buildConfig(ctx, { mcpServers, plugins: plugins.ids, hookState: hooks.state });
  await writeFile(join(home, "config.toml"), stringifyToml(config, { inlineTableStart: 2 }), { mode: FILE_MODE });
  if (resolved.instructions.trim().length > 0) {
    await writeFile(join(home, "AGENTS.md"), resolved.instructions, { mode: FILE_MODE });
  }
  for (const marker of MIGRATION_MARKERS) {
    await copyFile(join(ctx.systemHomes.codexHome, marker), join(home, marker)).catch(() => undefined);
  }

  // Seed the state DB against an empty real `sessions/`, then link it (spec §6.2 "Index seeding").
  await seedCodexHome({
    codexHome: home,
    sessionsTarget: await sessionsTarget(ctx),
    codexBin: ctx.cliBin,
    env: seedEnv(ctx)
  });
  // Only now the login: preparation never ran Codex with it.
  await symlink(join(ctx.accountHome, "auth.json"), join(home, "auth.json"));

  for (const skipped of resolved.skipped) {
    ctx.logger.info(`Agent Profiles: profile ${resolved.profileId} leaves ${skipped.name ?? skipped.itemId ?? "an item"} out for Codex: ${skipped.reason}`);
  }
  return {
    stateDbFile: CODEX_STATE_DB_FILE,
    hideBuiltinSkills: resolved.settings.hideBuiltinSkills,
    skills,
    mcpServers: Object.keys(mcpServers),
    plugins: plugins.ids,
    hooks: resolved.hooks.length,
    userSkillRoots: codexUserSkillRoots(ctx.systemHomes.home)
  };
}

/** The finished staging dir is a seeded, linked home (the lifecycle's `validate` step, §6.5). */
async function validateCodexHome(ctx: CodexPrepareContext): Promise<void> {
  const home = ctx.stagingDir;
  if (!(await codexStateDbPresent(home))) {
    throw new Error(`The Codex profile home was not seeded (${CODEX_STATE_DB_FILE} is missing).`);
  }
  for (const name of ["sessions", "auth.json"]) {
    const st = await lstat(join(home, name)).catch(() => null);
    if (!st?.isSymbolicLink()) {
      throw new Error(`The Codex profile home's ${name} is not a link to the account's.`);
    }
  }
}

// ---------------------------------------------------------------------------
// config.toml
// ---------------------------------------------------------------------------

async function readGlobalConfig(ctx: CodexPrepareContext): Promise<Doc> {
  const path = codexGlobalConfigPath(ctx);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`The Global Codex config.toml could not be read (${(error as NodeJS.ErrnoException).code ?? "error"}).`);
  }
  try {
    return parseToml(text);
  } catch (error) {
    throw new Error(`The Global Codex config.toml does not parse: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isTable(value: unknown): value is Doc {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/** The runtime settings of Global (§6.0) with the recipe's keys over them — the recipe wins. */
async function buildConfig(
  ctx: CodexPrepareContext,
  parts: { mcpServers: Record<string, Doc>; plugins: string[]; hookState: Record<string, Doc> }
): Promise<Doc> {
  const config = codexRuntimeConfig(await readGlobalConfig(ctx));
  const features: Doc = isTable(config.features) ? { ...config.features } : {};
  // Without these the account's remote plugins (skills and a 106-tool MCP server) and its ChatGPT
  // apps download into the profile home (spec §6.2).
  features.apps = false;
  features.remote_plugin = false;
  if (parts.plugins.length === 0) features.plugins = false;
  else delete features.plugins;
  config.features = features;
  if (ctx.resolved.settings.hideBuiltinSkills) {
    config.skills = { bundled: { enabled: false } };
  }
  if (Object.keys(parts.mcpServers).length > 0) config.mcp_servers = parts.mcpServers;
  if (parts.plugins.length > 0) {
    config.plugins = Object.fromEntries(parts.plugins.map((id) => [id, { enabled: true }]));
  }
  if (Object.keys(parts.hookState).length > 0) config.hooks = { state: parts.hookState };
  return config;
}

/** `[mcp_servers.<name>]` per profile server, through Agent config's Codex mapper. A server it refuses is left out (logged). */
function buildMcpServers(ctx: CodexPrepareContext): Record<string, Doc> {
  const out: Record<string, Doc> = {};
  for (const server of ctx.resolved.mcpServers) {
    const entry = mcpEntry(server, true) ?? mcpEntry(server, false);
    if (entry === null) {
      ctx.logger.warn(`Agent Profiles: profile ${ctx.resolved.profileId} leaves MCP server "${server.name}" out for Codex: Codex cannot express it.`);
      continue;
    }
    out[server.name] = entry;
  }
  return out;
}

function mcpEntry(server: ResolvedMcpServer, withAdvanced: boolean): Doc | null {
  const draft: McpServerDraft = {
    name: server.name,
    transport: server.transport,
    ...(server.command !== undefined ? { command: server.command } : {}),
    ...(server.args !== undefined ? { args: server.args } : {}),
    ...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
    ...(server.url !== undefined ? { url: server.url } : {}),
    env: Object.entries(server.env).map(([key, value]) => ({ key, value })),
    headers: Object.entries(server.headers).map(([key, value]) => ({ key, value })),
    ...(withAdvanced ? { advanced: server.advanced } : {})
  };
  try {
    return mcpEntryFromDraft(draft, undefined);
  } catch {
    // Never quote the error: a draft carries secret values.
    return null;
  }
}

// ---------------------------------------------------------------------------
// skills/ (skills + commands as skills)
// ---------------------------------------------------------------------------

async function writeSkills(ctx: CodexPrepareContext): Promise<string[]> {
  const root = join(ctx.stagingDir, "skills");
  await mkdir(root, { mode: DIR_MODE });
  const names = new Set<string>();
  for (const skill of ctx.resolved.skills) {
    if (!isValidSkillName(skill.name) || names.has(skill.name)) {
      ctx.logger.warn(`Agent Profiles: profile ${ctx.resolved.profileId} skips skill "${skill.name}" for Codex: invalid or duplicate name.`);
      continue;
    }
    await copyTree(skill.dir, join(root, skill.name), { refuseSymlinks: false });
    names.add(skill.name);
  }
  for (const command of ctx.resolved.commands) {
    const document = parseMarkdownDocument(await readFile(command.file, "utf8"));
    const skill = commandToSkillDocument(command.name, document.frontmatter);
    if (!isValidSkillName(skill.skillName) || names.has(skill.skillName)) {
      ctx.logger.warn(
        `Agent Profiles: profile ${ctx.resolved.profileId} skips command "${command.name}" for Codex: its skill name "${skill.skillName}" is invalid or taken.`
      );
      continue;
    }
    const dir = join(root, skill.skillName);
    await mkdir(dir, { mode: DIR_MODE });
    await writeFile(join(dir, "SKILL.md"), serializeMarkdownDocument(skill.frontmatter, document.body), { mode: FILE_MODE });
    names.add(skill.skillName);
  }
  return [...names];
}

// ---------------------------------------------------------------------------
// plugins/cache
// ---------------------------------------------------------------------------

async function copyPlugins(ctx: CodexPrepareContext): Promise<{ ids: string[] }> {
  const ids: string[] = [];
  for (const plugin of ctx.resolved.plugins) {
    const marketplace = plugin.marketplace;
    const version = plugin.version ?? "local";
    if (!marketplace || ![marketplace, plugin.name, version].every((segment) => SEGMENT_RE.test(segment) && segment !== "..")) {
      ctx.logger.warn(
        `Agent Profiles: profile ${ctx.resolved.profileId} leaves plugin "${plugin.name}" out for Codex: it needs a marketplace and plain name/version to be enabled.`
      );
      continue;
    }
    const id = `${plugin.name}@${marketplace}`;
    if (ids.includes(id)) continue;
    await mkdir(join(ctx.stagingDir, "plugins", "cache", marketplace, plugin.name), { recursive: true, mode: DIR_MODE });
    await copyTree(plugin.cacheDir, join(ctx.stagingDir, "plugins", "cache", marketplace, plugin.name, version), { refuseSymlinks: false });
    ids.push(id);
  }
  return { ids };
}

// ---------------------------------------------------------------------------
// hooks.json + hooks.state trust
// ---------------------------------------------------------------------------

interface HookGroup {
  matcher?: string;
  hooks: CodexHookHandler[];
}

/**
 * `hooks.json`: per event the profile's hooks (one group each, in order), then Orquester's managed
 * group — as account homes have them. Every handler gets its `[hooks.state."<key>"]` trust entry,
 * keyed by `<ctx.preparedDir>/hooks.json` (the path Codex opens it from once published).
 */
async function writeHooks(ctx: CodexPrepareContext): Promise<{ state: Record<string, Doc> }> {
  const daemonDir = daemonConfigDir(ctx.appdir);
  await ensureAgentHookScript(daemonDir);
  const scriptPath = agentHookScriptPath(daemonDir);
  const events: Record<string, HookGroup[]> = {};
  for (const hook of ctx.resolved.hooks) {
    (events[hook.event] ??= []).push(profileHookGroup(hook));
  }
  for (const event of CODEX_MANAGED_HOOK_EVENTS) {
    (events[event.name] ??= []).push(codexManagedHookGroup(scriptPath, event));
  }
  const hooksPath = join(ctx.preparedDir, "hooks.json");
  const state: Record<string, Doc> = {};
  for (const [event, groups] of Object.entries(events)) {
    const snake = eventSnake(event);
    groups.forEach((group, groupIndex) => {
      group.hooks.forEach((handler, handlerIndex) => {
        const hash = codexHookHash(snake, handler, group.matcher);
        if (hash !== null) state[stateKey(hooksPath, { eventSnake: snake, groupIndex, handlerIndex })] = { enabled: true, trusted_hash: hash };
      });
    });
  }
  await writeFile(join(ctx.stagingDir, "hooks.json"), `${JSON.stringify({ hooks: events }, null, 2)}\n`, { mode: FILE_MODE });
  return { state };
}

function profileHookGroup(hook: ResolvedHook): HookGroup {
  return {
    ...(hook.matcher !== undefined ? { matcher: hook.matcher } : {}),
    hooks: [{ type: "command", command: hook.command, ...(hook.timeoutSec !== undefined ? { timeout: hook.timeoutSec } : {}) }]
  };
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/**
 * What `<home>/sessions` links to: the account home's `sessions/` (itself a link to the shared
 * one); when the account home has none yet (an account never launched), the system home's — the
 * dir every account home links to (`agent-accounts.ts`).
 */
async function sessionsTarget(ctx: CodexPrepareContext): Promise<string> {
  const own = join(ctx.accountHome as string, "sessions");
  if (await exists(own)) return own;
  const shared = join(ctx.systemHomes.codexHome, "sessions");
  if (await exists(shared)) return shared;
  throw new Error("The Codex history folder (sessions/) does not exist yet; start one Codex chat first.");
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false
  );
}

/** The seeding child's env: enough to run the CLI, nothing of the account (no keys, no login). */
function seedEnv(ctx: CodexPrepareContext): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: ctx.systemHomes.home };
  for (const name of ["LANG", "LC_ALL", "TMPDIR"]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}
