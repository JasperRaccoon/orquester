import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { type DeviceActionInput } from "@orquester/api";
import type { StoredDeviceLease } from "@orquester/config";

import { createDeviceActionExecutor } from "./actions.ts";
import { type AgentDeviceClient, type AgentDeviceResult } from "./agent-device.ts";
import { isDeviceError } from "./errors.ts";
import { FakeDeviceHost, solidPng } from "./testing.ts";

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const signal = new AbortController().signal;

function result(name: string): AgentDeviceResult {
  const stdout = readFileSync(new URL(`./fixtures/agent-device/${name}.json`, import.meta.url), "utf8");
  const json = JSON.parse(stdout) as { success: boolean };
  return { exitCode: json.success ? 0 : 1, stdout, stderr: "", json };
}

const ok = (data: Record<string, unknown> = {}): AgentDeviceResult => ({ exitCode: 0, stdout: "", stderr: "", json: { success: true, data } });

function lease(overrides: Partial<StoredDeviceLease> = {}): StoredDeviceLease {
  return {
    id: "lease-1",
    threadId: "thread-1",
    hostId: "local",
    deviceId: "emulator-5554",
    platform: "android",
    profile: "pixel-9",
    name: "Pixel 9",
    osVersion: "Android 15",
    state: "ready",
    controller: "agent",
    openedBy: "agent",
    screen: { width: 360, height: 640, scale: 2 },
    createdAt: "2026-10-27T00:00:00.000Z",
    lastUsedAt: "2026-10-27T00:00:00.000Z",
    ...overrides
  };
}

test("actions reach the pinned agent-device protocol with platform coordinates and private text on stdin", async () => {
  const cases: [DeviceActionInput, string, string[], string?][] = [
    [{ action: "long_press", x: 100, y: 200, durationMs: 800 }, "longpress", ["200", "400", "800", "--settle"]],
    [{ action: "type", text: "--abc" }, "batch", ["--steps-file", "/dev/stdin"], JSON.stringify([{ command: "type", input: { text: "--abc" } }])],
    [{ action: "press", key: "enter" }, "keyboard", ["enter"]],
    [{ action: "press", key: "app_switch" }, "app-switcher", []],
    [{ action: "press", key: "volume_down" }, "hardware-button", ["volume-down"]],
    [{ action: "press", key: "lock" }, "hardware-button", ["sleep"]],
    [{ action: "swipe", from: { x: 10, y: 20 }, to: { x: 30, y: 40 } }, "swipe", ["20", "40", "60", "80"]],
    [{ action: "scroll", direction: "down" }, "scroll", ["down", "--settle"]],
    [{ action: "open_app", app: "com.example" }, "open", ["com.example"]],
    [{ action: "appearance", appearance: "dark" }, "settings", ["appearance", "dark"]],
    [{ action: "location", lat: 37.77, lon: -122.42 }, "settings", ["location", "set", "37.77", "-122.42"]],
    [{ action: "permissions", app: "com.example", permission: "Camera", grant: "revoke" }, "settings", ["permission", "deny", "camera", "--app", "com.example"]],
    [{ action: "wait", text: "Done", timeoutMs: 3000 }, "batch", ["--steps-file", "/dev/stdin"], JSON.stringify([{ command: "wait", input: { text: "Done", timeoutMs: 3000 } }])],
    [{ action: "wait", ref: "@e9" }, "wait", ["@e9", "10000"]]
  ];
  const agent = new ScriptedAgentDevice(() => ok());
  const executor = createDeviceActionExecutor({ agentDevice: agent, logger: quiet });
  const ctx = { host: new FakeDeviceHost(), lease: lease() };
  for (const [input, command, args, stdin] of cases) {
    await executor.execute(ctx, input, signal);
    assert.deepEqual(agent.calls.at(-1), { command, args, ...(stdin !== undefined ? { stdin } : {}) }, input.action);
  }
  const ios = { host: new FakeDeviceHost("box:mac", "box", ["ios"]), lease: lease({ id: "ios", platform: "ios", deviceId: "UDID-1", screen: { width: 402, height: 874, scale: 3 } }) };
  await executor.execute(ios, { action: "long_press", x: 100, y: 200, durationMs: 800 }, signal);
  assert.deepEqual(agent.calls.at(-1), { command: "longpress", args: ["100", "200", "800", "--settle"] });
  await executor.execute(ios, { action: "rotate", orientation: "landscape" }, signal);
  assert.deepEqual(agent.calls.at(-1), { command: "orientation", args: ["landscape-left"] });
  await assert.rejects(executor.execute(ios, { action: "press", key: "lock" }, signal), (error: unknown) => isDeviceError(error) && error.code === "INVALID_ARGUMENT");
});

