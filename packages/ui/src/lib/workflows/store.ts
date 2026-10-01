/**
 * Automated workflows — this client's copy of the connected daemon's
 * workflows, their runs and their secret names (workflows spec §7.1, §8.1).
 *
 * One module-level store, like saved prompts: every rail panel (docked, a
 * phone's section) and the editor tab read the same maps, so a change in one
 * shows in the others without a refetch. The daemon owns the data, and this
 * copy converges on it three ways:
 *
 * - a **load** (`GET /api/workflows`, a workflow's runs, a run, the secrets);
 * - a **mutation** applies what the daemon answered, at once;
 * - every change from any client arrives on `/events` (`WORKFLOWS_CHANNEL`),
 *   routed here by the app store's `applyEvent`.
 *
 * The three race freely, so every write is idempotent and never goes
 * backwards: a deleted id never comes back, a run that ended never reads as
 * running again, a block never steps back to an earlier attempt or state, and
 * a load's answer never undoes an event that landed while it was in flight.
 *
 * Per connection: `resetWorkflows()` runs on a connection switch and a
 * sign-out (the app store), and a load through a client of another connection
 * resets first. `markWorkflowsStale()` runs on a reconnect — the event stream
 * has no replay — and the hooks reload what is on screen. No React import.
 */

import { createStore } from "zustand/vanilla";

import {
  isRunActive,
  type CreateWorkflowRequest,
  type GetWorkflowResponse,
  type GetWorkflowRunResponse,
  type ListWorkflowRunsResponse,
  type ListWorkflowSecretsResponse,
  type ListWorkflowsResponse,
  type PatchWorkflowRequest,
  type RunWorkflowRequest,
  type RunWorkflowResponse,
  type Workflow,
  type WorkflowBlockRun,
  type WorkflowBlockStatus,
  type WorkflowProblem,
  type WorkflowRun,
  type WorkflowRunSummary,
  type WorkflowSecretName,
  type WorkflowSummary,
  type WorkflowTriggerSummary,
  type WorkflowWriteResponse
} from "@orquester/api";
import { isTriggerType, workflowSummaryErrors } from "@orquester/api";

import {
  isRecord,
  sanitizeBlocks,
  sanitizeEdgeIds,
  sanitizeRunList,
  sanitizeRunSummary,
  sanitizeSecretList,
  sanitizeSummaryList,
  sanitizeWorkflowRecord,
  sanitizeWorkflowProblem,
  sanitizeWorkflowRun,
  sanitizeWorkflowSummary
} from "./sanitize";

// ---------------------------------------------------------------------------
// The routes this store calls — `ApiClient` satisfies it; tests pass a fake.
// ---------------------------------------------------------------------------

