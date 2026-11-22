/**
 * An owner's Windows machine running Android emulators (tailnet machines spec §4.4 item 3): a
 * paired `windows` machine (its orq-agent reports `win32`) with Device simulators on. The shared
 * Android modules (`../../android/*`, `createAvd`) run there through the Windows executor
 * (`win32-executor.ts`); what is Windows-specific is in `win32-remote.ts`.
 *
 * Preparing ({@link BoxWindowsAndroidHost.prepare}; idempotent, reuses what runs):
 * 1. the PowerShell probe: the device root in the signed-in user's profile, WHPX (the feature on
 *    and the hypervisor running — else the host needs the owner, with the exact fix), memory, CPUs,
 *    disk, GPUs, desktop sessions; reattach to what `android-host.json` records;
 * 2. the pinned archives (Node, the Temurin JRE, platform-tools, the emulator with its
 *    `package.xml`, cmdline-tools, the x86_64 `google_apis` image), each checked by SHA-256 there;
 *    then `emulator -accel-check` must report WHPX usable;
 * 3. the pinned npm tools (the shipped lockfile, `npm ci --ignore-scripts` with the pinned Node),
 *    the scrcpy-server jar;
 * 4. the profiles' AVDs (1536 MB guest RAM) and the first profile's golden snapshot `orq-golden`,
 *    trying `-gpu host` in the desktop session (only with orq-agent's desktop-session helper),
 *    `-gpu angle_indirect` from the service session, then `swiftshader_indirect`; a hardware mode
 *    that fails or renders in software is remembered in `android-host.json` (`windowsGpuFailed`)
 *    for that GPU, driver and emulator;
 * 5. adb's server, the hub (`hub-launcher.mjs` uploaded, `--require-token`, its token read from its
 *    state file there) and the agent-device daemon, both forwarded here; agent-device on this machine.
 *
 * Leases boot read-only from `orq-golden` with its GPU mode — cold, with the best service-session
 * mode, when that mode needs a desktop session the box has none of now. Video goes through the
 * daemon's hub proxy (the direct stream gate does not run on Windows yet).
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import type { Readable } from "node:stream";

import {
  boxDeviceHostId,
  DEVICE_ERROR_CODES,
  DEVICE_PLATFORM_LABELS,
  deviceKey,
  deviceProfile,
  type DeviceCapacity,
  type DeviceHostBoxInfo,
  type DeviceHostReadiness,
  type DeviceProfile,
  type DeviceReadinessCheck,
  type DevicesSettings,
  type DeviceSummary,
  type MachineProblem
} from "@orquester/api";
import type { StoredBox, StoredDeviceLease } from "@orquester/config";

import type { BoxConnection, BoxHostForward } from "../../../boxes/contracts.ts";
import { DEVICE_TOOL_VERSIONS } from "../../../boxes/github/device-cache.ts";
import { AgentDeviceDaemon } from "../../android/agent-device-daemon.ts";
import { avdHardware, avdName } from "../../android/avd-config.ts";
import { allocateEmulatorPorts, findQemuPid, serialOf, signalLauncher, spawnEmulator, stopEmulator, verifyEmulator, waitForBootCompleted, type EmulatorLaunch } from "../../android/emulator.ts";
import { adbServerPort, androidLayoutAt, appdirMarker, type AndroidLayout } from "../../android/env.ts";
import { lastLine } from "../../android/exec.ts";
import type { DeviceExecutor } from "../../android/executor.ts";
import { createGoldenSnapshot, LEASE_BOOT_SCRIPT } from "../../android/golden.ts";
import { HUB_LAUNCHER, HubSupervisor } from "../../android/hub.ts";
import { delay, processMatches } from "../../android/procs.ts";
import { FIX_ACTIONS } from "../../android/readiness.ts";
import { emptyHostState, type EmulatorRecord, type HostStateFile, type HubRecord, parseHostState, planReattach, serializeHostState } from "../../android/state.ts";
import { DeviceError, isDeviceError } from "../../errors.ts";
import type { AgentDeviceCommand, DeviceBootRequest, DeviceBootResult, DeviceCommandResult, DeviceHost, DeviceHostProgress, DeviceHostState } from "../../host.ts";
import { adbPath, avdDir, clearGolden, createAvd, packageRevision, profileHash, readAvdMarker } from "../../toolchain/android-sdk.ts";
import type { DeviceToolchain } from "../../toolchain/index.ts";
import { NATIVE_PREBUILDS, NPM_CI_ARGS, SCRCPY_SERVER, scrcpyJarPath } from "../../toolchain/npm-tools.ts";
import { boxAgentDeviceConfigPath, removeAgentDeviceConfig } from "./agent-device-config.ts";
import { BOX_GOLDEN_MARKER, BOX_GOLDEN_SNAPSHOT, type BoxGolden, type BoxGoldenMarker, boxAvdState, boxGolden, screenOfConfig } from "./android-remote.ts";
import { ensureLocalAgentDevice, localAgentDeviceEntry } from "./local-agent-device.ts";
import { unreachableProblem } from "./problems.ts";
import { installedToolVersion, outputTail, writeBoxToolLocks } from "./remote.ts";
import type { MachineDeviceLoad } from "./shared-load.ts";
import { runPowerShell, windowsBoxExecutor } from "./win32-executor.ts";
import {
  buildWindowsAndroidEnv,
  hasWindowsAvdRam,
  parseWindowsProbe,
  patchWindowsAvdConfig,
  readGpuFailures,
  tryGpuModes,
  whpxProblem,
  whpxReady,
  WIN_INSTALL_ARCHIVE_SCRIPT,
  WIN_PROBE_SCRIPT,
  WINDOWS_ANDROID_ARTIFACTS,
  WINDOWS_EMULATOR_BYTES,
  WINDOWS_EMULATOR_PACKAGE_XML,
  WINDOWS_HOST_GPU_MODE,
  WINDOWS_TOOLCHAIN_DISK_BYTES,
  windowsAndroidCapacity,
  windowsArtifactZip,
  windowsCapacityBasis,
  windowsGpuPlan,
  windowsGpuSignature,
  windowsHostGpu,
  windowsLeaseLaunch,
  windowsNodePath,
  windowsNpmCli,
  windowsProbeProblems,
  windowsRendersInSoftware,
  type WindowsAndroidProbe,
  type WindowsArtifact,
  type WindowsGpuAttempt,
  type WindowsGpuFailures
} from "./win32-remote.ts";

const TIMING = {
  probeMs: 3 * 60_000,
  commandMs: 2 * 60_000,
  /** One archive: download (the system image is 1.7 GB), check, unpack. */
  artifactMs: 60 * 60_000,
  installMs: 20 * 60_000,
  bootMs: 6 * 60_000,
  goldenBootMs: 6 * 60_000,
  sampleMs: 30_000,
  agentCheckMs: 30_000,
  teardownWaitMs: 2 * 60_000
};

export interface BoxWindowsAndroidHostDeps {
  boxId: string;
  label: string;
  appDir: string;
  toolchain?: DeviceToolchain;
  record(): StoredBox | undefined;
  connection(): BoxConnection | undefined;
  settings(): DevicesSettings;
  activeLeases(): readonly StoredDeviceLease[];
  logger: Pick<Console, "info" | "warn" | "error">;
}

type Phase = "pending" | "preparing" | "ready" | "needs-setup" | "failed" | "stopped";

/** One at a time per key. */
class KeyedQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.tails.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}

/** The state file's key for the hardware GPU modes that failed (`WindowsGpuFailures`). */
const GPU_FAILED_KEY = "windowsGpuFailed";

