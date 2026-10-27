/**
 * Devices ("Device simulators" plugin) — this client's copy of the daemon's device state: hosts,
 * leases, profiles, settings, setup jobs, the pool summary, and the action logs of the leases a
 * panel looked at. Read by the Device panel (right rail), Settings → Devices and chat rows.
 *
 * It converges on the daemon three ways, which race freely (the `lib/boxes/store.ts` model):
 *
 * - a **load** per connection (connect, reconnect and the plugin turning on — the app store);
 * - the answer of each **mutation**, applied at once;
 * - `DEVICES_CHANNEL` **events**, routed here by the app store's `applyEvent`.
 *
 * Every write is validated first (`validate.ts`): a malformed payload is ignored, never applied
 * half-way. Each slot carries a revision every event and mutation bumps; a load whose slot moved
 * while it was in flight drops that slot's answer. While the plugin is off the store is empty.
 * `resetDevices()` runs on a connection switch (the app store), and a call through a client of
 * another connection resets first.
 */

import { createStore } from "zustand/vanilla";

import {
  DEVICE_ACTION_LOG_LIMIT,
  DEVICES_ACTION_EVENT,
  DEVICES_HOSTS_EVENT,
  DEVICES_LEASE_CLOSED_EVENT,
  DEVICES_LEASE_EVENT,
  DEVICES_POOL_EVENT,
  DEVICES_SETTINGS_EVENT,
  DEVICES_SETUP_EVENT,
  type DeviceActionEntry,
  type DeviceActionsResponse,
  type DeviceController,
  type DeviceHostSummary,
  type DeviceLeaseResponse,
  type DeviceLeaseSummary,
  type DeviceOpenRequest,
  type DevicePlatform,
  type DevicePoolSummary,
  type DeviceProfile,
  type DevicesSettings,
  type DevicesSettingsPatch,
  type DevicesSettingsResponse,
  type DevicesStateResponse,
  type DeviceSetupJob,
  type DeviceSetupRequest,
  type DeviceSetupResponse,
  type DeviceUserActionRequest,
  type DeviceUserActionResponse,
  type EventMessage
} from "@orquester/api";

import {
  sanitizeActionEvent,
  sanitizeActionsResponse,
  sanitizeDevicesState,
  sanitizeHostsPayload,
  sanitizeLeaseClosed,
  sanitizeLeasePayload,
  sanitizePoolSummary,
  sanitizeSettingsPayload,
  sanitizeSetupPayload,
  sanitizeUserActionResponse
} from "./validate";
import { resetLocalDeviceActions } from "./local-actions";
import { resetDevicePanelFocus } from "./panel-focus";

/** The routes this store calls — `ApiClient` satisfies it; tests pass a fake. */
export interface DevicesApi {
  /** The connection the client talks to; a different id resets the store. */
  readonly connection?: { readonly id: string };
  devicesState(signal?: AbortSignal): Promise<DevicesStateResponse>;
  deviceLeaseActions(leaseId: string, signal?: AbortSignal): Promise<DeviceActionsResponse>;
  openDeviceLease(req: DeviceOpenRequest): Promise<DeviceLeaseResponse>;
  releaseDeviceLease(leaseId: string, shutdown?: boolean): Promise<DeviceLeaseResponse>;
  setDeviceController(leaseId: string, controller: DeviceController): Promise<DeviceLeaseResponse>;
  deviceUserAction(leaseId: string, req: DeviceUserActionRequest): Promise<DeviceUserActionResponse>;
  updateDevicesSettings(patch: DevicesSettingsPatch): Promise<DevicesSettingsResponse>;
  startDeviceSetup(platform: DevicePlatform, req?: DeviceSetupRequest): Promise<DeviceSetupResponse>;
}

export interface DevicesState {
  /** The daemon's plugin switch as the last load said; null until loaded. */
  enabled: boolean | null;
  hosts: readonly DeviceHostSummary[] | null;
  /** Every lease (live and lost), oldest first; null until loaded. */
  leases: readonly DeviceLeaseSummary[] | null;
  profiles: readonly DeviceProfile[];
  settings: DevicesSettings | null;
  /** The latest setup job per platform. */
  setupJobs: Readonly<Partial<Record<DevicePlatform, DeviceSetupJob>>>;
  pool: DevicePoolSummary | null;
  /** Action logs by lease id, oldest first: present once loaded (`loadDeviceActions`) or an event arrived. */
  actions: Readonly<Record<string, readonly DeviceActionEntry[]>>;
}

type Slot = "hosts" | "leases" | "settings" | "setup" | "pool";

const INITIAL: DevicesState = {
  enabled: null,
  hosts: null,
  leases: null,
  profiles: [],
  settings: null,
  setupJobs: {},
  pool: null,
  actions: {}
};

export const devicesStore = createStore<DevicesState>(() => INITIAL);

// ---------------------------------------------------------------------------
// Module state (per connection; cleared by `resetDevices`)
// ---------------------------------------------------------------------------

