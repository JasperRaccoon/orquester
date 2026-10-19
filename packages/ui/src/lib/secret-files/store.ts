/**
 * Secret files — this client's copy of the daemon's vaults (`/api/secret-files`),
 * keyed by {@link vaultKey}(workspace, repoKey). Only states and names: the
 * daemon never sends secret content.
 *
 * One module-level store read by the repo-group menu/dialog, the project-row
 * badges, the repo-header counts and the project bar. It converges on the
 * daemon three ways, which race freely:
 *
 * - a full **load** per connection (connect, reconnect and the plugin turning
 *   on — the app store; only while the plugin is on);
 * - the vault each **mutation** answers, applied at once;
 * - `SECRET_FILES_CHANNEL` **events**, routed here by the app store's `applyEvent`.
 *
 * So every write is validated first (a malformed vault is ignored, bad fields
 * are repaired one by one) and never goes backwards: a vault older than the
 * one held is dropped, a deleted vault is not brought back by an answer no
 * newer than what was deleted, and a read's answer never undoes a change that
 * landed while it was in flight. "Older" is by `revision` when both copies
 * carry one (it moves on clone-state-only changes too), else by `updatedAt`.
 *
 * Per connection: `resetSecretFiles()` runs on a connection switch and when the
 * plugin turns off (the app store), and a load or mutation through a client of
 * another connection resets first. No React import (see `hooks.ts`).
 */

import { createStore } from "zustand/vanilla";

import {
  SECRET_FILES_CHANGED,
  SECRET_FILE_STATES,
  repoKeyProblem,
  secretFileNeedsAttention,
  secretFilePathProblem,
  type EventMessage,
  type SecretFileCandidate,
  type SecretFileCandidatesResponse,
  type SecretFileCloneState,
  type SecretFileRefusal,
  type SecretFileState,
  type SecretFileVariant,
  type SecretFilesClone,
  type SecretFilesCloneRequest,
  type SecretVaultDetail,
  type SecretVaultFile,
  type SecretVaultResponse,
  type SecretVaultRevision,
  type SecretVaultSummary,
  type SecretVaultsResponse,
  type SetupSecretVaultRequest,
  type UpdateSecretFilesRequest
} from "@orquester/api";
import { isValidName } from "@orquester/config";

/** The routes this store calls — `ApiClient` satisfies it; tests pass a fake. */
export interface SecretFilesApi {
  /** The connection the client talks to; a different id resets the store. */
  readonly connection?: { readonly id: string };
  listSecretVaults(signal?: AbortSignal): Promise<SecretVaultsResponse>;
  getSecretVault(workspace: string, repoKey: string, signal?: AbortSignal): Promise<SecretVaultResponse>;
  pushSecretFiles(req: SecretFilesCloneRequest): Promise<SecretVaultResponse>;
  resetSecretFiles(req: SecretFilesCloneRequest): Promise<SecretVaultResponse>;
}

/** The routes the "Secret files…" dialog adds (setup, file list, delete, scan). */
export interface SecretFilesAdminApi extends SecretFilesApi {
  deleteSecretVault(workspace: string, repoKey: string): Promise<void>;
  scanSecretFileCandidates(
    workspace: string,
    repoKey: string,
    path?: string,
    signal?: AbortSignal
  ): Promise<SecretFileCandidatesResponse>;
  setupSecretVault(req: SetupSecretVaultRequest): Promise<SecretVaultResponse>;
  updateSecretFiles(req: UpdateSecretFilesRequest): Promise<SecretVaultResponse>;
}

export interface SecretFilesState {
  /** vaultKey → detail. Repos without a vault are absent. */
  vaults: ReadonlyMap<string, SecretVaultDetail>;
}

const INITIAL: SecretFilesState = { vaults: new Map() };

export const secretFilesStore = createStore<SecretFilesState>(() => INITIAL);

export function vaultKey(workspace: string, repoKey: string): string {
  return `${workspace}\u0000${repoKey}`;
}

export function getSecretVault(workspace: string, repoKey: string): SecretVaultDetail | undefined {
  return secretFilesStore.getState().vaults.get(vaultKey(workspace, repoKey));
}

