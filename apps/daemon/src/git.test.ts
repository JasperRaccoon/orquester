import assert from "node:assert/strict";
import test from "node:test";
import type { GitStatusResponse } from "@orquester/api";
import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { GitError, GitService, GitWatcher, passesGitEventFilter } from "./git";

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
      calls.push(`${options.cwd}:${args.join(" ")}`);
      return commands[calls.length - 1].promise;
    }
  });

  const first = git.fetch("/repo");
  await nextTurn();
  const second = git.fetch("/repo");
  await nextTurn();

  assert.deepEqual(calls, ["/repo:fetch --all --prune"]);

  commands[0].resolve();
  await first;
  await nextTurn();
  assert.deepEqual(calls, [
    "/repo:fetch --all --prune",
    "/repo:fetch --all --prune"
  ]);

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

test("pull fetches all remotes before merging the upstream branch", async () => {
  const calls: string[] = [];
  const commands = [deferred(), deferred()];
  const git = new GitService({
    runner: async (_file, args) => {
      calls.push(args.join(" "));
      return commands[calls.length - 1].promise;
    }
  });

  const pull = git.pull("/repo");
  await nextTurn();
  assert.deepEqual(calls, ["fetch --all --prune"]);

  commands[0].resolve();
  await nextTurn();
  assert.deepEqual(calls, ["fetch --all --prune", "merge --no-edit @{upstream}"]);

  commands[1].resolve();
  await pull;
});

test("discard splits tracked and untracked pathspecs into separate commands", async () => {
  // `git restore` aborts the WHOLE invocation on one unknown pathspec, so a
  // mixed list must never reach it as a single call.
  const { git, calls } = fakeGit((args) =>
    args[0] === "status" ? nul("?? un tracked.txt", " M tracked file.txt", "A  staged new.txt") : ""
  );

  await git.discard("/repo", ["tracked file.txt", "un tracked.txt", "staged new.txt"]);

  assert.deepEqual(calls, [
    // Unscoped on purpose (rename detection is pathspec-limited); filtered here.
    ["status", "--porcelain=v1", "-z"],
    ["restore", "--staged", "--worktree", "--", "tracked file.txt", "staged new.txt"],
    ["clean", "-fd", "--", "un tracked.txt"]
  ]);
});

test("discard touches only the requested paths, never the rest of the tree", async () => {
  const { git, calls } = fakeGit((args) =>
    args[0] === "status" ? nul(" M asked.txt", " M untouched.txt", "?? other.txt") : ""
  );
  await git.discard("/repo", ["asked.txt"]);
  assert.deepEqual(calls, [
    ["status", "--porcelain=v1", "-z"],
    ["restore", "--staged", "--worktree", "--", "asked.txt"]
  ]);
});

test("discard of a folder pathspec covers the entries beneath it", async () => {
  const { git, calls } = fakeGit((args) =>
    args[0] === "status" ? nul(" M src/a.txt", "?? src/new.txt", " M other/b.txt") : ""
  );
  await git.discard("/repo", ["src/"]);
  assert.deepEqual(calls.slice(1), [
    ["restore", "--staged", "--worktree", "--", "src/a.txt"],
    ["clean", "-fd", "--", "src/new.txt"]
  ]);
});

test("discard skips a command entirely when its side of the split is empty", async () => {
  const { git, calls } = fakeGit((args) => (args[0] === "status" ? nul("?? only-untracked.txt") : ""));
  await git.discard("/repo", ["only-untracked.txt"]);
  assert.deepEqual(calls.map((c) => c[0]), ["status", "clean"]);
});

