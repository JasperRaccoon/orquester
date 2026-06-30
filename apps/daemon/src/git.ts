import type {
  GitBranch,
  GitBranchesResponse,
  GitCommitDetail,
  GitCommitFile,
  GitDiffResponse,
  GitFileChange,
  GitFileStatus,
  GitLogEntry,
  GitOpResult,
  GitStatusResponse
} from "@orquester/api";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Error carrying the HTTP status the route should reply with. */
export class GitError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "GitError";
  }
}

/**
 * Reads & mutates a project's git repo by shelling out to the system `git`
 * binary — the data layer behind the GitHub-Desktop-style Git tab. Stateless:
 * every method takes the project dir as `cwd` (the route has already realpath-
 * sandboxed it to fsRoot) and runs git there.
 *
 * Conventions (mirroring AccountsService):
 *   - Every call uses execFile (arg array, no shell): paths/branches/SHAs are
 *     user-controlled, so there is no shell to inject into.
 *   - HOME is pinned to the one `~` the daemon uses, so the per-workspace
 *     `includeIf` rule AccountsService writes (user.* + core.sshCommand) is
 *     picked up — fetch/push therefore use the bound account's identity + SSH
 *     key automatically. This service does NOT depend on AccountsService; when
 *     no account is bound, ambient git config is used.
 *   - `--no-color` + machine-readable `--porcelain`/`-z`/`--format` everywhere;
 *     rejected commands carry `.stdout`/`.stderr`/`.code`, surfaced as GitError.
 */
export class GitService {
  /** Pinned HOME — the one `~` the daemon (and its terminals) use. */
  private readonly home = process.env.HOME ?? homedir();

  // --- Core runner ---------------------------------------------------------

