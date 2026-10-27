// Devices — iOS simulators and Android emulators beside agent chats, the "Device simulators"
// built-in plugin (docs/superpowers/specs/2026-10-27-devices-phase-1-core.md; phase 2 pools:
// `…-phase-2-fleet.md`; phase 3 bring-your-own hosts and vphone: `…-phase-3-byo-research.md`).
//
// - Device hosts run devices: `local` (this host, Android), `box:<boxId>` (a rented box; `kind`
//   `box`, or `byo` for an owner's own paired machine, phase 3).
// - A device is keyed `<hostId>/<deviceId>` (Android serials repeat across hosts).
// - A lease is one chat's exclusive claim on one device; its controller (`agent` | `user`) says
//   who may drive it right now.
// - Routes: {@link deviceRoutes}; the hub proxy under `/api/devices/hosts/:hostId/hub/*` and the
//   WebSocket relay under {@link DEVICE_WS_PREFIXES}. Bus: {@link DEVICES_CHANNEL}.
// - Persisted shapes and the settings defaults live in `@orquester/config` (`devices.ts`).

import {
  DEFAULT_ANDROID_DEVICE_PROFILE_IDS,
  DEFAULT_IOS_DEVICE_PROFILE_IDS,
  DEVICE_PLACEMENT_MODES,
  DEVICES_SETTINGS_LIMITS,
  DEVICES_VPHONE_HOST_KEY,
  DEVICES_VPHONE_HOSTS_MAX,
  DEVICES_VPHONE_SOURCE_MAX,
  type DevicesSettings,
  type DevicesSettingsPatch,
  type DevicesVphoneHostSettings
} from "@orquester/config";

import { sessionToolNameOfData, sessionToolReferences } from "./agent-chat/session-tools.ts";

export type {
  DevicePlacementMode,
  DevicePoolSettings,
  DevicesAgentSettings,
  DevicesAndroidSettings,
  DevicesIosSettings,
  DevicesResearchSettings,
  DevicesSettings,
  DevicesSettingsPatch,
  DevicesVphoneHostSettings
} from "@orquester/config";
export { DEFAULT_DEVICES_SETTINGS, DEVICES_SETTINGS_LIMITS, DEVICE_PLACEMENT_MODES } from "@orquester/config";

/** The built-in plugin's id (Settings → Plugins → "Device simulators"). */
export const DEVICES_PLUGIN_ID = "devices";

// ---------------------------------------------------------------------------
// Platforms and profiles
// ---------------------------------------------------------------------------

export type DevicePlatform = "ios" | "android";
export const DEVICE_PLATFORMS: readonly DevicePlatform[] = ["ios", "android"];
/** How Settings and the picker group them. */
export const DEVICE_PLATFORM_LABELS: Readonly<Record<DevicePlatform, string>> = { ios: "iPhone & iPad", android: "Android" };

export function isDevicePlatform(value: unknown): value is DevicePlatform {
  return value === "ios" || value === "android";
}

export type DeviceFormFactor = "phone" | "tablet" | "foldable";

/** The Android system image every phase 1 AVD uses (API 35: API 37 needs 4 GB per emulator). */
export const ANDROID_SYSTEM_IMAGE = "system-images;android-35;google_apis;x86_64";

/**
 * A device model the owner or an agent can ask for. Hints for the hosts: an Android profile names
 * the `avdmanager --device` hardware profile; an iOS profile the `simctl` device type names, most
 * preferred first (the newest the Mac's Xcode has wins).
 */
export interface DeviceProfile {
  id: string;
  platform: DevicePlatform;
  /** Display name: "Pixel 9", "iPhone 17 Pro". */
  label: string;
  formFactor: DeviceFormFactor;
  /** The OS it boots, as shown: "Android 15", "iOS 26". */
  os: string;
  /** Android: `avdmanager create avd --device <avdDevice>`. */
  avdDevice?: string;
  /** Android: the `sdkmanager` system image package. */
  systemImage?: string;
  /** iOS: `xcrun simctl create … <device type>` names, most preferred first. */
  simDeviceTypes?: readonly string[];
  /** The 3D frame the panel draws it in, when one ships (`packages/ui/src/components/device/models`). */
  modelId?: string;
}

export const DEVICE_PROFILES: readonly DeviceProfile[] = [
  { id: "pixel-9", platform: "android", label: "Pixel 9", formFactor: "phone", os: "Android 15", avdDevice: "pixel_9", systemImage: ANDROID_SYSTEM_IMAGE },
  { id: "pixel-tablet", platform: "android", label: "Pixel Tablet", formFactor: "tablet", os: "Android 15", avdDevice: "pixel_tablet", systemImage: ANDROID_SYSTEM_IMAGE },
  { id: "pixel-fold", platform: "android", label: "Pixel Fold", formFactor: "foldable", os: "Android 15", avdDevice: "pixel_fold", systemImage: ANDROID_SYSTEM_IMAGE },
  // Samsung Galaxy: generic hardware profiles (avdmanager ships none of Samsung's) with the real
  // screens' aspect; the panel matches their `orq-galaxy-…` AVD names to the Samsung 3D models.
  { id: "galaxy-s26", platform: "android", label: "Galaxy S26", formFactor: "phone", os: "Android 15", avdDevice: "pixel_9", systemImage: ANDROID_SYSTEM_IMAGE, modelId: "galaxy-s26" },
  { id: "galaxy-s26-plus", platform: "android", label: "Galaxy S26+", formFactor: "phone", os: "Android 15", avdDevice: "pixel_9", systemImage: ANDROID_SYSTEM_IMAGE, modelId: "galaxy-s26-plus" },
  { id: "galaxy-s26-ultra", platform: "android", label: "Galaxy S26 Ultra", formFactor: "phone", os: "Android 15", avdDevice: "pixel_9", systemImage: ANDROID_SYSTEM_IMAGE, modelId: "galaxy-s26-ultra" },
  { id: "galaxy-z-fold8", platform: "android", label: "Galaxy Z Fold8", formFactor: "foldable", os: "Android 15", avdDevice: "7.6in Foldable", systemImage: ANDROID_SYSTEM_IMAGE, modelId: "galaxy-z-fold8" },
  { id: "galaxy-z-flip8", platform: "android", label: "Galaxy Z Flip8", formFactor: "foldable", os: "Android 15", avdDevice: "6.7in Foldable", systemImage: ANDROID_SYSTEM_IMAGE, modelId: "galaxy-z-flip8" },
  { id: "iphone-17-pro", platform: "ios", label: "iPhone 17 Pro", formFactor: "phone", os: "iOS 26", simDeviceTypes: ["iPhone 17 Pro"] },
  { id: "iphone-17-pro-max", platform: "ios", label: "iPhone 17 Pro Max", formFactor: "phone", os: "iOS 26", simDeviceTypes: ["iPhone 17 Pro Max"] },
  {
    id: "ipad-pro-13",
    platform: "ios",
    label: "iPad Pro 13-inch",
    formFactor: "tablet",
    os: "iPadOS 26",
    simDeviceTypes: ["iPad Pro 13-inch (M5)", "iPad Pro 13-inch (M4)"],
    modelId: "ipad-pro-13-m5"
  },
  { id: "iphone-duo", platform: "ios", label: "iPhone Duo", formFactor: "foldable", os: "iOS 26", simDeviceTypes: ["iPhone Duo"], modelId: "iphone-duo" }
];

