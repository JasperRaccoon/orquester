import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESKTOP_UNAVAILABLE_CODE, type DesktopHostStatus, type DesktopSummary } from "@orquester/api";
import { desktopsIndexPath } from "@orquester/config";
import { type DesktopBoxes, type DesktopGroupOwner, type DesktopHost, LocalDesktopHost } from "./desktop-host.ts";
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
  /** The box's live desktop sessions (its tmux). A "reboot" clears them without any exit file. */
  sessions: Set<string>;
  /** Sessions killed, in order. */
  killed: string[];
  /** Every group signal sent into the box, with the owner check it carried. */
  signals: Array<{ pgid: number; signal: string; owner?: DesktopGroupOwner }>;
  /** The host does not write `ready` on its own (a slow start). */
  slowHost: boolean;
  /** Runs right after a host session starts. */
  onHostStarted: (() => void) | null;
  onSignal: ((signal: { pgid: number; signal: string; owner?: DesktopGroupOwner }) => void) | null;
  /** Runs before the box tmux is listed (a slow listing). */
  beforeList: (() => Promise<void>) | null;
}

function fakeBox(appdir: string): FakeBox {
  const local = new LocalDesktopHost({ baseDir: appdir, tmux, baseEnv: () => ({}), renderNode: () => false, tmpDir: appdir });
  let up = true;
  const listeners = new Set<(boxId: string) => void>();
  const watches = new Set<(name: string | null) => void>();
  const dirOf = (id: string) => join(appdir, "box-home", ".orquester", "desktops", id);
  // The box's tmux: sessions come and go; a killed host records host.exit, as its trap does.
  const boxTmux: DesktopTmux = {
    newServiceSession: async (opts) => {
      fake.sessions.add(opts.name);
      if (!fake.slowHost) await atomicWrite(join(opts.cwd, "ready"), "42\n");
      fake.onHostStarted?.();
    },
    newServiceWindow: async () => {},
    listServiceSessions: async () => {
      await fake.beforeList?.();
      return [...fake.sessions];
    },
    listServiceWindows: async (session) => (fake.sessions.has(session) ? [{ name: "host", panePid: 4242 }] : []),
    killServiceSession: async (name) => {
      fake.killed.push(name);
      if (fake.sessions.delete(name)) await atomicWrite(join(dirOf(name.slice("orqsvc-desktop-".length)), "host.exit"), "143\n");
    }
  };
  const host: DesktopHost = {
    boxId: "b1",
    get connected() {
      return up;
    },
    tmux: boxTmux,
    parallelism: 2,
    desktopDir: dirOf,
    socketFallback: (dir, id) => local.socketFallback(dir, id),
    scripts: () => local.scripts(),
    prepareDirs: (dirs) => local.prepareDirs(dirs),
    readText: (path) => local.readText(path),
    readTail: (path, bytes) => local.readTail(path, bytes),
    writeFile: (path, data, mode) => local.writeFile(path, data, mode),
    rm: (path, options) => local.rm(path, options),
    exists: (path) => local.exists(path),
    readdir: (path) => local.readdir(path),
    // As a box's watch does: back in place after a reconnect, it reports `null` (check again).
    watch: (dir, onChange, onError) => {
      const watch = local.watch(dir, onChange, onError);
      watches.add(onChange);
      return {
        close: () => {
          watches.delete(onChange);
          watch.close();
        }
      };
    },
    signalGroup: async (pgid, signal, owner) => {
      const entry = { pgid, signal, ...(owner ? { owner } : {}) };
      fake.signals.push(entry);
      fake.onSignal?.(entry);
    },
    // Whatever ran there before is not ours any more (a reboot reuses pids).
    leaderBelongsTo: async () => false,
    appEnv: (options) => local.appEnv(options),
    trackerOptions: (options) => options
  };
  const fake: FakeBox = {
    host,
    ensureCalls: 0,
    status: READY,
    ensure: async () => READY,
    sessions: new Set(),
    killed: [],
    signals: [],
    slowHost: false,
    onHostStarted: null,
    onSignal: null,
    beforeList: null,
    setConnected(next) {
      up = next;
      // (The watches are back first: their re-check races the reconnect's reconcile.)
      if (next) for (const onChange of [...watches]) onChange(null);
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

async function setup(t: TestContext, options: { boxes?: boolean; readyTimeoutMs?: number } = {}) {
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
      ...(options.readyTimeoutMs ? { readyTimeoutMs: options.readyTimeoutMs } : {}),
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
  assert.ok(updates.some((summary) => summary.status === "starting" && /Checking/.test(summary.statusDetail ?? "")));
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

/** The desktop's summary once `predicate` holds: now, or at the update that makes it so. */
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

/** A running app with its pgid recorded, as app-run.sh leaves it. */
async function runningApp(appdir: string, manager: DesktopManager, id: string, pgid: number): Promise<string> {
  const app = await manager.launchApp(id, { command: "sleep 600", cwd: "/ws/p", env: {} });
  await atomicWrite(join(appdir, "box-home", ".orquester", "desktops", id, "apps", `${app.id}.pgid`), `${pgid}\n`);
  await until(manager, id, (d) => d.apps.some((a) => a.id === app.id && a.status === "running"));
  return app.id;
}

test("a VM missing only optional packages (sound, a compositor) gets them on the first desktop", async (t) => {
  const { box, manager } = await setup(t);
  box.status = { ...READY, installHint: "Orquester installs xcompmgr pulseaudio ffmpeg in the box when a desktop opens." };
  const desktop = await manager.create({ projectPath: "/ws/p", projectRealPath: "/ws/p", boxId: "b1" });
  assert.equal(desktop.status, "running", desktop.error);
  assert.equal(box.ensureCalls, 1);
});

test("a stop while the VM installs is not undone when the install ends", async (t) => {
  const { box, manager } = await setup(t);
  box.status = MISSING;
  let finishInstall!: () => void;
  box.ensure = () => new Promise((resolve) => (finishInstall = () => resolve(READY)));
  const created = new Promise<DesktopSummary>((resolve) => manager.once("created", resolve));
  const creating = manager.create({ projectPath: "/ws/p", projectRealPath: "/ws/p", boxId: "b1" });
  const { id } = await created;
  assert.equal((await manager.stop(id)).status, "stopped");
  finishInstall();
  const result = await creating;
  assert.equal(result.status, "stopped");
  assert.equal(manager.get(id)?.status, "stopped");
  assert.equal(box.sessions.size, 0, "no host was started after the stop");
});

test("a link blip while the VM installs leaves the install in charge: the desktop then starts", async (t) => {
  const { box, manager } = await setup(t);
  box.status = MISSING;
  let finishInstall!: () => void;
  box.ensure = () => new Promise((resolve) => (finishInstall = () => resolve(READY)));
  const created = new Promise<DesktopSummary>((resolve) => manager.once("created", resolve));
  const creating = manager.create({ projectPath: "/ws/p", projectRealPath: "/ws/p", boxId: "b1" });
  const { id } = await created;
  box.setConnected(false);
  const reconciled = new Promise<DesktopSummary>((resolve) => manager.once("updated", resolve));
  box.setConnected(true);
  assert.equal((await reconciled).status, "starting");
  finishInstall();
  assert.equal((await creating).status, "running");
  assert.equal(manager.get(id)?.status, "running");
});

test("an app launched while the reconnect reconcile reads the VM is not taken for exited", async (t) => {
  const { appdir, box, manager } = await setup(t);
  const desktop = await manager.create({ projectPath: "/ws/p", projectRealPath: "/ws/p", boxId: "b1" });
  box.setConnected(false);
  let release!: () => void;
  let listing!: () => void;
  const listed = new Promise<void>((resolve) => (listing = resolve));
  box.beforeList = () => {
    box.beforeList = null;
    listing();
    return new Promise<void>((resolve) => (release = resolve));
  };
  box.setConnected(true);
  await listed;
  // The reconcile is reading the box: a launch goes through meanwhile.
  const appId = await runningApp(appdir, manager, desktop.id, 555);
  const reconciled = new Promise<DesktopSummary>((resolve) => manager.once("updated", resolve));
  release();
  const after = await reconciled;
  assert.equal(after.status, "running");
  assert.equal(after.apps.find((a) => a.id === appId)?.status, "running");
});

test("a VM that restarted while out of reach: its running desktop ends stopped, saying so, and no reused pid is signalled", async (t) => {
  const { appdir, box, manager } = await setup(t);
  const desktop = await manager.create({ projectPath: "/ws/p", projectRealPath: "/ws/p", boxId: "b1" });
  const appId = await runningApp(appdir, manager, desktop.id, 777);
  box.setConnected(false);
  // The reboot: the session and the processes are gone; nothing wrote host.exit.
  box.sessions.clear();
  box.setConnected(true);
  const stopped = await until(manager, desktop.id, (d) => d.status === "stopped");
  assert.match(stopped.error ?? "", /ended while the VM was out of reach/);
  assert.equal(stopped.box?.connected, true);
  assert.equal(stopped.apps.find((a) => a.id === appId)?.status, "exited");
  assert.deepEqual(box.signals.filter((s) => s.pgid === 777), [], "the app's old pgid is someone else's now");
  assert.equal(manager.vncStream(desktop.id), null);
});

test("a VM shut down cleanly while out of reach (its host's trap wrote host.exit): the reconnect says it restarted, not that the host crashed", async (t) => {
  const { appdir, box, manager } = await setup(t);
  const desktop = await manager.create({ projectPath: "/ws/p", projectRealPath: "/ws/p", boxId: "b1" });
  const appId = await runningApp(appdir, manager, desktop.id, 778);
  box.setConnected(false);
  // `sudo reboot`: systemd ends the session, the host's trap records its SIGHUP exit, the VM comes back.
  box.sessions.clear();
  await atomicWrite(join(appdir, "box-home", ".orquester", "desktops", desktop.id, "host.exit"), "129\n");
  box.setConnected(true);
  const stopped = await until(manager, desktop.id, (d) => d.status === "stopped");
  assert.match(stopped.error ?? "", /ended while the VM was out of reach/);
  assert.doesNotMatch(stopped.error ?? "", /host exited/);
  assert.equal(stopped.apps.find((a) => a.id === appId)?.status, "exited");
  assert.deepEqual(box.signals.filter((s) => s.pgid === 778), [], "the app's old pgid is someone else's now");
});

test("a link blip without a restart: the desktop stays running, reconciled again", async (t) => {
  const { box, manager } = await setup(t);
  const desktop = await manager.create({ projectPath: "/ws/p", projectRealPath: "/ws/p", boxId: "b1" });
  box.setConnected(false);
  assert.equal(manager.get(desktop.id)?.box?.connected, false);
  // The reconcile on reconnect ends with an update of the desktop.
  const reconciled = new Promise<DesktopSummary>((resolve) => manager.once("updated", resolve));
  box.setConnected(true);
  const back = await reconciled;
  assert.equal(back.status, "running");
  assert.equal(back.error, undefined);
  assert.deepEqual(box.killed, [`orqsvc-desktop-${desktop.id}`], "only the stale-session kill before the start");
});

test("a host that came up after its start timed out on a dropped link is killed on the next connect; the desktop stays failed", async (t) => {
  const { appdir, box, manager } = await setup(t, { readyTimeoutMs: 300 });
  box.slowHost = true;
  box.onHostStarted = () => {
    box.onHostStarted = null;
    box.setConnected(false);
  };
  const desktop = await manager.create({ projectPath: "/ws/p", projectRealPath: "/ws/p", boxId: "b1" });
  assert.equal(desktop.status, "error");
  const session = `orqsvc-desktop-${desktop.id}`;
  assert.ok(box.sessions.has(session), "nothing could be killed while the VM was away");
  // It came up after all.
  await atomicWrite(join(appdir, "box-home", ".orquester", "desktops", desktop.id, "ready"), "42\n");
  // The cleanup's last step: the host's group, only while it is still the desktop's.
  const hostSignalled = new Promise<void>((resolve) => (box.onSignal = (s) => s.pgid === 4242 && resolve()));
  box.setConnected(true);
  await hostSignalled;
  assert.ok(box.killed.includes(session));
  assert.equal(box.sessions.has(session), false);
  assert.equal(manager.get(desktop.id)?.status, "error");
  assert.deepEqual(box.signals.find((s) => s.pgid === 4242)?.owner, { argument: join(appdir, "box-home", ".orquester", "desktops", desktop.id) });
});

test("every signal into a VM carries the owner check: app stops, teardown, the host's group", async (t) => {
  const { appdir, box, manager } = await setup(t);
  const desktop = await manager.create({ projectPath: "/ws/p", projectRealPath: "/ws/p", boxId: "b1" });
  const appId = await runningApp(appdir, manager, desktop.id, 901);
  manager.stopApp(desktop.id, appId, true);
  await runningApp(appdir, manager, desktop.id, 902);
  await manager.close(desktop.id);
  assert.ok(box.signals.length >= 3);
  for (const signal of box.signals) assert.ok(signal.owner, JSON.stringify(signal));
  const xauthority = join(appdir, "box-home", ".orquester", "desktops", desktop.id, "Xauthority");
  assert.deepEqual(box.signals.find((s) => s.pgid === 901)?.owner, { environ: `XAUTHORITY=${xauthority}` });
  assert.deepEqual(box.signals.find((s) => s.pgid === 4242)?.owner, { argument: join(appdir, "box-home", ".orquester", "desktops", desktop.id) });
});
