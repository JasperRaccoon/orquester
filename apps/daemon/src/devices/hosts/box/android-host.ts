/**
 * One Linux box device host running Android emulators (devices phase 2 §2.1): a rented Blacksmith
 * x64 Linux runner (`kind: "box"`, box purpose `device-host`, its `devices` setup step) or an
 * owner's own Linux machine with KVM marked for devices (`kind: "byo"`). The same Android modules
 * as the local host (`../../android/*`, `../../toolchain/android-sdk.ts`) run in the box through its
 * {@link DeviceExecutor} (`android-executor.ts`: `BoxConnection` exec, `setsid` detached processes
 * with log files, files, `/proc`).
 *
 * Preparing ({@link BoxAndroidHost.prepare}; idempotent, reuses what runs):
 * 1. probe (Node ≥ 22, KVM — the record's `kvm: false` or no usable `/dev/kvm` fails at once —,
 *    ffmpeg, Java, sudo); reattach to what the box's state file (`android-host.json`) records;
 * 2. ffmpeg with libx264 (`sudo apt-get install` when missing and sudo works);
 * 3. the pinned tools in the box (from the shipped lockfile; skipped when the cache restored them);
 * 4. the SDK, system image and the profiles' AVDs (skipped when the cache restored them);
 * 5. the first profile's golden snapshot `orq-golden` (the cache's, or made here: cold boot, settle,
 *    guest settings, dp cutout, named save; GPU modes tried in order, the working one recorded);
 * 6. the hub (detached through `hub-launcher.mjs`, uploaded; `--require-token`, the token read
 *    from its 0600 state file in the box, never argv or logs) and the agent-device daemon, both
 *    forwarded to this machine; the local 0600 `--config`; agent-device on this machine.
 *
 * Leases: a read-only instance of the profile's AVD from `orq-golden` with that snapshot's GPU mode
 * (cold boot when the snapshot does not load), `sys.boot_completed`, then the lease boot settings;
 * `release` stops it (`adb emu kill` → signals, only to the verified process).
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import type { Readable } from "node:stream";

import {
  ANDROID_SYSTEM_IMAGE,
  DEVICE_ERROR_CODES,
  DEVICE_PLATFORM_LABELS,
  deviceKey,
  deviceProfile,
  type DeviceCapacity,
  type DeviceHostBoxInfo,
  type DeviceHostPoolInfo,
  type DeviceHostReadiness,
  type DeviceProfile,
  type DeviceReadinessCheck,
  type DevicesSettings,
  type DeviceSummary
} from "@orquester/api";
import type { StoredBox, StoredDeviceLease } from "@orquester/config";

import type { BoxConnection, BoxHostForward } from "../../../boxes/contracts.ts";
import { DEVICE_TOOL_VERSIONS } from "../../../boxes/github/device-cache.ts";
import { AgentDeviceDaemon } from "../../android/agent-device-daemon.ts";
import { avdHardware, avdName } from "../../android/avd-config.ts";
import { allocateEmulatorPorts, findQemuPid, type KvmMode, serialOf, signalLauncher, spawnEmulator, stopEmulator, verifyEmulator, waitForBootCompleted, type EmulatorLaunch } from "../../android/emulator.ts";
import { adbServerPort, androidLayoutAt, appdirMarker, buildAndroidEnv, type AndroidLayout } from "../../android/env.ts";
import { lastLine } from "../../android/exec.ts";
import type { DeviceExecutor } from "../../android/executor.ts";
import { createGoldenSnapshot, LEASE_BOOT_SCRIPT } from "../../android/golden.ts";
import { HUB_LAUNCHER, HubSupervisor } from "../../android/hub.ts";
import { delay, processMatches } from "../../android/procs.ts";
import { evaluateReadiness, FIX_ACTIONS, type ReadinessProbe } from "../../android/readiness.ts";
import { emptyHostState, type EmulatorRecord, type HostStateFile, type HubRecord, parseHostState, planReattach, serializeHostState } from "../../android/state.ts";
import { DeviceError, isDeviceError } from "../../errors.ts";
import type { AgentDeviceCommand, DeviceBootRequest, DeviceBootResult, DeviceCommandResult, DeviceHost, DeviceHostProgress, DeviceHostState } from "../../host.ts";
import {
  acceptLicenses,
  adbPath,
  avdDir,
  clearGolden,
  createAvd,
  installCmdlineTools,
  installSdkPackages,
  packageInstalledOn,
  packageRevision,
  profileHash,
  readAvdMarker,
  SDK_PACKAGES,
  type SdkDeps
} from "../../toolchain/android-sdk.ts";
import type { DeviceToolchain } from "../../toolchain/index.ts";
import { SCRCPY_SERVER, scrcpyJarPath } from "../../toolchain/npm-tools.ts";
import { boxAgentDeviceConfigPath, removeAgentDeviceConfig } from "./agent-device-config.ts";
import { boxExecutor } from "./android-executor.ts";
import {
  ANDROID_PROBE_SCRIPT,
  type AndroidBoxProbe,
  BOX_GOLDEN_MARKER,
  BOX_GOLDEN_SNAPSHOT,
  BOX_GPU_MODES,
  boxAndroidCapacity,
  boxAndroidRoot,
  boxAvdState,
  boxBaseEnv,
  type BoxAvdState,
  boxGolden,
  type BoxGolden,
  type BoxGoldenMarker,
  FFMPEG_INSTALL_SCRIPT,
  parseAndroidProbe,
  screenOfConfig
} from "./android-remote.ts";
import { DEADLINE_MARGIN_MS } from "./host.ts";
import { ensureLocalAgentDevice, localAgentDeviceEntry } from "./local-agent-device.ts";
import { installedToolVersion, INSTALL_TOOLS_SCRIPT, outputTail, writeBoxToolLocks } from "./remote.ts";

/** How long things may take (tests shorten them). */
export interface BoxAndroidTiming {
  commandMs: number;
  installMs: number;
  /** The SDK and system image download and install. */
  sdkMs: number;
  /** A lease's boot to `sys.boot_completed`. */
  bootMs: number;
  /** A golden snapshot's cold boot (per GPU mode tried). */
  goldenBootMs: number;
  sampleMs: number;
  agentCheckMs: number;
  /** A teardown's wait for boots in flight. */
  teardownWaitMs: number;
}

