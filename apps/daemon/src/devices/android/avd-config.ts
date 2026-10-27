/**
 * Per-profile AVD hardware and the `config.ini` patch (spikes §2). `avdmanager create avd` writes
 * the device definition's config with placeholders (`avd.id=<build>`, `avd.name=<build>`,
 * `disk.dataPartition.path=<temp>`) and desktop defaults; {@link patchAvdConfig} replaces them
 * with Orquester's tuned values: a smaller framebuffer of the real screen's aspect (streaming cost
 * grows with pixels: 720p is the measured sweet spot), 2 GB / 2 cores, `swangle_indirect`, no
 * cameras or audio, a hardware keyboard. Foldables keep their hinge and display-region geometry,
 * scaled with the framebuffer, so postures work through serve-emu's `api/fold`.
 */

import { createHash } from "node:crypto";

import type { DeviceProfile, DeviceScreen } from "@orquester/api";

import * as tuning from "./avd-tuning.mjs";
import { EMULATOR_GPU_MODE } from "./emulator.ts";

export { cutoutSpecInDp, hasAvdPlaceholders, parseIni } from "./avd-tuning.mjs";

/**
 * Bump when the patch (`avd-tuning.mjs`) or the hardware table below changes: AVDs and golden
 * snapshots made before are made again (lazily, on the profile's next open). 2: every framebuffer
 * keeps its device's real aspect and dp size, and golden snapshots carry the device's display
 * cutout in dp ({@link cutoutSpecInDp}). 3: with its rect approximation and fill, so the camera
 * hole is drawn whole.
 */
export const AVD_CONFIG_VERSION = 3;

export interface AvdHardware {
  /** `avdmanager create avd --device`. */
  device: string;
  /** Framebuffer, portrait as the device stands up, in pixels. */
  width: number;
  height: number;
  /** `hw.lcd.density`. */
  density: number;
}

/**
 * Tuned framebuffers: the device's real resolution scaled to about 720 px across, keeping its
 * aspect, its orientation as avdmanager defines it, and its dp size (the density scales with the
 * pixels). The system image's display cutout is defined in pixels of the real panel, so golden
 * snapshots re-express it in dp ({@link cutoutSpecInDp}): the camera hole then sits where the real
 * device has it.
 */
export const AVD_HARDWARE: Readonly<Record<string, AvdHardware>> = {
  // Pixel 9 1080×2424 @420 → ×⅔: 411×923 dp.
  "pixel-9": { device: "pixel_9", width: 720, height: 1616, density: 280 },
  // Pixel Tablet 2560×1600 @320, landscape-native → half: 1280×800 dp.
  "pixel-tablet": { device: "pixel_tablet", width: 1280, height: 800, density: 160 },
  // Pixel Fold inner 2208×1840 @420 (cover 1080×2092) → half.
  "pixel-fold": { device: "pixel_fold", width: 1104, height: 920, density: 210 },
  // Galaxy S26 1080×2340, S26+/Ultra 1440×3120: the same 9:19.5 aspect, Pixel 9's dp width.
  "galaxy-s26": { device: "pixel_9", width: 720, height: 1560, density: 280 },
  "galaxy-s26-plus": { device: "pixel_9", width: 720, height: 1560, density: 280 },
  "galaxy-s26-ultra": { device: "pixel_9", width: 720, height: 1560, density: 280 },
  // Z Fold8 inner 1828×2448 with a narrow cover screen (the 7.6" fold-in's left region).
  "galaxy-z-fold8": { device: "7.6in Foldable", width: 914, height: 1224, density: 240 },
  // Z Flip8 1080×2520, horizontal hinge (the 6.7" fold-in).
  "galaxy-z-flip8": { device: "6.7in Foldable", width: 720, height: 1680, density: 280 }
};

/** A profile's hardware: the table's, else its `avdDevice` at 720×1280 @320. */
export function avdHardware(profile: Pick<DeviceProfile, "id" | "avdDevice">): AvdHardware {
  return AVD_HARDWARE[profile.id] ?? { device: profile.avdDevice ?? "pixel_9", width: 720, height: 1280, density: 320 };
}

/** The AVD's name (the panel matches `orq-galaxy-…` names to the Samsung models). */
export function avdName(profileId: string): string {
  return `orq-${profileId}`;
}

/** The screen a lease reports: dp and the pixel scale. */
export function avdScreen(hardware: AvdHardware): DeviceScreen {
  const scale = hardware.density / 160;
  return { width: Math.round(hardware.width / scale), height: Math.round(hardware.height / scale), scale };
}

/** Hash of what makes an AVD and its snapshot: a change makes both again. */
export function avdConfigHash(profileId: string, hardware: AvdHardware, systemImage: string): string {
  return createHash("sha256").update(JSON.stringify({ v: AVD_CONFIG_VERSION, profileId, hardware, systemImage })).digest("hex").slice(0, 16);
}

/**
 * The tuned `config.ini`: placeholders replaced, the framebuffer set (foldable geometry scaled with
 * it), Orquester's hardware choices applied with {@link EMULATOR_GPU_MODE}. Keys it does not set
 * stay as avdmanager wrote them. The logic is `avd-tuning.mjs`, which the device-cache workflow runs too.
 */
export function patchAvdConfig(text: string, options: { name: string; hardware: AvdHardware }): string {
  return tuning.patchAvdConfig(text, { ...options, gpuMode: EMULATOR_GPU_MODE });
}
