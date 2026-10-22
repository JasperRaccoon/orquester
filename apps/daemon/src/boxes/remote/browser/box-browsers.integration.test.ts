/**
 * The VM browser end to end with a real Chromium: the "box" is this machine
 * (`localBoxConnection`), the installer hands back the local Chrome, and the
 * forward is the double's real loopback listener. Skipped without Chrome.
 *
 * The double runs processes but keeps no table of detached ones, so
 * {@link detachedLocalBox} adds `orq-agent`'s: `proc.list`, `proc.signal`,
 * `proc.release` and a watching `attach` over the real child processes.
 */

import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { createConnection, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import type { BoxDetachedProcInfo, BrowserSummary } from "@orquester/api";

import { BrowserManager, VM_DEVTOOLS_REFUSED } from "../../../browsers.ts";
import type { BoxExecOptions, BoxHostForward, BoxProcess } from "../../contracts.ts";
import { localBoxConnection, type LocalBoxConnection } from "../../testing.ts";
import { boxRecord, fakeBoxes } from "../exec/testing.ts";
import { BoxBrowsers, type BoxBrowserInstaller } from "./box-browsers.ts";

const CHROME = "/usr/bin/google-chrome";
const SKIP = existsSync(CHROME) ? false : `${CHROME} is not installed`;
const PROJECT = "/srv/workspaces/acme/vm-app";
const TIMEOUT = 120_000;

interface Detached {
  proc: BoxProcess;
  exited: boolean;
}

interface DetachedLocalBox extends LocalBoxConnection {
  readonly detached: Map<string, Detached>;
  readonly forwards: { forward: BoxHostForward; closed: boolean }[];
  /** Chromium execs, with what the test made each one do. */
  readonly chromeExecs: BoxExecOptions[];
  /** The next Chromium exec is answered by a fake that fails like a missing sandbox. */
  failNextWithSandbox(): void;
}

class WatchingProcess extends EventEmitter implements BoxProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly procId: string;
  constructor(private readonly target: Detached) {
    super();
    this.procId = target.proc.procId ?? "";
    if (target.exited) setImmediate(() => this.emit("exit", target.proc.exitCode, target.proc.signalCode));
    else target.proc.once("exit", (code, signal) => this.emit("exit", code, signal));
  }
  get pid(): number | null {
    return this.target.proc.pid;
  }
  get exitCode(): number | null {
    return this.target.proc.exitCode;
  }
  get signalCode(): NodeJS.Signals | null {
    return this.target.proc.signalCode;
  }
  get killed(): boolean {
    return this.target.proc.killed;
  }
  kill(signal?: NodeJS.Signals): boolean {
    return this.target.proc.kill(signal);
  }
  resize(): void {}
}

/** A process that writes Chromium's sandbox failure and exits, like a box without user namespaces. */
class SandboxFailure extends EventEmitter implements BoxProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = null;
  exitCode: number | null = null;
  readonly signalCode = null;
  readonly killed = false;
  constructor(readonly procId: string) {
    super();
    setImmediate(() => {
      this.stderr.end("[FATAL:zygote_host_impl_linux.cc(128)] No usable sandbox! Update your kernel.\n");
      this.stdout.end();
      this.exitCode = 1;
      this.emit("exit", 1, null);
    });
  }
  kill(): boolean {
    return false;
  }
  resize(): void {}
}

