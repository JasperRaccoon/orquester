/**
 * Devices ("Device simulators" plugin) — persisted stores
 * (docs/superpowers/specs/2026-10-27-devices-phase-1-core.md §11, phase 2 §4).
 *
 * - `devices.json` ({@link parseDevicesSettingsFile}): the owner's Settings → Devices choices.
 *   Tolerant: a field this build cannot read falls back to its default on its own, and every key
 *   it does not know (at any level) is kept on rewrite.
 * - `device-leases.json` ({@link parseDeviceLeasesFile}): every live lease (a chat's exclusive
 *   claim on one device), read entry by entry; an entry this build cannot read is kept verbatim.
 *
 * Path helpers (`devicesDir`, `devicesSettingsPath`, `deviceLeasesPath`, …) live in `index.ts` with
 * the other appdir helpers. The transport contracts (`@orquester/api` `devices.ts`) re-export the
 * settings types; enum-like lease fields are plain strings here so a record from a newer build is
 * never dropped — readers narrow them with the `isDevice*` guards from `@orquester/api`.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const DEVICES_SETTINGS_VERSION = 1;

/** Android profiles a fresh install offers (ids of `@orquester/api` `DEVICE_PROFILES`). */
export const DEFAULT_ANDROID_DEVICE_PROFILE_IDS: readonly string[] = ["pixel-9", "pixel-tablet", "pixel-fold"];
/** iOS profiles a fresh install offers. */
export const DEFAULT_IOS_DEVICE_PROFILE_IDS: readonly string[] = ["iphone-17-pro", "iphone-17-pro-max", "ipad-pro-13", "iphone-duo"];

/** Where new leases go (phase 2 §2.4): the host first, the pool only, or the host only. */
export type DevicePlacementMode = "local-only" | "prefer-local" | "pool-only";
export const DEVICE_PLACEMENT_MODES: readonly DevicePlacementMode[] = ["local-only", "prefer-local", "pool-only"];

export interface DevicesAndroidSettings {
  /** Android emulators on this host (Settings → Devices). */
  enabled: boolean;
  /** The cap the host's own capacity formula is clamped to (spec §6.2). */
  maxLocalDevices: number;
  /** The profiles AVDs are prepared for, in display order. */
  profiles: string[];
}

export interface DevicesIosSettings {
  /** iOS simulators on rented Mac device hosts. */
  enabled: boolean;
  /** The box provider Mac hosts are rented from (phase 1: Blacksmith). */
  provider: string;
  /** The provider size id. */
  size: string;
  /** A Mac host's time limit. */
  lifetimeMinutes: number;
  /** A Mac host with no lease for this long is destroyed. */
  idleTeardownMinutes: number;
  /** Simulators one Mac host runs at once (phase 2 computes it with simslim). */
  maxSimulatorsPerHost: number;
  /** "Rent Mac hosts without asking": no spend card while the month's estimate stays under the cap. */
  rentWithoutAsking: boolean;
  /** The month's cap for renting without asking, in USD. */
  monthlyCapUsd: number;
  profiles: string[];
}

export interface DevicesAgentSettings {
  /** "Let agents use devices": the `devices` toolset is advertised. */
  enabled: boolean;
  /** "Show the device when an agent opens one" (spec §10.2). */
  followAgentDevices: boolean;
}

/** Phase 2 device pools on rented boxes (phase 2 §2.3–2.5). Inert in phase 1. */
export interface DevicePoolSettings {
  placement: DevicePlacementMode;
  /** The box provider pool hosts are rented from; null: none chosen. */
  provider: string | null;
  /** Linux (KVM) size for Android pool hosts; null: the provider's default. */
  androidSize: string | null;
  /** macOS size for iOS pool hosts; null: `ios.size`. */
  iosSize: string | null;
  /** Hard cap on pool hosts at once. */
  maxHosts: number;
  /** Hard cap on the pool's summed $/h. */
  maxHourlyUsd: number;
  /** Ready hosts kept warm per platform. */
  minWarmHosts: { android: number; ios: number };
  /** A pool host with no lease for this long is destroyed. */
  idleTeardownMinutes: number;
  /** How long a request above the caps waits for room before `DEVICE_CAPACITY`. */
  capacityWaitSeconds: number;
  /** "Rent device hosts without asking": within the caps, no spend card. */
  rentWithoutAsking: boolean;
  /** The month's cap for renting pool hosts without asking, in USD (above it each rental needs a card). */
  monthlyCapUsd: number;
}

