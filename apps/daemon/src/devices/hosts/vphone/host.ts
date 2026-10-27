/**
 * A vphone research host (phase 3 §2.3): an owner's own Mac (a `byo` box with "Use for device
 * simulators" and "Virtual iPhones (research)" on) running real iOS in vphone-cli VMs. Reached only
 * through its `BoxConnection`.
 *
 * - Readiness (`readiness.ts`) over `exec`; the template can be built as a setup job.
 * - Each lease gets its own machine `orq-<leaseId>`, cloned from the template with a new identity,
 *   launched headless and detached with `--api-listen 127.0.0.1:0` and a host-made
 *   `VPHONE_API_TOKEN` in its environment (never argv, never logged), its API port forwarded to
 *   this machine's loopback, and released by `vm stop` + `vm delete --force`.
 * - The token and port of each running machine live in a 0600 file under the devices runtime dir,
 *   so a restarted daemon reattaches.
 * - Video and input go through the {@link VphoneBridge} (serve-sim endpoints the panel speaks);
 *   agent actions and installs map onto vphoned RPCs (`agent-actions.ts`).
 */

import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  deviceKey,
  VPHONE_RESEARCH_LABEL,
  VPHONE_RESEARCH_NOTICE,
  type DeviceCapacity,
  type DeviceHostBoxInfo,
  type DeviceHostReadiness,
  type DeviceReadinessCheck,
  type DeviceSummary,
  type DevicesVphoneHostSettings
} from "@orquester/api";
import type { StoredDeviceLease } from "@orquester/config";

import type { BoxConnection, BoxHostForward, BoxProcess } from "../../../boxes/contracts.ts";
import { DeviceError, isDeviceError } from "../../errors.ts";
import type {
  DeviceActionOutcome,
  DeviceActionRequest,
  DeviceBootRequest,
  DeviceBootResult,
  DeviceCommandResult,
  DeviceHost,
  DeviceHostProgress,
  DeviceHostState
} from "../../host.ts";
import { performVphoneAction } from "./agent-actions.ts";
import { VphoneBridge, type VphoneStreamTuning } from "./bridge.ts";
import {
  createStageIndex,
  CREATE_STAGES,
  lastLine,
  lineSplitter,
  machineNameForLease,
  parseApiListenPort,
  parseStageBanner,
  runInBox,
  VPHONE_BASE_MACHINE,
  VphoneCli
} from "./cli.ts";
import { asRecord, VphoneGuestClient, VphoneRpcError } from "./guest-client.ts";
import { chooseCloneSource, evaluateVphoneReadiness, probeVphoneHost, VPHONE_TEMPLATE_ACTION, type VphoneProbe } from "./readiness.ts";
import type { VphoneSnapshot } from "./snapshot.ts";

export type VphoneBoxLink = Pick<BoxConnection, "boxId" | "sys" | "connected" | "exec" | "forwardToHost" | "request" | "detachedProcs" | "onStatus">;

export interface VphoneHostDeps {
  boxId: string;
  /** The machine's name ("Studio Mac"). */
  machineName: string;
  /** The box link, when the machine has ever connected. */
  link(): VphoneBoxLink | null;
  box(): DeviceHostBoxInfo;
  /** This machine's research settings (read per call). */
  settings(): DevicesVphoneHostSettings;
  /** Leases on this host that are active now. */
  activeLeases(): readonly StoredDeviceLease[];
  /** 0700 directory for this host's machine records (port + token). */
  stateDir: string;
  /** 0700 directory builds are staged in before they go to a VM. */
  uploadsDir: string;
  logger: Pick<Console, "info" | "warn" | "error">;
  /** Tests: faster waits, smaller streams, a fixed token source. */
  timing?: { launchTimeoutMs?: number; healthTimeoutMs?: number; healthIntervalMs?: number };
  tuning?: Partial<VphoneStreamTuning>;
  newToken?: () => string;
}

/** One running research iPhone. */
interface VphoneMachineRecord {
  name: string;
  leaseId: string;
  /** The `--api-listen` port on the Mac. */
  boxPort: number;
  token: string;
  procId: string;
  osVersion: string;
  screen: { width: number; height: number; scale: number } | null;
  forward: BoxHostForward | null;
  client: VphoneGuestClient | null;
  process: BoxProcess | null;
  snapshot: VphoneSnapshot | null;
}

