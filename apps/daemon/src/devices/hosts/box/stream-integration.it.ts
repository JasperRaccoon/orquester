/**
 * Manual integration check of the box streaming path with a real emulator (not part of `pnpm test`;
 * see `../../README.md`). The "box" is this machine through `localBoxConnection()`: a
 * `BoxAndroidHost` prepares (hub forwarded to a loopback port, `--require-token`), a real
 * `DeviceService` leases one emulator on it for an agent's chat, and the daemon's own WebSocket
 * route (`ws-routes.ts`) with the real hub proxy (`hub-proxy.ts`) listens on a random loopback port.
 * A client opens `/ws-device/<host>/vendor/serve-emu/ws?device=<serial>&frame-meta=1` THROUGH that
 * proxy, waits for the first SEMU frame (the hub starts its capture session then), counts SEMU
 * frames for 3 s more; then one input frame (a key) must switch the lease's control
 * from the agent to the user. Release, teardown, and nothing of the root left running. Prints a
 * JSON summary with the numbers.
 *
 *   cd apps/daemon && ORQ_IT_SDK=<sdk> TSX_DISABLE_CACHE=1 node --import tsx src/devices/hosts/box/stream-integration.it.ts <root> <appDir>
 *
 * Env: `ORQ_IT_SDK=<sdk>` hard-links an SDK into `<root>/android-sdk` first; `ORQ_IT_KIND=box|byo`
 * (default box: a rented host's GPU order); `ORQ_IT_PROFILE` (default pixel-9);
 * `ORQ_IT_STREAM_MS` (default 3000).
 */

import { execFile as execFileCb } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";

import websocketPlugin from "@fastify/websocket";
import Fastify from "fastify";
import { type RawData, WebSocket } from "ws";

import { DEFAULT_DEVICES_SETTINGS, DEVICES_LEASE_EVENT, deviceProfile, deviceRoutes, type DevicesSettings } from "@orquester/api";
import type { StoredBox } from "@orquester/config";

import { isolatedDeviceBox } from "./local-namespace.ts";
import { createHubProxy } from "../../hub-proxy.ts";
import { FakeHostFactory, startTestDeviceService, type TestDeviceService } from "../../testing.ts";
import { registerDeviceWsRoutes } from "../../ws-routes.ts";
import { BoxAndroidHost } from "./android-host.ts";

const execFile = promisify(execFileCb);
const [root, appDir] = process.argv.slice(2);
if (!root || !appDir) {
  console.error("usage: stream-integration.it.ts <device root> <appDir>  (throwaway dirs)");
  process.exit(2);
}
const profile = deviceProfile(process.env.ORQ_IT_PROFILE ?? "pixel-9")!;
const kind = process.env.ORQ_IT_KIND === "byo" ? "byo" : "box";
const streamMs = Number(process.env.ORQ_IT_STREAM_MS ?? 3_000);
const TOKEN = "stream-it-token";
const SEMU_MAGIC = 0x53454d55;

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
const summary: Record<string, unknown> = { timings, kind, profile: profile.id };

await mkdir(root, { recursive: true });
await mkdir(appDir, { recursive: true });
if (process.env.ORQ_IT_SDK) {
  await execFile("cp", ["-al", process.env.ORQ_IT_SDK, join(root, "android-sdk")]).catch((error) => log("SDK copy:", String(error)));
}

const connection = isolatedDeviceBox({ root, boxId: "it-stream-box", provider: kind === "box" ? "blacksmith" : "byo" });
const settings: DevicesSettings = { ...DEFAULT_DEVICES_SETTINGS, android: { ...DEFAULT_DEVICES_SETTINGS.android, enabled: true, profiles: [profile.id], maxLocalDevices: 2 } };
const record = {
  id: "it-stream-box",
  purpose: kind === "box" ? "device-host" : "machine",
  kind: "linux",
  provider: kind === "box" ? "blacksmith" : "byo",
  region: "it",
  size: "it",
  name: "orq-it-stream-box",
  os: "linux",
  createdAt: new Date().toISOString(),
  state: "ready"
} as StoredBox;
let factory: FakeHostFactory | null = null;
const host = new BoxAndroidHost({
  boxId: "it-stream-box",
  kind,
  label: "IT Linux stream host",
  appDir,
  record: () => record,
  connection: () => connection,
  settings: () => settings,
  activeLeases: () => factory?.ctx?.activeLeases(host.id) ?? [],
  logger
});

