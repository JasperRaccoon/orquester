/**
 * The file-backed things OpenCode 1.18 discovers, found the way it globs them
 * (symlinks followed, at any depth):
 *
 * - skills: `{skill,skills}/**\/SKILL.md` under `~/.config/opencode`, and
 *   `skills/**\/SKILL.md` (dot files included) under `~/.claude` and
 *   `~/.agents`. A skill is known by its frontmatter `name`, not its folder.
 * - commands: `{command,commands}/**\/*.md` (dot files included); the name is
 *   the path under that folder without `.md` (`git/pr`).
 * - plugin files: `{plugin,plugins}/*.{js,ts}` (dot files included).
 */

import type { Dirent } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { type FrontmatterYamlOptions, type MarkdownDocument, SKILL_FILE, parseMarkdownDocument } from "../../infra/index.ts";

/** How OpenCode reads a markdown file's frontmatter: gray-matter, i.e. js-yaml 3 (YAML 1.1). */
export const OPENCODE_YAML: FrontmatterYamlOptions = { yaml: "1.1" };

/**
 * OpenCode's `fallbackSanitization`: a top-level `key: value` line whose
 * unquoted value holds another `:` becomes a `key: |-` block, so
 * `description: Use when: …` still loads.
 */
function sanitizeFrontmatter(text: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (match === null) return text;
  const block = match[1]!;
  const lines = block.split(/\r?\n/).flatMap((line) => {
    if (line.trim().startsWith("#") || line.trim() === "" || /^\s+/.test(line)) return [line];
    const kv = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (kv === null) return [line];
    const value = kv[2]!.trim();
    if (value === "" || value === ">" || value === "|" || value.startsWith('"') || value.startsWith("'")) return [line];
    if (!value.includes(":")) return [line];
    return [`${kv[1]}: |-`, `  ${value}`];
  });
  return text.replace(block, () => lines.join("\n"));
}

/**
 * A markdown file as OpenCode reads it: YAML 1.1 frontmatter and, when that
 * does not parse, OpenCode's own retry after {@link sanitizeFrontmatter}.
 * Throws the first parse's error when both fail. `yaml` overrides the dialect
 * (a file another agent wrote).
 */
export function parseOpenCodeDocument(text: string, yaml: FrontmatterYamlOptions = OPENCODE_YAML): MarkdownDocument {
  try {
    return parseMarkdownDocument(text, yaml);
  } catch (error) {
    const source = text.startsWith("﻿") ? text.slice(1) : text;
    const sanitized = sanitizeFrontmatter(source);
    if (sanitized === source) throw error;
    try {
      return parseMarkdownDocument(sanitized, yaml);
    } catch {
      throw error;
    }
  }
}

/** Deepest folder level searched below a root; far past any real layout, short of a runaway tree. */
const MAX_DEPTH = 8;
/** Most matches one root answers. */
const MAX_MATCHES = 2000;
const SKIP_DIRS = new Set(["node_modules", ".git"]);

