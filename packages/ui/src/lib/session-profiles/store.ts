/**
 * Agent Profiles — this client's copy of the connected daemon's profiles
 * (`sessionProfileRoutes`, agent profiles spec §5). One module-level store,
 * like the agent-config and saved-prompt ones: the rail's library and editor
 * (docked or a phone's section), the item editors and every composer's
 * profile chip read the same copy. It converges three ways:
 *
 * - a **load** replaces the list or one profile's detail (single-flight per
 *   key; a forced load asked while one is in flight runs once more after it);
 * - a **mutation** replaces the profile with the detail the daemon answered;
 *   a stale revision (409 `PROFILE_CONFLICT`) reloads the profile and says
 *   so in the notice — nothing is retried behind the user's back;
 * - `/events` on `SESSION_PROFILES_CHANNEL` (routed here by the app store's
 *   `applyEvent`): `changed` refetches what is loaded when its revision
 *   moved, `deleted` drops it, `prepareStatus` moves the readiness of the
 *   revision held.
 *
 * Every wire payload is sanitized field by field (`sanitize.ts`). Per
 * connection: `resetSessionProfiles()` runs on a connection switch and a
 * sign-out (the app store), and a call through a client of another
 * connection resets first. No React import.
 */

import { createStore } from "zustand/vanilla";

import type {
  CreateSessionProfileRequest,
  SessionProfileDetail,
  SessionProfileItem,
  SessionProfileListError,
  SessionProfileSummary,
  UpdateSessionProfileRequest
} from "@orquester/api";

import { agentProfileErrorCode, agentProfileErrorText } from "../agent-profile/errors";
import {
  sanitizePrepareStatusResponse,
  sanitizeProfileWorkflowUses,
  type ProfileWorkflowUse,
  sanitizeSessionProfileDetail,
  sanitizeSessionProfileList,
  sanitizeSessionProfileMutation
} from "./sanitize";

/** The routes this store calls — `ApiClient` satisfies it; tests pass a fake. */
export interface SessionProfilesApi {
  readonly connection?: { readonly id: string };
  listSessionProfiles(signal?: AbortSignal): Promise<unknown>;
  getSessionProfile(profileId: string, signal?: AbortSignal): Promise<unknown>;
  createSessionProfile(req: CreateSessionProfileRequest): Promise<unknown>;
  updateSessionProfile(profileId: string, req: UpdateSessionProfileRequest): Promise<unknown>;
  deleteSessionProfile(profileId: string, revision: string, options?: { expectWorkflowUses?: readonly string[] }): Promise<unknown>;
  /** The workflows using a profile (the delete confirmation's list). */
  getProfileWorkflowReferences(profileId: string, signal?: AbortSignal): Promise<unknown>;
  duplicateSessionProfile(profileId: string, req?: { name?: string }): Promise<unknown>;
  setSessionProfileItemEnabled(profileId: string, itemId: string, revision: string, enabled: boolean): Promise<unknown>;
  deleteSessionProfileItem(profileId: string, itemId: string, revision: string): Promise<unknown>;
}

type LoadStatus = "idle" | "loading" | "ready" | "error";

export interface SessionProfileListEntry {
  profiles: readonly SessionProfileSummary[] | null;
  /** Profile directories the daemon could not read. */
  errors: readonly SessionProfileListError[];
  status: LoadStatus;
  error: string | null;
  stale: boolean;
}

export interface SessionProfileDetailEntry {
  detail: SessionProfileDetail | null;
  status: LoadStatus;
  error: string | null;
  errorCode: string | null;
  stale: boolean;
}

export interface SessionProfilesNotice {
  tone: "ok" | "error";
  text: string;
}

interface SessionProfilesState {
  list: SessionProfileListEntry;
  details: Readonly<Record<string, SessionProfileDetailEntry>>;
  notice: SessionProfilesNotice | null;
  /** Item ids (and `profile:<id>` for a profile-level change) with a change in flight. */
  pending: ReadonlySet<string>;
  /** The profile the rail's panel has drilled into, or `null` for the library. */
  openProfileId: string | null;
}

export const EMPTY_LIST_ENTRY: SessionProfileListEntry = Object.freeze({
  profiles: null,
  errors: [],
  status: "idle",
  error: null,
  stale: false
});

