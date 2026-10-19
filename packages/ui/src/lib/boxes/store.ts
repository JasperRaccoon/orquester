/**
 * Ephemeral AI VMs ("boxes") — this client's copy of the plugin's daemon state:
 * the boxes and their totals, the providers, the box kinds the New project
 * dialog offers, the config changes waiting for approval, and (loaded by the
 * plugin settings only) the connection and Blacksmith setup.
 *
 * One module-level store read by the plugin settings, the New project dialog's
 * Runs on row, the sidebar badges and the chat cards. It converges on the
 * daemon three ways, which race freely:
 *
 * - a **load** per connection (connect, reconnect and the plugin turning on —
 *   the app store; only while the plugin is on), and the settings' own loads;
 * - the answer of each **mutation**, applied at once;
 * - `BOXES_CHANNEL` **events** (full snapshots of a list), routed here by the
 *   app store's `applyEvent`.
 *
 * Every write is validated first (`validate.ts`): a malformed payload is
 * ignored, never applied half-way. A load's answer never undoes a change that
 * landed while it was in flight: each slot carries a revision every event and
 * mutation bumps, and a load whose slot moved meanwhile drops its answer.
 *
 * Per connection: `resetBoxes()` runs on a connection switch and when the
 * plugin turns off (the app store), and a call through a client of another
 * connection resets first.
 *
 * Exported API for other UI modules: the vanilla `boxesStore`, the hooks
 * `useBoxes()`, `useBoxesTotals()`, `useBox(id)`, `useProjectBox(path)`,
 * `useBoxProviders()`, `useBoxKinds()`, `useBoxConfigChanges()`,
 * `useBoxConnection()`, `useBlacksmithSetup()`, and the load / mutation
 * functions below (each takes the `ApiClient`).
 */

import { useSyncExternalStore } from "react";
import { createStore } from "zustand/vanilla";

import {
  BOXES_CHANGED_EVENT,
  BOX_CONFIG_CHANGES_EVENT,
  BOX_PROVIDERS_CHANGED_EVENT,
  type BlacksmithSetupResponse,
  type BoxConfigChangeSet,
  type BoxConfigChangesResponse,
  type BoxConnectionSettings,
  type BoxesResponse,
  type BoxesTotals,
  type BoxKind,
  type BoxKindAvailability,
  type BoxKindsResponse,
  type BoxOffersResponse,
  type BoxProviderId,
  type BoxProviderInfo,
  type BoxProvidersResponse,
  type BoxResponse,
  type BoxSummary,
  type DecideBoxConfigChangeRequest,
  type EventMessage,
  type SetBlacksmithSetupRequest,
  type SetBoxConnectionRequest,
  type SetBoxProviderCredentialsRequest
} from "@orquester/api";

import {
  isRecord,
  sanitizeBlacksmithSetup,
  sanitizeBoxConfigChangeSet,
  sanitizeBoxConfigChangesResponse,
  sanitizeBoxConnectionSettings,
  sanitizeBoxesResponse,
  sanitizeBoxKindsResponse,
  sanitizeBoxOffersResponse,
  sanitizeBoxProviderInfo,
  sanitizeBoxProvidersResponse,
  sanitizeBoxResponse
} from "./validate";

