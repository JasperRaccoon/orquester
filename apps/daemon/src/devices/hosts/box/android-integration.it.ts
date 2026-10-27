/**
 * Manual integration check of the Linux box Android host with real emulators (not part of `pnpm
 * test`; see `../../README.md`). The "box" is this machine through `localBoxConnection()`: prepare
 * (install path unless the root already holds an SDK), N concurrent read-only leases, each one's
 * `sys.boot_completed`, the display cutout of the first one (dumpsys + a screenshot), the hub's
 * `/api/devices` with and without its token, an agent-device `snapshot -i` through the host's
 * `--config`, a simulated daemon restart (a second host reattaches), release, teardown; finally
 * checks nothing of the root keeps running. Prints a JSON summary with timings.
 *
 *   cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx src/devices/hosts/box/android-integration.it.ts <root> <appDir>
 *
 * Env: `ORQ_IT_SDK=<sdk>` hard-links an SDK into `<root>/android-sdk` first; `ORQ_IT_DEVICES`
 * (default 2);
 * `ORQ_IT_KIND=box|byo` (default byo); `ORQ_IT_PROFILE` (default pixel-9).
 */

import { execFile as execFileCb } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { DEFAULT_DEVICES_SETTINGS, deviceProfile, type DevicesSettings } from "@orquester/api";
import type { StoredBox, StoredDeviceLease } from "@orquester/config";

import { isolatedDeviceBox } from "./local-namespace.ts";
import { createAgentDeviceClient } from "../../agent-device.ts";
import type { DeviceToolchain } from "../../toolchain/index.ts";
import { BoxAndroidHost } from "./android-host.ts";

const execFile = promisify(execFileCb);
const [root, appDir] = process.argv.slice(2);
if (!root || !appDir) {
  console.error("usage: android-integration.it.ts <device root> <appDir>  (throwaway dirs)");
  process.exit(2);
}
const profile = deviceProfile(process.env.ORQ_IT_PROFILE ?? "pixel-9")!;
const count = Number(process.env.ORQ_IT_DEVICES ?? 2);
const kind = process.env.ORQ_IT_KIND === "box" ? "box" : "byo";

const started = Date.now();
const t = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
const log = (...parts: unknown[]) => console.log(`[${t()}]`, ...parts);
const logger = { info: (...a: unknown[]) => log("info", ...a), warn: (...a: unknown[]) => log("warn", ...a), error: (...a: unknown[]) => log("error", ...a) };
const timings: Record<string, number> = {};
async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const at = Date.now();
  const result = await fn();
  timings[label] = Math.round((Date.now() - at) / 100) / 10;
  log(`${label}: ${timings[label]} s`);
  return result;
}
const summary: Record<string, unknown> = { timings };

await mkdir(root, { recursive: true });
await mkdir(appDir, { recursive: true });
if (process.env.ORQ_IT_SDK) {
  await execFile("cp", ["-al", process.env.ORQ_IT_SDK, join(root, "android-sdk")]).catch((error) => log("SDK copy:", String(error)));
}

const connection = isolatedDeviceBox({ root, boxId: "it-box", provider: kind === "box" ? "blacksmith" : "byo" });
const settings: DevicesSettings = { ...DEFAULT_DEVICES_SETTINGS, android: { ...DEFAULT_DEVICES_SETTINGS.android, enabled: true, profiles: [profile.id], maxLocalDevices: Math.max(count, 2) } };
const record = {
  id: "it-box",
  purpose: kind === "box" ? "device-host" : "machine",
  kind: "linux",
  provider: kind === "box" ? "blacksmith" : "byo",
  region: "it",
  size: "it",
  name: "orq-it-box",
  os: "linux",
  createdAt: new Date().toISOString(),
  state: "ready"
} as StoredBox;
const leases: StoredDeviceLease[] = [];
const make = () =>
  new BoxAndroidHost({
    boxId: "it-box",
    kind,
    label: "IT Linux host",
    appDir,
    record: () => record,
    connection: () => connection,
    settings: () => settings,
    activeLeases: () => leases,
    logger
  });
