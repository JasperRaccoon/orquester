/**
 * Agent Profiles — Grok's preparer (spec §6.3). A Grok profile chat runs with `GROK_HOME` = the
 * prepared (version) directory and `GROK_AUTH_PATH` = its account's `auth.json` (the launch
 * contribution, `../contributions/grok.ts`), so the directory is a complete Grok home holding
 * only the profile's kit (`../manifest/grok.ts` has the section):
 *
 *   AGENTS.md                      the profile's instructions (Grok's user-level instruction file)
 *   skills/<name>/                 the profile's skills
 *   commands/<name>.md             the profile's commands (`git/pr` → `commands/git/pr.md`)
 *   hooks/orquester.json           Orquester's own status hooks, as `AgentHooks` installs them in a
 *                                  Global home
 *   profile/config.base.toml       the Global `config.toml`'s runtime settings
 *                                  (`grokRuntimeConfig`, §6.0) + the profile's `[mcp_servers]`.
 *                                  SECRETS: 0600. The adapter renders `config.toml` from it at
 *                                  every spawn with the recipe and the per-spawn exclusion lists
 *                                  (`agent-host/adapters/grok/profile-launch.ts`).
 *   profile/plugins/<itemId>/<name>/   a COPY of each enabled Grok plugin (`--plugin-dir`)
 *   profile/hooks-plugin/<name>/   the profile's hooks as a generated plugin (`--plugin-dir`;
 *                                  Grok has no other per-process hook source that fires)
 *   config.toml                    a first render (exclusion lists as of now, no plugin deny list
 *                                  yet) so the home is never without the recipe; Grok rewrites
 *                                  it, the adapter regenerates it before every spawn
 *   sessions -> <~/.grok>/sessions, trusted_folders.toml -> <~/.grok>/trusted_folders.toml
 *                                  shared with Global and every account, so history, resume and
 *                                  folder trust match (linked only when the Global one exists)
 *
 * No `auth.json` here: the credential stays in the account home (`GROK_AUTH_PATH`). Copied plugins
 * live under `profile/`, not `plugins/`, so Grok's own user-plugin scan never sees them twice.
 *
 * Shared by every account (`perAccount: false`: the account only changes `GROK_AUTH_PATH`); reads
 * the Global `config.toml` (`inputs`).
 */

