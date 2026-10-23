/**
 * Claude adapter — what a profile thread launches with (Agent Profiles spec §6.0, §6.1).
 *
 * Claude keeps the account's `CLAUDE_CONFIG_DIR`; a profile chat differs from a Global one only in
 * its SDK options (`launch.ts`). {@link loadClaudeProfileLaunch} gathers their inputs at every
 * session start:
 * - the prepared section (`loadProfileManifest(input, "claude")`; a missing or mismatched one
 *   FAILS the start — never a Global launch) and the files it names: the generated and copied
 *   plugins, the instructions, the MCP servers (with secrets);
 * - the account's user `settings.json` (`<CLAUDE_CONFIG_DIR>/settings.json`), filtered by
 *   `claudeRuntimeSettings` — the runtime settings a profile chat carries over (§6.0). Missing or
 *   invalid reads as `{}`;
 * - what keeps the PROJECT's own files loading as in a Global chat although the recipe would drop
 *   them: its `.claude/` skills and commands are added to the `skills` allow-list, and its
 *   `.mcp.json` servers (minus `disabledMcpjsonServers`) are passed explicitly, since
 *   `strictMcpConfig` ignores them;
 * - every plugin id the account has installed or the project's settings enable, to switch off at
 *   the flag tier: probed on 2.1.285, a project's `.claude/settings.json` `enabledPlugins` DOES
 *   turn on a globally installed plugin under `settingSources: ["project", "local"]`, and
 *   `enabledPlugins: {id: false}` in `--settings` turns it off again. The profile's own plugins load
 *   by path (`<name>@inline`), so the override never touches them.
 *
 * The project's files (`.claude/settings*.json`, `.mcp.json` up the tree, `.claude/` skills and
 * commands) are read where they live: a box project's in its box (`where.projectFs`, the host
 * directory being an empty stub); the account's and the profile's files are always this machine's.
 *
 * Secrets: the MCP servers and the carried settings (`env`, auth helpers) never reach argv — the
 * launch writes them to 0600 files in a 0700 per-thread directory ({@link writeClaudeProfileLaunchFiles})
 * and passes the paths; the session removes the directory when it ends. The host's tmp dir may be a
 * shared `TMPDIR`, so the `claude-profile-launch` parent and the per-thread dir must each be a real
 * directory (not a symlink) owned by this user with no group/other bits — created that way, else
 * the start is refused rather than writing secrets where someone else can read or swap them.
 *
 * Static imports only (AGENTS.md: no dynamic `import()` under `agent-host`).
 */

import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import type { SdkPluginConfig } from "@anthropic-ai/claude-agent-sdk";

import {
  claudeInstalledPluginIds,
  claudeProjectEntryNames,
  claudeProjectMcpServers,
  isPlainObject,
  mcpServersOf,
  readJsonObject,
  type ClaudeNamesFs
} from "../../../agent-isolation/claude-names.ts";
import { claudeRuntimeSettings } from "../../../agent-isolation/runtime-settings.ts";
import type { ClaudePreparedHooks, ClaudePreparedSection } from "../../../session-profiles/manifest/claude.ts";
import type { HostThreadProfile } from "../../host-protocol.ts";
import { loadProfileManifest, ProfileLaunchError } from "../profile-manifest.ts";

type Doc = Record<string, unknown>;

/** Env a profile chat adds (spec §6.1): no claude.ai connectors, no auto-memory. */
export const CLAUDE_PROFILE_ENV: Readonly<Record<string, string>> = {
  ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1"
};

