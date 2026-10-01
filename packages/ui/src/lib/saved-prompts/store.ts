/**
 * Saved prompts — this client's copy of the connected daemon's list
 * (`/api/saved-prompts`).
 *
 * One module-level store, like the provider catalogue: every panel instance
 * (docked, a phone's section) and the editor read the same map, so a change in
 * one shows in the others without a refetch. The daemon owns the list, and
 * this copy converges on it three ways:
 *
 * - a **load** answers one scope — every global prompt plus one project's —
 *   and replaces exactly that scope;
 * - a **mutation** applies the record the daemon answered, at once;
 * - every change from any client arrives on `/events`
 *   (`SAVED_PROMPTS_CHANNEL`), routed here by the app store's `applyEvent`.
 *
 * The three race freely (a mutation's answer and its own event, a load and an
 * event that crossed it), so every write is idempotent and never goes
 * backwards: a record older than the one held is dropped, a deleted id is
 * never brought back, and a load's answer never undoes a change that landed
 * while it was in flight.
 *
 * Per connection: `resetSavedPrompts()` runs on a connection switch and a
 * sign-out (the app store), and a load through a client of another
 * connection resets first. No React import.
 */

import { createStore } from "zustand/vanilla";

import type {
  CreateSavedPromptRequest,
  SavedPrompt,
  SavedPromptListResponse,
  UpdateSavedPromptRequest
} from "@orquester/api";

import { savedPromptErrorStatus, savedPromptErrorText } from "./errors";
import { normalizeProjectPath } from "./list.logic";

/** The routes this store calls — `ApiClient` satisfies it; tests pass a fake. */
export interface SavedPromptsApi {
  /** The connection the client talks to; a different id resets the store. */
  readonly connection?: { readonly id: string };
  listSavedPrompts(projectPath: string | null, signal?: AbortSignal): Promise<SavedPromptListResponse>;
  createSavedPrompt(request: CreateSavedPromptRequest): Promise<SavedPrompt>;
  updateSavedPrompt(id: string, patch: UpdateSavedPromptRequest): Promise<SavedPrompt>;
  deleteSavedPrompt(id: string): Promise<void>;
  markSavedPromptUsed(id: string): Promise<SavedPrompt>;
}

export type SavedPromptsLoadStatus = "loading" | "loaded" | "error";

/** One scope's load: the global list (`"global"`) or a project's (`"project:<path>"`). */
export interface SavedPromptsLoad {
  status: SavedPromptsLoadStatus;
  /** The last failure: the first load's (`status: "error"`), or a refresh's over rows still shown. */
  error: string | null;
  /** A refresh is running over rows that are still shown. */
  refreshing: boolean;
  /** Possibly out of date (a reconnect may have missed events): the next load refreshes it. */
  stale: boolean;
}

export interface SavedPromptsState {
  /** Every prompt this client knows, by id — any scope. */
  prompts: ReadonlyMap<string, SavedPrompt>;
  loads: Readonly<Record<string, SavedPromptsLoad>>;
  /** Pin flips shown before the daemon answers them. */
  pinOverrides: ReadonlyMap<string, boolean>;
  /** The last failed change made from the panel (pin, move, delete), until dismissed. */
  notice: string | null;
}

/** A mutation's outcome. `prompt` is `null` for a delete, or an answer that did not parse. */
export type SavedPromptResult =
  | { ok: true; prompt: SavedPrompt | null }
  | { ok: false; error: string };

export interface SavedPromptMutationOptions {
  /** The caller shows the failure itself (the editor); otherwise it becomes the panel's notice. */
  quiet?: boolean;
  /** How the notice starts: "Couldn't move the prompt". */
  failure?: string;
}

const INITIAL: SavedPromptsState = {
  prompts: new Map(),
  loads: {},
  pinOverrides: new Map(),
  notice: null
};

export const savedPromptsStore = createStore<SavedPromptsState>(() => INITIAL);

