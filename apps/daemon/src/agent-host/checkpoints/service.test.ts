/**
 * Checkpoint service tests against REAL temporary git repositories.
 *
 * Every assertion here is about what git actually did — the captured tree, the
 * refs that exist, and, above all, what the user's repository looks like
 * afterwards (§5.4: nothing touches the index, HEAD, a branch, the stash or
 * the visible reflog).
 */

import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Checkpoint } from "@orquester/api/agent-chat";

import type { CheckpointService } from "../services.ts";
import { checkpointRefForThreadTurn, checkpointRefNamespace } from "./refs.ts";
import {
  CHECKPOINT_REF_LIMIT,
  CheckpointRefUnavailableError,
  CheckpointRollbackUnsupportedError,
  CheckpointTurnRangeError,
  createCheckpointService
} from "./service.ts";
import {
  createTempRepo,
  refNames,
  snapshotUserGitState,
  treePaths,
  type TempRepo
} from "./test-support.ts";

const THREAD = "thread-alpha";

function serviceFor(repo: TempRepo): CheckpointService {
  return createCheckpointService({ gitEnv: repo.gitEnv });
}

/** A repo with one commit, a staged file, an untracked file and an ignored file. */
async function seededRepo(): Promise<TempRepo> {
  const repo = await createTempRepo();
  await repo.write(".gitignore", "ignored.log\n");
  await repo.write("tracked.txt", "one\n");
  await repo.git("add", ".gitignore", "tracked.txt");
  await repo.git("commit", "-qm", "initial");
  await repo.write("staged.txt", "staged\n");
  await repo.git("add", "staged.txt");
  await repo.write("untracked.txt", "untracked\n");
  await repo.write("ignored.log", "noise\n");
  return repo;
}

test("captures tracked, staged and untracked files and never an ignored one", async (t) => {
  const repo = await seededRepo();
  t.after(() => repo.cleanup());

  const service = serviceFor(repo);
  const result = await service.captureBaseline({ threadId: THREAD, cwd: repo.dir });

  assert.ok(result, "a git project captures a baseline");
  assert.equal(result.turnCount, 0);
  assert.equal(result.status, "ready");
  assert.equal(result.ref, checkpointRefForThreadTurn(THREAD, 0));
  assert.deepEqual(await treePaths(repo, result.ref), [
    ".gitignore",
    "staged.txt",
    "tracked.txt",
    "untracked.txt"
  ]);
});

test("the user's index, HEAD, refs, stash and reflog are byte-identical afterwards", async (t) => {
  const repo = await seededRepo();
  t.after(() => repo.cleanup());

  // A stash and a second branch, so there is something to destroy.
  await repo.write("tracked.txt", "one\ntwo\n");
  await repo.git("stash", "push", "-q", "-m", "user stash");
  await repo.git("branch", "feature");

  const before = await snapshotUserGitState(repo);
  const service = serviceFor(repo);
  await service.captureBaseline({ threadId: THREAD, cwd: repo.dir });
  await service.captureTurnEnd({
    threadId: THREAD,
    cwd: repo.dir,
    turnId: "turn-1",
    assistantMessageId: "msg-1"
  });
  const after = await snapshotUserGitState(repo);

  assert.equal(after.indexSha, before.indexSha, "the user's index was not rewritten");
  assert.equal(after.head, before.head);
  assert.equal(after.stashes, before.stashes);
  assert.equal(after.status, before.status);
  assert.equal(after.headReflog, before.headReflog);
  // The only new refs are ours.
  const newRefs = after.branches
    .split("\n")
    .filter((line) => line.length > 0 && !before.branches.includes(line));
  assert.ok(newRefs.length > 0);
  for (const line of newRefs) {
    assert.ok(line.startsWith(checkpointRefNamespace(THREAD)), `unexpected new ref: ${line}`);
  }
  // …and the checkpoint namespace has no reflog of its own.
  const logs = await repo
    .gitReadOnly("reflog", "show", checkpointRefForThreadTurn(THREAD, 0))
    .catch(() => "");
  assert.equal(logs.trim(), "");
});