/** The profile `open_device` uses when none is named. */
export const DEFAULT_DEVICE_PROFILE: Readonly<Record<DevicePlatform, string>> = {
  android: DEFAULT_ANDROID_DEVICE_PROFILE_IDS[0]!,
  ios: DEFAULT_IOS_DEVICE_PROFILE_IDS[0]!
};

export function deviceProfile(id: string): DeviceProfile | undefined {
  return DEVICE_PROFILES.find((profile) => profile.id === id);
}

export function deviceProfilesFor(platform: DevicePlatform): DeviceProfile[] {
  return DEVICE_PROFILES.filter((profile) => profile.platform === platform);
}

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

/** `local`: this host; `box`: a rented box; `byo`: the owner's own paired machine (phase 3). */
export type DeviceHostKind = "local" | "box" | "byo";
export const DEVICE_HOST_KINDS: readonly DeviceHostKind[] = ["local", "box", "byo"];

export const LOCAL_DEVICE_HOST_ID = "local";
export const LOCAL_DEVICE_HOST_LABEL = "This machine";

/** A box's device-host id: `box:<boxId>` (a BYO box too: its kind says which). */
export function boxDeviceHostId(boxId: string): string {
  return `box:${boxId}`;
}

/** The box a host id names, or null for the local host or anything else. */
export function boxIdOfDeviceHost(hostId: string): string | null {
  return hostId.startsWith("box:") && hostId.length > 4 ? hostId.slice(4) : null;
}

/**
 * - `disabled` — its platform is off in Settings → Devices.
 * - `needs-setup` — a readiness check is missing or failed; nothing runs until it is fixed.
 * - `installing` — a setup job is fixing it.
 * - `starting` — booting its hub (a box: being rented and prepared).
 * - `ready` — leases can be placed on it.
 * - `unreachable` — a box whose link dropped; its devices keep running (phase 2: leases `suspended`).
 * - `stopping` — being torn down (a box: destroyed).
 * - `failed` — its hub or box failed; `statusDetail` says why.
 */
export type DeviceHostStatus = "disabled" | "needs-setup" | "installing" | "starting" | "ready" | "unreachable" | "stopping" | "failed";

/** One readiness item: `working` while a setup job is on it. */
export type DeviceReadinessState = "ok" | "missing" | "error" | "working";

export interface DeviceReadinessCheck {
  /** Stable id: `kvm`, `node`, `ffmpeg`, `android-sdk`, `system-image`, `avd:<profile>`, `snapshot:<profile>`, `tool:<name>`, … */
  id: string;
  label: string;
  state: DeviceReadinessState;
  /** One line: what is installed, or what is wrong. */
  detail: string | null;
  /** The setup action that installs or repairs it (a `DeviceSetupRequest.actions` entry); absent: the owner must fix it. */
  fixActionId?: string;
}

export interface DeviceHostReadiness {
  /** Every check is `ok`. */
  ready: boolean;
  checks: DeviceReadinessCheck[];
  /** When it was last probed; null before the first probe. */
  checkedAt: string | null;
}

export interface DeviceCapacity {
  /** Devices running under a lease. */
  used: number;
  /** How many it may run at once (the host's formula, clamped by Settings). */
  total: number;
}

/** A host that is a rented (or paired) box. */
export interface DeviceHostBoxInfo {
  boxId: string;
  provider: string;
  /** Estimated $/h; null when the provider reported none (0 for a BYO box). */
  hourlyUsd: number | null;
  startedAt: string;
  /** When the box's time limit ends; null for none. */
  deadlineAt: string | null;
}

/** Phase 2: a pool host's place in the fleet. */
export interface DeviceHostPoolInfo {
  /** Being drained: no new leases, destroyed once empty. */
  draining: boolean;
  /** Kept warm by `minWarmHosts`. */
  warm: boolean;
  /** Since when it has had no lease (idle teardown counts from here); null while in use. */
  idleSince: string | null;
}

export interface DeviceHostSummary {
  id: string;
  kind: DeviceHostKind;
  label: string;
  platforms: DevicePlatform[];
  status: DeviceHostStatus;
  /** One line about the status (what failed, what it waits on); null for none. */
  statusDetail: string | null;
  readiness: DeviceHostReadiness;
  capacity: DeviceCapacity;
  box?: DeviceHostBoxInfo;
  pool?: DeviceHostPoolInfo;
  /**
   * Phase 3: a research host (vphone-cli VMs running real iOS). Never chosen for a lease unless
   * the request names it; the picker and Settings show {@link notice} beside it.
   */
  research?: boolean;
  /** What the owner must know before using it ({@link VPHONE_RESEARCH_NOTICE} on a vphone host). */
  notice?: string;
}

/** The per-machine switch's label in Settings (phase 3 §2.3). */
export const VPHONE_RESEARCH_LABEL = "Virtual iPhones (research)";
/** Shown with every vphone research host, in Settings and in the device picker. */
export const VPHONE_RESEARCH_NOTICE = "Research — real iOS in a VM; not for App Store apps; Apple's licence terms may not allow this use";

// ---------------------------------------------------------------------------
// Devices and leases
// ---------------------------------------------------------------------------

/** `<hostId>/<deviceId>`: how a device is named everywhere (tools, the panel, the action log). */
export function deviceKey(hostId: string, deviceId: string): string {
  return `${hostId}/${deviceId}`;
}

/** The parts of a device key (split at the first `/`), or null when it is not one. */
export function parseDeviceKey(key: string): { hostId: string; deviceId: string } | null {
  const at = key.indexOf("/");
  if (at <= 0 || at === key.length - 1) return null;
  return { hostId: key.slice(0, at), deviceId: key.slice(at + 1) };
}

export interface DeviceScreen {
  /** In points (iOS) or dp (Android), portrait. */
  width: number;
  height: number;
  /** Pixels per point. */
  scale: number;
}

