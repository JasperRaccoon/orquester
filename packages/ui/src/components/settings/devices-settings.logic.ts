/**
 * Settings → Devices, pure (testable without a DOM): how number fields read and validate, the
 * patches the page sends (each one `parseDevicesSettingsPatch` accepts), the readiness summary,
 * the live setup job, Mac host costs, the pinned tools, and the device hosts list (owner, capacity
 * and its basis, placement order, problems).
 */

import {
  DEVICE_PLATFORM_LABELS,
  DEVICE_PROFILES,
  type DeviceCapacity,
  type DeviceHostSummary,
  type DevicePlacementMode,
  type DevicePlatform,
  type DeviceReadinessCheck,
  type DeviceReadinessState,
  type DeviceSetupJob,
  type DeviceSetupStepState,
  type DevicesSettings,
  type DevicesSettingsPatch,
  type MachineProblem
} from "@orquester/api";

import { costForMinutes, formatCountdown, formatHourlyRate, formatUsd } from "../../lib/boxes/format";

// ---------------------------------------------------------------------------
// Number fields
// ---------------------------------------------------------------------------

export interface NumberLimits {
  readonly min: number;
  readonly max: number;
}

export type ParsedSettingNumber = { ok: true; value: number } | { ok: false; message: string };

/** A typed number field's text, checked against its limits (`integer`: whole numbers only). */
export function parseSettingNumber(text: string, limits: NumberLimits, options: { integer?: boolean } = {}): ParsedSettingNumber {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, message: "Enter a number." };
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return { ok: false, message: "Enter a number." };
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return { ok: false, message: "Enter a number." };
  if (options.integer && !Number.isInteger(value)) return { ok: false, message: "Enter a whole number." };
  if (value < limits.min || value > limits.max) return { ok: false, message: `Between ${limits.min} and ${limits.max}.` };
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Patches
// ---------------------------------------------------------------------------

/**
 * `current` with `id` turned on or off, in {@link DEVICE_PROFILES}' display order (ids it does not
 * know, from another build, are dropped: the daemon refuses them).
 */
function toggledProfiles(current: readonly string[], id: string, on: boolean, platform: DevicePlatform): string[] {
  const chosen = new Set(current);
  if (on) chosen.add(id);
  else chosen.delete(id);
  return DEVICE_PROFILES.filter((profile) => profile.platform === platform && chosen.has(profile.id)).map((profile) => profile.id);
}

export function profilesPatch(settings: DevicesSettings, platform: DevicePlatform, id: string, on: boolean): DevicesSettingsPatch {
  const profiles = toggledProfiles(settings[platform].profiles, id, on, platform);
  return platform === "android" ? { android: { profiles } } : { ios: { profiles } };
}

/** A nullable text field: blank clears it to null. */
export function nullableText(text: string): string | null {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 200) : null;
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

export interface ReadinessSummary {
  ok: number;
  total: number;
  /** "3 of 8 ready", "All 8 ready", "Not checked yet". */
  label: string;
  /** Something is missing: "Install all". */
  canInstall: boolean;
  /** Something failed: "Repair". */
  canRepair: boolean;
  /** A setup job is on it. */
  working: boolean;
}

export function readinessSummary(checks: readonly Pick<DeviceReadinessCheck, "state">[]): ReadinessSummary {
  const total = checks.length;
  const ok = checks.filter((check) => check.state === "ok").length;
  const working = checks.some((check) => check.state === "working");
  const canRepair = checks.some((check) => check.state === "error");
  const canInstall = checks.some((check) => check.state === "missing");
  const label = total === 0 ? "Not checked yet" : ok === total ? `All ${total} ready` : `${ok} of ${total} ready`;
  return { ok, total, label, canInstall, canRepair, working };
}

export const READINESS_BADGE: Readonly<Record<DeviceReadinessState, { tone: "ok" | "warn" | "danger" | "info"; text: string }>> = {
  ok: { tone: "ok", text: "OK" },
  missing: { tone: "warn", text: "Missing" },
  error: { tone: "danger", text: "Error" },
  working: { tone: "info", text: "Working…" }
};

/** The button a single check offers: "Install" for a missing item, "Repair" for a broken one. */
export function fixLabel(check: Pick<DeviceReadinessCheck, "state" | "fixActionId">): "Install" | "Repair" | null {
  if (!check.fixActionId) return null;
  if (check.state === "missing") return "Install";
  if (check.state === "error") return "Repair";
  return null;
}

// ---------------------------------------------------------------------------
// Setup job
// ---------------------------------------------------------------------------

export type SetupStepIcon = "pending" | "spinner" | "done" | "failed" | "skipped";

