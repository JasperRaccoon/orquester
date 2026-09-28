/**
 * §5.4 "On `turn.started`: capture the baseline …" — WHEN that happens.
 *
 * The baseline must be the tree as it was BEFORE the turn. Capturing it only
 * from the runtime `turn.started`, on a queue, leaves an unbounded window in
 * which anything the agent (or the provider's own session start) writes folds
 * into the baseline, and the turn's numstat then silently under-reports those
 * files. T3 captures from the domain turn-start for exactly this reason
 * (`CheckpointReactor.ensurePreTurnBaselineFromDomainTurnStart`).
 *
 * This lives in the checkpoints package because the guarantee is a checkpoint
 * guarantee; the call site it pins is W1's `sendTurnEffect`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { CaptureResult } from "../services.ts";
import { createTestHost } from "../orchestration/testing/index.ts";
import { checkpointRefForThreadTurn } from "./refs.ts";
import { createCheckpointService } from "./service.ts";
import { createTempRepo } from "./test-support.ts";

test("R5 #6: the pre-turn baseline is captured before the provider is asked", async (t) => {
  const repo = await createTempRepo();
  const host = createTestHost();
  t.after(async () => { await host.stop(); await repo.cleanup(); });
  await repo.write("tracked.txt", "before the turn\n");
  await repo.git("add", "tracked.txt");
  await repo.git("commit", "-qm", "initial");
  const checkpoints = createCheckpointService({ gitEnv: repo.gitEnv });
  Object.assign(host.checkpoints, checkpoints);
  const startSession = host.adapter.startSession.bind(host.adapter);
  host.adapter.startSession = async (input) => {
    await repo.write("tracked.txt", "provider startup changed this\n");
    return startSession(input);
  };
  const threadId = await host.createThread({ cwd: repo.dir });

  await host.orchestrator.command(threadId, "turn", { commandId: "cmd-1", input: "hello" });
  await host.settle();
  assert.equal(
    await repo.gitReadOnly("show", `${checkpointRefForThreadTurn(threadId, 0)}:tracked.txt`),
    "before the turn\n"
  );
  const completed = await checkpoints.captureTurnEnd({
    threadId, cwd: repo.dir, turnId: "turn-1", assistantMessageId: null
  });
  assert.deepEqual(completed?.files, [{ path: "tracked.txt", additions: 1, deletions: 1 }]);
  await host.orchestrator.ingestionSink(threadId, [{
    eventId: "first-turn-complete",
    threadId,
    type: "thread.session-set",
    payload: { session: { status: "ready", activeTurnId: null } },
    occurredAt: host.clock.nowIso(),
    commandId: null,
    causationEventId: null,
    metadata: {}
  }]);

  await host.orchestrator.command(threadId, "turn", { commandId: "cmd-2", input: "next turn" });
  await host.settle();
  await repo.write("tracked.txt", "unfinished second turn\n");
  await host.orchestrator.command(threadId, "turn", { commandId: "cmd-3", input: "steer" });
  await host.settle();
  assert.equal(
    await repo.gitReadOnly("show", `${checkpointRefForThreadTurn(threadId, 1)}:tracked.txt`),
    "provider startup changed this\n"
  );
  assert.equal(
    await repo.gitReadOnly("for-each-ref", "--format=%(refname)", checkpointRefForThreadTurn(threadId, 2)),
    "",
    "a steer must not publish a partially completed turn checkpoint"
  );
});

test("R5 #6: a baseline failure never blocks the turn", async (t) => {
  const host = createTestHost();
  t.after(() => host.stop());
  const threadId = await host.createThread();
  host.checkpoints.captureBaseline = async (): Promise<CaptureResult | null> => {
    throw new Error("git exploded");
  };

  await host.orchestrator.command(threadId, "turn", { commandId: "cmd-1", input: "hello" });
  await host.settle();

  assert.equal(host.adapter.lastTurn?.input, "hello", "the turn was sent anyway");
});
