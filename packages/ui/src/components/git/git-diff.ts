/**
 * Pure unified-diff parser (no React). Turns `git diff` / `git show` output
 * into per-file sections of hunks of rows with old/new line numbers, ready for
 * `<DiffView>` (one file) and `<DiffFilesView>` (a multi-file patch such as a
 * turn's diff) to render a GitHub-Desktop-style unified diff.
 *
 * Everything here is pure text work, deliberately: a malformed or truncated
 * patch must shrink the output (fewer files, fewer rows), never throw.
 */

export type DiffRowType = "hunk" | "add" | "del" | "context";

export interface DiffRow {
  type: DiffRowType;
  oldNo: number | null;
  newNo: number | null;
  text: string;
  /** git's "\ No newline at end of file" follows this line. */
  noNewline?: true;
}

export interface DiffHunk {
  header: string;
  rows: DiffRow[];
}

export interface ParsedDiff {
  hunks: DiffHunk[];
  binary: boolean;
}

/** What happened to a file, from git's extended header lines. */
export type DiffFileChange = "modified" | "added" | "deleted" | "renamed" | "copied";

export interface DiffFile {
  /** The new path, falling back to the old one for a deletion. */
  path: string;
  /** Null for an added file. */
  oldPath: string | null;
  /** Null for a deleted file. */
  newPath: string | null;
  change: DiffFileChange;
  /** `old mode` / `deleted file mode`; null when the header names none. */
  oldMode: string | null;
  /** `new mode` / `new file mode`; null when the header names none. */
  newMode: string | null;
  /** `similarity index` of a rename or copy, in percent. */
  similarity: number | null;
  /** git printed a binary marker for THIS file instead of hunks. */
  binary: boolean;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

const DIFF_GIT = "diff --git ";
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * git's two binary markers, matched as WHOLE LINES outside a hunk (the same
 * anchoring the daemon's `isBinaryDiff` uses). An unanchored substring test
 * renders any text file that merely CONTAINS the phrase — this very file, a
 * spec documenting the check, a test fixture — as an unviewable "binary file".
 */
const BINARY_MARKER = /^(?:Binary files .* differ|GIT binary patch)$/;

const C_ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92
};

/**
 * Reads one C-quoted path (`"a/caf\303\251.txt"`) starting at `value[0] === '"'`,
 * the form git uses for a name with control characters, quotes, backslashes or
 * (under the default `core.quotePath`) non-ASCII bytes. Octal escapes are raw
 * bytes, decoded together as UTF-8. Null when the quote never closes.
 */
function readQuoted(value: string): { text: string; rest: string } | null {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let index = 1; index < value.length; index += 1) {
    const char = value[index]!;
    if (char === '"') {
      return { text: new TextDecoder().decode(new Uint8Array(bytes)), rest: value.slice(index + 1) };
    }
    if (char === "\\") {
      const next = value[index + 1] ?? "";
      const octal = /^[0-7]{3}/.exec(value.slice(index + 1));
      if (octal) {
        bytes.push(Number.parseInt(octal[0], 8) & 0xff);
        index += 3;
      } else {
        bytes.push(C_ESCAPES[next] ?? next.charCodeAt(0));
        index += 1;
      }
      continue;
    }
    bytes.push(...encoder.encode(char));
  }
  return null;
}