/** Everything `buildClaudeQueryOptions` needs for a profile chat. Holds SECRETS (`mcpServers`, `carriedSettings`). */
export interface ClaudeProfileLaunch {
  /** The generated plugin, then each copied plugin (MCP lifted by the preparer, so `skipMcpDiscovery`). Absolute. */
  plugins: SdkPluginConfig[];
  /** The SDK `skills` allow-list (prepared list + the project's own names); absent = omit the option. */
  skills?: string[];
  /** The profile's instructions; `""` when it has none. */
  instructions: string;
  hooks: ClaudePreparedHooks;
  disableWorkflows: boolean;
  /** No built-in tool at all (`tools: []`): a managed profile whose chats work only through MCP tools. */
  disableBuiltinTools?: boolean;
  /** The account's user settings minus the item keys (`claudeRuntimeSettings`). */
  carriedSettings: Doc;
  /** Installed or project-enabled plugin ids to switch off at the flag tier. */
  disabledPluginIds: string[];
  /** The project's `.mcp.json` servers (not disabled), then the profile's — the profile wins a name. */
  mcpServers: Record<string, Doc>;
}

/** Where a profile chat's launch files go, and what they are called. */
export interface ClaudeProfileLaunchFiles {
  dir: string;
  settings: string;
  mcpConfig: string;
}

export function claudeProfileLaunchFiles(tmpDir: string, threadId: string): ClaudeProfileLaunchFiles {
  const dir = join(tmpDir, "claude-profile-launch", threadId);
  return { dir, settings: join(dir, "settings.json"), mcpConfig: join(dir, "mcp.json") };
}

/** A manifest path resolved inside the prepared dir; throws for one that escapes it. */
function inside(preparedDir: string, relative: string): string {
  const root = resolve(preparedDir);
  const path = resolve(root, relative);
  if (!path.startsWith(root + sep)) {
    throw new ProfileLaunchError(`This chat's Agent Profile could not be loaded, so the agent was not started: the prepared path "${relative}" is outside its directory.`);
  }
  return path;
}

async function readPrepared(path: string, what: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    throw new ProfileLaunchError(`This chat's Agent Profile could not be loaded, so the agent was not started: its ${what} is missing from the prepared directory.`);
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * The thread's profile launch, or `null` for a Global thread. Throws `ProfileLaunchError` (the
 * start fails with its message) when the prepared directory cannot be launched from.
 */
export async function loadClaudeProfileLaunch(
  input: { profile?: HostThreadProfile; cwd: string },
  where: {
    /** The account's `CLAUDE_CONFIG_DIR` (`claudeConfigDir(env)`). */
    configDir: string;
    /** `.claude.json` of that account (`<CLAUDE_CONFIG_DIR>/.claude.json`, else `~/.claude.json`). */
    claudeJson: string;
    /** The child's `HOME`: where the project walk for `.claude/` skills stops. */
    home: string;
    /**
     * boxes: where the project's files are read — the box's (`BoxProjectFs`, host paths mapped)
     * for a box thread; this machine's when absent. `home` is then the box's.
     */
    projectFs?: ClaudeNamesFs;
  }
): Promise<ClaudeProfileLaunch | null> {
  const section: ClaudePreparedSection | null = await loadProfileManifest(input, "claude");
  if (section === null || input.profile === undefined) {
    return null;
  }
  const preparedDir = input.profile.preparedDir;

  const plugins: SdkPluginConfig[] = [];
  if (section.localPlugin !== undefined) {
    plugins.push({ type: "local", path: inside(preparedDir, section.localPlugin.path) });
  }
  for (const plugin of section.plugins) {
    plugins.push({ type: "local", path: inside(preparedDir, plugin.path), skipMcpDiscovery: true });
  }

  const instructions =
    section.instructionsFile !== undefined
      ? (await readPrepared(inside(preparedDir, section.instructionsFile), "instructions file")).trim()
      : "";

  let profileServers: Record<string, Doc> = {};
  if (section.mcpConfig !== undefined) {
    const text = await readPrepared(inside(preparedDir, section.mcpConfig), "MCP server file");
    try {
      profileServers = mcpServersOf(JSON.parse(text) as Doc);
    } catch {
      throw new ProfileLaunchError("This chat's Agent Profile could not be loaded, so the agent was not started: its MCP server file does not read.");
    }
  }

  const userSettings = (await readJsonObject(join(where.configDir, "settings.json"))) ?? {};
  const carriedSettings = claudeRuntimeSettings(userSettings);

  const projectFs = where.projectFs;
  const projectSettings = await Promise.all(
    [join(input.cwd, ".claude", "settings.json"), join(input.cwd, ".claude", "settings.local.json")].map((file) =>
      readJsonObject(file, projectFs)
    )
  );
  const claudeJson = await readJsonObject(where.claudeJson);
  const projectEntry = isPlainObject(claudeJson?.projects) ? claudeJson.projects[resolve(input.cwd)] : undefined;

  const disabledMcp = new Set([
    ...stringList(carriedSettings.disabledMcpjsonServers),
    ...projectSettings.flatMap((doc) => stringList(doc?.disabledMcpjsonServers)),
    ...(isPlainObject(projectEntry) ? stringList(projectEntry.disabledMcpjsonServers) : [])
  ]);
  const mcpServers: Record<string, Doc> = {};
  for (const [name, def] of Object.entries(await claudeProjectMcpServers(input.cwd, projectFs))) {
    if (!disabledMcp.has(name)) mcpServers[name] = def;
  }
  Object.assign(mcpServers, profileServers);

  const disabledPluginIds = [
    ...new Set([
      ...(await claudeInstalledPluginIds(where.configDir)),
      ...projectSettings.flatMap((doc) => (isPlainObject(doc?.enabledPlugins) ? Object.keys(doc.enabledPlugins) : []))
    ])
  ];

  const skills =
    section.skills !== undefined
      ? [...new Set([...section.skills, ...(await claudeProjectEntryNames(input.cwd, where.home, projectFs))])]
      : undefined;

  return {
    plugins,
    ...(skills !== undefined ? { skills } : {}),
    instructions,
    hooks: section.hooks,
    disableWorkflows: section.disableWorkflows,
    ...(section.disableBuiltinTools === true ? { disableBuiltinTools: true } : {}),
    carriedSettings,
    disabledPluginIds,
    mcpServers
  };
}

