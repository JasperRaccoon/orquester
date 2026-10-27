/**
 * A profile's golden snapshot (spikes §2): one writable cold boot of its AVD, wait for
 * `sys.boot_completed`, wait for the first-boot work to settle (a fresh AVD burns 200–400 % CPU
 * for ~3.5 min), apply the guest settings every lease wants (animations off, screen never off,
 * error dialogs hidden), pre-install agent-device's helper APKs, then `adb emu kill`, which saves
 * `default_boot`. Leases then boot read-only from it in seconds. Made lazily, the first time a
 * profile is opened (or on an explicit setup action).
 */

import { join } from "node:path";

import type { DeviceProfile } from "@orquester/api";

import type { DeviceHostProgress } from "../host.ts";
import { avdName } from "./avd-config.ts";
import { type EmulatorLaunch, findQemuPid, type KvmMode, serialOf, spawnEmulator, stopEmulator, waitForBootCompleted } from "./emulator.ts";
import { type ExecFn, lastLine } from "./exec.ts";
import { type DeviceExecutor, LOCAL_EXECUTOR } from "./executor.ts";
import { delay, isProcessAlive } from "./procs.ts";

/** Guest settings baked into every golden snapshot (and re-applied after each lease boot). */
export const GUEST_SETTINGS_SCRIPT = [
  "settings put global window_animation_scale 0",
  "settings put global transition_animation_scale 0",
  "settings put global animator_duration_scale 0",
  "settings put system screen_off_timeout 2147483647",
  "settings put global hide_error_dialogs 1",
  "svc power stayon true",
  "input keyevent KEYCODE_WAKEUP"
].join("; ");

export const ANIMATIONS_OFF_SCRIPT = GUEST_SETTINGS_SCRIPT.split("; ").slice(0, 3).join("; ");

/**
 * Dismiss what a loaded first boot leaves on screen: `hide_error_dialogs` only stops NEW error
 * dialogs, and a "System UI isn't responding" dialog raised while the boot was still settling would
 * otherwise be saved into the snapshot and greet every lease (error dialogs close on this broadcast).
 */
export const CLOSE_SYSTEM_DIALOGS_SCRIPT = "am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS";

/** Run after each lease boot: the animations off again, and any dialog an older snapshot kept closed. */
export const LEASE_BOOT_SCRIPT = `${ANIMATIONS_OFF_SCRIPT}; ${CLOSE_SYSTEM_DIALOGS_SCRIPT}`;

/** Settle: CPU of the emulator (in % of one core) under this for two windows in a row. */
export const SETTLE_CPU_PERCENT = 60;
export const SETTLE_WINDOW_MS = 10_000;
export const SETTLE_MAX_MS = 5 * 60_000;
const CLOCK_TICKS = 100;

export interface GoldenDeps {
  exec: ExecFn;
  sdk: string;
  avdHome: string;
  logs: string;
  env: NodeJS.ProcessEnv;
  kvm: KvmMode;
  /** A console/gRPC port pair reserved for this boot; `release` frees it. */
  reservePorts(): Promise<{ consolePort: number; grpcPort: number; release(): void }>;
  /** Record the running golden boot (orphan reaping after a crash), and forget it. */
  track(record: { serial: string; pid: number; pgid: number; consolePort: number; grpcPort: number; logPath: string }): Promise<void>;
  untrack(serial: string): Promise<void>;
  /** agent-device's helper APKs to pre-install (best effort; paths where the emulator runs). */
  helperApks: readonly string[];
  logger: Pick<Console, "info" | "warn" | "error">;
  /** Where it runs (absent: this machine). */
  executor?: DeviceExecutor;
  /** The GPU mode to boot and snapshot with (absent: the emulator module's default). */
  gpu?: string;
  /**
   * Save a named snapshot (`adb emu avd snapshot save <name>`, box hosts' `orq-golden`, the
   * device cache's layout) instead of `default_boot` on `emu kill`.
   */
  snapshotName?: string;
  /** How long the cold boot may take (absent: 10 minutes). */
  bootTimeoutMs?: number;
}

/** Where a golden snapshot lands (`snapshots/<name>/snapshot.pb`). */
export function goldenSnapshotFile(avdHome: string, profileId: string, snapshotName = "default_boot"): string {
  return join(avdHome, `${avdName(profileId)}.avd`, "snapshots", snapshotName, "snapshot.pb");
}

/** CPU use of `pid` over `windowMs`, in % of one core; null when it exited. */
export async function sampleCpuPercent(pid: number, windowMs: number, signal: AbortSignal, executor: Pick<DeviceExecutor, "procStat"> = LOCAL_EXECUTOR): Promise<number | null> {
  const before = await executor.procStat(pid);
  await delay(windowMs, signal);
  const after = await executor.procStat(pid);
  if (!before || !after) return null;
  return ((after.cpuTicks - before.cpuTicks) / CLOCK_TICKS / (windowMs / 1000)) * 100;
}

/** Wait until two windows in a row are under the threshold, or `maxMs` passed. Resolves whether it settled. */
export async function waitForSettle(
  sample: () => Promise<number | null>,
  options: { maxMs: number; threshold: number; now?: () => number; onSample?: (percent: number) => void }
): Promise<boolean> {
  const now = options.now ?? Date.now;
  const deadline = now() + options.maxMs;
  let quiet = 0;
  while (now() < deadline) {
    const percent = await sample();
    if (percent === null) throw new Error("exited while settling");
    options.onSample?.(percent);
    quiet = percent < options.threshold ? quiet + 1 : 0;
    if (quiet >= 2) return true;
  }
  return false;
}

