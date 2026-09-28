/**
 * Codex adapter — a collab child's QUESTION at the orchestrator seam (plan
 * `2026-09-24-follow-ups-adapters-output-composer-history`, Task 3, fix round 2).
 *
 * The real chain, end to end: the orchestrator and the real ingestion, the
 * real Codex adapter and session, and the scripted mock `codex app-server`.
 * A child asks the user a question; the parent's `wait` returns and the
 * parent's turn settles with the card still open. On every live
 * `turn.completed` the orchestrator dismisses the native-callback questions
 * of that turn (`settleStrandedQuestions`, §6.2) — in the log only, never an
 * answer to the adapter, because the provider's request is taken to have died
 * with the turn. A child's request does not die with the PARENT's turn: a
 * question stamped with the parent's turn was swept there, the card vanished,
 * the composer unblocked, and the child waited on `item/tool/requestUserInput`
 * until a Stop. Turnless, it survives the parent's turn end, and the user's
 * answer reaches the child.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { activitiesOf, orchestratedCodex } from "./seam-testing.ts";
import { waitUntil } from "./testing.ts";

const cleanups: (() => void | Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups) {
    await cleanup();
  }
});

describe("a collab child's question at the orchestrator seam (Task 3, fix round 2)", () => {
  it("survives the parent's turn end with its card open, and the user's answer reaches the child", async (t) => {
    const host = await orchestratedCodex(
      {
        kind: "child-approval",
        childThreadId: "child-1",
        item: "question",
        parentSettles: "while-asking"
      },
      cleanups
    );
    const { orchestrator } = host;
    await orchestrator.createThread({
      threadId: "thread-1",
      projectPath: process.cwd(),
      cwd: process.cwd(),
      title: "Codex",
      refId: "codex",
      accountId: "acc1",
      home: "account",
      modelSelection: { model: "gpt-5.5" },
      runtimeMode: "approval-required"
    });
    await orchestrator.command("thread-1", "turn", { commandId: "c-turn", input: "spawn an explorer" });

    // The child asks, then the parent's turn ends with the card still open.
    // Wait until the host has HANDLED that end — the stranded-question sweep
    // included — which it does after the question, in the order they came.
    await waitUntil(
      () => host.handled.some((event) => event.type === "turn.completed"),
      "the host handled the parent's turn end"
    );
    await orchestrator.drain();

    const asked = activitiesOf(host.log()).find((row) => row.activityKind === "user-input.requested");
    assert.ok(asked !== undefined, "the child asked");
    assert.equal(asked.turnId, null, "turnless: no turn's end sweeps it");
    const question = orchestrator.summary("thread-1")?.pendingRequests?.find(
      (request) => request.kind === "question"
    );
    assert.ok(question !== undefined, "the child's card outlives the parent's turn");

    // The user answers — through the host, to the adapter, to the child.
    await orchestrator.command("thread-1", "answer", {
      commandId: "c-answer",
      requestId: question.requestId,
      answers: { branch: "main" }
    });
    await waitUntil(
      () => host.received().some((frame) => (frame.result as { answers?: unknown } | undefined)?.answers !== undefined),
      "the child got its answer"
    );
    const reply = host
      .received()
      .find((frame) => (frame.result as { answers?: unknown } | undefined)?.answers !== undefined);
    assert.deepEqual((reply?.result as { answers: unknown }).answers, { branch: { answers: ["main"] } });
    await waitUntil(
      () => orchestrator.summary("thread-1")?.hasPendingUserInput === false,
      "the card closed with the answer"
    );
    const artifact = join(mkdtempSync(join(tmpdir(), "codex-child-question-")), "answered-question.json");
    writeFileSync(artifact, JSON.stringify({ events: host.log(), wire: host.received() }, null, 2));
    t.diagnostic(`Question workflow evidence: ${artifact}`);
    await host.stop();
  });
});
