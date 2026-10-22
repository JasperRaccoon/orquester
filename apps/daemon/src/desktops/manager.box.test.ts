import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESKTOP_UNAVAILABLE_CODE, type DesktopHostStatus, type DesktopSummary } from "@orquester/api";
import { desktopsIndexPath } from "@orquester/config";
import { type DesktopBoxes, type DesktopHost, LocalDesktopHost } from "./desktop-host.ts";
import { DesktopError, DesktopManager, type DesktopManagerOptions, type DesktopTmux } from "./manager.ts";

// The manager's VM-desktop paths against a fake box: its "machine" is a temp
// dir on this one (LocalDesktopHost underneath, a box id and a link that can
// drop on top) and a scripted tmux whose host writes `ready` at once, as
// manager.test.ts does. The real stack through a box link:
// boxes/remote/desktop/vm-desktop.integration.test.ts.

const READY: DesktopHostStatus = {
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
const MISSING: DesktopHostStatus = { ...READY, available: false, installHint: "Orquester installs it when a desktop opens." };

async function atomicWrite(path: string, value: string): Promise<void> {
  await writeFile(`${path}.tmp`, value);
  await rename(`${path}.tmp`, path);
}

const tmux: DesktopTmux = {
  newServiceSession: async (opts) => atomicWrite(join(opts.cwd, "ready"), "42\n"),
  newServiceWindow: async () => {},
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

interface FakeBox {
  boxes: DesktopBoxes;
  host: DesktopHost;
  setConnected(up: boolean): void;
  ensureCalls: number;
  status: DesktopHostStatus;
  ensure: (onProgress: (line: string) => void) => Promise<DesktopHostStatus>;
}

function fakeBox(appdir: string): FakeBox {
  const local = new LocalDesktopHost({ baseDir: appdir, tmux, baseEnv: () => ({}), renderNode: () => false, tmpDir: appdir });
  let up = true;
  const listeners = new Set<(boxId: string) => void>();
  const host: DesktopHost = {
    boxId: "b1",
    get connected() {
      return up;
    },
    tmux,
    parallelism: 2,
    desktopDir: (id) => join(appdir, "box-home", ".orquester", "desktops", id),
    socketFallback: (dir, id) => local.socketFallback(dir, id),
    scripts: () => local.scripts(),
    prepareDirs: (dirs) => local.prepareDirs(dirs),
    readText: (path) => local.readText(path),
    readTail: (path, bytes) => local.readTail(path, bytes),
    writeFile: (path, data, mode) => local.writeFile(path, data, mode),
    rm: (path, options) => local.rm(path, options),
    exists: (path) => local.exists(path),
    readdir: (path) => local.readdir(path),
    watch: (dir, onChange, onError) => local.watch(dir, onChange, onError),
    signalGroup: async () => {},
    leaderBelongsTo: async () => false,
    appEnv: (options) => local.appEnv(options),
    trackerOptions: (options) => options
  };
  const fake: FakeBox = {
    host,
    ensureCalls: 0,
    status: READY,
    ensure: async () => READY,
    setConnected(next) {
      up = next;
      for (const listener of listeners) listener("b1");
    },
    boxes: {
      host: (boxId) => (boxId === "b1" ? host : null),
      status: async () => fake.status,
      ensure: (_boxId, onProgress) => {
        fake.ensureCalls += 1;
        return fake.ensure(onProgress);
      },
      onChange: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    }
  };
  return fake;
}

async function setup(t: TestContext, options: { boxes?: boolean } = {}) {
  const appdir = await mkdtemp(join(tmpdir(), "orq-desktop-box-"));
  await mkdir(join(appdir, "box-home"), { recursive: true });
  const box = fakeBox(appdir);
  const make = () =>
    new DesktopManager({
      baseDir: appdir,
      indexFile: desktopsIndexPath(appdir),
      tmux,
      hostStatus: async () => READY,
      createTracker: (() => tracker) as unknown as DesktopManagerOptions["createTracker"],
      ...(options.boxes === false ? {} : { boxes: box.boxes }),
      tmpDir: appdir,
      logger: { warn: () => {}, error: () => {} }
    });
  const manager = make();
  t.after(async () => {
    await manager.shutdown();
    await rm(appdir, { recursive: true, force: true, maxRetries: 3 });
  });
  await manager.load();
  await manager.reattach();
  return { appdir, box, manager, make };
}

test("a VM desktop whose stack is missing installs it first, its progress in statusDetail, then runs in the box", async (t) => {
  const { appdir, box, manager } = await setup(t);
  box.status = MISSING;
  const updates: DesktopSummary[] = [];
  manager.on("updated", (summary) => updates.push(summary));
  box.ensure = async (onProgress) => {
    // The install's lines reach every client (coalesced), trimmed.
    const shown = new Promise<void>((resolve) =>
      manager.on("updated", (summary) => {
        if (summary.statusDetail === "Setting up openbox …") resolve();
      })
    );
    onProgress("  Setting up openbox …  ");
    await shown;
    return READY;
  };
  const created: DesktopSummary[] = [];
  manager.on("created", (summary) => created.push(summary));

  const desktop = await manager.create({ projectPath: "/ws/p", projectRealPath: "/ws/p", boxId: "b1" });
  assert.equal(desktop.status, "running", desktop.error);
  assert.deepEqual(desktop.box, { id: "b1", connected: true });
  assert.equal(desktop.statusDetail, undefined);
  assert.equal(box.ensureCalls, 1);
  assert.equal(created[0]?.status, "starting");
  assert.ok(updates.some((summary) => summary.status === "starting" && /Installing/.test(summary.statusDetail ?? "")));
  // The desktop's files are the box's; its record says so.
  assert.ok((await readFile(join(appdir, "box-home", ".orquester", "desktops", desktop.id, "ready"), "utf8")).includes("42"));
  await manager.flush();
  const index = JSON.parse(await readFile(desktopsIndexPath(appdir), "utf8"));
  assert.deepEqual(index.desktops[0].box, { id: "b1", dir: join(appdir, "box-home", ".orquester", "desktops", desktop.id) });

  // A box whose stack is there starts without installing.
  box.status = READY;
  await manager.create({ projectPath: "/ws/p", projectRealPath: "/ws/p", boxId: "b1" });
  assert.equal(box.ensureCalls, 1);
});

test("an install that cannot happen drops the tab again and answers 409 with its hint", async (t) => {
  const { box, manager } = await setup(t);
  box.status = MISSING;
  box.ensure = async () => {
    throw new DesktopError(409, DESKTOP_UNAVAILABLE_CODE, "This VM has no sudo.", "Use a VM image with sudo.");
  };
  const closed: string[] = [];
  manager.on("closed", ({ id }) => closed.push(id));
  await assert.rejects(manager.create({ projectPath: "/ws/p", projectRealPath: "/ws/p", boxId: "b1" }), {
    status: 409,
    code: DESKTOP_UNAVAILABLE_CODE,
    hint: "Use a VM image with sudo."
  });
  assert.equal(closed.length, 1);
  assert.deepEqual(manager.list(), []);
});

test("a VM that is not connected refuses new desktops and stops, but not closes", async (t) => {
  const { box, manager } = await setup(t);
  const desktop = await manager.create({ projectPath: "/ws/p", projectRealPath: "/ws/p", boxId: "b1" });
  box.setConnected(false);
  assert.equal(manager.get(desktop.id)?.box?.connected, false);
  assert.equal(manager.vncStream(desktop.id), null);
  assert.equal(manager.audioSource(desktop.id), null);
  await assert.rejects(manager.create({ projectPath: "/ws/p", projectRealPath: "/ws/p", boxId: "b1" }), { code: "DESKTOP_BOX_UNREACHABLE" });
  await assert.rejects(manager.stop(desktop.id), { code: "DESKTOP_BOX_UNREACHABLE" });
  await assert.rejects(manager.launchApp(desktop.id, { command: "true", cwd: "/ws/p", env: {} }), { code: "DESKTOP_BOX_UNREACHABLE" });
  await manager.close(desktop.id);
  assert.equal(manager.get(desktop.id), undefined);
});

test("a restart whose install fails leaves the desktop failed with the reason and its hint", async (t) => {
  const { box, manager } = await setup(t);
  const desktop = await manager.create({ projectPath: "/ws/p", projectRealPath: "/ws/p", boxId: "b1" });
  await manager.stop(desktop.id);
  box.status = MISSING;
  box.ensure = async () => {
    throw new DesktopError(409, DESKTOP_UNAVAILABLE_CODE, "The packages could not be installed.", "Check the VM's apt sources.");
  };
  await assert.rejects(manager.restart(desktop.id), { code: DESKTOP_UNAVAILABLE_CODE });
  const failed = manager.get(desktop.id)!;
  assert.equal(failed.status, "error");
  assert.match(failed.error ?? "", /could not be installed\.\nCheck the VM's apt sources\./);
  box.status = READY;
  assert.equal((await manager.restart(desktop.id)).status, "running");
});

test("a VM desktop on a daemon without VM support ends stopped at boot, its record kept", async (t) => {
  const first = await setup(t);
  const desktop = await first.manager.create({ projectPath: "/ws/p", projectRealPath: "/ws/p", boxId: "b1" });
  await first.manager.flush();
  const withoutBoxes = new DesktopManager({
    baseDir: first.appdir,
    indexFile: desktopsIndexPath(first.appdir),
    tmux,
    hostStatus: async () => READY,
    createTracker: (() => tracker) as unknown as DesktopManagerOptions["createTracker"],
    logger: { warn: () => {}, error: () => {} }
  });
  t.after(() => withoutBoxes.shutdown());
  await withoutBoxes.load();
  assert.equal(withoutBoxes.get(desktop.id)?.status, "starting");
  const stopped = new Promise<DesktopSummary>((resolve) =>
    withoutBoxes.on("updated", (summary) => {
      if (summary.id === desktop.id && summary.status === "stopped") resolve(summary);
    })
  );
  await withoutBoxes.reattach();
  assert.match((await stopped).error ?? "", /VMs are not available/);
  await withoutBoxes.flush();
  const index = JSON.parse(await readFile(desktopsIndexPath(first.appdir), "utf8"));
  assert.equal(index.desktops[0].box.id, "b1");
});
