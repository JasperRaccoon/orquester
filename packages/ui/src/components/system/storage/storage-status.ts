/**
 * Settings → Host status → Storage: the daemon's `storage.changed` events, shape-checked.
 *
 * The app store's `applyEvent` routes every {@link STORAGE_EVENTS_CHANNEL} event
 * here; the Storage tab subscribes while it is on screen and nothing is kept
 * while it is not (it reads the status again when it opens). A payload that is
 * not a whole {@link StorageStatusResponse} is dropped, never applied in part.
 */

import {
  STORAGE_CHANGED_EVENT,
  type EventMessage,
  type StorageScanState,
  type StorageScanSummary,
  type StorageStatusResponse,
  type StorageVolume
} from "@orquester/api";

type Listener = (status: StorageStatusResponse) => void;

const listeners = new Set<Listener>();

/** Hear every valid `storage.changed` status until the returned function is called. */
export function subscribeStorageStatus(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The app store's hook for the storage channel; anything malformed is ignored. */
export function applyStorageEvent(event: EventMessage): void {
  if (event.type !== STORAGE_CHANGED_EVENT) return;
  const status = parseStorageStatus(event.payload);
  if (!status) return;
  for (const listener of [...listeners]) listener(status);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const numberOrNull = (value: unknown): number | null | undefined =>
  value === null ? null : isNumber(value) ? value : undefined;
const stringOrNull = (value: unknown): string | null | undefined =>
  value === null ? null : isString(value) ? value : undefined;

function parseScanSummary(value: unknown): StorageScanSummary | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const { startedAt, finishedAt, durationMs, trigger, scannerVersion, scannedBytes, apparentBytes, items, unreadableDirs } =
    value;
  const usedBytesAtScan = numberOrNull(value.usedBytesAtScan);
  if (
    !isString(startedAt) ||
    !isString(finishedAt) ||
    !isNumber(durationMs) ||
    (trigger !== "manual" && trigger !== "schedule") ||
    !isString(scannerVersion) ||
    !isNumber(scannedBytes) ||
    !isNumber(apparentBytes) ||
    !isNumber(items) ||
    !isNumber(unreadableDirs) ||
    usedBytesAtScan === undefined ||
    !isNumber(value.unaccountedBytes)
  ) {
    return undefined;
  }
  return {
    startedAt,
    finishedAt,
    durationMs,
    trigger,
    scannerVersion,
    scannedBytes,
    apparentBytes,
    items,
    unreadableDirs,
    usedBytesAtScan,
    unaccountedBytes: value.unaccountedBytes
  };
}

function parseVolume(value: unknown): StorageVolume | null {
  if (!isRecord(value)) return null;
  const { id, mountPoint, device, fsType } = value;
  const totalBytes = numberOrNull(value.totalBytes);
  const usedBytes = numberOrNull(value.usedBytes);
  const freeBytes = numberOrNull(value.freeBytes);
  const lastScan = parseScanSummary(value.lastScan);
  if (
    !isString(id) ||
    !isString(mountPoint) ||
    !isString(device) ||
    !isString(fsType) ||
    totalBytes === undefined ||
    usedBytes === undefined ||
    freeBytes === undefined ||
    lastScan === undefined
  ) {
    return null;
  }
  return { id, mountPoint, device, fsType, totalBytes, usedBytes, freeBytes, lastScan };
}

function parseScanState(value: unknown): StorageScanState | null {
  if (!isRecord(value)) return null;
  if (value.state === "idle") return { state: "idle" };
  if (value.state !== "scanning") return null;
  const { volume, trigger, startedAt, queued } = value;
  const expectedDurationMs = numberOrNull(value.expectedDurationMs);
  if (
    !isString(volume) ||
    (trigger !== "manual" && trigger !== "schedule") ||
    !isString(startedAt) ||
    expectedDurationMs === undefined ||
    !Array.isArray(queued) ||
    !queued.every(isString)
  ) {
    return null;
  }
  return { state: "scanning", volume, trigger, startedAt, expectedDurationMs, queued: [...queued] };
}

/** A whole status off the wire (route answer or event payload), or null when it is not one. */
export function parseStorageStatus(value: unknown): StorageStatusResponse | null {
  if (!isRecord(value) || typeof value.supported !== "boolean") return null;
  const scanner = value.scanner;
  if (!isRecord(scanner) || typeof scanner.installed !== "boolean") return null;
  const version = stringOrNull(scanner.version);
  const path = stringOrNull(scanner.path);
  if (version === undefined || path === undefined) return null;
  if (!Array.isArray(value.volumes)) return null;
  const volumes: StorageVolume[] = [];
  for (const raw of value.volumes) {
    const volume = parseVolume(raw);
    if (!volume) return null;
    volumes.push(volume);
  }
  const scan = parseScanState(value.scan);
  if (!scan) return null;
  let lastError: StorageStatusResponse["lastError"] = null;
  if (value.lastError !== null) {
    const raw = value.lastError;
    if (!isRecord(raw) || !isString(raw.volume) || !isString(raw.message) || !isString(raw.at)) return null;
    lastError = { volume: raw.volume, message: raw.message, at: raw.at };
  }
  const nextScheduledAt = stringOrNull(value.nextScheduledAt);
  if (nextScheduledAt === undefined) return null;
  return {
    supported: value.supported,
    scanner: { installed: scanner.installed, version, path },
    volumes,
    scan,
    lastError,
    nextScheduledAt
  };
}
