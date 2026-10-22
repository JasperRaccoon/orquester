/**
 * Claude adapter — skill discovery (spec §4.6.2, §4.6.4, §4.6.8).
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/provider/Drivers/ClaudeSkills.ts`, translated from Effect
 * into plain TypeScript and with T3's `yaml` dependency replaced by a
 * line-scanner over the frontmatter keys this file actually reads (no new
 * dependency is allowed in this build).
 *
 * Claude Code loads skills from `<CLAUDE_CONFIG_DIR>/skills` (user scope),
 * `<cwd>/.claude/skills` (project scope) and each enabled installed plugin
 * (`plugin:skill`, see {@link discoverPluginSkillRoots}), one directory per
 * skill with a `SKILL.md` carrying YAML frontmatter. The user root wins on a
 * name collision, matching the CLI. `.agents/skills` is a Codex location and is
 * deliberately NOT scanned: verified against the CLI, a skill that lives only
 * there is answered with `Unknown command`.
 *
 * The Agent SDK's init handshake reports a skill as a bare command name with
 * no path, and the path is what a source badge, an enabled state and the
 * invocability flags need — which is why the snapshot scans disk instead.
 */

import { promises as fs } from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";

import type { Skill } from "@orquester/api/agent-chat";

import { SKILL_MENTION_PATTERN } from "./skill-dispatch.ts";

type ClaudeSkillScope = "user" | "project" | "plugin";

interface ClaudeSkillRoot {
  directory: string;
  scope: ClaudeSkillScope;
  /** A plugin root's namespace: its skills are `<prefix>:<skill>`. */
  prefix?: string;
}

/** Bounded so a pathological skills dir cannot stall a `sendTurn` rescan. */
const MAX_SKILL_DIRS_PER_ROOT = 500;

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

type SkillFrontmatter =
  | { kind: "missing" }
  | { kind: "malformed" }
  | {
      kind: "parsed";
      name?: string;
      description?: string;
      userInvocationOnly?: boolean;
      userInvocable?: boolean;
    };

/**
 * Claude Code accepts the YAML 1.1 boolean spellings (`yes`/`no`, `on`/`off`,
 * `1`/`0`). Verified against the CLI by T3: a skill carrying
 * `user-invocable: no` is absent from its published slash commands, so a
 * strict `=== false` would offer a command the CLI rejects.
 */
export function parseFrontmatterBoolean(value: string): boolean | undefined {
  switch (value.trim().toLowerCase()) {
    case "true":
    case "yes":
    case "on":
    case "y":
    case "1":
      return true;
    case "false":
    case "no":
    case "off":
    case "n":
    case "0":
      return false;
    default:
      return undefined;
  }
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * Read the three frontmatter keys this adapter uses. Only top-level
 * `key: value` lines are considered — a nested block is skipped rather than
 * guessed at, and a frontmatter block whose opening fence never closes is
 * `missing`, exactly as an unparsable one is `malformed`.
 */
function parseSkillFrontmatter(contents: string): SkillFrontmatter {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) {
    return { kind: "missing" };
  }

  const body = match[1] ?? "";
  let sawKey = false;
  let name: string | undefined;
  let description: string | undefined;
  let userInvocationOnly: boolean | undefined;
  let userInvocable: boolean | undefined;

  for (const rawLine of body.split(/\r?\n/)) {
    if (rawLine.trim().length === 0 || rawLine.trimStart().startsWith("#")) {
      continue;
    }
    // Indented lines belong to a nested structure; this scanner reads only the
    // top level, so they are not keys.
    if (/^\s/.test(rawLine)) {
      continue;
    }
    const separator = rawLine.indexOf(":");
    if (separator < 0) {
      // A frontmatter body that is not a key/value map at all is malformed —
      // the CLI would not load the skill either.
      return { kind: "malformed" };
    }
    sawKey = true;
    const key = rawLine.slice(0, separator).trim();
    const value = unquote(rawLine.slice(separator + 1));
    if (key === "name") {
      name = value.trim().length > 0 ? value.trim() : undefined;
    } else if (key === "description") {
      description = value.trim().length > 0 ? value.trim() : undefined;
    } else if (key === "disable-model-invocation") {
      userInvocationOnly = parseFrontmatterBoolean(value);
    } else if (key === "user-invocable") {
      userInvocable = parseFrontmatterBoolean(value);
    }
  }

  if (!sawKey) {
    return { kind: "malformed" };
  }

  return {
    kind: "parsed",
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(userInvocationOnly === true ? { userInvocationOnly: true } : {}),
    ...(userInvocable === false ? { userInvocable: false } : {})
  };
}