  /**
   * Run `git` in `cwd` with HOME pinned. On a non-zero exit node-pty-style the
   * error carries `.stdout`/`.stderr`/`.code`: with `allowFail` we resolve with
   * those (needed for `git diff --no-index`, which exits 1 when a diff exists,
   * and for `git log` in a repo with no commits); otherwise we throw a
   * GitError(500) preferring `.stderr`.
   */
  private async exec(
    cwd: string,
    args: string[],
    opts?: { timeout?: number; allowFail?: boolean; remote?: boolean }
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    const env = {
      ...process.env,
      HOME: this.home,
      // Remote ops must never block on an interactive credential/host prompt.
      ...(opts?.remote ? { GIT_TERMINAL_PROMPT: "0" } : {})
    };
    try {
      const { stdout, stderr } = await run("git", args, {
        cwd,
        env,
        maxBuffer: 64 * 1024 * 1024,
        timeout: opts?.timeout
      });
      return { stdout, stderr, code: 0 };
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string; code?: number };
      if (opts?.allowFail) {
        return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 };
      }
      throw new GitError(500, errText(error));
    }
  }

  // --- Read --------------------------------------------------------------

  /** True iff `cwd` is inside a git work tree. */
  async isRepo(cwd: string): Promise<boolean> {
    const { stdout, code } = await this.exec(cwd, ["rev-parse", "--is-inside-work-tree"], {
      allowFail: true
    });
    return code === 0 && stdout.trim() === "true";
  }

  /**
   * Working-tree + index status via `git status --porcelain=v2 --branch -z`.
   * Returns `isRepo:false` (never throws) for a non-repo dir so the route can
   * 200 the UI's empty state.
   */
  async status(cwd: string): Promise<GitStatusResponse> {
    if (!(await this.isRepo(cwd))) {
      return {
        isRepo: false,
        branch: null,
        detached: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        lastFetched: null,
        files: []
      };
    }

    const { stdout } = await this.exec(cwd, ["status", "--porcelain=v2", "--branch", "-z"]);

    let branch: string | null = null;
    let detached = false;
    let upstream: string | null = null;
    let ahead = 0;
    let behind = 0;
    const files: GitFileChange[] = [];

    // -z makes every record NUL-terminated; rename/copy ("2") records are
    // followed by a SEPARATE NUL field holding the original path, so we consume
    // fields with an index rather than a plain split-loop.
    const fields = stdout.split("\0");
    for (let i = 0; i < fields.length; i++) {
      const record = fields[i];
      if (!record) continue;

      if (record.startsWith("# ")) {
        const header = record.slice(2);
        if (header.startsWith("branch.head ")) {
          const name = header.slice("branch.head ".length);
          if (name === "(detached)") {
            detached = true;
            branch = null;
          } else {
            branch = name;
          }
        } else if (header.startsWith("branch.upstream ")) {
          upstream = header.slice("branch.upstream ".length) || null;
        } else if (header.startsWith("branch.ab ")) {
          // "+<ahead> -<behind>"
          const m = header.slice("branch.ab ".length).match(/\+(-?\d+)\s+-(-?\d+)/);
          if (m) {
            ahead = Number.parseInt(m[1], 10) || 0;
            behind = Number.parseInt(m[2], 10) || 0;
          }
        }
        continue;
      }

      if (record.startsWith("? ")) {
        files.push({ path: record.slice(2), status: "untracked", staged: false, unstaged: true });
        continue;
      }

      if (record.startsWith("1 ")) {
        // "1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>": 8 space tokens (incl.
        // the "1") precede the path, which may itself contain spaces.
        const xy = record.slice(2, 4);
        const path = record.split(" ").slice(8).join(" ");
        files.push(this.toChange(path, xy));
        continue;
      }

      if (record.startsWith("2 ")) {
        // "2 <XY> … <Xscore> <path>": 9 tokens (incl. the "2" and the rename
        // score, e.g. R100) precede the new path; the NEXT NUL field is the
        // original path.
        const xy = record.slice(2, 4);
        const path = record.split(" ").slice(9).join(" ");
        const oldPath = fields[++i] ?? "";
        files.push(this.toChange(path, xy, oldPath));
        continue;
      }

      if (record.startsWith("u ")) {
        // Unmerged: "u <xy> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>" —
        // 10 tokens precede the path; always a conflict.
        const path = record.split(" ").slice(10).join(" ");
        files.push({ path, status: "conflicted", staged: false, unstaged: true });
        continue;
      }
    }

    let lastFetched: string | null = null;
    try {
      lastFetched = (await stat(join(cwd, ".git", "FETCH_HEAD"))).mtime.toISOString();
    } catch {
      /* never fetched (or .git is a file/worktree) — leave null */
    }

    return { isRepo: true, branch, detached, upstream, ahead, behind, lastFetched, files };
  }

  /**
   * Build a GitFileChange from a porcelain-v2 "XY" pair: X = index (staged)
   * status, Y = worktree (unstaged) status; "." = unchanged on that side. The
   * reported status prefers whichever side is changed (worktree first, since
   * the changes list is working-tree-centric).
   */
  private toChange(path: string, xy: string, oldPath?: string): GitFileChange {
    const x = xy[0];
    const y = xy[1];
    const staged = x !== ".";
    const unstaged = y !== ".";
    const status = mapStatusLetter(unstaged ? y : x);
    return {
      path,
      status,
      staged,
      unstaged,
      ...(oldPath ? { oldPath } : {})
    };
  }

  /**
   * Unified diff for a single file. `commit` → that commit's diff; `staged` →
   * the index diff; otherwise the working-tree diff, falling back to a
   * `--no-index` diff against /dev/null for untracked files (which produce no
   * plain `git diff` output).
   */
  async diff(
    cwd: string,
    file: string,
    opts: { staged?: boolean; commit?: string }
  ): Promise<GitDiffResponse> {
    let diff: string;
    if (opts.commit) {
      const { stdout } = await this.exec(cwd, [
        "show",
        "--no-color",
        "--format=",
        opts.commit,
        "--",
        file
      ]);
      diff = stdout;
    } else if (opts.staged) {
      const { stdout } = await this.exec(cwd, ["diff", "--no-color", "--staged", "--", file]);
      diff = stdout;
    } else {
      const { stdout } = await this.exec(cwd, ["diff", "--no-color", "--", file]);
      diff = stdout;
      if (!diff) {
        // Likely untracked: diff against the null device (exits 1 when differing).
        const nul = process.platform === "win32" ? "NUL" : "/dev/null";
        const res = await this.exec(cwd, ["diff", "--no-color", "--no-index", "--", nul, file], {
          allowFail: true
        });
        diff = res.stdout;
      }
    }
    return { diff, binary: isBinaryDiff(diff) };
  }

  /**
   * Commit log (newest first). `allowFail` because an empty repo (no commits)
   * makes `git log` exit non-zero — we return `[]`. Fields are joined by US
   * (\x1f) and records by NUL; %D carries ref decorations.
   */
  async log(cwd: string, opts: { skip?: number; limit?: number }): Promise<GitLogEntry[]> {
    const limit = opts.limit && opts.limit > 0 ? opts.limit : 50;
    const args = [
      "log",
      "--no-color",
      "-z",
      "--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%D%x1f%s%x1f%b",
      `--skip=${opts.skip ?? 0}`,
      "-n",
      String(limit)
    ];
    const { stdout } = await this.exec(cwd, args, { allowFail: true });
    if (!stdout) return [];
    return stdout
      .split("\0")
      .filter((record) => record.length > 0)
      .map((record) => {
        const [sha, shortSha, authorName, authorEmail, date, decoration, subject, body] =
          record.split("\x1f");
        return {
          sha: sha ?? "",
          shortSha: shortSha ?? "",
          subject: subject ?? "",
          body: body ?? "",
          authorName: authorName ?? "",
          authorEmail: authorEmail ?? "",
          date: date ?? "",
          refs: parseRefs(decoration ?? "")
        };
      });
  }

  /**
   * Full detail for one commit: metadata plus its changed files with
   * additions/deletions (from --numstat) and status letters (from
   * --name-status), merged by path. The name-status pass is authoritative for
   * `path`/`oldPath`/`status` (its rename form is clean `R<score>\t<old>\t<new>`,
   * whereas numstat renders renames as `old => new` / `a/{b => c}/d`).
   */
  async commitDetail(cwd: string, sha: string): Promise<GitCommitDetail> {
    if (!sha.trim()) {
      throw new GitError(400, "A commit SHA is required.");
    }
    const { stdout: metaOut } = await this.exec(cwd, [
      "show",
      "-s",
      "--no-color",
      "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b",
      sha
    ]);
    const [fullSha, shortSha, authorName, authorEmail, date, subject, body] = metaOut.split("\x1f");

    // name-status: authoritative path/oldPath/status, keyed by the new path.
    const { stdout: nameOut } = await this.exec(cwd, [
      "show",
      "--no-color",
      "--name-status",
      "--format=",
      sha
    ]);
    const byPath = new Map<string, GitCommitFile>();
    const order: string[] = [];
    for (const line of nameOut.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      const code = parts[0];
      const letter = code[0];
      let path: string;
      let oldPath: string | undefined;
      if ((letter === "R" || letter === "C") && parts.length >= 3) {
        oldPath = parts[1];
        path = parts[2];
      } else {
        path = parts[1] ?? "";
      }
      if (!path) continue;
      byPath.set(path, {
        path,
        ...(oldPath ? { oldPath } : {}),
        status: mapStatusLetter(letter),
        additions: 0,
        deletions: 0,
        binary: false
      });
      order.push(path);
    }

    // numstat: additions/deletions, matched onto the name-status entries.
    const { stdout: numOut } = await this.exec(cwd, [
      "show",
      "--no-color",
      "--numstat",
      "--format=",
      sha
    ]);
    for (const line of numOut.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const [addStr, delStr] = parts;
      const numPath = parts.slice(2).join("\t");
      const newPath = numstatNewPath(numPath);
      const binary = addStr === "-" && delStr === "-";
      const entry = byPath.get(newPath);
      if (entry) {
        entry.additions = binary ? 0 : Number.parseInt(addStr, 10) || 0;
        entry.deletions = binary ? 0 : Number.parseInt(delStr, 10) || 0;
        entry.binary = binary;
      } else {
        // numstat saw a file name-status didn't (shouldn't happen, but stay safe).
        byPath.set(newPath, {
          path: newPath,
          status: "modified",
          additions: binary ? 0 : Number.parseInt(addStr, 10) || 0,
          deletions: binary ? 0 : Number.parseInt(delStr, 10) || 0,
          binary
        });
        order.push(newPath);
      }
    }

    return {
      sha: fullSha ?? sha,
      shortSha: shortSha ?? "",
      subject: subject ?? "",
      body: body ?? "",
      authorName: authorName ?? "",
      authorEmail: authorEmail ?? "",
      date: date ?? "",
      files: order.map((p) => byPath.get(p)).filter((f): f is GitCommitFile => !!f)
    };
  }

  /** Local branches (with upstream + current flag) and remote-tracking branches. */
  async branches(cwd: string): Promise<GitBranchesResponse> {
    // NOTE: `git for-each-ref --format` does NOT expand `%xNN` hex escapes (that's
    // a `git log --pretty` feature), so fields are separated by a literal TAB —
    // safe because git ref names cannot contain whitespace.
    const { stdout: localOut } = await this.exec(cwd, [
      "for-each-ref",
      "--format=%(refname:short)\t%(upstream:short)\t%(HEAD)",
      "refs/heads"
    ]);
    const local: GitBranch[] = [];
    let current: string | null = null;
    for (const line of localOut.split("\n")) {
      if (!line.trim()) continue;
      const [name, up, head] = line.split("\t");
      if (!name) continue;
      const isCurrent = head === "*";
      if (isCurrent) current = name;
      local.push({ name, current: isCurrent, ...(up ? { upstream: up } : {}) });
    }

    // Use the FULL refname: a remote's symbolic HEAD short-names to just the
    // remote (e.g. "origin"), so it cannot be filtered out by short name.
    const { stdout: remoteOut } = await this.exec(cwd, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/remotes"
    ]);
    const remote = remoteOut
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.endsWith("/HEAD"))
      .map((l) => l.replace(/^refs\/remotes\//, ""));

    return { current, local, remote };
  }

  // --- Mutations ---------------------------------------------------------

  /** Stage files (or everything when `files` is empty). */
  async stage(cwd: string, files: string[]): Promise<GitOpResult> {
    const args = files.length > 0 ? ["add", "--", ...files] : ["add", "-A"];
    const { stdout, stderr } = await this.exec(cwd, args);
    return { ok: true, output: combine(stdout, stderr) };
  }

  /** Unstage files (or the whole index when `files` is empty). */
  async unstage(cwd: string, files: string[]): Promise<GitOpResult> {
    const args =
      files.length > 0 ? ["restore", "--staged", "--", ...files] : ["reset", "-q", "HEAD", "--"];
    const { stdout, stderr } = await this.exec(cwd, args);
    return { ok: true, output: combine(stdout, stderr) };
  }

  /**
   * Commit the staged changes. Rejects a blank summary (400). A non-empty
   * description becomes a second `-m`. Author identity is left to the ambient /
   * includeIf config (no author flags).
   */
  async commit(cwd: string, summary: string, description?: string): Promise<GitOpResult> {
    const trimmed = summary?.trim();
    if (!trimmed) {
      throw new GitError(400, "A commit summary is required.");
    }
    const args = ["commit", "-m", trimmed];
    if (description && description.trim()) {
      args.push("-m", description);
    }
    const { stdout, stderr } = await this.exec(cwd, args);
    return { ok: true, output: combine(stdout, stderr) };
  }

  /**
   * Discard working-tree changes for the given files. Destructive (gated by a
   * client confirm). Best-effort: restore tracked files, then clean leftover
   * untracked ones — either step may be a no-op depending on each file's state.
   */
  async discard(cwd: string, files: string[]): Promise<GitOpResult> {
    if (files.length === 0) {
      throw new GitError(400, "No files to discard.");
    }
    const restore = await this.exec(cwd, ["restore", "--", ...files], { allowFail: true });
    const clean = await this.exec(cwd, ["clean", "-fd", "--", ...files], { allowFail: true });
    return { ok: true, output: combine(restore.stdout, restore.stderr, clean.stdout, clean.stderr) };
  }

  /** Fetch all remotes, pruning stale tracking refs. */
  async fetch(cwd: string): Promise<GitOpResult> {
    const { stdout, stderr } = await this.exec(cwd, ["fetch", "--all", "--prune"], {
      remote: true,
      timeout: 60_000
    });
    return { ok: true, output: combine(stdout, stderr) };
  }

  /**
   * Pull the current branch. `--no-rebase` pins the reconciliation strategy to
   * merge so a *divergent* branch (local commits the remote lacks AND remote
   * commits we lack) fast-forwards when it can and otherwise records a merge
   * commit — deterministically, never opening an editor (`--no-edit`). Without
   * it, git ≥ 2.27 aborts a divergent pull with "Need to specify how to
   * reconcile divergent branches" unless `pull.rebase` happens to be configured;
   * forcing merge here is the GitHub-Desktop default and the one behavior the
   * Pull button can promise every time. A merge that hits a conflict exits
   * non-zero (→ GitError → the UI's error banner) and leaves the conflicted
   * files in the working tree, where the Changes panel lists them to resolve +
   * commit — which completes the merge.
   */
  async pull(cwd: string): Promise<GitOpResult> {
    const { stdout, stderr } = await this.exec(cwd, ["pull", "--no-edit", "--no-rebase"], {
      remote: true,
      timeout: 60_000
    });
    return { ok: true, output: combine(stdout, stderr) };
  }

  /**
   * Push the current branch. When there is no upstream git exits non-zero with a
   * helpful message; we surface that stderr rather than auto-setting upstream.
   */
  async push(cwd: string): Promise<GitOpResult> {
    const { stdout, stderr } = await this.exec(cwd, ["push"], { remote: true, timeout: 60_000 });
    return { ok: true, output: combine(stdout, stderr) };
  }

  /** Switch branches. Rejects an empty branch (400). */
  async checkout(cwd: string, branch: string): Promise<GitOpResult> {
    if (!branch?.trim()) {
      throw new GitError(400, "A branch name is required.");
    }
    const { stdout, stderr } = await this.exec(cwd, ["checkout", branch]);
    return { ok: true, output: combine(stdout, stderr) };
  }
}