test("turn end diffs against the baseline and reports the changed files", async (t) => {
  const repo = await seededRepo();
  t.after(() => repo.cleanup());
  const service = serviceFor(repo);

  await service.captureBaseline({ threadId: THREAD, cwd: repo.dir });
  await repo.write("tracked.txt", "one\ntwo\nthree\n");
  await repo.write("created.txt", "new\n");
  await rm(join(repo.dir, "untracked.txt"));

  const summary = await service.captureTurnEnd({
    threadId: THREAD,
    cwd: repo.dir,
    turnId: "turn-1",
    assistantMessageId: "msg-1"
  });

  assert.ok(summary);
  assert.equal(summary.turnCount, 1);
  assert.equal(summary.status, "ready");
  assert.equal(summary.turnId, "turn-1");
  assert.equal(summary.assistantMessageId, "msg-1");
  assert.equal(summary.detail, undefined);
  assert.ok(Date.parse(summary.completedAt) > 0);
  assert.deepEqual(
    summary.files.map((file) => file.path).sort(),
    ["created.txt", "tracked.txt", "untracked.txt"]
  );
  const tracked = summary.files.find((file) => file.path === "tracked.txt");
  assert.deepEqual(tracked, { path: "tracked.txt", additions: 2, deletions: 0 });
  const removed = summary.files.find((file) => file.path === "untracked.txt");
  assert.deepEqual(removed, { path: "untracked.txt", additions: 0, deletions: 1 });
});

test("a missing baseline keeps the post ref and records an empty file list", async (t) => {
  const repo = await seededRepo();
  t.after(() => repo.cleanup());
  const service = serviceFor(repo);

  // No captureBaseline: git was "initialised during the turn".
  const summary = await service.captureTurnEnd({
    threadId: THREAD,
    cwd: repo.dir,
    turnId: "turn-1",
    assistantMessageId: null
  });

  assert.ok(summary);
  assert.equal(summary.turnCount, 1);
  assert.equal(summary.status, "ready");
  assert.deepEqual(summary.files, []);
  assert.deepEqual(await refNames(repo, checkpointRefNamespace(THREAD)), [
    checkpointRefForThreadTurn(THREAD, 1)
  ]);
});

test("a baseline is idempotent: the second call captures nothing", async (t) => {
  const repo = await seededRepo();
  t.after(() => repo.cleanup());
  const service = serviceFor(repo);

  const first = await service.captureBaseline({ threadId: THREAD, cwd: repo.dir });
  assert.ok(first);
  const firstCommit = (await repo.gitReadOnly("rev-parse", first.ref)).trim();

  await repo.write("tracked.txt", "changed after the baseline\n");
  const second = await service.captureBaseline({ threadId: THREAD, cwd: repo.dir });

  assert.equal(second, null, "an existing baseline is never recaptured");
  assert.equal((await repo.gitReadOnly("rev-parse", first.ref)).trim(), firstCommit);
});

test("a placeholder checkpoint is reused at its own turn count", async (t) => {
  const repo = await seededRepo();
  t.after(() => repo.cleanup());
  const service = serviceFor(repo);
  await service.captureBaseline({ threadId: THREAD, cwd: repo.dir });

  const placeholder: Checkpoint = {
    turnId: "turn-1",
    checkpointTurnCount: 1,
    checkpointRef: checkpointRefForThreadTurn(THREAD, 1),
    status: "missing",
    files: [],
    assistantMessageId: "msg-placeholder",
    completedAt: new Date(0).toISOString()
  };

  await repo.write("tracked.txt", "one\ntwo\n");
  const summary = await service.captureTurnEnd({
    threadId: THREAD,
    cwd: repo.dir,
    turnId: "turn-1",
    assistantMessageId: null,
    checkpoints: [placeholder]
  });

  assert.ok(summary);
  assert.equal(summary.turnCount, 1, "reused, not incremented past");
  assert.equal(summary.assistantMessageId, "msg-placeholder");
  assert.deepEqual(summary.files.map((file) => file.path), ["tracked.txt"]);
});