export const EMPTY_DETAIL_ENTRY: SessionProfileDetailEntry = Object.freeze({
  detail: null,
  status: "idle",
  error: null,
  errorCode: null,
  stale: false
});

function initialState(): SessionProfilesState {
  return { list: EMPTY_LIST_ENTRY, details: {}, notice: null, pending: new Set(), openProfileId: null };
}

export const sessionProfilesStore = createStore<SessionProfilesState>(() => initialState());

const getState = () => sessionProfilesStore.getState();

// ---------------------------------------------------------------------------
// Module state (per connection; cleared by `resetSessionProfiles`)
// ---------------------------------------------------------------------------

/** The client of the current connection — what a change event refetches through. */
let boundApi: SessionProfilesApi | null = null;
let boundConnection: string | null = null;
/** Bumped by a reset: an answer from before it is dropped. */
let generation = 0;
const inFlight = new Map<string, Promise<void>>();
const queued = new Set<string>();

const LIST_KEY = "list";
const detailKey = (profileId: string) => `detail:${profileId}`;
export const profilePendingKey = (profileId: string) => `profile:${profileId}`;

/** A client of another connection means another daemon's profiles: start over. */
function bind(api: SessionProfilesApi): void {
  const id = api.connection?.id ?? null;
  if (boundApi !== null && id !== boundConnection) resetSessionProfiles();
  boundApi = api;
  boundConnection = id;
}

export function resetSessionProfiles(): void {
  generation += 1;
  boundApi = null;
  boundConnection = null;
  inFlight.clear();
  queued.clear();
  sessionProfilesStore.setState(initialState(), true);
}

/** Possibly out of date (a reconnect): the next load refreshes what was loaded. */
export function markSessionProfilesStale(): void {
  const state = getState();
  const details: Record<string, SessionProfileDetailEntry> = {};
  for (const [id, entry] of Object.entries(state.details)) details[id] = entry.detail ? { ...entry, stale: true } : entry;
  sessionProfilesStore.setState({
    list: state.list.profiles !== null ? { ...state.list, stale: true } : state.list,
    details
  });
}

function singleFlight(key: string, force: boolean, run: () => Promise<void>): Promise<void> {
  const current = inFlight.get(key);
  if (current !== undefined) {
    if (!force) return current;
    queued.add(key);
    return current;
  }
  const started = (async () => {
    try {
      await run();
    } finally {
      inFlight.delete(key);
      if (queued.delete(key)) void singleFlight(key, false, run);
    }
  })();
  inFlight.set(key, started);
  return started;
}

function setList(patch: Partial<SessionProfileListEntry>): void {
  sessionProfilesStore.setState((state) => ({ list: { ...state.list, ...patch } }));
}

export function sessionProfileDetailEntry(profileId: string): SessionProfileDetailEntry {
  return getState().details[profileId] ?? EMPTY_DETAIL_ENTRY;
}

function setDetailEntry(profileId: string, patch: Partial<SessionProfileDetailEntry>): void {
  sessionProfilesStore.setState((state) => ({
    details: { ...state.details, [profileId]: { ...(state.details[profileId] ?? EMPTY_DETAIL_ENTRY), ...patch } }
  }));
}

function summaryOf(detail: SessionProfileDetail): SessionProfileSummary {
  const { settings: _settings, items: _items, itemErrors: _itemErrors, ...summary } = detail;
  return summary;
}

/** Put a fresh detail in the store, and its summary in the list (inserted when new). */
export function applySessionProfileDetail(detail: SessionProfileDetail): void {
  sessionProfilesStore.setState((state) => {
    const details = {
      ...state.details,
      [detail.id]: { detail, status: "ready" as const, error: null, errorCode: null, stale: false }
    };
    const profiles = state.list.profiles;
    if (profiles === null) return { details };
    const summary = summaryOf(detail);
    const index = profiles.findIndex((profile) => profile.id === detail.id);
    const next = index === -1 ? [...profiles, summary] : profiles.map((profile, at) => (at === index ? summary : profile));
    return { details, list: { ...state.list, profiles: next } };
  });
}

function removeProfile(profileId: string): void {
  sessionProfilesStore.setState((state) => {
    const { [profileId]: _removed, ...details } = state.details;
    const profiles = state.list.profiles?.filter((profile) => profile.id !== profileId) ?? null;
    return {
      details,
      list: { ...state.list, profiles },
      openProfileId: state.openProfileId === profileId ? null : state.openProfileId
    };
  });
}

