import assert from "node:assert/strict";
import test from "node:test";

import { deviceProfile } from "@orquester/api";

import { AVD_HARDWARE, avdConfigHash, avdHardware, avdName, avdScreen, hasAvdPlaceholders, parseIni, patchAvdConfig } from "./avd-config.ts";

// What avdmanager 22 writes for pixel_fold (abridged), placeholders included.
const FOLD = `PlayStore.enabled=no
avd.id=<build>
avd.name=<build>
disk.dataPartition.path=<temp>
disk.dataPartition.size=10G
hw.audioInput=yes
hw.camera.back=emulated
hw.cpu.ncore=4
hw.displayRegion.0.1.height=2092
hw.displayRegion.0.1.width=1080
hw.displayRegion.0.1.xOffset=-1
hw.displayRegion.0.2.width=0
hw.gpu.enabled=no
hw.gpu.mode=auto
hw.keyboard=no
hw.lcd.density=420
hw.lcd.height=1840
hw.lcd.width=2208
hw.ramSize=2G
hw.sensor.hinge.areas=1080-0-0-1840
hw.sensor.posture_list=1, 2, 3
image.sysdir.1=system-images/android-35/google_apis/x86_64/
`;

test("config.ini: placeholders replaced, Orquester's hardware applied, other keys kept", () => {
  const patched = patchAvdConfig(FOLD, { name: "orq-pixel-fold", hardware: AVD_HARDWARE["pixel-fold"]! });
  const ini = parseIni(patched);
  assert.equal(hasAvdPlaceholders(FOLD), true);
  assert.equal(hasAvdPlaceholders(patched), false);
  assert.equal(ini.get("avd.id"), "orq-pixel-fold");
  assert.equal(ini.get("avd.name"), "orq-pixel-fold");
  assert.equal(ini.has("disk.dataPartition.path"), false);
  for (const [key, value] of [
    ["hw.ramSize", "2048"],
    ["hw.cpu.ncore", "2"],
    ["hw.gpu.enabled", "yes"],
    ["hw.gpu.mode", "swangle_indirect"],
    ["hw.audioInput", "no"],
    ["hw.audioOutput", "no"],
    ["hw.camera.back", "none"],
    ["hw.camera.front", "none"],
    ["hw.keyboard", "yes"],
    ["hw.lcd.width", "1104"],
    ["hw.lcd.height", "920"],
    ["hw.lcd.density", "210"],
    ["firstboot.bootFromDownloadableSnapshot", "no"]
  ] as const) {
    assert.equal(ini.get(key), value, key);
  }
  assert.equal(ini.get("image.sysdir.1"), "system-images/android-35/google_apis/x86_64/");
  assert.equal(ini.get("hw.sensor.posture_list"), "1, 2, 3");
});

test("config.ini: a foldable's display regions and hinge scale with the framebuffer; unset values stay", () => {
  const ini = parseIni(patchAvdConfig(FOLD, { name: "orq-pixel-fold", hardware: AVD_HARDWARE["pixel-fold"]! }));
  assert.equal(ini.get("hw.displayRegion.0.1.width"), "540");
  assert.equal(ini.get("hw.displayRegion.0.1.height"), "1046");
  assert.equal(ini.get("hw.displayRegion.0.1.xOffset"), "-1");
  assert.equal(ini.get("hw.displayRegion.0.2.width"), "0");
  assert.equal(ini.get("hw.sensor.hinge.areas"), "540-0-0-920");
});

test("config.ini: the Z Flip8's horizontal hinge keeps a 1 px height and moves to the new middle", () => {
  const flip = "hw.lcd.width=1080\nhw.lcd.height=2636\nhw.lcd.density=480\nhw.sensor.hinge.areas=0-1318-1080-1\n";
  const ini = parseIni(patchAvdConfig(flip, { name: "orq-galaxy-z-flip8", hardware: AVD_HARDWARE["galaxy-z-flip8"]! }));
  assert.equal(ini.get("hw.sensor.hinge.areas"), "0-840-720-1");
  assert.equal(ini.get("hw.lcd.height"), "1680");
});

test("hardware: every Android profile has a tuned framebuffer of its real aspect; names and screens", () => {
  for (const id of ["pixel-9", "pixel-tablet", "pixel-fold", "galaxy-s26", "galaxy-s26-plus", "galaxy-s26-ultra", "galaxy-z-fold8", "galaxy-z-flip8"]) {
    const profile = deviceProfile(id);
    assert.ok(profile, id);
    assert.equal(avdHardware(profile).device, profile.avdDevice, id);
    assert.ok(avdHardware(profile).width * avdHardware(profile).height <= 1_250_000, `${id} stays near 720p`);
  }
  const s26 = AVD_HARDWARE["galaxy-s26"]!;
  assert.ok(Math.abs(s26.height / s26.width - 2340 / 1080) < 0.01);
  const flip = AVD_HARDWARE["galaxy-z-flip8"]!;
  assert.ok(Math.abs(flip.height / flip.width - 2520 / 1080) < 0.01);
  assert.equal(avdName("galaxy-z-fold8"), "orq-galaxy-z-fold8");
  assert.deepEqual(avdScreen(AVD_HARDWARE["pixel-9"]!), { width: 360, height: 640, scale: 2 });
  assert.deepEqual(avdHardware({ id: "unknown", avdDevice: "pixel_7" }), { device: "pixel_7", width: 720, height: 1280, density: 320 });
  assert.notEqual(avdConfigHash("pixel-9", AVD_HARDWARE["pixel-9"]!, "a"), avdConfigHash("pixel-9", { ...AVD_HARDWARE["pixel-9"]!, density: 300 }, "a"));
});