function detachedLocalBox(dataDir: string): DetachedLocalBox {
  const base = localBoxConnection({ boxId: "box-vm", sys: { dataDir } });
  const exec = base.exec.bind(base);
  const forwardToHost = base.forwardToHost.bind(base);
  const request = base.request.bind(base) as (method: string, params: unknown) => Promise<unknown>;
  const detached = new Map<string, Detached>();
  const forwards: DetachedLocalBox["forwards"] = [];
  const chromeExecs: BoxExecOptions[] = [];
  let sandboxFailures = 0;
  const notConnected = (): Error => Object.assign(new Error("Box is not connected"), { code: "BOX_NOT_CONNECTED" });
  const box = base as DetachedLocalBox;
  Object.assign(box, {
    detached,
    forwards,
    chromeExecs,
    failNextWithSandbox: () => (sandboxFailures += 1),
    exec(spec: BoxExecOptions): BoxProcess {
      if (!spec.detach) return exec(spec);
      if (spec.command === CHROME) chromeExecs.push(spec);
      const procId = spec.detach.procId;
      if (spec.command === CHROME && sandboxFailures > 0) {
        if (!box.connected) throw notConnected();
        sandboxFailures -= 1;
        const fake = new SandboxFailure(procId);
        const entry: Detached = { proc: fake, exited: false };
        detached.set(procId, entry);
        fake.once("exit", () => (entry.exited = true));
        return fake;
      }
      const proc = exec(spec);
      const entry: Detached = { proc, exited: false };
      detached.set(procId, entry);
      proc.once("exit", () => (entry.exited = true));
      return proc;
    },
    attach(procId: string): BoxProcess {
      if (!box.connected) throw notConnected();
      const entry = detached.get(procId);
      if (!entry) throw Object.assign(new Error(`UNKNOWN_PROC ${procId}`), { code: "UNKNOWN_PROC" });
      return new WatchingProcess(entry);
    },
    async forwardToHost(boxPort: number, options?: { hostPort?: number }): Promise<BoxHostForward> {
      const forward = await forwardToHost(boxPort, options);
      const entry = { forward, closed: false };
      forwards.push(entry);
      return {
        hostPort: forward.hostPort,
        boxPort: forward.boxPort,
        close: async () => {
          entry.closed = true;
          await forward.close();
        }
      };
    },
    async request(method: string, params: unknown): Promise<unknown> {
      if (method === "proc.list") {
        if (!box.connected) throw notConnected();
        return [...detached].map(([procId, entry]): BoxDetachedProcInfo => ({
          procId,
          pid: entry.exited ? null : entry.proc.pid,
          running: !entry.exited,
          exitCode: entry.proc.exitCode,
          signal: entry.proc.signalCode,
          outputBytes: 0,
          bufferStart: 0
        }));
      }
      if (method === "proc.signal") {
        if (!box.connected) throw notConnected();
        const { procId, signal } = params as { procId: string; signal: NodeJS.Signals };
        detached.get(procId)?.proc.kill(signal);
        return undefined;
      }
      if (method === "proc.release") {
        if (!box.connected) throw notConnected();
        const { procId } = params as { procId: string };
        if (detached.get(procId)?.exited === false) throw Object.assign(new Error("still running"), { code: "BUSY" });
        detached.delete(procId);
        return undefined;
      }
      return request(method, params);
    }
  });
  return box;
}

const installer: BoxBrowserInstaller = {
  ensureBrowser: async (_connection, options) => {
    options?.onProgress?.("chromium is installed");
    return { chromiumPath: CHROME, noSandbox: false };
  }
};

