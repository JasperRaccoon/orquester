/**
 * The local Android host (devices spec §6.2, spikes §2): Android emulators on this machine.
 *
 * - Readiness: /dev/kvm openable (directly, or through `sg kvm` while the daemon process lacks the
 *   group /etc/group gives its user), Node ≥ 22, ffmpeg with libx264, the SDK and system image, an
 *   AVD per configured profile, the pinned tools — each fixable item with a fix action the setup
 *   job (`ensureReady`) runs through the toolchain.
 * - Orquester launches and supervises the emulators itself (`../android/emulator.ts`): a read-only
 *   instance of the profile's AVD per lease, booted from its golden snapshot (made the first time
 *   the profile is opened, `../android/golden.ts`), on a free console port in 5554–5682, logs in
 *   `logs/<serial>.log`, ready at `sys.boot_completed=1`; stopped `adb emu kill` → SIGTERM → SIGKILL.
 * - The hub (`../android/hub.ts`) only streams and drives emulators by serial; the agent-device
 *   daemon (`../android/agent-device-daemon.ts`) backs the agent tools through a 0600 `--config`.
 * - Everything runs with the appdir's private environment (`../android/env.ts`: SDK, AVD, adb
 *   server port, runtime dir, caches) and is recorded in `hub.json`, so a restarted daemon
 *   reattaches (pid + environment check) and reaps what no live lease holds.
 * - Capacity: `min(maxLocalDevices, running + floor((MemAvailable − 8 GB) / 3.2 GB))`; the status
 *   line adds how many can be actively driven at once (`threads / 8`).
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, open, readdir, readFile, rm, stat } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  ANDROID_SYSTEM_IMAGE,
  deviceKey,
  deviceProfile,
  LOCAL_DEVICE_HOST_ID,
  LOCAL_DEVICE_HOST_LABEL,
  type DeviceCapacity,
  type DeviceHostReadiness,
  type DeviceProfile,
  type DeviceReadinessCheck,
  type DevicesSettings,
  type DeviceSummary
} from "@orquester/api";
import type { StoredDeviceLease } from "@orquester/config";

import { AgentDeviceDaemon } from "../android/agent-device-daemon.ts";
import { avdHardware, avdName, avdScreen } from "../android/avd-config.ts";
import { localCapacity } from "../android/capacity.ts";
import {
  allocateEmulatorPorts,
  findQemuPid,
  type KvmMode,
  serialOf,
  spawnEmulator,
  signalLauncher,
  stopEmulator,
  verifyEmulator,
  waitForBootCompleted
} from "../android/emulator.ts";
import { appdirMarker } from "../android/env.ts";
import { execFile, type ExecFn, lastLine } from "../android/exec.ts";
import { LOCAL_EXECUTOR } from "../android/executor.ts";
import { createGoldenSnapshot, LEASE_BOOT_SCRIPT } from "../android/golden.ts";
import { HUB_LAUNCHER, HubSupervisor } from "../android/hub.ts";
import { delay, isProcessAlive, listProcStats, processMatches, readMemAvailable, signalGroup, waitForExit } from "../android/procs.ts";
import { evaluateReadiness, ffmpegHasLibx264, FIX_ACTIONS, groupMembers, type KvmProbe, type ReadinessProbe } from "../android/readiness.ts";
import { type EmulatorRecord, emptyHostState, type HostStateFile, type HubRecord, planReattach, readHostState, writeHostState } from "../android/state.ts";
import { DeviceError } from "../errors.ts";
import type { AgentDeviceCommand, DeviceBootRequest, DeviceBootResult, DeviceCommandResult, DeviceHost, DeviceHostFactory, DeviceHostFactoryContext, DeviceHostProgress, DeviceHostState } from "../host.ts";
import { clearGolden, goldenReady, writeGoldenMarker } from "../toolchain/android-sdk.ts";
import { DEVICE_TOOL_NAMES, type LocalDeviceToolchain } from "../toolchain/index.ts";

export interface LocalAndroidHostDeps {
  appDir: string;
  env: NodeJS.ProcessEnv;
  toolchain: LocalDeviceToolchain;
  logger: Pick<Console, "info" | "warn" | "error">;
  /** Tests: the program runner and the KVM probe. */
  exec?: ExecFn;
  probeKvm?: () => Promise<KvmProbe>;
  nodePath?: string;
}

const BOOT_TIMEOUT_MS = 5 * 60_000;
const SAMPLE_MS = 15_000;
const AGENT_DEVICE_CHECK_MS = 30_000;
const UPLOAD_MAX_AGE_MS = 24 * 60 * 60_000;

