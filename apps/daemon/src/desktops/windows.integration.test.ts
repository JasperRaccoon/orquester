// Integration: the window tracker and the raw X11 client against a real Xvnc + Openbox, with
// xterm as the app. Skipped when Xvnc, openbox or xterm is missing. No sleeps: every wait is an
// X event, a tracker event or a process event, bounded by a timeout.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { Readable } from "node:stream";
import { after, before, describe, test } from "node:test";

import type { DesktopSize } from "@orquester/api";

import { DesktopWindowNotFoundError, DesktopWindowTracker, parseWindowId, type DesktopWindowSnapshot } from "./windows.ts";
import { X11Connection, X11SetupError, x11SocketPath } from "./x11/connection.ts";
import { encodeClientMessage, EventMask, type XEvent } from "./x11/protocol.ts";
import { encodeXauthEntry, MIT_MAGIC_COOKIE } from "./x11/xauth.ts";
import { XRES_EXTENSION_NAME } from "./x11/xres.ts";

const WAIT_MS = 15_000;

function onPath(name: string): boolean {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

const missing = ["Xvnc", "openbox", "xterm"].filter((name) => !onPath(name));
const hasXrandr = onPath("xrandr");

/** Resolve with the value `ready()` returns once it is defined, re-checking whenever `subscribe` calls back. */
function waitUntil<T>(
  subscribe: (check: () => void) => () => void,
  ready: () => T | undefined,
  label: string,
  describeState: () => string = () => ""
): Promise<T> {
  return new Promise((resolve, reject) => {
    let unsubscribe = (): void => {};
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out waiting for ${label} ${describeState()}`));
    }, WAIT_MS);
    const check = (): void => {
      const value = ready();
      if (value === undefined) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    };
    unsubscribe = subscribe(check);
    check();
  });
}

function waitForSnapshot(tracker: DesktopWindowTracker, predicate: (s: DesktopWindowSnapshot) => boolean, label: string): Promise<DesktopWindowSnapshot> {
  return waitUntil(
    (check) => {
      tracker.on("change", check);
      return () => tracker.off("change", check);
    },
    () => {
      const snapshot = tracker.snapshot();
      return predicate(snapshot) ? snapshot : undefined;
    },
    label,
    () => JSON.stringify(tracker.snapshot())
  );
}

function waitForEvent<T>(emitter: NodeJS.EventEmitter, name: string, label: string, filter: (value: T) => boolean = () => true): Promise<T> {
  let received: T | undefined;
  return waitUntil(
    (check) => {
      const listener = (value: T): void => {
        if (received === undefined && filter(value)) {
          received = value;
          check();
        }
      };
      emitter.on(name, listener);
      return () => emitter.off(name, listener);
    },
    () => received,
    label
  );
}

function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}

/** Terminate a detached child's whole process group and wait for the child itself to exit. */
async function killGroup(child: ChildProcess | undefined, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const done = exited(child);
  try {
    process.kill(-child.pid, signal);
  } catch {
    return;
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      // already gone
    }
  }, 5_000);
  await done;
  clearTimeout(timer);
}

describe("DesktopWindowTracker against Xvnc + Openbox", { skip: missing.length > 0 ? `missing ${missing.join(", ")}` : false, timeout: 120_000 }, () => {
  let dir: string;
  let xauthorityPath: string;
  let cookie: Buffer;
  let display: number;
  let env: NodeJS.ProcessEnv;
  let xvnc: ChildProcess | undefined;
  let xvncStderr = "";
  let openbox: ChildProcess | undefined;
  const xterms: ChildProcess[] = [];
  let probe: X11Connection;
  const apps = new Map<number, string>();
  let tracker: TestTracker;

  class TestTracker extends DesktopWindowTracker {
    readonly connections: X11Connection[] = [];
    constructor(giveUpMs = 30_000) {
      super({ display, xauthorityPath, appForPgid: (pgid) => apps.get(pgid) ?? null });
      this.reconnectInitialMs = 10;
      this.reconnectMaxMs = 100;
      this.reconnectGiveUpMs = giveUpMs;
    }
    protected override async openConnection(): Promise<X11Connection> {
      const conn = await super.openConnection();
      this.connections.push(conn);
      return conn;
    }
  }

  function startXterm(title: string, appId: string): ChildProcess {
    const child = spawn("xterm", ["-title", title, "-e", "cat"], { env, detached: true, stdio: "ignore" });
    assert.ok(child.pid);
    // detached ⇒ setsid ⇒ the xterm is its own process-group leader.
    apps.set(child.pid, appId);
    xterms.push(child);
    return child;
  }

  const windowOf = (s: DesktopWindowSnapshot, appId: string) => s.windows.find((w) => w.appId === appId);

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "orq-x11-"));
    xauthorityPath = join(dir, "Xauthority");
    cookie = randomBytes(16);
    await writeFile(xauthorityPath, encodeXauthEntry({ family: 0xffff, address: Buffer.alloc(0), number: "", name: MIT_MAGIC_COOKIE, data: cookie }), { mode: 0o600 });
    await mkdir(join(dir, "config"), { mode: 0o700 });

    xvnc = spawn(
      "Xvnc",
      ["-displayfd", "3", "-auth", xauthorityPath, "-rfbunixpath", join(dir, "vnc.sock"), "-rfbunixmode", "0600", "-rfbport", "-1", "-SecurityTypes", "None", "-nolisten", "tcp", "-geometry", "1024x768", "-depth", "24"],
      { env: { PATH: process.env.PATH, HOME: dir }, detached: true, stdio: ["ignore", "ignore", "pipe", "pipe"] }
    );
    xvnc.stderr!.on("data", (chunk: Buffer) => {
      xvncStderr = (xvncStderr + chunk.toString()).slice(-4000);
    });
    const displayFd = xvnc.stdio[3] as Readable;
    let written = "";
    display = await waitUntil<number>(
      (check) => {
        const onData = (chunk: Buffer): void => {
          written += chunk.toString();
          check();
        };
        const onExit = (): void => {
          written += "\nexit";
          check();
        };
        displayFd.on("data", onData);
        xvnc!.on("exit", onExit);
        return () => {
          displayFd.off("data", onData);
          xvnc!.off("exit", onExit);
        };
      },
      () => {
        if (written.endsWith("exit")) throw new Error(`Xvnc exited before reporting a display: ${xvncStderr}`);
        const match = /^(\d+)\n/.exec(written);
        return match ? Number(match[1]) : undefined;
      },
      "Xvnc -displayfd",
      () => xvncStderr
    );

    env = {
      PATH: process.env.PATH,
      HOME: dir,
      DISPLAY: `:${display}`,
      XAUTHORITY: xauthorityPath,
      XDG_CONFIG_HOME: join(dir, "config"),
      XDG_CACHE_HOME: join(dir, "cache"),
      XDG_DATA_HOME: join(dir, "data")
    };

    probe = await X11Connection.connect({ path: x11SocketPath(display), auth: { name: MIT_MAGIC_COOKIE, data: cookie } });

    // Openbox is up once it has set _NET_SUPPORTING_WM_CHECK on the root; subscribe before starting it.
    const wmCheck = await probe.internAtom("_NET_SUPPORTING_WM_CHECK");
    await probe.selectInput(probe.root, EventMask.PropertyChange);
    let managed = false;
    await waitUntil(
      (check) => {
        const onEvent = (event: XEvent): void => {
          if (event.type === "PropertyNotify" && event.atom === wmCheck) managed = true;
          check();
        };
        probe.on("event", onEvent);
        openbox = spawn("openbox", [], { env, detached: true, stdio: "ignore" });
        return () => probe.off("event", onEvent);
      },
      () => (managed ? true : undefined),
      "openbox to manage the display"
    );
  });

  after(async () => {
    tracker?.stop();
    probe?.close();
    await Promise.all(xterms.map((child) => killGroup(child)));
    await killGroup(openbox);
    await killGroup(xvnc);
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test("the server refuses connections without the cookie or with a wrong one", async () => {
    await assert.rejects(X11Connection.connect({ path: x11SocketPath(display), auth: null }), X11SetupError);
    await assert.rejects(X11Connection.connect({ path: x11SocketPath(display), auth: { name: MIT_MAGIC_COOKIE, data: randomBytes(16) } }), X11SetupError);
  });

  let first: string;
  let second: string;
  let firstXterm: ChildProcess;

  test("windows appear with their app, title and class", async () => {
    tracker = new TestTracker();
    await tracker.start();
    assert.deepEqual(tracker.snapshot().windows, []);

    firstXterm = startXterm("orq-one", "app1");
    startXterm("orq-two", "app2");
    const snapshot = await waitForSnapshot(tracker, (s) => windowOf(s, "app1") !== undefined && windowOf(s, "app2") !== undefined, "both xterm windows");
    const one = windowOf(snapshot, "app1")!;
    const two = windowOf(snapshot, "app2")!;
    assert.match(one.id, /^0x[0-9a-f]+$/);
    assert.equal(one.title, "orq-one");
    assert.equal(two.title, "orq-two");
    assert.equal(one.wmClass, "XTerm");
    assert.equal(one.maximized, false);
    first = one.id;
    second = two.id;

    // The mapping came from X-Resource: the server knows the window's owning pid.
    const xres = await probe.queryExtension(XRES_EXTENSION_NAME);
    assert.ok(xres.present);
    assert.equal(await probe.xresClientPid(xres.majorOpcode, parseWindowId(first)!), firstXterm.pid);
  });

  test("activate switches the active window", async () => {
    await tracker.action(second, "activate");
    await waitForSnapshot(tracker, (s) => s.activeWindowId === second, "second window active");
    await tracker.action(first, "activate");
    await waitForSnapshot(tracker, (s) => s.activeWindowId === first, "first window active");
  });

  test("maximize toggles", async () => {
    await tracker.action(first, "maximize");
    await waitForSnapshot(tracker, (s) => s.windows.find((w) => w.id === first)?.maximized === true, "maximized");
    await tracker.action(first, "maximize");
    await waitForSnapshot(tracker, (s) => s.windows.find((w) => w.id === first)?.maximized === false, "restored");
  });

  test("refreshApps re-resolves the app mapping", async () => {
    const pid = [...apps].find(([, app]) => app === "app2")![0];
    apps.set(pid, "app2-renamed");
    const changed = waitForEvent<DesktopWindowSnapshot>(tracker, "change", "change after refreshApps");
    tracker.refreshApps();
    const snapshot = await changed;
    assert.equal(snapshot.windows.find((w) => w.id === second)?.appId, "app2-renamed");
  });

  test("an unknown window id is rejected", async () => {
    await assert.rejects(tracker.action("0x1", "close"), DesktopWindowNotFoundError);
  });

  test("reconnects after the connection drops", async () => {
    const before = tracker.connections.length;
    tracker.connections.at(-1)!.close();
    // Change state behind the tracker's back; it sees it once it has reconnected and re-read.
    const netWmState = await probe.internAtom("_NET_WM_STATE");
    const vert = await probe.internAtom("_NET_WM_STATE_MAXIMIZED_VERT");
    const horz = await probe.internAtom("_NET_WM_STATE_MAXIMIZED_HORZ");
    await probe.sendEvent(false, probe.root, EventMask.SubstructureRedirect | EventMask.SubstructureNotify, encodeClientMessage(parseWindowId(second)!, netWmState, [2, vert, horz, 2, 0]));
    await waitForSnapshot(tracker, (s) => s.windows.find((w) => w.id === second)?.maximized === true, "maximized seen after reconnect");
    assert.equal(tracker.connections.length, before + 1);
    // Actions work on the new connection.
    await tracker.action(second, "maximize");
    await waitForSnapshot(tracker, (s) => s.windows.find((w) => w.id === second)?.maximized === false, "restored after reconnect");
  });

  test("close asks the app to close; the window goes and the app exits", async () => {
    const exit = exited(firstXterm);
    await tracker.action(first, "close");
    await waitForSnapshot(tracker, (s) => !s.windows.some((w) => w.id === first), "window gone");
    await exit;
    assert.ok(tracker.snapshot().windows.some((w) => w.id === second));
  });

  test("a root resize emits resize", { skip: hasXrandr ? false : "xrandr missing" }, async () => {
    const resized = waitForEvent<DesktopSize>(tracker, "resize", "resize event");
    const xrandr = spawn("xrandr", ["-s", "800x600"], { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    xrandr.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    assert.equal(await exited(xrandr), 0, stderr);
    assert.deepEqual(await resized, { width: 800, height: 600 });
  });

  test("stop closes the connection", () => {
    tracker.stop();
    assert.equal(tracker.connections.at(-1)!.isClosed, true);
  });

  test("gives up and emits error when the display is gone for good", async () => {
    const doomed = new TestTracker(300);
    await doomed.start();
    const failed = waitForEvent<Error>(doomed, "error", "give-up error");
    await killGroup(xvnc);
    const error = await failed;
    assert.match(error.message, /could not reconnect/);
    assert.deepEqual(doomed.snapshot(), { windows: [], activeWindowId: null });
    doomed.stop();
  });
});