/** One stream's tally. */
interface Tally {
  messages: number;
  semu: number;
  semuV1: number;
  semuV2: number;
  keyframes: number;
  bytes: number;
  text: string[];
  firstMessageMs: number | null;
  firstFrameMs: number | null;
}

function tallyMessage(tally: Tally, data: RawData, isBinary: boolean, openedAt: number): void {
  tally.messages += 1;
  tally.firstMessageMs ??= Date.now() - openedAt;
  const buffer = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
  if (!isBinary) {
    if (tally.text.length < 5) tally.text.push(buffer.toString("utf8").slice(0, 200));
    return;
  }
  tally.bytes += buffer.byteLength;
  if (buffer.byteLength > 16 && buffer.readUInt32BE(0) === SEMU_MAGIC) {
    tally.semu += 1;
    const version = buffer.readUInt8(4);
    if (version === 1) tally.semuV1 += 1;
    if (version === 2) tally.semuV2 += 1;
    if ((buffer.readUInt8(5) & 1) !== 0) tally.keyframes += 1;
    tally.firstFrameMs ??= Date.now() - openedAt;
  }
}

let svc: TestDeviceService | null = null;
let app: ReturnType<typeof Fastify> | null = null;
let client: WebSocket | null = null;
let failed = false;
const signal = AbortSignal.timeout(30 * 60_000);
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
  log("host:", host.state(), "cache:", host.cacheState());

  // The daemon's side: a real service with this host, the real proxy behind the real WebSocket route.
  factory = new FakeHostFactory(kind, ["android"], [host]);
  svc = await startTestDeviceService({ factories: [factory], settings: settings as unknown as Record<string, unknown> });
  const service = svc.service;
  const proxy = createHubProxy({
    leaseOnDevice: (hostId, deviceParam) => service.leaseOnDevice(hostId, deviceParam),
    userInput: (hostId, deviceParam) => service.userInput(hostId, deviceParam),
    viewerActive: (leaseId) => service.viewerActive(leaseId),
    viewersChanged: (hostId, deviceParam, count) => service.streamViewers(hostId, deviceParam, count),
    logger
  });
  app = Fastify();
  await app.register(websocketPlugin);
  await registerDeviceWsRoutes(app, { authorize: (token) => token === TOKEN, devices: () => service, hubProxy: () => proxy });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  log(`proxy listening on 127.0.0.1:${port}`);

  const lease = await timed("open lease (boot from orq-golden)", () =>
    service.openLease({ threadId: "it-chat", platform: "android", profile: profile.id, hostId: host.id, fresh: true, openedBy: "agent", rentalApproved: false }, signal)
  );
  if (lease.state !== "ready" || !lease.stream || lease.stream.kind !== "serve-emu") throw new Error(`the lease is not streamable: ${JSON.stringify(lease)}`);
  summary.lease = { state: lease.state, controller: lease.controller, deviceId: lease.deviceId, stream: lease.stream, screen: lease.screen };
  log("lease:", summary.lease);

  // Through the proxy: the daemon's route, never the hub's port or token.
  const url = `ws://127.0.0.1:${port}${deviceRoutes.socket(host.id, "vendor/serve-emu/ws")}?device=${encodeURIComponent(lease.stream.deviceParam)}&frame-meta=1&token=${TOKEN}`;
  const tally: Tally = { messages: 0, semu: 0, semuV1: 0, semuV2: 0, keyframes: 0, bytes: 0, text: [], firstMessageMs: null, firstFrameMs: null };
  const openedAt = Date.now();
  client = new WebSocket(url);
  const socket = client;
  const closed = new Promise<{ code: number; reason: string }>((resolve) => socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));
  socket.on("message", (data, isBinary) => tallyMessage(tally, data, isBinary, openedAt));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
    void closed.then((result) => reject(new Error(`the proxy closed the stream: ${result.code} ${result.reason}`)));
  });
  log(`stream open after ${Date.now() - openedAt} ms`);
  // The hub starts a capture session (scrcpy) on the first viewer: the first frame takes seconds.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no SEMU frame arrived through the proxy within 30 s")), 30_000);
    const check = () => {
      if (tally.semu === 0) return;
      clearTimeout(timer);
      socket.off("message", check);
      resolve();
    };
    socket.on("message", check);
  });
  log(`first SEMU frame after ${tally.firstFrameMs} ms; watching for ${streamMs} ms`);
  const atStart = { ...tally, text: [...tally.text] };
  await new Promise((resolve) => setTimeout(resolve, streamMs));
  const frames = tally.semu - atStart.semu;
  const bytes = tally.bytes - atStart.bytes;
  summary.stream = {
    firstMessageMs: tally.firstMessageMs,
    firstFrameMs: tally.firstFrameMs,
    windowMs: streamMs,
    windowFrames: frames,
    windowKeyframes: tally.keyframes - atStart.keyframes,
    windowBytes: bytes,
    fps: Math.round((frames / (streamMs / 1000)) * 10) / 10,
    kbps: Math.round((bytes * 8) / streamMs),
    total: { messages: tally.messages, semu: tally.semu, semuV1: tally.semuV1, semuV2: tally.semuV2, keyframes: tally.keyframes, bytes: tally.bytes, text: tally.text }
  };
  log("stream:", summary.stream);
  if (frames === 0) throw new Error(`no SEMU frame arrived through the proxy in the ${streamMs} ms window`);

  // Watching never changes control; one input frame does.
  const before = service.lease(lease.id)?.controller;
  const switched = svc.nextEvent((type, payload) => {
    const changed = (payload as { lease?: { id?: string; controller?: string } }).lease;
    return type === DEVICES_LEASE_EVENT && changed?.id === lease.id && changed.controller === "user";
  });
  const sentAt = Date.now();
  socket.send(JSON.stringify({ type: "key", keycode: 3 }));
  await Promise.race([switched, new Promise((_, reject) => setTimeout(() => reject(new Error("control did not switch to the user within 10 s")), 10_000))]);
  summary.control = { before, after: service.lease(lease.id)?.controller, switchMs: Date.now() - sentAt };
  log("control:", summary.control);
  if (before !== "agent" || service.lease(lease.id)?.controller !== "user") throw new Error(`control went ${before} → ${service.lease(lease.id)?.controller}`);

  socket.close(1000, "done");
  summary.close = await closed;
  await timed("release", () => service.releaseLease(lease.id, "agent", { shutdown: true }));
} catch (error) {
  failed = true;
  summary.error = error instanceof Error ? error.message : String(error);
  log("FAILED:", summary.error);
} finally {
  client?.terminate();
  if (app) {
    for (const socket of app.websocketServer.clients) socket.terminate();
    await app.close().catch(() => undefined);
  }
  if (svc) {
    await svc.service.releaseAll("plugin-off").catch((error) => log("release all failed:", String(error)));
    await svc.cleanup().catch((error) => log("service stop failed:", String(error)));
  }
  await timed("teardown", () => host.teardown()).catch((error) => log("teardown failed:", String(error)));
}

// Emulators, the hub, agent-device's daemon and adb started under the root (not this script or its shell).
const left = await execFile("pgrep", ["-af", root]).then(
  (result) => result.stdout.trim().split("\n").filter((line) => line && /qemu-system|hub-launcher|agent-device|platform-tools\/adb/.test(line) && !line.startsWith(`${process.pid} `)),
  () => [] as string[]
);
summary.leftRunning = left;
summary.ok = !failed && left.length === 0;
await mkdir(join(root, "logs"), { recursive: true });
await writeFile(join(root, "logs", "stream-it-summary.json"), `${JSON.stringify(summary, null, 2)}\n`).catch(() => undefined);
console.log(`IT-SUMMARY ${JSON.stringify(summary)}`);
process.exit(summary.ok ? 0 : 1);