/** How this process can open /dev/kvm (directly, or through `sg kvm`). */
export async function probeKvmAccess(exec: ExecFn = execFile, user = process.env.USER ?? ""): Promise<KvmProbe> {
  try {
    const handle = await open("/dev/kvm", "r+");
    await handle.close();
    return { access: "direct" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { access: "missing" };
  }
  const listed = groupMembers(await readFile("/etc/group", "utf8").catch(() => ""), "kvm").includes(user);
  if (listed) {
    const viaSg = await exec("sg", ["kvm", "-c", "test -r /dev/kvm -a -w /dev/kvm"], { timeoutMs: 10_000 });
    if (viaSg.exitCode === 0) return { access: "sg" };
  }
  return {
    access: "denied",
    detail: listed
      ? "/dev/kvm is not usable even through the kvm group. Check its permissions (ls -l /dev/kvm)."
      : `The Orquester user (${user || "unknown"}) cannot open /dev/kvm: add it to the kvm group (usermod -aG kvm ${user || "<user>"}) and restart Orquester (SupplementaryGroups=kvm).`
  };
}

function placeholderChecks(profiles: readonly string[]): DeviceReadinessCheck[] {
  const pending = (id: string, label: string, fixActionId?: string): DeviceReadinessCheck => ({ id, label, state: "missing", detail: "Not checked yet", ...(fixActionId ? { fixActionId } : {}) });
  return [
    pending("kvm", "Hardware virtualization (/dev/kvm)"),
    pending("node", "Node.js 22 or newer"),
    pending("ffmpeg", "ffmpeg with libx264"),
    pending("android-sdk", "Android SDK (platform-tools, emulator)", FIX_ACTIONS.sdk),
    pending("system-image", "Android 15 system image", FIX_ACTIONS.systemImage),
    ...profiles.map((profile) => pending(`avd:${profile}`, `Emulator for ${deviceProfile(profile)?.label ?? profile}`, FIX_ACTIONS.avd(profile))),
    ...DEVICE_TOOL_NAMES.map((name) => pending(`tool:${name}`, name, FIX_ACTIONS.tool(name)))
  ];
}

function androidProfiles(settings: DevicesSettings): string[] {
  return settings.android.profiles.filter((id) => deviceProfile(id)?.platform === "android");
}

function safeFileName(name: string): string {
  const base = basename(name).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return base.slice(0, 120) || "upload";
}

/** One-at-a-time per key. */
class KeyedQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}

export class LocalAndroidHost implements DeviceHost {
  readonly id = LOCAL_DEVICE_HOST_ID;
  readonly kind = "local" as const;
  readonly label = LOCAL_DEVICE_HOST_LABEL;
  readonly platforms = ["android"] as const;

  private readonly events = new EventEmitter();
  private readonly exec: ExecFn;
  private readonly env: NodeJS.ProcessEnv;
  private readonly layout;
  private readonly marker;
  private readonly nodePath: string;
  private readonly hub: HubSupervisor;
  private readonly agentDevice: AgentDeviceDaemon;
  private readonly emulators = new Map<string, EmulatorRecord>();
  /** Open proxied streams per device (`viewersChanged`). */
  private readonly viewers = new Map<string, number>();
  /** Console ports being booted (not yet in `emulators`). */
  private readonly reserved = new Set<number>();
  private readonly profileQueue = new KeyedQueue();
  private hubRecord: HubRecord | null = null;
  private stateExtra: HostStateFile["extra"] = {};
  private stateWrites: Promise<void> = Promise.resolve();
  private checks: DeviceReadinessCheck[];
  private checkedAt: string | null = null;
  private kvm: KvmMode | null = null;
  private installing = false;
  private servicesStarting: Promise<void> | null = null;
  private memAvailable: number | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private disposed = false;
  private readonly threads = availableParallelism();

