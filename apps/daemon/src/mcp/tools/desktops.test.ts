/**
 * get_desktops / control_desktop (unified MCP design 2026-10-15 §4 rows 40–41, ruling S4): the
 * ported desktop tool behaviour over the desktop routes (a FakeDaemonApi), and the chat tiers —
 * open/launch_app Admin with the card naming command, cwd and every env value in full; stop_app, close_window and
 * close Act — through the executor and the approval-port double.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DesktopActionResponse, DesktopAppSummary, DesktopSummary } from "@orquester/api";
import { slimActivityPayload } from "@orquester/api/agent-chat";
import { FakeApprovalPort } from "../catalog/approval-double.ts";
import type { ThreadCaller } from "../catalog/contract.ts";
import { audienceSchema, executeToolCall } from "../executor.ts";
import type { DaemonApi } from "../daemon-api.ts";
import { FakeDaemonApi } from "../testing.ts";
import { desktopPreview, isLoaderEnvKey } from "./desktop-preview.ts";
import { desktopsFamily } from "./desktops.ts";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "mcp-desktop-")));
const GAME = join(ROOT, "acme", "game");
const WEB = join(ROOT, "acme", "web");
const OTHER = join(ROOT, "beta", "app");
for (const dir of [GAME, WEB, OTHER]) mkdirSync(dir, { recursive: true });
test.after(() => rmSync(ROOT, { recursive: true, force: true }));

const stamp = "2026-09-30T12:00:00.000Z";

function app(overrides: Partial<DesktopAppSummary> = {}): DesktopAppSummary {
  return { id: "app-1", desktopId: "dt-1", command: "xterm", cwd: GAME, env: {}, status: "running", exitCode: null, startedAt: stamp, exitedAt: null, ...overrides };
}

function desktop(overrides: Partial<DesktopSummary> = {}): DesktopSummary {
  return {
    id: "dt-1", projectPath: GAME, title: "Desktop", order: 0, createdAt: stamp, display: 1,
    size: { width: 1280, height: 800 }, renderThreads: 4, status: "running", audio: "available",
    apps: [app()], windows: [{ id: "0x400001", title: "xterm", appId: "app-1", wmClass: "XTerm", maximized: false }], activeWindowId: "0x400001", control: null, video: "rfb",
    ...overrides
  };
}

function fakeApi(): FakeDaemonApi {
  const api = new FakeDaemonApi().on("GET", "/api/desktops", { status: 200, body: [desktop({ id: "other", projectPath: OTHER, windows: [], activeWindowId: null }), desktop()] });
  api.fsRoot = api.workspacesDir = ROOT;
  return api;
}

function chat(over: Partial<ThreadCaller> = {}): ThreadCaller {
  return {
    kind: "thread", threadId: "me", title: "Game", projectPath: GAME, workspace: "acme", cwd: GAME, agentId: "claude", callId: "c1",
    runtimeMode: "full-access", planning: false, workflowOwned: false, exchange: null, ...over
  };
}

type Outcome = { ok: true; value: Record<string, unknown> } | { ok: false; code: string; message: string };

async function call(api: FakeDaemonApi, name: string, args: Record<string, unknown>, caller?: ThreadCaller, port = new FakeApprovalPort()): Promise<Outcome> {
  const result: CallToolResult = await executeToolCall(
    { approvals: port },
    { name, arguments: args },
    { caller: caller ?? { kind: "external" }, api, signal: new AbortController().signal }
  );
  const content = result.structuredContent as Record<string, unknown>;
  return result.isError ? { ok: false, code: content.code as string, message: content.message as string } : { ok: true, value: content };
}

async function value(api: FakeDaemonApi, name: string, args: Record<string, unknown>, caller?: ThreadCaller, port?: FakeApprovalPort) {
  const outcome = await call(api, name, args, caller, port);
  assert.ok(outcome.ok, outcome.ok ? "" : `${outcome.code}: ${outcome.message}`);
  return outcome.value;
}

async function refused(api: FakeDaemonApi, name: string, args: Record<string, unknown>, code: string, caller?: ThreadCaller, port?: FakeApprovalPort) {
  const outcome = await call(api, name, args, caller, port);
  assert.ok(!outcome.ok, `${name} succeeded`);
  assert.equal(outcome.code, code, outcome.message);
  return outcome.message;
}

const schema = (name: string) => audienceSchema(desktopsFamily.find((tool) => tool.name === name)!, "external");

// --- Ported behaviour (external callers) ---------------------------------------------------------

test("get_desktops resolves the project to its path, and lists every project's desktops without one", async () => {
  const api = fakeApi();
  assert.deepEqual(await value(api, "get_desktops", { project: "acme/game" }), { desktops: [desktop({ id: "other", projectPath: OTHER, windows: [], activeWindowId: null }), desktop()] });
  assert.deepEqual(api.calls.at(-1), { method: "GET", path: "/api/desktops", query: { projectPath: GAME } });
  await value(api, "get_desktops", {});
  assert.deepEqual(api.calls.at(-1), { method: "GET", path: "/api/desktops" });
  await refused(api, "get_desktops", { project: "acme/missing" }, "PROJECT_NOT_FOUND");
});

test("get_desktops {desktopId} finds the desktop in the full list; an unknown id is NOT_FOUND with a hint; host adds the host status", async () => {
  const api = fakeApi().on("GET", "/api/desktops/host", { status: 200, body: { available: true, installHint: null } });
  assert.deepEqual(await value(api, "get_desktops", { desktopId: "dt-1" }), { desktop: desktop() });
  assert.match(await refused(api, "get_desktops", { desktopId: "nope" }, "NOT_FOUND"), /get_desktops shows/);
  const withHost = await value(api, "get_desktops", { desktopId: "dt-1", host: true });
  assert.deepEqual(withHost.host, { available: true, installHint: null });
  // boxes: the status is asked for the desktop's project (its VM's, for a VM project).
  assert.ok(api.calls.some((c) => c.path === "/api/desktops/host" && (c as { query?: { projectPath?: string } }).query?.projectPath === GAME));
  // A VM project whose VM is offline still gets its desktops, with a status saying why it cannot tell.
  api.on("GET", "/api/desktops/host", { status: 409, body: { code: "BOX_NOT_READY", message: "This project's box is not connected right now." } });
  const offline = await value(api, "get_desktops", { project: "acme/game", host: true });
  assert.ok(Array.isArray(offline.desktops));
  assert.equal((offline.host as { available: boolean }).available, false);
  assert.match((offline.host as { warnings: string[] }).warnings[0]!, /not connected/);
  api.on("GET", "/api/desktops/host", { status: 500, body: { code: "DESKTOP_ERROR", message: "boom" } });
  await refused(api, "get_desktops", { project: "acme/game", host: true }, "DESKTOP_ERROR");
  await refused(api, "get_desktops", { appId: "app-1" }, "INVALID_ARGUMENT");
  await refused(api, "get_desktops", { desktopId: "dt-1", project: "acme/game" }, "INVALID_ARGUMENT");
});

test("get_desktops {desktopId, appId} returns the log, a JSON-looking log as text, and the tail of an oversized one", async () => {
  const api = fakeApi().on("GET", "/api/desktops/dt-1/apps/app-1/log", { status: 200, body: "started\nready\n" });
  assert.deepEqual(await value(api, "get_desktops", { desktopId: "dt-1", appId: "app-1" }), { desktopId: "dt-1", appId: "app-1", text: "started\nready\n" });
  api.on("GET", "/api/desktops/dt-1/apps/app-1/log", { status: 200, body: { level: "info" } });
  assert.equal((await value(api, "get_desktops", { desktopId: "dt-1", appId: "app-1" })).text, "{\"level\":\"info\"}");
  const long = `${"é".repeat(30_000)}THE END`;
  api.on("GET", "/api/desktops/dt-1/apps/app-1/log", { status: 200, body: long });
  const cut = await value(api, "get_desktops", { desktopId: "dt-1", appId: "app-1" });
  assert.equal(cut.truncated, true);
  assert.ok((cut.text as string).endsWith("THE END") && long.endsWith(cut.text as string));
  assert.ok(Buffer.byteLength(JSON.stringify(cut.text)) - 2 <= 50_000);
  api.on("GET", "/api/desktops/dt-1/apps/app-9/log", { status: 404, body: { code: "DESKTOP_APP_NOT_FOUND", message: "No such app" } });
  assert.match(await refused(api, "get_desktops", { desktopId: "dt-1", appId: "app-9" }, "DESKTOP_APP_NOT_FOUND"), /^No such app\. get_desktops/);
});

test("control_desktop open posts the project path, the options and a first app; cwd or env without a command is refused first", async () => {
  const api = fakeApi().on("POST", "/api/desktops", { status: 200, body: desktop() });
  await value(api, "control_desktop", { action: "open", project: "acme/game", title: "Editor", size: { width: 1920, height: 1080 }, renderThreads: 8, command: "./bin/editor --level 2", cwd: "bin", env: { LP_NUM_THREADS: "2" } });
  assert.deepEqual(api.calls.at(-1), {
    method: "POST", path: "/api/desktops",
    body: { projectPath: GAME, title: "Editor", size: { width: 1920, height: 1080 }, renderThreads: 8, app: { command: "./bin/editor --level 2", cwd: "bin", env: { LP_NUM_THREADS: "2" } } }
  });
  await value(api, "control_desktop", { action: "open", project: GAME });
  assert.deepEqual(api.calls.at(-1)!.body, { projectPath: GAME });
  const before = api.calls.length;
  assert.match(await refused(api, "control_desktop", { action: "open", project: "acme/game", cwd: "bin" }, "INVALID_ARGUMENT"), /pass command/);
  assert.match(await refused(api, "control_desktop", { action: "open" }, "INVALID_ARGUMENT"), /needs project/);
  assert.equal(api.calls.length, before, "no request");
});

test("control_desktop's fields per action, and the schema's limits", async () => {
  const api = fakeApi();
  assert.match(await refused(api, "control_desktop", { action: "launch_app", desktopId: "dt-1" }, "INVALID_ARGUMENT"), /needs command/);
  assert.match(await refused(api, "control_desktop", { action: "close", desktopId: "dt-1", force: true }, "INVALID_ARGUMENT"), /takes no force/);
  assert.match(await refused(api, "control_desktop", { action: "stop_app", desktopId: "dt-1" }, "INVALID_ARGUMENT"), /needs appId/);
  const s = schema("control_desktop");
  assert.equal(s.safeParse({ action: "launch_app", desktopId: "dt-1", command: "xterm\nrm -rf ~" }).success, false);
  assert.equal(s.safeParse({ action: "launch_app", desktopId: "dt-1", command: "xterm", env: { "BAD-NAME": "1" } }).success, false);
  assert.equal(s.safeParse({ action: "launch_app", desktopId: "dt-1", command: "x".repeat(4097) }).success, false);
  assert.equal(s.safeParse({ action: "open", project: "acme/game", size: { width: 100, height: 800 } }).success, false);
  assert.equal(s.safeParse({ action: "maximize", desktopId: "dt-1" }).success, false, "activate/maximize are gone");
});

test("a DESKTOP_UNAVAILABLE refusal carries the daemon's install hint", async () => {
  const api = fakeApi().on("POST", "/api/desktops", { status: 409, body: { code: "DESKTOP_UNAVAILABLE", hint: "sudo apt-get install -y tigervnc-standalone-server openbox" } });
  assert.match(
    await refused(api, "control_desktop", { action: "open", project: "acme/game" }, "DESKTOP_UNAVAILABLE"),
    /^Desktops are unavailable on this host\. sudo apt-get install -y tigervnc-standalone-server openbox\. get_desktops \{host: true\}/
  );
});

test("control_desktop launch_app, stop_app (force=1 only when forced), close_window and close reach their routes", async () => {
  const api = fakeApi()
    .on("POST", "/api/desktops/dt-1/apps", { status: 200, body: app({ id: "app-2", command: "glxgears" }) })
    .on("DELETE", "/api/desktops/dt-1/apps/app-1", { status: 204, body: null })
    .on("POST", "/api/desktops/dt-1/windows/0x400001/close", { status: 204, body: null })
    .on("DELETE", "/api/desktops/dt-1", { status: 204, body: null });
  assert.equal(((await value(api, "control_desktop", { action: "launch_app", desktopId: "dt-1", command: "glxgears", env: { vblank_mode: "0" } })).app as DesktopAppSummary).id, "app-2");
  assert.deepEqual(api.calls.at(-1), { method: "POST", path: "/api/desktops/dt-1/apps", body: { command: "glxgears", env: { vblank_mode: "0" } } });
  assert.deepEqual(await value(api, "control_desktop", { action: "stop_app", desktopId: "dt-1", appId: "app-1" }), { stopped: true, desktopId: "dt-1", appId: "app-1", force: false });
  assert.deepEqual(api.calls.at(-1), { method: "DELETE", path: "/api/desktops/dt-1/apps/app-1" });
  await value(api, "control_desktop", { action: "stop_app", desktopId: "dt-1", appId: "app-1", force: true });
  assert.deepEqual(api.calls.at(-1), { method: "DELETE", path: "/api/desktops/dt-1/apps/app-1", query: { force: "1" } });
  assert.deepEqual(await value(api, "control_desktop", { action: "close_window", desktopId: "dt-1", windowId: "0x400001" }), { done: true, desktopId: "dt-1", windowId: "0x400001", action: "close" });
  assert.deepEqual(await value(api, "control_desktop", { action: "close", desktopId: "dt-1" }), { closed: true, desktopId: "dt-1" });
  assert.deepEqual(api.calls.at(-1), { method: "DELETE", path: "/api/desktops/dt-1" });
  assert.match(await refused(api, "control_desktop", { action: "close", desktopId: "gone" }, "NOT_FOUND"), /get_desktops shows/);
});

// --- Chat tiers (ruling S4) ----------------------------------------------------------------------

test("chat: open and launch_app are Admin — a card naming the command, the working directory and every env value in full", async () => {
  const api = fakeApi().on("POST", "/api/desktops", { status: 200, body: desktop() }).on("POST", "/api/desktops/dt-1/apps", { status: 200, body: app() });
  const port = new FakeApprovalPort();
  await value(api, "control_desktop", { action: "open", command: "./run.sh", cwd: "bin", env: { TOKEN: "s3cret", LD_PRELOAD: "/tmp/x.so" }, reason: "to test the UI" }, chat({ runtimeMode: "approval-required" }), port);
  const card = port.cards[0]!;
  assert.equal(card.kind, "admin");
  assert.equal(card.family, "desktops");
  assert.equal(card.reason, "to test the UI");
  assert.match(card.title, /acme\/game/);
  const text = JSON.stringify(card.sections);
  assert.ok(text.includes("./run.sh") && text.includes(join(GAME, "bin")));
  const envSection = card.sections.find((section) => section.kind === "fields" && section.title === "Environment");
  assert.deepEqual(envSection, {
    kind: "fields",
    title: "Environment",
    rows: [
      { label: "LD_PRELOAD", value: "/tmp/x.so" },
      { label: "TOKEN", value: "s3cret" }
    ]
  }, "every env value is shown in full (the agent wrote it)");
  const warning = card.sections.find((section) => section.kind === "warning");
  assert.ok(warning && warning.kind === "warning" && warning.text.includes("LD_PRELOAD"), "a loader key is named in the warning");
  assert.ok(!warning.text.includes("TOKEN"), "a plain key is not");
  assert.deepEqual(card.grantOptions, [], "grants only for Full access");
  assert.deepEqual(api.calls.find((c) => c.method === "POST")!.body, { projectPath: GAME, app: { command: "./run.sh", cwd: "bin", env: { TOKEN: "s3cret", LD_PRELOAD: "/tmp/x.so" } } });
  // Full access: grant options for the caller's project; a desktops grant then covers the next launch.
  await value(api, "control_desktop", { action: "launch_app", desktopId: "dt-1", command: "xterm" }, chat(), port);
  assert.deepEqual(port.cards[1]!.grantOptions, ["chat", "project"]);
  port.grant({ family: "desktops", scope: "project", projectPath: GAME });
  await value(api, "control_desktop", { action: "launch_app", desktopId: "dt-1", command: "xterm" }, chat(), port);
  assert.equal(port.cards.length, 2, "the grant covered it");
});

test("chat: stop_app, close_window and close are Act — no card in the own project; a card in another workspace", async () => {
  const api = fakeApi().on("DELETE", "/api/desktops/*", { status: 204, body: null });
  const port = new FakeApprovalPort();
  await value(api, "control_desktop", { action: "stop_app", desktopId: "dt-1", appId: "app-1" }, chat({ runtimeMode: "approval-required" }), port);
  await value(api, "control_desktop", { action: "close", desktopId: "dt-1" }, chat({ runtimeMode: "approval-required" }), port);
  assert.equal(port.cards.length, 0);
  await value(api, "control_desktop", { action: "close", desktopId: "other" }, chat(), port);
  assert.equal(port.cards.length, 1);
  assert.equal(port.cards[0]!.kind, "boundary");
  assert.match(await refused(api, "control_desktop", { action: "close", desktopId: "dt-1" }, "PERMISSION_DENIED", chat({ planning: true }), port), /planning/);
});

test("chat: a cwd outside every project is refused; a workflow-owned chat cannot open; the own project is the default", async () => {
  const api = fakeApi().on("GET", "/api/desktops", { status: 200, body: [desktop()] });
  assert.match(await refused(api, "control_desktop", { action: "launch_app", desktopId: "dt-1", command: "xterm", cwd: ROOT }, "PERMISSION_DENIED", chat()), /not inside a project/);
  assert.match(await refused(api, "control_desktop", { action: "launch_app", desktopId: "dt-1", command: "xterm", cwd: "../../.." }, "PERMISSION_DENIED", chat()), /not inside a project/);
  await refused(api, "control_desktop", { action: "open" }, "ADMIN_NOT_AVAILABLE", chat({ workflowOwned: true }));
  await value(api, "get_desktops", {}, chat());
  assert.deepEqual(api.calls.at(-1), { method: "GET", path: "/api/desktops", query: { projectPath: GAME } });
  await refused(api, "get_desktops", {}, "INVALID_ARGUMENT", chat({ projectPath: "", workspace: "" }));
});

test("chat: another workspace's desktops are a metadata read (card below Full access); an app's log is content", async () => {
  const api = fakeApi().on("GET", "/api/desktops/dt-1/apps/app-1/log", { status: 200, body: "log" });
  const port = new FakeApprovalPort();
  await value(api, "get_desktops", { project: "beta/app" }, chat({ runtimeMode: "auto" }), port);
  assert.equal(port.cards.at(-1)?.family, "cross-workspace-read");
  await value(api, "get_desktops", { project: "acme/web" }, chat({ runtimeMode: "approval-required" }), port);
  assert.equal(port.cards.length, 1, "same workspace metadata: no card");
  await value(api, "get_desktops", { desktopId: "dt-1", appId: "app-1" }, chat({ runtimeMode: "approval-required" }), port);
  assert.equal(port.cards.length, 1, "own project content: no card");
});

test("desktop card: the loader-key warning covers loaders, runtimes, shells, git hooks and GUI plugins; values stay in full", () => {
  for (const key of [
    "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "DYLD_INSERT_LIBRARIES", "PATH", "GIT_SSH_COMMAND", "GIT_EXEC_PATH", "GIT_CONFIG_KEY_0",
    "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "PROMPT_COMMAND", "BASH_ENV", "ENV", "ZDOTDIR", "DOTNET_STARTUP_HOOKS", "ELECTRON_RUN_AS_NODE",
    "PYTHONSTARTUP", "PYTHONPATH", "PERL5OPT", "RUBYOPT", "NODE_PATH", "NODE_OPTIONS", "GTK_MODULES", "QT_PLUGIN_PATH"
  ]) {
    assert.ok(isLoaderEnvKey(key), key);
  }
  for (const key of ["TOKEN", "vblank_mode", "LP_NUM_THREADS", "HOME_DIR", "path", "MY_PATH", "LDFLAGS"]) assert.ok(!isLoaderEnvKey(key), key);
  const card = desktopPreview({
    action: "launch_app",
    agentId: "claude",
    projectLabel: "acme/game",
    desktop: { id: "dt-1", title: "Editor", apps: [], windows: [] },
    command: "xterm",
    env: { GIT_SSH_COMMAND: "ssh -i /tmp/key -o ProxyCommand='curl x|sh'", ELECTRON_RUN_AS_NODE: "1", LONG: "v".repeat(5_000) }
  });
  const env = card.sections.find((section) => section.kind === "fields" && section.title === "Environment");
  assert.ok(env && env.kind === "fields");
  assert.deepEqual(env.rows.map((row) => [row.label, row.value]), [
    ["ELECTRON_RUN_AS_NODE", "1"],
    ["GIT_SSH_COMMAND", "ssh -i /tmp/key -o ProxyCommand='curl x|sh'"],
    ["LONG", "v".repeat(5_000)]
  ]);
  assert.ok(env.rows.every((row) => row.state === undefined), "no row is mislabelled as a secret");
  const warning = card.sections.find((section) => section.kind === "warning");
  assert.ok(warning && warning.kind === "warning");
  assert.match(warning.text, /^ELECTRON_RUN_AS_NODE, GIT_SSH_COMMAND change which program/);
  // No env: no Environment section, no warning.
  const plain = desktopPreview({ action: "launch_app", agentId: "claude", projectLabel: "acme/game", command: "xterm" });
  assert.ok(!plain.sections.some((section) => (section.kind === "fields" && section.title === "Environment") || section.kind === "warning"));
});

// --- desktop_action (desktop agents spec 2026-11-10 §2.5) -------------------------------------

const CLAUDE_ACTOR = { kind: "chat", threadId: "me", label: "Claude" } as const;

function actionResponse(over: Partial<DesktopActionResponse> = {}): DesktopActionResponse {
  return {
    desktopId: "dt-1", action: "click", summary: "Clicked at 412, 300", seq: 42, display: { width: 1280, height: 800 }, cursor: { x: 412, y: 300 }, control: null,
    entry: { id: "e1", at: stamp, actor: CLAUDE_ACTOR, kind: "click", summary: "Clicked at 412, 300", ok: true },
    ...over
  };
}

test("desktop_action: each action's fields are checked before any call; snake_case becomes the request, with the caller as actor", async () => {
  const api = fakeApi().on("POST", "/api/desktops/dt-1/actions", { status: 200, body: actionResponse() });
  assert.match(await refused(api, "desktop_action", { desktopId: "dt-1", action: "click", x: 1, y: 1, keys: "Return" }, "INVALID_ARGUMENT"), /click takes no keys/);
  assert.match(await refused(api, "desktop_action", { desktopId: "dt-1", action: "drag", x: 1, y: 1 }, "INVALID_ARGUMENT"), /needs to_x/);
  assert.match(await refused(api, "desktop_action", { desktopId: "dt-1", action: "move", x: 1, y: 1, max_size: 640 }, "INVALID_ARGUMENT"), /max_size goes with screenshot/);
  await refused(api, "desktop_action", { desktopId: "dt-1", action: "screenshot", region: { x: 0, y: 0, width: 9, height: 9 }, window_id: "0x1" }, "INVALID_ARGUMENT");
  await refused(api, "desktop_action", { desktopId: "dt-1", action: "click", screenshot_id: "s1" }, "INVALID_ARGUMENT");
  assert.equal(schema("desktop_action").safeParse({ desktopId: "dt-1", action: "click", x: -1, y: 0 }).success, false);
  assert.ok(!api.calls.some((call) => call.method === "POST"), "nothing reached the daemon");

  await value(api, "desktop_action", { desktopId: "dt-1", action: "click", x: 20, y: 30, screenshot_id: "s1", button: "right", count: 2, modifiers: ["ctrl"], screenshot: true, max_size: 640 }, chat());
  assert.deepEqual(api.calls.at(-1), {
    method: "POST", path: "/api/desktops/dt-1/actions",
    body: { action: "click", actor: CLAUDE_ACTOR, x: 20, y: 30, screenshotId: "s1", button: "right", count: 2, modifiers: ["ctrl"], maxSize: 640, screenshot: true }
  });
  await value(api, "desktop_action", { desktopId: "dt-1", action: "wait", for: "change", since: 41, timeout_ms: 5000 });
  assert.deepEqual(api.calls.at(-1)!.body, { action: "wait", actor: { kind: "external", label: "MCP client" }, for: "change", since: 41, timeoutMs: 5000 });
  api.on("POST", "/api/desktops/dt-1/actions", { status: 409, body: { code: "DESKTOP_CONTROLLED_BY_USER", message: "The user has control of this desktop." } });
  assert.match(await refused(api, "desktop_action", { desktopId: "dt-1", action: "type", text: "hi" }, "DESKTOP_CONTROLLED_BY_USER"), /Reads still work/);
});

test("desktop_action goes through DaemonApi.desktopAction with the call's signal: the call going away aborts a wait or a long type", async () => {
  const seen: Array<{ desktopId: string; action: string; signal: AbortSignal | undefined }> = [];
  const desktopAction: NonNullable<DaemonApi["desktopAction"]> = async (desktopId, request, opts) => {
    seen.push({ desktopId, action: request.action, signal: opts?.signal });
    return { status: 200, body: actionResponse({ action: "type", summary: "Typed “hi”" }) };
  };
  const api = Object.assign(fakeApi(), { desktopAction });
  const call = new AbortController();
  const result = await executeToolCall(
    { approvals: new FakeApprovalPort() },
    { name: "desktop_action", arguments: { desktopId: "dt-1", action: "type", text: "hi" } },
    { caller: { kind: "external" }, api, signal: call.signal }
  );
  assert.ok(!result.isError, JSON.stringify(result.structuredContent));
  assert.deepEqual(seen.map(({ desktopId, action }) => [desktopId, action]), [["dt-1", "type"]]);
  assert.ok(!api.calls.some((entry) => entry.method === "POST"), "not posted to the route");
  call.abort();
  assert.equal(seen[0]!.signal?.aborted, true);
});

test("desktop_action tiers: screenshot, wait and clipboard_get are reads (they run while planning); input is Act, with no card in the own project", async () => {
  const api = fakeApi().on("POST", "/api/desktops/dt-1/actions", { status: 200, body: actionResponse({ action: "wait", summary: "Waited 1.2 s for the screen to settle", changed: false, timedOut: false, waitedMs: 1200 }) });
  const port = new FakeApprovalPort();
  for (const action of ["screenshot", "wait", "clipboard_get"]) await value(api, "desktop_action", { desktopId: "dt-1", action }, chat({ planning: true }), port);
  assert.match(await refused(api, "desktop_action", { desktopId: "dt-1", action: "key", keys: "ctrl+s" }, "PERMISSION_DENIED", chat({ planning: true }), port), /planning/);
  const waited = await value(api, "desktop_action", { desktopId: "dt-1", action: "wait" }, chat({ runtimeMode: "approval-required" }), port);
  assert.deepEqual([waited.changed, waited.timed_out, waited.waited_ms, waited.seq], [false, false, 1200, 42]);
  await value(api, "desktop_action", { desktopId: "dt-1", action: "key", keys: "ctrl+s" }, chat({ runtimeMode: "approval-required" }), port);
  assert.equal(port.cards.length, 0);
});

test("desktop_action screenshot: an image block first, its facts in snake_case, and a desktopRef kept through slimming", async () => {
  const shot = { screenshotId: "s9", mimeType: "image/png" as const, width: 640, height: 400, scale: 2, origin: { x: 0, y: 0 }, base64: Buffer.from("png").toString("base64") };
  const api = fakeApi().on("POST", "/api/desktops/dt-1/actions", { status: 200, body: actionResponse({ action: "screenshot", summary: "Took a screenshot", screenshot: shot }) });
  const result = await executeToolCall(
    { approvals: new FakeApprovalPort() },
    { name: "desktop_action", arguments: { desktopId: "dt-1", action: "screenshot" } },
    { caller: chat(), api, signal: new AbortController().signal }
  );
  assert.ok(!result.isError, JSON.stringify(result.structuredContent));
  assert.deepEqual(result.content[0], { type: "image", data: shot.base64, mimeType: "image/png" });
  const content = result.structuredContent as Record<string, unknown>;
  assert.deepEqual(content.screenshot, { screenshot_id: "s9", width: 640, height: 400, scale: 2, origin: { x: 0, y: 0 }, mime_type: "image/png" });
  assert.deepEqual(content.cursor, { x: 412, y: 300 });
  const ref = { desktopId: "dt-1", projectPath: GAME, screenshotId: "s9", action: "screenshot", summary: "Took a screenshot" };
  assert.deepEqual(content.desktopRef, ref);
  const slimmed = slimActivityPayload({ itemType: "mcp_tool_call", data: { sessionTool: { name: "desktop_action" }, result } }) as { data: { sessionTool: { references?: Record<string, unknown> } } };
  assert.deepEqual(slimmed.data.sessionTool.references?.desktopRef, ref);
  assert.ok(!JSON.stringify(slimmed).includes(shot.base64), "the image bytes are not kept");
});
