/**
 * The device-host seam (devices spec §6.1): what the device service needs from a machine that runs
 * devices, and how host implementations plug in without editing `service.ts`.
 *
 * - {@link DeviceHost}: one machine — `local` (this host, Android emulators: `hosts/local-android.ts`)
 *   or `box:<boxId>` (a rented Mac running iOS simulators: `hosts/box-host.ts`; phase 2 adds Linux
 *   pool boxes, phase 3 paired BYO machines).
 * - {@link DeviceHostFactory}: makes and keeps a kind of host. The service starts every factory
 *   `wiring.ts` hands it; a factory adds and removes its hosts through {@link DeviceHostFactoryContext},
 *   and box factories rent one more host on request ({@link DeviceHostFactory.provision}).
 * - {@link DeviceHostRegistry}: the hosts that exist now, with one change signal.
 *
 * Hosts own their processes (hub, emulators, agent-device daemon) and their readiness probes; the
 * service owns leases, controller handoff and the action log. A host never sees a chat.
 */

import { EventEmitter } from "node:events";
import type { Readable } from "node:stream";

import type {
  DeviceActionInput,
  DeviceCapacity,
  DeviceHostBoxInfo,
  DeviceHostKind,
  DeviceHostPoolInfo,
  DeviceHostReadiness,
  DeviceHostStatus,
  DeviceHostSummary,
  DevicePlatform,
  DevicePoint,
  DeviceProfile,
  DeviceScreen,
  DeviceStreamInfo,
  DeviceSummary,
  DevicesSettings
} from "@orquester/api";
import type { StoredDeviceLease } from "@orquester/config";

/** One step of `ensureReady` or `boot`, for the setup job and the booting panel. */
export interface DeviceHostProgress {
  /** The readiness check or boot phase it works on (`android-sdk`, `avd:pixel-9`, `boot`, …). */
  step: string;
  label: string;
  state: "running" | "done" | "failed" | "skipped";
  /** 0–100 within the whole job, when known. */
  percent?: number;
  /** The latest output line (no secrets). */
  logLine?: string;
  detail?: string;
}

/** What `boot` is asked for: a new device for `leaseId` from `profile`, or an existing one (the service launches an app itself, through the action executor). */
export interface DeviceBootRequest {
  leaseId: string;
  profile: DeviceProfile;
  /** Lease this existing device (the panel's picker on a booted device). */
  deviceId?: string;
  /** Never hand back an already-booted device. */
  fresh: boolean;
}

/** A booted device, as the lease records it. */
export interface DeviceBootResult {
  deviceId: string;
  name: string;
  osVersion: string;
  screen?: DeviceScreen;
  stream: DeviceStreamInfo;
}

export interface DeviceCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * How to run the agent-device CLI against a host (`DeviceHost.agentDeviceCommand`): `command` and
 * the `args` before agent-device's own (`node`, `<pinned entry>`), and the environment the host
 * needs on top of the daemon's (`ANDROID_ADB_SERVER_PORT`, `PATH`, …). Never a secret: those stay
 * in the `--config` file.
 */
export interface AgentDeviceCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** A validated `device_action` input, as a host that drives devices itself receives it. */
export type DeviceActionRequest = DeviceActionInput;

/** A screen rectangle in device points. */
export interface DeviceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * What one action did (`actions.ts` builds it from agent-device; `DeviceHost.performAction` may
 * answer it directly). Points are device points (dp on Android), in the current orientation.
 */
export interface DeviceActionOutcome {
  /** Compact text for the agent: the snapshot tree, the settle diff, log lines. */
  text?: string;
  /** The action log's line; absent: a default one per action kind. */
  summary?: string;
  image?: { mimeType: "image/png" | "image/jpeg"; data: Buffer; width: number; height: number };
  /** Where a tap or press landed, and a swipe's ends (the panel's overlay). */
  point?: DevicePoint;
  from?: DevicePoint;
  to?: DevicePoint;
  /** The target's label ("@e7 Search"). */
  target?: string;
  /** A snapshot's refs (`e7` → frame), kept per lease to resolve later ref taps to points. */
  refs?: Record<string, DeviceRect>;
  details?: Record<string, unknown>;
}

/** The status line a host reports for its summary. */
export interface DeviceHostState {
  status: DeviceHostStatus;
  detail: string | null;
}

/**
 * One machine that runs devices. Every method may be called concurrently with others; a host
 * serializes what must be serialized (boots of one AVD, its hub's restarts) itself.
 */