/**
 * Where an administrator installs the policy file whose settings outrank every
 * user and project one. Absent on almost every machine, which is why a missing
 * file is the normal case rather than an error.
 */
function claudeManagedSettingsPath(platform: NodeJS.Platform): string | undefined {
  if (platform === "darwin") {
    return "/Library/Application Support/ClaudeCode/managed-settings.json";
  }
  if (platform === "win32") {
    const programData = process.env.PROGRAMDATA?.trim();
    return programData ? nodePath.join(programData, "ClaudeCode", "managed-settings.json") : undefined;
  }
  return "/etc/claude-code/managed-settings.json";
}

/**
 * Settings files Claude Code merges for `skillOverrides`, in increasing
 * precedence: user, project, project-local, the repository root's local file
 * when the cwd sits deeper in a checkout, then the administrator's managed
 * policy, which wins outright.
 */
function skillOverrideSettingsPaths(input: {
  configDir: string;
  cwd?: string;
  platform: NodeJS.Platform;
  repositoryRoot?: string;
}): string[] {
  const { configDir, cwd, platform, repositoryRoot } = input;
  const managed = claudeManagedSettingsPath(platform);
  const root =
    repositoryRoot !== undefined && repositoryRoot !== cwd ? repositoryRoot : undefined;
  return [
    nodePath.join(configDir, "settings.json"),
    ...(cwd
      ? [
          nodePath.join(cwd, ".claude", "settings.json"),
          nodePath.join(cwd, ".claude", "settings.local.json")
        ]
      : []),
    ...(root ? [nodePath.join(root, ".claude", "settings.local.json")] : []),
    ...(managed ? [managed] : [])
  ];
}

/**
 * The four states Claude Code accepts. The CLI validates the whole map, not
 * each entry: one entry with an unknown value makes it drop every override in
 * that file, so this does the same rather than applying the valid siblings the
 * CLI ignores.
 */
const SKILL_OVERRIDE_VALUES = new Set(["on", "name-only", "user-invocable-only", "off"]);

interface SkillOverride {
  enabled: boolean;
  userInvocationOnly: boolean;
}

function parseSkillOverrideValue(value: string): SkillOverride {
  switch (value) {
    case "off":
      return { enabled: false, userInvocationOnly: false };
    case "user-invocable-only":
      return { enabled: true, userInvocationOnly: true };
    default:
      return { enabled: true, userInvocationOnly: false };
  }
}

/**
 * These settings files are hand-edited and Claude Code itself tolerates
 * comments and trailing commas in them, so the read is lenient in exactly
 * those two ways and strict about everything else.
 */
function parseLenientJson(contents: string): unknown {
  const withoutComments = stripJsonComments(contents);
  const withoutTrailingCommas = withoutComments.replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.parse(withoutTrailingCommas);
  } catch {
    return undefined;
  }
}

function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  let index = 0;
  while (index < input.length) {
    const ch = input[index]!;
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      index += 1;
      continue;
    }
    if (ch === "/" && input[index + 1] === "/") {
      const nl = input.indexOf("\n", index);
      index = nl === -1 ? input.length : nl;
      continue;
    }
    if (ch === "/" && input[index + 1] === "*") {
      const end = input.indexOf("*/", index + 2);
      index = end === -1 ? input.length : end + 2;
      continue;
    }
    out += ch;
    index += 1;
  }
  return out;
}

