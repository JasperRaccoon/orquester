import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesktopHostStatus, DesktopSummary, DesktopVoxlStatus } from "@orquester/api";
import { desktopRuntimeDir, desktopsIndexPath } from "@orquester/config";
import { DesktopManager, type DesktopManagerOptions, type DesktopTmux } from "./manager.ts";
import { VoxlUnavailableError } from "./voxl-streams.ts";

// The manager's voxl backend against a scripted tmux: the host writes `ready`; the `voxl` window
// plays voxl as voxl-run.sh would run it — its listen line in `voxl.log` and a `/healthz` on the
// port it was given — or a voxl that cannot bind its port, or one that exits. The manager's own
// watches drive everything; no X server, no real voxl.

const HOST: DesktopHostStatus = {
  available: true,
  audioAvailable: false,
  tools: [],
  ffmpegPulse: false,
  ffmpegOpus: false,
  renderNode: false,
  tmuxUsable: true,
  warnings: [],
  installHint: null
};
const VOXL: DesktopVoxlStatus = { available: true, version: "0.3.4", path: "/opt/orquester-tools/voxl/0.3.4/voxl" };
const NO_VOXL: DesktopVoxlStatus = { available: false, version: null, path: null, reason: "voxl is not installed on the server." };

async function atomicWrite(path: string, value: string): Promise<void> {
  await writeFile(`${path}.tmp`, value);
  await rename(`${path}.tmp`, path);
}

type VoxlBehaviour = "listen" | "bind-fails-once" | "exits";

interface Harness {
  manager: DesktopManager;
  appdir: string;
  sessions: string[];
  /** Every `voxl` window's argv. */
  voxlLaunches: string[][];
  behaviour: VoxlBehaviour;
}

