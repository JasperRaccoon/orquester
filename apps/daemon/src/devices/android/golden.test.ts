import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";

import { fixDisplayCutout, GUEST_SETTINGS_SCRIPT, LEASE_BOOT_SCRIPT, waitForSettle } from "./golden.ts";
import type { ExecFn } from "./exec.ts";

function clock(t: test.TestContext) {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  return { advance: (ms: number) => t.mock.timers.tick(ms) };
}

test("settle: two quiet windows in a row, after the first-boot burst", async (t) => {
  const c = clock(t);
  const samples = [350, 280, 40, 120, 30, 20, 10];
  const seen: number[] = [];
  const settled = await waitForSettle(
    async () => {
      c.advance(10_000);
      return samples.shift() ?? 5;
    },
    { maxMs: 300_000, threshold: 60, onSample: (p) => seen.push(p) }
  );
  assert.equal(settled, true);
  assert.deepEqual(seen, [350, 280, 40, 120, 30, 20]);
});

test("settle: gives up after the limit (the snapshot is taken anyway); an exit fails it", async (t) => {
  const c = clock(t);
  assert.equal(await waitForSettle(async () => (c.advance(10_000), 300), { maxMs: 60_000, threshold: 60 }), false);
  await assert.rejects(waitForSettle(async () => null, { maxMs: 60_000, threshold: 60 }), /exited/);
});

test("golden and lease guest commands disable animations; loaded dialogs are dismissed", () => {
  for (const part of ["window_animation_scale 0", "transition_animation_scale 0", "animator_duration_scale 0", "screen_off_timeout 2147483647", "hide_error_dialogs 1", "svc power stayon true"]) {
    assert.ok(GUEST_SETTINGS_SCRIPT.includes(part), part);
  }
  for (const part of ["window_animation_scale 0", "transition_animation_scale 0", "animator_duration_scale 0", "am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS"]) {
    assert.ok(LEASE_BOOT_SCRIPT.includes(part), part);
  }
});

test("cutout: the pixel spec of the device emulation overlay is replaced by a dp one, as root, then adbd unroots", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: string[] = [];
  let spec = "m 581.5,86.5 a 42,42 0 0 0 -84,0 42,42 0 0 0 84,0 z @left";
  let systemUiPid = 996;
  const exec: ExecFn = async (_adb, args) => {
    const command = args.slice(2).join(" ");
    calls.push(command);
    if (command === "shell dumpsys display") return { exitCode: 0, stdout: `mCutout cutoutSpec={${spec}} x`, stderr: "" };
    if (command === "shell cmd overlay list") return { exitCode: 0, stdout: "android\n[x] com.android.internal.emulation.pixel_9\n[ ] com.android.internal.emulation.pixel_8\n", stderr: "" };
    // What Pixel 9's emulation overlay answers (the rect is in pixels of the real panel too).
    if (command === "shell cmd overlay lookup android android:string/config_mainBuiltInDisplayCutoutRectApproximation") return { exitCode: 0, stdout: "m 484.5,0 h 110 v 141.5 h -110 z @left\n", stderr: "" };
    if (command === "shell cmd overlay lookup android android:bool/config_fillMainBuiltInDisplayCutout") return { exitCode: 0, stdout: "true\n", stderr: "" };
    if (command === "shell pidof com.android.systemui") return { exitCode: 0, stdout: `${systemUiPid}\n`, stderr: "" };
    if (command === "shell kill 996") systemUiPid = 1204;
    if (command.startsWith("shell cmd overlay enable com.android.shell:OrqCutout")) spec = "m 221 33 @left @dp";
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  let finished = false;
  const fixing = fixDisplayCutout({ exec, adb: "adb", env: {}, serial: "emulator-5554", cutoutDensity: 420, signal: new AbortController().signal }).finally(() => { finished = true; });
  while (!finished) {
    t.mock.timers.runAll();
    await setImmediate();
  }
  const how = await fixing;
  assert.equal(how, "fixed");
  assert.deepEqual(calls.slice(2, 4), ["root", "wait-for-device"]);
  assert.ok(calls.includes("shell cmd overlay fabricate --target android --name OrqCutout android:string/config_mainBuiltInDisplayCutout 0x03 'm 221.524 32.952 a 16 16 0 0 0 -32 0 16 16 0 0 0 32 0 z @left @dp'"));
  // The rect SystemUI sizes the hole's window by, and the fill: without them the hole is cut in half, or not drawn.
  assert.ok(calls.includes("shell cmd overlay fabricate --target android --name OrqCutoutRect android:string/config_mainBuiltInDisplayCutoutRectApproximation 0x03 'm 184.571 0 h 41.905 v 53.905 h -41.905 z @left @dp'"));
  assert.ok(calls.includes("shell cmd overlay fabricate --target android --name OrqCutoutFill android:bool/config_fillMainBuiltInDisplayCutout 0x12 0xffffffff"));
  for (const name of ["OrqCutout", "OrqCutoutRect", "OrqCutoutFill"]) {
    assert.ok(calls.indexOf(`shell cmd overlay enable com.android.shell:${name}`) > calls.indexOf("shell cmd overlay disable com.android.internal.emulation.pixel_9"));
  }
  assert.ok(calls.includes("shell cmd overlay disable com.android.internal.emulation.pixel_9"));
  // SystemUI draws the new hole only once it starts again: killed (as root) after the overlays changed.
  assert.ok(calls.indexOf("shell kill 996") > calls.indexOf("shell cmd overlay enable com.android.shell:OrqCutoutFill"));
  assert.ok(calls.indexOf("shell kill 996") < calls.indexOf("unroot"));
  assert.equal(systemUiPid, 1204);
  assert.ok(!calls.some((call) => call.includes("pixel_8")));
  assert.ok(calls.indexOf("unroot") > calls.indexOf("shell cmd overlay enable com.android.shell:OrqCutout"));
  // Already in dp (or none): nothing to do.
  calls.length = 0;
  assert.equal(await fixDisplayCutout({ exec, adb: "adb", env: {}, serial: "emulator-5554", cutoutDensity: 420, signal: new AbortController().signal }), "kept");
  assert.deepEqual(calls, ["shell dumpsys display"]);
});
