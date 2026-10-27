import assert from "node:assert/strict";
import test from "node:test";

import { ANIMATIONS_OFF_SCRIPT, CLOSE_SYSTEM_DIALOGS_SCRIPT, CUTOUT_OVERLAY, fixDisplayCutout, GUEST_SETTINGS_SCRIPT, LEASE_BOOT_SCRIPT, waitForSettle } from "./golden.ts";
import type { ExecFn } from "./exec.ts";

function clock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test("settle: two quiet windows in a row, after the first-boot burst", async () => {
  const c = clock();
  const samples = [350, 280, 40, 120, 30, 20, 10];
  const seen: number[] = [];
  const settled = await waitForSettle(
    async () => {
      c.advance(10_000);
      return samples.shift() ?? 5;
    },
    { maxMs: 300_000, threshold: 60, now: c.now, onSample: (p) => seen.push(p) }
  );
  assert.equal(settled, true);
  assert.deepEqual(seen, [350, 280, 40, 120, 30, 20]);
});

test("settle: gives up after the limit (the snapshot is taken anyway); an exit fails it", async () => {
  const c = clock();
  assert.equal(await waitForSettle(async () => (c.advance(10_000), 300), { maxMs: 60_000, threshold: 60, now: c.now }), false);
  await assert.rejects(waitForSettle(async () => null, { maxMs: 60_000, threshold: 60 }), /exited/);
});

test("guest settings: animations off, screen never off, error dialogs hidden, stay awake", () => {
  for (const part of ["window_animation_scale 0", "transition_animation_scale 0", "animator_duration_scale 0", "screen_off_timeout 2147483647", "hide_error_dialogs 1", "svc power stayon true"]) {
    assert.ok(GUEST_SETTINGS_SCRIPT.includes(part), part);
  }
  assert.ok(ANIMATIONS_OFF_SCRIPT.includes("animator_duration_scale 0") && !ANIMATIONS_OFF_SCRIPT.includes("stayon"));
});

test("dialogs a loaded first boot raised are closed: before the snapshot is saved, and after every lease boot", () => {
  assert.equal(CLOSE_SYSTEM_DIALOGS_SCRIPT, "am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS");
  // An older snapshot may still hold a "System UI isn't responding" dialog: each lease boot closes it too.
  assert.ok(LEASE_BOOT_SCRIPT.startsWith(ANIMATIONS_OFF_SCRIPT) && LEASE_BOOT_SCRIPT.endsWith(`; ${CLOSE_SYSTEM_DIALOGS_SCRIPT}`));
});

test("cutout: the pixel spec of the device emulation overlay is replaced by a dp one, as root, then adbd unroots", async () => {
  const calls: string[] = [];
  let spec = "m 581.5,86.5 a 42,42 0 0 0 -84,0 42,42 0 0 0 84,0 z @left";
  const exec: ExecFn = async (_adb, args) => {
    const command = args.slice(2).join(" ");
    calls.push(command);
    if (command === "shell dumpsys display") return { exitCode: 0, stdout: `mCutout cutoutSpec={${spec}} x`, stderr: "" };
    if (command === "shell cmd overlay list") return { exitCode: 0, stdout: "android\n[x] com.android.internal.emulation.pixel_9\n[ ] com.android.internal.emulation.pixel_8\n", stderr: "" };
    // What Pixel 9's emulation overlay answers (the rect is in pixels of the real panel too).
    if (command === "shell cmd overlay lookup android android:string/config_mainBuiltInDisplayCutoutRectApproximation") return { exitCode: 0, stdout: "m 484.5,0 h 110 v 141.5 h -110 z @left\n", stderr: "" };
    if (command === "shell cmd overlay lookup android android:bool/config_fillMainBuiltInDisplayCutout") return { exitCode: 0, stdout: "true\n", stderr: "" };
    if (command.startsWith("shell cmd overlay enable com.android.shell:OrqCutout")) spec = "m 221 33 @left @dp";
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const how = await fixDisplayCutout({ exec, adb: "adb", env: {}, serial: "emulator-5554", cutoutDensity: 420, signal: new AbortController().signal });
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
  assert.ok(!calls.some((call) => call.includes("pixel_8")));
  assert.ok(calls.indexOf("unroot") > calls.indexOf(`shell cmd overlay enable ${CUTOUT_OVERLAY}`));
  // Already in dp (or none): nothing to do.
  calls.length = 0;
  assert.equal(await fixDisplayCutout({ exec, adb: "adb", env: {}, serial: "emulator-5554", cutoutDensity: 420, signal: new AbortController().signal }), "kept");
  assert.deepEqual(calls, ["shell dumpsys display"]);
});