/** A device a host runs (leased or not). */
export interface DeviceSummary {
  key: string;
  hostId: string;
  /** The simulator UDID or the emulator serial. */
  id: string;
  platform: DevicePlatform;
  name: string;
  osVersion: string;
  /** The profile it was made from, when Orquester made it. */
  profile: string | null;
  booted: boolean;
  /** The active lease on it, or null. */
  leaseId: string | null;
}

/**
 * - `starting` — being booted (an iOS host may be rented first).
 * - `ready` — leased and running.
 * - `suspended` — its host's link dropped; the device keeps running (phase 2).
 * - `lost` — its host or device is gone; the agent's next call answers `DEVICE_LOST`.
 * - `released` — over (only ever seen in a `devices.lease` event right before `devices.lease.closed`).
 */
export type DeviceLeaseState = "starting" | "ready" | "suspended" | "lost" | "released";
export const DEVICE_LEASE_STATES: readonly DeviceLeaseState[] = ["starting", "ready", "suspended", "lost", "released"];

export function isDeviceLeaseState(value: unknown): value is DeviceLeaseState {
  return typeof value === "string" && (DEVICE_LEASE_STATES as readonly string[]).includes(value);
}

/** Who may drive a leased device right now (spec §7). */
export type DeviceController = "agent" | "user";

export function isDeviceController(value: unknown): value is DeviceController {
  return value === "agent" || value === "user";
}

/** How the panel reads a device's video: serve-sim (iOS), serve-emu (Android), vphone (phase 3). */
export type DeviceStreamKind = "serve-sim" | "serve-emu" | "vphone";

export interface DeviceStreamInfo {
  kind: DeviceStreamKind;
  /** The `device` query value the hub's stream routes take for it. */
  deviceParam: string;
}

/** Why a lease ended. */
export type DeviceLeaseCloseReason = "agent" | "user" | "chat-closed" | "idle" | "host-lost" | "plugin-off" | "failed";

/** What a `starting` lease is doing now (the panel's booting steps, with elapsed time from `startedAt`). */
export interface DeviceLeaseProgress {
  /** `rent-host` (iOS: renting a Mac host, with its cost), `prepare-host`, `start-device`, `connect-video`, or a host's own step. */
  step: string;
  label: string;
  startedAt: string;
}

export interface DeviceLeaseSummary {
  id: string;
  /** `<hostId>/<deviceId>`; null while the host has not assigned the device yet (`starting`). */
  key: string | null;
  /** The chat that holds it (`sessionId`). */
  threadId: string;
  hostId: string;
  /** Null while `starting` (see `key`). */
  deviceId: string | null;
  platform: DevicePlatform;
  profile: string;
  name: string;
  osVersion: string;
  state: DeviceLeaseState;
  controller: DeviceController;
  /** Who opened it: an agent (`open_device`) or the user (the panel's picker). */
  openedBy: "agent" | "user";
  screen?: DeviceScreen;
  /** Absent until the device streams. */
  stream?: DeviceStreamInfo;
  createdAt: string;
  lastUsedAt: string;
  /** What went wrong (a failed boot, a lost host). */
  error?: string;
  /** While `starting`: the current step (memory only; absent after a restart). */
  progress?: DeviceLeaseProgress;
}

/** Whether a lease still holds its device (not lost, not released). */
export function isActiveDeviceLease(lease: Pick<DeviceLeaseSummary, "state">): boolean {
  return lease.state === "starting" || lease.state === "ready" || lease.state === "suspended";
}

// ---------------------------------------------------------------------------
// Actions (the `device_action` tool, the panel's input, the action log)
// ---------------------------------------------------------------------------

export const DEVICE_ACTION_KINDS = [
  "snapshot",
  "tap",
  "long_press",
  "fill",
  "type",
  "press",
  "swipe",
  "scroll",
  "open_app",
  "close_app",
  "open_url",
  "screenshot",
  "logs",
  "rotate",
  "appearance",
  "location",
  "permissions",
  "wait"
] as const;
export type DeviceActionKind = (typeof DEVICE_ACTION_KINDS)[number];

/** Actions that change nothing on the device: allowed while the user has control, `read` tier for the tool. */
export const DEVICE_READ_ONLY_ACTIONS: readonly DeviceActionKind[] = ["snapshot", "screenshot", "logs", "wait"];

export function isDeviceActionKind(value: unknown): value is DeviceActionKind {
  return typeof value === "string" && (DEVICE_ACTION_KINDS as readonly string[]).includes(value);
}

export function isReadOnlyDeviceAction(kind: DeviceActionKind): boolean {
  return DEVICE_READ_ONLY_ACTIONS.includes(kind);
}

export const DEVICE_PRESS_KEYS = ["home", "back", "enter", "app_switch", "volume_up", "volume_down", "lock"] as const;
export type DevicePressKey = (typeof DEVICE_PRESS_KEYS)[number];

export type DeviceDirection = "up" | "down" | "left" | "right";
export const DEVICE_DIRECTIONS: readonly DeviceDirection[] = ["up", "down", "left", "right"];

export interface DevicePoint {
  x: number;
  y: number;
}

/** Longest `logs` window, in seconds. */
export const DEVICE_LOGS_MAX_SECONDS = 60;
/** Longest `wait`, in milliseconds. */
export const DEVICE_WAIT_MAX_MS = 60_000;
/** Longest text `fill` / `type` take. */
export const DEVICE_TEXT_MAX_CHARS = 4_000;

/**
 * One `device_action` call, flat (each kind reads its own fields; {@link validateDeviceActionInput}
 * says which it needs). Coordinates are points (dp on Android) in the device's current orientation.
 */
export interface DeviceActionInput {
  action: DeviceActionKind;
  /** An accessibility ref from the last snapshot: `@e7`. */
  ref?: string;
  x?: number;
  y?: number;
  text?: string;
  key?: DevicePressKey;
  direction?: DeviceDirection;
  from?: DevicePoint;
  to?: DevicePoint;
  /** Bundle id (iOS) or package name (Android). */
  app?: string;
  url?: string;
  /** `logs`: how far back. */
  seconds?: number;
  /** `long_press`: hold time. */
  durationMs?: number;
  orientation?: "portrait" | "landscape";
  appearance?: "light" | "dark";
  lat?: number;
  lon?: number;
  permission?: string;
  grant?: "grant" | "revoke";
  /** `wait`: up to this long. */
  timeoutMs?: number;
}