// ---------------------------------------------------------------------------
// Module state (per connection; cleared by `resetSavedPrompts`)
// ---------------------------------------------------------------------------

/** Bumped by a reset: an answer from before it is dropped, never applied. */
let generation = 0;
let boundConnectionId: string | null = null;
const inFlight = new Map<string, Promise<void>>();
/** The one request a forced load asked for while another was in flight — shared by every such call. */
const forcedAfter = new Map<string, Promise<void>>();
/** The loads in flight — each remembers which ids a change touched meanwhile. */
const openLoads = new Set<Set<string>>();
/** Deleted ids. An id is never reused, so none of them may come back. */
const tombstones = new Set<string>();
/** The `projectPath` each scope was loaded with, so a reload asks the same way. */
const keyPaths = new Map<string, string | null>();
/** Bumped by `markSavedPromptsStale`: a load that crossed it stays stale. */
let staleEpoch = 0;
let pinSeq = 0;
/** The latest pin flip per id: only its own answer clears the override. */
const pinTokens = new Map<string, number>();

const GLOBAL_KEY = "global";
const PROJECT_KEY_PREFIX = "project:";

/** The load a `projectPath` means: the global list alone for none, else global + that project. */
export function savedPromptsLoadKey(projectPath: string | null): string {
  const normalized = projectPath === null ? "" : normalizeProjectPath(projectPath);
  return normalized.length === 0 ? GLOBAL_KEY : `${PROJECT_KEY_PREFIX}${normalized}`;
}

function getState(): SavedPromptsState {
  return savedPromptsStore.getState();
}

function setLoad(key: string, load: SavedPromptsLoad): void {
  savedPromptsStore.setState((state) => ({ loads: { ...state.loads, [key]: load } }));
}

// ---------------------------------------------------------------------------
// Wire validation
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * One prompt from the wire, repaired field-wise — or `null` when it cannot be
 * trusted at all (no id, no title or body, a scope that is neither global nor
 * a project). A daemon of another version may send another shape, and raw
 * JSON must never reach typed code (AGENTS.md, "Adapter/localStorage loads").
 */
function sanitizeSavedPrompt(value: unknown): SavedPrompt | null {
  if (!isRecord(value)) return null;
  const { id, title, body, projectPath } = value;
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof title !== "string" || typeof body !== "string") return null;
  // Mis-scoping is worse than dropping: a project prompt read as global would
  // show in every project.
  if (projectPath !== null && (typeof projectPath !== "string" || projectPath.length === 0)) {
    return null;
  }
  const useCount = value.useCount;
  return {
    id,
    title,
    description: typeof value.description === "string" ? value.description : "",
    body,
    tags: Array.isArray(value.tags)
      ? value.tags.filter((tag): tag is string => typeof tag === "string" && tag.length > 0)
      : [],
    projectPath,
    pinned: value.pinned === true,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
    lastUsedAt: typeof value.lastUsedAt === "string" ? value.lastUsedAt : null,
    useCount:
      typeof useCount === "number" && Number.isFinite(useCount) && useCount > 0
        ? Math.floor(useCount)
        : 0
  };
}

function readListResponse(response: unknown): SavedPrompt[] {
  if (!isRecord(response) || !Array.isArray(response.prompts)) {
    throw new Error("The daemon answered the saved-prompt list in an unexpected shape.");
  }
  const prompts: SavedPrompt[] = [];
  for (const raw of response.prompts) {
    const prompt = sanitizeSavedPrompt(raw);
    if (prompt !== null) prompts.push(prompt);
  }
  return prompts;
}

// ---------------------------------------------------------------------------
// Versions: a write never goes backwards
// ---------------------------------------------------------------------------

function timeOf(value: string | null): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const time = Date.parse(value);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

function compare(a: number, b: number): number {
  return a === b ? 0 : a > b ? 1 : -1;
}

