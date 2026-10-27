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
  /** The most simulators one Mac host runs at once; a host runs fewer when its memory is short (simslim `top`). */
  maxSimulatorsPerHost: number;
  /**
   * Superseded by `pool.rentWithoutAsking` (one switch for every platform's rentals). Kept for
   * older builds: a file that has only this one carries it into `pool` when read, and a patch
   * naming it sets `pool.rentWithoutAsking` too.
   */
  rentWithoutAsking: boolean;
  /** Superseded by `pool.monthlyCapUsd` (kept and mirrored like `rentWithoutAsking`). */
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
  /**
   * "Rent device hosts without asking": the ONE standing approval for renting device hosts of any
   * platform (Mac and Linux): within the caps, no spend card.
   */
  rentWithoutAsking: boolean;
  /**
   * The month's cap for renting without asking, in USD: this month's device-host spend + what
   * running hosts are committed to + the new host's whole lifetime must stay within it.
   */
  monthlyCapUsd: number;
}

/**
 * One bring-your-own Mac's "Virtual iPhones (research)" switch (phase 3 §2.3): vphone-cli research
 * VMs on that machine. Keyed by box id in {@link DevicesResearchSettings.vphoneHosts}.
 */
export interface DevicesVphoneHostSettings {
  /** "Virtual iPhones (research)" is on for this machine (its "Use for device simulators" must be on too). */
  enabled: boolean;
  /** The iPhone restore IPSW (a path on that Mac, or a URL) the vphone template is built from; null: none set. */
  iphoneSource: string | null;
  /** The matching PCC/cloudOS IPSW (a path on that Mac, or a URL); null: none set. */
  cloudosSource: string | null;
}

/** Phase 3 research hosts. */
export interface DevicesResearchSettings {
  /** Box id → its vphone switch. A box without an entry is off. */
  vphoneHosts: Record<string, DevicesVphoneHostSettings>;
}

/** A key of {@link DevicesResearchSettings.vphoneHosts}: a box id. */
export const DEVICES_VPHONE_HOST_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** At most this many machines carry a vphone switch. */
export const DEVICES_VPHONE_HOSTS_MAX = 64;
/** Longest IPSW source (path or URL). */
export const DEVICES_VPHONE_SOURCE_MAX = 2000;

/**
 * An IPSW source vphone-cli may be given (it reaches `sudo -n vphone-cli vm create … --iphone-source
 * <it>`): an absolute path on the Mac or an `https://` URL — never something that starts with `-`
 * (read as an option) or holds control characters.
 */
export function isVphoneSource(value: string): boolean {
  if (value.length === 0 || value.length > DEVICES_VPHONE_SOURCE_MAX || /[\u0000-\u001f\u007f]/.test(value)) return false;
  if (value.startsWith("/")) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname !== "" && value.toLowerCase().startsWith("https://");
  } catch {
    return false;
  }
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
  /** Phase 3 research hosts (vphone-cli). */
  research: DevicesResearchSettings;
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
    maxSimulatorsPerHost: 8,
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
  },
  research: { vphoneHosts: {} }
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

const isPlainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

const vphoneSource = z.string().trim().refine(isVphoneSource).nullable().catch(null);
const vphoneHostSchema = z
  .object({
    enabled: bool(false),
    iphoneSource: vphoneSource.default(null),
    cloudosSource: vphoneSource.default(null)
  })
  .passthrough();

/**
 * `research.vphoneHosts` split: the entries this build reads (a box-id key, an object, within
 * {@link DEVICES_VPHONE_HOSTS_MAX}) and the rest, as found (a file's are written back verbatim:
 * {@link DevicesSettingsFile.droppedVphoneHosts}).
 */
function splitVphoneHosts(value: unknown): { kept: [string, Record<string, unknown>][]; dropped: Record<string, unknown> } {
  const kept: [string, Record<string, unknown>][] = [];
  const dropped: Record<string, unknown> = {};
  if (!isPlainObject(value)) return { kept, dropped };
  for (const [key, entry] of Object.entries(value)) {
    if (kept.length < DEVICES_VPHONE_HOSTS_MAX && DEVICES_VPHONE_HOST_KEY.test(key) && isPlainObject(entry)) kept.push([key, entry]);
    else dropped[key] = entry;
  }
  return { kept, dropped };
}

// Entries keyed by something that is not a box id, that are not objects (a patch's `null`), or past the max are not read.
const vphoneHostsSchema = z.unknown().transform((value) => {
  const out: Record<string, DevicesVphoneHostSettings> = {};
  for (const [key, entry] of splitVphoneHosts(value).kept) out[key] = vphoneHostSchema.parse(entry) as DevicesVphoneHostSettings;
  return out;
});

const researchSchema = z.object({ vphoneHosts: vphoneHostsSchema }).passthrough();

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
    pool: section(poolSchema),
    research: section(researchSchema)
  })
  .passthrough();

const isPlainRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** A file written before `pool.rentWithoutAsking` / `pool.monthlyCapUsd` existed: its Mac switch and cap become the pool's. */
function adoptLegacyRentSwitch(record: Record<string, unknown>): Record<string, unknown> {
  const ios = isPlainRecord(record.ios) ? record.ios : null;
  if (!ios) return record;
  const pool = isPlainRecord(record.pool) ? { ...record.pool } : {};
  let changed = false;
  if (typeof pool.rentWithoutAsking !== "boolean" && ios.rentWithoutAsking === true) {
    pool.rentWithoutAsking = true;
    changed = true;
  }
  if (typeof pool.monthlyCapUsd !== "number" && typeof ios.monthlyCapUsd === "number") {
    pool.monthlyCapUsd = ios.monthlyCapUsd;
    changed = true;
  }
  return changed ? { ...record, pool } : record;
}

