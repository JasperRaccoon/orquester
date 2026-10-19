/**
 * Repo identities — this client's copy of the daemon's per-repo icon + label
 * (`/api/repo-identities`), keyed by `ProjectSummary.repoKey`.
 *
 * One module-level store: every repo group header, agent card and dialog reads
 * the same map. It converges on the daemon three ways:
 *
 * - a full **load** per connection (connect and every reconnect, the app store);
 * - the identity each **mutation** answers, applied at once;
 * - `REPO_IDENTITIES_CHANNEL` **events**, routed here by the app store's `applyEvent`.
 *
 * The three race freely, so every write is idempotent and never goes
 * backwards: an identity older (`updatedAt`) than the one held is dropped, a
 * deleted identity is not brought back by an answer no newer than what was
 * deleted, and a load's answer never undoes a change that landed while it was
 * in flight. Everything from the wire is validated first; a malformed identity
 * is ignored.
 *
 * Per connection: `resetRepoIdentities()` runs on a connection switch (the app
 * store), and a load or mutation through a client of another connection resets
 * first. No React import (see `hooks.ts`).
 */

import { createStore } from "zustand/vanilla";

import {
  REPO_IDENTITY_CHANGED,
  isRepoIconStoredType,
  repoKeyProblem,
  type FetchRepoFaviconRequest,
  type RepoIcon,
  type RepoIconUploadType,
  type RepoIdentitiesResponse,
  type RepoIdentity,
  type RepoIdentityResponse,
  type SetRepoEmojiRequest,
  type SetRepoLabelRequest
} from "@orquester/api";

/** The routes this store calls — `ApiClient` satisfies it; tests pass a fake. */
export interface RepoIdentitiesApi {
  /** The connection the client talks to; a different id resets the store. */
  readonly connection?: { readonly id: string };
  listRepoIdentities(signal?: AbortSignal): Promise<RepoIdentitiesResponse>;
  setRepoLabel(req: SetRepoLabelRequest): Promise<RepoIdentityResponse>;
  setRepoEmoji(req: SetRepoEmojiRequest): Promise<RepoIdentityResponse>;
  uploadRepoIcon(repoKey: string, contentType: RepoIconUploadType, data: Blob): Promise<RepoIdentityResponse>;
  clearRepoIcon(repoKey: string): Promise<RepoIdentityResponse>;
  fetchRepoFavicon(req: FetchRepoFaviconRequest): Promise<RepoIdentityResponse>;
  readRepoIcon(repoKey: string, version: string, signal?: AbortSignal): Promise<ArrayBuffer>;
}

export interface RepoIdentitiesState {
  /** repoKey → identity. Repos with no identity are absent. */
  identities: ReadonlyMap<string, RepoIdentity>;
  /** Bumped by every applied load — the icon image cache retries failed fetches on it. */
  loads: number;
}

const INITIAL: RepoIdentitiesState = { identities: new Map(), loads: 0 };

export const repoIdentitiesStore = createStore<RepoIdentitiesState>(() => INITIAL);

// ---------------------------------------------------------------------------
// Module state (per connection; cleared by `resetRepoIdentities`)
// ---------------------------------------------------------------------------

/** Bumped by a reset: an answer from before it is dropped, never applied. */
let generation = 0;
let boundConnectionId: string | null = null;
/** The loads in flight — each remembers which repoKeys a change touched meanwhile. */
const openLoads = new Set<Set<string>>();
/** Sequence of the newest load started / applied: an older load's late answer is dropped. */
let loadsStarted = 0;
let loadsApplied = 0;
/** Deleted repoKeys → the newest `updatedAt` held when deleted. An answer no newer stays deleted. */
const tombstones = new Map<string, number>();

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function getRepoIdentity(repoKey: string | undefined): RepoIdentity | undefined {
  return repoKey ? repoIdentitiesStore.getState().identities.get(repoKey) : undefined;
}

/** The label a repo shows: its custom label, else `fallback` (the remote's `owner/repo`). */
export function repoLabelOf(
  identities: ReadonlyMap<string, RepoIdentity>,
  repoKey: string,
  fallback: string
): string {
  return identities.get(repoKey)?.label ?? fallback;
}

// ---------------------------------------------------------------------------
// Wire validation
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function sanitizeIcon(value: unknown): RepoIcon | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "emoji") {
    // Bounded, not re-segmented: the daemon validated it, and another runtime's
    // grapheme tables must not hide an emoji the daemon accepted.
    return nonEmpty(value.value) && value.value.length <= 64 ? { kind: "emoji", value: value.value } : undefined;
  }
  if (value.kind === "image") {
    if (!isRepoIconStoredType(value.contentType) || !nonEmpty(value.version)) return undefined;
    const source = value.source;
    const domain = isRecord(source) && source.kind === "favicon" && nonEmpty(source.domain) ? source.domain : null;
    return {
      kind: "image",
      contentType: value.contentType,
      version: value.version,
      ...(domain !== null ? { source: { kind: "favicon" as const, domain } } : {})
    };
  }
  return undefined;
}