export interface WorkflowsApi {
  /** The connection the client talks to; a different id resets the store. */
  readonly connection?: { readonly id: string };
  listWorkflows(projectPath?: string | null, signal?: AbortSignal): Promise<ListWorkflowsResponse>;
  getWorkflow(id: string, signal?: AbortSignal): Promise<GetWorkflowResponse>;
  createWorkflow(req: CreateWorkflowRequest): Promise<WorkflowWriteResponse>;
  patchWorkflow(id: string, req: PatchWorkflowRequest): Promise<WorkflowWriteResponse>;
  duplicateWorkflow(id: string): Promise<WorkflowWriteResponse>;
  deleteWorkflow(id: string): Promise<void>;
  runWorkflow(id: string, req?: RunWorkflowRequest): Promise<RunWorkflowResponse>;
  listWorkflowRuns(
    id: string,
    opts?: { before?: string | null; limit?: number },
    signal?: AbortSignal
  ): Promise<ListWorkflowRunsResponse>;
  getWorkflowRun(runId: string, signal?: AbortSignal): Promise<GetWorkflowRunResponse>;
  listWorkflowSecrets(workflowId?: string | null, signal?: AbortSignal): Promise<ListWorkflowSecretsResponse>;
  setWorkflowSecret(name: string, value: string, workflowId?: string | null): Promise<void>;
  deleteWorkflowSecret(name: string, workflowId?: string | null): Promise<void>;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type WorkflowsLoadStatus = "idle" | "loading" | "loaded" | "error";

export interface WorkflowsLoad {
  status: WorkflowsLoadStatus;
  /** The first load's failure (`status: "error"`), or a refresh's over rows still shown. */
  error: string | null;
  /** A refresh is running over rows still shown. */
  refreshing: boolean;
  /** Possibly out of date (a reconnect may have missed events): the next load refreshes it. */
  stale: boolean;
}

/** A workflow's recent runs (the rail card's expansion, the editor's runs list). */
export interface WorkflowRunsList extends WorkflowsLoad {
  /** Newest first. */
  runs: WorkflowRunSummary[];
  /** The cursor for older runs; `null` = none. */
  before: string | null;
}

/**
 * One run as this client knows it. `blocks`/`takenEdges`/`deadEdges` are the
 * live overlay — the loaded run's, merged with every `workflowRun.updated`
 * delta since (or only the deltas, before the run was loaded).
 */
export interface WorkflowRunEntry {
  summary: WorkflowRunSummary;
  /** The whole run (frozen definition, trigger payload), once loaded. */
  detail: WorkflowRun | null;
  blocks: Readonly<Record<string, WorkflowBlockRun>>;
  takenEdges: readonly string[];
  deadEdges: readonly string[];
  /** The last load of the whole run failed. */
  error: string | null;
  /** The event stream was down since it was loaded (a reconnect): reload it when on screen. */
  stale?: boolean;
}

export interface WorkflowSecretsList extends WorkflowsLoad {
  secrets: WorkflowSecretName[];
}

/** The panel's notice: the last failure it could not show in place — or an overlap skip to override. */
export interface WorkflowsNotice {
  tone: "error" | "info";
  text: string;
  workflowId?: string;
  /** "Run anyway": the overlap policy skipped a Run now. */
  action?: "run-anyway";
}

export interface WorkflowsState {
  /** Every workflow this client knows, by id. */
  summaries: ReadonlyMap<string, WorkflowSummary>;
  /** The one list load (every workflow; the panel filters). */
  load: WorkflowsLoad;
  /** Enabled flips shown before the daemon answers them. */
  enabledOverrides: ReadonlyMap<string, boolean>;
  /** Per workflow id. */
  recentRuns: Readonly<Record<string, WorkflowRunsList>>;
  /** Per run id. */
  runs: Readonly<Record<string, WorkflowRunEntry>>;
  /** Per secrets scope: `"global"` or a workflow id. */
  secrets: Readonly<Record<string, WorkflowSecretsList>>;
  notice: WorkflowsNotice | null;
}

const IDLE_LOAD: WorkflowsLoad = { status: "idle", error: null, refreshing: false, stale: false };

const INITIAL: WorkflowsState = {
  summaries: new Map(),
  load: IDLE_LOAD,
  enabledOverrides: new Map(),
  recentRuns: {},
  runs: {},
  secrets: {},
  notice: null
};

export const workflowsStore = createStore<WorkflowsState>(() => INITIAL);

/** How many runs a card's expansion lists. */
export const RECENT_RUNS_LIMIT = 10;

/** The secrets scope key: `"global"`, or the workflow's id. */
export function workflowSecretsKey(workflowId: string | null | undefined): string {
  return workflowId ? `workflow:${workflowId}` : "global";
}

// ---------------------------------------------------------------------------
// Module state (per connection; cleared by `resetWorkflows`)
// ---------------------------------------------------------------------------

/** Bumped by a reset: an answer from before it is dropped, never applied. */
let generation = 0;
let boundConnectionId: string | null = null;
let listInFlight: Promise<void> | null = null;
/** The ids a change touched while the list load was in flight. */
let listTouched: Set<string> | null = null;
const runsInFlight = new Map<string, Promise<void>>();
const runInFlight = new Map<string, Promise<void>>();
const secretsInFlight = new Map<string, Promise<void>>();
/** Deleted workflow ids. An id is never reused, so none of them may come back. */
const tombstones = new Set<string>();
/** Bumped by `markWorkflowsStale`: a load that crossed it stays stale. */
let staleEpoch = 0;
let enabledSeq = 0;
const enabledTokens = new Map<string, number>();

const getState = workflowsStore.getState;

function errorText(error: unknown, fallback = "Something went wrong."): string {
  if (typeof error === "object" && error !== null) {
    const server = (error as { serverMessage?: unknown }).serverMessage;
    if (typeof server === "string" && server.trim().length > 0) return server.trim();
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) return message.trim();
  }
  return fallback;
}

function errorStatus(error: unknown): number | null {
  const status = typeof error === "object" && error !== null ? (error as { status?: unknown }).status : null;
  return typeof status === "number" ? status : null;
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") return code;
  const body = (error as { body?: unknown }).body;
  if (isRecord(body) && isRecord(body.error) && typeof body.error.code === "string") return body.error.code;
  return null;
}

function loadFailureText(error: unknown): string {
  if (errorStatus(error) === 404) return "This daemon does not support automated workflows yet — update it.";
  return errorText(error, "The daemon did not answer.");
}

/** A client of another connection means another daemon's workflows: start over. */
function bindConnection(api: WorkflowsApi): void {
  const id = api.connection?.id;
  if (id === undefined) return;
  if (boundConnectionId !== null && boundConnectionId !== id) resetWorkflows();
  boundConnectionId = id;
}

// ---------------------------------------------------------------------------
// Merge rules: nothing goes backwards
// ---------------------------------------------------------------------------

/** A run that ended never reads as running again: `incoming` replaces `current` unless it would. */
function mergeRunSummary(
  current: WorkflowRunSummary | undefined,
  incoming: WorkflowRunSummary
): WorkflowRunSummary {
  if (current === undefined) return incoming;
  if (!isRunActive(current.status) && isRunActive(incoming.status)) return current;
  return incoming;
}