/** > 0 when `a` is the newer record: a later edit, else a later use. */
function compareVersions(a: SavedPrompt, b: SavedPrompt): number {
  return (
    compare(timeOf(a.updatedAt), timeOf(b.updatedAt)) ||
    compare(timeOf(a.lastUsedAt), timeOf(b.lastUsedAt)) ||
    compare(a.useCount, b.useCount)
  );
}

function samePrompt(a: SavedPrompt, b: SavedPrompt): boolean {
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.description === b.description &&
    a.body === b.body &&
    a.projectPath === b.projectPath &&
    a.pinned === b.pinned &&
    a.createdAt === b.createdAt &&
    a.updatedAt === b.updatedAt &&
    a.lastUsedAt === b.lastUsedAt &&
    a.useCount === b.useCount &&
    a.tags.length === b.tags.length &&
    a.tags.every((tag, index) => tag === b.tags[index])
  );
}

/** Keep `current` over `incoming` — it is newer, or the same record. */
function keepCurrent(current: SavedPrompt | undefined, incoming: SavedPrompt): current is SavedPrompt {
  return current !== undefined && (compareVersions(current, incoming) > 0 || samePrompt(current, incoming));
}

function upsertLocal(prompt: SavedPrompt): void {
  if (tombstones.has(prompt.id)) return;
  for (const touched of openLoads) touched.add(prompt.id);
  const state = getState();
  if (keepCurrent(state.prompts.get(prompt.id), prompt)) return;
  const prompts = new Map(state.prompts);
  prompts.set(prompt.id, prompt);
  savedPromptsStore.setState({ prompts });
}

