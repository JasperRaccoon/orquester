/**
 * Codex adapter — a collab child's open cards end with the child, at the
 * orchestrator seam (follow-ups 2026-09-25).
 *
 * The real chain, end to end: the orchestrator and the real ingestion, the
 * real Codex adapter and session, and the scripted mock `codex app-server`.
 * A child asks, then its own turn is interrupted with the card still open —
 * and the server, as the installed CLI does, resolves the request itself and
 * says so with `serverRequest/resolved` (fixtures README observation 20).
 * Nothing on the host settles a child's card by a turn — an approval rides the
 * parent's turn, which nothing settles approvals by, and a question rides none
 * — so the card stayed pending, blocking the composer ("Answer the request
 * above first.") and the MCP's send_message until the user answered a card
 * nothing waited on any more, or pressed Stop. Now the adapter settles it as a
 * Stop settles one: one "Request cancelled" / "Question cancelled" row, on the
 * turn stamp the card was opened with, and the thread has nothing pending.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { activitiesOf, orchestratedCodex } from "./seam-testing.ts";
import { waitUntil } from "./testing.ts";

const cleanups: (() => void | Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups) {
    await cleanup();
  }
});

const THREAD = {
  threadId: "thread-1",
  projectPath: process.cwd(),
  cwd: process.cwd(),
  title: "Codex",
  refId: "codex",
  accountId: "acc1",
  home: "account" as const,
  modelSelection: { model: "gpt-5.5" },
  runtimeMode: "approval-required" as const
};

describe("a collab child's open cards end with the child, at the orchestrator seam", () => {
  it("a child's approval, its turn interrupted: one 'Request cancelled' row on its parent turn, nothing pending", async () => {
    const host = await orchestratedCodex(
      {
        kind: "child-approval",
        childThreadId: "child-1",
        item: "command",
        afterAsking: ["turn-interrupted", "resolved"]
      },
      cleanups
    );
    const { orchestrator } = host;
    await orchestrator.createThread(THREAD);
    await orchestrator.command("thread-1", "turn", { commandId: "c-turn", input: "spawn an explorer" });

    // The child asks, its turn is interrupted, the server resolves the
    // request; then the parent's turn ends. Wait until the host has handled
    // that last one — everything before it was handled first.
    await waitUntil(
      () => host.handled.some((event) => event.type === "turn.completed"),
      "the host handled the parent's turn end"
    );
    await orchestrator.drain();

    const rows = activitiesOf(host.log());
    const asked = rows.find((row) => row.activityKind === "approval.requested");
    assert.ok(asked !== undefined, "the child asked");
    const requestId = (asked.payload as { requestId: string }).requestId;
    assert.notEqual(asked.turnId, null, "the card rode the parent's turn");

    const resolutions = rows.filter(
      (row) =>
        row.activityKind === "approval.resolved" &&
        (row.payload as { requestId?: string }).requestId === requestId
    );
    assert.equal(resolutions.length, 1, "settled once");
    assert.deepEqual(resolutions[0], {
      kind: "activity",
      id: `settle-cancel:${requestId}`,
      tone: "info",
      activityKind: "approval.resolved",
      summary: "Request cancelled",
      payload: { requestId, decision: "cancel" },
      turnId: asked.turnId,
      createdAt: resolutions[0]!.createdAt,
      updatedAt: resolutions[0]!.createdAt
    });

    // The composer is unblocked: the host has nothing pending.
    const summary = orchestrator.summary("thread-1");
    assert.equal(summary?.hasPendingApprovals, false);
    assert.equal(summary?.hasPendingUserInput, false);
    assert.deepEqual(summary?.pendingRequests, []);

    // And nothing was answered for it: the server had resolved it itself.
    await host.wireBarrier();
    assert.deepEqual(
      host.received().filter((frame) => frame.method === undefined && frame.id === 0),
      []
    );
    await host.stop();
  });

  it("a child's question, its turn interrupted: one turnless 'Question cancelled' row, nothing pending", async () => {
    const host = await orchestratedCodex(
      {
        kind: "child-approval",
        childThreadId: "child-1",
        item: "question",
        afterAsking: ["turn-interrupted", "resolved"]
      },
      cleanups
    );
    const { orchestrator } = host;
    await orchestrator.createThread(THREAD);
    await orchestrator.command("thread-1", "turn", { commandId: "c-turn", input: "spawn an explorer" });

    await waitUntil(
      () => host.handled.some((event) => event.type === "turn.completed"),
      "the host handled the parent's turn end"
    );
    await orchestrator.drain();

    const rows = activitiesOf(host.log());
    const asked = rows.find((row) => row.activityKind === "user-input.requested");
    assert.ok(asked !== undefined, "the child asked");
    assert.equal(asked.turnId, null);
    const requestId = (asked.payload as { requestId: string }).requestId;

    const resolutions = rows.filter(
      (row) =>
        row.activityKind === "user-input.resolved" &&
        (row.payload as { requestId?: string }).requestId === requestId
    );
    assert.equal(resolutions.length, 1, "settled once");
    assert.equal(resolutions[0]!.id, `settle-cancel:${requestId}`);
    assert.equal(resolutions[0]!.summary, "Question cancelled");
    assert.deepEqual(resolutions[0]!.payload, { requestId });
    assert.equal(resolutions[0]!.turnId, null, "turnless, as it was asked");

    const summary = orchestrator.summary("thread-1");
    assert.equal(summary?.hasPendingUserInput, false);
    assert.deepEqual(summary?.pendingRequests, []);

    await host.wireBarrier();
    assert.deepEqual(
      host.received().filter((frame) => frame.method === undefined && frame.id === 0),
      []
    );
    await host.stop();
  });
});
