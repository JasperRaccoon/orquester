/**
 * simslim on a Mac device host (devices phase 2 §2 goal 7), pure: the Orquester slim profile, the
 * argv of every simslim command the host runs, and parsers for their `--json` output (the shapes
 * of simslim 0.13.0's `output.go`, `verify.go` and `measure.go`).
 *
 * simslim writes per-simulator `launchctl disable` overrides so a simulator boots without ~170
 * background daemons it does not need (~4x less memory). On a shut-down simulator of an iOS 18.5+
 * runtime it writes the overrides straight into the store `launchd_sim` reads at start (no
 * `launchctl` calls, no reboot), boots once and reads the state back. The overrides survive
 * shutdowns, `simctl rename` and `erase`, not `clone`.
 *
 * Device set: Orquester's simulators stay in the default set, namespaced by name (`orq-*`, see
 * `simctl.ts`). simslim (`--set`) and agent-device (`--ios-simulator-device-set`,
 * `AGENT_DEVICE_IOS_SIMULATOR_DEVICE_SET`) can both use a custom set, but serve-sim (the hub's iOS
 * capture, expo-device-hub 0.19) cannot: its native module only opens
 * `SimServiceContext.defaultDeviceSetWithError:` and its `simctl io/list/launch` calls pass no
 * `--set`, so a simulator in another set would never stream.
 */

import { posix } from "node:path";

import { SIMSLIM_RELEASE, SIMSLIM_TOOL_PATH } from "../../../boxes/github/device-cache.ts";

/** simslim's binary under a tools dir. */
export function simslimBin(toolsDir: string): string {
  return posix.join(toolsDir, SIMSLIM_TOOL_PATH);
}

/** Where a host writes {@link ORQ_SLIM_PROFILE} in the box. */
export function simslimProfilePath(deviceRoot: string): string {
  return posix.join(deviceRoot, "simslim-profile.json");
}

/**
 * Orquester's slim profile (`simslim on --profile`): everything off except what agents commonly
 * test in apps they build:
 * - `com.apple.apsd`: push notifications (`simctl push`, remote push registration);
 * - `com.apple.swcd`: universal links / associated domains (`simctl openurl https://…` deep links);
 * - `com.apple.assetsd`: the Photos library behind the photo picker (`simctl addmedia`, upload
 *   flows); its heavy sibling `photoanalysisd` stays off.
 * StoreKit, App Store, iCloud, Siri, Spotlight, widgets and the rest stay off: they need an Apple
 * account or Xcode StoreKit config anyway, and cost the most memory. A chat that needs one can
 * still `simslim enable` it on its device.
 */
const ORQ_SLIM_PROFILE = Object.freeze({
  name: "orquester",
  description: "Orquester device hosts: agents build and test apps (push, universal links and the photo picker kept)",
  except: [] as string[],
  keep: ["com.apple.apsd", "com.apple.swcd", "com.apple.assetsd"]
});

export const ORQ_SLIM_PROFILE_JSON = `${JSON.stringify(ORQ_SLIM_PROFILE, null, 2)}\n`;

/** Slow CI Macs: simslim's whole boot-and-reconfigure deadline and each `launchctl` transition. */
export const SIMSLIM_ENV: Readonly<Record<string, string>> = Object.freeze({ SIMSLIM_BOOT_TIMEOUT: "15m", SIMSLIM_SPAWN_TIMEOUT: "5m" });

/** The earliest runtime whose launchd overrides persist across reboots (simslim's gate). */
const SIMSLIM_MIN_IOS = "18.5";

/** Whether simslim can slim a simulator of this iOS version persistently ("27.0", "18.4.1"). */
export function slimmableIos(osVersion: string): boolean {
  const [major = 0, minor = 0] = osVersion.split(".").map((part) => Number(part) || 0);
  const [minMajor = 0, minMinor = 0] = SIMSLIM_MIN_IOS.split(".").map(Number);
  return major > minMajor || (major === minMajor && minor >= minMinor);
}

/**
 * `simslim on`: apply the profile. On a shut-down simulator it writes the overrides offline, boots
 * it once and reads them back; with `preserveBootState` it then shuts it down again (a pool
 * simulator), without it the simulator is left booted (a lease's first boot).
 */
export function simslimOnArgs(input: { udid: string; profilePath: string; preserveBootState?: boolean; noReboot?: boolean }): string[] {
  return [
    "on",
    input.udid,
    "--profile",
    input.profilePath,
    ...(input.preserveBootState ? ["--preserve-boot-state"] : []),
    ...(input.noReboot ? ["--no-reboot"] : [])
  ];
}

