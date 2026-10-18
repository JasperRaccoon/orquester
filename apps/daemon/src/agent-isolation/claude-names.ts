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
 * No dynamic `import()`: the agent host imports this module.
 */

import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { parseMarkdownDocument } from "../agent-profile/infra/frontmatter.ts";

type Doc = Record<string, unknown>;

/** Directory entries, sorted; `[]` when missing or not a directory. */
async function entries(dir: string): Promise<Dirent[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

async function isDir(path: string): Promise<boolean> {
  return stat(path).then(
    (st) => st.isDirectory(),
    () => false
  );
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (st) => st.isFile(),
    () => false
  );
}

/** The `name` of a markdown file's frontmatter, when it is a non-empty string. */
async function frontmatterName(file: string): Promise<string | undefined> {
  try {
    const { frontmatter } = parseMarkdownDocument(await readFile(file, "utf8"));
    const name = frontmatter.name;
    return typeof name === "string" && name.trim().length > 0 ? name.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** A JSON object file, or `null` when it is missing, unreadable or not an object. */
export async function readJsonObject(file: string): Promise<Doc | null> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

export function isPlainObject(value: unknown): value is Doc {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The skill under `dir` (holding `SKILL.md`), as Claude names it; `null` when it is none. */
async function skillNameOf(dir: string, fallback: string): Promise<string | null> {
  const file = join(dir, "SKILL.md");
  if (!(await isFile(file))) return null;
  return (await frontmatterName(file)) ?? fallback;
}

/** The skills directly under `root` (symlinked directories followed), as Claude names them. */
export async function claudeSkillNamesIn(root: string): Promise<string[]> {
  const names: string[] = [];
  for (const dirent of await entries(root)) {
    if (dirent.name.startsWith(".")) continue;
    const dir = join(root, dirent.name);
    if (!(await isDir(dir))) continue;
    const name = await skillNameOf(dir, dirent.name);
    if (name !== null) names.push(name);
  }
  return names;
}

/** Every `*.md` under `root`, at any depth (symlinks followed), as Claude names the command. */
export async function claudeCommandNamesIn(root: string, depthLimit = 8): Promise<string[]> {
  const names: string[] = [];
  const visit = async (dir: string, prefix: string[], depth: number): Promise<void> => {
    for (const dirent of await entries(dir)) {
      if (dirent.name.startsWith(".")) continue;
      const path = join(dir, dirent.name);
      if (await isDir(path)) {
        if (depth < depthLimit) await visit(path, [...prefix, dirent.name], depth + 1);
        continue;
      }
      if (dirent.name.endsWith(".md") && dirent.name.length > ".md".length && (await isFile(path))) {
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
    if (await isDir(path)) {
      commandNames.push(...(await claudeCommandNamesIn(path)));
    } else if (path.endsWith(".md") && (await isFile(path))) {
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
 */
export async function claudeProjectEntryNames(cwd: string, home: string): Promise<string[]> {
  const names: string[] = [];
  const stop = resolve(home);
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (dir === stop) break;
    names.push(...(await claudeCommandNamesIn(join(dir, ".claude", "commands"))));
    names.push(...(await claudeSkillNamesIn(join(dir, ".claude", "skills"))));
    if (dirname(dir) === dir) break;
  }
  return unique(names);
}

/**
 * The servers of every `.mcp.json` from `cwd` up to `/`, the nearest
 * definition of a name winning — what a Global chat loads as project scope.
 */
export async function claudeProjectMcpServers(cwd: string): Promise<Record<string, Doc>> {
  const found: Record<string, Doc> = {};
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const servers = mcpServersOf(await readJsonObject(join(dir, ".mcp.json")));
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
