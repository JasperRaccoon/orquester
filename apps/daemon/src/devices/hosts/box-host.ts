/**
 * Box device hosts (devices spec §6.3): Macs running iOS simulators, reached through the box
 * service (`BoxConnection`; no SSH). Two kinds:
 *
 * - **Rented** (`kind: "box"`): a box with purpose `device-host` (`threadId: null`) the factory
 *   rents in `provision` from Settings → Devices (provider, size, lifetime). The box's `devices`
 *   setup step runs this factory's preparer (`BoxService.setDeviceHostPreparer`): the box is ready
 *   only once the host is. Near its time limit a rented host drains (no new lease; the pool
 *   destroys it once empty); a failed one with no lease is destroyed at once. Idle teardown is the
 *   pool's alone (`pool-actor.ts`, `pool.idleTeardownMinutes`).
 * - **Your own Mac** (`kind: "byo"`): a bring-your-own machine the owner uses for device
 *   simulators — its machine's policy in the machines registry (visible, "Device simulators" on;
 *   `machine-access.ts`), or without the registry the box's "Use for device simulators"
 *   (`BoxSummary.deviceHost`). Prepared when it connects; never destroyed — idle for
 *   `pool.idleTeardownMinutes`, its helpers (hub, agent-device daemon) stop, and start again with
 *   the next lease. A machine whose policy turns devices off (Hidden, or the switch off) loses its
 *   host at once, and everything of devices running on it stops.
 *
 * `start` adds a host for every such box already recorded (a restart reattaches: the hub and the
 * agent-device daemon keep running in the box and are found again). A box whose link drops makes
 * its host `unreachable` (the service suspends its leases); a destroyed box removes its host (its
 * leases are lost).
 *
 * Linux boxes run Android emulators (`box/android-host.ts`): rented device-host boxes of kind
 * `linux` (Blacksmith x64 runners; `provision({ platform: "android" })` rents one of
 * `pool.androidSize`, default `blacksmith-16vcpu-ubuntu-2404`, with the device caches restored) and
 * the owner's Linux machines marked for devices once their orq-agent reported a usable `/dev/kvm`.
 *
 * An owner's Apple Silicon Mac (its orq-agent reported `arm64`) is two device hosts: its iOS
 * simulators (`box:<boxId>`) and its Android emulators (`box:<boxId>:android`, arm64-v8a images
 * under Hypervisor.framework). Each counts what the other holds (`box/shared-load.ts`), and a change
 * in one's devices tells the other. Rented Macs are VMs (no nested Hypervisor.framework): iOS only.
 */

import { DEVICE_ERROR_CODES, boxAndroidDeviceHostId, boxDeviceHostId, type BoxSizeOffer, type DevicePlatform, type DevicesSettings } from "@orquester/api";
import type { StoredBox } from "@orquester/config";

import type { BoxConnection } from "../../boxes/contracts.ts";
import type { DaemonBoxes } from "../../boxes/wiring.ts";
import { DeviceError, isDeviceError } from "../errors.ts";
import type { DeviceHost, DeviceHostFactory, DeviceHostFactoryContext, DeviceHostProvisionRequest, DeviceRentalQuote } from "../host.ts";
import { byoRunsDevices, type DeviceMachineAccess } from "../machine-access.ts";
import type { DeviceToolchain } from "../toolchain/index.ts";
import { BoxAndroidHost } from "./box/android-host.ts";
import { androidRentalSpec } from "./box/android-remote.ts";
import { BoxDeviceHost } from "./box/host.ts";
import { NO_LOAD, type MachineDeviceLoad } from "./box/shared-load.ts";
import { deviceHostSpend, iosRentalSpec, rentalNeedsApproval } from "./box/rental.ts";

