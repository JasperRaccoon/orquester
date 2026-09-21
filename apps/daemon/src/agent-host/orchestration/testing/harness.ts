/**
 * Agent host — the orchestration test harness (spec §9).
 *
 * Ported in spirit from T3 Code (MIT):
 * `apps/server/integration/OrchestrationEngineHarness.integration.ts`
 * (`waitForReceipt` / `drainProviderRuntime` — the handles a test waits on
 * instead of sleeping).
 *
 * Wires a real {@link createOrchestrator} onto the in-memory fakes, a scripted
 * adapter, a manual clock and a manual timer wheel, and hands back the drain
 * seams. No test that uses it needs a timeout to pass.
 */

import type { AgentAdapterId, DomainEvent, ProviderSnapshot } from "@orquester/api/agent-chat";

import type { ProviderSnapshotRegistry } from "../../services.ts";
import { createLivenessRegistry } from "../liveness.ts";
import { createOrchestrator, type Orchestrator, type OrchestratorOptions } from "../orchestrator.ts";
import {
  createFakeCheckpointService,
  createFakeIngestion,
  createFakeThreadStore,
  createRecordingLogger,
  createTestClock,
  createTestIdGen,
  createTestTimers,
  type FakeCheckpointService,
  type FakeIngestion,
  type FakeThreadStore,
  type RecordingLogger,
  type TestClock,
  type TestTimers
} from "./fakes.ts";
import { createScriptedAdapter, type ScriptedAdapter } from "./scripted-adapter.ts";
import { TEST_FOLD_OPS } from "./test-fold.ts";

export interface TestHostOptions {
  adapters?: Partial<Record<AgentAdapterId, ScriptedAdapter>>;
  /** Reuse a store from an earlier host, to assert a restart (§3.3). */
  store?: FakeThreadStore;
  continuationEnabled?: (projectPath: string) => boolean;
  isThreadClosed?: (threadId: string) => boolean;
  minimumVersions?: OrchestratorOptions["minimumVersions"];
  /** Leave the gate shut so queue-before-ready can be asserted. */
  openGate?: boolean;
}

export interface TestHost {
  orchestrator: Orchestrator;
  adapter: ScriptedAdapter;
  adapters: Map<AgentAdapterId, ScriptedAdapter>;
  store: FakeThreadStore;
  ingestion: FakeIngestion;
  checkpoints: FakeCheckpointService;
  snapshots: ProviderSnapshotRegistry & { set(snapshot: ProviderSnapshot): void };
  logger: RecordingLogger;
  clock: TestClock;
  timers: TestTimers;
  /** Every event published to subscribers, in order. */
  published: DomainEvent[];
  createThread(input?: { threadId?: string; refId?: string; cwd?: string }): Promise<string>;
  settle(): Promise<void>;
  stop(): Promise<void>;
}

function createStubSnapshotRegistry(): ProviderSnapshotRegistry & {
  set(snapshot: ProviderSnapshot): void;
} {
  const snapshots = new Map<AgentAdapterId, ProviderSnapshot>();
  const listeners = new Set<(adapterId: AgentAdapterId) => void>();
  return {
    set(snapshot: ProviderSnapshot): void {
      snapshots.set(snapshot.id, snapshot);
    },
    all: () => [...snapshots.values()],
    get: (adapterId) => snapshots.get(adapterId) ?? null,
    async refresh(adapterId) {
      const snapshot = snapshots.get(adapterId);
      if (!snapshot) throw new Error(`no snapshot for ${adapterId}`);
      return snapshot;
    },
    ensureWorkspaceSnapshot() {},
    applyUsageLimits() {},
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

export function createTestHost(options: TestHostOptions = {}): TestHost {
  const clock = createTestClock(1_700_000_000_000);
  const timers = createTestTimers();
  const ids = createTestIdGen();
  const logger = createRecordingLogger();
  const store = options.store ?? createFakeThreadStore();
  const checkpoints = createFakeCheckpointService();
  const snapshots = createStubSnapshotRegistry();
  const liveness = createLivenessRegistry();

  const adapters = new Map<AgentAdapterId, ScriptedAdapter>();
  for (const [id, adapter] of Object.entries(options.adapters ?? {})) {
    adapters.set(id as AgentAdapterId, adapter);
  }
  if (adapters.size === 0) {
    adapters.set("claude", createScriptedAdapter({ id: "claude" }));
  }
  const adapter = adapters.values().next().value as ScriptedAdapter;

  let orchestrator: Orchestrator;
  const ingestion = createFakeIngestion({
    sink: (threadId, events) => orchestrator.ingestionSink(threadId, events)
  });

  orchestrator = createOrchestrator({
    store,
    ingestion,
    checkpoints,
    liveness,
    snapshots,
    adapters,
    logger,
    hostInstanceId: "host-test",
    adapterForRefId: (refId) => {
      if (refId === "claudex" || refId === "claudemix") return "claude";
      return adapters.has(refId as AgentAdapterId) ? (refId as AgentAdapterId) : null;
    },
    resolveHome: async ({ home, accountId }) => ({
      kind: home,
      ...(home === "account" ? { accountId } : {}),
      path: `/tmp/home/${accountId}`
    }),
    ...(options.continuationEnabled ? { continuationEnabled: options.continuationEnabled } : {}),
    ...(options.isThreadClosed ? { isThreadClosed: options.isThreadClosed } : {}),
    ...(options.minimumVersions ? { minimumVersions: options.minimumVersions } : {}),
    clock,
    ids,
    fold: TEST_FOLD_OPS,
    setTimer: (fn, ms) => timers.setTimer(fn, ms),
    clearTimer: (handle) => timers.clearTimer(handle)
  });

  if (options.openGate !== false) {
    orchestrator.openGate();
  }

  const published: DomainEvent[] = [];

  const host: TestHost = {
    orchestrator,
    adapter,
    adapters,
    store,
    ingestion,
    checkpoints,
    snapshots,
    logger,
    clock,
    timers,
    published,
    async createThread(input = {}): Promise<string> {
      const threadId = input.threadId ?? "thread-1";
      await orchestrator.createThread({
        threadId,
        projectPath: "/work/project",
        cwd: input.cwd ?? "/work/project",
        title: "Test thread",
        refId: input.refId ?? adapter.id,
        accountId: "acc1",
        home: "account",
        modelSelection: { model: "test-model" },
        runtimeMode: "approval-required"
      });
      await orchestrator.subscribe(threadId, {
        onEvents: (events) => {
          published.push(...events);
        }
      });
      return threadId;
    },
    async settle(): Promise<void> {
      await orchestrator.drain();
    },
    async stop(): Promise<void> {
      for (const scripted of adapters.values()) {
        scripted.close();
      }
      await orchestrator.stop();
    }
  };

  return host;
}