  constructor(
    private readonly deps: LocalAndroidHostDeps,
    private readonly ctx: Pick<DeviceHostFactoryContext, "settings" | "activeLeases">
  ) {
    this.exec = deps.exec ?? execFile;
    this.env = deps.toolchain.env;
    this.layout = deps.toolchain.layout;
    this.marker = appdirMarker(this.layout);
    this.nodePath = deps.nodePath ?? process.execPath;
    this.checks = placeholderChecks(androidProfiles(ctx.settings()));
    this.hub = new HubSupervisor({
      nodePath: this.nodePath,
      cli: () => deps.toolchain.toolEntry("expo-device-hub"),
      env: this.env,
      hubStateDir: this.layout.hubState,
      logPath: join(this.layout.logs, "hub.log"),
      marker: this.marker,
      persist: async (record) => {
        this.hubRecord = record;
        await this.persistState();
      },
      onChange: () => this.changed(),
      logger: deps.logger
    });
    this.agentDevice = new AgentDeviceDaemon({
      exec: this.exec,
      nodePath: this.nodePath,
      entry: () => deps.toolchain.toolEntry("agent-device"),
      env: this.env,
      stateDir: this.layout.agentDeviceState,
      configPath: this.layout.agentDeviceConfig,
      logger: deps.logger
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Reattach to what a previous daemon left running and reap the rest. Fast (no installs). */
  async reattach(): Promise<void> {
    await mkdir(this.layout.devices, { recursive: true, mode: 0o700 }).catch(() => undefined);
    const state = await readHostState(this.layout.stateFile);
    this.stateExtra = state.extra;
    const ours = new Set<number>();
    for (const emulator of state.emulators) if (await verifyEmulator(LOCAL_EXECUTOR, emulator.pid, this.marker, emulator.startTicks)) ours.add(emulator.pid);
    if (state.hub && (await processMatches(state.hub.pid, this.marker, [HUB_LAUNCHER]))) ours.add(state.hub.pid);
    const live = new Set(this.ctx.activeLeases(this.id).map((lease) => lease.id));
    const plan = planReattach(state, ours, live);
    for (const emulator of plan.keep) this.emulators.set(emulator.serial, emulator);
    if (plan.keep.length > 0) this.deps.logger.info(`[devices] reattached to ${plan.keep.length} running emulator(s)`);
    if (state.hub && plan.hub === "reattach" && !(await this.hub.attach(state.hub))) {
      // Ours but not answering: stop it; the services start a fresh one.
      signalGroup(state.hub.pid, state.hub.pid, "SIGTERM");
    }
    this.hubRecord = this.hub.pid() !== null && state.hub ? state.hub : null;
    await this.persistState();
    for (const emulator of plan.reap) {
      this.deps.logger.info(`[devices] stopping ${emulator.serial} (${emulator.profile}): no lease holds it after the restart`);
      await this.stopRecord(emulator).catch(() => undefined);
    }
    await this.reapStrays();
  }

  /** Probe, then start the hub and agent-device when everything is installed (not awaited by the factory). */
  async start(): Promise<void> {
    this.timers.push(
      setInterval(() => void this.sample(), SAMPLE_MS),
      setInterval(() => void this.checkAgentDevice(), AGENT_DEVICE_CHECK_MS)
    );
    for (const timer of this.timers) timer.unref?.();
    await this.sample();
    await this.pruneUploads().catch(() => undefined);
    const readiness = await this.refreshReadiness();
    if (readiness.ready) await this.startServices().catch((error) => this.deps.logger.warn("[devices] the local device services did not start", errorText(error)));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const timer of this.timers.splice(0)) clearInterval(timer);
    if (this.emulators.size === 0) {
      // Nothing to reattach to: leave nothing running.
      await this.hub.stop().catch(() => undefined);
      await this.agentDevice.stop().catch(() => undefined);
      await this.exec(join(this.layout.sdk, "platform-tools", "adb"), ["kill-server"], { env: this.env, timeoutMs: 10_000 }).catch(() => undefined);
    } else {
      this.hub.detach();
    }
    await this.stateWrites;
    this.events.removeAllListeners();
  }

  /** Android was switched off: every emulator, the hub and the agent-device daemon stop. */
  async teardown(): Promise<void> {
    for (const record of [...this.emulators.values()]) await this.stopRecord(record).catch(() => undefined);
    await this.dispose();
  }

  settingsChanged(): void {
    void this.refreshReadiness().catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Status and readiness
  // -------------------------------------------------------------------------

  state(): DeviceHostState {
    if (this.installing) return { status: "installing", detail: "Installing device tools" };
    const notOk = this.checks.find((check) => check.state !== "ok");
    if (notOk) return { status: "needs-setup", detail: `${notOk.label}: ${notOk.detail ?? notOk.state}` };
    const hub = this.hub.status();
    if (hub === "failed") return { status: "failed", detail: this.hub.detail() };
    if (hub !== "running") return { status: "starting", detail: "Starting the device hub" };
    const { total, active } = this.capacityNumbers();
    const agent = this.agentDevice.configPath() === null ? ` Agent tools are unavailable: ${this.agentDevice.error() ?? "agent-device is starting"}.` : "";
    return { status: "ready", detail: `Up to ${total} device${total === 1 ? "" : "s"} at once; about ${active} can be actively driven at the same time.${agent}` };
  }

  readiness(): DeviceHostReadiness {
    return { ready: this.checks.every((check) => check.state === "ok"), checks: this.checks.map((check) => ({ ...check })), checkedAt: this.checkedAt };
  }

  async refreshReadiness(): Promise<DeviceHostReadiness> {
    const probe = await this.probe();
    this.checks = evaluateReadiness(probe);
    this.checkedAt = new Date().toISOString();
    this.changed();
    return this.readiness();
  }

  private async probe(): Promise<ReadinessProbe> {
    const toolchain = this.deps.toolchain;
    const profiles = androidProfiles(this.ctx.settings());
    const [kvm, ffmpeg, java, status, tools] = await Promise.all([
      (this.deps.probeKvm ?? (() => probeKvmAccess(this.exec, this.env.USER)))(),
      this.exec("ffmpeg", ["-hide_banner", "-encoders"], { env: this.env, timeoutMs: 15_000 }),
      this.exec("java", ["-version"], { env: this.env, timeoutMs: 15_000 }),
      toolchain.androidStatus(profiles),
      toolchain.tools()
    ]);
    this.kvm = kvm.access === "direct" || kvm.access === "sg" ? kvm.access : null;
    const installed = (id: string) => status.packages.find((entry) => entry.id === id)?.installed ?? false;
    return {
      kvm,
      nodeVersion: process.version,
      ffmpeg: ffmpeg.exitCode === -1 ? "missing" : ffmpegHasLibx264(ffmpeg.stdout) ? "libx264" : "no-libx264",
      java: java.exitCode === 0,
      packages: { cmdlineTools: installed("cmdline-tools"), platformTools: installed("platform-tools"), emulator: installed("emulator"), systemImage: installed(ANDROID_SYSTEM_IMAGE) },
      avds: status.avds.map((avd) => ({ ...avd, label: deviceProfile(avd.profile)?.label ?? avd.profile })),
      tools: tools.map((tool) => ({ name: tool.name, version: tool.version, installed: tool.installed }))
    };
  }

  capacity(): DeviceCapacity {
    return { used: this.leasedCount(), total: this.capacityNumbers().total };
  }

  private capacityNumbers() {
    return localCapacity({ maxLocalDevices: this.ctx.settings().android.maxLocalDevices, memAvailableBytes: this.memAvailable, running: this.emulators.size, threads: this.threads });
  }

  private leasedCount(): number {
    return [...this.emulators.values()].filter((record) => record.leaseId !== null).length;
  }

  private async sample(): Promise<void> {
    const before = this.capacityNumbers().total;
    this.memAvailable = await readMemAvailable();
    if (this.capacityNumbers().total !== before) this.changed();
  }

  // -------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------

  async ensureReady(signal: AbortSignal, onProgress: (progress: DeviceHostProgress) => void, actions?: readonly string[]): Promise<void> {
    if (this.installing) throw new DeviceError("DEVICE_BUSY", "A device setup is already running on this machine.");
    this.installing = true;
    this.changed();
    try {
      await this.refreshReadiness();
      const missing = this.checks.filter((check) => check.state !== "ok");
      const wanted = new Set(actions ?? missing.flatMap((check) => (check.fixActionId ? [check.fixActionId] : [])));
      // Java is the one owner-fixed item the installs themselves need; KVM, Node and ffmpeg only
      // matter at run time, so the installs go ahead and readiness names them at the end.
      const java = missing.find((check) => check.id === "java");
      if (java && this.needsJava(wanted)) throw new DeviceError("PLATFORM_NOT_READY", `${java.label}: ${java.detail ?? "missing"}`);
      const plan = this.plan(wanted);
      const total = plan.reduce((sum, step) => sum + step.weight, 0) || 1;
      let done = 0;
      for (const step of plan) {
        signal.throwIfAborted();
        const base = Math.round((done / total) * 100);
        onProgress({ step: step.id, label: step.label, state: "running", percent: base });
        await step.run(signal, (progress) => onProgress({ ...progress, step: step.id, label: progress.label || step.label, percent: base }));
        done += step.weight;
        onProgress({ step: step.id, label: step.label, state: "done", percent: Math.round((done / total) * 100) });
      }
      const readiness = await this.refreshReadiness();
      if (!readiness.ready) {
        const left = readiness.checks.filter((check) => check.state !== "ok");
        throw new DeviceError("PLATFORM_NOT_READY", `Still missing: ${left.map((check) => `${check.label} (${check.detail ?? check.state})`).join("; ")}.`);
      }
      onProgress({ step: "start-hub", label: "Starting the device hub", state: "running" });
      this.installing = false;
      await this.startServices(signal);
      onProgress({ step: "start-hub", label: "Starting the device hub", state: "done", percent: 100 });
    } catch (error) {
      if (signal.aborted) throw new DeviceError("CANCELLED", "The setup was cancelled.");
      if (error instanceof DeviceError) throw error;
      throw new DeviceError("UNAVAILABLE", error instanceof Error ? error.message : String(error));
    } finally {
      this.installing = false;
      this.changed();
    }
  }

  private needsJava(actions: ReadonlySet<string>): boolean {
    return [...actions].some((action) => action === FIX_ACTIONS.sdk || action === FIX_ACTIONS.systemImage || action.startsWith("create-avd:"));
  }

  /** The install steps for a set of fix actions, in dependency order. */
  private plan(actions: ReadonlySet<string>): { id: string; label: string; weight: number; run: (signal: AbortSignal, progress: (p: DeviceHostProgress) => void) => Promise<void> }[] {
    const toolchain = this.deps.toolchain;
    const steps: ReturnType<LocalAndroidHost["plan"]> = [];
    for (const name of DEVICE_TOOL_NAMES) {
      if (actions.has(FIX_ACTIONS.tool(name))) steps.push({ id: `tool:${name}`, label: `Installing ${name}`, weight: 5, run: async (signal, progress) => void (await toolchain.ensureTool(name, signal, progress)) });
    }
    if (actions.has(FIX_ACTIONS.sdk)) steps.push({ id: "android-sdk", label: "Installing the Android SDK", weight: 20, run: (signal, progress) => toolchain.ensureAndroidSdk(signal, progress) });
    if (actions.has(FIX_ACTIONS.systemImage)) steps.push({ id: "system-image", label: "Downloading the Android 15 system image", weight: 40, run: (signal, progress) => toolchain.ensureSystemImage(signal, progress) });
    for (const action of actions) {
      const profileId = action.startsWith("create-avd:") ? action.slice("create-avd:".length) : null;
      if (profileId === null) continue;
      const profile = this.requireProfile(profileId);
      steps.push({
        id: `avd:${profileId}`,
        label: `Creating the ${profile.label} emulator`,
        weight: 2,
        run: (signal) =>
          this.profileQueue.run(profileId, async () => {
            // Asked for an AVD that is fine: a repair, made again from scratch.
            const repair = this.checkFor(`avd:${profileId}`)?.state === "ok";
            if (this.instancesOf(profileId) > 0) {
              if (repair) throw new DeviceError("DEVICE_BUSY", `${profile.label} devices are running; release them before repairing its emulator.`);
              return;
            }
            await toolchain.ensureAvd(profileId, signal, { force: repair });
          })
      });
    }
    for (const action of actions) {
      const profileId = action.startsWith("create-snapshot:") ? action.slice("create-snapshot:".length) : null;
      if (profileId === null) continue;
      const profile = this.requireProfile(profileId);
      steps.push({ id: `snapshot:${profileId}`, label: `Preparing ${profile.label} for first use`, weight: 30, run: (signal, progress) => this.ensureGolden(profile, signal, progress, { force: true }) });
    }
    return steps;
  }

  private checkFor(id: string): DeviceReadinessCheck | undefined {
    return this.checks.find((check) => check.id === id);
  }

  private requireProfile(id: string): DeviceProfile {
    const profile = deviceProfile(id);
    if (!profile || profile.platform !== "android") throw new DeviceError("INVALID_ARGUMENT", `${id} is not an Android profile.`);
    return profile;
  }

  /** The hub, then the agent-device daemon (whose failure leaves streaming working). */
  private startServices(signal?: AbortSignal): Promise<void> {
    this.servicesStarting ??= (async () => {
      await mkdir(this.layout.logs, { recursive: true });
      await mkdir(this.layout.runtime, { recursive: true, mode: 0o700 });
      this.changed();
      await this.hub.start();
      await this.agentDevice.ensure(signal).catch((error) => this.deps.logger.warn("[devices] agent-device did not start", errorText(error)));
      this.changed();
    })().finally(() => {
      this.servicesStarting = null;
    });
    return this.servicesStarting;
  }

  private async checkAgentDevice(): Promise<void> {
    if (this.disposed || this.hub.status() !== "running") return;
    if (await this.agentDevice.check()) return;
    await this.agentDevice.ensure().catch(() => undefined);
    this.changed();
  }

  // -------------------------------------------------------------------------
  // Golden snapshots
  // -------------------------------------------------------------------------

  /** Make the profile's AVD and golden snapshot when missing (the first open of a profile). */
  private ensureGolden(profile: DeviceProfile, signal: AbortSignal, onProgress: (progress: DeviceHostProgress) => void, options: { force?: boolean } = {}): Promise<void> {
    return this.profileQueue.run(profile.id, async () => {
      const toolchain = this.deps.toolchain;
      if (!(await toolchain.avdStatus(profile.id)).created) {
        if (this.instancesOf(profile.id) > 0) return;
        onProgress({ step: "prepare-device", label: `Creating the ${profile.label} emulator`, state: "running" });
        await toolchain.ensureAvd(profile.id, signal);
      }
      const revision = await toolchain.emulatorRevision();
      if (!options.force && (await goldenReady(this.layout.avd, profile, revision))) return;
      // A snapshot is taken from a writable boot: never while read-only instances of the AVD run.
      if (this.instancesOf(profile.id) > 0) {
        if (options.force) throw new DeviceError("DEVICE_BUSY", `${profile.label} devices are running; release them before preparing it again.`);
        return;
      }
      if (!this.kvm) throw new DeviceError("PLATFORM_NOT_READY", "/dev/kvm is not usable; see Settings → Devices.");
      await clearGolden(this.layout.avd, profile.id);
      await createGoldenSnapshot(
        profile,
        {
          exec: this.exec,
          sdk: this.layout.sdk,
          avdHome: this.layout.avd,
          logs: this.layout.logs,
          env: this.env,
          kvm: this.kvm,
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
          marker: this.marker,
          logger: this.deps.logger
        },
        signal,
        onProgress
      );
      await writeGoldenMarker(this.layout.avd, profile, revision);
      // The profile's check reads "Ready" now, not "prepared on first use" (a first open makes it).
      void this.refreshReadiness().catch(() => undefined);
    });
  }

  /** agent-device's Android helper APKs, pre-installed into golden snapshots (its first snapshot then skips the install). */
  private async helperApks(): Promise<string[]> {
    const entry = this.deps.toolchain.toolEntry("agent-device");
    if (!entry) return [];
    const pkg = dirname(dirname(entry));
    const apks: string[] = [];
    for (const helper of ["snapshot-helper", "ime-helper"]) {
      const dir = join(pkg, "android", helper, "dist");
      for (const file of await readdir(dir).catch(() => [] as string[])) if (file.endsWith(".apk")) apks.push(join(dir, file));
    }
    return apks;
  }

  private instancesOf(profileId: string): number {
    return [...this.emulators.values()].filter((record) => record.profile === profileId).length;
  }

  // -------------------------------------------------------------------------
  // Devices
  // -------------------------------------------------------------------------

  hubOrigin(): string | null {
    return this.hub.origin();
  }

  hubToken(): string | null {
    return this.hub.token();
  }

  streamCapabilities(): { iosH264: boolean } {
    return { iosH264: false };
  }

  agentDeviceConfigPath(): string | null {
    return this.agentDevice.configPath();
  }

  /** The service's viewer signal for a leased device: the hub's capture sessions are in use. */
  viewerActive(_deviceId: string): void {
    this.hub.noteViewer();
  }

  /** The proxy's open streams of one device; the hub recycles its capture sessions once no device is watched. */
  viewersChanged(deviceId: string, count: number): void {
    if (count > 0) this.viewers.set(deviceId, count);
    else this.viewers.delete(deviceId);
    this.hub.setViewers([...this.viewers.values()].reduce((sum, n) => sum + n, 0));
  }

  /** The pinned agent-device CLI under the daemon's node, with this host's private environment (no secrets: the token is in `--config`). */
  agentDeviceCommand(): AgentDeviceCommand {
    const entry = this.deps.toolchain.toolEntry("agent-device");
    if (!entry) throw new DeviceError("UNAVAILABLE", "agent-device is not installed on this machine yet. Ask the owner to set devices up in Settings → Devices.");
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.env)) if (value !== undefined) env[key] = value;
    return { command: this.nodePath, args: [entry], env };
  }

  async listDevices(): Promise<DeviceSummary[]> {
    const devices: DeviceSummary[] = [];
    for (const profileId of androidProfiles(this.ctx.settings())) {
      const profile = deviceProfile(profileId)!;
      if (!(await this.deps.toolchain.avdStatus(profileId)).created) continue;
      const name = avdName(profileId);
      devices.push({ key: deviceKey(this.id, name), hostId: this.id, id: name, platform: "android", name: profile.label, osVersion: profile.os, profile: profileId, booted: false, leaseId: null });
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

  async boot(request: DeviceBootRequest, signal: AbortSignal, onProgress?: (progress: DeviceHostProgress) => void): Promise<DeviceBootResult> {
    const progress = (step: string, label: string) => onProgress?.({ step, label, state: "running" });
    const profile = request.profile;
    if (profile.platform !== "android") throw new DeviceError("INVALID_ARGUMENT", `${profile.label} is not an Android profile.`);
    if (!this.readiness().ready) {
      const missing = this.checks.filter((check) => check.state !== "ok").map((check) => check.label);
      throw new DeviceError("PLATFORM_NOT_READY", `Android emulators on this machine need setup first: ${missing.join(", ")}. Ask the owner to open Settings → Devices.`);
    }
    if (request.deviceId !== undefined) return this.attachExisting(request);
    if (this.hub.status() !== "running") {
      progress("start-hub", "Starting the device hub");
      await this.startServices(signal);
    }
    const { total } = this.capacityNumbers();
    if (this.leasedCount() + this.reserved.size >= total) {
      throw new DeviceError("DEVICE_CAPACITY", `This machine runs ${this.leasedCount()} of at most ${total} emulators now. Release a device first.`);
    }
    if (!(await this.deps.toolchain.avdStatus(profile.id)).snapshot) {
      progress("prepare-device", `Preparing ${profile.label} for first use (about 4 minutes, once)`);
      try {
        await this.ensureGolden(profile, signal, (p) => onProgress?.({ ...p, step: "prepare-device" }));
      } catch (error) {
        if (signal.aborted) throw new DeviceError("CANCELLED", "The device was released before it finished starting.");
        if (error instanceof DeviceError) throw error;
        // The details (paths, emulator output) go to the daemon log; the agent gets what to do next.
        this.deps.logger.warn(`[devices] preparing ${profile.id} failed: ${errorText(error)}`);
        throw new DeviceError("UNAVAILABLE", `Preparing ${profile.label} for first use failed. Try again; if it keeps failing, ask the owner to check Settings → Devices (the daemon log has the details).`);
      }
    }
    signal.throwIfAborted();
    progress("start-device", `Starting ${profile.label}`);
    const ports = await this.reservePorts();
    const serial = serialOf(ports.consolePort);
    const logPath = join(this.layout.logs, `${serial}.log`);
    let record: EmulatorRecord | null = null;
    let pgid: number | null = null;
    try {
      await rm(logPath, { force: true });
      if (!this.kvm) throw new DeviceError("PLATFORM_NOT_READY", "/dev/kvm is not usable; see Settings → Devices.");
      await this.exec(join(this.layout.sdk, "platform-tools", "adb"), ["start-server"], { env: this.env, timeoutMs: 30_000 });
      pgid = (await spawnEmulator({ sdk: this.layout.sdk, env: this.env, kvm: this.kvm, launch: { avd: avdName(profile.id), consolePort: ports.consolePort, grpcPort: ports.grpcPort }, logPath })).pgid;
      let pid: number | null = null;
      for (let tries = 0; tries < 150 && pid === null; tries++) {
        pid = await findQemuPid(pgid);
        if (pid === null) {
          if (!(await isProcessAlive(pgid))) break;
          await delay(200, signal);
        }
      }
      if (pid === null) throw new Error(`the emulator exited at start: ${await this.logTail(logPath)}`);
      const startTicks = (await LOCAL_EXECUTOR.procStat(pid))?.startTicks;
      record = {
        serial,
        pid,
        pgid,
        ...(startTicks !== undefined ? { startTicks } : {}),
        consolePort: ports.consolePort,
        grpcPort: ports.grpcPort,
        profile: profile.id,
        avd: avdName(profile.id),
        leaseId: request.leaseId,
        golden: false,
        startedAt: new Date().toISOString(),
        logPath
      };
      this.emulators.set(serial, record);
      ports.release();
      await this.persistState();
      this.changed();
      progress("wait-boot", `Waiting for ${profile.label} to boot`);
      const qemu = pid;
      await waitForBootCompleted({
        exec: this.exec,
        adb: join(this.layout.sdk, "platform-tools", "adb"),
        env: this.env,
        serial,
        alive: () => isProcessAlive(qemu),
        signal,
        timeoutMs: BOOT_TIMEOUT_MS
      });
      await this.exec(join(this.layout.sdk, "platform-tools", "adb"), ["-s", serial, "shell", LEASE_BOOT_SCRIPT], { env: this.env, timeoutMs: 30_000 });
    } catch (error) {
      ports.release();
      if (record) await this.stopRecord(record).catch(() => undefined);
      else if (pgid !== null) await signalLauncher(LOCAL_EXECUTOR, pgid, this.marker, "SIGKILL").catch(() => false);
      this.changed();
      if (signal.aborted) throw new DeviceError("CANCELLED", "The device was released before it finished starting.");
      if (error instanceof DeviceError) throw error;
      // The details (the log path, emulator output) go to the daemon log only.
      const reason = error instanceof Error ? error.message : String(error);
      this.deps.logger.warn(`[devices] ${profile.id} on ${serial} did not boot: ${reason} (log: ${logPath})`);
      throw new DeviceError("UNAVAILABLE", bootFailedMessage(profile.label));
    }
    return this.bootResult(record);
  }

  private bootResult(record: EmulatorRecord): DeviceBootResult {
    const profile = deviceProfile(record.profile);
    return {
      deviceId: record.serial,
      name: profile?.label ?? record.avd,
      osVersion: profile?.os ?? "Android",
      ...(profile ? { screen: avdScreen(avdHardware(profile)) } : {}),
      stream: { kind: "serve-emu", deviceParam: record.serial }
    };
  }

  private async attachExisting(request: DeviceBootRequest): Promise<DeviceBootResult> {
    const record = this.emulators.get(request.deviceId!);
    if (!record || record.golden || (record.leaseId !== null && record.leaseId !== request.leaseId) || request.fresh) {
      throw new DeviceError("DEVICE_NOT_FOUND", `${request.deviceId} is not a free emulator on this machine. Open a new device instead.`);
    }
    if (!(await isProcessAlive(record.pid))) throw new DeviceError("DEVICE_NOT_FOUND", `${request.deviceId} is no longer running.`);
    record.leaseId = request.leaseId;
    await this.persistState();
    this.changed();
    return this.bootResult(record);
  }

  async shutdown(deviceId: string): Promise<void> {
    const record = this.emulators.get(deviceId);
    if (record) await this.stopRecord(record);
  }

  async release(lease: StoredDeviceLease, _options: { shutdown: boolean }): Promise<void> {
    // Every lease's emulator is a read-only instance made for it: it always goes.
    if (lease.deviceId === null) return;
    const record = this.emulators.get(lease.deviceId);
    if (!record || (record.leaseId !== null && record.leaseId !== lease.id)) return;
    await this.stopRecord(record);
  }

  private async stopRecord(record: EmulatorRecord): Promise<void> {
    const how = await stopEmulator({
      exec: this.exec,
      adb: join(this.layout.sdk, "platform-tools", "adb"),
      env: this.env,
      serial: record.serial,
      pid: record.pid,
      pgid: record.pgid,
      marker: this.marker,
      startTicks: record.startTicks ?? null
    });
    if (how === "sigkill") this.deps.logger.warn(`[devices] ${record.serial} needed SIGKILL to stop`);
    if (this.emulators.get(record.serial) === record) this.emulators.delete(record.serial);
    if (this.viewers.delete(record.serial)) this.hub.setViewers([...this.viewers.values()].reduce((sum, n) => sum + n, 0));
    await this.persistState();
    this.changed();
  }

  async run(command: "simctl" | "adb", args: readonly string[], options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<DeviceCommandResult> {
    if (command !== "adb") throw new DeviceError("INVALID_ARGUMENT", `${command} does not run on an Android host.`);
    const result = await this.exec(join(this.layout.sdk, "platform-tools", "adb"), args, {
      env: this.env,
      timeoutMs: options.timeoutMs ?? 120_000,
      ...(options.signal ? { signal: options.signal } : {})
    });
    if (result.exitCode === -1) throw new DeviceError("UNAVAILABLE", `adb could not run: ${lastLine(result)}`);
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  }

  async uploadFile(stream: Readable, name: string, signal?: AbortSignal): Promise<{ path: string }> {
    const dir = join(this.layout.uploads, randomUUID());
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, safeFileName(name));
    try {
      await pipeline(stream, createWriteStream(path, { mode: 0o600 }), ...(signal ? [{ signal }] : []));
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
    return { path };
  }

  onChange(listener: () => void): () => void {
    this.events.on("change", listener);
    return () => void this.events.off("change", listener);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private changed(): void {
    if (!this.disposed) this.events.emit("change");
  }

  /** One allocation at a time: two boots probing the same free port concurrently would both take it. */
  private reservePorts(): Promise<{ consolePort: number; grpcPort: number; release(): void }> {
    return this.profileQueue.run(" ports", () => this.reservePortsNow());
  }

  private async reservePortsNow(): Promise<{ consolePort: number; grpcPort: number; release(): void }> {
    const taken = new Set<number>([...this.reserved, ...[...this.emulators.values()].map((record) => record.consolePort)]);
    const ports = await allocateEmulatorPorts(taken);
    if (!ports) throw new DeviceError("DEVICE_CAPACITY", "No free emulator port (5554–5682) is left on this machine.");
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
  }

  private persistState(): Promise<void> {
    const write = async () => {
      await mkdir(dirname(this.layout.stateFile), { recursive: true, mode: 0o700 });
      await writeHostState(this.layout.stateFile, { ...emptyHostState(), hub: this.hubRecord, emulators: [...this.emulators.values()], extra: this.stateExtra });
    };
    this.stateWrites = this.stateWrites.then(write, write).catch((error) => this.deps.logger.warn("[devices] writing the device host state failed", errorText(error)));
    return this.stateWrites;
  }

  /** Emulators and hubs of this appdir that no record names (a crash between spawn and record). */
  private async reapStrays(): Promise<void> {
    const known = new Set([...this.emulators.values()].map((record) => record.pid));
    const hubPid = this.hub.pid();
    for (const stat of await listProcStats()) {
      const isQemu = stat.comm.startsWith("qemu-system");
      if (known.has(stat.pid) || stat.pid === hubPid || stat.pid === process.pid) continue;
      if (isQemu ? !(await processMatches(stat.pid, this.marker)) : !(stat.comm === "node" && (await processMatches(stat.pid, this.marker, [HUB_LAUNCHER])))) continue;
      this.deps.logger.warn(`[devices] stopping a stray ${isQemu ? "emulator" : "device hub"} (pid ${stat.pid}) left by an earlier run`);
      signalGroup(null, stat.pid, "SIGTERM");
      if (!(await waitForExit(stat.pid, 10_000))) signalGroup(null, stat.pid, "SIGKILL");
    }
  }

  private async logTail(path: string): Promise<string> {
    const text = await readFile(path, "utf8").catch(() => "");
    return (
      text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-3)
        .join(" | ") || "no output"
    );
  }

  private async pruneUploads(): Promise<void> {
    const now = Date.now();
    for (const entry of await readdir(this.layout.uploads).catch(() => [] as string[])) {
      const info = await stat(join(this.layout.uploads, entry)).catch(() => null);
      if (info && now - info.mtimeMs > UPLOAD_MAX_AGE_MS) await rm(join(this.layout.uploads, entry), { recursive: true, force: true });
    }
  }
}

/** What an agent or the panel reads when an emulator did not boot (no host paths or emulator output). */
export function bootFailedMessage(label: string): string {
  return `${label} did not start. Try opening it again; if it keeps failing, ask the owner to check Settings → Devices (the daemon log has the details).`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Adds the local host while Android is enabled in Settings → Devices; switching Android off stops
 * its emulators, hub and agent-device daemon. `start` reattaches before it resolves (the service's
 * reconcile runs next); probing and starting the hub continue in the background.
 */
export function createLocalAndroidHostFactory(deps: LocalAndroidHostDeps): DeviceHostFactory {
  let ctx: DeviceHostFactoryContext | null = null;
  let host: LocalAndroidHost | null = null;
  let queue: Promise<void> = Promise.resolve();

  const follow = async (settings: DevicesSettings): Promise<void> => {
    if (!ctx) return;
    if (settings.android.enabled && !host) {
      const next = new LocalAndroidHost(deps, ctx);
      host = next;
      await next.reattach().catch((error) => deps.logger.warn("[devices] reattaching to running emulators failed", errorText(error)));
      ctx.addHost(next);
      void next.start().catch((error) => deps.logger.warn("[devices] the local Android host did not start", errorText(error)));
    } else if (!settings.android.enabled && host) {
      const current = host;
      host = null;
      ctx.removeHost(current.id);
      await current.teardown().catch((error) => deps.logger.warn("[devices] stopping the local Android host failed", errorText(error)));
    } else {
      host?.settingsChanged();
    }
  };
  const enqueue = (settings: DevicesSettings) => {
    queue = queue.then(() => follow(settings)).catch(() => undefined);
    return queue;
  };

  return {
    kind: "local",
    platforms: ["android"],
    async start(context) {
      ctx = context;
      await enqueue(context.settings());
    },
    settingsChanged(settings) {
      void enqueue(settings);
    },
    async stop() {
      await queue;
      const current = host;
      host = null;
      if (ctx && current) ctx.removeHost(current.id);
      await current?.dispose();
      ctx = null;
    }
  };
}
