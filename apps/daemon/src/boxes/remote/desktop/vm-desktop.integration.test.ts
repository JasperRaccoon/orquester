import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import type { DesktopHostStatus, DesktopSummary, DesktopWindowsPayload } from "@orquester/api";
import { desktopsIndexPath, desktopsRuntimeDir, type StoredBox } from "@orquester/config";
import { DesktopAudioHub, type DesktopAudioSink } from "../../../desktops/audio.ts";
import { DesktopHostProbe, resolveTool } from "../../../desktops/host-status.ts";
import { DesktopManager } from "../../../desktops/manager.ts";
import { Tmux, tmuxAvailable, tmuxVersionOk } from "../../../tmux.ts";
import type { BoxHub, BoxRegistry } from "../../contracts.ts";
import { localBoxConnection, type LocalBoxConnection } from "../../testing.ts";
import { BoxDesktops } from "./index.ts";
import type { BoxGuiInstaller } from "../gui/index.ts";

// A whole VM desktop, for real, through the box seam: the "box" is this machine
// (`localBoxConnection`: exec = local child processes, fs = node:fs, watches =
// fs.watch, unix channels = local sockets), so Xvnc, Openbox, the apps and the
// audio encoder run as they would in a Linux VM, reached only through
// `BoxConnection`. Its tmux is a throwaway `tmux -L` server — never the
// daemon's — and its home a temp dir. Every wait is an event with a timeout.

const REQUIRED = ["Xvnc", "openbox", "dbus-daemon", "tmux", "xterm"];
const missing = REQUIRED.filter((tool) => resolveTool(tool) === null);
const skipReason =
  missing.length > 0
    ? `missing ${missing.join(", ")}`
    : !tmuxAvailable() || !tmuxVersionOk()
      ? "tmux ≥ 3.2 unavailable"
      : null;

const BOX_ID = "vm-desktop-it";
const TMUX_SERVER = `orq-vmdesk-it-${process.pid}`;

let appdir = "";
let home = "";
let project = "";
let connection: LocalBoxConnection;
let record: { id: string; state: string; kind: string };
const registryListeners = new Set<(boxId: string) => void>();
const hubListeners = new Set<(boxId: string, connected: boolean) => void>();
let audio: DesktopAudioHub;
let manager: DesktopManager;
let desktopId = "";
/** Every process group the desktops ever had (hosts and apps): checked after close, killed in `after`. */
const groups = new Set<number>();
let hostStatus: DesktopHostStatus;

// The stack is this machine's: the installer reports it as found (the real one is tested in remote/gui).
const installer: Pick<BoxGuiInstaller, "desktopStatus" | "ensureDesktop"> = {
  desktopStatus: async () => hostStatus,
  ensureDesktop: async () => hostStatus
};

const registry: Pick<BoxRegistry, "get" | "onChange"> = {
  get: (boxId) => (boxId === BOX_ID ? (record as unknown as StoredBox) : undefined),
  onChange: (listener) => {
    registryListeners.add(listener);
    return () => registryListeners.delete(listener);
  }
};

const hub: Pick<BoxHub, "get" | "onConnectionChange"> = {
  get: (boxId) => (boxId === BOX_ID ? connection : undefined),
  onConnectionChange: (listener) => {
    hubListeners.add(listener);
    return () => hubListeners.delete(listener);
  }
};

function setLink(connected: boolean): void {
  connection.setConnected(connected);
  for (const listener of hubListeners) listener(BOX_ID, connected);
}

function makeManager(): DesktopManager {
  return new DesktopManager({
    baseDir: appdir,
    indexFile: desktopsIndexPath(appdir),
    // This machine's desktops: none here; its tmux is a throwaway server too.
    tmux: new Tmux(join(appdir, "host-tmux.sock")),
    hostStatus: async () => hostStatus,
    audio,
    boxes: new BoxDesktops({ registry, hub, installer, tmuxServer: TMUX_SERVER }),
    logger: { warn: () => {}, error: (...args: unknown[]) => console.error(...args) }
  });
}

function boxTmux(args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile("tmux", ["-L", TMUX_SERVER, ...args], (error, stdout) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? "") });
    });
  });
}

async function boxSessions(): Promise<string[]> {
  const { code, stdout } = await boxTmux(["list-sessions", "-F", "#{session_name}"]);
  return code === 0 ? stdout.split("\n").filter(Boolean) : [];
}

async function hostPanePid(id: string): Promise<number> {
  const { stdout } = await boxTmux(["list-windows", "-t", `=orqsvc-desktop-${id}`, "-F", "#{pane_pid} #{window_name}"]);
  const line = stdout.split("\n").find((entry) => entry.endsWith(" host"));
  assert.ok(line, `host window of ${id}`);
  return Number(line.split(" ")[0]);
}

