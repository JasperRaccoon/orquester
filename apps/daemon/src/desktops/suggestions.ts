import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DesktopEntrySuggestion } from "@orquester/api";

// Launch-dialog suggestions (desktop spec §7.1): installed `.desktop` apps and
// the project's own executables. Recent launches come from the manager.
// boxes: for a VM desktop the same reads go to the VM (`SuggestionsFs`).

/** The reads the suggestions make, on the machine the desktop runs on. */
export interface SuggestionsFs {
  /** A directory's entries; a symlink is not a directory here. Throws when it cannot be read. */
  list(path: string): Promise<Array<{ name: string; isDirectory: boolean }>>;
  readText(path: string): Promise<string>;
  /** Following symlinks; throws when there is nothing (or a dangling link). */
  stat(path: string): Promise<{ isFile: boolean; mode: number }>;
}

/** This machine. */
export const hostSuggestionsFs: SuggestionsFs = {
  list: async (path) =>
    (await readdir(path, { withFileTypes: true })).map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() })),
  readText: (path) => readFile(path, "utf8"),
  stat: async (path) => {
    const info = await stat(path);
    return { isFile: info.isFile(), mode: info.mode };
  }
};

/** Where `.desktop` entries are read from, user entries overriding system ones by file name. */
export function desktopEntryDirs(home: string = homedir()): Array<{ path: string; source: DesktopEntrySuggestion["source"] }> {
  return [
    { path: "/usr/share/applications", source: "system" },
    { path: join(home, ".local", "share", "applications"), source: "user" }
  ];
}

/**
 * Drop the Exec field codes (`%f %F %u %U %d %D %n %N %i %c %k %v %m`) and turn
 * `%%` into `%`; the rest of the line is kept as the shell command.
 */
export function stripFieldCodes(exec: string): string {
  return exec
    .replace(/%(%|[a-zA-Z])/g, (_match, code: string) => (code === "%" ? "\u0000" : ""))
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\u0000/g, "%");
}

/**
 * One `.desktop` file → a suggestion, or null when it is not a launchable,
 * visible, graphical Application (`NoDisplay`, `Hidden` and `Terminal` apps are
 * skipped). Only the `[Desktop Entry]` group and unlocalized keys are read.
 */
export function parseDesktopEntry(
  text: string,
  source: DesktopEntrySuggestion["source"]
): DesktopEntrySuggestion | null {
  const fields = new Map<string, string>();
  let inEntry = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      inEntry = line === "[Desktop Entry]";
      continue;
    }
    if (!inEntry) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!fields.has(key)) fields.set(key, line.slice(eq + 1).trim());
  }
  const type = fields.get("Type");
  if (type !== undefined && type !== "Application") return null;
  for (const flag of ["NoDisplay", "Hidden", "Terminal"]) {
    if (fields.get(flag)?.toLowerCase() === "true") return null;
  }
  const name = fields.get("Name");
  const exec = fields.get("Exec");
  if (!name || !exec) return null;
  const command = stripFieldCodes(exec);
  if (!command) return null;
  return { name, command, icon: fields.get("Icon") || null, source };
}

/** Every visible app in `dirs`, a user file overriding the system file of the same name, sorted by name. */
export async function scanDesktopEntries(
  dirs = desktopEntryDirs(),
  fs: SuggestionsFs = hostSuggestionsFs
): Promise<DesktopEntrySuggestion[]> {
  const byFile = new Map<string, DesktopEntrySuggestion | null>();
  for (const dir of dirs) {
    let names: string[];
    try {
      names = (await fs.list(dir.path)).map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".desktop")) continue;
      let text: string;
      try {
        text = await fs.readText(join(dir.path, name));
      } catch {
        continue;
      }
      // A later dir (the user's) wins, including a user file that hides an app.
      byFile.set(name, parseDesktopEntry(text, dir.source));
    }
  }
  return [...byFile.values()]
    .filter((entry): entry is DesktopEntrySuggestion => entry !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

const MAX_PROJECT_EXECUTABLES = 50;
/** Deepest `bin/` dir searched under the project (`build/linux/editor-install/bin` is 4). */
const MAX_EXECUTABLE_DEPTH = 4;
/** Directories visited under `build/` at most, so a huge build tree stays cheap. */
const MAX_BUILD_DIRS = 2000;

async function executablesIn(fs: SuggestionsFs, dir: string, rel: string, out: string[]): Promise<void> {
  let names: string[];
  try {
    names = (await fs.list(dir)).map((entry) => entry.name).sort();
  } catch {
    return;
  }
  for (const name of names) {
    if (out.length >= MAX_PROJECT_EXECUTABLES) return;
    if (name.startsWith(".")) continue;
    try {
      const info = await fs.stat(join(dir, name));
      if (info.isFile && (info.mode & 0o111) !== 0) {
        out.push(rel ? `${rel}/${name}` : name);
      }
    } catch {
      /* dangling link or gone */
    }
  }
}

/**
 * Project-relative paths of the executables a desktop app is likely to be:
 * regular files with an exec bit directly in the project, in `bin/`, and in
 * any `bin/` under `build/` up to {@link MAX_EXECUTABLE_DEPTH} levels deep.
 * Hidden entries and symlinked directories are not followed; capped at
 * {@link MAX_PROJECT_EXECUTABLES}.
 */
export async function findProjectExecutables(
  projectPath: string,
  fs: SuggestionsFs = hostSuggestionsFs,
  // boxes: each read in a VM is a round trip, so it visits fewer.
  maxBuildDirs: number = MAX_BUILD_DIRS
): Promise<string[]> {
  const out: string[] = [];
  await executablesIn(fs, projectPath, "", out);
  await executablesIn(fs, join(projectPath, "bin"), "bin", out);
  let visited = 0;
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (out.length >= MAX_PROJECT_EXECUTABLES || depth >= MAX_EXECUTABLE_DEPTH || visited >= maxBuildDirs) {
      return;
    }
    let entries;
    try {
      entries = await fs.list(join(projectPath, rel));
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      // A symlink is not a directory here (Dirent.isDirectory() is false for one), so linked trees are not entered.
      if (!entry.isDirectory || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      visited += 1;
      const child = `${rel}/${entry.name}`;
      if (entry.name === "bin") {
        await executablesIn(fs, join(projectPath, child), child, out);
      } else {
        await walk(child, depth + 1);
      }
      if (out.length >= MAX_PROJECT_EXECUTABLES) return;
    }
  };
  await walk("build", 1);
  return out;
}
