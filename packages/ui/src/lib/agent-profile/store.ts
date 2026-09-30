/**
 * Agent profile — this client's copy of the connected daemon's per-agent
 * profiles (`/api/agent-profile`, agent profile spec §7.2).
 *
 * One module-level store, like the saved prompts': every panel instance
 * (docked, a phone's section) and the editor read the same snapshots. The
 * daemon reads each agent's CLI files for every snapshot, so this copy is a
 * cache that converges three ways:
 *
 * - a **load** replaces one agent's snapshot (single-flight per agent; a
 *   forced load asked while another is in flight runs once more after it);
 * - a **mutation** replaces it with the snapshot the daemon answered (a copy:
 *   the TARGET agent's), and says what happened in the panel's `notice`;
 * - `agentProfile.changed {agent, revision}` on `/events` (routed here by the
 *   app store's `applyEvent`) refetches that agent — only when it was loaded
 *   and its revision moved.
 *
 * Every wire payload is sanitized field by field (`sanitize.ts`). A 409
 * `PROFILE_CONFLICT` refetches the agent and says so.
 *
 * Per connection: `resetAgentProfile()` runs on a connection switch and a
 * sign-out (the app store), and a call through a client of another connection
 * resets first. The last picked agent and each agent's last kind tab are
 * device preferences, persisted in localStorage (`orquester:agent-profile`)
 * and kept across a reset. No React
 * import.
 */

import { createStore } from "zustand/vanilla";

import {
  AGENT_PROFILE_AGENT_LABELS,
  AGENT_PROFILE_AGENTS,
  AGENT_PROFILE_KINDS,
  isAgentProfileAgentId,
  isProfileItemKind,
  type AgentProfileAgentId,
  type AgentProfileAgentSummary,
  type AgentProfileOverviewResponse,
  type AgentProfileSnapshot,
  type CopyProfileItemRequest,
  type ProfileConflictPolicy,
  type ProfileItem,
  type ProfileItemKind,
  type ProfileMutationResponse,
  type SetProfileItemEnabledRequest,
  type TrustProfileItemRequest
} from "@orquester/api";

import { agentProfileErrorCode, agentProfileErrorStatus, agentProfileErrorText } from "./errors";
import { sanitizeAgentProfileSnapshot, sanitizeMutationResponse, sanitizeOverview } from "./sanitize";

export { sanitizeAgentProfileSnapshot, sanitizeMutationResponse } from "./sanitize";

/** The routes this store calls — `ApiClient` satisfies it; tests pass a fake. */
export interface AgentProfileApi {
  /** The connection the client talks to; a different id resets the store. */
  readonly connection?: { readonly id: string };
  getAgentProfileOverview(signal?: AbortSignal): Promise<AgentProfileOverviewResponse>;
  getAgentProfile(agent: AgentProfileAgentId, signal?: AbortSignal): Promise<AgentProfileSnapshot>;
  setAgentProfileItemEnabled(
    agent: AgentProfileAgentId,
    id: string,
    req: SetProfileItemEnabledRequest
  ): Promise<ProfileMutationResponse>;
  deleteAgentProfileItem(agent: AgentProfileAgentId, id: string, revision: string): Promise<ProfileMutationResponse>;
  copyAgentProfileItem(agent: AgentProfileAgentId, id: string, req: CopyProfileItemRequest): Promise<ProfileMutationResponse>;
  trustAgentProfileItem(
    agent: AgentProfileAgentId,
    id: string,
    req: TrustProfileItemRequest
  ): Promise<ProfileMutationResponse>;
}

type AgentProfileLoadStatus = "idle" | "loading" | "ready" | "error";