/** Null when the input has what its action needs, else a message written for the agent. */
export function validateDeviceActionInput(input: DeviceActionInput): string | null {
  const point = input.x !== undefined || input.y !== undefined;
  const hasPoint = input.x !== undefined && input.y !== undefined;
  switch (input.action) {
    case "tap":
    case "long_press":
      if (input.ref === undefined && !hasPoint) return `${input.action} needs \`ref\` (from a snapshot) or both \`x\` and \`y\`.`;
      if (input.ref !== undefined && point) return `${input.action} takes \`ref\` or \`x\`/\`y\`, not both.`;
      return null;
    case "fill":
      if (input.ref === undefined || input.text === undefined) return "fill needs `ref` and `text`.";
      return null;
    case "type":
      return input.text === undefined ? "type needs `text`." : null;
    case "press":
      return input.key === undefined ? `press needs \`key\`: ${DEVICE_PRESS_KEYS.join(", ")}.` : null;
    case "swipe":
      if (input.direction === undefined && (input.from === undefined || input.to === undefined)) return "swipe needs `direction`, or `from` and `to`.";
      return null;
    case "scroll":
      return input.direction === undefined ? "scroll needs `direction`." : null;
    case "open_app":
    case "close_app":
      return input.app === undefined ? `${input.action} needs \`app\` (bundle id or package name).` : null;
    case "open_url":
      return input.url === undefined ? "open_url needs `url`." : null;
    case "rotate":
      return input.orientation === undefined ? "rotate needs `orientation`: portrait or landscape." : null;
    case "appearance":
      return input.appearance === undefined ? "appearance needs `appearance`: light or dark." : null;
    case "location":
      return input.lat === undefined || input.lon === undefined ? "location needs `lat` and `lon`." : null;
    case "permissions":
      if (input.app === undefined || input.permission === undefined || input.grant === undefined) return "permissions needs `app`, `permission` and `grant`.";
      return null;
    case "wait":
      return input.text === undefined && input.ref === undefined ? "wait needs `text` or `ref` to wait for." : null;
    case "snapshot":
    case "screenshot":
    case "logs":
      return null;
  }
}

/** Who did an action the log shows. */
export type DeviceActor = "agent" | "user";

/**
 * One action-log row (spec §9): the panel lists it and draws taps and swipes from `point` /
 * `from`–`to` (points, in the device's orientation at the time). The daemon keeps the last
 * {@link DEVICE_ACTION_LOG_LIMIT} per lease in memory.
 */
export interface DeviceActionEntry {
  id: string;
  leaseId: string;
  at: string;
  actor: DeviceActor;
  kind: DeviceActionKind;
  /** One line: "Tapped @e7 “Search”", "Typed 12 characters". */
  summary: string;
  point?: DevicePoint;
  from?: DevicePoint;
  to?: DevicePoint;
  /** The target's label, for the overlay ripple ("@e7 Search"). */
  target?: string;
  ok: boolean;
  /** Why it failed (`ok: false`). */
  error?: string;
}

export const DEVICE_ACTION_LOG_LIMIT = 200;

// ---------------------------------------------------------------------------
// Setup jobs
// ---------------------------------------------------------------------------

export type DeviceSetupJobState = "running" | "done" | "failed" | "cancelled";
export type DeviceSetupJobKind = "setup" | "cache-warm";
export type DeviceSetupStepState = "pending" | "running" | "done" | "failed" | "skipped";

export interface DeviceSetupStep {
  /** The readiness check (or fix action) it works on. */
  id: string;
  label: string;
  state: DeviceSetupStepState;
  detail: string | null;
}

/**
 * An install or repair (Settings → Devices "Install all", or an agent's first request), or —
 * `kind: "cache-warm"` — a device-cache warm run on the box provider (POST {@link deviceRoutes.cacheWarm};
 * listed in {@link DevicePoolSummary.cacheJobs}, never in `setupJobs`).
 */