const IPA_EXTENSIONS = [".ipa", ".tipa"];
const GIB = 1024 ** 3;

export class VphoneDeviceHost implements DeviceHost {
  readonly id: string;
  readonly kind = "byo" as const;
  readonly label: string;
  readonly platforms = ["ios"] as const;

  private readonly events = new EventEmitter();
  private readonly bridgeToken = randomBytes(32).toString("hex");
  private readonly bridge: VphoneBridge;
  private readonly machines = new Map<string, VphoneMachineRecord>();
  private checks: DeviceReadinessCheck[] = [];
  private checkedAt: string | null = null;
  private probe: VphoneProbe | null = null;
  private probing: Promise<DeviceHostReadiness> | null = null;
  private installing = false;
  private disposed = false;
  private unsubscribeLink: (() => void) | null = null;
  private watchedLink: VphoneBoxLink | null = null;
  private reattached = false;
  private sweeping: Promise<void> | null = null;
  private sweepAgain = false;

  constructor(private readonly deps: VphoneHostDeps) {
    this.id = vphoneHostId(deps.boxId);
    this.label = `${VPHONE_RESEARCH_LABEL} on ${deps.machineName}`;
    this.bridge = new VphoneBridge({
      token: this.bridgeToken,
      device: (id) => {
        const machine = this.machines.get(id);
        return machine?.client ? { client: machine.client, screen: machine.screen } : null;
      },
      logger: deps.logger,
      ...(deps.tuning ? { tuning: deps.tuning } : {})
    });
  }

  /** Start the bridge and the first probe (the factory calls it once after adding the host). */
  async start(): Promise<void> {
    if (this.disposed) return;
    try {
      await this.bridge.start();
    } catch (error) {
      if (this.disposed) return;
      throw error;
    }
    this.emit();
    this.linkChanged();
  }

  /** The box record or its link changed: follow the connection, probe again when it comes back. */
  linkChanged(): void {
    if (this.disposed) return;
    const link = this.deps.link();
    if (link !== this.watchedLink) {
      this.unsubscribeLink?.();
      this.watchedLink = link;
      this.unsubscribeLink = link?.onStatus((connected) => {
        this.emit();
        if (connected) void this.refreshReadiness().catch(() => undefined);
      }) ?? null;
    }
    this.emit();
    if (link?.connected && !this.probing) void this.refreshReadiness().catch(() => undefined);
  }

  state(): DeviceHostState {
    const link = this.deps.link();
    if (!link?.connected) return { status: "unreachable", detail: `${this.deps.machineName} is offline. Its research iPhones keep running.` };
    if (this.installing) return { status: "installing", detail: "Building the vphone template…" };
    if (this.checkedAt === null || !this.bridge.origin()) return { status: "starting", detail: "Checking the Mac…" };
    const failed = this.checks.find((check) => check.state !== "ok");
    if (failed) return { status: "needs-setup", detail: `${failed.label}: ${failed.detail ?? "missing"}` };
    return { status: "ready", detail: null };
  }

  readiness(): DeviceHostReadiness {
    return { ready: this.checks.length > 0 && this.checks.every((check) => check.state === "ok"), checks: this.checks.map((check) => ({ ...check })), checkedAt: this.checkedAt };
  }

  refreshReadiness(signal?: AbortSignal): Promise<DeviceHostReadiness> {
    this.probing ??= this.probeNow(signal).finally(() => {
      this.probing = null;
    });
    return this.probing;
  }

  private async probeNow(signal?: AbortSignal): Promise<DeviceHostReadiness> {
    const link = this.deps.link();
    if (!link?.connected) return this.readiness();
    const probe = await probeVphoneHost(link, signal);
    const settings = this.deps.settings();
    this.probe = probe;
    this.checks = evaluateVphoneReadiness(probe, {
      sourcesSet: settings.iphoneSource !== null && settings.cloudosSource !== null,
      canElevate: link.sys.isRoot || link.sys.canElevate
    });
    this.checkedAt = new Date().toISOString();
    this.emit();
    if (!this.reattached && probe.cli) {
      this.reattached = true;
      void this.reattach().catch((error) => this.deps.logger.warn(`[devices] reattaching research iPhones on ${this.deps.machineName} failed`, errorText(error)));
    }
    if (probe.cli) {
      void this.sweepReleased(link, new VphoneCli(link, probe.cli)).catch((error) =>
        this.deps.logger.warn(`[devices] deleting released research iPhones on ${this.deps.machineName} failed`, errorText(error))
      );
    }
    return this.readiness();
  }

