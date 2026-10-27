/**
 * Lease and controller rules (devices spec §7), pure: every function takes records and a clock
 * and returns new records or a refusal, so the service's state changes are testable on their own.
 *
 * - One device ↔ at most one active lease; a chat holds at most `maxLeasesPerChat`.
 * - A new lease is `starting` with no device until the host booted one, then `ready`.
 * - The controller starts as whoever opened it; the user's first touch takes control; "Give back"
 *   returns it. While the user controls a device, agent input fails `DEVICE_CONTROLLED_BY_USER`
 *   (read-only actions still run).
 * - A lease ends by `close_device`, the panel's Release, its chat closing, or `leaseIdleMinutes`
 *   with no agent or viewer activity. A lost host makes its leases `lost` (the agent's next call
 *   answers `DEVICE_LOST`).
 */

import {
  DEVICE_ERROR_CODES,
  deviceKey,
  isActiveDeviceLease,
  isDeviceController,
  isDeviceLeaseState,
  isDevicePlatform,
  isReadOnlyDeviceAction,
  type DeviceActionKind,
  type DeviceController,
  type DeviceLeaseSummary,
  type DevicePlatform,
  type DeviceScreen,
  type DeviceStreamInfo
} from "@orquester/api";
import type { StoredDeviceLease } from "@orquester/config";

import { DeviceError } from "./errors.ts";

export interface LeaseLimits {
  /** `maxLeasesPerChat`. */
  maxPerThread: number;
}

/** Whether a stored lease still holds its device. A state from a newer build counts as holding it (fail closed). */
export function isLiveLease(lease: StoredDeviceLease): boolean {
  if (!isDeviceLeaseState(lease.state)) return true;
  return isActiveDeviceLease({ state: lease.state });
}

/** `<hostId>/<deviceId>`, or null while the device is not assigned. */
export function leaseKeyOf(lease: Pick<StoredDeviceLease, "hostId" | "deviceId">): string | null {
  return lease.deviceId ? deviceKey(lease.hostId, lease.deviceId) : null;
}

/** A stored lease as the wire shows it, or null when it names a platform this build does not know. */
export function toLeaseSummary(lease: StoredDeviceLease): DeviceLeaseSummary | null {
  if (!isDevicePlatform(lease.platform)) return null;
  const screen = lease.screen;
  const stream = lease.stream;
  return {
    id: lease.id,
    key: leaseKeyOf(lease),
    threadId: lease.threadId,
    hostId: lease.hostId,
    deviceId: lease.deviceId,
    platform: lease.platform,
    profile: lease.profile,
    name: lease.name,
    osVersion: lease.osVersion,
    // A newer build's state reads as `starting` (it still holds its device).
    state: isDeviceLeaseState(lease.state) ? lease.state : "starting",
    controller: isDeviceController(lease.controller) ? lease.controller : "agent",
    openedBy: lease.openedBy === "user" ? "user" : "agent",
    ...(screen ? { screen: { width: screen.width, height: screen.height, scale: screen.scale } } : {}),
    ...(stream && (stream.kind === "serve-sim" || stream.kind === "serve-emu" || stream.kind === "vphone")
      ? { stream: { kind: stream.kind, deviceParam: stream.deviceParam } }
      : {}),
    createdAt: lease.createdAt,
    lastUsedAt: lease.lastUsedAt,
    ...(lease.error ? { error: lease.error } : {})
  };
}

