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
import { rmSync } from "node:fs";
import { after, describe, it } from "node:test";

import type {
  AgentAdapterId,
  DomainEvent,
  ProviderSnapshot,
  RuntimeEvent,
  ThreadActivityItem
} from "@orquester/api/agent-chat";

import type { AgentAdapter } from "../../adapter.ts";
import { createIngestion } from "../../ingestion/index.ts";
import { createLivenessRegistry } from "../../orchestration/liveness.ts";
import { createOrchestrator, type Orchestrator } from "../../orchestration/orchestrator.ts";
import {
  createFakeCheckpointService,
  createFakeThreadStore,
  createMemoryLaunchConfigStore,
  createRecordingLogger,
  createTestClock,
  createTestIdGen,
  createTestTimers
} from "../../orchestration/testing/index.ts";
import type { ProviderSnapshotRegistry } from "../../services.ts";
import { createCodexAdapter } from "./index.ts";
import { createFakeContext, waitUntil, writeMockCodexServer, type MockTurnScript } from "./testing.ts";

const cleanups: (() => void | Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups) {
    await cleanup();
  }
});

/** No cached snapshot: the host's version gate reads an unknown version as in range. */
function noSnapshots(): ProviderSnapshotRegistry {
  return {
    all: (): ProviderSnapshot[] => [],
    get: () => null,
    refresh: () => Promise.reject(new Error("no snapshot in this test")),
    ensureWorkspaceSnapshot: () => {},
    applyUsageLimits: () => {},
    onChange: () => () => {}
  };
}

/**
 * The adapter's event stream, counting an event as handled once the consumer
 * asks for the next one: the orchestrator's loop awaits all of an event's
 * handling — `settleStrandedQuestions` after a `turn.completed` included —
 * before it pulls again, so a test waits on what the host has DONE, not on a
 * sleep.
 */
function trackHandled(adapter: AgentAdapter): { adapter: AgentAdapter; handled: RuntimeEvent[] } {
  const handled: RuntimeEvent[] = [];
  const source = adapter.events;
  const events: AsyncIterable<RuntimeEvent> = {
    async *[Symbol.asyncIterator]() {
      for await (const event of source) {
        yield event;
        handled.push(event);
      }
    }
  };
  return { adapter: { ...adapter, events }, handled };
}

interface Orchestrated {
  orchestrator: Orchestrator;
  log: () => DomainEvent[];
  handled: RuntimeEvent[];
  received: () => { result?: unknown }[];
  stop(): Promise<void>;
}

async function orchestratedCodex(script: MockTurnScript): Promise<Orchestrated> {
  const server = writeMockCodexServer({ turns: [script] });
  cleanups.push(() => rmSync(server.dir, { recursive: true, force: true }));
  const { context, abort } = createFakeContext({ resolveBin: () => Promise.resolve(server.bin) });
  const tracked = trackHandled(await createCodexAdapter(context));

  const clock = createTestClock(1_700_000_000_000);
  const timers = createTestTimers();
  const ids = createTestIdGen();
  const store = createFakeThreadStore();
  const liveness = createLivenessRegistry({ clock });
  let orchestrator: Orchestrator | null = null;
  const ingestion = createIngestion({
    sink: (threadId, events) => orchestrator!.ingestionSink(threadId, events),
    liveness,
    clock,
    idGen: ids,
    setTimer: (fn, ms) => timers.setTimer(fn, ms),
    clearTimer: (handle) => timers.clearTimer(handle)
  });
  orchestrator = createOrchestrator({
    store,
    ingestion,
    checkpoints: createFakeCheckpointService(),
    liveness,
    snapshots: noSnapshots(),
    adapters: new Map<AgentAdapterId, AgentAdapter>([["codex", tracked.adapter]]),
    logger: createRecordingLogger(),
    hostInstanceId: "host-test",
    adapterForRefId: (refId) => (refId === "codex" ? "codex" : null),
    resolveHome: async ({ home, accountId }) => ({
      kind: home,
      ...(home === "account" ? { accountId } : {}),
      path: `/tmp/home/${accountId}`
    }),
    launchConfigs: createMemoryLaunchConfigStore(),
    clock,
    ids,
    setTimer: (fn, ms) => timers.setTimer(fn, ms),
    clearTimer: (handle) => timers.clearTimer(handle)
  });
  orchestrator.openGate();
  const consumed = orchestrator.consume(tracked.adapter);
  const running = orchestrator;

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await tracked.adapter.stopAll();
    await consumed;
    await running.stop();
    abort.abort();
  };
  cleanups.push(stop);
  return {
    orchestrator: running,
    log: () => store.logs.get("thread-1") ?? [],
    handled: tracked.handled,
    received: () => server.received(),
    stop
  };
}

function activitiesOf(log: readonly DomainEvent[]): ThreadActivityItem[] {
  return log.flatMap((event) => (event.type === "thread.activity-appended" ? [event.payload.activity] : []));
}

describe("a collab child's question at the orchestrator seam (Task 3, fix round 2)", () => {
  it("survives the parent's turn end with its card open, and the user's answer reaches the child", async () => {
    const host = await orchestratedCodex({
      kind: "child-approval",
      childThreadId: "child-1",
      item: "question",
      parentSettles: "while-asking"
    });
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
    assert.equal(
      activitiesOf(host.log()).some((row) => row.summary === "User input dismissed"),
      false,
      "never swept as stranded: the child is still waiting on it"
    );
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
    await host.stop();
  });
});
