/**
 * Agent profile — the markdown items all four agents share the shape of:
 * skills (`<root>/<name>/SKILL.md` plus the skill's other files) and slash
 * commands (`<root>/<name>.md`, optionally one folder level deep). The
 * readers are tolerant — one bad file is an `error` on its entry, never a
 * failed scan — and the writers go through `fs-write` (backup, realpath,
 * verify) with the frontmatter merged into what is on disk.
 */

import type { Dirent, Stats } from "node:fs";
import { readFile, readdir, readlink, stat } from "node:fs/promises";
import { join } from "node:path";
import type { MarkdownDocumentDraft } from "@orquester/api";
import { profileErrors } from "../errors.ts";
import type { ProfileBackups } from "./backups.ts";
import { type FrontmatterYamlOptions, mergeFrontmatter, parseMarkdownDocument, serializeMarkdownDocument } from "./frontmatter.ts";
import { type ProfileWriteResult, readTextIfExists, writeProfileFileVerified } from "./fs-write.ts";
import { assertCommandName, assertSafeSegment, assertSkillName } from "./names.ts";
import { isMissing } from "./tree.ts";

export const SKILL_FILE = "SKILL.md";
/** Most other files `readSkillFiles` lists. */
const SKILL_FILES_MAX = 500;
/** Directories `readSkillFiles` never descends into. */
const SKILL_FILES_SKIP_DIRS = new Set(["node_modules", ".git"]);

export interface ScannedSkill {
  /** The directory name — the skill's name as the agent loads it. */
  name: string;
  /** `<root>/<name>` as listed (not resolved: a symlinked skill keeps its link path). */
  dir: string;
  /** `<dir>/SKILL.md`. */
  skillFile: string;
  /** `{}` when there is none or it could not be parsed. */
  frontmatter: Record<string, unknown>;
  /** The frontmatter's `description`, trimmed, when it is a non-empty string. */
  description?: string;
  /** The directory entry is a symlink (the host symlinks shared skills in). */
  isSymlink: boolean;
  /** Why the skill could not be read: a broken symlink, an unreadable or unparseable `SKILL.md`. */
  error?: string;
  /** The `source` tag the scan was given. */
  source?: string;
}

export interface ScannedCommand {
  /** `review`, or `git/pr` for a command one folder deep. */
  name: string;
  file: string;
  frontmatter: Record<string, unknown>;
  description?: string;
  isSymlink: boolean;
  error?: string;
}

