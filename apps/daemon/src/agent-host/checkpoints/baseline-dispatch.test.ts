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

test("R5 #6: the pre-turn baseline is captured before the provider is asked", async () => {
  const host = createTestHost();
  const threadId = await host.createThread();

  let baselineCalls = 0;
  /** Adapter calls that had already happened when the baseline ran. */
  const callsAtBaseline: string[][] = [];
  host.checkpoints.captureBaseline = async (): Promise<CaptureResult | null> => {
    baselineCalls += 1;
    callsAtBaseline.push(host.adapter.calls.map((call) => call.kind));
    return null;
  };

  await host.orchestrator.command(threadId, "turn", { commandId: "cmd-1", input: "hello" });
  await host.settle();

  assert.ok(baselineCalls >= 1, "the turn dispatch captured a baseline");
  assert.deepEqual(
    callsAtBaseline[0],
    [],
    "…before startSession and before sendTurn — not after the provider had a chance to write"
  );
  assert.equal(
    host.adapter.calls.filter((call) => call.kind === "sendTurn").length,
    1,
    "and the turn still went out"
  );
  await host.stop();
});

test("R5 #6: an already-published baseline is not read as 'no checkpoints here'", async () => {
  const host = createTestHost();
  const threadId = await host.createThread();
  // What the real service answers from a thread's second turn onwards.
  host.checkpoints.captureBaseline = async (): Promise<CaptureResult | null> => ({
    turnCount: 0,
    ref: "refs/orquester/checkpoints/x/turn/0",
    status: "ready"
  });

  await host.orchestrator.command(threadId, "turn", { commandId: "cmd-1", input: "hello" });
  await host.settle();

  assert.deepEqual(
    host.orchestrator.placeholderCheckpoint({ threadId, turnId: host.adapter.turnIds[0] ?? "" }),
    { turnCount: 1 },
    "the thread still offers checkpoints"
  );
  await host.stop();
});

test("R5 #6: a baseline failure never blocks the turn", async () => {
  const host = createTestHost();
  const threadId = await host.createThread();
  host.checkpoints.captureBaseline = async (): Promise<CaptureResult | null> => {
    throw new Error("git exploded");
  };

  await host.orchestrator.command(threadId, "turn", { commandId: "cmd-1", input: "hello" });
  await host.settle();

  assert.equal(host.adapter.lastTurn?.input, "hello", "the turn was sent anyway");
  await host.stop();
});