export class BoxWindowsAndroidHost implements DeviceHost {
  readonly id: string;
  readonly kind = "byo" as const;
  readonly label: string;
  readonly platforms = ["android"] as const;

  private readonly events = new EventEmitter();
  private readonly x: DeviceExecutor;
  private phase: Phase = "pending";
  private detail: string | null = null;
  private working: string | null = null;
  private probe: WindowsAndroidProbe | null = null;
  private checkedAt: string | null = null;
  private preparing: Promise<void> | null = null;
  private readonly progressListeners = new Set<(progress: DeviceHostProgress) => void>();
  private layoutValue: AndroidLayout | null = null;
  private env: NodeJS.ProcessEnv | null = null;
  private hub: HubSupervisor | null = null;
  private hubRecord: HubRecord | null = null;
  private agent: AgentDeviceDaemon | null = null;
  private agentForward: BoxHostForward | null = null;
  private localCli: string | null = null;
  private toolVersions: { hub: string | null; agent: string | null } | null = null;
  /** What of the pinned toolchain is in place (artifact id → installed). */
  private installed = new Map<WindowsArtifact["id"], boolean>();
  /** The GPU mode the first profile's golden snapshot was made with (null: none yet). */
  private goldenGpu: string | null = null;
  private readonly emulators = new Map<string, EmulatorRecord>();
  private readonly viewers = new Map<string, number>();
  private readonly reserved = new Set<number>();
  private readonly queue = new KeyedQueue();
  private readonly inFlight = new Set<Promise<unknown>>();
  private stateExtra: HostStateFile["extra"] = {};
  private stateWrites: Promise<void> = Promise.resolve();
  private memAvailable: number | null = null;
  private sampledAt: string | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private tearingDown = false;
  private disposed = false;

  constructor(private readonly deps: BoxWindowsAndroidHostDeps) {
    this.id = boxDeviceHostId(deps.boxId);
    this.label = deps.label;
    this.x = windowsBoxExecutor(() => this.link(), { root: () => this.layoutValue?.devices ?? null });
  }