// ---------------------------------------------------------------------------
// Loads
// ---------------------------------------------------------------------------

export function loadSessionProfiles(api: SessionProfilesApi, options: { force?: boolean } = {}): Promise<void> {
  bind(api);
  const { list } = getState();
  if (!options.force && list.status === "ready" && !list.stale) return Promise.resolve();
  const at = generation;
  return singleFlight(LIST_KEY, options.force === true, async () => {
    if (getState().list.profiles === null) setList({ status: "loading", error: null });
    try {
      const response = sanitizeSessionProfileList(await api.listSessionProfiles());
      if (at !== generation) return;
      setList({ profiles: response.profiles, errors: response.errors, status: "ready", error: null, stale: false });
    } catch (error) {
      if (at !== generation) return;
      setList({ status: getState().list.profiles !== null ? "ready" : "error", error: agentProfileErrorText(error) });
    }
  });
}

export function loadSessionProfile(
  api: SessionProfilesApi,
  profileId: string,
  options: { force?: boolean } = {}
): Promise<void> {
  bind(api);
  const entry = sessionProfileDetailEntry(profileId);
  if (!options.force && entry.status === "ready" && !entry.stale) return Promise.resolve();
  const at = generation;
  return singleFlight(detailKey(profileId), options.force === true, async () => {
    if (sessionProfileDetailEntry(profileId).detail === null) setDetailEntry(profileId, { status: "loading", error: null });
    try {
      const detail = sanitizeSessionProfileDetail(await api.getSessionProfile(profileId));
      if (at !== generation) return;
      if (detail === null) {
        setDetailEntry(profileId, { status: "error", error: "The daemon's answer could not be read.", errorCode: null });
        return;
      }
      applySessionProfileDetail(detail);
    } catch (error) {
      if (at !== generation) return;
      const code = agentProfileErrorCode(error);
      if (code === "PROFILE_NOT_FOUND") {
        removeProfile(profileId);
        setDetailEntry(profileId, { status: "error", error: agentProfileErrorText(error), errorCode: code });
        return;
      }
      const shown = sessionProfileDetailEntry(profileId).detail !== null;
      setDetailEntry(profileId, { status: shown ? "ready" : "error", error: agentProfileErrorText(error), errorCode: code });
    }
  });
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** One `/events` message on `SESSION_PROFILES_CHANNEL`; a malformed payload is ignored. */
export function applySessionProfileEvent(event: { type: string; payload: unknown }): void {
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null) return;
  const record = payload as Record<string, unknown>;
  const profileId = typeof record.profileId === "string" && record.profileId.length > 0 ? record.profileId : null;
  if (profileId === null) return;
  const state = getState();

  if (event.type === "sessionProfile.deleted") {
    const wasOpen = state.openProfileId === profileId;
    const name = state.details[profileId]?.detail?.name ?? state.list.profiles?.find((p) => p.id === profileId)?.name;
    removeProfile(profileId);
    if (wasOpen) setSessionProfilesNotice({ tone: "error", text: `${name ?? "This profile"} was deleted.` });
    return;
  }

  if (event.type === "sessionProfile.changed") {
    const revision = typeof record.revision === "string" ? record.revision : null;
    if (revision === null) return;
    const held = state.list.profiles?.find((profile) => profile.id === profileId);
    if (state.list.profiles !== null && held?.revision !== revision) {
      setList({ stale: true });
      if (boundApi !== null) void loadSessionProfiles(boundApi, { force: true });
    }
    const entry = state.details[profileId];
    if (entry?.detail && entry.detail.revision !== revision) {
      setDetailEntry(profileId, { stale: true });
      if (boundApi !== null) void loadSessionProfile(boundApi, profileId, { force: true });
    }
    return;
  }

  if (event.type === "sessionProfile.prepareStatus") {
    const status = sanitizePrepareStatusResponse(payload);
    if (status === null) return;
    // Only the revision held: a newer one's readiness arrives with its refetch.
    sessionProfilesStore.setState((current) => {
      const patch: Partial<SessionProfilesState> = {};
      const profiles = current.list.profiles;
      if (profiles?.some((profile) => profile.id === profileId && profile.revision === status.revision)) {
        patch.list = {
          ...current.list,
          profiles: profiles.map((profile) =>
            profile.id === profileId ? { ...profile, preparation: status.agents } : profile
          )
        };
      }
      const entry = current.details[profileId];
      if (entry?.detail && entry.detail.revision === status.revision) {
        patch.details = { ...current.details, [profileId]: { ...entry, detail: { ...entry.detail, preparation: status.agents } } };
      }
      return patch;
    });
  }
}

