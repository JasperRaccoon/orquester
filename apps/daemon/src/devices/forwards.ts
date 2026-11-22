/**
 * Port forwards from a leased device to its chat's project (tailnet machines spec 2026-11-22 §4.6):
 * Metro and other dev servers reach simulators on the owner's machines.
 *
 * - **Where things run.** The device runs on its host's machine (this host, or a box: a rented one
 *   or the owner's paired machine); the project on the daemon host or in its project box
 *   ({@link DeviceForwardLink.projectMachine}).
 * - **A forward** `{devicePort, targetPort}` makes the device's `localhost:<devicePort>` reach the
 *   project's `<targetPort>`. When the device and the project are on different machines, a listener
 *   on the device machine's loopback pipes each connection back through the box link (a box's
 *   `forward.listen` + `host-tcp` channel, `ProjectBoxForwards` with `bind: "box"`; this host's own
 *   loopback for a device here and a project in a box) to the project. An Android emulator then
 *   gets `adb reverse tcp:<devicePort> tcp:<listener port>` (its own `localhost` is not the
 *   machine's; any free listener port does); an iOS simulator shares the Mac's `localhost`, so its
 *   listener must take `<devicePort>` exactly. On the same machine no listener is needed (Android:
 *   `adb reverse` alone).
 * - **Metro** ({@link DEVICE_METRO_PORT}) is forwarded automatically when the device opens on another
 *   machine than its chat's project and the project answers Metro's `/status`. On the same machine
 *   nothing is needed: React Native's dev build reaches its machine's Metro itself.
 * - **Lifetime.** The wanted list is the lease's (`StoredDeviceLease.forwards`, persisted by the
 *   service through {@link DeviceForwardsDeps.changed}); what is listening is memory only and is
 *   made again ({@link DeviceForwards.ensure}) when the host is ready after a restart or a dropped
 *   link. Everything closes when the lease ends (device closed, chat closed, lost, machine gone).
 */

import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import type { Duplex } from "node:stream";

import { DEVICE_METRO_PORT, type DevicePortForward } from "@orquester/api";
import type { StoredDeviceLease } from "@orquester/config";

import type { DaemonBoxes } from "../boxes/wiring.ts";
import { DeviceError } from "./errors.ts";
import type { DeviceCommandResult } from "./host.ts";

/** A machine a device or a project runs on. */
export type DeviceMachine = { kind: "host" } | { kind: "box"; boxId: string };

/** A listener on a machine's loopback. */
export interface DeviceListener {
  /** The port it listens on there. */
  readonly port: number;
  /** Still listening (a box that came back may have refused it again). */
  alive(): Promise<boolean>;
  close(): Promise<void>;
}

/** How forwards reach machines (`createDeviceForwardLink` in production; tests fake it). */
export interface DeviceForwardLink {
  /** Where a chat's project runs: its project box, else this host (a chat without a project too). */
  projectMachine(threadId: string): DeviceMachine;
  /** A fresh TCP stream to `port` on the machine's loopback. */
  connect(machine: DeviceMachine, port: number): Promise<Duplex>;
  /** Listen on the machine's loopback (`port` when free there; `exact`: only `port`) and pipe each connection to `upstream()`. */
  listen(machine: DeviceMachine, port: number, upstream: () => Promise<Duplex>, options: { exact: boolean }): Promise<DeviceListener>;
}

/** The lease a forward is for and what its device needs. */
export interface DeviceForwardTarget {
  lease: Pick<StoredDeviceLease, "id" | "threadId" | "platform" | "deviceId">;
  /** The device's machine; null: its host takes no forwards (a research VM). */
  machine: DeviceMachine | null;
  /** "jasper (your Linux machine)", for messages. */
  hostLabel: string;
  /** `adb` on the device's host (Android). */
  adb(args: readonly string[]): Promise<DeviceCommandResult>;
}

export interface DeviceForwardsDeps {
  link: DeviceForwardLink | null;
  /** The lease's wanted forwards changed: persist them with it. */
  changed(leaseId: string, forwards: readonly DevicePortForward[]): void;
  logger: Pick<Console, "info" | "warn">;
}

/** Forwards one lease may hold. */
export const MAX_FORWARDS_PER_LEASE = 8;
/** Device ports below this are privileged on the device machine. */
const MIN_DEVICE_PORT = 1024;
const MAX_PORT = 65_535;
/** How long Metro's `/status` may take to answer. */
const METRO_PROBE_MS = 3_000;

interface Active {
  forward: DevicePortForward;
  listener: DeviceListener | null;
}

export function sameMachine(a: DeviceMachine, b: DeviceMachine): boolean {
  return a.kind === b.kind && (a.kind === "host" || a.boxId === (b as { boxId: string }).boxId);
}