// ---------------------------------------------------------------------------
// Module state (per connection; cleared by `resetSecretFiles`)
// ---------------------------------------------------------------------------

/** Bumped by a reset: an answer from before it is dropped, never applied. */
let generation = 0;
let boundConnectionId: string | null = null;
/** The reads in flight — each remembers which vault keys a change touched meanwhile. */
const openReads = new Set<Set<string>>();
/** Sequence of the newest load started / applied: an older load's late answer is dropped. */
let loadsStarted = 0;
let loadsApplied = 0;
/** What a vault's place in the order is read from. */
type Rank = Pick<SecretVaultDetail, "updatedAt" | "revision">;
/** Deleted vault keys → the newest copy held when deleted. An answer no newer stays deleted. */
const tombstones = new Map<string, Rank>();

// ---------------------------------------------------------------------------
// Wire validation
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isPath = (value: unknown): value is string => secretFilePathProblem(value) === null;

const isWorkspace = (value: unknown): value is string => typeof value === "string" && isValidName(value);

const isRepoKey = (value: unknown): value is string => typeof value === "string" && repoKeyProblem(value) === null;

const REFUSALS: ReadonlySet<string> = new Set<SecretFileRefusal>([
  "tracked",
  "symlink",
  "outside",
  "not-a-file",
  "too-large",
  "unreadable"
]);
const isRefusal = (value: unknown): value is SecretFileRefusal => typeof value === "string" && REFUSALS.has(value);
const isState = (value: unknown): value is SecretFileState =>
  typeof value === "string" && (SECRET_FILE_STATES as readonly string[]).includes(value);

/** Valid, distinct paths from a wire list; anything else is left out. */
function pathList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isPath))];
}

function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function sanitizeVaultFile(value: unknown): SecretVaultFile | null {
  if (!isRecord(value) || !isPath(value.path) || !nonEmpty(value.version) || typeof value.updatedAt !== "string") {
    return null;
  }
  const by = isRecord(value.updatedBy) ? value.updatedBy : {};
  const updatedBy: SecretVaultFile["updatedBy"] = {
    kind: by.kind === "agent" ? "agent" : "user",
    ...(nonEmpty(by.threadId) ? { threadId: by.threadId } : {}),
    ...(nonEmpty(by.projectName) ? { projectName: by.projectName } : {})
  };
  return { path: value.path, version: value.version, updatedAt: value.updatedAt, updatedBy };
}

function sanitizeCloneState(value: unknown): SecretFileCloneState | null {
  if (!isRecord(value) || !isPath(value.path) || !isState(value.state)) return null;
  return {
    path: value.path,
    state: value.state,
    ...(value.state === "refused" && isRefusal(value.refusal) ? { refusal: value.refusal } : {}),
    ...(nonEmpty(value.contentToken) ? { contentToken: value.contentToken } : {})
  };
}

function sanitizeRevision(value: unknown): SecretVaultRevision | null {
  if (!isRecord(value) || !nonEmpty(value.boot) || !isCount(value.seq)) return null;
  return { boot: value.boot, seq: value.seq };
}

function sanitizeClone(value: unknown): SecretFilesClone | null {
  if (!isRecord(value) || !nonEmpty(value.projectPath)) return null;
  const files: SecretFileCloneState[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(value.files) ? value.files : []) {
    const file = sanitizeCloneState(raw);
    if (file === null || seen.has(file.path)) continue;
    seen.add(file.path);
    files.push(file);
  }
  return {
    projectPath: value.projectPath,
    projectName: nonEmpty(value.projectName) ? value.projectName : lastSegment(value.projectPath),
    files,
    needsAttention:
      typeof value.needsAttention === "boolean"
        ? value.needsAttention
        : files.some((file) => secretFileNeedsAttention(file.state))
  };
}

/**
 * One vault from the wire, repaired field-wise — or `null` when it cannot be
 * trusted at all (no valid workspace / repoKey, no `updatedAt`). A malformed
 * file, clone or path is left out on its own; a bad count is recomputed.
 */