export interface DevicesSettings {
  android: DevicesAndroidSettings;
  ios: DevicesIosSettings;
  agents: DevicesAgentSettings;
  /** A lease with no agent or viewer activity for this long is released (spec §7). */
  leaseIdleMinutes: number;
  /** Leases one chat may hold at once (spec §2 goal 6). */
  maxLeasesPerChat: number;
  pool: DevicePoolSettings;
}

/** Inclusive ranges of the numeric settings: the persisted schema clamps to them, the PUT route refuses outside them. */
export const DEVICES_SETTINGS_LIMITS = {
  maxLocalDevices: { min: 1, max: 32 },
  lifetimeMinutes: { min: 30, max: 24 * 60 },
  idleTeardownMinutes: { min: 5, max: 24 * 60 },
  maxSimulatorsPerHost: { min: 1, max: 16 },
  monthlyCapUsd: { min: 0, max: 100_000 },
  leaseIdleMinutes: { min: 5, max: 24 * 60 },
  maxLeasesPerChat: { min: 1, max: 8 },
  maxHosts: { min: 0, max: 200 },
  maxHourlyUsd: { min: 0, max: 10_000 },
  minWarmHosts: { min: 0, max: 50 },
  capacityWaitSeconds: { min: 0, max: 900 }
} as const;

export const DEFAULT_DEVICES_SETTINGS: DevicesSettings = Object.freeze({
  android: { enabled: false, maxLocalDevices: 6, profiles: [...DEFAULT_ANDROID_DEVICE_PROFILE_IDS] },
  ios: {
    enabled: false,
    provider: "blacksmith",
    size: "blacksmith-6vcpu-macos-26",
    lifetimeMinutes: 240,
    idleTeardownMinutes: 20,
    maxSimulatorsPerHost: 3,
    rentWithoutAsking: false,
    monthlyCapUsd: 100,
    profiles: [...DEFAULT_IOS_DEVICE_PROFILE_IDS]
  },
  agents: { enabled: true, followAgentDevices: true },
  leaseIdleMinutes: 60,
  maxLeasesPerChat: 3,
  pool: {
    placement: "prefer-local",
    provider: null,
    androidSize: null,
    iosSize: null,
    maxHosts: 4,
    maxHourlyUsd: 20,
    minWarmHosts: { android: 0, ios: 0 },
    idleTeardownMinutes: 20,
    capacityWaitSeconds: 120,
    rentWithoutAsking: false,
    monthlyCapUsd: 100
  }
}) as DevicesSettings;

/** A fresh, mutable copy of the defaults. */
export function defaultDevicesSettings(): DevicesSettings {
  return structuredClone(DEFAULT_DEVICES_SETTINGS);
}

type Limit = { readonly min: number; readonly max: number };

/** An integer in `limit`, or `fallback` when the stored value is not a finite number (out-of-range values are clamped). */
const intIn = (limit: Limit, fallback: number) =>
  z
    .number()
    .finite()
    .transform((value) => Math.min(limit.max, Math.max(limit.min, Math.round(value))))
    .catch(fallback);

const numberIn = (limit: Limit, fallback: number) =>
  z
    .number()
    .finite()
    .transform((value) => Math.min(limit.max, Math.max(limit.min, value)))
    .catch(fallback);

const bool = (fallback: boolean) => z.boolean().catch(fallback);
const text = (fallback: string) => z.string().min(1).max(200).catch(fallback);
const nullableText = z.string().min(1).max(200).nullable().catch(null);
const profileIds = (fallback: readonly string[]) =>
  z
    .array(z.string().min(1).max(64))
    .max(64)
    .transform((ids) => [...new Set(ids)])
    .catch([...fallback]);

const D = DEFAULT_DEVICES_SETTINGS;
const L = DEVICES_SETTINGS_LIMITS;

