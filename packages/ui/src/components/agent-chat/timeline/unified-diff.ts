/**
 * Splitting a unified diff into per-file patches (spec §7.3).
 *
 * The daemon's `GET …/turns/:n/diff` answers one `git diff` blob covering
 * every file the turn touched, and a file-change activity row shows *its* file
 * as a unified diff inline. The repo already has `parseUnifiedDiff`
 * (`components/git/git-diff.ts`) and it is the right renderer — but it
 * flattens hunks across files, so it has to be handed one file's patch at a
 * time. That split is what this module does.
 *
 * Everything here is pure text work, deliberately: a malformed or truncated
 * patch must shrink the output (fewer files, fewer hunks), never throw inside a
 * timeline row.
 */

export interface UnifiedDiffFile {
  /** The new path, falling back to the old one for a deletion. */
  path: string;
  oldPath: string | null;
  newPath: string | null;
  binary: boolean;
  /** This file's slice of the original text, ready for `parseUnifiedDiff`. */
  patch: string;
}

const DIFF_HEADER = /^diff --git (?:"?a\/(.*?)"?) (?:"?b\/(.*?)"?)$/;
const OLD_FILE = /^--- (?:"?a\/)?(.*?)"?$/;
const NEW_FILE = /^\+\+\+ (?:"?b\/)?(.*?)"?$/;
const BINARY = /^(?:Binary files .* differ|GIT binary patch)$/;

function unquote(value: string): string {
  return value.replace(/^"(.*)"$/, "$1");
}

/**
 * Splits on `diff --git` boundaries. A blob with no such header — some
 * providers hand over a single bare `--- / +++ / @@` patch — is returned as one
 * unnamed file rather than as nothing.
 */
export function splitUnifiedDiff(diff: string): UnifiedDiffFile[] {
  if (diff.trim().length === 0) return [];
  const lines = diff.split("\n");
  const files: UnifiedDiffFile[] = [];
  let current: { header: string[]; oldPath: string | null; newPath: string | null; binary: boolean } | null =
    null;

  const flush = (): void => {
    if (current === null) return;
    const path = current.newPath ?? current.oldPath;
    if (path !== null && path !== "/dev/null") {
      files.push({
        path,
        oldPath: current.oldPath,
        newPath: current.newPath,
        binary: current.binary,
        patch: current.header.join("\n")
      });
    } else if (current.oldPath !== null) {
      files.push({
        path: current.oldPath,
        oldPath: current.oldPath,
        newPath: current.newPath,
        binary: current.binary,
        patch: current.header.join("\n")
      });
    }
    current = null;
  };

  for (const line of lines) {
    const header = DIFF_HEADER.exec(line);
    if (header) {
      flush();
      current = {
        header: [line],
        oldPath: unquote(header[1] ?? ""),
        newPath: unquote(header[2] ?? ""),
        binary: false
      };
      continue;
    }
    if (current === null) {
      // A bare patch with no `diff --git` preamble.
      if (!OLD_FILE.test(line) && !line.startsWith("@@")) continue;
      current = { header: [], oldPath: null, newPath: null, binary: false };
    }
    current.header.push(line);
    if (BINARY.test(line)) current.binary = true;
    const oldMatch = OLD_FILE.exec(line);
    if (oldMatch && !line.startsWith("--- ---")) {
      const value = unquote(oldMatch[1] ?? "");
      current.oldPath = value === "/dev/null" ? null : value;
      continue;
    }
    const newMatch = NEW_FILE.exec(line);
    if (newMatch) {
      const value = unquote(newMatch[1] ?? "");
      current.newPath = value === "/dev/null" ? null : value;
    }
  }
  flush();
  return files;
}

/** One named file's patch out of a multi-file diff, or `null` when absent. */
export function unifiedDiffForPath(diff: string, path: string): UnifiedDiffFile | null {
  const normalized = path.replaceAll("\\", "/");
  const files = splitUnifiedDiff(diff);
  return (
    files.find((file) => file.path === normalized) ??
    files.find((file) => normalized.endsWith(`/${file.path}`) || file.path.endsWith(`/${normalized}`)) ??
    null
  );
}

/** Added/removed line counts, for a row's inline `+n −m` chip. */
export function countDiffLines(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}
