import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { BrowserStateMessage } from "@orquester/api";
import { WebSocketServer } from "ws";

import { BrowserManager, VM_DEVTOOLS_REFUSED } from "../../../browsers.ts";
import type { BoxConnection } from "../../contracts.ts";
import { boxRecord, fakeAgentConnection, fakeBoxes, type FakeAgentConnection, type FakeProcBehavior } from "../exec/testing.ts";
import {
  BOX_BROWSER_PROC_PREFIX,
  BoxBrowsers,
  connectBoundedTransport,
  projectBrowserHash,
  type BoxBrowserInstaller
} from "./box-browsers.ts";

const PROJECT = "/srv/workspaces/acme/app";
const MAC_PROJECT = "/srv/workspaces/acme/mac";
const HASH = projectBrowserHash(PROJECT);

const installed: BoxBrowserInstaller = {
  ensureBrowser: async (_connection, options) => {
    options?.onProgress?.("apt-get install chromium");
    return { chromiumPath: "/usr/bin/chromium", noSandbox: false };
  }
};

async function rig(
  t: test.TestContext,
  options: {
    /** A scripted detached process; `box` is the rig's connection (to drop its link mid-launch). */
    behavior?: (control: Parameters<FakeProcBehavior>[0], box: FakeAgentConnection) => ReturnType<FakeProcBehavior>;
    /** null: no installer wired. */
    installer?: BoxBrowserInstaller | null;
    launchDeadlineMs?: number;
    reconnectDeadlineMs?: number;
    exitDeadlineMs?: number;
  } = {}
) {
  const dir = await mkdtemp(join(tmpdir(), "orq-box-browsers-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = options.behavior;
  const connection: FakeAgentConnection = fakeAgentConnection({
    boxId: "box-1",
    sys: { dataDir: join(dir, "agent") },
    ...(script ? { behavior: (control: Parameters<FakeProcBehavior>[0]) => script(control, connection) } : {})
  });
  const mac = fakeAgentConnection({ boxId: "box-mac", sys: { os: "darwin" } });
  const boxes = fakeBoxes();
  boxes.add(boxRecord("box-1", { kind: "linux", project: { workspace: "acme", name: "app", path: PROJECT } }), connection);
  boxes.add(boxRecord("box-mac", { kind: "macos", project: { workspace: "acme", name: "mac", path: MAC_PROJECT } }), mac);
  const warnings: string[] = [];
  const vm = new BoxBrowsers({
    registry: boxes.registry,
    hub: boxes.hub,
    ...(options.installer === null ? {} : { installer: options.installer ?? installed }),
    logger: { warn: (message) => warnings.push(message) },
    launchDeadlineMs: options.launchDeadlineMs ?? 5_000,
    reconnectDeadlineMs: options.reconnectDeadlineMs ?? 50,
    exitDeadlineMs: options.exitDeadlineMs ?? 50
  });
  t.after(() => vm.stop());
  const manager = new BrowserManager({
    indexFile: join(dir, "browsers.json"),
    profilesDir: join(dir, "profiles"),
    resolveChromium: () => undefined,
    remoteChrome: (projectPath) => vm.launcherFor(projectPath)
  });
  return { dir, connection, boxes, vm, manager, warnings };
}

/** Subscribe and resolve with the first state the tab reports (an error, in these tests). */
async function firstState(manager: BrowserManager, id: string): Promise<BrowserStateMessage> {
  let state: BrowserStateMessage | null = null;
  const unsubscribe = await manager.subscribe(id, {
    onFrame: () => undefined,
    onState: (next) => (state ??= next),
    onPicked: () => undefined,
    onEnd: () => undefined
  });
  unsubscribe();
  assert.ok(state, "the tab reported a state");
  return state;
}

const chromeExecs = (connection: BoxConnection & { execs: { command: string; args?: string[]; detach?: { procId: string } }[] }) =>
  connection.execs.filter((spec) => spec.detach?.procId.startsWith(BOX_BROWSER_PROC_PREFIX));

test("only a Linux box project's tab runs in the box; it needs no host Chromium, the others still do", async (t) => {
  const r = await rig(t);
  assert.equal(r.vm.runsInBox(PROJECT), true);
  assert.equal(r.vm.runsInBox(`${PROJECT}/sub`), true);
  assert.equal(r.vm.runsInBox(MAC_PROJECT), false);
  assert.equal(r.vm.runsInBox("/srv/workspaces/acme/host-project"), false);
  assert.equal(r.vm.launcherFor(MAC_PROJECT), null);
  r.boxes.update("box-1", { kind: "linux-gpu" });
  assert.equal(r.vm.runsInBox(PROJECT), true);
  r.boxes.update("box-1", { kind: "windows" });
  assert.equal(r.vm.runsInBox(PROJECT), false);
  r.boxes.update("box-1", { kind: "linux" });

  const tab = await r.manager.create(PROJECT, "http://localhost:5173");
  assert.equal(tab.runsIn, "box");
  assert.equal(tab.status, "stopped");
  await assert.rejects(r.manager.create(MAC_PROJECT), { statusCode: 409 });
  await assert.rejects(r.manager.create("/srv/workspaces/acme/host-project"), { statusCode: 409 });
  assert.equal(r.connection.execs.length, 0, "creating a tab starts nothing");
});

test("an installer that cannot install shows its reason and hint on the tab", async (t) => {
  const r = await rig(t, {
    installer: {
      ensureBrowser: async () => {
        throw Object.assign(new Error("No package manager found in the VM."), {
          code: "BOX_GUI_UNAVAILABLE",
          hint: "Use an Ubuntu or Debian image."
        });
      }
    }
  });
  const updates: string[] = [];
  r.manager.lifecycle.on("updated", (summary: { status: string; progress?: string }) => updates.push(`${summary.status}:${summary.progress ?? ""}`));
  const tab = await r.manager.create(PROJECT);
  const state = await firstState(r.manager, tab.id);
  assert.equal(state.status, "error");
  const summary = r.manager.get(tab.id)!;
  assert.equal(summary.errorMessage, "Chromium is not available in the VM: No package manager found in the VM. Use an Ubuntu or Debian image.");
  assert.equal(summary.progress, undefined);
  assert.ok(updates.includes("starting:Preparing Chromium in the VM…"), "the starting step is published");
  assert.equal(chromeExecs(r.connection).length, 0);
});

test("a box that is away fails the launch with a clear message; Relaunch after it is back retries", async (t) => {
  let installs = 0;
  const r = await rig(t, {
    installer: {
      ensureBrowser: async () => {
        installs += 1;
        throw Object.assign(new Error("not wired"), { code: "BOX_GUI_UNAVAILABLE", hint: null });
      }
    }
  });
  const tab = await r.manager.create(PROJECT);
  r.connection.dropLink();
  await firstState(r.manager, tab.id);
  assert.match(r.manager.get(tab.id)!.errorMessage ?? "", /VM is not connected/);
  assert.equal(installs, 0);
  r.connection.restoreLink();
  await r.manager.navigate(tab.id, "reload").catch(() => undefined);
  assert.equal(installs, 1, "the Relaunch tried again");
  assert.equal(r.manager.get(tab.id)!.status, "error", "a failed Relaunch is not left starting");
  assert.equal(r.manager.get(tab.id)!.errorMessage, "Chromium is not available in the VM: not wired.");
});

test("a tab that subscribes while its box is away (a daemon that just started) launches once the box is back", async (t) => {
  let installs = 0;
  const r = await rig(t, {
    reconnectDeadlineMs: 10_000,
    installer: {
      ensureBrowser: async () => {
        installs += 1;
        throw Object.assign(new Error("not wired"), { code: "BOX_GUI_UNAVAILABLE", hint: null });
      }
    }
  });
  const tab = await r.manager.create(PROJECT);
  r.connection.dropLink();
  const waiting = new Promise<void>((resolve) => {
    const onUpdated = (summary: { progress?: string }): void => {
      if (summary.progress !== "Waiting for the VM to connect…") return;
      r.manager.lifecycle.off("updated", onUpdated);
      resolve();
    };
    r.manager.lifecycle.on("updated", onUpdated);
  });
  const state = firstState(r.manager, tab.id);
  await waiting;
  assert.equal(installs, 0, "nothing runs while the box is away");
  r.connection.restoreLink();
  await state;
  assert.equal(installs, 1, "the launch went on once the box was back");
  assert.equal(r.manager.get(tab.id)!.errorMessage, "Chromium is not available in the VM: not wired.");
});

test("a launch waiting for its box ends at once when the box is destroyed", async (t) => {
  const r = await rig(t, { reconnectDeadlineMs: 10_000 });
  const tab = await r.manager.create(PROJECT);
  r.connection.dropLink();
  const state = firstState(r.manager, tab.id);
  r.boxes.update("box-1", { state: "destroyed" });
  assert.equal((await state).status, "error");
  assert.match(r.manager.get(tab.id)!.errorMessage ?? "", /VM was destroyed/);
});

test("a launch stops the project's leftover Chromium first, in its own profile dir under the agent's data dir", async (t) => {
  const r = await rig(t, {
    behavior: (control) => {
      const id = control.spec.detach!.procId;
      if (id.endsWith("-leftover") || id === "other-job") return; // runs until signalled
      control.write("[ERROR:ozone_platform_x11.cc] boom: missing libnss3.so\n", 2);
      control.exit(127);
    }
  });
  // What a crashed daemon left behind: this project's Chromium, another project's, an unrelated job.
  r.connection.exec({ command: "/usr/bin/chromium", detach: { procId: `${BOX_BROWSER_PROC_PREFIX}${HASH}-leftover` } });
  r.connection.exec({ command: "/usr/bin/chromium", detach: { procId: `${BOX_BROWSER_PROC_PREFIX}ffffffffffffffff-leftover` } });
  r.connection.exec({ command: "sleep", detach: { procId: "other-job" } });

  const tab = await r.manager.create(PROJECT);
  await firstState(r.manager, tab.id);
  const message = r.manager.get(tab.id)!.errorMessage ?? "";
  assert.match(message, /exited \(code 127\) before it was ready: \[ERROR:ozone_platform_x11\.cc\] boom: missing libnss3\.so/);

  assert.deepEqual(r.connection.proc(`${BOX_BROWSER_PROC_PREFIX}${HASH}-leftover`), undefined, "the leftover was killed and released");
  assert.ok(r.connection.proc(`${BOX_BROWSER_PROC_PREFIX}ffffffffffffffff-leftover`), "another project's Chromium is not this launch's");
  assert.ok(r.connection.proc("other-job"));
  const signals = r.connection.calls.filter((call) => call.method === "proc.signal").map((call) => call.params);
  assert.deepEqual(signals, [{ procId: `${BOX_BROWSER_PROC_PREFIX}${HASH}-leftover`, signal: "SIGKILL" }]);

  const [spec, ...more] = chromeExecs(r.connection).slice(2);
  assert.equal(more.length, 0, "a failure that is not the sandbox's is not retried");
  const profileDir = join(r.dir, "agent", "browser-profiles", HASH);
  assert.ok(spec!.args!.includes(`--user-data-dir=${profileDir}`));
  assert.ok((await stat(profileDir)).isDirectory());
  assert.equal(r.connection.proc(spec!.detach!.procId), undefined, "the failed start was released");
  assert.deepEqual(r.vm.list(), []);
});

test("a sandbox failure is retried once unsandboxed; a box that cannot sandbox starts unsandboxed", async (t) => {
  const r = await rig(t, {
    behavior: (control) => {
      control.write("[FATAL:zygote_host_impl_linux.cc(127)] No usable sandbox! Update your kernel or see …\n", 2);
      control.exit(null, "SIGTRAP");
    }
  });
  const tab = await r.manager.create(PROJECT);
  await firstState(r.manager, tab.id);
  const execs = chromeExecs(r.connection);
  assert.equal(execs.length, 2);
  assert.ok(!execs[0]!.args!.includes("--no-sandbox"));
  assert.ok(execs[1]!.args!.includes("--no-sandbox"));
  assert.match(r.manager.get(tab.id)!.errorMessage ?? "", /SIGTRAP/);

  const root = await rig(t, {
    installer: { ensureBrowser: async () => ({ chromiumPath: "/opt/chromium/chrome", noSandbox: true }) },
    behavior: (control) => {
      control.write("No usable sandbox!\n", 2);
      control.exit(1);
    }
  });
  const rootTab = await root.manager.create(PROJECT);
  await firstState(root.manager, rootTab.id);
  const rootExecs = chromeExecs(root.connection);
  assert.equal(rootExecs.length, 1, "already unsandboxed: nothing to retry");
  assert.equal(rootExecs[0]!.command, "/opt/chromium/chrome");
  assert.ok(rootExecs[0]!.args!.includes("--no-sandbox"));
});

test("a Chromium that never announces its endpoint fails at the deadline and is killed", async (t) => {
  const r = await rig(t, { launchDeadlineMs: 40, behavior: () => undefined });
  const tab = await r.manager.create(PROJECT);
  await firstState(r.manager, tab.id);
  assert.match(r.manager.get(tab.id)!.errorMessage ?? "", /did not expose a debugging endpoint within 1 s/);
  const [spec] = chromeExecs(r.connection);
  assert.equal(r.connection.proc(spec!.detach!.procId), undefined, "killed and released");
  assert.ok(r.connection.calls.some((call) => call.method === "proc.signal" && (call.params as { signal: string }).signal === "SIGKILL"));
});

test("a box that (re)connects has the Chromiums this daemon does not own stopped", async (t) => {
  const r = await rig(t);
  r.connection.exec({ command: "/usr/bin/chromium", detach: { procId: `${BOX_BROWSER_PROC_PREFIX}${HASH}-a` } });
  r.connection.exec({ command: "/usr/bin/chromium", detach: { procId: `${BOX_BROWSER_PROC_PREFIX}0123456789abcdef-b` } });
  r.connection.exec({ command: "sleep", detach: { procId: "agent-claude-1" } });
  r.connection.dropLink();
  r.connection.restoreLink(); // the hub announces the link back
  await r.vm.sweepConnected(); // queued behind the reconnect's sweep
  assert.equal(r.connection.proc(`${BOX_BROWSER_PROC_PREFIX}${HASH}-a`), undefined);
  assert.equal(r.connection.proc(`${BOX_BROWSER_PROC_PREFIX}0123456789abcdef-b`), undefined);
  assert.ok(r.connection.proc("agent-claude-1"), "other detached processes are left alone");
  assert.deepEqual(r.warnings, []);
});

test("without an installer no tab runs in a box: box projects keep today's host Chromium path", async (t) => {
  const r = await rig(t, { installer: null });
  assert.equal(r.vm.runsInBox(PROJECT), false);
  assert.equal(r.vm.launcherFor(PROJECT), null);
  // No host Chromium here either: the create is refused as for any host-browser project.
  await assert.rejects(r.manager.create(PROJECT), { statusCode: 409 });
});

test("a VM tab never gets DevTools on the daemon's origin", async (t) => {
  const r = await rig(t);
  const tab = await r.manager.create(PROJECT);
  await assert.rejects(r.manager.devtoolsPort(tab.id), { statusCode: 409, message: VM_DEVTOOLS_REFUSED });
  await assert.rejects(r.manager.devtoolsEndpoint(tab.id), { statusCode: 409, message: VM_DEVTOOLS_REFUSED });
  assert.equal(r.connection.execs.length, 0, "and asking starts nothing");
});

test("a sandbox-looking failure is retried only once the first Chromium is known to have ended", async (t) => {
  // It cannot be killed: a second Chromium beside it would fight it for the profile.
  const stuck = await rig(t, {
    launchDeadlineMs: 40,
    behavior: (control) => {
      control.write("No usable sandbox!\n", 2);
      return { onSignal: () => undefined };
    }
  });
  const tab = await stuck.manager.create(PROJECT);
  await firstState(stuck.manager, tab.id);
  assert.equal(chromeExecs(stuck.connection).length, 1, "no retry beside a live first process");
  assert.match(stuck.manager.get(tab.id)!.errorMessage ?? "", /No usable sandbox/);

  // Killed at the deadline: ended, so the unsandboxed retry runs.
  const killed = await rig(t, {
    launchDeadlineMs: 40,
    behavior: (control) => {
      control.write("No usable sandbox!\n", 2);
    }
  });
  const killedTab = await killed.manager.create(PROJECT);
  await firstState(killed.manager, killedTab.id);
  const execs = chromeExecs(killed.connection);
  assert.equal(execs.length, 2);
  assert.ok(execs[1]!.args!.includes("--no-sandbox"));
});

test("a link that drops mid-start is not retried, and the detached process is stopped by id once the link is back", { timeout: 5_000 }, async (t) => {
  // A long exit deadline: a detached process must not be waited on at all.
  const r = await rig(t, {
    exitDeadlineMs: 60_000,
    behavior: (control, box) => {
      control.write("No usable sandbox!\n", 2);
      box.dropLink();
      box.restoreLink();
    }
  });
  const tab = await r.manager.create(PROJECT);
  await firstState(r.manager, tab.id);
  assert.match(r.manager.get(tab.id)!.errorMessage ?? "", /connection to the VM dropped while Chromium was starting/);
  const [spec, ...more] = chromeExecs(r.connection);
  assert.equal(more.length, 0, "a dropped link is not a sandbox failure");
  assert.equal(r.connection.proc(spec!.detach!.procId), undefined, "stopped through an attach and released");
});

test("closing the last tab cancels a launch still installing Chromium, at once", async (t) => {
  let seen: AbortSignal | undefined;
  let entered!: () => void;
  const installing = new Promise<void>((resolve) => (entered = resolve));
  const r = await rig(t, {
    installer: {
      ensureBrowser: (_connection, options) => {
        seen = options?.signal;
        entered();
        return new Promise(() => undefined); // an install that never finishes on its own
      }
    }
  });
  const tab = await r.manager.create(PROJECT);
  const sink = { onFrame: () => undefined, onState: () => undefined, onPicked: () => undefined, onEnd: () => undefined };
  const subscribed = r.manager.subscribe(tab.id, sink);
  await installing;
  await r.manager.close(tab.id);
  assert.equal(seen?.aborted, true, "the installer was told to stop");
  (await subscribed)();
  assert.equal(chromeExecs(r.connection).length, 0, "no Chromium was started");
  assert.deepEqual(r.manager.list(), []);
});

test("closing the last tab while Chromium starts ends that Chromium before the close returns", async (t) => {
  const r = await rig(t, { behavior: () => undefined }); // never announces its endpoint
  const tab = await r.manager.create(PROJECT);
  const started = r.connection.nextExec((spec) => spec.detach?.procId.startsWith(BOX_BROWSER_PROC_PREFIX) ?? false);
  const sink = { onFrame: () => undefined, onState: () => undefined, onPicked: () => undefined, onEnd: () => undefined };
  const subscribed = r.manager.subscribe(tab.id, sink);
  const spec = await started;
  await r.manager.close(tab.id);
  assert.equal(r.connection.proc(spec.detach!.procId), undefined, "killed and released");
  (await subscribed)();
  assert.deepEqual(r.vm.list(), []);
});

test("the CDP socket to a box closes on a message over the cap", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  server.on("connection", (socket) => {
    socket.on("message", () => socket.send("x".repeat(2048)));
  });
  try {
    const transport = await connectBoundedTransport(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/devtools/browser/x`, 1024);
    const closed = new Promise<void>((resolve) => (transport.onclose = resolve));
    transport.onmessage = () => assert.fail("an oversized message is never delivered");
    transport.send("{}");
    await closed;
  } finally {
    server.close();
  }
});
