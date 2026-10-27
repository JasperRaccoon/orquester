/**
 * One box device host (devices spec §6.3): a rented Mac (`kind: "box"`, box purpose `device-host`)
 * or an owner's own Mac flagged for devices (`kind: "byo"`), running iOS simulators. Everything in
 * the box happens over its `BoxConnection` (exec, files, `forwardToHost`).
 *
 * Preparing ({@link BoxDeviceHost.prepare}; the box's `devices` setup step, `ensureReady`, and a
 * reconnect or daemon restart all run it — it is idempotent and reuses what runs):
 * 1. probe (PATH, Node ≥ 22, Xcode + simctl, whether the Mac is a VM);
 * 2. the pinned tools under the box's tools dir (skipped when the device-tools cache restored them);
 * 3. the hub as `orq-agent` detached process `orq-devices-hub` (`--port 0 --require-token`, MJPEG
 *    on VMs), its port and token read from its state file, its port forwarded to this host;
 * 4. the agent-device daemon (state dir in the box, idle timeout off), port and token from its
 *    `daemon.json`, forwarded; the local 0600 `--config` file written;
 * 5. leftover `orq-<leaseId>` simulators of leases that no longer exist are deleted, and (once per
 *    host) agent-device's XCTest runner is warmed in the background on a scratch simulator.
 *
 * 6. simslim (pinned; `simslim.ts`), the slim profile file and the Mac's RAM; then, in the
 *    background, the pre-slimmed pool (`sim-pool.ts`) fills.
 *
 * Leases: `boot` takes a pool simulator of the profile (renamed `orq-<leaseId>`) or creates
 * `orq-<leaseId>` (profile device type, newest iOS runtime) and slims it while shut down
 * (`simslim on`, which boots it), boots it, waits for `bootstatus -b` and then for a real frame (see
 * `simctl.ts`), attaches serve-sim through the hub, and checks the slim state (`simslim verify`) in
 * the background; `release` stops the hub's capture of it, shuts it down and deletes it. Without
 * simslim (an Intel Mac, a runtime before iOS 18.5, a failed install) simulators boot stock.
 * `capacity` comes from host RAM and `simslim top` (`simslim-capacity.ts`).
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { posix } from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import {
  DEVICE_ERROR_CODES,
  DEVICE_PLATFORM_LABELS,
  deviceProfile,
  type DeviceCapacity,
  type DeviceHostBoxInfo,
  type DeviceHostPoolInfo,
  type DeviceHostReadiness,
  type DevicePlatform,
  type DeviceReadinessCheck,
  type DevicesSettings,
  type DeviceSummary
} from "@orquester/api";
import type { StoredBox, StoredDeviceLease } from "@orquester/config";

import type { BoxConnection, BoxHostForward, BoxProcess } from "../../../boxes/contracts.ts";
import { DEVICE_TOOL_VERSIONS, SIMSLIM_INSTALL_SCRIPT, SIMSLIM_RELEASE } from "../../../boxes/github/device-cache.ts";
import { DeviceError, isDeviceError } from "../../errors.ts";
import type { DeviceToolchain } from "../../toolchain/index.ts";
import type {
  AgentDeviceCommand,
  DeviceBootRequest,
  DeviceBootResult,
  DeviceCommandResult,
  DeviceHost,
  DeviceHostProgress,
  DeviceHostState
} from "../../host.ts";
import { boxAgentDeviceConfigPath, removeAgentDeviceConfig, writeAgentDeviceConfig } from "./agent-device-config.ts";
import { ensureLocalAgentDevice, localAgentDeviceEntry } from "./local-agent-device.ts";
import {
  AGENT_DEVICE_START_SCRIPT,
  archiveListingProblem,
  HUB_PROC_ID,
  INSTALL_TOOLS_SCRIPT,
  IOS_HARDWARE_STREAM_FLAGS,
  IOS_VM_STREAM_FLAGS,
  PROBE_SCRIPT,
  agentDeviceEnv,
  execRemote,
  hubCommand,
  installedToolVersion,
  outputTail,
  parseAgentDeviceStart,
  parseHubState,
  parseProbe,
  remoteEnv,
  remoteLayout,
  type RemoteLayout,
  type RemoteProbe,
  type RemoteResult
} from "./remote.ts";
import { SimPool, poolSimulatorName, profileOfPoolSimulator, type PoolSim } from "./sim-pool.ts";
import { simulatorCapacity } from "./simslim-capacity.ts";
import {
  ORQ_SLIM_PROFILE_JSON,
  SIMSLIM_ENV,
  isPinnedSimslim,
  parseSimslimInstall,
  parseSimslimTop,
  parseSimslimVerify,
  simslimBin,
  simslimOnArgs,
  simslimProfilePath,
  simslimTopArgs,
  simslimVerifyArgs,
  slimmableIos,
  type SimslimTop
} from "./simslim.ts";
import {
  FRAME_SIZE_SCRIPT,
  POOL_PREP_SIM_PREFIX,
  WARM_SIM_NAME,
  isRealFrame,
  leaseIdOfSimulator,
  leaseSimulatorName,
  newestIphoneTarget,
  parseSimCatalog,
  parseSimDevices,
  pickSimulatorTarget,
  simDeviceSummary,
  type SimDevice,
  type SimTarget
} from "./simctl.ts";

/** How long things may take (tests shorten them). */
export interface BoxHostTiming {
  /** The hub writing its state file after start. */
  hubStartMs: number;
  /** Between looks at the hub's state file while it starts. */
  hubPollMs: number;
  installMs: number;
  agentStartMs: number;
  commandMs: number;
  bootStatusMs: number;
  /** After `bootstatus`, at most this long for a real frame (then the boot goes on regardless). */
  frameWaitMs: number;
  framePollMs: number;
  /** serve-sim's first capture start (~6 s) and later ones. */
  streamStartMs: number;
  warmMs: number;
  /** `simslim on`: a slim first boot (~35 s on a 6 vCPU Mac; simslim's own deadline is 15 min). */
  slimMs: number;
}

export const DEFAULT_BOX_HOST_TIMING: BoxHostTiming = {
  hubStartMs: 60_000,
  hubPollMs: 500,
  installMs: 15 * 60_000,
  agentStartMs: 4 * 60_000,
  commandMs: 2 * 60_000,
  bootStatusMs: 5 * 60_000,
  frameWaitMs: 45_000,
  framePollMs: 1_500,
  streamStartMs: 3 * 60_000,
  warmMs: 15 * 60_000,
  slimMs: 10 * 60_000
};

/** agent-device's iOS simulator runner build under the box user's home (the runner cache restores it). */
export const APPLE_RUNNER_BUILD_DIR = ".agent-device/apple-runner/derived/ios-simulator";

/** A host whose box's time limit ends within this takes no new lease. */
export const DEADLINE_MARGIN_MS = 20 * 60_000;

export interface BoxDeviceHostDeps {
  boxId: string;
  kind: "box" | "byo";
  label: string;
  /** Phase 1: iOS on Macs. */
  platform: "ios";
  appDir: string;
  /** This machine's pinned tools (the agent-device CLI the actions layer runs here). */
  toolchain?: DeviceToolchain;
  /** The box's record now. */
  record(): StoredBox | undefined;
  /** Its link (whether or not connected now); undefined before it ever connected. */
  connection(): BoxConnection | undefined;
  settings(): DevicesSettings;
  /** Leases on this host that are active now. */
  activeLeases(): readonly StoredDeviceLease[];
  /** Rented hosts: destroy the box (Settings → Devices "Destroy"). */
  destroyBox?(): Promise<void>;
  logger: Pick<Console, "info" | "warn" | "error">;
  fetch?: typeof fetch;
  now?(): number;
  timing?: Partial<BoxHostTiming>;
  /**
   * Pre-slimmed shut-down simulators kept per profile (default {@link DEFAULT_SIM_POOL_SIZE} on
   * rented hosts, 0 on the owner's own Mac: its simulator list stays theirs).
   */
  simPoolSize?: number;
}

