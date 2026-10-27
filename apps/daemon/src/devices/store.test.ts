import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_DEVICES_SETTINGS, type StoredDeviceLease } from "@orquester/config";

import { DeviceLeaseStore, DeviceSettingsStore } from "./store.ts";

const quiet = { warn: () => undefined, error: () => undefined };

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "orq-devices-store-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const lease = (id: string): StoredDeviceLease => ({
  id,
  threadId: "t",
  hostId: "local",
  deviceId: "emulator-5554",
  platform: "android",
  profile: "pixel-9",
  name: "Pixel 9",
  osVersion: "Android 15",
  state: "ready",
  controller: "agent",
  openedBy: "agent",
  createdAt: "a",
  lastUsedAt: "b"
});

test("settings: a missing file reads the defaults; an update is written atomically and keeps unknown keys", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "devices.json");
    const store = new DeviceSettingsStore({ file, logger: quiet });
    assert.deepEqual(await store.load(), DEFAULT_DEVICES_SETTINGS);
    assert.equal(store.loaded, true);
    await writeFile(file, JSON.stringify({ version: 1, other: 1, settings: { android: { enabled: true, extra: "x" } } }));
    const again = new DeviceSettingsStore({ file, logger: quiet });
    assert.equal((await again.load()).android.enabled, true);
    const next = await again.update({ ios: { enabled: true } });
    assert.equal(next.ios.enabled, true);
    const written = JSON.parse(await readFile(file, "utf8"));
    assert.equal(written.other, 1);
    assert.equal(written.settings.android.extra, "x");
    assert.equal(written.settings.ios.enabled, true);
  });
});

test("settings: vphone host entries this build does not read survive an update, unless the patch names them", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "devices.json");
    await writeFile(file, JSON.stringify({ version: 1, settings: { research: { vphoneHosts: { box1: { enabled: true }, "odd key": { enabled: true }, box2: "later-shape" } } } }));
    const store = new DeviceSettingsStore({ file, logger: quiet });
    assert.deepEqual(Object.keys((await store.load()).research.vphoneHosts), ["box1"]);
    await store.update({ ios: { enabled: true } });
    let written = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(written.settings.research.vphoneHosts["odd key"], { enabled: true });
    assert.equal(written.settings.research.vphoneHosts.box2, "later-shape");
    // A patch that sets box2 replaces the kept value.
    await store.update({ research: { vphoneHosts: { box2: { enabled: true } } } });
    written = JSON.parse(await readFile(file, "utf8"));
    assert.equal(written.settings.research.vphoneHosts.box2.enabled, true);
    assert.deepEqual(written.settings.research.vphoneHosts["odd key"], { enabled: true });
  });
});

test("settings: a corrupt file is moved aside and the store refuses updates until restart", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "devices.json");
    await writeFile(file, "{not json");
    const store = new DeviceSettingsStore({ file, logger: quiet });
    assert.deepEqual(await store.load(), DEFAULT_DEVICES_SETTINGS);
    assert.match(store.readOnlyReason ?? "", /corrupt/);
    assert.ok((await readdir(dir)).some((name) => name.startsWith("devices.json.corrupt-")));
    await assert.rejects(store.update({ android: { enabled: true } }), /cannot be saved/);
  });
});

test("leases: written from the snapshot when the write runs; unreadable entries and keys survive", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "device-leases.json");
    await writeFile(file, JSON.stringify({ version: 1, keep: true, leases: [lease("a"), { id: 7 }] }));
    const store = new DeviceLeaseStore({ file, logger: quiet });
    const loaded = await store.load();
    assert.deepEqual(loaded.map((entry) => entry.id), ["a"]);
    let current = loaded;
    // Nothing is written before the service hands its snapshot over.
    await store.persist();
    assert.equal(JSON.parse(await readFile(file, "utf8")).leases.length, 2);
    store.setSnapshot(() => current);
    const write = store.persist();
    current = [...loaded, lease("b")];
    await write;
    const written = JSON.parse(await readFile(file, "utf8"));
    assert.equal(written.keep, true);
    assert.deepEqual(written.leases.map((entry: { id: unknown }) => entry.id), ["a", "b", 7]);
  });
});

test("leases: an outer shape this build cannot read is quarantined, never overwritten", async () => {
  await withDir(async (dir) => {
    const file = join(dir, "device-leases.json");
    await writeFile(file, JSON.stringify({ version: 3, leases: [] }));
    const store = new DeviceLeaseStore({ file, logger: quiet });
    assert.deepEqual(await store.load(), []);
    assert.notEqual(store.readOnlyReason, null);
    store.setSnapshot(() => [lease("x")]);
    await store.persist();
    assert.deepEqual(await readdir(dir).then((names) => names.filter((name) => name === "device-leases.json")), []);
  });
});