/** A lease record's wanted forwards (persisted by another version, so checked entry by entry). */
export function storedForwards(lease: StoredDeviceLease): DevicePortForward[] {
  const value = (lease as Record<string, unknown>).forwards;
  if (!Array.isArray(value)) return [];
  const out: DevicePortForward[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") continue;
    const { devicePort, targetPort, auto } = entry as Record<string, unknown>;
    if (!validPort(devicePort, MIN_DEVICE_PORT) || !validPort(targetPort, 1) || out.some((other) => other.devicePort === devicePort)) continue;
    out.push({ devicePort, targetPort, auto: auto === true });
  }
  return out.slice(0, MAX_FORWARDS_PER_LEASE);
}

function validPort(value: unknown, min: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= MAX_PORT;
}

export class DeviceForwards {
  /** Wanted forwards by lease (the lease record's). */
  private readonly wanted = new Map<string, DevicePortForward[]>();
  /** What listens now, by lease and device port. */
  private readonly active = new Map<string, Map<number, Active>>();
  /** One change at a time per lease. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: DeviceForwardsDeps) {}

  list(leaseId: string): DevicePortForward[] {
    return (this.wanted.get(leaseId) ?? []).map((forward) => ({ ...forward }));
  }

  /** A lease's persisted forwards at start (made again by {@link ensure} once its host is ready). */
  restore(leaseId: string, forwards: readonly DevicePortForward[]): void {
    if (forwards.length > 0) this.wanted.set(leaseId, forwards.map((forward) => ({ ...forward })));
  }

  /** Make one forward (replacing one on the same device port); resolves the lease's forwards. Rejects with a {@link DeviceError} for the owner or agent. */
  add(target: DeviceForwardTarget, request: { devicePort: number; targetPort?: number; auto?: boolean }): Promise<DevicePortForward[]> {
    return this.serial(target.lease.id, async () => {
      const forward: DevicePortForward = { devicePort: request.devicePort, targetPort: request.targetPort ?? request.devicePort, auto: request.auto === true };
      if (!validPort(forward.devicePort, MIN_DEVICE_PORT)) throw new DeviceError("INVALID_ARGUMENT", `The device port must be a whole number from ${MIN_DEVICE_PORT} to ${MAX_PORT}.`);
      if (!validPort(forward.targetPort, 1)) throw new DeviceError("INVALID_ARGUMENT", `The project port must be a whole number from 1 to ${MAX_PORT}.`);
      const current = this.wanted.get(target.lease.id) ?? [];
      const others = current.filter((entry) => entry.devicePort !== forward.devicePort);
      if (others.length >= MAX_FORWARDS_PER_LEASE) throw new DeviceError("INVALID_ARGUMENT", `A device holds at most ${MAX_FORWARDS_PER_LEASE} port forwards. Remove one first.`);
      await this.closeOne(target, forward.devicePort, { unreverse: false });
      const active = await this.apply(target, forward);
      this.activeOf(target.lease.id).set(forward.devicePort, active);
      this.setWanted(target.lease.id, [...others, forward].sort((a, b) => a.devicePort - b.devicePort));
      return this.list(target.lease.id);
    });
  }

  /** Remove one forward (none on that port: the list as it is). */
  remove(target: DeviceForwardTarget, devicePort: number): Promise<DevicePortForward[]> {
    return this.serial(target.lease.id, async () => {
      const current = this.wanted.get(target.lease.id) ?? [];
      if (!current.some((entry) => entry.devicePort === devicePort)) return this.list(target.lease.id);
      await this.closeOne(target, devicePort, { unreverse: true });
      this.setWanted(target.lease.id, current.filter((entry) => entry.devicePort !== devicePort));
      return this.list(target.lease.id);
    });
  }

  /** The host is ready: make again every wanted forward that does not listen now (a restart, a box that came back and refused it). */
  ensure(target: DeviceForwardTarget): Promise<void> {
    if ((this.wanted.get(target.lease.id) ?? []).length === 0) return Promise.resolve();
    return this.serial(target.lease.id, async () => {
      const active = this.activeOf(target.lease.id);
      for (const forward of this.wanted.get(target.lease.id) ?? []) {
        const current = active.get(forward.devicePort);
        if (current && (current.listener === null || (await current.listener.alive()))) continue;
        await current?.listener?.close().catch(() => undefined);
        active.delete(forward.devicePort);
        try {
          active.set(forward.devicePort, await this.apply(target, forward));
        } catch (error) {
          this.deps.logger.warn(`[devices] the forward of port ${forward.devicePort} to ${target.hostLabel} could not be made again: ${errorText(error)}`);
        }
      }
    }).then(
      () => undefined,
      () => undefined
    );
  }