/** Any value → valid settings, field by field (unknown keys kept). Never throws. */
export function readDevicesSettings(value: unknown): DevicesSettings {
  const record = isPlainRecord(value) ? adoptLegacyRentSwitch(value) : {};
  return devicesSettingsSchema.parse(record) as DevicesSettings;
}

/** A read `devices.json`: the settings, plus every other top-level key as found. */
export interface DevicesSettingsFile {
  version: typeof DEVICES_SETTINGS_VERSION;
  settings: DevicesSettings;
  /** Every top-level key but `version` and `settings`, kept verbatim. */
  extra: Record<string, unknown>;
  /** `settings.research.vphoneHosts` entries this build does not read, kept verbatim for the rewrite. */
  droppedVphoneHosts?: Record<string, unknown>;
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
  const research = isPlainRecord(record.settings) && isPlainRecord(record.settings.research) ? record.settings.research : null;
  const dropped = splitVphoneHosts(research?.vphoneHosts).dropped;
  return {
    version: DEVICES_SETTINGS_VERSION,
    settings: readDevicesSettings(record.settings),
    extra,
    ...(Object.keys(dropped).length > 0 ? { droppedVphoneHosts: dropped } : {})
  };
}

export function serializeDevicesSettingsFile(file: DevicesSettingsFile): Record<string, unknown> {
  const dropped = file.droppedVphoneHosts ?? {};
  const settings =
    Object.keys(dropped).length === 0
      ? file.settings
      : { ...file.settings, research: { ...file.settings.research, vphoneHosts: { ...file.settings.research.vphoneHosts, ...omitKeys(dropped, file.settings.research.vphoneHosts) } } };
  return { ...file.extra, version: DEVICES_SETTINGS_VERSION, settings };
}

function omitKeys(record: Record<string, unknown>, keys: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !Object.hasOwn(keys, key)));
}

/** A partial update of the settings: each section's fields optional, `pool.minWarmHosts` too. */
export type DevicesSettingsPatch = {
  android?: Partial<DevicesAndroidSettings>;
  ios?: Partial<DevicesIosSettings>;
  agents?: Partial<DevicesAgentSettings>;
  leaseIdleMinutes?: number;
  maxLeasesPerChat?: number;
  pool?: Partial<Omit<DevicePoolSettings, "minWarmHosts">> & { minWarmHosts?: Partial<DevicePoolSettings["minWarmHosts"]> };
  /** A box's entry merges field-wise; `null` forgets it. */
  research?: { vphoneHosts?: Record<string, Partial<DevicesVphoneHostSettings> | null> };
};

/**
 * `patch` applied over `current` (a validated patch: `@orquester/api` `parseDevicesSettingsPatch`),
 * re-read through the schema. Keys the patch does not name — unknown ones included — are kept.
 */
export function mergeDevicesSettings(current: DevicesSettings, patch: DevicesSettingsPatch): DevicesSettings {
  // An older client's Mac switch / cap sets the one pool switch / cap too (unless the patch names those).
  if (patch.ios && (patch.ios.rentWithoutAsking !== undefined || patch.ios.monthlyCapUsd !== undefined)) {
    const pool = { ...patch.pool };
    if (patch.ios.rentWithoutAsking !== undefined && pool.rentWithoutAsking === undefined) pool.rentWithoutAsking = patch.ios.rentWithoutAsking;
    if (patch.ios.monthlyCapUsd !== undefined && pool.monthlyCapUsd === undefined) pool.monthlyCapUsd = patch.ios.monthlyCapUsd;
    patch = { ...patch, pool };
  }
  return readDevicesSettings(mergeObject(structuredClone(current) as unknown as Record<string, unknown>, patch as Record<string, unknown>));
}

/** `patch` over `target`, object by object (arrays and other values replace). */
function mergeObject(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const next = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    next[key] = isPlainObject(value) ? mergeObject(isPlainObject(next[key]) ? next[key] : {}, value) : value;
  }
  return next;
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

/** A host the pool rented: what it was rented as (provider, size, price), for learned capacity. */
export const devicePoolRentalSchema = z
  .object({
    hostId: z.string().min(1),
    platform: z.string().min(1),
    provider: z.string().min(1),
    size: z.string().min(1),
    hourlyUsd: z.number().finite().min(0).nullable().default(null),
    rentedAt: z.string(),
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

/**
 * `device-pool.json`: the hosts the pool rented, learned capacities, drained host ids and
 * cache-warm state (spend is not kept here: the box records are its one source). Tolerant like
 * `devices.json`: each section falls back alone, unknown keys and entries are kept on rewrite.
 */
export interface DevicePoolState {
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
  return { rentals: [], learnedCapacity: [], drainingHostIds: [], cache: {} };
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

const POOL_KEYS = ["version", "rentals", "learnedCapacity", "drainingHostIds", "cache"];

/** Tolerant read of `device-pool.json`; the OUTER shape throws (not an object, another version), like the other device stores. */
export function parseDevicePoolStateFile(raw: unknown): DevicePoolStateFile {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Not a device pool file (the file is not a JSON object)");
  const record = raw as Record<string, unknown>;
  if (record.version !== undefined && record.version !== DEVICE_POOL_STATE_VERSION) {
    throw new Error(`Not a version-${DEVICE_POOL_STATE_VERSION} device pool file (version ${JSON.stringify(record.version)})`);
  }
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
    rentals: [...file.state.rentals, ...file.rejected.rentals],
    learnedCapacity: [...file.state.learnedCapacity, ...file.rejected.learnedCapacity],
    drainingHostIds: file.state.drainingHostIds,
    cache: file.state.cache
  };
}
