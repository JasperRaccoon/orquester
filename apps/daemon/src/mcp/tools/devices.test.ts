/**
 * The device tools (devices spec §9) through the executor, over a real `DeviceService` with fake
 * hosts: chat-only schemas, the principal forced onto the calling chat, per-call tiers, the
 * conditional `devices` spend card (only when a rental needs approval, pinned into the open), the
 * quick start and `deviceRef` in results, screenshots as image blocks, and refusals passing through.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DEVICE_TOOL_REFERENCE_KEY, readDeviceToolReference } from "@orquester/api";

import { runDeviceTool, type DeviceCallOptions, type DeviceToolsPort } from "../../devices/tools-port.ts";
import { FakeDeviceHost, FakeHostFactory, startTestDeviceService, type TestDeviceService } from "../../devices/testing.ts";
import { FakeApprovalPort } from "../catalog/approval-double.ts";
import type { ApprovalPort, ThreadCaller } from "../catalog/contract.ts";
import { audienceSchema, executeToolCall } from "../executor.ts";
import { FakeDaemonApi } from "../testing.ts";
import { deviceQuickStart, devicesFamily } from "./devices.ts";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "mcp-devices-")));
const PROJECT = join(ROOT, "acme", "app");
mkdirSync(join(PROJECT, "build"), { recursive: true });
writeFileSync(join(PROJECT, "build", "app.apk"), "apk");
test.after(() => rmSync(ROOT, { recursive: true, force: true }));

/** A `DaemonApi` whose device methods reach `port` the way `InjectDaemonApi` does; it records the principals. */
function apiFor(port: DeviceToolsPort | null): { api: FakeDaemonApi; principals: (string | undefined)[] } {
  const api = new FakeDaemonApi();
  api.fsRoot = api.workspacesDir = ROOT;
  const principals: (string | undefined)[] = [];
  const run = <T>(opts: DeviceCallOptions | undefined, fn: Parameters<typeof runDeviceTool<T>>[2]) => {
    principals.push(opts?.principal?.kind === "agent" ? opts.principal.threadId : opts?.principal?.kind);
    return runDeviceTool(port, opts, fn);
  };
  Object.assign(api, {
    devicesList: (opts?: DeviceCallOptions) => run(opts, (p, id) => p.toolList(id)),
    devicesPlanOpen: (platform: "ios" | "android", opts?: DeviceCallOptions) => run(opts, (p, id) => p.toolPlanOpen(id, platform)),
    deviceOpen: (input: Parameters<DeviceToolsPort["toolOpen"]>[1], opts?: DeviceCallOptions) => run(opts, (p, id, signal) => p.toolOpen(id, input, signal)),
    deviceAction: (device: string | undefined, input: Parameters<DeviceToolsPort["toolAction"]>[2], opts?: DeviceCallOptions) =>
      run(opts, (p, id, signal) => p.toolAction(id, device, input, signal)),
    deviceInstall: (input: Parameters<DeviceToolsPort["toolInstall"]>[1], opts?: DeviceCallOptions) => run(opts, (p, id, signal) => p.toolInstall(id, input, signal)),
    deviceClose: (input: Parameters<DeviceToolsPort["toolClose"]>[1], opts?: DeviceCallOptions) => run(opts, (p, id) => p.toolClose(id, input))
  });
  return { api, principals };
}

function chat(over: Partial<ThreadCaller> = {}): ThreadCaller {
  return {
    kind: "thread", threadId: "me", title: "App", projectPath: PROJECT, workspace: "acme", cwd: PROJECT, agentId: "claude", callId: "c1",
    runtimeMode: "full-access", planning: false, workflowOwned: false, exchange: null, ...over
  };
}

type Outcome = { ok: true; value: Record<string, unknown>; result: CallToolResult } | { ok: false; code: string; message: string };

