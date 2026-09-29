import assert from "node:assert/strict";
import test from "node:test";
import type { GitStatusResponse } from "@orquester/api";
import { GIT_WORKING_DIFF_DEFAULT_MAX_BYTES, GIT_WORKING_DIFF_MAX_BYTES } from "@orquester/api";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  GitError,
  GitService,
  GitWatcher,
  passesGitEventFilter,
  workingDiffMaxBytes
} from "./git";

const exec = promisify(execFile);

/** A throwaway directory (removed by the caller's finally) for real-fs cases. */
const tempDir = () => mkdtemp(join(tmpdir(), "orq-git-test-"));

/** A throwaway git repo with one commit; never the repo this code lives in. */
const tempRepo = async (): Promise<string> => {
  const dir = await tempDir();
  const git = (...args: string[]) =>
    exec("git", args, { cwd: dir, env: { ...process.env, HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null" } });
  await git("init", "-q", "-b", "main");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  await git("config", "commit.gpgsign", "false");
  await writeFile(join(dir, "kept.txt"), "one\n");
  await git("add", "-A");
  await git("commit", "-qm", "root");
  return dir;
};

/** A GitService whose git invocations are answered from a fixture map. */
const fakeGit = (
  reply: (args: string[]) => string | { stdout?: string; stderr?: string },
  calls: string[][] = []
) => {
  const git = new GitService({
    runner: async (_file, args) => {
      calls.push(args);
      const out = reply(args);
      return typeof out === "string" ? { stdout: out, stderr: "" } : { stdout: out.stdout ?? "", stderr: out.stderr ?? "" };
    }
  });
  return { git, calls };
};

const nul = (...records: string[]) => records.map((r) => `${r}\0`).join("");

type Deferred = {
  promise: Promise<{ stdout: string; stderr: string }>;
  resolve: () => void;
  reject: (error: Error) => void;
};

const deferred = (): Deferred => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<{ stdout: string; stderr: string }>((done, fail) => {
    resolve = () => done({ stdout: "", stderr: "" });
    reject = fail;
  });
  return { promise, resolve, reject };
};

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("serializes concurrent git mutations in the same repository", async () => {
  const calls: string[] = [];
  const commands = [deferred(), deferred()];
  const git = new GitService({
    runner: async (_file, args, options) => {
      calls.push(options.cwd);
      return commands[calls.length - 1].promise;
    }
  });

  const first = git.fetch("/repo");
  await nextTurn();
  const second = git.fetch("/repo");
  await nextTurn();

  assert.deepEqual(calls, ["/repo"]);

  commands[0].resolve();
  await first;
  await nextTurn();
  assert.deepEqual(calls, ["/repo", "/repo"]);

  commands[1].resolve();
  await second;
});

test("allows git mutations in different repositories to run concurrently", async () => {
  const calls: string[] = [];
  const commands = [deferred(), deferred()];
  const git = new GitService({
    runner: async (_file, _args, options) => {
      calls.push(options.cwd);
      return commands[calls.length - 1].promise;
    }
  });

  const first = git.fetch("/repo-a");
  const second = git.fetch("/repo-b");
  await nextTurn();

  assert.deepEqual(calls, ["/repo-a", "/repo-b"]);

  commands[0].resolve();
  commands[1].resolve();
  await Promise.all([first, second]);
});

test("continues a repository queue after an earlier mutation fails", async () => {
  const calls: string[] = [];
  const commands = [deferred(), deferred()];
  const git = new GitService({
    runner: async (_file, _args, options) => {
      calls.push(options.cwd);
      return commands[calls.length - 1].promise;
    }
  });

  const first = git.fetch("/repo");
  await nextTurn();
  const second = git.fetch("/repo");
  await nextTurn();

  commands[0].reject(Object.assign(new Error("fetch failed"), { stderr: "fetch failed" }));
  await assert.rejects(first, /fetch failed/);
  await nextTurn();
  assert.deepEqual(calls, ["/repo", "/repo"]);

  commands[1].resolve();
  await second;
});

test("discard touches only the requested paths, never the rest of the tree", async () => {
  const dir = await tempRepo();
  try {
    await writeFile(join(dir, "kept.txt"), "discard this edit\n");
    await writeFile(join(dir, "unrelated.txt"), "keep this work\n");
    await new GitService().discard(dir, ["kept.txt"]);
    assert.equal(await readFile(join(dir, "kept.txt"), "utf8"), "one\n");
    assert.equal(await readFile(join(dir, "unrelated.txt"), "utf8"), "keep this work\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("discard of a folder pathspec covers the entries beneath it", async () => {
  const dir = await tempRepo();
  try {
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src/a.txt"), "original\n");
    await exec("git", ["add", "src/a.txt"], { cwd: dir });
    await exec("git", ["commit", "-qm", "source"], { cwd: dir });
    await writeFile(join(dir, "src/a.txt"), "changed\n");
    await writeFile(join(dir, "src/new.txt"), "untracked\n");
    await writeFile(join(dir, "kept.txt"), "unrelated work\n");
    await new GitService().discard(dir, ["src/"]);
    assert.equal(await readFile(join(dir, "src/a.txt"), "utf8"), "original\n");
    await assert.rejects(stat(join(dir, "src/new.txt")), { code: "ENOENT" });
    assert.equal(await readFile(join(dir, "kept.txt"), "utf8"), "unrelated work\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("log carries parent hashes for the commit graph", async () => {
  const record = [
    "abc123", "abc12", "p1 p2", "Ann", "ann@example.com",
    "2026-01-01T00:00:00Z", "HEAD -> main, tag: v1", "subject", "body"
  ].join("\x1f");
  const { git } = fakeGit(() => `${record}\0`);
  const [entry] = await git.log("/repo", { limit: 1 });
  assert.deepEqual(entry.parents, ["p1", "p2"]);
  assert.deepEqual(entry.refs, ["main", "v1"]);
});

test("log reports a root commit as parentless, not as one empty parent", async () => {
  const record = ["abc", "ab", "", "A", "a@b", "d", "", "s", ""].join("\x1f");
  const { git } = fakeGit(() => `${record}\0`);
  assert.deepEqual((await git.log("/repo", {}))[0].parents, []);
});

test("branches derive ahead/behind from %(upstream:track)", async () => {
  const { git } = fakeGit((args) =>
    args[1] === "refs/heads" || args[2] === "refs/heads"
      ? "main\torigin/main\t*\t[ahead 2, behind 3]\nsolo\t\t\t\n"
      : "refs/remotes/origin/main\nrefs/remotes/origin/HEAD\n"
  );
  const { local, remote, current } = await git.branches("/repo");
  assert.equal(current, "main");
  assert.deepEqual(local, [
    { name: "main", current: true, ahead: 2, behind: 3, upstream: "origin/main" },
    { name: "solo", current: false, ahead: 0, behind: 0 }
  ]);
  assert.deepEqual(remote, ["origin/main"]);
});

test("commitDetail parses -z name-status/numstat rename records (old-then-new)", async () => {
  const { git } = fakeGit((args) => {
    if (args.includes("-s")) return ["sha", "shrt", "Ann", "a@b", "date", "subject", "body"].join("\x1f");
    if (args.includes("--name-status")) return nul("R100", "näme with ünicode.txt", "renamed ünicode.txt");
    if (args.includes("--numstat")) return nul("0\t0\t", "näme with ünicode.txt", "renamed ünicode.txt");
    return "";
  });
  const detail = await git.commitDetail("/repo", "sha");
  assert.deepEqual(detail.files, [
    {
      path: "renamed ünicode.txt",
      oldPath: "näme with ünicode.txt",
      status: "renamed",
      additions: 0,
      deletions: 0,
      binary: false
    }
  ]);
});

test("commitDetail marks git's '-' numstat pair as binary with zero counts", async () => {
  const { git } = fakeGit((args) => {
    if (args.includes("-s")) return ["sha", "shrt", "A", "a@b", "d", "s", ""].join("\x1f");
    if (args.includes("--name-status")) return nul("M", "logo.png");
    if (args.includes("--numstat")) return nul("-\t-\tlogo.png");
    return "";
  });
  const [file] = (await git.commitDetail("/repo", "sha")).files;
  assert.deepEqual([file.binary, file.additions, file.deletions], [true, 0, 0]);
});

test("stash list splits on the record separator and unwraps git's WIP subject", async () => {
  const records = [
    ["aaa", "WIP on main: 0a1afe4 pure rename", "2026-08-16T17:13:07+02:00"].join("\x1f"),
    ["bbb", "On feature: work in progress", "2026-08-15T09:00:00+02:00"].join("\x1f")
  ];
  const { git } = fakeGit((args) =>
    args[0] === "rev-parse" ? "true\n" : `${records.join("\x1e\n")}\x1e\n`
  );
  assert.deepEqual(await git.stashList("/repo"), [
    { index: 0, sha: "aaa", branch: "main", message: "0a1afe4 pure rename", date: "2026-08-16T17:13:07+02:00" },
    { index: 1, sha: "bbb", branch: "feature", message: "work in progress", date: "2026-08-15T09:00:00+02:00" }
  ]);
});

test("stash mutations reject invalid index or missing identity before invoking git", async () => {
  const { git, calls } = fakeGit(() => "");
  for (const index of [-1, 1.5]) {
    await assert.rejects(git.stashApply("/repo", index, "sha"), (error: unknown) =>
      error instanceof GitError && error.status === 400);
  }
  await assert.rejects(git.stashApply("/repo", 0, ""), (error: unknown) =>
    error instanceof GitError && error.status === 400);
  assert.equal(calls.length, 0);
});

test("a stash op refuses (409) when the index no longer resolves at all", async () => {
  const { git } = fakeGit((args) => {
    if (args[0] === "rev-parse") throw Object.assign(new Error("bad revision"), { code: 128 });
    return "";
  });
  await assert.rejects(git.stashDrop("/repo", 9, "old-sha"), (error: unknown) => {
    assert.equal((error as GitError).status, 409);
    return true;
  });
});

test("watcher polls only while subscribed, and only emits on a real change", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let files: string[] = [];
  const status = () => ({ isRepo: true, files: files.map((path) => ({ path })) }) as unknown as GitStatusResponse;
  let reads = 0;
  const git = { status: async () => { reads += 1; return status(); } } as unknown as GitService;

  const seen: string[][] = [];
  const watcher = new GitWatcher(git, (_path, s) => seen.push(s.files.map((f) => f.path)));
  t.after(() => watcher.stop());
  const settle = async () => { t.mock.timers.tick(2_000); await nextTurn(); };

  watcher.subscribe("/repo");
  watcher.subscribe("/repo"); // a second client shares the one loop
  await settle();
  assert.deepEqual(seen, [], "an unchanged repo stays silent (the first read only seeds)");

  files = ["a.txt"];
  await settle();
  assert.deepEqual(seen, [["a.txt"]], "one emit per actual change");
  await settle();
  assert.equal(seen.length, 1, "no repeat emits while the status holds still");

  watcher.unsubscribe("/repo");
  files = ["a.txt", "b.txt"];
  await settle();
  assert.equal(seen.length, 2, "one remaining subscriber keeps the loop alive");

  watcher.unsubscribe("/repo");
  const readsAtStop = reads;
  files = ["a.txt", "b.txt", "c.txt"];
  await settle();
  assert.equal(reads, readsAtStop, "the last unsubscribe stops polling entirely");
  assert.equal(seen.length, 2);
  watcher.stop();
});

test("the /events filter routes by event TYPE, not by a substring of the payload", () => {
  const event = (type: string, payload: unknown) =>
    JSON.stringify({ id: "1", channel: "projects", type, createdAt: "now", payload });

  const change = event("project.git.changed", { path: "/ws/proj", status: {} });
  assert.equal(passesGitEventFilter(change, "/ws/proj"), true, "the subscriber gets it");
  assert.equal(passesGitEventFilter(change, "/ws/other"), false, "another project's does not");
  assert.equal(passesGitEventFilter(change, null), false, "an unscoped stream does not");

  // The regression: an UNRELATED event whose payload merely quotes the literal.
  const echo = event("session.output", { data: 'grep \'"project.git.changed"\' index.ts' });
  assert.equal(passesGitEventFilter(echo, null), true, "must not be swallowed on a plain stream");
  assert.equal(passesGitEventFilter(echo, "/ws/proj"), true, "…nor on a scoped one");

  assert.equal(passesGitEventFilter(event("daemon.heartbeat", {}), null), true);
  assert.equal(passesGitEventFilter('{"project.git.changed" oops', null), true, "unparseable → deliver");
});

test("watcher ignores a lastFetched-only change (the background auto-fetch)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let lastFetched = "2026-08-16T10:00:00.000Z";
  const git = {
    status: async () =>
      ({ isRepo: true, files: [], lastFetched }) as unknown as GitStatusResponse
  } as unknown as GitService;
  const seen: number[] = [];
  const watcher = new GitWatcher(git, () => seen.push(1));
  t.after(() => watcher.stop());
  const settle = async () => { t.mock.timers.tick(2_000); await nextTurn(); };

  watcher.subscribe("/repo");
  await settle();
  lastFetched = "2026-08-16T10:01:00.000Z"; // a fetch touched .git/FETCH_HEAD
  await settle();
  assert.deepEqual(seen, [], "a new FETCH_HEAD mtime alone is not a working-tree change");
  watcher.stop();
});

// --- Untracked-diff synthesis: real filesystem, no repo mutation --------------

test("an untracked SYMLINK renders as its target string, never the target's bytes", async () => {
  const dir = await tempDir();
  try {
    const secret = join(dir, "secret.txt");
    await writeFile(secret, "TOP-SECRET-HOST-CONTENT\n");
    await symlink(secret, join(dir, "link.txt"));
    // `git diff` is empty for an untracked path; status reports it as "??".
    const { git } = fakeGit((args) => (args[0] === "status" ? nul("?? link.txt") : ""));

    const { diff, binary } = await git.diff(dir, "link.txt", {});
    assert.equal(binary, false);
    assert.match(diff, /new file mode 120000/, "a symlink is a 120000 blob, not a regular file");
    assert.match(diff, new RegExp(`\\+${secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    assert.doesNotMatch(diff, /TOP-SECRET-HOST-CONTENT/, "the link must never be followed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an untracked symlink to a host file outside the repo leaks nothing", async () => {
  const dir = await tempDir();
  try {
    // The reviewer's exact case: `ln -s /etc/hostname x` inside a project.
    await symlink("/etc/hostname", join(dir, "escape.txt"));
    const { git } = fakeGit((args) => (args[0] === "status" ? nul("?? escape.txt") : ""));
    const { diff } = await git.diff(dir, "escape.txt", {});
    assert.match(diff, /^\+\/etc\/hostname$/m, "only the link target STRING is shown");
    assert.equal(diff.split("\n").filter((l) => l.startsWith("+")).length, 2, "+++ header and one line");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an untracked file reached through a symlinked PARENT is refused", async () => {
  const outside = await tempDir();
  const dir = await tempDir();
  try {
    await writeFile(join(outside, "host.txt"), "OUTSIDE\n");
    await symlink(outside, join(dir, "elsewhere"));
    const { git } = fakeGit((args) => (args[0] === "status" ? nul("?? elsewhere/host.txt") : ""));
    const { diff } = await git.diff(dir, "elsewhere/host.txt", {});
    assert.equal(diff, "", "the realpath guard rejects a file outside the repo");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("an ordinary untracked file still renders as a new-file patch", async () => {
  const dir = await tempDir();
  try {
    await writeFile(join(dir, "new.txt"), "one\ntwo\n");
    const { git } = fakeGit((args) => (args[0] === "status" ? nul("?? new.txt") : ""));
    const { diff } = await git.diff(dir, "new.txt", {});
    assert.match(diff, /new file mode 100644/);
    assert.match(diff, /@@ -0,0 \+1,2 @@\n\+one\n\+two/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Discard: real git, in a throwaway repo -----------------------------------

test("discarding a rename restores BOTH halves (real git, throwaway repo)", async () => {
  const dir = await tempRepo();
  try {
    const git = new GitService();
    await exec("git", ["mv", "kept.txt", "moved.txt"], { cwd: dir });
    await writeFile(join(dir, "extra untracked.txt"), "junk\n");

    // The UI sends the path the changes list shows — the NEW one.
    await git.discard(dir, ["moved.txt", "extra untracked.txt"]);

    const { stdout } = await exec("git", ["status", "--porcelain"], { cwd: dir });
    assert.equal(stdout.trim(), "", `working tree should be clean, got:\n${stdout}`);
    const { stdout: files } = await exec("git", ["ls-files"], { cwd: dir });
    assert.equal(files.trim(), "kept.txt", "the rename's ORIGINAL path must come back");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a stash sha mismatch is a 409 against real git, and drops nothing", async () => {
  const dir = await tempRepo();
  try {
    const git = new GitService();
    await writeFile(join(dir, "kept.txt"), "changed\n");
    await git.stashCreate(dir, { message: "first" });
    const [stash] = await git.stashList(dir);

    await assert.rejects(git.stashDrop(dir, stash.index, `${"0".repeat(40)}`), (error: unknown) => {
      assert.equal((error as GitError).status, 409);
      return true;
    });
    assert.equal((await git.stashList(dir)).length, 1, "a stale drop must not destroy a stash");

    await git.stashDrop(dir, stash.index, stash.sha);
    assert.equal((await git.stashList(dir)).length, 0, "the matching sha still works");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Working diff (a saved prompt's {diff}) -------------------------------------

test("workingDiffMaxBytes parses an integer, defaults, and clamps", () => {
  assert.equal(workingDiffMaxBytes(undefined), 65_536);
  assert.equal(workingDiffMaxBytes(""), 65_536);
  assert.equal(workingDiffMaxBytes("lots"), 65_536);
  assert.equal(workingDiffMaxBytes(Number.NaN), 65_536);
  assert.equal(workingDiffMaxBytes("1000"), 1000);
  assert.equal(workingDiffMaxBytes("1000.9"), 1000);
  assert.equal(workingDiffMaxBytes(1000.9), 1000);
  assert.equal(workingDiffMaxBytes("0"), 1);
  assert.equal(workingDiffMaxBytes("-5"), 1);
  assert.equal(workingDiffMaxBytes(String(524_288 + 1)), 524_288);
  assert.equal(workingDiffMaxBytes(Number.POSITIVE_INFINITY), 524_288);
});

test("an overflow on a read that did not ask for a cap is still an error", async () => {
  const git = new GitService({
    runner: async (_file, args) => {
      if (args[0] === "rev-parse") return { stdout: "true\n", stderr: "" };
      throw Object.assign(new Error("stdout maxBuffer length exceeded"), {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        stdout: "partial",
        stderr: ""
      });
    }
  });
  await assert.rejects(git.status("/repo"), (error: unknown) => {
    assert.ok(error instanceof GitError, `expected a GitError, got ${String(error)}`);
    return true;
  });
});

test("working diff of a directory that is not a repo is isRepo:false, never an error", async (t) => {
  const dir = await tempDir();
  try {
    const inside = await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir }).then(
      () => true,
      () => false
    );
    if (inside) {
      t.skip("the temp dir is itself inside a git work tree on this machine");
      return;
    }
    assert.deepEqual(await new GitService().workingDiff(dir, GIT_WORKING_DIFF_DEFAULT_MAX_BYTES), {
      isRepo: false,
      diff: "",
      truncated: false,
      untracked: []
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("working diff of a clean repo is an empty patch with nothing untracked", async () => {
  const dir = await tempRepo();
  try {
    assert.deepEqual(await new GitService().workingDiff(dir, GIT_WORKING_DIFF_DEFAULT_MAX_BYTES), {
      isRepo: true,
      diff: "",
      truncated: false,
      untracked: []
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("working diff: staged and unstaged changes in ONE patch against HEAD; untracked files listed, not patched", async () => {
  const dir = await tempRepo();
  try {
    const git = (...args: string[]) => exec("git", args, { cwd: dir });
    await writeFile(join(dir, "gone.txt"), "doomed\n");
    await git("add", "gone.txt");
    await git("commit", "-qm", "second");

    await writeFile(join(dir, "kept.txt"), "one\nunstaged edit\n"); // unstaged
    await git("rm", "-q", "gone.txt"); // staged deletion
    await writeFile(join(dir, "staged.txt"), "brand new\n");
    await git("add", "staged.txt"); // staged add…
    await writeFile(join(dir, "staged.txt"), "brand new\nedited after staging\n"); // …then edited again
    await mkdir(join(dir, "notes"));
    await writeFile(join(dir, "notes", "todo.md"), "untracked\n");
    await writeFile(join(dir, ".gitignore"), "*.log\n");
    await writeFile(join(dir, "debug.log"), "ignored\n");

    const result = await new GitService().workingDiff(dir, GIT_WORKING_DIFF_DEFAULT_MAX_BYTES);
    assert.equal(result.isRepo, true);
    assert.equal(result.truncated, false);
    assert.match(result.diff, /^diff --git a\/kept\.txt b\/kept\.txt$/m);
    assert.match(result.diff, /^\+unstaged edit$/m);
    assert.match(result.diff, /^deleted file mode 100644$/m);
    assert.match(result.diff, /^-doomed$/m);
    // One entry for staged.txt, carrying the working tree's content — staged and
    // unstaged together, never twice.
    assert.equal(result.diff.match(/^diff --git a\/staged\.txt b\/staged\.txt$/gm)?.length, 1);
    assert.match(result.diff, /^@@ -0,0 \+1,2 @@\n\+brand new\n\+edited after staging$/m);
    assert.doesNotMatch(result.diff, /todo\.md|debug\.log/, "untracked files are listed, not patched");
    assert.deepEqual([...result.untracked].sort(), [".gitignore", "notes/todo.md"], "ignored files are left out");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("working diff before the first commit is against the empty tree", async () => {
  const dir = await tempDir();
  try {
    const git = (...args: string[]) =>
      exec("git", args, { cwd: dir, env: { ...process.env, HOME: dir, GIT_CONFIG_GLOBAL: "/dev/null" } });
    await git("init", "-q", "-b", "main");
    await writeFile(join(dir, "a.txt"), "one\n");
    await git("add", "a.txt");
    await writeFile(join(dir, "a.txt"), "one\ntwo\n");
    await writeFile(join(dir, "b.txt"), "not added\n");

    const result = await new GitService().workingDiff(dir, GIT_WORKING_DIFF_DEFAULT_MAX_BYTES);
    assert.equal(result.isRepo, true);
    assert.equal(result.truncated, false);
    assert.match(result.diff, /^diff --git a\/a\.txt b\/a\.txt\nnew file mode 100644$/m);
    assert.match(result.diff, /^@@ -0,0 \+1,2 @@\n\+one\n\+two$/m, "the working tree's content, whole");
    assert.deepEqual(result.untracked, ["b.txt"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("working diff cuts a long patch at the last whole line within maxBytes, never mid-character", async () => {
  const dir = await tempRepo();
  try {
    // Multi-byte text, so a plain byte cut would land inside a character.
    const lines = Array.from({ length: 400 }, (_, i) => `línea ${i} — ünïcödé ✓`);
    await writeFile(join(dir, "kept.txt"), `${lines.join("\n")}\n`);
    const git = new GitService();
    const whole = await git.workingDiff(dir, GIT_WORKING_DIFF_MAX_BYTES);
    assert.equal(whole.truncated, false);
    const wholeBytes = Buffer.byteLength(whole.diff);

    for (const maxBytes of [1, 1000, 1001, 1002, 1003, 4096, wholeBytes - 1]) {
      const cut = await git.workingDiff(dir, maxBytes);
      assert.equal(cut.truncated, true, `${maxBytes}: truncated`);
      assert.ok(Buffer.byteLength(cut.diff) <= maxBytes, `${maxBytes}: within the cap`);
      assert.ok(whole.diff.startsWith(cut.diff), `${maxBytes}: a prefix of the whole patch`);
      assert.ok(cut.diff === "" || cut.diff.endsWith("\n"), `${maxBytes}: ends on a line boundary`);
      assert.ok(!cut.diff.includes("�"), `${maxBytes}: no broken character`);
      // Nothing that would have fit was left out: the next line would not have.
      const next = whole.diff.slice(cut.diff.length).split("\n")[0] ?? "";
      assert.ok(Buffer.byteLength(cut.diff) + Buffer.byteLength(next) + 1 > maxBytes, `${maxBytes}: kept all that fits`);
    }
    // Exactly its own size fits whole.
    assert.deepEqual(await git.workingDiff(dir, wholeBytes), whole);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("working diff stops git once a huge patch has written enough, and still cuts cleanly", async () => {
  const dir = await tempRepo();
  try {
    // Well past the read floor (default cap + 1), so node really does kill git.
    const big = Array.from({ length: 12_000 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
    await writeFile(join(dir, "kept.txt"), `${big}\n`);
    const git = new GitService();
    const whole = await git.workingDiff(dir, GIT_WORKING_DIFF_MAX_BYTES);
    assert.ok(Buffer.byteLength(whole.diff) > GIT_WORKING_DIFF_DEFAULT_MAX_BYTES * 2, "the fixture is big enough");

    const cut = await git.workingDiff(dir, 10_000);
    assert.equal(cut.truncated, true);
    assert.ok(Buffer.byteLength(cut.diff) <= 10_000);
    assert.ok(cut.diff.endsWith("\n"));
    assert.ok(whole.diff.startsWith(cut.diff), "a clean prefix of the whole patch");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("working diff of a project inside a larger checkout stays within the project", async () => {
  const dir = await tempRepo();
  try {
    const git = (...args: string[]) => exec("git", args, { cwd: dir });
    await mkdir(join(dir, "site"));
    await writeFile(join(dir, "site", "page.txt"), "v1\n");
    await git("add", "site/page.txt");
    await git("commit", "-qm", "site");

    await writeFile(join(dir, "kept.txt"), "outside the project\n");
    await writeFile(join(dir, "stray.txt"), "untracked, outside\n");
    await writeFile(join(dir, "site", "page.txt"), "v2\n");
    await writeFile(join(dir, "site", "new.txt"), "untracked, inside\n");

    const result = await new GitService().workingDiff(join(dir, "site"), GIT_WORKING_DIFF_DEFAULT_MAX_BYTES);
    assert.match(result.diff, /^diff --git a\/site\/page\.txt b\/site\/page\.txt$/m, "paths stay repo-relative");
    assert.doesNotMatch(result.diff, /kept\.txt|outside the project/, "nothing outside the project");
    assert.deepEqual(result.untracked, ["site/new.txt"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("working diff ignores the user's own diff config: no quoting, a/ b/ prefixes, repo-relative paths", async () => {
  const dir = await tempRepo();
  try {
    const git = (...args: string[]) => exec("git", args, { cwd: dir });
    await mkdir(join(dir, "site"));
    await writeFile(join(dir, "site", "naïve-café.txt"), "v1\n");
    await git("add", "-A");
    await git("commit", "-qm", "site");
    // Every setting that reshapes a patch's headers, set the hostile way.
    for (const [key, value] of [
      ["core.quotePath", "true"],
      ["diff.noprefix", "true"],
      ["diff.mnemonicPrefix", "true"],
      ["diff.relative", "true"]
    ]) {
      await git("config", key, value);
    }
    await writeFile(join(dir, "site", "naïve-café.txt"), "v2\n");
    await writeFile(join(dir, "site", "新しい.txt"), "untracked\n");

    const result = await new GitService().workingDiff(join(dir, "site"), GIT_WORKING_DIFF_DEFAULT_MAX_BYTES);
    assert.match(result.diff, /^diff --git a\/site\/naïve-café\.txt b\/site\/naïve-café\.txt$/m);
    assert.match(result.diff, /^--- a\/site\/naïve-café\.txt\n\+\+\+ b\/site\/naïve-café\.txt$/m);
    assert.doesNotMatch(result.diff, /\\303/, "no C-quoted bytes");
    assert.deepEqual(result.untracked, ["site/新しい.txt"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
