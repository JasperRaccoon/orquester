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
  GitStashEntry,
  GitStatusResponse
} from "@orquester/api";
import { execFile } from "node:child_process";
import { lstat, open, readlink, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

type GitRunner = (
  file: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    maxBuffer: number;
    timeout?: number;
  }
) => Promise<{ stdout: string; stderr: string }>;

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
  /**
   * Tail promise for each repository's mutation queue. Git protects individual
   * files with lockfiles, but concurrent fetches can both read the same old ref
   * and then race its compare-and-swap update. Keeping this in the shared daemon
   * service serializes mutations across transports, browser tabs, and clients.
   */
  private readonly mutationTails = new Map<string, Promise<void>>();

  private readonly runner: GitRunner;

  constructor(options?: { runner?: GitRunner }) {
    this.runner = options?.runner ?? (run as GitRunner);
  }

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
      const { stdout, stderr } = await this.runner("git", args, {
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

  /** Queue one mutation behind earlier mutations for the same canonical cwd. */
  private async mutate<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTails.get(cwd) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.mutationTails.set(cwd, tail);

    try {
      return await result;
    } finally {
      if (this.mutationTails.get(cwd) === tail) {
        this.mutationTails.delete(cwd);
      }
    }
  }

  /** Fetch every remote while already inside this repository's mutation queue. */
  private fetchAll(cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
    return this.exec(cwd, ["fetch", "--all", "--prune"], {
      remote: true,
      timeout: 60_000
    });
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
   * the index diff; otherwise the working-tree diff — except for an untracked
   * file, which git has nothing to diff against and would render as "no
   * changes". Those get a SYNTHESIZED new-file patch built from the file's own
   * bytes, so the viewer shows every line as an addition exactly like a staged
   * add. (`git diff --no-index -- /dev/null <file>` produces something similar
   * but needs a platform-specific null device and mislabels the `a/` side.)
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
      // Empty is the only case that can be an untracked file, so the extra
      // status read never runs for the common (modified) path.
      if (!diff && (await this.isUntracked(cwd, file))) {
        return untrackedDiff(cwd, file);
      }
    }
    return { diff, binary: isBinaryDiff(diff) };
  }

  /** True when `file` is untracked ("??") according to a path-scoped status read. */
  private async isUntracked(cwd: string, file: string): Promise<boolean> {
    const { stdout, code } = await this.exec(
      cwd,
      ["status", "--porcelain=v1", "-z", "--", file],
      { allowFail: true }
    );
    return code === 0 && nulRecords(stdout).some((record) => record.startsWith("??"));
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
      "--pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%D%x1f%s%x1f%b",
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
        const [sha, shortSha, parents, authorName, authorEmail, date, decoration, subject, body] =
          record.split("\x1f");
        return {
          sha: sha ?? "",
          shortSha: shortSha ?? "",
          parents: (parents ?? "").split(" ").filter((p) => p.length > 0),
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
    // `-z` is not optional here: the plain form C-quotes any path with unicode
    // or spaces (`"new n\303\244me.txt"`), and that quoted string then fails as
    // the pathspec the UI sends back to /api/git/diff.
    const { stdout: nameOut } = await this.exec(cwd, [
      "show",
      "--no-color",
      "--name-status",
      "-z",
      "--format=",
      sha
    ]);
    const byPath = new Map<string, GitCommitFile>();
    const order: string[] = [];
    for (const { status: code, path, oldPath } of parseNameStatusZ(nameOut)) {
      if (!path) continue;
      byPath.set(path, {
        path,
        ...(oldPath ? { oldPath } : {}),
        status: mapStatusLetter(code[0]),
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
      "-z",
      "--format=",
      sha
    ]);
    for (const { additions: addStr, deletions: delStr, path: newPath } of parseNumstatZ(numOut)) {
      if (!newPath) continue;
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
      "--format=%(refname:short)\t%(upstream:short)\t%(HEAD)\t%(upstream:track)",
      "refs/heads"
    ]);
    const local: GitBranch[] = [];
    let current: string | null = null;
    for (const line of localOut.split("\n")) {
      if (!line.trim()) continue;
      const [name, up, head, track] = line.split("\t");
      if (!name) continue;
      const isCurrent = head === "*";
      if (isCurrent) current = name;
      const { ahead, behind } = parseTrack(track ?? "");
      local.push({ name, current: isCurrent, ahead, behind, ...(up ? { upstream: up } : {}) });
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
    return this.mutate(cwd, async () => {
      const args = files.length > 0 ? ["add", "--", ...files] : ["add", "-A"];
      const { stdout, stderr } = await this.exec(cwd, args);
      return { ok: true, output: combine(stdout, stderr) };
    });
  }

  /** Unstage files (or the whole index when `files` is empty). */
  async unstage(cwd: string, files: string[]): Promise<GitOpResult> {
    return this.mutate(cwd, async () => {
      const args =
        files.length > 0 ? ["restore", "--staged", "--", ...files] : ["reset", "-q", "HEAD", "--"];
      const { stdout, stderr } = await this.exec(cwd, args);
      return { ok: true, output: combine(stdout, stderr) };
    });
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
    return this.mutate(cwd, async () => {
      const args = ["commit", "-m", trimmed];
      if (description && description.trim()) {
        args.push("-m", description);
      }
      const { stdout, stderr } = await this.exec(cwd, args);
      return { ok: true, output: combine(stdout, stderr) };
    });
  }

  /**
   * Discard the given files back to HEAD. Destructive (gated by a client
   * confirm).
   *
   * The paths MUST be split by trackedness first: `git restore` refuses a
   * pathspec it doesn't know and aborts the ENTIRE invocation, so one untracked
   * path in the list silently left every tracked file in the list unmodified
   * (while the follow-up `clean` still deleted the untracked one — "discard
   * worked for the new file but not for my edit"). Tracked paths go through
   * `restore --staged --worktree` (index AND worktree, so a staged add is
   * unstaged and removed, matching GitHub Desktop), untracked paths through
   * `clean -fd`. Either list may be empty; a path git doesn't report at all is
   * already clean and is skipped.
   *
   * The status read is deliberately UNSCOPED and filtered here rather than run
   * with the paths as a pathspec: rename detection is pathspec-limited, so
   * `status -- moved.txt` reports a plain `A moved.txt` and hides that
   * `kept.txt` is staged-deleted as its other half. Restoring only the new path
   * then leaves the original deleted — a discard that half-reverts. Reading the
   * whole status keeps the `R` record (new path + original) intact.
   */
  async discard(cwd: string, files: string[]): Promise<GitOpResult> {
    if (files.length === 0) {
      throw new GitError(400, "No files to discard.");
    }
    return this.mutate(cwd, async () => {
      const { stdout } = await this.exec(cwd, ["status", "--porcelain=v1", "-z"], {
        allowFail: true
      });
      // A requested path matches an entry by equality or as its parent directory
      // (the UI sends file paths, but a pathspec may name a folder).
      const wanted = files.map((file) => file.replace(/\/+$/, ""));
      const requested = (path: string) =>
        wanted.some((want) => path === want || path.startsWith(`${want}/`));

      const tracked = new Set<string>();
      const untracked: string[] = [];
      for (const entry of parseStatusZ(stdout)) {
        // Either half of a rename may be the one the caller named.
        if (!requested(entry.path) && !(entry.oldPath && requested(entry.oldPath))) continue;
        if (entry.status.startsWith("?")) {
          untracked.push(entry.path);
          continue;
        }
        tracked.add(entry.path);
        // A rename is TWO paths in one record: restoring only the new path
        // leaves the original staged-deleted and missing from the worktree
        // ("discard" that half-reverts). Both go into the pathspec.
        if (entry.oldPath) tracked.add(entry.oldPath);
      }

      const outputs: string[] = [];
      if (tracked.size > 0) {
        const restore = await this.exec(cwd, ["restore", "--staged", "--worktree", "--", ...tracked], {
          allowFail: true
        });
        outputs.push(restore.stdout, restore.stderr);
      }
      if (untracked.length > 0) {
        const clean = await this.exec(cwd, ["clean", "-fd", "--", ...untracked], { allowFail: true });
        outputs.push(clean.stdout, clean.stderr);
      }
      return { ok: true, output: combine(...outputs) };
    });
  }

  // --- Stashes -------------------------------------------------------------

  /**
   * `git stash list`, newest first. Fields are US-separated and records RS-
   * separated (git emits a newline after each record, which the trim drops):
   * `%gs` is free-form text, so a tab/newline split would mis-slice it.
   */
  async stashList(cwd: string): Promise<GitStashEntry[]> {
    if (!(await this.isRepo(cwd))) return [];
    const { stdout } = await this.exec(
      cwd,
      ["stash", "list", "--no-color", "--format=%H%x1f%gs%x1f%aI%x1e"],
      { allowFail: true }
    );
    return stdout
      .split("\x1e")
      .map((record) => record.trim())
      .filter((record) => record.length > 0)
      .map((record, index) => {
        const [sha, subject, date] = record.split("\x1f");
        const { branch, message } = parseStashSubject(subject ?? "");
        return { index, sha: sha ?? "", branch, message, date: date ?? "" };
      });
  }

  /** Stash the working tree (optionally including untracked files). */
  async stashCreate(
    cwd: string,
    opts: { message?: string; includeUntracked?: boolean }
  ): Promise<GitOpResult> {
    return this.mutate(cwd, async () => {
      const args = ["stash", "push"];
      if (opts.includeUntracked) args.push("--include-untracked");
      const message = opts.message?.trim();
      if (message) args.push("-m", message);
      const { stdout, stderr } = await this.exec(cwd, args);
      return { ok: true, output: combine(stdout, stderr) };
    });
  }

  /**
   * Run one stash op against `stash@{index}`. The ref is built here from a
   * validated integer rather than accepted from the client, so no caller can
   * name an arbitrary revision through this route.
   *
   * An index alone is NOT a safe handle: `stash@{n}` addresses a position in a
   * list any other client (or a terminal) may have pushed onto or dropped from
   * since this client read it, and a Drop against the shifted list destroys the
   * wrong — unrecoverable — stash. So the caller must also send the `sha` it
   * saw; inside the mutation queue we re-resolve the ref and refuse with 409
   * unless it still names that exact commit. The UI re-reads the list on 409.
   */
  private async stashOp(
    cwd: string,
    verb: "apply" | "pop" | "drop",
    index: number,
    sha: string
  ): Promise<GitOpResult> {
    if (!Number.isInteger(index) || index < 0) {
      throw new GitError(400, "A stash index is required.");
    }
    if (!sha?.trim()) {
      throw new GitError(400, "A stash sha is required.");
    }
    return this.mutate(cwd, async () => {
      const ref = `stash@{${index}}`;
      const resolved = await this.exec(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
        allowFail: true
      });
      if (resolved.code !== 0 || resolved.stdout.trim() !== sha.trim()) {
        throw new GitError(409, "The stash list changed on disk. Refresh and try again.");
      }
      const { stdout, stderr } = await this.exec(cwd, ["stash", verb, ref]);
      return { ok: true, output: combine(stdout, stderr) };
    });
  }

  /** Apply a stash, keeping it in the list. */
  stashApply(cwd: string, index: number, sha: string): Promise<GitOpResult> {
    return this.stashOp(cwd, "apply", index, sha);
  }

  /** Apply a stash and drop it on success. */
  stashPop(cwd: string, index: number, sha: string): Promise<GitOpResult> {
    return this.stashOp(cwd, "pop", index, sha);
  }

  /** Delete a stash without applying it. */
  stashDrop(cwd: string, index: number, sha: string): Promise<GitOpResult> {
    return this.stashOp(cwd, "drop", index, sha);
  }

  /** Fetch all remotes, pruning stale tracking refs. */
  async fetch(cwd: string): Promise<GitOpResult> {
    return this.mutate(cwd, async () => {
      const { stdout, stderr } = await this.fetchAll(cwd);
      return { ok: true, output: combine(stdout, stderr) };
    });
  }

  /**
   * Pull the current branch as two explicit steps in one mutation slot: fetch
   * every remote (pruning stale refs), then merge the current branch's upstream.
   * Using `merge` after the explicit fetch avoids `git pull` performing a second,
   * redundant fetch. This pins reconciliation to GitHub-Desktop-style merge:
   * fast-forward when possible, otherwise create a merge commit, never opening
   * an editor (`--no-edit`). A conflict exits non-zero (→ GitError → the UI's
   * error banner) and remains in the working tree to resolve and commit.
   */
  async pull(cwd: string): Promise<GitOpResult> {
    return this.mutate(cwd, async () => {
      const fetched = await this.fetchAll(cwd);
      const merged = await this.exec(cwd, ["merge", "--no-edit", "@{upstream}"]);
      return {
        ok: true,
        output: combine(fetched.stdout, fetched.stderr, merged.stdout, merged.stderr)
      };
    });
  }

  /**
   * Push the current branch. When there is no upstream git exits non-zero with a
   * helpful message; we surface that stderr rather than auto-setting upstream.
   */
  async push(cwd: string): Promise<GitOpResult> {
    return this.mutate(cwd, async () => {
      const { stdout, stderr } = await this.exec(cwd, ["push"], { remote: true, timeout: 60_000 });
      return { ok: true, output: combine(stdout, stderr) };
    });
  }

  /** Switch branches. Rejects an empty branch (400). */
  async checkout(cwd: string, branch: string): Promise<GitOpResult> {
    if (!branch?.trim()) {
      throw new GitError(400, "A branch name is required.");
    }
    return this.mutate(cwd, async () => {
      const { stdout, stderr } = await this.exec(cwd, ["checkout", branch]);
      return { ok: true, output: combine(stdout, stderr) };
    });
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

// --- `-z` parsers ----------------------------------------------------------
//
// Every machine-read git listing goes through `-z`. The plain forms C-quote any
// path containing spaces, unicode or backslashes ("new n\303\244me.txt") and
// render a rename as one `old => new` string — neither survives a round-trip
// back to git as a pathspec, which is exactly what the UI does with these paths.
// The cost is that a rename becomes MULTIPLE NUL records, in an order that
// differs per command (see each parser).

/** Split `-z` output on NUL, dropping the trailing empty element the terminator leaves. */
function nulRecords(output: string): string[] {
  const records = output.split("\0");
  if (records.length > 0 && records[records.length - 1] === "") {
    records.pop();
  }
  return records;
}

/**
 * `git status --porcelain=v1 -z`: `XY <path>` per record, and a rename/copy is
 * followed by a SEPARATE record holding the original path (new-then-old — the
 * opposite of `diff --name-status -z` below). The original path is SURFACED, not
 * just skipped: discarding a rename has to restore both halves, or the old path
 * stays staged-deleted and gone from the worktree.
 */
function parseStatusZ(output: string): { status: string; path: string; oldPath?: string }[] {
  const records = nulRecords(output);
  const entries: { status: string; path: string; oldPath?: string }[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    const oldPath = status.includes("R") || status.includes("C") ? records[++i] : undefined;
    entries.push({ status, path, ...(oldPath ? { oldPath } : {}) });
  }
  return entries;
}

/**
 * `git diff/show --name-status -z`: the status code is its own record, followed
 * by the path — or, for a rename/copy, by OLD then NEW (the opposite order from
 * `status -z`).
 */
function parseNameStatusZ(output: string): { status: string; path: string; oldPath?: string }[] {
  const records = nulRecords(output);
  const entries: { status: string; path: string; oldPath?: string }[] = [];
  for (let i = 0; i < records.length; ) {
    const status = records[i++];
    if (!status) continue;
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = records[i++] ?? "";
      entries.push({ status, path: records[i++] ?? "", oldPath });
    } else {
      entries.push({ status, path: records[i++] ?? "" });
    }
  }
  return entries;
}

/**
 * `git diff/show --numstat -z`: `<add>\t<del>\t<path>`, except a rename leaves
 * the inline path EMPTY and appends two more records (old path, then new path).
 * Additions/deletions stay strings so the caller can spot git's "-" for binary.
 */
function parseNumstatZ(output: string): { additions: string; deletions: string; path: string }[] {
  const records = nulRecords(output);
  const entries: { additions: string; deletions: string; path: string }[] = [];
  for (let i = 0; i < records.length; ) {
    const record = records[i++];
    if (!record) continue;
    const tab1 = record.indexOf("\t");
    const tab2 = record.indexOf("\t", tab1 + 1);
    if (tab1 === -1 || tab2 === -1) continue;
    const additions = record.slice(0, tab1);
    const deletions = record.slice(tab1 + 1, tab2);
    let path = record.slice(tab2 + 1);
    if (!path) {
      i++; // old path
      path = records[i++] ?? "";
    }
    entries.push({ additions, deletions, path });
  }
  return entries;
}

/** Parse `%(upstream:track)` ("[ahead 2, behind 1]", "[gone]", "") into counts. */
function parseTrack(track: string): { ahead: number; behind: number } {
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  return {
    ahead: ahead ? Number.parseInt(ahead[1], 10) || 0 : 0,
    behind: behind ? Number.parseInt(behind[1], 10) || 0 : 0
  };
}

/**
 * Split a stash's `%gs` subject ("WIP on main: 0a1afe4 pure rename", or
 * "On main: my message") into the branch and the message tail.
 */
function parseStashSubject(subject: string): { branch: string; message: string } {
  const colon = subject.indexOf(": ");
  if (colon === -1) {
    return { branch: "", message: subject };
  }
  const head = subject.slice(0, colon);
  const branch = head.startsWith("WIP on ")
    ? head.slice("WIP on ".length)
    : head.startsWith("On ")
      ? head.slice("On ".length)
      : head;
  return { branch, message: subject.slice(colon + 2) };
}

/**
 * Largest untracked file rendered as a synthetic patch — the same 1 MB cap the
 * file browser's read route uses. Beyond it (or for binary content) the viewer
 * gets git's own binary placeholder instead of megabytes of `+` lines.
 */
const UNTRACKED_DIFF_CAP = 1024 * 1024;

/**
 * Build the `diff --git` new-file patch git itself never emits for an untracked
 * file. Best-effort: an unreadable path (deleted between status and read, a
 * directory, a permission error) yields an empty diff rather than a 500.
 *
 * SECURITY: this is the one place the daemon reads a file by path with no git
 * process in between, so it must not follow links out of the repo. An untracked
 * SYMLINK is rendered from its TARGET STRING (what `git diff` shows for a
 * 120000-mode blob) and never opened — otherwise `ln -s /etc/shadow x` would
 * paste any daemon-readable host file into the patch. A regular file is
 * additionally realpath-checked to still be inside the repo, since a symlinked
 * PARENT directory would escape the same way.
 */
async function untrackedDiff(cwd: string, file: string): Promise<GitDiffResponse> {
  const placeholder = (reason: string) =>
    `diff --git a/${file} b/${file}\nnew file mode 100644\nBinary files /dev/null and b/${file} differ\n${reason}\n`;

  const full = join(cwd, file);
  let info;
  try {
    info = await lstat(full);
  } catch {
    return { diff: "", binary: false };
  }

  if (info.isSymbolicLink()) {
    let target: string;
    try {
      target = await readlink(full);
    } catch {
      return { diff: "", binary: false };
    }
    // git stores a symlink as a one-line blob holding the target, with no
    // trailing newline — mirror that exactly, including the "\ No newline" note.
    return {
      diff:
        `diff --git a/${file} b/${file}\nnew file mode 120000\nindex 0000000..0000000\n` +
        `--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+${target}\n\\ No newline at end of file\n`,
      binary: false
    };
  }
  if (!info.isFile()) {
    return { diff: "", binary: false };
  }
  try {
    const [realFile, realRoot] = await Promise.all([realpath(full), realpath(cwd)]);
    if (realFile !== realRoot && !realFile.startsWith(realRoot + sep)) {
      return { diff: "", binary: false };
    }
  } catch {
    return { diff: "", binary: false };
  }

  let content: string;
  try {
    const handle = await open(full, "r");
    try {
      const buffer = Buffer.alloc(UNTRACKED_DIFF_CAP + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const bytes = buffer.subarray(0, bytesRead);
      if (bytesRead > UNTRACKED_DIFF_CAP) {
        return { diff: placeholder("(untracked file larger than 1 MB)"), binary: true };
      }
      if (bytes.includes(0)) {
        return { diff: placeholder("(untracked binary file)"), binary: true };
      }
      content = bytes.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return { diff: "", binary: false };
  }

  // Drop the single trailing newline so the last line isn't rendered as an
  // extra empty addition; an empty file gets a zero-line hunk.
  const body = content.replace(/\r?\n$/, "");
  const lines = body.length === 0 ? [] : body.split("\n");
  const hunk = lines.length === 0 ? "" : `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`;
  return {
    diff: `diff --git a/${file} b/${file}\nnew file mode 100644\nindex 0000000..0000000\n--- /dev/null\n+++ b/${file}\n${hunk}`,
    binary: false
  };
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

/**
 * Per-connection filter for the `/events` stream: `project.git.changed` carries
 * a whole status blob that is noise to everyone except the clients watching that
 * project, so it is delivered only to them and passes through untouched for
 * every other event.
 *
 * The decision is made on the event's real `type`. The substring test is only a
 * cheap gate so no unrelated event pays for a `JSON.parse` — deciding on the
 * substring ALONE silently dropped any event whose *payload* happened to quote
 * that literal (a terminal echoing it, a to-do naming it), and dropped it on
 * every unscoped stream, i.e. all of them.
 */
export function passesGitEventFilter(data: string, watchedProject: string | null): boolean {
  if (!data.includes('"project.git.changed"')) return true;
  let event: { type?: string; payload?: { path?: string } } | null = null;
  try {
    event = JSON.parse(data) as { type?: string; payload?: { path?: string } };
  } catch {
    return true; // not parseable — not ours to filter
  }
  if (event?.type !== "project.git.changed") return true;
  return watchedProject !== null && event.payload?.path === watchedProject;
}

/** How often a WATCHED project's status is re-read. */
const WATCH_INTERVAL_MS = 2000;

/**
 * Change-detection key for a status snapshot. `lastFetched` is deliberately
 * excluded: it is the mtime of .git/FETCH_HEAD, which the Git tab's own
 * background auto-fetch bumps every 60s — keeping it in the key made an
 * otherwise idle repo push a no-op "change" on that cadence to every subscriber.
 */
function watchKey(status: GitStatusResponse): string {
  return JSON.stringify({ ...status, lastFetched: null });
}

/**
 * Refcounted per-project status poller behind the `project.git.changed` event.
 *
 * Two properties make this cheap enough to run in the daemon: it polls ONLY
 * projects at least one `/events?project=…` client is currently looking at
 * (subscribe/unsubscribe are refcounted, so several clients on one project cost
 * one poll loop), and it emits only when the SERIALIZED status actually
 * differs, so an idle repo is silent. Polling rather than `fs.watch` is
 * deliberate: recursive watches are unportable and a busy repo (a build writing
 * into the tree) would fire thousands of times per second.
 *
 * Each loop is a self-rescheduling timeout, never an interval — a status read
 * that takes longer than the period must not stack up behind itself. The timer
 * is `unref`ed so a watcher can never hold the process open at shutdown.
 */
export class GitWatcher {
  private readonly watched = new Map<
    string,
    { subscribers: number; timer: NodeJS.Timeout | null; previous: string | null; stopped: boolean }
  >();

  constructor(
    private readonly git: GitService,
    private readonly onChange: (path: string, status: GitStatusResponse) => void,
    private readonly intervalMs = WATCH_INTERVAL_MS
  ) {}

  /** Register interest in `path`, starting the poll loop on the first subscriber. */
  subscribe(path: string): void {
    const entry = this.watched.get(path);
    if (entry) {
      entry.subscribers += 1;
      return;
    }
    const created = { subscribers: 1, timer: null as NodeJS.Timeout | null, previous: null as string | null, stopped: false };
    this.watched.set(path, created);
    void this.poll(path);
  }

  /** Drop one subscriber; the last one out stops and forgets the loop. */
  unsubscribe(path: string): void {
    const entry = this.watched.get(path);
    if (!entry) return;
    entry.subscribers -= 1;
    if (entry.subscribers > 0) return;
    entry.stopped = true;
    if (entry.timer) clearTimeout(entry.timer);
    this.watched.delete(path);
  }

  /** Stop every loop (daemon shutdown). */
  stop(): void {
    for (const entry of this.watched.values()) {
      entry.stopped = true;
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.watched.clear();
  }

  private async poll(path: string): Promise<void> {
    const entry = this.watched.get(path);
    if (!entry || entry.stopped) return;
    try {
      const status = await this.git.status(path);
      const serialized = watchKey(status);
      // The first read only seeds the baseline: a subscriber has just fetched
      // the status itself, so announcing it again would be pure noise.
      if (entry.previous !== null && entry.previous !== serialized) {
        this.onChange(path, status);
      }
      entry.previous = serialized;
    } catch {
      // Repo vanished / git unavailable: forget the baseline so recovery emits.
      entry.previous = null;
    }
    if (entry.stopped || this.watched.get(path) !== entry) return;
    entry.timer = setTimeout(() => void this.poll(path), this.intervalMs);
    entry.timer.unref?.();
  }
}
