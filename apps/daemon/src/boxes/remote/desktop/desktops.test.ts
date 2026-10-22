import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { DESKTOP_UNAVAILABLE_CODE, type DesktopHostStatus } from "@orquester/api";
import type { StoredBox } from "@orquester/config";
import { DesktopError } from "../../../desktops/manager.ts";
import type { BoxConnection, BoxExecOptions, BoxHub, BoxProcess, BoxRegistry } from "../../contracts.ts";
import { localBoxConnection, localSysInfo } from "../../testing.ts";
import { BoxDesktopHost } from "./host.ts";
import { BoxDesktops } from "./index.ts";
import { type BoxGuiInstaller, BoxGuiUnavailableError } from "../gui/index.ts";
import { boxDesktopRefusal } from "./suggestions.ts";
import { BOX_DESKTOP_TMUX_SERVER, BoxDesktopTmux } from "./tmux.ts";

// The VM desktop seam's box side against fakes: which boxes have a host, how
// installer refusals read, the in-box tmux's argv and listings, and watches
// across a reconnect. The whole stack for real: vm-desktop.integration.test.ts.

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

type DesktopInstaller = Pick<BoxGuiInstaller, "desktopStatus" | "ensureDesktop">;

function harness(options: { record?: Partial<StoredBox> | null; os?: "linux" | "darwin" | "win32"; installer?: Partial<DesktopInstaller> } = {}) {
  let record = options.record === null ? undefined : ({ id: "b1", state: "ready", kind: "linux", ...options.record } as StoredBox);
  const connection = localBoxConnection({ boxId: "b1", sys: { os: options.os ?? "linux" } });
  const registryListeners = new Set<(boxId: string) => void>();
  const hubListeners = new Set<(boxId: string, connected: boolean) => void>();
  const registry: Pick<BoxRegistry, "get" | "onChange"> = {
    get: (boxId) => (boxId === "b1" ? record : undefined),
    onChange: (listener) => {
      registryListeners.add(listener);
      return () => registryListeners.delete(listener);
    }
  };
  const hub: Pick<BoxHub, "get" | "onConnectionChange"> = {
    get: (boxId) => (boxId === "b1" ? connection : undefined),
    onConnectionChange: (listener) => {
      hubListeners.add(listener);
      return () => hubListeners.delete(listener);
    }
  };
  const installer: DesktopInstaller = {
    desktopStatus: async () => READY,
    ensureDesktop: async () => READY,
    ...options.installer
  };
  const desktops = new BoxDesktops({ registry, hub, installer });
  return {
    desktops,
    connection,
    setRecord: (next: Partial<StoredBox>) => {
      record = { ...record, ...next } as StoredBox;
      for (const listener of registryListeners) listener("b1");
    },
    hubListeners
  };
}

test("only Linux boxes that are not on their way out have a desktop host, one per box", () => {
  const live = harness();
  const host = live.desktops.host("b1");
  assert.ok(host);
  assert.equal(live.desktops.host("b1"), host);
  assert.equal(host.boxId, "b1");
  assert.equal(live.desktops.host("other"), null);
  assert.equal(harness({ record: null }).desktops.host("b1"), null);
  assert.equal(harness({ os: "darwin" }).desktops.host("b1"), null);
  for (const state of ["destroying", "destroy-failed", "destroyed"]) {
    assert.equal(harness({ record: { state } }).desktops.host("b1"), null, state);
  }
});

test("a box going away drops its host; listeners hear every change", () => {
  const h = harness();
  const heard: string[] = [];
  const off = h.desktops.onChange((boxId) => heard.push(boxId));
  assert.ok(h.desktops.host("b1"));
  for (const listener of h.hubListeners) listener("b1", false);
  h.setRecord({ state: "destroyed" });
  assert.deepEqual(heard, ["b1", "b1"]);
  assert.equal(h.desktops.host("b1"), null);
  off();
  for (const listener of h.hubListeners) listener("b1", true);
  assert.equal(heard.length, 2);
});