// Every object passes unknown keys through, so a rewrite keeps what a newer build stored.
const androidSchema = z
  .object({
    enabled: bool(D.android.enabled),
    maxLocalDevices: intIn(L.maxLocalDevices, D.android.maxLocalDevices),
    profiles: profileIds(D.android.profiles)
  })
  .passthrough();

const iosSchema = z
  .object({
    enabled: bool(D.ios.enabled),
    provider: text(D.ios.provider),
    size: text(D.ios.size),
    lifetimeMinutes: intIn(L.lifetimeMinutes, D.ios.lifetimeMinutes),
    idleTeardownMinutes: intIn(L.idleTeardownMinutes, D.ios.idleTeardownMinutes),
    maxSimulatorsPerHost: intIn(L.maxSimulatorsPerHost, D.ios.maxSimulatorsPerHost),
    rentWithoutAsking: bool(D.ios.rentWithoutAsking),
    monthlyCapUsd: numberIn(L.monthlyCapUsd, D.ios.monthlyCapUsd),
    profiles: profileIds(D.ios.profiles)
  })
  .passthrough();

const agentsSchema = z
  .object({
    enabled: bool(D.agents.enabled),
    followAgentDevices: bool(D.agents.followAgentDevices)
  })
  .passthrough();

const poolSchema = z
  .object({
    placement: z.enum(DEVICE_PLACEMENT_MODES as unknown as [DevicePlacementMode, ...DevicePlacementMode[]]).catch(D.pool.placement),
    provider: nullableText,
    androidSize: nullableText,
    iosSize: nullableText,
    maxHosts: intIn(L.maxHosts, D.pool.maxHosts),
    maxHourlyUsd: numberIn(L.maxHourlyUsd, D.pool.maxHourlyUsd),
    minWarmHosts: z
      .object({
        android: intIn(L.minWarmHosts, D.pool.minWarmHosts.android),
        ios: intIn(L.minWarmHosts, D.pool.minWarmHosts.ios)
      })
      .passthrough()
      .catch({ ...D.pool.minWarmHosts }),
    idleTeardownMinutes: intIn(L.idleTeardownMinutes, D.pool.idleTeardownMinutes),
    capacityWaitSeconds: intIn(L.capacityWaitSeconds, D.pool.capacityWaitSeconds),
    rentWithoutAsking: bool(D.pool.rentWithoutAsking),
    monthlyCapUsd: numberIn(L.monthlyCapUsd, D.pool.monthlyCapUsd)
  })
  .passthrough();

// A missing or non-object section reads as `{}`, so each of its fields takes its own default.
const section = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value !== null && typeof value === "object" && !Array.isArray(value) ? value : {}), schema);

export const devicesSettingsSchema = z
  .object({
    android: section(androidSchema),
    ios: section(iosSchema),
    agents: section(agentsSchema),
    leaseIdleMinutes: intIn(L.leaseIdleMinutes, D.leaseIdleMinutes),
    maxLeasesPerChat: intIn(L.maxLeasesPerChat, D.maxLeasesPerChat),
    pool: section(poolSchema)
  })
  .passthrough();

/** Any value → valid settings, field by field (unknown keys kept). Never throws. */
export function readDevicesSettings(value: unknown): DevicesSettings {
  const record = value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
  return devicesSettingsSchema.parse(record) as DevicesSettings;
}

/** A read `devices.json`: the settings, plus every other top-level key as found. */
export interface DevicesSettingsFile {
  version: typeof DEVICES_SETTINGS_VERSION;
  settings: DevicesSettings;
  /** Every top-level key but `version` and `settings`, kept verbatim. */
  extra: Record<string, unknown>;
}

export function createDefaultDevicesSettingsFile(): DevicesSettingsFile {
  return { version: DEVICES_SETTINGS_VERSION, settings: defaultDevicesSettings(), extra: {} };
}

/**
 * Tolerant read of `devices.json`. The OUTER shape still throws (not an object, or a `version`
 * other than 1): the daemon reads a throw as "not mine to rewrite" and moves the file aside
 * instead of writing defaults over it.
 */
