/**
 * Agent profile imports — finding the skills and commands in a cloned or
 * extracted tree (spec §6). The walk never follows a symlink (`lstat` and
 * `Dirent` types only):
 *
 * - every directory up to {@link SCAN_MAX_DEPTH} levels below the root
 *   (skipping `.git`, `node_modules`, `__MACOSX`) that holds a `SKILL.md` is a
 *   skill; the walk does not descend into it. Its name is the frontmatter
 *   `name` when that is a valid skill name, else the directory's name made
 *   into one (the root's own name is `rootName`);
 * - every `.md` file directly in a directory named `commands`, or one folder
 *   below it (`commands/git/pr.md` → `git/pr`), is a command;
 * - a candidate holding a symlink anywhere (its `SKILL.md`, a file or a
 *   folder inside the skill, a command file) is skipped with a note, as is
 *   one whose frontmatter does not parse or whose name cannot be made valid.
 */

import type { Dirent } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { SKILL_FILE, isValidCommandName, isValidSkillName, parseMarkdownDocument } from "../infra/index.ts";

/** Directory levels below the scan root a skill or `commands` folder may sit at. */
const SCAN_MAX_DEPTH = 6;
/** Largest `SKILL.md` or command file read. */
const SCAN_MAX_FILE_BYTES = 1024 * 1024;
/** Most candidates one scan offers. */
const SCAN_MAX_CANDIDATES = 500;
/** Most "skipped symlink" notes listed one by one. */
const MAX_SYMLINK_NOTES = 10;

const SKIP_DIRS = new Set([".git", "node_modules", "__MACOSX"]);

export interface ScannedImportCandidate {
  /** The path relative to the scan root (`.` for the root itself). */
  ref: string;
  kind: "skill" | "command";
  /** A valid skill name / command path (`git/pr`). */
  name: string;
  description?: string;
  /** Absolute: the skill's directory or the command's file. */
  path: string;
}

interface ImportScan {
  candidates: ScannedImportCandidate[];
  notes: string[];
}

/**
 * `raw` as a skill name: lowercase, every run of other characters one `-`,
 * trimmed to 64; null when nothing is left.
 */
export function toSkillName(raw: string): string | null {
  const name = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return isValidSkillName(name) ? name : null;
}