export function sanitizeSecretVault(value: unknown): SecretVaultDetail | null {
  if (!isRecord(value)) return null;
  const { workspace, repoKey, updatedAt } = value;
  if (!isWorkspace(workspace) || !isRepoKey(repoKey) || typeof updatedAt !== "string") return null;
  const files: SecretVaultFile[] = [];
  const seenFiles = new Set<string>();
  for (const raw of Array.isArray(value.files) ? value.files : []) {
    const file = sanitizeVaultFile(raw);
    if (file === null || seenFiles.has(file.path)) continue;
    seenFiles.add(file.path);
    files.push(file);
  }
  const clones: SecretFilesClone[] = [];
  const seenClones = new Set<string>();
  for (const raw of Array.isArray(value.clones) ? value.clones : []) {
    const clone = sanitizeClone(raw);
    if (clone === null || seenClones.has(clone.projectPath)) continue;
    seenClones.add(clone.projectPath);
    clones.push(clone);
  }
  const excluded = pathList(value.excluded);
  const candidates = pathList(value.candidates);
  const revision = sanitizeRevision(value.revision);
  return {
    workspace,
    repoKey,
    ...(revision !== null ? { revision } : {}),
    fileCount: isCount(value.fileCount) ? value.fileCount : files.length,
    clonesNeedingAttention: isCount(value.clonesNeedingAttention)
      ? value.clonesNeedingAttention
      : clones.filter((clone) => clone.needsAttention).length,
    newCandidates: isCount(value.newCandidates) ? value.newCandidates : candidates.length,
    updatedAt,
    files,
    excluded,
    candidates,
    clones
  };
}

function sanitizeSummary(value: unknown): Pick<SecretVaultSummary, "workspace" | "repoKey"> | null {
  if (!isRecord(value) || !isWorkspace(value.workspace) || !isRepoKey(value.repoKey)) return null;
  return { workspace: value.workspace, repoKey: value.repoKey };
}

function sanitizeVariant(value: unknown): SecretFileVariant | null {
  if (!isRecord(value) || !nonEmpty(value.variantId) || typeof value.modifiedAt !== "string") return null;
  const projectPaths = Array.isArray(value.projectPaths) ? [...new Set(value.projectPaths.filter(nonEmpty))] : [];
  if (projectPaths.length === 0) return null;
  return {
    variantId: value.variantId,
    projectPaths,
    modifiedAt: value.modifiedAt,
    ...(isCount(value.keyCount) ? { keyCount: value.keyCount } : {}),
    ...(isCount(value.lineCount) ? { lineCount: value.lineCount } : {})
  };
}

function sanitizeCandidate(value: unknown): SecretFileCandidate | null {
  if (!isRecord(value) || !isPath(value.path)) return null;
  const variants: SecretFileVariant[] = [];
  const ids = new Set<string>();
  for (const raw of Array.isArray(value.variants) ? value.variants : []) {
    const variant = sanitizeVariant(raw);
    if (variant === null || ids.has(variant.variantId)) continue;
    ids.add(variant.variantId);
    variants.push(variant);
  }
  const format = value.format === "env" ? "env" : "lines";
  let keys: SecretFileCandidate["keys"];
  if (format === "env" && Array.isArray(value.keys)) {
    keys = [];
    const seenKeys = new Set<string>();
    for (const raw of value.keys) {
      if (!isRecord(raw) || !nonEmpty(raw.key) || seenKeys.has(raw.key) || !isRecord(raw.byVariant)) continue;
      seenKeys.add(raw.key);
      const byVariant: Record<string, number | null> = {};
      for (const id of ids) {
        const cls = raw.byVariant[id];
        byVariant[id] = typeof cls === "number" && Number.isFinite(cls) ? cls : null;
      }
      keys.push({ key: raw.key, byVariant });
    }
  }
  const refused: SecretFileCandidate["refused"] = [];
  for (const raw of Array.isArray(value.refused) ? value.refused : []) {
    if (isRecord(raw) && nonEmpty(raw.projectPath) && isRefusal(raw.refusal)) {
      refused.push({ projectPath: raw.projectPath, refusal: raw.refusal });
    }
  }
  return {
    path: value.path,
    conventional: value.conventional === true,
    managed: value.managed === true,
    excluded: value.excluded === true,
    format,
    variants,
    defaultVariantId:
      typeof value.defaultVariantId === "string" && ids.has(value.defaultVariantId) ? value.defaultVariantId : null,
    ...(keys !== undefined ? { keys } : {}),
    refused
  };
}