test("installer refusals become 409 DESKTOP_UNAVAILABLE with their hint; other failures say what failed", async () => {
  const refused = harness({
    installer: {
      ensureDesktop: async () => {
        throw new BoxGuiUnavailableError("No sudo in this VM.", "Run the VM as root.");
      }
    }
  });
  await assert.rejects(refused.desktops.ensure("b1", () => {}), (error: unknown) => {
    assert.ok(error instanceof DesktopError);
    assert.equal(error.status, 409);
    assert.equal(error.code, DESKTOP_UNAVAILABLE_CODE);
    assert.equal(error.message, "No sudo in this VM.");
    assert.equal(error.hint, "Run the VM as root.");
    return true;
  });
  const broken = harness({
    installer: {
      ensureDesktop: async () => {
        throw new Error("apt-get exited 100");
      }
    }
  });
  await assert.rejects(broken.desktops.ensure("b1", () => {}), { status: 500, code: "DESKTOP_INSTALL_FAILED" });
  broken.connection.setConnected(false);
  await assert.rejects(broken.desktops.ensure("b1", () => {}), { status: 409, code: "DESKTOP_BOX_UNREACHABLE" });
  await assert.rejects(broken.desktops.status("b1"), { code: "DESKTOP_BOX_UNREACHABLE" });
  await assert.rejects(harness({ os: "win32" }).desktops.status("b1"), { code: DESKTOP_UNAVAILABLE_CODE });
});

test("progress lines reach the caller", async () => {
  const lines: string[] = [];
  const h = harness({
    installer: {
      ensureDesktop: async (_connection, options) => {
        options?.onProgress?.("Unpacking openbox…");
        return READY;
      }
    }
  });
  assert.deepEqual(await h.desktops.ensure("b1", (line) => lines.push(line)), READY);
  assert.deepEqual(lines, ["Unpacking openbox…"]);
});

test("a refusal is read off its code too (an installer error from elsewhere)", async () => {
  const h = harness({
    installer: {
      ensureDesktop: async () => {
        throw Object.assign(new Error("Unsupported distro."), { code: "BOX_GUI_UNAVAILABLE", hint: null });
      }
    }
  });
  await assert.rejects(h.desktops.ensure("b1", () => {}), { status: 409, code: DESKTOP_UNAVAILABLE_CODE, message: "Unsupported distro.", hint: null });
});

test("desktops need Linux", () => {
  assert.equal(boxDesktopRefusal({ os: "linux" }), null);
  assert.match(boxDesktopRefusal({ os: "darwin" }) ?? "", /Linux VMs.*macOS/);
  assert.match(boxDesktopRefusal({ os: "win32" }) ?? "", /Linux VMs.*Windows/);
});

// ---------------------------------------------------------------------------
// tmux in the box
// ---------------------------------------------------------------------------

/** A box process that exits with `code`, after writing `stdout` / `stderr`. */
function scriptedProcess(stdout: string, stderr: string, code: number): BoxProcess {
  const emitter = new EventEmitter() as EventEmitter & Partial<BoxProcess>;
  const out = new PassThrough();
  const err = new PassThrough();
  Object.assign(emitter, {
    stdin: new PassThrough(),
    stdout: out,
    stderr: err,
    pid: 4242,
    procId: null,
    exitCode: null,
    signalCode: null,
    killed: false,
    kill: () => false,
    resize: () => {}
  });
  setImmediate(() => {
    out.end(stdout);
    err.end(stderr);
    emitter.emit("spawn");
    emitter.emit("exit", code, null);
  });
  return emitter as unknown as BoxProcess;
}

function tmuxConnection(answer: (args: string[]) => { stdout?: string; stderr?: string; code?: number }) {
  const calls: string[][] = [];
  const connection = {
    ...localBoxConnection(),
    exec(options: BoxExecOptions): BoxProcess {
      const args = [options.command, ...(options.args ?? [])];
      calls.push(args);
      const { stdout = "", stderr = "", code = 0 } = answer(args);
      return scriptedProcess(stdout, stderr, code);
    }
  } as BoxConnection;
  return { connection, calls };
}