async function sortedEntries(dir: string): Promise<Dirent[]> {
  return (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function description(frontmatter: Record<string, unknown>): string | undefined {
  const value = frontmatter.description;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** The first symlink under `dir` (relative), or null; never follows one. */
async function firstSymlink(dir: string, rel = ""): Promise<string | null> {
  for (const entry of await sortedEntries(dir)) {
    const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isSymbolicLink()) return childRel;
    if (entry.isDirectory()) {
      const found = await firstSymlink(join(dir, entry.name), childRel);
      if (found !== null) return found;
    }
  }
  return null;
}

/** The markdown file's frontmatter, or the reason it cannot be imported. */
async function readDocument(path: string): Promise<{ frontmatter: Record<string, unknown> } | { problem: string }> {
  const st = await lstat(path);
  if (st.size > SCAN_MAX_FILE_BYTES) return { problem: `it is larger than ${SCAN_MAX_FILE_BYTES} bytes` };
  try {
    return { frontmatter: parseMarkdownDocument(await readFile(path, "utf8")).frontmatter };
  } catch (error) {
    return { problem: (error as Error).message };
  }
}

class Scanner {
  readonly candidates: ScannedImportCandidate[] = [];
  readonly notes: string[] = [];
  private readonly symlinks: string[] = [];
  private truncated = false;

  constructor(private readonly rootName: string) {}

  private add(candidate: ScannedImportCandidate): void {
    if (this.candidates.length >= SCAN_MAX_CANDIDATES) {
      this.truncated = true;
      return;
    }
    this.candidates.push(candidate);
  }

  async walk(dir: string, rel: string, depth: number): Promise<void> {
    const entries = await sortedEntries(dir);
    const skillFile = entries.find((entry) => entry.name === SKILL_FILE);
    if (skillFile !== undefined) {
      await this.skill(dir, rel, skillFile);
      return;
    }
    if (basename(dir) === "commands") {
      await this.commands(dir, rel, entries);
      return;
    }
    for (const entry of entries) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        this.symlinks.push(childRel);
      } else if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && depth < SCAN_MAX_DEPTH) {
        await this.walk(join(dir, entry.name), childRel, depth + 1);
      }
    }
  }

  private async skill(dir: string, rel: string, skillFile: Dirent): Promise<void> {
    const ref = rel === "" ? "." : rel;
    if (!skillFile.isFile()) {
      this.notes.push(`Skipped ${ref}: its ${SKILL_FILE} is ${skillFile.isSymbolicLink() ? "a symlink" : "not a file"}.`);
      return;
    }
    const link = await firstSymlink(dir);
    if (link !== null) {
      this.notes.push(`Skipped ${ref}: it contains a symlink (${link}).`);
      return;
    }
    const document = await readDocument(join(dir, SKILL_FILE));
    if ("problem" in document) {
      this.notes.push(`Skipped ${ref}: ${SKILL_FILE} could not be read (${document.problem}).`);
      return;
    }
    const declared = document.frontmatter.name;
    const name =
      typeof declared === "string" && isValidSkillName(declared)
        ? declared
        : toSkillName(rel === "" ? this.rootName : basename(dir));
    if (name === null) {
      this.notes.push(`Skipped ${ref}: no valid skill name could be made from it.`);
      return;
    }
    this.add({ ref, kind: "skill", name, description: description(document.frontmatter), path: dir });
  }

  private async commands(dir: string, rel: string, entries: Dirent[]): Promise<void> {
    for (const entry of entries) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isSymbolicLink() && !entry.name.toLowerCase().endsWith(".md")) {
        this.symlinks.push(childRel);
      } else if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
        for (const nested of await sortedEntries(join(dir, entry.name))) {
          await this.command(join(dir, entry.name, nested.name), `${childRel}/${nested.name}`, nested, entry.name);
        }
      } else {
        await this.command(join(dir, entry.name), childRel, entry, null);
      }
    }
  }

  private async command(path: string, ref: string, entry: Dirent, folder: string | null): Promise<void> {
    if (!entry.name.toLowerCase().endsWith(".md")) return;
    if (entry.isSymbolicLink()) {
      this.notes.push(`Skipped ${ref}: it is a symlink.`);
      return;
    }
    if (!entry.isFile()) return;
    const leaf = toSkillName(entry.name.slice(0, -3));
    const prefix = folder === null ? "" : toSkillName(folder);
    const name = leaf === null || prefix === null ? null : prefix === "" ? leaf : `${prefix}/${leaf}`;
    if (name === null || !isValidCommandName(name)) {
      this.notes.push(`Skipped ${ref}: no valid command name could be made from it.`);
      return;
    }
    const document = await readDocument(path);
    if ("problem" in document) {
      this.notes.push(`Skipped ${ref}: it could not be read (${document.problem}).`);
      return;
    }
    this.add({ ref, kind: "command", name, description: description(document.frontmatter), path });
  }

  finish(): ImportScan {
    const shown = this.symlinks.slice(0, MAX_SYMLINK_NOTES).map((rel) => `Skipped symlink ${rel}.`);
    if (this.symlinks.length > MAX_SYMLINK_NOTES) {
      shown.push(`Skipped ${this.symlinks.length - MAX_SYMLINK_NOTES} more symlinks.`);
    }
    const notes = [...this.notes, ...shown];
    if (this.truncated) {
      notes.push(`Only the first ${SCAN_MAX_CANDIDATES} items are offered.`);
    }
    return { candidates: this.candidates, notes };
  }
}

/**
 * The candidates under `root` (a directory the caller owns and has checked
 * holds no link above it). `rootName` names a skill found at the root itself.
 */
export async function scanImportTree(root: string, rootName: string): Promise<ImportScan> {
  const scanner = new Scanner(rootName);
  await scanner.walk(root, "", 0);
  return scanner.finish();
}
