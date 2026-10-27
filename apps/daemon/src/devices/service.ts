/**
 * The device service (devices spec §6–§9): one per daemon while the "Device simulators" plugin is
 * on (`wiring.ts` builds and disposes it). It owns
 *
 * - the hosts, through the factories `wiring.ts` hands it ({@link DeviceHostRegistry});
 * - the settings (`devices.json`) and the leases (`device-leases.json`, the durable record);
 * - lease placement (`pool.ts`), the lease and controller rules (`leases.ts`), setup jobs, the
 *   action log (`action-log.ts`) and kept screenshots (`screenshots.ts`);
 * - the agent tools' operations ({@link DeviceToolsPort}, reached through `DaemonApi`).
 *
 * Host internals (booting, streams, agent-device) stay behind `DeviceHost` and the action
 * executor. Every change is published on `DEVICES_CHANNEL` through `publish`; `events` emits
 * `"tools"` when the devices toolset's availability may have changed.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

import {
  DEFAULT_DEVICE_PROFILE,
  DEVICE_ERROR_CODES,
  DEVICE_PLATFORM_LABELS,
  DEVICE_PLATFORMS,
  DEVICE_PROFILES,
  DEVICES_ACTION_EVENT,
  DEVICES_HOSTS_EVENT,
  DEVICES_LEASE_CLOSED_EVENT,
  DEVICES_LEASE_EVENT,
  DEVICES_SETTINGS_EVENT,
  DEVICES_SETUP_EVENT,
  deviceProfile,
  isDevicePlatform,
  validateDeviceActionInput,
  type DeviceActionEntry,
  type DeviceActionInput,
  type DeviceController,
  type DeviceHostSummary,
  type DeviceLeaseCloseReason,
  type DeviceLeaseProgress,
  type DeviceLeaseSummary,
  type DevicePlatform,
  type DeviceProfile,
  type DeviceSetupJob,
  type DevicesEventType,
  type DevicesSettings,
  type DevicesSettingsPatch,
  type DevicesStateResponse,
  type DeviceSummary
} from "@orquester/api";
import type { StoredDeviceLease } from "@orquester/config";

import { DeviceActionLog, type DeviceActionDraft } from "./action-log.ts";
import type { DeviceActionExecutor, DeviceActionResult } from "./actions.ts";
import { DeviceError, isDeviceError } from "./errors.ts";
import {
  DeviceHostRegistry,
  deviceHostSummary,
  type DeviceHost,
  type DeviceHostFactory,
  type DeviceHostFactoryContext,
  type DeviceHostProgress
} from "./host.ts";
import {
  checkAcquire,
  checkAgentAction,
  describeLease,
  hostLeasesChanged,
  idleLeases,
  isLiveLease,
  leaseBooted,
  leaseKeyOf,
  leasesOfThread,
  newLease,
  resolveLeaseHandle,
  toLeaseSummary,
  touchLease,
  userInput,
  withController
} from "./leases.ts";
import { choosePlacement, type PlacementHost } from "./pool.ts";
import { DEVICE_SCREENSHOT_MAX_BASE64_CHARS } from "./screenshot-image.ts";
import type { DeviceScreenshots } from "./screenshots.ts";
import type { DeviceLeaseStore, DeviceSettingsStore } from "./store.ts";
import type {
  DeviceOpenPlan,
  DeviceToolActionResult,
  DeviceToolCloseInput,
  DeviceToolInstallInput,
  DeviceToolInstallResult,
  DeviceToolList,
  DeviceToolOpenInput,
  DeviceToolOpenResult,
  DeviceToolsPort
} from "./tools-port.ts";

/** How long `open_device` waits for a device before answering `starting` (spec §9: 9 min). */
export const OPEN_DEVICE_WAIT_MS = 9 * 60_000;
/** The idle sweep's period. */
const IDLE_SWEEP_MS = 60_000;
/** One placement wait (a host starting) at most. */
const HOST_WAIT_MS = 10 * 60_000;
/** Placement rounds before giving up (wait, setup and provision each take one). */
const PLACEMENT_ROUNDS = 6;
export { DEVICE_SCREENSHOT_MAX_BASE64_CHARS } from "./screenshot-image.ts";

export interface DeviceServiceDeps {
  settingsStore: DeviceSettingsStore;
  leaseStore: DeviceLeaseStore;
  factories: readonly DeviceHostFactory[];
  actions: DeviceActionExecutor;
  screenshots: DeviceScreenshots;
  /** Publish one devices event (`DEVICES_CHANNEL`). */
  publish(type: DevicesEventType, payload: unknown): void;
  /** A chat's tab title (busy devices in `list_devices`); null when unknown. */
  threadTitle?(threadId: string): string | null;
  /** A chat's project root (where `device_install` may read builds from); null when it has none. */
  threadProject?(threadId: string): string | null;
  /** Whether a chat still exists (a lease of a closed chat found at start is released). */
  threadExists?(threadId: string): boolean;
  now?(): number;
  id?(): string;
  logger?: Pick<Console, "info" | "warn" | "error">;
  /** Overrides {@link OPEN_DEVICE_WAIT_MS} (tests). */
  openWaitMs?: number;
  /** Run the idle sweep on a timer (default true; tests drive `sweepIdle`). */
  idleTimer?: boolean;
}

/** One running or finished setup job, with its promise. */
interface SetupRun {
  job: DeviceSetupJob;
  done: Promise<void>;
  abort: AbortController;
}