async function harness(t: TestContext, voxl: DesktopVoxlStatus): Promise<Harness> {
  const appdir = await mkdtemp(join(tmpdir(), "orq-desktop-voxl-"));
  const servers: Server[] = [];
  const h: Harness = { manager: undefined as unknown as DesktopManager, appdir, sessions: [], voxlLaunches: [], behaviour: "listen" };
  let bindFailed = false;
  const tmux: DesktopTmux = {
    newServiceSession: async (opts) => {
      h.sessions.push(opts.name);
      await atomicWrite(join(opts.cwd, "ready"), "99\n");
    },
    newServiceWindow: async (opts) => {
      if (opts.name !== "voxl") return;
      h.voxlLaunches.push(opts.args);
      const [, dir] = opts.args;
      const port = Number(opts.args.find((arg) => arg.startsWith("--port="))!.slice("--port=".length));
      const log = join(dir!, "voxl.log");
      if (h.behaviour === "bind-fails-once" && !bindFailed) {
        bindFailed = true;
        await writeFile(log, "thread 'main' panicked at src/lib.rs:410:10:\nbind: Os { code: 98, kind: AddrInUse, message: \"Address already in use\" }\n");
        await atomicWrite(join(dir!, "voxl.exit"), "134\n");
        return;
      }
      const server = createServer((socket) => {
        socket.once("data", () => socket.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok"));
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
      await writeFile(log, `[t INFO  voxl] listening on http://127.0.0.1:${port}\n`);
    },
    listServiceSessions: async () => [],
    // No voxl window is ever listed: nothing here is signalled.
    listServiceWindows: async () => [],
    killServiceSession: async () => {}
  };
  const tracker = {
    on: () => tracker,
    start: async () => {
      throw new Error("no X server in this test");
    },
    stop: () => {},
    snapshot: () => ({ windows: [], activeWindowId: null })
  };
  h.manager = new DesktopManager({
    baseDir: appdir,
    indexFile: desktopsIndexPath(appdir),
    tmux,
    hostStatus: async () => HOST,
    voxlStatus: async () => voxl,
    baseEnv: () => ({ PATH: "/usr/bin:/bin" }),
    renderNode: () => false,
    createTracker: (() => tracker) as unknown as DesktopManagerOptions["createTracker"],
    tmpDir: appdir,
    logger: { warn: () => {}, error: () => {} }
  });
  t.after(async () => {
    await h.manager.shutdown();
    for (const server of servers) server.close();
    await rm(appdir, { recursive: true, force: true, maxRetries: 3 });
  });
  await h.manager.load();
  return h;
}

/** The desktop's summary once it satisfies `predicate` (now, or at an `updated`). */
function until(manager: DesktopManager, id: string, predicate: (summary: DesktopSummary) => boolean): Promise<DesktopSummary> {
  const current = manager.get(id);
  if (current && predicate(current)) return Promise.resolve(current);
  return new Promise((resolve) => {
    const listener = (summary: DesktopSummary) => {
      if (summary.id !== id || !predicate(summary)) return;
      manager.off("updated", listener);
      resolve(summary);
    };
    manager.on("updated", listener);
  });
}

test("a new desktop streams with voxl when the host has one, else RFB; a request may name either", async (t) => {
  const withVoxl = await harness(t, VOXL);
  const desktop = await withVoxl.manager.create({ projectPath: withVoxl.appdir, projectRealPath: withVoxl.appdir });
  assert.equal(desktop.video, "voxl");
  assert.deepEqual((await until(withVoxl.manager, desktop.id, (d) => d.voxl?.state !== "starting")).voxl, { state: "ready" });
  const asked = await withVoxl.manager.create({ projectPath: withVoxl.appdir, projectRealPath: withVoxl.appdir, video: "rfb" });
  assert.equal(asked.video, "rfb");
  assert.equal(asked.voxl, undefined);

  const without = await harness(t, NO_VOXL);
  const plain = await without.manager.create({ projectPath: without.appdir, projectRealPath: without.appdir });
  assert.equal(plain.video, "rfb");
  assert.equal(plain.voxl, undefined);
});

test("without a voxl binary a voxl desktop runs on, its stream unavailable with the reason; a viewer is refused", async (t) => {
  const h = await harness(t, NO_VOXL);
  const desktop = await h.manager.create({ projectPath: h.appdir, projectRealPath: h.appdir, video: "voxl" });
  assert.equal(desktop.status, "running");
  const summary = await until(h.manager, desktop.id, (d) => d.voxl?.state === "unavailable");
  assert.match(summary.voxl?.reason ?? "", /not installed/);
  assert.equal(summary.status, "running");
  await assert.rejects(h.manager.voxlUpstream(desktop.id)!(), VoxlUnavailableError);
  assert.equal(h.voxlLaunches.length, 0);
});

test("PATCH switches the backend without restarting the desktop; it is persisted", async (t) => {
  const h = await harness(t, VOXL);
  const desktop = await h.manager.create({ projectPath: h.appdir, projectRealPath: h.appdir, video: "rfb" });
  const toVoxl = await h.manager.update(desktop.id, { video: "voxl" });
  assert.equal(toVoxl.video, "voxl");
  assert.deepEqual((await until(h.manager, desktop.id, (d) => d.voxl?.state === "ready")).voxl, { state: "ready" });
  const toRfb = await h.manager.update(desktop.id, { video: "rfb" });
  assert.equal(toRfb.video, "rfb");
  assert.equal(toRfb.voxl, undefined);
  assert.equal(h.manager.voxlUpstream(desktop.id), null, "an RFB desktop has no voxl relay");
  assert.equal(toRfb.status, "running");
  assert.deepEqual(h.sessions, [`orqsvc-desktop-${desktop.id}`], "the desktop's host was started once");
  await h.manager.flush();
  const index = JSON.parse(await readFile(desktopsIndexPath(h.appdir), "utf8")) as { desktops: Array<{ id: string; video?: unknown }> };
  assert.equal(index.desktops.find((record) => record.id === desktop.id)?.video, "rfb");
});

test("the first viewer starts voxl: loopback port, password only in the 0600 env file; voxl's own exit makes the stream unavailable", async (t) => {
  const h = await harness(t, VOXL);
  const desktop = await h.manager.create({ projectPath: h.appdir, projectRealPath: h.appdir, video: "voxl" });
  await until(h.manager, desktop.id, (d) => d.voxl?.state === "ready");
  assert.equal(h.voxlLaunches.length, 0, "voxl does not run before anyone watches");
  const lease = await h.manager.voxlUpstream(desktop.id)!();
  assert.equal(h.voxlLaunches.length, 1);
  const dir = desktopRuntimeDir(h.appdir, desktop.id);
  const envFile = join(dir, "voxl.env");
  assert.equal((await stat(envFile)).mode & 0o777, 0o600);
  assert.match(await readFile(envFile, "utf8"), new RegExp(`^VOXL_PASSWORD='${lease.password}'$`, "m"));
  assert.ok(!h.voxlLaunches[0]!.join(" ").includes(lease.password), "never in argv");
  assert.ok(h.voxlLaunches[0]!.includes(`--port=${lease.port}`));
  assert.ok(h.voxlLaunches[0]!.includes("--addr=127.0.0.1"));
  assert.ok(!JSON.stringify(h.manager.get(desktop.id)).includes(lease.password), "never in a summary");
  await h.manager.flush();
  assert.ok(!(await readFile(desktopsIndexPath(h.appdir), "utf8")).includes(lease.password), "never in desktops.json");
  // A second viewer shares the running voxl.
  const second = await h.manager.voxlUpstream(desktop.id)!();
  assert.equal(second.port, lease.port);
  assert.equal(h.voxlLaunches.length, 1);

  // voxl exits on its own: the desktop runs on, its viewers fall back to RFB.
  await writeFile(join(dir, "voxl.log"), "[t ERROR voxl] video init failed: X connect: refused\n", { flag: "a" });
  await atomicWrite(join(dir, "voxl.exit"), "1\n");
  const after = await until(h.manager, desktop.id, (d) => d.voxl?.state === "unavailable");
  assert.equal(after.status, "running");
  assert.match(after.voxl?.reason ?? "", /exited \(1\).*X connect: refused/);
  lease.release();
  second.release();
});

test("a taken port is retried once with another", async (t) => {
  const h = await harness(t, VOXL);
  h.behaviour = "bind-fails-once";
  const desktop = await h.manager.create({ projectPath: h.appdir, projectRealPath: h.appdir, video: "voxl" });
  await until(h.manager, desktop.id, (d) => d.voxl?.state === "ready");
  const lease = await h.manager.voxlUpstream(desktop.id)!();
  assert.equal(h.voxlLaunches.length, 2);
  assert.ok(h.voxlLaunches[1]!.includes(`--port=${lease.port}`));
  assert.deepEqual((await until(h.manager, desktop.id, () => true)).voxl, { state: "ready" });
  lease.release();
});