test("in-box tmux: a private server, argv only, the host's listing rules", async () => {
  const { connection, calls } = tmuxConnection((args) => {
    if (args.includes("list-sessions")) return { stdout: "orqsvc-desktop-a\nother\norqsvc-desktop-b\n" };
    if (args.includes("list-windows")) return { stdout: "123 host\n1 init-is-never-a-pane\n456 app-x y\ngarbled\n" };
    return {};
  });
  const tmux = new BoxDesktopTmux(() => connection);
  assert.deepEqual(await tmux.listServiceSessions("orqsvc-desktop-"), ["orqsvc-desktop-a", "orqsvc-desktop-b"]);
  assert.deepEqual(await tmux.listServiceWindows("orqsvc-desktop-a"), [
    { name: "host", panePid: 123 },
    { name: "app-x y", panePid: 456 }
  ]);
  await tmux.newServiceSession({ name: "orqsvc-desktop-a", windowName: "host", cwd: "/d", env: {}, bin: "/bin/sh", args: ["/s/desktop-host.sh", "/d"] });
  await tmux.newServiceWindow({ session: "orqsvc-desktop-a", name: "app-1", cwd: "/d", env: {}, bin: "/bin/sh", args: ["/s/app-run.sh", "/d", "1"] });
  for (const call of calls) assert.deepEqual(call.slice(0, 3), ["tmux", "-L", BOX_DESKTOP_TMUX_SERVER]);
  assert.deepEqual(calls[2]!.slice(3), ["new-session", "-d", "-s", "orqsvc-desktop-a", "-n", "host", "-c", "/d", "--", "/bin/sh", "/s/desktop-host.sh", "/d"]);
  assert.deepEqual(calls[3]!.slice(3, 6), ["new-window", "-d", "-t"]);
  assert.equal(calls[3]![6], "=orqsvc-desktop-a:");
  await assert.rejects(tmux.listServiceSessions("orq-"), /service session name/);
});

test("in-box tmux: no server is no sessions, a missing tmux too, but any other failure throws", async () => {
  const none = new BoxDesktopTmux(() => tmuxConnection(() => ({ stderr: "no server running on /tmp/tmux-1000/x", code: 1 })).connection);
  assert.deepEqual(await none.listServiceSessions("orqsvc-desktop-"), []);
  assert.deepEqual(await none.listServiceWindows("orqsvc-desktop-a"), []);
  const missing = new BoxDesktopTmux(() => tmuxConnection(() => ({ code: 127 })).connection);
  assert.deepEqual(await missing.listServiceSessions("orqsvc-desktop-"), []);
  const broken = new BoxDesktopTmux(() => tmuxConnection(() => ({ stderr: "server exited unexpectedly", code: 1 })).connection);
  await assert.rejects(broken.listServiceSessions("orqsvc-desktop-"));
  await assert.rejects(broken.newServiceSession({ name: "orqsvc-desktop-a", cwd: "/", env: {}, bin: "/bin/sh", args: [] }), /server exited unexpectedly/);
  // A kill of something gone is no error.
  await broken.killServiceSession("orqsvc-desktop-a");
  const down = localBoxConnection();
  down.setConnected(false);
  await assert.rejects(new BoxDesktopTmux(() => down).listServiceSessions("orqsvc-desktop-"));
});

// ---------------------------------------------------------------------------
// The box host's files and watches
// ---------------------------------------------------------------------------