  /**
   * A device opened: when its chat's project runs Metro on another machine, forward
   * {@link DEVICE_METRO_PORT} to it (`auto`). Never rejects; resolves the forward made, or null.
   */
  async autoMetro(target: DeviceForwardTarget): Promise<DevicePortForward | null> {
    const link = this.deps.link;
    if (!link || !target.machine) return null;
    const project = link.projectMachine(target.lease.threadId);
    if (sameMachine(target.machine, project)) return null;
    if (this.list(target.lease.id).some((entry) => entry.devicePort === DEVICE_METRO_PORT)) return null;
    if (!(await metroRunning(() => link.connect(project, DEVICE_METRO_PORT)))) return null;
    try {
      const forwards = await this.add(target, { devicePort: DEVICE_METRO_PORT, auto: true });
      this.deps.logger.info(`[devices] Metro forwarded to ${target.hostLabel} (port ${DEVICE_METRO_PORT})`);
      return forwards.find((entry) => entry.devicePort === DEVICE_METRO_PORT) ?? null;
    } catch (error) {
      this.deps.logger.warn(`[devices] forwarding Metro to ${target.hostLabel} failed: ${errorText(error)}`);
      return null;
    }
  }

  /**
   * The lease ended: every listener closes and the list goes. `target` (the device still there): its
   * `adb reverse` rules go too; null: the device is gone (lost), nothing to undo on it.
   */
  close(leaseId: string, target: DeviceForwardTarget | null): Promise<void> {
    if (!this.wanted.has(leaseId) && !this.active.has(leaseId)) return Promise.resolve();
    return this.serial(leaseId, async () => {
      for (const devicePort of [...(this.active.get(leaseId)?.keys() ?? [])]) {
        if (target) await this.closeOne(target, devicePort, { unreverse: true });
        else {
          await this.active.get(leaseId)?.get(devicePort)?.listener?.close().catch(() => undefined);
          this.active.get(leaseId)?.delete(devicePort);
        }
      }
      this.active.delete(leaseId);
      this.wanted.delete(leaseId);
    }).then(
      () => undefined,
      () => undefined
    );
  }

  /** Shutdown: stop listening (the wanted lists stay with their leases; a restart makes them again). */
  async dispose(): Promise<void> {
    for (const forwards of this.active.values()) {
      for (const active of forwards.values()) await active.listener?.close().catch(() => undefined);
    }
    this.active.clear();
  }

  // -------------------------------------------------------------------------

  private async apply(target: DeviceForwardTarget, forward: DevicePortForward): Promise<Active> {
    const link = this.deps.link;
    if (!link) throw new DeviceError("UNAVAILABLE", "Port forwards need the Ephemeral AI VMs plugin, which is unavailable right now.");
    if (!target.machine) throw new DeviceError("INVALID_ARGUMENT", `${target.hostLabel} takes no port forwards.`);
    const project = link.projectMachine(target.lease.threadId);
    const android = target.lease.platform === "android";
    const needsListener = !sameMachine(target.machine, project) || (!android && forward.devicePort !== forward.targetPort);
    let listener: DeviceListener | null = null;
    if (needsListener) {
      try {
        listener = await link.listen(target.machine, forward.devicePort, () => link.connect(project, forward.targetPort), { exact: !android });
      } catch (error) {
        throw new DeviceError("UNAVAILABLE", `Port ${forward.devicePort} could not be opened on ${target.hostLabel}: ${errorText(error)}.`);
      }
    }
    if (android) {
      if (target.lease.deviceId === null) {
        await listener?.close().catch(() => undefined);
        throw new DeviceError("UNAVAILABLE", "The device has not started yet.");
      }
      const result = await target.adb(["-s", target.lease.deviceId, "reverse", `tcp:${forward.devicePort}`, `tcp:${listener?.port ?? forward.targetPort}`]).catch((error: unknown) => ({ exitCode: -1, stdout: "", stderr: errorText(error) }));
      if (result.exitCode !== 0) {
        await listener?.close().catch(() => undefined);
        throw new DeviceError("UNAVAILABLE", `adb reverse for port ${forward.devicePort} failed on ${target.hostLabel}: ${(result.stderr || result.stdout).trim().split(/\r?\n/).at(-1) || `exit ${result.exitCode}`}.`);
      }
    }
    return { forward, listener };
  }

  private async closeOne(target: DeviceForwardTarget, devicePort: number, options: { unreverse: boolean }): Promise<void> {
    const active = this.active.get(target.lease.id)?.get(devicePort);
    this.active.get(target.lease.id)?.delete(devicePort);
    await active?.listener?.close().catch(() => undefined);
    if (options.unreverse && target.lease.platform === "android" && target.lease.deviceId !== null) {
      await target.adb(["-s", target.lease.deviceId, "reverse", "--remove", `tcp:${devicePort}`]).catch(() => undefined);
    }
  }