export const DEFAULT_BOX_ANDROID_TIMING: BoxAndroidTiming = {
  commandMs: 2 * 60_000,
  installMs: 15 * 60_000,
  sdkMs: 45 * 60_000,
  bootMs: 5 * 60_000,
  goldenBootMs: 4 * 60_000,
  sampleMs: 15_000,
  agentCheckMs: 30_000,
  teardownWaitMs: 2 * 60_000
};

export interface BoxAndroidHostDeps {
  boxId: string;
  kind: "box" | "byo";
  label: string;
  appDir: string;
  /** This machine's pinned tools (the agent-device CLI the actions layer runs here). */
  toolchain?: DeviceToolchain;
  record(): StoredBox | undefined;
  connection(): BoxConnection | undefined;
  settings(): DevicesSettings;
  activeLeases(): readonly StoredDeviceLease[];
  /** Rented hosts: destroy the box. */
  destroyBox?(): Promise<void>;
  logger: Pick<Console, "info" | "warn" | "error">;
  now?(): number;
  timing?: Partial<BoxAndroidTiming>;
  /** Tests and the integration run: the device root in the box (absent: by provider, {@link boxAndroidRoot}). */
  root?: string;
  /** GPU modes a golden made in the box tries, in order (absent: {@link BOX_GPU_MODES}). */
  gpuModes?: readonly string[];
  /** Make the first profile's golden snapshot while preparing (default true: a pool host's first lease boots in seconds). */
  eagerGolden?: boolean;
  /** Tests: agent-device on this machine (absent: the pinned install, installed when missing). */
  localAgentDevice?(signal: AbortSignal): Promise<string>;
}

type Phase = "pending" | "preparing" | "ready" | "needs-setup" | "failed" | "stopped";

/** Every step of `prepare`; all fix actions run it (it does only what is missing). */
export const BOX_ANDROID_STEPS = ["kvm", "node", "ffmpeg", "tools", "android-sdk", "avds", "golden", "hub", "agent-device", "tool:agent-device-local"] as const;

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

/** What prepare found restored (the device-host workflow restores the device caches before `orq-agent` starts). */
interface CacheFinding {
  tools: boolean;
  sdk: boolean;
  golden: boolean;
}

export class BoxAndroidHost implements DeviceHost {
  readonly id: string;
  readonly kind: "box" | "byo";
  readonly label: string;
  readonly platforms = ["android"] as const;

  private readonly events = new EventEmitter();
  private readonly timing: BoxAndroidTiming;
  private readonly x: DeviceExecutor;
  private phase: Phase = "pending";
  private detail: string | null = null;
  private working: string | null = null;
  private probe: AndroidBoxProbe | null = null;
  private readinessProbe: ReadinessProbe | null = null;
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
  private readonly emulators = new Map<string, EmulatorRecord>();
  /** The GPU mode and snapshot each running emulator booted with (memory only). */
  private readonly viewers = new Map<string, number>();
  private readonly reserved = new Set<number>();
  private readonly queue = new KeyedQueue();
  private readonly inFlight = new Set<Promise<unknown>>();
  private stateExtra: HostStateFile["extra"] = {};
  private stateWrites: Promise<void> = Promise.resolve();
  private memAvailable: number | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private cache: CacheFinding | null = null;
  private tearingDown = false;
  private disposed = false;

