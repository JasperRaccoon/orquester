import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEVICES_ACTION_EVENT, DEVICES_LEASE_CLOSED_EVENT, DEVICES_LEASE_EVENT, DEVICES_POOL_EVENT, type DeviceLeaseEventPayload } from "@orquester/api";

import { DeviceError } from "./errors.ts";
import { DeviceScreenshots } from "./screenshots.ts";
import { DeviceService } from "./service.ts";
import { DeviceLeaseStore, DeviceSettingsStore } from "./store.ts";
import { FakeActionExecutor, FakeDeviceHost, FakeHostFactory, startTestDeviceService } from "./testing.ts";

const ANDROID_ON = { android: { enabled: true } };
const signal = () => new AbortController().signal;
const codeOf = async (promise: Promise<unknown>): Promise<string | null> => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof DeviceError ? error.code : `unexpected: ${String(error)}`;
  }
};

test("open → ready lease on the local host; list, release and the events they publish", async () => {
  const host = new FakeDeviceHost();
  const t = await startTestDeviceService({ factories: [new FakeHostFactory("local", ["android"], [host])], settings: ANDROID_ON });
  try {
    const opened = await t.service.toolOpen("t1", { platform: "android", profile: "pixel-fold" }, signal());
    assert.equal(opened.ready, true);
    assert.equal(opened.lease.state, "ready");
    assert.equal(opened.lease.key, "local/dev-1");
    assert.equal(opened.lease.name, "Pixel Fold");
    assert.equal(opened.lease.controller, "agent");
    assert.equal(host.booted[0]!.profile.id, "pixel-fold");
    const states = t.events.filter((event) => event.type === DEVICES_LEASE_EVENT).map((event) => (event.payload as DeviceLeaseEventPayload).lease.state);
    assert.deepEqual(states.slice(0, 1), ["starting"]);
    assert.equal(states.at(-1), "ready");
    // Persisted.
    await t.service.flush();
    const stored = JSON.parse(await readFile(join(t.dir, "device-leases.json"), "utf8"));
    assert.equal(stored.leases[0].state, "ready");

    const list = t.service.toolList("t2");
    assert.deepEqual(list.mine, []);
    assert.deepEqual(list.busy.map((entry) => entry.key), ["local/dev-1"]);
    assert.deepEqual(list.platforms.map((entry) => [entry.platform, entry.enabled, entry.ready]), [
      ["ios", false, false],
      ["android", true, true]
    ]);
    assert.ok(list.profiles.every((profile) => profile.platform === "android"));

    const closed = await t.service.toolClose("t1", { device: "local/dev-1", shutdown: true });
    assert.equal(closed.lease.state, "released");
    assert.deepEqual(host.released.map((entry) => entry.shutdown), [true]);
    assert.equal(t.events.filter((event) => event.type !== DEVICES_POOL_EVENT).at(-2)!.type, DEVICES_LEASE_CLOSED_EVENT);
    assert.deepEqual(t.service.leaseSummaries(), []);
  } finally {
    await t.cleanup();
  }
});

test("agents see and open only the profiles Settings → Devices offers (as the panel's picker)", async () => {
  const host = new FakeDeviceHost();
  const t = await startTestDeviceService({
    factories: [new FakeHostFactory("local", ["android"], [host])],
    settings: { android: { enabled: true, profiles: ["pixel-tablet", "pixel-fold"] } }
  });
  try {
    assert.deepEqual(
      t.service.toolList("t1").profiles.map((profile) => profile.id),
      ["pixel-tablet", "pixel-fold"]
    );
    // A disabled profile is refused with the enabled ones and how the owner enables more.
    const refused = await t.service.toolOpen("t1", { platform: "android", profile: "galaxy-s26" }, signal()).then(
      () => null,
      (error: unknown) => error
    );
    assert.ok(refused instanceof DeviceError && refused.code === "INVALID_ARGUMENT");
    assert.match(refused.message, /Galaxy S26 \(galaxy-s26\) is not enabled.*Enabled Android profiles: pixel-tablet, pixel-fold\..*Settings → Devices → Android → Profiles/);
    assert.equal(host.booted.length, 0);
    // None named: the default (Pixel 9) is off, so the first enabled one.
    const opened = await t.service.toolOpen("t1", { platform: "android" }, signal());
    assert.equal(host.booted[0]!.profile.id, "pixel-tablet");
    assert.equal(opened.lease.name, "Pixel Tablet");
  } finally {
    await t.cleanup();
  }
});

