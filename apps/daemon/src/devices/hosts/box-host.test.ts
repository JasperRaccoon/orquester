import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { DEFAULT_DEVICES_SETTINGS, type DevicesSettings } from "@orquester/api";
import type { StoredBox, StoredDeviceLease } from "@orquester/config";

import type { BoxConnection } from "../../boxes/contracts.ts";
import type { CreateDeviceHostBoxRequest, DeviceHostPreparer } from "../../boxes/service/index.ts";
import type { DaemonBoxes } from "../../boxes/wiring.ts";
import { isDeviceError } from "../errors.ts";
import type { DeviceHost, DeviceHostFactoryContext, DeviceHostProgress } from "../host.ts";
import type { DeviceToolchain } from "../toolchain/index.ts";
import { createBoxHostFactory, deviceHostOfRecord, type BoxHostFactory } from "./box-host.ts";
import { FakeMacBox } from "./box/testing.ts";

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const T0 = Date.parse("2026-10-27T10:00:00.000Z");

function record(id: string, overrides: Partial<StoredBox> = {}): StoredBox {
  return {
    id,
    purpose: "device-host",
    kind: "macos",
    provider: "blacksmith",
    region: "blacksmith",
    size: "6vcpu",
    sizeLabel: "6 vCPU M4 · 24 GB",
    name: `orq-${id}`,
    os: "darwin",
    hourlyUsd: 4.8,
    createdAt: new Date(T0).toISOString(),
    readyAt: new Date(T0).toISOString(),
    deadlineAt: new Date(T0 + 4 * 3_600_000).toISOString(),
    state: "ready",
    ...overrides
  } as StoredBox;
}

/** The parts of the box wiring the factory uses, over in-memory records and fake Macs. */
class FakeBoxes {
  readonly records = new Map<string, StoredBox>();
  readonly macs = new Map<string, FakeMacBox>();
  private readonly connections = new Map<string, BoxConnection>();
  private readonly registryEvents = new EventEmitter();
  private readonly hubEvents = new EventEmitter();
  preparer: DeviceHostPreparer | null = null;
  readonly started: CreateDeviceHostBoxRequest[] = [];
  readonly destroyed: { boxId: string; reason: string; message?: string }[] = [];
  enabled = true;
  configured = true;

  mac(boxId: string, mac = new FakeMacBox({ toolsInstalled: true })): FakeMacBox {
    this.macs.set(boxId, mac);
    this.connections.set(boxId, mac.connection());
    return mac;
  }

  set(next: StoredBox): void {
    this.records.set(next.id, next);
    this.registryEvents.emit("change", next.id);
  }

  setConnected(boxId: string, connected: boolean): void {
    this.macs.get(boxId)!.setConnected(connected);
    this.hubEvents.emit("change", boxId, connected);
  }

  get fetch(): typeof fetch {
    return async (input, init) => {
      const port = Number(new URL(String(input instanceof Request ? input.url : input)).port);
      const mac = [...this.macs.values()].find((candidate) => candidate.forwards.includes(port));
      if (!mac) throw new TypeError("fetch failed");
      return mac.fetch(input, init);
    };
  }