/** Writes `value` as JSON to `path` (0600) via a temp file and a rename. */
async function writeSecretJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
  } finally {
    await handle.close();
  }
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

/**
 * `path` as a private directory: created 0700 when missing, else it must already be a real
 * directory (not a symlink) owned by this process's user with no group/other permission bits.
 * Throws `ProfileLaunchError` otherwise.
 */
async function privateDir(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await lstat(path);
  const uid = process.getuid?.();
  const problem = info.isSymbolicLink()
    ? "is a symlink"
    : !info.isDirectory()
      ? "is not a directory"
      : uid !== undefined && info.uid !== uid
        ? `belongs to uid ${info.uid}, not ${uid}`
        : (info.mode & 0o077) !== 0
          ? `has mode ${(info.mode & 0o777).toString(8).padStart(4, "0")}, not 0700`
          : null;
  if (problem !== null) {
    throw new ProfileLaunchError(
      `This chat's Agent Profile launch files were not written, so the agent was not started: ${path} ${problem}.`
    );
  }
}

/** Writes the launch's files (`buildClaudeQueryOptions`' `profileFiles`) into a private 0700 per-thread dir. */
export async function writeClaudeProfileLaunchFiles(
  files: ClaudeProfileLaunchFiles,
  contents: { settings: Doc; mcpConfig?: Doc }
): Promise<void> {
  const parent = dirname(files.dir);
  await mkdir(dirname(parent), { recursive: true });
  await privateDir(parent);
  await privateDir(files.dir);
  await writeSecretJson(files.settings, contents.settings);
  if (contents.mcpConfig !== undefined) {
    await writeSecretJson(files.mcpConfig, contents.mcpConfig);
  } else {
    await rm(files.mcpConfig, { force: true });
  }
}

/** Removes the launch's files; never throws. Nothing is removed through a parent that is not a real directory. */
export async function removeClaudeProfileLaunchFiles(files: ClaudeProfileLaunchFiles): Promise<void> {
  const parent = await lstat(dirname(files.dir)).catch(() => null);
  if (parent === null || !parent.isDirectory()) return;
  await rm(files.dir, { recursive: true, force: true }).catch(() => undefined);
}