test("limits: the chat's lease cap, a full host, a platform that is off or not set up", async () => {
  const host = new FakeDeviceHost();
  host.total = 2;
  const t = await startTestDeviceService({ factories: [new FakeHostFactory("local", ["android"], [host])], settings: { ...ANDROID_ON, maxLeasesPerChat: 1, pool: { capacityWaitSeconds: 0 } } });
  try {
    await t.service.toolOpen("t1", { platform: "android" }, signal());
    assert.equal(await codeOf(t.service.toolOpen("t1", { platform: "android" }, signal())), "DEVICE_LEASE_LIMIT");
    await t.service.toolOpen("t2", { platform: "android" }, signal());
    assert.equal(await codeOf(t.service.toolOpen("t3", { platform: "android" }, signal())), "DEVICE_CAPACITY");
    assert.equal(await codeOf(t.service.toolOpen("t3", { platform: "ios" }, signal())), "PLATFORM_NOT_READY");
    assert.equal(await codeOf(t.service.toolOpen("t3", { platform: "android", profile: "iphone-17-pro" }, signal())), "INVALID_ARGUMENT");
  } finally {
    await t.cleanup();
  }

  const broken = new FakeDeviceHost();
  broken.status = { status: "needs-setup", detail: "KVM missing" };
  broken.checks = [{ id: "kvm", label: "Hardware virtualization", state: "missing", detail: null }];
  const u = await startTestDeviceService({ factories: [new FakeHostFactory("local", ["android"], [broken])], settings: ANDROID_ON });
  try {
    await assert.rejects(u.service.toolOpen("t1", { platform: "android" }, signal()), (error: DeviceError) => error.code === "PLATFORM_NOT_READY" && /Hardware virtualization/.test(error.message));
  } finally {
    await u.cleanup();
  }
});

test("a host the daemon can fix itself is set up first (the setup job is published), then the lease boots", async () => {
  const host = new FakeDeviceHost();
  host.status = { status: "needs-setup", detail: null };
  host.checks = [{ id: "android-sdk", label: "Android SDK", state: "missing", detail: null, fixActionId: "install-android-sdk" }];
  const t = await startTestDeviceService({ factories: [new FakeHostFactory("local", ["android"], [host])], settings: ANDROID_ON });
  try {
    const opened = await t.service.toolOpen("t1", { platform: "android" }, signal());
    assert.equal(opened.lease.state, "ready");
    assert.deepEqual(host.ensured, [["install-android-sdk"]]);
    const job = t.service.setupJob("android");
    assert.equal(job?.state, "done");
    assert.equal(job?.percent, 100);
  } finally {
    await t.cleanup();
  }
});

