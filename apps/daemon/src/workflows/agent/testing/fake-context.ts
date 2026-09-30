// A fake `NodeExecutionContext<"agent">` and the readers the agent block needs, for its tests (and
// the engine's / MCP's / e2e builders'). `setWaitingOn` records every persisted value; `crashAt`
// throws `SimulatedCrash` right AFTER a chosen persist — the moment a daemon dies having written its
// `WaitingOn` but before the side effect it guards — so a test can resume from that value with a new
// executor, exactly as the engine does after a restart.

import { renderPromptTemplate } from "@orquester/api";
import type {
  AgentAccount,
  AgentAccountsResponse,
  UsageResponse,
  WorkflowBlockRun,
  WorkflowNode
} from "@orquester/api";
import { workflowRecordSchema, type AccountCooldown, type AgentBlockConfig, type WorkflowRecord } from "@orquester/config";
import type {
  AccountsReader,
  CooldownStore,
  EngineServices,
  NodeExecutionContext,
  PromptRenderer,
  UsageReader,
  WaitingOn,
  WorkflowLogger
} from "../../contracts.ts";
import { cooldownKey } from "../families.ts";
import type { FakeChatHost } from "./fake-chat-host.ts";
import type { FakeClock } from "./fake-clock.ts";

export class SimulatedCrash extends Error {
  constructor(readonly waitingOn: WaitingOn | undefined) {
    super("simulated daemon crash");
  }
}