const STEP_ICONS: Readonly<Record<DeviceSetupStepState, SetupStepIcon>> = {
  pending: "pending",
  running: "spinner",
  done: "done",
  failed: "failed",
  skipped: "skipped"
};

export interface SetupJobView {
  running: boolean;
  /** 0–100, or null when unknown (an indeterminate bar). */
  percent: number | null;
  title: string;
  steps: { id: string; label: string; detail: string | null; icon: SetupStepIcon }[];
  logLine: string | null;
  error: string | null;
}

/** Null when nothing is worth showing (no job, or one that finished cleanly). */
export function setupJobView(job: DeviceSetupJob | undefined): SetupJobView | null {
  if (!job || job.state === "done") return null;
  const percent = job.percent === null || !Number.isFinite(job.percent) ? null : Math.round(Math.min(100, Math.max(0, job.percent)));
  const title =
    job.state === "running" ? (percent === null ? "Setting up…" : `Setting up… ${percent}%`) : job.state === "failed" ? "Setup failed" : "Setup cancelled";
  return {
    running: job.state === "running",
    percent,
    title,
    steps: job.steps.map((step) => ({ id: step.id, label: step.label, detail: step.detail, icon: STEP_ICONS[step.state] ?? "pending" })),
    logLine: job.logLine,
    error: job.error ?? (job.state === "failed" ? "The setup stopped. Check the log line and try Repair." : null)
  };
}

// ---------------------------------------------------------------------------
// Mac hosts
// ---------------------------------------------------------------------------