function nextEvent<T>(
  emitter: DesktopManager,
  event: "updated" | "windows" | "closed",
  predicate: (payload: T) => boolean,
  timeoutMs: number
): Promise<T> {
  return new Promise((resolve, reject) => {
    const listener = (payload: T) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      emitter.off(event, listener as never);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      emitter.off(event, listener as never);
      reject(new Error(`timed out waiting for ${event}`));
    }, timeoutMs);
    emitter.on(event, listener as never);
  });
}

/** The desktop's summary once `predicate` holds: checked now, then on every update. */
async function until(
  target: DesktopManager,
  id: string,
  predicate: (summary: DesktopSummary) => boolean,
  timeoutMs = 20_000
): Promise<DesktopSummary> {
  const current = target.get(id);
  if (current && predicate(current)) return current;
  return nextEvent<DesktopSummary>(target, "updated", (summary) => summary.id === id && predicate(summary), timeoutMs);
}

/** The window `appId` owns: in the summary now, or from the next `windows` event that has it. */
async function windowOf(target: DesktopManager, id: string, appId: string): Promise<DesktopWindowsPayload["windows"][number]> {
  const find = (windows: DesktopWindowsPayload["windows"]) => windows.find((window) => window.appId === appId);
  const now = find(target.get(id)?.windows ?? []);
  if (now) return now;
  return find((await nextEvent<DesktopWindowsPayload>(target, "windows", (p) => p.desktopId === id && find(p.windows) !== undefined, 20_000)).windows)!;
}

/** Resolve once `done()` holds, re-checked on every fs.watch event in `dir` (bounded by a timeout). */
function untilInDir(dir: string, done: () => Promise<boolean>, label: string, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher.close();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error(`timed out waiting for ${label}`)), timeoutMs);
    const check = () => void done().then((ok) => ok && finish(), (error: Error) => finish(error));
    const watcher = watch(dir, { recursive: true }, check);
    check();
  });
}

function boxDir(id: string): string {
  return join(home, ".orquester", "desktops", id);
}

async function readPgid(id: string, appId: string): Promise<number> {
  return Number((await readFile(join(boxDir(id), "apps", `${appId}.pgid`), "utf8")).trim());
}

/** Live (non-zombie) processes whose process group is in `pgids`, from /proc. */
async function liveMembers(pgids: Set<number>): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let stat: string;
    try {
      stat = await readFile(`/proc/${entry}/stat`, "utf8");
    } catch {
      continue;
    }
    const close = stat.lastIndexOf(")");
    const [state, , pgrp] = stat.slice(close + 2).split(" ");
    if (pgids.has(Number(pgrp)) && state !== "Z") found.push(`${entry} ${stat.slice(0, close + 1)} ${state}`);
  }
  return found;
}

/** Read from `stream` until `bytes` bytes arrived. */
function readBytes(stream: Duplex, bytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => reject(new Error("timed out reading the RFB greeting")), 10_000);
    stream.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length >= bytes) {
        clearTimeout(timer);
        resolve(buffered.subarray(0, bytes));
      }
    });
    stream.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

before(async () => {
  if (skipReason) return;
  appdir = await realpath(await mkdtemp(join(tmpdir(), "orq-vmdesk-it-")));
  home = join(appdir, "home");
  project = join(appdir, "ws", "proj");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  await mkdir(desktopsRuntimeDir(appdir), { recursive: true, mode: 0o700 });
  hostStatus = await new DesktopHostProbe().status();
  record = { id: BOX_ID, state: "ready", kind: "linux" };
  connection = localBoxConnection({
    boxId: BOX_ID,
    sys: { os: "linux", home, tmux: true },
    watch: true,
    dropChannelsOnDisconnect: true
  });
  audio = new DesktopAudioHub({ ffmpegPath: null, stopGraceMs: 0 });
  manager = makeManager();
  await manager.load();
  await manager.reattach();
});