const BLOCK_RANK: Record<WorkflowBlockStatus, number> = {
  pending: 0,
  queued: 1,
  running: 2,
  waiting: 2,
  succeeded: 3,
  failed: 3,
  skipped: 3,
  cancelled: 3
};

/**
 * `incoming` replaces `current` unless it is behind it: an earlier attempt, or
 * the same attempt at an earlier stage (a loaded run that predates a delta).
 */
function mergeBlock(current: WorkflowBlockRun | undefined, incoming: WorkflowBlockRun): WorkflowBlockRun {
  if (current === undefined) return incoming;
  if (incoming.attempt !== current.attempt) return incoming.attempt > current.attempt ? incoming : current;
  return BLOCK_RANK[incoming.status] >= BLOCK_RANK[current.status] ? incoming : current;
}

function mergeBlocks(
  current: Readonly<Record<string, WorkflowBlockRun>>,
  incoming: Readonly<Record<string, WorkflowBlockRun>>
): Record<string, WorkflowBlockRun> {
  const next: Record<string, WorkflowBlockRun> = { ...current };
  for (const [nodeId, block] of Object.entries(incoming)) next[nodeId] = mergeBlock(current[nodeId], block);
  return next;
}

function union(current: readonly string[], incoming: readonly string[]): string[] {
  if (incoming.length === 0) return current as string[];
  const set = new Set(current);
  for (const id of incoming) set.add(id);
  return [...set];
}

