import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";

import { deviceProfile, VPHONE_RESEARCH_NOTICE, type DevicesVphoneHostSettings } from "@orquester/api";
import type { StoredDeviceLease } from "@orquester/config";

import { isDeviceError } from "../../errors.ts";
import { deviceHostSummary, type DeviceHostProgress } from "../../host.ts";
import { VphoneDeviceHost } from "./host.ts";
import { FakeMacLink, FIXTURE_JPEG, startFakeVphoned, VPHONE_CLI_PATH, type FakeMacOptions } from "./testing.ts";

const dirs: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups) await cleanup();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const RPC = {
  "device.screen": { width: 1206, height: 2622, scale: 3 },
  "ui.tree": { count: 1, elements: [{ label: "About", identifier: "", role: "button", value: "", enabled: true, clickable: true, frame: { x: 20, y: 380, width: 390, height: 52 } }] },
  "screen.screenshot": { mime_type: "image/jpeg", width: 1290, height: 2796, data: FIXTURE_JPEG.toString("base64") },
  "apps.install": (params: Record<string, unknown>) => ({ bundle_id: "com.example.app", path: params.path, msg: "Installed com.example.app as a User app." }),
  "input.tap": {}
};

function lease(id: string, deviceId: string | null): StoredDeviceLease {
  return {
    id,
    threadId: "t1",
    hostId: "vphone:mac1",
    deviceId,
    platform: "ios",
    profile: "iphone-17-pro",
    name: "Research iPhone",
    osVersion: "iOS 26.1",
    state: "ready",
    controller: "agent",
    openedBy: "agent",
    createdAt: "2026-10-27T10:00:00.000Z",
    lastUsedAt: "2026-10-27T10:00:00.000Z"
  };
}

async function setup(options: FakeMacOptions = {}, settings: Partial<DevicesVphoneHostSettings> = {}, leases: StoredDeviceLease[] = [], existingDir?: string) {
  const dir = existingDir ?? (await mkdtemp(join(tmpdir(), "orq-vphone-")));
  dirs.push(dir);
  const mac = new FakeMacLink({ ...options, vphoned: { rpc: RPC, unhealthyFirst: 2, ...options.vphoned } });
  const logs: string[] = [];
  const record = (...args: unknown[]) => void logs.push(args.map(String).join(" "));
  const host = new VphoneDeviceHost({
    boxId: "mac1",
    machineName: "Studio Mac",
    link: () => mac,
    box: () => ({ boxId: "mac1", provider: "byo", hourlyUsd: 0, startedAt: "2026-10-27T09:00:00.000Z", deadlineAt: null }),
    settings: () => ({ enabled: true, iphoneSource: null, cloudosSource: null, ...settings }),
    activeLeases: () => leases,
    stateDir: join(dir, "state"),
    uploadsDir: join(dir, "uploads"),
    logger: { info: record, warn: record, error: record },
    timing: { healthIntervalMs: 5, healthTimeoutMs: 10_000, launchTimeoutMs: 10_000 }
  });
  cleanups.push(() => host.dispose(), () => mac.close());
  await host.start();
  await host.refreshReadiness();
  return { host, mac, logs, dir };
}

const cliCalls = (mac: FakeMacLink, from = 0) => mac.execs.slice(from).filter((exec) => exec.command === VPHONE_CLI_PATH).map((exec) => exec.args.join(" "));

test("a ready Mac: the summary carries the research notice; a lease clones, launches, forwards and boots a VM", async () => {
  const { host, mac, logs } = await setup();
  assert.equal(host.state().status, "ready");
  const summary = deviceHostSummary(host);
  assert.equal(summary.kind, "byo");
  assert.equal(summary.research, true);
  assert.equal(summary.notice, VPHONE_RESEARCH_NOTICE);
  assert.deepEqual(summary.capacity, { used: 0, total: 2 });
  assert.equal(host.streamCapabilities().iosH264, true);
  assert.ok(host.hubOrigin()?.startsWith("http://127.0.0.1:"));

  const before = mac.execs.length;
  const progress: DeviceHostProgress[] = [];
  const booted = await host.boot({ leaseId: "lease1", profile: deviceProfile("iphone-17-pro")!, fresh: true }, new AbortController().signal, (step) => progress.push(step));
  assert.deepEqual(booted, {
    deviceId: "orq-lease1",
    name: "Research iPhone",
    osVersion: "iOS 26.1",
    screen: { width: 402, height: 874, scale: 3 },
    stream: { kind: "serve-sim", deviceParam: "orq-lease1" }
  });
  const calls = cliCalls(mac, before);
  assert.deepEqual(new Set(calls.slice(0, 2)), new Set(["vm template list --json", "vm list --json"]));
  assert.deepEqual(calls.slice(2), [
    "vm create orq-lease1 --template 3f2a91c0d4e7 --skip-first-boot",
    "vm launch orq-lease1 --headless --api-listen 127.0.0.1:0",
    "vm info orq-lease1 --json"
  ]);
  const launch = mac.execs.find((exec) => exec.args[1] === "launch")!;
  assert.equal(launch.detach, "vphone-orq-lease1");
  const token = launch.env?.VPHONE_API_TOKEN ?? "";
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.deepEqual(mac.forwards.map((forward) => forward.boxPort), [mac.vphoneds[0]!.port]);
  assert.deepEqual(progress.map((step) => step.step), ["clone", "launch", "boot"]);

  // The token: only in the launch's environment and the 0600 record — never argv, logs or progress.
  for (const exec of mac.execs) assert.ok(!exec.args.join(" ").includes(token));
  assert.ok(!logs.join("\n").includes(token));
  assert.ok(!JSON.stringify(progress).includes(token));
  assert.ok(!JSON.stringify(deviceHostSummary(host)).includes(token));

  assert.deepEqual((await host.listDevices()).map((device) => [device.id, device.leaseId, device.booted]), [["orq-lease1", "lease1", true]]);
});

