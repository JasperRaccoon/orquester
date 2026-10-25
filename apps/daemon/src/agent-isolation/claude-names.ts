/**
 * Agent isolation — what Claude Code calls the skills, commands, plugins and
 * project MCP servers it finds on disk (spec §6.1). A profile chat passes the
 * SDK `skills` allow-list, which hides every skill or command NOT on it from
 * the model, so the launcher must name everything a profile chat is meant to
 * keep: the profile's plugins' entries and the project's own `.claude/`
 * skills and commands. And it runs with `strictMcpConfig`, which drops the
 * project's `.mcp.json` and every plugin's MCP servers, so those are read here
 * and passed back explicitly.
 *
 * Rules observed on Claude Code 2.1.285 with no model call (SDK
 * `getContextUsage()` / `supportedCommands()` / `mcpServerStatus()`), the
 * skill names re-checked on 2.1.307 against the `skills` allow-list itself:
 * - A skill folder's name — what the allow-list matches — is its DIRECTORY
 *   name; its frontmatter `name` is only what `getContextUsage()` and
 *   `supportedCommands()` display (an allow-list naming it hides the skill).
 *   A plugin's skills follow {@link claudePluginSkillName}, under the
 *   plugin's name ({@link claudePluginNameOf}).
 * - A command is its file stem, subdirectories joined by `:` (`git/x.md` →
 *   `git:x`); a plugin's is `<plugin>:<that>`.
 * - A plugin's `plugin.json` `skills` paths ADD to `skills/`; its `commands`
 *   paths REPLACE `commands/` (a file path is one command named by its stem).
 * - Project skills and commands come from `.claude/` of the cwd and every
 *   ancestor below the user's home (the home itself is the user scope).
 * - Project `.mcp.json` files are read from the cwd up to `/` (the home
 *   included); the nearest definition of a name wins. In an SDK session they
 *   load without an approval prompt, minus `disabledMcpjsonServers`.
 *
 * Where the files are read: this machine by default. A box project's files live in its box (the
 * host directory is an empty stub), so the project walks — {@link claudeProjectEntryNames},
 * {@link claudeProjectMcpServers}, and {@link readJsonObject} of a project file — take the box's
 * `ProjectFs` (`boxes/remote/fs/project-fs.ts`, host paths in, mapped to box paths) for those.
 *
 * No dynamic `import()`: the agent host imports this module.
 */

import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { parseMarkdownDocument } from "../agent-profile/infra/frontmatter.ts";
import { HostProjectFs, type ProjectFs, type ProjectFsDirEntry } from "../boxes/remote/fs/project-fs.ts";

type Doc = Record<string, unknown>;

/** The reads this module makes, against HOST paths: this machine's files, or a box project's. */
export type ClaudeNamesFs = Pick<ProjectFs, "stat" | "readdir" | "read">;

const HOST_FS: ClaudeNamesFs = new HostProjectFs();