test("a turn that already has a real checkpoint is skipped", async (t) => {
  const repo = await seededRepo();
  t.after(() => repo.cleanup());
  const service = serviceFor(repo);
  await service.captureBaseline({ threadId: THREAD, cwd: repo.dir });

  const captured: Checkpoint = {
    turnId: "turn-1",
    checkpointTurnCount: 1,
    checkpointRef: checkpointRefForThreadTurn(THREAD, 1),
    status: "ready",
    files: [],
    assistantMessageId: "msg-1",
    completedAt: new Date(0).toISOString()
  };

  const summary = await service.captureTurnEnd({
    threadId: THREAD,
    cwd: repo.dir,
    turnId: "turn-1",
    assistantMessageId: null,
    checkpoints: [captured]
  });

  assert.equal(summary, null);
  assert.deepEqual(await refNames(repo, checkpointRefNamespace(THREAD)), [
    checkpointRefForThreadTurn(THREAD, 0)
  ]);
});

test("only the session's active turn produces a completion checkpoint", async (t) => {
  const repo = await seededRepo();
  t.after(() => repo.cleanup());
  const service = serviceFor(repo);
  await service.captureBaseline({ threadId: THREAD, cwd: repo.dir });

  const stale = await service.captureTurnEnd({
    threadId: THREAD,
    cwd: repo.dir,
    turnId: "turn-old",
    assistantMessageId: null,
    activeTurnId: "turn-new"
  });
  assert.equal(stale, null);

  const live = await service.captureTurnEnd({
    threadId: THREAD,
    cwd: repo.dir,
    turnId: "turn-new",
    assistantMessageId: null,
    activeTurnId: "turn-new"
  });
  assert.ok(live);
  assert.equal(live.turnCount, 1);
});