/**
 * One identity from the wire, repaired field-wise — or `null` when it cannot
 * be trusted at all (no valid repoKey, no `updatedAt`) or carries nothing to
 * show. A malformed label or icon is dropped on its own, so the other still shows.
 */
export function sanitizeRepoIdentity(value: unknown): RepoIdentity | null {
  if (!isRecord(value)) return null;
  const { repoKey, updatedAt } = value;
  if (typeof repoKey !== "string" || repoKeyProblem(repoKey) !== null) return null;
  if (typeof updatedAt !== "string") return null;
  const label = nonEmpty(value.label) && value.label.trim().length > 0 ? value.label : undefined;
  const icon = sanitizeIcon(value.icon);
  if (label === undefined && icon === undefined) return null;
  return {
    repoKey,
    ...(label !== undefined ? { label } : {}),
    ...(icon !== undefined ? { icon } : {}),
    updatedAt
  };
}

function readList(response: unknown): RepoIdentity[] {
  if (!isRecord(response) || !Array.isArray(response.identities)) {
    throw new Error("The daemon answered the repo identities in an unexpected shape.");
  }
  const out: RepoIdentity[] = [];
  for (const raw of response.identities) {
    const identity = sanitizeRepoIdentity(raw);
    if (identity !== null) out.push(identity);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Versions: a write never goes backwards
// ---------------------------------------------------------------------------

function timeOf(value: string): number {
  const time = Date.parse(value);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

function sameIcon(a: RepoIcon | undefined, b: RepoIcon | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.kind === "emoji" || b.kind === "emoji") {
    return a.kind === b.kind && a.kind === "emoji" && b.kind === "emoji" && a.value === b.value;
  }
  return (
    a.contentType === b.contentType &&
    a.version === b.version &&
    (a.source?.domain ?? null) === (b.source?.domain ?? null)
  );
}

function sameIdentity(a: RepoIdentity, b: RepoIdentity): boolean {
  return (
    a.repoKey === b.repoKey &&
    a.updatedAt === b.updatedAt &&
    (a.label ?? null) === (b.label ?? null) &&
    sameIcon(a.icon, b.icon)
  );
}

function touch(repoKey: string): void {
  for (const touched of openLoads) touched.add(repoKey);
}

/** Whether `incoming` may replace what is held for its repo. */
function accepts(current: RepoIdentity | undefined, incoming: RepoIdentity): boolean {
  const tomb = tombstones.get(incoming.repoKey);
  if (tomb !== undefined && timeOf(incoming.updatedAt) <= tomb) return false;
  if (current === undefined) return true;
  return timeOf(current.updatedAt) <= timeOf(incoming.updatedAt) && !sameIdentity(current, incoming);
}

function upsertLocal(identity: RepoIdentity): void {
  touch(identity.repoKey);
  const identities = repoIdentitiesStore.getState().identities;
  if (!accepts(identities.get(identity.repoKey), identity)) return;
  tombstones.delete(identity.repoKey);
  const next = new Map(identities);
  next.set(identity.repoKey, identity);
  repoIdentitiesStore.setState({ identities: next });
}

function removeLocal(repoKey: string): void {
  touch(repoKey);
  const identities = repoIdentitiesStore.getState().identities;
  const current = identities.get(repoKey);
  const held = current ? timeOf(current.updatedAt) : Number.NEGATIVE_INFINITY;
  tombstones.set(repoKey, Math.max(tombstones.get(repoKey) ?? Number.NEGATIVE_INFINITY, held));
  if (current === undefined) return;
  const next = new Map(identities);
  next.delete(repoKey);
  repoIdentitiesStore.setState({ identities: next });
}

/**
 * Apply an identity a mutation answered (`null`: the repo has none left). The
 * identity is validated first; one for another repo, or malformed, is ignored.
 */
export function applyRepoIdentity(repoKey: string, identity: RepoIdentity | null): void {
  if (identity === null) {
    if (repoKeyProblem(repoKey) === null) removeLocal(repoKey);
    return;
  }
  const clean = sanitizeRepoIdentity(identity);
  if (clean !== null && clean.repoKey === repoKey) upsertLocal(clean);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * One `REPO_IDENTITIES_CHANNEL` event. A malformed payload or an unknown type
 * is ignored — never applied half-way, never a throw into the event loop.
 */
export function applyRepoIdentityEvent(event: { type: string; payload: unknown }): void {
  if (event.type !== REPO_IDENTITY_CHANGED) return;
  const payload = event.payload;
  if (!isRecord(payload)) return;
  if ("identity" in payload) {
    const identity = sanitizeRepoIdentity(payload.identity);
    if (identity !== null) upsertLocal(identity);
    return;
  }
  if (payload.deleted === true && typeof payload.repoKey === "string" && repoKeyProblem(payload.repoKey) === null) {
    removeLocal(payload.repoKey);
  }
}

// ---------------------------------------------------------------------------
// Loads
// ---------------------------------------------------------------------------

/** A client of another connection means another daemon's identities: start over. */
function bindConnection(api: RepoIdentitiesApi): void {
  const id = api.connection?.id;
  if (id === undefined) return;
  if (boundConnectionId !== null && boundConnectionId !== id) resetRepoIdentities();
  boundConnectionId = id;
}

/**
 * Replace the map with the daemon's list — except for repos a change touched
 * while the load was in flight (an event or answer can overtake the list it is
 * newer than): those keep what they hold unless the list is newer still. Any
 * other repo takes the list as it is, so a reload repairs a held copy whatever
 * its timestamps say.
 */
function applyLoaded(list: RepoIdentity[], touched: ReadonlySet<string>): void {
  const state = repoIdentitiesStore.getState();
  const next = new Map<string, RepoIdentity>();
  for (const [repoKey, identity] of state.identities) {
    if (touched.has(repoKey)) next.set(repoKey, identity);
  }
  for (const identity of list) {
    const current = state.identities.get(identity.repoKey);
    if (touched.has(identity.repoKey)) {
      if (!accepts(current, identity)) continue;
    }
    tombstones.delete(identity.repoKey);
    // The held object when it is the same record — subscribers see no change.
    next.set(identity.repoKey, current !== undefined && sameIdentity(current, identity) ? current : identity);
  }
  repoIdentitiesStore.setState({ identities: next, loads: state.loads + 1 });
}

/**
 * Load every identity from the daemon. Rejects when the daemon fails or answers
 * in another shape; an answer that a reset or a newer load overtook is dropped
 * quietly.
 */
export async function loadRepoIdentities(api: RepoIdentitiesApi, signal?: AbortSignal): Promise<void> {
  bindConnection(api);
  const gen = generation;
  const seq = ++loadsStarted;
  const touched = new Set<string>();
  openLoads.add(touched);
  try {
    const response = await api.listRepoIdentities(signal);
    if (gen !== generation || seq < loadsApplied) return;
    const list = readList(response);
    loadsApplied = seq;
    applyLoaded(list, touched);
  } catch (error) {
    if (gen !== generation) return;
    throw error;
  } finally {
    openLoads.delete(touched);
  }
}

/** A connection switch or sign-out: forget everything; answers still in flight are dropped. */
export function resetRepoIdentities(): void {
  generation += 1;
  boundConnectionId = null;
  openLoads.clear();
  tombstones.clear();
  loadsStarted = 0;
  loadsApplied = 0;
  repoIdentitiesStore.setState(INITIAL, true);
}

// ---------------------------------------------------------------------------
// Mutations — each applies the identity the daemon answered and returns it
// ---------------------------------------------------------------------------

/**
 * Run one mutation and apply its answer. Rejects with the daemon's error
 * (an `ApiError`). Resolves with the answered identity (`null`: none left) —
 * applied unless a reset overtook it; an answer that does not parse means
 * this copy may be wrong, so the list is reloaded.
 */
async function mutate(
  api: RepoIdentitiesApi,
  repoKey: string,
  run: () => Promise<RepoIdentityResponse>
): Promise<RepoIdentity | null> {
  bindConnection(api);
  const gen = generation;
  const answer: unknown = await run();
  if (!isRecord(answer) || !("identity" in answer)) {
    if (gen === generation) void loadRepoIdentities(api).catch(() => undefined);
    return null;
  }
  if (answer.identity === null) {
    if (gen === generation) removeLocal(repoKey);
    return null;
  }
  const identity = sanitizeRepoIdentity(answer.identity);
  if (identity === null || identity.repoKey !== repoKey) {
    if (gen === generation) void loadRepoIdentities(api).catch(() => undefined);
    return null;
  }
  if (gen === generation) upsertLocal(identity);
  return identity;
}

export async function setRepoLabel(api: RepoIdentitiesApi, repoKey: string, label: string | null): Promise<void> {
  await mutate(api, repoKey, () => api.setRepoLabel({ repoKey, label }));
}

export function setRepoEmoji(api: RepoIdentitiesApi, repoKey: string, emoji: string): Promise<RepoIdentity | null> {
  return mutate(api, repoKey, () => api.setRepoEmoji({ repoKey, emoji }));
}

export function uploadRepoIcon(
  api: RepoIdentitiesApi,
  repoKey: string,
  contentType: RepoIconUploadType,
  data: Blob
): Promise<RepoIdentity | null> {
  return mutate(api, repoKey, () => api.uploadRepoIcon(repoKey, contentType, data));
}

/** Back to the default icon (the label, if any, stays). */
export function clearRepoIcon(api: RepoIdentitiesApi, repoKey: string): Promise<RepoIdentity | null> {
  return mutate(api, repoKey, () => api.clearRepoIcon(repoKey));
}

/** The daemon fetches `domain`'s favicon; the icon changes only when it succeeds. */
export function fetchRepoFavicon(api: RepoIdentitiesApi, repoKey: string, domain: string): Promise<RepoIdentity | null> {
  return mutate(api, repoKey, () => api.fetchRepoFavicon({ repoKey, domain }));
}