/** One agent's snapshot and its load. */
export interface AgentProfileEntry {
  snapshot: AgentProfileSnapshot | null;
  status: AgentProfileLoadStatus;
  /** The first load's failure (`status: "error"`), or a refresh's over a snapshot still shown. */
  error: string | null;
  /** The daemon's code for that failure (`AGENT_NOT_INSTALLED`, …). */
  errorCode: string | null;
  /** Possibly out of date (a reconnect, a change event): the next load refreshes it. */
  stale: boolean;
  /** A refresh runs over a snapshot still shown. */
  refreshing: boolean;
}

interface AgentProfileOverviewEntry {
  agents: readonly AgentProfileAgentSummary[] | null;
  status: AgentProfileLoadStatus;
  error: string | null;
  stale: boolean;
}

/** The panel's one-line feedback: what a change did, or why it did not. */
export interface AgentProfileNotice {
  tone: "ok" | "error";
  text: string;
}

interface AgentProfileState {
  agents: Readonly<Record<AgentProfileAgentId, AgentProfileEntry>>;
  overview: AgentProfileOverviewEntry;
  notice: AgentProfileNotice | null;
  /** Items with a change in flight, as {@link agentProfileItemKey}. */
  pending: ReadonlySet<string>;
}

/** What a mutation came to. `code` is the daemon's (`ITEM_EXISTS` asks the caller to decide). */
type AgentProfileMutationResult =
  | { ok: true; snapshot: AgentProfileSnapshot | null; itemIds: string[]; notes: string[] }
  | { ok: false; error: string; code: string | null; status: number | null };

export const EMPTY_AGENT_PROFILE_ENTRY: AgentProfileEntry = Object.freeze({
  snapshot: null,
  status: "idle",
  error: null,
  errorCode: null,
  stale: false,
  refreshing: false
}) as AgentProfileEntry;

function initialState(): AgentProfileState {
  const agents = {} as Record<AgentProfileAgentId, AgentProfileEntry>;
  for (const agent of AGENT_PROFILE_AGENTS) agents[agent] = EMPTY_AGENT_PROFILE_ENTRY;
  return {
    agents,
    overview: { agents: null, status: "idle", error: null, stale: false },
    notice: null,
    pending: new Set()
  };
}

export const agentProfileStore = createStore<AgentProfileState>(() => initialState());

/** Said after a 409 `PROFILE_CONFLICT`: the list was refetched. */
const PROFILE_CONFLICT_NOTICE = "It changed on disk; the list was refreshed.";

export function agentProfileItemKey(agent: AgentProfileAgentId, id: string): string {
  return `${agent}\n${id}`;
}

// ---------------------------------------------------------------------------
// Module state (per connection; cleared by `resetAgentProfile`)
// ---------------------------------------------------------------------------

/** Bumped by a reset: an answer from before it is dropped, never applied. */
let generation = 0;
let boundConnectionId: string | null = null;
/** The client of the current connection — what a change event refetches through. */
let boundApi: AgentProfileApi | null = null;
const inFlight = new Map<string, Promise<void>>();
/** The one request a forced load asked for while another was in flight — shared by every such call. */
const forcedAfter = new Map<string, Promise<void>>();
/** Bumped whenever a mutation's snapshot lands: a load that started before it does not overwrite it. */
const snapshotSeq = new Map<AgentProfileAgentId, number>();
/** Bumped by `markAgentProfileStale`: a load that crossed it stays stale. */
let staleEpoch = 0;

const OVERVIEW_KEY = "overview";
const agentLoadKey = (agent: AgentProfileAgentId): string => `agent:${agent}`;

function getState(): AgentProfileState {
  return agentProfileStore.getState();
}

function agentProfileEntry(agent: AgentProfileAgentId): AgentProfileEntry {
  return getState().agents[agent] ?? EMPTY_AGENT_PROFILE_ENTRY;
}

function setEntry(agent: AgentProfileAgentId, entry: AgentProfileEntry): void {
  agentProfileStore.setState((state) => ({ agents: { ...state.agents, [agent]: entry } }));
}

function setOverview(patch: Partial<AgentProfileOverviewEntry>): void {
  agentProfileStore.setState((state) => ({ overview: { ...state.overview, ...patch } }));
}

