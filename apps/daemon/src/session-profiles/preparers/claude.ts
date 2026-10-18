/**
 * Agent Profiles — Claude's preparer (spec §6.1). Claude keeps the account's `CLAUDE_CONFIG_DIR`;
 * a profile chat differs only in its SDK launch options, so the prepared directory holds just the
 * files those options point at (`../manifest/claude.ts` has the section):
 *
 *   plugin/                 one generated local plugin with the profile's skills and commands
 *                           (`generateClaudeLocalPlugin`), named after the profile
 *   plugins/<itemId>/       a COPY of each enabled Claude plugin's cache dir (the profile's cache
 *                           changes on edit; a published version must not)
 *   plugin-data/<itemId>/   `${CLAUDE_PLUGIN_DATA}` of that plugin's lifted MCP servers
 *   mcp-servers.json        `{ mcpServers }`: the profile's servers + each copied plugin's own
 *                           (`strictMcpConfig` drops plugin MCP, so they are lifted here as
 *                           `plugin:<plugin>:<server>`, `${CLAUDE_PLUGIN_ROOT}` resolved against
 *                           `ctx.preparedDir`). SECRETS: 0600.
 *   instructions.md         the profile's instructions (appended to the system prompt)
 *
 * The section also carries the profile's hooks in Claude's `settings.hooks` format, the `skills`
 * allow-list (generated plugin ids + each copied plugin's skills and commands +
 * `workflow-authoring` while the Workflow tool is on; absent when built-in skills are shown) and
 * `disableWorkflows`. The project's own skills, the account's runtime settings and the
 * `enabledPlugins` overrides depend on the launch (cwd, account) and are added by the adapter
 * (`agent-host/adapters/claude/profile-launch.ts`).
 *
 * Shared by every account (`perAccount: false`) and reads no Global file (`inputs`: none).
 */

import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { SESSION_TOOLS_SERVER_NAME } from "@orquester/api/agent-chat";
import { copyEntry } from "../../agent-profile/infra/tree.ts";
import { generateClaudeLocalPlugin } from "../../agent-isolation/claude-plugin.ts";
import {
  claudePluginEntryIds,
  isPlainObject,
  mcpServersOf,
  readClaudePluginManifest,
  readJsonObject
} from "../../agent-isolation/claude-names.ts";
import type { ClaudePreparedHooks, ClaudePreparedSection } from "../manifest/claude.ts";
import type { SessionProfilePrepareContext, SessionProfilePreparer } from "../preparer.ts";
import type { ResolvedAgentProfile, ResolvedHook, ResolvedMcpServer } from "../resolve.ts";

/** Bump when the prepared output changes for the same inputs. */
export const CLAUDE_PREPARER_VERSION = "1";

/** The bundled skill the Workflow tool points at; omitting it makes Claude inline the guide (spec §6.1). */
export const CLAUDE_WORKFLOW_AUTHORING_SKILL = "workflow-authoring";

const LOCAL_PLUGIN_DIR = "plugin";
const PLUGINS_DIR = "plugins";
const PLUGIN_DATA_DIR = "plugin-data";
const MCP_FILE = "mcp-servers.json";
const INSTRUCTIONS_FILE = "instructions.md";

const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The generated plugin's name — the prefix the model sees on the profile's skills and commands
 * (`developer:review`): the profile name as a slug, `profile` when nothing is left of it, and never
 * the name of one of the profile's own plugins.
 */
