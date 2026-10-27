/**
 * Launching, finding and stopping Android emulators (spikes §2). Orquester launches every
 * emulator itself (the hub only streams them by serial): read-only instances of a profile's AVD
 * booted from its golden snapshot, a console/adb port pair in 5554–5682, a gRPC port with a token,
 * output to a per-device log file, detached in its own process group so a daemon restart keeps it.
 */

import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

import type { ExecFn } from "./exec.ts";
import { delay, descendantsOf, isProcessAlive, listProcStats, signalGroup, waitForExit } from "./procs.ts";

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
  /** A golden-snapshot boot: writable, cold, and the snapshot is saved on `emu kill`. */
  golden?: boolean;
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
    EMULATOR_GPU_MODE,
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
  // Golden: cold boot, writable, saves `default_boot` on `emu kill`. Leases: read-only (many
  // instances of one AVD at once), from that snapshot, never saving.
  return launch.golden ? [...common, "-no-snapshot-load"] : ["-read-only", ...common, "-no-snapshot-save"];
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

/** Whether nothing listens on 127.0.0.1:`port` now. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => server.close(() => resolve(true)));
  });
}

/** A free port the OS picks (the hub's). */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

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
export function spawnEmulator(options: { sdk: string; env: NodeJS.ProcessEnv; kvm: KvmMode; launch: EmulatorLaunch; logPath: string }): SpawnedEmulator {
  const binary = join(options.sdk, "emulator", "emulator");
  const { command, args } = kvmCommand(options.kvm, binary, emulatorArgs(options.launch));
  const log = openSync(options.logPath, "a", 0o600);
  try {
    const child = spawn(command, args, { env: options.env, cwd: options.env.HOME, detached: true, stdio: ["ignore", log, log] });
    if (child.pid === undefined) throw new Error("the emulator did not start");
    child.on("error", () => undefined);
    child.unref();
    return { pgid: child.pid };
  } finally {
    closeSync(log);
  }
}

/** The emulator's QEMU process in a launcher's process group (the launcher, or `sg`, forks it). */
export async function findQemuPid(pgid: number): Promise<number | null> {
  const stats = await listProcStats();
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

export interface StopEmulatorDeps {
  exec: ExecFn;
  adb: string;
  env: NodeJS.ProcessEnv;
  serial: string;
  pid: number;
  pgid: number | null;
  /** How long `emu kill` may take (a golden boot saves its snapshot then: seconds). */
  graceMs?: number;
}

/** `adb emu kill` → SIGTERM → SIGKILL (to its process group). Resolves how it ended. */
export async function stopEmulator(deps: StopEmulatorDeps): Promise<"gone" | "emu-kill" | "sigterm" | "sigkill"> {
  // A pid that is gone is never signalled (nor its group: the ids may be reused by now).
  if (!(await isProcessAlive(deps.pid))) return "gone";
  await deps.exec(deps.adb, ["-s", deps.serial, "emu", "kill"], { env: deps.env, timeoutMs: 10_000 }).catch(() => undefined);
  if (await waitForExit(deps.pid, deps.graceMs ?? 15_000)) return finish("emu-kill");
  signalGroup(deps.pgid, deps.pid, "SIGTERM");
  if (await waitForExit(deps.pid, 10_000)) return finish("sigterm");
  signalGroup(deps.pgid, deps.pid, "SIGKILL");
  await waitForExit(deps.pid, 5_000);
  return finish("sigkill");

  function finish<T>(how: T): T {
    // The launcher (or `sg`) and any helper left in the group follow the emulator.
    if (deps.pgid !== null && deps.pgid > 1 && deps.pgid !== deps.pid) {
      try {
        process.kill(-deps.pgid, "SIGTERM");
      } catch {
        // already gone
      }
    }
    return how;
  }
}