/** `simslim verify --json`: a booted simulator's overrides against the profile (exit 1 on drift, JSON either way). */
export function simslimVerifyArgs(input: { udid: string; profilePath: string }): string[] {
  return ["verify", input.udid, "--profile", input.profilePath, "--json"];
}

/** `simslim top --json`: every booted simulator's footprint (all sets scanned) and their total. */
export function simslimTopArgs(): string[] {
  return ["top", "--json"];
}

/** `simslim measure --json`: one booted simulator's footprint. */
export function simslimMeasureArgs(udid: string): string[] {
  return ["measure", udid, "--json"];
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** What the install script reported. */
export type SimslimInstall = { kind: "installed"; version: string } | { kind: "unsupported"; reason: string };

/** The install script's last line (`simslim 0.13.0` or `simslim-unsupported <why>`), or null. */
export function parseSimslimInstall(stdout: string): SimslimInstall | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  const unsupported = /^simslim-unsupported\s*(.*)$/.exec(last);
  if (unsupported) return { kind: "unsupported", reason: unsupported[1] || "unsupported Mac" };
  const installed = /^simslim (\S+)$/.exec(last);
  return installed ? { kind: "installed", version: installed[1]! } : null;
}

/** Whether the installed version is the pinned one. */
export function isPinnedSimslim(install: SimslimInstall | null): boolean {
  return install?.kind === "installed" && install.version === SIMSLIM_RELEASE.version;
}

/** `Measurement` (`measure.go`): summed phys_footprint of a simulator's launchd tree. */
export interface SimslimMeasurement {
  processes: number;
  bytes: number;
  cpu: number;
}

/** `VerifyResult` (`verify.go`). */
export interface SimslimVerify {
  udid: string;
  ok: boolean;
  missing: string[];
  extra: string[];
}

/** `TopSim` (`output.go`): one booted simulator. */
export interface SimslimTopSim {
  udid: string;
  name: string;
  state: string;
  osVersion: string;
  /** Managed labels disabled now (absent when it could not be read). */
  managedDisabled: number | null;
  managedTotal: number;
  memory: SimslimMeasurement | null;
}

/** `TopOutput` (`output.go`): every booted simulator and their summed footprint. */
export interface SimslimTop {
  sims: SimslimTopSim[];
  totalBytes: number;
}

function json(stdout: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(stdout.trim()) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);

function measurementOf(value: unknown): SimslimMeasurement | null {
  if (value === null || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  const bytes = num(entry.bytes);
  if (bytes === null) return null;
  return { processes: num(entry.processes) ?? 0, bytes, cpu: num(entry.cpu) ?? 0 };
}

export function parseSimslimVerify(stdout: string): SimslimVerify | null {
  const data = json(stdout);
  if (!data || typeof data.ok !== "boolean") return null;
  return { udid: typeof data.udid === "string" ? data.udid : "", ok: data.ok, missing: strings(data.missing), extra: strings(data.extra) };
}

export function parseSimslimTop(stdout: string): SimslimTop | null {
  const data = json(stdout);
  if (!data) return null;
  // Go marshals an empty slice of booted simulators as null.
  if (data.sims !== null && data.sims !== undefined && !Array.isArray(data.sims)) return null;
  const sims: SimslimTopSim[] = [];
  for (const raw of (data.sims as unknown[] | null) ?? []) {
    if (raw === null || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.udid !== "string") continue;
    sims.push({
      udid: entry.udid,
      name: typeof entry.name === "string" ? entry.name : "",
      state: typeof entry.state === "string" ? entry.state : "Unknown",
      osVersion: typeof entry.osVersion === "string" ? entry.osVersion : "",
      managedDisabled: num(entry.managedDisabled),
      managedTotal: num(entry.managedTotal) ?? 0,
      memory: measurementOf(entry.memory)
    });
  }
  const summed = sims.reduce((total, sim) => total + (sim.memory?.bytes ?? 0), 0);
  return { sims, totalBytes: num(data.totalBytes) ?? summed };
}

/** A simulator `top` reads as slim: most managed daemons disabled (a profile keeps a few on). */
export function isSlim(sim: Pick<SimslimTopSim, "managedDisabled" | "managedTotal">): boolean {
  return sim.managedDisabled !== null && sim.managedTotal > 0 && sim.managedDisabled >= sim.managedTotal / 2;
}
