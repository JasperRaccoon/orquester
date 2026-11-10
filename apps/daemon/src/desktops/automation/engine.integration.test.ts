// Integration: the automation engine against a real Xvnc (no window manager). The test's own X
// clients draw a known pattern, record the key and button events XTEST produces, and play the other
// side of the clipboard. Skipped when Xvnc is missing. No sleeps: every wait is an X event, a
// reply or a process event, bounded by a timeout.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { Readable } from "node:stream";
import { after, before, describe, test } from "node:test";

import { X11Connection, x11SocketPath } from "../x11/connection.ts";
import {
  AnyPropertyType,
  CurrentTime,
  encodeChangeProperty,
  encodeConvertSelection,
  encodeCreateWindow,
  encodeSelectionNotify,
  encodeSetSelectionOwner,
  EventMask,
  PropertyMode,
  WindowClass,
  type KeyboardMapping,
  type XEvent
} from "../x11/protocol.ts";
import { encodeXauthEntry, MIT_MAGIC_COOKIE } from "../x11/xauth.ts";
import { openDesktopAutomation } from "./engine.ts";
import { pixelsToRgb } from "./pixels.ts";
import type { DesktopAutomation } from "./types.ts";

const WAIT_MS = 15_000;
const WIDTH = 1024;
const HEIGHT = 768;

function onPath(name: string): boolean {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

/** Resolve with the first event on `conn` that `pick` maps to a value. */
function nextEvent<T>(conn: X11Connection, pick: (event: XEvent) => T | undefined, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      conn.off("event", onEvent);
      reject(new Error(`timed out waiting for ${label}`));
    }, WAIT_MS);
    const onEvent = (event: XEvent): void => {
      const value = pick(event);
      if (value === undefined) return;
      clearTimeout(timer);
      conn.off("event", onEvent);
      resolve(value);
    };
    conn.on("event", onEvent);
  });
}

async function killGroup(child: ChildProcess | undefined): Promise<void> {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    return;
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      // already gone
    }
  }, 5_000);
  await exited;
  clearTimeout(timer);
}

const mapWindow = (window: number): Buffer => {
  const buf = Buffer.alloc(8);
  buf.writeUInt8(8, 0); // MapWindow
  buf.writeUInt16LE(2, 2);
  buf.writeUInt32LE(window, 4);
  return buf;
};

const setInputFocus = (window: number): Buffer => {
  const buf = Buffer.alloc(12);
  buf.writeUInt8(42, 0); // SetInputFocus, revert-to Parent
  buf.writeUInt8(2, 1);
  buf.writeUInt16LE(3, 2);
  buf.writeUInt32LE(window, 4);
  return buf;
};

/** The pixel value of an RGB colour in the root visual. */
function pixelOf(conn: X11Connection, [r, g, b]: readonly number[]): number {
  const visual = conn.setup.screens[0]!.rootVisual!;
  const channel = (mask: number, value: number): number => {
    let shift = 0;
    while (((mask >>> shift) & 1) === 0) shift++;
    const max = mask >>> shift;
    return (Math.round((value * max) / 255) << shift) >>> 0;
  };
  return (channel(visual.redMask, r!) | channel(visual.greenMask, g!) | channel(visual.blueMask, b!)) >>> 0;
}

/** Translate a KeyPress as a client would: the keysym at the shifted level when Shift is down (core rules for a lone letter). */
function keysymOf(mapping: KeyboardMapping, minKeycode: number, keycode: number, state: number): number {
  const at = (keycode - minKeycode) * mapping.keysymsPerKeycode;
  const first = mapping.keysyms[at]!;
  let second = mapping.keysyms[at + 1] ?? 0;
  if (second === 0) second = first >= 0x61 && first <= 0x7a ? first - 0x20 : first;
  return state & 1 ? second : first;
}