export function readSkillOverridesFromSettings(
  contents: string
): ReadonlyMap<string, SkillOverride> | undefined {
  const parsed = parseLenientJson(contents);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const overrides = (parsed as { skillOverrides?: unknown }).skillOverrides;
  if (overrides === null || typeof overrides !== "object" || Array.isArray(overrides)) {
    return undefined;
  }
  const result = new Map<string, SkillOverride>();
  for (const [name, value] of Object.entries(overrides as Record<string, unknown>)) {
    if (typeof value !== "string" || !SKILL_OVERRIDE_VALUES.has(value)) {
      // One bad entry drops the whole file's overrides, as the CLI does.
      return undefined;
    }
    result.set(name, parseSkillOverrideValue(value));
  }
  return result;
}

async function readFileOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Nearest ancestor of `cwd` (inclusive) holding a `.git` entry, which is the
 * boundary Claude Code walks up to for project settings. `undefined` outside a
 * repository.
 */
async function findRepositoryRoot(cwd: string): Promise<string | undefined> {
  let current = nodePath.resolve(cwd);
  for (;;) {
    try {
      await fs.stat(nodePath.join(current, ".git"));
      return current;
    } catch {
      // Not a repository root; keep walking.
    }
    const parent = nodePath.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

/**
 * The `enabledPlugins` map of one settings file: `true`/`false` for a plugin
 * the file switches on or off, `null` for an extended value (an object), which
 * replaces a lower-precedence value without enabling the plugin here.
 * `undefined` when the file has no readable map.
 */
export function readEnabledPluginsFromSettings(
  contents: string
): ReadonlyMap<string, boolean | null> | undefined {
  const parsed = parseLenientJson(contents);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const enabled = (parsed as { enabledPlugins?: unknown }).enabledPlugins;
  if (enabled === null || typeof enabled !== "object" || Array.isArray(enabled)) {
    return undefined;
  }
  const result = new Map<string, boolean | null>();
  for (const [key, value] of Object.entries(enabled as Record<string, unknown>)) {
    result.set(key, typeof value === "boolean" ? value : null);
  }
  return result;
}

interface SkillSettings {
  overrides: ReadonlyMap<string, SkillOverride>;
  /** Plugin ids (`name@marketplace`) the merged settings switch on; absent or `false` = off. */
  enabledPlugins: ReadonlyMap<string, boolean>;
}

async function readSkillSettings(input: { configDir: string; cwd?: string }): Promise<SkillSettings> {
  const repositoryRoot = input.cwd === undefined ? undefined : await findRepositoryRoot(input.cwd);
  const merged = new Map<string, SkillOverride>();
  const enabledPlugins = new Map<string, boolean>();
  const paths = skillOverrideSettingsPaths({
    configDir: input.configDir,
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    platform: process.platform,
    ...(repositoryRoot !== undefined ? { repositoryRoot } : {})
  });
  for (const settingsPath of paths) {
    const contents = await readFileOrUndefined(settingsPath);
    if (contents === undefined) {
      continue;
    }
    for (const [name, override] of readSkillOverridesFromSettings(contents) ?? []) {
      merged.set(name, override);
    }
    for (const [key, value] of readEnabledPluginsFromSettings(contents) ?? []) {
      if (value === null) {
        enabledPlugins.delete(key);
      } else {
        enabledPlugins.set(key, value);
      }
    }
  }
  return { overrides: merged, enabledPlugins };
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function realPathOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await fs.realpath(path);
  } catch {
    return undefined;
  }
}

function isInsideDirectory(directory: string, candidate: string): boolean {
  const relative = nodePath.relative(directory, candidate);
  return relative !== ".." && !relative.startsWith(`..${nodePath.sep}`) && !nodePath.isAbsolute(relative);
}

function expandHomePath(value: string): string {
  if (value === "~") return nodeOs.homedir();
  if (value.startsWith("~/")) return nodePath.join(nodeOs.homedir(), value.slice(2));
  return value;
}

// Adapted from T3 Code (MIT): apps/server/src/provider/Drivers/ClaudeSkills.ts
/**
 * The repository a plugin install record of `cwd` belongs to. Claude shares
 * project-scoped plugin installs across linked worktrees, so a linked
 * worktree (a `.git` FILE pointing at `<common>/worktrees/<name>`, whose
 * `gitdir` backlink comes back to it) answers its common repository's root.
 */
async function findPluginRepositoryRoot(cwd: string): Promise<string | undefined> {
  const root = await findRepositoryRoot(cwd);
  if (root === undefined) return undefined;
  const gitFile = ((await readFileOrUndefined(nodePath.join(root, ".git"))) ?? "").trim();
  if (!gitFile.startsWith("gitdir:")) return root;
  const gitDirectory = nodePath.resolve(root, gitFile.slice("gitdir:".length).trim());
  const commonFile = ((await readFileOrUndefined(nodePath.join(gitDirectory, "commondir"))) ?? "").trim();
  const worktreeFile = ((await readFileOrUndefined(nodePath.join(gitDirectory, "gitdir"))) ?? "").trim();
  if (!commonFile || !worktreeFile) return root;
  const commonDirectory = nodePath.resolve(gitDirectory, commonFile);
  const backlink = await realPathOrUndefined(nodePath.resolve(gitDirectory, worktreeFile));
  const worktreeGit = await realPathOrUndefined(nodePath.join(root, ".git"));
  if (
    nodePath.dirname(gitDirectory) !== nodePath.join(commonDirectory, "worktrees") ||
    backlink === undefined ||
    backlink !== worktreeGit
  ) {
    return root;
  }
  return nodePath.basename(commonDirectory) === ".git" ? nodePath.dirname(commonDirectory) : commonDirectory;
}

interface InstalledPlugin {
  scope: "user" | "project" | "local" | "managed";
  installPath: string;
  projectPath?: string;
}

const INSTALL_SCOPES: ReadonlySet<string> = new Set(["user", "project", "local", "managed"]);

/** One `installed_plugins.json` record, or null for one that does not read. */
function installedPluginOf(value: unknown): InstalledPlugin | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.scope !== "string" || !INSTALL_SCOPES.has(record.scope)) return null;
  if (typeof record.installPath !== "string" || record.installPath.length === 0) return null;
  const projectPath =
    typeof record.projectPath === "string" && record.projectPath.length > 0 ? record.projectPath : undefined;
  return {
    scope: record.scope as InstalledPlugin["scope"],
    installPath: record.installPath,
    ...(projectPath !== undefined ? { projectPath } : {})
  };
}