test("readTurnDiff: equal turns short-circuit without touching git", async () => {
  const service = createCheckpointService({ gitEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  const diff = await service.readTurnDiff({
    threadId: THREAD,
    cwd: "/nonexistent-path-for-a-short-circuit",
    fromTurnCount: 3,
    toTurnCount: 3
  });
  assert.equal(diff, "");
});

test("readTurnDiff ignores whitespace by default and can be told not to", async (t) => {
  const repo = await createTempRepo();
  t.after(() => repo.cleanup());
  await repo.write("a.txt", "alpha\nbeta\n");
  await repo.git("add", "a.txt");
  await repo.git("commit", "-qm", "initial");

  const service = serviceFor(repo);
  await service.captureBaseline({ threadId: THREAD, cwd: repo.dir });
  await repo.write("a.txt", "alpha   \nbeta\n");
  await service.captureTurnEnd({
    threadId: THREAD,
    cwd: repo.dir,
    turnId: "turn-1",
    assistantMessageId: null
  });

  const ignored = await service.readTurnDiff({
    threadId: THREAD,
    cwd: repo.dir,
    fromTurnCount: 0,
    toTurnCount: 1
  });
  assert.equal(ignored, "", "a whitespace-only change is no diff by default");

  const exact = await service.readTurnDiff({
    threadId: THREAD,
    cwd: repo.dir,
    fromTurnCount: 0,
    toTurnCount: 1,
    ignoreWhitespace: false
  });
  assert.match(exact, /^diff --git a\/a\.txt b\/a\.txt$/m);
  assert.match(exact, /^\+alpha {3}$/m);
});

test("readTurnDiff caches by (thread, from, to, whitespace)", async (t) => {
  const repo = await seededRepo();
  t.after(() => repo.cleanup());
  const service = serviceFor(repo);
  await service.captureBaseline({ threadId: THREAD, cwd: repo.dir });
  await repo.write("tracked.txt", "one\ntwo\n");
  await service.captureTurnEnd({
    threadId: THREAD,
    cwd: repo.dir,
    turnId: "turn-1",
    assistantMessageId: null
  });

  const first = await service.readTurnDiff({
    threadId: THREAD,
    cwd: repo.dir,
    fromTurnCount: 0,
    toTurnCount: 1
  });
  assert.match(first, /tracked\.txt/);

  // Remove the ref: a cache miss would now fail the range check instead.
  await repo.git("update-ref", "-d", checkpointRefForThreadTurn(THREAD, 0));
  const cached = await service.readTurnDiff({
    threadId: THREAD,
    cwd: repo.dir,
    fromTurnCount: 0,
    toTurnCount: 1
  });
  assert.equal(cached, first);

  // A different whitespace flag is a different key, so it misses and fails.
  await assert.rejects(
    service.readTurnDiff({
      threadId: THREAD,
      cwd: repo.dir,
      fromTurnCount: 0,
      toTurnCount: 1,
      ignoreWhitespace: false
    }),
    CheckpointRefUnavailableError
  );
});

test("readTurnDiff refuses a turn above the thread's highest checkpoint", async (t) => {
  const repo = await seededRepo();
  t.after(() => repo.cleanup());
  const service = serviceFor(repo);
  await service.captureBaseline({ threadId: THREAD, cwd: repo.dir });

  await assert.rejects(
    service.readTurnDiff({ threadId: THREAD, cwd: repo.dir, fromTurnCount: 0, toTurnCount: 4 }),
    (error: unknown) => {
      assert.ok(error instanceof CheckpointTurnRangeError);
      assert.equal(error.requestedTurnCount, 4);
      assert.equal(error.availableTurnCount, 0);
      return true;
    }
  );
});

test("captures prune to the 200-ref cap, oldest first", async (t) => {
  const repo = await seededRepo();
  t.after(() => repo.cleanup());
  const service = serviceFor(repo);

  // Plant CHECKPOINT_REF_LIMIT refs in one git process, then capture one more.
  const head = (await repo.gitReadOnly("rev-parse", "HEAD")).trim();
  const commands: string[] = [];
  for (let turnCount = 0; turnCount < CHECKPOINT_REF_LIMIT; turnCount += 1) {
    commands.push(`create ${checkpointRefForThreadTurn(THREAD, turnCount)}\0${head}\0`);
  }
  await repo.gitStdin(commands.join(""), "update-ref", "-z", "--stdin");

  const summary = await service.captureTurnEnd({
    threadId: THREAD,
    cwd: repo.dir,
    turnId: "turn-200",
    assistantMessageId: null
  });

  assert.ok(summary);
  assert.equal(summary.turnCount, CHECKPOINT_REF_LIMIT);
  const refs = await refNames(repo, checkpointRefNamespace(THREAD));
  assert.equal(refs.length, CHECKPOINT_REF_LIMIT);
  assert.ok(!refs.includes(checkpointRefForThreadTurn(THREAD, 0)), "the oldest ref was pruned");
  assert.ok(refs.includes(checkpointRefForThreadTurn(THREAD, 1)));
  assert.ok(refs.includes(checkpointRefForThreadTurn(THREAD, CHECKPOINT_REF_LIMIT)));
});

test("pruneAbove deletes every ref above the target and nothing else", async (t) => {
  const repo = await seededRepo();
  t.after(() => repo.cleanup());
  const service = serviceFor(repo);

  await service.captureBaseline({ threadId: THREAD, cwd: repo.dir });
  for (const turnId of ["turn-1", "turn-2", "turn-3"]) {
    await repo.write("tracked.txt", `${turnId}\n`);
    await service.captureTurnEnd({ threadId: THREAD, cwd: repo.dir, turnId, assistantMessageId: null });
  }
  await service.captureBaseline({ threadId: "other-thread", cwd: repo.dir });

  await service.pruneAbove({ threadId: THREAD, cwd: repo.dir, targetTurnCount: 1 });

  assert.deepEqual(await refNames(repo, checkpointRefNamespace(THREAD)), [
    checkpointRefForThreadTurn(THREAD, 0),
    checkpointRefForThreadTurn(THREAD, 1)
  ]);
  assert.deepEqual(await refNames(repo, checkpointRefNamespace("other-thread")), [
    checkpointRefForThreadTurn("other-thread", 0)
  ]);
  assert.deepEqual(await refNames(repo, "refs/heads/"), ["refs/heads/main"]);
});

test("deleteThreadRefs removes every ref under the thread's prefix and nothing else", async (t) => {
  const repo = await seededRepo();
  t.after(() => repo.cleanup());
  const service = serviceFor(repo);

  await service.captureBaseline({ threadId: THREAD, cwd: repo.dir });
  await repo.write("tracked.txt", "second\n");
  await service.captureTurnEnd({
    threadId: THREAD,
    cwd: repo.dir,
    turnId: "turn-1",
    assistantMessageId: null
  });
  await service.captureBaseline({ threadId: "other-thread", cwd: repo.dir });
  // A stray ref of ours that is not a `turn/<n>` — still under the prefix.
  const head = (await repo.gitReadOnly("rev-parse", "HEAD")).trim();
  await repo.git("update-ref", `${checkpointRefNamespace(THREAD)}/stray`, head);

  await service.deleteThreadRefs({ threadId: THREAD, cwd: repo.dir });

  assert.deepEqual(await refNames(repo, checkpointRefNamespace(THREAD)), []);
  assert.deepEqual(await refNames(repo, checkpointRefNamespace("other-thread")), [
    checkpointRefForThreadTurn("other-thread", 0)
  ]);
  assert.deepEqual(await refNames(repo, "refs/heads/"), ["refs/heads/main"]);
});

test("a non-git directory is a silent no-op on every path", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orq-ckpt-plain-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const service = createCheckpointService({
    gitEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir }
  });

  assert.equal(await service.captureBaseline({ threadId: THREAD, cwd: dir }), null);
  assert.equal(
    await service.captureTurnEnd({
      threadId: THREAD,
      cwd: dir,
      turnId: "turn-1",
      assistantMessageId: null
    }),
    null
  );
  await service.pruneAbove({ threadId: THREAD, cwd: dir, targetTurnCount: 0 });
  await service.deleteThreadRefs({ threadId: THREAD, cwd: dir });
  await assert.rejects(
    service.readTurnDiff({ threadId: THREAD, cwd: dir, fromTurnCount: 0, toTurnCount: 1 }),
    CheckpointTurnRangeError
  );
  // A directory that does not exist at all behaves the same way.
  assert.equal(
    await service.captureBaseline({ threadId: THREAD, cwd: join(dir, "gone") }),
    null
  );
});