// ---------------------------------------------------------------------------
// Notice, navigation
// ---------------------------------------------------------------------------

export function setSessionProfilesNotice(notice: SessionProfilesNotice | null): void {
  const current = getState().notice;
  if (current === notice || (current?.tone === notice?.tone && current?.text === notice?.text)) return;
  sessionProfilesStore.setState({ notice });
}

export function dismissSessionProfilesNotice(): void {
  setSessionProfilesNotice(null);
}

/** Drill the rail's panel into a profile, or back to the library (`null`). */
export function openSessionProfile(profileId: string | null): void {
  if (getState().openProfileId === profileId) return;
  sessionProfilesStore.setState({ openProfileId: profileId, notice: null });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export type SessionProfileMutationResult =
  | { ok: true; profile: SessionProfileDetail | null; itemId: string | null }
  | { ok: false; error: string; code: string | null };

const CONFLICT_NOTICE = "This profile was changed elsewhere and has been reloaded — check it and try again.";

function setPending(key: string, on: boolean): void {
  sessionProfilesStore.setState((state) => {
    if (state.pending.has(key) === on) return {};
    const pending = new Set(state.pending);
    if (on) pending.add(key);
    else pending.delete(key);
    return { pending };
  });
}

/**
 * Run one mutation of `profileId` carrying the revision held, and fold its
 * answer in. A 409 `PROFILE_CONFLICT` reloads the profile and says so;
 * any other refusal is the notice. `answer` reads the daemon's response:
 * a mutation response (`{profile, itemId}`) or a bare detail.
 */
async function mutate(
  api: SessionProfilesApi,
  profileId: string,
  pendingKey: string,
  send: (revision: string) => Promise<unknown>,
  answer: "mutation" | "detail" | "none"
): Promise<SessionProfileMutationResult> {
  bind(api);
  const detail = sessionProfileDetailEntry(profileId).detail;
  const revision = detail?.revision ?? getState().list.profiles?.find((profile) => profile.id === profileId)?.revision;
  if (revision === undefined) return { ok: false, error: "The profile is not loaded yet.", code: null };
  const at = generation;
  setPending(pendingKey, true);
  try {
    const raw = await send(revision);
    if (at !== generation) return { ok: false, error: "The connection changed before the daemon answered.", code: null };
    if (answer === "none") return { ok: true, profile: null, itemId: null };
    const result =
      answer === "detail"
        ? { profile: sanitizeSessionProfileDetail(raw), itemId: null }
        : sanitizeSessionProfileMutation(raw);
    if (result.profile !== null) applySessionProfileDetail(result.profile);
    else void loadSessionProfile(api, profileId, { force: true });
    return { ok: true, ...result };
  } catch (error) {
    const code = agentProfileErrorCode(error);
    const text = agentProfileErrorText(error);
    if (at === generation) {
      if (code === "PROFILE_CONFLICT") {
        setSessionProfilesNotice({ tone: "error", text: CONFLICT_NOTICE });
        void loadSessionProfile(api, profileId, { force: true });
      } else if (code === "PROFILE_NOT_FOUND") {
        removeProfile(profileId);
        setSessionProfilesNotice({ tone: "error", text });
      } else {
        setSessionProfilesNotice({ tone: "error", text });
      }
    }
    return { ok: false, error: text, code };
  } finally {
    setPending(pendingKey, false);
  }
}

export function setSessionProfileItemEnabled(
  api: SessionProfilesApi,
  profileId: string,
  item: SessionProfileItem,
  enabled: boolean
): Promise<SessionProfileMutationResult> {
  return mutate(
    api,
    profileId,
    item.id,
    (revision) => api.setSessionProfileItemEnabled(profileId, item.id, revision, enabled),
    "mutation"
  );
}

export async function deleteSessionProfileItem(
  api: SessionProfilesApi,
  profileId: string,
  item: SessionProfileItem
): Promise<SessionProfileMutationResult> {
  const result = await mutate(
    api,
    profileId,
    item.id,
    (revision) => api.deleteSessionProfileItem(profileId, item.id, revision),
    "mutation"
  );
  if (result.ok) setSessionProfilesNotice({ tone: "ok", text: `Deleted ${item.name}.` });
  return result;
}

/** Name, icon, description or settings (`UpdateSessionProfileRequest` minus the revision). */
export function updateSessionProfile(
  api: SessionProfilesApi,
  profileId: string,
  patch: Omit<UpdateSessionProfileRequest, "revision">
): Promise<SessionProfileMutationResult> {
  return mutate(
    api,
    profileId,
    profilePendingKey(profileId),
    (revision) => api.updateSessionProfile(profileId, { ...patch, revision }),
    "detail"
  );
}

/**
 * Delete a profile. `expectWorkflowUses` (the delete guard, spec 2026-10-18 §5.5): the ids of the
 * workflows the confirmation showed as using it — the daemon refuses (409 `WORKFLOW_USES_CHANGED`,
 * the notice says which use it now) when they are no longer exactly those. Absent: unchecked.
 */
export async function deleteSessionProfile(
  api: SessionProfilesApi,
  profileId: string,
  options: { expectWorkflowUses?: readonly string[] } = {}
): Promise<SessionProfileMutationResult> {
  const name = sessionProfileDetailEntry(profileId).detail?.name;
  const result = await mutate(
    api,
    profileId,
    profilePendingKey(profileId),
    (revision) =>
      options.expectWorkflowUses === undefined
        ? api.deleteSessionProfile(profileId, revision)
        : api.deleteSessionProfile(profileId, revision, { expectWorkflowUses: options.expectWorkflowUses }),
    "none"
  );
  // The delete answers no profile: drop it here (the event does the same, idempotently).
  if (result.ok) {
    removeProfile(profileId);
    setSessionProfilesNotice({ tone: "ok", text: `Deleted ${name ?? "the profile"}.` });
  }
  return result;
}

export type ProfileWorkflowUsesResult =
  | { ok: true; workflows: ProfileWorkflowUse[]; unknown: boolean }
  | { ok: false; error: string };

/** The workflows whose agent blocks launch with `profileId` — what the delete confirmation lists. */
export async function loadProfileWorkflowUses(api: SessionProfilesApi, profileId: string): Promise<ProfileWorkflowUsesResult> {
  try {
    return { ok: true, ...sanitizeProfileWorkflowUses(await api.getProfileWorkflowReferences(profileId)) };
  } catch (error) {
    return { ok: false, error: agentProfileErrorText(error) };
  }
}

/** Create or duplicate: no revision to carry; the answer is the new profile's detail. */
async function createLike(api: SessionProfilesApi, send: () => Promise<unknown>): Promise<SessionProfileMutationResult> {
  bind(api);
  const at = generation;
  try {
    const profile = sanitizeSessionProfileDetail(await send());
    if (at !== generation) return { ok: false, error: "The connection changed before the daemon answered.", code: null };
    if (profile !== null) applySessionProfileDetail(profile);
    return { ok: true, profile, itemId: null };
  } catch (error) {
    return { ok: false, error: agentProfileErrorText(error), code: agentProfileErrorCode(error) };
  }
}

export function createSessionProfile(
  api: SessionProfilesApi,
  request: CreateSessionProfileRequest
): Promise<SessionProfileMutationResult> {
  return createLike(api, () => api.createSessionProfile(request));
}

export async function duplicateSessionProfile(
  api: SessionProfilesApi,
  profileId: string
): Promise<SessionProfileMutationResult> {
  const result = await createLike(api, () => api.duplicateSessionProfile(profileId, {}));
  if (!result.ok) setSessionProfilesNotice({ tone: "error", text: result.error });
  return result;
}

/**
 * The answer of a write made elsewhere (an item editor, the instructions
 * editor): a mutation response or a bare detail, folded in like a mutation's.
 */
export function applySessionProfileWrite(raw: unknown, answer: "mutation" | "detail"): string | null {
  const result =
    answer === "detail" ? { profile: sanitizeSessionProfileDetail(raw), itemId: null } : sanitizeSessionProfileMutation(raw);
  if (result.profile !== null) applySessionProfileDetail(result.profile);
  return result.itemId;
}

/** A 409 an editor got: reload the profile (the editor keeps its own copy and says so). */
export function reloadAfterConflict(api: SessionProfilesApi, profileId: string): void {
  void loadSessionProfile(api, profileId, { force: true });
}