  wiring(): Pick<DaemonBoxes, "service" | "registry" | "hub"> {
    const boxes = this;
    return {
      service: {
        enabled: () => boxes.enabled,
        settings: {
          adapter: (id: string) => {
            if (id !== "blacksmith") throw new Error("no such provider");
            return { id, label: "Blacksmith" };
          },
          configured: () => boxes.configured,
          offers: async () => ({ sizes: [] })
        },
        setDeviceHostPreparer: (preparer: DeviceHostPreparer | null) => {
          boxes.preparer = preparer;
        },
        async startDeviceHostBox(request: CreateDeviceHostBoxRequest) {
          boxes.started.push(request);
          const id = `new${boxes.started.length}`;
          boxes.set(
            record(id, {
              state: "provisioning",
              readyAt: null,
              setup: [{ id: "create", label: "Create", state: "running", startedAt: null, finishedAt: null, message: null }]
            })
          );
          return { id };
        },
        async destroyBox(boxId: string, reason: string, message?: string) {
          boxes.destroyed.push({ boxId, reason, ...(message ? { message } : {}) });
          boxes.set({ ...boxes.records.get(boxId)!, state: "destroyed" });
          return {};
        }
      },
      registry: {
        list: () => [...boxes.records.values()],
        get: (boxId: string) => boxes.records.get(boxId),
        onChange: (listener: (boxId: string) => void) => {
          boxes.registryEvents.on("change", listener);
          return () => void boxes.registryEvents.off("change", listener);
        }
      },
      hub: {
        get: (boxId: string) => boxes.connections.get(boxId),
        onConnectionChange: (listener: (boxId: string, connected: boolean) => void) => {
          boxes.hubEvents.on("change", listener);
          return () => void boxes.hubEvents.off("change", listener);
        }
      }
    } as unknown as Pick<DaemonBoxes, "service" | "registry" | "hub">;
  }
}

/** Resolves once `predicate` holds (checked after every host change and a few ticks). */
async function eventually(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2000; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`timed out waiting for ${what}`);
}