function setPending(key: string, on: boolean): void {
  const pending = getState().pending;
  if (pending.has(key) === on) return;
  const next = new Set(pending);
  if (on) next.add(key);
  else next.delete(key);
  agentProfileStore.setState({ pending: next });
}

/** A client of another connection means another daemon's profiles: start over. */
function bindConnection(api: AgentProfileApi): void {
  const id = api.connection?.id;
  if (id !== undefined) {
    if (boundConnectionId !== null && boundConnectionId !== id) resetAgentProfile();
    boundConnectionId = id;
  }
  boundApi = api;
}

/**
 * Run `start` as the one load of `key`. Concurrent callers share it; a forced
 * call while it runs gets one more load after it (shared by every such call);
 * an unforced call with `fresh()` true asks nothing.
 */
function singleFlight(
  key: string,
  force: boolean,
  fresh: () => boolean,
  start: () => Promise<void>,
  again: () => Promise<void>
): Promise<void> {
  const pending = inFlight.get(key);
  if (pending !== undefined) {
    if (!force) return pending;
    const queued = forcedAfter.get(key);
    if (queued !== undefined) return queued;
    const gen = generation;
    const next: Promise<void> = pending.then(() => {
      if (forcedAfter.get(key) === next) forcedAfter.delete(key);
      if (gen !== generation) return undefined;
      // A load started since began after the call that forced this one.
      return inFlight.get(key) ?? again();
    });
    forcedAfter.set(key, next);
    return next;
  }
  if (!force && fresh()) return Promise.resolve();
  // Started on the next microtask, so `promise` is registered before the
  // body can settle — even when the client throws synchronously.
  const promise: Promise<void> = Promise.resolve()
    .then(start)
    .finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return promise;
}

function loadFailureText(error: unknown): string {
  if (agentProfileErrorStatus(error) === 404 && agentProfileErrorCode(error) === null) {
    return "This daemon does not support the agent profile yet — update it.";
  }
  return agentProfileErrorText(error, "The daemon did not answer.");
}

// ---------------------------------------------------------------------------
// Loads
// ---------------------------------------------------------------------------

/**
 * Load one agent's snapshot. A snapshot already loaded and not stale is not
 * asked again unless `force`. A refresh keeps the snapshot on screen
 * (`refreshing`), and a failed one keeps it too, with the error beside it.
 */
export function loadAgentProfile(
  api: AgentProfileApi,
  agent: AgentProfileAgentId,
  options?: { force?: boolean }
): Promise<void> {
  bindConnection(api);
  const force = options?.force === true;
  const again = () => loadAgentProfile(api, agent, { force: true });
  return singleFlight(
    agentLoadKey(agent),
    force,
    () => {
      const entry = agentProfileEntry(agent);
      return entry.status === "ready" && !entry.stale;
    },
    async () => {
      const gen = generation;
      const epoch = staleEpoch;
      const seq = snapshotSeq.get(agent) ?? 0;
      const before = agentProfileEntry(agent);
      setEntry(
        agent,
        before.snapshot !== null
          ? { ...before, refreshing: true }
          : { snapshot: null, status: "loading", error: null, errorCode: null, stale: false, refreshing: false }
      );
      try {
        const raw = await api.getAgentProfile(agent);
        if (gen !== generation) return;
        const snapshot = sanitizeAgentProfileSnapshot(raw);
        if (snapshot === null || snapshot.agent !== agent) {
          throw new Error("The daemon answered the profile in an unexpected shape.");
        }
        const current = agentProfileEntry(agent);
        // A mutation's snapshot landed while this was in flight: it is at
        // least as new as this answer, which may predate the change.
        const overtaken = (snapshotSeq.get(agent) ?? 0) !== seq && current.snapshot !== null;
        setEntry(agent, {
          snapshot: overtaken ? current.snapshot : snapshot,
          status: "ready",
          error: null,
          errorCode: null,
          stale: epoch !== staleEpoch,
          refreshing: false
        });
      } catch (error) {
        if (gen !== generation) return;
        const current = agentProfileEntry(agent);
        const message = loadFailureText(error);
        const code = agentProfileErrorCode(error);
        setEntry(
          agent,
          current.snapshot !== null
            ? { ...current, status: "ready", error: message, errorCode: code, stale: true, refreshing: false }
            : { snapshot: null, status: "error", error: message, errorCode: code, stale: false, refreshing: false }
        );
      }
      // A reconnect while this was in flight: the answer may predate what the
      // event stream missed — ask once more (bounded: the epoch only moves on
      // a reconnect).
      if (gen === generation && epoch !== staleEpoch) void again();
    },
    again
  );
}

