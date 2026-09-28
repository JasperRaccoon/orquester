// The workflow runtime booted the way `startDaemon` boots it — the REAL stores on a temp appdir, the
// REAL routes on a Fastify app, the REAL wiring (`createWorkflowDaemon`), the daemon's own client
// (`InjectDaemonApi`) and the event bus — for the end-to-end tests. Nothing listens on a port.
//
// `boot()` twice over the same root is a daemon restart: a new set of stores reads what the last one
// flushed, and a new runtime resumes the runs it left.

import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify, { type FastifyInstance, type InjectOptions, type LightMyRequestResponse } from "fastify";
import type { AgentAccountsResponse, EventMessage, UsageResponse } from "@orquester/api";
import { workflowRunsDir, workflowSecretsPath, workflowStatePath, workflowsPath } from "@orquester/config";

import { Broadcaster } from "../../broadcaster.ts";
import { GitService } from "../../git.ts";
import { InjectDaemonApi, type DaemonApi } from "../../mcp/daemon-api.ts";
import type { LsRemoteResult } from "../git-remote/index.ts";
import type { ConditionalListOptions, ConditionalPage, PullRequestInfo, ReleaseInfo } from "../../providers/types.ts";
import type { AccountsReader, Clock, SandboxRunner, UsageReader, WorkflowEngine } from "../contracts.ts";
import type { AgentTimings } from "../agent/executor.ts";
import { createWorkflowDaemon, type WorkflowDaemon } from "../daemon-wiring.ts";
import { registerWorkflowRoutes } from "../routes.ts";
import type { ValidationCatalog } from "../agent/validation-catalog.ts";
import { FileRunStore } from "../run-store.ts";
import { createSandboxRunner } from "../sandbox/sandbox.ts";
import { WorkflowSecretsService } from "../secrets.ts";
import { WorkflowService, publishWorkflowEvents } from "../service.ts";
import { WorkflowStateStore } from "../state-store.ts";
import type { GitRemoteReader } from "../triggers/git-poller.ts";
import { silentLogger } from "./fakes.ts";

export const quietStoreLogger = { warn: () => undefined, error: () => undefined };