/** An agent-device client that answers per command from a script and records the calls. */
class ScriptedAgentDevice implements AgentDeviceClient {
  calls: { command: string; args: string[]; stdin?: string }[] = [];
  constructor(private readonly answer: (command: string, args: readonly string[], index: number) => AgentDeviceResult | Promise<AgentDeviceResult>) {}
  async run(_target: unknown, command: string, args: readonly string[], options: { stdin?: string }): Promise<AgentDeviceResult> {
    this.calls.push({ command, args: [...args], ...(options.stdin !== undefined ? { stdin: options.stdin } : {}) });
    return this.answer(command, args, this.calls.length - 1);
  }
}

test("execute: snapshot keeps refs; a ref tap logs its point, target and diff; fill keeps its text out of argv", async () => {
  const agent = new ScriptedAgentDevice((command) => {
    if (command === "snapshot") return result("snapshot-noopen");
    if (command === "click") return result("click-settle");
    if (command === "fill") return result("fill-settle");
    return ok();
  });
  const executor = createDeviceActionExecutor({ agentDevice: agent, logger: quiet });
  const ctx = { host: new FakeDeviceHost(), lease: lease() };
  const snap = await executor.execute(ctx, { action: "snapshot" }, signal);
  assert.ok(snap.text!.includes("@e2") && snap.text!.includes("At a glance"));
  assert.match(snap.text!, /@e10 \[group\] "Google search"/);

  const tap = await executor.execute(ctx, { action: "tap", ref: "@e10" }, signal);
  assert.deepEqual(tap.log.point, { x: 180, y: 567 });
  assert.equal(tap.log.target, "@e10 Google search");
  assert.match(tap.text!, /did not settle/);
  const recordedSnapshot = result("snapshot-noopen");
  const fallbackAgent = new ScriptedAgentDevice((command) => command === "snapshot" ? recordedSnapshot : ok());
  const fallback = createDeviceActionExecutor({ agentDevice: fallbackAgent, logger: quiet });
  await fallback.execute(ctx, { action: "snapshot" }, signal);
  const fallbackTap = await fallback.execute(ctx, { action: "tap", ref: "@e10" }, signal);
  const selected = (recordedSnapshot.json as { data: { nodes: { ref: string; rect: { x: number; y: number; width: number; height: number } }[] } }).data.nodes.find((node) => node.ref === "e10")!;
  const point = fallbackTap.log.point;
  assert.ok(point, "a ref tap keeps a point for the selected element even without provider coordinates");
  const scale = ctx.lease.screen!.scale;
  assert.ok(point.x * scale >= selected.rect.x && point.x * scale <= selected.rect.x + selected.rect.width);
  assert.ok(point.y * scale >= selected.rect.y && point.y * scale <= selected.rect.y + selected.rect.height);
  assert.equal(fallbackTap.log.target, "@e10");
  assert.deepEqual(fallbackAgent.calls.at(-1), { command: "click", args: ["@e10", "--settle"] });

  const fill = await executor.execute(ctx, { action: "fill", ref: "@e64", text: "hello orq" }, signal);
  assert.ok(!JSON.stringify(fill.log).includes("hello orq"), "typed text must not enter action history");
  assert.deepEqual(agent.calls.at(-1), { command: "fill", args: ["@e64", "--text-stdin", "--settle"], stdin: "hello orq" });
  assert.ok(fill.text!.includes('+ @e2 [group] "orq"'));
  assert.ok(fill.text!.includes('- @e2 [group] "Sticker Keyboard"'));
});

