// Builds the workflow engine, executors, services and sweepers for daemon-wiring.ts.
// Attach the daemon API before starting: agent and project operations use its route gates.

import { randomUUID } from "node:crypto";

import type {
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
  ProjectOps,
  RunStore,
  SecretStore,
  UsageReader,
  WorkflowLogger,
  WorkflowStore
} from "./contracts.ts";
import { createAgentExecutor } from "./agent/executor.ts";
import { createAccountPreview } from "./agent/preview.ts";
import { createWorkflowEngine, type WorkflowRuntimeEngine } from "./engine.ts";
import { createNodeExecutors } from "./nodes/index.ts";
import { createWorkflowNotifier, type WorkflowPushSender } from "./notifier.ts";
import { createProjectOps } from "./projects.ts";
import { createPromptRenderer } from "./prompt-renderer.ts";
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
  logger: WorkflowLogger;
  clock?: Clock;
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
  const sandbox = createSandboxRunner({ clock, logger: deps.logger, ...(deps.appdirTmp !== undefined ? { appdirTmp: deps.appdirTmp } : {}) });
  const notifier = createWorkflowNotifier({ push: deps.push, clock, logger: deps.logger });
  const mintId = randomUUID;
  const agent = createAgentExecutor({
    usage: deps.usage,
    accounts: deps.accounts,
    cooldowns: deps.cooldowns,
    prompts,
    clock,
    mintId,
    logger: deps.logger
  });
  const accountPreview = createAccountPreview({ usage: deps.usage, accounts: deps.accounts, cooldowns: deps.cooldowns, clock, api: () => api });
  const executors = createNodeExecutors({ agent });

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
    accountPreview,
    clock,
    mintId,
    logger: deps.logger
  });

  const sweepers = createWorkflowSweepers({
    clock,
    runStore: deps.runStore,
    store: deps.store,
    projects,
    api: () => api,
    activeRunIds: () => engine.activeRunIds(),
    logger: deps.logger
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