describe("box device host factory", () => {
  let appDir: string;
  let boxes: FakeBoxes;
  let settings: DevicesSettings;
  let leases: StoredDeviceLease[];
  let added: Map<string, DeviceHost>;
  let now: number;
  let factory: BoxHostFactory;

  const context = (): DeviceHostFactoryContext => ({
    settings: () => settings,
    activeLeases: (hostId) => leases.filter((lease) => lease.hostId === hostId),
    addHost: (host) => void added.set(host.id, host),
    removeHost: (hostId) => void added.delete(hostId),
    logger: quiet
  });

  const make = () =>
    createBoxHostFactory({
      appDir,
      boxes: () => boxes.wiring(),
      toolchain: { toolBin: () => process.execPath } as unknown as DeviceToolchain,
      logger: quiet,
      now: () => now,
      idleSweep: false,
      fetch: boxes.fetch,
      timing: { hubPollMs: 2, framePollMs: 1 }
    });

  beforeEach(async () => {
    appDir = await mkdtemp(join(tmpdir(), "orq-box-factory-"));
    boxes = new FakeBoxes();
    settings = { ...DEFAULT_DEVICES_SETTINGS, ios: { ...DEFAULT_DEVICES_SETTINGS.ios, enabled: true } };
    leases = [];
    added = new Map();
    now = T0 + 60_000;
    factory = make();
  });

  afterEach(async () => {
    await factory.stop();
    await rm(appDir, { recursive: true, force: true });
  });

  it("knows which boxes are device hosts", () => {
    assert.deepEqual(deviceHostOfRecord(record("a")), { kind: "box", platform: "ios" });
    assert.equal(deviceHostOfRecord(record("a", { state: "destroyed" })), null);
    assert.equal(deviceHostOfRecord(record("a", { purpose: "temporary" })), null);
    assert.deepEqual(deviceHostOfRecord(record("b", { provider: "byo", purpose: "machine", deviceHost: true })), { kind: "byo", platform: "ios" });
    assert.equal(deviceHostOfRecord(record("b", { provider: "byo", purpose: "machine", deviceHost: false })), null);
    // Own Linux machines with KVM wait for the phase 2 Android driver.
    assert.equal(deviceHostOfRecord(record("c", { provider: "byo", purpose: "machine", deviceHost: true, os: "linux", kind: "linux", kvm: true })), null);
  });

  it("adopts rented device hosts and own Macs at start, and follows their boxes", async () => {
    boxes.records.set("a", record("a"));
    boxes.records.set("b", record("b", { provider: "byo", purpose: "machine", deviceHost: true, machineName: "Studio" }));
    boxes.records.set("d", record("d", { state: "destroyed" }));
    boxes.records.set("e", record("e", { purpose: "temporary" }));
    boxes.mac("a");
    boxes.mac("b");
    await factory.start(context());

    assert.deepEqual([...added.keys()].sort(), ["box:a", "box:b"]);
    assert.equal(added.get("box:a")!.kind, "box");
    assert.equal(added.get("box:b")!.kind, "byo");
    assert.equal(added.get("box:b")!.label, "Studio (your Mac)");
    assert.equal(added.get("box:a")!.label, "Mac host (Blacksmith, 6 vCPU M4)");
    await eventually(() => factory.host("a")!.isReady() && factory.host("b")!.isReady(), "both hosts ready");
    assert.ok(boxes.preparer, "the devices setup step is the factory's");
    assert.equal(added.get("box:a")!.box?.()?.hourlyUsd, 4.8);
    assert.equal(added.get("box:b")!.box?.()?.hourlyUsd, 0);

    // The link drops: unreachable (the service suspends its leases); back: ready again.
    boxes.setConnected("a", false);
    assert.equal(added.get("box:a")!.state().status, "unreachable");
    boxes.setConnected("a", true);
    await eventually(() => added.get("box:a")!.state().status === "ready", "reattached");

    // The box goes: its host goes (the service marks its leases lost).
    boxes.set({ ...boxes.records.get("a")!, state: "destroyed" });
    assert.ok(!added.has("box:a"));
    // The owner unticks "Use for device simulators".
    boxes.set({ ...boxes.records.get("b")!, deviceHost: false });
    assert.ok(!added.has("box:b"));

    await factory.stop();
    assert.equal(boxes.preparer, null);
  });

  it("quotes a rental from Settings → Devices and the month's spending", async () => {
    await factory.start(context());
    assert.deepEqual(factory.provisionQuote!("ios"), {
      platform: "ios",
      provider: "blacksmith",
      providerLabel: "Blacksmith",
      size: "6vcpu",
      sizeLabel: "6 vCPU M4 · 24 GB",
      hourlyUsd: 4.8,
      lifetimeMinutes: 240,
      needsApproval: true
    });
    settings = { ...settings, ios: { ...settings.ios, rentWithoutAsking: true, monthlyCapUsd: 100 } };
    assert.equal(factory.provisionQuote!("ios")!.needsApproval, false);
    // A device host that ran 17 h this month ($81.6) leaves no room for 4 h more ($19.2) under $100.
    boxes.records.set("old", record("old", { state: "destroyed", providerRef: { runId: 1 }, createdAt: new Date(T0 - 17 * 3_600_000).toISOString(), destroyedAt: new Date(T0).toISOString() }));
    assert.equal(factory.provisionQuote!("ios")!.needsApproval, true);
    assert.equal(factory.provisionQuote!("android"), null);
    boxes.configured = false;
    assert.equal(factory.provisionQuote!("ios"), null);
  });

  it("rents a Mac host: refuses without approval, then rents, prepares and resolves it ready", async () => {
    await factory.start(context());
    await assert.rejects(
      factory.provision!({ platform: "ios", approved: false, threadId: "t1" }, new AbortController().signal),
      (error) => isDeviceError(error) && error.code === "PLATFORM_NOT_READY" && /approval/.test(error.message)
    );
    assert.equal(boxes.started.length, 0);

    const progress: DeviceHostProgress[] = [];
    const pending = factory.provision!({ platform: "ios", approved: true, threadId: "t1", onProgress: (entry) => progress.push(entry) }, new AbortController().signal);
    // A second request while renting joins the first.
    const joined = factory.provision!({ platform: "ios", approved: true, threadId: "t2" }, new AbortController().signal);
    await eventually(() => added.has("box:new1"), "the renting host");
    assert.deepEqual(boxes.started, [{ kind: "macos", provider: "blacksmith", size: "6vcpu", image: "macos-26", lifetimeMinutes: 240, purposeNote: "iPhone & iPad simulators (Device simulators)" }]);
    const host = added.get("box:new1")!;
    assert.deepEqual(host.state(), { status: "starting", detail: "Renting a Mac host (6 vCPU M4 · 24 GB)…" });

    // The box service connects it and runs its `devices` step (the factory's preparer), then marks it ready.
    const mac = boxes.mac("new1", new FakeMacBox());
    boxes.set({ ...boxes.records.get("new1")!, setup: [{ id: "devices", label: "Prepare", state: "running", startedAt: null, finishedAt: null, message: null }] });
    const lines: string[] = [];
    await boxes.preparer!({ boxId: "new1", connection: boxes.wiring().hub.get("new1")!, signal: new AbortController().signal, log: (line) => lines.push(line) });
    assert.ok(mac.log.includes("install-tools"));
    assert.ok(lines.some((line) => line.startsWith("Installing the device tools")));
    boxes.set({ ...boxes.records.get("new1")!, state: "ready", setup: [] });

    assert.equal(await pending, host);
    assert.equal(await joined, host);
    assert.equal(boxes.started.length, 1);
    assert.equal(host.state().status, "ready");
    assert.ok(progress.some((entry) => entry.step === "rent-host"));
    assert.ok(progress.some((entry) => entry.step === "prepare-host"));
  });

  it("fails a rental whose box is torn down", async () => {
    await factory.start(context());
    const pending = factory.provision!({ platform: "ios", approved: true, threadId: "t1" }, new AbortController().signal);
    await eventually(() => added.has("box:new1"), "the renting host");
    boxes.set({ ...boxes.records.get("new1")!, state: "destroyed", stateReason: "Setup failed; the box was torn down." });
    await assert.rejects(pending, /Setup failed; the box was torn down/);
  });

  it("destroys an idle rented host after the idle time, and only stops an own Mac's helpers", async () => {
    boxes.records.set("a", record("a"));
    boxes.records.set("b", record("b", { provider: "byo", purpose: "machine", deviceHost: true }));
    const ownMac = boxes.mac("b");
    boxes.mac("a");
    await factory.start(context());
    await eventually(() => factory.host("a")!.isReady() && factory.host("b")!.isReady(), "both hosts ready");

    leases = [{ id: "L1", hostId: "box:a" } as StoredDeviceLease];
    await factory.sweepIdle();
    now += 30 * 60_000;
    await factory.sweepIdle();
    assert.deepEqual(boxes.destroyed, [], "a host with a lease stays");

    leases = [];
    await factory.sweepIdle();
    now += 19 * 60_000;
    await factory.sweepIdle();
    assert.deepEqual(boxes.destroyed, []);
    now += 2 * 60_000;
    await factory.sweepIdle();
    assert.deepEqual(boxes.destroyed, [{ boxId: "a", reason: "deleted", message: "Idle: no device for 20 min (Settings → Devices)." }]);
    assert.ok(!added.has("box:a"));
    // The own Mac is never destroyed: its helpers stop.
    assert.equal(added.get("box:b")!.state().status, "needs-setup");
    assert.equal(ownMac.hub, null);
    assert.equal(ownMac.agentRunning, false);
  });

  it("destroys a rented host on the owner's Destroy and refuses for an own Mac", async () => {
    boxes.records.set("a", record("a"));
    boxes.records.set("b", record("b", { provider: "byo", purpose: "machine", deviceHost: true }));
    boxes.mac("a");
    boxes.mac("b");
    await factory.start(context());
    await added.get("box:a")!.destroy!();
    assert.deepEqual(boxes.destroyed, [{ boxId: "a", reason: "deleted", message: "Destroyed from Settings → Devices." }]);
    await assert.rejects(added.get("box:b")!.destroy!(), /never destroyed/);
  });
});
