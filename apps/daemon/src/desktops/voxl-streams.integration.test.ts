import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import websocketPlugin from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import { desktopRoutes, type DesktopSummary } from "@orquester/api";
import { desktopRuntimeDir, desktopsIndexPath, desktopsRuntimeDir } from "@orquester/config";
import { Tmux, tmuxAvailable, tmuxVersionOk } from "../tmux.ts";
import type { DesktopAudioHub } from "./audio.ts";
import { desktopSessionName } from "./host-env.ts";
import { DesktopHostProbe, resolveTool } from "./host-status.ts";
import { DesktopManager } from "./manager.ts";
import { VoxlProbe } from "./voxl.ts";
import { registerDesktopWsRoutes } from "./ws-routes.ts";

// A real desktop (Xvnc, Openbox) with `video: voxl` and a real voxl, in a temp appdir on a throwaway
// `tmux -S` server — never the daemon's: a viewer through the relay starts voxl, gets its `hello`
// and a key frame; switching to RFB stops voxl; stopping the desktop leaves nothing behind.
// voxl: ORQUESTER_VOXL_BIN, else the spike's build at /tmp/voxl-spike/voxl, else the host's.

const SPIKE_VOXL = "/tmp/voxl-spike/voxl";
const REQUIRED = ["Xvnc", "openbox", "dbus-daemon", "tmux"];
const missing = REQUIRED.filter((tool) => resolveTool(tool) === null);
const voxlEnv: NodeJS.ProcessEnv = {
  ORQUESTER_VOXL_BIN: process.env.ORQUESTER_VOXL_BIN ?? (existsSync(SPIKE_VOXL) ? SPIKE_VOXL : undefined)
};

const TOKEN = "it-token";
let skipReason: string | null =
  missing.length > 0 ? `missing ${missing.join(", ")}` : !tmuxAvailable() || !tmuxVersionOk() ? "tmux ≥ 3.2 unavailable" : null;

let appdir = "";
let tmuxSocket = "";
let manager: DesktopManager;
let app: FastifyInstance;
let relayPort = 0;
let desktopId = "";
const groups = new Set<number>();

function until(predicate: (summary: DesktopSummary) => boolean, timeoutMs = 20_000): Promise<DesktopSummary> {
  const current = manager.get(desktopId);
  if (current && predicate(current)) return Promise.resolve(current);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      manager.off("updated", listener);
      reject(new Error("timed out waiting for the desktop"));
    }, timeoutMs);
    const listener = (summary: DesktopSummary) => {
      if (summary.id !== desktopId || !predicate(summary)) return;
      clearTimeout(timer);
      manager.off("updated", listener);
      resolve(summary);
    };
    manager.on("updated", listener);
  });
}

/** Live (non-zombie) processes of the process groups in `pgids`. */
async function liveMembers(pgids: Set<number>): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = await readFile(`/proc/${entry}/stat`, "utf8").catch(() => "");
    const close = stat.lastIndexOf(")");
    if (close < 0) continue;
    const [state, , pgrp] = stat.slice(close + 2).split(" ");
    if (pgids.has(Number(pgrp)) && state !== "Z") found.push(`${entry} ${stat.slice(0, close + 1)}`);
  }
  return found;
}