function describe(frontmatter: Record<string, unknown>): string | undefined {
  const value = frontmatter.description;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The directory's entries, sorted; `[]` when it is missing or not a directory. */
async function entries(dir: string): Promise<Dirent[]> {
  try {
    return (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    if (isMissing(error) || (error as NodeJS.ErrnoException).code === "ENOTDIR") {
      return [];
    }
    throw error;
  }
}

/** `stat` through a symlink; `null` when the link is broken. */
async function follow(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch (error) {
    if (isMissing(error) || (error as NodeJS.ErrnoException).code === "ELOOP") {
      return null;
    }
    throw error;
  }
}

async function readDocument(
  file: string
): Promise<{ frontmatter: Record<string, unknown>; description?: string; error?: string }> {
  try {
    const { frontmatter } = parseMarkdownDocument(await readFile(file, "utf8"));
    return { frontmatter, description: describe(frontmatter) };
  } catch (error) {
    return { frontmatter: {}, error: `${file}: ${message(error)}` };
  }
}

/**
 * The skills directly under `root`: every child directory holding a
 * `SKILL.md`, symlinked ones followed (and marked). A broken symlink is listed
 * with an `error` so it can still be seen and deleted; a directory without
 * `SKILL.md` is not a skill and is left out. Hidden entries (`.system`, …) are
 * skipped unless `includeHidden`. A missing root answers `[]`.
 */
export async function scanSkills(
  root: string,
  options: { source?: string; includeHidden?: boolean } = {}
): Promise<ScannedSkill[]> {
  const skills: ScannedSkill[] = [];
  for (const dirent of await entries(root)) {
    if (dirent.name.startsWith(".") && !options.includeHidden) {
      continue;
    }
    const dir = join(root, dirent.name);
    const skillFile = join(dir, SKILL_FILE);
    const isSymlink = dirent.isSymbolicLink();
    const base = { name: dirent.name, dir, skillFile, isSymlink, ...(options.source !== undefined ? { source: options.source } : {}) };
    if (isSymlink) {
      const target = await follow(dir);
      if (target === null) {
        const link = await readlink(dir).catch(() => "?");
        skills.push({ ...base, frontmatter: {}, error: `Broken symlink to ${link}` });
        continue;
      }
      if (!target.isDirectory()) {
        continue;
      }
    } else if (!dirent.isDirectory()) {
      continue;
    }
    const skillStat = await follow(skillFile);
    if (skillStat === null) {
      continue;
    }
    if (!skillStat.isFile()) {
      skills.push({ ...base, frontmatter: {}, error: `${skillFile} is not a file` });
      continue;
    }
    skills.push({ ...base, ...(await readDocument(skillFile)) });
  }
  return skills;
}

/**
 * The commands under `root`: every visible `*.md` file (symlinks followed),
 * and with `nested` every `*.md` one folder level down, named `folder/file`.
 * An unparseable frontmatter is an `error` on its entry. A missing root
 * answers `[]`.
 */
export async function scanCommands(root: string, options: { nested: boolean }): Promise<ScannedCommand[]> {
  const commands: ScannedCommand[] = [];
  const visit = async (dir: string, prefix: string, depth: number): Promise<void> => {
    for (const dirent of await entries(dir)) {
      if (dirent.name.startsWith(".")) {
        continue;
      }
      const path = join(dir, dirent.name);
      const isSymlink = dirent.isSymbolicLink();
      const target = isSymlink ? await follow(path) : null;
      const isDir = isSymlink ? target?.isDirectory() === true : dirent.isDirectory();
      const isFile = isSymlink ? target?.isFile() === true : dirent.isFile();
      if (isDir) {
        if (options.nested && depth === 0) {
          await visit(path, `${dirent.name}/`, depth + 1);
        }
        continue;
      }
      if (!dirent.name.endsWith(".md") || dirent.name === ".md") {
        continue;
      }
      const name = `${prefix}${dirent.name.slice(0, -".md".length)}`;
      if (isSymlink && target === null) {
        const link = await readlink(path).catch(() => "?");
        commands.push({ name, file: path, frontmatter: {}, isSymlink, error: `Broken symlink to ${link}` });
        continue;
      }
      if (!isFile) {
        continue;
      }
      commands.push({ name, file: path, isSymlink, ...(await readDocument(path)) });
    }
  };
  await visit(root, "", 0);
  return commands;
}

/**
 * The skill's files other than its top-level `SKILL.md`, as `/`-separated
 * paths relative to `dir`, sorted. Symlinks inside are listed, never followed;
 * `node_modules` and `.git` are skipped; at most {@link SKILL_FILES_MAX}.
 */
export async function readSkillFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (path: string, prefix: string): Promise<void> => {
    for (const dirent of await entries(path)) {
      if (files.length >= SKILL_FILES_MAX) {
        return;
      }
      const rel = `${prefix}${dirent.name}`;
      if (dirent.isDirectory()) {
        if (!SKILL_FILES_SKIP_DIRS.has(dirent.name)) {
          await visit(join(path, dirent.name), `${rel}/`);
        }
      } else if (rel !== SKILL_FILE) {
        files.push(rel);
      }
    }
  };
  await visit(dir, "");
  return files.sort();
}

export interface MarkdownWriteOptions extends FrontmatterYamlOptions {
  backups: ProfileBackups;
  agent: string;
  /**
   * Merge the draft's frontmatter into the file on disk (default): keys the
   * draft does not mention survive, `null` removes one. `false` writes the
   * draft's frontmatter alone (a create that replaces).
   */
  mergeExisting?: boolean;
}

/** The frontmatter to write for `path`: the draft's, merged into the file's own unless told not to. */
async function frontmatterFor(
  path: string,
  draft: MarkdownDocumentDraft,
  mergeExisting: boolean,
  yaml: FrontmatterYamlOptions
): Promise<Record<string, unknown>> {
  const fresh = mergeFrontmatter({}, draft.frontmatter);
  if (!mergeExisting) {
    return fresh;
  }
  const text = await readTextIfExists(path);
  if (text === null) {
    return fresh;
  }
  let existing: Record<string, unknown>;
  try {
    existing = parseMarkdownDocument(text, yaml).frontmatter;
  } catch (error) {
    throw profileErrors.unreadable(path, message(error));
  }
  return mergeFrontmatter(existing, draft.frontmatter);
}

/** Serializes and checks that the text reads back — frontmatter is validated before anything is written. */
function render(frontmatter: Record<string, unknown>, body: string, yaml: FrontmatterYamlOptions): string {
  const text = serializeMarkdownDocument(frontmatter, body, yaml);
  try {
    parseMarkdownDocument(text, yaml);
  } catch (error) {
    throw profileErrors.invalidItem(`The frontmatter cannot be written: ${message(error)}`);
  }
  return text;
}

/**
 * Writes `<root>/<draft.name>/SKILL.md` (creating the directory). The name
 * must be a valid skill name; the frontmatter's `name` is always set to it
 * (every agent requires the two to match) and comes first in a new file. Other
 * files of the skill are left alone. Throws `CONFIG_UNREADABLE` when merging
 * into a `SKILL.md` that does not parse.
 */
export async function writeSkill(
  root: string,
  draft: MarkdownDocumentDraft,
  options: MarkdownWriteOptions
): Promise<ProfileWriteResult> {
  assertSkillName(draft.name);
  assertSafeSegment(draft.name);
  const path = join(root, draft.name, SKILL_FILE);
  const merged = await frontmatterFor(path, draft, options.mergeExisting ?? true, { yaml: options.yaml });
  const frontmatter = "name" in merged ? { ...merged, name: draft.name } : { name: draft.name, ...merged };
  return writeProfileFileVerified(path, render(frontmatter, draft.body, { yaml: options.yaml }), {
    backups: options.backups,
    agent: options.agent,
    verify: (text) => parseMarkdownDocument(text, { yaml: options.yaml })
  });
}

/**
 * Writes `<root>/<draft.name>.md` — `git/pr` lands in `<root>/git/pr.md`. The
 * name must be a valid command name. Throws `CONFIG_UNREADABLE` when merging
 * into a file that does not parse.
 */
export async function writeCommand(
  root: string,
  draft: MarkdownDocumentDraft,
  options: MarkdownWriteOptions
): Promise<ProfileWriteResult> {
  assertCommandName(draft.name);
  const segments = draft.name.split("/");
  segments.forEach(assertSafeSegment);
  const path = `${join(root, ...segments)}.md`;
  const frontmatter = await frontmatterFor(path, draft, options.mergeExisting ?? true, { yaml: options.yaml });
  return writeProfileFileVerified(path, render(frontmatter, draft.body, { yaml: options.yaml }), {
    backups: options.backups,
    agent: options.agent,
    verify: (text) => parseMarkdownDocument(text, { yaml: options.yaml })
  });
}