/** Make `profile`'s golden snapshot. The caller holds the profile's lock (no other instance of the AVD runs). */
export async function createGoldenSnapshot(profile: DeviceProfile, deps: GoldenDeps, signal: AbortSignal, onProgress: (progress: DeviceHostProgress) => void): Promise<void> {
  const step = `snapshot:${profile.id}`;
  const label = `Preparing ${profile.label} for first use`;
  const report = (detail: string, percent?: number) => onProgress({ step, label, state: "running", detail, ...(percent !== undefined ? { percent } : {}) });
  const x = deps.executor ?? LOCAL_EXECUTOR;
  const ports = await deps.reservePorts();
  const serial = serialOf(ports.consolePort);
  const logPath = join(deps.logs, `golden-${profile.id}.log`);
  const adb = join(deps.sdk, "platform-tools", "adb");
  const launch: EmulatorLaunch = {
    avd: avdName(profile.id),
    consolePort: ports.consolePort,
    grpcPort: ports.grpcPort,
    golden: true,
    ...(deps.gpu ? { gpu: deps.gpu } : {}),
    ...(deps.snapshotName ? { snapshot: deps.snapshotName } : {})
  };
  let pid: number | null = null;
  let pgid: number | null = null;
  let saved = false;
  const started = Date.now();
  try {
    report("Cold-booting the emulator", 5);
    await deps.exec(adb, ["start-server"], { env: deps.env, timeoutMs: 30_000 });
    pgid = (await spawnEmulator({ sdk: deps.sdk, env: deps.env, kvm: deps.kvm, launch, logPath, executor: x })).pgid;
    for (let tries = 0; tries < 150 && pid === null; tries++) {
      pid = await findQemuPid(pgid, x);
      if (pid === null) {
        if (!(await isProcessAlive(pgid, x))) break;
        await delay(200, signal);
      }
    }
    if (pid === null) throw new Error(`the emulator did not start (see ${logPath})`);
    await deps.track({ serial, pid, pgid, consolePort: ports.consolePort, grpcPort: ports.grpcPort, logPath });
    const qemu = pid;
    await waitForBootCompleted({ exec: deps.exec, adb, env: deps.env, serial, alive: () => isProcessAlive(qemu, x), signal, timeoutMs: deps.bootTimeoutMs ?? 10 * 60_000 });
    deps.logger.info(`[devices] golden ${profile.id}: booted in ${Math.round((Date.now() - started) / 1000)} s`);
    report("Waiting for first-boot work to settle", 25);
    const settleStart = Date.now();
    const settled = await waitForSettle(() => sampleCpuPercent(qemu, SETTLE_WINDOW_MS, signal, x), {
      maxMs: SETTLE_MAX_MS,
      threshold: SETTLE_CPU_PERCENT,
      onSample: (percent) => {
        const elapsed = Date.now() - settleStart;
        report(`Settling (emulator CPU ${Math.round(percent)} %)`, 25 + Math.min(55, Math.round((elapsed / SETTLE_MAX_MS) * 55)));
      }
    });
    deps.logger.info(`[devices] golden ${profile.id}: ${settled ? "settled" : "did not settle"} after ${Math.round((Date.now() - settleStart) / 1000)} s`);
    report("Applying settings", 82);
    const settings = await deps.exec(adb, ["-s", serial, "shell", GUEST_SETTINGS_SCRIPT], { env: deps.env, signal, timeoutMs: 60_000 });
    if (settings.exitCode !== 0) throw new Error(`applying guest settings failed: ${lastLine(settings)}`);
    for (const apk of deps.helperApks) {
      if (!(await x.exists(apk))) continue;
      const installed = await deps.exec(adb, ["-s", serial, "install", "-r", "-g", apk], { env: deps.env, signal, timeoutMs: 120_000 });
      if (installed.exitCode !== 0) deps.logger.warn(`[devices] golden ${profile.id}: pre-installing ${apk} failed: ${lastLine(installed)}`);
    }
    await delay(3_000, signal);
    const closed = await deps.exec(adb, ["-s", serial, "shell", CLOSE_SYSTEM_DIALOGS_SCRIPT], { env: deps.env, signal, timeoutMs: 30_000 });
    if (closed.exitCode !== 0) deps.logger.warn(`[devices] golden ${profile.id}: closing system dialogs failed: ${lastLine(closed)}`);
    await delay(1_000, signal);
    report("Saving the snapshot", 90);
    if (deps.snapshotName) {
      const save = await deps.exec(adb, ["-s", serial, "emu", "avd", "snapshot", "save", deps.snapshotName], { env: deps.env, signal, timeoutMs: 180_000 });
      if (save.exitCode !== 0 || /KO/.test(save.stdout)) throw new Error(`saving the ${deps.snapshotName} snapshot failed: ${lastLine(save) || `exit ${save.exitCode}`}`);
    }
    const how = await stopEmulator({ exec: deps.exec, adb, env: deps.env, serial, pid: qemu, pgid, graceMs: 180_000, executor: x });
    // A named snapshot is already saved: how the emulator stopped does not matter.
    if ((!deps.snapshotName && how !== "emu-kill") || !(await x.exists(goldenSnapshotFile(deps.avdHome, profile.id, deps.snapshotName)))) {
      throw new Error(`the snapshot was not saved (the emulator stopped by ${how}; see ${logPath})`);
    }
    deps.logger.info(`[devices] golden ${profile.id}: saved after ${Math.round((Date.now() - started) / 1000)} s in total`);
    saved = true;
  } finally {
    if (!saved && pid !== null) await stopEmulator({ exec: deps.exec, adb, env: deps.env, serial, pid, pgid, graceMs: 5_000, executor: x }).catch(() => undefined);
    else if (!saved && pgid !== null) await x.signal(pgid, pgid, "SIGKILL").catch(() => false);
    await deps.untrack(serial).catch(() => undefined);
    ports.release();
  }
}