export interface DeviceSetupJob {
  id: string;
  /** Absent: `setup`. */
  kind?: DeviceSetupJobKind;
  /** A cache-warm run's page on the provider (GitHub Actions), when known. */
  url?: string | null;
  platform: DevicePlatform;
  hostId: string;
  state: DeviceSetupJobState;
  steps: DeviceSetupStep[];
  /** Overall progress 0–100; null when unknown. */
  percent: number | null;
  /** The latest line of the running step's output (no secrets). */
  logLine: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

// ---------------------------------------------------------------------------
// Phase 2: the pool
// ---------------------------------------------------------------------------

/** Why a queued lease request waits. */
export type DevicePoolWaitReason =
  /** A host that is starting (or being rented for it) will have a slot. */
  | "host-starting"
  /** Every host is full and no more may be rented (`maxHosts`, or none can be rented). */
  | "capacity"
  /** Renting another host would exceed `maxHourlyUsd`. */
  | "budget";

/** One lease request waiting for room (the fleet view's queue). */
export interface DevicePoolWaiter {
  id: string;
  threadId: string;
  platform: DevicePlatform;
  profile: string;
  requestedAt: string;
  /** When it fails `DEVICE_CAPACITY` if still without room (`capacityWaitSeconds`); waits on a starting host are not cut short. */
  deadlineAt: string;
  reason: DevicePoolWaitReason;
  /** The host it waits for, when one is starting for it. */
  hostId: string | null;
  /** Estimated seconds until it gets a device; null when unknown (it waits for a release). */
  etaSeconds: number | null;
}

/** One platform's slice of the pool. */
export interface DevicePoolPlatformSummary {
  platform: DevicePlatform;
  /** Rented pool hosts of the platform (starting, ready, draining). */
  hosts: number;
  /** Of those, still starting (being rented or prepared). */
  starting: number;
  /** Ready pool hosts' slots (draining hosts count their leases only). */
  capacity: DeviceCapacity;
  /** This host's slots for the platform; null when it runs none. */
  local: DeviceCapacity | null;
  queue: number;
  /** `pool.minWarmHosts` of the platform. */
  minWarmHosts: number;
  /** Devices a newly rented host is planned with (learned, else the default for the size). */
  perHostCapacity: number;
}

/** Spend on rented device hosts, accrued from their $/h while they run (UTC days and months). */
export interface DevicePoolSpend {
  /** `YYYY-MM-DD` (UTC). */
  day: string;
  todayUsd: number;
  /** `YYYY-MM` (UTC). */
  month: string;
  monthUsd: number;
  /** `pool.monthlyCapUsd`: renting without asking stops at it. */
  monthlyCapUsd: number;
  /** `pool.maxHourlyUsd`: the hard cap on the pool's summed $/h. */
  maxHourlyUsd: number;
}

/** A capacity measured on a ready pool host (devices per host for a provider and size). */
export interface DevicePoolLearnedCapacity {
  platform: DevicePlatform;
  provider: string;
  size: string;
  capacity: number;
  measuredAt: string;
}

export interface DevicePoolSummary {
  /** Pool hosts (rented), not counting this host. */
  hosts: number;
  capacity: DeviceCapacity;
  /** The pool's summed estimated $/h. */
  hourlyUsd: number;
  /** Lease requests waiting for room. */
  queue: number;
  // Phase 2 additions (absent from an older daemon):
  /** Leased share of the ready pool slots, 0–1 (0 with no slots). */
  utilization?: number;
  /** Rented pool host ids (see `DeviceHostSummary.pool` for each one's role). */
  hostIds?: string[];
  /** Pool hosts being drained (no new leases; destroyed once empty). */
  drainingHostIds?: string[];
  platforms?: DevicePoolPlatformSummary[];
  spend?: DevicePoolSpend;
  /** The queued requests, oldest first. */
  waiting?: DevicePoolWaiter[];
  learnedCapacity?: DevicePoolLearnedCapacity[];
  /** Cache-warm runs (`kind: "cache-warm"`), one per platform at most: running or last finished. */
  cacheJobs?: DeviceSetupJob[];
  /** When each platform's caches were last warmed (ISO); null: never from this daemon. */
  cacheWarmedAt?: Partial<Record<DevicePlatform, string | null>>;
  updatedAt?: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The error codes devices answer with (HTTP bodies `{code, message}` and tool errors). */
export const DEVICE_ERROR_CODES = {
  /** The plugin is off, or the agents' access is. */
  DEVICES_DISABLED: "DEVICES_DISABLED",
  /** The handle names no lease of this chat: "call open_device". */
  DEVICE_NOT_LEASED: "DEVICE_NOT_LEASED",
  /** The lease's host or device is gone: "call open_device again". */
  DEVICE_LOST: "DEVICE_LOST",
  /** The user holds control; read-only actions still work. */
  DEVICE_CONTROLLED_BY_USER: "DEVICE_CONTROLLED_BY_USER",
  /** No host has room (names the current leases). */
  DEVICE_CAPACITY: "DEVICE_CAPACITY",
  /** The chat already holds `maxLeasesPerChat` leases. */
  DEVICE_LEASE_LIMIT: "DEVICE_LEASE_LIMIT",
  /** The device is leased by another chat. */
  DEVICE_BUSY: "DEVICE_BUSY",
  /** The platform is off or its host is not ready (names the missing readiness items). */
  PLATFORM_NOT_READY: "PLATFORM_NOT_READY",
  DEVICE_NOT_FOUND: "DEVICE_NOT_FOUND",
  HOST_NOT_FOUND: "HOST_NOT_FOUND"
} as const;
export type DeviceErrorCode = (typeof DEVICE_ERROR_CODES)[keyof typeof DEVICE_ERROR_CODES];

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const enc = encodeURIComponent;
const HOSTS = "/api/devices/hosts";
const LEASES = "/api/devices/leases";

/** The hub proxy's route (`/api/devices/hosts/:hostId/hub/*`). */
export const DEVICE_HUB_ROUTE_PATTERN = `${HOSTS}/:hostId/hub/*`;
/** A kept screenshot's route. */
export const DEVICE_SCREENSHOT_ROUTE_PATTERN = `${LEASES}/:leaseId/screenshots/:screenshotId`;
/**
 * Routes that also accept the bearer as `?token=` (an `<img>`, a media element or a fetch the
 * browser starts cannot send a header); the daemon redacts it from logs and never forwards it.
 */
export const DEVICE_QUERY_TOKEN_ROUTES: readonly string[] = [DEVICE_HUB_ROUTE_PATTERN, DEVICE_SCREENSHOT_ROUTE_PATTERN];

/**
 * Every devices route, on both transports (bearer on HTTP). Hub streams need HTTP: the desktop
 * app's unix socket lists and drives leases but shows no video.
 */
export const deviceRoutes = {
  /** GET → {@link DevicesStateResponse}: everything the panel and Settings start from. */
  state: "/api/devices",
  /** GET → {@link DeviceHostsResponse}. */
  hosts: HOSTS,
  /** GET → `{host}`; DELETE destroys a box host (its leases end `host-lost`). */
  host: (hostId: string): string => `${HOSTS}/${enc(hostId)}`,
  /**
   * PUT {@link DeviceHostDrainRequest} → {@link DeviceHostResponse} (phase 2, the fleet view's
   * Drain): a draining host takes no new lease and is destroyed once empty (`pool.draining`);
   * `draining: false` takes it back into placement.
   */
  hostDrain: (hostId: string): string => `${HOSTS}/${enc(hostId)}/drain`,
  /**
   * POST {@link DeviceCacheWarmRequest} → {@link DeviceCacheWarmResponse} (phase 2 §2.6, "Warm
   * caches"): dispatch the run that builds and saves a platform's device-host caches.
   */
  cacheWarm: "/api/devices/pool/caches/warm",
  /** GET → {@link DevicesListResponse}: every device of every ready host. */
  devices: "/api/devices/list",
  /** GET (`?threadId=`) → {@link DeviceLeasesResponse}; POST {@link DeviceOpenRequest} → {@link DeviceLeaseResponse}. */
  leases: LEASES,
  /** GET → {@link DeviceLeaseResponse}; DELETE (`?shutdown=1`) releases it. */
  lease: (leaseId: string): string => `${LEASES}/${enc(leaseId)}`,
  /** PUT {@link DeviceControllerRequest} → {@link DeviceLeaseResponse}. */
  controller: (leaseId: string): string => `${LEASES}/${enc(leaseId)}/controller`,
  /** GET → {@link DeviceActionsResponse}: the lease's action log, oldest first. */
  actions: (leaseId: string): string => `${LEASES}/${enc(leaseId)}/actions`,
  /** GET → the image (`image/png` or `image/jpeg`) a `deviceRef` names. */
  screenshot: (leaseId: string, screenshotId: string): string => `${LEASES}/${enc(leaseId)}/screenshots/${enc(screenshotId)}`,
  /** GET / PUT ({@link DevicesSettingsPatch}) → {@link DevicesSettingsResponse}. */
  settings: "/api/devices/settings",
  /** POST {@link DeviceSetupRequest} starts (or joins) the platform's setup job; GET → {@link DeviceSetupResponse}. */
  setup: (platform: DevicePlatform): string => `/api/devices/setup/${platform}`,
  /** GET → {@link DevicePoolResponse}. */
  pool: "/api/devices/pool",
  /** The hub proxy: `path` is the hub's own path (`api/devices`, `vendor/serve-emu/ws`, …). */
  hub: (hostId: string, path: string): string => `${HOSTS}/${enc(hostId)}/hub/${path.replace(/^\/+/, "")}`,
  /** The WebSocket relay to a hub path (append `?token=` on HTTP; see `ApiClient.deviceSocketUrl`). */
  socket: (hostId: string, path: string): string => `/ws-device/${enc(hostId)}/${path.replace(/^\/+/, "")}`
} as const;

/** WebSocket path prefixes the SPA fallback must not swallow. */
export const DEVICE_WS_PREFIXES = ["/ws-device/"] as const;

// ---------------------------------------------------------------------------
// Requests and responses
// ---------------------------------------------------------------------------

/** POST {@link deviceRoutes.leases}: lease a device for a chat (the panel's picker, or an agent through its tool). */
export interface DeviceOpenRequest {
  threadId: string;
  platform: DevicePlatform;
  /** A {@link DEVICE_PROFILES} id; default {@link DEFAULT_DEVICE_PROFILE}. */
  profile?: string;
  /** Lease an existing device instead of booting one (with `hostId`). */
  deviceId?: string;
  hostId?: string;
  /** Launch this bundle id / package once booted. */
  app?: string;
  /** A clean device: never reuse a booted one. */
  fresh?: boolean;
}

/** PUT {@link deviceRoutes.controller}. */
export interface DeviceControllerRequest {
  controller: DeviceController;
}

/** POST {@link deviceRoutes.setup}: the fix actions to run; absent: every one the host's readiness names. */
export interface DeviceSetupRequest {
  actions?: string[];
}

export interface DevicesStateResponse {
  /** The plugin is on. */
  enabled: boolean;
  hosts: DeviceHostSummary[];
  leases: DeviceLeaseSummary[];
  profiles: DeviceProfile[];
  settings: DevicesSettings;
  /** Running and recently finished setup jobs, one per platform at most. */
  setupJobs: DeviceSetupJob[];
  pool?: DevicePoolSummary;
}

export interface DeviceHostsResponse {
  hosts: DeviceHostSummary[];
}

/** PUT {@link deviceRoutes.hostDrain}. */
export interface DeviceHostDrainRequest {
  draining: boolean;
}

/** One host (GET {@link deviceRoutes.host}, PUT {@link deviceRoutes.hostDrain}). */
export interface DeviceHostResponse {
  host: DeviceHostSummary;
}

/** GET {@link deviceRoutes.pool}. */
export interface DevicePoolResponse {
  pool: DevicePoolSummary;
}

/** POST {@link deviceRoutes.cacheWarm}: the platform whose pool-host caches to build and save. */
export interface DeviceCacheWarmRequest {
  platform: DevicePlatform;
}

export interface DeviceCacheWarmResponse {
  /** A run was dispatched (false: one is already running, or there is nothing to warm). */
  started: boolean;
  /** One line for the owner (why nothing started, or what runs now); null for none. */
  message: string | null;
}

export interface DevicesListResponse {
  devices: DeviceSummary[];
}

export interface DeviceLeasesResponse {
  leases: DeviceLeaseSummary[];
}

export interface DeviceLeaseResponse {
  lease: DeviceLeaseSummary;
}

export interface DeviceActionsResponse {
  leaseId: string;
  actions: DeviceActionEntry[];
}

export interface DevicesSettingsResponse {
  settings: DevicesSettings;
}

export interface DeviceSetupResponse {
  job: DeviceSetupJob | null;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** The `/events` channel every devices event goes out on. */
export const DEVICES_CHANNEL = "devices";
/** {@link DevicesHostsPayload}: the whole host list, on any host change. */
export const DEVICES_HOSTS_EVENT = "devices.hosts";
/** {@link DeviceLeaseEventPayload}: one lease created or changed. */
export const DEVICES_LEASE_EVENT = "devices.lease";
/** {@link DeviceLeaseClosedPayload}: a lease ended. */
export const DEVICES_LEASE_CLOSED_EVENT = "devices.lease.closed";
/** {@link DeviceActionEventPayload}: one action-log row. */
export const DEVICES_ACTION_EVENT = "devices.action";
/** {@link DeviceSetupEventPayload}: a setup job's progress. */
export const DEVICES_SETUP_EVENT = "devices.setup";
/** {@link DevicesSettingsResponse}: the settings changed. */
export const DEVICES_SETTINGS_EVENT = "devices.settings";
/** {@link DevicePoolSummary} (the payload IS the summary): the pool changed (phase 2). */
export const DEVICES_POOL_EVENT = "devices.pool";

export type DevicesEventType =
  | typeof DEVICES_HOSTS_EVENT
  | typeof DEVICES_LEASE_EVENT
  | typeof DEVICES_LEASE_CLOSED_EVENT
  | typeof DEVICES_ACTION_EVENT
  | typeof DEVICES_SETUP_EVENT
  | typeof DEVICES_SETTINGS_EVENT
  | typeof DEVICES_POOL_EVENT;

export interface DevicesHostsPayload {
  hosts: DeviceHostSummary[];
}

export interface DeviceLeaseEventPayload {
  lease: DeviceLeaseSummary;
}

export interface DeviceLeaseClosedPayload {
  leaseId: string;
  threadId: string;
  reason: DeviceLeaseCloseReason;
}

export interface DeviceActionEventPayload {
  leaseId: string;
  threadId: string;
  entry: DeviceActionEntry;
}

export interface DeviceSetupEventPayload {
  job: DeviceSetupJob;
}

// ---------------------------------------------------------------------------
// Request validation (the daemon's routes; clients may check before sending)
// ---------------------------------------------------------------------------

export type DeviceParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const APP_ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,254}$/;

function optionalString(record: Record<string, unknown>, key: string, pattern: RegExp): string | undefined | Error {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !pattern.test(value)) return new Error(`\`${key}\` is not valid.`);
  return value;
}

/** The body of POST {@link deviceRoutes.leases}. */
export function parseDeviceOpenRequest(value: unknown): DeviceParseResult<DeviceOpenRequest> {
  if (!isRecord(value)) return { ok: false, message: "The body must be a JSON object." };
  const { threadId, platform, fresh } = value;
  if (typeof threadId !== "string" || threadId.length === 0 || threadId.length > 200) return { ok: false, message: "`threadId` is required." };
  if (!isDevicePlatform(platform)) return { ok: false, message: "`platform` must be ios or android." };
  const out: DeviceOpenRequest = { threadId, platform };
  const profile = optionalString(value, "profile", /^[a-z0-9][a-z0-9-]{0,63}$/);
  if (profile instanceof Error) return { ok: false, message: profile.message };
  if (profile !== undefined) {
    const known = deviceProfile(profile);
    if (!known || known.platform !== platform) return { ok: false, message: `\`profile\` ${profile} is not a ${platform} profile.` };
    out.profile = profile;
  }
  const hostId = optionalString(value, "hostId", ID_PATTERN);
  if (hostId instanceof Error) return { ok: false, message: hostId.message };
  if (hostId !== undefined) out.hostId = hostId;
  const deviceId = optionalString(value, "deviceId", ID_PATTERN);
  if (deviceId instanceof Error) return { ok: false, message: deviceId.message };
  if (deviceId !== undefined) {
    if (hostId === undefined) return { ok: false, message: "`deviceId` needs `hostId`." };
    out.deviceId = deviceId;
  }
  const app = optionalString(value, "app", APP_ID_PATTERN);
  if (app instanceof Error) return { ok: false, message: app.message };
  if (app !== undefined) out.app = app;
  if (fresh !== undefined) {
    if (typeof fresh !== "boolean") return { ok: false, message: "`fresh` must be a boolean." };
    out.fresh = fresh;
  }
  return { ok: true, value: out };
}

/** The body of PUT {@link deviceRoutes.hostDrain}. */
export function parseDeviceHostDrainRequest(value: unknown): DeviceParseResult<DeviceHostDrainRequest> {
  if (!isRecord(value) || typeof value.draining !== "boolean") return { ok: false, message: "`draining` must be true or false." };
  return { ok: true, value: { draining: value.draining } };
}

/** The body of POST {@link deviceRoutes.cacheWarm}. */
export function parseDeviceCacheWarmRequest(value: unknown): DeviceParseResult<DeviceCacheWarmRequest> {
  if (!isRecord(value) || !isDevicePlatform(value.platform)) return { ok: false, message: "`platform` must be ios or android." };
  return { ok: true, value: { platform: value.platform } };
}

/** The body of PUT {@link deviceRoutes.controller}. */
export function parseDeviceControllerRequest(value: unknown): DeviceParseResult<DeviceControllerRequest> {
  if (!isRecord(value) || !isDeviceController(value.controller)) return { ok: false, message: "`controller` must be agent or user." };
  return { ok: true, value: { controller: value.controller } };
}

/** The body of POST {@link deviceRoutes.setup} (an empty body runs every fix). */
export function parseDeviceSetupRequest(value: unknown): DeviceParseResult<DeviceSetupRequest> {
  if (value === undefined || value === null) return { ok: true, value: {} };
  if (!isRecord(value)) return { ok: false, message: "The body must be a JSON object." };
  if (value.actions === undefined) return { ok: true, value: {} };
  if (!Array.isArray(value.actions) || value.actions.length > 64 || !value.actions.every((id) => typeof id === "string" && /^[a-z0-9][a-z0-9:._-]{0,127}$/.test(id))) {
    return { ok: false, message: "`actions` must be a list of setup action ids." };
  }
  return { ok: true, value: { actions: [...new Set(value.actions as string[])] } };
}

type FieldRule =
  | { kind: "boolean" }
  | { kind: "int"; min: number; max: number }
  | { kind: "number"; min: number; max: number }
  | { kind: "text" }
  | { kind: "nullable-text" }
  | { kind: "profiles"; platform: DevicePlatform }
  | { kind: "enum"; values: readonly string[] };

const L = DEVICES_SETTINGS_LIMITS;
const SETTINGS_RULES: Readonly<Record<string, Readonly<Record<string, FieldRule>>>> = {
  android: {
    enabled: { kind: "boolean" },
    maxLocalDevices: { kind: "int", ...L.maxLocalDevices },
    profiles: { kind: "profiles", platform: "android" }
  },
  ios: {
    enabled: { kind: "boolean" },
    provider: { kind: "text" },
    size: { kind: "text" },
    lifetimeMinutes: { kind: "int", ...L.lifetimeMinutes },
    idleTeardownMinutes: { kind: "int", ...L.idleTeardownMinutes },
    maxSimulatorsPerHost: { kind: "int", ...L.maxSimulatorsPerHost },
    rentWithoutAsking: { kind: "boolean" },
    monthlyCapUsd: { kind: "number", ...L.monthlyCapUsd },
    profiles: { kind: "profiles", platform: "ios" }
  },
  agents: {
    enabled: { kind: "boolean" },
    followAgentDevices: { kind: "boolean" }
  },
  pool: {
    placement: { kind: "enum", values: DEVICE_PLACEMENT_MODES },
    provider: { kind: "nullable-text" },
    androidSize: { kind: "nullable-text" },
    iosSize: { kind: "nullable-text" },
    maxHosts: { kind: "int", ...L.maxHosts },
    maxHourlyUsd: { kind: "number", ...L.maxHourlyUsd },
    idleTeardownMinutes: { kind: "int", ...L.idleTeardownMinutes },
    capacityWaitSeconds: { kind: "int", ...L.capacityWaitSeconds },
    rentWithoutAsking: { kind: "boolean" },
    monthlyCapUsd: { kind: "number", ...L.monthlyCapUsd }
  }
};
const TOP_RULES: Readonly<Record<string, FieldRule>> = {
  leaseIdleMinutes: { kind: "int", ...L.leaseIdleMinutes },
  maxLeasesPerChat: { kind: "int", ...L.maxLeasesPerChat }
};

function checkField(rule: FieldRule, value: unknown, path: string): string | null {
  switch (rule.kind) {
    case "boolean":
      return typeof value === "boolean" ? null : `\`${path}\` must be true or false.`;
    case "int":
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value) || (rule.kind === "int" && !Number.isInteger(value))) {
        return `\`${path}\` must be ${rule.kind === "int" ? "a whole number" : "a number"}.`;
      }
      return value < rule.min || value > rule.max ? `\`${path}\` must be between ${rule.min} and ${rule.max}.` : null;
    case "text":
      return typeof value === "string" && value.trim().length > 0 && value.length <= 200 ? null : `\`${path}\` must be a non-empty string.`;
    case "nullable-text":
      return value === null || (typeof value === "string" && value.trim().length > 0 && value.length <= 200) ? null : `\`${path}\` must be a string or null.`;
    case "enum":
      return typeof value === "string" && rule.values.includes(value) ? null : `\`${path}\` must be one of ${rule.values.join(", ")}.`;
    case "profiles":
      if (!Array.isArray(value) || value.length > 64) return `\`${path}\` must be a list of profile ids.`;
      for (const id of value) {
        const profile = typeof id === "string" ? deviceProfile(id) : undefined;
        if (!profile || profile.platform !== rule.platform) return `\`${path}\`: ${String(id)} is not a ${rule.platform} profile.`;
      }
      return null;
  }
}