  constructor(private readonly deps: BoxAndroidHostDeps) {
    this.id = `box:${deps.boxId}`;
    this.kind = deps.kind;
    this.label = deps.label;
    this.timing = { ...DEFAULT_BOX_ANDROID_TIMING, ...deps.timing };
    this.x = boxExecutor(() => this.link());
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
    if (!record || record.state === "destroyed" || record.state === "destroying" || record.state === "destroy-failed") return { status: "stopping", detail: "The host is being torn down." };
    if (record.state === "pairing") return { status: "needs-setup", detail: "Pair this machine first (Settings → Ephemeral AI VMs)." };
    if (record.state === "provisioning" && this.phase !== "preparing") return { status: "starting", detail: provisioningDetail(record) };
    if (!this.deps.connection()?.connected) {
      return { status: "unreachable", detail: this.kind === "byo" ? "Your machine is offline (its orq-agent is not connected)." : "Reconnecting to the host…" };
    }
    switch (this.phase) {
      case "pending":
        return { status: "starting", detail: "Connecting to the host…" };
      case "preparing":
        return { status: "starting", detail: this.detail ?? "Preparing the host…" };
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
    const link = this.deps.connection();
    if (link?.connected && this.phase !== "preparing" && this.layoutValue) {
      try {
        await this.probeBox(signal);
        await this.refreshStatus();
        if (this.agent && !(await this.agent.check())) await this.agent.ensure(signal).catch(() => undefined);
      } catch (error) {
        this.deps.logger.warn(`[devices] probing ${this.id} failed`, errorText(error));
      }
    }
    return this.readiness();
  }

  capacity(): DeviceCapacity {
    const used = this.leasedCount();
    if (!this.deps.settings().android.enabled || !this.probe) return { used, total: 0 };
    return { used, total: this.capacityTotal() };
  }

  private capacityTotal(): number {
    const running = [...this.emulators.values()].filter((record) => !record.golden).length;
    return boxAndroidCapacity({
      cpus: this.probe?.cpus ?? 1,
      memAvailableBytes: this.memAvailable,
      running,
      ...(this.kind === "byo" ? { cap: this.deps.settings().android.maxLocalDevices } : {})
    });
  }

  box(): DeviceHostBoxInfo | null {
    const record = this.deps.record();
    if (!record) return null;
    return {
      boxId: record.id,
      provider: record.provider,
      hourlyUsd: record.provider === "byo" ? 0 : (record.hourlyUsd ?? null),
      startedAt: record.readyAt ?? record.createdAt,
      deadlineAt: record.deadlineAt ?? null
    };
  }

  /** Near its time limit a rented host drains: no new lease is placed on it. */
  pool(): DeviceHostPoolInfo | null {
    return this.draining() ? { draining: true, warm: false, idleSince: null } : null;
  }

  draining(): boolean {
    const deadline = this.deps.record()?.deadlineAt;
    const at = deadline ? Date.parse(deadline) : NaN;
    return Number.isFinite(at) && at - this.now() < DEADLINE_MARGIN_MS;
  }

  /**
   * Whether the device caches the box workflow restored covered this host (tools, SDK and system
   * image, the first profile's AVD and golden snapshot): `miss` when any had to be built here.
   * Own machines have no cache.
   */
  cacheState(): "hit" | "miss" | "unknown" {
    if (this.kind === "byo" || !this.cache) return "unknown";
    return this.cache.tools && this.cache.sdk && this.cache.golden ? "hit" : "miss";
  }

  hubOrigin(): string | null {
    return this.hub?.origin() ?? null;
  }

  hubToken(): string | null {
    return this.hub?.token() ?? null;
  }

  /** Android streams by serial (serve-emu); there is no iOS here. */
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

  /** agent-device runs on this machine and reaches the box's daemon through the `--config` file's forwarded URL. */
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
    if (!link?.connected) throw new DeviceError(DEVICE_ERROR_CODES.PLATFORM_NOT_READY, `${this.label} is not connected${this.kind === "byo" ? ": start orq-agent on it" : ""}.`);
    await this.prepare(link, signal, onProgress);
  }