export interface DeviceHost {
  /** `local` or `box:<boxId>`. */
  readonly id: string;
  readonly kind: DeviceHostKind;
  /** "This machine", "Mac host (Blacksmith, 6 vCPU)". */
  readonly label: string;
  readonly platforms: readonly DevicePlatform[];

  /** The status line, now (cheap; no I/O). */
  state(): DeviceHostState;
  /** The last readiness probe (cheap; `refreshReadiness` probes again). */
  readiness(): DeviceHostReadiness;
  /** Probe every readiness check now. */
  refreshReadiness(signal?: AbortSignal): Promise<DeviceHostReadiness>;
  /** How many devices it may run at once, and how many run under a lease. */
  capacity(): DeviceCapacity;
  /** A box host's box. */
  box?(): DeviceHostBoxInfo | null;
  /** Phase 2: its pool role. */
  pool?(): DeviceHostPoolInfo | null;

  /**
   * Install or repair what readiness names, then start the hub (and agent-device daemon). `actions`
   * limits it to those fix action ids; absent: everything missing. Resolves once ready; rejects
   * with a message written for the owner.
   */
  ensureReady(signal: AbortSignal, onProgress: (progress: DeviceHostProgress) => void, actions?: readonly string[]): Promise<void>;
  /** The hub's loopback origin (`http://127.0.0.1:<port>`) the proxy targets; null while it is not running. */
  hubOrigin(): string | null;
  /**
   * The hub's session token (it runs with `--require-token`); the proxy adds it to every upstream
   * request and strips any client-supplied one. Null when the hub needs none. Never sent to clients.
   */
  hubToken?(): string | null;
  /** What the host's hub can stream for iOS: serve-sim H.264 fails in Apple VMs (no H.264 encoder). */
  streamCapabilities?(): { iosH264: boolean };
  /** A viewer is watching one of its devices (the service relays `viewerActive`): a host may keep or end stream sessions by it. */
  viewerActive?(deviceId: string): void;
  /** The agent-device config file pinned to this host's daemon (token inside, never returned); null while not running. */
  agentDeviceConfigPath(): string | null;
  /** How to run agent-device for this host; absent: the toolchain's pinned CLI with the daemon's environment. */
  agentDeviceCommand?(): AgentDeviceCommand;
  /**
   * How many proxied streams of a device are open changed (`deviceId` is the device's id); 0: the
   * last viewer left, so the host may recycle the device's capture session.
   */
  viewersChanged?(deviceId: string, count: number): void;
  /**
   * Drive a device without agent-device (a host with its own automation): answer the action's
   * outcome, or null to let `actions.ts` run it through agent-device.
   */
  performAction?(lease: StoredDeviceLease, action: DeviceActionRequest, signal: AbortSignal): Promise<DeviceActionOutcome | null>;
  /**
   * Install a build `uploadFile` put at `uploadedPath` on the host (instead of agent-device's
   * `install`); resolves the bundle id / package when known.
   */
  installApp?(lease: StoredDeviceLease, uploadedPath: string, signal: AbortSignal): Promise<{ appId: string | null; summary: string }>;