export function parseDevicesSettingsFile(raw: unknown): DevicesSettingsFile {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Not a devices settings file (the file is not a JSON object)");
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== undefined && record.version !== DEVICES_SETTINGS_VERSION) {
    throw new Error(`Not a version-${DEVICES_SETTINGS_VERSION} devices settings file (version ${JSON.stringify(record.version)})`);
  }
  const extra = Object.fromEntries(Object.entries(record).filter(([key]) => key !== "version" && key !== "settings"));
  return { version: DEVICES_SETTINGS_VERSION, settings: readDevicesSettings(record.settings), extra };
}

export function serializeDevicesSettingsFile(file: DevicesSettingsFile): Record<string, unknown> {
  return { ...file.extra, version: DEVICES_SETTINGS_VERSION, settings: file.settings };
}

/** A partial update of the settings: each section's fields optional, `pool.minWarmHosts` too. */
export type DevicesSettingsPatch = {
  android?: Partial<DevicesAndroidSettings>;
  ios?: Partial<DevicesIosSettings>;
  agents?: Partial<DevicesAgentSettings>;
  leaseIdleMinutes?: number;
  maxLeasesPerChat?: number;
  pool?: Partial<Omit<DevicePoolSettings, "minWarmHosts">> & { minWarmHosts?: Partial<DevicePoolSettings["minWarmHosts"]> };
};

/**
 * `patch` applied over `current` (a validated patch: `@orquester/api` `parseDevicesSettingsPatch`),
 * re-read through the schema. Keys the patch does not name — unknown ones included — are kept.
 */
export function mergeDevicesSettings(current: DevicesSettings, patch: DevicesSettingsPatch): DevicesSettings {
  const next = structuredClone(current) as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const target = { ...((next[key] as Record<string, unknown> | undefined) ?? {}) };
      for (const [field, fieldValue] of Object.entries(value as Record<string, unknown>)) {
        if (fieldValue === undefined) continue;
        if (fieldValue !== null && typeof fieldValue === "object" && !Array.isArray(fieldValue)) {
          target[field] = { ...((target[field] as Record<string, unknown> | undefined) ?? {}), ...(fieldValue as Record<string, unknown>) };
        } else {
          target[field] = fieldValue;
        }
      }
      next[key] = target;
    } else {
      next[key] = value;
    }
  }
  return readDevicesSettings(next);
}

// ---------------------------------------------------------------------------
// Leases
// ---------------------------------------------------------------------------

export const DEVICE_LEASES_VERSION = 1;

/**
 * One live lease (spec §7). `platform`, `state`, `controller` and `openedBy` stay plain strings so
 * a newer build's values survive; `deviceId` is null while the host has not assigned one yet
 * (an iOS simulator being created, an emulator still being placed).
 */
export const storedDeviceLeaseSchema = z
  .object({
    id: z.string().min(1),
    threadId: z.string().min(1),
    hostId: z.string().min(1),
    deviceId: z.string().min(1).nullable().default(null),
    platform: z.string().min(1),
    profile: z.string().default(""),
    name: z.string().default(""),
    osVersion: z.string().default(""),
    state: z.string().min(1),
    controller: z.string().default("agent"),
    openedBy: z.string().default("agent"),
    createdAt: z.string(),
    lastUsedAt: z.string(),
    error: z.string().nullable().optional(),
    screen: z
      .object({ width: z.number(), height: z.number(), scale: z.number() })
      .passthrough()
      .nullable()
      .optional(),
    stream: z
      .object({ kind: z.string(), deviceParam: z.string() })
      .passthrough()
      .nullable()
      .optional()
  })
  .passthrough();

export type StoredDeviceLease = z.infer<typeof storedDeviceLeaseSchema>;

/** A read `device-leases.json`, with everything this build cannot use kept VERBATIM. */
export interface DeviceLeasesFile {
  version: typeof DEVICE_LEASES_VERSION;
  leases: StoredDeviceLease[];
  /** `leases` entries that failed the schema or repeated an id, as found. */
  rejected: unknown[];
  /** Every top-level key but `version` and `leases`, as found. */
  extra: Record<string, unknown>;
}

export function createDefaultDeviceLeasesFile(): DeviceLeasesFile {
  return { version: DEVICE_LEASES_VERSION, leases: [], rejected: [], extra: {} };
}

/**
 * Entry-wise tolerant. The OUTER shape throws (not an object, `leases` not an array, a `version`
 * other than 1): the daemon then moves the file aside and keeps its leases read-only until restart.
 */
