// Automated workflows — the whole runtime as `startDaemon` wires it (spec §2 "Wiring in startDaemon").
//
// ONE function builds what the daemon runs: the engine runtime (factory.ts) with the agent executor
// and the account preview, the schedule trigger and the git poller on top of the engine (a
// `TriggerHost`), and the ONE summary builder every `workflow.upserted` and the list route share.
// `startDaemon` calls it with its live services; the end-to-end tests call it with the same stores on
// a temp appdir, so what they prove is what the daemon runs.
//
// Order (the invariants the daemon relies on):
//   1. `createWorkflowDaemon(...)` right after the stores load — nothing runs yet.
//   2. `start(api)` after `agentChat.init()` and once the unix app exists: the engine gets the
//      daemon's own client, resumes every unfinished run (§5.8), starts its queue and sweepers, then
//      the scheduler (boot catch-up, §6.1) and the poller (first polls spread over 10 s, §6.2).
//   3. `stop()` FIRST on shutdown: triggers, then the engine (which persists and kills nothing — the
//      sandbox children are detached and survive, §5.8); the stores flush after it.
//
// The summary (`summarize`) is built here and never delegates to `engine.summarize` — the routes'
// `summarizeWorkflow` delegates TO the engine, which calls this builder; a builder that called back
// would recurse (the engine refuses the loop and throws).
//
// Trigger state changes without a definition change (a scheduler reconcile computing `nextRunAt`
// after the edit's own `workflow.upserted` went out, a poll starting or stopping to fail): a small
// watcher republishes `workflow.upserted` when a workflow's (nextRunAt, lastError) moved — after
// every definition change once the scheduler settled, and every `triggerStateIntervalMs`. Never on
// `lastPollAt` alone, which moves every minute per trigger.

import {
  isTriggerType,
  WORKFLOWS_CHANNEL,
  type Workflow,
  type WorkflowSummary,
  type WorkflowsEventType
} from "@orquester/api";

import type { Broadcaster } from "../broadcaster.ts";
import type { DaemonApi } from "../mcp/daemon-api.ts";
import type { AccountsReader, UsageReader, WorkflowLogger } from "./contracts.ts";
import { createCooldownStore } from "./agent/cooldowns.ts";
import { createAgentExecutor } from "./agent/executor.ts";
import { createAccountPreview } from "./agent/preview.ts";
import { createValidationCatalog, type ValidationCatalog } from "./agent/validation-catalog.ts";
import { createWorkflowRuntime, realClock, type WorkflowRuntime, type WorkflowRuntimeDeps } from "./factory.ts";
import type { WorkflowPushSender } from "./notifier.ts";
import type { FileRunStore } from "./run-store.ts";
import type { WorkflowSecretsService } from "./secrets.ts";
import type { WorkflowService } from "./service.ts";
import type { WorkflowStateStore } from "./state-store.ts";
import { buildWorkflowSummary, summaryErrorsOf, type TriggerState } from "./summary.ts";
import { systemTriggerClock } from "./triggers/clock.ts";
import { createGitPoller, type GitPoller, type GitRemoteReader } from "./triggers/git-poller.ts";
import { createRepoResolver } from "./triggers/repo-resolve.ts";
import { createScheduler, type Scheduler } from "./triggers/scheduler.ts";

/** The daemon's log: one `[workflows]` line per message, its meta as JSON. Debug lines are dropped. */
export const consoleWorkflowLogger: WorkflowLogger = {
  debug() {},
  info: (msg, meta) => console.log(`[workflows] ${msg}${meta ? ` ${safeJson(meta)}` : ""}`),
  warn: (msg, meta) => console.warn(`[workflows] ${msg}${meta ? ` ${safeJson(meta)}` : ""}`),
  error: (msg, meta) => console.error(`[workflows] ${msg}${meta ? ` ${safeJson(meta)}` : ""}`)
};

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** How often the trigger-state watcher looks for a moved `nextRunAt` / `lastError`. */
const TRIGGER_STATE_CHECK_MS = 15_000;

export interface WorkflowDaemonDeps {
  service: WorkflowService;
  secrets: WorkflowSecretsService;
  runStore: FileRunStore;
  state: WorkflowStateStore;
  broadcaster: Pick<Broadcaster, "publish">;
  /** Synchronous: the usage service's latest cached reading (no I/O). */
  usage: UsageReader;
  /** Managed agent accounts (the agent-accounts store). */
  accounts: AccountsReader;
  /** The daemon's GitService. */
  git: WorkflowRuntimeDeps["git"] & { remoteUrl(cwd: string): Promise<string | null> };
  /** `AccountsService` — `lsRemote`, `listPullRequests`, `listReleases`. */
  gitRemote: GitRemoteReader;
  /** A workspace's `workspaces.json` side-table entry, by NAME (its `gitAccountId`). */
  readWorkspaceMeta(workspace: string): Promise<{ gitAccountId?: string | null } | null | undefined>;
  savedPrompts: WorkflowRuntimeDeps["savedPrompts"];
  /** Getters: `PUT /api/config/daemon` moves both in place. */
  workspacesDir: () => string;
  fsRoot: () => string;
  /** `<appdir>/tmp` — the sandbox attempts' TMPDIR. */
  appdirTmp?: string;
  push: WorkflowPushSender | null;
  logger: WorkflowLogger;
}

