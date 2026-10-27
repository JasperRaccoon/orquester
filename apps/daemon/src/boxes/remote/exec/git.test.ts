import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { GitStatusResponse } from "@orquester/api";

import { GitError, GitService, GitWatcher } from "../../../git.ts";
import type { BoxExecOptions } from "../../contracts.ts";
import { localBoxConnection, type LocalBoxConnection } from "../../testing.ts";
import { createBoxGitRouteResolver } from "./git.ts";
import { boxRecord, fakeBoxes } from "./testing.ts";

const exec = promisify(execFile);

interface Fixture {
  root: string;
  project: string;
  bare: string;
  boxHome: string;
  connection: LocalBoxConnection;
  execs: BoxExecOptions[];
  git: GitService;
  boxes: ReturnType<typeof fakeBoxes>;
}

/**
 * A "box" project: a repo with one commit and an `origin` bare remote. The box
 * user's HOME holds the identity (as the box setup writes it), and the host
 * process env has none — so a commit that succeeds proves git ran with the
 * box's HOME.
 */
async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "orq-box-git-"));
  const project = join(root, "ws", "app");
  const bare = join(root, "origin.git");
  const boxHome = join(root, "box-home");
  await mkdir(project, { recursive: true });
  await mkdir(boxHome);
  await writeFile(join(boxHome, ".gitconfig"), "[user]\n\tname = Box User\n\temail = box@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n");
  const env = { ...process.env, HOME: boxHome, GIT_CONFIG_NOSYSTEM: "1" };
  await exec("git", ["init", "-q", "--bare", "-b", "main", bare], { env });
  await exec("git", ["init", "-q", "-b", "main"], { cwd: project, env });
  await writeFile(join(project, "kept.txt"), "one\n");
  await exec("git", ["add", "-A"], { cwd: project, env });
  await exec("git", ["commit", "-qm", "root"], { cwd: project, env });
  await exec("git", ["remote", "add", "origin", bare], { cwd: project, env });
  await exec("git", ["push", "-q", "-u", "origin", "main"], { cwd: project, env });

  const connection = localBoxConnection({ boxId: "box-1", sys: { home: boxHome } });
  const execs: BoxExecOptions[] = [];
  const localExec = connection.exec;
  connection.exec = (options: BoxExecOptions) => {
    execs.push(options);
    return localExec(options);
  };
  const boxes = fakeBoxes();
  boxes.add(boxRecord("box-1", { project: { workspace: "ws", name: "app", path: project } }), connection);
  const git = new GitService({
    // The host runner must never be used for the box project.
    runner: async () => {
      throw new Error("host git ran for a box project");
    },
    route: createBoxGitRouteResolver(boxes.registry)
  });
  return { root, project, bare, boxHome, connection, execs, git, boxes };
}