/** `a/x` → `x`; leaves a name without the expected prefix as it is. */
function stripPrefix(path: string, prefix: "a/" | "b/"): string {
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/**
 * The path on a `--- ` / `+++ ` line, without its `a/`/`b/` prefix. git ends
 * an unquoted name that contains a space with a TAB (and `diff -u` puts a
 * timestamp after one), so an unquoted name stops at the first TAB.
 * `/dev/null` is null: the file did not exist on that side.
 */
function filePathOf(raw: string, prefix: "a/" | "b/"): string | null {
  let path: string;
  if (raw.startsWith('"')) {
    path = readQuoted(raw)?.text ?? raw;
  } else {
    const tab = raw.indexOf("\t");
    path = tab < 0 ? raw : raw.slice(0, tab);
  }
  if (path === "/dev/null") return null;
  return stripPrefix(path, prefix);
}

/** A `rename from` / `copy to` name: no prefix, possibly C-quoted. */
function plainPathOf(raw: string): string {
  return raw.startsWith('"') ? (readQuoted(raw)?.text ?? raw) : raw;
}

/**
 * The two paths on a `diff --git a/X b/Y` line. Unquoted names are ambiguous
 * when they contain " b/", so the symmetric `a/P b/P` reading wins when it
 * fits; the `---`/`+++`/`rename` lines that follow are authoritative anyway
 * and overwrite these.
 */
function headerPaths(rest: string): { oldPath: string; newPath: string } | null {
  if (rest.startsWith('"')) {
    const first = readQuoted(rest);
    if (!first) return null;
    const tail = first.rest.trimStart();
    const second = tail.startsWith('"') ? readQuoted(tail)?.text : tail;
    if (second === undefined) return null;
    return { oldPath: stripPrefix(first.text, "a/"), newPath: stripPrefix(second, "b/") };
  }
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest[half] === " ") {
    const left = rest.slice(0, half);
    const right = rest.slice(half + 1);
    if (stripPrefix(left, "a/") === stripPrefix(right, "b/")) {
      return { oldPath: stripPrefix(left, "a/"), newPath: stripPrefix(right, "b/") };
    }
  }
  const split = rest.indexOf(' "b/') >= 0 ? rest.indexOf(' "b/') : rest.indexOf(" b/");
  if (split < 0) return null;
  const right = rest.slice(split + 1);
  return {
    oldPath: stripPrefix(rest.slice(0, split), "a/"),
    newPath: right.startsWith('"') ? stripPrefix(readQuoted(right)?.text ?? right, "b/") : stripPrefix(right, "b/")
  };
}