test("execute: a lost session is reopened on the foreground app and the action retried once; iOS opens one first", async () => {
  let homes = 0;
  const agent = new ScriptedAgentDevice((command) => {
    if (command === "home") return homes++ === 0 ? result("home3") : ok({ action: "home", message: "Home" });
    return ok({ message: "Opened" });
  });
  const executor = createDeviceActionExecutor({ agentDevice: agent, logger: quiet });
  const pressed = await executor.execute({ host: new FakeDeviceHost(), lease: lease() }, { action: "press", key: "home" }, signal);
  assert.ok(pressed.log.summary.length > 0);
  assert.deepEqual(
    agent.calls.map((call) => [call.command, ...call.args].join(" ")),
    ["home", "open", "home"]
  );

  const iosAgent = new ScriptedAgentDevice((command, args) => (command === "open" && args[0] === "--foreground" ? result("err-cmd") : ok({ nodes: [] })));
  const iosExecutor = createDeviceActionExecutor({ agentDevice: iosAgent, logger: quiet });
  const iosLease = lease({ platform: "ios", deviceId: "UDID-1", screen: { width: 402, height: 874, scale: 3 } });
  await iosExecutor.execute({ host: new FakeDeviceHost("box:mac", "box", ["ios"]), lease: iosLease }, { action: "snapshot" }, signal);
  await iosExecutor.execute({ host: new FakeDeviceHost("box:mac", "box", ["ios"]), lease: iosLease }, { action: "snapshot" }, signal);
  assert.deepEqual(
    iosAgent.calls.map((call) => [call.command, ...call.args].join(" ")),
    ["open --foreground", "open com.apple.springboard", "snapshot -i", "snapshot -i"]
  );
});

test("execute: input that leaves the session's app (agent-device's Android guard) succeeded: the session ends and the next action reopens one", async () => {
  let clicks = 0;
  const agent = new ScriptedAgentDevice((command) => {
    if (command === "click") return clicks++ === 0 ? result("click-escaped") : ok({ x: 360, y: 600 });
    if (command === "close") return ok({ message: "Closed" });
    // After the close, the first call finds no session (`home3`); `open` starts one.
    if (command === "snapshot" && !agent.calls.some((call) => call.command === "open")) return result("home3");
    return ok({ nodes: [] });
  });
  const executor = createDeviceActionExecutor({ agentDevice: agent, logger: quiet });
  const ctx = { host: new FakeDeviceHost(), lease: lease() };
  const tapped = await executor.execute(ctx, { action: "tap", x: 180, y: 300 }, signal);
  assert.deepEqual(tapped.log.point, { x: 180, y: 300 });
  for (const context of ["com.google.android.apps.nexuslauncher", "com.android.settings", "snapshot"]) assert.ok(tapped.text!.includes(context));
  // Not the bare `close <app>`: the app keeps running.
  assert.deepEqual(agent.calls.map((call) => [call.command, ...call.args].join(" ")), ["click 360 600 --settle", "close"]);

  await executor.execute(ctx, { action: "snapshot" }, signal);
  assert.deepEqual(agent.calls.slice(2).map((call) => [call.command, ...call.args].join(" ")), ["snapshot -i", "open", "snapshot -i"]);

  // A permission dialog over the app is still an error.
  const dialog: AgentDeviceResult = {
    exitCode: 1,
    stdout: "",
    stderr: "",
    json: { success: false, error: { code: "COMMAND_FAILED", message: "press 1 opened an Android permission dialog", details: { expectedPackage: "com.example", foregroundPackage: "com.google.android.permissioncontroller", permissionDialog: true } } }
  };
  const blocked = createDeviceActionExecutor({ agentDevice: new ScriptedAgentDevice(() => dialog), logger: quiet });
  const refused = await blocked.execute({ host: new FakeDeviceHost(), lease: lease() }, { action: "tap", x: 1, y: 2 }, signal).catch((error: unknown) => error);
  assert.ok(isDeviceError(refused) && refused.code === "UNAVAILABLE");
});