  capacity(): DeviceCapacity {
    const memBytes = this.deps.link()?.sys.memBytes ?? 0;
    // A clone takes 8 GB by default; keep room for macOS.
    const total = Math.max(1, Math.min(4, Math.floor(memBytes / (12 * GIB))));
    return { used: this.deps.activeLeases().length, total };
  }

  box(): DeviceHostBoxInfo {
    return this.deps.box();
  }

  research(): { notice: string } {
    return { notice: VPHONE_RESEARCH_NOTICE };
  }

  async ensureReady(signal: AbortSignal, onProgress: (progress: DeviceHostProgress) => void, actions?: readonly string[]): Promise<void> {
    await this.refreshReadiness(signal);
    const template = this.checks.find((check) => check.id === "template");
    if (template?.state !== "ok" && template?.fixActionId === VPHONE_TEMPLATE_ACTION && (!actions || actions.includes(VPHONE_TEMPLATE_ACTION))) {
      await this.buildTemplate(signal, onProgress);
      await this.refreshReadiness(signal);
    }
    const failed = this.checks.filter((check) => check.state !== "ok");
    if (failed.length > 0) {
      throw new DeviceError("PLATFORM_NOT_READY", `${this.deps.machineName} is not ready for research iPhones. ${failed.map((check) => `${check.label}: ${check.detail ?? "missing"}`).join(" ")}`);
    }
  }

  /** `vm create orq-base --iphone-source … --cloudos-source …` with its stage banners as progress. */
  private async buildTemplate(signal: AbortSignal, onProgress: (progress: DeviceHostProgress) => void): Promise<void> {
    const link = this.requireLink();
    const cli = this.requireCli(link);
    const settings = this.deps.settings();
    if (!settings.iphoneSource || !settings.cloudosSource) throw new DeviceError("PLATFORM_NOT_READY", "Set both IPSW sources for this machine in Settings → Devices first.");
    const args = cli.argv(cli.createTemplateArgs(VPHONE_BASE_MACHINE, settings.iphoneSource, settings.cloudosSource));
    const command = link.sys.isRoot ? args.command : "/usr/bin/sudo";
    const argv = link.sys.isRoot ? args.args : ["-n", args.command, ...args.args];
    let stage = -1;
    let label = "Building the vphone template";
    const step = "template";
    this.installing = true;
    this.emit();
    onProgress({ step, label, state: "running", percent: 0 });
    try {
      const result = await runInBox(link, command, argv, {
        signal,
        timeoutMs: 4 * 60 * 60_000,
        onLine: (line) => {
          const banner = parseStageBanner(line);
          if (banner !== null) {
            const index = createStageIndex(banner);
            if (index > stage) stage = index;
            label = index >= 0 ? CREATE_STAGES[index]!.label : banner;
            onProgress({ step, label, state: "running", percent: Math.round((Math.max(stage, 0) / CREATE_STAGES.length) * 100), logLine: line });
          } else {
            onProgress({ step, label, state: "running", logLine: line });
          }
        }
      });
      if (result.exitCode !== 0) {
        onProgress({ step, label, state: "failed", detail: lastLine(result) });
        throw new DeviceError("PLATFORM_NOT_READY", `Building the vphone template failed: ${lastLine(result)}`);
      }
      onProgress({ step, label: "Template ready", state: "done", percent: 100 });
    } finally {
      this.installing = false;
      this.emit();
    }
  }

  hubOrigin(): string | null {
    return this.bridge.origin();
  }

  hubToken(): string | null {
    return this.bridgeToken;
  }

  streamCapabilities(): { iosH264: boolean } {
    // vphone-vm encodes in its own process with the Mac's hardware encoder.
    return { iosH264: true };
  }

