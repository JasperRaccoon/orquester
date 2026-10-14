/**
 * Scheduled tasks — this client's copy of the connected daemon's tasks, per chat thread
 * (`/api/scheduled-tasks?threadId=`; design 2026-10-14 §5 "Scheduling").
 *
 * One module-level store, like the saved prompts': every chat view reads the same map. It converges
 * on the daemon three ways that race freely, so every write is idempotent:
 *
 * - a **load** answers one thread and replaces exactly that thread's tasks — except one an event
 *   touched while the load was in flight (the event is newer than the answer);
 * - a **mutation** (Cancel, Run now) applies what the daemon answered, at once;
 * - every change from any client arrives on `/events` (`SCHEDULED_TASKS_CHANNEL`), routed here by
 *   the app store's `applyEvent`.
 *
 * A deleted id never comes back (ids are never reused). Per connection: `resetScheduledTasks()` runs
 * on a connection switch, and a load through another connection's client resets first. Everything
 * from the wire is shape-checked before it reaches state. No React import.
 */

import { createStore } from "zustand/vanilla";

import type {
  RunScheduledTaskResponse,
  ScheduledTask,
  ScheduledTaskListResponse,
  ScheduledTaskRunStatus,
  ScheduledTaskSchedule
} from "@orquester/api";

/** The routes this store calls — `ApiClient` satisfies it; tests pass a fake. */
export interface ScheduledTasksApi {
  readonly connection?: { readonly id: string };
  listScheduledTasks(threadId: string, signal?: AbortSignal): Promise<ScheduledTaskListResponse>;
  deleteScheduledTask(id: string): Promise<void>;
  runScheduledTaskNow(id: string): Promise<RunScheduledTaskResponse>;
}

export interface ThreadTasksLoad {
  status: "loading" | "loaded" | "error";
  error: string | null;
  /** A reconnect may have missed events: the next mount reloads. */
  stale: boolean;
}

export interface ScheduledTasksState {
  tasks: ReadonlyMap<string, ScheduledTask>;
  loads: Readonly<Record<string, ThreadTasksLoad>>;
  /** Ids with a Cancel or Run now in flight. */
  busy: ReadonlySet<string>;
  /** The last failed action per thread, until the next one. */
  notices: Readonly<Record<string, string>>;
}

const INITIAL: ScheduledTasksState = { tasks: new Map(), loads: {}, busy: new Set(), notices: {} };

export const scheduledTasksStore = createStore<ScheduledTasksState>(() => INITIAL);

let generation = 0;
let boundConnectionId: string | null = null;
const tombstones = new Set<string>();
/** Loads in flight, each with the ids an event touched meanwhile. */
const openLoads = new Set<Set<string>>();

export function resetScheduledTasks(): void {
  generation += 1;
  boundConnectionId = null;
  tombstones.clear();
  openLoads.clear();
  scheduledTasksStore.setState(INITIAL, true);
}

// ---------------------------------------------------------------------------
// Wire validation
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

function sanitizeSchedule(value: unknown): ScheduledTaskSchedule | null {
  if (!isRecord(value)) return null;
  if (value.kind === "once" && typeof value.at === "string") return { kind: "once", at: value.at };
  if (value.kind === "cron" && typeof value.cron === "string" && typeof value.timezone === "string") {
    return { kind: "cron", cron: value.cron, timezone: value.timezone };
  }
  return null;
}

const RUN_STATUSES: ReadonlySet<string> = new Set<ScheduledTaskRunStatus>(["delivered", "missed", "failed"]);

/** One task from the wire, repaired field-wise, or null when it cannot be trusted at all. */
export function sanitizeScheduledTask(value: unknown): ScheduledTask | null {
  if (!isRecord(value)) return null;
  const { id, threadId, prompt } = value;
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof threadId !== "string" || threadId.length === 0) return null;
  if (typeof prompt !== "string") return null;
  const schedule = sanitizeSchedule(value.schedule);
  if (schedule === null) return null;
  const runCount = value.runCount;
  const lastRunStatus = str(value.lastRunStatus);
  return {
    id,
    threadId,
    projectPath: str(value.projectPath) ?? "",
    prompt,
    schedule,
    enabled: value.enabled !== false,
    createdAt: str(value.createdAt) ?? "",
    updatedAt: str(value.updatedAt) ?? "",
    createdByThreadId: str(value.createdByThreadId),
    nextRunAt: str(value.nextRunAt),
    lastRunAt: str(value.lastRunAt),
    lastRunStatus: lastRunStatus !== null && RUN_STATUSES.has(lastRunStatus) ? (lastRunStatus as ScheduledTaskRunStatus) : null,
    lastRunError: str(value.lastRunError),
    runCount: typeof runCount === "number" && Number.isFinite(runCount) && runCount > 0 ? Math.floor(runCount) : 0,
    queuedAt: str(value.queuedAt)
  };
}

// ---------------------------------------------------------------------------
// Local writes
// ---------------------------------------------------------------------------

function touch(id: string): void {
  for (const touched of openLoads) touched.add(id);
}

function upsertLocal(task: ScheduledTask): void {
  if (tombstones.has(task.id)) return;
  touch(task.id);
  scheduledTasksStore.setState((state) => {
    const tasks = new Map(state.tasks);
    tasks.set(task.id, task);
    return { tasks };
  });
}

