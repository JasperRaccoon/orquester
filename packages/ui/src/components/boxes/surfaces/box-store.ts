/**
 * Ephemeral AI VMs — this client's copy of the boxes and the box → host config
 * changes the chat and sidebar surfaces show (spec 2026-10-19 §8.3, §8.10,
 * §9.3, §13.3).
 *
 * A stand-in for the boxes store slice another UI track builds
 * (`lib/boxes/store.ts`): only `box-data.ts` reads it, so swapping to that
 * slice is a change to `box-data.ts` alone, after which this file and its one
 * `applyEvent` branch in the app store go away.
 *
 * It converges on the daemon two ways: a full load per connection (`box-data.ts`
 * triggers it while the plugin is on) and the `boxes` channel events, whose
 * payloads carry the whole list each time. Every payload is shape-checked
 * first; a malformed one is dropped and the last good copy stays. No React
 * import, so the app store can route events here without a cycle.
 */

import { createStore } from "zustand/vanilla";

import {
  BOXES_CHANGED_EVENT,
  BOXES_CHANNEL,
  BOX_CONFIG_CHANGES_EVENT,
  BOX_SETUP_STEP_IDS,
  BOX_STATES,
  boxRoutes,
  isBoxKind,
  isBoxProviderId,
  type BoxConfigChangeFile,
  type BoxConfigChangeSet,
  type BoxConfigChangeState,
  type BoxDestroyedReason,
  type BoxSetupStep,
  type BoxSetupStepState,
  type BoxState,
  type BoxSummary,
  type DecideBoxConfigChangeRequest,
  type EventMessage
} from "@orquester/api";

/** The routes this store calls — `ApiClient` satisfies it; tests pass a fake. */
export interface BoxSurfacesApi {
  readonly connection?: { readonly id: string };
  send<T>(method: "GET" | "POST" | "DELETE", path: string, options?: { body?: unknown; signal?: AbortSignal }): Promise<T>;
}

export interface BoxSurfacesState {
  /** Every box the daemon reported, destroyed ones included; null until the first load answers. */
  boxes: readonly BoxSummary[] | null;
  /** Config change sets, pending first; null until the first load answers. */
  configChanges: readonly BoxConfigChangeSet[] | null;
}

const INITIAL: BoxSurfacesState = { boxes: null, configChanges: null };

export const boxSurfacesStore = createStore<BoxSurfacesState>(() => INITIAL);

/** Bumped by a reset: a load that started before it is dropped when it answers. */
let generation = 0;

// ---------------------------------------------------------------------------
// Wire validation
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const stringOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);
const finiteOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const DESTROYED_REASONS: ReadonlySet<string> = new Set<BoxDestroyedReason>([
  "deleted",
  "agent",
  "time-limit",
  "chat-closed",
  "provider-gone",
  "provider-error",
  "provisioning-failed",
  "orphan"
]);
const STEP_STATES: ReadonlySet<string> = new Set<BoxSetupStepState>(["pending", "running", "done", "failed", "skipped"]);
const CHANGE_STATES: ReadonlySet<string> = new Set<BoxConfigChangeState>(["pending", "approved", "denied", "stale"]);

const isBoxState = (value: unknown): value is BoxState =>
  typeof value === "string" && (BOX_STATES as readonly string[]).includes(value);

/** A destroyed reason this build knows, else null (a newer daemon's reason reads as "destroyed"). */
export function readDestroyedReason(value: unknown): BoxDestroyedReason | null {
  return typeof value === "string" && DESTROYED_REASONS.has(value) ? (value as BoxDestroyedReason) : null;
}

function parseSetupStep(value: unknown): BoxSetupStep | null {
  if (!isRecord(value) || !isString(value.id) || !(BOX_SETUP_STEP_IDS as readonly string[]).includes(value.id)) return null;
  if (!isString(value.label) || !isString(value.state) || !STEP_STATES.has(value.state)) return null;
  return {
    id: value.id as BoxSetupStep["id"],
    label: value.label,
    state: value.state as BoxSetupStepState,
    startedAt: stringOrNull(value.startedAt),
    finishedAt: stringOrNull(value.finishedAt),
    message: stringOrNull(value.message)
  };
}

/**
 * A box from untrusted JSON, or null when it is not one. Unknown extra fields
 * are dropped; optional ones that do not read fall back to null rather than
 * failing the whole box.
 */
export function parseBoxSummary(value: unknown): BoxSummary | null {
  if (!isRecord(value) || !nonEmpty(value.id) || !isBoxKind(value.kind) || !isBoxProviderId(value.provider)) return null;
  if (!isBoxState(value.state) || !isString(value.createdAt)) return null;
  if (value.purpose !== "project" && value.purpose !== "temporary") return null;
  const project = isRecord(value.project) && isString(value.project.path) && isString(value.project.workspace) && isString(value.project.name)
    ? { workspace: value.project.workspace, name: value.project.name, path: value.project.path }
    : null;
  const os = value.os === "linux" || value.os === "win32" || value.os === "darwin" ? value.os : null;
  const arch = value.arch === "x64" || value.arch === "arm64" ? value.arch : null;
  return {
    id: value.id,
    purpose: value.purpose,
    kind: value.kind,
    provider: value.provider,
    providerLabel: nonEmpty(value.providerLabel) ? value.providerLabel : value.provider,
    region: isString(value.region) ? value.region : "",
    regionLabel: isString(value.regionLabel) ? value.regionLabel : "",
    size: isString(value.size) ? value.size : "",
    sizeLabel: isString(value.sizeLabel) ? value.sizeLabel : "",
    image: stringOrNull(value.image),
    os,
    arch,
    state: value.state,
    stateReason: stringOrNull(value.stateReason),
    destroyedReason: readDestroyedReason(value.destroyedReason),
    hourlyUsd: finiteOrNull(value.hourlyUsd),
    estimatedCostUsd: finiteOrNull(value.estimatedCostUsd) ?? 0,
    createdAt: value.createdAt,
    readyAt: stringOrNull(value.readyAt),
    deadlineAt: stringOrNull(value.deadlineAt),
    destroyedAt: stringOrNull(value.destroyedAt),
    connected: value.connected === true,
    lastSeenAt: stringOrNull(value.lastSeenAt),
    project,
    threadId: nonEmpty(value.threadId) ? value.threadId : null,
    purposeNote: stringOrNull(value.purposeNote),
    setup: Array.isArray(value.setup) ? value.setup.flatMap((step) => parseSetupStep(step) ?? []) : []
  };
}

