import { test } from "node:test";
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESKTOP_MAX_COMMAND_LENGTH, DESKTOP_UNAVAILABLE_CODE, type DesktopSummary } from "@orquester/api";
import { createDefaultClientConfig, createDefaultDaemonConfig } from "@orquester/config";
import { createServer } from "../index.js";
import { type CreateDesktopInput, DesktopError, type LaunchAppInput } from "./manager.ts";

// Route-level coverage for /api/desktops (desktop spec §7.1), the
// devtools-routes.test.ts way: the real createServer with a stubbed
// services.desktops, so the sandbox, validation and error mapping are the
// daemon's own.

type CreateServerArgs = Parameters<typeof createServer>;

const USERNAME = "admin";
const PASSWORD_HASH = "$2a$12$0123456789012345678901uFAKEfakeFAKEfakeFAKEfa";
const BEARER = `Bearer ${Buffer.from(`${USERNAME}:${PASSWORD_HASH}`).toString("base64")}`;

interface Harness {
  inject: ReturnType<typeof createServer>["inject"];
  root: string;
  project: string;
  calls: { create: CreateDesktopInput[]; launch: Array<{ id: string; input: LaunchAppInput }>; list: Array<string | undefined> };
  createError: Error | null;
}

function summary(projectPath: string): DesktopSummary {
  return {
    id: "d1",
    projectPath,
    title: "Desktop",
    order: 0,
    createdAt: "2026-09-30T00:00:00.000Z",
    display: 1,
    size: { width: 1280, height: 800 },
    renderThreads: 4,
    status: "running",
    audio: "available",
    apps: [],
    windows: [],
    activeWindowId: null
  };
}

async function makeHarness(t: any, mode: "local" | "remote" = "local"): Promise<Harness> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orq-desktop-routes-")));
  const project = join(root, "ws", "proj");
  await mkdir(join(project, "sub"), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  const config = createDefaultDaemonConfig({ env: {} });
  config.transports.http.username = USERNAME;
  config.transports.http.passwordHash = PASSWORD_HASH;
  const resolved = {
    daemonDir: root,
    workspacesDir: root,
    workspacesMetaFile: join(root, "workspaces.json"),
    fsRoot: root
  } as unknown as CreateServerArgs[1];

  const harness: Harness = {
    inject: undefined as never,
    root,
    project,
    calls: { create: [], launch: [], list: [] },
    createError: null
  };
  const known = () => summary(project);
  const desktops = {
    hostStatus: async () => ({ available: true }),
    list: (projectPath?: string) => {
      harness.calls.list.push(projectPath);
      return [known()];
    },
    get: (id: string) => (id === "d1" ? known() : undefined),
    recentLaunches: () => [],
    create: async (input: CreateDesktopInput) => {
      if (harness.createError) throw harness.createError;
      harness.calls.create.push(input);
      return known();
    },
    stop: async (id: string) => {
      if (id !== "d1") throw new DesktopError(404, "DESKTOP_NOT_FOUND", "No such desktop.");
      return known();
    },
    restart: async () => {
      throw new DesktopError(409, "DESKTOP_NOT_STOPPED", "Only a stopped desktop can be restarted.");
    },
    close: async (id: string) => {
      if (id !== "d1") throw new DesktopError(404, "DESKTOP_NOT_FOUND", "No such desktop.");
    },
    launchApp: async (id: string, input: LaunchAppInput) => {
      harness.calls.launch.push({ id, input });
      return { id: "a1", desktopId: id, ...input, status: "starting", exitCode: null, startedAt: "", exitedAt: null };
    },
    stopApp: () => {},
    appLog: async () => "line 1\nline 2\n",
    windowAction: async () => {},
    vncSocketPath: () => null,
    audioSource: () => null
  };
  const services = {
    desktops,
    desktopAudio: { subscribe: () => () => {}, stopDesktop: () => {}, shutdown: () => {} }
  } as unknown as CreateServerArgs[4];
  const app = createServer(
    config,
    resolved,
    createDefaultClientConfig(join(root, "daemon.sock")),
    createWriteStream("/dev/null"),
    services,
    { authRequired: mode === "remote", mode }
  );
  t.after(() => app.close());
  harness.inject = app.inject.bind(app);
  return harness;
}

