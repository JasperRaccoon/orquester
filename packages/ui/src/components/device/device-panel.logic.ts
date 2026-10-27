/**
 * The Device panel's rules, pure (testable without a DOM): which view it shows, how a lease's
 * state, controller and boot progress read, which device a tab strip selects, where its stream
 * lives, and what the picker offers.
 */

import {
  DEVICE_PLATFORM_LABELS,
  deviceRoutes,
  isActiveDeviceLease,
  type DeviceController,
  type DeviceHostSummary,
  type DeviceLeaseSummary,
  type DevicePlatform,
  type DeviceProfile,
  type DevicesSettings
} from "@orquester/api";

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** "Starting…", "Ready", "Unreachable", "Lost — its host is gone". */
export function leaseStateLabel(lease: Pick<DeviceLeaseSummary, "state" | "error" | "progress">): string {
  switch (lease.state) {
    case "starting":
      return lease.progress ? `${lease.progress.label}…` : "Starting…";
    case "ready":
      return "Ready";
    case "suspended":
      return "Unreachable — still running";
    case "lost":
      return lease.error ? `Lost — ${lease.error}` : "Lost";
    case "released":
      return "Released";
  }
}

/** The lost card's line: the lease's reason (the daemon's are sentences: "Its host is gone."), then what to do. */
export function lostDeviceText(error: string | null | undefined): string {
  const reason = error?.trim();
  if (!reason) return "Its host or emulator stopped. Open a fresh one to keep going.";
  return `${reason}${/[.!?…]$/.test(reason) ? "" : "."} Open a fresh one to keep going.`;
}

/** Who drives it now, as the controller pill says it. */
export function controllerLabel(lease: Pick<DeviceLeaseSummary, "controller" | "state">, agentName = "The agent"): string | null {
  if (lease.state !== "ready") return null;
  return lease.controller === "user" ? "You have control" : `${agentName} is controlling`;
}

/** "iPhone 17 Pro · iOS 26" with the platform group when the OS is unknown. */
export function leaseSubtitle(lease: Pick<DeviceLeaseSummary, "platform" | "osVersion">): string {
  return lease.osVersion || DEVICE_PLATFORM_LABELS[lease.platform];
}

/** The name a tab and the pill show: the device's, else its profile's. */
export function leaseName(lease: Pick<DeviceLeaseSummary, "name" | "profile">, profiles: readonly Pick<DeviceProfile, "id" | "label">[] = []): string {
  if (lease.name) return lease.name;
  return profiles.find((profile) => profile.id === lease.profile)?.label ?? (lease.profile || "Device");
}

/** "8s", "1m 05s", "1h 02m" — a booting step's elapsed time. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function since(iso: string | undefined, now: number): number {
  const at = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(at) ? Math.max(0, now - at) : 0;
}

// ---------------------------------------------------------------------------
// Which lease, which view
// ---------------------------------------------------------------------------

/**
 * The lease the panel shows: the one picked (while it is still this chat's), else the newest live
 * one, else the newest at all (a lost device still shows why).
 */
export function activeLeaseOf(leases: readonly DeviceLeaseSummary[], selectedId: string | null | undefined): DeviceLeaseSummary | null {
  if (leases.length === 0) return null;
  const picked = selectedId ? leases.find((lease) => lease.id === selectedId) : undefined;
  if (picked) return picked;
  const live = leases.filter((lease) => isActiveDeviceLease(lease));
  return (live.length > 0 ? live : leases).at(-1) ?? null;
}

export type DevicePanelView =
  /** No chat tab is visible. */
  | { kind: "no-chat" }
  | { kind: "loading" }
  /** The empty state (or "+ Add device"): the picker. */
  | { kind: "picker" }
  /** Booting, with its steps; `failed` when the boot ended with an error and no device. */
  | { kind: "booting"; lease: DeviceLeaseSummary; failed: boolean }
  /** Ready: the stream (or, off HTTP / without a stream, the reason it can't show). */
  | { kind: "live"; lease: DeviceLeaseSummary; stream: DeviceStreamAvailability }
  /** The host's link dropped; the device keeps running. */
  | { kind: "suspended"; lease: DeviceLeaseSummary }
  /** Gone: Retry opens a fresh one. */
  | { kind: "lost"; lease: DeviceLeaseSummary };

export type DeviceStreamAvailability =
  | { ok: true }
  | { ok: false; reason: "transport" | "no-stream" | "unsupported"; message: string };

export const NO_TRANSPORT_MESSAGE = "Live devices need a server connection";

export interface DevicePanelInput {
  sessionId: string | null;
  loaded: boolean;
  leases: readonly DeviceLeaseSummary[];
  selectedLeaseId?: string | null;
  /** The user asked for the picker over the chat's devices ("+"). */
  picking?: boolean;
  /** The connection can carry hub streams (HTTP); false on the desktop app's unix socket. */
  streamsAvailable: boolean;
}