let generation = 0;
let pluginOff = false;
let boundConnectionId: string | null = null;
const revisions: Record<Slot, number> = { hosts: 0, leases: 0, settings: 0, setup: 0, pool: 0 };

function bind(api: DevicesApi): void {
  const id = api.connection?.id;
  if (id === undefined) return;
  if (boundConnectionId !== null && boundConnectionId !== id) resetDevices();
  boundConnectionId = id;
}

function write(slot: Slot, patch: Partial<DevicesState>): void {
  if (pluginOff) return;
  revisions[slot] += 1;
  devicesStore.setState(patch);
}

/**
 * A connection switch: forget everything — the store, each chat's selected device and the panel's
 * own action rows (lease ids of another daemon mean nothing here); answers still in flight are dropped.
 */
export function resetDevices(): void {
  generation += 1;
  boundConnectionId = null;
  for (const slot of Object.keys(revisions) as Slot[]) revisions[slot] = 0;
  devicesStore.setState(INITIAL, true);
  resetDevicePanelFocus();
  resetLocalDeviceActions();
}

/** The plugin turned on or off (the app store calls this on every plugins list). Off empties the store. */
export function setDevicesPluginOn(on: boolean): void {
  if (pluginOff === !on) return;
  pluginOff = !on;
  if (!on) {
    generation += 1;
    devicesStore.setState(INITIAL, true);
  }
}

// ---------------------------------------------------------------------------
// Applying validated data
// ---------------------------------------------------------------------------