/** A setup scan from the wire: malformed candidates and clones are left out; a broken shape throws. */
export function sanitizeSecretFileCandidates(value: unknown): SecretFileCandidatesResponse {
  if (!isRecord(value) || !Array.isArray(value.candidates)) {
    throw new Error("The daemon answered the secret-file scan in an unexpected shape.");
  }
  const clones: SecretFileCandidatesResponse["clones"] = [];
  const seenClones = new Set<string>();
  for (const raw of Array.isArray(value.clones) ? value.clones : []) {
    if (!isRecord(raw) || !nonEmpty(raw.projectPath) || seenClones.has(raw.projectPath)) continue;
    seenClones.add(raw.projectPath);
    clones.push({
      projectPath: raw.projectPath,
      projectName: nonEmpty(raw.projectName) ? raw.projectName : lastSegment(raw.projectPath)
    });
  }
  const candidates: SecretFileCandidate[] = [];
  const seenPaths = new Set<string>();
  for (const raw of value.candidates) {
    const candidate = sanitizeCandidate(raw);
    if (candidate === null || seenPaths.has(candidate.path)) continue;
    seenPaths.add(candidate.path);
    candidates.push(candidate);
  }
  return {
    workspace: typeof value.workspace === "string" ? value.workspace : "",
    repoKey: typeof value.repoKey === "string" ? value.repoKey : "",
    clones,
    candidates
  };
}

// ---------------------------------------------------------------------------
// Versions: a write never goes backwards
// ---------------------------------------------------------------------------