export function streamAvailability(lease: Pick<DeviceLeaseSummary, "stream">, streamsAvailable: boolean): DeviceStreamAvailability {
  if (!streamsAvailable) {
    return { ok: false, reason: "transport", message: NO_TRANSPORT_MESSAGE };
  }
  if (!lease.stream) return { ok: false, reason: "no-stream", message: "Waiting for the device's video…" };
  if (lease.stream.kind === "vphone") {
    return { ok: false, reason: "unsupported", message: "This device's video can't be shown in this version of Orquester." };
  }
  return { ok: true };
}

/** The panel's state machine. */
export function devicePanelView(input: DevicePanelInput): DevicePanelView {
  if (input.sessionId === null) return { kind: "no-chat" };
  if (!input.loaded) return { kind: "loading" };
  const lease = input.picking ? null : activeLeaseOf(input.leases, input.selectedLeaseId);
  if (!lease) return { kind: "picker" };
  switch (lease.state) {
    case "starting":
      return { kind: "booting", lease, failed: Boolean(lease.error) };
    case "ready":
      return { kind: "live", lease, stream: streamAvailability(lease, input.streamsAvailable) };
    case "suspended":
      return { kind: "suspended", lease };
    case "lost":
    case "released":
      return { kind: "lost", lease };
  }
}

// ---------------------------------------------------------------------------
// Booting steps
// ---------------------------------------------------------------------------

export type BootStepState = "done" | "active" | "pending" | "failed";

export interface BootStep {
  id: string;
  label: string;
  state: BootStepState;
  /** The active step's elapsed time ("12s"); null for the others. */
  elapsed: string | null;
  /** A line under the label (the Mac host's cost). */
  detail: string | null;
}

const BOOT_STEPS: readonly { id: string; label: string; ios?: true }[] = [
  { id: "rent-host", label: "Renting Mac host", ios: true },
  { id: "prepare-host", label: "Preparing host" },
  { id: "start-device", label: "Starting device" },
  { id: "connect-video", label: "Connecting video" }
];

/**
 * A booting lease's steps (spec §10.1): the iOS host rental first (with its cost), each step done,
 * active (with its elapsed time) or pending. A host's own step id shows in place of "Preparing host".
 */
export function bootSteps(
  lease: Pick<DeviceLeaseSummary, "platform" | "progress" | "error" | "createdAt">,
  now: number,
  options: { hourlyUsd?: number | null; rentingNeeded?: boolean } = {}
): BootStep[] {
  const rent = lease.platform === "ios" && options.rentingNeeded !== false;
  const steps = BOOT_STEPS.filter((step) => !step.ios || rent).map((step) => ({ ...step }));
  const progress = lease.progress;
  let at = progress ? steps.findIndex((step) => step.id === progress.step) : 0;
  if (progress && at === -1) {
    // A host's own step ("Installing tools"): it stands in for the host preparation.
    at = steps.findIndex((step) => step.id === "prepare-host");
    steps[at] = { id: progress.step, label: progress.label };
  }
  const failed = Boolean(lease.error);
  const cost = options.hourlyUsd != null && options.hourlyUsd > 0 ? `~$${options.hourlyUsd.toFixed(2)}/h while it runs` : null;
  return steps.map((step, index) => ({
    id: step.id,
    label: index === at && progress ? progress.label : step.label,
    state: index < at ? "done" : index === at ? (failed ? "failed" : "active") : "pending",
    elapsed: index === at ? formatElapsed(since(progress?.startedAt ?? lease.createdAt, now)) : null,
    detail: step.id === "rent-host" ? cost : null
  }));
}

/** The whole boot's elapsed time ("Starting · 42s"). */
export function bootElapsed(lease: Pick<DeviceLeaseSummary, "createdAt">, now: number): string {
  return formatElapsed(since(lease.createdAt, now));
}

// ---------------------------------------------------------------------------
// Control handoff (spec §7)
// ---------------------------------------------------------------------------

export interface ControllerPill {
  tone: "agent" | "user";
  text: string;
  /** The pill's button: Take over (to `user`) or Give back (to `agent`). */
  action: { label: string; controller: DeviceController };
}

/** The pill above a ready device. A device the user opened has no agent to give back to until one acts. */
export function controllerPill(lease: Pick<DeviceLeaseSummary, "state" | "controller" | "openedBy">, agentName: string): ControllerPill | null {
  if (lease.state !== "ready") return null;
  if (lease.controller === "agent") {
    return { tone: "agent", text: `${agentName} is controlling`, action: { label: "Take over", controller: "user" } };
  }
  return { tone: "user", text: "You have control", action: { label: `Give back`, controller: "agent" } };
}