/** What `openLease` is asked for. */
export interface OpenLeaseRequest {
  threadId: string;
  platform: DevicePlatform;
  profile?: string;
  hostId?: string;
  deviceId?: string;
  app?: string;
  fresh?: boolean;
  openedBy: "agent" | "user";
  /** A rental this open may need is approved (the panel's Open is the owner's; an agent's needs its card). */
  rentalApproved: boolean;
}

/** A lease being opened: its record now, and the boot finishing. */
export interface OpeningLease {
  lease: DeviceLeaseSummary;
  /** Resolves the ready lease; rejects with a `DeviceError` (the lease is then gone). */
  done: Promise<DeviceLeaseSummary>;
}

export class DeviceService implements DeviceToolsPort {
  /** `"tools"`: the devices toolset's availability may have changed. */
  readonly events = new EventEmitter();
  readonly hosts = new DeviceHostRegistry();

  private leases: StoredDeviceLease[] = [];
  private readonly actionLog: DeviceActionLog;
  private readonly progress = new Map<string, DeviceLeaseProgress>();
  /** A failed `app` launch after a boot, for `open_device`'s answer (taken once). */
  private readonly launchNotes = new Map<string, string>();
  /** Opens in flight, by lease id: aborting one cancels its boot (the lease was released). */
  private readonly opening = new Map<string, AbortController>();
  private readonly setups = new Map<DevicePlatform, SetupRun>();
  private readonly unsubscribers: (() => void)[] = [];
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private stopping = false;
  private readonly logger: Pick<Console, "info" | "warn" | "error">;

  constructor(private readonly deps: DeviceServiceDeps) {
    this.logger = deps.logger ?? console;
    this.actionLog = new DeviceActionLog({ now: () => new Date(this.nowMs()) });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Load the stores, start every factory (each adds the hosts it has now), then reconcile: a lease
   * whose boot a restart interrupted, whose chat is gone or whose host did not come back is lost or
   * released. Never throws for one factory's failure.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.deps.settingsStore.load();
    this.leases = await this.deps.leaseStore.load();
    this.deps.leaseStore.setSnapshot(() => this.leases);
    this.unsubscribers.push(this.hosts.onChange((hostId) => this.hostChanged(hostId)));
    const ctx: DeviceHostFactoryContext = {
      settings: () => this.settings(),
      activeLeases: (hostId) => this.leases.filter((lease) => lease.hostId === hostId && isLiveLease(lease)),
      addHost: (host) => this.hosts.add(host),
      removeHost: (hostId) => this.hosts.remove(hostId),
      logger: this.logger
    };
    for (const factory of this.deps.factories) {
      await factory.start(ctx).catch((error) => this.logger.error(`[devices] the ${factory.kind} host factory failed to start`, errorText(error)));
    }
    await this.reconcile();
    if (this.deps.idleTimer !== false) {
      this.sweepTimer = setInterval(() => void this.sweepIdle().catch(() => undefined), IDLE_SWEEP_MS);
      this.sweepTimer.unref?.();
    }
    this.publishHosts();
    this.events.emit("tools");
  }

  /** Stop: cancel setups and opens, stop the factories (devices keep running), flush the stores. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const run of this.setups.values()) run.abort.abort();
    for (const abort of this.opening.values()) abort.abort();
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    for (const factory of this.deps.factories) {
      await factory.stop().catch((error) => this.logger.warn(`[devices] the ${factory.kind} host factory failed to stop`, errorText(error)));
    }
    this.hosts.clear();
    await this.flush();
    this.events.emit("tools");
  }

  /** Resolves once every queued store write has landed. */
  async flush(): Promise<void> {
    await Promise.all([this.deps.leaseStore.flush(), this.deps.settingsStore.flush()]);
  }