async function rig(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "orq-vm-browser-"));
  const connection = detachedLocalBox(join(dir, "agent"));
  const boxes = fakeBoxes();
  boxes.add(boxRecord("box-vm", { kind: "linux", project: { workspace: "acme", name: "vm-app", path: PROJECT } }), connection);
  const vm = new BoxBrowsers({ registry: boxes.registry, hub: boxes.hub, installer });
  const manager = new BrowserManager({
    indexFile: join(dir, "browsers.json"),
    profilesDir: join(dir, "host-profiles"),
    // No host Chromium: a Linux box project does not need one.
    resolveChromium: () => undefined,
    remoteChrome: (projectPath) => vm.launcherFor(projectPath)
  });
  const page = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end("<!doctype html><title>Box page</title><h1>hello from the box</h1>");
  });
  page.listen(0, "127.0.0.1");
  await once(page, "listening");
  t.after(async () => {
    await vm.stop();
    await manager.shutdown();
    // Whatever a failed assertion left running must not outlive the test.
    for (const entry of connection.detached.values()) if (!entry.exited) entry.proc.kill("SIGKILL");
    page.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { connection, boxes, vm, manager, pageUrl: `http://127.0.0.1:${(page.address() as AddressInfo).port}/` };
}

/** Subscribe; resolves with the first frame once one arrives (the subscribe primes one). */
async function subscribeForFrame(manager: BrowserManager, id: string): Promise<{ frame: Buffer; unsubscribe: () => void }> {
  let resolveFrame!: (frame: Buffer) => void;
  const frame = new Promise<Buffer>((resolve) => (resolveFrame = resolve));
  const unsubscribe = await manager.subscribe(id, {
    onFrame: (jpeg) => resolveFrame(jpeg),
    onState: () => undefined,
    onPicked: () => undefined,
    onEnd: () => undefined
  });
  assert.equal(manager.get(id)?.status, "running", manager.get(id)?.errorMessage);
  return { frame: await frame, unsubscribe };
}

function nextUpdate(manager: BrowserManager, predicate: (summary: BrowserSummary) => boolean): Promise<BrowserSummary> {
  return new Promise((resolve) => {
    const listener = (summary: BrowserSummary): void => {
      if (!predicate(summary)) return;
      manager.lifecycle.off("updated", listener);
      resolve(summary);
    };
    manager.lifecycle.on("updated", listener);
  });
}

function isAlive(pid: number | null): boolean {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function refused(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });
}

/** GET through the forward with a loopback Host (Chromium refuses any other). */
function getThrough(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += String(chunk)));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("a Linux box project's tab runs Chromium in the box: frames, navigation, no DevTools, and nothing left after close", { skip: SKIP, timeout: TIMEOUT }, async (t) => {
  const r = await rig(t);
  const created = await r.manager.create(PROJECT);
  assert.equal(created.runsIn, "box");

  const { frame, unsubscribe } = await subscribeForFrame(r.manager, created.id);
  assert.deepEqual([...frame.subarray(0, 2)], [0xff, 0xd8], "a JPEG frame");
  const [chrome] = r.vm.list();
  assert.ok(chrome, "one Chromium runs in the box");
  const exec = r.connection.chromeExecs.at(-1)!;
  assert.ok(exec.args!.includes("--headless=new") && exec.args!.includes("--remote-debugging-port=0"));
  const proc = r.connection.detached.get(chrome.procId)!.proc;
  assert.ok(isAlive(proc.pid));

  // Navigation reaches the box's localhost (here: this machine's).
  await r.manager.navigate(created.id, "goto", r.pageUrl);
  assert.equal(r.manager.get(created.id)?.title, "Box page");
  assert.equal(r.manager.get(created.id)?.url, r.pageUrl);

  // The CDP endpoint is reached through the forward; DevTools is refused on the daemon's origin
  // even with the tab running (its frontend would be the box's).
  const debugPort = chrome.debugPort;
  const [forward] = r.connection.forwards;
  assert.equal(forward!.forward.hostPort, debugPort);
  const version = await getThrough(debugPort, "/json/version");
  assert.equal(version.status, 200);
  await assert.rejects(r.manager.devtoolsPort(created.id), { statusCode: 409, message: VM_DEVTOOLS_REFUSED });
  await assert.rejects(r.manager.devtoolsEndpoint(created.id), { statusCode: 409, message: VM_DEVTOOLS_REFUSED });

  // The last tab closes: the process ends, is released, and the forward is gone.
  unsubscribe();
  await r.manager.close(created.id);
  assert.notEqual(proc.exitCode ?? proc.signalCode, null, "Chromium exited");
  assert.equal(isAlive(proc.pid), false);
  assert.equal(r.connection.detached.size, 0, "released");
  assert.equal(r.connection.forwards.every((entry) => entry.closed), true);
  assert.equal(await refused(debugPort), true);
  assert.deepEqual(r.vm.list(), []);
});

