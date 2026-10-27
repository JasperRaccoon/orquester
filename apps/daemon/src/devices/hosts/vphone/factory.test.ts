import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { BoxSummary } from "@orquester/api";
import { defaultDevicesSettings, type DevicesSettings } from "@orquester/config";

import type { DeviceHost, DeviceHostFactoryContext } from "../../host.ts";
import { createVphoneHostFactory, isVphoneCandidate } from "./factory.ts";
import { FakeMacLink } from "./testing.ts";

function box(id: string, extra: Partial<BoxSummary> = {}): BoxSummary {
  return {
    id,
    purpose: "machine",
    kind: "macos",
    provider: "byo",
    providerLabel: "Your machines",
    region: "",
    regionLabel: "",
    size: "",
    sizeLabel: "",
    image: null,
    os: "darwin",
    arch: "arm64",
    state: "ready",
    stateReason: null,
    destroyedReason: null,
    hourlyUsd: 0,
    estimatedCostUsd: 0,
    createdAt: "2026-10-27T09:00:00.000Z",
    readyAt: "2026-10-27T09:01:00.000Z",
    deadlineAt: null,
    destroyedAt: null,
    connected: true,
    lastSeenAt: null,
    project: null,
    threadId: null,
    purposeNote: null,
    setup: [],
    deviceHost: true,
    byo: { name: `Mac ${id}`, pairingExpiresAt: null },
    ...extra
  };
}

test("only bring-your-own Macs marked for devices AND switched to research iPhones become vphone hosts", () => {
  const settings = defaultDevicesSettings();
  settings.research.vphoneHosts = { a: { enabled: true, iphoneSource: null, cloudosSource: null } };
  assert.equal(isVphoneCandidate(box("a"), settings), true);
  assert.equal(isVphoneCandidate(box("b"), settings), false, "research switch off");
  assert.equal(isVphoneCandidate(box("a", { deviceHost: false }), settings), false);
  assert.equal(isVphoneCandidate(box("a", { provider: "blacksmith" }), settings), false);
  assert.equal(isVphoneCandidate(box("a", { kind: "linux", os: "linux" }), settings), false);
  assert.equal(isVphoneCandidate(box("a", { state: "pairing" }), settings), false);
});

test("the factory follows the box registry and the settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orq-vphone-factory-"));
  const boxes = new Map<string, BoxSummary>([
    ["a", box("a")],
    ["b", box("b", { deviceHost: false })]
  ]);
  const registryEvents = new EventEmitter();
  const links = new Map([["a", new FakeMacLink()]]);
  const registry = {
    list: () => [...boxes.keys()].map((id) => ({ id })),
    summary: (id: string) => boxes.get(id),
    onChange: (listener: (id: string) => void) => {
      registryEvents.on("change", listener);
      return () => void registryEvents.off("change", listener);
    }
  };
  const hub = { get: (id: string) => links.get(id), onConnectionChange: () => () => undefined };
  const factory = createVphoneHostFactory({
    appDir: dir,
    boxes: () => ({ registry, hub }) as never,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined }
  });

  let settings: DevicesSettings = defaultDevicesSettings();
  const hosts = new Map<string, DeviceHost>();
  const ctx: DeviceHostFactoryContext = {
    settings: () => settings,
    activeLeases: () => [],
    addHost: (host) => void hosts.set(host.id, host),
    removeHost: (id) => void hosts.delete(id),
    logger: console
  };
  await factory.start(ctx);
  assert.deepEqual([...hosts.keys()], []);

  settings = structuredClone(settings);
  settings.research.vphoneHosts = { a: { enabled: true, iphoneSource: null, cloudosSource: null }, b: { enabled: true, iphoneSource: null, cloudosSource: null } };
  factory.settingsChanged?.(settings);
  assert.deepEqual([...hosts.keys()], ["vphone:a"], "b is not marked for device simulators");
  const host = hosts.get("vphone:a")!;
  assert.equal(host.kind, "byo");
  assert.equal(host.label, "Virtual iPhones (research) on Mac a");
  assert.deepEqual(host.box?.(), { boxId: "a", provider: "byo", hourlyUsd: 0, startedAt: "2026-10-27T09:01:00.000Z", deadlineAt: null });

  boxes.set("a", box("a", { deviceHost: false }));
  registryEvents.emit("change", "a");
  assert.deepEqual([...hosts.keys()], []);

  boxes.set("a", box("a"));
  registryEvents.emit("change", "a");
  assert.deepEqual([...hosts.keys()], ["vphone:a"]);
  await factory.stop();
  assert.deepEqual([...hosts.keys()], []);
  await links.get("a")!.close();
  await rm(dir, { recursive: true, force: true });
});
