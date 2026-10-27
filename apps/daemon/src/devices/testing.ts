/**
 * Test doubles for the device module: a scriptable host, a factory that adds it, an action
 * executor that records calls, and a service over a temp appdir. For tests only.
 */

import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { deflateSync } from "node:zlib";

import type { DeviceActionInput, DeviceHostKind, DeviceHostReadiness, DevicePlatform, DevicesEventType, DeviceSummary } from "@orquester/api";
import type { StoredDeviceLease } from "@orquester/config";

import type { DeviceActionContext, DeviceActionExecutor, DeviceActionResult } from "./actions.ts";
import type { DeviceBootRequest, DeviceBootResult, DeviceCommandResult, DeviceHost, DeviceHostFactory, DeviceHostFactoryContext, DeviceHostState, DeviceRentalQuote } from "./host.ts";
import { DeviceScreenshots } from "./screenshots.ts";
import { DeviceService, type DeviceServiceDeps } from "./service.ts";
import { DeviceLeaseStore, DevicePoolStore, DeviceSettingsStore } from "./store.ts";

/** A host whose state, capacity and boots the test sets. */
export class FakeDeviceHost implements DeviceHost {
  private readonly events = new EventEmitter();
  status: DeviceHostState = { status: "ready", detail: null };
  checks: DeviceHostReadiness["checks"] = [];
  total = 2;
  booted: DeviceBootRequest[] = [];
  released: { lease: StoredDeviceLease; shutdown: boolean }[] = [];
  ensured: (readonly string[] | undefined)[] = [];
  /** What `boot` does; default: a ready device named after the profile. */
  bootImpl: (request: DeviceBootRequest, signal: AbortSignal) => Promise<DeviceBootResult> = async (request) => ({
    deviceId: `dev-${this.booted.length}`,
    name: request.profile.label,
    osVersion: request.profile.os,
    screen: { width: 400, height: 800, scale: 2 },
    stream: { kind: this.platforms.includes("ios") ? "serve-sim" : "serve-emu", deviceParam: `dev-${this.booted.length}` }
  });
  /** What `ensureReady` does; default: every check becomes ok. */
  ensureImpl: (signal: AbortSignal) => Promise<void> = async () => {
    this.checks = this.checks.map((check) => ({ ...check, state: "ok" as const }));
    this.status = { status: "ready", detail: null };
  };
  destroyed = false;
  destroy?: () => Promise<void>;
  agentDeviceCommand?: DeviceHost["agentDeviceCommand"];
  performAction?: DeviceHost["performAction"];
  installApp?: DeviceHost["installApp"];
  cacheState?: DeviceHost["cacheState"];
  /** What `hubOrigin` answers while ready, and `hubToken`. */
  hubOriginValue = "http://127.0.0.1:9";
  hubTokenValue: string | null = null;
  /** `viewersChanged` calls. */
  viewerCounts: { deviceId: string; count: number }[] = [];
  /** What `run` does; default: refuses. */
  runImpl: (command: "simctl" | "adb", args: readonly string[]) => Promise<DeviceCommandResult> = async () => {
    throw new Error("not scripted");
  };
  runs: { command: "simctl" | "adb"; args: string[] }[] = [];
  /** What `uploadFile` does; default: reads the stream and answers `/host/<name>`. */
  uploads: { name: string; bytes: number }[] = [];

  constructor(
    readonly id = "local",
    readonly kind: DeviceHostKind = "local",
    readonly platforms: readonly DevicePlatform[] = ["android"],
    readonly label = "This machine"
  ) {}

  state(): DeviceHostState {
    return this.status;
  }

  readiness(): DeviceHostReadiness {
    return { ready: this.checks.every((check) => check.state === "ok"), checks: this.checks.map((check) => ({ ...check })), checkedAt: null };
  }

  async refreshReadiness(): Promise<DeviceHostReadiness> {
    return this.readiness();
  }

  capacity() {
    return { used: 0, total: this.total };
  }

  async ensureReady(signal: AbortSignal, onProgress: Parameters<DeviceHost["ensureReady"]>[1], actions?: readonly string[]): Promise<void> {
    this.ensured.push(actions);
    for (const check of this.checks) onProgress({ step: check.id, label: check.label, state: "running" });
    await this.ensureImpl(signal);
    this.changed();
  }

  hubOrigin(): string | null {
    return this.status.status === "ready" ? this.hubOriginValue : null;
  }

  hubToken(): string | null {
    return this.hubTokenValue;
  }

  viewersChanged(deviceId: string, count: number): void {
    this.viewerCounts.push({ deviceId, count });
  }

  agentDeviceConfigPath(): string | null {
    return null;
  }

  /** Devices booted and not shut down (what `listDevices` answers), by id. */
  running = new Map<string, DeviceSummary>();
  /** What `listDevices` does; default: the running devices. */
  listImpl: () => Promise<DeviceSummary[]> = async () => [...this.running.values()];

  async listDevices(): Promise<DeviceSummary[]> {
    return this.listImpl();
  }

  async boot(request: DeviceBootRequest, signal: AbortSignal): Promise<DeviceBootResult> {
    this.booted.push(request);
    const result = await this.bootImpl(request, signal);
    this.running.set(result.deviceId, {
      key: `${this.id}/${result.deviceId}`,
      hostId: this.id,
      id: result.deviceId,
      platform: request.profile.platform,
      name: result.name,
      osVersion: result.osVersion,
      profile: request.profile.id,
      booted: true,
      leaseId: request.leaseId
    });
    return result;
  }

  async shutdown(deviceId: string): Promise<void> {
    this.running.delete(deviceId);
  }

  async release(lease: StoredDeviceLease, options: { shutdown: boolean }): Promise<void> {
    this.released.push({ lease, shutdown: options.shutdown });
    if (options.shutdown && lease.deviceId) this.running.delete(lease.deviceId);
  }