interface FileBuilder {
  oldPath: string | null;
  newPath: string | null;
  change: DiffFileChange;
  oldMode: string | null;
  newMode: string | null;
  similarity: number | null;
  binary: boolean;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

function newFile(): FileBuilder {
  return {
    oldPath: null,
    newPath: null,
    change: "modified",
    oldMode: null,
    newMode: null,
    similarity: null,
    binary: false,
    hunks: [],
    additions: 0,
    deletions: 0
  };
}

function finish(file: FileBuilder): DiffFile | null {
  const path = file.newPath ?? file.oldPath;
  if (path === null) return null;
  let change = file.change;
  // A bare patch has no `new file`/`deleted file` header; `/dev/null` says it.
  if (change === "modified" && file.oldPath === null) change = "added";
  if (change === "modified" && file.newPath === null) change = "deleted";
  return { path, ...file, change };
}

/**
 * Parse a unified diff of any number of files into one section per file.
 *
 * Hunk bodies are read by their `@@` line counts, so a removed line that
 * itself starts with `-- ` (a SQL comment, a Markdown rule) is a deletion, not
 * a `--- ` file header. A blob with no `diff --git` preamble — a bare
 * `--- / +++ / @@` patch — is one file; lines before the first file (a `git
 * show` commit header) are skipped.
 */
export function parseDiffFiles(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: FileBuilder | null = null;
  let hunk: DiffHunk | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let oldNo = 0;
  let newNo = 0;

  const flush = (): void => {
    if (file === null) return;
    const done = finish(file);
    if (done) files.push(done);
    file = null;
    hunk = null;
  };

  const lines = diff.split("\n");
  /** `--- x` directly followed by `+++ y`: a bare patch's file header. */
  const isBareHeader = (index: number): boolean =>
    lines[index]!.startsWith("--- ") && (lines[index + 1] ?? "").startsWith("+++ ");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;

    // Inside a hunk by its counts — or past them on a +/-/context line, which
    // git never writes there but a hand-made patch with understated counts
    // does: its lines are kept rather than dropped.
    const overrun = /^[+\- ]/.test(line) && !isBareHeader(index);
    if (file !== null && hunk !== null && (oldLeft > 0 || newLeft > 0 || overrun)) {
      const marker = line[0];
      const current: FileBuilder = file;
      const rows: DiffRow[] = (hunk as DiffHunk).rows;
      if (marker === "+") {
        rows.push({ type: "add", oldNo: null, newNo: newNo++, text: line.slice(1) });
        current.additions += 1;
        newLeft -= 1;
        continue;
      }
      if (marker === "-") {
        rows.push({ type: "del", oldNo: oldNo++, newNo: null, text: line.slice(1) });
        current.deletions += 1;
        oldLeft -= 1;
        continue;
      }
      // An empty line is a context line whose leading space was stripped (some
      // editors and mailers do that) — or the end of a truncated patch.
      if (marker === " " || (line === "" && index < lines.length - 1)) {
        rows.push({ type: "context", oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
        oldLeft -= 1;
        newLeft -= 1;
        continue;
      }
      if (marker === "\\") {
        const last = rows[rows.length - 1];
        if (last && last.type !== "hunk") last.noNewline = true;
        continue;
      }
      // Anything else ends a hunk whose counts lied; read it as a header line.
      oldLeft = 0;
      newLeft = 0;
    }

    if (line.startsWith("\\")) {
      // "\ No newline at end of file" after a hunk's last line.
      const rows: DiffRow[] | undefined = (hunk as DiffHunk | null)?.rows;
      const last = rows?.[rows.length - 1];
      if (last && last.type !== "hunk") last.noNewline = true;
      continue;
    }

    if (line.startsWith(DIFF_GIT)) {
      flush();
      const started = newFile();
      const paths = headerPaths(line.slice(DIFF_GIT.length));
      if (paths) {
        started.oldPath = paths.oldPath;
        started.newPath = paths.newPath;
      }
      file = started;
      continue;
    }

    const hunkMatch = HUNK_HEADER.exec(line);
    // A second bare patch starts at its own `--- ` once the previous one has hunks.
    const bareStart = isBareHeader(index) && (file === null || hunk !== null);
    if (bareStart || (file === null && hunkMatch)) {
      flush();
      file = newFile();
    }
    if (file === null) continue;
    const current: FileBuilder = file;

    if (hunkMatch) {
      oldNo = Number(hunkMatch[1]);
      newNo = Number(hunkMatch[3]);
      oldLeft = hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]);
      newLeft = hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]);
      hunk = { header: line, rows: [{ type: "hunk", oldNo: null, newNo: null, text: line }] };
      current.hunks.push(hunk);
      continue;
    }

    if (line.startsWith("--- ")) {
      current.oldPath = filePathOf(line.slice(4), "a/");
    } else if (line.startsWith("+++ ")) {
      current.newPath = filePathOf(line.slice(4), "b/");
    } else if (line.startsWith("new file mode ")) {
      current.change = "added";
      current.oldPath = null;
      current.newMode = line.slice("new file mode ".length).trim();
    } else if (line.startsWith("deleted file mode ")) {
      current.change = "deleted";
      current.newPath = null;
      current.oldMode = line.slice("deleted file mode ".length).trim();
    } else if (line.startsWith("old mode ")) {
      current.oldMode = line.slice("old mode ".length).trim();
    } else if (line.startsWith("new mode ")) {
      current.newMode = line.slice("new mode ".length).trim();
    } else if (line.startsWith("rename from ") || line.startsWith("copy from ")) {
      current.change = line.startsWith("rename") ? "renamed" : "copied";
      current.oldPath = plainPathOf(line.slice(line.indexOf(" from ") + 6));
    } else if (line.startsWith("rename to ") || line.startsWith("copy to ")) {
      current.change = line.startsWith("rename") ? "renamed" : "copied";
      current.newPath = plainPathOf(line.slice(line.indexOf(" to ") + 4));
    } else if (line.startsWith("similarity index ")) {
      const percent = Number.parseInt(line.slice("similarity index ".length), 10);
      current.similarity = Number.isFinite(percent) ? percent : null;
    } else if (BINARY_MARKER.test(line)) {
      current.binary = true;
    }
    // Anything else outside a hunk (`index`, `dissimilarity index`, a binary
    // patch's base85 body, a truncation marker) carries nothing to show.
  }
  flush();
  return files;
}

/**
 * Parse raw unified-diff text into hunks of rows — the single-file view the
 * Git tab uses, where the pane header already names the file. `binary` only
 * when every file in the text is binary, so one binary file never blanks a
 * text file beside it.
 */
export function parseUnifiedDiff(diff: string): ParsedDiff {
  const files = parseDiffFiles(diff);
  return {
    hunks: files.flatMap((file) => file.hunks),
    binary: files.length > 0 && files.every((file) => file.binary)
  };
}