  private activeOf(leaseId: string): Map<number, Active> {
    let active = this.active.get(leaseId);
    if (!active) {
      active = new Map();
      this.active.set(leaseId, active);
    }
    return active;
  }

  private setWanted(leaseId: string, forwards: DevicePortForward[]): void {
    if (forwards.length === 0) this.wanted.delete(leaseId);
    else this.wanted.set(leaseId, forwards);
    this.deps.changed(leaseId, this.list(leaseId));
  }

  private serial<T>(leaseId: string, run: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(leaseId) ?? Promise.resolve()).then(run, run);
    const tail = result.catch(() => undefined);
    this.queues.set(leaseId, tail);
    void tail.then(() => {
      if (this.queues.get(leaseId) === tail) this.queues.delete(leaseId);
    });
    return result;
  }
}

/** Whether Metro (or Expo's dev server) answers on the stream `open` gives: its `/status` reads `packager-status:running`. */
export async function metroRunning(open: () => Promise<Duplex>): Promise<boolean> {
  let stream: Duplex;
  try {
    stream = await withTimeout(open(), METRO_PROBE_MS);
  } catch {
    return false;
  }
  return new Promise<boolean>((resolve) => {
    let text = "";
    const finish = (running: boolean) => {
      clearTimeout(timer);
      stream.destroy();
      resolve(running);
    };
    const timer = setTimeout(() => finish(false), METRO_PROBE_MS);
    timer.unref?.();
    stream.on("data", (chunk: Buffer) => {
      text += chunk.toString("latin1");
      if (text.includes("packager-status:running")) finish(true);
      else if (text.length > 16_384) finish(false);
    });
    stream.once("end", () => finish(text.includes("packager-status:running")));
    stream.once("error", () => finish(false));
    stream.write("GET /status HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// The production link
// ---------------------------------------------------------------------------

/**
 * Forwards over the box wiring: a project box's streams through its link (`openTcp`), a device
 * box's listeners in its forward list (`ProjectBoxForwards`, box-bound), this host's own loopback
 * for the rest. Null while the box wiring is unavailable.
 */
export function createDeviceForwardLink(input: {
  boxes: () => Pick<DaemonBoxes, "registry" | "hub" | "projectForwards"> | null;
  /** A chat's project root; null without one. */
  threadProject(threadId: string): string | null;
}): DeviceForwardLink {
  const wiring = () => {
    const boxes = input.boxes();
    if (!boxes) throw new Error("Ephemeral AI VMs is unavailable");
    return boxes;
  };
  return {
    projectMachine(threadId) {
      const project = input.threadProject(threadId);
      const boxes = input.boxes();
      if (!project || !boxes) return { kind: "host" };
      const location = boxes.registry.locate(project);
      return location.kind === "box" ? { kind: "box", boxId: location.boxId } : { kind: "host" };
    },
    async connect(machine, port) {
      if (machine.kind === "host") return connectLoopback(port);
      const connection = wiring().hub.get(machine.boxId);
      if (!connection?.connected) throw new Error("the project's box is not connected");
      return connection.openTcp(port);
    },
    async listen(machine, port, upstream, options) {
      if (machine.kind === "host") return listenLoopback(port, upstream, options);
      const forward = await wiring().projectForwards.open(machine.boxId, port, upstream, { bind: "box", exactPort: options.exact });
      return { port: forward.boxPort, alive: () => forward.alive(), close: () => forward.close() };
    }
  };
}

function connectLoopback(port: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port, allowHalfOpen: true });
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

/** A listener on this host's 127.0.0.1 (`port` when free; another one unless `exact`). */
async function listenLoopback(port: number, upstream: () => Promise<Duplex>, options: { exact: boolean }): Promise<DeviceListener> {
  const sockets = new Set<Socket>();
  const server: Server = createServer({ allowHalfOpen: true }, (client) => {
    sockets.add(client);
    client.once("close", () => sockets.delete(client));
    client.pause();
    upstream().then(
      (stream) => {
        client.pipe(stream).pipe(client);
        client.resume();
        stream.on("error", () => client.destroy());
        client.on("error", () => stream.destroy());
        client.once("close", () => stream.destroy());
        stream.once("close", () => client.end());
      },
      () => client.destroy()
    );
  });
  const bind = (at: number) =>
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(at, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  try {
    await bind(port);
  } catch (error) {
    if (options.exact) throw error;
    await bind(0);
  }
  let open = true;
  return {
    port: (server.address() as AddressInfo).port,
    alive: async () => open,
    close: () =>
      new Promise<void>((resolve) => {
        if (!open) return resolve();
        open = false;
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      })
  };
}