  async run(command: "simctl" | "adb", args: readonly string[]): Promise<DeviceCommandResult> {
    this.runs.push({ command, args: [...args] });
    return this.runImpl(command, args);
  }

  async uploadFile(stream: Readable, name: string): Promise<{ path: string }> {
    let bytes = 0;
    for await (const chunk of stream) bytes += (chunk as Buffer).length;
    this.uploads.push({ name, bytes });
    return { path: `/host/${name}` };
  }

  onChange(listener: () => void): () => void {
    this.events.on("change", listener);
    return () => void this.events.off("change", listener);
  }

  /** Tell the service something changed. */
  changed(): void {
    this.events.emit("change");
  }

  async dispose(): Promise<void> {}
}

/** A factory that adds `hosts` at start (and can rent `rentable` ones on demand). */
export class FakeHostFactory implements DeviceHostFactory {
  ctx: DeviceHostFactoryContext | null = null;
  provisioned: { platform: DevicePlatform; approved: boolean }[] = [];
  quote: DeviceRentalQuote | null = null;
  provision?: DeviceHostFactory["provision"];

  constructor(
    readonly kind: DeviceHostKind,
    readonly platforms: readonly DevicePlatform[],
    readonly hosts: DeviceHost[] = [],
    rentable?: () => DeviceHost
  ) {
    if (rentable) {
      this.provision = async (request) => {
        this.provisioned.push({ platform: request.platform, approved: request.approved });
        const host = rentable();
        this.ctx?.addHost(host);
        return host;
      };
    }
  }

  async start(ctx: DeviceHostFactoryContext): Promise<void> {
    this.ctx = ctx;
    for (const host of this.hosts) ctx.addHost(host);
  }

  provisionQuote(): DeviceRentalQuote | null {
    return this.quote;
  }

  async stop(): Promise<void> {
    for (const host of this.hosts) this.ctx?.removeHost(host.id);
  }
}

/** An executor that answers every action with a summary and records the calls. */
export class FakeActionExecutor implements DeviceActionExecutor {
  calls: { lease: string; input: DeviceActionInput }[] = [];
  installs: string[] = [];
  launches: string[] = [];
  result: (input: DeviceActionInput) => DeviceActionResult = (input) => ({ log: { summary: `did ${input.action}` }, text: `${input.action} ok` });

  async execute(ctx: DeviceActionContext, input: DeviceActionInput): Promise<DeviceActionResult> {
    this.calls.push({ lease: ctx.lease.id, input });
    return this.result(input);
  }

  async install(_ctx: DeviceActionContext, localPath: string) {
    this.installs.push(localPath);
    return { appId: "com.example.app", summary: "Installed com.example.app" };
  }

  async launch(_ctx: DeviceActionContext, app: string): Promise<void> {
    this.launches.push(app);
  }

  /** `restartApp` calls (lease ids), and what it answers. */
  restarts: string[] = [];
  restartImpl: () => Promise<{ appId: string }> = async () => ({ appId: "com.example.app" });

  async restartApp(ctx: DeviceActionContext): Promise<{ appId: string }> {
    this.restarts.push(ctx.lease.id);
    return this.restartImpl();
  }
}

export interface TestDeviceService {
  service: DeviceService;
  dir: string;
  events: { type: DevicesEventType; payload: unknown }[];
  /** Resolves with the first event (from now on) `match` accepts. */
  nextEvent(match: (type: DevicesEventType, payload: unknown) => boolean): Promise<unknown>;
  actions: FakeActionExecutor;
  cleanup(): Promise<void>;
}

/** A started service over a temp appdir; `settings` is written to devices.json first. */
export async function startTestDeviceService(
  options: { factories: DeviceHostFactory[]; settings?: Record<string, unknown>; deps?: Partial<DeviceServiceDeps> }
): Promise<TestDeviceService> {
  const dir = await mkdtemp(join(tmpdir(), "orq-devices-"));
  if (options.settings) await writeFile(join(dir, "devices.json"), JSON.stringify({ version: 1, settings: options.settings }));
  const events: TestDeviceService["events"] = [];
  const bus = new EventEmitter();
  const actions = new FakeActionExecutor();
  const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const service = new DeviceService({
    settingsStore: new DeviceSettingsStore({ file: join(dir, "devices.json"), logger: quiet }),
    leaseStore: new DeviceLeaseStore({ file: join(dir, "device-leases.json"), logger: quiet }),
    poolStore: new DevicePoolStore({ file: join(dir, "device-pool.json"), logger: quiet }),
    factories: options.factories,
    actions,
    screenshots: new DeviceScreenshots(join(dir, "screenshots"), quiet),
    publish: (type, payload) => {
      events.push({ type, payload });
      bus.emit("event", type, payload);
    },
    logger: quiet,
    idleTimer: false,
    ...options.deps
  });
  await service.start();
  return {
    service,
    dir,
    events,
    nextEvent: (match) =>
      new Promise((resolve) => {
        const listener = (type: DevicesEventType, payload: unknown) => {
          if (!match(type, payload)) return;
          bus.off("event", listener);
          resolve(payload);
        };
        bus.on("event", listener);
      }),
    actions,
    async cleanup() {
      await service.stop();
      await rm(dir, { recursive: true, force: true });
    }
  };
}

/** A solid RGBA PNG (filter 0 rows). */
export function solidPng(width: number, height: number, rgba: [number, number, number, number] = [200, 40, 40, 255]): Buffer {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) Buffer.from(rgba).copy(raw, y * (width * 4 + 1) + 1 + x * 4);
  }
  const chunk = (type: string, body: Buffer) => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, "latin1");
    body.copy(out, 8);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