/** Directory entries, sorted; `[]` when missing or not a directory. */
async function entries(dir: string, fs: ClaudeNamesFs): Promise<ProjectFsDirEntry[]> {
  try {
    return (await fs.readdir(dir)).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** What `path` is, symlinks followed; null when nothing (readable) is there. */
async function kindOf(path: string, fs: ClaudeNamesFs): Promise<string | null> {
  return fs.stat(path).then(
    (st) => st?.kind ?? null,
    () => null
  );
}

async function isDir(path: string, fs: ClaudeNamesFs): Promise<boolean> {
  return (await kindOf(path, fs)) === "dir";
}

async function isFile(path: string, fs: ClaudeNamesFs): Promise<boolean> {
  return (await kindOf(path, fs)) === "file";
}

/**
 * The most bytes read from one file here. These are config files (`.mcp.json`, `SKILL.md`,
 * `~/.claude.json`), far below it; a larger one is treated as unreadable.
 */
const MAX_CLAUDE_FILE_BYTES = 64 * 1024 * 1024;

async function readText(file: string, fs: ClaudeNamesFs): Promise<string> {
  const bytes = await fs.read(file, { length: MAX_CLAUDE_FILE_BYTES + 1 });
  if (bytes.length > MAX_CLAUDE_FILE_BYTES) throw new Error(`${file} is larger than ${MAX_CLAUDE_FILE_BYTES} bytes`);
  return bytes.toString("utf8");
}

/** The `name` of a markdown file's frontmatter, when it is a non-empty string. */
async function frontmatterName(file: string, fs: ClaudeNamesFs): Promise<string | undefined> {
  try {
    const { frontmatter } = parseMarkdownDocument(await readText(file, fs));
    const name = frontmatter.name;
    return typeof name === "string" && name.trim().length > 0 ? name.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** A JSON object file, or `null` when it is missing, unreadable or not an object. */
export async function readJsonObject(file: string, fs: ClaudeNamesFs = HOST_FS): Promise<Doc | null> {
  try {
    const value: unknown = JSON.parse(await readText(file, fs));
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

export function isPlainObject(value: unknown): value is Doc {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Claude Code refuses to load a plugin whose name is empty or holds `@`, `:`, whitespace, a path
 * separator or an invisible/control character (its manifest validation). Dots are fine:
 * `my.plugin:skill` loads and dispatches as written.
 */
export function isValidClaudePluginName(name: string): boolean {
  return name.length > 0 && !/[@:\s/\\\p{Cc}\p{Cf}]/u.test(name);
}

/**
 * The name Claude Code loads a plugin under: its manifest's `name`, else `fallback` — the
 * directory's name for a plugin loaded by path (a profile's copy, `plugins/<itemId>`), the
 * registry id's plugin part for an installed one. `null` when that name is one the CLI refuses
 * ({@link isValidClaudePluginName}): the plugin does not load, so it names nothing.
 */
export function claudePluginNameOf(manifest: Doc | null | undefined, fallback: string): string | null {
  const declared = manifest?.name;
  const name = typeof declared === "string" ? declared : fallback;
  return isValidClaudePluginName(name) ? name : null;
}

/**
 * A plugin skill's name as Claude Code's loader gives it (2.1.278 and 2.1.307 alike), the one the
 * `skills` allow-list matches and `/name` dispatches: `<plugin>:<entry>`, where `entry` is
 * - a skill FOLDER's directory name — its frontmatter `name` is display only; or
 * - for a skill root that is itself one `SKILL.md` (a declared path, the plugin root), its
 *   frontmatter `name` (`declaredName`) minus a `<plugin>:` prefix, else its directory name;
 *
 * every character outside `[a-zA-Z0-9_-]` replaced by `-`. The plugin name is kept as written.
 */
export function claudePluginSkillName(pluginName: string, directoryName: string, declaredName?: string): string {
  const declared = declaredName?.trim() ?? "";
  const unprefixed = declared.startsWith(`${pluginName}:`) ? declared.slice(pluginName.length + 1) : declared;
  return `${pluginName}:${(unprefixed || directoryName).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

/** The skill folders directly under `root` (symlinked directories followed), by directory name. */
async function skillFoldersIn(root: string, fs: ClaudeNamesFs): Promise<string[]> {
  const names: string[] = [];
  for (const dirent of await entries(root, fs)) {
    if (dirent.name.startsWith(".")) continue;
    if (await isFile(join(root, dirent.name, "SKILL.md"), fs)) names.push(dirent.name);
  }
  return names;
}

/** The skills directly under `root` (symlinked directories followed), as Claude names them: by directory. */
export async function claudeSkillNamesIn(root: string, fs: ClaudeNamesFs = HOST_FS): Promise<string[]> {
  return skillFoldersIn(root, fs);
}

/** Every `*.md` under `root`, at any depth (symlinks followed), as Claude names the command. */
export async function claudeCommandNamesIn(root: string, depthLimit = 8, fs: ClaudeNamesFs = HOST_FS): Promise<string[]> {
  const names: string[] = [];
  const visit = async (dir: string, prefix: string[], depth: number): Promise<void> => {
    for (const dirent of await entries(dir, fs)) {
      if (dirent.name.startsWith(".")) continue;
      const path = join(dir, dirent.name);
      if (await isDir(path, fs)) {
        if (depth < depthLimit) await visit(path, [...prefix, dirent.name], depth + 1);
        continue;
      }
      if (dirent.name.endsWith(".md") && dirent.name.length > ".md".length && (await isFile(path, fs))) {
        names.push([...prefix, dirent.name.slice(0, -".md".length)].join(":"));
      }
    }
  };
  await visit(root, [], 0);
  return names;
}

/** `string | string[]` manifest paths, relative to `root` and kept inside it. */
function manifestPaths(root: string, value: unknown): string[] {
  const list = typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  const out: string[] = [];
  for (const entry of list) {
    if (isAbsolute(entry)) continue;
    const path = resolve(root, entry);
    if (path === root || path.startsWith(root + sep)) out.push(path);
  }
  return out;
}

/** A plugin's `.claude-plugin/plugin.json` (`{}` when missing or unreadable). */
export async function readClaudePluginManifest(root: string): Promise<Doc> {
  return (await readJsonObject(join(root, ".claude-plugin", "plugin.json"))) ?? {};
}

/**
 * Every skill and command id of the plugin at `root` (`<plugin>:<entry>`), in
 * the order Claude lists them: commands, then skills. What the `skills`
 * allow-list must carry for the plugin to keep them.
 */
export async function claudePluginEntryIds(root: string, pluginName: string, manifest?: Doc): Promise<string[]> {
  const plugin = manifest ?? (await readClaudePluginManifest(root));
  const commandNames: string[] = [];
  const commandPaths = manifestPaths(root, plugin.commands);
  if (commandPaths.length === 0 && plugin.commands === undefined) commandPaths.push(join(root, "commands"));
  for (const path of commandPaths) {
    if (await isDir(path, HOST_FS)) {
      commandNames.push(...(await claudeCommandNamesIn(path)));
    } else if (path.endsWith(".md") && (await isFile(path, HOST_FS))) {
      commandNames.push(path.slice(path.lastIndexOf(sep) + 1, -".md".length));
    }
  }
  if (isPlainObject(plugin.commands)) {
    // The object form names its commands itself.
    commandNames.push(...Object.keys(plugin.commands));
  }
  const skillIds: string[] = [];
  const declared = manifestPaths(root, plugin.skills);
  const defaultDir = join(root, "skills");
  const skillRoots = [
    ...((await isDir(defaultDir, HOST_FS)) ? [defaultDir] : []),
    ...declared,
    // A plugin that is itself one skill and declares none (as `skills.ts` lists it).
    ...(plugin.skills === undefined && !(await isDir(defaultDir, HOST_FS)) ? [root] : [])
  ];
  for (const path of skillRoots) {
    const file = join(path, "SKILL.md");
    if (await isFile(file, HOST_FS)) {
      const directoryName = path.slice(path.lastIndexOf(sep) + 1);
      skillIds.push(claudePluginSkillName(pluginName, directoryName, await frontmatterName(file, HOST_FS)));
    } else {
      for (const folder of await skillFoldersIn(path, HOST_FS)) skillIds.push(claudePluginSkillName(pluginName, folder));
    }
  }
  return unique([...commandNames.map((name) => `${pluginName}:${name}`), ...skillIds]);
}

/**
 * The project's own skill and command names, as Claude would list them for
 * a session in `cwd`: `.claude/skills` and `.claude/commands` of `cwd` and
 * each ancestor, stopping BELOW `home` (whose `.claude` is the user scope).
 * `fs`: where the project's files are (a box project's box).
 */
export async function claudeProjectEntryNames(cwd: string, home: string, fs: ClaudeNamesFs = HOST_FS): Promise<string[]> {
  const names: string[] = [];
  const stop = resolve(home);
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (dir === stop) break;
    names.push(...(await claudeCommandNamesIn(join(dir, ".claude", "commands"), undefined, fs)));
    names.push(...(await claudeSkillNamesIn(join(dir, ".claude", "skills"), fs)));
    if (dirname(dir) === dir) break;
  }
  return unique(names);
}

/**
 * The servers of every `.mcp.json` from `cwd` up to `/`, the nearest
 * definition of a name winning — what a Global chat loads as project scope.
 * `fs`: where the project's files are (a box project's box).
 */
export async function claudeProjectMcpServers(cwd: string, fs: ClaudeNamesFs = HOST_FS): Promise<Record<string, Doc>> {
  const found: Record<string, Doc> = {};
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const servers = mcpServersOf(await readJsonObject(join(dir, ".mcp.json"), fs));
    for (const [name, def] of Object.entries(servers)) {
      if (!(name in found)) found[name] = def;
    }
    if (dirname(dir) === dir) break;
  }
  return found;
}

/** `{ mcpServers: { … } }` (or a bare map) → its object-valued entries. */
export function mcpServersOf(doc: Doc | null): Record<string, Doc> {
  if (doc === null) return {};
  const map = isPlainObject(doc.mcpServers) ? doc.mcpServers : doc;
  const out: Record<string, Doc> = {};
  for (const [name, def] of Object.entries(map)) {
    if (isPlainObject(def)) out[name] = def;
  }
  return out;
}

/** `installed_plugins.json`'s plugin ids (`name@marketplace`) under a Claude config dir. */
export async function claudeInstalledPluginIds(configDir: string): Promise<string[]> {
  const doc = await readJsonObject(join(configDir, "plugins", "installed_plugins.json"));
  if (doc === null) return [];
  const plugins = isPlainObject(doc.plugins) ? doc.plugins : doc;
  return Object.keys(plugins).filter((id) => id.includes("@"));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
