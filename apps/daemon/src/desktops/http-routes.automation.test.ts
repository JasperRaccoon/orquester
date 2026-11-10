import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopRoutes, type DesktopActionResponse, type DesktopActor, type DesktopHostStatus, type DesktopSummary } from "@orquester/api";
import { createDefaultClientConfig, createDefaultDaemonConfig, desktopsIndexPath } from "@orquester/config";
import { createServer } from "../index.js";
import { testAuthSessions } from "../auth/testing.ts";
import { FakeDesktopAutomation, fakeScreenshotEncoder } from "./automation-testing.ts";
import type { DesktopAutomationTarget } from "./automation/types.ts";
import { DesktopManager, type DesktopManagerOptions, type DesktopTmux } from "./manager.ts";

// The automation routes (spec 2026-11-10 §2.4, §3) on the real createServer with a real
// DesktopManager: a scripted tmux brings the host up at once (as manager.test.ts does) and a fake
// engine stands in for X. Handoff, the log, a kept screenshot's bytes and their auth.

type CreateServerArgs = Parameters<typeof createServer>;

const USERNAME = "admin";
const PASSWORD_HASH = "$2a$12$0123456789012345678901uFAKEfakeFAKEfakeFAKEfa";
const { authSessions: AUTH_SESSIONS, bearer: BEARER } = await testAuthSessions();
const CLAUDE: DesktopActor = { kind: "chat", threadId: "t1", label: "Claude" };