  agentDeviceConfigPath(): string | null {
    return null;
  }

  async listDevices(): Promise<DeviceSummary[]> {
    return [...this.machines.values()].map((machine) => ({
      key: deviceKey(this.id, machine.name),
      hostId: this.id,
      id: machine.name,
      platform: "ios",
      name: "Research iPhone",
      osVersion: machine.osVersion,
      profile: null,
      booted: machine.client !== null,
      leaseId: machine.leaseId
    }));
  }

  async boot(request: DeviceBootRequest, signal: AbortSignal, onProgress?: (progress: DeviceHostProgress) => void): Promise<DeviceBootResult> {
    if (request.deviceId !== undefined) {
      const existing = this.machines.get(request.deviceId);
      if (!existing?.client || request.fresh) throw new DeviceError("DEVICE_NOT_FOUND", "Research iPhones are made for each lease: open a new one.");
      existing.leaseId = request.leaseId;
      return this.bootResult(existing);
    }
    if (!this.readiness().ready) throw new DeviceError("PLATFORM_NOT_READY", this.state().detail ?? `${this.deps.machineName} is not ready for research iPhones.`);
    const link = this.requireLink();
    const cli = this.requireCli(link);
    const name = machineNameForLease(request.leaseId);
    const progress = (step: string, label: string) => onProgress?.({ step, label, state: "running" });
    let created = false;
    const record: VphoneMachineRecord = {
      name,
      leaseId: request.leaseId,
      boxPort: 0,
      token: this.deps.newToken?.() ?? randomBytes(32).toString("hex"),
      procId: `vphone-${name}`,
      osVersion: "iOS",
      screen: null,
      forward: null,
      client: null,
      process: null,
      snapshot: null
    };
    try {
      progress("clone", "Cloning the research iPhone");
      const [templates, machines] = await Promise.all([cli.listTemplates(signal), cli.listMachines(signal)]);
      const source = chooseCloneSource({ templates, machines });
      if (!source) throw new DeviceError("PLATFORM_NOT_READY", `${this.deps.machineName} has no vphone template to clone. Open Settings → Devices to set one up.`);
      const cloned = source.kind === "template" ? await cli.createFromTemplate(name, source.id, { signal }) : await cli.cloneMachine(source.name, name, { signal });
      created = true;
      if (cloned.exitCode !== 0) throw new DeviceError("UNAVAILABLE", `Cloning the research iPhone failed: ${lastLine(cloned)}`);
      this.throwIfAborted(signal);

      progress("launch", "Starting the research iPhone");
      record.boxPort = await this.launch(link, cli, record, signal);
      record.forward = await link.forwardToHost(record.boxPort);
      record.client = new VphoneGuestClient({ port: record.forward.hostPort, token: record.token });
      this.machines.set(name, record);
      await this.saveRecord(record);

      progress("boot", "Waiting for iOS to finish booting");
      await this.waitForHealth(record, signal);
      record.screen = await readScreen(record.client, signal);
      const info = await cli.machineInfo(name, signal).catch(() => null);
      record.osVersion = info?.iosVersion ? `iOS ${info.iosVersion}` : "iOS";
      await this.saveRecord(record);
      this.emit();
      return this.bootResult(record);
    } catch (error) {
      await this.teardown(link, cli, record, created).catch(() => undefined);
      if (signal.aborted) throw new DeviceError("CANCELLED", "The research iPhone was released before it finished starting.");
      if (isDeviceError(error)) throw error;
      this.deps.logger.error(`[devices] starting a research iPhone on ${this.deps.machineName} failed`, errorText(error));
      throw new DeviceError("UNAVAILABLE", `The research iPhone did not start: ${errorText(error)}`);
    }
  }

  private bootResult(record: VphoneMachineRecord): DeviceBootResult {
    return {
      deviceId: record.name,
      name: "Research iPhone",
      osVersion: record.osVersion,
      ...(record.screen ? { screen: record.screen } : {}),
      stream: { kind: "serve-sim", deviceParam: record.name }
    };
  }

