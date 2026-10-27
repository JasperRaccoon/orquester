import assert from "node:assert/strict";
import test from "node:test";

import type { DeviceActionInput } from "@orquester/api";

import { isDeviceError } from "../../errors.ts";
import { logText, performVphoneAction, type VphoneActionTarget } from "./agent-actions.ts";
import { assertSafeParams, VphoneRpcError } from "./guest-client.ts";
import { parseUiTree, renderSnapshot, type VphoneSnapshot } from "./snapshot.ts";
import { FIXTURE_JPEG } from "./testing.ts";

/** A `ui.tree` result in the shape vphoned returns (Settings → General on an iOS 26 guest). */
const UI_TREE = {
  count: 4,
  pid: 312,
  source: "ax",
  truncated: false,
  elements: [
    { clickable: false, enabled: true, frame: { height: 26.333333333333314, width: 80, x: 40, y: 238 }, identifier: "", label: "General", role: "text", traits: 8590000192, value: "", visible: 1, x: 80, y: 251.16666666666666 },
    {
      clickable: true,
      enabled: true,
      frame: { height: 52, width: 390, x: 20, y: 382.66666666666669 },
      identifier: "com.apple.settings.general.about",
      label: "About",
      role: "button",
      traits: 8589934657,
      value: "",
      visible: 1,
      x: 215,
      y: 408.66666666666669
    },
    { clickable: true, enabled: false, frame: { height: 52, width: 390, x: 20, y: 434.6 }, identifier: "", label: "Software Update", role: "button", value: "1", visible: 1 },
    { clickable: true, enabled: true, frame: { height: 44, width: 0, x: 20, y: 500 }, identifier: "", label: "zero width", role: "button" }
  ]
};

function target(results: Record<string, unknown> = {}): VphoneActionTarget & { calls: [string, Record<string, unknown>][]; current: VphoneSnapshot | null } {
  const calls: [string, Record<string, unknown>][] = [];
  const state = {
    calls,
    current: null as VphoneSnapshot | null,
    async call(method: string, params: Record<string, unknown>) {
      assertSafeParams(params);
      calls.push([method, params]);
      const result = results[method];
      if (result instanceof Error) throw result;
      return (result as Record<string, unknown>) ?? {};
    },
    screen: () => ({ width: 402, height: 874 }),
    snapshot: () => state.current,
    setSnapshot: (snapshot: VphoneSnapshot) => {
      state.current = snapshot;
    }
  };
  return state;
}

const run = (t: VphoneActionTarget, input: DeviceActionInput) => performVphoneAction(t, input, new AbortController().signal);

test("ui.tree renders as compact @eN lines and keeps each ref's frame", () => {
  const snapshot = renderSnapshot(parseUiTree(UI_TREE));
  assert.equal(
    snapshot.text,
    ['@e1 [text] "General"', '@e2 [button] "About" id=com.apple.settings.general.about', '@e3 [button] "Software Update" value="1" (disabled)'].join("\n")
  );
  assert.deepEqual(snapshot.refs.e2, { x: 20, y: 382.66666666666669, width: 390, height: 52 });
  assert.equal(renderSnapshot([]).text, "(no accessible elements on screen; take a screenshot)");
});

test("snapshot, then ref taps: a unique identifier taps the element, else the frame's center", async () => {
  const t = target({ "ui.tree": UI_TREE });
  const snap = await run(t, { action: "snapshot" });
  assert.deepEqual(t.calls[0], ["ui.tree", { max_elements: 400 }]);
  assert.equal(Object.keys(snap.refs!).length, 3);
  assert.equal(snap.summary, "Snapshot: 3 elements");

  const about = await run(t, { action: "tap", ref: "@e2" });
  assert.deepEqual(t.calls[1], ["ui.tap_element", { identifier: "com.apple.settings.general.about" }]);
  assert.deepEqual(about.point, { x: 215, y: 408.67 });
  assert.equal(about.target, "@e2 About");

  await run(t, { action: "tap", ref: "e1" });
  assert.deepEqual(t.calls[2], ["input.tap", { x: 80, y: 251.17 }]);

  const fill = await run(t, { action: "fill", ref: "@e1", text: "hi" });
  assert.deepEqual(t.calls.slice(3), [
    ["input.tap", { x: 80, y: 251.17 }],
    ["input.type", { text: "hi" }]
  ]);
  assert.match(fill.summary!, /Filled @e1 General with 2 characters/);

  await assert.rejects(run(t, { action: "tap", ref: "@e9" }), (error) => isDeviceError(error) && /new snapshot/.test(error.message));
});