const HOST: DesktopHostStatus = {
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

async function atomicWrite(path: string, value: string): Promise<void> {
  await writeFile(`${path}.tmp`, value);
  await rename(`${path}.tmp`, path);
}

interface Harness {
  inject: ReturnType<typeof createServer>["inject"];
  desktop: DesktopSummary;
  engines: FakeDesktopAutomation[];
  targets: DesktopAutomationTarget[];
  updates: DesktopSummary[];
}

async function harness(t: TestContext, mode: "local" | "remote" = "local"): Promise<Harness> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orq-desktop-automation-routes-")));
  const tmux: DesktopTmux = {
    newServiceSession: async (opts) => atomicWrite(join(opts.cwd, "ready"), "77\n"),
    newServiceWindow: async () => {},
    listServiceSessions: async () => [],
    listServiceWindows: async () => [],
    killServiceSession: async () => {}
  };
  const tracker = {
    on: () => tracker,
    start: async () => {},
    stop: () => {},
    snapshot: () => ({ windows: [], activeWindowId: null })
  };
  const engines: FakeDesktopAutomation[] = [];
  const targets: DesktopAutomationTarget[] = [];
  const manager = new DesktopManager({
    baseDir: root,
    indexFile: desktopsIndexPath(root),
    tmux,
    hostStatus: async () => HOST,
    baseEnv: () => ({ PATH: "/usr/bin:/bin" }),
    renderNode: () => false,
    createTracker: (() => tracker) as unknown as DesktopManagerOptions["createTracker"],
    tmpDir: root,
    logger: { warn: () => {}, error: () => {} },
    openAutomation: async (target) => {
      targets.push(target);
      const engine = new FakeDesktopAutomation();
      engines.push(engine);
      return engine;
    },
    encodeScreenshot: fakeScreenshotEncoder
  });
  t.after(async () => {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  await manager.load();
  const desktop = await manager.create({ projectPath: root, projectRealPath: root });
  assert.equal(desktop.status, "running");
  const updates: DesktopSummary[] = [];
  manager.on("updated", (summary) => updates.push(summary));

  const config = createDefaultDaemonConfig({ env: {} });
  config.transports.http.username = USERNAME;
  config.transports.http.passwordHash = PASSWORD_HASH;
  const resolved = { daemonDir: root, workspacesDir: root, workspacesMetaFile: join(root, "workspaces.json"), fsRoot: root } as unknown as CreateServerArgs[1];
  const services = {
    authSessions: AUTH_SESSIONS,
    desktops: manager,
    desktopAudio: { subscribe: () => () => {}, stopDesktop: () => {}, shutdown: () => {} }
  } as unknown as CreateServerArgs[4];
  const app = createServer(config, resolved, createDefaultClientConfig(join(root, "daemon.sock")), createWriteStream("/dev/null"), services, {
    authRequired: mode === "remote",
    mode
  });
  t.after(() => app.close());
  return { inject: app.inject.bind(app), desktop, engines, targets, updates };
}

const headers = { authorization: BEARER };

test("take over → the agent's input is refused (reads still run) → give back → its input works again", async (t) => {
  const h = await harness(t);
  const id = h.desktop.id;
  const act = (payload: Record<string, unknown>) => h.inject({ method: "POST", url: desktopRoutes.actions(id), payload: { actor: CLAUDE, ...payload } });

  const clicked = await act({ action: "click", x: 412, y: 300 });
  assert.equal(clicked.statusCode, 200, clicked.body);
  assert.equal((clicked.json() as DesktopActionResponse).summary, "Clicked at 412, 300");
  // The engine reaches this machine's display: the X socket and the desktop's own authority file.
  assert.equal(h.targets[0]!.display, 77);
  assert.ok((await h.targets[0]!.readAuthority()).length > 0);
  assert.equal(h.updates.at(-1)?.control?.controller, "agent", "control went out as desktop.updated");

  const takeOver = await h.inject({ method: "PUT", url: desktopRoutes.control(id), payload: { controller: "user" } });
  assert.equal(takeOver.statusCode, 200);
  assert.deepEqual((takeOver.json() as DesktopSummary).control, { controller: "user", actor: CLAUDE, since: (takeOver.json() as DesktopSummary).control!.since });
  const refused = await act({ action: "type", text: "hello" });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.json().code, "DESKTOP_CONTROLLED_BY_USER");
  const shot = await act({ action: "screenshot" });
  assert.equal(shot.statusCode, 200);

  const giveBack = await h.inject({ method: "PUT", url: desktopRoutes.control(id), payload: { controller: "agent" } });
  assert.equal((giveBack.json() as DesktopSummary).control?.controller, "agent");
  assert.equal((await act({ action: "type", text: "hello" })).statusCode, 200);
  assert.deepEqual(h.engines[0]!.input().map((call) => call.kind), ["click", "type"]);

  const log = await h.inject({ method: "GET", url: desktopRoutes.actionLog(id) });
  assert.deepEqual(
    log.json().entries.map((entry: { summary: string; ok: boolean }) => [entry.summary, entry.ok]),
    [["Clicked at 412, 300", true], ["Could not type", false], ["Took a screenshot", true], ["Typed “hello”", true]]
  );
  assert.equal((await h.inject({ method: "PUT", url: desktopRoutes.control(id), payload: { controller: "nobody" } })).statusCode, 400);
  assert.equal((await h.inject({ method: "POST", url: desktopRoutes.actions(id), payload: { action: "click" } })).statusCode, 400, "no actor");
  assert.equal((await h.inject({ method: "POST", url: desktopRoutes.actions("nope"), payload: { action: "screenshot", actor: CLAUDE } })).statusCode, 404);
});

test("a kept screenshot is served with its type and an immutable cache, by ?token= too; nothing else takes the query token", async (t) => {
  const h = await harness(t, "remote");
  const id = h.desktop.id;
  const shot = await h.inject({ method: "POST", url: desktopRoutes.actions(id), headers, payload: { action: "screenshot", actor: CLAUDE } });
  assert.equal(shot.statusCode, 200, shot.body);
  const { screenshotId } = (shot.json() as DesktopActionResponse).screenshot!;
  const token = encodeURIComponent(BEARER.replace(/^Bearer\s+/i, ""));

  const image = await h.inject({ method: "GET", url: `${desktopRoutes.screenshot(id, screenshotId)}?token=${token}` });
  assert.equal(image.statusCode, 200);
  assert.equal(image.headers["content-type"], "image/png");
  assert.equal(image.headers["cache-control"], "private, max-age=31536000, immutable");
  assert.equal(image.body, "png:1280x800");
  assert.equal((await h.inject({ method: "GET", url: desktopRoutes.screenshot(id, screenshotId) })).statusCode, 401, "no token at all");
  assert.equal((await h.inject({ method: "GET", url: `${desktopRoutes.actionLog(id)}?token=${token}` })).statusCode, 401);
  assert.equal(
    (await h.inject({ method: "POST", url: `${desktopRoutes.actions(id)}?token=${token}`, payload: { action: "screenshot", actor: CLAUDE } })).statusCode,
    401
  );
  assert.equal((await h.inject({ method: "GET", url: desktopRoutes.screenshot(id, "unknown"), headers })).statusCode, 404);
});