/** The routes this store calls — `ApiClient` satisfies it; tests pass a fake. */
export interface BoxesApi {
  /** The connection the client talks to; a different id resets the store. */
  readonly connection?: { readonly id: string };
  listBoxes(signal?: AbortSignal): Promise<BoxesResponse>;
  getBox(id: string, signal?: AbortSignal): Promise<BoxResponse>;
  destroyBox(id: string): Promise<BoxResponse | undefined>;
  listBoxKinds(signal?: AbortSignal): Promise<BoxKindsResponse>;
  listBoxProviders(signal?: AbortSignal): Promise<BoxProvidersResponse>;
  setBoxProviderCredentials(id: BoxProviderId, req: SetBoxProviderCredentialsRequest): Promise<BoxProviderInfo>;
  removeBoxProviderCredentials(id: BoxProviderId): Promise<BoxProviderInfo | undefined>;
  getBoxOffers(id: BoxProviderId, kind: BoxKind, signal?: AbortSignal): Promise<BoxOffersResponse>;
  prepareBoxWindowsImage(id: BoxProviderId): Promise<unknown>;
  getBoxConnection(signal?: AbortSignal): Promise<BoxConnectionSettings>;
  setBoxConnection(req: SetBoxConnectionRequest): Promise<BoxConnectionSettings>;
  testBoxConnection(): Promise<BoxConnectionSettings>;
  getBlacksmithSetup(signal?: AbortSignal): Promise<BlacksmithSetupResponse>;
  setBlacksmithSetup(req: SetBlacksmithSetupRequest): Promise<BlacksmithSetupResponse>;
  startBlacksmithTest(): Promise<unknown>;
  listBoxConfigChanges(signal?: AbortSignal): Promise<BoxConfigChangesResponse>;
  decideBoxConfigChange(id: string, req: DecideBoxConfigChangeRequest): Promise<{ change: BoxConfigChangeSet }>;
}

/** Each slot is `null` until it first loads on this connection. */
export interface BoxesState {
  boxes: readonly BoxSummary[] | null;
  totals: BoxesTotals | null;
  providers: readonly BoxProviderInfo[] | null;
  kinds: readonly BoxKindAvailability[] | null;
  /** Pending first, as the daemon sends them. */
  configChanges: readonly BoxConfigChangeSet[] | null;
  connection: BoxConnectionSettings | null;
  blacksmith: BlacksmithSetupResponse | null;
}

type Slot = "boxes" | "providers" | "kinds" | "configChanges" | "connection" | "blacksmith";

const INITIAL: BoxesState = {
  boxes: null,
  totals: null,
  providers: null,
  kinds: null,
  configChanges: null,
  connection: null,
  blacksmith: null
};

export const boxesStore = createStore<BoxesState>(() => INITIAL);

// ---------------------------------------------------------------------------
// Module state (per connection; cleared by `resetBoxes`)
// ---------------------------------------------------------------------------

/** Bumped by a reset: an answer from before it is dropped, never applied. */
let generation = 0;
let boundConnectionId: string | null = null;
/** The client of the latest call — what follow-up reloads (kinds after a provider change) go through. */
let boundApi: BoxesApi | null = null;
/** Bumped by every event or mutation that wrote a slot: a load that started before is stale. */
const revisions: Record<Slot, number> = {
  boxes: 0,
  providers: 0,
  kinds: 0,
  configChanges: 0,
  connection: 0,
  blacksmith: 0
};

/** Offers per provider and kind, kept a few minutes (prices move slowly); in-flight reads are shared. */
const OFFERS_MAX_AGE_MS = 5 * 60_000;
const offersCache = new Map<string, { offers: BoxOffersResponse; at: number }>();
const offersInFlight = new Map<string, Promise<BoxOffersResponse>>();
const offersKey = (provider: BoxProviderId, kind: BoxKind): string => `${provider}\u0000${kind}`;

/** A client of another connection means another daemon's boxes: start over. */
function bind(api: BoxesApi): void {
  const id = api.connection?.id;
  if (id !== undefined) {
    if (boundConnectionId !== null && boundConnectionId !== id) resetBoxes();
    boundConnectionId = id;
  }
  boundApi = api;
}

function write(slot: Slot, patch: Partial<BoxesState>): void {
  revisions[slot] += 1;
  boxesStore.setState(patch);
}

/** A connection switch or the plugin turning off: forget everything; answers still in flight are dropped. */
export function resetBoxes(): void {
  generation += 1;
  boundConnectionId = null;
  boundApi = null;
  for (const slot of Object.keys(revisions) as Slot[]) revisions[slot] = 0;
  offersCache.clear();
  offersInFlight.clear();
  boxesStore.setState(INITIAL, true);
}