  /** Install and start what is missing (joins a run in progress). */
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
    this.setPhase("preparing", "Checking the host…");
    try {
      this.step("kvm", "Checking the host", "running", 2);
      const probe = await this.probeBox(signal);
      this.requireBasics(probe);
      const layout = this.layout();
      this.step("kvm", "Checking the host", "done", 5, `Node ${probe.nodeVersion}, KVM ${probe.kvm.access === "sg" ? "through the kvm group" : "available"}, ${probe.cpus} CPUs`);
      await this.x.mkdir(layout.devices, { mode: 0o700 });
      for (const dir of [layout.tmp, layout.home, layout.androidUser, layout.logs, layout.uploads, layout.hubState, layout.downloads, layout.npmCache, layout.agentDeviceState, layout.agentDeviceHome, layout.agentDeviceClaims]) await this.x.mkdir(dir);
      await this.x.mkdir(layout.runtime, { mode: 0o700 });
      await this.reattach();
      const finding: CacheFinding = { tools: true, sdk: true, golden: true };

      if (probe.ffmpeg !== "libx264") await this.installFfmpeg(probe, signal);

      if (!this.toolsCurrent()) {
        finding.tools = false;
        await this.installTools(signal);
      } else {
        this.step("tools", "Device tools", "skipped", 20, "Already installed");
      }
      // The hub's scrcpy-server jar, pinned (a restored cache may lack it; the hub would fetch it on first stream).
      if (!(await this.x.exists(scrcpyJarPath(layout.tools)))) {
        await this.x.download(SCRCPY_SERVER, scrcpyJarPath(layout.tools), { signal }).catch((error) => this.deps.logger.warn(`[devices] seeding scrcpy-server on ${this.id} failed (the hub fetches it on first stream)`, errorText(error)));
      }

      finding.sdk = await this.ensureSdk(probe, signal);
      await this.ensureAvds(probe, signal);

      const first = this.profiles()[0];
      if (first && this.deps.eagerGolden !== false) {
        this.working = "golden";
        this.step("golden", `Preparing ${first.label} for first use`, "running", 60);
        const before = await boxGolden(this.x, layout.avd, first, await boxAvdState(this.x, layout.avd, first), await this.emulatorRevision());
        finding.golden = before?.source === "cache";
        const golden = await this.ensureGolden(first, signal, (progress) => this.emitProgress({ ...progress, step: "golden", percent: 60 }));
        this.step("golden", `Preparing ${first.label} for first use`, "done", 80, golden ? `${golden.source === "cache" ? "From the cache" : "Made here"} (GPU ${golden.gpu})` : "Later");
      }
      this.cache = finding;

      this.working = "hub";
      this.step("hub", "Starting the device hub", "running", 82);
      this.setDetail("Starting the device hub…");
      await this.x.exec(adbPath(layout.sdk), ["start-server"], { env: this.env!, timeoutMs: 30_000 });
      await this.ensureHub(probe);
      this.step("hub", "Starting the device hub", "done", 88);

      this.working = "agent-device";
      this.step("agent-device", "Starting agent-device", "running", 90);
      this.setDetail("Starting agent-device…");
      await this.ensureAgentDevice(probe, signal);
      this.step("agent-device", "Starting agent-device", "done", 94);

      this.working = "tool:agent-device-local";
      this.step("tool:agent-device-local", "agent-device on this machine", "running", 95);
      this.localCli = await (this.deps.localAgentDevice?.(signal) ?? ensureLocalAgentDevice({ appDir: this.deps.appDir, ...(this.deps.toolchain ? { toolchain: this.deps.toolchain } : {}), signal })).catch((error: unknown) => {
        throw new DeviceError(DEVICE_ERROR_CODES.PLATFORM_NOT_READY, `Installing agent-device on this machine failed: ${errorText(error)}`);
      });
      this.step("tool:agent-device-local", "agent-device on this machine", "done", 98);

      this.working = null;
      await this.refreshStatus();
      await this.sample();
      this.startTimers();
      this.checkedAt = new Date(this.now()).toISOString();
      this.setPhase("ready", null);
      this.emitProgress({ step: "ready", label: "Ready", state: "done", percent: 100 });
    } catch (error) {
      const failedCheck = this.working;
      this.working = null;
      this.checkedAt = new Date(this.now()).toISOString();
      if (signal.aborted) {
        this.setPhase("needs-setup", "Preparing the host was cancelled.");
        throw error;
      }
      const message = isDeviceError(error) ? error.message : `Preparing ${this.label} failed: ${errorText(error)}`;
      if (failedCheck) this.emitProgress({ step: failedCheck, label: failedCheck, state: "failed", detail: message });
      this.deps.logger.warn(`[devices] preparing ${this.id} failed: ${message}`);
      // A fix action can retry an install or a helper; no KVM or Node needs the owner.
      this.setPhase(failedCheck !== null ? "needs-setup" : "failed", message);
      throw isDeviceError(error) ? error : new DeviceError(DEVICE_ERROR_CODES.PLATFORM_NOT_READY, message);
    }
  }

  private requireBasics(probe: AndroidBoxProbe): void {
    const notReady = (message: string) => new DeviceError(DEVICE_ERROR_CODES.PLATFORM_NOT_READY, message);
    if (probe.os !== "Linux") throw notReady(`${this.label} is not a Linux machine: Android emulators need Linux with KVM.`);
    if (this.deps.record()?.kvm === false || probe.kvm.access === "missing" || probe.kvm.access === "denied") {
      const reason = probe.kvm.access === "denied" ? probe.kvm.detail : "it has no usable /dev/kvm (hardware virtualization)";
      throw notReady(`${this.label} cannot run Android emulators: ${reason}`);
    }
    if (probe.nodePath === null || probe.nodeMajor === null || probe.nodeMajor < 22) {
      throw notReady(`${this.label} needs Node.js 22 or newer${probe.nodeVersion ? ` (it has ${probe.nodeVersion})` : ""}: install it there, then try again.`);
    }
  }

  private async probeBox(signal?: AbortSignal): Promise<AndroidBoxProbe> {
    const result = await this.x.exec("/bin/sh", ["-c", ANDROID_PROBE_SCRIPT], { timeoutMs: this.timing.commandMs, ...(signal ? { signal } : {}) });
    if (result.exitCode !== 0) throw new Error(`the probe did not run: ${outputTail(result.stderr) || `exit ${result.exitCode}`}`);
    const probe = parseAndroidProbe(result.stdout);
    this.probe = probe;
    if (!this.layoutValue && probe.nodePath) {
      const root = this.deps.root ?? boxAndroidRoot({ provider: this.deps.record()?.provider ?? "byo", home: this.link().sys.home });
      this.layoutValue = androidLayoutAt(root);
    }
    if (this.layoutValue && probe.nodePath) {
      this.env = buildAndroidEnv(this.layoutValue, boxBaseEnv(probe), { user: probe.user, nodePath: probe.nodePath, adbPort: adbServerPort(this.layoutValue.devices) });
      await this.readToolVersions();
    }
    return probe;
  }

  private async installFfmpeg(probe: AndroidBoxProbe, signal: AbortSignal): Promise<void> {
    if (!probe.sudo) {
      throw new DeviceError(
        DEVICE_ERROR_CODES.PLATFORM_NOT_READY,
        `${this.label} needs ffmpeg with libx264 to stream emulators: install it there (sudo apt install ffmpeg), then try again.`
      );
    }
    this.working = "ffmpeg";
    this.step("ffmpeg", "Installing ffmpeg", "running", 8);
    this.setDetail("Installing ffmpeg…");
    const result = await this.x.exec("/bin/sh", ["-c", FFMPEG_INSTALL_SCRIPT], {
      signal,
      timeoutMs: this.timing.installMs,
      onLine: (line) => this.emitProgress({ step: "ffmpeg", label: "Installing ffmpeg", state: "running", logLine: line })
    });
    if (result.exitCode !== 0) throw new DeviceError(DEVICE_ERROR_CODES.PLATFORM_NOT_READY, `Installing ffmpeg on ${this.label} failed: ${outputTail(result.stderr || result.stdout) || `exit ${result.exitCode}`}`);
    probe.ffmpeg = "libx264";
    this.step("ffmpeg", "Installing ffmpeg", "done", 12);
  }

  private async installTools(signal: AbortSignal): Promise<void> {
    const layout = this.layout();
    this.working = "tools";
    this.step("tools", "Installing the device tools", "running", 12);
    this.setDetail("Installing the device tools…");
    await writeBoxToolLocks(this.link(), layout.tools);
    const result = await this.x.exec("/bin/sh", ["-c", INSTALL_TOOLS_SCRIPT], {
      env: { ...this.env!, TOOLS: layout.tools },
      signal,
      timeoutMs: this.timing.installMs,
      onLine: (line) => this.emitProgress({ step: "tools", label: "Installing the device tools", state: "running", logLine: line })
    });
    await this.readToolVersions();
    if (result.exitCode !== 0 || !this.toolsCurrent()) {
      throw new DeviceError(DEVICE_ERROR_CODES.PLATFORM_NOT_READY, `Installing the device tools on ${this.label} failed: ${outputTail(result.stderr || result.stdout) || `exit ${result.exitCode}`}`);
    }
    this.step("tools", "Installing the device tools", "done", 20);
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

  /** The SDK packages and system image; resolves whether everything was there already (the cache). */
  private async ensureSdk(probe: AndroidBoxProbe, signal: AbortSignal): Promise<boolean> {
    const layout = this.layout();
    const ids = ["cmdline-tools", ...SDK_PACKAGES, ANDROID_SYSTEM_IMAGE];
    const missing: string[] = [];
    for (const id of ids) if (!(await packageInstalledOn(this.x, layout.sdk, id))) missing.push(id);
    if (missing.length === 0) {
      this.step("android-sdk", "Android SDK", "skipped", 50, "Already installed");
      return true;
    }
    if (!probe.java) throw new DeviceError(DEVICE_ERROR_CODES.PLATFORM_NOT_READY, `${this.label} needs Java 17 or newer for the Android SDK tools: install it there (sudo apt install openjdk-17-jre-headless), then try again.`);
    if (missing.includes("cmdline-tools") && !probe.unzip) throw new DeviceError(DEVICE_ERROR_CODES.PLATFORM_NOT_READY, `${this.label} needs unzip for the Android SDK: install it there (sudo apt install unzip), then try again.`);
    this.working = "android-sdk";
    const label = "Installing the Android SDK and system image";
    this.setDetail(`${label}…`);
    const report = (percent: number | null, line: string) =>
      this.emitProgress({ step: "android-sdk", label, state: "running", logLine: line, ...(percent !== null ? { detail: `${percent} %` } : {}), percent: 20 + Math.round(((percent ?? 0) / 100) * 30) });
    this.step("android-sdk", label, "running", 20);
    const deps = this.sdkDeps();
    const sdkSignal = AbortSignal.any([signal, AbortSignal.timeout(this.timing.sdkMs)]);
    await installCmdlineTools({ sdk: layout.sdk, avd: layout.avd }, deps, sdkSignal, report);
    await acceptLicenses({ sdk: layout.sdk, avd: layout.avd }, deps, sdkSignal);
    await installSdkPackages({ sdk: layout.sdk, avd: layout.avd }, [...SDK_PACKAGES, ANDROID_SYSTEM_IMAGE], deps, sdkSignal, report);
    this.step("android-sdk", label, "done", 50);
    return false;
  }

  private sdkDeps(): SdkDeps {
    return { exec: this.x.exec, download: this.x.download, env: this.env!, downloads: this.layout().downloads, executor: this.x };
  }

  /** An AVD for every configured profile (the cache's are kept; outdated ones of ours are made again while none of their instances runs). */
  private async ensureAvds(probe: AndroidBoxProbe, signal: AbortSignal): Promise<void> {
    const layout = this.layout();
    for (const profile of this.profiles()) {
      const state = await boxAvdState(this.x, layout.avd, profile);
      if (state === "cache" || state === "built" || (state === "outdated" && this.instancesOf(profile.id) > 0)) continue;
      if (!probe.java) throw new DeviceError(DEVICE_ERROR_CODES.PLATFORM_NOT_READY, `${this.label} needs Java 17 or newer to create emulators: install it there, then try again.`);
      this.working = "avds";
      this.step("avds", `Creating the ${profile.label} emulator`, "running", 52);
      await this.queue.run(profile.id, () => createAvd({ sdk: layout.sdk, avd: layout.avd }, profile, { exec: this.x.exec, env: this.env!, executor: this.x }, signal));
      this.step("avds", `Creating the ${profile.label} emulator`, "done", 58);
    }
  }

  private async emulatorRevision(): Promise<string | null> {
    return packageRevision(this.layout().sdk, "emulator", this.x);
  }

  /**
   * The profile's usable golden snapshot, made here when missing (its AVD made first). Null when it
   * cannot be made now (instances of an older AVD run): the lease then boots cold.
   */
  private ensureGolden(profile: DeviceProfile, signal: AbortSignal, onProgress: (progress: DeviceHostProgress) => void): Promise<BoxGolden | null> {
    return this.queue.run(profile.id, async () => {
      const layout = this.layout();
      let state: BoxAvdState = await boxAvdState(this.x, layout.avd, profile);
      if (state === "missing" || state === "outdated") {
        if (this.instancesOf(profile.id) > 0) return null;
        onProgress({ step: "prepare-device", label: `Creating the ${profile.label} emulator`, state: "running" });
        await createAvd({ sdk: layout.sdk, avd: layout.avd }, profile, { exec: this.x.exec, env: this.env!, executor: this.x }, signal);
        state = "built";
      }
      const revision = await this.emulatorRevision();
      const found = await boxGolden(this.x, layout.avd, profile, state, revision);
      if (found) return found;
      // A snapshot is taken from a writable boot: never while read-only instances of the AVD run.
      if (this.instancesOf(profile.id) > 0) return null;
      const kvm = this.kvmMode();
      const deviceDensity = (await readAvdMarker(layout.avd, profile.id, this.x))?.deviceDensity;
      const modes = this.deps.gpuModes ?? BOX_GPU_MODES[this.kind];
      const failures: string[] = [];
      for (const gpu of modes) {
        await clearGolden(layout.avd, profile.id, this.x);
        try {
          await createGoldenSnapshot(
            profile,
            {
              exec: this.x.exec,
              sdk: layout.sdk,
              avdHome: layout.avd,
              logs: layout.logs,
              env: this.env!,
              kvm,
              reservePorts: () => this.reservePorts(),
              track: async (record) => {
                this.emulators.set(record.serial, { ...record, profile: profile.id, avd: avdName(profile.id), leaseId: null, golden: true, startedAt: new Date(this.now()).toISOString() });
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
              gpu,
              snapshotName: BOX_GOLDEN_SNAPSHOT,
              bootTimeoutMs: this.timing.goldenBootMs,
              ...(state === "built" ? { density: avdHardware(profile).density, ...(deviceDensity ? { cutoutDensity: deviceDensity } : {}) } : {})
            },
            signal,
            onProgress
          );
          const marker: BoxGoldenMarker = { snapshot: BOX_GOLDEN_SNAPSHOT, gpu, configHash: profileHash(profile), emulatorRevision: revision, createdAt: new Date(this.now()).toISOString() };
          await this.x.writeText(posix.join(avdDir(layout.avd, profile.id), BOX_GOLDEN_MARKER), `${JSON.stringify(marker)}\n`);
          this.deps.logger.info(`[devices] golden ${profile.id} on ${this.id}: made with -gpu ${gpu}`);
          return { snapshot: BOX_GOLDEN_SNAPSHOT, gpu, source: "built" as const };
        } catch (error) {
          if (signal.aborted) throw error;
          failures.push(`${gpu}: ${errorText(error)}`);
          this.deps.logger.warn(`[devices] golden ${profile.id} on ${this.id} with -gpu ${gpu} failed: ${errorText(error)}`);
        }
      }
      throw new Error(failures.join("; "));
    });
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

  private async ensureHub(probe: AndroidBoxProbe): Promise<void> {
    const layout = this.layout();
    const launcher = posix.join(layout.devices, "hub-launcher.mjs");
    const text = readFileSync(HUB_LAUNCHER, "utf8");
    if ((await this.x.readText(launcher)) !== text) await this.x.writeText(launcher, text, { mode: 0o600 });
    this.hub ??= new HubSupervisor({
      nodePath: probe.nodePath!,
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

  private async ensureAgentDevice(probe: AndroidBoxProbe, signal: AbortSignal): Promise<void> {
    const layout = this.layout();
    this.agent ??= new AgentDeviceDaemon({
      exec: this.x.exec,
      nodePath: probe.nodePath!,
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

  /** Reattach to what the box's state file records (a daemon restart, a dropped link): keep what a live lease holds, stop the rest. */
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
      devices.push({
        key: deviceKey(this.id, record.serial),
        hostId: this.id,
        id: record.serial,
        platform: "android",
        name: profile?.label ?? record.avd,
        osVersion: profile?.os ?? "Android",
        profile: record.profile,
        booted: true,
        leaseId: record.leaseId
      });
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
    const gpu = golden?.gpu ?? (this.deps.gpuModes ?? BOX_GPU_MODES[this.kind])[0]!;
    let record: EmulatorRecord;
    try {
      try {
        record = await this.launch(profile, request.leaseId, golden ? { gpu, snapshot: golden.snapshot } : { gpu, coldBoot: true }, signal, progress);
      } catch (error) {
        if (signal.aborted || !golden || isDeviceError(error)) throw error;
        // The snapshot did not load (another emulator build, a broken restore): boot it cold.
        this.deps.logger.warn(`[devices] ${profile.id} on ${this.id} did not boot from ${golden.snapshot} (${errorText(error)}); booting it cold`);
        progress("start-device", `Starting ${profile.label} (cold boot)`);
        record = await this.launch(profile, request.leaseId, { gpu, coldBoot: true }, signal, progress);
      }
    } catch (error) {
      if (signal.aborted) throw new DeviceError("CANCELLED", "The device was released before it finished starting.");
      if (isDeviceError(error)) throw error;
      this.deps.logger.warn(`[devices] ${profile.id} on ${this.id} did not boot: ${errorText(error)}`);
      throw new DeviceError("UNAVAILABLE", `${profile.label} did not start. Try opening it again; if it keeps failing, ask the owner to check Settings → Devices (the daemon log has the details).`);
    }
    const config = (await this.x.readText(posix.join(avdDir(this.layout().avd, profile.id), "config.ini"))) ?? "";
    const screen = screenOfConfig(config);
    return {
      deviceId: record.serial,
      name: profile.label,
      osVersion: profile.os,
      ...(screen ? { screen } : {}),
      stream: { kind: "serve-emu", deviceParam: record.serial }
    };
  }

  /** One emulator launch to `sys.boot_completed`; on failure nothing of it keeps running. */
  private async launch(
    profile: DeviceProfile,
    leaseId: string,
    launch: Pick<EmulatorLaunch, "gpu" | "snapshot" | "coldBoot">,
    signal: AbortSignal,
    progress: (step: string, label: string) => void
  ): Promise<EmulatorRecord> {
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
      pgid = (await spawnEmulator({ sdk: layout.sdk, env, kvm: this.kvmMode(), launch: { avd: avdName(profile.id), consolePort: ports.consolePort, grpcPort: ports.grpcPort, ...launch }, logPath, executor: this.x })).pgid;
      let pid: number | null = null;
      for (let tries = 0; tries < 100 && pid === null; tries++) {
        pid = await findQemuPid(pgid, this.x);
        if (pid === null) {
          if (!(await this.x.procStat(pgid))) break;
          await delay(300, signal);
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
        startedAt: new Date(this.now()).toISOString(),
        logPath
      };
      this.emulators.set(serial, record);
      ports.release();
      await this.persistState();
      this.emitChange();
      progress("wait-boot", `Waiting for ${profile.label} to boot`);
      const qemu = pid;
      const identity = startTicks ?? null;
      await waitForBootCompleted({
        exec: this.x.exec,
        adb: adbPath(layout.sdk),
        env,
        serial,
        alive: async () => (await verifyEmulator(this.x, qemu, marker, identity)) !== null,
        signal,
        timeoutMs: this.timing.bootMs,
        pollMs: 1_000
      });
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
    // Every lease's emulator is a read-only instance made for it: it always goes. Unreachable: the
    // next prepare reaps it (no live lease holds it then).
    if (lease.deviceId === null || !this.deps.connection()?.connected) return;
    const record = this.emulators.get(lease.deviceId);
    if (!record || (record.leaseId !== null && record.leaseId !== lease.id)) return;
    await this.stopRecord(record);
  }

  private async stopRecord(record: EmulatorRecord): Promise<void> {
    const layout = this.layout();
    const how = await stopEmulator({
      exec: this.x.exec,
      adb: adbPath(layout.sdk),
      env: this.env!,
      serial: record.serial,
      pid: record.pid,
      pgid: record.pgid,
      marker: this.marker(),
      startTicks: record.startTicks ?? null,
      executor: this.x
    });
    if (how === "sigkill") this.deps.logger.warn(`[devices] ${record.serial} on ${this.id} needed SIGKILL to stop`);
    if (this.emulators.get(record.serial) === record) this.emulators.delete(record.serial);
    if (this.viewers.delete(record.serial)) this.hub?.setViewers([...this.viewers.values()].reduce((sum, n) => sum + n, 0));
    await this.persistState();
    this.emitChange();
  }

  async run(command: "simctl" | "adb", args: readonly string[], options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<DeviceCommandResult> {
    if (command !== "adb") throw new DeviceError("INVALID_ARGUMENT", `${this.label} runs Android emulators: there is no ${command} there.`);
    this.requireLink();
    if (!this.layoutValue || !this.env) throw new DeviceError(DEVICE_ERROR_CODES.PLATFORM_NOT_READY, `${this.label} is not ready yet.`);
    const result = await this.x.exec(adbPath(this.layoutValue.sdk), args, { env: this.env, timeoutMs: options.timeoutMs ?? this.timing.commandMs, ...(options.signal ? { signal: options.signal } : {}) });
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
    if (!this.deps.destroyBox) throw new DeviceError("INVALID_ARGUMENT", `${this.label} is your own machine: it is never destroyed.`);
    await this.deps.destroyBox();
  }

  // -------------------------------------------------------------------------
  // Lifecycle (the factory calls these)
  // -------------------------------------------------------------------------

  /** The box's link came back or dropped, or its record changed. A drop forgets the forwards (the hub and devices keep running there). */
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

  /** An idle own machine: stop the hub and the agent-device daemon in it (the next prepare starts them). */
  async stopHelpers(): Promise<void> {
    await this.hub?.stop().catch(() => undefined);
    await this.agent?.stop().catch(() => undefined);
    await this.agentForward?.close().catch(() => undefined);
    this.agentForward = null;
    this.stopTimers();
    this.setPhase("stopped", null);
  }

  /** The plugin or Android went off: no new boot; boots in flight end (bounded); every emulator and helper in the box stops. */
  async teardown(): Promise<void> {
    this.tearingDown = true;
    if (this.inFlight.size > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.allSettled([...this.inFlight]), new Promise<void>((resolve) => (timer = setTimeout(resolve, this.timing.teardownWaitMs)))]);
      clearTimeout(timer);
    }
    if (this.deps.connection()?.connected && this.layoutValue && this.env) {
      for (const record of [...this.emulators.values()]) await this.stopRecord(record).catch((error) => this.deps.logger.warn(`[devices] stopping ${record.serial} on ${this.id} failed`, errorText(error)));
      await this.stopHelpers();
      await this.x.exec(adbPath(this.layoutValue.sdk), ["kill-server"], { env: this.env, timeoutMs: 10_000 }).catch(() => undefined);
    }
    await this.dispose();
  }

  onChange(listener: () => void): () => void {
    this.events.on("change", listener);
    return () => void this.events.off("change", listener);
  }

  /** Stop watching: the hub, agent-device and emulators keep running in the box (a restart reattaches). */
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

  private kvmMode(): KvmMode {
    return this.probe?.kvm.access === "sg" ? "sg" : "direct";
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

  /** A lease's slot is free (checked again under the port queue: {@link reservePorts}). */
  private requireRoom(): void {
    const total = this.capacityTotal();
    if (this.leasedCount() + this.reserved.size >= total) {
      throw new DeviceError("DEVICE_CAPACITY", `${this.label} runs ${this.leasedCount()} of at most ${total} emulators now. Release a device first.`);
    }
  }

  /** One allocation at a time; a lease's slot is re-checked against capacity in the same queue. */
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
      const text = serializeHostState({ ...emptyHostState(), hub: this.hubRecord, emulators: [...this.emulators.values()], extra: this.stateExtra });
      await this.x.writeText(file, text, { mode: 0o600 });
    };
    this.stateWrites = this.stateWrites.then(write, write).catch((error) => this.deps.logger.warn(`[devices] writing ${this.id}'s state file failed`, errorText(error)));
    return this.stateWrites;
  }

  /** The SDK / AVD / tool part of readiness, from the box. */
  private async refreshStatus(): Promise<void> {
    const probe = this.probe;
    if (!probe || !this.layoutValue) return;
    const layout = this.layoutValue;
    const installed = (id: string) => packageInstalledOn(this.x, layout.sdk, id);
    const revision = await this.emulatorRevision();
    const avds = [];
    for (const profile of this.profiles()) {
      const state = await boxAvdState(this.x, layout.avd, profile);
      const golden = state === "missing" ? null : await boxGolden(this.x, layout.avd, profile, state, revision);
      avds.push({ profile: profile.id, label: profile.label, created: state === "cache" || state === "built", snapshot: golden !== null, ...(state === "outdated" ? { outdated: true } : {}) });
    }
    this.readinessProbe = {
      kvm: probe.kvm,
      nodeVersion: probe.nodeVersion ?? "none",
      ffmpeg: probe.ffmpeg,
      java: probe.java,
      packages: { cmdlineTools: await installed("cmdline-tools"), platformTools: await installed("platform-tools"), emulator: await installed("emulator"), systemImage: await installed(ANDROID_SYSTEM_IMAGE) },
      avds,
      tools: (["expo-device-hub", "agent-device"] as const).map((name) => ({
        name,
        version: DEVICE_TOOL_VERSIONS[name],
        installed: (name === "agent-device" ? this.toolVersions?.agent : this.toolVersions?.hub) === DEVICE_TOOL_VERSIONS[name]
      }))
    };
    this.emitChange();
  }

  private checks(): DeviceReadinessCheck[] {
    const working = (check: DeviceReadinessCheck): DeviceReadinessCheck => (this.working && check.id.startsWith(this.working) ? { ...check, state: "working" } : check);
    const base: DeviceReadinessCheck[] = this.readinessProbe
      ? evaluateReadiness(this.readinessProbe).map((check) => ({ ...check, ...(check.fixActionId ? { fixActionId: FIX_ACTIONS.sdk } : {}) }))
      : [
          { id: "kvm", label: "Hardware virtualization (/dev/kvm)", state: "missing", detail: "Not checked yet" },
          { id: "node", label: "Node.js 22 or newer", state: "missing", detail: "Not checked yet" }
        ];
    const hubOk = this.hub?.status() === "running";
    const agentOk = this.agent?.configPath() != null;
    const helpers: DeviceReadinessCheck[] = [
      { id: "tool:agent-device-local", label: "agent-device on this machine", state: this.localCli ? "ok" : "missing", detail: this.localCli ? DEVICE_TOOL_VERSIONS["agent-device"] : "Not installed", fixActionId: FIX_ACTIONS.sdk },
      { id: "hub", label: "Device hub", state: hubOk ? "ok" : "missing", detail: hubOk ? "Running" : (this.hub?.detail() ?? "Not running"), fixActionId: FIX_ACTIONS.sdk },
      { id: "agent-device", label: "agent-device daemon", state: agentOk ? "ok" : "missing", detail: agentOk ? "Running" : (this.agent?.error() ?? "Not running"), fixActionId: FIX_ACTIONS.sdk }
    ];
    return [...base, ...helpers].map(working);
  }

  private startTimers(): void {
    if (this.timers.length > 0) return;
    this.timers.push(
      setInterval(() => void this.sample(), this.timing.sampleMs),
      setInterval(() => void this.checkAgentDevice(), this.timing.agentCheckMs)
    );
    for (const timer of this.timers) timer.unref?.();
  }

  private stopTimers(): void {
    for (const timer of this.timers.splice(0)) clearInterval(timer);
  }

  private async sample(): Promise<void> {
    if (!this.deps.connection()?.connected) return;
    const before = this.capacity().total;
    this.memAvailable = await this.x.memAvailable().catch(() => this.memAvailable);
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

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

/** What a box being set up is doing now (its running setup step). */
function provisioningDetail(record: StoredBox): string {
  const running = (record.setup ?? []).find((step) => step.state === "running");
  switch (running?.id) {
    case "create":
      return `Renting a Linux host (${record.sizeLabel ?? record.size})…`;
    case "connect":
      return "Waiting for the host to start…";
    case "devices":
      return running.message ? `Preparing: ${running.message}` : "Preparing the host…";
    default:
      return "Setting up the host…";
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