/** A temp appdir: `<root>/daemon`, `<root>/workspaces/<ws>/<project>` for each project named. */
export async function tempAppdir(projects: string[] = ["acme/app"]): Promise<{ root: string; workspacesDir: string; cleanup(): Promise<void> }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orq-wf-e2e-")));
  const workspacesDir = join(root, "workspaces");
  await mkdir(join(root, "daemon"), { recursive: true });
  await mkdir(join(root, "tmp"), { recursive: true });
  for (const project of projects) await mkdir(join(workspacesDir, project), { recursive: true });
  return { root, workspacesDir, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** A git remote nobody polls unless a test says so. */
export class FakeGitRemote implements GitRemoteReader {
  heads: Record<string, string> = {};
  tags: Record<string, { sha: string; commit: string }> = {};
  defaultBranch: string | undefined = "main";
  lsError: Error | null = null;
  lsCalls: { accountId: string | null; url: string }[] = [];
  async lsRemote(accountId: string | null, url: string, opts?: { defaultBranch?: boolean }): Promise<LsRemoteResult> {
    this.lsCalls.push({ accountId, url });
    if (this.lsError) throw this.lsError;
    return { heads: { ...this.heads }, tags: structuredClone(this.tags), ...(opts?.defaultBranch && this.defaultBranch ? { defaultBranch: this.defaultBranch } : {}) };
  }
  async listPullRequests(_a: string | null, _u: string, _o?: ConditionalListOptions): Promise<ConditionalPage<PullRequestInfo>> {
    return { items: [] };
  }
  async listReleases(_a: string | null, _u: string, _o?: ConditionalListOptions): Promise<ConditionalPage<ReleaseInfo>> {
    return { items: [] };
  }
}

export interface BootOptions {
  /** The engine's client (default: the daemon's own `InjectDaemonApi` over this app). */
  engineApi?: (inject: InjectDaemonApi) => DaemonApi;
  clock?: Clock;
  triggerClock?: Clock;
  sandbox?: SandboxRunner;
  gitRemote?: GitRemoteReader;
  usage?: UsageReader;
  accounts?: AccountsReader;
  agentTimings?: Partial<AgentTimings>;
  workspaceAccounts?: Record<string, string>;
  random?: () => number;
  triggerStateCheckMs?: number;
}

export interface Booted {
  root: string;
  workspacesDir: string;
  app: FastifyInstance;
  /** The daemon's own client over this app (what the MCP tools and the engine ride). */
  api: InjectDaemonApi;
  wf: WorkflowDaemon;
  service: WorkflowService;
  secrets: WorkflowSecretsService;
  runStore: FileRunStore;
  state: WorkflowStateStore;
  broadcaster: Broadcaster;
  /** Every event on the bus, in order. */
  events: EventMessage[];
  inject(options: InjectOptions): Promise<LightMyRequestResponse>;
  /** Resolves with the first event (already seen or future) that matches. */
  waitEvent(match: (event: EventMessage) => boolean, timeoutMs?: number, since?: number): Promise<EventMessage>;
  /** The whole shutdown: the runtime first (kills nothing), the stores flushed, the app closed. */
  close(): Promise<void>;
}

export async function boot(root: string, opts: BootOptions = {}): Promise<Booted> {
  const workspacesDir = join(root, "workspaces");
  const daemonDir = join(root, "daemon");
  const broadcaster = new Broadcaster();
  const events: EventMessage[] = [];
  const waiters = new Set<{ match: (event: EventMessage) => boolean; resolve: (event: EventMessage) => void }>();
  broadcaster.add({
    send(data: string) {
      const event = JSON.parse(data) as EventMessage;
      events.push(event);
      for (const waiter of [...waiters]) {
        if (waiter.match(event)) {
          waiters.delete(waiter);
          waiter.resolve(event);
        }
      }
    }
  });

  let catalogRef: ValidationCatalog | null = null;
  const secrets = new WorkflowSecretsService({ file: workflowSecretsPath(root), logger: quietStoreLogger });
  await secrets.load();
  const service = new WorkflowService({
    file: workflowsPath(root),
    logger: quietStoreLogger,
    secretNames: (workflowId) => secrets.names(workflowId),
    savedPromptIds: () => [],
    // Late-bound as in startDaemon: the workflow daemon below owns the catalogue.
    agentCatalog: () => catalogRef?.current()
  });
  await service.load();
  const runStore = new FileRunStore({ dir: workflowRunsDir(root), logger: quietStoreLogger });
  await runStore.init();
  const state = new WorkflowStateStore({ path: workflowStatePath(root), logger: quietStoreLogger });
  await state.load();

  let engine: WorkflowEngine | null = null;
  const app = Fastify({ logger: false });
  registerWorkflowRoutes(app, {
    service,
    secrets,
    runStore,
    engine: () => engine,
    savedPromptIds: () => [],
    logPollMs: 10,
    agentCatalogReady: async () => catalogRef?.ready()
  });
  await app.ready();
  const api = new InjectDaemonApi({ app, authorization: undefined, agentChat: null, broadcaster, fsRoot: () => workspacesDir, workspacesDir: () => workspacesDir });

  const usage: UsageReader = opts.usage ?? { snapshot: (): UsageResponse => ({ agents: [] }) };
  const accounts: AccountsReader = opts.accounts ?? {
    list: (): AgentAccountsResponse => ({ accounts: [], defaults: { claude: null, codex: null, grok: null } }) as AgentAccountsResponse,
    seededAccountIds: () => new Set<string>()
  };
  const wf = createWorkflowDaemon({
    service,
    secrets,
    runStore,
    state,
    broadcaster,
    usage,
    accounts,
    git: new GitService(),
    gitRemote: opts.gitRemote ?? new FakeGitRemote(),
    readWorkspaceMeta: async (workspace) => {
      const id = opts.workspaceAccounts?.[workspace];
      return id ? { gitAccountId: id } : null;
    },
    savedPrompts: { get: () => undefined },
    workspacesDir: () => workspacesDir,
    fsRoot: () => workspacesDir,
    daemonDir,
    appdirTmp: join(root, "tmp"),
    push: null,
    logger: silentLogger(),
    sandbox: opts.sandbox ?? createSandboxRunner({ pollMs: 20, killGraceMs: 300, appdirTmp: join(root, "tmp") }),
    ...(opts.clock ? { clock: opts.clock } : {}),
    ...(opts.triggerClock ? { triggerClock: opts.triggerClock } : {}),
    ...(opts.agentTimings ? { agentTimings: opts.agentTimings } : {}),
    ...(opts.random ? { random: opts.random } : {}),
    ...(opts.triggerStateCheckMs !== undefined ? { triggerStateCheckMs: opts.triggerStateCheckMs } : {})
  });
  catalogRef = wf.validationCatalog;
  publishWorkflowEvents({ service, secrets, broadcaster: wf.events, summarize: (workflow) => wf.summarize(workflow) });
  engine = wf.runtime.engine;
  await wf.start(opts.engineApi ? opts.engineApi(api) : api);

  const waitEvent = (match: (event: EventMessage) => boolean, timeoutMs = 20_000, since = 0): Promise<EventMessage> => {
    const seen = events.slice(since).find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const waiter = {
        match,
        resolve: (event: EventMessage) => {
          clearTimeout(timer);
          resolve(event);
        }
      };
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`no matching workflow event within ${timeoutMs} ms; saw: ${events.map((e) => e.type).join(", ")}`));
      }, timeoutMs);
      waiters.add(waiter);
    });
  };

  let closed = false;
  return {
    root,
    workspacesDir,
    app,
    api,
    wf,
    service,
    secrets,
    runStore,
    state,
    broadcaster,
    events,
    inject: (options) => app.inject(options),
    waitEvent,
    async close() {
      if (closed) return;
      closed = true;
      await wf.stop();
      await Promise.all([service.flush(), secrets.flush(), runStore.flush(), state.flush()]);
      await app.close();
    }
  };
}

/** A run's end on the bus. */
export const runFinished =
  (runId: string) =>
  (event: EventMessage): boolean =>
    event.channel === "workflows" && event.type === "workflowRun.finished" && (event.payload as { run?: { id?: string } })?.run?.id === runId;
