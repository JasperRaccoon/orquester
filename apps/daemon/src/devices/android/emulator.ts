/**
 * Launching, finding and stopping Android emulators (spikes §2). Orquester launches every
 * emulator itself (the hub only streams them by serial): read-only instances of a profile's AVD
 * booted from its golden snapshot, a console/adb port pair in 5554–5682, a gRPC port with a token,
 * output to a per-device log file, detached in its own process group so a daemon restart keeps it.
 * Everything runs through a {@link DeviceExecutor}: this machine by default, or a Linux box.
 */

import { join } from "node:path";

import type { ExecFn } from "./exec.ts";
import { type DeviceExecutor, isLocalPortFree, LOCAL_EXECUTOR, pickLocalFreePort } from "./executor.ts";
import { delay, descendantsOf, type ProcStat } from "./procs.ts";

/** The GPU mode every AVD is configured, snapshotted and booted with (spikes §2: fastest without a GPU). */
export const EMULATOR_GPU_MODE = "swangle_indirect";

/** Console ports: even, 5554–5682 (adb uses the odd port above each). */
export const CONSOLE_PORT_MIN = 5554;
export const CONSOLE_PORT_MAX = 5682;
/** adb servers scan 5555–5585 for emulators on start: other appdirs' adb servers would see ours there, so those go last. */
const ADB_SCANNED_MAX = 5584;
/** gRPC ports: one per console port, from here. */
export const GRPC_PORT_BASE = 8554;

export interface EmulatorLaunch {
  avd: string;
  consolePort: number;
  grpcPort: number;
  /** A golden-snapshot boot: writable, cold, and the snapshot is saved on `emu kill` (or, with `snapshot`, by name and never on exit). */
  golden?: boolean;
  /** The GPU mode (a snapshot loads only with the mode it was saved with); absent: {@link EMULATOR_GPU_MODE}. */
  gpu?: string;
  /** A named snapshot a lease boots from (`-snapshot <name>`; box hosts: `orq-golden`); absent: `default_boot`. */
  snapshot?: string;
  /** A lease booted cold (its snapshot would not load). */
  coldBoot?: boolean;
}

/** The emulator's arguments (spikes §2 flags). */
export function emulatorArgs(launch: EmulatorLaunch): string[] {
  const common = [
    "-avd",
    launch.avd,
    "-no-window",
    "-no-audio",
    "-no-boot-anim",
    "-no-metrics",
    "-accel",
    "on",
    "-gpu",
    launch.gpu ?? EMULATOR_GPU_MODE,
    "-port",
    String(launch.consolePort),
    "-grpc",
    String(launch.grpcPort),
    "-grpc-use-token",
    "-camera-back",
    "none",
    "-camera-front",
    "none"
  ];
  // Golden: cold boot, writable, saves `default_boot` on `emu kill` (a named golden is saved by
  // `adb emu avd snapshot save` instead, never on exit). Leases: read-only (many instances of one
  // AVD at once), from that snapshot, never saving.
  if (launch.golden) return launch.snapshot ? [...common, "-no-snapshot-load", "-no-snapshot-save"] : [...common, "-no-snapshot-load"];
  const from = launch.coldBoot ? ["-no-snapshot-load"] : launch.snapshot ? ["-snapshot", launch.snapshot] : [];
  return ["-read-only", ...common, ...from, "-no-snapshot-save"];
}

export function serialOf(consolePort: number): string {
  return `emulator-${consolePort}`;
}

export function consolePortOf(serial: string): number | null {
  const match = /^emulator-(\d+)$/.exec(serial);
  return match ? Number(match[1]) : null;
}

/** Console ports in the order they are tried: above adb's scan range first. */
export function consolePortCandidates(): number[] {
  const ports: number[] = [];
  for (let port = ADB_SCANNED_MAX + 2; port <= CONSOLE_PORT_MAX; port += 2) ports.push(port);
  for (let port = CONSOLE_PORT_MIN; port <= ADB_SCANNED_MAX; port += 2) ports.push(port);
  return ports;
}

export function grpcPortFor(consolePort: number): number {
  return GRPC_PORT_BASE + (consolePort - CONSOLE_PORT_MIN) / 2;
}

