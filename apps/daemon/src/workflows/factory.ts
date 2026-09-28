// Automated workflows — the runtime the daemon starts (spec §2 "Wiring in startDaemon"): the engine
// with every block executor, the projects/prompt/notification services it needs, and the hourly
// sweepers. The integrator calls, in `startDaemon`:
//
//   const workflows = createWorkflowRuntime({...});          // after the stores are loaded
//   ...build the unix app...
//   workflows.attachApi(createInternalDaemonApi({...}));      // the ALWAYS-ON unix app
//   await workflows.start();                                  // after agentChat.init(): resume, then run
//   ...start the scheduler and the git poller against `workflows.engine` (a TriggerHost)...
//   // and on shutdown, first:
//   await workflows.stop();                                   // fast; never kills sandbox children
//
// The engine drives agents and projects ONLY through the daemon's own REST (`DaemonApi`), so it
// cannot run before `attachApi`: a block that needs it before then fails, and `start()` refuses.

import { randomUUID } from "node:crypto";

import type {
  AccountSelectionDecision,
  AgentChainEntry,
  GitStatusResponse,
  GitWorkingDiffResponse,
  Workflow,
  WorkflowSummary,
  WorkflowsEventType
} from "@orquester/api";

import type { DaemonApi } from "../mcp/daemon-api.ts";
import type {
  AccountsReader,
  ChatClient,
  Clock,
  CooldownStore,
  MintId,
  NodeExecutor,
  ProjectOps,
  PromptRenderer,
  RunStore,
  SandboxRunner,
  SecretStore,
  UsageReader,
  WorkflowLogger,
  WorkflowStore
} from "./contracts.ts";
import { createWorkflowEngine, type WorkflowRuntimeEngine } from "./engine.ts";
import { createNodeExecutors } from "./nodes/index.ts";
import { createWorkflowNotifier, type WorkflowPushSender } from "./notifier.ts";
import { createProjectOps } from "./projects.ts";
import { createPromptRenderer } from "./prompt-renderer.ts";
import type { EngineLimits } from "./run-context.ts";
import { createSandboxRunner } from "./sandbox/sandbox.ts";
import { createWorkflowSweepers, type WorkflowSweepers } from "./sweepers.ts";

export interface WorkflowRuntimeDeps {
  /** Definitions (storage's WorkflowService). */
  store: WorkflowStore;
  /** Runs on disk (storage's RunStore). */
  runStore: RunStore;
  /** Secret values (storage's WorkflowSecrets); only `resolve` is used here. */
  secrets: Pick<SecretStore, "resolve">;
  /** The WORKFLOWS_CHANNEL broadcaster: `broadcaster.publish(WORKFLOWS_CHANNEL, {type, payload})`-shaped. */
  publish(type: WorkflowsEventType, payload: unknown): void;
  /**
   * The rail's summary of a workflow: BUILD it — `buildWorkflowSummary(workflow, {runStore,
   * triggerState, validation})` from summary.ts — never `summarizeWorkflow` from routes.ts, which
   * delegates to `engine.summarize` once the engine is attached (the engine refuses the loop).
   */
  summarize(workflow: Workflow): WorkflowSummary;
  /** In-memory usage cache (`usage.snapshot()`), managed agent accounts, and the shared cooldowns. */
  usage: UsageReader;
  accounts: AccountsReader;
  cooldowns: CooldownStore;
  /** The daemon's GitService (status, workingDiff, currentBranch). */
  git: {
    status(cwd: string): Promise<GitStatusResponse>;
    workingDiff(cwd: string, maxBytes: number): Promise<GitWorkingDiffResponse>;
    currentBranch(cwd: string): Promise<string | null>;
  };
  /** The saved-prompts service (`get(id)`). */
  savedPrompts: { get(id: string): { body: string; title: string } | undefined | null };
  /** Getters in the daemon (`PUT /api/config/daemon` moves both in place); a string in tests. */
  workspacesDir: string | (() => string);
  fsRoot: string | (() => string);
  /** `<appdir>/tmp` — the sandbox attempts' TMPDIR. */
  appdirTmp?: string;
  /** The daemon's PushService (`notifyWorkflowRun`); null disables pushes. */
  push: WorkflowPushSender | null;
  /**
   * The agent block's executor factory — `createAgentExecutor` from agent/executor.ts. Without it an
   * agent block fails "no executor".
   */
  createAgentExecutor?: (deps: AgentExecutorFactoryDeps) => NodeExecutor<"agent">;
  /** "Who would run now?" — `createAccountPreview` from agent/preview.ts. */
  createAccountPreview?: (deps: AccountPreviewFactoryDeps) => (chain: AgentChainEntry[], projectPath?: string) => Promise<AccountSelectionDecision>;
  /** Which (agent, model) pairs run on an account (claudex router / xAI models do not): agent/families.ts `createUsesAccount`. */
  usesAccount?: (refId: string, model: string) => boolean;
  logger: WorkflowLogger;
  clock?: Clock;
  mintId?: MintId;
  /** A sandbox runner other than the default detached one (tests). */
  sandbox?: SandboxRunner;
  limits?: Partial<EngineLimits>;
  /** Global days a workflow tab is kept after its run (default 7). */
  workflowTabRetentionDays?: number;
}