function runTime(run: WorkflowRunSummary): number {
  const time = Date.parse(run.startedAt ?? run.queuedAt);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

/** Newest first; ties by id so the order is stable. */
function byNewest(a: WorkflowRunSummary, b: WorkflowRunSummary): number {
  return runTime(b) - runTime(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/** Fold one run into a workflow's row: its active runs and its last run. */
function foldRunIntoSummary(summary: WorkflowSummary, run: WorkflowRunSummary): WorkflowSummary {
  const held = summary.activeRuns.find((entry) => entry.id === run.id);
  const merged = mergeRunSummary(held ?? (summary.lastRun?.id === run.id ? summary.lastRun : undefined), run);
  const others = summary.activeRuns.filter((entry) => entry.id !== run.id);
  const activeRuns = isRunActive(merged.status) ? [...others, merged].sort(byNewest) : others;
  const previous = summary.lastRun;
  const lastRun =
    previous === undefined || previous.id === merged.id || runTime(merged) >= runTime(previous) ? merged : previous;
  return { ...summary, activeRuns, lastRun };
}

// ---------------------------------------------------------------------------
// Local writes
// ---------------------------------------------------------------------------

function touch(id: string): void {
  listTouched?.add(id);
}

/** A summary from any source: newer revisions win; a stale one never undoes a run that ended. */
function upsertSummaryLocal(summary: WorkflowSummary): void {
  if (tombstones.has(summary.id)) return;
  touch(summary.id);
  const state = getState();
  const current = state.summaries.get(summary.id);
  if (current !== undefined && current.revision > summary.revision) return;
  let next = summary;
  // What the runs cache knows ended stays ended, whatever this row says.
  for (const run of summary.activeRuns) {
    const known = state.runs[run.id]?.summary;
    if (known !== undefined && !isRunActive(known.status)) next = foldRunIntoSummary(next, known);
  }
  const summaries = new Map(state.summaries);
  summaries.set(summary.id, next);
  workflowsStore.setState({ summaries });
}

function removeWorkflowLocal(id: string): void {
  tombstones.add(id);
  enabledTokens.delete(id);
  const state = getState();
  const summaries = new Map(state.summaries);
  summaries.delete(id);
  const enabledOverrides = new Map(state.enabledOverrides);
  enabledOverrides.delete(id);
  const recentRuns = { ...state.recentRuns };
  delete recentRuns[id];
  const secrets = { ...state.secrets };
  delete secrets[workflowSecretsKey(id)];
  const runs: Record<string, WorkflowRunEntry> = {};
  for (const [runId, entry] of Object.entries(state.runs)) {
    if (entry.summary.workflowId !== id) runs[runId] = entry;
  }
  workflowsStore.setState({ summaries, enabledOverrides, recentRuns, secrets, runs });
}

/** A run summary from an event or a load: into the run cache, its workflow's row and its recent-runs list. */
function applyRunSummary(run: WorkflowRunSummary): void {
  if (tombstones.has(run.workflowId)) return;
  const state = getState();
  const entry = state.runs[run.id];
  const summary = mergeRunSummary(entry?.summary, run);
  const runs = {
    ...state.runs,
    [run.id]: entry
      ? { ...entry, summary }
      : { summary, detail: null, blocks: {}, takenEdges: [], deadEdges: [], error: null }
  };
  const patch: Partial<WorkflowsState> = { runs };
  const row = state.summaries.get(run.workflowId);
  if (row !== undefined) {
    touch(run.workflowId);
    const summaries = new Map(state.summaries);
    summaries.set(run.workflowId, foldRunIntoSummary(row, summary));
    patch.summaries = summaries;
  }
  const recent = state.recentRuns[run.workflowId];
  if (recent !== undefined) {
    const others = recent.runs.filter((entry) => entry.id !== run.id);
    patch.recentRuns = {
      ...state.recentRuns,
      [run.workflowId]: { ...recent, runs: [...others, summary].sort(byNewest) }
    };
  }
  workflowsStore.setState(patch);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** What an event changed that the app store's tabs care about. */
export type WorkflowsEventEffect =
  | { kind: "upserted"; workflow: WorkflowSummary }
  | { kind: "deleted"; id: string }
  | null;

/**
 * Apply one `/events` message of `WORKFLOWS_CHANNEL`. A malformed payload or
 * an unknown type is ignored — never applied half-way, never a throw into the
 * event loop. Returns what the app store must mirror in its tabs.
 */
export function applyWorkflowsEvent(event: { type: string; payload: unknown }): WorkflowsEventEffect {
  const payload = isRecord(event.payload) ? event.payload : null;
  if (payload === null) return null;
  switch (event.type) {
    case "workflow.upserted": {
      const workflow = sanitizeWorkflowSummary(payload.workflow);
      if (workflow === null || tombstones.has(workflow.id)) return null;
      upsertSummaryLocal(workflow);
      return { kind: "upserted", workflow: getState().summaries.get(workflow.id) ?? workflow };
    }
    case "workflow.deleted": {
      if (typeof payload.id !== "string" || payload.id.length === 0) return null;
      removeWorkflowLocal(payload.id);
      return { kind: "deleted", id: payload.id };
    }
    case "workflowRun.started":
    case "workflowRun.finished": {
      const run = sanitizeRunSummary(payload.run);
      if (run !== null) applyRunSummary(run);
      return null;
    }
    case "workflowRun.updated": {
      const run = sanitizeRunSummary(payload.run);
      if (run === null) return null;
      applyRunSummary(run);
      const state = getState();
      const entry = state.runs[run.id];
      if (entry === undefined) return null;
      workflowsStore.setState({
        runs: {
          ...state.runs,
          [run.id]: {
            ...entry,
            blocks: mergeBlocks(entry.blocks, sanitizeBlocks(payload.blocks)),
            takenEdges: union(entry.takenEdges, sanitizeEdgeIds(payload.takenEdges)),
            deadEdges: union(entry.deadEdges, sanitizeEdgeIds(payload.deadEdges))
          }
        }
      });
      return null;
    }
    case "workflowSecrets.changed": {
      const workflowId = typeof payload.workflowId === "string" ? payload.workflowId : null;
      markSecretsStale(workflowId);
      return null;
    }
    default:
      return null;
  }
}

/** A global secret changes every scope's list (each lists the globals too); a workflow's only its own. */
function markSecretsStale(workflowId: string | null): void {
  const state = getState();
  const secrets: Record<string, WorkflowSecretsList> = {};
  let changed = false;
  for (const [key, list] of Object.entries(state.secrets)) {
    const hit = workflowId === null || key === workflowSecretsKey(workflowId);
    if (hit && !list.stale) {
      secrets[key] = { ...list, stale: true };
      changed = true;
    } else {
      secrets[key] = list;
    }
  }
  if (changed) workflowsStore.setState({ secrets });
}

// ---------------------------------------------------------------------------
// Loads
// ---------------------------------------------------------------------------

/**
 * Load every workflow's row. Concurrent callers share one request; a loaded,
 * fresh list is not asked again unless `force`. A refresh keeps the rows on
 * screen, and a failed one keeps them with the error beside them.
 */
export function loadWorkflows(api: WorkflowsApi, options?: { force?: boolean }): Promise<void> {
  bindConnection(api);
  if (listInFlight !== null) return listInFlight;
  const load = getState().load;
  if (!options?.force && load.status === "loaded" && !load.stale) return Promise.resolve();
  const gen = generation;
  const epoch = staleEpoch;
  const touched = new Set<string>();
  listTouched = touched;
  const hadRows = load.status === "loaded";
  workflowsStore.setState({
    load: hadRows ? { ...load, refreshing: true } : { status: "loading", error: null, refreshing: false, stale: false }
  });
  const promise: Promise<void> = Promise.resolve().then(async () => {
    try {
      if (gen !== generation) return;
      const response = await api.listWorkflows(null);
      if (gen !== generation) return;
      if (!isRecord(response) || !Array.isArray(response.workflows)) {
        throw new Error("The daemon answered the workflow list in an unexpected shape.");
      }
      applyLoadedList(sanitizeSummaryList(response.workflows), touched);
      workflowsStore.setState({
        load: { status: "loaded", error: null, refreshing: false, stale: epoch !== staleEpoch }
      });
    } catch (error) {
      if (gen !== generation) return;
      const message = loadFailureText(error);
      workflowsStore.setState({
        load: hadRows
          ? { status: "loaded", error: message, refreshing: false, stale: true }
          : { status: "error", error: message, refreshing: false, stale: false }
      });
    } finally {
      if (listTouched === touched) listTouched = null;
      if (listInFlight === promise) listInFlight = null;
    }
    if (gen === generation && epoch !== staleEpoch) void loadWorkflows(api, { force: true });
  });
  listInFlight = promise;
  return promise;
}

/**
 * Replace the list with the daemon's answer: a held row the answer no longer
 * lists is dropped — unless an event touched it while the load was in flight —
 * and a listed row replaces the held one unless an event touched it meanwhile
 * (then the newer revision stands).
 */
function applyLoadedList(fresh: readonly WorkflowSummary[], touched: ReadonlySet<string>): void {
  const state = getState();
  const summaries = new Map<string, WorkflowSummary>();
  for (const [id, summary] of state.summaries) {
    if (touched.has(id)) summaries.set(id, summary);
  }
  workflowsStore.setState({ summaries });
  for (const summary of fresh) {
    if (tombstones.has(summary.id)) continue;
    const held = summaries.get(summary.id);
    if (held !== undefined && touched.has(summary.id)) {
      if (held.revision >= summary.revision) continue;
    }
    upsertSummaryLocal(summary);
  }
}

/** A workflow's most recent runs (`limit` 10 by default), newest first. */
export function loadWorkflowRuns(
  api: WorkflowsApi,
  workflowId: string,
  options?: { force?: boolean; limit?: number }
): Promise<void> {
  bindConnection(api);
  const pending = runsInFlight.get(workflowId);
  if (pending !== undefined) return pending;
  const held = getState().recentRuns[workflowId];
  if (!options?.force && held?.status === "loaded" && !held.stale) return Promise.resolve();
  const gen = generation;
  const epoch = staleEpoch;
  const hadRows = held?.status === "loaded";
  const setList = (list: WorkflowRunsList) =>
    workflowsStore.setState((state) => ({ recentRuns: { ...state.recentRuns, [workflowId]: list } }));
  setList(
    hadRows
      ? { ...held, refreshing: true }
      : { status: "loading", error: null, refreshing: false, stale: false, runs: held?.runs ?? [], before: null }
  );
  const promise: Promise<void> = Promise.resolve().then(async () => {
    try {
      if (gen !== generation) return;
      const response = await api.listWorkflowRuns(workflowId, { limit: options?.limit ?? RECENT_RUNS_LIMIT });
      if (gen !== generation || tombstones.has(workflowId)) return;
      if (!isRecord(response) || !Array.isArray(response.runs)) {
        throw new Error("The daemon answered the run list in an unexpected shape.");
      }
      // A run this client holds whole learns its status from the list too (an
      // end missed while the event stream was down).
      for (const run of sanitizeRunList(response.runs)) {
        if (run.workflowId === workflowId && getState().runs[run.id] !== undefined) applyRunSummary(run);
      }
      const state = getState();
      const current = state.recentRuns[workflowId];
      const fresh = sanitizeRunList(response.runs).filter((run) => run.workflowId === workflowId);
      // An event that crossed the answer (a run that started or ended since) stands.
      const byId = new Map<string, WorkflowRunSummary>();
      for (const run of fresh) byId.set(run.id, mergeRunSummary(state.runs[run.id]?.summary, run));
      const newestFresh = fresh.reduce((max, run) => Math.max(max, runTime(run)), Number.NEGATIVE_INFINITY);
      for (const run of current?.runs ?? []) {
        if (!byId.has(run.id) && runTime(run) >= newestFresh) byId.set(run.id, run);
      }
      setList({
        status: "loaded",
        error: null,
        refreshing: false,
        stale: epoch !== staleEpoch,
        runs: [...byId.values()].sort(byNewest),
        before: typeof response.before === "string" ? response.before : null
      });
    } catch (error) {
      if (gen !== generation) return;
      const message = loadFailureText(error);
      const current = getState().recentRuns[workflowId];
      setList(
        hadRows && current
          ? { ...current, status: "loaded", error: message, refreshing: false, stale: true }
          : { status: "error", error: message, refreshing: false, stale: false, runs: current?.runs ?? [], before: null }
      );
    } finally {
      if (runsInFlight.get(workflowId) === promise) runsInFlight.delete(workflowId);
    }
  });
  runsInFlight.set(workflowId, promise);
  return promise;
}

/** One whole run (frozen definition, blocks) into `runs[runId]`, merged with the deltas already held. */
export function loadWorkflowRun(api: WorkflowsApi, runId: string, options?: { force?: boolean }): Promise<void> {
  bindConnection(api);
  const pending = runInFlight.get(runId);
  if (pending !== undefined) return pending;
  if (!options?.force && getState().runs[runId]?.detail) return Promise.resolve();
  const gen = generation;
  const promise: Promise<void> = Promise.resolve().then(async () => {
    try {
      if (gen !== generation) return;
      const response = await api.getWorkflowRun(runId);
      if (gen !== generation) return;
      const run = isRecord(response) ? sanitizeWorkflowRun(response.run) : null;
      if (run === null) throw new Error("The daemon answered the run in an unexpected shape.");
      if (tombstones.has(run.workflowId)) return;
      const { definition: _d, triggerPayload: _t, blocks, takenEdges, deadEdges, finalOutput: _f, ...summaryFields } = run;
      applyRunSummary(summaryFields);
      const state = getState();
      const entry = state.runs[runId];
      if (entry === undefined) return;
      workflowsStore.setState({
        runs: {
          ...state.runs,
          [runId]: {
            ...entry,
            detail: run,
            // The answer may predate a delta that already landed: per block, the one further along stands.
            blocks: mergeBlocks(blocks, entry.blocks),
            takenEdges: union(takenEdges, entry.takenEdges),
            deadEdges: union(deadEdges, entry.deadEdges),
            error: null,
            stale: false
          }
        }
      });
    } catch (error) {
      if (gen !== generation) return;
      const message = loadFailureText(error);
      const state = getState();
      const entry = state.runs[runId];
      if (entry !== undefined) {
        workflowsStore.setState({ runs: { ...state.runs, [runId]: { ...entry, error: message } } });
      }
    } finally {
      if (runInFlight.get(runId) === promise) runInFlight.delete(runId);
    }
  });
  runInFlight.set(runId, promise);
  return promise;
}

/** Secret names: the global ones (`workflowId` null), or the global ones plus a workflow's. */
export function loadWorkflowSecrets(
  api: WorkflowsApi,
  workflowId: string | null,
  options?: { force?: boolean }
): Promise<void> {
  bindConnection(api);
  const key = workflowSecretsKey(workflowId);
  const pending = secretsInFlight.get(key);
  if (pending !== undefined) return pending;
  const held = getState().secrets[key];
  if (!options?.force && held?.status === "loaded" && !held.stale) return Promise.resolve();
  const gen = generation;
  const hadRows = held?.status === "loaded";
  const setList = (list: WorkflowSecretsList) =>
    workflowsStore.setState((state) => ({ secrets: { ...state.secrets, [key]: list } }));
  setList(
    hadRows
      ? { ...held, refreshing: true, stale: false }
      : { status: "loading", error: null, refreshing: false, stale: false, secrets: [] }
  );
  const promise: Promise<void> = Promise.resolve().then(async () => {
    try {
      if (gen !== generation) return;
      const response = await api.listWorkflowSecrets(workflowId);
      if (gen !== generation) return;
      if (!isRecord(response) || !Array.isArray(response.secrets)) {
        throw new Error("The daemon answered the secret list in an unexpected shape.");
      }
      const current = getState().secrets[key];
      setList({
        status: "loaded",
        error: null,
        refreshing: false,
        // A change announced while this was in flight: ask again.
        stale: current?.stale ?? false,
        secrets: sanitizeSecretList(response.secrets).sort((a, b) => a.name.localeCompare(b.name))
      });
    } catch (error) {
      if (gen !== generation) return;
      const message = loadFailureText(error);
      setList(
        hadRows
          ? { ...held, status: "loaded", error: message, refreshing: false, stale: false }
          : { status: "error", error: message, refreshing: false, stale: false, secrets: [] }
      );
    } finally {
      if (secretsInFlight.get(key) === promise) secretsInFlight.delete(key);
    }
  });
  secretsInFlight.set(key, promise);
  return promise;
}

/**
 * Everything loaded may be out of date — the event stream was down (a
 * reconnect) and the daemon has no replay. The rows stay; the hooks reload
 * what is on screen in the background.
 */
export function markWorkflowsStale(): void {
  staleEpoch += 1;
  const state = getState();
  const patch: Partial<WorkflowsState> = {};
  if (state.load.status === "loaded" && !state.load.stale) patch.load = { ...state.load, stale: true };
  const recentRuns: Record<string, WorkflowRunsList> = {};
  for (const [id, list] of Object.entries(state.recentRuns)) {
    recentRuns[id] = list.status === "loaded" ? { ...list, stale: true } : list;
  }
  patch.recentRuns = recentRuns;
  const secrets: Record<string, WorkflowSecretsList> = {};
  for (const [key, list] of Object.entries(state.secrets)) {
    secrets[key] = list.status === "loaded" ? { ...list, stale: true } : list;
  }
  patch.secrets = secrets;
  // A run held whole missed its deltas (and maybe its end): the view on screen reloads it.
  let runsChanged = false;
  const runs: Record<string, WorkflowRunEntry> = {};
  for (const [id, entry] of Object.entries(state.runs)) {
    if (entry.detail !== null && !entry.stale) {
      runs[id] = { ...entry, stale: true };
      runsChanged = true;
    } else runs[id] = entry;
  }
  if (runsChanged) patch.runs = runs;
  workflowsStore.setState(patch);
}

/** Forget everything: another daemon, or a sign-out. Answers still in flight are dropped. */
export function resetWorkflows(): void {
  generation += 1;
  boundConnectionId = null;
  listInFlight = null;
  listTouched = null;
  runsInFlight.clear();
  runInFlight.clear();
  secretsInFlight.clear();
  tombstones.clear();
  enabledTokens.clear();
  workflowsStore.setState(INITIAL, true);
}

export function setWorkflowsNotice(notice: WorkflowsNotice): void {
  workflowsStore.setState({ notice });
}

export function dismissWorkflowsNotice(): void {
  if (getState().notice !== null) workflowsStore.setState({ notice: null });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export type WorkflowMutationResult<T> = { ok: true; value: T } | { ok: false; error: string; code: string | null };

const CONNECTION_CHANGED = "The connection changed before the daemon answered.";

/**
 * A row for a record the daemon just wrote — so the card shows at once; the
 * `workflow.upserted` event that follows brings the daemon's own row (trigger
 * texts, next runs) and replaces it, being of the same revision.
 */
export function summaryFromRecord(workflow: Workflow, problems: readonly WorkflowProblem[] = []): WorkflowSummary {
  const held = getState().summaries.get(workflow.id);
  const triggers: WorkflowTriggerSummary[] = workflow.nodes
    .filter((node) => isTriggerType(node.type))
    .map((node) => {
      const kept = held?.triggers.find((trigger) => trigger.nodeId === node.id);
      return kept ?? { nodeId: node.id, type: node.type, text: TRIGGER_FALLBACK_TEXT[node.type] ?? node.name };
    });
  return {
    id: workflow.id,
    name: workflow.name,
    ...(workflow.description !== undefined ? { description: workflow.description } : {}),
    enabled: workflow.enabled,
    revision: workflow.revision,
    project: workflow.project,
    triggers,
    nodeCount: workflow.nodes.length,
    ...workflowSummaryErrors(problems),
    ...(held?.lastRun ? { lastRun: held.lastRun } : {}),
    activeRuns: held?.activeRuns ?? [],
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt
  };
}

const TRIGGER_FALLBACK_TEXT: Partial<Record<string, string>> = {
  "trigger.manual": "Manual",
  "trigger.schedule": "On a schedule",
  "trigger.git": "On a git event"
};

/** A write's answer (`{workflow, problems}`), applied; `null` when it does not parse. */
function applyWriteAnswer(answer: unknown): { workflow: Workflow; problems: WorkflowProblem[] } | null {
  if (!isRecord(answer)) return null;
  const workflow = sanitizeWorkflowRecord(answer.workflow);
  if (workflow === null) return null;
  const problems = Array.isArray(answer.problems)
    ? answer.problems.map(sanitizeWorkflowProblem).filter((problem): problem is WorkflowProblem => problem !== null)
    : [];
  if (!tombstones.has(workflow.id)) upsertSummaryLocal(summaryFromRecord(workflow, problems));
  return { workflow, problems };
}

async function mutate<T>(
  api: WorkflowsApi,
  run: () => Promise<T>,
  failure: string | null
): Promise<WorkflowMutationResult<T>> {
  bindConnection(api);
  const gen = generation;
  try {
    const value = await run();
    if (gen !== generation) return { ok: false, error: CONNECTION_CHANGED, code: null };
    return { ok: true, value };
  } catch (error) {
    const message = errorText(error);
    if (gen === generation && failure !== null) {
      setWorkflowsNotice({ tone: "error", text: `${failure}: ${message}` });
    }
    return { ok: false, error: message, code: errorCode(error) };
  }
}

/** Create a workflow; its row shows at once. `quiet` leaves the failure to the caller (the New workflow form). */
export async function createWorkflow(
  api: WorkflowsApi,
  request: CreateWorkflowRequest,
  options: { quiet?: boolean } = {}
): Promise<WorkflowMutationResult<Workflow>> {
  const result = await mutate(api, () => api.createWorkflow(request), options.quiet ? null : "Couldn't create the workflow");
  if (!result.ok) return result;
  const applied = applyWriteAnswer(result.value);
  if (applied === null) {
    void loadWorkflows(api, { force: true });
    return { ok: false, error: "The daemon answered in an unexpected shape.", code: null };
  }
  return { ok: true, value: applied.workflow };
}

export async function duplicateWorkflow(api: WorkflowsApi, id: string): Promise<WorkflowMutationResult<Workflow>> {
  const result = await mutate(api, () => api.duplicateWorkflow(id), "Couldn't duplicate the workflow");
  if (!result.ok) return result;
  const applied = applyWriteAnswer(result.value);
  if (applied === null) {
    void loadWorkflows(api, { force: true });
    return { ok: false, error: "The daemon answered in an unexpected shape.", code: null };
  }
  return { ok: true, value: applied.workflow };
}

export async function deleteWorkflow(api: WorkflowsApi, id: string): Promise<WorkflowMutationResult<null>> {
  const result = await mutate(api, () => api.deleteWorkflow(id), "Couldn't delete the workflow");
  if (!result.ok) {
    // Already gone is what was asked.
    if (result.code === "WORKFLOW_NOT_FOUND") {
      removeWorkflowLocal(id);
      return { ok: true, value: null };
    }
    return result;
  }
  removeWorkflowLocal(id);
  return { ok: true, value: null };
}

function setEnabledOverride(id: string, enabled: boolean | undefined): void {
  const state = getState();
  if (state.enabledOverrides.get(id) === enabled) return;
  const enabledOverrides = new Map(state.enabledOverrides);
  if (enabled === undefined) enabledOverrides.delete(id);
  else enabledOverrides.set(id, enabled);
  workflowsStore.setState({ enabledOverrides });
}

/**
 * Enable or disable, shown at once: the flip rides `enabledOverrides` until
 * the daemon answers — the row then carries it — or refuses, when it falls
 * back and the refusal (a validation error blocks enabling) is the notice.
 * A stale revision is re-read and tried once more.
 */
export async function setWorkflowEnabled(
  api: WorkflowsApi,
  id: string,
  enabled: boolean
): Promise<WorkflowMutationResult<null>> {
  bindConnection(api);
  const summary = getState().summaries.get(id);
  if (summary === undefined) return { ok: false, error: "This workflow no longer exists.", code: "WORKFLOW_NOT_FOUND" };
  const token = ++enabledSeq;
  enabledTokens.set(id, token);
  setEnabledOverride(id, enabled);
  const gen = generation;
  const send = (revision: number) =>
    api.patchWorkflow(id, { revision, ops: [{ op: "set_enabled", enabled }] });
  let result = await mutate(api, () => send(summary.revision), null);
  if (!result.ok && result.code === "REVISION_CONFLICT" && gen === generation) {
    result = await mutate(
      api,
      async () => {
        const fresh = await api.getWorkflow(id);
        const record = isRecord(fresh) ? sanitizeWorkflowRecord(fresh.workflow) : null;
        if (record === null) throw new Error("The daemon answered in an unexpected shape.");
        return send(record.revision);
      },
      null
    );
  }
  if (gen !== generation) return { ok: false, error: CONNECTION_CHANGED, code: null };
  if (result.ok) applyWriteAnswer(result.value);
  if (enabledTokens.get(id) === token) {
    enabledTokens.delete(id);
    setEnabledOverride(id, undefined);
  }
  if (!result.ok) {
    setWorkflowsNotice({
      tone: "error",
      workflowId: id,
      text: `${enabled ? "Couldn't enable" : "Couldn't disable"} “${summary.name}”: ${result.error}`
    });
    return result;
  }
  return { ok: true, value: null };
}

/**
 * Run now. An overlap skip is not a failure: it becomes the panel's notice
 * with "Run anyway", which calls this again with `force`.
 */
export async function runWorkflowNow(
  api: WorkflowsApi,
  id: string,
  request: RunWorkflowRequest = {}
): Promise<WorkflowMutationResult<RunWorkflowResponse>> {
  const name = getState().summaries.get(id)?.name ?? "the workflow";
  const result = await mutate(api, () => api.runWorkflow(id, request), `Couldn't run “${name}”`);
  if (!result.ok) return result;
  const answer = result.value;
  if (isRecord(answer) && answer.skipped === "overlap") {
    setWorkflowsNotice({
      tone: "info",
      workflowId: id,
      action: "run-anyway",
      text: `“${name}” is already running — this run was skipped (overlap: skip).`
    });
  }
  return result;
}

export async function setWorkflowSecret(
  api: WorkflowsApi,
  name: string,
  value: string,
  workflowId: string | null
): Promise<WorkflowMutationResult<null>> {
  const result = await mutate(api, () => api.setWorkflowSecret(name, value, workflowId), null);
  if (!result.ok) return result;
  void loadWorkflowSecrets(api, workflowId, { force: true });
  return { ok: true, value: null };
}

export async function deleteWorkflowSecret(
  api: WorkflowsApi,
  name: string,
  workflowId: string | null
): Promise<WorkflowMutationResult<null>> {
  const result = await mutate(api, () => api.deleteWorkflowSecret(name, workflowId), null);
  if (!result.ok) return result;
  void loadWorkflowSecrets(api, workflowId, { force: true });
  return { ok: true, value: null };
}

/** `summary` with its pending enabled flip, if any. */
export function withEnabledOverride(
  summary: WorkflowSummary,
  overrides: ReadonlyMap<string, boolean>
): WorkflowSummary {
  const enabled = overrides.get(summary.id);
  return enabled === undefined || enabled === summary.enabled ? summary : { ...summary, enabled };
}
