/**
 * Agent Profiles — OpenCode's preparer and launch contribution (spec §6.0, §6.4). OpenCode has no
 * managed accounts and `opencode serve` reads its config once, at start, so a profile chat runs on
 * its own keyed server of the project (`agent-host/adapters/opencode/server.ts`) whose env points
 * at this prepared (version) directory:
 *
 *   opencode/                 OPENCODE_CONFIG_DIR (`../manifest/opencode.ts` has the section)
 *     opencode.json           §6.0: the Global `config.json` + `opencode.json` + `opencode.jsonc`
 *                             merged as OpenCode merges them, minus the item keys
 *                             (`opencodeRuntimeConfig`), plus the profile's `mcp`, `skills.paths`
 *                             = the REPO's `.claude/skills` and `.agents/skills` (the two disable
 *                             flags drop them with the user ones) and, when built-ins are hidden,
 *                             `permission.skill` denying `customize-opencode`. SECRETS: 0600.
 *     AGENTS.md               the profile's instructions, ALWAYS written (empty without any):
 *                             OpenCode takes the first existing of `<config dir>/AGENTS.md` and
 *                             `~/.claude/CLAUDE.md` as THE global instruction file and skips an
 *                             empty one, so the user's CLAUDE.md never loads; the launch refuses a
 *                             version without it
 *     skills/<name>/          the profile's skills
 *     commands/<name>.md      the profile's commands (`git/pr` → `commands/git/pr.md`)
 *     plugin/                 every top-level `*.js`/`*.ts`/`*.mjs` of each profile plugin's cache,
 *                             plus Orquester's `orquester-status.js` (its only copy this server
 *                             loads: the real `~/.config/opencode` is never read)
 *   xdg/                      XDG_CONFIG_HOME: a symlink to every entry of the real `~/.config`
 *                             EXCEPT `opencode` (`buildXdgConfigShadow`), so `gh`, git and the
 *                             like keep their config while the global OpenCode dir is never read
 *   home/                     OPENCODE_TEST_HOME: empty. OpenCode reads `<home>/.opencode` as a
 *                             config dir whatever the two dirs above say; `<home>` is this variable
 *                             or else the real HOME (`agent-isolation/opencode-home.ts`)
 *
 * `$HOME/.opencode`. The variable is undocumented, so preparation probes the CLI binary
 * (`probeOpencodeTestHome`, once per binary) and records `testHome.verified`. Unproven, a user
 * `~/.opencode` holding config refuses preparation AND every launch (it may appear later).
 *
 * WRITABLE CONFIG DIR. OpenCode writes `.gitignore`, `package.json`, `bun.lock` and `node_modules/`
 * (its `@opencode-ai/plugin` dependency) into every config dir it loads — here `opencode/` and the
 * shadow's own `xdg/opencode/` (OpenCode creates `$XDG_CONFIG_HOME/opencode`). Both are real,
 * Orquester-owned directories inside the version dir: the PATH CONTRACT lets the CLI running in a
 * version write there, the lifecycle never hashes a version's content, and they go with the
 * version when the GC collects it. Nothing of the profile is ever written into them by OpenCode.
 *
 * SHADOW TIMING. The shadow is built at preparation (so a version is complete on its own: the host
 * may launch the persisted `launch.json` when the daemon cannot be asked) AND refreshed by
 * {@link opencodeLaunchContribution} at every launch, because the real `~/.config` gains and loses
 * entries without any profile change. The refresh only adds, retargets or removes the shadow's own
 * symlinks (atomic per link) — the one launch-time write into a published version; it never
 * touches `opencode/`, a real entry a tool created in the shadow, or the real `~/.config`.
 *
 * LAUNCH. `serverPool { key: "profile:<profileId>:<version dir>", env: {XDG_CONFIG_HOME,
 * OPENCODE_CONFIG_DIR, OPENCODE_DISABLE_EXTERNAL_SKILLS=1, OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1,
 * OPENCODE_TEST_HOME},
 * unsetEnv: [OPENCODE_CONFIG] }` — a new version is a new key, so an edited profile starts a new
 * server at the thread's next start and the old one closes once idle (the pool's idle close).
 * `XDG_DATA_HOME` (auth and the session DB, shared with Global) and Orquester's
 * `OPENCODE_CONFIG_CONTENT` (loaded LAST by OpenCode, so it still wins) are left as they are;
 * nothing goes into the thread's own `launchEnv`, which OpenCode's shared servers do not read.
 *
 * Project instructions load as in Global (verified on 1.18.34 with the real system prompt): the
 * repo's `AGENTS.md`, else its `CLAUDE.md`. Known limits (OpenCode 1.18.34): `$HOME/.opencode` is
 * kept out only through the undocumented `OPENCODE_TEST_HOME` (above).
 * OpenCode 1.18.34 reads no project `.mcp.json` in Global or here.
 */

