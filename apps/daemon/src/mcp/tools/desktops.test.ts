import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { DesktopAppSummary, DesktopSummary } from "@orquester/api";
import { ToolError } from "../errors.ts";
import { FakeDaemonApi } from "../testing.ts";
import { DESTRUCTIVE, MUTATING, READ_ONLY, type ToolContext } from "../tool.ts";
import { desktopTools } from "./desktops.ts";

const stamp = "2026-09-30T12:00:00.000Z";
const tool = (name: string) => desktopTools.find((t) => t.name === name)!;
const ctx = (api: FakeDaemonApi): ToolContext => ({ api, todos: {} as never, files: {} as never, signal: new AbortController().signal, now: () => Date.parse(stamp) });
/** Parse as the server does (defaults applied, unknown keys refused), then run. */
const run = (name: string, api: FakeDaemonApi, args: Record<string, unknown>) => tool(name).run(z.object(tool(name).input).strict().parse(args) as never, ctx(api));

async function sandbox(t: { after: (fn: () => Promise<void>) => void }): Promise<FakeDaemonApi> {
  const root = await mkdtemp(join(tmpdir(), "mcp-desktop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "acme", "game"), { recursive: true });
  const api = new FakeDaemonApi();
  api.fsRoot = api.workspacesDir = root;
  return api;
}

function app(overrides: Partial<DesktopAppSummary> = {}): DesktopAppSummary {
  return { id: "app-1", desktopId: "dt-1", command: "xterm", cwd: "/w/acme/game", env: {}, status: "running", exitCode: null, startedAt: stamp, exitedAt: null, ...overrides };
}

function desktop(overrides: Partial<DesktopSummary> = {}): DesktopSummary {
  return {
    id: "dt-1", projectPath: "/w/acme/game", title: "Desktop", order: 0, createdAt: stamp, display: 1,
    size: { width: 1280, height: 800 }, renderThreads: 4, status: "running", audio: "available",
    apps: [app()], windows: [{ id: "0x400001", title: "xterm", appId: "app-1", wmClass: "XTerm", maximized: false }], activeWindowId: "0x400001",
    ...overrides
  };
}

test("the group has the spec's tools and annotations", () => {
  const annotations = Object.fromEntries(desktopTools.map((t) => [t.name, t.annotations]));
  assert.deepEqual(annotations, {
    desktops_list: READ_ONLY,
    desktop_host_status: READ_ONLY,
    desktop_open: MUTATING,
    desktop_launch_app: MUTATING,
    desktop_windows: READ_ONLY,
    desktop_window_action: MUTATING,
    desktop_app_log: READ_ONLY,
    desktop_stop_app: DESTRUCTIVE,
    desktop_close: DESTRUCTIVE
  });
});

test("desktops_list resolves the project to its path, and lists every project's desktops without one", async (t) => {
  const api = await sandbox(t);
  api.on("GET", "/api/desktops", { status: 200, body: [desktop()] });
  const result = await run("desktops_list", api, { projectPath: "acme/game" });
  assert.deepEqual(result, { desktops: [desktop()] });
  assert.deepEqual(api.calls.at(-1), { method: "GET", path: "/api/desktops", query: { projectPath: join(api.workspacesDir, "acme", "game") } });
  await run("desktops_list", api, {});
  assert.deepEqual(api.calls.at(-1), { method: "GET", path: "/api/desktops" });
  await assert.rejects(run("desktops_list", api, { projectPath: "acme/missing" }), (e: unknown) => e instanceof ToolError && e.code === "PROJECT_NOT_FOUND");
});

test("desktop_host_status returns the host report", async () => {
  const host = { available: false, audioAvailable: false, tools: [{ name: "Xvnc", path: null, required: true }], ffmpegPulse: false, ffmpegOpus: false, renderNode: false, tmuxUsable: true, warnings: [], installHint: "sudo apt-get install -y tigervnc-standalone-server" };
  const api = new FakeDaemonApi().on("GET", "/api/desktops/host", { status: 200, body: host });
  assert.deepEqual(await run("desktop_host_status", api, {}), host);
  assert.deepEqual(api.calls, [{ method: "GET", path: "/api/desktops/host" }]);
});

test("desktop_open posts the project path, the options and a first app", async (t) => {
  const api = await sandbox(t);
  api.on("POST", "/api/desktops", ({ body }) => ({ status: 200, body: desktop({ title: (body as { title?: string }).title ?? "Desktop" }) }));
  const result = await run("desktop_open", api, { projectPath: "acme/game", title: "Editor", size: { width: 1920, height: 1080 }, renderThreads: 8, command: "./bin/editor --level 2", cwd: "bin", env: { LP_NUM_THREADS: "2" } });
  assert.equal((result.desktop as DesktopSummary).title, "Editor");
  assert.deepEqual(api.calls.at(-1), {
    method: "POST", path: "/api/desktops",
    body: { projectPath: join(api.workspacesDir, "acme", "game"), title: "Editor", size: { width: 1920, height: 1080 }, renderThreads: 8, app: { command: "./bin/editor --level 2", cwd: "bin", env: { LP_NUM_THREADS: "2" } } }
  });
  await run("desktop_open", api, { projectPath: join(api.workspacesDir, "acme", "game") });
  assert.deepEqual(api.calls.at(-1)!.body, { projectPath: join(api.workspacesDir, "acme", "game") }, "nothing but the project when nothing else is given");
});

test("desktop_open refuses cwd or env without a command, before any request", async (t) => {
  const api = await sandbox(t);
  await assert.rejects(run("desktop_open", api, { projectPath: "acme/game", cwd: "bin" }), (e: unknown) => e instanceof ToolError && e.code === "INVALID_ARGUMENT" && /pass command/.test(e.message));
  assert.equal(api.calls.length, 0);
});

test("the schemas refuse a multi-line command, a bad env name and an out-of-range size", () => {
  const open = z.object(tool("desktop_open").input).strict();
  const launch = z.object(tool("desktop_launch_app").input).strict();
  assert.equal(launch.safeParse({ desktopId: "dt-1", command: "xterm\nrm -rf ~" }).success, false);
  assert.equal(launch.safeParse({ desktopId: "dt-1", command: "xterm", env: { "BAD-NAME": "1" } }).success, false);
  assert.equal(launch.safeParse({ desktopId: "dt-1", command: "x".repeat(4097) }).success, false);
  assert.equal(open.safeParse({ projectPath: "acme/game", size: { width: 100, height: 800 } }).success, false);
  assert.equal(launch.safeParse({ desktopId: "dt-1", command: "xterm", env: { DISPLAY_SCALE: "2" } }).success, true);
});

test("a DESKTOP_UNAVAILABLE refusal carries the daemon's install hint", async (t) => {
  const api = await sandbox(t);
  api.on("POST", "/api/desktops", { status: 409, body: { code: "DESKTOP_UNAVAILABLE", hint: "sudo apt-get install -y tigervnc-standalone-server openbox" } });
  await assert.rejects(run("desktop_open", api, { projectPath: "acme/game" }), (e: unknown) => {
    assert.ok(e instanceof ToolError);
    assert.equal(e.code, "DESKTOP_UNAVAILABLE");
    assert.match(e.message, /^Desktops are unavailable on this host\. sudo apt-get install -y tigervnc-standalone-server openbox\. desktop_host_status/);
    return true;
  });
  api.on("POST", "/api/desktops", { status: 409, body: { code: "DESKTOP_UNAVAILABLE", message: "Xvnc is missing.", hint: "sudo apt-get install -y tigervnc-standalone-server" } });
  await assert.rejects(run("desktop_open", api, { projectPath: "acme/game" }), (e: unknown) => e instanceof ToolError && e.message.startsWith("Xvnc is missing. sudo apt-get install -y tigervnc-standalone-server."));
});

test("desktop_launch_app posts the launch request to the desktop's apps", async () => {
  const api = new FakeDaemonApi().on("POST", "/api/desktops/dt%201/apps", { status: 200, body: app({ id: "app-2", command: "glxgears" }) });
  const result = await run("desktop_launch_app", api, { desktopId: "dt 1", command: "glxgears", env: { vblank_mode: "0" } });
  assert.equal((result.app as DesktopAppSummary).id, "app-2");
  assert.deepEqual(api.calls.at(-1), { method: "POST", path: "/api/desktops/dt%201/apps", body: { command: "glxgears", env: { vblank_mode: "0" } } });
});

test("desktop_windows finds the desktop in the full list; an unknown id is NOT_FOUND with a hint", async () => {
  const api = new FakeDaemonApi().on("GET", "/api/desktops", { status: 200, body: [desktop({ id: "other", windows: [], activeWindowId: null }), desktop()] });
  const result = await run("desktop_windows", api, { desktopId: "dt-1" });
  assert.deepEqual(result, { desktopId: "dt-1", status: "running", windows: desktop().windows, activeWindowId: "0x400001", apps: [{ id: "app-1", command: "xterm", status: "running" }] });
  assert.deepEqual(api.calls.at(-1), { method: "GET", path: "/api/desktops" }, "no projectPath: every project's desktops");
  await assert.rejects(run("desktop_windows", api, { desktopId: "nope" }), (e: unknown) => e instanceof ToolError && e.code === "NOT_FOUND" && /desktops_list/.test(e.message));
});

test("desktop_window_action posts the action to the window", async () => {
  const api = new FakeDaemonApi().on("POST", "/api/desktops/dt-1/windows/0x400001/maximize", { status: 204, body: null });
  const result = await run("desktop_window_action", api, { desktopId: "dt-1", windowId: "0x400001", action: "maximize" });
  assert.deepEqual(result, { done: true, desktopId: "dt-1", windowId: "0x400001", action: "maximize" });
  assert.equal(z.object(tool("desktop_window_action").input).strict().safeParse({ desktopId: "dt-1", windowId: "0x1", action: "minimize" }).success, false);
});

test("desktop_app_log returns the text, a JSON-looking log as text, and the tail of an oversized one", async () => {
  const api = new FakeDaemonApi().on("GET", "/api/desktops/dt-1/apps/app-1/log", { status: 200, body: "started\nready\n" });
  assert.deepEqual(await run("desktop_app_log", api, { desktopId: "dt-1", appId: "app-1" }), { desktopId: "dt-1", appId: "app-1", text: "started\nready\n" });
  api.on("GET", "/api/desktops/dt-1/apps/app-1/log", { status: 200, body: { level: "info" } });
  assert.equal((await run("desktop_app_log", api, { desktopId: "dt-1", appId: "app-1" })).text, "{\"level\":\"info\"}");
  const long = `${"é".repeat(30_000)}THE END`;
  api.on("GET", "/api/desktops/dt-1/apps/app-1/log", { status: 200, body: long });
  const cut = await run("desktop_app_log", api, { desktopId: "dt-1", appId: "app-1" });
  assert.equal(cut.truncated, true);
  const text = cut.text as string;
  assert.ok(text.endsWith("THE END"), "the tail is kept");
  assert.ok(Buffer.byteLength(JSON.stringify(text)) - 2 <= 50_000);
  assert.ok(long.endsWith(text));
  api.on("GET", "/api/desktops/dt-1/apps/app-9/log", { status: 404, body: { code: "DESKTOP_APP_NOT_FOUND", message: "No such app" } });
  await assert.rejects(run("desktop_app_log", api, { desktopId: "dt-1", appId: "app-9" }), (e: unknown) => e instanceof ToolError && e.code === "DESKTOP_APP_NOT_FOUND" && e.message.startsWith("No such app. desktops_list"));
});

test("desktop_stop_app deletes the app, with force=1 only when forced", async () => {
  const api = new FakeDaemonApi().on("DELETE", "/api/desktops/dt-1/apps/app-1", { status: 204, body: null });
  assert.deepEqual(await run("desktop_stop_app", api, { desktopId: "dt-1", appId: "app-1" }), { stopped: true, desktopId: "dt-1", appId: "app-1", force: false });
  assert.deepEqual(api.calls.at(-1), { method: "DELETE", path: "/api/desktops/dt-1/apps/app-1" });
  await run("desktop_stop_app", api, { desktopId: "dt-1", appId: "app-1", force: true });
  assert.deepEqual(api.calls.at(-1), { method: "DELETE", path: "/api/desktops/dt-1/apps/app-1", query: { force: "1" } });
});

test("desktop_close deletes the desktop; the daemon's 404 is NOT_FOUND with a hint", async () => {
  const api = new FakeDaemonApi().on("DELETE", "/api/desktops/dt-1", { status: 204, body: null });
  assert.deepEqual(await run("desktop_close", api, { desktopId: "dt-1" }), { closed: true, desktopId: "dt-1" });
  assert.deepEqual(api.calls.at(-1), { method: "DELETE", path: "/api/desktops/dt-1" });
  await assert.rejects(run("desktop_close", api, { desktopId: "gone" }), (e: unknown) => e instanceof ToolError && e.code === "NOT_FOUND" && /desktops_list shows/.test(e.message));
});