/** `research` of a settings patch: `{vphoneHosts: {<boxId>: {enabled?, iphoneSource?, cloudosSource?} | null}}`. */
function parseResearchPatch(value: unknown): DeviceParseResult<NonNullable<DevicesSettingsPatch["research"]>> {
  if (!isRecord(value)) return { ok: false, message: "`research` must be an object." };
  const out: NonNullable<DevicesSettingsPatch["research"]> = {};
  for (const [field, entry] of Object.entries(value)) {
    if (field !== "vphoneHosts") return { ok: false, message: `Unknown setting \`research.${field}\`.` };
    if (!isRecord(entry) || Object.keys(entry).length > DEVICES_VPHONE_HOSTS_MAX) return { ok: false, message: "`research.vphoneHosts` must be an object keyed by machine id." };
    const hosts: Record<string, Partial<DevicesVphoneHostSettings> | null> = {};
    for (const [boxId, host] of Object.entries(entry)) {
      const path = `research.vphoneHosts.${boxId}`;
      if (!DEVICES_VPHONE_HOST_KEY.test(boxId)) return { ok: false, message: `\`${path}\`: not a machine id.` };
      if (host === null) {
        hosts[boxId] = null;
        continue;
      }
      if (!isRecord(host)) return { ok: false, message: `\`${path}\` must be an object or null.` };
      const parsed: Partial<DevicesVphoneHostSettings> = {};
      for (const [name, fieldValue] of Object.entries(host)) {
        if (name === "enabled") {
          if (typeof fieldValue !== "boolean") return { ok: false, message: `\`${path}.enabled\` must be true or false.` };
          parsed.enabled = fieldValue;
        } else if (name === "iphoneSource" || name === "cloudosSource") {
          const ok = fieldValue === null || (typeof fieldValue === "string" && fieldValue.trim().length > 0 && fieldValue.length <= DEVICES_VPHONE_SOURCE_MAX && !/[\u0000-\u001f]/.test(fieldValue));
          if (!ok) return { ok: false, message: `\`${path}.${name}\` must be a path or URL, or null.` };
          parsed[name] = fieldValue === null ? null : (fieldValue as string).trim();
        } else {
          return { ok: false, message: `Unknown setting \`${path}.${name}\`.` };
        }
      }
      hosts[boxId] = parsed;
    }
    out.vphoneHosts = hosts;
  }
  return { ok: true, value: out };
}