export interface WorkflowDaemon {
  runtime: WorkflowRuntime;
  scheduler: Scheduler;
  poller: GitPoller;
  /**
   * The broadcaster the definition events go out on (`publishWorkflowEvents`): the daemon's own, with
   * each `workflow.upserted` noted by the trigger-state watcher so it does not say the same twice.
   */
  events: Pick<Broadcaster, "publish">;
  /** The rail row: the ONE builder (never `summarizeWorkflow`, which delegates back to the engine). */
  summarize(workflow: Workflow): WorkflowSummary;
  /** Live trigger state of one trigger node (schedule: nextRunAt; git: lastPollAt / lastError). */
  triggerState(workflowId: string, nodeId: string): TriggerState | undefined;
  /** After `agentChat.init()`, with the daemon's own client: resume, run, then arm the triggers. */
  start(api: DaemonApi): Promise<void>;
  /**
   * The agent catalogue validation checks chains against (`unknown_agent` / `unknown_model`): the
   * store's `agentCatalog` reads `current()`, the write routes await `ready()`. Reads through the
   * client `start` is handed; nothing before.
   */
  validationCatalog: ValidationCatalog;
  /** Fast: triggers, the watcher, then the engine (which kills nothing). Stores are the caller's to flush. */
  stop(): Promise<void>;
}

