import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";

import { DEVICE_ACTION_KINDS, type DeviceActionInput } from "@orquester/api";
import type { StoredDeviceLease } from "@orquester/config";

import { createDeviceActionExecutor, homePackageOf, planAction, renderSettle, renderSnapshot, resolvePoint, shellQuote, swipePoints, type PlanContext } from "./actions.ts";
import { parseAgentDeviceJson, type AgentDeviceClient, type AgentDeviceResult } from "./agent-device.ts";
import { isDeviceError } from "./errors.ts";
import { FakeDeviceHost } from "./testing.ts";

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const signal = new AbortController().signal;

function fixtureData(name: string): Record<string, unknown> {
  const json = JSON.parse(readFileSync(new URL(`./fixtures/agent-device/${name}.json`, import.meta.url), "utf8")) as { data: Record<string, unknown> };
  return json.data;
}

function result(name: string): AgentDeviceResult {
  const stdout = readFileSync(new URL(`./fixtures/agent-device/${name}.json`, import.meta.url), "utf8");
  const json = parseAgentDeviceJson(stdout) as { success: boolean };
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

const android: PlanContext = { platform: "android", deviceId: "emulator-5554", unitsPerPoint: 2, screen: { width: 360, height: 640 } };
const ios: PlanContext = { platform: "ios", deviceId: "UDID-1", unitsPerPoint: 1, screen: { width: 402, height: 874 } };

/** One input per action kind, as `validateDeviceActionInput` accepts it. */
const SAMPLES: Record<string, DeviceActionInput> = {
  snapshot: { action: "snapshot" },
  tap: { action: "tap", ref: "@e3" },
  long_press: { action: "long_press", x: 100, y: 200, durationMs: 800 },
  fill: { action: "fill", ref: "@e5", text: "hello" },
  type: { action: "type", text: "--abc" },
  press: { action: "press", key: "back" },
  swipe: { action: "swipe", direction: "up" },
  scroll: { action: "scroll", direction: "down" },
  open_app: { action: "open_app", app: "com.example" },
  close_app: { action: "close_app", app: "com.example" },
  open_url: { action: "open_url", url: "https://example.com/a?b=1&c='x'" },
  screenshot: { action: "screenshot" },
  logs: { action: "logs", seconds: 5 },
  rotate: { action: "rotate", orientation: "landscape" },
  appearance: { action: "appearance", appearance: "dark" },
  location: { action: "location", lat: 37.77, lon: -122.42 },
  permissions: { action: "permissions", app: "com.example", permission: "Camera", grant: "revoke" },
  wait: { action: "wait", text: "Done", timeoutMs: 3000 }
};

test("the mapping table: every action kind on Android and iOS", () => {
  assert.deepEqual(Object.keys(SAMPLES).sort(), [...DEVICE_ACTION_KINDS].sort());
  const table = (ctx: PlanContext) => Object.fromEntries(Object.entries(SAMPLES).map(([kind, input]) => [kind, planAction(input, ctx)]));
  assert.deepEqual(table(android), {
    snapshot: { via: "special", kind: "snapshot" },
    tap: { via: "agent-device", command: "click", args: ["@e3", "--settle"] },
    long_press: { via: "agent-device", command: "longpress", args: ["200", "400", "800", "--settle"] },
    fill: { via: "agent-device", command: "fill", args: ["@e5", "--text-stdin", "--settle"], stdin: "hello" },
    type: { via: "agent-device", command: "type", args: ["--", "--abc"] },
    press: { via: "agent-device", command: "back", args: ["--settle"] },
    swipe: { via: "agent-device", command: "swipe", args: ["360", "896", "360", "384"] },
    scroll: { via: "agent-device", command: "scroll", args: ["down", "--settle"] },
    open_app: { via: "agent-device", command: "open", args: ["com.example"], timeoutMs: 150_000 },
    close_app: { via: "host", tool: "adb", calls: [["-s", "emulator-5554", "shell", "am force-stop 'com.example'"]] },
    open_url: { via: "host", tool: "adb", calls: [["-s", "emulator-5554", "shell", `am start -a android.intent.action.VIEW -d 'https://example.com/a?b=1&c='\\''x'\\'''`]] },
    screenshot: { via: "special", kind: "screenshot" },
    logs: { via: "special", kind: "logs" },
    rotate: { via: "special", kind: "rotate-emulator" },
    appearance: { via: "agent-device", command: "settings", args: ["appearance", "dark"] },
    location: { via: "agent-device", command: "settings", args: ["location", "set", "37.77", "-122.42"] },
    permissions: { via: "agent-device", command: "settings", args: ["permission", "deny", "camera", "--app", "com.example"] },
    wait: { via: "agent-device", command: "wait", args: ["--", "text", "Done", "3000"], timeoutMs: 23_000 }
  });
  const onIos = table(ios);
  assert.deepEqual(onIos.long_press, { via: "agent-device", command: "longpress", args: ["100", "200", "800", "--settle"] });
  assert.deepEqual(onIos.swipe, { via: "agent-device", command: "swipe", args: ["201", "612", "201", "262"] });
  assert.deepEqual(onIos.close_app, { via: "host", tool: "simctl", calls: [["terminate", "UDID-1", "com.example"]] });
  assert.deepEqual(onIos.open_url, { via: "host", tool: "simctl", calls: [["openurl", "UDID-1", "https://example.com/a?b=1&c='x'"]] });
  assert.deepEqual(onIos.rotate, { via: "agent-device", command: "orientation", args: ["landscape-left"] });
  // Keys.
  const press = (key: DeviceActionInput["key"], ctx = android) => planAction({ action: "press", key }, ctx);
  assert.deepEqual(press("home"), { via: "agent-device", command: "home", args: [] });
  assert.deepEqual(press("enter"), { via: "agent-device", command: "keyboard", args: ["enter"] });
  assert.deepEqual(press("app_switch"), { via: "agent-device", command: "app-switcher", args: [] });
  assert.deepEqual(press("volume_down"), { via: "agent-device", command: "hardware-button", args: ["volume-down"] });
  assert.deepEqual(press("lock"), { via: "agent-device", command: "hardware-button", args: ["sleep"] });
  assert.throws(() => press("lock", ios), (error: unknown) => isDeviceError(error) && error.code === "INVALID_ARGUMENT");
  // A physical Android device rotates through agent-device; a wait on a ref; refusals.
  assert.deepEqual(planAction({ action: "rotate", orientation: "portrait" }, { ...android, deviceId: "R58M123" }), { via: "agent-device", command: "orientation", args: ["portrait"] });
  assert.deepEqual(planAction({ action: "wait", ref: "@e9" }, android), { via: "agent-device", command: "wait", args: ["@e9", "10000"], timeoutMs: 30_000 });
  assert.throws(() => planAction({ action: "permissions", app: "a", permission: "teleport", grant: "grant" }, android), /Unknown permission/);
  assert.throws(() => planAction({ action: "open_url", url: "not a url" }, android), /spaces|full URL/);
  assert.throws(() => planAction({ action: "swipe", direction: "up" }, { ...android, screen: null }), /snapshot first/);
  assert.equal(shellQuote("a'b"), `'a'\\''b'`);
  assert.deepEqual(swipePoints("left", { width: 100, height: 200 }), { from: { x: 80, y: 100 }, to: { x: 20, y: 100 } });
});

test("snapshots render as compact refs with frames in points; settle diffs as +/- lines", () => {
  const rendered = renderSnapshot(fixtureData("snapshot-noopen"), 2);
  assert.equal(rendered.count, 13);
  const lines = rendered.text.split("\n");
  assert.equal(lines[0], "Snapshot: 13 elements");
  assert.equal(lines[2], '@e2 [viewpager] "At a glance"');
  assert.ok(lines.includes('@e8 [text] "Chrome"'));
  // 720×1280 pixels at 2×: the Google search bar's frame in dp.
  assert.deepEqual(rendered.refs.e1, { x: 0, y: 0, width: 360, height: 640 });

  const fill = renderSettle(fixtureData("fill-settle"))!;
  assert.match(fill, /^Screen changed \(\+7 −15\)/);
  assert.ok(fill.includes('+ @e2 [group] "orq"'));
  assert.ok(fill.includes('- @e2 [group] "Sticker Keyboard"'));
  assert.match(renderSettle(fixtureData("click-settle"))!, /did not settle/);
  assert.equal(renderSettle(fixtureData("swipe")), null);
});

test("ref → point: agent-device's tap point (pixels → points), else the ref's frame centre from the last snapshot", () => {
  const refs = { e10: { x: 20, y: 550, width: 320, height: 30 } };
  assert.deepEqual(resolvePoint({ ref: "@e10" }, fixtureData("click-settle"), refs, 2), { x: 180, y: 567 });
  assert.deepEqual(resolvePoint({ ref: "@e10" }, {}, refs, 2), { x: 180, y: 565 });
  assert.equal(resolvePoint({ ref: "@e99" }, {}, refs, 2), undefined);
  assert.deepEqual(resolvePoint({ x: 10, y: 20 }, {}, refs, 2), { x: 10, y: 20 });
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
  assert.equal(snap.log.summary, "Read the screen (13 elements)");
  assert.match(snap.text!, /@e10 \[group\] "Google search"/);

  const tap = await executor.execute(ctx, { action: "tap", ref: "@e10" }, signal);
  assert.deepEqual(tap.log, { summary: "Tapped @e10 “Google search”", point: { x: 180, y: 567 }, target: "@e10 Google search" });
  assert.match(tap.text!, /did not settle/);

  const fill = await executor.execute(ctx, { action: "fill", ref: "@e64", text: "hello orq" }, signal);
  assert.equal(fill.log.summary, "Filled @e64 “Search web and more” with 9 characters");
  assert.deepEqual(agent.calls.at(-1), { command: "fill", args: ["@e64", "--text-stdin", "--settle"], stdin: "hello orq" });
  assert.match(fill.text!, /Screen changed/);
});

test("execute: a lost session is reopened on the foreground app and the action retried once; iOS opens one first", async () => {
  let homes = 0;
  const agent = new ScriptedAgentDevice((command) => {
    if (command === "home") return homes++ === 0 ? result("home3") : ok({ action: "home", message: "Home" });
    return ok({ message: "Opened" });
  });
  const executor = createDeviceActionExecutor({ agentDevice: agent, logger: quiet });
  const pressed = await executor.execute({ host: new FakeDeviceHost(), lease: lease() }, { action: "press", key: "home" }, signal);
  assert.equal(pressed.log.summary, "Pressed home");
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
  assert.equal((await executor.execute(ctx, { action: "close_app", app: "com.example" }, signal)).log.summary, "Closed com.example");
  const logs = await executor.execute(ctx, { action: "logs", seconds: 5 }, signal);
  assert.equal(logs.text, "10-27 05:32:22.522 I/A ( 1741): hello");
  assert.deepEqual(host.runs.find((run) => run.args.includes("logcat"))!.args, ["-s", "emulator-5554", "logcat", "-d", "-v", "time", "-t", "995.000"]);
  await executor.execute(ctx, { action: "rotate", orientation: "landscape" }, signal);
  assert.deepEqual(host.runs.at(-1)!.args, ["-s", "emulator-5554", "emu", "sensor", "set", "acceleration", "9.81:0:0"]);
  const failed = await executor.execute(ctx, { action: "open_url", url: "myapp://x" }, signal).catch((error: unknown) => error);
  assert.ok(isDeviceError(failed) && /Activity not started/.test(failed.message), String(failed));
});

/** A 1×1 RGB PNG. */
function tinyPng(): Buffer {
  const chunk = (type: string, body: Buffer) => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, "latin1");
    body.copy(out, 8);
    return out;
  };
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0]))), chunk("IEND", Buffer.alloc(0))]);
}

