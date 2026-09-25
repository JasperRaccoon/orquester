/**
 * Codex adapter — the parent's own cards at the orchestrator seam (sweep,
 * follow-ups 2026-09-25).
 *
 * The real orchestrator and ingestion over the real Codex adapter and session
 * and the scripted mock `codex app-server`, for two ways a card closes without
 * the user's answer:
 *
 * - **A host Stop.** The host writes its own "Request cancelled" / "Question
 *   cancelled" row and hands the adapter the cancel, which the adapter answers
 *   on the wire and reports — and that report was a second row, "Approval
 *   resolved" / "User input submitted", saying someone answered. One row now,
 *   and the answer still reaches the provider.
 * - **The server resolving the card itself** (`serverRequest/resolved` naming
 *   a card still parked, mid-turn or after the turn ended). The card stayed
 *   parked in the adapter: a later Stop answered a request the server had
 *   dropped and wrote a second row. Now it is settled once — "Request
 *   cancelled" / "Question cancelled" on the card's own stamp, or, for a
 *   question the host already dismissed at its turn's end, the dismissal
 *   alone — and a later Stop writes nothing more.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import {
  SEAM_THREAD,
  activitiesOf,
  answersTo,
  closingRows,
  openedCard,
  orchestratedCodex,
  type OrchestratedCodex
} from "./seam-testing.ts";
import { waitUntil, type MockParentAskEnd, type MockTurnScript } from "./testing.ts";

const cleanups: (() => void | Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups) {
    await cleanup();
  }
});

type Item = "command" | "question";

function askScript(item: Item, afterAsking?: MockParentAskEnd): MockTurnScript {
  return item === "command"
    ? { kind: "command-approval", command: "ls -1", ...(afterAsking !== undefined ? { afterAsking } : {}) }
    : {
        kind: "user-input",
        questionId: "branch",
        header: "Branch",
        question: "Which branch?",
        options: [{ label: "main", description: "The default branch" }],
        ...(afterAsking !== undefined ? { afterAsking } : {})
      };
}

/** A host whose one thread's first turn asks, as `script` says. */
async function asking(script: MockTurnScript): Promise<OrchestratedCodex> {
  const host = await orchestratedCodex(script, cleanups);
  await host.orchestrator.createThread(SEAM_THREAD);
  await host.orchestrator.command("thread-1", "turn", {
    commandId: "c-turn",
    input: "go",
    interactionMode: "plan"
  });
  return host;
}

/** Wait until the host has handled the adapter's resolution of the card, and everything it wrote. */
async function handledResolution(host: OrchestratedCodex, requestId: string): Promise<void> {
  await waitUntil(
    () =>
      host.handled.some(
        (event) =>
          (event.type === "request.resolved" || event.type === "user-input.resolved") &&
          event.requestId === requestId
      ),
    "the host handled the adapter's resolution"
  );
  await host.orchestrator.drain();
}

/** Stop the thread from the host, and wait until everything it wrote is in. */
async function hostStop(host: OrchestratedCodex, commandId: string): Promise<void> {
  await host.orchestrator.command("thread-1", "interrupt", { commandId });
  await host.orchestrator.drain();
  await host.wireBarrier();
  await host.orchestrator.drain();
}

const CANCELLED = { command: "Request cancelled", question: "Question cancelled" } as const;

describe("a host Stop cancels the parent's own card with one row (sweep)", () => {
  for (const item of ["command", "question"] as const) {
    it(`the ${item} card: one '${CANCELLED[item]}' row, and the cancel still reaches the provider`, async () => {
      const host = await asking(askScript(item));
      await waitUntil(() => openedCard(host) !== null, "the card opened");
      await host.orchestrator.drain();
      const card = openedCard(host)!;
      assert.equal(host.orchestrator.summary("thread-1")?.pendingRequests?.length, 1);

      await host.orchestrator.command("thread-1", "interrupt", { commandId: "c-stop" });
      await handledResolution(host, card.requestId);

      assert.deepEqual(
        closingRows(host, card.requestId).map((row) => [row.id, row.summary]),
        [[`settle-cancel:${card.requestId}`, CANCELLED[item]]],
        "the host's own row, and no second one saying someone answered"
      );
      assert.deepEqual(answersTo(host, card.providerRequestId), [
        item === "command" ? { decision: "cancel" } : { answers: {} }
      ]);
      assert.deepEqual(host.orchestrator.summary("thread-1")?.pendingRequests, []);
      await host.stop();
    });
  }
});

describe("a parent card the server resolved itself (sweep)", () => {
  for (const item of ["command", "question"] as const) {
    it(`the ${item} card resolved mid-turn: one '${CANCELLED[item]}' row on its turn; a later Stop writes nothing more`, async () => {
      const host = await asking(askScript(item, ["resolved"]));
      await waitUntil(() => openedCard(host) !== null, "the card opened");
      const card = openedCard(host)!;
      await handledResolution(host, card.requestId);

      const asked = activitiesOf(host.log()).find(
        (row) => (row.payload as { requestId?: string } | null)?.requestId === card.requestId
      );
      assert.ok(asked !== undefined);
      assert.deepEqual(
        closingRows(host, card.requestId).map((row) => [row.id, row.summary, row.turnId]),
        [[`settle-cancel:${card.requestId}`, CANCELLED[item], asked.turnId]]
      );
      assert.notEqual(asked.turnId, null, "the card's own turn");
      assert.deepEqual(host.orchestrator.summary("thread-1")?.pendingRequests, []);

      await hostStop(host, "c-stop");
      assert.equal(closingRows(host, card.requestId).length, 1, "a later Stop writes nothing more");
      assert.deepEqual(answersTo(host, card.providerRequestId), [], "and never answers it");
      await host.stop();
    });

    it(`the ${item} card resolved after its turn ended: one closing row; a later Stop writes nothing more`, async () => {
      const host = await asking(askScript(item, ["turn-interrupted", "resolved"]));
      await waitUntil(() => openedCard(host) !== null, "the card opened");
      const card = openedCard(host)!;
      await handledResolution(host, card.requestId);

      const turnEnd = host.handled.find((event) => event.type === "turn.completed");
      assert.ok(turnEnd !== undefined);
      // A question on the ended turn was dismissed by the host at the turn's
      // end (§6.2) — that dismissal is its one row; an approval, which no turn
      // end settles, gets the cancelled row.
      assert.deepEqual(
        closingRows(host, card.requestId).map((row) => [row.id, row.summary]),
        item === "command"
          ? [[`settle-cancel:${card.requestId}`, "Request cancelled"]]
          : [[`turn-end-dismiss:${String(turnEnd.turnId)}:${card.requestId}`, "User input dismissed"]]
      );
      assert.deepEqual(host.orchestrator.summary("thread-1")?.pendingRequests, []);

      await hostStop(host, "c-stop");
      assert.equal(closingRows(host, card.requestId).length, 1, "a later Stop writes nothing more");
      assert.deepEqual(answersTo(host, card.providerRequestId), [], "and never answers it");
      await host.stop();
    });
  }
});