/** What `createAgentExecutor` (agent/executor.ts `AgentExecutorDeps`) is handed. */
export interface AgentExecutorFactoryDeps {
  usage: UsageReader;
  accounts: AccountsReader;
  cooldowns: CooldownStore;
  usesAccount?: (refId: string, model: string) => boolean;
  prompts: PromptRenderer;
  clock: Clock;
  mintId: MintId;
  logger: WorkflowLogger;
}

/** What `createAccountPreview` (agent/preview.ts `AccountPreviewDeps`) is handed. */
export interface AccountPreviewFactoryDeps {
  usage: UsageReader;
  accounts: AccountsReader;
  cooldowns: CooldownStore;
  usesAccount?: (refId: string, model: string) => boolean;
  clock: Pick<Clock, "now">;
}

export interface WorkflowRuntime {
  engine: WorkflowRuntimeEngine;
  projects: ProjectOps;
  sweepers: WorkflowSweepers;
  /** Hand the engine the daemon's own client (the unix app is built after the services). */
  attachApi(api: DaemonApi): void;
  /** Resume unfinished runs, then start the queue and the sweepers. Call once, after `attachApi`. */
  start(): Promise<void>;
  /** Fast: stops the sweepers and the engine (which persists, and kills nothing). */
  stop(): Promise<void>;
}

export const realClock: Clock = {
  now: () => new Date(),
  setTimeout(fn, ms) {
    const timer = setTimeout(fn, Math.max(0, Math.min(ms, 2 ** 31 - 1)));
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  }
};

export function createWorkflowRuntime(deps: WorkflowRuntimeDeps): WorkflowRuntime {
  const clock = deps.clock ?? realClock;
  let api: DaemonApi | null = null;
  const chat: ChatClient = {
    get api(): DaemonApi {
      if (!api) throw new Error("The workflow engine is not attached to the daemon yet.");
      return api;
    }
  };
  const projects = createProjectOps({ api: () => api, git: deps.git, workspacesDir: deps.workspacesDir, fsRoot: deps.fsRoot });
  const prompts = createPromptRenderer({ git: deps.git, savedPrompts: deps.savedPrompts, now: () => clock.now() });
  const sandbox =
    deps.sandbox ?? createSandboxRunner({ clock, logger: deps.logger, ...(deps.appdirTmp !== undefined ? { appdirTmp: deps.appdirTmp } : {}) });
  const notifier = createWorkflowNotifier({ push: deps.push, clock, logger: deps.logger });
  const mintId = deps.mintId ?? randomUUID;
  const usesAccount = deps.usesAccount !== undefined ? { usesAccount: deps.usesAccount } : {};
  const agent = deps.createAgentExecutor?.({
    usage: deps.usage,
    accounts: deps.accounts,
    cooldowns: deps.cooldowns,
    ...usesAccount,
    prompts,
    clock,
    mintId,
    logger: deps.logger
  });
  const accountPreview = deps.createAccountPreview?.({ usage: deps.usage, accounts: deps.accounts, cooldowns: deps.cooldowns, ...usesAccount, clock });
  const executors = createNodeExecutors(agent ? { agent } : {});

  const engine = createWorkflowEngine({
    store: deps.store,
    runStore: deps.runStore,
    secrets: deps.secrets,
    executors,
    services: {
      chat,
      usage: deps.usage,
      accounts: deps.accounts,
      cooldowns: deps.cooldowns,
      sandbox,
      projects,
      prompts
    },
    publish: deps.publish,
    notifier,
    summarize: deps.summarize,
    ...(accountPreview ? { accountPreview } : {}),
    clock,
    mintId,
    logger: deps.logger,
    ...(deps.limits ? { limits: deps.limits } : {})
  });

  const sweepers = createWorkflowSweepers({
    clock,
    runStore: deps.runStore,
    store: deps.store,
    projects,
    api: () => api,
    activeRunIds: () => engine.activeRunIds(),
    logger: deps.logger,
    ...(deps.workflowTabRetentionDays !== undefined ? { workflowTabRetentionDays: deps.workflowTabRetentionDays } : {})
  });

  let started = false;
  return {
    engine,
    projects,
    sweepers,
    attachApi(next: DaemonApi): void {
      api = next;
    },
    async start(): Promise<void> {
      if (started) return;
      if (!api) throw new Error("Attach the daemon API before starting the workflow engine.");
      started = true;
      await engine.resume();
      engine.start();
      sweepers.start();
    },
    async stop(): Promise<void> {
      sweepers.stop();
      await engine.stop();
    }
  };
}