function timeOf(value: string): number {
  const time = Date.parse(value);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

function sameVault(a: SecretVaultDetail, b: SecretVaultDetail): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function touch(key: string): void {
  for (const touched of openReads) touched.add(key);
}

/**
 * Where `incoming` stands against `held`: 1 newer, 0 the same, -1 older. By
 * `revision` when both carry one (same boot: the higher `seq`; another boot:
 * the daemon restarted, so `incoming` is newer), else by `updatedAt`.
 */
function order(held: Rank, incoming: Rank): -1 | 0 | 1 {
  const [a, b] = [held.revision, incoming.revision];
  if (a !== undefined && b !== undefined) {
    if (a.boot !== b.boot) return 1;
    return b.seq > a.seq ? 1 : b.seq < a.seq ? -1 : 0;
  }
  const [x, y] = [timeOf(held.updatedAt), timeOf(incoming.updatedAt)];
  return y > x ? 1 : y < x ? -1 : 0;
}

/**
 * Whether `incoming` may replace what is held for its vault. A copy of the same
 * rank replaces it only when ordered by `updatedAt` (which a clone-state change
 * doesn't move) and not `strict` — a read that a change overtook is strict: it
 * keeps the held copy unless its own is strictly newer.
 */
function accepts(current: SecretVaultDetail | undefined, incoming: SecretVaultDetail, strict = false): boolean {
  const tomb = tombstones.get(vaultKey(incoming.workspace, incoming.repoKey));
  if (tomb !== undefined && order(tomb, incoming) <= 0) return false;
  if (current === undefined) return true;
  if (sameVault(current, incoming)) return false;
  const rank = order(current, incoming);
  if (rank !== 0) return rank > 0;
  return !strict && (current.revision === undefined || incoming.revision === undefined);
}

function upsertLocal(vault: SecretVaultDetail, strict = false): void {
  const key = vaultKey(vault.workspace, vault.repoKey);
  touch(key);
  const vaults = secretFilesStore.getState().vaults;
  if (!accepts(vaults.get(key), vault, strict)) return;
  tombstones.delete(key);
  const next = new Map(vaults);
  next.set(key, vault);
  secretFilesStore.setState({ vaults: next });
}

function removeLocal(workspace: string, repoKey: string): void {
  const key = vaultKey(workspace, repoKey);
  touch(key);
  const vaults = secretFilesStore.getState().vaults;
  const current = vaults.get(key);
  const tomb = tombstones.get(key);
  if (current !== undefined && (tomb === undefined || order(tomb, current) > 0)) {
    tombstones.set(key, { updatedAt: current.updatedAt, ...(current.revision ? { revision: current.revision } : {}) });
  } else if (tomb === undefined) {
    tombstones.set(key, { updatedAt: "" });
  }
  if (current === undefined) return;
  const next = new Map(vaults);
  next.delete(key);
  secretFilesStore.setState({ vaults: next });
}

/**
 * Apply a vault a mutation answered or an event carried (`null`: deleted). The
 * vault is validated first; one for another repo, or malformed, is ignored.
 */
export function applySecretVault(workspace: string, repoKey: string, vault: SecretVaultDetail | null): void {
  if (vault === null) {
    if (isWorkspace(workspace) && isRepoKey(repoKey)) removeLocal(workspace, repoKey);
    return;
  }
  const clean = sanitizeSecretVault(vault);
  if (clean !== null && clean.workspace === workspace && clean.repoKey === repoKey) upsertLocal(clean);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * One `SECRET_FILES_CHANNEL` event. A malformed payload or an unknown type is
 * ignored — never applied half-way, never a throw into the event loop.
 */
export function applySecretFilesEvent(event: Pick<EventMessage, "type" | "payload">): void {
  if (event.type !== SECRET_FILES_CHANGED) return;
  const payload: unknown = event.payload;
  if (!isRecord(payload)) return;
  if ("vault" in payload) {
    const vault = sanitizeSecretVault(payload.vault);
    if (vault !== null) upsertLocal(vault);
    return;
  }
  if (payload.deleted === true && isWorkspace(payload.workspace) && isRepoKey(payload.repoKey)) {
    removeLocal(payload.workspace, payload.repoKey);
  }
}

// ---------------------------------------------------------------------------
// Loads
// ---------------------------------------------------------------------------

/** A client of another connection means another daemon's vaults: start over. */
function bindConnection(api: SecretFilesApi): void {
  const id = api.connection?.id;
  if (id === undefined) return;
  if (boundConnectionId !== null && boundConnectionId !== id) resetSecretFiles();
  boundConnectionId = id;
}

const isNotFound = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { status?: unknown }).status === 404;

/**
 * Replace the map with the daemon's vaults — except for vaults a change
 * touched while the load was in flight (an event or answer can overtake the
 * list it is newer than): those keep what they hold unless the load's copy is
 * strictly newer (a vault deleted meanwhile stays deleted). `kept` are vaults
 * whose detail failed to load: they keep what they hold. Any other vault takes
 * the load as it is, so a reload repairs a held copy whatever its order says.
 */
function applyLoaded(list: SecretVaultDetail[], kept: ReadonlySet<string>, touched: ReadonlySet<string>): void {
  const vaults = secretFilesStore.getState().vaults;
  const next = new Map<string, SecretVaultDetail>();
  for (const [key, vault] of vaults) {
    if (touched.has(key) || kept.has(key)) next.set(key, vault);
  }
  for (const vault of list) {
    const key = vaultKey(vault.workspace, vault.repoKey);
    const current = vaults.get(key);
    // Deleted while the load was in flight: its copy predates the delete (a
    // vault set up again since would have cleared the tombstone).
    if (touched.has(key) && (tombstones.has(key) || !accepts(current, vault, true))) continue;
    tombstones.delete(key);
    // The held object when it is the same record — subscribers see no change.
    next.set(key, current !== undefined && sameVault(current, vault) ? current : vault);
  }
  secretFilesStore.setState({ vaults: next });
}

/**
 * Every vault's detail, replacing the map. Rejects when the list fails or
 * answers in another shape; a vault deleted between the list and its detail
 * is left out, one whose detail fails otherwise keeps what is held. An answer
 * a reset or a newer load overtook is dropped quietly.
 */
export async function loadSecretVaults(api: SecretFilesApi, signal?: AbortSignal): Promise<void> {
  bindConnection(api);
  const gen = generation;
  const seq = ++loadsStarted;
  const touched = new Set<string>();
  openReads.add(touched);
  try {
    const response: unknown = await api.listSecretVaults(signal);
    if (gen !== generation || seq < loadsApplied) return;
    if (!isRecord(response) || !Array.isArray(response.vaults)) {
      throw new Error("The daemon answered the secret-file vaults in an unexpected shape.");
    }
    const summaries = response.vaults.map(sanitizeSummary).filter((summary) => summary !== null);
    const answers = await Promise.allSettled(
      summaries.map((summary) => api.getSecretVault(summary.workspace, summary.repoKey, signal))
    );
    if (gen !== generation || seq < loadsApplied) return;
    const list: SecretVaultDetail[] = [];
    const kept = new Set<string>();
    answers.forEach((answer, index) => {
      const { workspace, repoKey } = summaries[index];
      if (answer.status === "rejected") {
        if (!isNotFound(answer.reason)) kept.add(vaultKey(workspace, repoKey));
        return;
      }
      const raw: unknown = answer.value;
      const vault = isRecord(raw) ? sanitizeSecretVault(raw.vault) : null;
      if (vault !== null && vault.workspace === workspace && vault.repoKey === repoKey) list.push(vault);
      else kept.add(vaultKey(workspace, repoKey));
    });
    loadsApplied = seq;
    applyLoaded(list, kept, touched);
  } catch (error) {
    if (gen !== generation) return;
    throw error;
  } finally {
    openReads.delete(touched);
  }
}

/**
 * One vault's detail from the daemon, applied (a 404 removes it) — what the
 * dialog runs when it opens, to tell setup from manage for sure. Resolves with
 * what the store holds for it afterwards. A change that landed while the read
 * was in flight is not undone.
 */
export async function fetchSecretVault(
  api: SecretFilesApi,
  workspace: string,
  repoKey: string,
  signal?: AbortSignal
): Promise<SecretVaultDetail | null> {
  bindConnection(api);
  const gen = generation;
  const key = vaultKey(workspace, repoKey);
  const touched = new Set<string>();
  openReads.add(touched);
  try {
    let raw: unknown;
    try {
      raw = await api.getSecretVault(workspace, repoKey, signal);
    } catch (error) {
      if (gen !== generation) return getSecretVault(workspace, repoKey) ?? null;
      if (!isNotFound(error)) throw error;
      if (!touched.has(key)) removeLocal(workspace, repoKey);
      return getSecretVault(workspace, repoKey) ?? null;
    }
    if (gen !== generation) return getSecretVault(workspace, repoKey) ?? null;
    const vault = isRecord(raw) ? sanitizeSecretVault(raw.vault) : null;
    if (vault === null || vault.workspace !== workspace || vault.repoKey !== repoKey) {
      throw new Error("The daemon answered the vault in an unexpected shape.");
    }
    // Overtaken by a change: kept only when strictly newer (deleted meanwhile: dropped).
    if (!(touched.has(key) && tombstones.has(key))) upsertLocal(vault, touched.has(key));
    return getSecretVault(workspace, repoKey) ?? null;
  } finally {
    openReads.delete(touched);
  }
}

/** A connection switch or the plugin turning off: forget everything; answers still in flight are dropped. */
export function resetSecretFiles(): void {
  generation += 1;
  boundConnectionId = null;
  openReads.clear();
  tombstones.clear();
  loadsStarted = 0;
  loadsApplied = 0;
  secretFilesStore.setState(INITIAL, true);
}

// ---------------------------------------------------------------------------
// Mutations — each applies the vault the daemon answered and returns it
// ---------------------------------------------------------------------------

/**
 * Run one mutation and apply its answer. Rejects with the daemon's error (an
 * `ApiError`). Resolves with the answered vault — applied unless a reset
 * overtook it. An answer that does not parse means this copy may be wrong: the
 * vaults are reloaded, and the call resolves with what is held (or rejects
 * when nothing is).
 */
async function mutate(
  api: SecretFilesApi,
  workspace: string,
  repoKey: string,
  run: () => Promise<SecretVaultResponse>
): Promise<SecretVaultDetail> {
  bindConnection(api);
  const gen = generation;
  const answer: unknown = await run();
  const vault = isRecord(answer) ? sanitizeSecretVault(answer.vault) : null;
  if (vault === null || vault.workspace !== workspace || vault.repoKey !== repoKey) {
    if (gen === generation) void loadSecretVaults(api).catch(() => undefined);
    const held = getSecretVault(workspace, repoKey);
    if (held) return held;
    throw new Error("The daemon answered in an unexpected shape.");
  }
  if (gen === generation) upsertLocal(vault);
  return vault;
}

/** The daemon refused a push / reset because a file changed since the UI showed it (409 CONTENT_CHANGED). Duck-typed on `ApiError`. */
export function isContentChangedError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const body = (error as { body?: unknown }).body;
  return isRecord(body) && body.code === "CONTENT_CHANGED";
}