test("renting a host: refused without approval, done with it", async () => {
  const factory = new FakeHostFactory("box", ["ios"], [], () => new FakeDeviceHost("box:b1", "box", ["ios"], "Mac host"));
  factory.quote = { platform: "ios", provider: "blacksmith", providerLabel: "Blacksmith", size: "m", sizeLabel: "6 vCPU", hourlyUsd: 4.8, lifetimeMinutes: 240, needsApproval: true };
  const t = await startTestDeviceService({ factories: [factory], settings: { ios: { enabled: true } } });
  try {
    assert.deepEqual(t.service.toolPlanOpen("t1", "ios").rental?.hourlyUsd, 4.8);
    await assert.rejects(t.service.toolOpen("t1", { platform: "ios" }, signal()), (error: DeviceError) => error.code === "PLATFORM_NOT_READY" && /approval/.test(error.message));
    const opened = await t.service.toolOpen("t1", { platform: "ios", rentalApproved: true }, signal());
    assert.equal(opened.lease.hostId, "box:b1");
    assert.deepEqual(factory.provisioned, [{ platform: "ios", approved: true }]);
    // A host with room now: no rental needed.
    assert.equal(t.service.toolPlanOpen("t2", "ios").rental, null);
  } finally {
    await t.cleanup();
  }
});

test("open_device answers `starting` when the boot outlasts the wait, and the boot carries on", async () => {
  const host = new FakeDeviceHost();
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => (finish = resolve));
  const original = host.bootImpl;
  host.bootImpl = async (request, abort) => {
    await gate;
    return original(request, abort);
  };
  const t = await startTestDeviceService({ factories: [new FakeHostFactory("local", ["android"], [host])], settings: ANDROID_ON, deps: { openWaitMs: 5 } });
  try {
    const opened = await t.service.toolOpen("t1", { platform: "android", app: "com.example" }, signal());
    assert.equal(opened.ready, false);
    assert.equal(opened.lease.state, "starting");
    assert.equal(opened.progress, "Starting Pixel 9");
    const ready = t.nextEvent((type, payload) => type === DEVICES_LEASE_EVENT && (payload as DeviceLeaseEventPayload).lease.state === "ready");
    finish();
    await ready;
    // The boot carried on, and the app is launched once the device is ready.
    assert.deepEqual(t.actions.launches, ["com.example"]);
  } finally {
    await t.cleanup();
  }
});

test("controller handoff and actions: the user's input takes control, agent input is refused, reads still run", async () => {
  const host = new FakeDeviceHost();
  const t = await startTestDeviceService({ factories: [new FakeHostFactory("local", ["android"], [host])], settings: ANDROID_ON });
  try {
    const { lease } = await t.service.toolOpen("t1", { platform: "android" }, signal());
    const tapped = await t.service.toolAction("t1", undefined, { action: "tap", x: 10, y: 20 }, signal());
    assert.equal(tapped.text, "tap ok");
    assert.equal(tapped.entry.actor, "agent");
    assert.ok(t.events.some((event) => event.type === DEVICES_ACTION_EVENT));
    assert.equal(await codeOf(t.service.toolAction("t1", undefined, { action: "tap" }, signal())), "INVALID_ARGUMENT");

    t.service.userInput("local", lease.stream!.deviceParam);
    assert.equal(t.service.lease(lease.id)?.controller, "user");
    assert.equal(await codeOf(t.service.toolAction("t1", lease.key!, { action: "tap", ref: "@e1" }, signal())), "DEVICE_CONTROLLED_BY_USER");
    assert.equal(await codeOf(t.service.toolAction("t1", lease.key!, { action: "snapshot" }, signal())), null);
    t.service.setController(lease.id, "agent");
    assert.equal(await codeOf(t.service.toolAction("t1", lease.key!, { action: "tap", ref: "@e1" }, signal())), null);
    assert.deepEqual(t.service.actions(lease.id).map((entry) => entry.kind), ["tap", "snapshot", "tap"]);
    // Another chat cannot reach it.
    assert.equal(await codeOf(t.service.toolAction("t2", lease.key!, { action: "snapshot" }, signal())), "DEVICE_NOT_LEASED");
  } finally {
    await t.cleanup();
  }
});

