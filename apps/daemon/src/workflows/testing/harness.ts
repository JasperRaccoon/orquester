// Automated workflows — an engine wired to in-memory fakes, for tests.

import type { UsageResponse, Workflow, WorkflowSummary, WorkflowsEventType } from "@orquester/api";

import type { DaemonApi } from "../../mcp/daemon-api.ts";
import type { NodeExecutionContext, NodeExecutor, NodeExecutorRegistry, NodeResult, WorkflowNotifier } from "../contracts.ts";
import { createWorkflowEngine, type WorkflowRuntimeEngine } from "../engine.ts";
import { createNodeExecutors } from "../nodes/index.ts";
import type { EngineLimits } from "../run-context.ts";
import {
  FakeProjects,
  FakeSandbox,
  InMemoryRunStore,
  InMemorySecretStore,
  InMemoryWorkflowStore,
  ManualClock,
  sequentialIds,
  silentLogger
} from "./fakes.ts";

export interface PublishedEvent {
  type: WorkflowsEventType;
  payload: unknown;
}

export const nullDaemonApi: DaemonApi = {
  request: async () => ({ status: 503, body: { code: "HOST_UNAVAILABLE", message: "no daemon in tests" } }),
  uploadAttachment: async () => ({ status: 503, value: null }),
  subscribe: () => () => undefined,
  fsRoot: "/w",
  workspacesDir: "/w"
};

/** An executor answering per node NAME; unnamed nodes echo `{node, input}`. */
export function scripted<T extends NodeExecutionContext["node"]["type"]>(
  type: T,
  behaviors: Record<string, (ctx: NodeExecutionContext<T>) => NodeResult | Promise<NodeResult>> = {}
): NodeExecutor<T> & { seen: string[] } {
  const seen: string[] = [];
  return {
    type,
    seen,
    async execute(ctx) {
      seen.push(ctx.node.name);
      const behavior = behaviors[ctx.node.name];
      if (behavior) return behavior(ctx);
      return { status: "succeeded", output: { node: ctx.node.name, input: ctx.expressionContext().input ?? null } };
    }
  };
}

export interface HarnessOptions {
  workflows?: Workflow[];
  executors?: NodeExecutorRegistry;
  limits?: Partial<EngineLimits>;
  clock?: ManualClock;
  runStore?: InMemoryRunStore;
  store?: InMemoryWorkflowStore;
  secrets?: InMemorySecretStore;
  projects?: FakeProjects;
  sandbox?: FakeSandbox;
  mintId?: () => string;
  notifier?: WorkflowNotifier;
}

export interface Harness {
  engine: WorkflowRuntimeEngine;
  clock: ManualClock;
  runStore: InMemoryRunStore;
  store: InMemoryWorkflowStore;
  secrets: InMemorySecretStore;
  projects: FakeProjects;
  sandbox: FakeSandbox;
  events: PublishedEvent[];
  logger: ReturnType<typeof silentLogger>;
  notified: { status: string; workflowId: string }[];
  /** Events of one type (payload typed loosely). */
  eventsOf(type: WorkflowsEventType): Record<string, unknown>[];
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const clock = options.clock ?? new ManualClock();
  const runStore = options.runStore ?? new InMemoryRunStore();
  const store = options.store ?? new InMemoryWorkflowStore(options.workflows ?? []);
  const secrets = options.secrets ?? new InMemorySecretStore();
  const projects = options.projects ?? new FakeProjects();
  const sandbox = options.sandbox ?? new FakeSandbox();
  const logger = silentLogger();
  const events: PublishedEvent[] = [];
  const notified: { status: string; workflowId: string }[] = [];
  const executors: NodeExecutorRegistry = { ...createNodeExecutors(), ...(options.executors ?? {}) };
  const summarize = (workflow: Workflow): WorkflowSummary => ({
    id: workflow.id,
    name: workflow.name,
    enabled: workflow.enabled,
    revision: workflow.revision,
    project: workflow.project,
    triggers: [],
    nodeCount: workflow.nodes.length,
    errorCount: 0,
    activeRuns: runStore.activeForWorkflow(workflow.id),
    ...(runStore.latestForWorkflow(workflow.id) ? { lastRun: runStore.latestForWorkflow(workflow.id)! } : {}),
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt
  });
  const engine = createWorkflowEngine({
    store,
    runStore,
    secrets,
    executors,
    services: {
      chat: { api: nullDaemonApi },
      usage: { snapshot: () => ({}) as UsageResponse },
      accounts: { list: () => ({ accounts: [] }) as never },
      cooldowns: { get: () => null, set: async () => undefined, list: () => ({}) },
      sandbox,
      projects,
      prompts: { render: async (input) => ({ ok: true, text: input.body }), savedPromptBody: () => null }
    },
    publish: (type, payload) => events.push({ type, payload: structuredClone(payload) }),
    notifier: options.notifier ?? {
      runFinished: (run) => notified.push({ status: run.status, workflowId: run.workflowId })
    },
    summarize,
    clock,
    mintId: options.mintId ?? sequentialIds("run"),
    logger,
    ...(options.limits ? { limits: options.limits } : {})
  });
  return {
    engine,
    clock,
    runStore,
    store,
    secrets,
    projects,
    sandbox,
    events,
    logger,
    notified,
    eventsOf: (type) => events.filter((event) => event.type === type).map((event) => event.payload as Record<string, unknown>)
  };
}