function parseConfigChangeFile(value: unknown): BoxConfigChangeFile | null {
  if (!isRecord(value) || !nonEmpty(value.path)) return null;
  if (value.change !== "added" && value.change !== "modified" && value.change !== "deleted") return null;
  return {
    path: value.path,
    change: value.change,
    executable: value.executable === true,
    diff: isString(value.diff) ? value.diff : "",
    truncated: value.truncated === true,
    binary: value.binary === true
  };
}

/** A config change set from untrusted JSON, or null. A file that does not read is left out. */
export function parseBoxConfigChangeSet(value: unknown): BoxConfigChangeSet | null {
  if (!isRecord(value) || !nonEmpty(value.id) || !nonEmpty(value.boxId) || !isString(value.createdAt)) return null;
  if (!isString(value.state) || !CHANGE_STATES.has(value.state)) return null;
  return {
    id: value.id,
    boxId: value.boxId,
    threadId: nonEmpty(value.threadId) ? value.threadId : null,
    createdAt: value.createdAt,
    decidedAt: stringOrNull(value.decidedAt),
    state: value.state as BoxConfigChangeState,
    files: Array.isArray(value.files) ? value.files.flatMap((file) => parseConfigChangeFile(file) ?? []) : []
  };
}

/** The `boxes` list of a `BoxesResponse`, or null when the payload is not one. */
export function parseBoxList(value: unknown): BoxSummary[] | null {
  if (!isRecord(value) || !Array.isArray(value.boxes)) return null;
  return value.boxes.flatMap((box) => parseBoxSummary(box) ?? []);
}

/** The `changes` list of a `BoxConfigChangesResponse`, or null when the payload is not one. */
export function parseConfigChangeList(value: unknown): BoxConfigChangeSet[] | null {
  if (!isRecord(value) || !Array.isArray(value.changes)) return null;
  return value.changes.flatMap((change) => parseBoxConfigChangeSet(change) ?? []);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Forget everything (connection switch, plugin turned off). A load in flight is dropped. */
export function resetBoxSurfaces(): void {
  generation += 1;
  boxSurfacesStore.setState(INITIAL, true);
}

/**
 * Load the boxes and the config changes. Each half lands on its own; a half
 * that fails (an older daemon without the plugin's routes) leaves what is held.
 */
export async function loadBoxSurfaces(api: BoxSurfacesApi): Promise<void> {
  const started = generation;
  const [boxes, changes] = await Promise.allSettled([
    api.send<unknown>("GET", boxRoutes.list),
    api.send<unknown>("GET", boxRoutes.configChanges)
  ]);
  if (started !== generation) return;
  const next: Partial<BoxSurfacesState> = {};
  const boxList = boxes.status === "fulfilled" ? parseBoxList(boxes.value) : null;
  if (boxList) next.boxes = boxList;
  const changeList = changes.status === "fulfilled" ? parseConfigChangeList(changes.value) : null;
  if (changeList) next.configChanges = changeList;
  if (next.boxes || next.configChanges) boxSurfacesStore.setState(next);
}

/** Route one `boxes` channel event here (the app store's `applyEvent`). Other events are ignored. */
export function applyBoxSurfacesEvent(event: EventMessage): void {
  if (event.channel !== BOXES_CHANNEL) return;
  if (event.type === BOXES_CHANGED_EVENT) {
    const boxes = parseBoxList(event.payload);
    if (boxes) boxSurfacesStore.setState({ boxes });
  } else if (event.type === BOX_CONFIG_CHANGES_EVENT) {
    const configChanges = parseConfigChangeList(event.payload);
    if (configChanges) boxSurfacesStore.setState({ configChanges });
  }
}

/** Put one decided (or refreshed) change set in place of the copy held. */
export function upsertConfigChange(change: BoxConfigChangeSet): void {
  const held = boxSurfacesStore.getState().configChanges ?? [];
  const index = held.findIndex((entry) => entry.id === change.id);
  const configChanges = index === -1 ? [...held, change] : held.map((entry, i) => (i === index ? change : entry));
  boxSurfacesStore.setState({ configChanges });
}

/** Approve or deny one change set; the answer replaces the copy held. */
export async function decideBoxConfigChange(
  api: BoxSurfacesApi,
  id: string,
  decision: DecideBoxConfigChangeRequest["decision"]
): Promise<BoxConfigChangeSet | null> {
  const body: DecideBoxConfigChangeRequest = { decision };
  const answer = await api.send<unknown>("POST", boxRoutes.configChange(id), { body });
  const change = isRecord(answer) ? parseBoxConfigChangeSet(answer.change) : null;
  if (change) upsertConfigChange(change);
  return change;
}

/** Destroy a temporary box. The state change arrives as a `boxes.changed` event. */
export async function destroyTemporaryBox(api: BoxSurfacesApi, id: string): Promise<void> {
  await api.send<unknown>("DELETE", boxRoutes.box(id));
}