/** Map a git status letter (porcelain XY or name-status) to a GitFileStatus. */
function mapStatusLetter(letter: string): GitFileStatus {
  switch (letter) {
    case "U":
      return "conflicted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "T":
      return "typechange";
    case "?":
      return "untracked";
    case "M":
      return "modified";
    default:
      return "modified";
  }
}

/**
 * Parse `%D` decoration into bare ref names: split on ", ", strip a leading
 * "HEAD -> " (the current branch) and a "tag: " prefix, drop empties.
 */
function parseRefs(decoration: string): string[] {
  if (!decoration.trim()) return [];
  return decoration
    .split(", ")
    .map((ref) => ref.trim().replace(/^HEAD -> /, "").replace(/^tag: /, ""))
    .filter((ref) => ref.length > 0);
}

/**
 * Resolve a numstat path field to the post-change path. numstat renders renames
 * either as `old => new` or with a brace span `pre/{old => new}/post`; both
 * collapse to the new path. Plain paths pass through.
 */
function numstatNewPath(field: string): string {
  if (!field.includes(" => ")) return field;
  // Brace form: dir/{a => b}/c  →  dir/b/c
  const brace = field.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (brace) {
    return `${brace[1]}${brace[3]}${brace[4]}`;
  }
  // Simple form: a => b  →  b
  const parts = field.split(" => ");
  return parts[parts.length - 1];
}

/**
 * True when a diff is git's "binary" placeholder rather than text hunks. Both
 * markers are matched as WHOLE LINES — an unanchored substring check
 * false-positives whenever the diffed file's own text contains the phrase
 * (e.g. this source file, or the design spec that documents this very check).
 */
function isBinaryDiff(diff: string): boolean {
  return /^Binary files .* differ$/m.test(diff) || /^GIT binary patch$/m.test(diff);
}

/** Join command stdout/stderr fragments into one trimmed blob (empty → undefined). */
function combine(...parts: string[]): string | undefined {
  const text = parts.filter((p) => p && p.length > 0).join("\n").trim();
  return text || undefined;
}

function errText(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error && (error as { stderr?: string }).stderr) {
    return String((error as { stderr?: string }).stderr).slice(0, 500);
  }
  return error instanceof Error ? error.message : "unknown git error";
}