async function entries(dir: string): Promise<Dirent[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

async function kindThroughLinks(path: string, dirent: Dirent): Promise<"dir" | "file" | "broken" | "other"> {
  if (!dirent.isSymbolicLink()) {
    return dirent.isDirectory() ? "dir" : dirent.isFile() ? "file" : "other";
  }
  try {
    const st = await stat(path);
    return st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
  } catch {
    return "broken";
  }
}

/** Every file under `root` for which `accept(relativePath)` holds; symlinked directories followed once. */
async function walk(
  root: string,
  options: { dot: boolean; maxDepth: number; accept: (name: string) => boolean }
): Promise<{ path: string; rel: string }[]> {
  const found: { path: string; rel: string }[] = [];
  const seen = new Set<string>();
  const visit = async (dir: string, rel: string, depth: number): Promise<void> => {
    let real: string;
    try {
      real = await realpath(dir);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    for (const dirent of await entries(dir)) {
      if (found.length >= MAX_MATCHES) return;
      if (!options.dot && dirent.name.startsWith(".")) continue;
      const path = join(dir, dirent.name);
      const childRel = rel === "" ? dirent.name : `${rel}/${dirent.name}`;
      const kind = await kindThroughLinks(path, dirent);
      if (kind === "dir") {
        if (depth < options.maxDepth && !SKIP_DIRS.has(dirent.name)) {
          await visit(path, childRel, depth + 1);
        }
      } else if (kind === "file" && options.accept(dirent.name)) {
        found.push({ path, rel: childRel });
      }
    }
  };
  await visit(root, "", 0);
  return found;
}

export interface FoundSkill {
  /** The frontmatter `name` (OpenCode's key), else the folder name. */
  name: string;
  /** Whether the frontmatter carries a string `name` (OpenCode skips a skill without one). */
  named: boolean;
  dir: string;
  skillFile: string;
  /** The folder path under the root (`review`, `synced/abc/pdf`; `""` for a `SKILL.md` at the root). */
  rel: string;
  text: string;
  frontmatter: Record<string, unknown>;
  body: string;
  description?: string;
  error?: string;
}

function folderName(rel: string, root: string): string {
  const parts = (rel === "" ? root : rel).split("/");
  return parts[parts.length - 1] ?? rel;
}

/** The skills under one root, in path order. A missing root answers `[]`. */
export async function findSkills(root: string, options: { dot: boolean }): Promise<FoundSkill[]> {
  const files = await walk(root, { dot: options.dot, maxDepth: MAX_DEPTH, accept: (name) => name === SKILL_FILE });
  const skills: FoundSkill[] = [];
  for (const file of files) {
    const rel = file.rel === SKILL_FILE ? "" : file.rel.slice(0, -(SKILL_FILE.length + 1));
    const dir = rel === "" ? root : join(root, ...rel.split("/"));
    const base = { dir, skillFile: file.path, rel };
    let text: string;
    try {
      text = await readFile(file.path, "utf8");
    } catch (error) {
      skills.push({
        ...base,
        name: folderName(rel, root),
        named: false,
        text: "",
        frontmatter: {},
        body: "",
        error: error instanceof Error ? error.message : String(error)
      });
      continue;
    }
    try {
      const doc = parseOpenCodeDocument(text);
      const name = typeof doc.frontmatter.name === "string" && doc.frontmatter.name.length > 0 ? doc.frontmatter.name : null;
      const description = doc.frontmatter.description;
      skills.push({
        ...base,
        name: name ?? folderName(rel, root),
        named: name !== null,
        text,
        frontmatter: doc.frontmatter,
        body: doc.body,
        ...(typeof description === "string" && description.trim().length > 0 ? { description: description.trim() } : {})
      });
    } catch (error) {
      skills.push({
        ...base,
        name: folderName(rel, root),
        named: false,
        text,
        frontmatter: {},
        body: text,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return skills;
}

export interface FoundCommand {
  /** `review`, `git/pr`. */
  name: string;
  /**
   * The name OpenCode registers it under when the frontmatter's own `name`
   * (a string) differs from the path: OpenCode spreads the frontmatter over
   * `{name: <path>}`, so that key wins.
   */
  invokedAs?: string;
  file: string;
  text: string;
  frontmatter: Record<string, unknown>;
  body: string;
  description?: string;
  error?: string;
}

/** The commands under one `command/` or `commands/` root. */
export async function findCommands(root: string): Promise<FoundCommand[]> {
  const files = await walk(root, { dot: true, maxDepth: MAX_DEPTH, accept: (name) => name.endsWith(".md") });
  const commands: FoundCommand[] = [];
  for (const file of files) {
    const name = file.rel.slice(0, -".md".length);
    let text: string;
    try {
      text = await readFile(file.path, "utf8");
    } catch (error) {
      commands.push({ name, file: file.path, text: "", frontmatter: {}, body: "", error: String(error) });
      continue;
    }
    try {
      const doc = parseOpenCodeDocument(text);
      const description = doc.frontmatter.description;
      const own = doc.frontmatter.name;
      commands.push({
        name,
        ...(typeof own === "string" && own !== name ? { invokedAs: own } : {}),
        file: file.path,
        text,
        frontmatter: doc.frontmatter,
        body: doc.body,
        ...(typeof description === "string" && description.trim().length > 0 ? { description: description.trim() } : {})
      });
    } catch (error) {
      commands.push({
        name,
        file: file.path,
        text,
        frontmatter: {},
        body: text,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return commands;
}

/** The plugin files directly in one `plugin/` or `plugins/` folder. */
export async function findPluginFiles(root: string): Promise<{ file: string; name: string }[]> {
  const files = await walk(root, { dot: true, maxDepth: 0, accept: (name) => /\.(js|ts)$/.test(name) });
  return files.map((file) => ({ file: file.path, name: file.rel }));
}