/** The body of PUT {@link deviceRoutes.settings}: every named field checked; unknown fields refused. */
export function parseDevicesSettingsPatch(value: unknown): DeviceParseResult<DevicesSettingsPatch> {
  if (!isRecord(value)) return { ok: false, message: "The body must be a JSON object." };
  const patch: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "research") {
      const research = parseResearchPatch(entry);
      if (!research.ok) return research;
      patch.research = research.value;
      continue;
    }
    const top = TOP_RULES[key];
    if (top) {
      const error = checkField(top, entry, key);
      if (error) return { ok: false, message: error };
      patch[key] = entry;
      continue;
    }
    const rules = SETTINGS_RULES[key];
    if (!rules) return { ok: false, message: `Unknown setting \`${key}\`.` };
    if (!isRecord(entry)) return { ok: false, message: `\`${key}\` must be an object.` };
    const section: Record<string, unknown> = {};
    for (const [field, fieldValue] of Object.entries(entry)) {
      if (key === "pool" && field === "minWarmHosts") {
        if (!isRecord(fieldValue)) return { ok: false, message: "`pool.minWarmHosts` must be an object." };
        const warm: Record<string, number> = {};
        for (const [platform, count] of Object.entries(fieldValue)) {
          if (!isDevicePlatform(platform)) return { ok: false, message: `Unknown setting \`pool.minWarmHosts.${platform}\`.` };
          const error = checkField({ kind: "int", ...L.minWarmHosts }, count, `pool.minWarmHosts.${platform}`);
          if (error) return { ok: false, message: error };
          warm[platform] = count as number;
        }
        section[field] = warm;
        continue;
      }
      const rule = rules[field];
      if (!rule) return { ok: false, message: `Unknown setting \`${key}.${field}\`.` };
      const error = checkField(rule, fieldValue, `${key}.${field}`);
      if (error) return { ok: false, message: error };
      section[field] = rule.kind === "profiles" ? [...new Set(fieldValue as string[])] : fieldValue;
    }
    patch[key] = section;
  }
  return { ok: true, value: patch as DevicesSettingsPatch };
}