export function parseDeviceLeasesFile(raw: unknown): DeviceLeasesFile {
  const outer = z
    .object({
      version: z.literal(DEVICE_LEASES_VERSION).default(DEVICE_LEASES_VERSION),
      leases: z.array(z.unknown()).default([])
    })
    .passthrough()
    .safeParse(raw);
  if (!outer.success) {
    const issue = outer.error.issues[0];
    const where = issue && issue.path.length > 0 ? issue.path.join(".") : "the file";
    throw new Error(`Not a version-${DEVICE_LEASES_VERSION} device leases file (${where}: ${issue?.message ?? "invalid"})`);
  }
  const leases: StoredDeviceLease[] = [];
  const rejected: unknown[] = [];
  const ids = new Set<string>();
  for (const entry of outer.data.leases) {
    const parsed = storedDeviceLeaseSchema.safeParse(entry);
    if (parsed.success && !ids.has(parsed.data.id)) {
      ids.add(parsed.data.id);
      leases.push(parsed.data);
    } else {
      rejected.push(entry);
    }
  }
  const extra = Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([key]) => key !== "version" && key !== "leases"));
  return { version: DEVICE_LEASES_VERSION, leases, rejected, extra };
}

/** The on-disk JSON: live records first, then the rejected ones as found. */
export function serializeDeviceLeasesFile(file: DeviceLeasesFile): Record<string, unknown> {
  return { ...file.extra, version: DEVICE_LEASES_VERSION, leases: [...file.leases, ...file.rejected] };
}

// ---------------------------------------------------------------------------
// The device pool's own record (`device-pool.json`, phase 2 §4)
// ---------------------------------------------------------------------------

export const DEVICE_POOL_STATE_VERSION = 1;

/** The capacity measured on a ready pool host, per platform + provider + size (the scheduler plans new hosts with it). */
export const deviceLearnedCapacitySchema = z
  .object({
    platform: z.string().min(1),
    provider: z.string().min(1),
    size: z.string().min(1),
    capacity: z.number().int().min(1).max(64),
    measuredAt: z.string(),
    samples: z.number().int().min(1).default(1)
  })
  .passthrough();
export type DeviceLearnedCapacity = z.infer<typeof deviceLearnedCapacitySchema>;

/** A host the pool rented: what it was rented as (provider, size, price) and how far its spend is counted. */
export const devicePoolRentalSchema = z
  .object({
    hostId: z.string().min(1),
    platform: z.string().min(1),
    provider: z.string().min(1),
    size: z.string().min(1),
    hourlyUsd: z.number().finite().min(0).nullable().default(null),
    rentedAt: z.string(),
    /** Spend is counted up to here (ISO). */
    accruedUntil: z.string().nullable().default(null),
    /** Its capacity was learned already. */
    measured: z.boolean().default(false)
  })
  .passthrough();
export type DevicePoolRental = z.infer<typeof devicePoolRentalSchema>;

/** One OS's device caches (`orquester-device-cache.yml` runs). */
export const devicePoolCacheSchema = z
  .object({
    /** The last dispatched warm run (any trigger). */
    lastWarmAt: z.string().nullable().default(null),
    /** The last warm a cache miss dispatched (at most one a day). */
    lastAutoWarmAt: z.string().nullable().default(null),
    lastRunId: z.string().nullable().default(null),
    /** `success`, `failure`, … once the last run completed; null while unknown. */
    lastConclusion: z.string().nullable().default(null)
  })
  .passthrough();
export type DevicePoolCacheState = z.infer<typeof devicePoolCacheSchema>;

const usdBuckets = z
  .record(z.string(), z.unknown())
  .transform((record) => {
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(record)) if (typeof value === "number" && Number.isFinite(value) && value >= 0) out[key] = value;
    return out;
  })
  .catch({});

/**
 * `device-pool.json`: spend so far (USD per UTC day `YYYY-MM-DD` and month `YYYY-MM`), the hosts
 * the pool rented, learned capacities, drained host ids and cache-warm state. Tolerant like
 * `devices.json`: each section falls back alone, unknown keys and entries are kept on rewrite.
 */
