/**
 * Manual integration check of the local Android host on a real KVM machine (not part of `pnpm
 * test`; see `../README.md`). With a throwaway appdir it installs everything (or reuses an SDK
 * with `ORQ_IT_SDK=<sdk dir>`, hard-linked), creates the profile's AVD, boots two leases at once
 * (the first one makes the golden snapshot), checks `sys.boot_completed`, the hub's device list
 * with its token and agent-device through its `--config`, "restarts the daemon" (a second host
 * reattaches), releases both and checks nothing of the appdir keeps running.
 *
 *   cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx src/devices/android/integration.it.ts /var/lib/orquester/tmp/devices-local-it/app [profile]
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { DEFAULT_DEVICES_SETTINGS, deviceProfile, type DevicesSettings } from "@orquester/api";
import type { StoredDeviceLease } from "@orquester/config";

import { LocalAndroidHost } from "../hosts/local-android.ts";
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
const signal = new AbortController().signal;

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

let host = new LocalAndroidHost({ appDir, env: process.env, toolchain, logger }, ctx);
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
log("booted:", a.deviceId, b.deviceId, a.screen);
for (const device of [a, b]) {
  const prop = await host.run("adb", ["-s", device.deviceId, "shell", "getprop", "sys.boot_completed"]);
  log(`${device.deviceId} sys.boot_completed=${prop.stdout.trim()}`);
}
const origin = host.hubOrigin();
const token = host.hubToken();
for (const path of ["/api/devices", "/vendor/serve-emu/api/devices"]) {
  const authed = await fetch(`${origin}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const bare = await fetch(`${origin}${path}`);
  log(`GET ${path}: ${authed.status} with the token, ${bare.status} without →`, (await authed.text()).slice(0, 400));
}
const config = host.agentDeviceConfigPath();
const entry = toolchain.toolEntry("agent-device");
if (config && entry) {
  const devices = await timed("agent-device devices --config", () => execFile(process.execPath, [entry, "devices", "--json", "--config", config], { env: toolchain.env, timeoutMs: 60_000 }));
  log(`agent-device exit ${devices.exitCode}:`, devices.stdout.slice(0, 400), devices.stderr.slice(0, 200));
} else log("agent-device config missing:", config, entry);

// A daemon restart: the host is disposed with devices running; a new one reattaches.
await host.dispose();
host = new LocalAndroidHost({ appDir, env: process.env, toolchain, logger }, ctx);
await timed("reattach after a restart", () => host.reattach());
await host.start();
log("after restart:", host.state().status, host.capacity(), "same hub:", host.hubOrigin() === origin, "same token:", host.hubToken() === token);

for (const lease of [...leases]) await timed(`release ${lease.id}`, () => host.release(lease, { shutdown: true }));
await host.teardown();

const left: string[] = [];
const marker = { key: "ANDROID_AVD_HOME", value: toolchain.layout.avd };
for (const stat of await listProcStats()) {
  if (stat.pid !== process.pid && (await processMatches(stat.pid, marker))) left.push(`${stat.pid} ${stat.comm}`);
}
log(left.length === 0 ? "no process of this appdir remains" : `STILL RUNNING: ${left.join(", ")}`);
log(`logs: ${join(toolchain.layout.logs)}`);
process.exit(left.length === 0 ? 0 : 1);