const signal = AbortSignal.timeout(40 * 60_000);
let failed = false;
let host = make();
try {
  let last = "";
  await timed("prepare", () =>
    host.prepare(connection, signal, (p) => {
      const key = `${p.step}:${p.state}:${p.detail ?? ""}`;
      if (key !== last && p.logLine === undefined) log(`  prepare ${p.step} ${p.state}${p.detail ? ` — ${p.detail}` : ""}`);
      last = key;
    })
  );
  summary.cacheState = host.cacheState();
  summary.capacity = host.capacity();
  summary.notReady = host.readiness().checks.filter((check) => check.state !== "ok").map((check) => `${check.id}: ${check.detail}`);
  log("host:", host.state(), host.capacity(), "cache:", host.cacheState());

  const boot = (index: number) => {
    const id = `lease-${index}`;
    const lease: StoredDeviceLease = {
      id,
      threadId: "it",
      hostId: host.id,
      deviceId: null,
      platform: "android",
      profile: profile.id,
      name: profile.label,
      osVersion: profile.os,
      state: "starting",
      controller: "agent",
      openedBy: "agent",
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString()
    };
    leases.push(lease);
    return timed(`boot ${id}`, async () => {
      const result = await host.boot({ leaseId: id, profile, fresh: true }, signal, (p) => log(`  ${id} ${p.step}: ${p.label}`));
      lease.deviceId = result.deviceId;
      lease.state = "ready";
      return result;
    });
  };
  const results = await timed(`${count} concurrent boots`, () => Promise.all(Array.from({ length: count }, (_, index) => boot(index))));
  summary.screen = results[0]!.screen;
  summary.bootCompleted = [];
  for (const device of results) {
    const prop = await host.run("adb", ["-s", device.deviceId, "shell", "getprop", "sys.boot_completed"]);
    (summary.bootCompleted as string[]).push(`${device.deviceId}=${prop.stdout.trim()}`);
  }
  log("boot_completed:", summary.bootCompleted);

  // The display cutout: a dp spec centred on the panel (an AVD made here), or the device's own (a cache AVD).
  const first = results[0]!.deviceId;
  const display = (await host.run("adb", ["-s", first, "shell", "dumpsys display"])).stdout;
  summary.cutoutSpec = /cutoutSpec=\{([^}]*)\}/.exec(display)?.[1] ?? null;
  summary.cutoutBounds = /boundingRect=\{Bounds=\[[^\]]*\]\}/.exec(display)?.[0] ?? null;
  summary.wmSize = (await host.run("adb", ["-s", first, "shell", "wm size"])).stdout.trim();
  const shot = await host.run("adb", ["-s", first, "shell", "screencap -p /data/local/tmp/it.png"]);
  const pulled = await host.run("adb", ["-s", first, "pull", "/data/local/tmp/it.png", join(root, "logs", "screenshot.png")]);
  log("cutout:", summary.cutoutSpec, summary.cutoutBounds, summary.wmSize, "screenshot:", shot.exitCode, pulled.exitCode);

  const origin = host.hubOrigin()!;
  const token = host.hubToken()!;
  const authed = await fetch(`${origin}/api/devices`, { headers: { authorization: `Bearer ${token}` } });
  const bare = await fetch(`${origin}/api/devices`);
  summary.hub = { withToken: authed.status, withoutToken: bare.status };
  log(`hub /api/devices: ${authed.status} with the token, ${bare.status} without →`, (await authed.text()).slice(0, 300));

  const agent = createAgentDeviceClient({ toolchain: {} as DeviceToolchain, env: process.env });
  const snapshot = await timed("agent-device snapshot -i", () => agent.run({ host, lease: leases[0]! }, "snapshot", ["-i"], { signal, timeoutMs: 180_000 }));
  summary.snapshot = { exitCode: snapshot.exitCode, head: snapshot.stdout.split("\n").slice(0, 6).join(" | ").slice(0, 400), stderr: snapshot.stderr.slice(0, 300) };
  log("snapshot:", summary.snapshot);

  // A daemon restart: the host goes away with devices running; a new one reattaches.
  await host.dispose();
  host = make();
  await timed("reattach after a restart", () => host.prepare(connection, signal));
  summary.reattach = { sameToken: host.hubToken() === token, used: host.capacity().used };
  log("after restart:", summary.reattach);

  await timed("release all", async () => {
    for (const lease of [...leases]) await host.release(lease, { shutdown: true });
  });
  leases.length = 0;
} catch (error) {
  failed = true;
  summary.error = error instanceof Error ? error.message : String(error);
  log("FAILED:", summary.error);
} finally {
  await timed("teardown", () => host.teardown()).catch((error) => log("teardown failed:", String(error)));
}

// Emulators, the hub, agent-device's daemon and adb started under the root (not this script or its shell).
const left = await execFile("pgrep", ["-af", root]).then(
  (result) => result.stdout.trim().split("\n").filter((line) => line && /qemu-system|hub-launcher|agent-device|platform-tools\/adb/.test(line) && !line.startsWith(`${process.pid} `)),
  () => [] as string[]
);
summary.leftRunning = left;
summary.ok = !failed && left.length === 0;
await writeFile(join(root, "logs", "it-summary.json"), `${JSON.stringify(summary, null, 2)}\n`).catch(() => undefined);
console.log(`IT-SUMMARY ${JSON.stringify(summary)}`);
process.exit(summary.ok ? 0 : 1);