/** "45m", "2h 05m", "1d 3h". */
function formatUptime(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export interface MacHostView {
  rate: string | null;
  uptime: string | null;
  costSoFar: string | null;
  countdown: string | null;
  /** "$4.80/h · up 2h 05m · ~$10.00 so far" */
  line: string;
}

export function macHostView(host: Pick<DeviceHostSummary, "box" | "statusDetail">, now: number): MacHostView {
  const box = host.box;
  if (!box) return { rate: null, uptime: null, costSoFar: null, countdown: null, line: host.statusDetail ?? "" };
  const started = Date.parse(box.startedAt);
  const upMs = Number.isNaN(started) ? null : Math.max(0, now - started);
  const rate = box.hourlyUsd !== null ? formatHourlyRate(box.hourlyUsd) : null;
  const uptime = upMs === null ? null : formatUptime(upMs);
  const costSoFar = box.hourlyUsd !== null && upMs !== null ? formatUsd(costForMinutes(box.hourlyUsd, upMs / 60_000)) : null;
  const countdown = formatCountdown(box.deadlineAt, now);
  const line = [rate, uptime ? `up ${uptime}` : null, costSoFar ? `~${costSoFar} so far` : null].filter(Boolean).join(" · ");
  return { rate, uptime, costSoFar, countdown, line };
}

/** The Mac device hosts (rented boxes running iOS). */
export function macHosts(hosts: readonly DeviceHostSummary[]): DeviceHostSummary[] {
  return hosts.filter((host) => host.kind !== "local" && host.platforms.includes("ios") && host.research !== true);
}

/** The owner's own Macs marked for devices: the ones that may run virtual iPhones. */
export function ownMacHosts(hosts: readonly DeviceHostSummary[]): DeviceHostSummary[] {
  return macHosts(hosts).filter((host) => host.kind === "byo" && host.box !== undefined);
}

/** The empty state's words, with the size's price when the quote is known. */
export function noMacHostText(hourlyUsd: number | null): string {
  return hourlyUsd !== null
    ? `No Mac host running — the first iPhone or iPad rents one (~${formatHourlyRate(hourlyUsd)}).`
    : "No Mac host running — the first iPhone or iPad rents one.";
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface ToolRow {
  id: string;
  label: string;
  /** The version or what is wrong. */
  detail: string | null;
  state: DeviceReadinessState;
  /** Where it was checked ("This machine", a Mac host's label). */
  hostLabel: string;
}

/** Every `tool:*` readiness check, per host, in host order. */
export function toolRows(hosts: readonly DeviceHostSummary[]): ToolRow[] {
  return hosts.flatMap((host) =>
    host.readiness.checks
      .filter((check) => check.id.startsWith("tool:"))
      .map((check) => ({ id: `${host.id}:${check.id}`, label: check.label, detail: check.detail, state: check.state, hostLabel: host.label }))
  );
}

// ---------------------------------------------------------------------------
// Fleet
// ---------------------------------------------------------------------------

export const PLACEMENT_LABELS: Readonly<Record<DevicePlacementMode, string>> = {
  "local-only": "This host only",
  "prefer-local": "Prefer this host",
  "pool-only": "Pool only"
};

export const PLACEMENT_HINTS: Readonly<Record<DevicePlacementMode, string>> = {
  "local-only": "Devices run here; above capacity an agent gets DEVICE_CAPACITY.",
  "prefer-local": "Devices run here first and spill to rented pool hosts.",
  "pool-only": "Every device runs on a rented pool host."
};

// ---------------------------------------------------------------------------
// Device hosts (tailnet machines spec §4.4.7)
// ---------------------------------------------------------------------------

export type DeviceHostOwner = "this-host" | "own" | "rented";

export interface DeviceHostRow {
  id: string;
  label: string;
  owner: DeviceHostOwner;
  /** "This host", "Your machine", "Rented (blacksmith)". */
  ownerText: string;
  /** "Android", "iPhone & iPad". */
  platformsText: string;
  status: DeviceHostSummary["status"];
  statusDetail: string | null;
  /** "2 of 12 devices · from 24 CPUs, 61 GB free memory, 410 GB free disk, KVM". */
  capacityText: string;
  /** Where placement tries it: 1 first; null when placement never picks it on its own. */
  order: number | null;
  /** One line about its place ("Used first", "Only when asked for by name"). */
  placementText: string;
  problems: readonly MachineProblem[];
}

const GiB = 1024 ** 3;

/** "24 CPUs, 61 GB free memory, 410 GB free disk, KVM": what the probe measured capacity from; null without a probe. */
export function capacityBasisText(capacity: DeviceCapacity): string | null {
  const basis = capacity.basis;
  if (!basis) return null;
  const parts = [`${basis.cpus} CPU${basis.cpus === 1 ? "" : "s"}`, `${Math.round(basis.freeMemBytes / GiB)} GB free memory`];
  if (basis.freeDiskBytes !== null) parts.push(`${Math.round(basis.freeDiskBytes / GiB)} GB free disk`);
  if (basis.accel) parts.push(basis.accel === "hvf" ? "Hypervisor.framework" : basis.accel.toUpperCase());
  return parts.join(", ");
}

const OWNER_RANK: Readonly<Record<DeviceHostOwner, number>> = { "this-host": 0, own: 1, rented: 2 };

/**
 * Every device host as Settings → Devices lists it, in placement order: this host first (unless
 * the fleet is pool-only), then the owner's own machines, then rented hosts (within each, placement
 * packs the busiest host with room first). Research hosts open only by name.
 */
export function deviceHostRows(hosts: readonly DeviceHostSummary[], settings: DevicesSettings | null): DeviceHostRow[] {
  const mode = settings?.pool.placement ?? "prefer-local";
  const ownerOf = (host: DeviceHostSummary): DeviceHostOwner => (host.kind === "local" ? "this-host" : host.kind === "byo" ? "own" : "rented");
  const placed = (host: DeviceHostSummary): boolean => {
    if (host.research === true) return false;
    const owner = ownerOf(host);
    return mode === "local-only" ? owner === "this-host" : mode === "pool-only" ? owner !== "this-host" : true;
  };
  const sorted = [...hosts].sort((a, b) => Number(a.research === true) - Number(b.research === true) || OWNER_RANK[ownerOf(a)] - OWNER_RANK[ownerOf(b)] || a.label.localeCompare(b.label));
  const ranks = [...new Set(sorted.filter(placed).map((host) => OWNER_RANK[ownerOf(host)]))];
  return sorted.map((host) => {
    const owner = ownerOf(host);
    const order = placed(host) ? ranks.indexOf(OWNER_RANK[owner]) + 1 : null;
    const basis = capacityBasisText(host.capacity);
    const devices = `${host.capacity.used} of ${host.capacity.total} device${host.capacity.total === 1 ? "" : "s"}`;
    return {
      id: host.id,
      label: host.label,
      owner,
      ownerText: owner === "this-host" ? "This host" : owner === "own" ? "Your machine" : `Rented${host.box?.provider ? ` (${host.box.provider})` : ""}`,
      platformsText: host.platforms.map((platform) => DEVICE_PLATFORM_LABELS[platform]).join(", "),
      status: host.status,
      statusDetail: host.statusDetail,
      capacityText: basis ? `${devices} · from ${basis}` : devices,
      order,
      placementText:
        host.research === true
          ? "Only when asked for by name"
          : order === null
            ? mode === "local-only"
              ? "Not used: devices stay on this host (Fleet → Placement)"
              : "Not used: devices run on pool hosts only (Fleet → Placement)"
            : order === 1
              ? "Used first"
              : owner === "own"
                ? "Used when this host is full"
                : ranks.length > 2
                  ? "Used when your machines are full"
                  : "Used when the hosts above are full",
      problems: host.problems ?? []
    };
  });
}
