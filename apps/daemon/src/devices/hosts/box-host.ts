/**
 * Box device hosts (devices spec §6.3): Macs running iOS simulators, reached through the box
 * service (`BoxConnection`; no SSH). Two kinds:
 *
 * - **Rented** (`kind: "box"`): a box with purpose `device-host` (`threadId: null`) the factory
 *   rents in `provision` from Settings → Devices (provider, size, lifetime). The box's `devices`
 *   setup step runs this factory's preparer (`BoxService.setDeviceHostPreparer`): the box is ready
 *   only once the host is. A rented host with no lease for `ios.idleTeardownMinutes` is destroyed;
 *   one near its time limit drains (no new lease).
 * - **Your own Mac** (`kind: "byo"`): a bring-your-own machine the owner marked "Use for device
 *   simulators" (`BoxSummary.deviceHost`). Prepared when it connects; never destroyed — when idle,
 *   its helpers (hub, agent-device daemon) stop, and start again with the next lease.
 *
 * `start` adds a host for every such box already recorded (a restart reattaches: the hub and the
 * agent-device daemon keep running in the box and are found again). A box whose link drops makes
 * its host `unreachable` (the service suspends its leases); a destroyed box removes its host (its
 * leases are lost).
 *
 * Phase 2 grows this into Linux (KVM) pool boxes for Android; bring-your-own Linux machines with
 * KVM are left to that phase (they need the remote emulator driver).
 */

import { DEVICE_ERROR_CODES, boxDeviceHostId, type BoxSizeOffer, type DevicePlatform, type DevicesSettings } from "@orquester/api";
import type { StoredBox } from "@orquester/config";

import type { BoxConnection } from "../../boxes/contracts.ts";
import type { DaemonBoxes } from "../../boxes/wiring.ts";
import { DeviceError, isDeviceError } from "../errors.ts";
import type { DeviceHost, DeviceHostFactory, DeviceHostFactoryContext, DeviceHostProvisionRequest, DeviceRentalQuote } from "../host.ts";
import type { DeviceToolchain } from "../toolchain/index.ts";
import { BoxDeviceHost, type BoxHostTiming } from "./box/host.ts";
import { deviceHostSpend, iosRentalSpec, rentalNeedsApproval } from "./box/rental.ts";

export interface BoxHostDeps {
  appDir: string;
  /** The Ephemeral AI VMs wiring (the box service, its registry and hub); null while that plugin is unavailable. */
  boxes: () => Pick<DaemonBoxes, "service" | "registry" | "hub"> | null;
  toolchain: DeviceToolchain;
  logger: Pick<Console, "info" | "warn" | "error">;
  /** Tests: the clock, the idle sweep, waits and HTTP. */
  now?: () => number;
  idleSweep?: boolean;
  timing?: Partial<BoxHostTiming>;
  fetch?: typeof fetch;
}

/** The idle sweep's period. */
const IDLE_SWEEP_MS = 60_000;

/** What kind of device host a box record is, or null when it is none. */
export function deviceHostOfRecord(record: StoredBox): { kind: "box" | "byo"; platform: DevicePlatform } | null {
  if (record.state === "destroyed") return null;
  if (record.provider === "byo") {
    // A Mac: paired as one (`kind`), or reported so by its orq-agent (`os`).
    if (record.deviceHost !== true || !(record.kind === "macos" || record.os === "darwin")) return null;
    return { kind: "byo", platform: "ios" };
  }
  if (record.purpose !== "device-host" || record.kind !== "macos") return null;
  return { kind: "box", platform: "ios" };
}

export function deviceHostLabel(record: StoredBox): string {
  if (record.provider === "byo") return `${typeof record.machineName === "string" && record.machineName ? record.machineName : "Your Mac"} (your Mac)`;
  const provider = record.provider === "blacksmith" ? "Blacksmith" : record.provider;
  const size = typeof record.sizeLabel === "string" && record.sizeLabel ? record.sizeLabel.split(" · ")[0] : record.size;
  return `Mac host (${provider}, ${size})`;
}

export interface BoxHostFactory extends DeviceHostFactory {
  /** The host of a box (tests, the integration run). */
  host(boxId: string): BoxDeviceHost | undefined;
  /** Destroy or stop idle hosts now (tests drive it; a timer runs it every minute). */
  sweepIdle(): Promise<void>;
}