/** Load the overview: which agents are installed, their versions and counts. */
export function loadAgentProfileOverview(api: AgentProfileApi, options?: { force?: boolean }): Promise<void> {
  bindConnection(api);
  const force = options?.force === true;
  const again = () => loadAgentProfileOverview(api, { force: true });
  return singleFlight(
    OVERVIEW_KEY,
    force,
    () => getState().overview.status === "ready" && !getState().overview.stale,
    async () => {
      const gen = generation;
      const epoch = staleEpoch;
      const hadAgents = getState().overview.agents !== null;
      if (!hadAgents) setOverview({ status: "loading", error: null });
      try {
        const agents = sanitizeOverview(await api.getAgentProfileOverview());
        if (gen !== generation) return;
        if (agents === null) throw new Error("The daemon answered the agent list in an unexpected shape.");
        setOverview({ agents, status: "ready", error: null, stale: epoch !== staleEpoch });
      } catch (error) {
        if (gen !== generation) return;
        setOverview(
          hadAgents
            ? { status: "ready", error: loadFailureText(error), stale: true }
            : { status: "error", error: loadFailureText(error), stale: false }
        );
      }
      if (gen === generation && epoch !== staleEpoch) void again();
    },
    again
  );
}

/**
 * Every loaded snapshot (and the overview) may be out of date — the event
 * stream was down (a reconnect) and the daemon has no replay. What is shown
 * stays; the next load refreshes it.
 */
export function markAgentProfileStale(): void {
  staleEpoch += 1;
  const state = getState();
  const agents = { ...state.agents };
  let changed = false;
  for (const agent of AGENT_PROFILE_AGENTS) {
    const entry = agents[agent];
    if (entry.status === "ready" && !entry.stale) {
      agents[agent] = { ...entry, stale: true };
      changed = true;
    }
  }
  const overview =
    state.overview.status === "ready" && !state.overview.stale ? { ...state.overview, stale: true } : state.overview;
  if (changed || overview !== state.overview) agentProfileStore.setState({ agents, overview });
}

/** Forget everything: another daemon, or a sign-out. Answers still in flight are dropped. */
export function resetAgentProfile(): void {
  generation += 1;
  boundConnectionId = null;
  boundApi = null;
  inFlight.clear();
  forcedAfter.clear();
  snapshotSeq.clear();
  agentProfileStore.setState(initialState(), true);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Apply one `/events` message of `AGENT_PROFILE_CHANNEL`. `agentProfile.changed`
 * refetches that agent when it was loaded and its revision moved (a change
 * made by hand, by a session, or by another client); a malformed payload or
 * an unknown type is ignored — never a throw into the event loop.
 */
export function applyAgentProfileEvent(event: { type: string; payload: unknown }): void {
  if (event.type !== "agentProfile.changed") return;
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null) return;
  const { agent, revision } = payload as { agent?: unknown; revision?: unknown };
  if (!isAgentProfileAgentId(agent) || typeof revision !== "string") return;
  const entry = agentProfileEntry(agent);
  if (entry.snapshot !== null && entry.snapshot.revision === revision) return;
  const state = getState();
  if (state.overview.status === "ready" && !state.overview.stale) setOverview({ stale: true });
  // A first load in flight may have been answered before this change: a
  // forced load queues one more after it (`singleFlight`).
  if (boundApi !== null && (state.overview.status === "ready" || inFlight.has(OVERVIEW_KEY))) {
    void loadAgentProfileOverview(boundApi, { force: true });
  }
  if (entry.snapshot === null) {
    if (boundApi !== null && inFlight.has(agentLoadKey(agent))) void loadAgentProfile(boundApi, agent, { force: true });
    return;
  }
  // Stale first, so a panel mounted without a bound client still refreshes it.
  if (!entry.stale) setEntry(agent, { ...entry, stale: true });
  if (boundApi !== null) void loadAgentProfile(boundApi, agent, { force: true });
}