  private async reconcile(): Promise<void> {
    const now = this.iso();
    let changed = false;
    for (const lease of [...this.leases]) {
      if (this.deps.threadExists && !this.deps.threadExists(lease.threadId)) {
        await this.releaseLease(lease.id, "chat-closed", { shutdown: true });
        continue;
      }
      if (!isLiveLease(lease)) continue;
      const reason =
        lease.state === "starting"
          ? "Orquester restarted while the device was starting."
          : !this.hosts.get(lease.hostId)
            ? "Its host did not come back after Orquester restarted."
            : null;
      if (reason) {
        this.replace({ ...lease, state: "lost", error: reason, lastUsedAt: now });
        changed = true;
      }
    }
    if (changed) void this.deps.leaseStore.persist();
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  settings(): DevicesSettings {
    return this.deps.settingsStore.settings();
  }

  /** Apply a validated patch; the factories follow it (a platform on or off adds or removes hosts). */
  async updateSettings(patch: DevicesSettingsPatch): Promise<DevicesSettings> {
    const before = this.toolsAvailable();
    const settings = await this.deps.settingsStore.update(patch);
    for (const factory of this.deps.factories) factory.settingsChanged?.(settings);
    this.deps.publish(DEVICES_SETTINGS_EVENT, { settings });
    if (before !== this.toolsAvailable()) this.events.emit("tools");
    return settings;
  }

  /** Whether the devices toolset is advertised: agents may use devices and a platform is on. */
  toolsAvailable(): boolean {
    if (!this.started || this.stopping) return false;
    const settings = this.settings();
    return settings.agents.enabled && (settings.android.enabled || settings.ios.enabled);
  }

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  hostSummaries(): DeviceHostSummary[] {
    return this.hosts.list().map((host) => {
      const summary = deviceHostSummary(host);
      const leased = this.leases.filter((lease) => lease.hostId === host.id && isLiveLease(lease)).length;
      return { ...summary, capacity: { ...summary.capacity, used: Math.max(summary.capacity.used, leased) } };
    });
  }

  /** Every device of every ready host (one host's failure leaves it out). */
  async listDevices(signal?: AbortSignal): Promise<DeviceSummary[]> {
    const lists = await Promise.all(
      this.hosts.list().map((host) =>
        host.state().status === "ready" ? host.listDevices(signal).catch(() => [] as DeviceSummary[]) : Promise.resolve([] as DeviceSummary[])
      )
    );
    return lists.flat().map((device) => ({ ...device, leaseId: this.leases.find((lease) => lease.hostId === device.hostId && lease.deviceId === device.id && isLiveLease(lease))?.id ?? null }));
  }

  /** Leases as the wire shows them (live and lost), oldest first; `threadId` narrows to one chat's. */
  leaseSummaries(filter: { threadId?: string } = {}): DeviceLeaseSummary[] {
    return this.leases
      .filter((lease) => filter.threadId === undefined || lease.threadId === filter.threadId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .flatMap((lease) => this.summary(lease) ?? []);
  }

  lease(leaseId: string): DeviceLeaseSummary | undefined {
    const lease = this.leases.find((entry) => entry.id === leaseId);
    return lease ? (this.summary(lease) ?? undefined) : undefined;
  }

  setupJobs(): DeviceSetupJob[] {
    return [...this.setups.values()].map((run) => structuredClone(run.job));
  }

  setupJob(platform: DevicePlatform): DeviceSetupJob | null {
    const run = this.setups.get(platform);
    return run ? structuredClone(run.job) : null;
  }

  /** `GET /api/devices`: everything the panel and Settings start from. */
  snapshot(): DevicesStateResponse {
    return {
      enabled: true,
      hosts: this.hostSummaries(),
      leases: this.leaseSummaries(),
      profiles: [...DEVICE_PROFILES],
      settings: this.settings(),
      setupJobs: this.setupJobs()
    };
  }

  actions(leaseId: string): DeviceActionEntry[] {
    return this.actionLog.list(leaseId);
  }

  // -------------------------------------------------------------------------
  // Setup jobs
  // -------------------------------------------------------------------------

  /**
   * Start (or join) the platform's install/repair job on its host: `actions` limits it to those
   * fix actions. Refuses `PLATFORM_NOT_READY` when the platform has no host to set up (iOS before a
   * Mac host is rented: opening an iPhone rents and prepares one).
   */
  startSetup(platform: DevicePlatform, actions?: readonly string[]): DeviceSetupJob {
    const running = this.setups.get(platform);
    if (running?.job.state === "running") return structuredClone(running.job);
    const host = this.hosts.list().find((entry) => entry.platforms.includes(platform) && entry.state().status !== "disabled");
    if (!host) {
      throw new DeviceError(
        DEVICE_ERROR_CODES.PLATFORM_NOT_READY,
        platform === "ios"
          ? "There is no Mac host to set up yet: opening an iPhone or iPad rents one and prepares it."
          : `${DEVICE_PLATFORM_LABELS[platform]} is off. Turn it on in Settings → Devices first.`
      );
    }
    return structuredClone(this.runSetup(host, platform, actions).job);
  }

  private runSetup(host: DeviceHost, platform: DevicePlatform, actions?: readonly string[]): SetupRun {
    const missing = host.readiness().checks.filter((check) => check.state !== "ok" && (!actions || (check.fixActionId !== undefined && actions.includes(check.fixActionId))));
    const job: DeviceSetupJob = {
      id: this.newId(),
      platform,
      hostId: host.id,
      state: "running",
      steps: missing.map((check) => ({ id: check.id, label: check.label, state: "pending", detail: null })),
      percent: 0,
      logLine: null,
      error: null,
      startedAt: this.iso(),
      finishedAt: null
    };
    const abort = new AbortController();
    const publish = () => this.deps.publish(DEVICES_SETUP_EVENT, { job: structuredClone(job) });
    const onProgress = (progress: DeviceHostProgress) => {
      let step = job.steps.find((entry) => entry.id === progress.step);
      if (!step) {
        step = { id: progress.step, label: progress.label, state: "pending", detail: null };
        job.steps.push(step);
      }
      step.state = progress.state;
      if (progress.detail !== undefined) step.detail = progress.detail;
      if (progress.percent !== undefined) job.percent = Math.max(0, Math.min(100, progress.percent));
      if (progress.logLine !== undefined) job.logLine = progress.logLine.slice(0, 500);
      publish();
    };
    const done = (async () => {
      try {
        await host.ensureReady(abort.signal, onProgress, actions);
        job.state = "done";
        job.percent = 100;
      } catch (error) {
        job.state = abort.signal.aborted ? "cancelled" : "failed";
        job.error = isDeviceError(error) ? error.message : "The setup failed. See the daemon log.";
        if (!isDeviceError(error)) this.logger.error(`[devices] setup of ${host.id} failed`, errorText(error));
      } finally {
        job.finishedAt = this.iso();
        for (const step of job.steps) if (step.state === "running" || step.state === "pending") step.state = job.state === "done" ? "done" : "skipped";
        await host.refreshReadiness().catch(() => undefined);
        publish();
        this.publishHosts();
      }
    })();
    const run: SetupRun = { job, done, abort };
    this.setups.set(platform, run);
    publish();
    return run;
  }

  // -------------------------------------------------------------------------
  // Leases
  // -------------------------------------------------------------------------

  /**
   * Lease a device for a chat: place it (waiting for a starting host, running the setup the owner
   * consented to by enabling the platform, renting a host when allowed), record the `starting`
   * lease, then boot. Resolves as soon as the lease exists; `done` follows the boot.
   */
  async beginOpen(request: OpenLeaseRequest, signal: AbortSignal): Promise<OpeningLease> {
    this.assertRunning();
    if (this.deps.threadExists && !this.deps.threadExists(request.threadId)) {
      throw new DeviceError("INVALID_ARGUMENT", "There is no such chat to lease a device to.");
    }
    const profile = this.resolveProfile(request.platform, request.profile);
    if (request.hostId !== undefined && request.deviceId !== undefined) {
      const existing = this.leases.find((lease) => lease.hostId === request.hostId && lease.deviceId === request.deviceId && isLiveLease(lease));
      if (existing && existing.threadId === request.threadId) {
        const summary = this.summary(existing)!;
        return { lease: summary, done: Promise.resolve(summary) };
      }
    }
    const limits = { maxPerThread: this.settings().maxLeasesPerChat };
    const refused = checkAcquire(this.leases, request, limits);
    if (refused) throw refused;

    const host = await this.place(request, signal);
    // Placement may have waited: check again right before the lease exists (no await in between).
    const late = checkAcquire(this.leases, request, limits);
    if (late) throw late;
    const lease = newLease({
      id: this.newId(),
      threadId: request.threadId,
      hostId: host.id,
      platform: request.platform,
      profile: profile.id,
      name: profile.label,
      osVersion: profile.os,
      openedBy: request.openedBy,
      now: this.iso()
    });
    this.leases.push(lease);
    this.setProgress(lease.id, "start-device", `Starting ${profile.label}`);
    void this.deps.leaseStore.persist();
    this.publishLease(lease);
    this.publishHosts();

    const abort = new AbortController();
    const onAbort = () => abort.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    this.opening.set(lease.id, abort);
    const done = this.boot(lease, host, profile, request, abort.signal).finally(() => {
      signal.removeEventListener("abort", onAbort);
      this.opening.delete(lease.id);
    });
    return { lease: this.summary(lease)!, done };
  }

  /** {@link beginOpen} and wait for the boot. */
  async openLease(request: OpenLeaseRequest, signal: AbortSignal): Promise<DeviceLeaseSummary> {
    const opening = await this.beginOpen(request, signal);
    return opening.done;
  }

  private async boot(lease: StoredDeviceLease, host: DeviceHost, profile: DeviceProfile, request: OpenLeaseRequest, signal: AbortSignal): Promise<DeviceLeaseSummary> {
    let booted;
    try {
      booted = await host.boot(
        { leaseId: lease.id, profile, ...(request.deviceId !== undefined ? { deviceId: request.deviceId } : {}), fresh: request.fresh === true },
        signal,
        (progress) => this.setProgress(lease.id, progress.step, progress.label)
      );
    } catch (error) {
      const current = this.leases.find((entry) => entry.id === lease.id);
      if (current) await this.releaseLease(lease.id, "failed", { shutdown: true });
      if (signal.aborted) throw new DeviceError("CANCELLED", "The device was released before it finished starting.");
      if (isDeviceError(error)) throw error;
      this.logger.error(`[devices] booting ${profile.id} on ${host.id} failed`, errorText(error));
      throw new DeviceError("UNAVAILABLE", `${profile.label} did not start. Try again, or ask the owner to check Settings → Devices.`);
    }
    const current = this.leases.find((entry) => entry.id === lease.id);
    if (!current || signal.aborted) {
      // Released (or the chat closed) while it booted: hand the device back.
      await host.release({ ...lease, deviceId: booted.deviceId }, { shutdown: true }).catch(() => undefined);
      throw new DeviceError("CANCELLED", "The device was released before it finished starting.");
    }
    this.progress.delete(lease.id);
    const ready = leaseBooted(current, booted, this.iso());
    this.replace(ready);
    void this.deps.leaseStore.persist();
    this.publishLease(ready);
    this.publishHosts();
    if (request.app) {
      // Best effort: the device is ready either way; a failed launch is noted for the agent.
      try {
        await this.deps.actions.launch({ host, lease: ready }, request.app, signal);
      } catch (error) {
        this.launchNotes.set(lease.id, `The device is ready, but ${request.app} could not be launched: ${isDeviceError(error) ? error.message : "unknown error"}.`);
      }
    }
    return this.summary(this.leases.find((entry) => entry.id === lease.id) ?? ready)!;
  }

  /** Pick the host for a new lease, doing what placement asks first (wait, setup, rent). */
  private async place(request: OpenLeaseRequest, signal: AbortSignal): Promise<DeviceHost> {
    const settings = this.settings();
    for (let round = 0; round < PLACEMENT_ROUNDS; round += 1) {
      if (signal.aborted) throw new DeviceError("CANCELLED", "The request was cancelled.");
      const factory = this.provisioner(request.platform);
      const placement = choosePlacement({
        platform: request.platform,
        hosts: this.placementHosts(),
        settings,
        canProvision: factory !== null,
        ...(request.hostId !== undefined ? { hostId: request.hostId } : {})
      });
      switch (placement.kind) {
        case "host": {
          const host = this.hosts.get(placement.hostId);
          if (host) return host;
          continue;
        }
        case "wait":
          await this.waitForHost(placement.hostId, signal);
          continue;
        case "setup": {
          const run = this.setups.get(request.platform);
          const setup = run?.job.state === "running" ? run : this.runSetup(this.hosts.get(placement.hostId)!, request.platform, placement.actions);
          await setup.done;
          if (setup.job.state !== "done") throw new DeviceError(DEVICE_ERROR_CODES.PLATFORM_NOT_READY, `Setting up ${DEVICE_PLATFORM_LABELS[request.platform]} failed: ${setup.job.error ?? "unknown error"}. Ask the owner to check Settings → Devices.`);
          continue;
        }
        case "provision": {
          // Fail closed: a rental nobody could quote needs the owner's approval too.
          const quote = factory!.provisionQuote?.(request.platform) ?? null;
          if ((quote === null || quote.needsApproval) && !request.rentalApproved) {
            const what = quote ? `a ${quote.providerLabel} host (${quote.sizeLabel})` : "a device host";
            throw new DeviceError(DEVICE_ERROR_CODES.PLATFORM_NOT_READY, `Opening this device rents ${what}, which needs the owner's approval. Call open_device again to ask them.`);
          }
          await factory!.provision!({ platform: request.platform, threadId: request.threadId, approved: request.rentalApproved }, signal);
          continue;
        }
        case "full": {
          const busy = this.leases.filter((lease) => placement.hostIds.includes(lease.hostId) && isLiveLease(lease));
          throw new DeviceError(
            DEVICE_ERROR_CODES.DEVICE_CAPACITY,
            `Every ${DEVICE_PLATFORM_LABELS[request.platform]} host is full${busy.length > 0 ? ` (in use: ${busy.map(describeLease).join(", ")})` : ""}. Close a device with close_device, or try again later.`
          );
        }
        case "not-ready": {
          const missing = placement.missing.map((check) => check.label);
          throw new DeviceError(
            DEVICE_ERROR_CODES.PLATFORM_NOT_READY,
            `${DEVICE_PLATFORM_LABELS[request.platform]} devices are not ready${missing.length > 0 ? `: missing ${missing.join(", ")}` : ""}. Ask the owner to set it up in Settings → Devices.`
          );
        }
        case "disabled":
          throw new DeviceError(
            DEVICE_ERROR_CODES.PLATFORM_NOT_READY,
            `${DEVICE_PLATFORM_LABELS[request.platform]} devices are off. Ask the owner to enable them in Settings → Devices.`
          );
      }
    }
    throw new DeviceError(DEVICE_ERROR_CODES.DEVICE_CAPACITY, `No ${DEVICE_PLATFORM_LABELS[request.platform]} host became available. Try again later.`);
  }

  private placementHosts(): PlacementHost[] {
    return this.hostSummaries().map((host) => ({
      id: host.id,
      kind: host.kind,
      platforms: host.platforms,
      status: host.status,
      checks: host.readiness.checks,
      used: host.capacity.used,
      total: host.capacity.total,
      ...(host.pool?.draining ? { draining: true } : {})
    }));
  }

  /** The factory that rents hosts for `platform`, or null. */
  private provisioner(platform: DevicePlatform): DeviceHostFactory | null {
    return this.deps.factories.find((factory) => factory.provision !== undefined && factory.platforms.includes(platform)) ?? null;
  }

  /**
   * Until the host's status changes (or it goes), the call aborts, or {@link HOST_WAIT_MS} passes.
   * Progress lines of a starting host (a rented Mac being prepared) are changes too, but only a new
   * status is worth another placement round.
   */
  private waitForHost(hostId: string, signal: AbortSignal): Promise<void> {
    const status = this.hosts.get(hostId)?.state().status;
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        unsubscribe();
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const unsubscribe = this.hosts.onChange((changed) => {
        if (changed === hostId && this.hosts.get(hostId)?.state().status !== status) finish();
      });
      const timer = setTimeout(finish, HOST_WAIT_MS);
      timer.unref?.();
      signal.addEventListener("abort", finish, { once: true });
    });
  }