test("an untracked embedded repository does not break capture", async (t) => {
  const repo = await seededRepo();
  t.after(() => repo.cleanup());

  // A nested repository with no commit: `git add -A` refuses to stage it.
  const nested = join(repo.dir, "nested");
  await repo.write("nested/inner.txt", "inner\n");
  await repo.git("-C", nested, "init", "-q", "-b", "main", ".");

  const service = serviceFor(repo);
  const result = await service.captureBaseline({ threadId: THREAD, cwd: repo.dir });

  assert.ok(result, "the capture recovered by excluding the embedded repo");
  assert.equal(result.status, "ready");
  const paths = await treePaths(repo, result.ref);
  assert.ok(paths.includes("tracked.txt"));
  assert.ok(!paths.some((entry) => entry.startsWith("nested/")), `nested was staged: ${paths}`);
});

test("a cone sparse checkout captures skipped files instead of deleting them", async (t) => {
  const repo = await createTempRepo();
  t.after(() => repo.cleanup());
  await repo.write("kept/a.txt", "a\n");
  await repo.write("skipped/b.txt", "b\n");
  await repo.write("root.txt", "root\n");
  await repo.git("add", ".");
  await repo.git("commit", "-qm", "initial");
  await repo.git("sparse-checkout", "init", "--cone");
  await repo.git("sparse-checkout", "set", "kept");

  const service = serviceFor(repo);
  const result = await service.captureBaseline({ threadId: THREAD, cwd: repo.dir });

  assert.ok(result);
  assert.equal(result.status, "ready");
  assert.deepEqual(await treePaths(repo, result.ref), [
    "kept/a.txt",
    "root.txt",
    "skipped/b.txt"
  ]);
});