test("execute: host-tool actions (close_app, open_url, logs, emulator rotation) run through DeviceHost.run", async () => {
  const host = new FakeDeviceHost();
  host.runImpl = async (_tool, args) => {
    if (args.includes("date")) return { exitCode: 0, stdout: "1000\r\n", stderr: "" };
    if (args.includes("logcat")) return { exitCode: 0, stdout: "--------- beginning of main\n10-27 05:32:22.522 I/A ( 1741): hello\n", stderr: "" };
    if (args.includes("wm")) return { exitCode: 0, stdout: "Physical size: 720x1280\n", stderr: "" };
    if (args.some((arg) => arg.startsWith("am start"))) return { exitCode: 0, stdout: "Starting: Intent {}\nError: Activity not started, unable to resolve Intent\n", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const executor = createDeviceActionExecutor({ agentDevice: new ScriptedAgentDevice(() => ok()), logger: quiet });
  const ctx = { host, lease: lease() };
  await executor.execute(ctx, { action: "close_app", app: "com.example" }, signal);
  assert.deepEqual(host.runs.at(-1)!.args, ["-s", "emulator-5554", "shell", "am force-stop 'com.example'"]);
  const logs = await executor.execute(ctx, { action: "logs", seconds: 5 }, signal);
  assert.equal(logs.text, "10-27 05:32:22.522 I/A ( 1741): hello");
  assert.deepEqual(host.runs.find((run) => run.args.includes("logcat"))!.args, ["-s", "emulator-5554", "logcat", "-d", "-v", "time", "-t", "995.000"]);
  await executor.execute(ctx, { action: "rotate", orientation: "landscape" }, signal);
  assert.deepEqual(host.runs.at(-1)!.args, ["-s", "emulator-5554", "emu", "sensor", "set", "acceleration", "9.81:0:0"]);
  const mac = new FakeDeviceHost("box:mac", "box", ["ios"]);
  mac.runImpl = async () => ({ exitCode: 0, stdout: "", stderr: "" });
  const ios = { host: mac, lease: lease({ platform: "ios", deviceId: "UDID-1" }) };
  await executor.execute(ios, { action: "close_app", app: "com.example" }, signal);
  await executor.execute(ios, { action: "open_url", url: "myapp://x" }, signal);
  assert.deepEqual(mac.runs.map((run) => run.args), [["terminate", "UDID-1", "com.example"], ["openurl", "UDID-1", "myapp://x"]]);
  const failed = await executor.execute(ctx, { action: "open_url", url: "myapp://x" }, signal).catch((error: unknown) => error);
  assert.ok(isDeviceError(failed) && /Activity not started/.test(failed.message), String(failed));
});

const SCREENSHOT = solidPng(1, 1, [255, 0, 0, 255]);

test("execute: a screenshot comes back as an image; a host that drives devices itself answers first", async () => {
  const agent = new ScriptedAgentDevice(async (command, args) => {
    if (command === "screenshot") {
      await writeFile(args[0]!, SCREENSHOT);
      return ok({ path: args[0], width: 1, height: 1 });
    }
    return ok();
  });
  const executor = createDeviceActionExecutor({ agentDevice: agent, logger: quiet });
  const host = new FakeDeviceHost();
  const shot = await executor.execute({ host, lease: lease() }, { action: "screenshot" }, signal);
  assert.equal(shot.image?.mimeType, "image/png");
  assert.deepEqual([shot.image?.width, shot.image?.height], [1, 1]);
  assert.deepEqual(shot.image!.data, SCREENSHOT);

  // performAction: an outcome wins (its refs kept for a later ref tap); null falls through to agent-device.
  host.performAction = async (_lease, action) =>
    action.action === "snapshot" ? { text: "own tree", refs: { e1: { x: 10, y: 10, width: 20, height: 20 } } } : action.action === "tap" ? null : { summary: "Did it" };
  const own = await executor.execute({ host, lease: lease() }, { action: "snapshot" }, signal);
  assert.equal(own.text, "own tree");
  const before = agent.calls.length;
  const tap = await executor.execute({ host, lease: lease() }, { action: "tap", ref: "@e1" }, signal);
  assert.equal(agent.calls.length, before + 1);
  assert.deepEqual(tap.log.point, { x: 20, y: 20 });
});

test("install: a build streams to the host, then the host's installApp or agent-device install; the wrong kind of build is refused", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orq-install-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "app.apk"), Buffer.alloc(1000, 1));
  await mkdir(join(dir, "Demo.app"));
  await writeFile(join(dir, "Demo.app", "Info.plist"), "<plist/>");
  const agent = new ScriptedAgentDevice((command) => (command === "install" ? ok({ appId: "com.example.demo" }) : ok()));
  const executor = createDeviceActionExecutor({ agentDevice: agent, logger: quiet });
  const host = new FakeDeviceHost();

  const installed = await executor.install({ host, lease: lease() }, join(dir, "app.apk"), signal);
  assert.equal(installed.appId, "com.example.demo");
  assert.deepEqual(host.uploads, [{ name: "app.apk", bytes: 1000 }]);
  assert.deepEqual(agent.calls.at(-1), { command: "install", args: ["/host/app.apk"] });

  const refused = await executor.install({ host, lease: lease() }, join(dir, "Demo.app"), signal).catch((error: unknown) => error);
  assert.ok(isDeviceError(refused) && refused.code === "INVALID_ARGUMENT");

  const mac = new FakeDeviceHost("box:mac", "box", ["ios"]);
  mac.installApp = async (_lease, path) => ({ appId: "com.example.ios", summary: `installed ${path}` });
  const ios = await executor.install({ host: mac, lease: lease({ platform: "ios", deviceId: "UDID-1" }) }, join(dir, "Demo.app"), signal);
  assert.equal(ios.appId, "com.example.ios");
  assert.equal(mac.uploads[0]!.name, "Demo.app.tar");
  assert.ok(mac.uploads[0]!.bytes >= 1024, "a tar archive");
});