// ---------------------------------------------------------------------------
// Applying validated data
// ---------------------------------------------------------------------------

function applyBoxesList(response: BoxesResponse): void {
  write("boxes", { boxes: response.boxes, totals: response.totals });
}

/** One box a read or a destroy answered: replaces its entry, or joins the list. */
function upsertBox(box: BoxSummary): void {
  const list = boxesStore.getState().boxes ?? [];
  const at = list.findIndex((entry) => entry.id === box.id);
  const next = at === -1 ? [...list, box] : list.map((entry, index) => (index === at ? box : entry));
  write("boxes", { boxes: next });
}

function applyProviders(response: BoxProvidersResponse): void {
  write("providers", { providers: response.providers });
}

function upsertProvider(provider: BoxProviderInfo): void {
  const list = boxesStore.getState().providers ?? [];
  const at = list.findIndex((entry) => entry.id === provider.id);
  const next = at === -1 ? [...list, provider] : list.map((entry, index) => (index === at ? provider : entry));
  write("providers", { providers: next });
}

function applyConfigChanges(response: BoxConfigChangesResponse): void {
  write("configChanges", { configChanges: response.changes });
}

function upsertConfigChange(change: BoxConfigChangeSet): void {
  const list = boxesStore.getState().configChanges ?? [];
  const at = list.findIndex((entry) => entry.id === change.id);
  const next = at === -1 ? [change, ...list] : list.map((entry, index) => (index === at ? change : entry));
  write("configChanges", { configChanges: next });
}

/**
 * The kinds the New project dialog offers follow from the providers and the
 * connection: after either changes, re-read them — when they were loaded.
 */
