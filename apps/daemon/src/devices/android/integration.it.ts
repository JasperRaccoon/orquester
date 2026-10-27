/**
 * Manual integration check of the local Android host on a real KVM machine (not part of `pnpm
 * test`; see `../README.md`). With a throwaway appdir it installs everything (or reuses an SDK
 * with `ORQ_IT_SDK=<sdk dir>`, hard-linked), creates the profile's AVD, boots two leases at once
 * (the first one makes the golden snapshot), checks `sys.boot_completed`, the hub's device list
 * with its token and agent-device through its `--config`, "restarts the daemon" (a second host
 * reattaches), releases both; then, through a real `DeviceService` (the local factory, the
 * agent-device runner and actions), opens one device as an agent and runs `device_action snapshot`;
 * finally checks nothing of the appdir keeps running.
 *
 *   cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx src/devices/android/integration.it.ts /var/lib/orquester/tmp/devices-local-it/app [profile]
 */

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { DEFAULT_DEVICES_SETTINGS, deviceProfile, type DevicesSettings } from "@orquester/api";
import type { StoredDeviceLease } from "@orquester/config";

import { deviceLeasesPath, deviceScreenshotsDir, devicesSettingsPath } from "@orquester/config";

import { createDeviceActionExecutor } from "../actions.ts";
import { createAgentDeviceClient } from "../agent-device.ts";
import { createLocalAndroidHostFactory, LocalAndroidHost } from "../hosts/local-android.ts";
import { DeviceScreenshots } from "../screenshots.ts";
import { DeviceService } from "../service.ts";
import { DeviceLeaseStore, DeviceSettingsStore } from "../store.ts";
import { createDeviceToolchain } from "../toolchain/index.ts";
import { execFile } from "./exec.ts";
import { listProcStats, processMatches } from "./procs.ts";

const appDir = process.argv[2];
const profileId = process.argv[3] ?? "pixel-9";
if (!appDir || !appDir.startsWith("/var/lib/orquester/tmp/")) {
  console.error("usage: integration.it.ts /var/lib/orquester/tmp/<dir> [profile]  (a throwaway appdir)");
  process.exit(2);
}
const profile = deviceProfile(profileId);
if (!profile || profile.platform !== "android") throw new Error(`${profileId} is not an Android profile`);

const started = Date.now();
const t = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
const log = (...parts: unknown[]) => console.log(`[${t()}]`, ...parts);
const logger = { info: (...a: unknown[]) => log("info", ...a), warn: (...a: unknown[]) => log("warn", ...a), error: (...a: unknown[]) => log("error", ...a) };
const settings: DevicesSettings = { ...DEFAULT_DEVICES_SETTINGS, android: { ...DEFAULT_DEVICES_SETTINGS.android, enabled: true, profiles: [profileId] } };
const leases: StoredDeviceLease[] = [];
const ctx = { settings: () => settings, activeLeases: () => leases };
const signal = AbortSignal.timeout(15 * 60_000);

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const at = Date.now();
  const result = await fn();
  log(`${label}: ${((Date.now() - at) / 1000).toFixed(1)} s`);
  return result;
}

const toolchain = createDeviceToolchain({ appDir, env: process.env, logger });
const reuse = process.env.ORQ_IT_SDK;
if (reuse) {
  await mkdir(toolchain.layout.devices, { recursive: true, mode: 0o700 });
  const copy = await execFile("cp", ["-al", reuse, toolchain.layout.sdk]);
  log(`reused the SDK from ${reuse} (hard links): exit ${copy.exitCode} ${copy.stderr.trim()}`);
}

