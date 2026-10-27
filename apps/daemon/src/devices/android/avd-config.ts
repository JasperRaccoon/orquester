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

import { EMULATOR_GPU_MODE } from "./emulator.ts";

/**
 * Bump when the patch below changes: AVDs and golden snapshots made before are made again (lazily,
 * on the profile's next open). 2: every framebuffer keeps its device's real aspect and dp size, and
 * golden snapshots carry the device's display cutout in dp ({@link cutoutSpecInDp}).
 */
export const AVD_CONFIG_VERSION = 2;

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

/** Parse `key=value` lines (order kept). */
export function parseIni(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at <= 0 || line.trimStart().startsWith("#")) continue;
    map.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  return map;
}

function serializeIni(map: ReadonlyMap<string, string>): string {
  return `${[...map].map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}

const SCALED_X = /^hw\.displayRegion\.\d+\.\d+\.(width|xOffset)$/;
const SCALED_Y = /^hw\.displayRegion\.\d+\.\d+\.(height|yOffset)$/;

function scaleLength(value: string, factor: number): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return value; // 0 and -1 (unset) stay
  return String(Math.max(1, Math.round(n * factor)));
}

/** `hw.sensor.hinge.areas`: `x-y-w-h` per hinge, comma-separated. */
function scaleHingeAreas(value: string, sx: number, sy: number): string {
  return value
    .split(",")
    .map((area) => {
      const parts = area.trim().split("-");
      if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return area.trim();
      const [x, y, w, h] = parts.map(Number) as [number, number, number, number];
      return [Math.round(x * sx), Math.round(y * sy), w > 0 ? Math.max(1, Math.round(w * sx)) : 0, h > 0 ? Math.max(1, Math.round(h * sy)) : 0].join("-");
    })
    .join(", ");
}

/**
 * The tuned `config.ini`: placeholders replaced, the framebuffer set (foldable geometry scaled with
 * it), Orquester's hardware choices applied. Keys it does not set stay as avdmanager wrote them.
 */
export function patchAvdConfig(text: string, options: { name: string; hardware: AvdHardware }): string {
  const config = parseIni(text);
  const { hardware } = options;
  const originalWidth = Number(config.get("hw.lcd.width"));
  const originalHeight = Number(config.get("hw.lcd.height"));
  const sx = originalWidth > 0 ? hardware.width / originalWidth : 1;
  const sy = originalHeight > 0 ? hardware.height / originalHeight : 1;
  for (const [key, value] of config) {
    if (SCALED_X.test(key)) config.set(key, scaleLength(value, sx));
    else if (SCALED_Y.test(key)) config.set(key, scaleLength(value, sy));
    else if (key === "hw.sensor.hinge.areas") config.set(key, scaleHingeAreas(value, sx, sy));
  }
  config.delete("disk.dataPartition.path");
  const set: Record<string, string> = {
    "avd.id": options.name,
    "avd.name": options.name,
    "disk.dataPartition.size": "6G",
    "firstboot.bootFromDownloadableSnapshot": "no",
    "firstboot.bootFromLocalSnapshot": "yes",
    "firstboot.saveToLocalSnapshot": "yes",
    "fastboot.forceColdBoot": "no",
    "fastboot.forceFastBoot": "yes",
    "hw.audioInput": "no",
    "hw.audioOutput": "no",
    "hw.camera.back": "none",
    "hw.camera.front": "none",
    "hw.cpu.ncore": "2",
    "hw.ramSize": "2048",
    "hw.gpu.enabled": "yes",
    "hw.gpu.mode": EMULATOR_GPU_MODE,
    "hw.keyboard": "yes",
    "hw.lcd.width": String(hardware.width),
    "hw.lcd.height": String(hardware.height),
    "hw.lcd.density": String(hardware.density),
    "hw.initialOrientation": "portrait",
    "hw.sdCard": "no",
    "sdcard.size": "0",
    showDeviceFrame: "no",
    "PlayStore.enabled": "no"
  };
  for (const [key, value] of Object.entries(set)) config.set(key, value);
  return serializeIni(config);
}

/**
 * A display cutout spec in pixels of a panel of `density` (`dumpsys display`'s `cutoutSpec`, e.g.
 * `m 581.5,86.5 a 42,42 0 0 0 -84,0 42,42 0 0 0 84,0 z @left`) re-expressed in dp (`@dp`): every
 * length divided by `density / 160`; arc rotations and flags, commands and position markers kept.
 * Null for an empty spec or one already in dp.
 */
export function cutoutSpecInDp(spec: string, density: number): string | null {
  const text = spec.trim();
  if (!text || /@dp\b/.test(text) || !(density > 0)) return null;
  const at = text.search(/@/);
  const path = at < 0 ? text : text.slice(0, at);
  const markers = at < 0 ? "" : text.slice(at).trim();
  const factor = 160 / density;
  const tokens = path.match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? [];
  const out: string[] = [];
  let command = "";
  let index = 0;
  for (const token of tokens) {
    if (/^[A-Za-z]$/.test(token)) {
      command = token;
      index = 0;
      out.push(token);
      continue;
    }
    // Arcs: rx ry rotation large-arc sweep x y — only lengths scale.
    const keep = command.toLowerCase() === "a" && [2, 3, 4].includes(index % 7);
    out.push(keep ? token : String(Math.round(Number(token) * factor * 1000) / 1000));
    index += 1;
  }
  return `${out.join(" ")} ${markers ? `${markers} ` : ""}@dp`;
}

/** Placeholders avdmanager 22 leaves behind; none may survive the patch. */
export function hasAvdPlaceholders(text: string): boolean {
  return /=<(build|temp)>/.test(text);
}