import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { OPENCODE_SESSION_TOOLS_SERVER_PATTERN, SESSION_TOOLS_SERVER_NAME } from "@orquester/api/agent-chat";
import { OPENCODE_STATUS_PLUGIN_FILE, openCodeStatusPluginSource } from "../../agent-hooks.ts";
import { opencodeRuntimeConfig } from "../../agent-isolation/runtime-settings.ts";
import {
  OPENCODE_TEST_HOME_ENV,
  type OpencodeTestHomeProbe,
  opencodeHomeConfigItems,
  probeOpencodeTestHome
} from "../../agent-isolation/opencode-home.ts";
import { buildXdgConfigShadow } from "../../agent-isolation/xdg-shadow.ts";
import { CONFIG_FILE_NAMES, mergeConfigValues, readConfigState } from "../../agent-profile/adapters/opencode/config.ts";
import { isJsonObject, type JsonObject } from "../../agent-profile/adapters/opencode/jsonc.ts";
import { mcpEntryFromPortable } from "../../agent-profile/adapters/opencode/mcp.ts";
import { checkCommandFrontmatter } from "../../agent-profile/adapters/opencode/validate.ts";
import type { PortableMcpServer } from "../../agent-profile/adapters/types.ts";
import { parseMarkdownDocument } from "../../agent-profile/infra/frontmatter.ts";
import { copyEntry } from "../../agent-profile/infra/tree.ts";
import type { ProfileLaunchContext, ProfileLaunchContribution } from "../launch.ts";
import type { OpenCodePreparedSection } from "../manifest/opencode.ts";
import type { SessionProfilePrepareContext, SessionProfilePreparer } from "../preparer.ts";
import type { ResolvedMcpServer } from "../resolve.ts";

/**
 * Bump the leading number when the prepared output changes for the same inputs. The suffix follows
 * the status plugin's source, so a new plugin re-prepares every OpenCode profile.
 */
export const OPENCODE_PREPARER_VERSION = `3.${createHash("sha256").update(openCodeStatusPluginSource()).digest("hex").slice(0, 8)}`;

/** OpenCode's one built-in skill (1.18.34); denied when the profile hides built-ins. */
export const OPENCODE_BUILTIN_SKILLS = ["customize-opencode"] as const;

/** The repo's own skill folders, brought back by `skills.paths` (relative to the session's directory). */
export const OPENCODE_PROJECT_SKILL_PATHS = [".claude/skills", ".agents/skills"] as const;

/**
 * The variables a profile server starts with (besides the dirs): the user's `~/.claude/skills` and
 * `~/.agents/skills` off. Not `OPENCODE_DISABLE_CLAUDE_CODE`: it also drops a repo's own
 * `CLAUDE.md`; the `~/.claude/CLAUDE.md` fallback is stopped by the always-present `AGENTS.md`.
 */
export const OPENCODE_PROFILE_FLAGS = { OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1" } as const;

/** Removed from a profile server's env: an extra config FILE the launcher env may name (user items). */
export const OPENCODE_PROFILE_UNSET = ["OPENCODE_CONFIG"] as const;

const CONFIG_DIR = "opencode";
const XDG_DIR = "xdg";
const TEST_HOME_DIR = "home";
/** The probe's scratch, inside the staging dir and removed before it is published. */
const PROBE_DIR = ".probe-test-home";
const CONFIG_FILE = "opencode.json";
const INSTRUCTIONS_FILE = "AGENTS.md";
const PLUGIN_EXTENSIONS = new Set([".js", ".ts", ".mjs"]);
const SCHEMA_URL = "https://opencode.ai/config.json";

/** The pool key of a prepared version: the profile and the version dir's (never reused) name. */
export function opencodeProfilePoolKey(profileId: string, preparedDir: string): string {
  return `profile:${profileId}:${basename(preparedDir)}`;
}

/** `{file:./x}` resolves against the config file's dir: make it absolute before the config moves. */
function absolutizeFileRefs(value: unknown, baseDir: string): unknown {
  if (typeof value === "string") {
    return value.replace(/\{file:([^}]+)\}/g, (whole, path: string) =>
      path.startsWith("~/") || isAbsolute(path) ? whole : `{file:${resolve(baseDir, path)}}`
    );
  }
  if (Array.isArray(value)) return value.map((entry) => absolutizeFileRefs(entry, baseDir));
  if (isJsonObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, absolutizeFileRefs(entry, baseDir)]));
  }
  return value;
}