/**
 * A push / reset: on 409 CONTENT_CHANGED the vault is fetched again (what the
 * user looked at is stale), then the error is rethrown for the caller to show.
 */
async function cloneAction(
  api: SecretFilesApi,
  req: SecretFilesCloneRequest,
  run: () => Promise<SecretVaultResponse>
): Promise<SecretVaultDetail> {
  bindConnection(api);
  const gen = generation;
  try {
    return await mutate(api, req.workspace, req.repoKey, run);
  } catch (error) {
    if (isContentChangedError(error) && gen === generation) {
      void fetchSecretVault(api, req.workspace, req.repoKey).catch(() => undefined);
    }
    throw error;
  }
}

/**
 * Push a clone's modified files to the vault (every other in-sync clone then
 * updates). Pass `expect` (the content tokens shown) so a copy that changed
 * since is refused rather than pushed.
 */
export function pushSecretFiles(api: SecretFilesApi, req: SecretFilesCloneRequest): Promise<SecretVaultDetail> {
  return cloneAction(api, req, () => api.pushSecretFiles(req));
}

/** Overwrite a clone's files with the vault's version (discards that clone's changes); `expect` as for push. */
export function resetCloneSecretFiles(api: SecretFilesApi, req: SecretFilesCloneRequest): Promise<SecretVaultDetail> {
  return cloneAction(api, req, () => api.resetSecretFiles(req));
}