describe("DesktopAutomation against Xvnc", { skip: onPath("Xvnc") ? false : "missing Xvnc" }, () => {
  let dir: string;
  let xauthorityPath: string;
  let display: number;
  let xvnc: ChildProcess | undefined;
  let xvncStderr = "";
  /** The test's own X client: draws, listens, and plays the other clipboard party. */
  let client: X11Connection;
  let engine: DesktopAutomation;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "orq-automation-"));
    xauthorityPath = join(dir, "Xauthority");
    const cookie = randomBytes(16);
    await writeFile(xauthorityPath, encodeXauthEntry({ family: 0xffff, address: Buffer.alloc(0), number: "", name: MIT_MAGIC_COOKIE, data: cookie }), { mode: 0o600 });
    xvnc = spawn(
      "Xvnc",
      ["-displayfd", "3", "-auth", xauthorityPath, "-rfbunixpath", join(dir, "vnc.sock"), "-rfbunixmode", "0600", "-rfbport", "-1", "-SecurityTypes", "None", "-nolisten", "tcp", "-geometry", `${WIDTH}x${HEIGHT}`, "-depth", "24"],
      { env: { PATH: process.env.PATH, HOME: dir }, detached: true, stdio: ["ignore", "ignore", "pipe", "pipe"] }
    );
    xvnc.stderr!.on("data", (chunk: Buffer) => {
      xvncStderr = (xvncStderr + chunk.toString()).slice(-4000);
    });
    const displayFd = xvnc.stdio[3] as Readable;
    display = await new Promise<number>((resolve, reject) => {
      let written = "";
      const timer = setTimeout(() => reject(new Error(`Xvnc reported no display: ${xvncStderr}`)), WAIT_MS);
      displayFd.on("data", (chunk: Buffer) => {
        written += chunk.toString();
        const match = /^(\d+)\n/.exec(written);
        if (!match) return;
        clearTimeout(timer);
        resolve(Number(match[1]));
      });
      xvnc!.once("exit", () => {
        clearTimeout(timer);
        reject(new Error(`Xvnc exited before reporting a display: ${xvncStderr}`));
      });
    });
    client = await X11Connection.connect({ path: x11SocketPath(display), auth: { name: MIT_MAGIC_COOKIE, data: cookie } });
    engine = await openDesktopAutomation({
      display,
      connect: async () => createConnection(x11SocketPath(display)),
      readAuthority: () => readFile(xauthorityPath)
    });
  });

  after(async () => {
    await engine?.close();
    client?.close();
    await killGroup(xvnc);
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const colors = [
    [220, 30, 20],
    [20, 200, 40],
    [30, 40, 210],
    [250, 250, 250]
  ] as const;
  /** Four 100×50 quadrants at (200, 100). */
  const quadrant = (i: number) => ({ x: 200 + (i % 2) * 100, y: 100 + Math.floor(i / 2) * 50, width: 100, height: 50 });

  test("a change in the region ends a wait; the pattern drawn is captured exactly; then the screen is idle", async () => {
    assert.deepEqual(engine.size(), { width: WIDTH, height: HEIGHT });
    const since = engine.seq();
    const changed = engine.wait({ for: "change", idleMs: 0, region: { x: 200, y: 100, width: 200, height: 100 }, timeoutMs: WAIT_MS });
    for (const [i, color] of colors.entries()) {
      const window = client.allocateId();
      await client.requestVoid(encodeCreateWindow(window, client.root, quadrant(i), WindowClass.InputOutput, { backgroundPixel: pixelOf(client, color), overrideRedirect: true }));
      await client.requestVoid(mapWindow(window));
    }
    const result = await changed;
    assert.equal(result.changed, true);
    assert.equal(result.timedOut, false);
    assert.ok(result.seq > since);

    const capture = await engine.capture({ x: 190, y: 95, width: 220, height: 110 });
    assert.deepEqual([capture.width, capture.height, capture.origin.x, capture.origin.y], [220, 110, 190, 95]);
    const rgb = pixelsToRgb(capture.pixels, capture.format, capture.width * capture.height);
    const at = (x: number, y: number): number[] => {
      const i = ((y - capture.origin.y) * capture.width + (x - capture.origin.x)) * 3;
      return [...rgb.subarray(i, i + 3)];
    };
    for (const [i, color] of colors.entries()) {
      const { x, y, width, height } = quadrant(i);
      for (const [px, py] of [[x, y], [x + width - 1, y + height - 1], [x + 50, y + 25]] as const) assert.deepEqual(at(px, py), [...color], `quadrant ${i} at ${px},${py}`);
    }
    // Just outside the pattern is the root's background, not a quadrant colour.
    assert.ok(!colors.some((color) => at(199, 99).every((value, c) => value === color[c])));

    const full = await engine.capture();
    assert.deepEqual([full.width, full.height, full.pixels.length], [WIDTH, HEIGHT, WIDTH * HEIGHT * 4]);
    const idle = await engine.wait({ for: "idle", idleMs: 100, region: { x: 200, y: 100, width: 200, height: 100 }, timeoutMs: WAIT_MS });
    assert.equal(idle.timedOut, false);
  });

  let keyWindow: number;
  let original: KeyboardMapping;
  const keyPresses: Array<{ keycode: number; state: number }> = [];

  test("typing reaches the focused window as the right keysyms, shifted where needed", async () => {
    keyWindow = client.allocateId();
    await client.requestVoid(
      encodeCreateWindow(keyWindow, client.root, { x: 500, y: 400, width: 200, height: 100 }, WindowClass.InputOutput, {
        overrideRedirect: true,
        eventMask: EventMask.KeyPress | EventMask.ButtonPress
      })
    );
    await client.requestVoid(mapWindow(keyWindow));
    await client.requestVoid(setInputFocus(keyWindow));
    client.on("event", (event) => {
      if (event.type === "KeyPress" && event.event === keyWindow) keyPresses.push({ keycode: event.detail, state: event.state });
    });
    original = await client.getKeyboardMapping();

    await engine.type("Hi! a_1\n");
    // The engine's last barrier has passed: a round trip on this connection delivers every event before it.
    await client.sync();
    // Shift_L…Hyper_R presses are the modifiers themselves.
    const typed = keyPresses.map(({ keycode, state }) => keysymOf(original, client.setup.minKeycode, keycode, state)).filter((keysym) => keysym < 0xffe1 || keysym > 0xffee);
    assert.deepEqual(typed, [...[..."Hi! a_1"].map((char) => char.codePointAt(0)!), 0xff0d]);

    keyPresses.length = 0;
    await engine.key("ctrl+shift+t", 1);
    await client.sync();
    const t = keyPresses.at(-1)!;
    assert.equal(keysymOf(original, client.setup.minKeycode, t.keycode, 0), 0x74);
    assert.equal(t.state & 0b101, 0b101, "Shift and Control are down for the t");
  });

  test("a character the keymap lacks is typed on a spare keycode, which is restored on close", async () => {
    keyPresses.length = 0;
    await engine.type("é");
    await client.sync();
    assert.equal(keyPresses.length, 1);
    const { keycode } = keyPresses[0]!;
    const at = (keycode - client.setup.minKeycode) * original.keysymsPerKeycode;
    assert.ok(original.keysyms.subarray(at, at + original.keysymsPerKeycode).every((keysym) => keysym === 0), "a keycode that had no keysyms");
    const bound = await client.getKeyboardMapping();
    assert.equal(bound.keysyms[(keycode - client.setup.minKeycode) * bound.keysymsPerKeycode], 0xe9);
  });

  test("a click lands on the window under the pointer; the pointer is where it was moved", async () => {
    const pressed = nextEvent(client, (event) => (event.type === "ButtonPress" && event.event === keyWindow ? event : undefined), "ButtonPress");
    await engine.click(520, 430, 1, 1, []);
    const press = await pressed;
    assert.deepEqual([press.detail, press.eventX, press.eventY], [1, 20, 30]);
    await engine.move(10, 20);
    assert.deepEqual(await engine.pointer(), { x: 10, y: 20 });
  });

  test("clipboard round trip: another client reads what the engine set, and the engine reads what it set", async () => {
    const [clipboardAtom, utf8, property] = await Promise.all([client.internAtom("CLIPBOARD"), client.internAtom("UTF8_STRING"), client.internAtom("ORQ_TEST")]);
    const requestor = client.allocateId();
    await client.requestVoid(encodeCreateWindow(requestor, client.root, { x: 0, y: 0, width: 1, height: 1 }, WindowClass.InputOnly));

    const text = "héllo ✓ from the engine";
    await engine.setClipboard(text);
    const notified = nextEvent(client, (event) => (event.type === "SelectionNotify" && event.requestor === requestor ? event : undefined), "SelectionNotify");
    await client.requestVoid(encodeConvertSelection(requestor, clipboardAtom, utf8, property, CurrentTime));
    assert.equal((await notified).property, property);
    const value = await client.getProperty(requestor, property, AnyPropertyType);
    assert.equal(value?.type, utf8);
    assert.equal(value?.value.toString("utf8"), text);

    // Now this client owns it (the engine gets SelectionClear) and answers the engine's request.
    const reply = "naïve ✓ from the other client";
    client.on("event", (event) => {
      if (event.type !== "SelectionRequest" || event.owner !== requestor) return;
      void (async () => {
        await client.requestVoid(encodeChangeProperty(PropertyMode.Replace, event.requestor, event.property, utf8, 8, Buffer.from(reply)));
        await client.sendEvent(false, event.requestor, 0, encodeSelectionNotify(event.time, event.requestor, event.selection, event.target, event.property));
      })();
    });
    await client.requestVoid(encodeSetSelectionOwner(requestor, clipboardAtom, CurrentTime));
    assert.equal(await engine.getClipboard(), reply);
  });

  test("close restores the keymap and leaves the display alone", async () => {
    await engine.close();
    assert.equal(engine.closed, true);
    assert.deepEqual([...(await client.getKeyboardMapping()).keysyms], [...original.keysyms]);
    await assert.rejects(engine.capture(), { code: "DESKTOP_NOT_RUNNING" });
  });
});