  listDevices(signal?: AbortSignal): Promise<DeviceSummary[]>;
  /** Boot (or attach to) a device; resolves once the OS finished booting. */
  boot(request: DeviceBootRequest, signal: AbortSignal, onProgress?: (progress: DeviceHostProgress) => void): Promise<DeviceBootResult>;
  /** Turn a device off. */
  shutdown(deviceId: string, signal?: AbortSignal): Promise<void>;
  /** A lease ended: tear down what it made (an iOS lease's simulator is deleted), or just stop it with `shutdown`. */
  release(lease: StoredDeviceLease, options: { shutdown: boolean }): Promise<void>;
  /** Run a platform tool on the host (`simctl`, `adb`), never through a shell. */
  run(command: "simctl" | "adb", args: readonly string[], options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<DeviceCommandResult>;
  /** Stream a build to the host; resolves the path it landed at there. */
  uploadFile(stream: Readable, name: string, signal?: AbortSignal): Promise<{ path: string }>;

  /** A box host: destroy its box (the owner's Destroy in Settings → Devices); its leases end lost. */
  destroy?(): Promise<void>;

  /** Status, readiness, capacity or devices changed. Returns the unsubscribe. */
  onChange(listener: () => void): () => void;
  /** Stop watching; running devices are left running (a restart reattaches). */
  dispose(): Promise<void>;
}

/** What a factory needs from the service. */
export interface DeviceHostFactoryContext {
  /** The current settings (read per call: Settings → Devices changes them). */
  settings(): DevicesSettings;
  /** Leases on `hostId` that are active now (capacity, idle teardown, reconcile). */
  activeLeases(hostId: string): readonly StoredDeviceLease[];
  addHost(host: DeviceHost): void;
  removeHost(hostId: string): void;
  logger: Pick<Console, "info" | "warn" | "error">;
}

/** What renting one more host would cost, for the spend card and Settings. */
export interface DeviceRentalQuote {
  platform: DevicePlatform;
  /** Box provider id and its label. */
  provider: string;
  providerLabel: string;
  /** Provider size id and its label. */
  size: string;
  sizeLabel: string;
  /** Estimated $/h; null when the provider reports none. */
  hourlyUsd: number | null;
  /** Its time limit. */
  lifetimeMinutes: number;
  /** No standing approval covers it ("Rent … without asking" off, or over its cap): a `spend` card is needed. */
  needsApproval: boolean;
}

/** A request to rent (or prepare) one more host for a platform. */
export interface DeviceHostProvisionRequest {
  platform: DevicePlatform;
  /** The owner approved the rental (its spend card, or the panel's own Open). */
  approved: boolean;
  /** The chat whose lease needs it (its spend card, its booting steps). */
  threadId: string;
  onProgress?: (progress: DeviceHostProgress) => void;
}

/**
 * Makes and keeps one kind of host. `start` adds the hosts it has now (the local host when its
 * platform is enabled; box hosts recorded before a restart); `settingsChanged` follows Settings →
 * Devices (a platform switched on or off adds or removes hosts).
 */
export interface DeviceHostFactory {
  readonly kind: DeviceHostKind;
  /** The platforms its hosts run. */
  readonly platforms: readonly DevicePlatform[];
  start(ctx: DeviceHostFactoryContext): Promise<void>;
  /** Rent or prepare one more host for `request.platform`; absent: this kind never grows on demand. */
  provision?(request: DeviceHostProvisionRequest, signal: AbortSignal): Promise<DeviceHost>;
  /** What `provision` would rent for `platform` now (the spend card shows it); null when it cannot. */
  provisionQuote?(platform: DevicePlatform): DeviceRentalQuote | null;
  settingsChanged?(settings: DevicesSettings): void;
  /** Stop: dispose every host it added (devices keep running). */
  stop(): Promise<void>;
}

/** The hosts that exist now. */
export class DeviceHostRegistry {
  private readonly hosts = new Map<string, { host: DeviceHost; unsubscribe: () => void }>();
  private readonly events = new EventEmitter();

  add(host: DeviceHost): void {
    this.remove(host.id);
    const unsubscribe = host.onChange(() => this.events.emit("change", host.id));
    this.hosts.set(host.id, { host, unsubscribe });
    this.events.emit("change", host.id);
  }

  /** Forget a host (its factory disposes it). */
  remove(hostId: string): void {
    const entry = this.hosts.get(hostId);
    if (!entry) return;
    entry.unsubscribe();
    this.hosts.delete(hostId);
    this.events.emit("change", hostId);
  }

  get(hostId: string): DeviceHost | undefined {
    return this.hosts.get(hostId)?.host;
  }

  /** Every host, the local one first, then by id. */
  list(): DeviceHost[] {
    return [...this.hosts.values()]
      .map((entry) => entry.host)
      .sort((a, b) => (a.kind === "local" ? -1 : b.kind === "local" ? 1 : a.id.localeCompare(b.id)));
  }

  /** A host was added, removed or reported a change. Returns the unsubscribe. */
  onChange(listener: (hostId: string) => void): () => void {
    this.events.on("change", listener);
    return () => void this.events.off("change", listener);
  }

  clear(): void {
    for (const id of [...this.hosts.keys()]) this.remove(id);
  }
}

/** A host as `devices.hosts` and the routes show it. */
export function deviceHostSummary(host: DeviceHost): DeviceHostSummary {
  const state = host.state();
  const box = host.box?.() ?? null;
  const pool = host.pool?.() ?? null;
  return {
    id: host.id,
    kind: host.kind,
    label: host.label,
    platforms: [...host.platforms],
    status: state.status,
    statusDetail: state.detail,
    readiness: host.readiness(),
    capacity: host.capacity(),
    ...(box ? { box } : {}),
    ...(pool ? { pool } : {})
  };
}