async function call(api: FakeDaemonApi, name: string, args: Record<string, unknown>, opts: { caller?: ThreadCaller | { kind: "external" }; port?: ApprovalPort } = {}): Promise<Outcome> {
  const result = await executeToolCall(
    { approvals: opts.port ?? new FakeApprovalPort() },
    { name, arguments: args },
    { caller: opts.caller ?? chat(), api, signal: new AbortController().signal }
  );
  const content = result.structuredContent as Record<string, unknown>;
  return result.isError ? { ok: false, code: content.code as string, message: content.message as string } : { ok: true, value: content, result };
}

async function androidService(): Promise<TestDeviceService> {
  return startTestDeviceService({
    factories: [new FakeHostFactory("local", ["android"], [new FakeDeviceHost()])],
    settings: { android: { enabled: true } },
    deps: { threadProject: () => PROJECT }
  });
}

test("the device tools are chat-only; schemas refuse bad and unknown arguments", async () => {
  const { api } = apiFor(null);
  for (const tool of devicesFamily) {
    const external = await call(api, tool.name, {}, { caller: { kind: "external" } });
    assert.ok(!external.ok && external.code === "TOOL_NOT_FOUND", tool.name);
  }
  const schema = (name: string) => audienceSchema(devicesFamily.find((tool) => tool.name === name)!, "chat");
  assert.ok(schema("open_device").safeParse({ platform: "android", profile: "pixel-fold", app: "com.example.app" }).success);
  assert.ok(!schema("open_device").safeParse({ platform: "windows" }).success);
  assert.ok(!schema("open_device").safeParse({ platform: "ios", profile: "galaxy-s99" }).success);
  assert.ok(!schema("open_device").safeParse({ platform: "ios", app: "rm -rf /" }).success);
  assert.ok(!schema("open_device").safeParse({ platform: "ios", threadId: "other" }).success, "unknown keys are refused");
  assert.ok(schema("device_action").safeParse({ action: "tap", ref: "@e7" }).success);
  assert.ok(schema("device_action").safeParse({ action: "swipe", from: { x: 1, y: 2 }, to: { x: 3, y: 400 } }).success);
  assert.ok(!schema("device_action").safeParse({ action: "explode" }).success);
  assert.ok(!schema("device_action").safeParse({ action: "logs", seconds: 61 }).success);
  assert.ok(!schema("device_action").safeParse({ action: "tap", ref: "e7; rm" }).success);
  assert.ok(!schema("device_action").safeParse({ action: "press", key: "power" }).success);
});

test("plugin off: every tool answers DEVICES_DISABLED", async () => {
  const { api } = apiFor(null);
  const listed = await call(api, "list_devices", {});
  assert.ok(!listed.ok && listed.code === "DEVICES_DISABLED");
  const bare = new FakeDaemonApi();
  const noBackend = await call(bare, "close_device", {});
  assert.ok(!noBackend.ok && noBackend.code === "DEVICES_DISABLED");
});

