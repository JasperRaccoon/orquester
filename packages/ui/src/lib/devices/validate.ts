/**
 * Devices — shape checks for everything the daemon sends (`deviceRoutes` answers and
 * `DEVICES_CHANNEL` events) before it reaches the store. A list keeps the entries it can read and
 * drops the rest (a newer daemon's host kind or lease state is skipped, never half-applied); a
 * payload whose outer shape is wrong is null. The settings go through `@orquester/config`'s own
 * tolerant reader, so a field this client cannot read takes its default.
 */

import {
  DEVICE_ACTION_KINDS,
  DEVICE_HOST_KINDS,
  DEVICE_LEASE_STATES,
  isDeviceController,
  isDevicePlatform,
  type DeviceActionEntry,
  type DeviceActionEventPayload,
  type DeviceActionKind,
  type DeviceCapacity,
  type DeviceHostKind,
  type DeviceHostReadiness,
  type DeviceHostStatus,
  type DeviceHostSummary,
  type DeviceLeaseClosedPayload,
  type DeviceLeaseCloseReason,
  type DeviceLeaseState,
  type DeviceLeaseSummary,
  type DevicePlatform,
  type DevicePoint,
  type DevicePoolSummary,
  type DeviceProfile,
  type DeviceReadinessCheck,
  type DeviceReadinessState,
  type DevicesSettings,
  type DevicesStateResponse,
  type DeviceSetupJob,
  type DeviceSetupStep
} from "@orquester/api";
import { readDevicesSettings } from "@orquester/config";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const str = (value: unknown): value is string => typeof value === "string";
const num = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const strOrNull = (value: unknown): string | null => (str(value) ? value : null);
const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T => str(value) && (values as readonly string[]).includes(value);

