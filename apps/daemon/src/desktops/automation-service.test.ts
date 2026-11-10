import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DESKTOP_AGENT_CONTROL_LAPSE_MS,
  DESKTOP_NOT_RUNNING_CODE,
  type DesktopActionEventPayload,
  type DesktopActionRequest,
  type DesktopActor,
  type DesktopWindow
} from "@orquester/api";
import { DesktopAutomationService } from "./automation-service.ts";
import { FakeDesktopAutomation, fakeScreenshotEncoder } from "./automation-testing.ts";
import type { DesktopAutomationTarget } from "./automation/types.ts";
import { DesktopError } from "./errors.ts";
import { DesktopScreenshotStore } from "./screenshots.ts";

// The automation service against a fake engine (no X server) and a real screenshot store in a
// temp appdir: validation, coordinate mapping, control and the agent-lapse timer, the engine's
// lifecycle. Route-level handoff: http-routes.automation.test.ts.

const CLAUDE: DesktopActor = { kind: "chat", threadId: "t1", label: "Claude" };
const TARGET: DesktopAutomationTarget = { display: 7, connect: async () => { throw new Error("unused"); }, readAuthority: async () => Buffer.alloc(0) };

interface Harness {
  service: DesktopAutomationService;
  engines: FakeDesktopAutomation[];
  windows: DesktopWindow[];
  running: boolean;
  controlChanges: number;
  logged: DesktopActionEventPayload[];
  /** The engine of the last open (asserts there was one). */
  engine(): FakeDesktopAutomation;
}

async function harness(t: TestContext): Promise<Harness> {
  const appdir = await mkdtemp(join(tmpdir(), "orq-desktop-automation-"));
  t.after(() => rm(appdir, { recursive: true, force: true }));
  const h: Harness = {
    service: undefined as never,
    engines: [],
    windows: [],
    running: true,
    controlChanges: 0,
    logged: [],
    engine: () => {
      assert.ok(h.engines.length > 0, "an engine was opened");
      return h.engines.at(-1)!;
    }
  };
  h.service = new DesktopAutomationService({
    open: async () => {
      const engine = new FakeDesktopAutomation();
      h.engines.push(engine);
      return engine;
    },
    encode: fakeScreenshotEncoder,
    screenshots: new DesktopScreenshotStore(appdir, { warn: () => {} }),
    desktop: (id) =>
      id === "d1"
        ? {
            target: () => {
              if (!h.running) throw new DesktopError(409, DESKTOP_NOT_RUNNING_CODE, "The desktop is not running.");
              return TARGET;
            },
            windows: () => h.windows
          }
        : undefined,
    controlChanged: () => {
      h.controlChanges += 1;
    },
    actionLogged: (payload) => h.logged.push(payload),
    logger: { warn: () => {} }
  });
  t.after(() => h.service.shutdown());
  return h;
}

const act = (h: Harness, request: Omit<DesktopActionRequest, "actor"> & { actor?: DesktopActor }) =>
  h.service.run("d1", { actor: CLAUDE, ...request });

async function refusal(promise: Promise<unknown>): Promise<DesktopError> {
  const error = await promise.then(
    () => assert.fail("the action ran"),
    (caught: unknown) => caught
  );
  assert.ok(error instanceof DesktopError, String(error));
  return error;
}