test("box host files: missing reads are null/empty, a tail is the end, a dir that is a symlink is refused", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orq-boxdesk-host-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const connection = localBoxConnection({ sys: { home: root } });
  const host = new BoxDesktopHost({ boxId: "b1", connection: () => connection });
  assert.equal(host.desktopDir("abc"), join(root, ".orquester", "desktops", "abc"));
  assert.equal(await host.readText(join(root, "nope")), null);
  assert.equal(await host.readTail(join(root, "nope"), 10), "");
  assert.deepEqual(await host.readdir(join(root, "nope")), []);
  await writeFile(join(root, "log"), "0123456789");
  assert.equal(await host.readTail(join(root, "log"), 4), "6789");
  assert.equal(await host.readText(join(root, "log")), "0123456789");
  assert.equal(await host.exists(join(root, "log")), true);

  const dirs = [join(root, "a", "b"), join(root, "c")];
  await host.prepareDirs(dirs);
  for (const dir of dirs) assert.equal(await host.exists(dir), true);
  await mkdir(join(root, "elsewhere"));
  await symlink(join(root, "elsewhere"), join(root, "link"));
  await assert.rejects(host.prepareDirs([join(root, "link")]), /not a directory owned by the VM's user/);

  // The link down: every call refuses at once (and the manager reads that as "unknown", never "absent").
  connection.setConnected(false);
  assert.equal(host.connected, false);
  await assert.rejects(host.readText(join(root, "log")));
  await assert.rejects(host.exists(join(root, "log")));
});

test("box host watch: changes by name, a fresh watch after every reconnect, and unwatch on close", async () => {
  const connection = localBoxConnection();
  const host = new BoxDesktopHost({ boxId: "b1", connection: () => connection });
  const seen: Array<string | null> = [];
  let nextChange: (() => void) | null = null;
  const watch = host.watch(
    "/d",
    (name) => {
      seen.push(name);
      nextChange?.();
    },
    (error) => assert.fail(error)
  );
  const changed = () => new Promise<void>((resolve) => (nextChange = resolve));
  // In place: everything is checked once.
  await changed();
  assert.deepEqual(seen, [null]);
  const watchCall = connection.calls.find((call) => call.method === "fs.watch")!;
  const { watchId } = watchCall.params as { watchId: string };
  assert.deepEqual(watchCall.params, { watchId, path: "/d", recursive: false });

  connection.emitEvent("fs.change", { watchId, changes: [{ path: "/d/ready", type: "create" }, { path: "/d/x/y", type: "update" }, { path: "/d", type: "update" }] });
  connection.emitEvent("fs.change", { watchId: "someone-else", changes: [{ path: "/d/host.exit", type: "create" }] });
  assert.deepEqual(seen, [null, "ready", null]);

  connection.setConnected(false);
  const back = changed();
  connection.setConnected(true);
  await back;
  assert.equal(connection.calls.filter((call) => call.method === "fs.watch").length, 2);
  assert.deepEqual(seen.at(-1), null);

  watch.close();
  assert.ok(connection.calls.some((call) => call.method === "fs.unwatch" && (call.params as { watchId: string }).watchId === watchId));
  connection.emitEvent("fs.change", { watchId, changes: [{ path: "/d/ready", type: "update" }] });
  assert.equal(seen.filter((name) => name === "ready").length, 1);
});

test("box host env: the box's own base, never the host's (no host PATH or NODE_OPTIONS preload)", async () => {
  const connection = localBoxConnection({ sys: localSysInfo({ cpus: 3 }) });
  const host = new BoxDesktopHost({ boxId: "b1", connection: () => connection });
  assert.equal(host.parallelism, 3);
  const layout = { xauthority: "/x/Xauthority", pulseSocket: "/x/pulse/native", clientConf: "/x/client.conf", bus: "/x/bus", runDir: "/x/run" };
  const env = await host.appEnv({ layout: layout as never, display: 7, renderThreads: 2, user: { FOO: "bar" } });
  assert.equal(env.DISPLAY, ":7");
  assert.equal(env.XAUTHORITY, "/x/Xauthority");
  assert.equal(env.FOO, "bar");
  assert.equal(env.PATH, undefined, "PATH stays the box's own (the tmux server's)");
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.HOME, undefined);
});