after(async () => {
  if (skipReason) return;
  await manager?.shutdown();
  audio?.shutdown();
  await boxTmux(["kill-server"]);
  // tmux's own `-L` socket path; a server that died without cleaning up leaves it behind.
  await rm(join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid?.() ?? 0}`, TMUX_SERVER), { force: true });
  // Belt and braces: nothing of the desktops may outlive the test run.
  for (const pgid of groups) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  await rm(appdir, { recursive: true, force: true });
});

test("1. a desktop of a Linux box project runs in the box: its dir, its scripts' copy and its session are the box's", { skip: skipReason ?? false }, async () => {
  const created = await manager.create({ projectPath: project, projectRealPath: project, title: "VM", size: { width: 1024, height: 768 }, boxId: BOX_ID });
  desktopId = created.id;
  assert.equal(created.status, "running", created.error);
  assert.deepEqual(created.box, { id: BOX_ID, connected: true });
  assert.equal(typeof created.display, "number");
  assert.ok(existsSync(join(boxDir(desktopId), "vnc.sock")), "the RFB socket is in the box user's desktop dir");
  assert.ok(existsSync(join(boxDir(desktopId), "Xauthority")));
  // Nothing of it on the daemon's side: its runtime dir stays empty, and the relay has no local path.
  assert.deepEqual(await readdir(desktopsRuntimeDir(appdir)), []);
  assert.equal(manager.vncSocketPath(desktopId), null);
  const copies = await readdir(join(home, ".orquester", "desktop-assets"));
  assert.equal(copies.length, 1);
  for (const script of ["desktop-host.sh", "app-run.sh"]) {
    assert.ok(existsSync(join(home, ".orquester", "desktop-assets", copies[0]!, script)), script);
  }
  assert.deepEqual(await boxSessions(), [`orqsvc-desktop-${desktopId}`]);
  groups.add(await hostPanePid(desktopId));
});

test("2. the RFB stream comes through the box link", { skip: skipReason ?? false }, async () => {
  assert.ok(desktopId, "needs step 1");
  const open = manager.vncStream(desktopId);
  assert.ok(open, "a running VM desktop has a VNC stream");
  const stream = await open();
  try {
    assert.match((await readBytes(stream, 12)).toString("latin1"), /^RFB 003\.00\d\n$/);
  } finally {
    stream.destroy();
  }
});

test("3. an app's window is tracked over the box link and mapped to its app; closing it exits the app", { skip: skipReason ?? false }, async () => {
  assert.ok(desktopId, "needs step 1");
  const app = await manager.launchApp(desktopId, { command: "xterm -e cat", cwd: project, env: { ORQ_IT_VALUE: "x" } });
  await until(manager, desktopId, (d) => d.apps.some((a) => a.id === app.id && a.status === "running"));
  groups.add(await readPgid(desktopId, app.id));
  const window = await windowOf(manager, desktopId, app.id);
  assert.equal(window.wmClass?.toLowerCase().includes("xterm"), true, String(window.wmClass));
  // The env file was consumed in the box.
  assert.equal(existsSync(join(boxDir(desktopId), "apps", `${app.id}.env`)), false);

  await manager.windowAction(desktopId, window.id, "close");
  const summary = await until(manager, desktopId, (d) => d.apps.some((a) => a.id === app.id && a.status === "exited"));
  assert.equal(summary.status, "running");
  assert.equal(typeof (await manager.appLog(desktopId, app.id)), "string");
});

test("4. sound: the encoder runs in the box and its Opus packets reach a subscriber", { skip: skipReason ?? false }, async (t) => {
  assert.ok(desktopId, "needs step 1");
  if (!hostStatus.audioAvailable) {
    t.skip("no PulseAudio + ffmpeg (pulse, libopus) here");
    return;
  }
  const source = manager.audioSource(desktopId);
  assert.ok(source && "pulseSocketPath" in source && source.spawn, JSON.stringify(source));
  const packet = await new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for an audio packet")), 20_000);
    const sink: DesktopAudioSink = {
      send: (data) => {
        clearTimeout(timer);
        off();
        resolve(data);
      },
      bufferedAmount: () => 0,
      sendState: () => {}
    };
    const off = audio.subscribe(desktopId, source.pulseSocketPath, sink, source.spawn);
  });
  assert.equal(packet[0], 1, "a framed Opus packet");
  audio.stopDesktop(desktopId);
});

test("5. a link drop shows as an outage; what happened meanwhile is caught up once the link is back", { skip: skipReason ?? false }, async () => {
  assert.ok(desktopId, "needs step 1");
  const app = await manager.launchApp(desktopId, { command: "sleep 600", cwd: project, env: {} });
  await until(manager, desktopId, (d) => d.apps.some((a) => a.id === app.id && a.status === "running"));
  const pgid = await readPgid(desktopId, app.id);
  groups.add(pgid);

  const down = until(manager, desktopId, (d) => d.box?.connected === false);
  setLink(false);
  const outage = await down;
  assert.equal(outage.status, "running", "the desktop keeps running in the box");
  assert.equal(manager.vncStream(desktopId), null);
  await assert.rejects(manager.launchApp(desktopId, { command: "true", cwd: project, env: {} }), { code: "DESKTOP_BOX_UNREACHABLE" });
  await assert.rejects(manager.stop(desktopId), { code: "DESKTOP_BOX_UNREACHABLE" });
  // The app ends while nobody watches.
  process.kill(-pgid, "SIGTERM");
  const exitFile = join(boxDir(desktopId), "apps", `${app.id}.exit`);
  await untilInDir(join(boxDir(desktopId), "apps"), async () => existsSync(exitFile), "the app's exit file");
  assert.equal(manager.get(desktopId)?.apps.find((a) => a.id === app.id)?.status, "running", "unseen while the link is down");

  setLink(true);
  const back = await until(manager, desktopId, (d) => d.box?.connected === true && d.apps.some((a) => a.id === app.id && a.status === "exited"));
  assert.equal(back.status, "running");
  // The window tracker is back: a new app's window is mapped again.
  const again = await manager.launchApp(desktopId, { command: "xterm -e cat", cwd: project, env: {} });
  await until(manager, desktopId, (d) => d.apps.some((a) => a.id === again.id && a.status === "running"));
  groups.add(await readPgid(desktopId, again.id));
  await windowOf(manager, desktopId, again.id);
  manager.stopApp(desktopId, again.id, true);
  await until(manager, desktopId, (d) => d.apps.some((a) => a.id === again.id && a.status === "exited"));
});

test("6. after a daemon restart the desktop waits for its VM, then reattaches there", { skip: skipReason ?? false }, async () => {
  assert.ok(desktopId, "needs step 1");
  const display = manager.get(desktopId)!.display;
  await manager.flush();
  await manager.shutdown();
  setLink(false);
  manager = makeManager();
  await manager.load();
  await manager.reattach();
  const waiting = manager.get(desktopId)!;
  assert.equal(waiting.status, "starting");
  assert.equal(waiting.box?.connected, false);
  assert.match(waiting.statusDetail ?? "", /VM/);
  setLink(true);
  const summary = await until(manager, desktopId, (d) => d.status === "running");
  assert.equal(summary.display, display);
  assert.equal(summary.box?.connected, true);
  assert.ok(summary.apps.every((a) => a.status === "exited"));
  const open = manager.vncStream(desktopId);
  assert.ok(open);
  const stream = await open();
  try {
    assert.match((await readBytes(stream, 12)).toString("latin1"), /^RFB 003\.00\d\n$/);
  } finally {
    stream.destroy();
  }
});

test("7. closing takes everything down in the box", { skip: skipReason ?? false }, async () => {
  assert.ok(desktopId, "needs step 1");
  const app = await manager.launchApp(desktopId, { command: "sleep 600", cwd: project, env: {} });
  await until(manager, desktopId, (d) => d.apps.some((a) => a.id === app.id && a.status === "running"));
  groups.add(await readPgid(desktopId, app.id));
  assert.ok((await liveMembers(groups)).length > 0, "the desktop's processes are running before close");
  await manager.close(desktopId);
  assert.equal(manager.get(desktopId), undefined);
  assert.equal(existsSync(boxDir(desktopId)), false);
  assert.deepEqual(await boxSessions(), []);
  assert.deepEqual(await liveMembers(groups), []);
});

test("8. a desktop closed while its VM is away is reaped there once the VM is back", { skip: skipReason ?? false }, async () => {
  const created = await manager.create({ projectPath: project, projectRealPath: project, boxId: BOX_ID });
  assert.equal(created.status, "running", created.error);
  const host = await hostPanePid(created.id);
  groups.add(host);
  const app = await manager.launchApp(created.id, { command: "sleep 600", cwd: project, env: {} });
  await until(manager, created.id, (d) => d.apps.some((a) => a.id === app.id && a.status === "running"));
  groups.add(await readPgid(created.id, app.id));

  setLink(false);
  await manager.close(created.id);
  assert.equal(manager.get(created.id), undefined);
  assert.deepEqual(await boxSessions(), [`orqsvc-desktop-${created.id}`], "nothing could be reached meanwhile");

  setLink(true);
  // The reap removes the dir last, after the app's group (out of the session's reach) and the session.
  await untilInDir(join(home, ".orquester", "desktops"), async () => !existsSync(boxDir(created.id)), "the reaped dir");
  assert.deepEqual(await boxSessions(), []);
  assert.deepEqual(await liveMembers(groups), []);
});

test("9. a desktop whose VM is destroyed ends stopped", { skip: skipReason ?? false }, async () => {
  const created = await manager.create({ projectPath: project, projectRealPath: project, boxId: BOX_ID });
  assert.equal(created.status, "running", created.error);
  groups.add(await hostPanePid(created.id));
  const stopped = until(manager, created.id, (d) => d.status === "stopped");
  record = { ...record, state: "destroyed" };
  for (const listener of registryListeners) listener(BOX_ID);
  const summary = await stopped;
  assert.match(summary.error ?? "", /VM .*gone/);
  await assert.rejects(manager.restart(created.id), { code: "DESKTOP_BOX_GONE" });
  // The tab can still be closed.
  await manager.close(created.id);
  assert.equal(manager.get(created.id), undefined);
});