test("agent actions and installs go to the VM's vphoned; release stops and deletes the clone", async () => {
  const { host, mac, dir } = await setup();
  const booted = await host.boot({ leaseId: "lease2", profile: deviceProfile("iphone-17-pro")!, fresh: true }, new AbortController().signal);
  const active = lease("lease2", booted.deviceId);
  const signal = new AbortController().signal;
  const vphoned = mac.vphoneds[0]!;

  const record = join(dir, "state", "orq-lease2.json");
  assert.equal((await stat(record)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(record, "utf8")).token, mac.execs.find((exec) => exec.args[1] === "launch")!.env!.VPHONE_API_TOKEN);

  const snapshot = await host.performAction(active, { action: "snapshot" }, signal);
  assert.equal(snapshot.text, '@e1 [button] "About"');
  const tap = await host.performAction(active, { action: "tap", ref: "@e1" }, signal);
  assert.deepEqual(tap.point, { x: 215, y: 406 });
  assert.deepEqual(vphoned.calls.at(-1), { method: "input.tap", params: { x: 215, y: 406 }, via: "http" });
  await assert.rejects(host.performAction(active, { action: "rotate", orientation: "landscape" }, signal), (error) => isDeviceError(error) && error.code === "INVALID_ARGUMENT");
  await assert.rejects(host.performAction(active, { action: "close_app", app: "x" }, signal), (error) => isDeviceError(error) && /refused apps\.terminate/.test(error.message));
  await assert.rejects(host.performAction(lease("other", "orq-nope"), { action: "snapshot" }, signal), (error) => isDeviceError(error) && error.code === "DEVICE_LOST");

  const ipa = Buffer.from("PK\u0003\u0004 fake ipa bytes");
  const uploaded = await host.uploadFile(Readable.from([ipa]), "My App.ipa");
  const installed = await host.installApp(active, uploaded.path, signal);
  assert.deepEqual(installed, { appId: "com.example.app", summary: "Installed com.example.app as a User app." });
  const [guestPath, bytes] = [...vphoned.uploads][0]!;
  assert.match(guestPath, /^\/private\/var\/tmp\/orq-[0-9a-f-]+\.ipa$/);
  assert.deepEqual(bytes, ipa);
  assert.deepEqual(vphoned.calls.find((call) => call.method === "apps.install")?.params, { path: guestPath });
  await assert.rejects(stat(uploaded.path));
  const app = await host.uploadFile(Readable.from([Buffer.from("tar")]), "Sim.app.tar");
  await assert.rejects(host.installApp(active, app.path, signal), (error) => isDeviceError(error) && /\.ipa/.test(error.message));
  await assert.rejects(host.installApp(active, "/etc/passwd", signal), (error) => isDeviceError(error) && error.code === "INVALID_ARGUMENT");

  const before = mac.execs.length;
  await host.release(active, { shutdown: false });
  assert.deepEqual(cliCalls(mac, before), ["vm stop orq-lease2", "vm delete orq-lease2 --force"]);
  assert.equal(mac.launches[0]!.killed, true);
  assert.ok(mac.requests.some((request) => request.method === "proc.release" && JSON.stringify(request.params) === JSON.stringify({ procId: "vphone-orq-lease2" })));
  assert.equal(mac.forwards[0]!.closed, true);
  await assert.rejects(stat(record));
  assert.deepEqual(await host.listDevices(), []);

  // Never touches machines it did not make.
  const count = mac.execs.length;
  await host.release(lease("x", "orq-base"), { shutdown: true });
  await host.release(lease("y", "my-phone"), { shutdown: true });
  assert.equal(mac.execs.length, count);
});

