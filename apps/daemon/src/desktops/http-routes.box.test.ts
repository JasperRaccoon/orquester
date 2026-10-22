import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { DESKTOP_UNAVAILABLE_CODE, type DesktopHostStatus, type DesktopSummary } from "@orquester/api";
import type { StoredBox } from "@orquester/config";
import type { BoxRegistry, ProjectLocation } from "../boxes/contracts.ts";
import { localBoxConnection, type LocalBoxConnection } from "../boxes/testing.ts";
import { registerDesktopHttpRoutes, type DesktopRoutesService } from "./http-routes.ts";
import type { CreateDesktopInput, LaunchAppInput } from "./manager.ts";

// The desktop routes for box projects (boxes: Linux VM desktops): paths are
// realpath'd in the box and kept inside its project, the host status answers
// for the box, macOS/Windows boxes are refused. The "box" is this machine
// (`localBoxConnection`), so its project folder is a temp dir here.

const HOST: DesktopHostStatus = {
  available: true,
  audioAvailable: true,
  tools: [],
  ffmpegPulse: true,
  ffmpegOpus: true,
  renderNode: false,
  tmuxUsable: true,
  warnings: [],
  installHint: null
};
const BOX: DesktopHostStatus = { ...HOST, available: false, installHint: "Orquester installs the desktop packages in the VM when a desktop opens." };

function summary(projectPath: string, box: DesktopSummary["box"]): DesktopSummary {
  return {
    id: "d1",
    projectPath,
    title: "Desktop",
    order: 0,
    createdAt: "2026-10-22T00:00:00.000Z",
    display: 1,
    size: { width: 1280, height: 800 },
    renderThreads: 4,
    status: "running",
    audio: "unavailable",
    apps: [],
    windows: [],
    activeWindowId: null,
    ...(box ? { box } : {})
  };
}

async function harness(t: TestContext, options: { os?: "linux" | "darwin" | "win32"; desktopBox?: DesktopSummary["box"] | null } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orq-desktop-box-routes-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "ws", "vm");
  const hostProject = join(root, "ws", "local");
  const home = join(root, "box-home");
  await mkdir(join(project, "sub"), { recursive: true });
  await mkdir(hostProject, { recursive: true });
  await mkdir(join(home, ".local", "share", "applications"), { recursive: true });
  const connection: LocalBoxConnection = localBoxConnection({ boxId: "b1", sys: { os: options.os ?? "linux", home } });
  const record = { id: "b1", state: "ready", kind: "linux", project: { path: project } } as unknown as StoredBox;
  const registry = {
    locate: (path: string): ProjectLocation =>
      path === project || path.startsWith(`${project}/`) ? { kind: "box", boxId: "b1", record, connection } : { kind: "host" }
  } as unknown as BoxRegistry;
  const calls = { create: [] as CreateDesktopInput[], launch: [] as LaunchAppInput[], boxStatus: [] as string[], hostStatus: 0 };
  const desktop = summary(project, options.desktopBox === null ? undefined : (options.desktopBox ?? { id: "b1", connected: true }));
  const desktops = {
    hostStatus: async () => {
      calls.hostStatus += 1;
      return HOST;
    },
    boxHostStatus: async (boxId: string) => {
      calls.boxStatus.push(boxId);
      return BOX;
    },
    list: () => [desktop],
    get: (id: string) => (id === "d1" ? desktop : undefined),
    recentLaunches: () => [],
    create: async (input: CreateDesktopInput) => {
      calls.create.push(input);
      return desktop;
    },
    launchApp: async (_id: string, input: LaunchAppInput) => {
      calls.launch.push(input);
      return { id: "a1", desktopId: "d1", ...input, status: "starting", exitCode: null, startedAt: "", exitedAt: null };
    }
  } as unknown as DesktopRoutesService;
  const app = Fastify();
  registerDesktopHttpRoutes(app, { desktops, fsRoot: () => root, boxes: () => registry });
  t.after(() => app.close());
  return { app, root, project, hostProject, home, connection, calls };
}

test("host status: a box project's is its VM's; a host project's and the bare route stay the host's", async (t) => {
  const h = await harness(t);
  const box = await h.app.inject({ method: "GET", url: `/api/desktops/host?projectPath=${encodeURIComponent(h.project)}` });
  assert.equal(box.statusCode, 200);
  assert.deepEqual(box.json(), BOX);
  assert.deepEqual(h.calls.boxStatus, ["b1"]);
  const local = await h.app.inject({ method: "GET", url: `/api/desktops/host?projectPath=${encodeURIComponent(h.hostProject)}` });
  assert.deepEqual(local.json(), HOST);
  assert.deepEqual((await h.app.inject({ method: "GET", url: "/api/desktops/host" })).json(), HOST);
  assert.equal(h.calls.hostStatus, 2);
  const outside = await h.app.inject({ method: "GET", url: `/api/desktops/host?projectPath=${encodeURIComponent("/etc")}` });
  assert.equal(outside.statusCode, 403);
});