  /**
   * End a lease: it leaves the store, its log goes, the host tears down what it made (or turns it
   * off with `shutdown`). Resolves the released lease, or null when there was none.
   */
  async releaseLease(leaseId: string, reason: DeviceLeaseCloseReason, options: { shutdown?: boolean } = {}): Promise<DeviceLeaseSummary | null> {
    const lease = this.leases.find((entry) => entry.id === leaseId);
    if (!lease) return null;
    this.leases = this.leases.filter((entry) => entry.id !== leaseId);
    this.opening.get(leaseId)?.abort();
    this.progress.delete(leaseId);
    this.launchNotes.delete(leaseId);
    this.actionLog.forget(leaseId);
    void this.deps.leaseStore.persist();
    const released = { ...lease, state: "released", lastUsedAt: this.iso() };
    const summary = this.summary(released);
    if (summary) this.deps.publish(DEVICES_LEASE_EVENT, { lease: summary });
    this.deps.publish(DEVICES_LEASE_CLOSED_EVENT, { leaseId, threadId: lease.threadId, reason });
    this.publishHosts();
    const host = this.hosts.get(lease.hostId);
    if (host && lease.deviceId !== null) {
      // Its agent-device session ends first (Android gets its own keyboard back).
      await this.deps.actions.end?.({ host, lease }).catch(() => undefined);
      await host.release(lease, { shutdown: options.shutdown === true }).catch((error) => this.logger.warn(`[devices] releasing ${describeLease(lease)} failed`, errorText(error)));
    }
    return summary;
  }