export interface BoxHostDeps {
  appDir: string;
  /** The Ephemeral AI VMs wiring (the box service, its registry and hub); null while that plugin is unavailable. */
  boxes: () => Pick<DaemonBoxes, "service" | "registry" | "hub"> | null;
  toolchain: DeviceToolchain;
  logger: Pick<Console, "info" | "warn" | "error">;
  fetch?: typeof fetch;
  /** The machines registry's policies (absent: the boxes' own "Use for device simulators" decides). */
  machineAccess?: DeviceMachineAccess | null;
}

/** A box host of either platform: Macs run iOS simulators, Linux boxes with KVM Android emulators. */
type BoxHost = BoxDeviceHost | BoxAndroidHost;

/** A device host role: rented (`box`) or the owner's (`byo`), and its platform. */
export interface DeviceHostRole {
  kind: "box" | "byo";
  platform: DevicePlatform;
}

/** The sweep's period (failed rented hosts, idle own Macs' helpers). */
const IDLE_SWEEP_MS = 60_000;

/**
 * What kind of device host a box record is, or null when it is none: rented device-host boxes (a
 * Mac runs iOS, a Linux box Android) and the owner's machines used for device simulators (their
 * policy in `access`, else "Use for device simulators"; a Mac; a Linux machine only once its
 * orq-agent reported a usable `/dev/kvm`). A Mac's first role (iOS); {@link deviceHostsOfRecord} has all.
 */
export function deviceHostOfRecord(record: StoredBox, access: DeviceMachineAccess | null = null): DeviceHostRole | null {
  return deviceHostsOfRecord(record, access)[0] ?? null;
}

/** A Mac: paired as one (`kind`), or reported so by its orq-agent (`os`). */
function isMacRecord(record: StoredBox): boolean {
  return record.kind === "macos" || record.os === "darwin";
}

/**
 * Every device host a box record is: one for rented boxes and Linux machines, two for an owner's
 * Apple Silicon Mac (iOS, then Android: its orq-agent reported `arm64`; an Intel Mac or one not
 * yet connected runs iOS only).
 */
export function deviceHostsOfRecord(record: StoredBox, access: DeviceMachineAccess | null = null): DeviceHostRole[] {
  if (record.state === "destroyed") return [];
  if (record.provider === "byo") {
    if (!byoRunsDevices(record.id, record.deviceHost, access)) return [];
    if (isMacRecord(record)) return record.arch === "arm64" ? [{ kind: "byo", platform: "ios" }, { kind: "byo", platform: "android" }] : [{ kind: "byo", platform: "ios" }];
    if ((record.kind === "linux" || record.os === "linux") && record.kvm === true) return [{ kind: "byo", platform: "android" }];
    return [];
  }
  if (record.purpose !== "device-host") return [];
  if (record.kind === "macos") return [{ kind: "box", platform: "ios" }];
  if (record.kind === "linux") return [{ kind: "box", platform: "android" }];
  return [];
}

/** The device host id of a box's `role`: `box:<boxId>`, or `box:<boxId>:android` for a Mac's Android emulators. */
export function deviceHostIdOf(record: Pick<StoredBox, "id" | "kind" | "os">, role: DeviceHostRole): string {
  return role.platform === "android" && isMacRecord(record as StoredBox) ? boxAndroidDeviceHostId(record.id) : boxDeviceHostId(record.id);
}

function deviceHostLabel(record: StoredBox): string {
  const linux = record.kind === "linux" || record.os === "linux";
  if (record.provider === "byo") {
    const name = typeof record.machineName === "string" && record.machineName ? record.machineName : linux ? "Your machine" : "Your Mac";
    return `${name} (your ${linux ? "Linux machine" : "Mac"})`;
  }
  const provider = record.provider === "blacksmith" ? "Blacksmith" : record.provider;
  const size = typeof record.sizeLabel === "string" && record.sizeLabel ? record.sizeLabel.split(" · ")[0] : record.size;
  return `${linux ? "Android host" : "Mac host"} (${provider}, ${size})`;
}

/** "Mac" or "Linux", for messages about renting a host of `platform`. */
function hostWord(platform: DevicePlatform): string {
  return platform === "ios" ? "Mac" : "Linux";
}


