// AVD tuning that must run unchanged in two places: the daemon (`avd-config.ts` re-exports it for
// local and box hosts) and the Linux device-cache workflow on a Blacksmith runner, whose script
// embeds this file's text verbatim (`boxes/github/device-cache.ts`). Plain JavaScript, no imports:
// it runs under any Node. Types: `avd-tuning.d.mts`.

/** Parse `key=value` lines (order kept). */
export function parseIni(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at <= 0 || line.trimStart().startsWith("#")) continue;
    map.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  return map;
}

function serializeIni(map) {
  return `${[...map].map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}

const SCALED_X = /^hw\.displayRegion\.\d+\.\d+\.(width|xOffset)$/;
const SCALED_Y = /^hw\.displayRegion\.\d+\.\d+\.(height|yOffset)$/;

function scaleLength(value, factor) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return value; // 0 and -1 (unset) stay
  return String(Math.max(1, Math.round(n * factor)));
}

/** `hw.sensor.hinge.areas`: `x-y-w-h` per hinge, comma-separated. */
function scaleHingeAreas(value, sx, sy) {
  return value
    .split(",")
    .map((area) => {
      const parts = area.trim().split("-");
      if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return area.trim();
      const [x, y, w, h] = parts.map(Number);
      return [Math.round(x * sx), Math.round(y * sy), w > 0 ? Math.max(1, Math.round(w * sx)) : 0, h > 0 ? Math.max(1, Math.round(h * sy)) : 0].join("-");
    })
    .join(", ");
}

/**
 * The tuned `config.ini`: placeholders replaced, the framebuffer set (foldable geometry scaled with
 * it), Orquester's hardware choices applied. Keys it does not set stay as avdmanager wrote them.
 */
export function patchAvdConfig(text, options) {
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
  const set = {
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
    "hw.gpu.mode": options.gpuMode,
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
export function cutoutSpecInDp(spec, density) {
  const text = spec.trim();
  if (!text || /@dp\b/.test(text) || !(density > 0)) return null;
  const at = text.search(/@/);
  const path = at < 0 ? text : text.slice(0, at);
  const markers = at < 0 ? "" : text.slice(at).trim();
  const factor = 160 / density;
  const tokens = path.match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? [];
  const out = [];
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
export function hasAvdPlaceholders(text) {
  return /=<(build|temp)>/.test(text);
}