/** Pool simulators per profile on a rented host. */
export const DEFAULT_SIM_POOL_SIZE = 2;

type Phase = "pending" | "preparing" | "ready" | "needs-setup" | "failed" | "stopped";

interface Forwarded {
  boxPort: number;
  token: string;
  forward: BoxHostForward;
}

interface HubRuntime extends Forwarded {
  pid: number | null;
}

/** Fix actions (a setup job's `actions`): all of them run `prepare`, which does only what is missing. */
export const BOX_FIX_ACTIONS = { tools: "install-tools", hub: "start-hub", agent: "start-agent-device" } as const;

export class BoxDeviceHost implements DeviceHost {
  readonly id: string;
  readonly kind: "box" | "byo";
  readonly label: string;
  readonly platforms: readonly DevicePlatform[];

  private readonly events = new EventEmitter();
  private readonly timing: BoxHostTiming;
  private phase: Phase = "pending";
  private detail: string | null = null;
  /** The readiness check being worked on while preparing. */
  private working: string | null = null;
  private probe: RemoteProbe | null = null;
  private layoutCache: RemoteLayout | null = null;
  private toolVersions: { hub: string | null; agent: string | null } | null = null;
  private hub: HubRuntime | null = null;
  private agent: Forwarded | null = null;
  private configPath: string | null = null;
  /** The agent-device CLI on this machine (entry script), once found or installed. */
  private localCli: string | null = null;
  private checkedAt: string | null = null;
  private preparing: Promise<void> | null = null;
  private readonly progressListeners = new Set<(progress: DeviceHostProgress) => void>();
  private warming: Promise<void> | null = null;
  private warmed = false;
  /** The profile of each lease's simulator (for `listDevices`; memory only). */
  private readonly leaseProfiles = new Map<string, string>();
  private disposed = false;
  /** Cold boots in line ({@link oneBootAtATime}). */
  private bootQueue: Promise<void> = Promise.resolve();
  private bootsRunning = 0;
  /** Lease boots under way (from their first call, before they queue): the pool waits for them. */
  private leaseBoots = 0;
  /** simslim in the box (null: simulators boot stock). */
  private slim: { bin: string; profilePath: string } | null = null;
  /** The `tool:simslim` readiness check; null before the first prepare. */
  private slimCheck: { ok: boolean; detail: string } | null = null;
  /** `hw.memsize`; null until read. */
  private hostBytes: number | null = null;
  /** The latest `simslim top --json`. */
  private top: SimslimTop | null = null;
  private sampling: Promise<void> | null = null;
  private simPool: SimPool | null = null;
  /** Profiles the pool keeps stocked beyond the default one: those leased on this host. */
  private readonly poolProfiles = new Set<string>();

  constructor(private readonly deps: BoxDeviceHostDeps) {
    this.id = `box:${deps.boxId}`;
    this.kind = deps.kind;
    this.label = deps.label;
    this.platforms = [deps.platform];
    this.timing = { ...DEFAULT_BOX_HOST_TIMING, ...deps.timing };
  }

