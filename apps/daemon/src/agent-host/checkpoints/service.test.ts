/**
 * Checkpoint service tests against REAL temporary git repositories.
 *
 * Every assertion here is about what git actually did — the captured tree, the
 * refs that exist, and, above all, what the user's repository looks like
 * afterwards (§5.4: nothing touches the index, HEAD, a branch, the stash or
 * the visible reflog).
 */

import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { Checkpoint } from "@orquester/api/agent-chat";

import type { CheckpointService } from "../services.ts";
import { checkpointRefForThreadTurn, checkpointRefNamespace } from "./refs.ts";
import {
  CHECKPOINT_DIFF_CACHE_LIMIT,
  CHECKPOINT_DIFF_CACHE_MAX_BYTES,
  CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
  CHECKPOINT_REF_LIMIT,
  CheckpointRefDeleteError,
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

  // Answers the existing baseline rather than `null`: `null` is reserved for
  // "this project has no checkpoints", and from turn 2 on the baseline is
  // always already there.
  assert.deepEqual(second, { turnCount: 0, ref: first.ref, status: "ready" });
  assert.equal(
    (await repo.gitReadOnly("rev-parse", first.ref)).trim(),
    firstCommit,
    "an existing baseline is never recaptured"
  );
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

  // Remove the TO ref: a cache miss would now fail the range check instead.
  await repo.git("update-ref", "-d", checkpointRefForThreadTurn(THREAD, 1));
  const cached = await service.readTurnDiff({
    threadId: THREAD,
    cwd: repo.dir,
    fromTurnCount: 0,
    toTurnCount: 1
  });
  assert.equal(cached, first, "served from the cache, not from the deleted ref");

  // A different whitespace flag is a different key, so it misses — and the
  // miss really goes to git, which no longer has the ref.
  await assert.rejects(
    service.readTurnDiff({
      threadId: THREAD,
      cwd: repo.dir,
      fromTurnCount: 0,
      toTurnCount: 1,
      ignoreWhitespace: false
    }),
    CheckpointTurnRangeError
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

  assert.equal(
    await service.captureBaseline({ threadId: THREAD, cwd: dir }),
    null,
    "null is reserved for a project with no checkpoints at all"
  );
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

// ---------------------------------------------------------------------------
// Fix-wave regressions (R5 #10, #11, #14, #20; Q1 #42, #43; S1 #9)
// ---------------------------------------------------------------------------

test("R5 #10: a turn whose baseline is missing diffs against HEAD, not 404", async (t) => {
  const repo = await seededRepo();
  t.after(() => repo.cleanup());
  const service = serviceFor(repo);

  // No baseline at all — git was "initialised during the turn".
  await repo.write("tracked.txt", "one\nsecond line\n");
  const summary = await service.captureTurnEnd({
    threadId: THREAD,
    cwd: repo.dir,
    turnId: "turn-1",
    assistantMessageId: null
  });
  assert.ok(summary);
  assert.equal(summary.turnCount, 1);

  const diff = await service.readTurnDiff({
    threadId: THREAD,
    cwd: repo.dir,
    fromTurnCount: 0,
    toTurnCount: 1
  });
  assert.match(diff, /tracked\.txt/, "the HEAD fallback produced a real patch");
  assert.match(diff, /^\+second line$/m);

  // A turn ABOVE the highest checkpoint is still a 404 — that is the one case
  // the spec reserves it for.
  await assert.rejects(
    service.readTurnDiff({ threadId: THREAD, cwd: repo.dir, fromTurnCount: 1, toTurnCount: 2 }),
    CheckpointTurnRangeError
  );
});

test("R5 #10: a baseline pruned by the cap still answers a diff", async (t) => {
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
  // The cap pruned turn/0 (simulated by deleting it) — the row is still there.
  await repo.git("update-ref", "-d", checkpointRefForThreadTurn(THREAD, 0));

  const diff = await service.readTurnDiff({
    threadId: THREAD,
    cwd: repo.dir,
    fromTurnCount: 0,
    toTurnCount: 1
  });
  assert.equal(typeof diff, "string");
  assert.match(diff, /tracked\.txt/);
});

test("R5 #10: with no HEAD at all the fallback is the empty tree", async (t) => {
  const repo = await createTempRepo();
  t.after(() => repo.cleanup());
  await repo.write("only.txt", "hello\n");
  const service = serviceFor(repo);

  const summary = await service.captureTurnEnd({
    threadId: THREAD,
    cwd: repo.dir,
    turnId: "turn-1",
    assistantMessageId: null
  });
  assert.ok(summary);

  const diff = await service.readTurnDiff({
    threadId: THREAD,
    cwd: repo.dir,
    fromTurnCount: 0,
    toTurnCount: 1
  });
  assert.match(diff, /^\+\+\+ b\/only\.txt$/m);
  assert.match(diff, /^\+hello$/m);
});

test("R5 #11: a stale turn end for a turn that never started is refused", async (t) => {
  const repo = await seededRepo();
  t.after(() => repo.cleanup());
  const service = serviceFor(repo);

  // The host recorded turn-2 as the started turn…
  await service.captureBaseline({ threadId: THREAD, cwd: repo.dir, turnId: "turn-2" });
  // …so a late abort for turn-1 must not mint turn/1.
  const stale = await service.captureTurnEnd({
    threadId: THREAD,
    cwd: repo.dir,
    turnId: "turn-1",
    assistantMessageId: null
  });
  assert.equal(stale, null);
  assert.deepEqual(await refNames(repo, checkpointRefNamespace(THREAD)), [
    checkpointRefForThreadTurn(THREAD, 0)
  ]);

  const live = await service.captureTurnEnd({
    threadId: THREAD,
    cwd: repo.dir,
    turnId: "turn-2",
    assistantMessageId: null
  });
  assert.ok(live);
  assert.equal(live.turnCount, 1);
});

test("R5 #11: a replayed turn end is refused even with no fold rows to check", async (t) => {
  const repo = await seededRepo();
  t.after(() => repo.cleanup());
  const service = serviceFor(repo);

  await service.captureBaseline({ threadId: THREAD, cwd: repo.dir, turnId: "turn-1" });
  const first = await service.captureTurnEnd({
    threadId: THREAD,
    cwd: repo.dir,
    turnId: "turn-1",
    assistantMessageId: null
  });
  assert.ok(first);

  const replay = await service.captureTurnEnd({
    threadId: THREAD,
    cwd: repo.dir,
    turnId: "turn-1",
    assistantMessageId: null
  });
  assert.equal(replay, null, "the second delivery of the same completion captures nothing");
  assert.deepEqual(await refNames(repo, checkpointRefNamespace(THREAD)), [
    checkpointRefForThreadTurn(THREAD, 0),
    checkpointRefForThreadTurn(THREAD, 1)
  ]);
});

test("R5 #20: a non-cone sparse checkout that cannot be rebuilt fails the capture", async (t) => {
  const repo = await createTempRepo();
  t.after(() => repo.cleanup());
  await repo.write("kept/a.txt", "a\n");
  await repo.write("skipped/b.txt", "b\n");
  await repo.git("add", ".");
  await repo.git("commit", "-qm", "initial");
  // Non-cone sparse checkout…
  await repo.git("sparse-checkout", "init", "--no-cone");
  await repo.git("sparse-checkout", "set", "/kept/*");
  // …plus a manual index flag, so the live index cannot be reused and the
  // rebuild path — the one that would publish false deletions — is reached.
  await repo.git("update-index", "--assume-unchanged", "kept/a.txt");

  const service = serviceFor(repo);
  const result = await service.captureBaseline({ threadId: THREAD, cwd: repo.dir });

  assert.ok(result, "a git project reports a result rather than skipping");
  assert.equal(result.status, "error", "false deletions are refused, not published");
  assert.match(result.detail ?? "", /non-cone sparse checkout/);
  assert.deepEqual(await refNames(repo, checkpointRefNamespace(THREAD)), [], "no ref was written");
});

test("R5 #20: a stale temp-index lock does not poison the next capture", async (t) => {
  const repo = await seededRepo();
  t.after(() => repo.cleanup());
  const gitDir = join(repo.dir, ".git");
  // A capture killed mid-flight leaves <tempIndex>.lock behind. With a fixed
  // uuid the next capture reuses that exact path, which is the poisoned case.
  const service = createCheckpointService({ gitEnv: repo.gitEnv, uuid: () => "fixed" });
  await writeFile(join(gitDir, "orq-checkpoint-index-fixed"), "stale", "utf8");
  await writeFile(join(gitDir, "orq-checkpoint-index-fixed.lock"), "stale", "utf8");

  const result = await service.captureBaseline({ threadId: THREAD, cwd: repo.dir });

  assert.ok(result);
  assert.equal(result.status, "ready", result.detail ?? "");
  const entries = await repo.gitCommonDirEntries();
  assert.deepEqual(
    entries.filter((entry) => entry.startsWith("orq-checkpoint-index")),
    [],
    "the temp index and its lock are removed in the finally"
  );
});

test("Q1 #42: a ref that survives deletion fails the prune instead of reporting success", async (t) => {
  const repo = await seededRepo();
  const gitDir = join(repo.dir, ".git");
  t.after(async () => {
    await chmod(gitDir, 0o700);
    await repo.cleanup();
  });
  const service = serviceFor(repo);

  await service.captureBaseline({ threadId: THREAD, cwd: repo.dir });
  await repo.write("tracked.txt", "second\n");
  await service.captureTurnEnd({
    threadId: THREAD,
    cwd: repo.dir,
    turnId: "turn-1",
    assistantMessageId: null
  });

  const surviving = checkpointRefForThreadTurn(THREAD, 1);
  // Deletion needs a lock file in the git dir; a read-only git dir is what a
  // hard lock contention looks like from here. Reads still work, so the
  // service can see that the ref survived — which is the whole point.
  await chmod(gitDir, 0o500);

  await assert.rejects(
    service.pruneAbove({ threadId: THREAD, cwd: repo.dir, targetTurnCount: 0 }),
    (error: unknown) => {
      assert.ok(error instanceof CheckpointRefDeleteError, `unexpected error: ${String(error)}`);
      assert.deepEqual([...error.refs], [surviving]);
      return true;
    }
  );

  await chmod(gitDir, 0o700);
  assert.deepEqual(
    await refNames(repo, checkpointRefNamespace(THREAD)),
    [checkpointRefForThreadTurn(THREAD, 0), surviving],
    "the refs really are still there — the rejection told the truth"
  );
});

test("R5 #14/Q1 #43: the diff cache is bounded by bytes, not only by entries", async (t) => {
  const repo = await createTempRepo();
  t.after(() => repo.cleanup());
  const line = `${"x".repeat(120)}\n`;
  await repo.write("big.txt", line.repeat(40));
  await repo.git("add", ".");
  await repo.git("commit", "-qm", "initial");
  const service = serviceFor(repo);

  await service.captureBaseline({ threadId: THREAD, cwd: repo.dir });
  await repo.write("big.txt", line.repeat(80));
  const summary = await service.captureTurnEnd({
    threadId: THREAD,
    cwd: repo.dir,
    turnId: "turn-1",
    assistantMessageId: null
  });
  assert.ok(summary);

  const first = await service.readTurnDiff({
    threadId: THREAD,
    cwd: repo.dir,
    fromTurnCount: 0,
    toTurnCount: 1
  });
  assert.ok(first.length > 0);
  // Served from the cache: the ref is gone and the answer is unchanged.
  await repo.git("update-ref", "-d", checkpointRefForThreadTurn(THREAD, 1));
  const cached = await service.readTurnDiff({
    threadId: THREAD,
    cwd: repo.dir,
    fromTurnCount: 0,
    toTurnCount: 1
  });
  assert.equal(cached, first);
  // The budget that makes that safe on a 2 GB box is the byte one: an
  // entry-count cap alone would admit 32 × 10 MB.
  assert.ok(
    CHECKPOINT_DIFF_CACHE_MAX_BYTES <
      CHECKPOINT_DIFF_CACHE_LIMIT * CHECKPOINT_DIFF_MAX_OUTPUT_BYTES
  );
});

test("S1 #9: a failure detail collapses the host's home path to ~", async (t) => {
  const repo = await seededRepo();
  const gitDir = join(repo.dir, ".git");
  t.after(async () => {
    await chmod(gitDir, 0o700);
    await repo.cleanup();
  });
  // HOME is the repo's parent here, so any path git names sits under it.
  const home = dirname(repo.dir);
  const service = createCheckpointService({ gitEnv: { ...repo.gitEnv, HOME: home } });
  await chmod(gitDir, 0o500);

  const result = await service.captureBaseline({ threadId: THREAD, cwd: repo.dir });

  assert.ok(result);
  assert.equal(result.status, "error");
  assert.ok(
    !(result.detail ?? "").includes(home),
    `raw host path leaked into a timeline row: ${result.detail ?? ""}`
  );
});