test("end: the agent-device session of a used lease is closed once; an unused one needs nothing", async () => {
  const agent = new ScriptedAgentDevice(() => ok({ nodes: [] }));
  const executor = createDeviceActionExecutor({ agentDevice: agent, logger: quiet });
  const ctx = { host: new FakeDeviceHost(), lease: lease() };
  await executor.end!({ host: ctx.host, lease: lease({ id: "unused" }) });
  assert.equal(agent.calls.length, 0);
  await executor.execute(ctx, { action: "snapshot" }, signal);
  await executor.end!(ctx);
  await executor.end!(ctx);
  assert.deepEqual(agent.calls.map((call) => call.command), ["snapshot", "close"]);
});

test("a stale Orquester session holding the device is closed and the call retried; anyone else's is left alone", async () => {
  const inUse = (session: string): AgentDeviceResult => ({
    exitCode: 1,
    stdout: "",
    stderr: "",
    json: { success: false, error: { code: "DEVICE_IN_USE", message: `Device is already in use by session "${session}".`, details: { session, deviceId: "emulator-5554" } } }
  });
  const sessions: (string | undefined)[] = [];
  let first = true;
  const agent: AgentDeviceClient = {
    async run(_target, command, _args, options) {
      sessions.push(options.session);
      if (command === "snapshot" && first) {
        first = false;
        return inUse("orq-00000000000000aa");
      }
      return ok({ nodes: [] });
    }
  };
  const executor = createDeviceActionExecutor({ agentDevice: agent, logger: quiet });
  await executor.execute({ host: new FakeDeviceHost(), lease: lease() }, { action: "snapshot" }, signal);
  assert.deepEqual(sessions, [undefined, "orq-00000000000000aa", undefined]);

  const foreignCommands: string[] = [];
  const foreign = createDeviceActionExecutor({ agentDevice: { run: async (_target, command) => { foreignCommands.push(command); return inUse("someone-else"); } }, logger: quiet });
  const refused = await foreign.execute({ host: new FakeDeviceHost(), lease: lease() }, { action: "snapshot" }, signal).catch((error: unknown) => error);
  assert.ok(isDeviceError(refused) && refused.code === "DEVICE_BUSY");
  assert.deepEqual(foreignCommands, ["snapshot"], "another caller's session cannot be closed");
});