  /** Every lease ends (the plugin was turned off: nothing may keep running). */
  async releaseAll(reason: DeviceLeaseCloseReason): Promise<void> {
    for (const lease of [...this.leases]) await this.releaseLease(lease.id, reason, { shutdown: true });
  }

  /** Settings → Devices "Destroy" on a box host: its box goes, its leases end lost. */
  async destroyHost(hostId: string): Promise<void> {
    this.assertRunning();
    const host = this.hosts.get(hostId);
    if (!host) throw new DeviceError(DEVICE_ERROR_CODES.HOST_NOT_FOUND, `There is no device host ${hostId}.`);
    if (!host.destroy) throw new DeviceError("INVALID_ARGUMENT", `${host.label} cannot be destroyed (only rented hosts can).`);
    await host.destroy();
  }

  /** A chat closed: every lease it holds ends, and its kept screenshots go. */
  async releaseThread(threadId: string, reason: DeviceLeaseCloseReason = "chat-closed"): Promise<void> {
    for (const lease of this.leases.filter((entry) => entry.threadId === threadId)) {
      await this.releaseLease(lease.id, reason, { shutdown: true });
    }
    await this.deps.screenshots.forgetThread(threadId);
  }

  /** The panel's Take over / Give back. */
  setController(leaseId: string, controller: DeviceController): DeviceLeaseSummary {
    const lease = this.requireLease(leaseId);
    const next = withController(lease, controller, this.iso());
    if (next !== lease) this.commit(next);
    return this.summary(next)!;
  }