test("an action is checked before anything runs: a misplaced field, a bad value or a missing one opens no engine", async (t) => {
  const h = await harness(t);
  for (const request of [
    { action: "click", x: 10, y: 10, keys: "Return" },
    { action: "scroll", x: 10, y: 10 },
    { action: "move", x: 10 },
    { action: "type", text: "x".repeat(4001) },
    { action: "type", text: "bell\u0007" },
    { action: "click", x: 1, y: 1, maxSize: 640 },
    { action: "screenshot", region: { x: 0, y: 0, width: 10, height: 10 }, windowId: "0x400001" },
    { action: "wait", since: 3 },
    { action: "key", keys: "Return", repeat: 21 },
    // What only the engine knew: no such key, a C1 control character.
    { action: "key", keys: "ctrl+bogus" },
    { action: "type", text: "next\u0085line" },
    { action: "click", actor: { kind: "chat", threadId: "t1", label: "" } }
  ] as const) {
    const error = await refusal(act(h, request as never));
    assert.equal(error.status, 400, JSON.stringify(request));
    assert.equal(error.code, "INVALID_ARGUMENT", JSON.stringify(request));
  }
  assert.equal(h.engines.length, 0);
  assert.equal(h.logged.length, 0, "a malformed request is not an action");
  assert.deepEqual([h.service.control("d1"), h.controlChanges], [null, 0], "nor does it take control");
  // Bounds need the display: checked once the engine is open, before any input.
  const outside = await refusal(act(h, { action: "click", x: 1280, y: 10 }));
  assert.equal(outside.code, "INVALID_ARGUMENT");
  assert.deepEqual(h.engine().input(), []);
  assert.equal((await refusal(h.service.run("nope", { action: "screenshot", actor: CLAUDE }))).status, 404);
});

test("points named by a screenshot map through its scale and origin; after a resize they fail DESKTOP_RESIZED", async (t) => {
  const h = await harness(t);
  h.windows = [{ id: "0x400001", title: "xterm", appId: null, wmClass: null, maximized: false, bounds: { x: 100, y: 50, width: 800, height: 600 } }];
  const shot = await act(h, { action: "screenshot", windowId: "0x400001", maxSize: 400 });
  assert.deepEqual(h.engine().calls[0], { kind: "capture", region: { x: 100, y: 50, width: 800, height: 600 } });
  const info = shot.screenshot!;
  assert.deepEqual([info.width, info.height, info.scale, info.origin], [400, 300, 2, { x: 100, y: 50 }]);
  assert.equal(Buffer.from(info.base64, "base64").toString(), "png:400x300");

  const clicked = await act(h, { action: "click", x: 10, y: 20, screenshotId: info.screenshotId, button: "right" });
  assert.deepEqual(h.engine().input(), [{ kind: "click", x: 120, y: 90, button: 3, count: 1, modifiers: [] }]);
  assert.equal(clicked.summary, "Right-clicked at 120, 90");
  assert.deepEqual(clicked.entry.point, { x: 120, y: 90 });
  assert.equal((await refusal(act(h, { action: "click", x: 400, y: 20, screenshotId: info.screenshotId }))).code, "INVALID_ARGUMENT", "outside the image");

  h.engine().display = { width: 1920, height: 1080 };
  const resized = await refusal(act(h, { action: "drag", x: 10, y: 20, toX: 30, toY: 40, screenshotId: info.screenshotId }));
  assert.deepEqual([resized.status, resized.code], [409, "DESKTOP_RESIZED"]);
  assert.equal(h.engine().input().length, 1, "nothing ran");
  // Display pixels are still fine, and a window without known bounds cannot be cropped to.
  await act(h, { action: "move", x: 1900, y: 1000 });
  h.windows = [{ ...h.windows[0]!, bounds: undefined }];
  assert.match((await refusal(act(h, { action: "screenshot", windowId: "0x400001" }))).message, /window bounds unknown/);
});