test("screenshots are kept per lease (deviceRef), served back, and dropped when the chat closes", async () => {
  const host = new FakeDeviceHost();
  const t = await startTestDeviceService({ factories: [new FakeHostFactory("local", ["android"], [host])], settings: ANDROID_ON });
  try {
    t.actions.result = () => ({ log: { summary: "Took a screenshot" }, image: { mimeType: "image/png", data: Buffer.from("png-bytes"), width: 1, height: 1 } });
    const { lease } = await t.service.toolOpen("t1", { platform: "android" }, signal());
    const shot = await t.service.toolAction("t1", undefined, { action: "screenshot" }, signal());
    assert.ok(shot.screenshotId);
    assert.equal(shot.image?.base64, Buffer.from("png-bytes").toString("base64"));
    assert.deepEqual((await t.service.screenshot(lease.id, shot.screenshotId!))?.data, Buffer.from("png-bytes"));
    assert.equal(await t.service.screenshot(lease.id, "../../etc"), null);
    await t.service.releaseThread("t1");
    assert.deepEqual(t.service.leaseSummaries(), []);
    assert.equal(await t.service.screenshot(lease.id, shot.screenshotId!), null);
  } finally {
    await t.cleanup();
  }
});

test("device_install reads only inside the chat's project", async () => {
  const project = await mkdtemp(join(tmpdir(), "orq-devices-project-"));
  await mkdir(join(project, "build"), { recursive: true });
  await writeFile(join(project, "build", "app.apk"), "apk");
  const host = new FakeDeviceHost();
  const t = await startTestDeviceService({
    factories: [new FakeHostFactory("local", ["android"], [host])],
    settings: ANDROID_ON,
    deps: { threadProject: () => project }
  });
  try {
    await t.service.toolOpen("t1", { platform: "android" }, signal());
    const installed = await t.service.toolInstall("t1", { path: join(project, "build", "app.apk") }, signal());
    assert.equal(installed.appId, "com.example.app");
    assert.equal(await codeOf(t.service.toolInstall("t1", { path: "/etc/hostname" }, signal())), "INVALID_ARGUMENT");
    assert.equal(await codeOf(t.service.toolInstall("t1", { path: join(project, "missing.apk") }, signal())), "INVALID_ARGUMENT");
  } finally {
    await t.cleanup();
    await rm(project, { recursive: true, force: true });
  }
});

test("restart reconcile, a host going away, the idle sweep, and the toolset switch", async () => {
  const host = new FakeDeviceHost();
  const factory = new FakeHostFactory("local", ["android"], [host]);
  let now = Date.parse("2026-10-27T10:00:00.000Z");
  const t = await startTestDeviceService({ factories: [factory], settings: ANDROID_ON, deps: { now: () => now } });
  try {
    assert.equal(t.service.toolsAvailable(), true);
    const tools: string[] = [];
    t.service.events.on("tools", () => tools.push("changed"));
    await t.service.updateSettings({ agents: { enabled: false } });
    assert.equal(t.service.toolsAvailable(), false);
    assert.deepEqual(tools, ["changed"]);
    assert.equal(await codeOf(t.service.toolOpen("t1", { platform: "android" }, signal())), "DEVICES_DISABLED");
    await t.service.updateSettings({ agents: { enabled: true } });

    const a = await t.service.toolOpen("t1", { platform: "android" }, signal());
    const b = await t.service.toolOpen("t2", { platform: "android" }, signal());
    now += 30 * 60_000;
    t.service.viewerActive(b.lease.id);
    now += 40 * 60_000;
    await t.service.sweepIdle();
    assert.deepEqual(t.service.leaseSummaries().map((lease) => lease.id), [b.lease.id]);
    assert.notEqual(a.lease.id, b.lease.id);

    // The host goes: its leases are lost, and the agent hears DEVICE_LOST.
    factory.ctx!.removeHost("local");
    assert.equal(t.service.lease(b.lease.id)?.state, "lost");
    assert.equal(await codeOf(t.service.toolAction("t2", undefined, { action: "snapshot" }, signal())), "DEVICE_LOST");
    assert.equal(await codeOf(t.service.toolAction("t2", b.lease.id, { action: "snapshot" }, signal())), "DEVICE_LOST");
  } finally {
    await t.cleanup();
  }
});