function removeLocal(id: string): void {
  tombstones.add(id);
  touch(id);
  scheduledTasksStore.setState((state) => {
    if (!state.tasks.has(id)) return state;
    const tasks = new Map(state.tasks);
    tasks.delete(id);
    return { tasks };
  });
}

/** Apply one `/events` message of `SCHEDULED_TASKS_CHANNEL`; a malformed one is ignored. */
export function applyScheduledTaskEvent(event: { type: string; payload: unknown }): void {
  if (event.type === "scheduledTask.upserted") {
    const task = sanitizeScheduledTask(event.payload);
    if (task !== null) upsertLocal(task);
    return;
  }
  if (event.type === "scheduledTask.deleted" && isRecord(event.payload) && typeof event.payload.id === "string") {
    removeLocal(event.payload.id);
  }
}

/** Every loaded thread's tasks may have missed events (a reconnect): reload on next use. */
export function markScheduledTasksStale(): void {
  scheduledTasksStore.setState((state) => ({
    loads: Object.fromEntries(Object.entries(state.loads).map(([key, load]) => [key, { ...load, stale: true }]))
  }));
}

function bindConnection(api: ScheduledTasksApi): void {
  const id = api.connection?.id;
  if (id === undefined) return;
  if (boundConnectionId !== null && boundConnectionId !== id) resetScheduledTasks();
  boundConnectionId = id;
}

function errorText(error: unknown, fallback: string): string {
  if (isRecord(error)) {
    const body = (error as { body?: unknown }).body;
    if (isRecord(body) && typeof body.message === "string" && body.message.length > 0) return body.message;
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

// ---------------------------------------------------------------------------
// Loads and actions
// ---------------------------------------------------------------------------

/** Load (or reload) one thread's tasks. */
export async function loadThreadScheduledTasks(api: ScheduledTasksApi, threadId: string): Promise<void> {
  bindConnection(api);
  const started = generation;
  const touched = new Set<string>();
  openLoads.add(touched);
  scheduledTasksStore.setState((state) => ({
    loads: { ...state.loads, [threadId]: { status: state.loads[threadId]?.status === "loaded" ? "loaded" : "loading", error: null, stale: false } }
  }));
  try {
    const response = await api.listScheduledTasks(threadId);
    if (started !== generation) return;
    if (!isRecord(response) || !Array.isArray(response.tasks)) throw new Error("The daemon answered the scheduled tasks in an unexpected shape.");
    const fresh = response.tasks.map(sanitizeScheduledTask).filter((task): task is ScheduledTask => task !== null && task.threadId === threadId);
    scheduledTasksStore.setState((state) => {
      const tasks = new Map(state.tasks);
      for (const [id, task] of state.tasks) {
        if (task.threadId === threadId && !touched.has(id)) tasks.delete(id);
      }
      for (const task of fresh) {
        if (!tombstones.has(task.id) && !touched.has(task.id)) tasks.set(task.id, task);
      }
      return { tasks, loads: { ...state.loads, [threadId]: { status: "loaded", error: null, stale: state.loads[threadId]?.stale ?? false } } };
    });
  } catch (error) {
    if (started !== generation) return;
    scheduledTasksStore.setState((state) => ({
      loads: { ...state.loads, [threadId]: { status: "error", error: errorText(error, "Couldn't load the scheduled tasks."), stale: false } }
    }));
  } finally {
    openLoads.delete(touched);
  }
}

function setBusy(id: string, on: boolean): void {
  scheduledTasksStore.setState((state) => {
    const busy = new Set(state.busy);
    if (on) busy.add(id);
    else busy.delete(id);
    return { busy };
  });
}

function setNotice(threadId: string, notice: string | null): void {
  scheduledTasksStore.setState((state) => {
    const notices = { ...state.notices };
    if (notice === null) delete notices[threadId];
    else notices[threadId] = notice;
    return { notices };
  });
}

/** Cancel = delete the task for good. */
export async function cancelScheduledTask(api: ScheduledTasksApi, task: ScheduledTask): Promise<void> {
  bindConnection(api);
  setBusy(task.id, true);
  setNotice(task.threadId, null);
  try {
    await api.deleteScheduledTask(task.id);
    removeLocal(task.id);
  } catch (error) {
    setNotice(task.threadId, `Couldn't cancel the task: ${errorText(error, "the daemon refused it")}`);
  } finally {
    setBusy(task.id, false);
  }
}

/** Send the task's prompt now (it waits for the running turn, like a scheduled run). */
export async function runScheduledTaskNow(api: ScheduledTasksApi, task: ScheduledTask): Promise<void> {
  bindConnection(api);
  setBusy(task.id, true);
  setNotice(task.threadId, null);
  try {
    const result = await api.runScheduledTaskNow(task.id);
    const fresh = isRecord(result) ? sanitizeScheduledTask(result.task) : null;
    if (fresh !== null) upsertLocal(fresh);
    else if (isRecord(result) && result.task === null) removeLocal(task.id);
  } catch (error) {
    setNotice(task.threadId, `Couldn't run the task: ${errorText(error, "the daemon refused it")}`);
  } finally {
    setBusy(task.id, false);
  }
}
