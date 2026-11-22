/**
 * The Device panel's rules, pure (testable without a DOM): which view it shows, how a lease's
 * state, controller and boot progress read, which device a tab strip selects, where its stream
 * lives, and what the picker offers.
 */

import {
  DEVICE_PLATFORM_LABELS,
  deviceRoutes,
  isActiveDeviceLease,
  LOCAL_DEVICE_HOST_LABEL,
  type DeviceController,
  type DeviceHostSummary,
  type DeviceLeaseSummary,
  type DevicePlatform,
  type DeviceProfile,
  type DevicesSettings,
  type MachineProblem
} from "@orquester/api";

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** The lost card's line: the lease's reason (the daemon's are sentences: "Its host is gone."), then what to do. */
export function lostDeviceText(error: string | null | undefined): string {
  const reason = error?.trim();
  if (!reason) return "Its host or emulator stopped. Open a fresh one to keep going.";
  return `${reason}${/[.!?…]$/.test(reason) ? "" : "."} Open a fresh one to keep going.`;
}

/** The name a tab and the pill show: the device's, else its profile's. */
export function leaseName(lease: Pick<DeviceLeaseSummary, "name" | "profile">, profiles: readonly Pick<DeviceProfile, "id" | "label">[] = []): string {
  if (lease.name) return lease.name;
  return profiles.find((profile) => profile.id === lease.profile)?.label ?? (lease.profile || "Device");
}

/** "8s", "1m 05s", "1h 02m" — a booting step's elapsed time. */
function formatElapsed(ms: number): string {
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
  | { ok: false; reason: "transport" | "daemon" | "no-stream" | "unsupported"; message: string };

const NO_TRANSPORT_MESSAGE = "Live devices need a server connection";
const OLDER_DAEMON_MESSAGE = "Restart Orquester to watch this device";

export interface DevicePanelInput {
  sessionId: string | null;
  loaded: boolean;
  leases: readonly DeviceLeaseSummary[];
  selectedLeaseId?: string | null;
  /** The user asked for the picker over the chat's devices ("+"). */
  picking?: boolean;
  /** The connection can carry hub streams (HTTP, or the desktop app's relay); false on an older desktop's unix socket. */
  streamsAvailable: boolean;
  /** The desktop's relay is up, but the daemon behind it predates the hub on its unix socket. */
  daemonOutdated?: boolean;
}

export function streamAvailability(lease: Pick<DeviceLeaseSummary, "stream">, streamsAvailable: boolean, daemonOutdated = false): DeviceStreamAvailability {
  if (!streamsAvailable) {
    return { ok: false, reason: "transport", message: NO_TRANSPORT_MESSAGE };
  }
  if (daemonOutdated) return { ok: false, reason: "daemon", message: OLDER_DAEMON_MESSAGE };
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
      return { kind: "live", lease, stream: streamAvailability(lease, input.streamsAvailable, input.daemonOutdated) };
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
  /** A WebSocket URL (the bearer as `?token=`: browsers cannot set WebSocket headers). */
  deviceSocketUrl(path: string): string | null;
  /** A URL this app fetches itself, without credentials, and the transport's auth headers. */
  deviceHttpRequest(path: string): { url: string; headers: Record<string, string> } | null;
}

export interface DeviceLeaseStreamUrls {
  video: string;
  input?: string;
  screenshot?: string;
  /** The auth headers for the fetched URLs (`video` on iOS, `screenshot`); WebSockets carry their own token. */
  headers: Record<string, string>;
}

function addQuery(url: string, params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  return `${url}${url.includes("?") ? "&" : "?"}${query}`;
}

/**
 * Where a ready lease streams (spec §8): Android's serve-emu WebSocket (video + input) and its
 * screenshot route; iOS's serve-sim `stream.avcc` (MJPEG swapped in by the stream client) and its
 * input WebSocket. The fetched URLs carry no token: `headers` authenticates them. Null off HTTP or
 * without a stream.
 */
export function deviceStreamUrls(api: DeviceUrlApi, lease: Pick<DeviceLeaseSummary, "hostId" | "stream">): DeviceLeaseStreamUrls | null {
  const stream = lease.stream;
  if (!stream) return null;
  const device = { device: stream.deviceParam };
  if (stream.kind === "serve-emu") {
    const socket = api.deviceSocketUrl(deviceRoutes.socket(lease.hostId, "vendor/serve-emu/ws"));
    if (!socket) return null;
    const shot = api.deviceHttpRequest(deviceRoutes.hub(lease.hostId, "vendor/serve-emu/api/screenshot"));
    return { video: addQuery(socket, device), ...(shot ? { screenshot: addQuery(shot.url, device) } : {}), headers: shot?.headers ?? {} };
  }
  if (stream.kind === "serve-sim") {
    const video = api.deviceHttpRequest(deviceRoutes.hub(lease.hostId, `vendor/serve-sim/helper/${encodeURIComponent(stream.deviceParam)}/stream.avcc`));
    const input = api.deviceSocketUrl(deviceRoutes.socket(lease.hostId, "vendor/serve-sim/helper/ws"));
    if (!video) return null;
    return { video: video.url, ...(input ? { input: addQuery(input, device) } : {}), headers: video.headers };
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

/** The Android fold route (`vendor/serve-emu/api/fold`) and its auth headers, or null off HTTP. */
export function deviceFoldRequest(api: DeviceUrlApi, lease: Pick<DeviceLeaseSummary, "hostId" | "stream">): { url: string; headers: Record<string, string> } | null {
  if (lease.stream?.kind !== "serve-emu") return null;
  const target = api.deviceHttpRequest(deviceRoutes.hub(lease.hostId, "vendor/serve-emu/api/fold"));
  return target ? { url: addQuery(target.url, { device: lease.stream.deviceParam }), headers: target.headers } : null;
}

// ---------------------------------------------------------------------------
// The toolbar's place
// ---------------------------------------------------------------------------

/** The device toolbar's sizes as `DeviceToolbar` draws them (px): `h-8` buttons, `gap-0.5`, a divider with its margins, `p-1` and a border per group, `gap-2` between groups; the rail's `py-2`; a fold error's two lines. */
const TOOLBAR_PX = { button: 32, gap: 2, divider: 5, groupChrome: 10, groupGap: 8, railPadding: 16, foldError: 32 } as const;

/** How tall the vertical rail is for a device: Home, (Back,) Recents, Rotate | Screenshot, Keyboard, 3D, More, then Fold/Unfold for foldables. */
export function railToolbarHeight(device: { platform: DevicePlatform; foldable: boolean; foldError: boolean }): number {
  const px = TOOLBAR_PX;
  const buttons = device.platform === "android" ? 8 : 7;
  let height = px.railPadding + px.groupChrome + buttons * px.button + buttons * px.gap + px.divider;
  if (device.foldable) height += px.groupGap + px.groupChrome + 2 * px.button + px.gap;
  if (device.foldable && device.foldError) height += px.groupGap + px.foldError;
  return height;
}

/**
 * Where the toolbar goes: the panel's choice, except that a rail taller than the room beside the
 * device (`areaHeight`: the stage and the toolbar's row together, above the activity drawer) becomes
 * the bar below the device, so it never spills over the controller pill or the activity drawer.
 * Unmeasured (`null` or 0): the panel's choice.
 */
export function deviceToolbarLayout(preferred: "rail" | "bar", areaHeight: number | null, railHeight: number): "rail" | "bar" {
  if (preferred === "bar" || !areaHeight) return preferred;
  return areaHeight >= railHeight ? "rail" : "bar";
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
  /** A short state chip: "Ready", "Needs setup", "Rents a Mac", "Installing…", "Full". */
  badge: string;
  /** What Open does: opens now, or queues in the pool (the host is full; it answers with a stand-in at once). */
  action: "open" | "queue";
  /** A tooltip for an enabled row (what queueing means). */
  hint: string | null;
  /** Opens on this host (one of the owner's machines, or a research host, which opens only by name); absent: placement picks. */
  hostId?: string;
}

export interface PickerGroup {
  /** Unique among the groups: the host's id, or `<platform>:any` for the hosts placement picks. */
  key: string;
  platform: DevicePlatform;
  /** The host's machine name ("jasper (your Linux machine)", "This machine"), or the platform for hosts placement picks. */
  title: string;
  /** One line under the title: the host's state ("No Mac host — opening an iPhone rents one (~$4.80/h)"). */
  note: string | null;
  rows: PickerRow[];
  /** The host every row opens on (an own machine's or a research host's group); absent: placement picks. */
  hostId?: string;
  /** What the host's probes found wrong, each with its fix. */
  problems?: readonly MachineProblem[];
}

export interface PickerInput {
  profiles: readonly DeviceProfile[];
  hosts: readonly DeviceHostSummary[];
  settings: DevicesSettings | null;
  /** The chat's live leases (the per-chat cap). */
  chatLeases: number;
  /** The Mac host quote ($/h) for the configured size, when known. */
  macHourlyUsd: number | null;
  /** The platforms the daemon can rent a host for now (absent from an older daemon: unknown). */
  rentable?: readonly DevicePlatform[] | undefined;
}

function hourly(value: number | null): string {
  return value != null && value > 0 ? ` (~$${value.toFixed(2)}/h)` : "";
}

/** A row's identity among every group's rows (the same profile opens on several hosts). */
export function pickerRowKey(row: Pick<PickerRow, "hostId"> & { profile: Pick<DeviceProfile, "id"> }): string {
  return row.hostId ? `${row.hostId}/${row.profile.id}` : row.profile.id;
}

/** The research host's row: a virtual iPhone, whatever the profile says (the host boots its own). */
function researchGroup(host: DeviceHostSummary, profile: DeviceProfile, input: PickerInput, fullReason: string | null): PickerGroup {
  const off = !(input.settings?.ios.enabled ?? false);
  let reason: string | null = fullReason;
  let badge = fullReason ? "Limit reached" : "Research";
  if (off) {
    reason = `${DEVICE_PLATFORM_LABELS.ios} is off. Turn it on in Settings → Devices.`;
    badge = "Off";
  } else if (host.status !== "ready") {
    reason = `${host.statusDetail ?? "This host needs setup."} Check Settings → Devices.`;
    badge = "Needs setup";
  } else if (host.capacity.used >= host.capacity.total) {
    reason = `All ${host.capacity.total} virtual iPhones on this Mac are in use.`;
    badge = "Full";
  }
  return {
    key: host.id,
    platform: "ios",
    title: host.label,
    note: host.notice ?? null,
    hostId: host.id,
    rows: [{ profile: { ...profile, label: "Virtual iPhone", os: "Real iOS in a VM" }, enabled: reason === null, reason, badge, action: "open", hint: null, hostId: host.id }]
  };
}

/** What every row of a group says: open now (on `hostId`), queue in the pool, or why not. */
interface GroupState {
  note: string | null;
  reason: string | null;
  badge: string;
  queueHint: string | null;
  /** Rows open on this host (absent: placement picks, as a queued open does). */
  hostId?: string;
}

const isOwn = (host: DeviceHostSummary): boolean => host.kind === "local" || host.kind === "byo";

/** The picker's order of own hosts: ready ones first, this host before paired machines, then by name. */
function ownOrder(a: DeviceHostSummary, b: DeviceHostSummary): number {
  const ready = (host: DeviceHostSummary) => (host.status === "ready" ? 0 : 1);
  return ready(a) - ready(b) || (a.kind === "local" ? -1 : 0) - (b.kind === "local" ? -1 : 0) || a.label.localeCompare(b.label);
}

function missingText(host: DeviceHostSummary): string[] {
  return host.readiness.checks.filter((check) => check.state !== "ok").map((check) => check.label);
}

/** One of the owner's hosts (this host, or a paired machine): its rows open on it by name, or queue when it is full. */
function ownHostState(host: DeviceHostSummary, platform: DevicePlatform, input: PickerInput): GroupState {
  const label = DEVICE_PLATFORM_LABELS[platform];
  const local = host.kind === "local";
  const where = local ? "This host" : host.label;
  const rents = input.settings?.pool.placement !== "local-only" && (input.rentable === undefined || input.rentable.includes(platform));
  const { used, total } = host.capacity;
  switch (host.status) {
    case "ready":
      if (total === 0 && (!local || input.settings?.pool.placement === "local-only")) {
        // Kept on this host, which runs none (or an own machine with no room now): it can never open here.
        return {
          note: null,
          reason: local
            ? `This host has no room for an ${label} device (too little free memory, or Settings allow none here), and Settings keep devices on this host.`
            : `${host.label} has no room for a device right now (too little free memory or disk).`,
          badge: "No room",
          queueHint: null
        };
      }
      if (used >= total) {
        // Open queues it in the pool (a stand-in answers at once): it opens when a slot frees up, or elsewhere.
        return {
          note: total > 0 ? `${used} of ${total} in use — a new device waits for a slot` : "This host runs no devices — a new device waits for a rented host",
          reason: null,
          badge: "Full",
          queueHint:
            total > 0
              ? `All ${total} slot${total === 1 ? " is" : "s are"} on ${local ? "this host" : host.label} in use — it opens when one frees up${rents ? ", or on a rented host if the fleet allows" : ""}.`
              : "This host runs no devices — it opens on a rented host if the fleet allows."
        };
      }
      // This host is placement's first choice anyway (unless the fleet is pool-only): its rows need not name it.
      return {
        note: total > 0 ? `${local ? "Runs on this host" : "Ready"} · ${used} of ${total} in use` : local ? "Runs on this host" : "Ready",
        reason: null,
        badge: "Ready",
        queueHint: null,
        ...(local && input.settings?.pool.placement !== "pool-only" ? {} : { hostId: host.id })
      };
    case "starting":
      return { note: `${where} is starting · the device opens when it's ready`, reason: null, badge: "Starting", queueHint: null, hostId: host.id };
    case "installing":
      return { note: null, reason: `Installing the ${label} tools on ${local ? "this host" : host.label} — this takes a few minutes.`, badge: "Installing…", queueHint: null };
    case "needs-setup": {
      const missing = missingText(host);
      // A paired machine sets itself up when a device opens (its helpers, its tools); this host's install is the owner's (it accepts the SDK licence).
      if (!local && host.readiness.checks.every((check) => check.state === "ok" || check.fixActionId !== undefined)) {
        return { note: host.statusDetail ?? "Prepares itself when a device opens", reason: null, badge: "Needs setup", queueHint: null, hostId: host.id };
      }
      const what = local ? "This host" : host.label;
      return {
        note: null,
        reason:
          missing.length > 0
            ? `${what} needs setup: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? "…" : ""}. ${local ? "Install it in Settings → Devices." : "Check Settings → Devices."}`
            : `${host.statusDetail ?? `${what} needs setup.`} ${local ? "Install it in Settings → Devices." : "Check Settings → Devices."}`,
        badge: "Needs setup",
        queueHint: null
      };
    }
    case "failed":
      return { note: null, reason: `${host.statusDetail ?? `${where} failed.`} Check Settings → Devices.`, badge: "Failed", queueHint: null };
    case "unreachable":
      return { note: null, reason: host.problems?.find((problem) => problem.code === "machine-asleep")?.message ?? host.statusDetail ?? `${where} is offline.`, badge: "Offline", queueHint: null };
    case "disabled":
      return { note: null, reason: `${label} on ${local ? "this host" : host.label} is off. Turn it on in Settings → Devices.`, badge: "Off", queueHint: null };
    case "stopping":
      return { note: null, reason: `${where} is being turned off.`, badge: "Stopping", queueHint: null };
  }
}

/**
 * Rows placement picks a host for (the owner's machines first, then rented ones): renting one when
 * the daemon can, or a rented host already running. Null when there is nothing to offer beyond the
 * own hosts' groups.
 */
function automaticState(platform: DevicePlatform, hosts: readonly DeviceHostSummary[], ownGroups: number, input: PickerInput): GroupState | null {
  const mac = platform === "ios";
  const rented = hosts.filter((host) => host.kind === "box");
  const ready = rented.filter((host) => host.status === "ready" && (host.capacity.total === 0 || host.capacity.used < host.capacity.total));
  const starting = rented.find((host) => host.status === "starting" || host.status === "installing");
  const placementOk = input.settings?.pool.placement !== "local-only";
  // An older daemon says nothing of rentals: iOS assumes it can rent a Mac (as before), Android does not.
  const canRent = placementOk && (input.rentable ? input.rentable.includes(platform) : mac);
  const rentWithoutAsking = input.settings?.pool.rentWithoutAsking === true;
  const word = mac ? "Mac host" : "Android host";
  if (ready.length > 0) {
    return { note: `${ready.length === 1 ? `A rented ${word} is` : `${ready.length} rented ${word}s are`} running · opens in seconds`, reason: null, badge: "Ready", queueHint: null };
  }
  if (starting) return { note: `A rented ${word} is starting · the device opens when it's ready`, reason: null, badge: "Host starting", queueHint: null };
  if (canRent) {
    const price = mac ? hourly(input.macHourlyUsd) : "";
    return {
      note: ownGroups > 0 ? `Uses a free one of your machines first, else rents a ${word}${price}` : mac ? `No Mac host — opening an iPhone rents one${price}` : `No Android host — opening one rents a ${word}${price}`,
      reason: null,
      badge: rentWithoutAsking ? (mac ? "Rents a Mac" : "Rents a host") : "Asks to rent",
      queueHint: null
    };
  }
  if (ownGroups > 0) return null;
  return {
    note: null,
    reason: mac
      ? "No Mac host, and renting one isn't set up. Check Settings → Devices."
      : "No Android host is set up: install Android on this host, or turn Device simulators on for one of your machines. Check Settings → Devices.",
    badge: "Needs setup",
    queueHint: null
  };
}

function groupRows(profiles: readonly DeviceProfile[], state: GroupState, fullReason: string | null): PickerRow[] {
  const reason = state.reason ?? fullReason;
  return profiles.map((profile) => ({
    profile,
    enabled: reason === null,
    reason,
    badge: state.reason === null && fullReason !== null ? "Limit reached" : state.badge,
    action: reason === null && state.queueHint ? "queue" : "open",
    hint: reason === null ? state.queueHint : null,
    ...(reason === null && state.hostId ? { hostId: state.hostId } : {})
  }));
}

/**
 * The picker's groups, by host: per platform each of the owner's hosts by its machine name (this
 * host, paired machines; rows open on it, or queue when it is full), then the hosts placement picks
 * (rented ones, or renting one), then each research host; each row explains a disabled Open. This
 * host is left out while it is not ready and another host of the platform is: it is never "needs
 * setup" in front of a ready machine.
 */
export function pickerGroups(input: PickerInput): PickerGroup[] {
  const max = input.settings?.maxLeasesPerChat ?? 3;
  const full = input.chatLeases >= max;
  const fullReason = full ? `This chat already has ${input.chatLeases} device${input.chatLeases === 1 ? "" : "s"} (the limit is ${max}). Release one first.` : null;
  const groups: PickerGroup[] = [];
  for (const platform of ["android", "ios"] as const) {
    const offered = input.settings?.[platform].profiles;
    const profiles = input.profiles.filter((profile) => profile.platform === platform && (!offered || offered.includes(profile.id)));
    if (profiles.length === 0) continue;
    const title = platform === "android" ? "Android" : DEVICE_PLATFORM_LABELS.ios;
    if (!(input.settings?.[platform].enabled ?? false)) {
      const state: GroupState = { note: null, reason: `${DEVICE_PLATFORM_LABELS[platform]} is off. Turn it on in Settings → Devices.`, badge: "Off", queueHint: null };
      groups.push({ key: `${platform}:any`, platform, title, note: null, rows: groupRows(profiles, state, fullReason) });
      continue;
    }
    const hosts = input.hosts.filter((host) => host.platforms.includes(platform) && host.research !== true);
    const anotherReady = (host: DeviceHostSummary) => hosts.some((other) => other.id !== host.id && other.status === "ready");
    const own = hosts.filter(isOwn).filter((host) => !(host.kind === "local" && host.status !== "ready" && anotherReady(host))).sort(ownOrder);
    for (const host of own) {
      const state = ownHostState(host, platform, input);
      groups.push({
        key: host.id,
        platform,
        title: host.kind === "local" ? LOCAL_DEVICE_HOST_LABEL : host.label,
        note: state.note,
        rows: groupRows(profiles, state, fullReason),
        ...(state.hostId ? { hostId: state.hostId } : {}),
        ...(host.problems && host.problems.length > 0 ? { problems: host.problems } : {})
      });
    }
    const automatic = automaticState(platform, hosts, own.length, input);
    if (automatic) groups.push({ key: `${platform}:any`, platform, title: own.length > 0 ? "Any free host" : title, note: automatic.note, rows: groupRows(profiles, automatic, fullReason) });
  }
  const offered = input.settings?.ios.profiles;
  const iphone = input.profiles.find((profile) => profile.platform === "ios" && (!offered || offered.includes(profile.id)));
  if (iphone) {
    for (const host of input.hosts) if (host.research === true && host.platforms.includes("ios")) groups.push(researchGroup(host, iphone, input, fullReason));
  }
  return groups;
}

/** Copy for the More menu's "Copy device key". */
export function deviceKeyOf(lease: Pick<DeviceLeaseSummary, "key" | "id">): string {
  return lease.key ?? lease.id;
}