/** `installed_plugins.json`'s `plugins` map, or undefined when the file is missing or malformed. */
async function readInstalledPlugins(pluginsDir: string): Promise<Record<string, unknown[]> | undefined> {
  const contents = await readFileOrUndefined(nodePath.join(pluginsDir, "installed_plugins.json"));
  if (contents === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return undefined;
  }
  const plugins = (parsed as { plugins?: unknown } | null)?.plugins;
  if (plugins === null || typeof plugins !== "object" || Array.isArray(plugins)) return undefined;
  const result: Record<string, unknown[]> = {};
  for (const [key, entries] of Object.entries(plugins as Record<string, unknown>)) {
    if (Array.isArray(entries)) result[key] = entries;
  }
  return result;
}

/**
 * The fields of `.claude-plugin/plugin.json` discovery reads, each dropped
 * when it does not read: a malformed manifest is a plugin named after its
 * id with only its default `skills/`.
 */
async function readPluginManifest(installPath: string): Promise<{ name?: string; skills?: string[] }> {
  const contents = await readFileOrUndefined(nodePath.join(installPath, ".claude-plugin", "plugin.json"));
  if (contents === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" && record.name.trim().length > 0 ? record.name.trim() : undefined;
  const skills =
    typeof record.skills === "string"
      ? [record.skills]
      : Array.isArray(record.skills) && record.skills.every((entry) => typeof entry === "string")
        ? (record.skills as string[])
        : undefined;
  return { ...(name !== undefined ? { name } : {}), ...(skills !== undefined ? { skills } : {}) };
}

/**
 * The skill roots of the plugin at `installPath` named `prefix`: its
 * `skills/` dir; the plugin itself when it is one root `SKILL.md` and
 * declares no skills; and each `skills` path its manifest declares, kept only
 * inside the plugin, through symlinks too (the CLI's loader rejects the rest).
 */
async function pluginSkillRoots(installPath: string, prefix: string, declared: string[] | undefined): Promise<ClaudeSkillRoot[]> {
  const roots: ClaudeSkillRoot[] = [];
  const defaultDirectory = nodePath.join(installPath, "skills");
  const hasDefaultDirectory = await exists(defaultDirectory);
  if (hasDefaultDirectory) roots.push({ directory: defaultDirectory, scope: "plugin", prefix });
  if (declared === undefined && !hasDefaultDirectory && (await exists(nodePath.join(installPath, "SKILL.md")))) {
    roots.push({ directory: installPath, scope: "plugin", prefix });
  }
  const canonicalInstallPath = await realPathOrUndefined(installPath);
  for (const relative of declared ?? []) {
    const directory = nodePath.resolve(installPath, relative);
    if (canonicalInstallPath === undefined || !isInsideDirectory(installPath, directory)) continue;
    const canonicalDirectory = await realPathOrUndefined(directory);
    if (canonicalDirectory !== undefined && isInsideDirectory(canonicalInstallPath, canonicalDirectory)) {
      roots.push({ directory, scope: "plugin", prefix });
    }
  }
  return roots;
}

// Adapted from T3 Code (MIT): apps/server/src/provider/Drivers/ClaudeSkills.ts
/**
 * The skill roots of the account's installed plugins that its settings
 * enable (`enabledPlugins[id] === true`). Installs are read from
 * `<CLAUDE_CONFIG_DIR>/plugins/installed_plugins.json`, or from
 * `CLAUDE_CODE_PLUGIN_CACHE_DIR` when the CLI is told to use another cache. A
 * `user`/`managed` install applies everywhere; a `project`/`local` one only
 * to its project — or to another worktree of the same repository. The first
 * install whose directory exists wins, in registry order, as the CLI's
 * loader does. A missing or malformed registry is no plugins.
 */
async function discoverPluginSkillRoots(input: {
  configDir: string;
  cwd?: string;
  pluginCacheDir?: string;
  enabledPlugins: ReadonlyMap<string, boolean>;
}): Promise<ClaudeSkillRoot[]> {
  const base = input.cwd ?? ".";
  const pluginsDir =
    input.pluginCacheDir !== undefined && input.pluginCacheDir.trim().length > 0
      ? nodePath.resolve(base, expandHomePath(input.pluginCacheDir.trim()))
      : nodePath.join(input.configDir, "plugins");
  const installed = await readInstalledPlugins(pluginsDir);
  if (installed === undefined) return [];
  // The CLI's cwd resolves symlinks; registry `projectPath` values stay lexical.
  const workspace =
    input.cwd === undefined ? undefined : ((await realPathOrUndefined(input.cwd)) ?? nodePath.resolve(input.cwd));
  const repositoryRoot = workspace === undefined ? undefined : await findPluginRepositoryRoot(workspace);

  const roots: ClaudeSkillRoot[] = [];
  for (const key of Object.keys(installed).sort()) {
    if (input.enabledPlugins.get(key) !== true) continue;
    const applicable: InstalledPlugin[] = [];
    for (const record of installed[key]!.map(installedPluginOf)) {
      if (record === null) continue;
      if (record.scope === "user" || record.scope === "managed") {
        applicable.push(record);
      } else if (record.projectPath !== undefined && workspace !== undefined) {
        if (
          nodePath.resolve(record.projectPath) === workspace ||
          (repositoryRoot !== undefined && (await findPluginRepositoryRoot(record.projectPath)) === repositoryRoot)
        ) {
          applicable.push(record);
        }
      }
    }
    let install: InstalledPlugin | undefined;
    for (const record of applicable) {
      if (await exists(nodePath.resolve(base, record.installPath))) {
        install = record;
        break;
      }
    }
    install ??= applicable[0];
    if (install === undefined) continue;
    const installPath = nodePath.resolve(base, install.installPath);
    const manifest = await readPluginManifest(installPath);
    const prefix = manifest.name ?? key.split("@")[0];
    if (!prefix) continue;
    roots.push(...(await pluginSkillRoots(installPath, prefix, manifest.skills)));
  }
  return roots;
}

/** A plugin loaded by path, and the name it goes by when its manifest names none (default: its directory's). */
export interface ClaudePluginDir {
  path: string;
  name?: string;
}

/** The skill roots of plugins loaded by path (an Agent Profile's), each named by its manifest, else its fallback. */
async function pluginDirSkillRoots(pluginDirs: readonly ClaudePluginDir[]): Promise<ClaudeSkillRoot[]> {
  const roots: ClaudeSkillRoot[] = [];
  for (const dir of pluginDirs) {
    const installPath = nodePath.resolve(dir.path);
    const manifest = await readPluginManifest(installPath);
    const prefix = manifest.name ?? dir.name ?? nodePath.basename(installPath);
    if (!prefix) continue;
    roots.push(...(await pluginSkillRoots(installPath, prefix, manifest.skills)));
  }
  return roots;
}

interface DiscoverClaudeSkillsInput {
  /** The absolute `CLAUDE_CONFIG_DIR` the spawned CLI will see. */
  configDir: string;
  cwd?: string;
  /** The `CLAUDE_CODE_PLUGIN_CACHE_DIR` the spawned CLI will see, when set. */
  pluginCacheDir?: string;
  /**
   * The plugins whose skills are listed. Absent: the account's installed
   * plugins its settings enable (a Global chat). A list: exactly the plugins
   * at these directories — an Agent Profile chat loads its own plugins by
   * path and switches every installed one off.
   */
  pluginDirs?: readonly ClaudePluginDir[];
}

/**
 * Enumerate Claude Code skills from the config dir, the workspace
 * `.claude/skills` and the enabled plugins. Discovery is best-effort:
 * unreadable roots, malformed plugin registries or manifests and malformed
 * skill entries are skipped so a broken skill never degrades the snapshot.
 * Roots are listed highest precedence first and the first hit for a name wins,
 * matching Claude Code. A skill's identity is its **directory name**, not the
 * frontmatter `name`: the CLI publishes `probe-alias/` as `probe-alias` even
 * when its frontmatter says otherwise, and only `skillOverrides["probe-alias"]`
 * switches it off. A plugin's skills are `<plugin>:<directory>`.
 */
export async function discoverClaudeSkills(
  input: DiscoverClaudeSkillsInput
): Promise<Skill[]> {
  const settings = await readSkillSettings(input);
  const roots: ClaudeSkillRoot[] = [
    { directory: nodePath.join(input.configDir, "skills"), scope: "user" },
    ...(input.cwd
      ? [{ directory: nodePath.join(input.cwd, ".claude", "skills"), scope: "project" as const }]
      : []),
    ...(input.pluginDirs !== undefined
      ? await pluginDirSkillRoots(input.pluginDirs)
      : await discoverPluginSkillRoots({
          configDir: input.configDir,
          ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
          ...(input.pluginCacheDir !== undefined ? { pluginCacheDir: input.pluginCacheDir } : {}),
          enabledPlugins: settings.enabledPlugins
        }))
  ];
  return collectSkills(roots, settings.overrides);
}

/**
 * The skills of plugins at these directories alone — an Agent Profile's
 * Claude plugins, for its composer before a session reports its own.
 */
export async function discoverClaudePluginSkills(pluginDirs: readonly ClaudePluginDir[]): Promise<Skill[]> {
  return collectSkills(await pluginDirSkillRoots(pluginDirs), new Map());
}

async function collectSkills(
  roots: readonly ClaudeSkillRoot[],
  overrides: ReadonlyMap<string, SkillOverride>
): Promise<Skill[]> {
  const byName = new Map<string, Skill>();
  for (const root of roots) {
    // A plugin that is itself one skill: its root `SKILL.md`, named by its directory.
    const singleSkill = root.prefix !== undefined && (await exists(nodePath.join(root.directory, "SKILL.md")));
    let entries: string[];
    if (singleSkill) {
      entries = [nodePath.basename(root.directory)];
    } else {
      try {
        entries = await fs.readdir(root.directory);
      } catch {
        continue;
      }
    }

    for (const entry of [...entries].sort().slice(0, MAX_SKILL_DIRS_PER_ROOT)) {
      const directoryName = entry.trim();
      if (directoryName.length === 0) {
        continue;
      }
      const skillPath = singleSkill
        ? nodePath.join(root.directory, "SKILL.md")
        : nodePath.join(root.directory, entry, "SKILL.md");
      let name = directoryName;
      let frontmatter: SkillFrontmatter | undefined;
      if (root.prefix !== undefined) {
        frontmatter = await readFrontmatter(skillPath);
        if (frontmatter === undefined || frontmatter.kind === "malformed") continue;
        // Folder skills use their folder; only a single root SKILL.md uses its `name` field.
        const declared = singleSkill && frontmatter.kind === "parsed" ? (frontmatter.name ?? "") : "";
        const unprefixed = declared.startsWith(`${root.prefix}:`) ? declared.slice(root.prefix.length + 1) : declared;
        name = `${root.prefix}:${(unprefixed || entry).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
        // Only a name the composer's `$name` grammar reads whole can be offered and dispatched.
        const [mention] = `$${name}`.matchAll(SKILL_MENTION_PATTERN);
        if (mention?.[2] !== name) continue;
      }
      if (byName.has(name)) {
        continue;
      }
      frontmatter ??= await readFrontmatter(skillPath);
      // Malformed frontmatter means the skill will not load in Claude Code
      // either — skip it rather than surfacing a broken entry.
      if (frontmatter === undefined || frontmatter.kind === "malformed") {
        continue;
      }
      // `skillOverrides` name user and project skills; a plugin's are switched with the plugin.
      const override = root.prefix !== undefined ? undefined : overrides.get(name);
      const userInvocationOnly =
        (frontmatter.kind === "parsed" && frontmatter.userInvocationOnly === true) ||
        override?.userInvocationOnly === true;
      byName.set(name, {
        name,
        path: skillPath,
        enabled: override?.enabled ?? true,
        scope: root.scope,
        ...(frontmatter.kind === "parsed" && frontmatter.description !== undefined
          ? { description: frontmatter.description }
          : {}),
        ...(userInvocationOnly ? { userInvocationOnly: true } : {}),
        ...(frontmatter.kind === "parsed" && frontmatter.userInvocable === false
          ? { userInvocable: false }
          : {})
      });
    }
  }

  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

async function readFrontmatter(skillPath: string): Promise<SkillFrontmatter | undefined> {
  const contents = await readFileOrUndefined(skillPath);
  return contents === undefined ? undefined : parseSkillFrontmatter(contents);
}

/**
 * The set handed to the dispatcher (§4.6.4): disabled and agent-reserved
 * skills are excluded, so a rewritten `/name` can never be one the CLI would
 * answer with a notice.
 */
export function dispatchableSkillNames(skills: readonly Skill[]): Set<string> {
  return new Set(
    skills.filter((skill) => skill.enabled && skill.userInvocable !== false).map((s) => s.name)
  );
}