export function createBoxHostFactory(deps: BoxHostDeps): BoxHostFactory {
  const { logger } = deps;
  const now = () => deps.now?.() ?? Date.now();
  const hosts = new Map<string, BoxDeviceHost>();
  /** Since when each host has had no lease (box id → ms). */
  const idleSince = new Map<string, number>();
  const unsubscribers: (() => void)[] = [];
  let ctx: DeviceHostFactoryContext | null = null;
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  let provisioning: Promise<DeviceHost> | null = null;
  /** The shared rental's own abort (the factory stopping), never one caller's. */
  let rentalAbort = new AbortController();
  let sizeOffers: BoxSizeOffer[] = [];
  /** The settings as last read (hosts read them after `stop` too, while they are disposed). */
  let lastSettings: DevicesSettings | null = null;

  const settings = (): DevicesSettings | null => {
    if (ctx) lastSettings = ctx.settings();
    return lastSettings;
  };

  const connection = (boxId: string): BoxConnection | undefined => deps.boxes()?.hub.get(boxId);

  /** Prepare a host in the background (it reports its own failure in its status). */
  const prepareInBackground = (host: BoxDeviceHost): void => {
    const link = connection(host.boxId);
    if (!link?.connected) return;
    void host.prepare(link, AbortSignal.timeout(30 * 60_000)).catch((error) => {
      if (!isDeviceError(error)) logger.warn(`[devices] preparing ${host.id} failed`, error instanceof Error ? error.message : String(error));
    });
  };

  const addHost = (record: StoredBox, kind: "box" | "byo"): BoxDeviceHost => {
    const boxId = record.id;
    const hostId = boxDeviceHostId(boxId);
    const host = new BoxDeviceHost({
      boxId,
      kind,
      label: deviceHostLabel(record),
      platform: "ios",
      appDir: deps.appDir,
      toolchain: deps.toolchain,
      record: () => deps.boxes()?.registry.get(boxId),
      connection: () => connection(boxId),
      settings: () => settings()!,
      activeLeases: () => ctx?.activeLeases(hostId) ?? [],
      ...(kind === "box"
        ? {
            destroyBox: async () => {
              const boxes = deps.boxes();
              if (!boxes) throw new DeviceError("UNAVAILABLE", "Ephemeral AI VMs is unavailable, so the host cannot be destroyed now.");
              await boxes.service.destroyBox(boxId, "deleted", "Destroyed from Settings → Devices.");
            }
          }
        : {}),
      logger,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.timing ? { timing: deps.timing } : {})
    });
    hosts.set(boxId, host);
    ctx?.addHost(host);
    return host;
  };

  const removeHost = (boxId: string): void => {
    const host = hosts.get(boxId);
    if (!host) return;
    hosts.delete(boxId);
    idleSince.delete(boxId);
    ctx?.removeHost(host.id);
    void host.dispose().catch(() => undefined);
  };

  /** Add a host for every device-host box and flagged own Mac; remove the ones that went. */
  const sync = (): void => {
    const boxes = deps.boxes();
    if (!ctx || !boxes) return;
    const wanted = new Set<string>();
    for (const record of boxes.registry.list()) {
      const role = deviceHostOfRecord(record);
      if (!role) continue;
      wanted.add(record.id);
      const existing = hosts.get(record.id);
      if (existing && existing.kind !== role.kind) removeHost(record.id);
      const host = hosts.get(record.id) ?? addHost(record, role.kind);
      host.linkChanged();
      // A rented box being set up is prepared by its `devices` step; a ready one (a restart) or an own machine now.
      if (record.state === "ready" && !host.isReady() && host.state().status === "starting") prepareInBackground(host);
    }
    for (const boxId of [...hosts.keys()]) if (!wanted.has(boxId)) removeHost(boxId);
  };

  const recordChanged = (boxId: string): void => {
    const record = deps.boxes()?.registry.get(boxId);
    if (!record) {
      removeHost(boxId);
      return;
    }
    if (!deviceHostOfRecord(record) && !hosts.has(boxId)) return;
    sync();
  };

  const connectionChanged = (boxId: string, connected: boolean): void => {
    const host = hosts.get(boxId);
    if (!host) return;
    host.linkChanged();
    if (!connected) return;
    const record = deps.boxes()?.registry.get(boxId);
    // Reattach after a drop or a restart: `prepare` reuses what still runs and re-forwards it.
    if (record?.state === "ready" && !(host.kind === "byo" && host.state().status === "needs-setup")) prepareInBackground(host);
  };

  /** The box service's `devices` setup step for a rented box. */
  const preparer = async (input: { boxId: string; connection: BoxConnection; signal: AbortSignal; log: (line: string) => void }): Promise<void> => {
    const record = deps.boxes()?.registry.get(input.boxId);
    if (!record) throw new Error("The box record is gone.");
    const host = hosts.get(input.boxId) ?? addHost(record, "box");
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
    if (platform !== "ios" || !current || !boxes || !boxes.service.enabled()) return null;
    const spec = iosRentalSpec(current, sizeOffers);
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

  /** Other providers' sizes and prices (Blacksmith's come from its table). */
  const refreshOffers = (): void => {
    const current = settings();
    const boxes = deps.boxes();
    if (!current || !boxes || current.ios.provider === "blacksmith" || !boxes.service.settings.configured(current.ios.provider as never)) return;
    void boxes.service.settings
      .offers(current.ios.provider, "macos")
      .then((offers) => {
        sizeOffers = offers.sizes;
      })
      .catch(() => undefined);
  };

  /** Resolves once the host is ready; rejects when its box goes or its preparation fails. */
  const whenReady = (host: BoxDeviceHost, signal: AbortSignal, onProgress?: DeviceHostProvisionRequest["onProgress"]): Promise<BoxDeviceHost> =>
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
        if (!hosts.has(host.boxId)) {
          const record = deps.boxes()?.registry.get(host.boxId);
          return finish(new DeviceError("UNAVAILABLE", `Renting the Mac host failed: ${record?.stateReason ?? "its box is gone"}.`));
        }
        if (state.status === "failed" || state.status === "stopping") return finish(new DeviceError(DEVICE_ERROR_PLATFORM, `The Mac host could not be prepared: ${state.detail ?? state.status}.`));
      };
      const unsubscribe = host.onChange(check);
      const unsubscribeRegistry = deps.boxes()?.registry.onChange((boxId) => {
        if (boxId === host.boxId) check();
      });
      const onAbort = () => finish(new DeviceError("CANCELLED", "The request was cancelled (the Mac host keeps starting)."));
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
    if (request.platform !== "ios") throw new DeviceError(DEVICE_ERROR_PLATFORM, "Only Mac hosts (iPhone & iPad) are rented in this build.");
    const current = settings();
    const boxes = deps.boxes();
    if (!current || !boxes) throw new DeviceError(DEVICE_ERROR_PLATFORM, "Renting a Mac host needs the Ephemeral AI VMs plugin: turn it on in Settings → Plugins.");
    if (!boxes.service.enabled()) throw new DeviceError(DEVICE_ERROR_PLATFORM, "Renting a Mac host needs the Ephemeral AI VMs plugin: turn it on in Settings → Plugins.");
    const rental = quote("ios");
    if (!rental) throw new DeviceError(DEVICE_ERROR_PLATFORM, `Renting a Mac host needs ${current.ios.provider === "blacksmith" ? "Blacksmith" : current.ios.provider} set up in Settings → Ephemeral AI VMs.`);
    if (rental.needsApproval && !request.approved) throw new DeviceError(DEVICE_ERROR_PLATFORM, `Opening this device rents a ${rental.providerLabel} Mac host (${rental.sizeLabel}), which needs the owner's approval.`);
    // One rental at a time: a second request waits for the first host. Each caller's abort ends
    // only its own wait; the rental goes on for the others (and the host joins the pool).
    if (provisioning) return untilAborted(provisioning, signal);
    const run = (async () => {
      // Re-checked while holding the rental slot: nothing else may rent in between.
      const held = quote("ios");
      if (!held) throw new DeviceError(DEVICE_ERROR_PLATFORM, "Renting a Mac host is not possible right now (its provider is off or not set up).");
      if (held.needsApproval && !request.approved) throw new DeviceError(DEVICE_ERROR_PLATFORM, `Opening this device rents a ${held.providerLabel} Mac host (${held.sizeLabel}), which needs the owner's approval.`);
      const spec = iosRentalSpec(current, sizeOffers);
      request.onProgress?.({ step: "rent-host", label: `Renting a ${rental.providerLabel} Mac host`, state: "running" });
      let summary;
      try {
        summary = await boxes.service.startDeviceHostBox({
          kind: "macos",
          provider: spec.provider as never,
          size: spec.size,
          ...(spec.image ? { image: spec.image } : {}),
          lifetimeMinutes: spec.lifetimeMinutes,
          purposeNote: "iPhone & iPad simulators (Device simulators)"
        });
      } catch (error) {
        throw new DeviceError(DEVICE_ERROR_PLATFORM, `Renting a Mac host failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      const record = boxes.registry.get(summary.id);
      const host = hosts.get(summary.id) ?? (record ? addHost(record, "box") : null);
      if (!host) throw new DeviceError("UNAVAILABLE", "Renting a Mac host failed: its box record is gone.");
      const ready = await whenReady(host, rentalAbort.signal, request.onProgress);
      request.onProgress?.({ step: "prepare-host", label: "Mac host ready", state: "done" });
      return ready;
    })().finally(() => {
      provisioning = null;
    });
    provisioning = run;
    return untilAborted(run, signal);
  };

  const sweepIdle = async (): Promise<void> => {
    const current = settings();
    if (!current || !ctx) return;
    const at = now();
    for (const host of [...hosts.values()]) {
      const leases = ctx.activeLeases(host.id).length;
      const status = host.state().status;
      // A rented host bills whatever its state: with no lease it is idle (only one still being
      // rented and prepared is not), and a failed one goes at once. The pool's warm hosts stay.
      if (host.kind === "box" && leases === 0 && status === "failed") {
        idleSince.delete(host.boxId);
        logger.info(`[devices] ${host.label} failed: destroying it`);
        await deps
          .boxes()
          ?.service.destroyBox(host.boxId, "deleted", `Failed: ${host.state().detail ?? "the device host failed"} (Settings → Devices).`)
          .catch((error) => logger.warn(`[devices] destroying failed ${host.id} failed`, error instanceof Error ? error.message : String(error)));
        continue;
      }
      const notIdle = host.kind === "box" ? status === "starting" || status === "installing" : !host.isReady();
      if (leases > 0 || notIdle || ctx.keepWarm?.(host.id) === true) {
        idleSince.delete(host.boxId);
        continue;
      }
      const since = idleSince.get(host.boxId) ?? at;
      idleSince.set(host.boxId, since);
      if (at - since < current.ios.idleTeardownMinutes * 60_000) continue;
      idleSince.delete(host.boxId);
      if (host.kind === "byo") {
        logger.info(`[devices] ${host.label} is idle: stopping its device helpers`);
        await host.stopHelpers().catch((error) => logger.warn(`[devices] stopping ${host.id}'s helpers failed`, error instanceof Error ? error.message : String(error)));
        continue;
      }
      logger.info(`[devices] ${host.label} had no device for ${current.ios.idleTeardownMinutes} min: destroying it`);
      await deps
        .boxes()
        ?.service.destroyBox(host.boxId, "deleted", `Idle: no device for ${current.ios.idleTeardownMinutes} min (Settings → Devices).`)
        .catch((error) => logger.warn(`[devices] destroying idle ${host.id} failed`, error instanceof Error ? error.message : String(error)));
    }
  };

  return {
    kind: "box",
    platforms: ["ios"],

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
      // Synchronously: leases on hosts missing after `start` are marked lost.
      sync();
      refreshOffers();
      if (deps.idleSweep !== false) {
        sweepTimer = setInterval(() => void sweepIdle().catch(() => undefined), IDLE_SWEEP_MS);
        sweepTimer.unref?.();
      }
    },

    provision,

    provisionQuote: quote,

    settingsChanged() {
      for (const host of hosts.values()) host.linkChanged();
      refreshOffers();
    },

    host: (boxId) => hosts.get(boxId),

    sweepIdle,

    async stop() {
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = null;
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
      deps.boxes()?.service.setDeviceHostPreparer(null);
      for (const boxId of [...hosts.keys()]) removeHost(boxId);
      rentalAbort.abort();
      rentalAbort = new AbortController();
      ctx = null;
    }
  };
}

const DEVICE_ERROR_PLATFORM = DEVICE_ERROR_CODES.PLATFORM_NOT_READY;

/** `promise`, or `CANCELLED` once this caller's `signal` aborts (the shared work goes on). */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DeviceError("CANCELLED", "The request was cancelled (the Mac host keeps starting)."));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DeviceError("CANCELLED", "The request was cancelled (the Mac host keeps starting)."));
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
