/**
 * The local Android host's process record (`devicesHubStatePath`, `hub.json`): the hub's pid and
 * port, and every emulator it launched (pid, process group, ports, profile, lease). A restarted
 * daemon reattaches to what is still running (pid alive, environment names this appdir) and reaps
 * the rest (emulators no live lease holds). Tolerant: unreadable entries are dropped, unknown keys
 * kept on rewrite. Holds no secrets (the hub token stays in the hub's own state file).
 */

import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";

export const HOST_STATE_VERSION = 1;

export interface HubRecord {
  pid: number;
  port: number;
  startedAt: string;
}

export interface EmulatorRecord {
  serial: string;
  /** The QEMU process. */
  pid: number;
  /** The launcher's process group. */
  pgid: number | null;
  /** The QEMU process's start time (`/proc/<pid>/stat` field 22): a reused pid never matches it. Absent in older records. */
  startTicks?: number;
  consolePort: number;
  grpcPort: number;
  profile: string;
  avd: string;
  /** The lease it was booted for; null while none holds it. */
  leaseId: string | null;
  /** A golden-snapshot boot (never leased; reaped after a restart). */
  golden: boolean;
  startedAt: string;
  logPath: string;
}

export interface HostStateFile {
  version: number;
  hub: HubRecord | null;
  emulators: EmulatorRecord[];
  /** Keys this build does not know, kept on rewrite. */
  extra: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const posInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;
const str = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function readHub(value: unknown): HubRecord | null {
  if (!isRecord(value) || !posInt(value.pid) || !posInt(value.port)) return null;
  return { pid: value.pid, port: value.port, startedAt: str(value.startedAt) ? value.startedAt : "" };
}

function readEmulator(value: unknown): EmulatorRecord | null {
  if (!isRecord(value) || !str(value.serial) || !posInt(value.pid) || !posInt(value.consolePort) || !posInt(value.grpcPort) || !str(value.profile) || !str(value.avd)) return null;
  return {
    serial: value.serial,
    pid: value.pid,
    pgid: posInt(value.pgid) ? value.pgid : null,
    ...(posInt(value.startTicks) ? { startTicks: value.startTicks } : {}),
    consolePort: value.consolePort,
    grpcPort: value.grpcPort,
    profile: value.profile,
    avd: value.avd,
    leaseId: str(value.leaseId) ? value.leaseId : null,
    golden: value.golden === true,
    startedAt: str(value.startedAt) ? value.startedAt : "",
    logPath: str(value.logPath) ? value.logPath : ""
  };
}

export function emptyHostState(): HostStateFile {
  return { version: HOST_STATE_VERSION, hub: null, emulators: [], extra: {} };
}

export function parseHostState(text: string): HostStateFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyHostState();
  }
  if (!isRecord(raw)) return emptyHostState();
  const { version: _version, hub, emulators, ...extra } = raw;
  return {
    version: HOST_STATE_VERSION,
    hub: readHub(hub),
    emulators: Array.isArray(emulators) ? emulators.map(readEmulator).filter((entry): entry is EmulatorRecord => entry !== null) : [],
    extra
  };
}

export function serializeHostState(state: HostStateFile): string {
  return `${JSON.stringify({ ...state.extra, version: HOST_STATE_VERSION, hub: state.hub, emulators: state.emulators }, null, 2)}\n`;
}

export async function readHostState(file: string): Promise<HostStateFile> {
  try {
    return parseHostState(await readFile(file, "utf8"));
  } catch {
    return emptyHostState();
  }
}

/** Atomic rewrite (temp file + rename), 0600. */
export async function writeHostState(file: string, state: HostStateFile): Promise<void> {
  const temp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temp, serializeHostState(state), { mode: 0o600 });
  await rename(temp, file);
}

export interface ReattachPlan {
  /** Still running under a live lease: supervise again. */
  keep: EmulatorRecord[];
  /** Running, but no live lease holds it (or a golden boot a crash interrupted): stop it. */
  reap: EmulatorRecord[];
  /** Gone (or its pid now belongs to someone else): forget. */
  forget: EmulatorRecord[];
  hub: "reattach" | "forget" | "none";
}

/**
 * What a restarted daemon does with the recorded processes. `ours(pid)` says the pid is alive and
 * still the process this appdir started (its environment names the appdir); `liveLeases` are the
 * leases the service still holds on this host.
 */
export function planReattach(state: HostStateFile, ours: ReadonlySet<number>, liveLeases: ReadonlySet<string>): ReattachPlan {
  const plan: ReattachPlan = { keep: [], reap: [], forget: [], hub: state.hub ? (ours.has(state.hub.pid) ? "reattach" : "forget") : "none" };
  for (const emulator of state.emulators) {
    if (!ours.has(emulator.pid)) plan.forget.push(emulator);
    else if (!emulator.golden && emulator.leaseId !== null && liveLeases.has(emulator.leaseId)) plan.keep.push(emulator);
    else plan.reap.push(emulator);
  }
  return plan;
}