test("each action kind maps onto its vphoned method; unsupported kinds say so", async () => {
  const t = target({
    "screen.screenshot": { mime_type: "image/jpeg", width: 1290, height: 2796, data: FIXTURE_JPEG.toString("base64") },
    "logs.syslog": { lines: ["SpringBoard: ready", { process: "backboardd", message: "touch" }] },
    "apps.launch": { pid: 9, frontmost_verified: false }
  });
  await run(t, { action: "tap", x: 10, y: 20 });
  await run(t, { action: "long_press", x: 10, y: 20, durationMs: 1500 });
  await run(t, { action: "type", text: "abc" });
  await run(t, { action: "press", key: "home" });
  await run(t, { action: "press", key: "lock" });
  await run(t, { action: "press", key: "enter" });
  const swipe = await run(t, { action: "swipe", direction: "up" });
  await run(t, { action: "scroll", direction: "down" });
  await run(t, { action: "swipe", from: { x: 1, y: 2 }, to: { x: 3, y: 4 } });
  const opened = await run(t, { action: "open_app", app: "com.apple.Preferences" });
  await run(t, { action: "close_app", app: "com.apple.Preferences" });
  await run(t, { action: "open_url", url: "https://example.test" });
  const shot = await run(t, { action: "screenshot" });
  const logs = await run(t, { action: "logs", seconds: 500 });
  await run(t, { action: "wait", text: "About", timeoutMs: 2000 });
  await run(t, { action: "location", lat: 1.5, lon: 2.5 });
  assert.deepEqual(t.calls, [
    ["input.tap", { x: 10, y: 20 }],
    ["input.long_press", { x: 10, y: 20, seconds: 1.5 }],
    ["input.type", { text: "abc" }],
    ["input.button", { name: "home" }],
    ["input.button", { name: "power" }],
    ["input.key", { name: "return" }],
    ["input.swipe", { x1: 201, y1: 699, x2: 201, y2: 175, seconds: 0.3 }],
    ["input.swipe", { x1: 201, y1: 699, x2: 201, y2: 175, seconds: 0.3 }],
    ["input.swipe", { x1: 1, y1: 2, x2: 3, y2: 4, seconds: 0.3 }],
    ["apps.launch", { bundle_id: "com.apple.Preferences" }],
    ["apps.terminate", { bundle_id: "com.apple.Preferences" }],
    ["apps.open_url", { url: "https://example.test" }],
    ["screen.screenshot", {}],
    ["logs.syslog", { seconds: 60, max_lines: 300 }],
    ["ui.wait", { text: "About", timeout: 2 }],
    ["location.set", { latitude: 1.5, longitude: 2.5 }]
  ]);
  assert.deepEqual(swipe.from, { x: 201, y: 699 });
  assert.match(opened.text!, /did not confirm/);
  assert.equal(shot.image?.mimeType, "image/jpeg");
  assert.deepEqual(shot.image?.data, FIXTURE_JPEG);
  assert.equal(shot.image?.width, 1290);
  assert.equal(logs.text, "SpringBoard: ready\nbackboardd: touch");

  for (const input of [
    { action: "rotate", orientation: "landscape" },
    { action: "appearance", appearance: "dark" },
    { action: "permissions", app: "x", permission: "camera", grant: "grant" },
    { action: "press", key: "back" }
  ] as DeviceActionInput[]) {
    await assert.rejects(run(t, input), (error) => isDeviceError(error) && error.code === "INVALID_ARGUMENT", input.action);
  }
});

test("force methods are never sent", () => {
  assert.throws(() => assertSafeParams({ bundle_id: "x", force: true }), VphoneRpcError);
  assert.doesNotThrow(() => assertSafeParams({ bundle_id: "x" }));
});

test("log text tolerates other result shapes", () => {
  assert.equal(logText({ output: "a\nb" }), "a\nb");
  assert.equal(logText({}), "");
});
