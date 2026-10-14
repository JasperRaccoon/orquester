/**
 * Thread lineage — Codex's native fork (spec 2026-10-14 §6): `thread/fork`
 * through the last kept turn, on a short-lived app-server, against the mock
 * server the session tests use.
 */

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";

import { codexThreadIdOf, forkCodexThread } from "./fork.ts";
import { createFakeContext, writeMockCodexServer } from "./testing.ts";

describe("forkCodexThread", () => {
  it("asks for thread/fork through the last kept turn and answers the new thread", async () => {
    const mock = writeMockCodexServer({ forkThreadId: "forked-1" });
    const { context } = createFakeContext();
    const id = await forkCodexThread({
      bin: mock.bin,
      env: { PATH: process.env.PATH ?? "", HOME: tmpdir() },
      cwd: tmpdir(),
      sourceCodexThreadId: "source-1",
      lastTurnId: "turn-2",
      logger: context.logger
    });
    assert.equal(id, "forked-1");
    const fork = mock.received().find((frame) => frame.method === "thread/fork");
    assert.deepEqual(fork?.params, {
      threadId: "source-1",
      lastTurnId: "turn-2",
      cwd: tmpdir(),
      excludeTurns: true,
      deferGoalContinuation: true
    });
    // Only the handshake and the fork: the source thread is never resumed.
    assert.deepEqual(
      mock.received().flatMap((frame) => (frame.method !== undefined ? [frame.method] : [])),
      ["initialize", "initialized", "thread/fork"]
    );
  });

  it("rejects with the provider's refusal", async () => {
    const mock = writeMockCodexServer({ failFork: true });
    const { context } = createFakeContext();
    await assert.rejects(
      forkCodexThread({
        bin: mock.bin,
        env: { PATH: process.env.PATH ?? "", HOME: tmpdir() },
        cwd: tmpdir(),
        sourceCodexThreadId: "gone",
        lastTurnId: "turn-1",
        logger: context.logger
      }),
      /no rollout found/
    );
  });

  it("reads the source thread off a cursor, or nothing", () => {
    assert.equal(codexThreadIdOf({ threadId: "abc-1" }), "abc-1");
    assert.equal(codexThreadIdOf({ threadId: "-flag" }), null);
    assert.equal(codexThreadIdOf(null), null);
    assert.equal(codexThreadIdOf("abc"), null);
  });
});