export function createBoxHostFactory(deps: BoxHostDeps): DeviceHostFactory {
  const { logger } = deps;
  const now = () => Date.now();
  /** Host id → host (a Mac has two: iOS and Android). */
  const hosts = new Map<string, BoxHost>();
  /** Since when each host has had no lease (host id → ms). */
  const idleSince = new Map<string, number>();
  /** What each host held when last looked at (host id → devices): a change tells its machine's other host. */
  const loads = new Map<string, number>();
  const unsubscribers: (() => void)[] = [];
  let ctx: DeviceHostFactoryContext | null = null;
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** One rental at a time per platform. */
  const provisioning = new Map<DevicePlatform, Promise<DeviceHost>>();
  /** The shared rental's own abort (the factory stopping), never one caller's. */
  let rentalAbort = new AbortController();
  let sizeOffers: BoxSizeOffer[] = [];
  let linuxOffers: BoxSizeOffer[] = [];
  /** The settings as last read (hosts read them after `stop` too, while they are disposed). */
  let lastSettings: DevicesSettings | null = null;

  const settings = (): DevicesSettings | null => {
    if (ctx) lastSettings = ctx.settings();
    return lastSettings;
  };

  const connection = (boxId: string): BoxConnection | undefined => deps.boxes()?.hub.get(boxId);

  /** Prepare a host in the background (it reports its own failure in its status). */
  const prepareInBackground = (host: BoxHost): void => {
    const link = connection(host.boxId);
    if (!link?.connected) return;
    void host.prepare(link, AbortSignal.timeout(30 * 60_000)).catch((error) => {
      if (!isDeviceError(error)) logger.warn(`[devices] preparing ${host.id} failed`, error instanceof Error ? error.message : String(error));
    });
  };

  const destroyBoxOf = (boxId: string) => async () => {
    const boxes = deps.boxes();
    if (!boxes) throw new DeviceError("UNAVAILABLE", "Ephemeral AI VMs is unavailable, so the host cannot be destroyed now.");
    await boxes.service.destroyBox(boxId, "deleted", "Destroyed from Settings → Devices.");
  };

  /** The hosts on one box (a Mac's iOS and Android hosts). */
  const hostsOfBox = (boxId: string): BoxHost[] => [...hosts.values()].filter((host) => host.boxId === boxId);

  /** What the box's other host holds now (a Mac's iOS host for its Android host, and back). */
  const siblingLoad = (boxId: string, hostId: string) => (): MachineDeviceLoad => {
    const other = hostsOfBox(boxId).find((host) => host.id !== hostId);
    return other ? other.deviceLoad() : NO_LOAD;
  };

  /** A host's devices changed: its machine's other host's capacity follows (once per change, so the two never ping-pong). */
  const watchLoad = (host: BoxHost): void => {
    loads.set(host.id, host.deviceLoad().devices);
    host.onChange(() => {
      const devices = host.deviceLoad().devices;
      if (loads.get(host.id) === devices) return;
      loads.set(host.id, devices);
      for (const other of hostsOfBox(host.boxId)) if (other !== host) other.siblingChanged();
    });
  };

  const addHost = (record: StoredBox, role: DeviceHostRole): BoxHost => {
    const boxId = record.id;
    const hostId = deviceHostIdOf(record, role);
    const kind = role.kind;
    const mac = kind === "byo" && isMacRecord(record);
    if (role.platform === "android") {
      const host = new BoxAndroidHost({
        boxId,
        kind,
        label: deviceHostLabel(record),
        appDir: deps.appDir,
        toolchain: deps.toolchain,
        record: () => deps.boxes()?.registry.get(boxId),
        connection: () => connection(boxId),
        settings: () => settings()!,
        activeLeases: () => ctx?.activeLeases(hostId) ?? [],
        ...(kind === "box" ? { destroyBox: destroyBoxOf(boxId) } : {}),
        logger,
        ...(mac ? { os: "darwin" as const, hostId, siblingLoad: siblingLoad(boxId, hostId) } : {})
      });
      hosts.set(hostId, host);
      watchLoad(host);
      ctx?.addHost(host);
      return host;
    }
    const host = new BoxDeviceHost({
      boxId,
      kind,
      label: deviceHostLabel(record),
      appDir: deps.appDir,
      toolchain: deps.toolchain,
      record: () => deps.boxes()?.registry.get(boxId),
      connection: () => connection(boxId),
      settings: () => settings()!,
      activeLeases: () => ctx?.activeLeases(hostId) ?? [],
      ...(kind === "box" ? { destroyBox: destroyBoxOf(boxId) } : {}),
      logger,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(mac ? { siblingLoad: siblingLoad(boxId, hostId) } : {})
    });
    hosts.set(hostId, host);
    watchLoad(host);
    ctx?.addHost(host);
    return host;
  };

  const access = (): DeviceMachineAccess | null => deps.machineAccess ?? null;

  /** `stopDevices`: the owner's machine stopped being a device host (its policy): what devices run there stops too. */
  const removeHost = (hostId: string, options: { stopDevices?: boolean } = {}): void => {
    const host = hosts.get(hostId);
    if (!host) return;
    hosts.delete(hostId);
    idleSince.delete(hostId);
    loads.delete(hostId);
    ctx?.removeHost(host.id);
    // Its machine's other host gets the room back.
    for (const other of hostsOfBox(host.boxId)) other.siblingChanged();
    const stop = !options.stopDevices ? host.dispose() : host instanceof BoxAndroidHost ? host.teardown() : host.stopHelpers().then(() => host.dispose());
    void stop.catch((error) => logger.warn(`[devices] stopping ${host.id} failed`, error instanceof Error ? error.message : String(error)));
  };

  /** Add a host for every device-host box and flagged own machine (two for an Apple Silicon Mac); remove the ones that went. */
  const sync = (): void => {
    const boxes = deps.boxes();
    if (!ctx || !boxes) return;
    const wanted = new Set<string>();
    for (const record of boxes.registry.list()) {
      for (const role of deviceHostsOfRecord(record, access())) {
        const hostId = deviceHostIdOf(record, role);
        wanted.add(hostId);
        const existing = hosts.get(hostId);
        if (existing && (existing.kind !== role.kind || existing.platforms[0] !== role.platform)) removeHost(hostId);
        const host = hosts.get(hostId) ?? addHost(record, role);
        host.linkChanged();
        // A rented box being set up is prepared by its `devices` step; a ready one (a restart) or an own machine now.
        if (record.state === "ready" && !host.isReady() && host.state().status === "starting") prepareInBackground(host);
      }
    }
    for (const [hostId, host] of [...hosts]) {
      if (wanted.has(hostId)) continue;
      const record = boxes.registry.get(host.boxId);
      removeHost(hostId, { stopDevices: record?.provider === "byo" && record.state !== "destroyed" && deps.boxes()?.hub.get(host.boxId)?.connected === true });
    }
  };

  const recordChanged = (boxId: string): void => {
    const record = deps.boxes()?.registry.get(boxId);
    if (!record) {
      for (const host of hostsOfBox(boxId)) removeHost(host.id);
      return;
    }
    if (deviceHostsOfRecord(record, access()).length === 0 && hostsOfBox(boxId).length === 0) return;
    sync();
  };

  const connectionChanged = (boxId: string, connected: boolean): void => {
    for (const host of hostsOfBox(boxId)) {
      host.linkChanged();
      if (!connected) continue;
      const record = deps.boxes()?.registry.get(boxId);
      // Reattach after a drop or a restart: `prepare` reuses what still runs and re-forwards it.
      if (record?.state === "ready" && !(host.kind === "byo" && host.state().status === "needs-setup")) prepareInBackground(host);
    }
  };

  /** The box service's `devices` setup step for a rented box. */
  const preparer = async (input: { boxId: string; connection: BoxConnection; signal: AbortSignal; log: (line: string) => void }): Promise<void> => {
    const record = deps.boxes()?.registry.get(input.boxId);
    if (!record) throw new Error("The box record is gone.");
    // Rented boxes only (own machines are prepared when they connect): one host each, `box:<boxId>`.
    const host = hosts.get(boxDeviceHostId(input.boxId)) ?? addHost(record, deviceHostOfRecord(record, access()) ?? { kind: "box", platform: record.kind === "linux" ? "android" : "ios" });
    await host.prepare(input.connection, input.signal, (progress) => {
      if (progress.state === "running" && progress.logLine === undefined) input.log(`${progress.label}…`);
      else if (progress.state === "done" && progress.detail) input.log(`${progress.label}: ${progress.detail}`);
      else if (progress.state === "failed") input.log(`${progress.label} failed: ${progress.detail ?? ""}`);
    });
  };

  /** This month's device-host spend plus what running device hosts are committed to until their deadline. */
  const spend = (): { monthUsd: number; committedUsd: number } => {
    const boxes = deps.boxes();
    if (!boxes) return { monthUsd: 0, committedUsd: 0 };
    return deviceHostSpend(boxes.registry.list(), now());
  };

  const quote = (platform: DevicePlatform): DeviceRentalQuote | null => {
    const current = settings();
    const boxes = deps.boxes();
    if (!current || !boxes || !boxes.service.enabled()) return null;
    const spec = rentalSpec(platform, current);
    let providerLabel: string;
    try {
      const adapter = boxes.service.settings.adapter(spec.provider);
      if (!boxes.service.settings.configured(adapter.id)) return null;
      providerLabel = adapter.label;
    } catch {
      return null;
    }
    return {
      platform,
      provider: spec.provider,
      providerLabel,
      size: spec.size,
      sizeLabel: spec.sizeLabel,
      hourlyUsd: spec.hourlyUsd,
      lifetimeMinutes: spec.lifetimeMinutes,
      needsApproval: rentalNeedsApproval(current, spec, spend())
    };
  };

  /** What renting a host of `platform` means now (Settings → Devices). */
  const rentalSpec = (platform: DevicePlatform, current: DevicesSettings) => (platform === "ios" ? iosRentalSpec(current, sizeOffers) : androidRentalSpec(current, linuxOffers));

  /** Other providers' sizes and prices (Blacksmith's come from its table). */
  const refreshOffers = (): void => {
    const current = settings();
    const boxes = deps.boxes();
    if (!current || !boxes) return;
    const fetchOffers = (provider: string, kind: "macos" | "linux", keep: (offers: BoxSizeOffer[]) => void) => {
      if (provider === "blacksmith" || !boxes.service.settings.configured(provider as never)) return;
      void boxes.service.settings
        .offers(provider, kind)
        .then((offers) => keep(offers.sizes))
        .catch(() => undefined);
    };
    fetchOffers(current.ios.provider, "macos", (offers) => (sizeOffers = offers));
    fetchOffers(current.pool.provider ?? "blacksmith", "linux", (offers) => (linuxOffers = offers));
  };

  /** Resolves once the host is ready; rejects when its box goes or its preparation fails. */
  const whenReady = (host: BoxHost, signal: AbortSignal, onProgress?: DeviceHostProvisionRequest["onProgress"]): Promise<BoxHost> =>
    new Promise((resolve, reject) => {
      let lastDetail: string | null = null;
      const check = () => {
        const state = host.state();
        if (state.detail && state.detail !== lastDetail) {
          lastDetail = state.detail;
          const renting = (deps.boxes()?.registry.get(host.boxId)?.setup ?? []).some((step) => (step.id === "create" || step.id === "connect") && step.state === "running");
          onProgress?.({ step: renting ? "rent-host" : "prepare-host", label: state.detail, state: "running" });
        }
        if (host.isReady()) return finish(null);
        if (!hosts.has(host.id)) {
          const record = deps.boxes()?.registry.get(host.boxId);
          return finish(new DeviceError("UNAVAILABLE", `Renting the ${hostWord(host.platforms[0]!)} host failed: ${record?.stateReason ?? "its box is gone"}.`));
        }
        if (state.status === "failed" || state.status === "stopping") return finish(new DeviceError(DEVICE_ERROR_PLATFORM, `The ${hostWord(host.platforms[0]!)} host could not be prepared: ${state.detail ?? state.status}.`));
      };
      const unsubscribe = host.onChange(check);
      const unsubscribeRegistry = deps.boxes()?.registry.onChange((boxId) => {
        if (boxId === host.boxId) check();
      });
      const onAbort = () => finish(new DeviceError("CANCELLED", `The request was cancelled (the ${hostWord(host.platforms[0]!)} host keeps starting).`));
      function finish(error: Error | null): void {
        unsubscribe();
        unsubscribeRegistry?.();
        signal.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve(host);
      }
      signal.addEventListener("abort", onAbort, { once: true });
      check();
    });

  const provision = async (request: DeviceHostProvisionRequest, signal: AbortSignal): Promise<DeviceHost> => {
    const platform = request.platform;
    const word = hostWord(platform);
    const current = settings();
    const boxes = deps.boxes();
    if (!current || !boxes || !boxes.service.enabled()) throw new DeviceError(DEVICE_ERROR_PLATFORM, `Renting a ${word} host needs the Ephemeral AI VMs plugin: turn it on in Settings → Plugins.`);
    const rental = quote(platform);
    if (!rental) {
      const provider = platform === "ios" ? current.ios.provider : (current.pool.provider ?? "blacksmith");
      throw new DeviceError(DEVICE_ERROR_PLATFORM, `Renting a ${word} host needs ${provider === "blacksmith" ? "Blacksmith" : provider} set up in Settings → Ephemeral AI VMs.`);
    }
    if (rental.needsApproval && !request.approved) throw new DeviceError(DEVICE_ERROR_PLATFORM, `Opening this device rents a ${rental.providerLabel} ${word} host (${rental.sizeLabel}), which needs the owner's approval.`);
    // One rental at a time per platform: a second request waits for the first host. Each caller's
    // abort ends only its own wait; the rental goes on for the others (and the host joins the pool).
    const running = provisioning.get(platform);
    if (running) return untilAborted(running, signal);
    const run = (async () => {
      // Re-checked while holding the rental slot: nothing else may rent in between.
      const held = quote(platform);
      if (!held) throw new DeviceError(DEVICE_ERROR_PLATFORM, `Renting a ${word} host is not possible right now (its provider is off or not set up).`);
      if (held.needsApproval && !request.approved) throw new DeviceError(DEVICE_ERROR_PLATFORM, `Opening this device rents a ${held.providerLabel} ${word} host (${held.sizeLabel}), which needs the owner's approval.`);
      const spec = rentalSpec(platform, current);
      request.onProgress?.({ step: "rent-host", label: `Renting a ${rental.providerLabel} ${word} host`, state: "running" });
      let summary;
      try {
        summary = await boxes.service.startDeviceHostBox({
          kind: platform === "ios" ? "macos" : "linux",
          provider: spec.provider as never,
          size: spec.size,
          ...(spec.image ? { image: spec.image } : {}),
          lifetimeMinutes: spec.lifetimeMinutes,
          purposeNote: platform === "ios" ? "iPhone & iPad simulators (Device simulators)" : "Android emulators (Device simulators)"
        });
      } catch (error) {
        throw new DeviceError(DEVICE_ERROR_PLATFORM, `Renting a ${word} host failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      const record = boxes.registry.get(summary.id);
      const host = hosts.get(boxDeviceHostId(summary.id)) ?? (record ? addHost(record, { kind: "box", platform }) : null);
      if (!host) throw new DeviceError("UNAVAILABLE", `Renting a ${word} host failed: its box record is gone.`);
      const ready = await whenReady(host, rentalAbort.signal, request.onProgress);
      request.onProgress?.({ step: "prepare-host", label: `${word} host ready`, state: "done" });
      return ready;
    })().finally(() => {
      provisioning.delete(platform);
    });
    provisioning.set(platform, run);
    return untilAborted(run, signal);
  };

  const sweepIdle = async (): Promise<void> => {
    const current = settings();
    if (!current || !ctx) return;
    const at = now();
    for (const host of [...hosts.values()]) {
      const leases = ctx.activeLeases(host.id).length;
      // A failed rented host bills for nothing: it goes at once.
      if (host.kind === "box" && leases === 0 && host.state().status === "failed") {
        idleSince.delete(host.id);
        logger.info(`[devices] ${host.label} failed: destroying it`);
        await deps
          .boxes()
          ?.service.destroyBox(host.boxId, "deleted", `Failed: ${host.state().detail ?? "the device host failed"} (Settings → Devices).`)
          .catch((error) => logger.warn(`[devices] destroying failed ${host.id} failed`, error instanceof Error ? error.message : String(error)));
        continue;
      }
      // Idle rented hosts are the pool's (`pool.idleTeardownMinutes`, warm hosts kept).
      if (host.kind !== "byo" || leases > 0 || !host.isReady()) {
        idleSince.delete(host.id);
        continue;
      }
      const since = idleSince.get(host.id) ?? at;
      idleSince.set(host.id, since);
      if (at - since < current.pool.idleTeardownMinutes * 60_000) continue;
      idleSince.delete(host.id);
      logger.info(`[devices] ${host.label} is idle: stopping its device helpers`);
      await host.stopHelpers().catch((error) => logger.warn(`[devices] stopping ${host.id}'s helpers failed`, error instanceof Error ? error.message : String(error)));
    }
  };

  return {
    kind: "box",
    platforms: ["ios", "android"],

    async start(context) {
      ctx = context;
      const boxes = deps.boxes();
      if (boxes) {
        boxes.service.setDeviceHostPreparer(preparer);
        unsubscribers.push(
          boxes.registry.onChange(recordChanged),
          boxes.hub.onConnectionChange(connectionChanged)
        );
      }
      // A machine's visibility or "Device simulators" switch changed: hosts follow at once.
      const policies = access();
      if (policies) unsubscribers.push(policies.onChange(() => sync()));
      // Synchronously: leases on hosts missing after `start` are marked lost.
      sync();
      refreshOffers();
      sweepTimer = setInterval(() => void sweepIdle().catch(() => undefined), IDLE_SWEEP_MS);
      sweepTimer.unref?.();
    },

    provision,

    provisionQuote: quote,

    settingsChanged() {
      for (const host of hosts.values()) host.linkChanged();
      refreshOffers();
    },

    async stop(options) {
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = null;
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
      deps.boxes()?.service.setDeviceHostPreparer(null);
      // Plugin off: Android hosts stop their emulators and helpers in the box (a shutdown leaves them for the next start).
      if (options?.teardown) {
        for (const host of [...hosts.values()]) {
          if (host instanceof BoxAndroidHost) await host.teardown().catch((error) => logger.warn(`[devices] tearing down ${host.id} failed`, error instanceof Error ? error.message : String(error)));
        }
      }
      for (const hostId of [...hosts.keys()]) removeHost(hostId);
      rentalAbort.abort();
      rentalAbort = new AbortController();
      ctx = null;
    }
  };
}

const DEVICE_ERROR_PLATFORM = DEVICE_ERROR_CODES.PLATFORM_NOT_READY;

/** `promise`, or `CANCELLED` once this caller's `signal` aborts (the shared work goes on). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DeviceError("CANCELLED", "The request was cancelled (the host keeps starting)."));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DeviceError("CANCELLED", "The request was cancelled (the host keeps starting)."));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}