  /**
   * The panel's first input on a device (the hub proxy calls it per input frame): the user takes
   * control at once, and the idle clock restarts. `deviceParam` is the device's id or its stream's
   * `device` parameter. Unknown devices are ignored.
   */
  userInput(hostId: string, deviceParam: string): void {
    const lease = this.leases.find((entry) => entry.hostId === hostId && isLiveLease(entry) && (entry.deviceId === deviceParam || entry.stream?.deviceParam === deviceParam));
    if (!lease) return;
    const next = userInput(lease, this.iso());
    if (next.controller !== lease.controller) this.commit(next);
    else this.replace(next);
  }

  /** A viewer is watching (the stream relay calls it while connected): the idle clock restarts. */
  viewerActive(leaseId: string): void {
    const lease = this.leases.find((entry) => entry.id === leaseId);
    if (lease) this.replace(touchLease(lease, this.iso()));
  }

  /** The lease on a device, for the proxy's view checks: null when none is live. */
  leaseOnDevice(hostId: string, deviceParam: string): DeviceLeaseSummary | null {
    const lease = this.leases.find((entry) => entry.hostId === hostId && isLiveLease(entry) && (entry.deviceId === deviceParam || entry.stream?.deviceParam === deviceParam));
    return lease ? this.summary(lease) : null;
  }

  /** Whether a host has a live lease (viewing its hub needs one, spec §8). */
  hostHasLease(hostId: string): boolean {
    return this.leases.some((lease) => lease.hostId === hostId && isLiveLease(lease));
  }

  /** The hub origin the proxy targets for a host, or null (unknown host, hub not running). */
  hubOrigin(hostId: string): string | null {
    return this.hosts.get(hostId)?.hubOrigin() ?? null;
  }

  /** The hub's session token the proxy adds upstream, or null (none, or unknown host). Never sent to clients. */
  hubToken(hostId: string): string | null {
    return this.hosts.get(hostId)?.hubToken?.() ?? null;
  }

  /** How many proxied streams of a leased device are open now: its host may recycle an unwatched capture. */
  streamViewers(hostId: string, deviceParam: string, count: number): void {
    const lease = this.leases.find((entry) => entry.hostId === hostId && (entry.deviceId === deviceParam || entry.stream?.deviceParam === deviceParam));
    const host = this.hosts.get(hostId);
    if (!host?.viewersChanged) return;
    try {
      host.viewersChanged(lease?.deviceId ?? deviceParam, count);
    } catch (error) {
      this.logger.warn(`[devices] ${hostId} failed to take a viewer count`, errorText(error));
    }
  }

  /** Release every idle lease (spec §7: `leaseIdleMinutes` with no agent or viewer activity). */
  async sweepIdle(): Promise<void> {
    for (const lease of idleLeases(this.leases, this.nowMs(), this.settings().leaseIdleMinutes)) {
      await this.releaseLease(lease.id, "idle", { shutdown: true });
    }
  }

  /** Append one action-log row and broadcast it; the lease's idle clock restarts. */
  recordAction(leaseId: string, draft: DeviceActionDraft): DeviceActionEntry {
    const entry = this.actionLog.append(leaseId, draft);
    const lease = this.leases.find((item) => item.id === leaseId);
    if (lease) {
      this.replace(touchLease(lease, entry.at));
      this.deps.publish(DEVICES_ACTION_EVENT, { leaseId, threadId: lease.threadId, entry });
    }
    return entry;
  }

  /** A kept screenshot (`GET deviceRoutes.screenshot`). */
  screenshot(leaseId: string, screenshotId: string): Promise<{ mimeType: "image/png" | "image/jpeg"; data: Buffer } | null> {
    return this.deps.screenshots.read(leaseId, screenshotId);
  }

  // -------------------------------------------------------------------------
  // The agent tools (DeviceToolsPort)
  // -------------------------------------------------------------------------