function refreshKindsLater(): void {
  const api = boundApi;
  if (api && boxesStore.getState().kinds !== null) void loadBoxKinds(api).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * One `BOXES_CHANNEL` event. A malformed payload or an unknown type is
 * ignored — never applied half-way, never a throw into the event loop.
 */
export function applyBoxesEvent(event: Pick<EventMessage, "type" | "payload">): void {
  if (event.type === BOXES_CHANGED_EVENT) {
    const response = sanitizeBoxesResponse(event.payload);
    if (response) applyBoxesList(response);
    return;
  }
  if (event.type === BOX_PROVIDERS_CHANGED_EVENT) {
    const response = sanitizeBoxProvidersResponse(event.payload);
    if (!response) return;
    applyProviders(response);
    // Offer prices and availability may have moved with the provider.
    offersCache.clear();
    refreshKindsLater();
    return;
  }
  if (event.type === BOX_CONFIG_CHANGES_EVENT) {
    const response = sanitizeBoxConfigChangesResponse(event.payload);
    if (response) applyConfigChanges(response);
  }
}

// ---------------------------------------------------------------------------
// Loads
// ---------------------------------------------------------------------------

/**
 * Read one slot and apply what `parse` makes of the answer — unless a reset,
 * or an event / mutation on the same slot, overtook the read (the answer is
 * then older than what is held, and dropped). Rejects when the read fails or
 * answers in another shape.
 */
async function load<T>(
  api: BoxesApi,
  slot: Slot,
  read: () => Promise<unknown>,
  parse: (raw: unknown) => T | null,
  apply: (value: T) => void,
  what: string
): Promise<void> {
  bind(api);
  const gen = generation;
  const revision = revisions[slot];
  const raw = await read();
  if (gen !== generation) return;
  const value = parse(raw);
  if (value === null) throw new Error(`The daemon answered the ${what} in an unexpected shape.`);
  if (revisions[slot] !== revision) return;
  apply(value);
}

export function loadBoxesList(api: BoxesApi, signal?: AbortSignal): Promise<void> {
  return load(api, "boxes", () => api.listBoxes(signal), sanitizeBoxesResponse, applyBoxesList, "boxes");
}

export function loadBoxProviders(api: BoxesApi, signal?: AbortSignal): Promise<void> {
  return load(api, "providers", () => api.listBoxProviders(signal), sanitizeBoxProvidersResponse, applyProviders, "providers");
}

export function loadBoxKinds(api: BoxesApi, signal?: AbortSignal): Promise<void> {
  return load(
    api,
    "kinds",
    () => api.listBoxKinds(signal),
    sanitizeBoxKindsResponse,
    (response) => write("kinds", { kinds: response.kinds }),
    "box kinds"
  );
}

export function loadBoxConfigChanges(api: BoxesApi, signal?: AbortSignal): Promise<void> {
  return load(
    api,
    "configChanges",
    () => api.listBoxConfigChanges(signal),
    sanitizeBoxConfigChangesResponse,
    applyConfigChanges,
    "config changes"
  );
}

export function loadBoxConnection(api: BoxesApi, signal?: AbortSignal): Promise<void> {
  return load(
    api,
    "connection",
    () => api.getBoxConnection(signal),
    sanitizeBoxConnectionSettings,
    (connection) => write("connection", { connection }),
    "connection settings"
  );
}

export function loadBlacksmithSetup(api: BoxesApi, signal?: AbortSignal): Promise<void> {
  return load(
    api,
    "blacksmith",
    () => api.getBlacksmithSetup(signal),
    sanitizeBlacksmithSetup,
    (blacksmith) => write("blacksmith", { blacksmith }),
    "Blacksmith setup"
  );
}

/**
 * What every client holds while the plugin is on: the boxes, providers, kinds
 * and pending config changes. Each loads on its own (one failing leaves the
 * others); rejects with the boxes list's error when that one failed.
 */
export async function loadBoxes(api: BoxesApi, signal?: AbortSignal): Promise<void> {
  const [boxes] = await Promise.allSettled([
    loadBoxesList(api, signal),
    loadBoxProviders(api, signal),
    loadBoxKinds(api, signal),
    loadBoxConfigChanges(api, signal)
  ]);
  if (boxes.status === "rejected") throw boxes.reason;
}

/**
 * A provider's sizes, regions and images for one kind, validated. Served from a
 * short cache (shared with reads in flight); `fresh` reads again.
 */
export async function loadBoxOffers(
  api: BoxesApi,
  provider: BoxProviderId,
  kind: BoxKind,
  options: { fresh?: boolean; signal?: AbortSignal } = {}
): Promise<BoxOffersResponse> {
  bind(api);
  const key = offersKey(provider, kind);
  const cached = offersCache.get(key);
  if (!options.fresh && cached && Date.now() - cached.at < OFFERS_MAX_AGE_MS) return cached.offers;
  const inFlight = offersInFlight.get(key);
  if (!options.fresh && inFlight) return inFlight;
  const gen = generation;
  const read = (async () => {
    const raw: unknown = await api.getBoxOffers(provider, kind, options.signal);
    const offers = sanitizeBoxOffersResponse(raw, provider, kind);
    if (offers === null) throw new Error("The daemon answered the offers in an unexpected shape.");
    if (gen === generation) offersCache.set(key, { offers, at: Date.now() });
    return offers;
  })();
  offersInFlight.set(key, read);
  try {
    return await read;
  } finally {
    if (offersInFlight.get(key) === read) offersInFlight.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Mutations — each applies what the daemon answered
// ---------------------------------------------------------------------------

/** Run `call` for the client's connection; resolves with its answer and whether it is still current. */
async function mutate<T>(api: BoxesApi, call: () => Promise<T>): Promise<{ answer: T; current: boolean }> {
  bind(api);
  const gen = generation;
  const answer = await call();
  return { answer, current: gen === generation };
}

/** Re-read a slot after an answer this client cannot read; failures are left to the next event. */
function reloadQuietly(run: () => Promise<void>): void {
  void run().catch(() => undefined);
}

/**
 * Save a provider's credentials. The daemon checks them with a read call first
 * and refuses bad ones (an `ApiError`, `BOX_PROVIDER_ERROR`). Resolves with the
 * provider's new state.
 */
export async function saveBoxProviderCredentials(
  api: BoxesApi,
  id: BoxProviderId,
  credentials: Record<string, string>
): Promise<BoxProviderInfo | null> {
  const { answer, current } = await mutate(api, () => api.setBoxProviderCredentials(id, { credentials }));
  if (!current) return null;
  offersCache.clear();
  const provider = sanitizeBoxProviderInfo(answer);
  if (provider && provider.id === id) upsertProvider(provider);
  else reloadQuietly(() => loadBoxProviders(api));
  refreshKindsLater();
  return provider && provider.id === id ? provider : null;
}

/** Forget a provider's credentials. */
export async function removeBoxProviderCredentials(api: BoxesApi, id: BoxProviderId): Promise<void> {
  const { answer, current } = await mutate(api, () => api.removeBoxProviderCredentials(id));
  if (!current) return;
  offersCache.clear();
  const provider = sanitizeBoxProviderInfo(answer);
  if (provider && provider.id === id) upsertProvider(provider);
  else reloadQuietly(() => loadBoxProviders(api));
  refreshKindsLater();
}

/** Start the provider's Windows image build; it shows as preparing until the daemon reports otherwise. */
export async function prepareBoxWindowsImage(api: BoxesApi, id: BoxProviderId): Promise<void> {
  const { current } = await mutate(api, () => api.prepareBoxWindowsImage(id));
  if (!current) return;
  const provider = boxesStore.getState().providers?.find((entry) => entry.id === id);
  if (provider?.windowsImage) {
    upsertProvider({ ...provider, windowsImage: { ...provider.windowsImage, state: "preparing", message: null } });
  }
  reloadQuietly(() => loadBoxProviders(api));
}

/** Destroy a temporary box. Rejects with the daemon's error (409 `BOX_IS_PROJECT` for a project box). */
export async function destroyBox(api: BoxesApi, id: string): Promise<void> {
  const { answer, current } = await mutate(api, () => api.destroyBox(id));
  if (!current) return;
  const box = sanitizeBoxResponse(answer);
  if (box && box.id === id) upsertBox(box);
  else reloadQuietly(() => loadBoxesList(api));
}

/** One box from the daemon, applied. */
export async function fetchBox(api: BoxesApi, id: string, signal?: AbortSignal): Promise<BoxSummary | null> {
  const { answer, current } = await mutate(api, () => api.getBox(id, signal));
  const box = sanitizeBoxResponse(answer);
  if (!box || box.id !== id) throw new Error("The daemon answered the box in an unexpected shape.");
  if (current) upsertBox(box);
  return box;
}

function applyConnectionAnswer(answer: unknown, current: boolean): BoxConnectionSettings {
  const connection = sanitizeBoxConnectionSettings(answer);
  if (connection === null) throw new Error("The daemon answered the connection settings in an unexpected shape.");
  if (current) {
    write("connection", { connection });
    refreshKindsLater();
  }
  return connection;
}

/** Save connection settings (secret fields are write-only). */
export async function saveBoxConnection(api: BoxesApi, req: SetBoxConnectionRequest): Promise<BoxConnectionSettings> {
  const { answer, current } = await mutate(api, () => api.setBoxConnection(req));
  return applyConnectionAnswer(answer, current);
}

/** Run the reachability check. */
export async function testBoxConnection(api: BoxesApi): Promise<BoxConnectionSettings> {
  const { answer, current } = await mutate(api, () => api.testBoxConnection());
  return applyConnectionAnswer(answer, current);
}

/** Pick the Blacksmith account or org (an empty request re-runs the automatic steps). */
export async function saveBlacksmithSetup(
  api: BoxesApi,
  req: SetBlacksmithSetupRequest
): Promise<BlacksmithSetupResponse> {
  const { answer, current } = await mutate(api, () => api.setBlacksmithSetup(req));
  const blacksmith = sanitizeBlacksmithSetup(answer);
  if (blacksmith === null) throw new Error("The daemon answered the Blacksmith setup in an unexpected shape.");
  if (current) {
    write("blacksmith", { blacksmith });
    refreshKindsLater();
  }
  return blacksmith;
}

/** Start the macOS test run, then re-read the setup so its step shows as running. */
export async function startBlacksmithTest(api: BoxesApi): Promise<void> {
  const { current } = await mutate(api, () => api.startBlacksmithTest());
  if (current) await loadBlacksmithSetup(api);
}

/** Approve or deny a box's config change set. */
export async function decideBoxConfigChange(
  api: BoxesApi,
  id: string,
  decision: DecideBoxConfigChangeRequest["decision"]
): Promise<BoxConfigChangeSet | null> {
  const { answer, current } = await mutate(api, () => api.decideBoxConfigChange(id, { decision }));
  const change = isRecord(answer) ? sanitizeBoxConfigChangeSet(answer.change) : null;
  if (!current) return change;
  if (change && change.id === id) upsertConfigChange(change);
  else reloadQuietly(() => loadBoxConfigChanges(api));
  return change;
}

// ---------------------------------------------------------------------------
// Selectors (pure, also used by the hooks)
// ---------------------------------------------------------------------------

/**
 * The box a project runs in: the live one, else the newest destroyed one (a
 * project whose box is gone still shows why).
 */
export function projectBoxIn(boxes: readonly BoxSummary[] | null, projectPath: string | null | undefined): BoxSummary | undefined {
  if (!boxes || !projectPath) return undefined;
  let destroyed: BoxSummary | undefined;
  for (const box of boxes) {
    if (box.purpose !== "project" || box.project?.path !== projectPath) continue;
    if (box.state !== "destroyed") return box;
    if (!destroyed || (box.destroyedAt ?? "") > (destroyed.destroyedAt ?? "")) destroyed = box;
  }
  return destroyed;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

const EMPTY_BOXES: readonly BoxSummary[] = [];
const EMPTY_CHANGES: readonly BoxConfigChangeSet[] = [];

const subscribe = (listener: () => void) => boxesStore.subscribe(listener);

/** A slot of the store; the selector must return a value stable between changes. */
export function useBoxesState<T>(select: (state: BoxesState) => T): T {
  const snapshot = () => select(boxesStore.getState());
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Every box the daemon lists (destroyed ones included); empty until loaded. */
export function useBoxes(): readonly BoxSummary[] {
  return useBoxesState((state) => state.boxes ?? EMPTY_BOXES);
}

/** Whether the boxes list has loaded on this connection. */
export function useBoxesLoaded(): boolean {
  return useBoxesState((state) => state.boxes !== null);
}

export function useBoxesTotals(): BoxesTotals | null {
  return useBoxesState((state) => state.totals);
}

export function useBox(id: string | null | undefined): BoxSummary | undefined {
  return useBoxesState((state) => (id ? state.boxes?.find((box) => box.id === id) : undefined));
}

/** The box a project runs in (see {@link projectBoxIn}); undefined for a host project. */
export function useProjectBox(projectPath: string | null | undefined): BoxSummary | undefined {
  return useBoxesState((state) => projectBoxIn(state.boxes, projectPath));
}

/** The providers; null until loaded. */
export function useBoxProviders(): readonly BoxProviderInfo[] | null {
  return useBoxesState((state) => state.providers);
}

/** The Runs on row's kinds; null until loaded. */
export function useBoxKinds(): readonly BoxKindAvailability[] | null {
  return useBoxesState((state) => state.kinds);
}

/** Box → host config change sets (pending first); empty until loaded. */
export function useBoxConfigChanges(): readonly BoxConfigChangeSet[] {
  return useBoxesState((state) => state.configChanges ?? EMPTY_CHANGES);
}

export function useBoxConnection(): BoxConnectionSettings | null {
  return useBoxesState((state) => state.connection);
}

export function useBlacksmithSetup(): BlacksmithSetupResponse | null {
  return useBoxesState((state) => state.blacksmith);
}