/** The live leases of one chat, oldest first. */
export function leasesOfThread(leases: readonly StoredDeviceLease[], threadId: string): StoredDeviceLease[] {
  return leases.filter((lease) => lease.threadId === threadId && isLiveLease(lease)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** The live lease on a device, if any. */
export function leaseOnDevice(leases: readonly StoredDeviceLease[], hostId: string, deviceId: string): StoredDeviceLease | undefined {
  return leases.find((lease) => lease.hostId === hostId && lease.deviceId === deviceId && isLiveLease(lease));
}

/** How a lease is named in messages: "Pixel 9 (local/emulator-5554)". */
export function describeLease(lease: StoredDeviceLease): string {
  const key = leaseKeyOf(lease);
  return key ? `${lease.name || lease.profile} (${key})` : `${lease.name || lease.profile} (starting)`;
}

/**
 * Whether `threadId` may take one more lease — on a specific device when `hostId`/`deviceId` are
 * given. Null when it may; otherwise the refusal.
 */
export function checkAcquire(
  leases: readonly StoredDeviceLease[],
  request: { threadId: string; hostId?: string; deviceId?: string },
  limits: LeaseLimits
): DeviceError | null {
  if (request.hostId !== undefined && request.deviceId !== undefined) {
    const holder = leaseOnDevice(leases, request.hostId, request.deviceId);
    if (holder && holder.threadId !== request.threadId) {
      return new DeviceError(DEVICE_ERROR_CODES.DEVICE_BUSY, `${deviceKey(request.hostId, request.deviceId)} is in use by another chat.`);
    }
    if (holder) return null;
  }
  const mine = leasesOfThread(leases, request.threadId);
  if (mine.length >= limits.maxPerThread) {
    return new DeviceError(
      DEVICE_ERROR_CODES.DEVICE_LEASE_LIMIT,
      `This chat already holds ${mine.length} device${mine.length === 1 ? "" : "s"} (the limit is ${limits.maxPerThread}): ${mine.map(describeLease).join(", ")}. Close one with close_device first.`
    );
  }
  return null;
}

/** A new `starting` lease; its controller is whoever opened it. */
export function newLease(input: {
  id: string;
  threadId: string;
  hostId: string;
  platform: DevicePlatform;
  profile: string;
  name: string;
  osVersion: string;
  openedBy: "agent" | "user";
  now: string;
}): StoredDeviceLease {
  return {
    id: input.id,
    threadId: input.threadId,
    hostId: input.hostId,
    deviceId: null,
    platform: input.platform,
    profile: input.profile,
    name: input.name,
    osVersion: input.osVersion,
    state: "starting",
    controller: input.openedBy,
    openedBy: input.openedBy,
    createdAt: input.now,
    lastUsedAt: input.now
  };
}

/** The host booted the lease's device: it is `ready`. */
export function leaseBooted(
  lease: StoredDeviceLease,
  boot: { deviceId: string; name: string; osVersion: string; screen?: DeviceScreen; stream: DeviceStreamInfo },
  now: string
): StoredDeviceLease {
  const { error: _error, ...rest } = lease;
  return {
    ...rest,
    deviceId: boot.deviceId,
    name: boot.name || lease.name,
    osVersion: boot.osVersion || lease.osVersion,
    state: "ready",
    ...(boot.screen ? { screen: { ...boot.screen } } : {}),
    stream: { ...boot.stream },
    lastUsedAt: now
  };
}

/** Agent or viewer activity: the idle clock restarts. */
export function touchLease(lease: StoredDeviceLease, now: string): StoredDeviceLease {
  return lease.lastUsedAt === now ? lease : { ...lease, lastUsedAt: now };
}

/** Hand control over (the panel's Take over / Give back). */
export function withController(lease: StoredDeviceLease, controller: DeviceController, now: string): StoredDeviceLease {
  if (lease.controller === controller) return touchLease(lease, now);
  return { ...lease, controller, lastUsedAt: now };
}

/** The user touched or typed on the device: they take control at once (spec §7). */
export function userInput(lease: StoredDeviceLease, now: string): StoredDeviceLease {
  return withController(lease, "user", now);
}

/** Whether the agent may run `kind` on the lease now; null when it may. */
export function checkAgentAction(lease: StoredDeviceLease, kind: DeviceActionKind): DeviceError | null {
  if (lease.state === "lost") {
    return new DeviceError(DEVICE_ERROR_CODES.DEVICE_LOST, `${describeLease(lease)} is gone${lease.error ? ` (${lease.error})` : ""}. Call open_device again for a new one.`);
  }
  if (lease.state === "starting" || lease.deviceId === null) {
    return new DeviceError("UNAVAILABLE", `${describeLease(lease)} is still starting. Call list_devices to see when it is ready.`);
  }
  if (lease.state === "suspended") {
    return new DeviceError("UNAVAILABLE", `${describeLease(lease)} is unreachable for now (its host's link dropped); it keeps running. Try again shortly.`);
  }
  if (lease.controller === "user" && !isReadOnlyDeviceAction(kind)) {
    return new DeviceError(
      DEVICE_ERROR_CODES.DEVICE_CONTROLLED_BY_USER,
      "The user is controlling this device. Wait, or ask them to give control back. Read-only actions (snapshot, screenshot, logs) still work."
    );
  }
  return null;
}

/**
 * The lease a tool's `device` handle names among the chat's own: its key or its lease id. With no
 * handle, the chat's only live lease (or its only lost one). Another chat's device reads as not
 * leased (never confirmed).
 */
export function resolveLeaseHandle(leases: readonly StoredDeviceLease[], threadId: string, handle: string | undefined): StoredDeviceLease | DeviceError {
  const own = leases.filter((lease) => lease.threadId === threadId && (isLiveLease(lease) || lease.state === "lost"));
  if (handle === undefined || handle === "") {
    const live = own.filter(isLiveLease);
    if (live.length === 1) return live[0]!;
    // Only a lost one left: it is the one meant (its use answers DEVICE_LOST).
    if (live.length === 0 && own.length === 1) return own[0]!;
    if (live.length === 0) return new DeviceError(DEVICE_ERROR_CODES.DEVICE_NOT_LEASED, "This chat has no device open. Call open_device first.");
    return new DeviceError("INVALID_ARGUMENT", `This chat has ${live.length} devices open: name one with \`device\` (${live.map(describeLease).join(", ")}).`);
  }
  const found = own.find((lease) => lease.id === handle || leaseKeyOf(lease) === handle);
  if (found) return found;
  return new DeviceError(DEVICE_ERROR_CODES.DEVICE_NOT_LEASED, `${handle} is not one of this chat's devices. Call open_device (or list_devices to see yours).`);
}

/**
 * Leases with no agent or viewer activity for `idleMinutes`: live ones, and lost ones (kept that
 * long so the agent's next call can still say `DEVICE_LOST`).
 */
export function idleLeases(leases: readonly StoredDeviceLease[], nowMs: number, idleMinutes: number): StoredDeviceLease[] {
  const cutoff = nowMs - idleMinutes * 60_000;
  return leases.filter((lease) => {
    if (!isLiveLease(lease) && lease.state !== "lost") return false;
    const last = Date.parse(lease.lastUsedAt);
    return Number.isFinite(last) && last < cutoff;
  });
}

/**
 * A host's link changed: `lost` (it is gone: every live lease on it is lost), `suspended` (its
 * link dropped; devices keep running) or `ready` (back: suspended leases resume). Returns only
 * the leases that changed.
 */
export function hostLeasesChanged(
  leases: readonly StoredDeviceLease[],
  hostId: string,
  change: "lost" | "suspended" | "ready",
  now: string,
  reason?: string
): StoredDeviceLease[] {
  const changed: StoredDeviceLease[] = [];
  for (const lease of leases) {
    if (lease.hostId !== hostId || !isLiveLease(lease)) continue;
    if (change === "lost") changed.push({ ...lease, state: "lost", error: reason ?? "Its host is gone." });
    else if (change === "suspended" && lease.state === "ready") changed.push({ ...lease, state: "suspended" });
    else if (change === "ready" && lease.state === "suspended") changed.push({ ...lease, state: "ready" });
  }
  return changed;
}