export const silentLogger: WorkflowLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** An in-memory `CooldownStore` shared by every block of a test (the daemon's is `workflow-state.json`). */
export class MemoryCooldowns implements CooldownStore {
  readonly entries: Record<string, AccountCooldown> = {};
  constructor(private readonly clock: Pick<FakeClock, "now">) {}
  get(family: string, accountId: string): AccountCooldown | null {
    const c = this.entries[cooldownKey(family, accountId)];
    return c && Date.parse(c.until) > this.clock.now().getTime() ? c : null;
  }
  async set(family: string, accountId: string, cooldown: AccountCooldown): Promise<void> {
    this.entries[cooldownKey(family, accountId)] = cooldown;
  }
  list(): Record<string, AccountCooldown> {
    const now = this.clock.now().getTime();
    return Object.fromEntries(Object.entries(this.entries).filter(([, c]) => Date.parse(c.until) > now));
  }
}

export function staticUsage(usage: UsageResponse = { agents: [] }): UsageReader & { current: UsageResponse } {
  const reader = { current: usage, snapshot: () => reader.current };
  return reader;
}

export function staticAccounts(host: Pick<FakeChatHost, "accounts" | "defaults">): AccountsReader {
  return {
    list: (): AgentAccountsResponse => ({ accounts: host.accounts, defaults: host.defaults })
  };
}

/** A `PromptRenderer` over saved prompts in memory; `{project}` / `{branch}` render, `{diff}` can be made to fail. */
export function fakePrompts(opts: { saved?: Record<string, { body: string; title: string }>; failVariable?: string; branch?: string } = {}): PromptRenderer {
  return {
    async render({ body, projectPath, agentLabel, modelLabel }) {
      if (opts.failVariable && body.includes(`{${opts.failVariable}}`) && !body.includes(`{{${opts.failVariable}}}`)) {
        return { ok: false, reason: `{${opts.failVariable}}: the git read failed` };
      }
      const project = projectPath.split("/").filter(Boolean).at(-1) ?? "";
      // The real renderer's escape rule (`renderPromptTemplate`), over a few values.
      const text = renderPromptTemplate(body, { project, branch: opts.branch ?? "main", agent: agentLabel ?? "", model: modelLabel ?? "" });
      return { ok: true, text };
    },
    savedPromptBody(promptId) {
      return opts.saved?.[promptId] ?? null;
    }
  };
}

export function account(agent: AgentAccount["agent"], id: string, label = id): AgentAccount {
  return { id, agent, label, email: null, plan: null, needsReauth: false, createdAt: "2026-09-01T00:00:00.000Z", importedAt: "2026-09-01T00:00:00.000Z" };
}

/** An agent node with `config` over sensible defaults (one chain entry: claude/opus, every account). */
export function agentNode(id: string, config: Partial<AgentBlockConfig> & Record<string, unknown> = {}, name = id): WorkflowNode {
  return {
    id,
    type: "agent",
    name,
    position: { x: 0, y: 0 },
    config: {
      prompt: { kind: "text", text: "Fix the bug." },
      session: { kind: "new" },
      chain: [{ agent: "claude", model: "opus", accounts: { strategy: "fixed", includeSystem: false, soonestResetWindow: "weekly", leastUsedMetric: "max", unknownUsage: "last" } }],
      autonomyNote: true,
      whenOnlyWatchLoopsRemain: "finish",
      whenAllBurnt: { kind: "fail" },
      maxMinutes: 240,
      ...config
    }
  } as WorkflowNode;
}

export function testWorkflow(nodes: WorkflowNode[], overrides: Record<string, unknown> = {}): WorkflowRecord {
  return workflowRecordSchema.parse({
    id: "wf-1",
    name: "Nightly",
    enabled: true,
    revision: 1,
    project: { kind: "existing", projectPath: "/w/ws/app" },
    settings: { timezone: "UTC" },
    nodes,
    edges: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides
  });
}

export interface FakeContextOptions {
  host: FakeChatHost;
  clock: FakeClock;
  workflow: WorkflowRecord;
  nodeId: string;
  runId?: string;
  resumeFrom?: WaitingOn;
  /** Upstream outputs by node NAME (`nodes.<Name>.output`). */
  upstream?: Record<string, unknown>;
  input?: unknown;
  trigger?: unknown;
  secrets?: Record<string, string>;
  /** Throw `SimulatedCrash` right after the Nth persist (1-based) — or after the first persist of a phase. */
  crashAt?: { persist: number } | { phase: string; occurrence?: number };
  gitStatus?: string | ((path: string) => Promise<string>);
  signal?: AbortSignal;
  services?: Partial<EngineServices>;
}

export interface FakeContext {
  ctx: NodeExecutionContext<"agent">;
  /** Every value persisted, in order (`undefined` = cleared). */
  persisted: (WaitingOn | undefined)[];
  updates: Partial<WorkflowBlockRun>[];
  /** The merged live fields. */
  live(): Partial<WorkflowBlockRun>;
  abort(): void;
}

export function createFakeContext(opts: FakeContextOptions): FakeContext {
  const node = opts.workflow.nodes.find((n) => n.id === opts.nodeId);
  if (!node || node.type !== "agent") throw new Error(`no agent node ${opts.nodeId}`);
  const persisted: (WaitingOn | undefined)[] = [];
  const updates: Partial<WorkflowBlockRun>[] = [];
  const controller = new AbortController();
  const signal = opts.signal ?? controller.signal;
  const phaseCounts = new Map<string, number>();
  const project = { path: "/w/ws/app", name: "app", workspace: "ws", temp: false };
  const nodes: Record<string, { output: unknown; status: string }> = {};
  for (const [name, output] of Object.entries(opts.upstream ?? {})) nodes[name] = { output, status: "succeeded" };
  const services: EngineServices = {
    clock: opts.clock,
    mintId: () => crypto.randomUUID(),
    chat: { api: opts.host },
    usage: staticUsage(),
    accounts: staticAccounts(opts.host),
    cooldowns: new MemoryCooldowns(opts.clock),
    sandbox: undefined as never,
    projects: {
      async resolveExisting() { return project; },
      async createTemp() { throw new Error("not simulated"); },
      async deleteProject() {},
      tempPathFor(workspace, name) { return `/w/${workspace}/${name}`; },
      async gitStatusShort(path) {
        if (typeof opts.gitStatus === "function") return opts.gitStatus(path);
        return opts.gitStatus ?? " M src/app.ts\n";
      },
      async currentBranch() { return "main"; }
    },
    prompts: fakePrompts(),
    store: undefined as never,
    runChild: undefined as never,
    awaitRun: undefined as never,
    logger: silentLogger,
    ...opts.services
  };
  const ctx: NodeExecutionContext<"agent"> = {
    runId: opts.runId ?? "run-1",
    workflow: opts.workflow,
    node: node as NodeExecutionContext<"agent">["node"],
    attempt: 1,
    signal,
    project,
    render: (template) => ({ text: template, warnings: [] }),
    renderValue: (template) => ({ value: template, warnings: [] }),
    expressionContext: () => ({
      input: opts.input ?? null,
      nodes,
      trigger: opts.trigger ?? { kind: "manual", input: null },
      run: { id: opts.runId ?? "run-1", startedAt: "2026-09-28T12:00:00.000Z", workflowId: opts.workflow.id, workflowName: opts.workflow.name, attempt: 1 },
      project: { path: project.path, name: project.name, workspace: project.workspace, branch: "main" },
      workflow: { id: opts.workflow.id, name: opts.workflow.name }
    }),
    secrets: opts.secrets ?? {},
    ...(opts.resumeFrom ? { resumeFrom: structuredClone(opts.resumeFrom) } : {}),
    async setWaitingOn(waitingOn) {
      const copy = waitingOn === undefined ? undefined : structuredClone(waitingOn);
      persisted.push(copy);
      const crash = opts.crashAt;
      if (!crash || !copy) return;
      if ("persist" in crash && persisted.length === crash.persist) throw new SimulatedCrash(copy);
      if ("phase" in crash && copy.kind === "agent" && copy.phase === crash.phase) {
        const n = (phaseCounts.get(copy.phase) ?? 0) + 1;
        phaseCounts.set(copy.phase, n);
        if (n === (crash.occurrence ?? 1)) throw new SimulatedCrash(copy);
      }
    },
    update(patch) {
      updates.push(structuredClone(patch));
    },
    async attemptDir() {
      return "/tmp/attempt";
    },
    timeoutMs: 240 * 60_000,
    depth: 0,
    services,
    log: silentLogger
  };
  return {
    ctx,
    persisted,
    updates,
    live: () => Object.assign({}, ...updates) as Partial<WorkflowBlockRun>,
    abort: () => controller.abort()
  };
}