// ---------------------------------------------------------------------------
// Notice
// ---------------------------------------------------------------------------

export function setAgentProfileNotice(notice: AgentProfileNotice | null): void {
  const current = getState().notice;
  if (current === notice || (current?.tone === notice?.tone && current?.text === notice?.text)) return;
  agentProfileStore.setState({ notice });
}

export function dismissAgentProfileNotice(): void {
  setAgentProfileNotice(null);
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Take a snapshot a mutation answered (the editor's saves go through here
 * too): it replaces that agent's, whatever a load in flight answers later.
 */
export function applyAgentProfileSnapshot(snapshot: AgentProfileSnapshot): void {
  snapshotSeq.set(snapshot.agent, (snapshotSeq.get(snapshot.agent) ?? 0) + 1);
  const current = agentProfileEntry(snapshot.agent);
  setEntry(snapshot.agent, {
    snapshot,
    status: "ready",
    error: null,
    errorCode: null,
    stale: false,
    refreshing: current.refreshing
  });
}

/** A refusal that means the list on screen is wrong: refetch the agent. */
const RELOAD_ON_CODES: readonly string[] = ["ITEM_NOT_FOUND", "CONFIG_UNREADABLE", "STASH_CONFLICT", "AGENT_NOT_INSTALLED"];

interface MutationSpec {
  /** The agent the item belongs to. */
  agent: AgentProfileAgentId;
  item: Pick<ProfileItem, "id" | "name">;
  run: () => Promise<unknown>;
  /** "Turned off jira." — the notes follow it. */
  success: string;
  /** "Couldn't turn off jira" — the daemon's reason follows it. */
  failure: string;
  /** Codes the caller answers itself (no notice), e.g. `ITEM_EXISTS` on a copy. */
  quietCodes?: readonly string[];
  /** The agent whose snapshot the answer carries (a copy: the target); defaults to `agent`. */
  answers?: AgentProfileAgentId;
}

async function mutate(api: AgentProfileApi, spec: MutationSpec): Promise<AgentProfileMutationResult> {
  bindConnection(api);
  const gen = generation;
  const key = agentProfileItemKey(spec.agent, spec.item.id);
  setPending(key, true);
  try {
    const answer = sanitizeMutationResponse(await spec.run());
    if (gen !== generation) {
      return { ok: false, error: "The connection changed before the daemon answered.", code: null, status: null };
    }
    if (answer.snapshot !== null) {
      applyAgentProfileSnapshot(answer.snapshot);
    } else {
      // An answer without a usable snapshot: our copy may be wrong.
      void loadAgentProfile(api, spec.answers ?? spec.agent, { force: true });
    }
    const notes = answer.notes.join(" ");
    setAgentProfileNotice({
      tone: "ok",
      text: notes.length > 0 ? `${spec.success} ${notes}` : `${spec.success} Applies to new sessions.`
    });
    return { ok: true, snapshot: answer.snapshot, itemIds: answer.itemIds, notes: answer.notes };
  } catch (error) {
    const code = agentProfileErrorCode(error);
    const status = agentProfileErrorStatus(error);
    const message = agentProfileErrorText(error);
    if (gen === generation) {
      if (code === "PROFILE_CONFLICT") {
        setAgentProfileNotice({ tone: "error", text: PROFILE_CONFLICT_NOTICE });
        void loadAgentProfile(api, spec.agent, { force: true });
      } else if (!(code !== null && spec.quietCodes?.includes(code))) {
        setAgentProfileNotice({ tone: "error", text: `${spec.failure}: ${message}` });
        // The item is gone or changed shape, or the agent itself is: show what is there now.
        if (RELOAD_ON_CODES.includes(code ?? "")) void loadAgentProfile(api, spec.agent, { force: true });
        if (code === "AGENT_NOT_INSTALLED") void loadAgentProfileOverview(api, { force: true });
      }
    }
    return { ok: false, error: message, code, status };
  } finally {
    if (gen === generation) setPending(key, false);
  }
}

/** Turn an item on or off. */
export function setAgentProfileItemEnabled(
  api: AgentProfileApi,
  agent: AgentProfileAgentId,
  item: ProfileItem,
  enabled: boolean
): Promise<AgentProfileMutationResult> {
  const verb = enabled ? "on" : "off";
  return mutate(api, {
    agent,
    item,
    run: () => api.setAgentProfileItemEnabled(agent, item.id, { revision: item.revision, enabled }),
    success: `Turned ${verb} ${item.name}.`,
    failure: `Couldn't turn ${verb} ${item.name}`
  });
}

export function removeAgentProfileItem(
  api: AgentProfileApi,
  agent: AgentProfileAgentId,
  item: ProfileItem
): Promise<AgentProfileMutationResult> {
  return mutate(api, {
    agent,
    item,
    run: () => api.deleteAgentProfileItem(agent, item.id, item.revision),
    success: `Deleted ${item.name}.`,
    failure: `Couldn't delete ${item.name}`
  });
}

/**
 * Copy an item to another agent. A name already taken there answers 409
 * `ITEM_EXISTS` with NO notice: the caller asks Replace / Keep both / Cancel
 * and calls again with `onConflict`.
 */
export function copyAgentProfileItem(
  api: AgentProfileApi,
  agent: AgentProfileAgentId,
  item: ProfileItem,
  toAgent: AgentProfileAgentId,
  onConflict?: ProfileConflictPolicy
): Promise<AgentProfileMutationResult> {
  const target = AGENT_PROFILE_AGENT_LABELS[toAgent];
  return mutate(api, {
    agent,
    item,
    run: async () => {
      const response = await api.copyAgentProfileItem(agent, item.id, {
        toAgent,
        ...(onConflict !== undefined ? { onConflict } : {})
      });
      // The answer is the TARGET's snapshot; make sure it lands there only.
      const parsed = sanitizeAgentProfileSnapshot((response as { snapshot?: unknown } | null)?.snapshot);
      if (parsed !== null && parsed.agent !== toAgent) return { ...response, snapshot: null };
      return response;
    },
    success: `Copied ${item.name} to ${target}.`,
    failure: `Couldn't copy ${item.name} to ${target}`,
    quietCodes: onConflict === undefined ? ["ITEM_EXISTS"] : [],
    answers: toAgent
  });
}

/** Trust a hook the agent reports modified or untrusted (Codex). */
export function trustAgentProfileItem(
  api: AgentProfileApi,
  agent: AgentProfileAgentId,
  item: ProfileItem
): Promise<AgentProfileMutationResult> {
  return mutate(api, {
    agent,
    item,
    run: () => api.trustAgentProfileItem(agent, item.id, { revision: item.revision }),
    success: `Trusted ${item.name}.`,
    failure: `Couldn't trust ${item.name}`
  });
}

// ---------------------------------------------------------------------------
// The last picked agent and each agent's last tab (device preferences)
// ---------------------------------------------------------------------------

const AGENT_PROFILE_STORAGE_KEY = "orquester:agent-profile";
const AGENT_PROFILE_PREFS_VERSION = 1;

interface AgentProfilePrefs {
  agent: AgentProfileAgentId | null;
  /** The kind tab last shown per agent — only kinds that agent has. */
  tabs: Partial<Record<AgentProfileAgentId, ProfileItemKind>>;
}

/** The browser storage methods used by device preferences. */
interface AgentProfileStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parseJsonRecord(raw: string | null | undefined): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Any stored string → valid prefs, field by field; anything unusable is the
 * default. A tab is kept only for a known agent that has that kind.
 */
function parseAgentProfilePrefs(raw: string | null | undefined): AgentProfilePrefs {
  const parsed = parseJsonRecord(raw);
  if (parsed === null) return { agent: null, tabs: {} };
  const agent = parsed.agent;
  const tabs: AgentProfilePrefs["tabs"] = {};
  const storedTabs = asRecord(parsed.tabs);
  if (storedTabs !== null) {
    for (const id of AGENT_PROFILE_AGENTS) {
      const kind = storedTabs[id];
      if (isProfileItemKind(kind) && AGENT_PROFILE_KINDS[id].includes(kind)) tabs[id] = kind;
    }
  }
  return { agent: isAgentProfileAgentId(agent) ? agent : null, tabs };
}

/**
 * The prefs to store, over whatever `previous` held: fields another bundle
 * wrote are kept, and so are its tabs for agents this one does not know
 * (AGENTS.md: preserve unknown persisted fields).
 */
function serializeAgentProfilePrefs(prefs: AgentProfilePrefs, previous?: string | null): string {
  const base = parseJsonRecord(previous) ?? {};
  const tabs = { ...(asRecord(base.tabs) ?? {}), ...prefs.tabs };
  return JSON.stringify({ ...base, v: AGENT_PROFILE_PREFS_VERSION, agent: prefs.agent, tabs });
}

/** Read on first use, so importing this module never touches storage. */
let prefsCache: AgentProfilePrefs | undefined;

function storage(): AgentProfileStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function prefs(): AgentProfilePrefs {
  if (prefsCache === undefined) {
    try {
      prefsCache = parseAgentProfilePrefs(storage()?.getItem(AGENT_PROFILE_STORAGE_KEY));
    } catch {
      prefsCache = { agent: null, tabs: {} };
    }
  }
  return prefsCache;
}

/** Keep `next`: in memory at once, in storage best-effort. */
function writePrefs(next: AgentProfilePrefs): void {
  prefsCache = next;
  try {
    const store = storage();
    if (store === null) return;
    store.setItem(AGENT_PROFILE_STORAGE_KEY, serializeAgentProfilePrefs(next, store.getItem(AGENT_PROFILE_STORAGE_KEY)));
  } catch {
    /* quota / availability: it stays in memory */
  }
}

/** The agent last picked in the panel on this device, or `null`. */
export function lastAgentProfileAgent(): AgentProfileAgentId | null {
  return prefs().agent;
}

/** Remember a pick. */
export function rememberAgentProfileAgent(agent: AgentProfileAgentId): void {
  const current = prefs();
  if (current.agent === agent) return;
  writePrefs({ ...current, agent });
}

/** The kind tab last shown for `agent` on this device, or `null`. */
export function lastAgentProfileTab(agent: AgentProfileAgentId): ProfileItemKind | null {
  return prefs().tabs[agent] ?? null;
}

/** Remember the tab shown for `agent`; a kind that agent does not have is not kept. */
export function rememberAgentProfileTab(agent: AgentProfileAgentId, kind: ProfileItemKind): void {
  if (!AGENT_PROFILE_KINDS[agent].includes(kind)) return;
  const current = prefs();
  if (current.tabs[agent] === kind) return;
  writePrefs({ ...current, tabs: { ...current.tabs, [agent]: kind } });
}
