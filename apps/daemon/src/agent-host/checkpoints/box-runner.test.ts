/**
 * Checkpoints of a box project: every git command runs in the box (`createBoxGitRunner`), the
 * refs land in the box's repository. The "box" is `localBoxConnection()` over a real temporary
 * repository; the service's own runner is given a PATH without git, so a command that ran here
 * instead of in the box would fail the test.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { localBoxConnection } from "../../boxes/testing.ts";
import { createBoxGitRunner } from "./box-git.ts";
import { checkpointRefNamespace } from "./refs.ts";
import { createCheckpointService } from "./service.ts";
import { createTempRepo, refNames } from "./test-support.ts";

test("a box project's checkpoints are captured and diffed by git in the box", async () => {
  const repo = await createTempRepo();
  try {
    await repo.write("a.txt", "alpha\n");
    await repo.git("add", "a.txt");
    await repo.git("commit", "-q", "-m", "initial");

    const base = localBoxConnection();
    const boxRunner = createBoxGitRunner({ connection: base, path: repo.gitEnv.PATH ?? "/usr/bin:/bin" });
    const service = createCheckpointService({
      // Nothing may run here: this PATH has no git.
      gitEnv: { PATH: "/nonexistent", HOME: repo.gitEnv.HOME ?? "/nonexistent" },
      runnerFor: async (cwd) => (cwd === repo.dir ? boxRunner : null)
    });

    const baseline = await service.captureBaseline({ threadId: "t1", cwd: repo.dir, turnId: "turn-1", turnCount: 0 });
    assert.ok(baseline);
    await repo.write("b.txt", "bravo\n");
    const summary = await service.captureTurnEnd({ threadId: "t1", cwd: repo.dir, turnId: "turn-1", assistantMessageId: "m1", turnCount: 1 });
    assert.equal(summary?.status, "ready");
    assert.deepEqual(summary?.files.map((file) => file.path), ["b.txt"]);
    assert.deepEqual(await refNames(repo, checkpointRefNamespace("t1")), [
      `${checkpointRefNamespace("t1")}/turn/0`,
      `${checkpointRefNamespace("t1")}/turn/1`
    ]);
    const diff = await service.readTurnDiff({ threadId: "t1", cwd: repo.dir, fromTurnCount: 0, toTurnCount: 1 });
    assert.match(diff, /\+bravo/);
    // The capture's temp index lived in the box's git dir and is gone.
    const leftovers = (await repo.gitReadOnly("rev-parse", "--git-common-dir")).trim();
    const listed = await base.request("fs.readdir", { path: `${repo.dir}/${leftovers}` });
    assert.deepEqual(listed.filter((entry) => entry.name.startsWith("orq-checkpoint-index-")).map((entry) => entry.name), []);
  } finally {
    await repo.cleanup();
  }
});