test("open → act → screenshot → install → close, acting for the calling chat only", async () => {
  const t = await androidService();
  try {
    const { api, principals } = apiFor(t.service);
    const opened = await call(api, "open_device", { platform: "android" });
    assert.ok(opened.ok, JSON.stringify(opened));
    assert.equal(opened.value.device, "local/dev-1");
    assert.equal(opened.value.ready, true);
    const quickStart = String(opened.value.quick_start);
    assert.ok(quickStart.split("\n").length <= 6);
    for (const needle of [/snapshot/, /@eN refs/, /\.apk/, /Device panel/]) assert.match(quickStart, needle);
    // The reference names the device, so a reloaded (slimmed) row still reads "Opened Pixel 9".
    assert.deepEqual(readDeviceToolReference(opened.value[DEVICE_TOOL_REFERENCE_KEY]), { device: "local/dev-1", leaseId: opened.value.lease_id, name: "Pixel 9" });
    assert.ok(principals.every((who) => who === "me"));

    const tapped = await call(api, "device_action", { action: "tap", ref: "e3" });
    assert.ok(tapped.ok);
    assert.equal(t.actions.calls.at(-1)!.input.ref, "@e3");
    assert.equal(tapped.value.summary, "did tap");
    assert.deepEqual(readDeviceToolReference(tapped.value[DEVICE_TOOL_REFERENCE_KEY]), {
      device: "local/dev-1",
      leaseId: opened.value.lease_id,
      name: "Pixel 9",
      action: "tap",
      summary: "did tap"
    });
    // A summary that would not survive the reader (a line break, too long) is made one line and clipped.
    t.actions.result = () => ({ log: { summary: `Tapped @e3 “${"x".repeat(300)}”\nsecond line` } });
    const long = await call(api, "device_action", { action: "tap", ref: "e3" });
    assert.ok(long.ok);
    const longRef = readDeviceToolReference(long.value[DEVICE_TOOL_REFERENCE_KEY]);
    assert.equal(longRef?.action, "tap");
    assert.equal([...(longRef?.summary ?? "")].length, 200);
    assert.ok(longRef?.summary?.endsWith("…"));

    t.actions.result = () => ({ log: { summary: "Took a screenshot" }, image: { mimeType: "image/png", data: Buffer.from("png"), width: 2, height: 4 } });
    const shot = await call(api, "device_action", { device: "local/dev-1", action: "screenshot" });
    assert.ok(shot.ok);
    assert.deepEqual(shot.result.content[0], { type: "image", data: Buffer.from("png").toString("base64"), mimeType: "image/png" });
    assert.deepEqual(JSON.parse((shot.result.content[1] as { text: string }).text), shot.value);
    const ref = readDeviceToolReference(shot.value[DEVICE_TOOL_REFERENCE_KEY]);
    assert.ok(ref?.screenshotId);
    assert.equal(ref?.action, "screenshot");
    assert.equal(ref?.name, "Pixel 9");

    const installed = await call(api, "device_install", { path: "build/app.apk" });
    assert.ok(installed.ok, JSON.stringify(installed));
    assert.equal(installed.value.app, "com.example.app");
    assert.deepEqual(t.actions.installs, [join(PROJECT, "build", "app.apk")]);
    assert.equal(readDeviceToolReference(installed.value[DEVICE_TOOL_REFERENCE_KEY])?.name, "Pixel 9");

    // Another chat cannot touch it.
    const stranger = await call(api, "device_action", { device: "local/dev-1", action: "snapshot" }, { caller: chat({ threadId: "other" }) });
    assert.ok(!stranger.ok && stranger.code === "DEVICE_NOT_LEASED");

    // The user takes over: input is refused, a read still works.
    t.service.userInput("local", "dev-1");
    const refused = await call(api, "device_action", { action: "tap", x: 1, y: 2 });
    assert.ok(!refused.ok && refused.code === "DEVICE_CONTROLLED_BY_USER");
    assert.match(refused.message, /give control back/);
    t.actions.result = (input) => ({ log: { summary: `did ${input.action}` }, text: "tree" });
    const read = await call(api, "device_action", { action: "snapshot" });
    assert.ok(read.ok);
    assert.match(String(read.value.note), /user has control/);

    const closed = await call(api, "close_device", { shutdown: true });
    assert.ok(closed.ok);
    assert.equal(closed.value.closed, true);
    assert.equal(readDeviceToolReference(closed.value[DEVICE_TOOL_REFERENCE_KEY])?.name, "Pixel 9");
    const listed = await call(api, "list_devices", {});
    assert.ok(listed.ok);
    assert.deepEqual(listed.value.my_devices, []);
    // Errors name the next call.
    const gone = await call(api, "device_action", { action: "snapshot" });
    assert.ok(!gone.ok && gone.code === "DEVICE_NOT_LEASED");
    assert.match(gone.message, /open_device/);
  } finally {
    await t.cleanup();
  }
});