test("restartApp: the app in front is relaunched; the home screen is refused (Android asks the launcher, iOS knows SpringBoard)", async () => {
  // Android: appstate (fixture: the Pixel launcher in front) against the resolved HOME package.
  const host = new FakeDeviceHost();
  host.runImpl = async () => ({ exitCode: 0, stdout: "priority=0\ncom.google.android.apps.nexuslauncher/.NexusLauncherActivity\n", stderr: "" });
  let front = "launcher";
  const agent = new ScriptedAgentDevice((command) => {
    if (command === "appstate") return front === "launcher" ? result("appstate") : ok({ platform: "android", package: "com.example.app", activity: "com.example.app.Main" });
    return ok({ message: "Opened" });
  });
  const executor = createDeviceActionExecutor({ agentDevice: agent, logger: quiet });
  const refused = await executor.restartApp!({ host, lease: lease() }, signal).catch((error: unknown) => error);
  assert.ok(isDeviceError(refused) && refused.code === "INVALID_ARGUMENT" && /home screen/.test(refused.message), String(refused));
  assert.ok(!agent.calls.some((call) => call.command === "open"), "nothing relaunched");
  front = "app";
  assert.deepEqual(await executor.restartApp!({ host, lease: lease() }, signal), { appId: "com.example.app" });
  assert.deepEqual(agent.calls.at(-1), { command: "open", args: ["com.example.app", "--relaunch"] });
  assert.deepEqual(host.runs.at(-1)!.args, ["-s", "emulator-5554", "shell", "cmd", "package", "resolve-activity", "--brief", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.HOME"]);

  // iOS: the session is bound to the foreground app first (appstate answers per session).
  let iosFront = "com.apple.springboard";
  const iosAgent = new ScriptedAgentDevice((command) => (command === "open" ? ok({ appBundleId: iosFront }) : ok()));
  const iosExecutor = createDeviceActionExecutor({ agentDevice: iosAgent, logger: quiet });
  const iosCtx = { host: new FakeDeviceHost("box:mac", "box", ["ios"]), lease: lease({ platform: "ios", deviceId: "UDID-1" }) };
  const home = await iosExecutor.restartApp!(iosCtx, signal).catch((error: unknown) => error);
  assert.ok(isDeviceError(home) && home.code === "INVALID_ARGUMENT", String(home));
  iosFront = "com.example.ios";
  assert.deepEqual(await iosExecutor.restartApp!(iosCtx, signal), { appId: "com.example.ios" });
  assert.deepEqual(
    iosAgent.calls.map((call) => [call.command, ...call.args].join(" ")),
    ["open --foreground", "open --foreground", "open com.example.ios --relaunch"]
  );
});