export interface DevicePoolState {
  spend: { days: Record<string, number>; months: Record<string, number> };
  rentals: DevicePoolRental[];
  learnedCapacity: DeviceLearnedCapacity[];
  drainingHostIds: string[];
  cache: { linux?: DevicePoolCacheState; macos?: DevicePoolCacheState } & Record<string, unknown>;
}

export interface DevicePoolStateFile {
  version: typeof DEVICE_POOL_STATE_VERSION;
  state: DevicePoolState;
  /** Entries of `rentals` / `learnedCapacity` this build cannot read, kept verbatim. */
  rejected: { rentals: unknown[]; learnedCapacity: unknown[] };
  /** Every top-level key this build does not use, as found. */
  extra: Record<string, unknown>;
}

export function createDefaultDevicePoolState(): DevicePoolState {
  return { spend: { days: {}, months: {} }, rentals: [], learnedCapacity: [], drainingHostIds: [], cache: {} };
}

export function createDefaultDevicePoolStateFile(): DevicePoolStateFile {
  return { version: DEVICE_POOL_STATE_VERSION, state: createDefaultDevicePoolState(), rejected: { rentals: [], learnedCapacity: [] }, extra: {} };
}

function entries<T>(value: unknown, schema: z.ZodType<T, z.ZodTypeDef, unknown>): { ok: T[]; rejected: unknown[] } {
  const ok: T[] = [];
  const rejected: unknown[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const parsed = schema.safeParse(entry);
    if (parsed.success) ok.push(parsed.data);
    else rejected.push(entry);
  }
  return { ok, rejected };
}

const POOL_KEYS = ["version", "spend", "rentals", "learnedCapacity", "drainingHostIds", "cache"];

/** Tolerant read of `device-pool.json`; the OUTER shape throws (not an object, another version), like the other device stores. */
export function parseDevicePoolStateFile(raw: unknown): DevicePoolStateFile {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Not a device pool file (the file is not a JSON object)");
  const record = raw as Record<string, unknown>;
  if (record.version !== undefined && record.version !== DEVICE_POOL_STATE_VERSION) {
    throw new Error(`Not a version-${DEVICE_POOL_STATE_VERSION} device pool file (version ${JSON.stringify(record.version)})`);
  }
  const spendRaw = record.spend !== null && typeof record.spend === "object" && !Array.isArray(record.spend) ? (record.spend as Record<string, unknown>) : {};
  const rentals = entries(record.rentals, devicePoolRentalSchema);
  const learned = entries(record.learnedCapacity, deviceLearnedCapacitySchema);
  const cacheRaw = record.cache !== null && typeof record.cache === "object" && !Array.isArray(record.cache) ? (record.cache as Record<string, unknown>) : {};
  const cache: DevicePoolState["cache"] = { ...cacheRaw };
  for (const os of ["linux", "macos"] as const) {
    if (cacheRaw[os] === undefined) continue;
    const parsed = devicePoolCacheSchema.safeParse(cacheRaw[os]);
    if (parsed.success) cache[os] = parsed.data;
    else delete cache[os];
  }
  const draining = Array.isArray(record.drainingHostIds) ? record.drainingHostIds.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
  return {
    version: DEVICE_POOL_STATE_VERSION,
    state: {
      spend: { ...spendRaw, days: usdBuckets.parse(spendRaw.days ?? {}), months: usdBuckets.parse(spendRaw.months ?? {}) },
      rentals: rentals.ok,
      learnedCapacity: learned.ok,
      drainingHostIds: [...new Set(draining)],
      cache
    },
    rejected: { rentals: rentals.rejected, learnedCapacity: learned.rejected },
    extra: Object.fromEntries(Object.entries(record).filter(([key]) => !POOL_KEYS.includes(key)))
  };
}

export function serializeDevicePoolStateFile(file: DevicePoolStateFile): Record<string, unknown> {
  return {
    ...file.extra,
    version: DEVICE_POOL_STATE_VERSION,
    spend: file.state.spend,
    rentals: [...file.state.rentals, ...file.rejected.rentals],
    learnedCapacity: [...file.state.learnedCapacity, ...file.rejected.learnedCapacity],
    drainingHostIds: file.state.drainingHostIds,
    cache: file.state.cache
  };
}