test("open_device: a rental the owner did not pre-approve raises a devices spend card, and the approval reaches the open", async () => {
  const factory = new FakeHostFactory("box", ["ios"], [], () => new FakeDeviceHost("box:m1", "box", ["ios"], "Mac host"));
  factory.quote = { platform: "ios", provider: "blacksmith", providerLabel: "Blacksmith", size: "6vcpu", sizeLabel: "6 vCPU macOS", hourlyUsd: 4.8, lifetimeMinutes: 240, needsApproval: true };
  const t = await startTestDeviceService({ factories: [factory], settings: { ios: { enabled: true } } });
  try {
    const { api } = apiFor(t.service);
    const port = new FakeApprovalPort();
    const opened = await call(api, "open_device", { platform: "ios" }, { port });
    assert.ok(opened.ok, JSON.stringify(opened));
    assert.equal(port.cards.length, 1);
    assert.equal(port.cards[0]!.kind, "spend");
    assert.equal(port.cards[0]!.family, "devices");
    assert.deepEqual(port.cards[0]!.grantOptions, []);
    assert.deepEqual(factory.provisioned, [{ platform: "ios", approved: true }]);

    // A host with room now: no card for the next one.
    const again = await call(api, "open_device", { platform: "ios" }, { port, caller: chat({ threadId: "second" }) });
    assert.ok(again.ok, JSON.stringify(again));
    assert.equal(port.cards.length, 1);

    // The host is full (capacity 2): a third device needs another rental. Denied: nothing is rented.
    factory.provisioned.length = 0;
    const denyPort = new FakeApprovalPort({ outcome: "denied", approvalId: "", reason: "too pricey" });
    const third = await call(api, "open_device", { platform: "ios" }, { port: denyPort, caller: chat({ threadId: "third" }) });
    assert.ok(!third.ok && third.code === "APPROVAL_DENIED", JSON.stringify(third));
    assert.equal(denyPort.cards.length, 1);
    assert.deepEqual(factory.provisioned, []);
  } finally {
    await t.cleanup();
  }
});

test("open_device while planning: no spend card can be raised", async () => {
  const factory = new FakeHostFactory("box", ["ios"], [], () => new FakeDeviceHost("box:m1", "box", ["ios"], "Mac host"));
  factory.quote = { platform: "ios", provider: "blacksmith", providerLabel: "Blacksmith", size: "s", sizeLabel: "S", hourlyUsd: 1, lifetimeMinutes: 60, needsApproval: true };
  const t = await startTestDeviceService({ factories: [factory], settings: { ios: { enabled: true } } });
  try {
    const { api } = apiFor(t.service);
    const planning = await call(api, "open_device", { platform: "ios" }, { caller: chat({ planning: true }) });
    assert.ok(!planning.ok && planning.code === "PERMISSION_DENIED");
    assert.deepEqual(factory.provisioned, []);
  } finally {
    await t.cleanup();
  }
});

test("the quick start is per platform, at most six lines and 1 KiB, and says what the spikes found", () => {
  for (const platform of ["ios", "android"] as const) {
    const text = deviceQuickStart(platform);
    assert.ok(text.split("\n").length <= 6, platform);
    assert.ok(Buffer.byteLength(text) <= 1024, `${platform}: ${Buffer.byteLength(text)} bytes`);
    // Refs first, they expire after open, screenshots are images, the build path, and the handoff.
    for (const needle of [/@eN refs/, /Prefer refs/, /refs expire/, /open_app, open_url or rotate/, /returns an image/, /device_install \{path\}/, /in this project/, /Device panel/, /DEVICE_CONTROLLED_BY_USER/, /wait, or ask/]) {
      assert.match(text, needle, `${platform}: ${needle}`);
    }
  }
  const ios = deviceQuickStart("ios");
  // iOS: an app session before the first snapshot.
  assert.ok(ios.indexOf("open_app") < ios.indexOf("snapshot"));
  assert.match(ios, /simulator \.app/);
  assert.match(ios, /bundle id/);
  assert.doesNotMatch(ios, /\.apk/);
  assert.match(deviceQuickStart("android"), /\.apk/);
  assert.match(deviceQuickStart("android"), /package/);
});