/** Whether nothing listens on 127.0.0.1:`port` now (this machine). */
export const isPortFree = isLocalPortFree;

/** A free port the OS picks (the hub's; this machine). */
export const pickFreePort = pickLocalFreePort;

/**
 * The first console port (and its gRPC port) not `taken` by this host and free on the machine:
 * the console port, its adb port (+1) and the gRPC port must all be unbound. Null when none is.
 */
export async function allocateEmulatorPorts(taken: ReadonlySet<number>, isFree: (port: number) => Promise<boolean> = isPortFree): Promise<{ consolePort: number; grpcPort: number } | null> {
  for (const consolePort of consolePortCandidates()) {
    if (taken.has(consolePort)) continue;
    const grpcPort = grpcPortFor(consolePort);
    if ((await isFree(consolePort)) && (await isFree(consolePort + 1)) && (await isFree(grpcPort))) return { consolePort, grpcPort };
  }
  return null;
}

/** How the emulator reaches /dev/kvm: directly, or through `sg kvm` (the daemon lacks the group but /etc/group lists its user). */
export type KvmMode = "direct" | "sg";

/** POSIX shell quoting for `sg kvm -c` (its only form; the arguments carry no secrets). */
export function shellQuote(args: readonly string[]): string {
  return args.map((arg) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`)).join(" ");
}

/** The program and arguments that start `binary args…` with KVM access. */
export function kvmCommand(mode: KvmMode, binary: string, args: readonly string[]): { command: string; args: string[] } {
  return mode === "sg" ? { command: "sg", args: ["kvm", "-c", `exec ${shellQuote([binary, ...args])}`] } : { command: binary, args: [...args] };
}

export interface SpawnedEmulator {
  /** The launcher's pid: the process group id of everything it started. */
  pgid: number;
}

/** Start an emulator detached (own session), output appended to `logPath`. */
export async function spawnEmulator(options: {
  sdk: string;
  env: NodeJS.ProcessEnv;
  kvm: KvmMode;
  launch: EmulatorLaunch;
  logPath: string;
  executor?: DeviceExecutor;
}): Promise<SpawnedEmulator> {
  const binary = join(options.sdk, "emulator", "emulator");
  const { command, args } = kvmCommand(options.kvm, binary, emulatorArgs(options.launch));
  const pgid = await (options.executor ?? LOCAL_EXECUTOR).spawnDetached(command, args, { env: options.env, logPath: options.logPath });
  return { pgid };
}

/** The emulator's QEMU process in a launcher's process group (the launcher, or `sg`, forks it). */
export async function findQemuPid(pgid: number, executor: Pick<DeviceExecutor, "procStats"> = LOCAL_EXECUTOR): Promise<number | null> {
  const stats = await executor.procStats();
  const qemu = stats.find((stat) => stat.pgrp === pgid && stat.comm.startsWith("qemu-system"));
  if (qemu) return qemu.pid;
  return descendantsOf(pgid, stats).find((stat) => stat.comm.startsWith("qemu-system"))?.pid ?? null;
}

export interface BootWaitDeps {
  exec: ExecFn;
  adb: string;
  env: NodeJS.ProcessEnv;
  serial: string;
  /** The process to watch: a boot fails at once when it exits. */
  alive: () => Promise<boolean>;
  signal: AbortSignal;
  timeoutMs: number;
  pollMs?: number;
}

/** Resolves once `sys.boot_completed` is 1; rejects when the emulator exits, the signal aborts or time runs out. */
export async function waitForBootCompleted(deps: BootWaitDeps): Promise<void> {
  const deadline = Date.now() + deps.timeoutMs;
  while (true) {
    deps.signal.throwIfAborted();
    if (!(await deps.alive())) throw new Error("exited during boot");
    const result = await deps.exec(deps.adb, ["-s", deps.serial, "shell", "getprop", "sys.boot_completed"], { env: deps.env, timeoutMs: 5_000, signal: deps.signal });
    if (result.exitCode === 0 && result.stdout.trim() === "1") return;
    if (Date.now() > deadline) throw new Error(`did not finish booting within ${Math.round(deps.timeoutMs / 1000)} s`);
    await delay(deps.pollMs ?? 1_000, deps.signal);
  }
}

/** What marks a process as one of this host's: `KEY=value` in its environment (`env.ts` `appdirMarker`). */
export interface ProcessMarker {
  key: string;
  value: string;
}

/**
 * The emulator's QEMU process `pid` as this host started it, or null: alive, `qemu-system*`, its
 * environment carries `marker`, and (when recorded) it started at `startTicks`. A pid that fails
 * any of these may have been reused by another process: it is never signalled.
 */
export async function verifyEmulator(
  executor: Pick<DeviceExecutor, "procStat" | "environ">,
  pid: number,
  marker: ProcessMarker,
  startTicks?: number | null
): Promise<ProcStat | null> {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  const stat = await executor.procStat(pid);
  if (!stat || stat.state === "Z" || stat.state === "X" || !stat.comm.startsWith("qemu-system")) return null;
  if (startTicks !== undefined && startTicks !== null && stat.startTicks !== startTicks) return null;
  const env = await executor.environ(pid);
  return env?.get(marker.key) === marker.value ? stat : null;
}

export interface StopEmulatorDeps {
  exec: ExecFn;
  adb: string;
  env: NodeJS.ProcessEnv;
  serial: string;
  pid: number;
  pgid: number | null;
  /** This host's marker: only a process carrying it is signalled. */
  marker: ProcessMarker;
  /** The recorded start time of `pid` (absent: an older record, checked by marker and name only). */
  startTicks?: number | null;
  /** How long `emu kill` may take (a golden boot saves its snapshot then: seconds). */
  graceMs?: number;
  /** Where it runs (absent: this machine). */
  executor?: DeviceExecutor;
}

/**
 * `adb emu kill` → SIGTERM → SIGKILL. Every signal goes only to the verified emulator
 * ({@link verifyEmulator}, checked again before each one): its process group while the emulator is
 * still in it, else the pid alone; the launcher's group afterwards only while a process of it still
 * carries the marker. Resolves how it ended.
 */
export async function stopEmulator(deps: StopEmulatorDeps): Promise<"gone" | "emu-kill" | "sigterm" | "sigkill"> {
  const x = deps.executor ?? LOCAL_EXECUTOR;
  const first = await verifyEmulator(x, deps.pid, deps.marker, deps.startTicks);
  if (!first) return "gone";
  // From here on the identity includes the start time (read now for an older record): a pid reused later never matches.
  const identity = deps.startTicks ?? first.startTicks ?? null;
  const ours = () => verifyEmulator(x, deps.pid, deps.marker, identity);
  const gone = async (ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (!(await ours())) return true;
      await delay(200);
    }
    return !(await ours());
  };
  const signal = async (name: NodeJS.Signals): Promise<void> => {
    const stat = await ours();
    if (!stat) return;
    await x.signal(deps.pgid !== null && stat.pgrp === deps.pgid ? deps.pgid : null, deps.pid, name);
  };
  await deps.exec(deps.adb, ["-s", deps.serial, "emu", "kill"], { env: deps.env, timeoutMs: 10_000 }).catch(() => undefined);
  if (await gone(deps.graceMs ?? 15_000)) return finish("emu-kill");
  await signal("SIGTERM");
  if (await gone(10_000)) return finish("sigterm");
  await signal("SIGKILL");
  await gone(5_000);
  return finish("sigkill");

  async function finish<T>(how: T): Promise<T> {
    // The launcher (or `sg`) and any helper left in the group follow the emulator.
    if (deps.pgid !== null && deps.pgid !== deps.pid) await signalLauncher(x, deps.pgid, deps.marker, "SIGTERM").catch(() => false);
    return how;
  }
}

/**
 * Signal a launcher's process group, only while a process of it still carries this host's marker
 * (the group id may belong to someone else by now). False when nothing was signalled.
 */
export async function signalLauncher(executor: Pick<DeviceExecutor, "procStats" | "environ" | "signal">, pgid: number, marker: ProcessMarker, signal: NodeJS.Signals): Promise<boolean> {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  for (const member of (await executor.procStats()).filter((stat) => stat.pgrp === pgid)) {
    if ((await executor.environ(member.pid).catch(() => null))?.get(marker.key) === marker.value) return executor.signal(pgid, -1, signal);
  }
  return false;
}