/** Create the vault (or add files to it: re-running setup adds). */
export function setupSecretVault(api: SecretFilesAdminApi, req: SetupSecretVaultRequest): Promise<SecretVaultDetail> {
  return mutate(api, req.workspace, req.repoKey, () => api.setupSecretVault(req));
}

/** Add / exclude / include / stop managing files. */
export function updateSecretFiles(api: SecretFilesAdminApi, req: UpdateSecretFilesRequest): Promise<SecretVaultDetail> {
  return mutate(api, req.workspace, req.repoKey, () => api.updateSecretFiles(req));
}

/** Delete the vault; clone files are left as they are. */
export async function deleteSecretVault(api: SecretFilesAdminApi, workspace: string, repoKey: string): Promise<void> {
  bindConnection(api);
  const gen = generation;
  await api.deleteSecretVault(workspace, repoKey);
  if (gen === generation) removeLocal(workspace, repoKey);
}

/** The setup scan (or one hand-typed `path`), validated. Changes nothing. */
export async function scanSecretFileCandidates(
  api: SecretFilesAdminApi,
  workspace: string,
  repoKey: string,
  path?: string,
  signal?: AbortSignal
): Promise<SecretFileCandidatesResponse> {
  const answer: unknown = await api.scanSecretFileCandidates(workspace, repoKey, path, signal);
  return sanitizeSecretFileCandidates(answer);
}