let host = new LocalAndroidHost({ toolchain, logger }, ctx);
let service: DeviceService | null = null;
const evidence: Record<string, unknown> = { profileId };
try {
  await host.reattach();
  await host.start();
  const before = host.readiness();
  log("readiness before:", before.checks.map((check) => `${check.id}=${check.state}`).join(" "));
  let lastStep = "";
  await timed("setup (ensureReady)", () =>
    host.ensureReady(signal, (p) => {
      const key = `${p.step}:${p.state}:${p.detail ?? ""}`;
      if (key !== lastStep) log(`  setup ${p.step} ${p.state}${p.detail ? ` — ${p.detail}` : ""}${p.percent !== undefined ? ` (${p.percent}%)` : ""}`);
      lastStep = key;
    })
  );
  log("host:", host.state(), host.capacity());

  const boot = (leaseId: string) => {
    const lease: StoredDeviceLease = {
      id: leaseId,
      threadId: "it",
      hostId: "local",
      deviceId: null,
      platform: "android",
      profile: profileId,
      name: profile.label,
      osVersion: profile.os,
      state: "starting",
      controller: "agent",
      openedBy: "agent",
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString()
    };
    leases.push(lease);
    return timed(`boot ${leaseId}`, async () => {
      const result = await host.boot({ leaseId, profile, fresh: true }, signal, (p) => log(`  ${leaseId} ${p.step}: ${p.label}${p.detail ? ` — ${p.detail}` : ""}`));
      lease.deviceId = result.deviceId;
      lease.state = "ready";
      return result;
    });
  };
  const [a, b] = await timed("two concurrent boots", () => Promise.all([boot("lease-a"), boot("lease-b")]));
  assert.notEqual(a.deviceId, b.deviceId, "concurrent leases have distinct emulators");
  evidence.serials = [a.deviceId, b.deviceId];
  log("booted:", a.deviceId, b.deviceId, a.screen);
  for (const device of [a, b]) {
    const prop = await host.run("adb", ["-s", device.deviceId, "shell", "getprop", "sys.boot_completed"]);
    assert.equal(prop.exitCode, 0);
    assert.equal(prop.stdout.trim(), "1", `${device.deviceId} completed boot`);
    log(`${device.deviceId} sys.boot_completed=${prop.stdout.trim()}`);
  }
  const origin = host.hubOrigin();
  const token = host.hubToken();
  assert.ok(origin && token, "hub has an authenticated endpoint");
  for (const path of ["/api/devices", "/vendor/serve-emu/api/devices"]) {
    const authenticatedResponse: Response = await fetch(`${origin}${path}`, { headers: { authorization: `Bearer ${token}` } });
    const unauthenticatedResponse: Response = await fetch(`${origin}${path}`);
    const body = await authenticatedResponse.text();
    await unauthenticatedResponse.arrayBuffer();
    assert.equal(authenticatedResponse.status, 200, path);
    assert.ok(unauthenticatedResponse.status === 401 || unauthenticatedResponse.status === 403, `${path} refuses unauthenticated access`);
    assert.ok(body.includes(a.deviceId) && body.includes(b.deviceId), `${path} lists both live instances`);
    log(`GET ${path}: ${authenticatedResponse.status} with the token, ${unauthenticatedResponse.status} without`);
  }
  const config = host.agentDeviceConfigPath();
  const entry = toolchain.toolEntry("agent-device");
  assert.ok(config && entry, "agent-device config and pinned CLI are available");
  {
    const devices = await timed("agent-device devices --config", () => execFile(process.execPath, [entry, "devices", "--json", "--config", config], { env: toolchain.env, timeoutMs: 60_000 }));
    assert.equal(devices.exitCode, 0, devices.stderr);
    const listed = JSON.parse(devices.stdout) as { success: boolean; data?: { devices?: { id: string }[] } };
    assert.equal(listed.success, true);
    for (const id of [a.deviceId, b.deviceId]) assert.ok(listed.data?.devices?.some((device) => device.id === id), id);
  }

  // A daemon restart: the host is disposed with devices running; a new one reattaches.
  await host.dispose();
  host = new LocalAndroidHost({ toolchain, logger }, ctx);
  await timed("reattach after a restart", () => host.reattach());
  await host.start();
  assert.equal(host.hubOrigin(), origin);
  assert.equal(host.hubToken(), token);
  assert.equal(host.capacity().used, 2);
  assert.deepEqual((await host.listDevices()).filter((device) => device.booted).map((device) => device.id).sort(), [a.deviceId, b.deviceId].sort());
  evidence.reattached = true;

  for (const lease of [...leases]) await timed(`release ${lease.id}`, () => host.release(lease, { shutdown: true }));
  await host.teardown();
  leases.length = 0;

  // Through the device service, as an agent's tools reach it.
  await writeFile(devicesSettingsPath(appDir), JSON.stringify({ version: 1, settings }));
  const agentDevice = createAgentDeviceClient({ toolchain, env: process.env });
  const serviceInstance = new DeviceService({
    settingsStore: new DeviceSettingsStore({ file: devicesSettingsPath(appDir), logger }),
    leaseStore: new DeviceLeaseStore({ file: deviceLeasesPath(appDir), logger }),
    factories: [createLocalAndroidHostFactory({ toolchain, logger })],
    actions: createDeviceActionExecutor({ agentDevice, logger }),
    screenshots: new DeviceScreenshots(deviceScreenshotsDir(appDir), logger),
    publish: () => undefined,
    logger
  });
  service = serviceInstance;
  await serviceInstance.start();
  await timed("service: hub ready", async () => {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { unsubscribe(); reject(new Error("local hub did not become ready within 2 minutes")); }, 120_000);
      const check = () => {
        if (serviceInstance.hosts.get("local")?.state().status === "ready") { clearTimeout(timeout); unsubscribe(); resolve(); }
      };
      const unsubscribe = serviceInstance.hosts.onChange(check);
      check();
    });
  });
  const opened = await timed("service: open_device", () => serviceInstance.toolOpen("it-thread", { platform: "android", profile: profileId }, signal));
  assert.equal(opened.ready, true);
  assert.equal(opened.lease.state, "ready");
  evidence.serviceOpened = true;
  for (const round of [1, 2]) {
    const snapshot = await timed(`service: device_action snapshot #${round}`, () => serviceInstance.toolAction("it-thread", undefined, { action: "snapshot" }, signal));
    assert.ok(snapshot.text?.trim(), `snapshot ${round} has semantic output`);
  }
  await timed("service: release", async () => void (await serviceInstance.releaseThread("it-thread")));
  await serviceInstance.stop({ teardown: true });
  evidence.snapshots = 2;
} finally {
  await service?.stop({ teardown: true });
  await host.teardown();
}

const left: string[] = [];
const marker = { key: "ANDROID_AVD_HOME", value: toolchain.layout.avd };
for (const stat of await listProcStats()) {
  if (stat.pid !== process.pid && (await processMatches(stat.pid, marker))) left.push(`${stat.pid} ${stat.comm}`);
}
assert.deepEqual(left, [], "no process of the throwaway appdir remains");
await mkdir(toolchain.layout.logs, { recursive: true });
const artifact = join(toolchain.layout.logs, "integration-result.json");
await writeFile(artifact, `${JSON.stringify({ ...evidence, remainingProcesses: 0 }, null, 2)}\n`, { mode: 0o600 });
log(`verified artifact: ${artifact}`);
log(`logs: ${join(toolchain.layout.logs)}`);
process.exit(left.length === 0 ? 0 : 1);