function sortLeases(leases: readonly DeviceLeaseSummary[]): DeviceLeaseSummary[] {
  return [...leases].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function upsertLease(lease: DeviceLeaseSummary): void {
  const list = devicesStore.getState().leases ?? [];
  if (lease.state === "released") {
    removeLease(lease.id);
    return;
  }
  const at = list.findIndex((entry) => entry.id === lease.id);
  write("leases", { leases: sortLeases(at === -1 ? [...list, lease] : list.map((entry, index) => (index === at ? lease : entry))) });
}

function removeLease(leaseId: string): void {
  const { leases, actions } = devicesStore.getState();
  const { [leaseId]: _gone, ...rest } = actions;
  write("leases", { leases: (leases ?? []).filter((entry) => entry.id !== leaseId), actions: rest });
}

function appendAction(leaseId: string, entry: DeviceActionEntry): void {
  if (pluginOff) return;
  const { actions } = devicesStore.getState();
  const log = actions[leaseId] ?? [];
  if (log.some((row) => row.id === entry.id)) return;
  const next = [...log, entry].slice(-DEVICE_ACTION_LOG_LIMIT);
  devicesStore.setState({ actions: { ...actions, [leaseId]: next } });
}

function applySetupJob(job: DeviceSetupJob): void {
  write("setup", { setupJobs: { ...devicesStore.getState().setupJobs, [job.platform]: job } });
}

function applyState(state: DevicesStateResponse, taken: Record<Slot, number>): void {
  if (pluginOff) return;
  const patch: Partial<DevicesState> = { enabled: state.enabled, profiles: state.profiles };
  if (revisions.hosts === taken.hosts) patch.hosts = state.hosts;
  if (revisions.leases === taken.leases) patch.leases = sortLeases(state.leases);
  if (revisions.settings === taken.settings) patch.settings = state.settings;
  if (revisions.setup === taken.setup) {
    const jobs: Partial<Record<DevicePlatform, DeviceSetupJob>> = {};
    for (const job of state.setupJobs) jobs[job.platform] = job;
    patch.setupJobs = jobs;
  }
  if (revisions.pool === taken.pool) patch.pool = state.pool ?? null;
  devicesStore.setState(patch);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** One `DEVICES_CHANNEL` event. A malformed payload or an unknown type is ignored. */
export function applyDevicesEvent(event: Pick<EventMessage, "type" | "payload">): void {
  switch (event.type) {
    case DEVICES_HOSTS_EVENT: {
      const hosts = sanitizeHostsPayload(event.payload);
      if (hosts) write("hosts", { hosts });
      return;
    }
    case DEVICES_LEASE_EVENT: {
      const lease = sanitizeLeasePayload(event.payload);
      if (lease) upsertLease(lease);
      return;
    }
    case DEVICES_LEASE_CLOSED_EVENT: {
      const closed = sanitizeLeaseClosed(event.payload);
      if (closed) removeLease(closed.leaseId);
      return;
    }
    case DEVICES_ACTION_EVENT: {
      const action = sanitizeActionEvent(event.payload);
      if (action) appendAction(action.leaseId, action.entry);
      return;
    }
    case DEVICES_SETUP_EVENT: {
      const setup = sanitizeSetupPayload(event.payload);
      if (setup?.job) applySetupJob(setup.job);
      return;
    }
    case DEVICES_SETTINGS_EVENT: {
      const settings = sanitizeSettingsPayload(event.payload);
      if (settings) write("settings", { settings });
      return;
    }
    case DEVICES_POOL_EVENT: {
      const pool = sanitizePoolSummary(event.payload);
      if (pool) write("pool", { pool });
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Loads and mutations
// ---------------------------------------------------------------------------

/** Everything (`GET /api/devices`). Rejects when the read fails or answers in another shape. */
export async function loadDevices(api: DevicesApi, signal?: AbortSignal): Promise<void> {
  bind(api);
  const gen = generation;
  const taken = { ...revisions };
  const raw = await api.devicesState(signal);
  if (gen !== generation) return;
  const state = sanitizeDevicesState(raw);
  if (!state) throw new Error("The daemon answered the devices state in an unexpected shape.");
  applyState(state, taken);
}

/** A lease's action log; events append to it from then on. */
export async function loadDeviceActions(api: DevicesApi, leaseId: string, signal?: AbortSignal): Promise<void> {
  bind(api);
  const gen = generation;
  const raw = await api.deviceLeaseActions(leaseId, signal);
  if (gen !== generation || pluginOff) return;
  const parsed = sanitizeActionsResponse(raw);
  if (!parsed) throw new Error("The daemon answered the action log in an unexpected shape.");
  const { actions } = devicesStore.getState();
  // Rows an event delivered while this read was in flight are kept.
  const seen = new Set(parsed.actions.map((row) => row.id));
  const merged = [...parsed.actions, ...(actions[leaseId] ?? []).filter((row) => !seen.has(row.id))].slice(-DEVICE_ACTION_LOG_LIMIT);
  devicesStore.setState({ actions: { ...actions, [leaseId]: merged } });
}

/** Run a mutation and apply its validated answer (dropped after a reset). */
async function mutate<T>(api: DevicesApi, run: () => Promise<unknown>, parse: (raw: unknown) => T | null, apply: (value: T) => void): Promise<T> {
  bind(api);
  const gen = generation;
  const raw = await run();
  const value = parse(raw);
  if (value === null) throw new Error("The daemon answered in an unexpected shape.");
  if (gen === generation) apply(value);
  return value;
}

/** The panel's picker: lease a device for the visible chat (it answers `starting`). */
export function openDevice(api: DevicesApi, req: DeviceOpenRequest): Promise<DeviceLeaseSummary> {
  return mutate(api, () => api.openDeviceLease(req), sanitizeLeasePayload, upsertLease);
}

/** The panel's Release (`shutdown` also turns the device off). */
export function releaseDevice(api: DevicesApi, leaseId: string, shutdown = false): Promise<DeviceLeaseSummary> {
  return mutate(api, () => api.releaseDeviceLease(leaseId, shutdown), sanitizeLeasePayload, (lease) => removeLease(lease.id));
}

/** Take over (`user`) or give back (`agent`). */
export function setDeviceController(api: DevicesApi, leaseId: string, controller: DeviceController): Promise<DeviceLeaseSummary> {
  return mutate(api, () => api.setDeviceController(leaseId, controller), sanitizeLeasePayload, upsertLease);
}

/**
 * One of the panel's buttons that is not hub input (`deviceRoutes.userAction`): the answer's lease
 * (now the user's, or released after a power off) and its log row apply at once.
 */
export function runDeviceUserAction(api: DevicesApi, leaseId: string, req: DeviceUserActionRequest): Promise<{ lease: DeviceLeaseSummary; entry: DeviceActionEntry }> {
  return mutate(api, () => api.deviceUserAction(leaseId, req), sanitizeUserActionResponse, ({ lease, entry }) => {
    if (lease.state === "released") {
      removeLease(lease.id);
      return;
    }
    upsertLease(lease);
    appendAction(lease.id, entry);
  });
}

export function updateDevicesSettings(api: DevicesApi, patch: DevicesSettingsPatch): Promise<DevicesSettings> {
  return mutate(api, () => api.updateDevicesSettings(patch), sanitizeSettingsPayload, (settings) => write("settings", { settings }));
}

/** Settings → Devices "Install all" / "Repair". */
export function startDeviceSetup(api: DevicesApi, platform: DevicePlatform, actions?: string[]): Promise<DeviceSetupJob | null> {
  return mutate(
    api,
    () => api.startDeviceSetup(platform, actions ? { actions } : {}),
    sanitizeSetupPayload,
    ({ job }) => {
      if (job) applySetupJob(job);
    }
  ).then(({ job }) => job);
}

// ---------------------------------------------------------------------------
// Pure selectors (the hooks in `hooks.ts` wrap them)
// ---------------------------------------------------------------------------

const EMPTY_LEASES: readonly DeviceLeaseSummary[] = [];

/** One chat's leases, oldest first (a stable empty list when it has none). */
export function leasesOfThread(leases: readonly DeviceLeaseSummary[] | null, threadId: string | null | undefined): readonly DeviceLeaseSummary[] {
  if (!threadId || !leases) return EMPTY_LEASES;
  const mine = leases.filter((lease) => lease.threadId === threadId);
  return mine.length > 0 ? mine : EMPTY_LEASES;
}
