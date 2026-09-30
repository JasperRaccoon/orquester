import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DesktopEntrySuggestion } from "@orquester/api";

// Launch-dialog suggestions (desktop spec §7.1): installed `.desktop` apps and
// the project's own executables. Recent launches come from the manager.

/** Where `.desktop` entries are read from, user entries overriding system ones by file name. */
export function desktopEntryDirs(): Array<{ path: string; source: DesktopEntrySuggestion["source"] }> {
  return [
    { path: "/usr/share/applications", source: "system" },
    { path: join(homedir(), ".local", "share", "applications"), source: "user" }
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
  dirs = desktopEntryDirs()
): Promise<DesktopEntrySuggestion[]> {
  const byFile = new Map<string, DesktopEntrySuggestion | null>();
  for (const dir of dirs) {
    let names: string[];
    try {
      names = await readdir(dir.path);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".desktop")) continue;
      let text: string;
      try {
        text = await readFile(join(dir.path, name), "utf8");
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

export const MAX_PROJECT_EXECUTABLES = 50;
/** Deepest `bin/` dir searched under the project (`build/linux/editor-install/bin` is 4). */
export const MAX_EXECUTABLE_DEPTH = 4;
/** Directories visited under `build/` at most, so a huge build tree stays cheap. */
const MAX_BUILD_DIRS = 2000;

async function executablesIn(dir: string, rel: string, out: string[]): Promise<void> {
  let names: string[];
  try {
    names = (await readdir(dir)).sort();
  } catch {
    return;
  }
  for (const name of names) {
    if (out.length >= MAX_PROJECT_EXECUTABLES) return;
    if (name.startsWith(".")) continue;
    try {
      const info = await stat(join(dir, name));
      if (info.isFile() && (info.mode & 0o111) !== 0) {
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
export async function findProjectExecutables(projectPath: string): Promise<string[]> {
  const out: string[] = [];
  await executablesIn(projectPath, "", out);
  await executablesIn(join(projectPath, "bin"), "bin", out);
  let visited = 0;
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (out.length >= MAX_PROJECT_EXECUTABLES || depth >= MAX_EXECUTABLE_DEPTH || visited >= MAX_BUILD_DIRS) {
      return;
    }
    let entries;
    try {
      entries = await readdir(join(projectPath, rel), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      // Dirent.isDirectory() is false for a symlink, so linked trees are not entered.
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      visited += 1;
      const child = `${rel}/${entry.name}`;
      if (entry.name === "bin") {
        await executablesIn(join(projectPath, child), child, out);
      } else {
        await walk(child, depth + 1);
      }
      if (out.length >= MAX_PROJECT_EXECUTABLES) return;
    }
  };
  await walk("build", 1);
  return out;
}