/** Each entry `read` accepts; the others are dropped. Null when `value` is not a list. */
function listOf<T>(value: unknown, read: (entry: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((entry) => {
    const parsed = read(entry);
    return parsed === null ? [] : [parsed];
  });
}

const HOST_STATUSES: readonly DeviceHostStatus[] = ["disabled", "needs-setup", "installing", "starting", "ready", "unreachable", "stopping", "failed"];
const READINESS_STATES: readonly DeviceReadinessState[] = ["ok", "missing", "error", "working"];
const CLOSE_REASONS: readonly DeviceLeaseCloseReason[] = ["agent", "user", "chat-closed", "idle", "host-lost", "plugin-off", "failed"];

function point(value: unknown): DevicePoint | undefined {
  return isRecord(value) && num(value.x) && num(value.y) ? { x: value.x, y: value.y } : undefined;
}

function capacity(value: unknown): DeviceCapacity {
  return isRecord(value) && num(value.used) && num(value.total) ? { used: value.used, total: value.total } : { used: 0, total: 0 };
}

export function sanitizeReadinessCheck(value: unknown): DeviceReadinessCheck | null {
  if (!isRecord(value) || !str(value.id) || !str(value.label) || !oneOf(READINESS_STATES, value.state)) return null;
  return {
    id: value.id,
    label: value.label,
    state: value.state,
    detail: strOrNull(value.detail),
    ...(str(value.fixActionId) ? { fixActionId: value.fixActionId } : {})
  };
}

function readiness(value: unknown): DeviceHostReadiness {
  if (!isRecord(value)) return { ready: false, checks: [], checkedAt: null };
  return { ready: value.ready === true, checks: listOf(value.checks, sanitizeReadinessCheck) ?? [], checkedAt: strOrNull(value.checkedAt) };
}

export function sanitizeDeviceHost(value: unknown): DeviceHostSummary | null {
  if (!isRecord(value) || !str(value.id) || !str(value.label) || !oneOf<DeviceHostKind>(DEVICE_HOST_KINDS, value.kind) || !oneOf(HOST_STATUSES, value.status)) return null;
  const host: DeviceHostSummary = {
    id: value.id,
    kind: value.kind,
    label: value.label,
    platforms: (listOf(value.platforms, (entry) => (isDevicePlatform(entry) ? entry : null)) ?? []) as DevicePlatform[],
    status: value.status,
    statusDetail: strOrNull(value.statusDetail),
    readiness: readiness(value.readiness),
    capacity: capacity(value.capacity)
  };
  const box = value.box;
  if (isRecord(box) && str(box.boxId) && str(box.provider) && str(box.startedAt)) {
    host.box = {
      boxId: box.boxId,
      provider: box.provider,
      hourlyUsd: num(box.hourlyUsd) ? box.hourlyUsd : null,
      startedAt: box.startedAt,
      deadlineAt: strOrNull(box.deadlineAt)
    };
  }
  const pool = value.pool;
  if (isRecord(pool)) host.pool = { draining: pool.draining === true, warm: pool.warm === true, idleSince: strOrNull(pool.idleSince) };
  if (value.research === true) host.research = true;
  if (str(value.notice)) host.notice = value.notice;
  return host;
}

export function sanitizeDeviceLease(value: unknown): DeviceLeaseSummary | null {
  if (
    !isRecord(value) ||
    !str(value.id) ||
    !str(value.threadId) ||
    !str(value.hostId) ||
    !isDevicePlatform(value.platform) ||
    !oneOf<DeviceLeaseState>(DEVICE_LEASE_STATES, value.state) ||
    !str(value.createdAt) ||
    !str(value.lastUsedAt)
  ) {
    return null;
  }
  const lease: DeviceLeaseSummary = {
    id: value.id,
    key: strOrNull(value.key),
    threadId: value.threadId,
    hostId: value.hostId,
    deviceId: strOrNull(value.deviceId),
    platform: value.platform,
    profile: str(value.profile) ? value.profile : "",
    name: str(value.name) ? value.name : "",
    osVersion: str(value.osVersion) ? value.osVersion : "",
    state: value.state,
    controller: isDeviceController(value.controller) ? value.controller : "agent",
    openedBy: value.openedBy === "user" ? "user" : "agent",
    createdAt: value.createdAt,
    lastUsedAt: value.lastUsedAt
  };
  const screen = value.screen;
  if (isRecord(screen) && num(screen.width) && num(screen.height) && num(screen.scale)) lease.screen = { width: screen.width, height: screen.height, scale: screen.scale };
  const stream = value.stream;
  if (isRecord(stream) && oneOf(["serve-sim", "serve-emu", "vphone"] as const, stream.kind) && str(stream.deviceParam)) {
    lease.stream = { kind: stream.kind, deviceParam: stream.deviceParam };
  }
  if (str(value.error)) lease.error = value.error;
  const progress = value.progress;
  if (isRecord(progress) && str(progress.step) && str(progress.label) && str(progress.startedAt)) {
    lease.progress = { step: progress.step, label: progress.label, startedAt: progress.startedAt };
  }
  return lease;
}

export function sanitizeDeviceProfile(value: unknown): DeviceProfile | null {
  if (!isRecord(value) || !str(value.id) || !isDevicePlatform(value.platform) || !str(value.label) || !str(value.os)) return null;
  const formFactor = oneOf(["phone", "tablet", "foldable"] as const, value.formFactor) ? value.formFactor : "phone";
  return {
    id: value.id,
    platform: value.platform,
    label: value.label,
    formFactor,
    os: value.os,
    ...(str(value.modelId) ? { modelId: value.modelId } : {})
  };
}

export function sanitizeActionEntry(value: unknown): DeviceActionEntry | null {
  if (
    !isRecord(value) ||
    !str(value.id) ||
    !str(value.leaseId) ||
    !str(value.at) ||
    (value.actor !== "agent" && value.actor !== "user") ||
    !oneOf<DeviceActionKind>(DEVICE_ACTION_KINDS, value.kind) ||
    !str(value.summary) ||
    typeof value.ok !== "boolean"
  ) {
    return null;
  }
  const entry: DeviceActionEntry = { id: value.id, leaseId: value.leaseId, at: value.at, actor: value.actor, kind: value.kind, summary: value.summary, ok: value.ok };
  const at = point(value.point);
  const from = point(value.from);
  const to = point(value.to);
  if (at) entry.point = at;
  if (from) entry.from = from;
  if (to) entry.to = to;
  if (str(value.target)) entry.target = value.target;
  if (str(value.error)) entry.error = value.error;
  return entry;
}

function setupStep(value: unknown): DeviceSetupStep | null {
  if (!isRecord(value) || !str(value.id) || !str(value.label) || !oneOf(["pending", "running", "done", "failed", "skipped"] as const, value.state)) return null;
  return { id: value.id, label: value.label, state: value.state, detail: strOrNull(value.detail) };
}

export function sanitizeSetupJob(value: unknown): DeviceSetupJob | null {
  if (
    !isRecord(value) ||
    !str(value.id) ||
    !isDevicePlatform(value.platform) ||
    !str(value.hostId) ||
    !oneOf(["running", "done", "failed", "cancelled"] as const, value.state) ||
    !str(value.startedAt)
  ) {
    return null;
  }
  return {
    id: value.id,
    platform: value.platform,
    hostId: value.hostId,
    state: value.state,
    steps: listOf(value.steps, setupStep) ?? [],
    percent: num(value.percent) ? Math.max(0, Math.min(100, value.percent)) : null,
    logLine: strOrNull(value.logLine),
    error: strOrNull(value.error),
    startedAt: value.startedAt,
    finishedAt: strOrNull(value.finishedAt)
  };
}

export function sanitizeDevicesSettings(value: unknown): DevicesSettings | null {
  return isRecord(value) ? readDevicesSettings(value) : null;
}

export function sanitizePoolSummary(value: unknown): DevicePoolSummary | null {
  if (!isRecord(value) || !num(value.hosts) || !num(value.hourlyUsd) || !num(value.queue)) return null;
  return { hosts: value.hosts, capacity: capacity(value.capacity), hourlyUsd: value.hourlyUsd, queue: value.queue };
}

/** `GET /api/devices`. */
export function sanitizeDevicesState(value: unknown): DevicesStateResponse | null {
  if (!isRecord(value) || typeof value.enabled !== "boolean") return null;
  const hosts = listOf(value.hosts, sanitizeDeviceHost);
  const leases = listOf(value.leases, sanitizeDeviceLease);
  const profiles = listOf(value.profiles, sanitizeDeviceProfile);
  const settings = sanitizeDevicesSettings(value.settings);
  if (hosts === null || leases === null || profiles === null || settings === null) return null;
  const pool = sanitizePoolSummary(value.pool);
  return {
    enabled: value.enabled,
    hosts,
    leases,
    profiles,
    settings,
    setupJobs: listOf(value.setupJobs, sanitizeSetupJob) ?? [],
    ...(pool ? { pool } : {})
  };
}

/** `{hosts}` (a route answer or a `devices.hosts` event). */
export function sanitizeHostsPayload(value: unknown): DeviceHostSummary[] | null {
  return isRecord(value) ? listOf(value.hosts, sanitizeDeviceHost) : null;
}

/** `{lease}` (a route answer or a `devices.lease` event). */
export function sanitizeLeasePayload(value: unknown): DeviceLeaseSummary | null {
  return isRecord(value) ? sanitizeDeviceLease(value.lease) : null;
}

export function sanitizeLeaseClosed(value: unknown): DeviceLeaseClosedPayload | null {
  if (!isRecord(value) || !str(value.leaseId) || !str(value.threadId)) return null;
  return { leaseId: value.leaseId, threadId: value.threadId, reason: oneOf(CLOSE_REASONS, value.reason) ? value.reason : "failed" };
}

export function sanitizeActionEvent(value: unknown): DeviceActionEventPayload | null {
  if (!isRecord(value) || !str(value.leaseId) || !str(value.threadId)) return null;
  const entry = sanitizeActionEntry(value.entry);
  return entry && entry.leaseId === value.leaseId ? { leaseId: value.leaseId, threadId: value.threadId, entry } : null;
}

export function sanitizeActionsResponse(value: unknown): { leaseId: string; actions: DeviceActionEntry[] } | null {
  if (!isRecord(value) || !str(value.leaseId)) return null;
  const actions = listOf(value.actions, sanitizeActionEntry);
  return actions === null ? null : { leaseId: value.leaseId, actions };
}

/** `{job}` (a setup route answer or a `devices.setup` event); `job: null` reads as `{job: null}`. */
export function sanitizeSetupPayload(value: unknown): { job: DeviceSetupJob | null } | null {
  if (!isRecord(value)) return null;
  if (value.job === null) return { job: null };
  const job = sanitizeSetupJob(value.job);
  return job ? { job } : null;
}

/** `{settings}` (a settings route answer or a `devices.settings` event). */
export function sanitizeSettingsPayload(value: unknown): DevicesSettings | null {
  return isRecord(value) ? sanitizeDevicesSettings(value.settings) : null;
}