test("a failed clone: it is deleted, the error is readable and carries no token", async () => {
  const { host, mac } = await setup({
    answer: (command, args) => (command === VPHONE_CLI_PATH && args[1] === "create" ? { exitCode: 1, stderr: "error: template 3f2a91c0d4e7 is busy\n" } : undefined)
  });
  const before = mac.execs.length;
  await assert.rejects(host.boot({ leaseId: "lease3", profile: deviceProfile("iphone-17-pro")!, fresh: true }, new AbortController().signal), (error) => {
    assert.ok(isDeviceError(error));
    assert.match(error.message, /template 3f2a91c0d4e7 is busy/);
    return true;
  });
  assert.ok(cliCalls(mac, before).includes("vm delete orq-lease3 --force"));
  assert.ok(!cliCalls(mac, before).some((call) => call.includes("launch")));
});

test("not ready: boot refuses with the failing check; ensureReady names every fix", async () => {
  const { host, mac } = await setup({ answer: (command) => (command === "/usr/bin/csrutil" ? { stdout: "Allow Research Guests status: disabled.\n" } : undefined) });
  assert.equal(host.state().status, "needs-setup");
  await assert.rejects(host.boot({ leaseId: "l", profile: deviceProfile("iphone-17-pro")!, fresh: true }, new AbortController().signal), (error) => isDeviceError(error) && error.code === "PLATFORM_NOT_READY");
  await assert.rejects(host.ensureReady(new AbortController().signal, () => undefined), (error) => isDeviceError(error) && /csrutil allow-research-guests enable/.test(error.message));
  mac.setConnected(false);
  assert.equal(host.state().status, "unreachable");
});

test("the template setup job runs vphone-cli through sudo -n and turns stage banners into progress", async () => {
  let built = false;
  const { host, mac } = await setup(
    {
      sys: { canElevate: true },
      answer: (command, args) => {
        if (command === VPHONE_CLI_PATH && args.join(" ") === "vm template list --json") {
          return { stdout: JSON.stringify({ templates: built ? [{ id: "aa11bb22", key: { summary: "new" }, stale: false }] : [] }) };
        }
        if (command === VPHONE_CLI_PATH && args.join(" ") === "vm list --json") return { stdout: "[]" };
        if (command === "/usr/bin/sudo") {
          built = true;
          return { stdout: "=== fw prepare ===\ndownloading 10%\n=== Restore phase ===\n=== CFW install (host-mount) ===\nok\n" };
        }
        return undefined;
      }
    },
    { iphoneSource: "/Users/me/iPhone17,3.ipsw", cloudosSource: "https://example.test/cloudOS.ipsw" }
  );
  assert.equal(host.readiness().checks.find((check) => check.id === "template")?.fixActionId, "vphone-template");
  const progress: DeviceHostProgress[] = [];
  await host.ensureReady(new AbortController().signal, (step) => progress.push(step), ["vphone-template"]);
  const sudo = mac.execs.find((exec) => exec.command === "/usr/bin/sudo")!;
  assert.deepEqual(sudo.args, [
    "-n",
    VPHONE_CLI_PATH,
    "vm",
    "create",
    "orq-base",
    "--iphone-source",
    "/Users/me/iPhone17,3.ipsw",
    "--cloudos-source",
    "https://example.test/cloudOS.ipsw",
    "--skip-first-boot"
  ]);
  const labels = progress.filter((step) => step.logLine?.startsWith("===")).map((step) => step.label);
  assert.deepEqual(labels, ["Preparing firmware", "Restoring iOS", "Installing the guest environment"]);
  assert.ok(progress.some((step) => step.logLine === "downloading 10%"));
  assert.equal(progress.at(-1)?.state, "done");
  assert.equal(host.readiness().ready, true);
});

test("after a restart the host reattaches to a running VM from its record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orq-vphone-"));
  const token = "a".repeat(64);
  const vphoned = await startFakeVphoned({ token, rpc: RPC });
  cleanups.push(() => vphoned.close());
  await mkdir(join(dir, "state"), { recursive: true });
  await writeFile(join(dir, "state", "orq-lease9.json"), JSON.stringify({ name: "orq-lease9", leaseId: "lease9", boxPort: vphoned.port, token, procId: "vphone-orq-lease9", osVersion: "iOS 26.1" }));
  const active = lease("lease9", "orq-lease9");
  const { host, mac } = await setup({}, {}, [active], dir);
  const attached = new Promise<void>((resolve) => {
    const check = async () => {
      if ((await host.listDevices()).some((device) => device.id === "orq-lease9" && device.booted)) resolve();
    };
    host.onChange(() => void check());
    void check();
  });
  await attached;
  assert.equal((await host.performAction(active, { action: "snapshot" }, new AbortController().signal)).text, '@e1 [button] "About"');
  assert.ok(!mac.execs.some((exec) => exec.args[1] === "launch"));
});