test("concurrent captures on two threads of one repo do not corrupt each other", async (t) => {
  const repo = await seededRepo();
  t.after(() => repo.cleanup());
  const service = serviceFor(repo);

  const [first, second] = await Promise.all([
    service.captureBaseline({ threadId: "thread-one", cwd: repo.dir }),
    service.captureBaseline({ threadId: "thread-two", cwd: repo.dir })
  ]);

  assert.ok(first);
  assert.ok(second);
  assert.equal(first.status, "ready");
  assert.equal(second.status, "ready");
  const expected = [".gitignore", "staged.txt", "tracked.txt", "untracked.txt"];
  assert.deepEqual(await treePaths(repo, first.ref), expected);
  assert.deepEqual(await treePaths(repo, second.ref), expected);
  // Neither capture left a temp index (or its lock) behind in the git dir.
  const entries = await repo.gitCommonDirEntries();
  assert.deepEqual(
    entries.filter((entry) => entry.startsWith("orq-checkpoint-index")),
    []
  );
});

test("a repository with no commits at all still captures a baseline", async (t) => {
  const repo = await createTempRepo();
  t.after(() => repo.cleanup());
  await repo.write("first.txt", "hello\n");

  const service = serviceFor(repo);
  const result = await service.captureBaseline({ threadId: THREAD, cwd: repo.dir });

  assert.ok(result);
  assert.equal(result.status, "ready");
  assert.deepEqual(await treePaths(repo, result.ref), ["first.txt"]);
  // Still no branch, and still no commit on the user's side.
  assert.deepEqual(await refNames(repo, "refs/heads/"), []);
});

test("a capture failure is reported, never thrown into the turn", async (t) => {
  const repo = await seededRepo();
  const gitDir = join(repo.dir, ".git");
  t.after(async () => {
    await chmod(gitDir, 0o700);
    await repo.cleanup();
  });
  const service = serviceFor(repo);

  // The git dir is unwritable, so the temporary index cannot be created.
  await chmod(gitDir, 0o500);
  const baseline = await service.captureBaseline({ threadId: THREAD, cwd: repo.dir });

  assert.ok(baseline, "a git project still reports a result");
  assert.equal(baseline.status, "error");
  assert.ok((baseline.detail ?? "").length > 0, "the failure carries a detail for the activity");

  const summary = await service.captureTurnEnd({
    threadId: THREAD,
    cwd: repo.dir,
    turnId: "turn-1",
    assistantMessageId: null
  });
  assert.ok(summary);
  assert.equal(summary.status, "error");
  assert.deepEqual(summary.files, []);
  assert.equal(summary.turnId, "turn-1");
});

test("assertRollbackSupported refuses grok and allows every other adapter", () => {
  const service = createCheckpointService({ gitEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
  assert.throws(() => service.assertRollbackSupported("grok"), CheckpointRollbackUnsupportedError);
  for (const adapter of ["claude", "codex", "opencode"] as const) {
    service.assertRollbackSupported(adapter);
  }
});