  /** `vm launch` detached, its token in the environment; resolves the API port it printed. */
  private launch(link: VphoneBoxLink, cli: VphoneCli, record: VphoneMachineRecord, signal: AbortSignal): Promise<number> {
    const argv = cli.argv(cli.launchArgs(record.name));
    return new Promise((resolve, reject) => {
      const process = link.exec({ command: argv.command, args: argv.args, env: { VPHONE_API_TOKEN: record.token }, detach: { procId: record.procId } });
      record.process = process;
      const recent: string[] = [];
      let settled = false;
      const finish = (error: Error | null, port?: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve(port!);
      };
      const onLine = (raw: string) => {
        // vphone-vm prints the token and the bearer header it expects: never keep those lines.
        const line = raw.includes(record.token) || /\btoken\b|authorization|bearer/i.test(raw) ? "[api] (token line hidden)" : raw;
        recent.push(line);
        if (recent.length > 20) recent.shift();
        const port = parseApiListenPort(raw);
        if (port !== null) finish(null, port);
      };
      const splitOut = lineSplitter(onLine);
      const splitErr = lineSplitter(onLine);
      process.stdout.on("data", (chunk: Buffer) => splitOut.push(chunk));
      process.stderr.on("data", (chunk: Buffer) => splitErr.push(chunk));
      process.on("error", (error) => finish(error));
      process.on("exit", (code) => {
        splitOut.flush();
        splitErr.flush();
        finish(new Error(`vphone-cli vm launch exited (${code ?? "signal"}): ${recent.filter((line) => !line.includes("token line hidden")).slice(-1)[0] ?? "no output"}`));
      });
      const onAbort = () => finish(new Error("cancelled"));
      signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => finish(new Error("vphone-cli vm launch did not report its API address in time")), this.deps.timing?.launchTimeoutMs ?? 5 * 60_000);
    });
  }

  /** Poll `/v1/health` until vphoned answers (the guest boots after `vm launch` returns). */
  private async waitForHealth(record: VphoneMachineRecord, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + (this.deps.timing?.healthTimeoutMs ?? 10 * 60_000);
    const interval = this.deps.timing?.healthIntervalMs ?? 2_000;
    let last = "no answer";
    for (;;) {
      this.throwIfAborted(signal);
      if (record.process && record.process.exitCode !== null) throw new Error("the VM stopped while it booted");
      try {
        await record.client!.health({ signal, timeoutMs: 10_000 });
        return;
      } catch (error) {
        last = errorText(error);
      }
      if (Date.now() >= deadline) throw new Error(`vphoned did not answer in time (${last})`);
      await waitMs(interval, signal);
    }
  }

  async shutdown(deviceId: string): Promise<void> {
    const link = this.deps.link();
    if (!link?.connected || !this.isOurs(deviceId)) return;
    const cli = this.cliOrNull(link);
    if (cli) await cli.stop(deviceId).catch(() => undefined);
    const record = this.machines.get(deviceId);
    if (record) {
      await record.forward?.close().catch(() => undefined);
      record.forward = null;
      record.client = null;
      this.emit();
    }
  }

  /**
   * A lease's clone is always deleted (`shutdown` or not): research iPhones are made per lease.
   * Its record stays (as a 0600 tombstone without the token) until `vm delete` worked or the
   * machine is gone: released while the Mac is offline or before the first probe found vphone-cli,
   * the clone is deleted on the next probe ({@link sweepReleased}) instead of being orphaned.
   */
  async release(lease: StoredDeviceLease, _options?: { shutdown: boolean }): Promise<void> {
    const name = lease.deviceId ?? machineNameForLease(lease.id);
    if (!this.isOurs(name)) return;
    const link = this.deps.link();
    const record = this.machines.get(name) ?? (await this.loadRecord(name));
    const fallback = { name, procId: record?.procId ?? `vphone-${name}`, forward: null, process: null };
    if (!link?.connected) {
      await this.markReleased(fallback.name, fallback.procId, record);
      return;
    }
    let cli = this.cliOrNull(link);
    if (!cli) {
      // Not probed yet (a release right after a restart): find vphone-cli first.
      await this.refreshReadiness().catch(() => undefined);
      cli = this.cliOrNull(link);
    }
    await this.teardown(link, cli, record ?? fallback, true);
  }

  private async teardown(
    link: VphoneBoxLink,
    cli: VphoneCli | null,
    record: Pick<VphoneMachineRecord, "name" | "procId" | "forward" | "process"> | null,
    created: boolean
  ): Promise<void> {
    if (!record) return;
    const name = record.name;
    if (cli) await cli.stop(name).catch(() => undefined);
    if (record.process && record.process.exitCode === null) record.process.kill("SIGTERM");
    else await link.request("proc.signal", { procId: record.procId, signal: "SIGTERM" }).catch(() => undefined);
    await link.request("proc.release", { procId: record.procId }).catch(() => undefined);
    await record.forward?.close().catch(() => undefined);
    let gone = !created;
    if (cli && created) {
      const deleted = await cli.delete(name).catch((error: unknown) => ({ exitCode: -1, stdout: "", stderr: errorText(error) }) satisfies DeviceCommandResult);
      // A failed delete of a machine that is not there (any more) is done too.
      gone = deleted.exitCode === 0 || (await cli.machineInfo(name).catch(() => undefined)) === null;
      if (!gone) this.deps.logger.warn(`[devices] deleting research iPhone ${name} failed; retrying on the next check`, lastLine(deleted));
    }
    if (gone) await this.forget(name, null);
    else await this.markReleased(name, record.procId, null);
  }

  private async forget(name: string, record: Pick<VphoneMachineRecord, "forward"> | null): Promise<void> {
    await record?.forward?.close().catch(() => undefined);
    this.machines.delete(name);
    await rm(this.recordPath(name), { force: true }).catch(() => undefined);
    this.emit();
  }

  /** Released, its clone not deleted yet: keep a tombstone (no token) for {@link sweepReleased}. */
  private async markReleased(name: string, procId: string, record: Pick<VphoneMachineRecord, "forward"> | null): Promise<void> {
    await record?.forward?.close().catch(() => undefined);
    this.machines.delete(name);
    try {
      await mkdir(this.deps.stateDir, { recursive: true, mode: 0o700 });
      // Written whole (a sweep may read it at any time).
      const path = this.recordPath(name);
      const temp = `${path}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify({ name, procId, released: true }), { mode: 0o600 });
      await rename(temp, path);
    } catch (error) {
      this.deps.logger.warn(`[devices] remembering released research iPhone ${name} failed`, errorText(error));
    }
    this.emit();
  }

  /**
   * Delete the clones of released leases that could not be deleted then (offline, not probed, a
   * failed delete). One sweep at a time; a probe during a sweep runs one more after it.
   */
  private sweepReleased(link: VphoneBoxLink, cli: VphoneCli): Promise<void> {
    if (this.sweeping) {
      this.sweepAgain = true;
      return this.sweeping;
    }
    this.sweeping = (async () => {
      do {
        this.sweepAgain = false;
        await this.sweepOnce(link, cli);
      } while (this.sweepAgain && !this.disposed);
    })().finally(() => {
      this.sweeping = null;
    });
    return this.sweeping;
  }

  private async sweepOnce(link: VphoneBoxLink, cli: VphoneCli): Promise<void> {
    const files = await readdir(this.deps.stateDir).catch(() => [] as string[]);
    const leased = new Set(this.deps.activeLeases().map((lease) => lease.deviceId));
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const name = file.slice(0, -".json".length);
      if (!this.isOurs(name) || this.machines.has(name) || leased.has(name)) continue;
      const raw = asRecord(JSON.parse(await readFile(this.recordPath(name), "utf8").catch(() => "null")) as unknown);
      if (raw?.released !== true) continue;
      const procId = typeof raw.procId === "string" ? raw.procId : `vphone-${name}`;
      await this.teardown(link, cli, { name, procId, forward: null, process: null }, true);
    }
  }

  async run(): Promise<never> {
    throw new DeviceError("UNAVAILABLE", "Research iPhones have no simctl or adb: use device_action.");
  }

  async uploadFile(stream: Readable, name: string): Promise<{ path: string }> {
    const dir = join(this.deps.uploadsDir, randomUUID());
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, basename(name).replace(/[^A-Za-z0-9._-]/g, "_") || "app.ipa");
    await pipeline(stream, createWriteStream(path, { mode: 0o600 }));
    return { path };
  }

  async installApp(lease: StoredDeviceLease, uploadedPath: string, signal: AbortSignal): Promise<{ appId: string | null; summary: string }> {
    const record = this.liveRecord(lease);
    const real = await realpath(uploadedPath).catch(() => null);
    const root = await realpath(this.deps.uploadsDir).catch(() => this.deps.uploadsDir);
    if (!real || !real.startsWith(root + sep)) throw new DeviceError("INVALID_ARGUMENT", "That build was not uploaded for this device.");
    try {
      if (!IPA_EXTENSIONS.some((extension) => real.toLowerCase().endsWith(extension))) {
        throw new DeviceError("INVALID_ARGUMENT", "Research iPhones install .ipa archives: export the app as an .ipa (a device build, not a simulator .app) and install that.");
      }
      const guestPath = `/private/var/tmp/orq-${randomUUID()}.ipa`;
      await record.client!.putFile(guestPath, createReadStream(real), { signal, mode: "644" });
      // vphoned deletes the archive after installing it.
      const result = await this.callGuest(record, "apps.install", { path: guestPath }, { signal, timeoutMs: 15 * 60_000 });
      const appId = typeof result.bundle_id === "string" ? result.bundle_id : null;
      return { appId, summary: typeof result.msg === "string" ? result.msg : `Installed ${appId ?? "the app"}.` };
    } finally {
      await rm(join(real, ".."), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async performAction(lease: StoredDeviceLease, action: DeviceActionRequest, signal: AbortSignal): Promise<DeviceActionOutcome> {
    const record = this.liveRecord(lease);
    return performVphoneAction(
      {
        call: (method, params, options) => this.callGuest(record, method, params, options),
        screen: () => record.screen,
        snapshot: () => record.snapshot,
        setSnapshot: (snapshot) => {
          record.snapshot = snapshot;
        }
      },
      action,
      signal
    );
  }

  private liveRecord(lease: StoredDeviceLease): VphoneMachineRecord {
    const record = lease.deviceId ? this.machines.get(lease.deviceId) : undefined;
    if (!record?.client || record.leaseId !== lease.id) throw new DeviceError("DEVICE_LOST", "This research iPhone is gone. Call open_device again.");
    return record;
  }

  private async callGuest(record: VphoneMachineRecord, method: string, params: Record<string, unknown>, options: { signal?: AbortSignal; timeoutMs?: number }): Promise<Record<string, unknown>> {
    try {
      return await record.client!.call(method, params, options);
    } catch (error) {
      if (error instanceof VphoneRpcError) {
        if (error.code === "unreachable") throw new DeviceError("DEVICE_LOST", "The research iPhone does not answer. Call open_device again.");
        throw new DeviceError("UNAVAILABLE", `The research iPhone refused ${method}: ${error.message}`);
      }
      throw error;
    }
  }

  /** After a daemon restart: find each active lease's machine record and forward its API again. */
  private async reattach(): Promise<void> {
    const link = this.deps.link();
    if (!link) return;
    for (const lease of this.deps.activeLeases()) {
      const name = lease.deviceId;
      if (!name || this.machines.has(name) || !this.isOurs(name)) continue;
      const record = await this.loadRecord(name);
      if (!record) continue;
      record.leaseId = lease.id;
      try {
        record.forward = await link.forwardToHost(record.boxPort);
        record.client = new VphoneGuestClient({ port: record.forward.hostPort, token: record.token });
        await record.client.health({ timeoutMs: 10_000 });
        record.screen = await readScreen(record.client);
        record.osVersion = lease.osVersion || record.osVersion;
        this.machines.set(name, record);
        this.emit();
      } catch (error) {
        await record.forward?.close().catch(() => undefined);
        this.deps.logger.warn(`[devices] research iPhone ${name} did not answer after a restart`, errorText(error));
      }
    }
  }

  private recordPath(name: string): string {
    return join(this.deps.stateDir, `${name}.json`);
  }

  private async saveRecord(record: VphoneMachineRecord): Promise<void> {
    await mkdir(this.deps.stateDir, { recursive: true, mode: 0o700 });
    const path = this.recordPath(record.name);
    await writeFile(path, JSON.stringify({ name: record.name, leaseId: record.leaseId, boxPort: record.boxPort, token: record.token, procId: record.procId, osVersion: record.osVersion }), { mode: 0o600 });
    await chmod(path, 0o600).catch(() => undefined);
  }

  private async loadRecord(name: string): Promise<VphoneMachineRecord | null> {
    try {
      const raw = asRecord(JSON.parse(await readFile(this.recordPath(name), "utf8")));
      if (!raw || typeof raw.boxPort !== "number" || typeof raw.token !== "string" || typeof raw.procId !== "string") return null;
      return {
        name,
        leaseId: typeof raw.leaseId === "string" ? raw.leaseId : "",
        boxPort: raw.boxPort,
        token: raw.token,
        procId: raw.procId,
        osVersion: typeof raw.osVersion === "string" ? raw.osVersion : "iOS",
        screen: null,
        forward: null,
        client: null,
        process: null,
        snapshot: null
      };
    } catch {
      return null;
    }
  }

  /** Only machines this host made (`orq-<leaseId>`); never the base machine or the owner's own. */
  private isOurs(name: string): boolean {
    return /^orq-[A-Za-z0-9-]+$/.test(name) && name !== VPHONE_BASE_MACHINE;
  }

  private requireLink(): VphoneBoxLink {
    const link = this.deps.link();
    if (!link?.connected) throw new DeviceError("PLATFORM_NOT_READY", `${this.deps.machineName} is offline.`);
    return link;
  }

  private requireCli(link: VphoneBoxLink): VphoneCli {
    const cli = this.cliOrNull(link);
    if (!cli) throw new DeviceError("PLATFORM_NOT_READY", `vphone-cli was not found on ${this.deps.machineName}.`);
    return cli;
  }

  private cliOrNull(link: VphoneBoxLink): VphoneCli | null {
    return this.probe?.cli ? new VphoneCli(link, this.probe.cli) : null;
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new DeviceError("CANCELLED", "The research iPhone was released before it finished starting.");
  }

  onChange(listener: () => void): () => void {
    this.events.on("change", listener);
    return () => void this.events.off("change", listener);
  }

  private emit(): void {
    if (!this.disposed) this.events.emit("change");
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.unsubscribeLink?.();
    this.unsubscribeLink = null;
    await this.bridge.close();
    for (const record of this.machines.values()) await record.forward?.close().catch(() => undefined);
    this.machines.clear();
    this.events.removeAllListeners();
  }
}

/** A vphone host's id: `vphone:<boxId>` (the box's own `box:<boxId>` host runs its simulators). */
export function vphoneHostId(boxId: string): string {
  return `vphone:${boxId}`;
}

/** The screen in points from `device.screen` (tolerant of IcliKit's key names). */
async function readScreen(client: VphoneGuestClient, signal?: AbortSignal): Promise<{ width: number; height: number; scale: number } | null> {
  try {
    const result = await client.call("device.screen", {}, { ...(signal ? { signal } : {}), timeoutMs: 15_000 });
    return parseScreen(result);
  } catch {
    return null;
  }
}

export function parseScreen(result: Record<string, unknown>): { width: number; height: number; scale: number } | null {
  const source = asRecord(result.screen) ?? result;
  const pick = (...keys: string[]) => keys.map((key) => source[key]).find((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  const scale = pick("scale", "native_scale", "nativeScale") ?? 3;
  let width = pick("width", "points_width", "pointsWidth", "bounds_width");
  let height = pick("height", "points_height", "pointsHeight", "bounds_height");
  if (width === undefined || height === undefined) {
    const pw = pick("pixel_width", "pixelWidth", "native_width");
    const ph = pick("pixel_height", "pixelHeight", "native_height");
    if (pw === undefined || ph === undefined) return null;
    width = pw / scale;
    height = ph / scale;
  }
  // Pixels reported as points: a phone is never wider than ~1100 points.
  if (width > 1100 && height > 1100) {
    width /= scale;
    height /= scale;
  }
  return { width: Math.round(Math.min(width, height)), height: Math.round(Math.max(width, height)), scale };
}

function waitMs(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