/** The user's first touch or key on a device the agent drives switches control to them. */
export function inputTakesOver(lease: Pick<DeviceLeaseSummary, "state" | "controller"> | null | undefined): boolean {
  return lease?.state === "ready" && lease.controller === "agent";
}

/** The toast after an input took control. */
export function takeOverToast(agentName: string): string {
  return `You took control from ${agentName}. Give it back when you're done.`;
}

// ---------------------------------------------------------------------------
// Stream URLs
// ---------------------------------------------------------------------------

/** The part of `ApiClient` the URL builder needs. */
export interface DeviceUrlApi {
  deviceSocketUrl(path: string): string | null;
  deviceMediaUrl(path: string): string | null;
}

export interface DeviceLeaseStreamUrls {
  video: string;
  input?: string;
  screenshot?: string;
}

function addQuery(url: string, params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  return `${url}${url.includes("?") ? "&" : "?"}${query}`;
}

/**
 * Where a ready lease streams (spec §8): Android's serve-emu WebSocket (video + input) and its
 * screenshot route; iOS's serve-sim `stream.avcc` (MJPEG swapped in by the stream client) and its
 * input WebSocket. Null off HTTP or without a stream.
 */
export function deviceStreamUrls(api: DeviceUrlApi, lease: Pick<DeviceLeaseSummary, "hostId" | "stream">): DeviceLeaseStreamUrls | null {
  const stream = lease.stream;
  if (!stream) return null;
  const device = { device: stream.deviceParam };
  if (stream.kind === "serve-emu") {
    const socket = api.deviceSocketUrl(deviceRoutes.socket(lease.hostId, "vendor/serve-emu/ws"));
    if (!socket) return null;
    const shot = api.deviceMediaUrl(deviceRoutes.hub(lease.hostId, "vendor/serve-emu/api/screenshot"));
    return { video: addQuery(socket, device), ...(shot ? { screenshot: addQuery(shot, device) } : {}) };
  }
  if (stream.kind === "serve-sim") {
    const video = api.deviceMediaUrl(deviceRoutes.hub(lease.hostId, `vendor/serve-sim/helper/${encodeURIComponent(stream.deviceParam)}/stream.avcc`));
    const input = api.deviceSocketUrl(deviceRoutes.socket(lease.hostId, "vendor/serve-sim/helper/ws"));
    if (!video) return null;
    return { video, ...(input ? { input: addQuery(input, device) } : {}) };
  }
  return null;
}

/**
 * What the lease's host can stream, as `useDeviceStream`'s `hostCaps`: iOS H.264 only where the
 * host's summary says serve-sim's encoder works (a physical Mac); an Apple VM (Blacksmith) or a host
 * that says nothing streams MJPEG. The transport then picks the default view (H.264 → 3D).
 */
export function hostStreamCaps(hosts: readonly Pick<DeviceHostSummary, "id" | "stream">[], hostId: string): { h264: boolean } {
  return { h264: hosts.find((host) => host.id === hostId)?.stream?.iosH264 === true };
}

/** The orientation a Rotate press asks for: landscape from portrait, portrait from anything else. */
export function nextRotation(current: "portrait" | "portrait_upside_down" | "landscape_left" | "landscape_right"): "portrait" | "landscape" {
  return current === "portrait" ? "landscape" : "portrait";
}

/**
 * Whether the panel's Rotate works now, and why not: iOS turns the simulator through serve-sim's
 * input socket (needs it admitted); Android asks the daemon (`deviceRoutes.userAction`: the
 * emulator's accelerometer, so the video turns too), once its video is live.
 */
export function rotateControl(platform: DevicePlatform, now: { inputReady: boolean; live: boolean; pending: boolean }): { enabled: boolean; reason: string | null } {
  if (now.pending) return { enabled: false, reason: "Rotating…" };
  if (platform === "ios") return now.inputReady ? { enabled: true, reason: null } : { enabled: false, reason: "Waiting for the device's input to connect" };
  return now.live ? { enabled: true, reason: null } : { enabled: false, reason: "Waiting for video" };
}

/** The Android fold route (`vendor/serve-emu/api/fold`), or null off HTTP. */
export function deviceFoldUrl(api: DeviceUrlApi, lease: Pick<DeviceLeaseSummary, "hostId" | "stream">): string | null {
  if (lease.stream?.kind !== "serve-emu") return null;
  const url = api.deviceMediaUrl(deviceRoutes.hub(lease.hostId, "vendor/serve-emu/api/fold"));
  return url ? addQuery(url, { device: lease.stream.deviceParam }) : null;
}