export function createWorkflowDaemon(deps: WorkflowDaemonDeps): WorkflowDaemon {
  const { service, runStore, state, logger } = deps;
  const clock = realClock;
  const triggerClock = systemTriggerClock;
  const cooldowns = createCooldownStore(state, clock);

  let scheduler: Scheduler | null = null;
  let poller: GitPoller | null = null;
  let attachedApi: DaemonApi | null = null;
  const validationCatalog = createValidationCatalog({ api: () => attachedApi, logger });

  const triggerState = (workflowId: string, nodeId: string): TriggerState | undefined => {
    const schedule = scheduler?.triggerState(workflowId, nodeId) ?? null;
    const git = poller?.triggerState(workflowId, nodeId) ?? null;
    if (!schedule && !git) return undefined;
    return {
      ...(schedule ? { nextRunAt: schedule.nextRunAt } : {}),
      ...(git ? { lastPollAt: git.lastPollAt, lastError: git.lastError } : {})
    };
  };

  const summarize = (workflow: Workflow): WorkflowSummary =>
    buildWorkflowSummary(workflow, { runStore, triggerState, validation: service.validationOptions(workflow.id) });

  // ---- The trigger-state watcher -------------------------------------------------------------
  // It also re-judges each definition against the validation context as it stands — the agent
  // catalogue above all, which moves without an edit (a provider probed, a CLI updated): a row whose
  // errors changed goes out again, so the rail's problem chip follows the catalogue. Reading the
  // context is what refreshes a stale catalogue reading (`current()`), so this also keeps it fresh.
  /** workflowId → the (nodeId, nextRunAt, lastError) + errors fingerprint last published. */
  const published = new Map<string, string>();
  const errorsPrint = (errors: Pick<WorkflowSummary, "errorCount" | "errors">): unknown[] => [
    errors.errorCount,
    ...(errors.errors ?? []).map((problem) => [problem.code, problem.nodeId ?? null, problem.field ?? null, problem.message])
  ];
  const fingerprintOf = (workflow: Workflow, live: boolean): string =>
    JSON.stringify([
      ...workflow.nodes
        .filter((node) => isTriggerType(node.type))
        .map((node) => {
          const current = live ? triggerState(workflow.id, node.id) : undefined;
          return [node.id, current?.nextRunAt ?? null, current?.lastError ?? null];
        }),
      errorsPrint(summaryErrorsOf(workflow, service.validationOptions(workflow.id)))
    ]);
  const noteSummary = (summary: WorkflowSummary): void => {
    published.set(
      summary.id,
      JSON.stringify([
        ...summary.triggers.map((trigger) => [trigger.nodeId, trigger.nextRunAt ?? null, trigger.lastError ?? null]),
        errorsPrint(summary)
      ])
    );
  };
  const publish = (type: WorkflowsEventType, payload: unknown): void => {
    if (type === "workflow.upserted") {
      const summary = (payload as { workflow?: WorkflowSummary } | null)?.workflow;
      if (summary && typeof summary.id === "string" && Array.isArray(summary.triggers)) noteSummary(summary);
    }
    deps.broadcaster.publish(WORKFLOWS_CHANNEL, type, payload);
  };
  let watcherStopped = true;
  let watcherTimer: { cancel(): void } | null = null;
  const checkTriggerState = (): void => {
    const live = new Set<string>();
    for (const workflow of service.list()) {
      live.add(workflow.id);
      const now = fingerprintOf(workflow, true);
      const before = published.get(workflow.id) ?? fingerprintOf(workflow, false);
      if (now === before) continue;
      published.set(workflow.id, now);
      try {
        publish("workflow.upserted", { workflow: summarize(workflow) });
      } catch (error) {
        logger.warn("workflow summary failed", { workflowId: workflow.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    for (const id of [...published.keys()]) if (!live.has(id)) published.delete(id);
  };
  const armWatcher = (): void => {
    if (watcherStopped) return;
    watcherTimer = triggerClock.setTimeout(() => {
      watcherTimer = null;
      checkTriggerState();
      armWatcher();
    }, TRIGGER_STATE_CHECK_MS);
  };
  let unsubscribeDefinitions: (() => void)[] = [];

  // ---- The runtime ----------------------------------------------------------------------------
  const runtime = createWorkflowRuntime({
    store: service,
    runStore,
    secrets: deps.secrets,
    publish,
    summarize,
    usage: deps.usage,
    accounts: deps.accounts,
    cooldowns,
    git: deps.git,
    savedPrompts: deps.savedPrompts,
    workspacesDir: deps.workspacesDir,
    fsRoot: deps.fsRoot,
    ...(deps.appdirTmp !== undefined ? { appdirTmp: deps.appdirTmp } : {}),
    push: deps.push,
    createAgentExecutor,
    createAccountPreview: (previewDeps) => createAccountPreview(previewDeps),
    logger,
    clock
  });

  scheduler = createScheduler({ host: runtime.engine, state, clock: triggerClock, logger });
  poller = createGitPoller({
    host: runtime.engine,
    state,
    remote: deps.gitRemote,
    resolveRepo: createRepoResolver({ git: deps.git, readWorkspaceMeta: deps.readWorkspaceMeta, workspacesDir: deps.workspacesDir }),
    clock: triggerClock,
    logger
  });
  const theScheduler = scheduler;
  const thePoller = poller;

  let started = false;
  let stopped = false;
  return {
    runtime,
    events: {
      publish(channel: string, type: string, payload: unknown): void {
        if (channel === WORKFLOWS_CHANNEL) publish(type as WorkflowsEventType, payload);
        else deps.broadcaster.publish(channel, type, payload);
      }
    },
    scheduler: theScheduler,
    poller: thePoller,
    summarize,
    triggerState,
    validationCatalog,
    async start(api: DaemonApi): Promise<void> {
      if (started || stopped) return;
      started = true;
      attachedApi = api;
      runtime.attachApi(api);
      await runtime.start();
      // Seed what clients already hold (the list route's rows) so the watcher only speaks on a change.
      for (const workflow of service.list()) published.set(workflow.id, fingerprintOf(workflow, true));
      await theScheduler.start().catch((error: unknown) => logger.error("workflow scheduler failed to start", { error: String(error) }));
      await thePoller.start().catch((error: unknown) => logger.error("workflow git poller failed to start", { error: String(error) }));
      const settled = (): void => {
        if (stopped) return;
        // The scheduler reconciles on the same change: speak once its cursors have moved.
        void theScheduler.idle().then(() => {
          if (!stopped) checkTriggerState();
        });
      };
      unsubscribeDefinitions = [service.onChanged(settled), service.onDeleted((id) => void published.delete(id))];
      // The agent catalogue moves with the registry (an install, an update) and the provider
      // snapshots (a probe): read it again at once, then re-judge the rows — the rail's problem
      // chips follow without waiting out the refresh window.
      const offCatalog = api.subscribe?.((event) => {
        if (event.channel !== "registry" || (event.type !== "agent.providers.changed" && event.type !== "registry.changed")) return;
        validationCatalog.expire();
        void validationCatalog.ready().then(() => {
          if (!stopped) checkTriggerState();
        });
      });
      if (offCatalog) unsubscribeDefinitions.push(offCatalog);
      checkTriggerState();
      watcherStopped = false;
      armWatcher();
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      watcherStopped = true;
      watcherTimer?.cancel();
      watcherTimer = null;
      for (const off of unsubscribeDefinitions.splice(0)) off();
      theScheduler.stop();
      thePoller.stop();
      if (started) await runtime.stop();
    }
  };
}
