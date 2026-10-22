import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { BrowserStateMessage } from "@orquester/api";

import { BrowserManager } from "../../../browsers.ts";
import type { BoxConnection } from "../../contracts.ts";
import { boxRecord, fakeAgentConnection, fakeBoxes, type FakeProcBehavior } from "../exec/testing.ts";
import {
  BOX_BROWSER_PROC_PREFIX,
  BoxBrowsers,
  boxChromiumArgs,
  boxRunsBrowser,
  parseDevtoolsListening,
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
  options: { behavior?: FakeProcBehavior; installer?: BoxBrowserInstaller; launchDeadlineMs?: number } = {}
) {
  const dir = await mkdtemp(join(tmpdir(), "orq-box-browsers-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const connection = fakeAgentConnection({ boxId: "box-1", sys: { dataDir: join(dir, "agent") }, behavior: options.behavior });
  const mac = fakeAgentConnection({ boxId: "box-mac", sys: { os: "darwin" } });
  const boxes = fakeBoxes();
  boxes.add(boxRecord("box-1", { kind: "linux", project: { workspace: "acme", name: "app", path: PROJECT } }), connection);
  boxes.add(boxRecord("box-mac", { kind: "macos", project: { workspace: "acme", name: "mac", path: MAC_PROJECT } }), mac);
  const warnings: string[] = [];
  const vm = new BoxBrowsers({
    registry: boxes.registry,
    hub: boxes.hub,
    installer: options.installer ?? installed,
    logger: { warn: (message) => warnings.push(message) },
    launchDeadlineMs: options.launchDeadlineMs ?? 5_000,
    exitDeadlineMs: 50
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

test("pure helpers: the Linux kinds run the browser, the endpoint line parses, the argv is Chromium's", () => {
  assert.equal(boxRunsBrowser({ kind: "linux" }), true);
  assert.equal(boxRunsBrowser({ kind: "linux-gpu" }), true);
  assert.equal(boxRunsBrowser({ kind: "macos" }), false);
  assert.equal(boxRunsBrowser({ kind: "windows" }), false);
  assert.deepEqual(parseDevtoolsListening("\nDevTools listening on ws://127.0.0.1:40123/devtools/browser/0b1c-2d\n"), {
    port: 40123,
    path: "/devtools/browser/0b1c-2d"
  });
  assert.equal(parseDevtoolsListening("DevTools listening on ws://127.0.0.1:0/devtools/browser/x"), null);
  assert.equal(parseDevtoolsListening("DevTools listening on ws://127.0.0.1:9222/json/version"), null);
  assert.equal(parseDevtoolsListening("[1022/101010.1:ERROR:gpu_init.cc] whatever"), null);
  const args = boxChromiumArgs("/data/browser-profiles/abc", false);
  assert.ok(args.includes("--headless=new") && args.includes("--remote-debugging-port=0"));
  assert.ok(args.includes("--user-data-dir=/data/browser-profiles/abc") && !args.includes("--no-sandbox"));
  assert.ok(boxChromiumArgs("/p", true).includes("--no-sandbox"));
});

test("only a Linux box project's tab runs in the box; it needs no host Chromium, the others still do", async (t) => {
  const r = await rig(t);
  assert.equal(r.vm.runsInBox(PROJECT), true);
  assert.equal(r.vm.runsInBox(`${PROJECT}/sub`), true);
  assert.equal(r.vm.runsInBox(MAC_PROJECT), false);
  assert.equal(r.vm.runsInBox("/srv/workspaces/acme/host-project"), false);
  assert.equal(r.vm.launcherFor(MAC_PROJECT), null);

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