  toolList(threadId: string): DeviceToolList {
    this.assertRunning();
    const settings = this.settings();
    const hosts = this.hostSummaries();
    const platforms = DEVICE_PLATFORMS.map((platform) => {
      const enabled = platform === "android" ? settings.android.enabled : settings.ios.enabled;
      const ready = hosts.some((host) => host.platforms.includes(platform) && host.status === "ready");
      const detail = !enabled
        ? "Off in Settings → Devices."
        : ready
          ? null
          : platform === "ios" && this.provisioner("ios")
            ? "No Mac host yet: open_device rents one."
            : (hosts.find((host) => host.platforms.includes(platform))?.statusDetail ?? "Not set up.");
      return { platform, enabled, ready, detail };
    });
    const enabledPlatforms = platforms.filter((entry) => entry.enabled).map((entry) => entry.platform);
    return {
      hosts,
      profiles: DEVICE_PROFILES.filter((profile) => enabledPlatforms.includes(profile.platform)),
      platforms,
      mine: this.leaseSummaries({ threadId }),
      busy: this.leases
        .filter((lease) => lease.threadId !== threadId && isLiveLease(lease) && isDevicePlatform(lease.platform))
        .map((lease) => ({ key: leaseKeyOf(lease), platform: lease.platform as DevicePlatform, name: lease.name, chat: this.deps.threadTitle?.(lease.threadId) ?? null }))
    };
  }

  toolPlanOpen(_threadId: string, platform: DevicePlatform): DeviceOpenPlan {
    this.assertRunning();
    const factory = this.provisioner(platform);
    if (!factory) return { rental: null };
    const placement = choosePlacement({ platform, hosts: this.placementHosts(), settings: this.settings(), canProvision: true });
    if (placement.kind !== "provision") return { rental: null };
    return { rental: factory.provisionQuote?.(platform) ?? null };
  }