test("status, diff, stage, commit, log and push run in the box with the box's HOME and git auth env", async () => {
  const f = await fixture();
  try {
    const monitor = join(f.project, ".git", "fsmonitor");
    const monitorRan = join(f.project, ".git", "fsmonitor-ran");
    const hookRan = join(f.project, ".git", "hook-ran");
    await writeFile(monitor, "#!/bin/sh\nprintf invoked > .git/fsmonitor-ran\n", { mode: 0o755 });
    await writeFile(join(f.project, ".git", "hooks", "pre-commit"), "#!/bin/sh\nprintf invoked > .git/hook-ran\n", { mode: 0o755 });
    await exec("git", ["config", "core.fsmonitor", monitor], { cwd: f.project });
    // A native positive control proves this repository's monitor really would execute.
    await exec("git", ["status", "--porcelain"], { cwd: f.project });
    assert.equal(await readFile(monitorRan, "utf8"), "invoked");
    await rm(monitorRan);
    await writeFile(join(f.project, "kept.txt"), "one\ntwo\n");
    await writeFile(join(f.project, "new.txt"), "fresh\n");

    const status = await f.git.status(f.project);
    assert.equal(status.isRepo, true);
    assert.equal(status.branch, "main");
    assert.equal(status.upstream, "origin/main");
    assert.deepEqual(
      status.files.map((file) => [file.path, file.status]).sort(),
      [
        ["kept.txt", "modified"],
        ["new.txt", "untracked"]
      ]
    );

    const modified = await f.git.diff(f.project, "kept.txt", {});
    assert.match(modified.diff, /^\+two$/m);
    // An untracked file's synthesized patch is read through the box's file channel.
    const untracked = await f.git.diff(f.project, "new.txt", {});
    assert.match(untracked.diff, /new file mode 100644/);
    assert.match(untracked.diff, /^\+fresh$/m);
    assert.ok(f.connection.calls.some((call) => call.method === "fs.realpath"));

    await f.git.stage(f.project, []);
    const committed = await f.git.commit(f.project, "box commit", "made in the box");
    assert.equal(committed.ok, true);
    const log = await f.git.log(f.project, { limit: 5 });
    assert.equal(log[0]?.subject, "box commit");
    assert.equal(log[0]?.authorName, "Box User");
    assert.equal(log.length, 2);

    const pushed = await f.git.push(f.project);
    assert.equal(pushed.ok, true);
    const remoteHead = (await exec("git", ["rev-parse", "main"], { cwd: f.bare })).stdout.trim();
    assert.equal(remoteHead, log[0]?.sha);

    const fetched = await f.git.fetch(f.project);
    assert.equal(fetched.ok, true);
    // FETCH_HEAD's mtime comes from the box's fs.stat.
    assert.ok((await f.git.status(f.project)).lastFetched);

    // Every git ran through the box connection, in the project dir, with the box env only.
    const gitExecs = f.execs.filter((e) => e.command === "git");
    assert.ok(gitExecs.length > 5);
    for (const e of gitExecs) {
      assert.equal(e.cwd, f.project);
      assert.equal(e.env?.HOME, f.boxHome);
      // No credential helper (a box never gets a token) and no GIT_SSH_COMMAND over the box's pinned config.
      assert.equal(e.env?.GIT_CONFIG_COUNT, undefined);
      assert.equal(e.env?.GIT_SSH_COMMAND, undefined);
      assert.equal(e.env?.PATH, undefined, "the host env is never passed");
    }
    // Reading a box repo never executes its monitor; a deliberate commit keeps its own hook.
    await assert.rejects(readFile(monitorRan), { code: "ENOENT" });
    assert.equal(await readFile(hookRan, "utf8"), "invoked");
    const pushExec = gitExecs.find((e) => e.args?.[2] === "push");
    assert.equal(pushExec?.env?.GIT_TERMINAL_PROMPT, "0");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("an untracked symlink is rendered from its target, read in the box", async () => {
  const f = await fixture();
  try {
    await symlink("/etc/hostname", join(f.project, "link"));
    const diff = await f.git.diff(f.project, "link", {});
    assert.match(diff.diff, /new file mode 120000/);
    assert.match(diff.diff, /^\+\/etc\/hostname$/m);
    assert.ok(f.execs.some((e) => e.command === "readlink"));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a box that is not connected is a 409 BOX_NOT_READY GitError; host projects keep the host runner", async () => {
  const f = await fixture();
  try {
    f.connection.setConnected(false);
    await assert.rejects(f.git.status(f.project), (error: unknown) => {
      assert.ok(error instanceof GitError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "BOX_NOT_READY");
      return true;
    });
    const hostCalls: string[][] = [];
    const host = new GitService({
      runner: async (_file, args) => {
        hostCalls.push(args);
        return { stdout: "true\n", stderr: "" };
      },
      route: createBoxGitRouteResolver(f.boxes.registry)
    });
    assert.equal(await host.isRepo(join(f.root, "elsewhere")), true);
    assert.deepEqual(hostCalls, [["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "rev-parse", "--is-inside-work-tree"]]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("the watcher's polling reads status in the box and announces a change", async (t) => {
  const f = await fixture();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let resolveChange!: (status: GitStatusResponse) => void;
    const changed = new Promise<GitStatusResponse>((resolve) => (resolveChange = resolve));
    let firstRead!: () => void;
    const baselineRead = new Promise<void>((resolve) => (firstRead = resolve));
    let polls = 0;
    const counting = new GitService({ route: createBoxGitRouteResolver(f.boxes.registry) });
    const watcher = new GitWatcher(
      {
        status: async (path: string) => {
          polls += 1;
          const status = await counting.status(path);
          // Change the tree right after the first (baseline) read.
          if (polls === 1) {
            await writeFile(join(f.project, "later.txt"), "x\n");
            firstRead();
          }
          return status;
        }
      } as unknown as GitService,
      (_path, status) => resolveChange(status)
    );
    watcher.subscribe(f.project);
    try {
      await baselineRead;
      // Let the completed baseline poll schedule its next interval before advancing it.
      await new Promise<void>((resolve) => setImmediate(resolve));
      t.mock.timers.tick(2_000);
      const status = await changed;
      assert.ok(status.files.some((file) => file.path === "later.txt"));
      assert.ok(f.execs.some((e) => e.command === "git" && e.args?.includes("status")));
    } finally {
      watcher.stop();
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