  get boxId(): string {
    return this.deps.boxId;
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  state(): DeviceHostState {
    if (!this.deps.settings().android.enabled) return { status: "disabled", detail: `${DEVICE_PLATFORM_LABELS.android} is off in Settings → Devices.` };
    const record = this.deps.record();
    if (!record || record.state === "destroyed" || record.state === "destroying" || record.state === "destroy-failed") return { status: "stopping", detail: "The machine is being removed." };
    if (record.state === "pairing") return { status: "needs-setup", detail: "Pair this machine first (Settings → Machines)." };
    if (!this.deps.connection()?.connected) return { status: "unreachable", detail: "Your Windows machine is offline (its orq-agent is not connected)." };
    switch (this.phase) {
      case "pending":
        return { status: "starting", detail: "Connecting to the machine…" };
      case "preparing":
        return { status: "starting", detail: this.detail ?? "Preparing the machine…" };
      case "ready": {
        const total = this.capacity().total;
        return { status: "ready", detail: `Up to ${total} Android device${total === 1 ? "" : "s"} at once.` };
      }
      case "needs-setup":
        return { status: "needs-setup", detail: this.detail };
      case "stopped":
        return { status: "needs-setup", detail: "Idle: its device helpers start again when a device is opened." };
      case "failed":
        return { status: "failed", detail: this.detail };
    }
  }

  readiness(): DeviceHostReadiness {
    const checks = this.checks();
    return { ready: checks.every((check) => check.state === "ok"), checks, checkedAt: this.checkedAt };
  }

  async refreshReadiness(signal?: AbortSignal): Promise<DeviceHostReadiness> {
    if (this.deps.connection()?.connected && this.phase !== "preparing") {
      try {
        await this.probeBox(signal);
        if (this.layoutValue) await this.refreshInstalled();
        if (this.agent && !(await this.agent.check())) await this.agent.ensure(signal).catch(() => undefined);
      } catch (error) {
        this.deps.logger.warn(`[devices] probing ${this.id} failed`, errorText(error));
      }
      this.checkedAt = new Date().toISOString();
      this.emitChange();
    }
    return this.readiness();
  }

  capacity(): DeviceCapacity {
    const used = this.leasedCount();
    if (!this.deps.settings().android.enabled || !this.probe) return { used, total: 0 };
    return { used, total: this.capacityTotal(), basis: windowsCapacityBasis(this.probe, this.memAvailable, this.sampledAt ?? new Date().toISOString()) };
  }

  private capacityTotal(): number {
    if (!this.probe || !whpxReady(this.probe)) return 0;
    const running = [...this.emulators.values()].filter((record) => !record.golden).length;
    return windowsAndroidCapacity({ cpus: this.probe.cpus, freeMemBytes: this.memAvailable ?? this.probe.freeMemBytes, running, freeDiskBytes: this.probe.diskFreeBytes });
  }

  /** What this host's emulators hold of the machine now (its machine has no other device host). */
  deviceLoad(): MachineDeviceLoad {
    const devices = Math.max(this.deps.activeLeases().length, this.leasedCount());
    return { devices, bytes: devices * WINDOWS_EMULATOR_BYTES };
  }

  siblingChanged(): void {
    this.emitChange();
  }

  problems(): MachineProblem[] {
    const machine = this.machineName();
    if (!this.deps.connection()?.connected && this.deps.record()?.state === "ready") return [unreachableProblem(machine, "linux")];
    return this.probe ? windowsProbeProblems(this.probe, { machine, desktopSession: this.desktopSession(), goldenGpu: this.goldenGpu }) : [];
  }

  box(): DeviceHostBoxInfo | null {
    const record = this.deps.record();
    if (!record) return null;
    return { boxId: record.id, provider: record.provider, hourlyUsd: 0, startedAt: record.readyAt ?? record.createdAt, deadlineAt: null };
  }

  pool(): null {
    return null;
  }

  hubOrigin(): string | null {
    return this.hub?.origin() ?? null;
  }

  hubToken(): string | null {
    return this.hub?.token() ?? null;
  }

  streamCapabilities(): { iosH264: boolean } {
    return { iosH264: false };
  }

  viewerActive(): void {
    this.hub?.noteViewer();
  }

  viewersChanged(deviceId: string, count: number): void {
    if (count > 0) this.viewers.set(deviceId, count);
    else this.viewers.delete(deviceId);
    this.hub?.setViewers([...this.viewers.values()].reduce((sum, n) => sum + n, 0));
  }

  agentDeviceConfigPath(): string | null {
    return this.agent?.configPath() ?? null;
  }

  agentDeviceCommand(): AgentDeviceCommand {
    const entry = this.localCli ?? localAgentDeviceEntry(this.deps.appDir, this.deps.toolchain);
    if (!entry) throw new DeviceError("UNAVAILABLE", `agent-device is not installed on this machine yet; it installs when ${this.label} is prepared. Try again shortly.`);
    this.localCli = entry;
    return { command: process.execPath, args: [entry], env: {} };
  }

  isReady(): boolean {
    return this.phase === "ready" && this.deps.connection()?.connected === true;
  }

  // -------------------------------------------------------------------------
  // Preparing
  // -------------------------------------------------------------------------

  async ensureReady(signal: AbortSignal, onProgress: (progress: DeviceHostProgress) => void): Promise<void> {
    const link = this.deps.connection();
    if (!link?.connected) throw new DeviceError(DEVICE_ERROR_CODES.PLATFORM_NOT_READY, `${this.label} is not connected: start orq-agent on it.`);
    await this.prepare(link, signal, onProgress);
  }

  prepare(_link: BoxConnection, signal: AbortSignal, onProgress?: (progress: DeviceHostProgress) => void): Promise<void> {
    if (onProgress) this.progressListeners.add(onProgress);
    const run =
      this.preparing ??
      (this.preparing = this.runPrepare(signal).finally(() => {
        this.preparing = null;
        this.progressListeners.clear();
      }));
    return onProgress ? run.finally(() => this.progressListeners.delete(onProgress)) : run;
  }

  private async runPrepare(signal: AbortSignal): Promise<void> {
    this.setPhase("preparing", "Checking the machine…");
    try {
      this.working = "whpx";
      this.step("whpx", "Checking the machine", "running", 2);
      let probe = await this.probeBox(signal);
      this.requireBasics(probe);
      const layout = this.layout();
      this.step("whpx", "Checking the machine", "done", 5, `WHPX on, ${probe.cpus} CPUs, ${gib(probe.freeMemBytes)} free`);
      for (const dir of [layout.devices, layout.tmp, layout.home, layout.androidUser, layout.logs, layout.uploads, layout.hubState, layout.downloads, layout.npmCache, layout.agentDeviceState, layout.agentDeviceHome, layout.agentDeviceClaims, layout.runtime]) await this.x.mkdir(dir);
      await this.reattach();

      await this.refreshInstalled();
      const missing = WINDOWS_ANDROID_ARTIFACTS.filter((artifact) => !this.installed.get(artifact.id));
      if (missing.length > 0 && probe.diskFreeBytes !== null && probe.diskFreeBytes < WINDOWS_TOOLCHAIN_DISK_BYTES) {
        this.working = "disk";
        throw new DeviceError(DEVICE_ERROR_CODES.PLATFORM_NOT_READY, `${this.label} needs about ${gib(WINDOWS_TOOLCHAIN_DISK_BYTES)} free on its system drive for the Android tools (it has ${gib(probe.diskFreeBytes)}): free some space there, then try again.`);
      }
      for (const [index, artifact] of missing.entries()) await this.installArtifact(artifact, signal, 6 + Math.round((index / missing.length) * 40));
      if (missing.some((artifact) => artifact.id === "emulator")) {
        // The emulator's own WHPX check, now that it is there.
        probe = await this.probeBox(signal);
        this.requireBasics(probe);
      }

      if (!this.toolsCurrent()) await this.installTools(signal);
      else this.step("tools", "Device tools", "skipped", 50, "Already installed");
      if (!(await this.x.exists(scrcpyJarPath(layout.tools)))) {
        await this.x.download(SCRCPY_SERVER, scrcpyJarPath(layout.tools), { signal }).catch((error) => this.deps.logger.warn(`[devices] seeding scrcpy-server on ${this.id} failed (the hub fetches it on first stream)`, errorText(error)));
      }

      await this.ensureAvds(signal);
      const first = this.profiles()[0];
      if (first) {
        this.working = "golden";
        this.step("golden", `Preparing ${first.label} for first use`, "running", 60);
        const golden = await this.ensureGolden(first, signal, (progress) => this.emitProgress({ ...progress, step: "golden", percent: 60 }));
        this.step("golden", `Preparing ${first.label} for first use`, "done", 80, golden ? `${golden.source === "cache" ? "From the cache" : "Made here"} (GPU ${golden.gpu})` : "Later");
      }

      this.working = "hub";
      this.step("hub", "Starting the device hub", "running", 82);
      this.setDetail("Starting the device hub…");
      await this.x.exec(adbPath(layout.sdk), ["start-server"], { env: this.env!, timeoutMs: 60_000 });
      await this.ensureHub();
      this.step("hub", "Starting the device hub", "done", 88);

      this.working = "agent-device";
      this.step("agent-device", "Starting agent-device", "running", 90);
      this.setDetail("Starting agent-device…");
      await this.ensureAgentDevice(signal);
      this.step("agent-device", "Starting agent-device", "done", 94);

      this.working = "tool:agent-device-local";
      this.step("tool:agent-device-local", "agent-device on this machine", "running", 95);
      this.localCli = await ensureLocalAgentDevice({ appDir: this.deps.appDir, ...(this.deps.toolchain ? { toolchain: this.deps.toolchain } : {}), signal }).catch((error: unknown) => {
        throw new DeviceError(DEVICE_ERROR_CODES.PLATFORM_NOT_READY, `Installing agent-device on this machine failed: ${errorText(error)}`);
      });
      this.step("tool:agent-device-local", "agent-device on this machine", "done", 98);

      this.working = null;
      await this.sample();
      this.startTimers();
      this.checkedAt = new Date().toISOString();
      this.setPhase("ready", null);
      this.emitProgress({ step: "ready", label: "Ready", state: "done", percent: 100 });
    } catch (error) {
      const failedCheck = this.working;
      this.working = null;
      this.checkedAt = new Date().toISOString();
      if (signal.aborted) {
        this.setPhase("needs-setup", "Preparing the machine was cancelled.");
        throw error;
      }
      const message = isDeviceError(error) ? error.message : `Preparing ${this.label} failed: ${errorText(error)}`;
      if (failedCheck) this.emitProgress({ step: failedCheck, label: failedCheck, state: "failed", detail: message });
      this.deps.logger.warn(`[devices] preparing ${this.id} failed: ${message}`);
      // WHPX and the profile are the owner's to fix: needs setup; anything else may be retried.
      this.setPhase(failedCheck !== null ? "needs-setup" : "failed", message);
      throw isDeviceError(error) ? error : new DeviceError(DEVICE_ERROR_CODES.PLATFORM_NOT_READY, message);
    }
  }

  /** What the owner must fix before anything is installed: a user profile for the device root, and WHPX. */
  private requireBasics(probe: WindowsAndroidProbe): void {
    const notReady = (message: string) => new DeviceError(DEVICE_ERROR_CODES.PLATFORM_NOT_READY, message);
    if (!probe.root) throw notReady(`${this.label} has no user profile to keep the Android tools in: sign in to it once with the account that will use it, then try again.`);
    const whpx = whpxProblem(probe, this.machineName());
    if (whpx) throw notReady(`${whpx.message} ${whpx.fix ?? ""}`.trim());
  }

  private async probeBox(signal?: AbortSignal): Promise<WindowsAndroidProbe> {
    const value = await runPowerShell(() => this.link(), WIN_PROBE_SCRIPT, { timeoutMs: TIMING.probeMs, ...(signal ? { signal } : {}) });
    const probe = parseWindowsProbe(JSON.stringify(value));
    const before = this.probe === null ? null : JSON.stringify(this.problems());
    this.probe = probe;
    this.sampledAt = new Date().toISOString();
    if (probe.freeMemBytes !== null) this.memAvailable = probe.freeMemBytes;
    if (!this.layoutValue && probe.root) this.layoutValue = androidLayoutAt(probe.root);
    if (this.layoutValue) {
      this.env = buildWindowsAndroidEnv(this.layoutValue, probe, { root: this.layoutValue.devices, adbPort: adbServerPort(this.layoutValue.devices) });
      await this.readToolVersions();
    }
    if (before !== null && before !== JSON.stringify(this.problems())) this.emitChange();
    return probe;
  }

  /** Which pinned archives are in place (their pin file and marker file). */
  private async refreshInstalled(): Promise<void> {
    const root = this.layout().devices;
    for (const artifact of WINDOWS_ANDROID_ARTIFACTS) {
      const dest = posix.join(root, artifact.dest);
      const pin = ((await this.x.readText(posix.join(dest, ".orq-pin"))) ?? "").trim().toLowerCase();
      let ok = pin === artifact.sha256 && (await this.x.exists(posix.join(dest, artifact.check)));
      if (ok && artifact.id === "emulator") ok = await this.x.exists(posix.join(dest, "package.xml"));
      this.installed.set(artifact.id, ok);
    }
  }

  private async installArtifact(artifact: WindowsArtifact, signal: AbortSignal, percent: number): Promise<void> {
    const layout = this.layout();
    const step = `win:${artifact.id}`;
    const label = `Installing ${artifact.label} ${artifact.version}`;
    this.working = step;
    this.step(step, label, "running", percent, artifact.size ? `${Math.round(artifact.size / 1e6)} MB` : undefined);
    this.setDetail(`${label}…`);
    const dest = posix.join(layout.devices, artifact.dest);
    const value = await runPowerShell(() => this.link(), WIN_INSTALL_ARCHIVE_SCRIPT, {
      env: { ORQ_URL: artifact.url, ORQ_SHA256: artifact.sha256, ORQ_ZIP: windowsArtifactZip(layout, artifact), ORQ_DEST: dest, ORQ_INNER: artifact.inner, ORQ_CHECK: artifact.check.replace(/\//g, "\\") },
      timeoutMs: TIMING.artifactMs,
      signal
    });
    if (value.ok !== true) throw new DeviceError(DEVICE_ERROR_CODES.PLATFORM_NOT_READY, `${label} on ${this.label} failed: ${typeof value.error === "string" ? value.error : "no reason given"}`);
    if (artifact.id === "emulator") await this.x.writeText(posix.join(dest, "package.xml"), WINDOWS_EMULATOR_PACKAGE_XML);
    this.installed.set(artifact.id, true);
    this.step(step, label, "done", percent, value.cached === true ? "Already there" : undefined);
  }

  /** The pinned npm tools: the shipped lockfile, `npm ci --ignore-scripts` with the pinned Node, then the native prebuilds. */
  private async installTools(signal: AbortSignal): Promise<void> {
    const layout = this.layout();
    const root = layout.devices;
    this.working = "tools";
    const label = "Installing the device tools";
    this.step("tools", label, "running", 48);
    this.setDetail(`${label}…`);
    await writeBoxToolLocks(this.link(), layout.tools);
    const node = windowsNodePath(root);
    const onLine = (line: string) => this.emitProgress({ step: "tools", label, state: "running", logLine: line });
    const result = await this.x.exec(node, [windowsNpmCli(root), ...NPM_CI_ARGS], { env: this.env!, cwd: layout.tools, signal, timeoutMs: TIMING.installMs, onLine });
    if (result.exitCode === 0) {
      for (const [pkg, step] of Object.entries(NATIVE_PREBUILDS)) {
        const dir = posix.join(layout.tools, pkg);
        if (!(await this.x.exists(dir))) continue;
        const built = await this.x.exec(node, [posix.join(layout.tools, step.script), ...step.args], { env: this.env!, cwd: dir, signal, timeoutMs: TIMING.installMs, onLine });
        if (built.exitCode !== 0) onLine(`warning: the prebuilt binary of ${pkg.replace("node_modules/", "")} was not installed (${lastLine(built) || `exit ${built.exitCode}`}); the hub fetches it when WebRTC is first used.`);
      }
    }
    await this.readToolVersions();
    if (result.exitCode !== 0 || !this.toolsCurrent()) {
      throw new DeviceError(DEVICE_ERROR_CODES.PLATFORM_NOT_READY, `${label} on ${this.label} failed: ${outputTail(result.stderr || result.stdout) || `exit ${result.exitCode}`}`);
    }
    this.step("tools", label, "done", 50);
  }

  private async readToolVersions(): Promise<void> {
    const tools = this.layout().tools;
    const read = async (name: string) => installedToolVersion(await this.x.readText(posix.join(tools, "node_modules", name, "package.json")));
    const [hub, agent] = await Promise.all([read("expo-device-hub"), read("agent-device")]);
    this.toolVersions = { hub, agent };
  }

  private toolsCurrent(): boolean {
    return this.toolVersions?.hub === DEVICE_TOOL_VERSIONS["expo-device-hub"] && this.toolVersions?.agent === DEVICE_TOOL_VERSIONS["agent-device"];
  }

  /** An AVD for every configured profile, with the Windows guest RAM (outdated ones made again while none of their instances runs). */
  private async ensureAvds(signal: AbortSignal): Promise<void> {
    for (const profile of this.profiles()) {
      const state = await this.avdUsable(profile);
      if (state === "usable" || (state === "outdated" && this.instancesOf(profile.id) > 0)) continue;
      this.working = "avds";
      this.step("avds", `Creating the ${profile.label} emulator`, "running", 52);
      await this.queue.run(profile.id, () => this.createAvd(profile, signal));
      this.step("avds", `Creating the ${profile.label} emulator`, "done", 58);
    }
  }

  /** The AVD is current (its marker names this config) and has the Windows guest RAM. */
  private async avdUsable(profile: DeviceProfile): Promise<"usable" | "outdated" | "missing"> {
    const layout = this.layout();
    const state = await boxAvdState(this.x, layout.avd, profile);
    if (state === "missing") return "missing";
    if (state === "outdated") return "outdated";
    const config = (await this.x.readText(posix.join(avdDir(layout.avd, profile.id), "config.ini"))) ?? "";
    return hasWindowsAvdRam(config) ? "usable" : "outdated";
  }

  private async createAvd(profile: DeviceProfile, signal: AbortSignal): Promise<void> {
    const layout = this.layout();
    await createAvd({ sdk: layout.sdk, avd: layout.avd }, profile, { exec: this.x.exec, env: this.env!, executor: this.x }, signal);
    const configPath = posix.join(avdDir(layout.avd, profile.id), "config.ini");
    await this.x.writeText(configPath, patchWindowsAvdConfig((await this.x.readText(configPath)) ?? ""));
  }

  private async emulatorRevision(): Promise<string | null> {
    return packageRevision(this.layout().sdk, "emulator", this.x);
  }

  private desktopSession(): boolean {
    return this.deps.connection()?.capabilities?.includes("desktop-session") === true;
  }

  /** The modes a golden made now tries, best first. */
  private async gpuPlan(): Promise<WindowsGpuAttempt[]> {
    return windowsGpuPlan({ desktopSession: this.desktopSession(), gpu: this.probe ? windowsHostGpu(this.probe.gpus) : null, failed: readGpuFailures(this.stateExtra[GPU_FAILED_KEY]), emulatorRevision: await this.emulatorRevision() });
  }

  /** The profile's usable golden snapshot, made here when missing; null when it cannot be made now (instances of an older AVD run). */
  private ensureGolden(profile: DeviceProfile, signal: AbortSignal, onProgress: (progress: DeviceHostProgress) => void): Promise<BoxGolden | null> {
    return this.queue.run(profile.id, async () => {
      const layout = this.layout();
      const usable = await this.avdUsable(profile);
      if (usable !== "usable") {
        if (this.instancesOf(profile.id) > 0) return null;
        onProgress({ step: "prepare-device", label: `Creating the ${profile.label} emulator`, state: "running" });
        await this.createAvd(profile, signal);
      }
      const revision = await this.emulatorRevision();
      const found = await boxGolden(this.x, layout.avd, profile, await boxAvdState(this.x, layout.avd, profile), revision);
      if (found) {
        if (profile.id === this.profiles()[0]?.id) this.goldenGpu = found.gpu;
        return found;
      }
      if (this.instancesOf(profile.id) > 0) return null;
      const deviceDensity = (await readAvdMarker(layout.avd, profile.id, this.x))?.deviceDensity;
      const gpu = this.probe ? windowsHostGpu(this.probe.gpus) : null;
      const worked = await tryGpuModes(
        await this.gpuPlan(),
        async (attempt) => {
          await clearGolden(layout.avd, profile.id, this.x);
          await createGoldenSnapshot(
            profile,
            {
              exec: this.x.exec,
              sdk: layout.sdk,
              avdHome: layout.avd,
              logs: layout.logs,
              env: this.env!,
              kvm: "direct",
              reservePorts: () => this.reservePorts(),
              track: async (record) => {
                this.emulators.set(record.serial, { ...record, profile: profile.id, avd: avdName(profile.id), leaseId: null, golden: true, startedAt: new Date().toISOString() });
                await this.persistState();
              },
              untrack: async (serial) => {
                this.emulators.delete(serial);
                await this.persistState();
              },
              helperApks: await this.helperApks(),
              logger: this.deps.logger,
              marker: this.marker(),
              executor: this.x,
              gpu: attempt.gpu,
              snapshotName: BOX_GOLDEN_SNAPSHOT,
              bootTimeoutMs: TIMING.goldenBootMs,
              density: avdHardware(profile).density,
              ...(deviceDensity ? { cutoutDensity: deviceDensity } : {}),
              ...(attempt.hardware ? { checkRender: (serial: string, renderSignal: AbortSignal) => this.checkHardwareRender(serial, renderSignal, attempt.gpu) } : {})
            },
            signal,
            onProgress
          );
        },
        async (attempt, failed) => {
          if (attempt.gpu === "swiftshader_indirect") return;
          await this.rememberGpu(attempt.gpu, failed && gpu ? windowsGpuSignature(gpu, revision) : null);
          if (failed) this.deps.logger.warn(`[devices] golden ${profile.id} on ${this.id}: -gpu ${attempt.gpu} (${attempt.session} session) failed; it is skipped for this GPU and emulator`);
        },
        signal
      );
      const marker: BoxGoldenMarker = { snapshot: BOX_GOLDEN_SNAPSHOT, gpu: worked.gpu, configHash: profileHash(profile), emulatorRevision: revision, createdAt: new Date().toISOString() };
      await this.x.writeText(posix.join(avdDir(layout.avd, profile.id), BOX_GOLDEN_MARKER), `${JSON.stringify(marker)}\n`);
      if (profile.id === this.profiles()[0]?.id) this.goldenGpu = worked.gpu;
      this.deps.logger.info(`[devices] golden ${profile.id} on ${this.id}: made with -gpu ${worked.gpu} (${worked.session} session)`);
      this.emitChange();
      return { snapshot: BOX_GOLDEN_SNAPSHOT, gpu: worked.gpu, source: "built" as const };
    });
  }

  /** A hardware mode must render on the GPU: the emulator falls back to a software rasterizer (SwiftShader, Microsoft's WARP) silently. */
  private async checkHardwareRender(serial: string, signal: AbortSignal, gpu: string): Promise<void> {
    const dump = await this.x.exec(adbPath(this.layout().sdk), ["-s", serial, "shell", "dumpsys SurfaceFlinger"], { env: this.env!, signal, timeoutMs: 30_000 });
    // The emulator's stdout and stderr logs (Start-Process keeps them apart).
    const logPath = this.emulators.get(serial)?.logPath;
    const log = logPath ? `${(await this.x.readText(logPath)) ?? ""}\n${(await this.x.readText(`${logPath}.err`)) ?? ""}` : "";
    if (windowsRendersInSoftware(dump.exitCode === 0 ? dump.stdout : "", log) === true) throw new Error(`-gpu ${gpu} rendered in software (the emulator did not reach this GPU)`);
  }

  /** Remember (with a signature) or forget (null) a hardware mode's failure, in the machine's state file. */
  private async rememberGpu(mode: string, signature: string | null): Promise<void> {
    const failures: WindowsGpuFailures = readGpuFailures(this.stateExtra[GPU_FAILED_KEY]);
    const key = mode as keyof WindowsGpuFailures;
    if ((failures[key] ?? null) === signature) return;
    if (signature === null) delete failures[key];
    else failures[key] = signature;
    if (Object.keys(failures).length === 0) delete this.stateExtra[GPU_FAILED_KEY];
    else this.stateExtra[GPU_FAILED_KEY] = failures;
    await this.persistState();
  }

  private async helperApks(): Promise<string[]> {
    const pkg = posix.join(this.layout().tools, "node_modules", "agent-device", "android");
    const apks: string[] = [];
    for (const helper of ["snapshot-helper", "ime-helper"]) {
      const dir = posix.join(pkg, helper, "dist");
      for (const file of await this.x.list(dir).catch(() => [] as string[])) if (file.endsWith(".apk")) apks.push(posix.join(dir, file));
    }
    return apks;
  }

  private async ensureHub(): Promise<void> {
    const layout = this.layout();
    const launcher = posix.join(layout.devices, "hub-launcher.mjs");
    const text = readFileSync(HUB_LAUNCHER, "utf8");
    if ((await this.x.readText(launcher)) !== text) await this.x.writeText(launcher, text);
    this.hub ??= new HubSupervisor({
      nodePath: windowsNodePath(layout.devices),
      cli: () => posix.join(layout.tools, "node_modules", "expo-device-hub", "dist", "server", "cli.mjs"),
      env: this.env!,
      hubStateDir: layout.hubState,
      logPath: posix.join(layout.logs, "hub.log"),
      marker: this.marker(),
      persist: async (record) => {
        this.hubRecord = record;
        await this.persistState();
      },
      onChange: () => this.emitChange(),
      logger: this.deps.logger,
      executor: this.x,
      launcher,
      endpoint: async (port) => {
        const forward = await this.link().forwardToHost(port);
        return { origin: `http://127.0.0.1:${forward.hostPort}`, close: () => forward.close() };
      }
    });
    if (this.hub.status() === "running") return;
    if (this.hubRecord && (await this.hub.attach(this.hubRecord))) return;
    await this.hub.start();
  }

  private async ensureAgentDevice(signal: AbortSignal): Promise<void> {
    const layout = this.layout();
    this.agent ??= new AgentDeviceDaemon({
      exec: this.x.exec,
      nodePath: windowsNodePath(layout.devices),
      entry: () => posix.join(layout.tools, "node_modules", "agent-device", "bin", "agent-device.mjs"),
      env: this.env!,
      stateDir: layout.agentDeviceState,
      configPath: boxAgentDeviceConfigPath(this.deps.appDir, this.id),
      logger: this.deps.logger,
      executor: this.x,
      endpoint: async (port) => {
        await this.agentForward?.close().catch(() => undefined);
        this.agentForward = await this.link().forwardToHost(port);
        return `http://127.0.0.1:${this.agentForward.hostPort}`;
      }
    });
    await this.agent.ensure(signal);
  }

  /** Reattach to what the state file records: keep what a live lease holds, stop the rest. */
  private async reattach(): Promise<void> {
    const layout = this.layout();
    const state = parseHostState((await this.x.readText(layout.stateFile)) ?? "");
    this.stateExtra = state.extra;
    const marker = this.marker();
    const ours = new Set<number>();
    for (const emulator of state.emulators) if (await verifyEmulator(this.x, emulator.pid, marker, emulator.startTicks)) ours.add(emulator.pid);
    const launcher = posix.join(layout.devices, "hub-launcher.mjs");
    if (state.hub && (await processMatches(state.hub.pid, marker, [launcher], this.x))) ours.add(state.hub.pid);
    const live = new Set(this.deps.activeLeases().map((lease) => lease.id));
    const plan = planReattach(state, ours, live);
    for (const emulator of plan.keep) if (!this.emulators.has(emulator.serial)) this.emulators.set(emulator.serial, emulator);
    for (const emulator of plan.forget) this.emulators.delete(emulator.serial);
    if (plan.keep.length > 0) this.deps.logger.info(`[devices] ${this.id}: reattached to ${plan.keep.length} running emulator(s)`);
    if (this.hub?.status() !== "running") this.hubRecord = plan.hub === "reattach" ? state.hub : null;
    await this.persistState();
    for (const emulator of plan.reap) {
      this.deps.logger.info(`[devices] ${this.id}: stopping ${emulator.serial} (${emulator.profile}): no lease holds it`);
      await this.stopRecord(emulator).catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // Devices
  // -------------------------------------------------------------------------

  async listDevices(): Promise<DeviceSummary[]> {
    const devices: DeviceSummary[] = [];
    if (this.layoutValue && this.deps.connection()?.connected) {
      for (const profile of this.profiles()) {
        if ((await boxAvdState(this.x, this.layoutValue.avd, profile)) === "missing") continue;
        const name = avdName(profile.id);
        devices.push({ key: deviceKey(this.id, name), hostId: this.id, id: name, platform: "android", name: profile.label, osVersion: profile.os, profile: profile.id, booted: false, leaseId: null });
      }
    }
    for (const record of this.emulators.values()) {
      if (record.golden) continue;
      const profile = deviceProfile(record.profile);
      devices.push({ key: deviceKey(this.id, record.serial), hostId: this.id, id: record.serial, platform: "android", name: profile?.label ?? record.avd, osVersion: profile?.os ?? "Android", profile: record.profile, booted: true, leaseId: record.leaseId });
    }
    return devices;
  }

  boot(request: DeviceBootRequest, signal: AbortSignal, onProgress?: (progress: DeviceHostProgress) => void): Promise<DeviceBootResult> {
    if (this.tearingDown) return Promise.reject(new DeviceError("UNAVAILABLE", `${this.label} is being turned off.`));
    const run = this.bootNow(request, signal, onProgress);
    this.inFlight.add(run);
    void run.then(
      () => this.inFlight.delete(run),
      () => this.inFlight.delete(run)
    );
    return run;
  }

  private async bootNow(request: DeviceBootRequest, signal: AbortSignal, onProgress?: (progress: DeviceHostProgress) => void): Promise<DeviceBootResult> {
    const progress = (step: string, label: string) => onProgress?.({ step, label, state: "running" });
    const profile = request.profile;
    if (profile.platform !== "android") throw new DeviceError("INVALID_ARGUMENT", `${this.label} runs Android emulators: ${profile.label} is not one.`);
    this.requireReady();
    if (request.deviceId !== undefined) return this.attachExisting(request);
    this.requireRoom();
    let golden: BoxGolden | null;
    try {
      progress("prepare-device", `Preparing ${profile.label}`);
      golden = await this.ensureGolden(profile, signal, (p) => onProgress?.({ ...p, step: "prepare-device" }));
    } catch (error) {
      if (signal.aborted) throw new DeviceError("CANCELLED", "The device was released before it finished starting.");
      if (isDeviceError(error)) throw error;
      this.deps.logger.warn(`[devices] preparing ${profile.id} on ${this.id} failed: ${errorText(error)}`);
      throw new DeviceError("UNAVAILABLE", `Preparing ${profile.label} for first use failed. Try again; if it keeps failing, ask the owner to check Settings → Devices (the daemon log has the details).`);
    }
    signal.throwIfAborted();
    progress("start-device", `Starting ${profile.label}`);
    const launch = windowsLeaseLaunch(golden, await this.gpuPlan(), this.desktopSession());
    let record: EmulatorRecord;
    try {
      try {
        record = await this.launch(profile, request.leaseId, launch, signal, progress);
      } catch (error) {
        if (signal.aborted || !launch.snapshot || isDeviceError(error)) throw error;
        // The snapshot did not load (another emulator build, a broken restore): boot it cold.
        this.deps.logger.warn(`[devices] ${profile.id} on ${this.id} did not boot from ${launch.snapshot} (${errorText(error)}); booting it cold`);
        progress("start-device", `Starting ${profile.label} (cold boot)`);
        record = await this.launch(profile, request.leaseId, { gpu: launch.gpu, coldBoot: true }, signal, progress);
      }
    } catch (error) {
      if (signal.aborted) throw new DeviceError("CANCELLED", "The device was released before it finished starting.");
      if (isDeviceError(error)) throw error;
      this.deps.logger.warn(`[devices] ${profile.id} on ${this.id} did not boot: ${errorText(error)}`);
      throw new DeviceError("UNAVAILABLE", `${profile.label} did not start. Try opening it again; if it keeps failing, ask the owner to check Settings → Devices (the daemon log has the details).`);
    }
    const screen = screenOfConfig((await this.x.readText(posix.join(avdDir(this.layout().avd, profile.id), "config.ini"))) ?? "");
    return { deviceId: record.serial, name: profile.label, osVersion: profile.os, ...(screen ? { screen } : {}), stream: { kind: "serve-emu", deviceParam: record.serial } };
  }

  /** One emulator launch to `sys.boot_completed`; on failure nothing of it keeps running. */
  private async launch(profile: DeviceProfile, leaseId: string, launch: Pick<EmulatorLaunch, "gpu" | "snapshot" | "coldBoot">, signal: AbortSignal, progress: (step: string, label: string) => void): Promise<EmulatorRecord> {
    const layout = this.layout();
    const env = this.env!;
    const marker = this.marker();
    const ports = await this.reservePorts(true);
    const serial = serialOf(ports.consolePort);
    const logPath = posix.join(layout.logs, `${serial}.log`);
    let record: EmulatorRecord | null = null;
    let pgid: number | null = null;
    try {
      await this.x.remove(logPath);
      pgid = (await spawnEmulator({ sdk: layout.sdk, env, kvm: "direct", launch: { avd: avdName(profile.id), consolePort: ports.consolePort, grpcPort: ports.grpcPort, ...launch }, logPath, executor: this.x })).pgid;
      let pid: number | null = null;
      for (let tries = 0; tries < 100 && pid === null; tries++) {
        pid = await findQemuPid(pgid, this.x);
        if (pid === null) {
          if (!(await this.x.procStat(pgid))) break;
          await delay(500, signal);
        }
      }
      if (pid === null) throw new Error(`the emulator exited at start (log: ${logPath})`);
      const startTicks = (await this.x.procStat(pid))?.startTicks;
      record = {
        serial,
        pid,
        pgid,
        ...(startTicks !== undefined ? { startTicks } : {}),
        consolePort: ports.consolePort,
        grpcPort: ports.grpcPort,
        profile: profile.id,
        avd: avdName(profile.id),
        leaseId,
        golden: false,
        startedAt: new Date().toISOString(),
        logPath
      };
      this.emulators.set(serial, record);
      ports.release();
      await this.persistState();
      this.emitChange();
      progress("wait-boot", `Waiting for ${profile.label} to boot`);
      const qemu = pid;
      const identity = startTicks ?? null;
      await waitForBootCompleted({ exec: this.x.exec, adb: adbPath(layout.sdk), env, serial, alive: async () => (await verifyEmulator(this.x, qemu, marker, identity)) !== null, signal, timeoutMs: TIMING.bootMs, pollMs: 1_000 });
      await this.x.exec(adbPath(layout.sdk), ["-s", serial, "shell", LEASE_BOOT_SCRIPT], { env, timeoutMs: 30_000 });
      return record;
    } catch (error) {
      ports.release();
      if (record) await this.stopRecord(record).catch(() => undefined);
      else if (pgid !== null) await signalLauncher(this.x, pgid, marker, "SIGKILL").catch(() => false);
      this.emitChange();
      throw error;
    }
  }

  private attachExisting(request: DeviceBootRequest): DeviceBootResult {
    const record = this.emulators.get(request.deviceId!);
    if (!record || record.golden || (record.leaseId !== null && record.leaseId !== request.leaseId) || request.fresh) {
      throw new DeviceError(DEVICE_ERROR_CODES.DEVICE_NOT_FOUND, `${request.deviceId} is not a free emulator on ${this.label}. Open a new device instead.`);
    }
    record.leaseId = request.leaseId;
    void this.persistState();
    this.emitChange();
    const profile = deviceProfile(record.profile);
    return { deviceId: record.serial, name: profile?.label ?? record.avd, osVersion: profile?.os ?? "Android", stream: { kind: "serve-emu", deviceParam: record.serial } };
  }

  async shutdown(deviceId: string): Promise<void> {
    const record = this.emulators.get(deviceId);
    if (record) await this.stopRecord(record);
  }

  async release(lease: StoredDeviceLease): Promise<void> {
    if (lease.deviceId === null || !this.deps.connection()?.connected) return;
    const record = this.emulators.get(lease.deviceId);
    if (!record || record.golden || record.leaseId !== lease.id) return;
    await this.stopRecord(record);
  }

  private async stopRecord(record: EmulatorRecord): Promise<void> {
    const layout = this.layout();
    const how = await stopEmulator({ exec: this.x.exec, adb: adbPath(layout.sdk), env: this.env!, serial: record.serial, pid: record.pid, pgid: record.pgid, marker: this.marker(), startTicks: record.startTicks ?? null, executor: this.x });
    if (how === "sigkill") this.deps.logger.warn(`[devices] ${record.serial} on ${this.id} needed a forced stop`);
    if (this.emulators.get(record.serial) === record) this.emulators.delete(record.serial);
    if (this.viewers.delete(record.serial)) this.hub?.setViewers([...this.viewers.values()].reduce((sum, n) => sum + n, 0));
    await this.persistState();
    this.emitChange();
  }

  async run(command: "simctl" | "adb", args: readonly string[], options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<DeviceCommandResult> {
    if (command !== "adb") throw new DeviceError("INVALID_ARGUMENT", `${this.label} runs Android emulators: there is no ${command} there.`);
    this.requireLink();
    if (!this.layoutValue || !this.env) throw new DeviceError(DEVICE_ERROR_CODES.PLATFORM_NOT_READY, `${this.label} is not ready yet.`);
    const result = await this.x.exec(adbPath(this.layoutValue.sdk), args, { env: this.env, timeoutMs: options.timeoutMs ?? TIMING.commandMs, ...(options.signal ? { signal: options.signal } : {}) });
    if (result.exitCode === -1) throw new DeviceError("UNAVAILABLE", `adb could not run on ${this.label}: ${lastLine(result)}`);
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }

  async uploadFile(stream: Readable, name: string, signal?: AbortSignal): Promise<{ path: string }> {
    const link = this.requireLink();
    const safe = posix.basename(name).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 120) || "upload";
    const path = posix.join(this.layout().uploads, randomUUID(), safe);
    await link.writeFile(path, stream, { mkdirs: true, mode: 0o600 });
    signal?.throwIfAborted();
    return { path };
  }

  async destroy(): Promise<void> {
    throw new DeviceError("INVALID_ARGUMENT", `${this.label} is your own machine: it is never destroyed.`);
  }

  // -------------------------------------------------------------------------
  // Lifecycle (the factory calls these)
  // -------------------------------------------------------------------------

  /** The link came back or dropped, or the record changed. A drop forgets the forwards (the hub and devices keep running there). */
  linkChanged(): void {
    if (!this.deps.connection()?.connected && this.phase === "ready") {
      void this.hub?.forget();
      this.agent?.forget();
      void this.agentForward?.close().catch(() => undefined);
      this.agentForward = null;
      this.phase = "pending";
    }
    this.emitChange();
  }

  /** Idle: stop the hub and the agent-device daemon there (the next prepare starts them). */
  async stopHelpers(): Promise<void> {
    await this.hub?.stop().catch(() => undefined);
    await this.agent?.stop().catch(() => undefined);
    await this.agentForward?.close().catch(() => undefined);
    this.agentForward = null;
    this.stopTimers();
    this.setPhase("stopped", null);
  }

  /** The plugin, Android or the machine's devices went off: boots in flight end (bounded); every emulator and helper there stops. */
  async teardown(): Promise<void> {
    this.tearingDown = true;
    if (this.inFlight.size > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.allSettled([...this.inFlight]), new Promise<void>((resolve) => (timer = setTimeout(resolve, TIMING.teardownWaitMs)))]);
      clearTimeout(timer);
    }
    if (this.deps.connection()?.connected && this.layoutValue && this.env) {
      for (const record of [...this.emulators.values()]) await this.stopRecord(record).catch((error) => this.deps.logger.warn(`[devices] stopping ${record.serial} on ${this.id} failed`, errorText(error)));
      await this.stopHelpers();
      await this.x.exec(adbPath(this.layoutValue.sdk), ["kill-server"], { env: this.env, timeoutMs: 20_000 }).catch(() => undefined);
    }
    await this.dispose();
  }

  onChange(listener: () => void): () => void {
    this.events.on("change", listener);
    return () => void this.events.off("change", listener);
  }

  /** Stop watching: the hub, agent-device and emulators keep running there (a restart reattaches). */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.stopTimers();
    await this.hub?.forget().catch(() => undefined);
    this.agent?.forget();
    await this.agentForward?.close().catch(() => undefined);
    this.agentForward = null;
    await removeAgentDeviceConfig(boxAgentDeviceConfigPath(this.deps.appDir, this.id)).catch(() => undefined);
    await this.stateWrites;
    this.events.removeAllListeners();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private link(): BoxConnection {
    const link = this.deps.connection();
    if (!link) throw new Error(`${this.label} has never connected`);
    return link;
  }

  private layout(): AndroidLayout {
    if (!this.layoutValue) throw new DeviceError(DEVICE_ERROR_CODES.PLATFORM_NOT_READY, `${this.label} is not prepared yet.`);
    return this.layoutValue;
  }

  private marker(): { key: string; value: string } {
    return appdirMarker(this.layout());
  }

  private machineName(): string {
    const name = this.deps.record()?.machineName;
    return typeof name === "string" && name ? name : "Your Windows machine";
  }

  private profiles(): DeviceProfile[] {
    return this.deps.settings().android.profiles.flatMap((id) => {
      const profile = deviceProfile(id);
      return profile && profile.platform === "android" ? [profile] : [];
    });
  }

  private instancesOf(profileId: string): number {
    return [...this.emulators.values()].filter((record) => record.profile === profileId).length;
  }

  private leasedCount(): number {
    return [...this.emulators.values()].filter((record) => record.leaseId !== null && !record.golden).length;
  }

  private requireLink(): BoxConnection {
    const link = this.deps.connection();
    if (!link?.connected) throw new DeviceError("UNAVAILABLE", `${this.label} is unreachable right now; its devices keep running. Try again shortly.`);
    return link;
  }

  private requireReady(): void {
    this.requireLink();
    if (this.phase !== "ready" || !this.env) throw new DeviceError(DEVICE_ERROR_CODES.PLATFORM_NOT_READY, `${this.label} is not ready yet (${this.state().detail ?? this.state().status}).`);
  }

  private requireRoom(): void {
    const total = this.capacityTotal();
    if (this.leasedCount() + this.reserved.size >= total) {
      throw new DeviceError("DEVICE_CAPACITY", `${this.label} runs ${this.leasedCount()} of at most ${total} emulator${total === 1 ? "" : "s"} now (its free memory decides). Release a device first.`);
    }
  }

  private reservePorts(forLease = false): Promise<{ consolePort: number; grpcPort: number; release(): void }> {
    return this.queue.run(" ports", async () => {
      if (forLease) this.requireRoom();
      const listening = new Set((await this.x.tcpRows()).filter((row) => row.state === "0A").map((row) => row.localPort));
      const taken = new Set<number>([...this.reserved, ...[...this.emulators.values()].map((record) => record.consolePort)]);
      const ports = await allocateEmulatorPorts(taken, async (port) => !listening.has(port));
      if (!ports) throw new DeviceError("DEVICE_CAPACITY", `No free emulator port (5554–5682) is left on ${this.label}.`);
      this.reserved.add(ports.consolePort);
      let released = false;
      return {
        ...ports,
        release: () => {
          if (released) return;
          released = true;
          this.reserved.delete(ports.consolePort);
        }
      };
    });
  }

  private persistState(): Promise<void> {
    if (!this.layoutValue) return this.stateWrites;
    const file = this.layoutValue.stateFile;
    const write = async () => {
      await this.x.writeText(file, serializeHostState({ ...emptyHostState(), hub: this.hubRecord, emulators: [...this.emulators.values()], extra: this.stateExtra }));
    };
    this.stateWrites = this.stateWrites.then(write, write).catch((error) => this.deps.logger.warn(`[devices] writing ${this.id}'s state file failed`, errorText(error)));
    return this.stateWrites;
  }

  private checks(): DeviceReadinessCheck[] {
    const probe = this.probe;
    const working = (check: DeviceReadinessCheck): DeviceReadinessCheck => (this.working && check.id.startsWith(this.working) ? { ...check, state: "working" } : check);
    const checks: DeviceReadinessCheck[] = [];
    const whpx = probe ? whpxProblem(probe, this.machineName()) : null;
    checks.push(
      !probe
        ? { id: "whpx", label: "Windows Hypervisor Platform (WHPX)", state: "missing", detail: "Not checked yet" }
        : whpx
          ? { id: "whpx", label: "Windows Hypervisor Platform (WHPX)", state: "error", detail: `${whpx.message} ${whpx.fix ?? ""}`.trim() }
          : { id: "whpx", label: "Windows Hypervisor Platform (WHPX)", state: "ok", detail: probe.accel?.message || "On, and the hypervisor is running" }
    );
    for (const artifact of WINDOWS_ANDROID_ARTIFACTS) {
      const ok = this.installed.get(artifact.id) === true;
      checks.push({ id: `win:${artifact.id}`, label: artifact.label, state: ok ? "ok" : "missing", detail: ok ? artifact.version : "Not installed", fixActionId: FIX_ACTIONS.sdk });
    }
    for (const name of ["expo-device-hub", "agent-device"] as const) {
      const ok = (name === "agent-device" ? this.toolVersions?.agent : this.toolVersions?.hub) === DEVICE_TOOL_VERSIONS[name];
      checks.push({ id: `tool:${name}`, label: name, state: ok ? "ok" : "missing", detail: ok ? DEVICE_TOOL_VERSIONS[name] : "Not installed", fixActionId: FIX_ACTIONS.sdk });
    }
    const gpu = probe ? windowsHostGpu(probe.gpus) : null;
    const graphics =
      this.goldenGpu === WINDOWS_HOST_GPU_MODE
        ? `${gpu?.name ?? "The GPU"} through the desktop session (-gpu host)`
        : this.goldenGpu === "angle_indirect"
          ? `${gpu?.name ?? "The GPU"} through Direct3D (ANGLE)`
          : this.goldenGpu
            ? "Software rendering (SwiftShader)"
            : gpu
              ? `${gpu.name}; the mode is chosen when the first device is prepared${this.desktopSession() ? "" : " (no desktop session: -gpu host is not tried)"}`
              : "No GPU found: software rendering";
    checks.push({ id: "gpu", label: "Graphics", state: "ok", detail: graphics });
    const hubOk = this.hub?.status() === "running";
    const agentOk = this.agent?.configPath() != null;
    checks.push(
      { id: "tool:agent-device-local", label: "agent-device on this machine", state: this.localCli ? "ok" : "missing", detail: this.localCli ? DEVICE_TOOL_VERSIONS["agent-device"] : "Not installed", fixActionId: FIX_ACTIONS.sdk },
      { id: "hub", label: "Device hub", state: hubOk ? "ok" : "missing", detail: hubOk ? "Running" : (this.hub?.detail() ?? "Not running"), fixActionId: FIX_ACTIONS.sdk },
      { id: "agent-device", label: "agent-device daemon", state: agentOk ? "ok" : "missing", detail: agentOk ? "Running" : (this.agent?.error() ?? "Not running"), fixActionId: FIX_ACTIONS.sdk }
    );
    return checks.map(working);
  }

  private startTimers(): void {
    if (this.timers.length > 0) return;
    this.timers.push(
      setInterval(() => void this.sample(), TIMING.sampleMs),
      setInterval(() => void this.checkAgentDevice(), TIMING.agentCheckMs)
    );
    for (const timer of this.timers) timer.unref?.();
  }

  private stopTimers(): void {
    for (const timer of this.timers.splice(0)) clearInterval(timer);
  }

  private async sample(): Promise<void> {
    if (!this.deps.connection()?.connected) return;
    const before = this.capacity().total;
    const memory = await this.x.memAvailable().catch(() => null);
    if (memory !== null) {
      this.memAvailable = memory;
      this.sampledAt = new Date().toISOString();
    }
    if (this.capacity().total !== before) this.emitChange();
  }

  private async checkAgentDevice(): Promise<void> {
    if (this.disposed || this.phase !== "ready" || !this.agent || !this.deps.connection()?.connected) return;
    if (await this.agent.check()) return;
    await this.agent.ensure().catch(() => undefined);
    this.emitChange();
  }

  private setPhase(phase: Phase, detail: string | null): void {
    if (this.disposed) return;
    const changed = phase !== this.phase || detail !== this.detail;
    this.phase = phase;
    this.detail = detail;
    if (changed) this.emitChange();
  }

  private setDetail(detail: string): void {
    this.detail = detail;
    this.emitChange();
  }

  private step(step: string, label: string, state: DeviceHostProgress["state"], percent: number, detail?: string): void {
    this.emitProgress({ step, label, state, percent, ...(detail !== undefined ? { detail } : {}) });
  }

  private emitProgress(progress: DeviceHostProgress): void {
    for (const listener of [...this.progressListeners]) listener(progress);
  }

  private emitChange(): void {
    if (!this.disposed) this.events.emit("change");
  }
}

function gib(bytes: number | null): string {
  return bytes === null ? "unknown" : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
