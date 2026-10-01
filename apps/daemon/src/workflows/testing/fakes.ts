// Automated workflows — in-memory fakes of the engine's neighbours, for tests (never imported by
// production code). The RunStore fake is faithful to the contract: deep copies in and out,
// `listUnfinished` by status, newest-first pages with a `before` cursor, active/latest summaries.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  defaultNodeConfig,
  isRunActive,
  type ListWorkflowRunsResponse,
  type Workflow,
  type WorkflowNode,
  type WorkflowNodeType,
  type WorkflowRunSummary,
  type WorkflowSecretName
} from "@orquester/api";
import { workflowRecordSchema as configRecordSchema } from "@orquester/config";

import type {
  Clock,
  NodeExecutionContext,
  NodeExecutor,
  NodeResult,
  PersistedRun,
  ProjectContext,
  ProjectOps,
  RunStore,
  SandboxExit,
  SandboxHandle,
  SandboxRunner,
  SandboxSpawnRequest,
  SecretStore,
  WorkflowLogger,
  WorkflowStore
} from "../contracts.ts";
import { toRunSummary } from "../run-context.ts";

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** Lets every pending promise chain run (macrotask turns; no wall-clock wait). */
export async function flush(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

interface ManualTimer {
  at: number;
  seq: number;
  fn: () => void;
  cancelled: boolean;
}

/** A clock that only moves when told to; timers fire in order, promise chains settling between them. */
export class ManualClock implements Clock {
  private current: number;
  private timers: ManualTimer[] = [];
  private seq = 0;

  constructor(start = "2026-09-28T10:00:00.000Z") {
    this.current = Date.parse(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  setTimeout(fn: () => void, ms: number): { cancel(): void } {
    const timer: ManualTimer = { at: this.current + Math.max(0, ms), seq: this.seq++, fn, cancelled: false };
    this.timers.push(timer);
    return {
      cancel: () => {
        timer.cancelled = true;
      }
    };
  }

  /** Move time forward by `ms`, firing every timer due on the way (and those they arm within the window). */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    await flush();
    for (;;) {
      const due = this.timers
        .filter((timer) => !timer.cancelled && timer.at <= target)
        .sort((x, y) => x.at - y.at || x.seq - y.seq)[0];
      if (!due) break;
      this.current = Math.max(this.current, due.at);
      due.cancelled = true;
      this.timers = this.timers.filter((timer) => timer !== due);
      due.fn();
      await flush();
    }
    this.current = target;
    this.timers = this.timers.filter((timer) => !timer.cancelled);
    await flush();
  }

  /** Jump the wall clock without firing anything (a daemon that was down). */
  jump(ms: number): void {
    this.current += ms;
  }
}

export function silentLogger(): WorkflowLogger & { lines: { level: string; msg: string; meta?: Record<string, unknown> }[] } {
  const lines: { level: string; msg: string; meta?: Record<string, unknown> }[] = [];
  const at = (level: string) => (msg: string, meta?: Record<string, unknown>) => {
    lines.push(meta === undefined ? { level, msg } : { level, msg, meta });
  };
  return { lines, debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

export function sequentialIds(prefix = "id"): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}-${String(n).padStart(4, "0")}`;
  };
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export function node(
  id: string,
  type: WorkflowNodeType,
  config: Record<string, unknown> = {},
  extra: Partial<Omit<WorkflowNode, "config" | "type" | "id">> = {}
): WorkflowNode {
  return {
    id,
    type,
    name: extra.name ?? id,
    position: { x: 0, y: 0 },
    ...extra,
    config: { ...(defaultNodeConfig(type) as Record<string, unknown>), ...config }
  } as WorkflowNode;
}

export function edge(source: string, target: string, sourceHandle = "success", id?: string) {
  return { id: id ?? `${source}-${sourceHandle}-${target}`, source, target, sourceHandle };
}

export function workflow(
  id: string,
  nodes: WorkflowNode[],
  edges: ReturnType<typeof edge>[] = [],
  overrides: Record<string, unknown> = {}
): Workflow {
  return configRecordSchema.parse({
    id,
    name: overrides.name ?? `Workflow ${id}`,
    enabled: true,
    revision: 1,
    project: { kind: "existing", projectPath: "/w/ws/app" },
    settings: { timezone: "UTC", ...((overrides.settings as Record<string, unknown>) ?? {}) },
    nodes,
    edges,
    createdAt: "2026-09-28T09:00:00.000Z",
    updatedAt: "2026-09-28T09:00:00.000Z",
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "settings" && key !== "name"))
  }) as Workflow;
}

export class InMemoryWorkflowStore implements WorkflowStore {
  private readonly records = new Map<string, Workflow>();
  private readonly changed = new Set<(workflow: Workflow) => void>();
  private readonly deleted = new Set<(id: string) => void>();

  constructor(initial: Workflow[] = []) {
    for (const record of initial) this.records.set(record.id, structuredClone(record));
  }

  list(): Workflow[] {
    return [...this.records.values()].map((record) => structuredClone(record));
  }

  get(id: string): Workflow | null {
    const record = this.records.get(id);
    return record ? structuredClone(record) : null;
  }

  put(record: Workflow): void {
    this.records.set(record.id, structuredClone(record));
    for (const listener of this.changed) listener(structuredClone(record));
  }

  remove(id: string): void {
    this.records.delete(id);
    for (const listener of this.deleted) listener(id);
  }

  onChanged(listener: (workflow: Workflow) => void): () => void {
    this.changed.add(listener);
    return () => this.changed.delete(listener);
  }

  onDeleted(listener: (id: string) => void): () => void {
    this.deleted.add(listener);
    return () => this.deleted.delete(listener);
  }
}

export class InMemorySecretStore implements SecretStore {
  readonly global = new Map<string, string>();
  readonly scoped = new Map<string, Map<string, string>>();

  list(workflowId?: string): WorkflowSecretName[] {
    const out: WorkflowSecretName[] = [];
    for (const [name, value] of this.global) out.push({ name, scope: "global", updatedAt: "2026-09-28T09:00:00.000Z", short: value.length < 4 });
    if (workflowId) {
      for (const [name, value] of this.scoped.get(workflowId) ?? []) {
        out.push({ name, scope: "workflow", workflowId, updatedAt: "2026-09-28T09:00:00.000Z", short: value.length < 4 });
      }
    }
    return out;
  }

  resolve(workflowId: string): Record<string, string> {
    return { ...Object.fromEntries(this.global), ...Object.fromEntries(this.scoped.get(workflowId) ?? []) };
  }

  async set(name: string, value: string, workflowId?: string): Promise<void> {
    if (workflowId === undefined) this.global.set(name, value);
    else {
      const map = this.scoped.get(workflowId) ?? new Map<string, string>();
      map.set(name, value);
      this.scoped.set(workflowId, map);
    }
  }

  async delete(name: string, workflowId?: string): Promise<boolean> {
    return workflowId === undefined ? this.global.delete(name) : (this.scoped.get(workflowId)?.delete(name) ?? false);
  }

  async deleteForWorkflow(workflowId: string): Promise<void> {
    this.scoped.delete(workflowId);
  }
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export class InMemoryRunStore implements RunStore {
  readonly runs = new Map<string, PersistedRun>();
  readonly events = new Map<string, Record<string, unknown>[]>();
  readonly files = new Map<string, unknown>();
  /** With a root, `attemptDir` creates real directories (for the real sandbox). */
  constructor(private readonly root?: string) {}

  async create(run: PersistedRun): Promise<void> {
    if (this.runs.has(run.id)) throw new Error(`run ${run.id} exists`);
    this.runs.set(run.id, structuredClone(run));
  }

  async save(run: PersistedRun): Promise<void> {
    this.runs.set(run.id, structuredClone(run));
  }

  async load(runId: string): Promise<PersistedRun | null> {
    const run = this.runs.get(runId);
    return run ? structuredClone(run) : null;
  }

  async listUnfinished(): Promise<PersistedRun[]> {
    return [...this.runs.values()].filter((run) => isRunActive(run.status)).map((run) => structuredClone(run));
  }

  private sorted(workflowId: string): PersistedRun[] {
    return [...this.runs.values()]
      .filter((run) => run.workflowId === workflowId)
      .sort((x, y) => (x.queuedAt < y.queuedAt ? 1 : x.queuedAt > y.queuedAt ? -1 : x.id < y.id ? 1 : -1));
  }

  async listForWorkflow(workflowId: string, opts: { before?: string; limit: number }): Promise<ListWorkflowRunsResponse> {
    let runs = this.sorted(workflowId);
    if (opts.before !== undefined) {
      const index = runs.findIndex((run) => run.id === opts.before);
      runs = index >= 0 ? runs.slice(index + 1) : [];
    }
    const page = runs.slice(0, opts.limit);
    return { runs: page.map(toRunSummary), before: runs.length > opts.limit ? page[page.length - 1]!.id : null };
  }

  latestForWorkflow(workflowId: string): WorkflowRunSummary | undefined {
    const run = this.sorted(workflowId)[0];
    return run ? toRunSummary(run) : undefined;
  }

  activeForWorkflow(workflowId: string): WorkflowRunSummary[] {
    return this.sorted(workflowId).filter((run) => isRunActive(run.status)).map(toRunSummary);
  }

  async appendEvent(runId: string, event: Record<string, unknown>): Promise<void> {
    const list = this.events.get(runId) ?? [];
    list.push(structuredClone(event));
    this.events.set(runId, list);
  }

  async attemptDir(runId: string, nodeId: string, attempt: number): Promise<string> {
    const dir = join(this.root ?? "/mem/workflow-runs", runId, "nodes", nodeId, String(attempt));
    if (this.root) await mkdir(dir, { recursive: true });
    return dir;
  }

  async writeOutputFile(runId: string, nodeId: string, attempt: number, output: unknown): Promise<string> {
    const path = join(this.root ?? "/mem/workflow-runs", runId, "nodes", nodeId, String(attempt), "output.json");
    this.files.set(path, structuredClone(output));
    return path;
  }

  async readOutputFile(path: string): Promise<unknown> {
    if (!this.files.has(path)) throw new Error(`no output file ${path}`);
    return structuredClone(this.files.get(path));
  }

  async deleteForWorkflow(workflowId: string, options: { keep?: ReadonlySet<string> } = {}): Promise<void> {
    for (const [id, run] of this.runs) if (run.workflowId === workflowId && !options.keep?.has(id)) this.runs.delete(id);
  }

  workflowIds(): string[] {
    return [...new Set([...this.runs.values()].map((run) => run.workflowId))];
  }

  async sweep(): Promise<void> {
  }
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export class FakeProjects implements ProjectOps {
  readonly existing = new Set<string>(["/w/ws/app"]);
  readonly created: { workspace: string; name: string; source: unknown }[] = [];
  readonly deleted: string[] = [];
  failCreate: Error | null = null;
  branch: string | undefined = "main";

  async resolveExisting(projectPath: string): Promise<ProjectContext | null> {
    if (!this.existing.has(projectPath)) return null;
    const parts = projectPath.split("/");
    return { path: projectPath, name: parts[parts.length - 1]!, workspace: parts[parts.length - 2]!, temp: false };
  }

  async createTemp(input: { workspace: string; name: string; source: { kind: "empty" } | { kind: "clone"; url: string; ref?: string } }): Promise<ProjectContext> {
    if (this.failCreate) throw this.failCreate;
    this.created.push(structuredClone(input));
    const path = `/w/${input.workspace}/${input.name}`;
    this.existing.add(path);
    return { path, name: input.name, workspace: input.workspace, temp: true };
  }

  async deleteProject(path: string): Promise<void> {
    this.deleted.push(path);
    this.existing.delete(path);
  }

  tempPathFor(workspace: string, name: string): string {
    return `/w/${workspace}/${name}`;
  }

  async gitStatusShort(): Promise<string> {
    return "";
  }

  async currentBranch(): Promise<string | undefined> {
    return this.branch;
  }
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

interface FakeProcess {
  handle: SandboxHandle;
  request: SandboxSpawnRequest;
  alive: boolean;
  exit: SandboxExit | null;
  waiters: ((exit: SandboxExit) => void)[];
}

/** A sandbox whose processes end when the test says so. */
export class FakeSandbox implements SandboxRunner {
  readonly processes: FakeProcess[] = [];
  readonly killed: number[] = [];
  private nextPid = 1000;

  async spawn(request: SandboxSpawnRequest): Promise<SandboxHandle> {
    const handle = { pid: this.nextPid++, starttime: 42, attemptDir: request.attemptDir };
    this.processes.push({ handle, request: structuredClone(request), alive: true, exit: null, waiters: [] });
    return handle;
  }

  private find(pid: number): FakeProcess {
    const found = this.processes.find((process) => process.handle.pid === pid);
    if (!found) throw new Error(`no fake process ${pid}`);
    return found;
  }

  wait(handle: SandboxHandle, opts: { deadlineAt: Date; signal: AbortSignal; onLogs?: (bytes: { stdout: number; stderr: number }) => void }): Promise<SandboxExit> {
    const process = this.find(handle.pid);
    if (process.exit) return Promise.resolve(process.exit);
    return new Promise((resolve) => {
      process.waiters.push(resolve);
      const onAbort = (): void => {
        this.killed.push(handle.pid);
        this.finish(handle.pid, { code: null, signal: "SIGTERM", timedOut: false, stdoutBytes: 0, stderrBytes: 0, cancelled: true } as SandboxExit);
      };
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
      opts.onLogs?.({ stdout: 1, stderr: 0 });
    });
  }

  /** End a process (its exit.json is "written"). */
  finish(pid: number, exit: SandboxExit): void {
    const process = this.find(pid);
    if (process.exit) return;
    process.exit = exit;
    process.alive = false;
    for (const waiter of process.waiters.splice(0)) waiter(exit);
  }

  /** The process vanished (with or without a recorded exit) — as seen by a restarted daemon. */
  vanish(pid: number, exit: SandboxExit | null): void {
    const process = this.find(pid);
    process.alive = false;
    process.exit = exit;
  }

  last(): FakeProcess {
    const process = this.processes[this.processes.length - 1];
    if (!process) throw new Error("no process spawned");
    return process;
  }

  isAlive(handle: SandboxHandle): boolean {
    return this.processes.find((process) => process.handle.pid === handle.pid)?.alive ?? false;
  }

  async readExit(attemptDir: string): Promise<SandboxExit | null> {
    return this.processes.find((process) => process.handle.attemptDir === attemptDir)?.exit ?? null;
  }

  async readHandle(attemptDir: string): Promise<SandboxHandle | null> {
    const found = this.processes.find((process) => process.handle.attemptDir === attemptDir);
    return found ? { ...found.handle } : null;
  }

  async kill(handle: SandboxHandle): Promise<void> {
    this.killed.push(handle.pid);
    this.finish(handle.pid, { code: null, signal: "SIGTERM", timedOut: false, stdoutBytes: 0, stderrBytes: 0 });
  }
}

// ---------------------------------------------------------------------------
// Controllable executors
// ---------------------------------------------------------------------------

export interface PendingCall<T extends WorkflowNodeType = WorkflowNodeType> {
  ctx: NodeExecutionContext<T>;
  resolve(result: NodeResult): void;
}

/**
 * An executor whose every call waits for the test: `calls` lists them in order; `resolve` ends one.
 * An aborted call answers `cancelled` by itself.
 */
export function controlledExecutor<T extends WorkflowNodeType>(
  type: T
): NodeExecutor<T> & { calls: PendingCall<T>[] } {
  const calls: PendingCall<T>[] = [];
  return {
    type,
    calls,
    execute(ctx) {
      return new Promise<NodeResult>((resolve) => {
        const call: PendingCall<T> = {
          ctx,
          resolve
        };
        calls.push(call);
        ctx.signal.addEventListener("abort", () => call.resolve({ status: "cancelled" }), { once: true });
      });
    }
  };
}