test("create in a Linux box project: the project and the first app's cwd are realpath'd and contained in the box", async (t) => {
  const h = await harness(t);
  const res = await h.app.inject({
    method: "POST",
    url: "/api/desktops",
    payload: { projectPath: join(h.project, "sub", ".."), app: { command: "xterm", cwd: "sub" } }
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(h.calls.create.length, 1);
  const input = h.calls.create[0]!;
  assert.equal(input.boxId, "b1");
  assert.equal(input.projectRealPath, h.project);
  assert.equal(input.app?.cwd, join(h.project, "sub"));
  assert.ok(h.connection.calls.some((call) => call.method === "fs.realpath"), "resolved in the box");

  // A link in the project that leads out of it is refused, as the file routes do.
  await symlink(h.root, join(h.project, "out"));
  const escape = await h.app.inject({ method: "POST", url: "/api/desktops", payload: { projectPath: h.project, app: { command: "xterm", cwd: "out" } } });
  assert.equal(escape.statusCode, 403);
  assert.equal(escape.json().code, "FS_FORBIDDEN");
  const notDir = await h.app.inject({ method: "POST", url: "/api/desktops", payload: { projectPath: join(h.project, "missing") } });
  assert.equal(notDir.statusCode, 400);
  assert.equal(h.calls.create.length, 1);
});

test("a box project whose VM is not connected answers 409 BOX_NOT_READY", async (t) => {
  const h = await harness(t);
  h.connection.setConnected(false);
  const res = await h.app.inject({ method: "POST", url: "/api/desktops", payload: { projectPath: h.project } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().code, "BOX_NOT_READY");
  // The tab list still answers from the host (a VM project's tabs list while its VM is away).
  const list = await h.app.inject({ method: "GET", url: `/api/desktops?projectPath=${encodeURIComponent(h.project)}` });
  assert.equal(list.statusCode, 200);
});

test("macOS and Windows box projects are refused: no desktop, no suggestions, a status saying why", async (t) => {
  for (const os of ["darwin", "win32"] as const) {
    const h = await harness(t, { os });
    const create = await h.app.inject({ method: "POST", url: "/api/desktops", payload: { projectPath: h.project } });
    assert.equal(create.statusCode, 409);
    assert.equal(create.json().code, DESKTOP_UNAVAILABLE_CODE);
    assert.match(create.json().message, /only in Linux VMs/);
    const suggestions = await h.app.inject({ method: "GET", url: `/api/desktops/suggestions?projectPath=${encodeURIComponent(h.project)}` });
    assert.equal(suggestions.statusCode, 409);
    const status = (await h.app.inject({ method: "GET", url: `/api/desktops/host?projectPath=${encodeURIComponent(h.project)}` })).json();
    assert.equal(status.available, false);
    assert.equal(status.installHint, null);
    assert.match(status.warnings[0], os === "darwin" ? /macOS/ : /Windows/);
    assert.equal(h.calls.create.length, 0);
    assert.deepEqual(h.calls.boxStatus, []);
  }
});

test("a VM desktop's app cwd is checked in its VM; a desktop that runs elsewhere than its project is refused", async (t) => {
  const h = await harness(t);
  const res = await h.app.inject({ method: "POST", url: "/api/desktops/d1/apps", payload: { command: "xterm", cwd: "sub" } });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(h.calls.launch, [{ command: "xterm", cwd: join(h.project, "sub"), env: {} }]);
  const outside = await h.app.inject({ method: "POST", url: "/api/desktops/d1/apps", payload: { command: "xterm", cwd: h.root } });
  assert.equal(outside.statusCode, 403);

  const mismatched = await harness(t, { desktopBox: null });
  const refused = await mismatched.app.inject({ method: "POST", url: "/api/desktops/d1/apps", payload: { command: "xterm" } });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().code, "DESKTOP_BOX_MISMATCH");
});

test("suggestions of a VM project are the VM's: its user's .desktop apps and the project's executables there", async (t) => {
  const h = await harness(t);
  await writeFile(
    join(h.home, ".local", "share", "applications", "vm-editor.desktop"),
    "[Desktop Entry]\nType=Application\nName=VM Editor\nExec=vm-editor %F\n"
  );
  await mkdir(join(h.project, "bin"));
  await writeFile(join(h.project, "bin", "game"), "#!/bin/sh\n");
  await chmod(join(h.project, "bin", "game"), 0o755);
  const res = await h.app.inject({ method: "GET", url: `/api/desktops/suggestions?projectPath=${encodeURIComponent(h.project)}` });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.ok(body.entries.some((entry: { name: string; command: string; source: string }) => entry.name === "VM Editor" && entry.command === "vm-editor" && entry.source === "user"));
  assert.deepEqual(body.executables, ["bin/game"]);
  assert.ok(h.connection.calls.some((call) => call.method === "fs.readdir"), "read through the box");
});