test("input is refused while the user has control and reads still run; an agent's control lapses 2 minutes after its last action", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = await harness(t);
  const typed = await act(h, { action: "type", text: "hello\nworld" });
  assert.deepEqual(typed.control, { controller: "agent", actor: CLAUDE, since: typed.control!.since });
  assert.equal(typed.summary, "Typed “hello world”");
  assert.equal(h.controlChanges, 1);

  assert.deepEqual(h.service.setControl("d1", "user"), { controller: "user", actor: CLAUDE, since: h.service.control("d1")!.since });
  const refused = await refusal(act(h, { action: "key", keys: "ctrl+s" }));
  assert.deepEqual([refused.status, refused.code], [409, "DESKTOP_CONTROLLED_BY_USER"]);
  assert.deepEqual(h.engine().input(), [{ kind: "type", text: "hello\nworld" }]);
  assert.equal((await act(h, { action: "screenshot" })).summary, "Took a screenshot");
  assert.deepEqual(
    h.logged.map(({ entry }) => [entry.summary, entry.ok]),
    [["Typed “hello world”", true], ["Could not press Ctrl+S", false], ["Took a screenshot", true]]
  );
  // The user's control never lapses.
  t.mock.timers.tick(DESKTOP_AGENT_CONTROL_LAPSE_MS * 2);
  assert.equal(h.service.control("d1")?.controller, "user");

  assert.equal(h.service.setControl("d1", "agent")?.controller, "agent", "given back to Claude");
  t.mock.timers.tick(DESKTOP_AGENT_CONTROL_LAPSE_MS - 1);
  await act(h, { action: "wait" });
  t.mock.timers.tick(DESKTOP_AGENT_CONTROL_LAPSE_MS - 1);
  assert.equal(h.service.control("d1")?.controller, "agent", "its last action restarted the clock");
  const changes = h.controlChanges;
  t.mock.timers.tick(1);
  assert.equal(h.service.control("d1"), null);
  assert.equal(h.controlChanges, changes + 1, "the lapse goes out as an update");
});

test("the user taking over stops the agent's input in flight: it fails DESKTOP_CONTROLLED_BY_USER", async (t) => {
  const h = await harness(t);
  await act(h, { action: "screenshot" });
  let entered!: () => void;
  const inType = new Promise<void>((resolve) => (entered = resolve));
  let finish!: () => void;
  h.engine().duringType = (signal) =>
    new Promise<void>((resolve, reject) => {
      finish = resolve;
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      entered();
    });
  const typing = act(h, { action: "type", text: "a long text" });
  await inType;
  h.service.setControl("d1", "user");
  // Were the input not stopped, it would end well now.
  finish();
  const stopped = await refusal(typing);
  assert.deepEqual([stopped.status, stopped.code], [409, "DESKTOP_CONTROLLED_BY_USER"]);
  assert.deepEqual(h.logged.at(-1)!.entry.ok, false);
  assert.equal(h.service.control("d1")?.controller, "user");
});

test("one engine per desktop: opened once, replaced after its connection drops, closed when idle 5 minutes or released", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = await harness(t);
  await Promise.all([act(h, { action: "screenshot" }), act(h, { action: "clipboard_get" })]);
  assert.equal(h.engines.length, 1);
  h.engine().closed = true;
  await act(h, { action: "move", x: 1, y: 1 });
  assert.equal(h.engines.length, 2);
  t.mock.timers.tick(5 * 60_000);
  assert.equal(h.engines[1]!.closes, 1, "idle: closed");
  await act(h, { action: "move", x: 2, y: 2 });
  assert.equal(h.engines.length, 3);
  h.service.release("d1");
  h.running = false;
  assert.equal(h.engines[2]!.closes, 1, "released: closed");
  const stopped = await refusal(act(h, { action: "screenshot" }));
  assert.deepEqual([stopped.status, stopped.code], [409, DESKTOP_NOT_RUNNING_CODE]);
  assert.equal(h.engines.length, 3);
});

test("daemon shutdown waits for the automations to close, at most a second", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = await harness(t);
  await act(h, { action: "screenshot" });
  let closed!: () => void;
  h.engine().closing = new Promise<void>((resolve) => (closed = resolve));
  let done = false;
  const shutdown = h.service.shutdown().then(() => (done = true));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(done, false, "the close is still running");
  closed();
  await shutdown;
  assert.equal(h.engine().closes, 1);

  // A close that never ends holds shutdown back for a second only.
  const other = await harness(t);
  await act(other, { action: "screenshot" });
  other.engine().closing = new Promise<void>(() => {});
  const bounded = other.service.shutdown();
  t.mock.timers.tick(1_000);
  await bounded;
});