// ---------------------------------------------------------------------------
// The picker
// ---------------------------------------------------------------------------

export interface PickerRow {
  profile: DeviceProfile;
  /** Open is offered. */
  enabled: boolean;
  /** Why not, in one line (links to Settings → Devices). */
  reason: string | null;
  /** A short state chip: "Ready", "Needs setup", "Rents a Mac", "Installing…". */
  badge: string;
}

export interface PickerGroup {
  platform: DevicePlatform;
  title: string;
  /** One line under the title: the host's state ("No Mac host — opening an iPhone rents one (~$4.80/h)"). */
  note: string | null;
  rows: PickerRow[];
}

export interface PickerInput {
  profiles: readonly DeviceProfile[];
  hosts: readonly DeviceHostSummary[];
  settings: DevicesSettings | null;
  /** The chat's live leases (the per-chat cap). */
  chatLeases: number;
  /** The Mac host quote ($/h) for the configured size, when known. */
  macHourlyUsd: number | null;
}

function hourly(value: number | null): string {
  return value != null && value > 0 ? ` (~$${value.toFixed(2)}/h)` : "";
}

/** The picker's groups: Android on this host, then iPhone & iPad on Mac hosts, each row explaining a disabled Open. */
export function pickerGroups(input: PickerInput): PickerGroup[] {
  const max = input.settings?.maxLeasesPerChat ?? 3;
  const full = input.chatLeases >= max;
  const fullReason = `This chat already has ${input.chatLeases} device${input.chatLeases === 1 ? "" : "s"} (the limit is ${max}). Release one first.`;
  const groups: PickerGroup[] = [];
  for (const platform of ["android", "ios"] as const) {
    const enabledInSettings = input.settings?.[platform].enabled ?? false;
    const offered = input.settings?.[platform].profiles;
    const profiles = input.profiles.filter((profile) => profile.platform === platform && (!offered || offered.includes(profile.id)));
    if (profiles.length === 0) continue;
    const hosts = input.hosts.filter((host) => host.platforms.includes(platform));
    let note: string | null = null;
    let reason: string | null = null;
    let badge = "Ready";
    if (!enabledInSettings) {
      reason = `${DEVICE_PLATFORM_LABELS[platform]} is off. Turn it on in Settings → Devices.`;
      badge = "Off";
    } else if (platform === "android") {
      const local = hosts.find((host) => host.kind === "local");
      if (!local || local.status === "needs-setup" || local.status === "failed") {
        const missing = local?.readiness.checks.filter((check) => check.state !== "ok").map((check) => check.label) ?? [];
        reason = missing.length > 0 ? `This host needs setup: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? "…" : ""}. Install it in Settings → Devices.` : "This host needs setup. Install it in Settings → Devices.";
        badge = local?.status === "failed" ? "Failed" : "Needs setup";
      } else if (local.status === "installing") {
        reason = "Installing the Android tools — this takes a few minutes.";
        badge = "Installing…";
      } else if (local.status === "disabled") {
        reason = "Android on this host is off. Turn it on in Settings → Devices.";
        badge = "Off";
      } else if (local.capacity.total > 0 && local.capacity.used >= local.capacity.total) {
        reason = `This host is full (${local.capacity.used} of ${local.capacity.total} devices running).`;
        badge = "Full";
      } else {
        note = local.capacity.total > 0 ? `Runs on this host · ${local.capacity.used} of ${local.capacity.total} in use` : "Runs on this host";
      }
    } else {
      const ready = hosts.filter((host) => host.status === "ready" && (host.capacity.total === 0 || host.capacity.used < host.capacity.total));
      const starting = hosts.find((host) => host.status === "starting" || host.status === "installing");
      if (ready.length > 0) {
        note = `${ready.length === 1 ? "A Mac host is" : `${ready.length} Mac hosts are`} running · opens in seconds`;
      } else if (starting) {
        note = "A Mac host is starting · the device opens when it's ready";
        badge = "Host starting";
      } else {
        note = `No Mac host — opening an iPhone rents one${hourly(input.macHourlyUsd)}`;
        badge = input.settings?.pool.rentWithoutAsking ? "Rents a Mac" : "Asks to rent";
      }
    }
    if (!reason && full) reason = fullReason;
    groups.push({
      platform,
      title: platform === "android" ? "Android" : DEVICE_PLATFORM_LABELS.ios,
      note,
      rows: profiles.map((profile) => ({ profile, enabled: reason === null, reason, badge: reason === fullReason ? "Limit reached" : badge }))
    });
  }
  return groups;
}

/** Copy for the More menu's "Copy device key". */
export function deviceKeyOf(lease: Pick<DeviceLeaseSummary, "key" | "id">): string {
  return lease.key ?? lease.id;
}