test("discarding a rename restores both the new AND the original path", async () => {
  // porcelain v1 -z emits NEW then OLD for a rename, as one record. Restoring
  // only the new path leaves the original staged-deleted and gone from the
  // worktree — a discard that half-reverts.
  const { git, calls } = fakeGit((args) => (args[0] === "status" ? nul("R  new.txt", "old.txt") : ""));
  await git.discard("/repo", ["new.txt"]);
  assert.deepEqual(calls[1], ["restore", "--staged", "--worktree", "--", "new.txt", "old.txt"]);

  // …and naming the ORIGINAL path (a stale list, or the History pane) works too.
  const second = fakeGit((args) => (args[0] === "status" ? nul("R  new.txt", "old.txt") : ""));
  await second.git.discard("/repo", ["old.txt"]);
  assert.deepEqual(second.calls[1], ["restore", "--staged", "--worktree", "--", "new.txt", "old.txt"]);
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

test("stash mutations build the stash@{n} ref themselves and reject a bad index", async () => {
  const { git, calls } = fakeGit((args) => (args[0] === "rev-parse" ? "sha-at-that-slot\n" : ""));
  await git.stashApply("/repo", 2, "sha-at-that-slot");
  await git.stashPop("/repo", 0, "sha-at-that-slot");
  await git.stashDrop("/repo", 1, "sha-at-that-slot");
  await git.stashCreate("/repo", { message: "  wip  ", includeUntracked: true });
  await git.stashCreate("/repo", { message: "   " });
  assert.deepEqual(calls, [
    ["rev-parse", "--verify", "--quiet", "stash@{2}^{commit}"],
    ["stash", "apply", "stash@{2}"],
    ["rev-parse", "--verify", "--quiet", "stash@{0}^{commit}"],
    ["stash", "pop", "stash@{0}"],
    ["rev-parse", "--verify", "--quiet", "stash@{1}^{commit}"],
    ["stash", "drop", "stash@{1}"],
    ["stash", "push", "--include-untracked", "-m", "wip"],
    ["stash", "push"]
  ]);
  await assert.rejects(git.stashApply("/repo", -1, "sha"), /stash index/);
  await assert.rejects(git.stashApply("/repo", 1.5, "sha"), /stash index/);
  await assert.rejects(git.stashApply("/repo", 0, ""), /stash sha/);
});

test("a stash op refuses (409) when the list shifted under the client", async () => {
  // The client asks to drop stash@{1} it saw as "old-sha"; the slot now holds a
  // different commit because someone else pushed/dropped a stash meanwhile.
  const { git, calls } = fakeGit((args) => (args[0] === "rev-parse" ? "someone-elses-sha\n" : ""));
  await assert.rejects(git.stashDrop("/repo", 1, "old-sha"), (error: unknown) => {
    assert.equal((error as GitError).status, 409);
    return true;
  });
  assert.deepEqual(
    calls.map((c) => c[0]),
    ["rev-parse"],
    "the destructive command must never run after a mismatch"
  );
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

test("watcher polls only while subscribed, and only emits on a real change", async () => {
  let files: string[] = [];
  const status = () => ({ isRepo: true, files: files.map((path) => ({ path })) }) as unknown as GitStatusResponse;
  let reads = 0;
  const git = { status: async () => { reads += 1; return status(); } } as unknown as GitService;

  const seen: string[][] = [];
  const watcher = new GitWatcher(git, (_path, s) => seen.push(s.files.map((f) => f.path)), 5);
  const settle = () => new Promise((r) => setTimeout(r, 40));

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

test("watcher re-seeds after a failed read so recovery emits", async () => {
  let fail = false;
  const git = {
    status: async () => {
      if (fail) throw new Error("not a repo");
      return { isRepo: true, files: [] } as unknown as GitStatusResponse;
    }
  } as unknown as GitService;
  const seen: number[] = [];
  const watcher = new GitWatcher(git, () => seen.push(1), 5);
  const settle = () => new Promise((r) => setTimeout(r, 40));

  watcher.subscribe("/repo");
  await settle();
  fail = true;
  await settle();
  fail = false;
  await settle();
  assert.deepEqual(seen, [], "an unchanged status across a failure window is not an event");
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

test("watcher ignores a lastFetched-only change (the background auto-fetch)", async () => {
  let lastFetched = "2026-08-16T10:00:00.000Z";
  const git = {
    status: async () =>
      ({ isRepo: true, files: [], lastFetched }) as unknown as GitStatusResponse
  } as unknown as GitService;
  const seen: number[] = [];
  const watcher = new GitWatcher(git, () => seen.push(1), 5);
  const settle = () => new Promise((r) => setTimeout(r, 40));

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