test("a dropped link evicts the box Chromium; the leftover is stopped on reconnect and Relaunch starts a new one", { skip: SKIP, timeout: TIMEOUT }, async (t) => {
  const r = await rig(t);
  const created = await r.manager.create(PROJECT, r.pageUrl);
  const first = await subscribeForFrame(r.manager, created.id);
  const [chrome] = r.vm.list();
  const leftover = r.connection.detached.get(chrome!.procId)!.proc;

  const lost = nextUpdate(r.manager, (summary) => summary.status === "error");
  r.connection.setConnected(false);
  const summary = await lost;
  assert.equal(summary.errorMessage, "The connection to the VM dropped. Relaunch once it is back.");
  assert.deepEqual(r.vm.list(), [], "evicted");
  assert.equal(r.connection.forwards.every((entry) => entry.closed), true, "its forward is closed");
  assert.ok(isAlive(leftover.pid), "the box process outlives the link, as a detached one does");
  first.unsubscribe();

  r.connection.setConnected(true);
  await r.vm.sweepConnected();
  assert.equal(isAlive(leftover.pid), false, "the reconnect's sweep stopped the leftover");
  assert.equal(r.connection.detached.has(chrome!.procId), false, "and released it");

  // Relaunch: the tab's persisted URL loads again in a new Chromium.
  const reloaded = nextUpdate(r.manager, (next) => next.status === "running" && next.title === "Box page");
  await r.manager.navigate(created.id, "reload");
  const second = await subscribeForFrame(r.manager, created.id);
  await reloaded;
  const [relaunched] = r.vm.list();
  assert.ok(relaunched && relaunched.procId !== chrome!.procId, "a new Chromium");
  second.unsubscribe();
  await r.manager.close(created.id);
  assert.equal(r.connection.detached.size, 0);
});

test("a sandbox failure in the box relaunches unsandboxed and says so; the daemon's shutdown ends it", { skip: SKIP, timeout: TIMEOUT }, async (t) => {
  const r = await rig(t);
  r.connection.failNextWithSandbox();
  const created = await r.manager.create(PROJECT);
  const { unsubscribe } = await subscribeForFrame(r.manager, created.id);
  const [failed, retried] = r.connection.chromeExecs;
  assert.ok(!failed!.args!.includes("--no-sandbox"));
  assert.ok(retried!.args!.includes("--no-sandbox"));
  assert.equal(r.manager.get(created.id)?.sandboxed, false);
  unsubscribe();

  const [chrome] = r.vm.list();
  const proc = r.connection.detached.get(chrome!.procId)!.proc;
  await r.vm.stop();
  assert.equal(isAlive(proc.pid), false, "shutdown ends the box Chromium while the link is up");
  assert.equal(r.connection.detached.size, 0);
  assert.equal(r.connection.forwards.every((entry) => entry.closed), true);
});

test("a Chromium channel that fails after the launch (an output overrun) closes that Chromium instead of crashing the daemon", { skip: SKIP, timeout: TIMEOUT }, async (t) => {
  const r = await rig(t);
  const created = await r.manager.create(PROJECT);
  const { unsubscribe } = await subscribeForFrame(r.manager, created.id);
  const [chrome] = r.vm.list();
  const proc = r.connection.detached.get(chrome!.procId)!.proc;

  const dropped = nextUpdate(r.manager, (summary) => summary.status === "crashed");
  // What the box client emits when orq-agent ends a viewer that fell behind the output buffer.
  (proc as unknown as EventEmitter).emit("error", Object.assign(new Error("the output buffer moved past offset 0"), { code: "OUTPUT_OVERRUN" }));
  await dropped;
  unsubscribe();
  assert.deepEqual(r.vm.list(), []);

  // The tab relaunches on its next subscribe, once the old Chromium is gone: its channel failed,
  // so it was ended by its id (proc.list, attach, SIGKILL) and released.
  const again = await subscribeForFrame(r.manager, created.id);
  assert.equal(isAlive(proc.pid), false);
  assert.equal(r.connection.detached.has(chrome!.procId), false);
  assert.notEqual(r.vm.list()[0]?.procId, chrome!.procId);
  again.unsubscribe();
  await r.manager.close(created.id);
  assert.equal(r.connection.detached.size, 0);
});