test("execute: a screenshot comes back as an image; a host that drives devices itself answers first", async () => {
  const agent = new ScriptedAgentDevice(async (command, args) => {
    if (command === "screenshot") {
      await writeFile(args[0]!, tinyPng());
      return ok({ path: args[0], width: 1, height: 1 });
    }
    return ok();
  });
  const executor = createDeviceActionExecutor({ agentDevice: agent, logger: quiet });
  const host = new FakeDeviceHost();
  const shot = await executor.execute({ host, lease: lease() }, { action: "screenshot" }, signal);
  assert.equal(shot.image?.mimeType, "image/png");
  assert.deepEqual([shot.image?.width, shot.image?.height], [1, 1]);
  assert.equal(shot.log.summary, "Took a screenshot");

  // performAction: an outcome wins (its refs kept for a later ref tap); null falls through to agent-device.
  host.performAction = async (_lease, action) =>
    action.action === "snapshot" ? { text: "own tree", refs: { e1: { x: 10, y: 10, width: 20, height: 20 } } } : action.action === "tap" ? null : { summary: "Did it" };
  const own = await executor.execute({ host, lease: lease() }, { action: "snapshot" }, signal);
  assert.deepEqual(own, { log: { summary: "Read the screen" }, text: "own tree" });
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
  assert.deepEqual(ios, { appId: "com.example.ios", summary: "installed /host/Demo.app.tar" });
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

  const foreign = createDeviceActionExecutor({ agentDevice: { run: async () => inUse("someone-else") }, logger: quiet });
  const refused = await foreign.execute({ host: new FakeDeviceHost(), lease: lease() }, { action: "snapshot" }, signal).catch((error: unknown) => error);
  assert.ok(isDeviceError(refused) && refused.code === "DEVICE_BUSY");
});

test("restartApp: the app in front is relaunched; the home screen is refused (Android asks the launcher, iOS knows SpringBoard)", async () => {
  // Android: appstate (fixture: the Pixel launcher in front) against the resolved HOME package.
  assert.equal(homePackageOf("priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\ncom.google.android.apps.nexuslauncher/.NexusLauncherActivity\n"), "com.google.android.apps.nexuslauncher");
  assert.equal(homePackageOf("No activity found\n"), null);
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