test("start: a lease whose boot a restart interrupted is lost; one of a closed chat is released", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orq-devices-restart-"));
  const base = { hostId: "local", platform: "android", profile: "pixel-9", name: "Pixel 9", osVersion: "Android 15", controller: "agent", openedBy: "agent", createdAt: "2026-10-27T10:00:00.000Z", lastUsedAt: "2026-10-27T10:00:00.000Z" };
  await writeFile(
    join(dir, "device-leases.json"),
    JSON.stringify({
      version: 1,
      leases: [
        { ...base, id: "s", threadId: "open", deviceId: null, state: "starting" },
        { ...base, id: "r", threadId: "open", deviceId: "emulator-1", state: "ready" },
        { ...base, id: "c", threadId: "closed", deviceId: "emulator-2", state: "ready" }
      ]
    })
  );
  const host = new FakeDeviceHost();
  const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const service = new DeviceService({
    settingsStore: new DeviceSettingsStore({ file: join(dir, "devices.json"), logger: quiet }),
    leaseStore: new DeviceLeaseStore({ file: join(dir, "device-leases.json"), logger: quiet }),
    factories: [new FakeHostFactory("local", ["android"], [host])],
    actions: new FakeActionExecutor(),
    screenshots: new DeviceScreenshots(join(dir, "shots"), quiet),
    publish: () => undefined,
    threadExists: (id) => id !== "closed",
    logger: quiet,
    idleTimer: false
  });
  try {
    await service.start();
    assert.deepEqual(
      service.leaseSummaries().map((lease) => [lease.id, lease.state]),
      [
        ["s", "lost"],
        ["r", "ready"]
      ]
    );
    assert.deepEqual(host.released.map((entry) => entry.lease.id), ["c"]);
  } finally {
    await service.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a host whose link drops suspends its ready leases; they resume when it is ready again", async () => {
  const host = new FakeDeviceHost("box:mac1", "box", ["ios"], "Mac host");
  const t = await startTestDeviceService({ factories: [new FakeHostFactory("box", ["ios"], [host])], settings: { ios: { enabled: true } } });
  try {
    const opened = await t.service.toolOpen("t1", { platform: "ios" }, signal());
    assert.equal(opened.lease.state, "ready");
    host.status = { status: "unreachable", detail: "Reconnecting to the host…" };
    host.changed();
    assert.equal(t.service.lease(opened.lease.id)?.state, "suspended");
    assert.equal(await codeOf(t.service.toolAction("t1", undefined, { action: "snapshot" }, signal())), "UNAVAILABLE");
    host.status = { status: "ready", detail: null };
    host.changed();
    assert.equal(t.service.lease(opened.lease.id)?.state, "ready");
  } finally {
    await t.cleanup();
  }
});

test("a lease waiting for a starting host sits through its progress lines and goes on when it is ready", async () => {
  const host = new FakeDeviceHost("box:mac1", "box", ["ios"], "Mac host");
  host.status = { status: "starting", detail: "Preparing: installing the device tools…" };
  const t = await startTestDeviceService({ factories: [new FakeHostFactory("box", ["ios"], [host])], settings: { ios: { enabled: true } } });
  try {
    const opening = t.service.openLease({ threadId: "t1", platform: "ios", openedBy: "user", rentalApproved: true }, signal());
    // More progress lines than placement has rounds: none of them is a new status.
    for (let i = 0; i < 10; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      host.status = { status: "starting", detail: `Preparing: step ${i}` };
      host.changed();
    }
    host.status = { status: "ready", detail: null };
    host.changed();
    const lease = await opening;
    assert.equal(lease.state, "ready");
    assert.equal(lease.hostId, "box:mac1");
  } finally {
    await t.cleanup();
  }
});