  async toolOpen(threadId: string, input: DeviceToolOpenInput, signal: AbortSignal): Promise<DeviceToolOpenResult> {
    this.assertAgentsAllowed();
    const opening = await this.beginOpen(
      {
        threadId,
        platform: input.platform,
        ...(input.profile !== undefined ? { profile: input.profile } : {}),
        ...(input.app !== undefined ? { app: input.app } : {}),
        ...(input.fresh !== undefined ? { fresh: input.fresh } : {}),
        openedBy: "agent",
        rentalApproved: input.rentalApproved === true
      },
      signal
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = await Promise.race([
      opening.done.then((lease) => ({ lease })),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), this.deps.openWaitMs ?? OPEN_DEVICE_WAIT_MS);
        timer.unref?.();
      })
    ]).finally(() => clearTimeout(timer));
    if (!waited) {
      // Still booting: the boot carries on; the agent checks back with list_devices.
      opening.done.catch(() => undefined);
      const lease = this.lease(opening.lease.id) ?? opening.lease;
      return { lease, ready: false, progress: lease.progress?.label ?? "Starting" };
    }
    const note = this.launchNotes.get(waited.lease.id);
    this.launchNotes.delete(waited.lease.id);
    return { lease: this.lease(waited.lease.id) ?? waited.lease, ready: true, ...(note ? { note } : {}) };
  }

  async toolAction(threadId: string, device: string | undefined, input: DeviceActionInput, signal: AbortSignal): Promise<DeviceToolActionResult> {
    this.assertAgentsAllowed();
    const invalid = validateDeviceActionInput(input);
    if (invalid) throw new DeviceError("INVALID_ARGUMENT", invalid);
    const { lease, host } = this.agentTarget(threadId, device);
    const refused = checkAgentAction(lease, input.action);
    if (refused) throw refused;
    let result: DeviceActionResult;
    try {
      result = await this.deps.actions.execute({ host, lease }, input, signal);
    } catch (error) {
      const message = isDeviceError(error) ? error.message : "The action failed.";
      this.recordAction(lease.id, { actor: "agent", kind: input.action, summary: `${input.action} failed`, ok: false, error: message });
      if (isDeviceError(error)) throw error;
      this.logger.error(`[devices] ${input.action} on ${describeLease(lease)} failed`, errorText(error));
      throw new DeviceError("UNAVAILABLE", message);
    }
    const entry = this.recordAction(lease.id, { actor: "agent", kind: input.action, ...result.log, ok: true });
    let screenshotId: string | undefined;
    let image: DeviceToolActionResult["image"];
    if (result.image) {
      screenshotId = (await this.deps.screenshots.save(threadId, lease.id, { mimeType: result.image.mimeType, data: result.image.data })) ?? undefined;
      const base64 = result.image.data.toString("base64");
      if (base64.length <= DEVICE_SCREENSHOT_MAX_BASE64_CHARS) {
        image = { mimeType: result.image.mimeType, base64, width: result.image.width, height: result.image.height };
      }
    }
    return {
      lease: this.lease(lease.id)!,
      entry,
      ...(result.text !== undefined ? { text: result.text } : {}),
      ...(image ? { image } : {}),
      ...(screenshotId ? { screenshotId } : {}),
      ...(result.details ? { details: result.details } : {})
    };
  }

  async toolInstall(threadId: string, input: DeviceToolInstallInput, signal: AbortSignal): Promise<DeviceToolInstallResult> {
    this.assertAgentsAllowed();
    const { lease, host } = this.agentTarget(threadId, input.device);
    const refused = checkAgentAction(lease, "open_app");
    if (refused) throw refused;
    const localPath = await this.projectPath(threadId, input.path);
    const result = await this.deps.actions.install({ host, lease }, localPath, signal);
    this.recordAction(lease.id, { actor: "agent", kind: "open_app", summary: `Installed ${result.appId ?? input.path.split("/").pop() ?? "a build"}`, ok: true });
    return { lease: this.lease(lease.id)!, appId: result.appId, summary: result.summary };
  }

  async toolClose(threadId: string, input: DeviceToolCloseInput): Promise<{ lease: DeviceLeaseSummary }> {
    this.assertRunning();
    const lease = resolveLeaseHandle(this.leases, threadId, input.device);
    if (isDeviceError(lease)) throw lease;
    const released = await this.releaseLease(lease.id, "agent", { shutdown: input.shutdown === true });
    return { lease: released ?? this.summary({ ...lease, state: "released" })! };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** The lease a tool names and its host; a lease whose host is gone becomes lost. */
  private agentTarget(threadId: string, device: string | undefined): { lease: StoredDeviceLease; host: DeviceHost } {
    const lease = resolveLeaseHandle(this.leases, threadId, device);
    if (isDeviceError(lease)) throw lease;
    const host = this.hosts.get(lease.hostId);
    if (!host && isLiveLease(lease)) {
      const lost = { ...lease, state: "lost", error: "Its host is gone." };
      this.commit(lost);
      throw checkAgentAction(lost, "snapshot")!;
    }
    if (!host) throw checkAgentAction(lease, "snapshot") ?? new DeviceError(DEVICE_ERROR_CODES.DEVICE_LOST, "The device is gone. Call open_device again.");
    return { lease, host };
  }

  /** `path` (absolute) as a real path inside the chat's project, or a refusal. */
  private async projectPath(threadId: string, path: string): Promise<string> {
    const project = this.deps.threadProject?.(threadId) ?? null;
    if (!project) throw new DeviceError("INVALID_ARGUMENT", "This chat has no project, so there is nothing to install from.");
    if (!isAbsolute(path)) throw new DeviceError("INVALID_ARGUMENT", "`path` must be absolute.");
    let real: string;
    let root: string;
    try {
      [real, root] = await Promise.all([realpath(path), realpath(project)]);
      await stat(real);
    } catch {
      throw new DeviceError("INVALID_ARGUMENT", `${path} does not exist.`);
    }
    const rel = relative(root, real);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new DeviceError("INVALID_ARGUMENT", "`path` must be inside this chat's project.");
    return real;
  }

  private resolveProfile(platform: DevicePlatform, id: string | undefined): DeviceProfile {
    const profile = deviceProfile(id ?? DEFAULT_DEVICE_PROFILE[platform]);
    if (!profile || profile.platform !== platform) {
      throw new DeviceError("INVALID_ARGUMENT", `${id} is not a ${DEVICE_PLATFORM_LABELS[platform]} profile. Call list_devices for the profiles.`);
    }
    return profile;
  }

  private requireLease(leaseId: string): StoredDeviceLease {
    const lease = this.leases.find((entry) => entry.id === leaseId);
    if (!lease) throw new DeviceError(DEVICE_ERROR_CODES.DEVICE_NOT_LEASED, "There is no such lease.");
    return lease;
  }

  private assertRunning(): void {
    if (!this.started || this.stopping) throw new DeviceError(DEVICE_ERROR_CODES.DEVICES_DISABLED, "Device simulators are off.");
  }

  private assertAgentsAllowed(): void {
    this.assertRunning();
    if (!this.settings().agents.enabled) {
      throw new DeviceError(DEVICE_ERROR_CODES.DEVICES_DISABLED, "The owner turned agent access to devices off in Settings → Devices.");
    }
  }

  private summary(lease: StoredDeviceLease): DeviceLeaseSummary | null {
    const summary = toLeaseSummary(lease);
    if (!summary) return null;
    const progress = this.progress.get(lease.id);
    return progress && summary.state === "starting" ? { ...summary, progress: { ...progress } } : summary;
  }

  /** Swap a lease's record in memory (no write, no event: activity stamps). */
  private replace(next: StoredDeviceLease): void {
    this.leases = this.leases.map((entry) => (entry.id === next.id ? next : entry));
  }

  /** Swap, persist and publish. */
  private commit(next: StoredDeviceLease): void {
    this.replace(next);
    void this.deps.leaseStore.persist();
    this.publishLease(next);
  }

  private setProgress(leaseId: string, step: string, label: string): void {
    const current = this.progress.get(leaseId);
    if (current?.step === step && current.label === label) return;
    this.progress.set(leaseId, { step, label, startedAt: this.iso() });
    const lease = this.leases.find((entry) => entry.id === leaseId);
    if (lease) this.publishLease(lease);
  }

  private publishLease(lease: StoredDeviceLease): void {
    const summary = this.summary(lease);
    if (summary) this.deps.publish(DEVICES_LEASE_EVENT, { lease: summary });
  }

  private publishHosts(): void {
    if (this.stopping) return;
    this.deps.publish(DEVICES_HOSTS_EVENT, { hosts: this.hostSummaries() });
  }

  /**
   * A host was added, removed or changed: republish. A removed host's leases are lost (not at
   * shutdown); an unreachable one's ready leases are suspended (its devices keep running), and
   * resume when it is ready again.
   */
  private hostChanged(hostId: string): void {
    if (this.stopping) return;
    const host = this.hosts.get(hostId);
    const status = host?.state().status;
    const change = !host ? "lost" : status === "unreachable" ? "suspended" : status === "ready" ? "ready" : null;
    if (change) {
      for (const lease of hostLeasesChanged(this.leases, hostId, change, this.iso(), "Its host is gone.")) this.commit(lease);
    }
    this.publishHosts();
  }

  private nowMs(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private iso(): string {
    return new Date(this.nowMs()).toISOString();
  }

  private newId(): string {
    return this.deps.id?.() ?? randomUUID();
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