test("create: projectPath outside the sandbox is 403 and never reaches the manager", async (t) => {
  const h = await makeHarness(t);
  const res = await h.inject({ method: "POST", url: "/api/desktops", payload: { projectPath: "/etc" } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().code, "FS_FORBIDDEN");
  assert.equal(h.calls.create.length, 0);
});

test("create: a missing project directory is 400", async (t) => {
  const h = await makeHarness(t);
  const res = await h.inject({ method: "POST", url: "/api/desktops", payload: { projectPath: join(h.root, "nope") } });
  assert.equal(res.statusCode, 400);
});

test("create: keeps the client's projectPath beside its realpath; a first app's relative cwd resolves against the project", async (t) => {
  const h = await makeHarness(t);
  const res = await h.inject({
    method: "POST",
    url: "/api/desktops",
    payload: {
      projectPath: join(h.project, "sub", ".."),
      title: "Editor",
      size: { width: 1600, height: 900 },
      app: { command: "  xterm  ", cwd: "sub", env: { FOO: "bar" } }
    }
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(h.calls.create, [
    {
      projectPath: join(h.project, "sub", ".."),
      projectRealPath: h.project,
      title: "Editor",
      size: { width: 1600, height: 900 },
      renderThreads: undefined,
      app: { command: "xterm", cwd: join(h.project, "sub"), env: { FOO: "bar" } }
    }
  ]);
});

test("create: 409 DESKTOP_UNAVAILABLE carries the install hint", async (t) => {
  const h = await makeHarness(t);
  const hint = "sudo apt-get install -y tigervnc-standalone-server";
  h.createError = new DesktopError(409, DESKTOP_UNAVAILABLE_CODE, "Desktops need Xvnc on the server.", hint);
  const res = await h.inject({ method: "POST", url: "/api/desktops", payload: { projectPath: h.project } });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.json(), { code: DESKTOP_UNAVAILABLE_CODE, message: "Desktops need Xvnc on the server.", hint });
});

test("launch: cwd escaping the sandbox is 403", async (t) => {
  const h = await makeHarness(t);
  for (const cwd of ["../../../..", "/etc"]) {
    const res = await h.inject({ method: "POST", url: "/api/desktops/d1/apps", payload: { command: "xterm", cwd } });
    assert.equal(res.statusCode, 403, cwd);
  }
  assert.equal(h.calls.launch.length, 0);
});

test("launch: defaults cwd to the project", async (t) => {
  const h = await makeHarness(t);
  const res = await h.inject({ method: "POST", url: "/api/desktops/d1/apps", payload: { command: "xterm" } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(h.calls.launch, [{ id: "d1", input: { command: "xterm", cwd: h.project, env: {} } }]);
});

test("launch: command and env validation (400), never echoing a value", async (t) => {
  const h = await makeHarness(t);
  const bad: unknown[] = [
    {},
    { command: "   " },
    { command: "xterm\nrm -rf /" },
    { command: "xterm\r" },
    { command: "xterm\u0000" },
    { command: "x".repeat(DESKTOP_MAX_COMMAND_LENGTH + 1) },
    { command: "xterm", env: { "BAD-KEY": "v" } },
    { command: "xterm", env: { "1ABC": "v" } },
    { command: "xterm", env: { TOKEN: "sekrit-line-1\nsekrit-line-2" } },
    { command: "xterm", env: { TOKEN: 5 } },
    { command: "xterm", cwd: "a\nb" }
  ];
  for (const payload of bad) {
    const res = await h.inject({ method: "POST", url: "/api/desktops/d1/apps", payload: payload as object });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
    assert.equal(res.json().code, "INVALID_REQUEST");
    assert.doesNotMatch(res.body, /sekrit/);
  }
  assert.equal(h.calls.launch.length, 0);
  const ok = await h.inject({
    method: "POST",
    url: "/api/desktops/d1/apps",
    payload: { command: "x".repeat(DESKTOP_MAX_COMMAND_LENGTH), env: { _A1: "it's $fine" } }
  });
  assert.equal(ok.statusCode, 200);
});

test("unknown desktop ids are 404", async (t) => {
  const h = await makeHarness(t);
  assert.equal((await h.inject({ method: "POST", url: "/api/desktops/nope/apps", payload: { command: "xterm" } })).statusCode, 404);
  assert.equal((await h.inject({ method: "DELETE", url: "/api/desktops/nope" })).statusCode, 404);
  assert.equal((await h.inject({ method: "POST", url: "/api/desktops/nope/stop" })).statusCode, 404);
  assert.equal((await h.inject({ method: "DELETE", url: "/api/desktops/d1" })).statusCode, 204);
});

test("restart of a running desktop is 409", async (t) => {
  const h = await makeHarness(t);
  const res = await h.inject({ method: "POST", url: "/api/desktops/d1/restart" });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().code, "DESKTOP_NOT_STOPPED");
});

test("app log is text/plain", async (t) => {
  const h = await makeHarness(t);
  const res = await h.inject({ method: "GET", url: "/api/desktops/d1/apps/a1/log" });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"] as string, /^text\/plain/);
  assert.equal(res.body, "line 1\nline 2\n");
});

test("window action must be activate, maximize or close", async (t) => {
  const h = await makeHarness(t);
  assert.equal((await h.inject({ method: "POST", url: "/api/desktops/d1/windows/0x1/explode" })).statusCode, 400);
  assert.equal((await h.inject({ method: "POST", url: "/api/desktops/d1/windows/0x1/close" })).statusCode, 204);
});

test("list: projectPath is sandboxed and realpath'd; omitted lists all", async (t) => {
  const h = await makeHarness(t);
  assert.equal((await h.inject({ method: "GET", url: "/api/desktops?projectPath=/etc" })).statusCode, 403);
  await h.inject({ method: "GET", url: `/api/desktops?projectPath=${encodeURIComponent(join(h.project, "sub", ".."))}` });
  await h.inject({ method: "GET", url: "/api/desktops" });
  assert.deepEqual(h.calls.list, [h.project, undefined]);
});

test("suggestions need a sandboxed projectPath", async (t) => {
  const h = await makeHarness(t);
  assert.equal((await h.inject({ method: "GET", url: "/api/desktops/suggestions" })).statusCode, 400);
  assert.equal((await h.inject({ method: "GET", url: "/api/desktops/suggestions?projectPath=/etc" })).statusCode, 403);
  const res = await h.inject({ method: "GET", url: `/api/desktops/suggestions?projectPath=${encodeURIComponent(h.project)}` });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.json()).sort(), ["entries", "executables", "recent"]);
});

test("remote transport: desktop routes need the bearer", async (t) => {
  const h = await makeHarness(t, "remote");
  assert.equal((await h.inject({ method: "GET", url: "/api/desktops" })).statusCode, 401);
  assert.equal((await h.inject({ method: "GET", url: "/api/desktops", headers: { authorization: BEARER } })).statusCode, 200);
});
