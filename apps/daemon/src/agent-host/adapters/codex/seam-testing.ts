/**
 * Codex adapter — test support: the orchestrator seam. The real orchestrator
 * and the real ingestion over the real Codex adapter and session, driving the
 * scripted mock `codex app-server` (`testing.ts`), so a test reads what the
 * HOST did with a frame — the rows in the log, the thread's pending requests —
 * not just what the adapter emitted.
 *
 * Not a `*.test.ts`, so `pnpm test` does not execute it; it is typechecked
 * with the rest of the package.
 */

import { rmSync } from "node:fs";

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
import {
  createFakeContext,
  writeMockCodexServer,
  type MockReceived,
  type MockTurnScript
} from "./testing.ts";

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

export interface OrchestratedCodex {
  orchestrator: Orchestrator;
  /** The one thread's log, as the store holds it. */
  log: () => DomainEvent[];
  /** Every runtime event the host has finished handling, in order. */
  handled: RuntimeEvent[];
  /** Every frame the mock peer received, in the order it read them. */
  received: () => MockReceived[];
  /**
   * A barrier on the wire: resolves once the mock has answered a request of
   * ours, so everything the adapter wrote before it is in {@link received}.
   */
  wireBarrier(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * One host with the Codex adapter over a mock peer that runs `script` for
 * every turn. `cleanups` is the calling file's teardown list — the mock's
 * temp dir and the host's stop are registered there, so a failed assertion
 * never leaves a mock child alive.
 */
export async function orchestratedCodex(
  script: MockTurnScript,
  cleanups: (() => void | Promise<void>)[]
): Promise<OrchestratedCodex> {
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
    wireBarrier: async () => {
      await tracked.adapter.readThread("thread-1");
    },
    stop
  };
}

/** The thread every seam test opens: a supervised Codex chat under a managed account. */
export const SEAM_THREAD = {
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

/** The activity rows a log appended, in order. */
export function activitiesOf(log: readonly DomainEvent[]): ThreadActivityItem[] {
  return log.flatMap((event) => (event.type === "thread.activity-appended" ? [event.payload.activity] : []));
}

/** The card the adapter opened, as it emitted it: its request id and the server's JSON-RPC id. */
export function openedCard(host: OrchestratedCodex): { requestId: string; providerRequestId: string } | null {
  const opened = host.handled.find(
    (event) => event.type === "request.opened" || event.type === "user-input.requested"
  );
  const providerRequestId = opened?.providerRefs?.providerRequestId;
  return opened?.requestId !== undefined && providerRequestId !== undefined
    ? { requestId: opened.requestId, providerRequestId }
    : null;
}

/** The rows that close `requestId`, in log order. */
export function closingRows(host: OrchestratedCodex, requestId: string): ThreadActivityItem[] {
  return activitiesOf(host.log()).filter(
    (row) =>
      (row.activityKind === "approval.resolved" || row.activityKind === "user-input.resolved") &&
      (row.payload as { requestId?: string }).requestId === requestId
  );
}

/** What the adapter wrote to the wire for one server→client request: a response carries no method. */
export function answersTo(host: OrchestratedCodex, providerRequestId: string): unknown[] {
  return host
    .received()
    .filter((frame) => frame.method === undefined && String(frame.id) === providerRequestId)
    .map((frame) => frame.result ?? frame.error);
}
