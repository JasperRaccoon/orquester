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
 * `getContextUsage()` / `supportedCommands()` / `mcpServerStatus()`):
 * - A skill is `<SKILL.md frontmatter name>`, else its directory name; a
 *   plugin's is `<plugin>:<that>`.
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
export const MAX_CLAUDE_FILE_BYTES = 64 * 1024 * 1024;

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

/** The skill under `dir` (holding `SKILL.md`), as Claude names it; `null` when it is none. */
async function skillNameOf(dir: string, fallback: string, fs: ClaudeNamesFs = HOST_FS): Promise<string | null> {
  const file = join(dir, "SKILL.md");
  if (!(await isFile(file, fs))) return null;
  return (await frontmatterName(file, fs)) ?? fallback;
}

/** The skills directly under `root` (symlinked directories followed), as Claude names them. */
export async function claudeSkillNamesIn(root: string, fs: ClaudeNamesFs = HOST_FS): Promise<string[]> {
  const names: string[] = [];
  for (const dirent of await entries(root, fs)) {
    if (dirent.name.startsWith(".")) continue;
    const dir = join(root, dirent.name);
    if (!(await isDir(dir, fs))) continue;
    const name = await skillNameOf(dir, dirent.name, fs);
    if (name !== null) names.push(name);
  }
  return names;
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
  const skillNames: string[] = [];
  for (const path of [join(root, "skills"), ...manifestPaths(root, plugin.skills)]) {
    const single = await skillNameOf(path, path.slice(path.lastIndexOf(sep) + 1));
    if (single !== null && path !== join(root, "skills")) {
      skillNames.push(single);
    } else {
      skillNames.push(...(await claudeSkillNamesIn(path)));
    }
  }
  return unique([...commandNames, ...skillNames].map((name) => `${pluginName}:${name}`));
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