before(async () => {
  if (skipReason) return;
  const voxl = await new VoxlProbe({ baseDir: "/nonexistent", env: () => voxlEnv }).status();
  if (!voxl.available) {
    skipReason = `voxl unavailable: ${voxl.reason ?? "not found"}`;
    return;
  }
  appdir = await realpath(await mkdtemp(join(tmpdir(), "orq-voxl-it-")));
  tmuxSocket = join(appdir, "tmux.sock");
  await mkdir(desktopsRuntimeDir(appdir), { recursive: true, mode: 0o700 });
  await mkdir(join(appdir, "proj"), { recursive: true });
  const probe = new DesktopHostProbe();
  const voxlProbe = new VoxlProbe({ baseDir: appdir, env: () => voxlEnv });
  manager = new DesktopManager({
    baseDir: appdir,
    indexFile: desktopsIndexPath(appdir),
    tmux: new Tmux(tmuxSocket),
    hostStatus: () => probe.status(),
    voxlStatus: () => voxlProbe.status(),
    logger: { warn: () => {}, error: (...args: unknown[]) => console.error(...args) }
  });
  await manager.load();
  await manager.reattach();
  app = Fastify();
  await app.register(websocketPlugin);
  await registerDesktopWsRoutes(app, {
    authorize: (token) => token === TOKEN,
    vncSocketPath: () => null,
    audioSource: () => null,
    audio: {} as DesktopAudioHub,
    voxlUpstream: (id) => manager.voxlUpstream(id)
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  relayPort = (app.server.address() as AddressInfo).port;
});

after(async () => {
  if (skipReason) return;
  for (const client of app?.websocketServer?.clients ?? []) client.terminate();
  await app?.close();
  await manager?.shutdown();
  await new Promise<void>((resolve) => execFile("tmux", ["-S", tmuxSocket, "kill-server"], () => resolve()));
  for (const pgid of groups) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  await rm(appdir, { recursive: true, force: true });
});

test("a voxl desktop: a viewer through the relay gets hello and a key frame; RFB stops voxl; stop leaves nothing", { skip: skipReason ?? false }, async (t) => {
  if (skipReason) {
    t.skip(skipReason);
    return;
  }
  const created = await manager.create({ projectPath: join(appdir, "proj"), projectRealPath: join(appdir, "proj"), size: { width: 1024, height: 768 } });
  desktopId = created.id;
  assert.equal(created.status, "running", created.error);
  assert.equal(created.video, "voxl", "the host's voxl makes voxl the default");
  await until((d) => d.voxl?.state === "ready");
  const tmux = new Tmux(tmuxSocket);
  const session = desktopSessionName(desktopId);
  for (const window of await tmux.listServiceWindows(session)) groups.add(window.panePid);
  assert.ok(!(await tmux.listServiceWindows(session)).some((window) => window.name === "voxl"), "no voxl before a viewer");

  const client = new WebSocket(`ws://127.0.0.1:${relayPort}${desktopRoutes.voxlSocket(desktopId)}?token=${TOKEN}`);
  const got = await new Promise<{ hello: Record<string, unknown>; keyframe: Buffer }>((resolve, reject) => {
    let hello: Record<string, unknown> | null = null;
    const timer = setTimeout(() => reject(new Error("no hello and key frame from voxl")), 20_000);
    client.on("open", () => client.send("v,1"));
    client.on("message", (data: Buffer, binary: boolean) => {
      if (!binary) {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        if (message.t === "hello") hello = message;
        if (message.t === "ping") client.send(`po,${String(message.s)}`);
        return;
      }
      // A video frame: type 0x01, flags (bit 0: key frame), frame number at 2..6.
      if (data[0] === 0x01) client.send(`a,${data.readUInt32BE(2)}`);
      if (hello && data[0] === 0x01 && (data[1]! & 1) === 1) {
        clearTimeout(timer);
        resolve({ hello, keyframe: Buffer.from(data) });
      }
    });
    client.once("close", (code, reason) => reject(new Error(`relay closed ${code} ${reason.toString()}`)));
  });
  assert.equal(got.hello.w, 1024);
  assert.equal(got.hello.h, 768);
  assert.ok(got.keyframe.length > 16);
  const voxlWindow = (await tmux.listServiceWindows(session)).find((window) => window.name === "voxl");
  assert.ok(voxlWindow, "voxl runs as the session's voxl window");
  groups.add(voxlWindow.panePid);
  const dir = desktopRuntimeDir(appdir, desktopId);
  const log = await readFile(join(dir, "voxl.log"), "utf8");
  const password = /^VOXL_PASSWORD='([0-9a-f]+)'$/m.exec(await readFile(join(dir, "voxl.env"), "utf8"))![1]!;
  assert.ok(!log.includes(password), "voxl never logs its password");
  const cmdline = await readFile(`/proc/${voxlWindow.panePid}/cmdline`, "utf8").catch(() => "");
  assert.ok(!cmdline.includes(password), "nor is it in an argv");

  // Switching to RFB stops voxl (the viewer's relay closes); the desktop runs on.
  const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
  const switched = await manager.update(desktopId, { video: "rfb" });
  await closed;
  assert.equal(switched.status, "running");
  assert.equal(switched.video, "rfb");
  assert.ok(!(await tmux.listServiceWindows(session)).some((window) => window.name === "voxl"));
  assert.deepEqual(await liveMembers(new Set([voxlWindow.panePid])), [], "voxl is gone");

  const stopped = await manager.stop(desktopId);
  assert.equal(stopped.status, "stopped");
  assert.deepEqual(await liveMembers(groups), []);
});