  get boxId(): string {
    return this.deps.boxId;
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  state(): DeviceHostState {
    if (!this.platformEnabled()) return { status: "disabled", detail: `${DEVICE_PLATFORM_LABELS[this.deps.platform]} is off in Settings → Devices.` };
    const record = this.deps.record();
    if (!record || record.state === "destroyed" || record.state === "destroying" || record.state === "destroy-failed") {
      return { status: "stopping", detail: "The host is being torn down." };
    }
    if (record.state === "pairing") return { status: "needs-setup", detail: "Pair this machine first (Settings → Ephemeral AI VMs)." };
    if (record.state === "provisioning" && this.phase !== "preparing") return { status: "starting", detail: provisioningDetail(record) };
    if (!this.deps.connection()?.connected) {
      return {
        status: "unreachable",
        detail: this.kind === "byo" ? "Your machine is offline (its orq-agent is not connected)." : "Reconnecting to the host…"
      };
    }
    switch (this.phase) {
      case "pending":
        return { status: "starting", detail: "Connecting to the host…" };
      case "preparing":
        return { status: "starting", detail: this.detail ?? "Preparing the host…" };
      case "ready":
        return { status: "ready", detail: null };
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
    if (link?.connected && this.phase !== "preparing") {
      try {
        await this.probeBox(link, signal);
        if (this.hub && !(await this.healthy(this.hub.forward.hostPort, "/readyz"))) this.hubLost("The device hub stopped responding.");
        if (this.agent && !(await this.healthy(this.agent.forward.hostPort, "/health"))) this.agentLost();
        await this.sampleCapacity(link);
      } catch (error) {
        this.deps.logger.warn(`[devices] probing ${this.id} failed`, errorText(error));
      }
    }
    return this.readiness();
  }

  capacity(): DeviceCapacity {
    const leased = this.deps.activeLeases().length;
    if (!this.platformEnabled()) return { used: leased, total: 0 };
    const { total } = simulatorCapacity({
      settingCap: this.deps.settings().ios.maxSimulatorsPerHost,
      hostBytes: this.hostBytes,
      slim: this.slim !== null,
      top: this.top,
      leased
    });
    return { used: leased, total };
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

  hubOrigin(): string | null {
    return this.hub ? `http://127.0.0.1:${this.hub.forward.hostPort}` : null;
  }

  hubToken(): string | null {
    return this.hub?.token ?? null;
  }

  /** serve-sim H.264 needs a hardware encoder: Apple VMs (every Blacksmith Mac) have none. */
  streamCapabilities(): { iosH264: boolean } {
    return { iosH264: this.probe?.vm === false };
  }

  agentDeviceConfigPath(): string | null {
    return this.agent ? this.configPath : null;
  }

  /**
   * The agent-device CLI runs on this machine (this daemon's Node and the pinned install under
   * `devicesToolsDir`) and reaches the box's daemon through the `--config` file's forwarded URL.
   */
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
    if (!link?.connected) {
      throw new DeviceError(DEVICE_ERROR_CODES.PLATFORM_NOT_READY, `${this.label} is not connected${this.kind === "byo" ? ": start orq-agent on it" : ""}.`);
    }
    await this.prepare(link, signal, onProgress);
  }

  /**
   * Install and start what is missing (joins a run in progress). Rejects with a `DeviceError` for
   * the owner; the host is then `needs-setup` (a fix action can retry) or `failed`.
   */
  prepare(link: BoxConnection, signal: AbortSignal, onProgress?: (progress: DeviceHostProgress) => void): Promise<void> {
    if (onProgress) this.progressListeners.add(onProgress);
    const run =
      this.preparing ??
      (this.preparing = this.runPrepare(link, signal).finally(() => {
        this.preparing = null;
        this.progressListeners.clear();
      }));
    return onProgress ? run.finally(() => this.progressListeners.delete(onProgress)) : run;
  }

  private async runPrepare(link: BoxConnection, signal: AbortSignal): Promise<void> {
    this.setPhase("preparing", "Checking the host…");
    try {
      this.step("node", "Checking the host", "running", 5);
      const probe = await this.probeBox(link, signal);
      this.requireBasics(probe);
      this.step("node", "Checking the host", "done", 10, `Node ${probe.nodeVersion}, ${probe.xcode ?? "Xcode"}`);
      const layout = this.layout(link);
      for (const dir of [layout.root, layout.hubState, layout.agentState, layout.uploads]) {
        await link.request("fs.mkdir", { path: dir, recursive: true, mode: 0o700 });
      }

      if (!this.toolsCurrent()) {
        this.working = "tool:expo-device-hub";
        this.step("tool:expo-device-hub", "Installing the device tools", "running", 15);
        this.setDetail("Installing the device tools…");
        const env = { ...remoteEnv(probe), TOOLS: layout.tools };
        const result = await execRemote(
          link,
          { command: "/bin/sh", args: ["-c", INSTALL_TOOLS_SCRIPT], env },
          { signal, timeoutMs: this.timing.installMs, onLine: (line) => this.emitProgress({ step: "tool:expo-device-hub", label: "Installing the device tools", state: "running", logLine: line }) }
        );
        await this.readToolVersions(link);
        if (result.exitCode !== 0 || !this.toolsCurrent()) {
          throw new DeviceError(DEVICE_ERROR_CODES.PLATFORM_NOT_READY, `Installing the device tools on ${this.label} failed: ${outputTail(result.stderr || result.stdout) || `exit ${result.exitCode}`}`);
        }
        this.step("tool:expo-device-hub", "Installing the device tools", "done", 45);
      } else {
        this.step("tool:expo-device-hub", "Device tools", "skipped", 45, "Already installed");
      }

      this.working = "hub";
      this.step("hub", "Starting the device hub", "running", 50);
      this.setDetail("Starting the device hub…");
      await this.ensureHub(link, probe, layout, signal);
      this.step("hub", "Starting the device hub", "done", 70);

      this.working = "agent-device";
      this.step("agent-device", "Starting agent-device", "running", 75);
      this.setDetail("Starting agent-device…");
      await this.ensureAgentDevice(link, probe, layout, signal);
      this.step("agent-device", "Starting agent-device", "done", 90);

      this.working = "tool:agent-device-local";
      this.step("tool:agent-device-local", "agent-device on this machine", "running", 92);
      this.localCli = await ensureLocalAgentDevice({ appDir: this.deps.appDir, ...(this.deps.toolchain ? { toolchain: this.deps.toolchain } : {}), signal }).catch((error: unknown) => {
        throw new DeviceError(DEVICE_ERROR_CODES.PLATFORM_NOT_READY, `Installing agent-device on this machine failed: ${errorText(error)}`);
      });
      this.step("tool:agent-device-local", "agent-device on this machine", "done", 97);

      this.working = "tool:simslim";
      this.step("tool:simslim", "simslim (slim simulators)", "running", 98);
      await this.ensureSimslim(link, probe, layout, signal);
      this.step("tool:simslim", "simslim (slim simulators)", "done", 99, this.slimCheck?.detail);

      this.working = null;
      await this.removeLeftovers(link, signal).catch((error) => this.deps.logger.warn(`[devices] cleaning ${this.id}'s leftover simulators failed`, errorText(error)));
      this.checkedAt = new Date(this.now()).toISOString();
      this.setPhase("ready", null);
      this.emitProgress({ step: "ready", label: "Ready", state: "done", percent: 100 });
      this.startWarm(link);
      void this.sampleCapacity(link);
      this.simPool?.reset();
      this.simPool?.kick();
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
      // What a fix action can retry leaves the host needing setup; Node or Xcode missing needs the owner.
      const fixable = failedCheck !== null;
      this.setPhase(fixable ? "needs-setup" : "failed", message);
      throw isDeviceError(error) ? error : new DeviceError(DEVICE_ERROR_CODES.PLATFORM_NOT_READY, message);
    }
  }

  private requireBasics(probe: RemoteProbe): void {
    if (probe.nodePath === null || probe.nodeMajor === null || probe.nodeMajor < 22) {
      throw new DeviceError(
        DEVICE_ERROR_CODES.PLATFORM_NOT_READY,
        `${this.label} needs Node.js 22 or newer${probe.nodeVersion ? ` (it has ${probe.nodeVersion})` : ""}: install it there, then try again.`
      );
    }
    if (this.deps.platform === "ios" && (probe.os !== "Darwin" || !probe.simctl)) {
      throw new DeviceError(DEVICE_ERROR_CODES.PLATFORM_NOT_READY, `${this.label} has no Xcode with iOS simulators (xcrun simctl): install Xcode there, then try again.`);
    }
  }

  private async probeBox(link: BoxConnection, signal?: AbortSignal): Promise<RemoteProbe> {
    const result = await execRemote(link, { command: "/bin/sh", args: ["-c", PROBE_SCRIPT] }, { ...(signal ? { signal } : {}), timeoutMs: this.timing.commandMs });
    const probe = parseProbe(result.stdout);
    this.probe = probe;
    await this.readToolVersions(link);
    return probe;
  }

  private layout(link: BoxConnection): RemoteLayout {
    this.layoutCache ??= remoteLayout({ provider: this.deps.record()?.provider ?? "byo", home: link.sys.home });
    return this.layoutCache;
  }

  private async readToolVersions(link: BoxConnection): Promise<void> {
    const layout = this.layout(link);
    const read = (name: string) => readSmallFile(link, posix.join(layout.tools, "node_modules", name, "package.json")).then(installedToolVersion);
    const [hub, agent] = await Promise.all([read("expo-device-hub"), read("agent-device")]);
    this.toolVersions = { hub, agent };
  }

  private toolsCurrent(): boolean {
    return this.toolVersions?.hub === DEVICE_TOOL_VERSIONS["expo-device-hub"] && this.toolVersions?.agent === DEVICE_TOOL_VERSIONS["agent-device"];
  }

  /** Reuse the running hub (after a restart: its detached process and state file), or start one. */
  private async ensureHub(link: BoxConnection, probe: RemoteProbe, layout: RemoteLayout, signal: AbortSignal): Promise<void> {
    if (this.hub && (await this.healthy(this.hub.forward.hostPort, "/readyz"))) return;
    await this.closeHub();
    const procs = await link.request("proc.list", {});
    const existing = procs.find((proc) => proc.procId === HUB_PROC_ID);
    if (existing?.running) {
      const state = await this.findHubState(link, layout, existing.pid);
      if (state?.token) {
        const forward = await link.forwardToHost(state.port);
        if (await this.healthy(forward.hostPort, "/readyz")) {
          this.hub = { boxPort: state.port, token: state.token, forward, pid: state.pid };
          return;
        }
        await forward.close().catch(() => undefined);
      }
      await this.stopHubProcess(link);
    } else if (existing) {
      await link.request("proc.release", { procId: HUB_PROC_ID }).catch(() => undefined);
    }
    await this.clearHubStates(link, layout);

    const flags = this.deps.platform === "ios" ? (probe.vm === false ? IOS_HARDWARE_STREAM_FLAGS : IOS_VM_STREAM_FLAGS) : [];
    const proc = link.exec(hubCommand({ nodePath: probe.nodePath!, layout, platform: this.deps.platform, streamFlags: flags, env: remoteEnv(probe) }));
    let stderr = "";
    let exited: string | null = null;
    proc.stdout.resume();
    proc.stderr.on("data", (chunk: Buffer | string) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    proc.once("exit", (code, sig) => {
      exited = `exit ${code ?? sig ?? "?"}`;
      if (this.hub && (this.hub.pid === null || this.hub.pid === proc.pid)) this.hubLost(`The device hub stopped (${exited}).`);
    });
    proc.once("error", (error) => {
      exited = error.message;
    });
    const deadline = this.now() + this.timing.hubStartMs;
    for (;;) {
      signal.throwIfAborted();
      if (exited !== null) throw new DeviceError(DEVICE_ERROR_CODES.PLATFORM_NOT_READY, `The device hub on ${this.label} exited at start (${exited}): ${outputTail(stderr) || "no output"}`);
      const state = await this.findHubState(link, layout, proc.pid);
      if (state?.token) {
        const forward = await link.forwardToHost(state.port);
        if (await this.healthy(forward.hostPort, "/readyz")) {
          this.hub = { boxPort: state.port, token: state.token, forward, pid: state.pid };
          return;
        }
        await forward.close().catch(() => undefined);
      }
      if (this.now() > deadline) {
        await this.stopHubProcess(link).catch(() => undefined);
        throw new DeviceError(DEVICE_ERROR_CODES.PLATFORM_NOT_READY, `The device hub on ${this.label} did not start within ${Math.round(this.timing.hubStartMs / 1000)} s: ${outputTail(stderr) || "no output"}`);
      }
      // The hub signals readiness only through its state file: look again shortly.
      await delay(this.timing.hubPollMs, undefined, { signal });
    }
  }

  /** The hub state file of `pid` (any, when the pid is unknown). */
  private async findHubState(link: BoxConnection, layout: RemoteLayout, pid: number | null): Promise<ReturnType<typeof parseHubState>> {
    const entries = await link.request("fs.readdir", { path: layout.hubState }).catch(() => []);
    for (const entry of entries) {
      if (!/^server-\d+\.json$/.test(entry.name)) continue;
      const state = parseHubState((await readSmallFile(link, posix.join(layout.hubState, entry.name))) ?? "");
      if (state && (pid === null || state.pid === pid)) return state;
    }
    return null;
  }

  private async clearHubStates(link: BoxConnection, layout: RemoteLayout): Promise<void> {
    const entries = await link.request("fs.readdir", { path: layout.hubState }).catch(() => []);
    for (const entry of entries) {
      if (/^server-\d+\.json$/.test(entry.name)) await link.request("fs.rm", { path: posix.join(layout.hubState, entry.name), force: true }).catch(() => undefined);
    }
  }

  private async stopHubProcess(link: BoxConnection): Promise<void> {
    await link.request("proc.signal", { procId: HUB_PROC_ID, signal: "SIGTERM" }).catch(() => undefined);
    // serve-sim's shutdown takes a few seconds; then the process record is released.
    const deadline = this.now() + 15_000;
    while (this.now() < deadline) {
      const proc = (await link.request("proc.list", {}).catch(() => [])).find((entry) => entry.procId === HUB_PROC_ID);
      if (!proc?.running) break;
      await delay(250);
    }
    await link.request("proc.signal", { procId: HUB_PROC_ID, signal: "SIGKILL" }).catch(() => undefined);
    await link.request("proc.release", { procId: HUB_PROC_ID }).catch(() => undefined);
  }

  private async ensureAgentDevice(link: BoxConnection, probe: RemoteProbe, layout: RemoteLayout, signal: AbortSignal): Promise<void> {
    if (!(this.agent && (await this.healthy(this.agent.forward.hostPort, "/health")))) {
      await this.closeAgent();
      const result = await execRemote(
        link,
        { command: probe.nodePath!, args: ["-e", AGENT_DEVICE_START_SCRIPT], env: { ...agentDeviceEnv(layout, remoteEnv(probe)), ORQ_AD_ENTRY: layout.agentDeviceEntry }, cwd: layout.root },
        { signal, timeoutMs: this.timing.agentStartMs }
      );
      const started = result.exitCode === 0 ? parseAgentDeviceStart(result.stdout) : null;
      if (!started) throw new DeviceError(DEVICE_ERROR_CODES.PLATFORM_NOT_READY, `agent-device did not start on ${this.label}: ${outputTail(result.stderr) || `exit ${result.exitCode}`}`);
      const forward = await link.forwardToHost(started.httpPort);
      if (!(await this.healthy(forward.hostPort, "/health"))) {
        await forward.close().catch(() => undefined);
        throw new DeviceError(DEVICE_ERROR_CODES.PLATFORM_NOT_READY, `agent-device on ${this.label} is not reachable through the box link.`);
      }
      this.agent = { boxPort: started.httpPort, token: started.token, forward };
    }
    this.configPath = await writeAgentDeviceConfig(boxAgentDeviceConfigPath(this.deps.appDir, this.id), {
      baseUrl: `http://127.0.0.1:${this.agent.forward.hostPort}`,
      token: this.agent.token
    });
  }

  /** Simulators of leases that no longer exist (a restart, a failed release) and the warm-up one. */
  private async removeLeftovers(link: BoxConnection, signal: AbortSignal): Promise<void> {
    const live = new Set(this.deps.activeLeases().map((lease) => lease.id));
    const adopted: PoolSim[] = [];
    for (const device of await this.simDevices(link, signal)) {
      const leaseId = leaseIdOfSimulator(device.name);
      const poolProfile = profileOfPoolSimulator(device.name);
      // A pool simulator someone booted, or one a stopped daemon left half-made, is not ready.
      const stalePool = (poolProfile !== null && (device.state !== "Shutdown" || !this.simPool)) || (device.name.startsWith(POOL_PREP_SIM_PREFIX) && !this.simPool?.busy);
      const stale = (leaseId !== null && !live.has(leaseId)) || (device.name === WARM_SIM_NAME && !this.warming) || stalePool;
      if (stale) await this.deleteSimulator(link, device.udid, signal);
      else if (poolProfile !== null) adopted.push({ udid: device.udid, profileId: poolProfile, runtimeId: device.runtimeId });
    }
    this.simPool?.adopt(adopted);
    await link.request("fs.rm", { path: this.layout(link).uploads, recursive: true, force: true }).catch(() => undefined);
    await link.request("fs.mkdir", { path: this.layout(link).uploads, recursive: true, mode: 0o700 }).catch(() => undefined);
  }

  /**
   * Build and launch agent-device's XCTest runner once (first use takes ~30 s): a scratch simulator
   * opens Settings and takes an interactive snapshot through this host's agent-device daemon, then
   * is deleted. Background; a failure only means the first agent snapshot is slow.
   */
  private startWarm(link: BoxConnection): void {
    if (this.deps.platform !== "ios" || this.warmed || this.warming) return;
    this.warming = this.warmRunner(link)
      .then(
        () => {
          this.warmed = true;
        },
        (error) => this.deps.logger.warn(`[devices] warming agent-device on ${this.id} failed`, errorText(error))
      )
      .finally(() => {
        this.warming = null;
        this.simPool?.kick();
      });
  }

  /** Resolves once a warm-up started by `prepare` finished (tests, the integration run). */
  async warmSettled(): Promise<boolean> {
    await this.warming;
    return this.warmed;
  }

  private async warmRunner(link: BoxConnection): Promise<void> {
    const probe = this.probe;
    if (!probe?.nodePath) return;
    const layout = this.layout(link);
    // Once per box (not per daemon start: a second warm-up beside booting leases doubles their boot
    // time on a 6 vCPU Mac): its marker names the agent-device and Xcode it was built for. A
    // Blacksmith box that restored the runner cache (keyed by both) needs none.
    const marker = posix.join(layout.root, "apple-runner-warmed");
    const built = `agent-device ${DEVICE_TOOL_VERSIONS["agent-device"]}; ${probe.xcode ?? "Xcode"}`;
    if ((await readSmallFile(link, marker))?.trim() === built) return;
    const restored =
      this.kind === "box" &&
      (await link.request("fs.stat", { path: posix.join(link.sys.home, APPLE_RUNNER_BUILD_DIR) }).catch(() => null))?.kind === "dir";
    if (!restored) await this.buildRunner(link, probe, layout);
    await link.writeFile(marker, `${built}\n`, { mode: 0o600 });
  }

  private async buildRunner(link: BoxConnection, probe: RemoteProbe, layout: RemoteLayout): Promise<void> {
    const signal = AbortSignal.timeout(this.timing.warmMs);
    const catalog = parseSimCatalog((await this.simctl(link, ["list", "-j", "devicetypes", "runtimes"], signal)).stdout);
    const target = newestIphoneTarget(catalog);
    if (!target) throw new Error("no iOS runtime with an iPhone simulator");
    const udid = (await this.simctl(link, ["create", WARM_SIM_NAME, target.deviceTypeId, target.runtimeId], signal)).stdout.trim();
    try {
      await this.simctl(link, ["boot", udid], signal);
      await this.simctl(link, ["bootstatus", udid, "-b"], signal, this.timing.bootStatusMs);
      const env = agentDeviceEnv(layout, remoteEnv(probe));
      const agentDevice = async (args: string[]) => {
        const result = await execRemote(link, { command: probe.nodePath!, args: [layout.agentDeviceEntry, ...args], env, cwd: layout.root }, { signal });
        if (result.exitCode !== 0) throw new Error(`agent-device ${args[0]} failed: ${outputTail(result.stderr || result.stdout)}`);
      };
      await agentDevice(["open", "com.apple.Preferences", "--platform", "ios", "--udid", udid, "--session", "orq-warm"]);
      await agentDevice(["snapshot", "-i", "--session", "orq-warm"]);
      await agentDevice(["close", "--session", "orq-warm"]).catch(() => undefined);
    } finally {
      await this.deleteSimulator(link, udid, AbortSignal.timeout(this.timing.commandMs)).catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // simslim: install, pool, capacity
  // -------------------------------------------------------------------------

  /**
   * Install the pinned simslim (skipped when the tools cache restored it), write the slim profile
   * and read the Mac's RAM. Never fails the prepare: without simslim, simulators boot stock.
   */
  private async ensureSimslim(link: BoxConnection, probe: RemoteProbe, layout: RemoteLayout, signal: AbortSignal): Promise<void> {
    if (this.deps.platform !== "ios") return;
    this.hostBytes = await this.readHostBytes(link, signal);
    try {
      const result = await execRemote(
        link,
        { command: "/bin/sh", args: ["-c", SIMSLIM_INSTALL_SCRIPT, "simslim-install"], env: { ...remoteEnv(probe), TOOLS: layout.tools } },
        { signal, timeoutMs: this.timing.commandMs }
      );
      const install = result.exitCode === 0 ? parseSimslimInstall(result.stdout) : null;
      if (install?.kind === "unsupported") {
        this.slim = null;
        this.slimCheck = { ok: true, detail: `Not used on this Mac (${install.reason}): simulators run stock` };
        return;
      }
      if (!isPinnedSimslim(install)) throw new Error(outputTail(result.stderr || result.stdout) || `exit ${result.exitCode}`);
      const profilePath = simslimProfilePath(layout.root);
      await link.writeFile(profilePath, ORQ_SLIM_PROFILE_JSON, { mode: 0o600 });
      this.slim = { bin: simslimBin(layout.tools), profilePath };
      this.slimCheck = { ok: true, detail: SIMSLIM_RELEASE.version };
      const size = this.deps.simPoolSize ?? (this.kind === "box" ? DEFAULT_SIM_POOL_SIZE : 0);
      if (size > 0 && !this.simPool) this.simPool = this.createPool(size);
    } catch (error) {
      if (signal.aborted) throw error;
      this.slim = null;
      this.slimCheck = { ok: false, detail: `Not installed (${errorText(error)}): simulators run stock` };
      this.deps.logger.warn(`[devices] installing simslim on ${this.id} failed; simulators boot stock`, errorText(error));
    }
  }

  private async readHostBytes(link: BoxConnection, signal: AbortSignal): Promise<number | null> {
    const result = await execRemote(link, { command: "/usr/sbin/sysctl", args: ["-n", "hw.memsize"] }, { signal, timeoutMs: this.timing.commandMs }).catch(() => null);
    const bytes = Number(result?.stdout.trim());
    return result?.exitCode === 0 && Number.isFinite(bytes) && bytes > 0 ? bytes : null;
  }

  private async runSimslim(link: BoxConnection, args: string[], signal?: AbortSignal, timeoutMs = this.timing.commandMs): Promise<RemoteResult> {
    if (!this.slim) throw new DeviceError("UNAVAILABLE", `simslim is not installed on ${this.label}.`);
    const env = { ...(this.probe ? remoteEnv(this.probe) : {}), ...SIMSLIM_ENV };
    return execRemote(link, { command: this.slim.bin, args, env }, { ...(signal ? { signal } : {}), timeoutMs });
  }

  private createPool(size: number): SimPool {
    return new SimPool({
      size,
      logger: this.deps.logger,
      targets: () => {
        const enabled = this.deps.settings().ios.profiles;
        return [...new Set([enabled[0], ...this.poolProfiles].filter((id): id is string => typeof id === "string" && enabled.includes(id)))];
      },
      idle: () => this.isReady() && this.leaseBoots === 0 && this.bootsRunning === 0 && !this.warming && !this.draining(),
      exclusive: (signal, work) => this.oneBootAtATime(signal, () => undefined, work),
      ops: { make: (profileId, signal) => this.makePoolSimulator(this.requireLink(), profileId, signal) }
    });
  }

  /** Create `orq-poolprep-<id>`, slim it (one boot, back to shut down), name it `orq-pool-<profile>.<id>`. */
  private async makePoolSimulator(link: BoxConnection, profileId: string, signal: AbortSignal): Promise<PoolSim> {
    const profile = deviceProfile(profileId);
    if (!profile || !this.slim) throw new Error(`no profile ${profileId} or no simslim`);
    const catalog = parseSimCatalog((await this.simctl(link, ["list", "-j", "devicetypes", "runtimes"], signal)).stdout);
    const target = pickSimulatorTarget(catalog, profile);
    if (!target || !slimmableIos(target.osVersion)) throw new Error(`no iOS 18.5+ simulator for ${profile.label}`);
    const id = randomUUID().slice(0, 8);
    const udid = await this.createSimulator(link, `${POOL_PREP_SIM_PREFIX}${id}`, target.deviceTypeId, target.runtimeId, signal);
    try {
      const slimmed = await this.runSimslim(link, simslimOnArgs({ udid, profilePath: this.slim.profilePath, preserveBootState: true }), signal, this.timing.slimMs);
      if (slimmed.exitCode !== 0) throw new Error(`simslim on failed: ${outputTail(slimmed.stderr || slimmed.stdout) || `exit ${slimmed.exitCode}`}`);
      await this.simctl(link, ["rename", udid, poolSimulatorName(profileId, id)], signal);
      return { udid, profileId, runtimeId: target.runtimeId };
    } catch (error) {
      await this.deleteSimulator(link, udid, AbortSignal.timeout(this.timing.commandMs)).catch(() => undefined);
      throw error;
    }
  }

  /** After a lease's slim boot: its overrides match the profile, else apply what is missing live (no reboot). */
  private async verifySlim(link: BoxConnection, udid: string): Promise<void> {
    if (!this.slim) return;
    try {
      const verified = parseSimslimVerify((await this.runSimslim(link, simslimVerifyArgs({ udid, profilePath: this.slim.profilePath }))).stdout);
      if (verified?.ok !== false) return;
      this.deps.logger.warn(`[devices] ${udid} on ${this.id} is not slim (${verified.missing.length} missing, ${verified.extra.length} extra); slimming it live`);
      await this.runSimslim(link, simslimOnArgs({ udid, profilePath: this.slim.profilePath, noReboot: true }), undefined, this.timing.slimMs);
    } catch (error) {
      this.deps.logger.warn(`[devices] verifying ${udid}'s slim state on ${this.id} failed`, errorText(error));
    }
  }

  /** Resolves once the pool's refill in progress ended (tests, the integration run). */
  async poolSettled(): Promise<Record<string, number>> {
    await this.simPool?.settled();
    return this.simPool?.counts() ?? {};
  }

  /** A simulator booted or went: measure again, then refill the pool. */
  private afterDeviceChange(link: BoxConnection): void {
    void this.sampleCapacity(link).finally(() => this.simPool?.kick());
  }

  /** `simslim top --json` (memory of every booted simulator) for {@link capacity}. */
  private sampleCapacity(link: BoxConnection): Promise<void> {
    if (!this.slim || !link.connected) return Promise.resolve();
    this.sampling ??= this.runSimslim(link, simslimTopArgs())
      .then((result) => {
        const top = result.exitCode === 0 ? parseSimslimTop(result.stdout) : null;
        if (!top) return;
        const before = this.capacity().total;
        this.top = top;
        if (this.capacity().total !== before) this.emitChange();
      })
      .catch((error) => this.deps.logger.warn(`[devices] measuring ${this.id}'s simulators failed`, errorText(error)))
      .finally(() => {
        this.sampling = null;
      });
    return this.sampling;
  }

  // -------------------------------------------------------------------------
  // Devices
  // -------------------------------------------------------------------------

  async listDevices(signal?: AbortSignal): Promise<DeviceSummary[]> {
    const link = this.requireLink();
    return (await this.simDevices(link, signal)).flatMap((device) => simDeviceSummary(this.id, device, (leaseId) => this.leaseProfiles.get(leaseId) ?? null) ?? []);
  }

  async boot(request: DeviceBootRequest, signal: AbortSignal, onProgress?: (progress: DeviceHostProgress) => void): Promise<DeviceBootResult> {
    const link = this.requireReady();
    const progress = (step: string, label: string) => onProgress?.({ step, label, state: "running" });
    if (request.deviceId !== undefined) return this.attachExisting(link, request, signal, progress);

    progress("create-device", `Creating the ${request.profile.label} simulator`);
    const catalog = parseSimCatalog((await this.simctl(link, ["list", "-j", "devicetypes", "runtimes"], signal)).stdout);
    const target = pickSimulatorTarget(catalog, request.profile);
    if (!target) {
      throw new DeviceError(
        DEVICE_ERROR_CODES.PLATFORM_NOT_READY,
        `${this.label} has no ${request.profile.label} simulator in its Xcode (looked for ${(request.profile.simDeviceTypes ?? []).join(", ") || "no device type"}). Pick another profile.`
      );
    }
    const name = leaseSimulatorName(request.leaseId);
    this.poolProfiles.add(request.profile.id);
    // A refill holding the boot slot gives it up now, and none starts until this boot is done.
    this.leaseBoots += 1;
    this.simPool?.preempt();
    try {
      return await this.bootNew(link, request, target, name, signal, progress);
    } finally {
      this.leaseBoots -= 1;
      this.simPool?.kick();
    }
  }

  private async bootNew(
    link: BoxConnection,
    request: DeviceBootRequest,
    target: SimTarget,
    name: string,
    signal: AbortSignal,
    progress: (step: string, label: string) => void
  ): Promise<DeviceBootResult> {
    // A retry after a restart may find the lease's earlier simulator.
    for (const device of await this.simDevices(link, signal)) {
      if (device.name === name) await this.deleteSimulator(link, device.udid, signal);
    }
    const slim = this.slim && slimmableIos(target.osVersion) ? this.slim : null;
    const pooled = slim ? await this.takePooled(link, request.profile.id, target.runtimeId, name, signal) : null;
    const udid = pooled ?? (await this.createSimulator(link, name, target.deviceTypeId, target.runtimeId, signal));
    this.leaseProfiles.set(request.leaseId, request.profile.id);
    try {
      await this.bootAndAttach(link, udid, signal, progress, false, pooled ? "pooled" : slim ? "slim" : "stock");
    } catch (error) {
      this.leaseProfiles.delete(request.leaseId);
      await this.deleteSimulator(link, udid, AbortSignal.timeout(this.timing.commandMs)).catch(() => undefined);
      throw error;
    }
    this.emitChange();
    if (slim) void this.verifySlim(link, udid);
    this.afterDeviceChange(link);
    return { deviceId: udid, name: request.profile.label, osVersion: `iOS ${target.osVersion}`, stream: { kind: "serve-sim", deviceParam: udid } };
  }

  private async createSimulator(link: BoxConnection, name: string, deviceTypeId: string, runtimeId: string, signal: AbortSignal): Promise<string> {
    const udid = (await this.simctl(link, ["create", name, deviceTypeId, runtimeId], signal)).stdout.trim();
    if (!/^[0-9A-F-]{36}$/i.test(udid)) throw new DeviceError("UNAVAILABLE", `simctl create returned no simulator id on ${this.label}.`);
    return udid;
  }

  /** A ready pool simulator of the profile renamed for the lease, or null (none, or the rename failed). */
  private async takePooled(link: BoxConnection, profileId: string, runtimeId: string, name: string, signal: AbortSignal): Promise<string | null> {
    const sim = this.simPool?.take(profileId, runtimeId);
    if (!sim) return null;
    const renamed = await this.simctl(link, ["rename", sim.udid, name], signal, this.timing.commandMs, true);
    if (renamed.exitCode === 0) return sim.udid;
    this.deps.logger.warn(`[devices] renaming pool simulator ${sim.udid} on ${this.id} failed`, outputTail(renamed.stderr));
    await this.deleteSimulator(link, sim.udid, signal).catch(() => undefined);
    return null;
  }

  private async attachExisting(link: BoxConnection, request: DeviceBootRequest, signal: AbortSignal, progress: (step: string, label: string) => void): Promise<DeviceBootResult> {
    const device = (await this.simDevices(link, signal)).find((entry) => entry.udid === request.deviceId);
    if (!device) throw new DeviceError(DEVICE_ERROR_CODES.DEVICE_NOT_FOUND, `${this.label} has no simulator ${request.deviceId}.`);
    if (request.fresh && device.state === "Booted") throw new DeviceError(DEVICE_ERROR_CODES.DEVICE_BUSY, `${device.name} is already running; open a new one instead.`);
    await this.bootAndAttach(link, device.udid, signal, progress, device.state === "Booted");
    return { deviceId: device.udid, name: device.name, osVersion: `iOS ${device.osVersion}`, stream: { kind: "serve-sim", deviceParam: device.udid } };
  }

  /**
   * `mode`: `stock` boots it; `slim` (a new simulator) slims it while shut down, which boots it
   * (stock when slimming fails); `pooled` boots a pool simulator, already slim.
   */
  private async bootAndAttach(
    link: BoxConnection,
    udid: string,
    signal: AbortSignal,
    progress: (step: string, label: string) => void,
    booted = false,
    mode: "stock" | "slim" | "pooled" = "stock"
  ): Promise<void> {
    await this.oneBootAtATime(signal, () => progress("boot-queue", "Waiting for another device on this host to finish booting"), async () => {
      if (!booted && mode === "slim" && this.slim) {
        progress("boot", "Booting iOS (slim)");
        const slimmed = await this.runSimslim(link, simslimOnArgs({ udid, profilePath: this.slim.profilePath }), signal, this.timing.slimMs);
        if (slimmed.exitCode !== 0) {
          this.deps.logger.warn(`[devices] slimming ${udid} on ${this.id} failed; booting it stock`, outputTail(slimmed.stderr || slimmed.stdout));
          const boot = await this.simctl(link, ["boot", udid], signal, this.timing.commandMs, true);
          if (boot.exitCode !== 0 && !/current state: Booted/i.test(boot.stderr)) {
            throw new DeviceError("UNAVAILABLE", `simctl boot failed on ${this.label}: ${outputTail(boot.stderr || boot.stdout) || `exit ${boot.exitCode}`}`);
          }
        }
      } else if (!booted) {
        progress("boot", "Booting iOS");
        await this.simctl(link, ["boot", udid], signal);
      }
      await this.simctl(link, ["bootstatus", udid, "-b"], signal, this.timing.bootStatusMs);
      progress("first-frame", "Waiting for the home screen");
      await this.waitForFrame(link, udid, signal);
    });
    progress("connect-video", "Connecting the video");
    await this.hubPost("/vendor/serve-sim/grid/api/start", { udid }, signal, this.timing.streamStartMs);
  }

  /**
   * Cold boots run one at a time per host: two at once saturate a 6 vCPU Mac (integration run:
   * ~70 s each instead of ~37 s), so queueing gets the first device ready sooner at the same total.
   */
  private async oneBootAtATime(signal: AbortSignal, onQueued: () => void, run: () => Promise<void>): Promise<void> {
    const previous = this.bootQueue;
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    this.bootQueue = previous.then(() => mine);
    try {
      if (this.bootsRunning > 0) onQueued();
      this.bootsRunning += 1;
      await Promise.race([previous, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
      await run();
    } finally {
      this.bootsRunning -= 1;
      release();
    }
  }

  /** Until a screenshot is a rendered screen, not the boot logo (bounded: the boot goes on after {@link BoxHostTiming.frameWaitMs}). */
  private async waitForFrame(link: BoxConnection, udid: string, signal: AbortSignal): Promise<{ bytes: number; waitedMs: number; real: boolean }> {
    const started = this.now();
    const file = posix.join(this.layout(link).root, `frame-${udid}.png`);
    let bytes = 0;
    for (;;) {
      const result = await execRemote(link, { command: "/bin/sh", args: ["-c", FRAME_SIZE_SCRIPT, "frame", udid, file] }, { signal, timeoutMs: this.timing.commandMs });
      bytes = Number(result.stdout.trim()) || 0;
      if (isRealFrame(bytes)) return { bytes, waitedMs: this.now() - started, real: true };
      if (this.now() - started >= this.timing.frameWaitMs) {
        this.deps.logger.warn(`[devices] ${udid} on ${this.id} showed no rendered frame within ${Math.round(this.timing.frameWaitMs / 1000)} s (last ${bytes} bytes); going on`);
        return { bytes, waitedMs: this.now() - started, real: false };
      }
      // simctl has no "first frame" signal: look again shortly.
      await delay(this.timing.framePollMs, undefined, { signal });
    }
  }

  async shutdown(deviceId: string, signal?: AbortSignal): Promise<void> {
    const link = this.requireLink();
    await this.stopDevice(link, deviceId, signal ?? AbortSignal.timeout(this.timing.commandMs));
  }

  /** Stop the hub's capture of the device (before `simctl shutdown`: spike), then shut it down. */
  private async stopDevice(link: BoxConnection, udid: string, signal: AbortSignal): Promise<void> {
    if (this.hub) await this.hubPost("/vendor/serve-sim/grid/api/shutdown", { udid }, signal, this.timing.commandMs).catch(() => undefined);
    const result = await this.simctl(link, ["shutdown", udid], signal, this.timing.commandMs, true);
    if (result.exitCode !== 0 && !/current state: Shutdown|Unable to shutdown device in current state: Shutdown/i.test(result.stderr)) {
      throw new DeviceError("UNAVAILABLE", `Shutting down ${udid} failed: ${outputTail(result.stderr)}`);
    }
  }

  async release(lease: StoredDeviceLease, options: { shutdown: boolean }): Promise<void> {
    const udid = lease.deviceId;
    this.leaseProfiles.delete(lease.id);
    if (!udid) return;
    const link = this.deps.connection();
    // Unreachable: the next prepare deletes the lease's simulator as a leftover.
    if (!link?.connected) return;
    const signal = AbortSignal.timeout(this.timing.commandMs * 2);
    const device = (await this.simDevices(link, signal)).find((entry) => entry.udid === udid);
    if (!device) return;
    const owned = device.name === leaseSimulatorName(lease.id);
    if (owned || options.shutdown) await this.stopDevice(link, udid, signal).catch((error) => this.deps.logger.warn(`[devices] stopping ${udid} on ${this.id} failed`, errorText(error)));
    if (owned) await this.deleteSimulator(link, udid, signal);
    this.emitChange();
    this.afterDeviceChange(link);
  }

  async run(command: "simctl" | "adb", args: readonly string[], options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<DeviceCommandResult> {
    if (command !== "simctl") throw new DeviceError("INVALID_ARGUMENT", `${this.label} runs iOS simulators: there is no adb there.`);
    const link = this.requireLink();
    return this.simctl(link, [...args], options.signal, options.timeoutMs ?? this.timing.commandMs, true);
  }

  /**
   * Stream a build into the box's uploads dir (a fresh random directory). A `.zip`/`.ipa` or
   * tarball is listed first and refused unless every entry stays inside ({@link archiveListingProblem}:
   * no absolute path, no `..`, no link out), then unpacked into a new `unpacked` directory there,
   * and the `.app` inside is what resolves (what `simctl install` takes); otherwise the file itself.
   */
  async uploadFile(stream: Readable, name: string, signal?: AbortSignal): Promise<{ path: string }> {
    const link = this.requireLink();
    const safe = posix.basename(name).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "") || "build";
    const dir = posix.join(this.layout(link).uploads, randomUUID());
    const file = posix.join(dir, safe);
    await link.writeFile(file, stream, { mkdirs: true, mode: 0o600 });
    signal?.throwIfAborted();
    const kind = /\.(zip|ipa)$/i.test(safe) ? "zip" : /\.(tar|tar\.gz|tgz)$/i.test(safe) ? "tar" : null;
    if (!kind) return { path: file };
    const options = { ...(signal ? { signal } : {}), timeoutMs: this.timing.commandMs * 2 };
    const names = await execRemote(link, { command: "bsdtar", args: ["-tf", file] }, options);
    const verbose = names.exitCode === 0 ? await execRemote(link, { command: "bsdtar", args: ["-tvf", file] }, options) : names;
    if (names.exitCode !== 0 || verbose.exitCode !== 0) throw new DeviceError("INVALID_ARGUMENT", `${safe} could not be read: ${outputTail(verbose.stderr)}`);
    const problem = archiveListingProblem(names.stdout, verbose.stdout);
    if (problem) throw new DeviceError("INVALID_ARGUMENT", `${safe} was refused: ${problem}.`);
    const target = posix.join(dir, "unpacked");
    // `mkdir` without `-p`: the directory is new, nothing in it the archive could write through.
    const made = await execRemote(link, { command: "mkdir", args: ["-m", "700", target] }, options);
    if (made.exitCode !== 0) throw new DeviceError("UNAVAILABLE", `${safe} could not be unpacked: ${outputTail(made.stderr)}`);
    const unpack = kind === "zip" ? { command: "ditto", args: ["-x", "-k", file, target] } : { command: "tar", args: ["-xf", file, "-C", target] };
    const unpacked = await execRemote(link, unpack, options);
    if (unpacked.exitCode !== 0) throw new DeviceError("INVALID_ARGUMENT", `${safe} could not be unpacked: ${outputTail(unpacked.stderr)}`);
    const found = await execRemote(link, { command: "find", args: [target, "-maxdepth", "3", "-type", "d", "-name", "*.app", "-print"] }, { ...(signal ? { signal } : {}), timeoutMs: this.timing.commandMs });
    const app = found.stdout.split("\n").map((line) => line.trim()).filter(Boolean).sort((a, b) => a.length - b.length)[0];
    return { path: app ?? target };
  }

  async destroy(): Promise<void> {
    if (!this.deps.destroyBox) throw new DeviceError("INVALID_ARGUMENT", `${this.label} is your own machine: it is never destroyed.`);
    await this.deps.destroyBox();
  }

  // -------------------------------------------------------------------------
  // Lifecycle (the factory calls these)
  // -------------------------------------------------------------------------

  /** The box's link came back or dropped, or its record changed. */
  linkChanged(): void {
    this.emitChange();
  }

  /**
   * Stop the hub and the agent-device daemon in the box (an idle own machine: never destroyed, its
   * helpers stop). The next `ensureReady` starts them again.
   */
  async stopHelpers(): Promise<void> {
    const link = this.deps.connection();
    const probe = this.probe;
    this.simPool?.stop();
    await this.closeHub();
    await this.closeAgent();
    if (link?.connected) {
      await this.stopHubProcess(link).catch(() => undefined);
      if (probe?.nodePath) {
        const layout = this.layout(link);
        await execRemote(
          link,
          { command: probe.nodePath, args: [layout.agentDeviceEntry, "daemon", "stop", "--state-dir", layout.agentState], env: agentDeviceEnv(layout, remoteEnv(probe)) },
          { timeoutMs: this.timing.commandMs }
        ).catch(() => undefined);
      }
    }
    if (this.configPath) await removeAgentDeviceConfig(this.configPath).catch(() => undefined);
    this.setPhase("stopped", null);
  }

  onChange(listener: () => void): () => void {
    this.events.on("change", listener);
    return () => void this.events.off("change", listener);
  }

  /** Stop watching: the hub and simulators keep running in the box (a restart reattaches). */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.simPool?.stop();
    await this.closeHub();
    await this.closeAgent();
    if (this.configPath) await removeAgentDeviceConfig(this.configPath).catch(() => undefined);
    this.events.removeAllListeners();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private platformEnabled(): boolean {
    const settings = this.deps.settings();
    return this.deps.platform === "ios" ? settings.ios.enabled : settings.android.enabled;
  }

  private checks(): DeviceReadinessCheck[] {
    const probe = this.probe;
    const tools = this.toolVersions;
    const state = (id: string, ok: boolean | null): DeviceReadinessCheck["state"] => (this.working === id ? "working" : ok === true ? "ok" : "missing");
    const notChecked = "Not checked yet";
    const hubOk = this.hub !== null;
    const agentOk = this.agent !== null;
    return [
      {
        id: "node",
        label: "Node.js 22 or newer",
        state: state("node", probe ? (probe.nodeMajor ?? 0) >= 22 : null),
        detail: probe ? (probe.nodeVersion ?? "Not installed") : notChecked
      },
      {
        id: "xcode",
        label: "Xcode with iOS simulators",
        state: state("xcode", probe ? probe.os === "Darwin" && probe.simctl : null),
        detail: probe ? (probe.xcode ?? "Not installed") : notChecked
      },
      ...(["expo-device-hub", "agent-device"] as const).map((name): DeviceReadinessCheck => {
        const installed = tools ? (name === "agent-device" ? tools.agent : tools.hub) : null;
        return {
          id: `tool:${name}`,
          label: name,
          state: this.working === "tool:expo-device-hub" ? "working" : installed === DEVICE_TOOL_VERSIONS[name] ? "ok" : "missing",
          detail: tools ? (installed ? `${installed}${installed === DEVICE_TOOL_VERSIONS[name] ? "" : ` (needs ${DEVICE_TOOL_VERSIONS[name]})`}` : "Not installed") : notChecked,
          fixActionId: BOX_FIX_ACTIONS.tools
        };
      }),
      {
        id: "tool:agent-device-local",
        label: "agent-device on this machine",
        state: this.working === "tool:agent-device-local" ? "working" : this.localCli ? "ok" : "missing",
        detail: this.localCli ? DEVICE_TOOL_VERSIONS["agent-device"] : "Not installed",
        fixActionId: BOX_FIX_ACTIONS.tools
      },
      {
        id: "tool:simslim",
        label: "simslim (slim simulators)",
        state: state("tool:simslim", this.slimCheck?.ok ?? null),
        detail: this.slimCheck?.detail ?? notChecked,
        fixActionId: BOX_FIX_ACTIONS.tools
      },
      { id: "hub", label: "Device hub", state: state("hub", hubOk), detail: hubOk ? "Running" : "Not running", fixActionId: BOX_FIX_ACTIONS.hub },
      { id: "agent-device", label: "agent-device daemon", state: state("agent-device", agentOk), detail: agentOk ? "Running" : "Not running", fixActionId: BOX_FIX_ACTIONS.agent }
    ];
  }

  private requireLink(): BoxConnection {
    const link = this.deps.connection();
    if (!link?.connected) throw new DeviceError("UNAVAILABLE", `${this.label} is unreachable right now; its devices keep running. Try again shortly.`);
    return link;
  }

  private requireReady(): BoxConnection {
    const link = this.requireLink();
    if (this.phase !== "ready" || !this.hub) throw new DeviceError(DEVICE_ERROR_CODES.PLATFORM_NOT_READY, `${this.label} is not ready yet (${this.state().detail ?? this.state().status}).`);
    return link;
  }

  private async simctl(link: BoxConnection, args: string[], signal?: AbortSignal, timeoutMs = this.timing.commandMs, allowFailure = false): Promise<RemoteResult> {
    const result = await execRemote(link, { command: "xcrun", args: ["simctl", ...args], ...(this.probe ? { env: remoteEnv(this.probe) } : {}) }, { ...(signal ? { signal } : {}), timeoutMs });
    if (!allowFailure && result.exitCode !== 0) {
      throw new DeviceError("UNAVAILABLE", `simctl ${args[0]} failed on ${this.label}: ${outputTail(result.stderr || result.stdout) || `exit ${result.exitCode}`}`);
    }
    return result;
  }

  private async simDevices(link: BoxConnection, signal?: AbortSignal): Promise<SimDevice[]> {
    return parseSimDevices((await this.simctl(link, ["list", "-j", "devices"], signal)).stdout);
  }

  private async deleteSimulator(link: BoxConnection, udid: string, signal: AbortSignal): Promise<void> {
    await this.simctl(link, ["shutdown", udid], signal, this.timing.commandMs, true);
    await this.simctl(link, ["delete", udid], signal, this.timing.commandMs, true);
  }

  private async hubPost(path: string, body: Record<string, string>, signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    const origin = this.hubOrigin();
    const token = this.hub?.token;
    if (!origin || !token) throw new DeviceError("UNAVAILABLE", `The device hub on ${this.label} is not running.`);
    const fetchImpl = this.deps.fetch ?? fetch;
    const response = await fetchImpl(`${origin}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Not JSON: judged by the status alone.
    }
    const failed = !response.ok || (parsed !== null && typeof parsed === "object" && (parsed as { ok?: unknown }).ok === false);
    if (failed) {
      const error = parsed && typeof parsed === "object" ? (parsed as { error?: unknown }).error : null;
      throw new DeviceError("UNAVAILABLE", `The device hub refused ${posix.basename(path)} (HTTP ${response.status}${typeof error === "string" ? `: ${error.slice(0, 300)}` : ""}).`);
    }
    return parsed;
  }

  private async healthy(hostPort: number, route: string): Promise<boolean> {
    try {
      const response = await (this.deps.fetch ?? fetch)(`http://127.0.0.1:${hostPort}${route}`, { signal: AbortSignal.timeout(5_000) });
      await response.arrayBuffer().catch(() => undefined);
      return response.ok;
    } catch {
      return false;
    }
  }

  private hubLost(reason: string): void {
    void this.closeHub();
    if (this.phase === "ready") this.setPhase("needs-setup", `${reason} It starts again when a device is opened.`);
  }

  private agentLost(): void {
    void this.closeAgent();
    if (this.phase === "ready") this.setPhase("needs-setup", "agent-device stopped. It starts again when a device is opened.");
  }

  private async closeHub(): Promise<void> {
    const hub = this.hub;
    this.hub = null;
    await hub?.forward.close().catch(() => undefined);
  }

  private async closeAgent(): Promise<void> {
    const agent = this.agent;
    this.agent = null;
    await agent?.forward.close().catch(() => undefined);
  }

  private setPhase(phase: Phase, detail: string | null): void {
    if (this.disposed) return;
    const changed = phase !== this.phase || detail !== this.detail;
    this.phase = phase;
    this.detail = detail;
    if (changed) this.emitChange();
  }

  /** A new detail line while preparing (the host summary shows it; no change event for each line). */
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
      return `Renting a ${record.kind === "macos" ? "Mac" : "Linux"} host (${record.sizeLabel ?? record.size})…`;
    case "connect":
      return "Waiting for the host to start…";
    case "devices":
      return running.message ? `Preparing: ${running.message}` : "Preparing the host…";
    default:
      return "Setting up the host…";
  }
}

async function readSmallFile(link: BoxConnection, path: string): Promise<string | null> {
  try {
    const stream = await link.readFile(path, { length: 256 * 1024 });
    let text = "";
    for await (const chunk of stream) text += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
    return text;
  } catch {
    return null;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
