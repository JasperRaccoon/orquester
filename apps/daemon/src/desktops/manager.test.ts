import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesktopHostStatus, DesktopSummary } from "@orquester/api";
import { desktopRuntimeDir, desktopsIndexPath } from "@orquester/config";
import { DesktopManager, type DesktopManagerOptions, type DesktopTmux } from "./manager.ts";

// The manager against a scripted tmux: the "host" writes `ready` and the "app" its `.pgid`
// and `.exit` as the real scripts do (write, then rename into place), so the manager's own
// watchers drive it. No X server, no real process.

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

async function atomicWrite(path: string, value: string): Promise<void> {
  await writeFile(`${path}.tmp`, value);
  await rename(`${path}.tmp`, path);
}

test("an app's exit is never seen as exited without its code: every summary sampled while it lands", async (t) => {
  const appdir = await mkdtemp(join(tmpdir(), "orq-desktop-manager-"));
  const tmux: DesktopTmux = {
    // The host comes up at once: display 99.
    newServiceSession: async (opts) => {
      await atomicWrite(join(opts.cwd, "ready"), "99\n");
    },
    // The app starts: its group recorded, nothing else yet.
    newServiceWindow: async (opts) => {
      const [, dir, appId] = opts.args;
      await atomicWrite(join(dir!, "apps", `${appId}.pgid`), "999999\n");
    },
    listServiceSessions: async () => [],
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
  const manager = new DesktopManager({
    baseDir: appdir,
    indexFile: desktopsIndexPath(appdir),
    tmux,
    hostStatus: async () => HOST,
    baseEnv: () => ({ PATH: "/usr/bin:/bin" }),
    renderNode: () => false,
    createTracker: (() => tracker) as unknown as DesktopManagerOptions["createTracker"],
    tmpDir: appdir,
    logger: { warn: () => {}, error: () => {} }
  });
  // Watchers and index writes end before the directory goes.
  t.after(async () => {
    await manager.shutdown();
    await rm(appdir, { recursive: true, force: true, maxRetries: 3 });
  });
  await manager.load();

  const desktop = await manager.create({ projectPath: appdir, projectRealPath: appdir });
  assert.equal(desktop.status, "running");
  assert.equal((await stat(join(desktopRuntimeDir(appdir, desktop.id), "Xauthority"))).mode & 0o777, 0o600);
  const app = await manager.launchApp(desktop.id, { command: "true", cwd: appdir, env: {} });
  const appOf = (summary: DesktopSummary | undefined) => summary?.apps.find((candidate) => candidate.id === app.id);
  // Running first: the `.pgid` the window wrote has been taken in.
  while (appOf(manager.get(desktop.id))?.status !== "running") {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  // Every update emitted while the exit lands, and `get()` once per macrotask until it has.
  const seen: Array<{ status: string; exitCode: number | null }> = [];
  const record = (summary: DesktopSummary | undefined) => {
    const current = appOf(summary);
    if (current !== undefined) seen.push({ status: current.status, exitCode: current.exitCode });
  };
  manager.on("updated", (summary) => {
    if (summary.id === desktop.id) record(summary);
  });
  await atomicWrite(join(desktopRuntimeDir(appdir, desktop.id), "apps", `${app.id}.exit`), "3\n");
  while (appOf(manager.get(desktop.id))?.status !== "exited") {
    record(manager.get(desktop.id));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  record(manager.get(desktop.id));

  const exited = seen.filter((sample) => sample.status === "exited");
  assert.ok(exited.length > 0);
  assert.deepEqual(
    exited.filter((sample) => sample.exitCode !== 3),
    [],
    "exited ⇒ its exit code, in every sample"
  );
});