// ---------------------------------------------------------------------------
// The `deviceRef` session-tool reference (a chat row's "Show device" and screenshot thumbnail)
// ---------------------------------------------------------------------------

/** The result key `SESSION_TOOL_REFERENCE_KEYS` keeps through slimming. */
export const DEVICE_TOOL_REFERENCE_KEY = "deviceRef";

/** What a device tool's result names: the device (its key), the lease, and a kept screenshot. */
export interface DeviceToolReference {
  device: string;
  leaseId?: string;
  screenshotId?: string;
  /** The device's display name ("Pixel 9"), for the row's words. */
  name?: string;
  /** `device_action`: the action it ran. */
  action?: DeviceActionKind;
  /** `device_action`: the action-log summary, one line ("Tapped @e7 “Search”"). */
  summary?: string;
}

const REF_PART = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,299}$/;

/** `value` as a reference, or undefined when it is not one (it came through a provider: never trusted as is). */
export function readDeviceToolReference(value: unknown): DeviceToolReference | undefined {
  if (!isRecord(value)) return undefined;
  const { device, leaseId, screenshotId } = value;
  if (typeof device !== "string" || !REF_PART.test(device)) return undefined;
  const out: DeviceToolReference = { device };
  if (typeof leaseId === "string" && REF_PART.test(leaseId)) out.leaseId = leaseId;
  if (typeof screenshotId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(screenshotId)) out.screenshotId = screenshotId;
  const name = oneLine(value.name, DEVICE_REF_NAME_MAX);
  if (name !== undefined) out.name = name;
  if (isDeviceActionKind(value.action)) out.action = value.action;
  const summary = oneLine(value.summary, DEVICE_REF_SUMMARY_MAX);
  if (summary !== undefined) out.summary = summary;
  return out;
}

const DEVICE_REF_NAME_MAX = 120;
const DEVICE_REF_SUMMARY_MAX = 200;

/** A short one-line text a provider relayed, or undefined (control characters or line breaks: refused). */
function oneLine(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(value)) return undefined;
  const text = value.trim();
  return text.length > 0 && text.length <= max ? text : undefined;
}

/** The device a session-tool row links to, or undefined (only rows the host marked as its own session tool's). */
export function deviceToolReferenceOfActivityData(data: unknown): DeviceToolReference | undefined {
  if (!isRecord(data) || sessionToolNameOfData(data) === null) return undefined;
  return readDeviceToolReference(sessionToolReferences(data, [DEVICE_TOOL_REFERENCE_KEY])?.[DEVICE_TOOL_REFERENCE_KEY]);
}