/** The Global config as OpenCode merges it; throws when a file does not parse (what loads is unknowable). */
async function globalConfig(dir: string): Promise<JsonObject> {
  const state = await readConfigState(dir);
  const broken = state.files.find((file) => file.value === null);
  if (broken !== undefined) {
    throw new Error(`The Global OpenCode config ${broken.path} could not be read: ${broken.error ?? "it does not parse"}.`);
  }
  return mergeConfigValues(state.files.map((file) => absolutizeFileRefs(file.value, dirname(file.path)) as JsonObject));
}

/** `permission` with `skill` rules denying `hidden` added LAST (OpenCode's last matching rule wins). */
export function withSkillsDenied(permission: unknown, hidden: readonly string[]): JsonObject {
  const base: JsonObject = typeof permission === "string" ? { "*": permission } : isJsonObject(permission) ? { ...permission } : {};
  const current = base.skill;
  delete base.skill;
  const skill: JsonObject = typeof current === "string" ? { "*": current } : isJsonObject(current) ? { ...current } : {};
  for (const name of hidden) {
    delete skill[name];
    skill[name] = "deny";
  }
  return { ...base, skill };
}

/** A profile MCP server as OpenCode's `mcp.<name>` entry (known keys only; refused shapes throw). */
export function opencodeMcpEntry(server: ResolvedMcpServer): JsonObject {
  const timeout = server.advanced.timeout;
  const portable: PortableMcpServer = {
    name: server.name,
    transport: server.transport,
    ...(server.command !== undefined ? { command: server.command } : {}),
    ...(server.args !== undefined ? { args: server.args } : {}),
    ...(server.cwd !== undefined && server.cwd.length > 0 ? { cwd: server.cwd } : {}),
    ...(server.url !== undefined ? { url: server.url } : {}),
    ...(server.transport === "stdio" && Object.keys(server.env).length > 0 ? { env: server.env } : {}),
    ...(server.transport !== "stdio" && Object.keys(server.headers).length > 0 ? { headers: server.headers } : {}),
    ...(typeof timeout === "number" ? { advanced: { timeout } } : {})
  };
  try {
    return mcpEntryFromPortable(portable);
  } catch (error) {
    // The message names the field, never a value.
    throw new Error(`The MCP server "${server.name}" cannot run in OpenCode: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Writes `text` to a new file with `mode`. */
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

/** The top-level plugin files of a profile plugin's cache dir (real files only). */
async function pluginFiles(cacheDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of (await readdir(cacheDir)).sort()) {
    if (!PLUGIN_EXTENSIONS.has(extname(name))) continue;
    if ((await lstat(join(cacheDir, name))).isFile()) out.push(name);
  }
  return out;
}

/**
 * The refusal when `<home>/.opencode` holds config a profile server would load: OpenCode reads it
 * whatever XDG_CONFIG_HOME / OPENCODE_CONFIG_DIR say, and the override is not proven.
 */
export function opencodeHomeLeakMessage(home: string, items: readonly string[], reason: string): string {
  return (
    `~/.opencode would leak into profile chats: ${join(home, ".opencode")} holds ${items.join(", ")}, which OpenCode loads ` +
    `in every chat, and ${OPENCODE_TEST_HOME_ENV} cannot be relied on to keep it out (${reason}). ` +
    "Move those into ~/.config/opencode or remove them, then try again."
  );
}

/** Probes that proved the override, per CLI binary (path, size, mtime): one probe per installed OpenCode. */
const provenTestHome = new Map<string, Promise<OpencodeTestHomeProbe>>();

async function verifyTestHome(cliBin: string | null | undefined, scratchDir: string): Promise<OpencodeTestHomeProbe> {
  if (!cliBin) return { effective: false, reason: "no OpenCode binary was found to check it" };
  let key: string;
  try {
    const info = await stat(cliBin);
    key = `${cliBin}\0${info.size}\0${info.mtimeMs}`;
  } catch {
    return { effective: false, reason: `the OpenCode binary ${cliBin} could not be read` };
  }
  const known = provenTestHome.get(key);
  if (known !== undefined) return await known;
  const probe = probeOpencodeTestHome({ opencodeBin: cliBin, scratchDir });
  provenTestHome.set(key, probe);
  const result = await probe;
  if (!result.effective) provenTestHome.delete(key);
  return result;
}

async function prepareOpenCode(ctx: SessionProfilePrepareContext<"opencode">): Promise<OpenCodePreparedSection> {
  const { resolved } = ctx;
  const configDir = join(ctx.stagingDir, CONFIG_DIR);
  await mkdir(configDir, { mode: 0o700 });

  // MCP servers: Orquester's own names are its session tools' (registered per thread by the host).
  const mcp: JsonObject = {};
  for (const server of resolved.mcpServers) {
    if (server.name === SESSION_TOOLS_SERVER_NAME || OPENCODE_SESSION_TOOLS_SERVER_PATTERN.test(server.name)) {
      ctx.logger.warn(`OpenCode profile ${resolved.profileId}: the MCP server name "${server.name}" is Orquester's own; it was left out.`);
      continue;
    }
    mcp[server.name] = opencodeMcpEntry(server);
  }

  const hiddenSkills = resolved.settings.hideBuiltinSkills ? [...OPENCODE_BUILTIN_SKILLS] : [];
  const runtime = opencodeRuntimeConfig(await globalConfig(ctx.systemHomes.opencodeDir));
  const config: JsonObject = {
    $schema: SCHEMA_URL,
    ...runtime,
    ...(Object.keys(mcp).length > 0 ? { mcp } : {}),
    skills: { paths: [...OPENCODE_PROJECT_SKILL_PATHS] },
    ...(hiddenSkills.length > 0 ? { permission: withSkillsDenied(runtime.permission, hiddenSkills) } : {})
  };
  await writeNew(join(configDir, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`, 0o600);

  // ALWAYS written, empty without instructions: OpenCode takes the first of `<config dir>/AGENTS.md`
  // and `~/.claude/CLAUDE.md` that exists as the global instructions, and skips an empty file.
  const instructions = resolved.instructions.trim();
  await writeNew(join(configDir, INSTRUCTIONS_FILE), instructions.length > 0 ? `${instructions}\n` : "", 0o600);

  const skills: string[] = [];
  for (const skill of resolved.skills) {
    await mkdir(join(configDir, "skills"), { recursive: true, mode: 0o700 });
    await copyEntry(skill.dir, join(configDir, "skills", skill.name), { symlinks: "skip", followRoot: true });
    skills.push(skill.name);
  }

  // A command OpenCode cannot decode fails the WHOLE server's config load: leave it out instead.
  const commands: string[] = [];
  for (const command of resolved.commands) {
    const text = await readFile(command.file, "utf8");
    try {
      checkCommandFrontmatter(parseMarkdownDocument(text).frontmatter);
    } catch (error) {
      ctx.logger.warn(
        `OpenCode profile ${resolved.profileId}: the command "${command.name}" was left out: ${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }
    await writeNew(join(configDir, "commands", `${command.name}.md`), text, 0o600);
    commands.push(command.name);
  }

  // Plugins: the profile's files, then Orquester's status plugin under its own name (it wins).
  const pluginDir = join(configDir, "plugin");
  await mkdir(pluginDir, { mode: 0o700 });
  const taken = new Set<string>([OPENCODE_STATUS_PLUGIN_FILE]);
  const plugins: OpenCodePreparedSection["plugins"] = [];
  for (const plugin of resolved.plugins) {
    const files: string[] = [];
    for (const file of await pluginFiles(plugin.cacheDir)) {
      if (taken.has(file)) {
        ctx.logger.warn(`OpenCode profile ${resolved.profileId}: the plugin file "${file}" of "${plugin.name}" is already taken; it was left out.`);
        continue;
      }
      taken.add(file);
      await copyFile(join(plugin.cacheDir, file), join(pluginDir, file));
      await chmod(join(pluginDir, file), 0o600);
      files.push(file);
    }
    plugins.push({ itemId: plugin.id, name: plugin.name, files });
  }
  await writeNew(join(pluginDir, OPENCODE_STATUS_PLUGIN_FILE), openCodeStatusPluginSource(), 0o600);

  // The shadow (refreshed again at every launch): links point outside the dir, so they survive the rename.
  const realConfigHome = dirname(ctx.systemHomes.opencodeDir);
  await buildXdgConfigShadow({ realConfigHome, shadowDir: join(ctx.stagingDir, XDG_DIR), exclude: ["opencode"] });

  // `$HOME/.opencode`: OPENCODE_TEST_HOME points OpenCode at an empty dir instead, when the CLI is
  // proven to honour it; otherwise a home whose `.opencode` holds config refuses the profile.
  await mkdir(join(ctx.stagingDir, TEST_HOME_DIR), { mode: 0o700 });
  const probe = await verifyTestHome(ctx.cliBin, join(ctx.stagingDir, PROBE_DIR));
  const userHome = ctx.systemHomes.home;
  if (!probe.effective) {
    const leaks = await opencodeHomeConfigItems(userHome);
    if (leaks.length > 0) throw new Error(opencodeHomeLeakMessage(userHome, leaks, probe.reason));
  }

  return {
    configDir: CONFIG_DIR,
    xdgConfigHome: XDG_DIR,
    realConfigHome,
    skills,
    commands,
    mcpServerNames: Object.keys(mcp),
    plugins,
    hiddenSkills,
    userHome,
    testHome: probe.effective ? { dir: TEST_HOME_DIR, verified: true } : { dir: TEST_HOME_DIR, verified: false, reason: probe.reason }
  };
}

export const opencodePreparer: SessionProfilePreparer<"opencode"> = {
  agent: "opencode",
  perAccount: false,
  version: OPENCODE_PREPARER_VERSION,
  inputs: (ctx) => CONFIG_FILE_NAMES.map((name) => join(ctx.systemHomes.opencodeDir, name)),
  prepare: prepareOpenCode
};

/** One shadow refresh per shadow dir at a time: two launches of one version share it. */
const shadowRefreshes = new Map<string, Promise<unknown>>();

function refreshShadow(realConfigHome: string, shadowDir: string): Promise<unknown> {
  const running = shadowRefreshes.get(shadowDir);
  if (running !== undefined) return running;
  const refresh = buildXdgConfigShadow({ realConfigHome, shadowDir, exclude: ["opencode"] }).finally(() => {
    shadowRefreshes.delete(shadowDir);
  });
  shadowRefreshes.set(shadowDir, refresh);
  return refresh;
}

/**
 * The launch contribution (`../launch.ts`): refresh the version's shadow of the real `~/.config`
 * (the launcher env's `XDG_CONFIG_HOME` when it names one — that is the config home a Global
 * server of this launch reads), then name the version's keyed server. Throws (→
 * `PROFILE_NOT_READY`) when the shadow cannot be refreshed.
 */
export async function opencodeLaunchContribution(ctx: ProfileLaunchContext<"opencode">): Promise<ProfileLaunchContribution> {
  const { preparedDir, profileId } = ctx.profile;
  const section = ctx.manifestSection;
  const shadowDir = join(preparedDir, section.xdgConfigHome);
  const configDir = join(preparedDir, section.configDir);
  const launcherConfigHome = ctx.launchEnv.XDG_CONFIG_HOME;
  const realConfigHome = launcherConfigHome !== undefined && isAbsolute(launcherConfigHome) ? launcherConfigHome : section.realConfigHome;
  if (!(await lstat(join(configDir, INSTRUCTIONS_FILE)).then((info) => info.isFile(), () => false))) {
    // Without it OpenCode would read the user's ~/.claude/CLAUDE.md as the global instructions.
    throw new Error(`The prepared OpenCode config's ${INSTRUCTIONS_FILE} is missing (an older or damaged preparation); prepare the profile again.`);
  }
  const testHome = section.testHome;
  if (testHome?.verified !== true) {
    const userHome = section.userHome ?? homedir();
    const leaks = await opencodeHomeConfigItems(userHome);
    if (leaks.length > 0) {
      throw new Error(opencodeHomeLeakMessage(userHome, leaks, testHome?.reason ?? "this prepared version predates the check"));
    }
  }
  await refreshShadow(realConfigHome, shadowDir);
  return {
    serverPool: {
      key: opencodeProfilePoolKey(profileId, preparedDir),
      env: {
        XDG_CONFIG_HOME: shadowDir,
        OPENCODE_CONFIG_DIR: configDir,
        ...OPENCODE_PROFILE_FLAGS,
        ...(testHome !== undefined ? { [OPENCODE_TEST_HOME_ENV]: join(preparedDir, testHome.dir) } : {})
      },
      unsetEnv: [...OPENCODE_PROFILE_UNSET]
    }
  };
}