export function claudeLocalPluginName(profileName: string, taken: ReadonlySet<string>): string {
  const slug = profileName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 48);
  const base = PLUGIN_NAME.test(slug) ? slug : "profile";
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base}-${n}`;
  return name;
}

/** A profile MCP server as Claude's `--mcp-config` entry (SDK `McpServerConfig` shape). */
export function claudeMcpDefinition(server: ResolvedMcpServer): Record<string, unknown> {
  const timeout = Number(server.advanced.timeout);
  const extra = Number.isFinite(timeout) && timeout > 0 ? { timeout: Math.round(timeout) } : {};
  if (server.transport === "stdio") {
    return {
      type: "stdio",
      command: server.command ?? "",
      args: [...(server.args ?? [])],
      env: { ...server.env },
      ...(server.cwd !== undefined && server.cwd.length > 0 ? { cwd: server.cwd } : {}),
      ...extra
    };
  }
  return {
    type: server.transport,
    url: server.url ?? "",
    ...(Object.keys(server.headers).length > 0 ? { headers: { ...server.headers } } : {}),
    ...extra
  };
}

/** The profile's hooks in Claude's `settings.hooks` format, grouped by event then matcher. */
export function claudeHooksSetting(hooks: readonly ResolvedHook[]): ClaudePreparedHooks {
  const out: ClaudePreparedHooks = {};
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
  return out;
}

/** Every string inside `value` with `${NAME}` replaced for each `vars` entry. */
function substitute(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z_]+)\}/g, (whole, name: string) => vars[name] ?? whole);
  }
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, vars));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, substitute(entry, vars)]));
  }
  return value;
}

/** A copied plugin's own MCP servers: `.mcp.json` and `plugin.json` `mcpServers` (a map or file paths). */
async function pluginMcpServers(root: string, manifest: Record<string, unknown>): Promise<Record<string, Record<string, unknown>>> {
  const servers = { ...mcpServersOf(await readJsonObject(join(root, ".mcp.json"))) };
  const declared = manifest.mcpServers;
  if (isPlainObject(declared)) {
    Object.assign(servers, mcpServersOf(declared));
  } else {
    const files = typeof declared === "string" ? [declared] : Array.isArray(declared) ? declared : [];
    for (const file of files) {
      if (typeof file !== "string" || file.startsWith("/") || file.split("/").includes("..")) continue;
      Object.assign(servers, mcpServersOf(await readJsonObject(join(root, file))));
    }
  }
  return servers;
}

/** Writes `text` to a new file with `mode`. */
async function writeNew(path: string, text: string, mode: number): Promise<void> {
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(text);
  } finally {
    await handle.close();
  }
  await chmod(path, mode);
}

async function prepareClaude(ctx: SessionProfilePrepareContext<"claude">): Promise<ClaudePreparedSection> {
  const resolved: ResolvedAgentProfile = ctx.resolved;
  const allowlist: string[] = [];
  const mcpServers: Record<string, Record<string, unknown>> = {};

  for (const server of resolved.mcpServers) {
    if (server.name === SESSION_TOOLS_SERVER_NAME) {
      ctx.logger.warn(`Claude profile ${resolved.profileId}: the MCP server name "${server.name}" is Orquester's own; it was left out.`);
      continue;
    }
    mcpServers[server.name] = claudeMcpDefinition(server);
  }

  // The profile's Claude plugins, copied whole: a version dir must not change under a running chat.
  const plugins: ClaudePreparedSection["plugins"] = [];
  for (const plugin of resolved.plugins) {
    const path = `${PLUGINS_DIR}/${plugin.id}`;
    const dest = join(ctx.stagingDir, PLUGINS_DIR, plugin.id);
    await mkdir(join(ctx.stagingDir, PLUGINS_DIR), { recursive: true, mode: 0o700 });
    await copyEntry(plugin.cacheDir, dest, { symlinks: "preserve", followRoot: true });
    const manifest = await readClaudePluginManifest(dest);
    const declaredName = typeof manifest.name === "string" ? manifest.name : "";
    const name = PLUGIN_NAME.test(declaredName) ? declaredName : plugin.name;
    plugins.push({ itemId: plugin.id, name, path });
    allowlist.push(...(await claudePluginEntryIds(dest, name, manifest)));
    const lifted = await pluginMcpServers(dest, manifest);
    if (Object.keys(lifted).length > 0) {
      const dataDir = join(ctx.stagingDir, PLUGIN_DATA_DIR, plugin.id);
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      const vars = {
        CLAUDE_PLUGIN_ROOT: join(ctx.preparedDir, PLUGINS_DIR, plugin.id),
        CLAUDE_PLUGIN_DATA: join(ctx.preparedDir, PLUGIN_DATA_DIR, plugin.id)
      };
      for (const [server, def] of Object.entries(lifted)) {
        const key = `plugin:${name}:${server}`;
        if (!(key in mcpServers)) mcpServers[key] = substitute(def, vars) as Record<string, unknown>;
      }
    }
  }

  let localPlugin: ClaudePreparedSection["localPlugin"];
  if (resolved.skills.length > 0 || resolved.commands.length > 0) {
    const name = claudeLocalPluginName(resolved.name, new Set(plugins.map((plugin) => plugin.name)));
    const commands = await Promise.all(
      resolved.commands.map(async (command) => ({ name: command.name, markdown: await readFile(command.file, "utf8") }))
    );
    const generated = await generateClaudeLocalPlugin({
      dir: join(ctx.stagingDir, LOCAL_PLUGIN_DIR),
      name,
      description: `Skills and commands of the Agent Profile "${resolved.name}" (generated by Orquester).`,
      skills: resolved.skills.map((skill) => ({ name: skill.name, sourceDir: skill.dir })),
      commands
    });
    localPlugin = { path: LOCAL_PLUGIN_DIR, name };
    allowlist.unshift(...generated.allowlist);
  }

  const mcpServerNames = Object.keys(mcpServers);
  if (mcpServerNames.length > 0) {
    await writeNew(join(ctx.stagingDir, MCP_FILE), `${JSON.stringify({ mcpServers }, null, 2)}\n`, 0o600);
  }
  const instructions = resolved.instructions.trim();
  if (instructions.length > 0) {
    await writeNew(join(ctx.stagingDir, INSTRUCTIONS_FILE), `${instructions}\n`, 0o600);
  }

  const workflowOn = resolved.settings.claudeWorkflowTool;
  const skills = resolved.settings.hideBuiltinSkills
    ? [...new Set([...allowlist, ...(workflowOn ? [CLAUDE_WORKFLOW_AUTHORING_SKILL] : [])])]
    : undefined;

  return {
    ...(localPlugin !== undefined ? { localPlugin } : {}),
    plugins,
    ...(mcpServerNames.length > 0 ? { mcpConfig: MCP_FILE } : {}),
    mcpServerNames,
    hooks: claudeHooksSetting(resolved.hooks),
    ...(instructions.length > 0 ? { instructionsFile: INSTRUCTIONS_FILE } : {}),
    ...(skills !== undefined ? { skills } : {}),
    disableWorkflows: !workflowOn
  };
}

export const claudePreparer: SessionProfilePreparer<"claude"> = {
  agent: "claude",
  perAccount: false,
  version: CLAUDE_PREPARER_VERSION,
  prepare: prepareClaude
};