import { chmod, copyFile, lstat, mkdir, open, readFile, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "@decimalturn/toml-patch";
import { daemonConfigDir } from "@orquester/config";
import { SESSION_TOOLS_SERVER_NAME } from "@orquester/api/agent-chat";
import { prepareGrokManagedHooks } from "../../agent-hooks.ts";
import { copyEntry } from "../../agent-profile/infra/tree.ts";
import { isPlainObject, readJsonObject } from "../../agent-isolation/claude-names.ts";
import { grokSkillIgnoreList, renderGrokProfileConfigToml } from "../../agent-isolation/grok.ts";
import { grokRuntimeConfig } from "../../agent-isolation/runtime-settings.ts";
import type { GrokPreparedSection } from "../manifest/grok.ts";
import type { SessionProfilePrepareContext, SessionProfilePrepareInputsContext, SessionProfilePreparer } from "../preparer.ts";
import type { ResolvedHook, ResolvedMcpServer } from "../resolve.ts";

/** Bump when the prepared output changes for the same inputs. */
export const GROK_PREPARER_VERSION = "1";

export const GROK_CONFIG_BASE_FILE = "profile/config.base.toml";
const PLUGINS_DIR = "profile/plugins";
const HOOKS_PLUGIN_DIR = "profile/hooks-plugin";
const HOOKS_PLUGIN_NAME = "orquester-profile-hooks";

const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const GROK_MCP_ADVANCED_KEYS = ["startup_timeout_sec", "tool_timeout_sec", "bearer_token_env_var"] as const;

type Doc = Record<string, unknown>;

/** A profile MCP server as Grok's `[mcp_servers.<name>]` table (the Agent config editor's shape). */
export function grokMcpTable(server: ResolvedMcpServer): Doc {
  const table: Doc = {};
  if (server.transport === "stdio") {
    table.command = server.command ?? "";
    if (server.args !== undefined && server.args.length > 0) table.args = [...server.args];
    if (server.cwd !== undefined && server.cwd.length > 0) table.cwd = server.cwd;
  } else {
    table.url = server.url ?? "";
    if (server.transport === "sse") table.type = "sse";
    if (Object.keys(server.headers).length > 0) table.headers = { ...server.headers };
  }
  if (Object.keys(server.env).length > 0) table.env = { ...server.env };
  for (const key of GROK_MCP_ADVANCED_KEYS) {
    const value = server.advanced[key];
    if ((typeof value === "number" && Number.isFinite(value) && value > 0) || (typeof value === "string" && value.length > 0)) {
      table[key] = value;
    }
  }
  return table;
}

/** The profile's hooks as a Grok hook file (`{hooks: {<Event>: [{matcher?, hooks: [...]}]}}`). */
export function grokHooksFile(hooks: readonly ResolvedHook[]): { hooks: Record<string, Doc[]> } {
  const out: Record<string, Array<{ matcher?: string; hooks: Doc[] }>> = {};
  for (const hook of hooks) {
    const groups = (out[hook.event] ??= []);
    let group = groups.find((entry) => entry.matcher === hook.matcher);
    if (group === undefined) {
      group = { ...(hook.matcher !== undefined ? { matcher: hook.matcher } : {}), hooks: [] };
      groups.push(group);
    }
    group.hooks.push({
      type: "command",
      command: hook.command,
      ...(hook.timeoutSec !== undefined ? { timeout: hook.timeoutSec } : {})
    });
  }
  return { hooks: out };
}

/** The Global `config.toml`, parsed; `{}` when there is none. Throws when it does not parse. */
async function readGlobalConfig(path: string): Promise<Doc> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    const parsed: unknown = parseToml(text);
    return isPlainObject(parsed) ? parsed : {};
  } catch (error) {
    throw new Error(`The Global Grok config (${path}) does not parse: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The name Grok gives the plugin at `root`: its manifest's `name`, else `fallback`. */
async function grokPluginName(root: string, fallback: string): Promise<string> {
  for (const file of [join(".grok-plugin", "plugin.json"), join(".claude-plugin", "plugin.json"), "plugin.json"]) {
    const manifest = await readJsonObject(join(root, file));
    if (manifest !== null && typeof manifest.name === "string" && PLUGIN_NAME.test(manifest.name)) return manifest.name;
  }
  return fallback;
}

/** Writes `text` to a new file with `mode` (dirs made 0700). */
async function writeNew(path: string, text: string, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(text);
  } finally {
    await handle.close();
  }
  await chmod(path, mode);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function prepareGrok(ctx: SessionProfilePrepareContext<"grok">): Promise<GrokPreparedSection> {
  const resolved = ctx.resolved;
  const staging = ctx.stagingDir;
  const globalHome = ctx.systemHomes.grokHome;

  // Instructions, skills, commands: Grok's own user-level places inside the home.
  const instructions = resolved.instructions.trim();
  if (instructions.length > 0) await writeNew(join(staging, "AGENTS.md"), `${instructions}\n`, 0o600);
  for (const skill of resolved.skills) {
    await mkdir(join(staging, "skills"), { recursive: true, mode: 0o700 });
    await copyEntry(skill.dir, join(staging, "skills", skill.name), { symlinks: "preserve", followRoot: true });
  }
  for (const command of resolved.commands) {
    const dest = `${join(staging, "commands", ...command.name.split("/"))}.md`;
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
    await copyFile(command.file, dest);
    await chmod(dest, 0o600);
  }

  // Orquester's own status hooks, as a Global home has them (no launch installs into this one).
  await writeNew(join(staging, "hooks", "orquester.json"), await prepareGrokManagedHooks(daemonConfigDir(ctx.appdir)), 0o644);

  // The profile's Grok plugins, copied whole: a version dir must not change under a running chat.
  const plugins: GrokPreparedSection["plugins"] = [];
  for (const plugin of resolved.plugins) {
    const fallback = PLUGIN_NAME.test(plugin.name) ? plugin.name : plugin.id;
    const name = await grokPluginName(plugin.cacheDir, fallback);
    const path = `${PLUGINS_DIR}/${plugin.id}/${name}`;
    await mkdir(join(staging, PLUGINS_DIR, plugin.id), { recursive: true, mode: 0o700 });
    await copyEntry(plugin.cacheDir, join(staging, path), { symlinks: "preserve", followRoot: true });
    plugins.push({ itemId: plugin.id, name, path });
  }

  let hooksPlugin: GrokPreparedSection["hooksPlugin"];
  if (resolved.hooks.length > 0) {
    let name = HOOKS_PLUGIN_NAME;
    for (let n = 2; plugins.some((plugin) => plugin.name === name); n += 1) name = `${HOOKS_PLUGIN_NAME}-${n}`;
    const path = `${HOOKS_PLUGIN_DIR}/${name}`;
    const manifest = {
      name,
      version: resolved.revision,
      description: `Hooks of the Agent Profile "${resolved.name}" (generated by Orquester).`
    };
    await writeNew(join(staging, path, "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
    await writeNew(join(staging, path, "hooks", "hooks.json"), `${JSON.stringify(grokHooksFile(resolved.hooks), null, 2)}\n`, 0o600);
    hooksPlugin = { name, path };
  }

  // MCP servers: in the config (Grok boots `[mcp_servers]` at `session/new`).
  const mcpServers: Record<string, Doc> = {};
  for (const server of resolved.mcpServers) {
    if (server.name === SESSION_TOOLS_SERVER_NAME) {
      ctx.logger.warn(`Grok profile ${resolved.profileId}: the MCP server name "${server.name}" is Orquester's own; it was left out.`);
      continue;
    }
    mcpServers[server.name] = grokMcpTable(server);
  }

  // The base config (runtime settings carried over + the profile's servers), then a first render.
  const carriedOver = grokRuntimeConfig(await readGlobalConfig(join(globalHome, "config.toml")));
  const base: Doc = { ...carriedOver, ...(Object.keys(mcpServers).length > 0 ? { mcp_servers: mcpServers } : {}) };
  await writeNew(join(staging, GROK_CONFIG_BASE_FILE), stringifyToml(base, { inlineTableStart: 2 }), 0o600);
  const hideBundledSkills = resolved.settings.hideBuiltinSkills;
  const skillsIgnore = await grokSkillIgnoreList({ home: ctx.systemHomes.home, grokHome: ctx.preparedDir, hideBundled: hideBundledSkills });
  await writeNew(
    join(staging, "config.toml"),
    renderGrokProfileConfigToml({ carriedOver, mcpServers, skillsIgnore, pluginsDisabled: [] }),
    0o600
  );

  // History and folder trust are shared with Global (absolute links: they point outside the dir).
  for (const name of ["sessions", "trusted_folders.toml"]) {
    const target = join(globalHome, name);
    if (await exists(target)) await symlink(target, join(staging, name));
    else ctx.logger.info(`Grok profile ${resolved.profileId}: ${target} does not exist yet; ${name} is not shared.`);
  }

  return {
    configBase: GROK_CONFIG_BASE_FILE,
    hideBundledSkills,
    plugins,
    ...(hooksPlugin !== undefined ? { hooksPlugin } : {}),
    mcpServerNames: Object.keys(mcpServers)
  };
}

export const grokPreparer: SessionProfilePreparer<"grok"> = {
  agent: "grok",
  perAccount: false,
  version: GROK_PREPARER_VERSION,
  inputs: (ctx: SessionProfilePrepareInputsContext<"grok">) => [join(ctx.systemHomes.grokHome, "config.toml")],
  prepare: prepareGrok
};