function removeLocal(id: string): void {
  tombstones.add(id);
  pinTokens.delete(id);
  const state = getState();
  if (!state.prompts.has(id) && !state.pinOverrides.has(id)) return;
  const prompts = new Map(state.prompts);
  prompts.delete(id);
  const pinOverrides = new Map(state.pinOverrides);
  pinOverrides.delete(id);
  savedPromptsStore.setState({ prompts, pinOverrides });
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Apply one `/events` message of `SAVED_PROMPTS_CHANNEL`. A malformed payload
 * or an unknown type is ignored — never applied half-way, never a throw into
 * the event loop.
 */
export function applySavedPromptEvent(event: { type: string; payload: unknown }): void {
  if (event.type === "savedPrompt.upserted") {
    const prompt = sanitizeSavedPrompt(event.payload);
    if (prompt !== null) upsertLocal(prompt);
    return;
  }
  if (event.type === "savedPrompt.deleted") {
    const payload = event.payload;
    if (isRecord(payload) && typeof payload.id === "string" && payload.id.length > 0) {
      removeLocal(payload.id);
    }
  }
}

// ---------------------------------------------------------------------------
// Loads
// ---------------------------------------------------------------------------

/** A client of another connection means another daemon's list: start over. */
function bindConnection(api: SavedPromptsApi): void {
  const id = api.connection?.id;
  if (id === undefined) return;
  if (boundConnectionId !== null && boundConnectionId !== id) resetSavedPrompts();
  boundConnectionId = id;
}

/**
 * Replace one scope with the daemon's answer: every held prompt of the scope
 * the answer no longer lists is dropped — unless a change touched it while the
 * load was in flight (an event can overtake the answer it is newer than) — and
 * every listed prompt is taken, deleted ones aside. Versions are compared only
 * for an id a change touched meanwhile; any other id takes the answer as it
 * is, so a reload repairs a held copy whatever its timestamps say (a daemon
 * clock stepped back must not pin a stale copy forever).
 */
function applyLoaded(key: string, fresh: readonly SavedPrompt[], touched: ReadonlySet<string>): void {
  const scopePath = key === GLOBAL_KEY ? null : key.slice(PROJECT_KEY_PREFIX.length);
  const inScope = (prompt: SavedPrompt): boolean =>
    prompt.projectPath === null ||
    (scopePath !== null && normalizeProjectPath(prompt.projectPath) === scopePath);
  const state = getState();
  const prompts = new Map<string, SavedPrompt>();
  for (const [id, prompt] of state.prompts) {
    if (!inScope(prompt) || touched.has(id)) prompts.set(id, prompt);
  }
  for (const prompt of fresh) {
    if (tombstones.has(prompt.id)) continue;
    const current = state.prompts.get(prompt.id);
    const keep = touched.has(prompt.id)
      ? keepCurrent(current, prompt)
      : current !== undefined && samePrompt(current, prompt);
    // The held object when it stands — the same record keeps its identity (and its search cache).
    prompts.set(prompt.id, keep && current !== undefined ? current : prompt);
  }
  savedPromptsStore.setState({ prompts });
}

function loadFailureText(error: unknown): string {
  if (savedPromptErrorStatus(error) === 404) {
    return "This daemon does not support saved prompts yet — update it.";
  }
  return savedPromptErrorText(error, "The daemon did not answer.");
}

/**
 * The daemon refused a PROJECT list (400 — `INVALID_PROJECT_PATH`: the
 * directory is gone, or is no project). The global list does not depend on
 * it, so it is loaded on its own and stays usable; this says why the
 * project's own are missing.
 */
function refusedProjectText(error: unknown): string {
  const reason = savedPromptErrorText(error, "the daemon refused this project");
  return `${reason} — only global prompts are listed.`;
}

/**
 * Load a scope: every global prompt, plus `projectPath`'s own when given.
 * Concurrent callers share one request; a scope already loaded and not stale
 * is not asked again unless `force`. A refresh keeps the rows on screen
 * (`refreshing`) and a failed one keeps them too, with the error beside them.
 */
export function loadSavedPrompts(
  api: SavedPromptsApi,
  projectPath: string | null,
  options?: { force?: boolean }
): Promise<void> {
  bindConnection(api);
  const key = savedPromptsLoadKey(projectPath);
  const pending = inFlight.get(key);
  if (pending !== undefined) {
    if (!options?.force) return pending;
    // Forced — after a failed change, a Retry — it must see the daemon as it
    // is NOW, and the answer in flight may predate what forced it: one more
    // request follows that one, shared by every forced call made meanwhile.
    const queued = forcedAfter.get(key);
    if (queued !== undefined) return queued;
    const gen = generation;
    const next: Promise<void> = pending.then(() => {
      if (forcedAfter.get(key) === next) forcedAfter.delete(key);
      if (gen !== generation) return undefined;
      // A load started since (a reconnect's follow-up) began after the call
      // that forced this one, so joining it is as fresh as asking again.
      return inFlight.get(key) ?? loadSavedPrompts(api, projectPath, { force: true });
    });
    forcedAfter.set(key, next);
    return next;
  }
  const entry = getState().loads[key];
  if (!options?.force && entry?.status === "loaded" && !entry.stale) return Promise.resolve();

  const requestPath = key === GLOBAL_KEY ? null : projectPath;
  keyPaths.set(key, requestPath);
  const gen = generation;
  const epoch = staleEpoch;
  const touched = new Set<string>();
  openLoads.add(touched);
  const hadRows = entry?.status === "loaded";
  setLoad(
    key,
    hadRows
      ? { ...entry, refreshing: true }
      : { status: "loading", error: null, refreshing: false, stale: false }
  );

  // Started on the next microtask, so `promise` is registered before the body
  // can settle — even when the client throws synchronously.
  const promise: Promise<void> = Promise.resolve().then(async () => {
    let fallBackToGlobal = false;
    try {
      // Reset before the request left: another connection's, never sent.
      if (gen !== generation) return;
      const response = await api.listSavedPrompts(requestPath);
      if (gen !== generation) return;
      applyLoaded(key, readListResponse(response), touched);
      setLoad(key, { status: "loaded", error: null, refreshing: false, stale: epoch !== staleEpoch });
    } catch (error) {
      if (gen !== generation) return;
      fallBackToGlobal = key !== GLOBAL_KEY && savedPromptErrorStatus(error) === 400;
      const message = fallBackToGlobal ? refusedProjectText(error) : loadFailureText(error);
      setLoad(
        key,
        hadRows
          ? { status: "loaded", error: message, refreshing: false, stale: true }
          : { status: "error", error: message, refreshing: false, stale: false }
      );
    } finally {
      openLoads.delete(touched);
      if (inFlight.get(key) === promise) inFlight.delete(key);
    }
    if (gen !== generation) return;
    if (fallBackToGlobal) {
      void loadSavedPrompts(api, null);
    } else if (epoch !== staleEpoch) {
      // A reconnect while this was in flight: the answer may predate what the
      // stream missed, and the reconnect's own load joined this one — so ask
      // once more. Bounded: the epoch only moves on a reconnect.
      void loadSavedPrompts(api, projectPath, { force: true });
    }
  });
  inFlight.set(key, promise);
  return promise;
}

/** Refresh every scope this client has asked for — after a failed change, which may mean the copy is wrong. */
function reloadSavedPrompts(api: SavedPromptsApi): Promise<void> {
  const keys = Object.keys(getState().loads);
  return Promise.all(
    keys.map((key) =>
      loadSavedPrompts(api, key === GLOBAL_KEY ? null : (keyPaths.get(key) ?? null), { force: true })
    )
  ).then(() => undefined);
}

/**
 * Every loaded scope may be out of date — the event stream was down (a
 * reconnect) and the daemon has no replay. The rows stay; the next load of
 * each scope refreshes it in the background.
 */
export function markSavedPromptsStale(): void {
  staleEpoch += 1;
  const loads = getState().loads;
  let changed = false;
  const next: Record<string, SavedPromptsLoad> = {};
  for (const [key, load] of Object.entries(loads)) {
    if (load.status === "loaded" && !load.stale) {
      next[key] = { ...load, stale: true };
      changed = true;
    } else {
      next[key] = load;
    }
  }
  if (changed) savedPromptsStore.setState({ loads: next });
}

/** Forget everything: another daemon, or a sign-out. Answers still in flight are dropped. */
export function resetSavedPrompts(): void {
  generation += 1;
  boundConnectionId = null;
  inFlight.clear();
  forcedAfter.clear();
  openLoads.clear();
  tombstones.clear();
  keyPaths.clear();
  pinTokens.clear();
  savedPromptsStore.setState(INITIAL, true);
}

/** Show `text` as the panel's notice: a failure no open surface can show (an editor closed while it saved). */
export function setSavedPromptsNotice(text: string): void {
  if (getState().notice !== text) savedPromptsStore.setState({ notice: text });
}

export function dismissSavedPromptsNotice(): void {
  if (getState().notice !== null) savedPromptsStore.setState({ notice: null });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

async function mutate(
  api: SavedPromptsApi,
  run: () => Promise<unknown>,
  apply: (answer: unknown) => SavedPrompt | null,
  options: SavedPromptMutationOptions & { reloadOnFailure?: boolean }
): Promise<SavedPromptResult> {
  bindConnection(api);
  const gen = generation;
  try {
    const answer = await run();
    if (gen !== generation) return { ok: false, error: "The connection changed before the daemon answered." };
    return { ok: true, prompt: apply(answer) };
  } catch (error) {
    const message = savedPromptErrorText(error);
    if (gen === generation) {
      if (!options.quiet) {
        savedPromptsStore.setState({
          notice: `${options.failure ?? "Couldn't save the change"}: ${message}`
        });
      }
      if (options.reloadOnFailure !== false) void reloadSavedPrompts(api);
    }
    return { ok: false, error: message };
  }
}

/** Apply a record the daemon answered; an answer that does not parse means our copy may be wrong. */
function applyAnswer(api: SavedPromptsApi): (answer: unknown) => SavedPrompt | null {
  return (answer) => {
    const prompt = sanitizeSavedPrompt(answer);
    if (prompt === null) {
      void reloadSavedPrompts(api);
      return null;
    }
    upsertLocal(prompt);
    return prompt;
  };
}

export function createSavedPrompt(
  api: SavedPromptsApi,
  request: CreateSavedPromptRequest,
  options: SavedPromptMutationOptions = {}
): Promise<SavedPromptResult> {
  return mutate(api, () => api.createSavedPrompt(request), applyAnswer(api), {
    failure: "Couldn't save the prompt",
    ...options
  });
}

/** Send only the fields that changed; `projectPath` moves a prompt between global and a project. */
export function updateSavedPrompt(
  api: SavedPromptsApi,
  id: string,
  patch: UpdateSavedPromptRequest,
  options: SavedPromptMutationOptions = {}
): Promise<SavedPromptResult> {
  return mutate(api, () => api.updateSavedPrompt(id, patch), applyAnswer(api), {
    failure: "Couldn't update the prompt",
    ...options
  });
}

export function removeSavedPrompt(
  api: SavedPromptsApi,
  id: string,
  options: SavedPromptMutationOptions = {}
): Promise<SavedPromptResult> {
  return mutate(
    api,
    () => api.deleteSavedPrompt(id),
    () => {
      removeLocal(id);
      return null;
    },
    { failure: "Couldn't delete the prompt", ...options }
  );
}

function setPinOverride(id: string, pinned: boolean | undefined): void {
  const state = getState();
  if (state.pinOverrides.get(id) === pinned) return;
  const pinOverrides = new Map(state.pinOverrides);
  if (pinned === undefined) pinOverrides.delete(id);
  else pinOverrides.set(id, pinned);
  savedPromptsStore.setState({ pinOverrides });
}

/**
 * Pin or unpin, shown at once: the flip rides `pinOverrides` until the daemon
 * answers — the record then carries it — or refuses, when it falls back to the
 * held value and the refusal becomes the notice.
 */
export async function toggleSavedPromptPin(
  api: SavedPromptsApi,
  id: string,
  options: SavedPromptMutationOptions = {}
): Promise<SavedPromptResult> {
  const state = getState();
  const prompt = state.prompts.get(id);
  if (prompt === undefined) return { ok: false, error: "This prompt no longer exists." };
  const pinned = !(state.pinOverrides.get(id) ?? prompt.pinned);
  const token = ++pinSeq;
  pinTokens.set(id, token);
  setPinOverride(id, pinned);
  const gen = generation;
  const result = await updateSavedPrompt(api, id, { pinned }, {
    failure: pinned ? "Couldn't pin the prompt" : "Couldn't unpin the prompt",
    ...options
  });
  if (gen === generation && pinTokens.get(id) === token) {
    pinTokens.delete(id);
    setPinOverride(id, undefined);
  }
  return result;
}

/**
 * An Insert or a Send used the prompt (`lastUsedAt`, `useCount`). Fire and
 * forget: a failed bump changes nothing the user can see, so it is neither a
 * notice nor a reason to reload.
 */
export function markSavedPromptUsed(api: SavedPromptsApi, id: string): Promise<SavedPromptResult> {
  return mutate(api, () => api.markSavedPromptUsed(id), applyAnswer(api), {
    quiet: true,
    reloadOnFailure: false
  });
}

/** `prompt` with its pending pin flip, if any. */
export function withPinOverride(
  prompt: SavedPrompt,
  pinOverrides: ReadonlyMap<string, boolean>
): SavedPrompt {
  const pinned = pinOverrides.get(prompt.id);
  return pinned === undefined || pinned === prompt.pinned ? prompt : { ...prompt, pinned };
}
