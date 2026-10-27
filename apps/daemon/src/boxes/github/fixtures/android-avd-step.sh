set -eu
SDK=/var/lib/orquester/devices/android-sdk
TOOLS=/var/lib/orquester/devices/tools
export ANDROID_HOME="$SDK" ANDROID_SDK_ROOT="$SDK" ANDROID_AVD_HOME=/var/lib/orquester/devices/avd
export ANDROID_USER_HOME=/var/lib/orquester/devices/android-user ANDROID_EMULATOR_HOME=/var/lib/orquester/devices/android-user
export HOME=/var/lib/orquester/devices/home TMPDIR=/var/lib/orquester/devices/tmp XDG_RUNTIME_DIR=/var/lib/orquester/devices/runtime
export PATH="$SDK/platform-tools:$SDK/emulator:$SDK/cmdline-tools/latest/bin:$PATH"
mkdir -p "$ANDROID_AVD_HOME" "$ANDROID_USER_HOME" "$HOME" "$TMPDIR" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
TUNE="$RUNNER_TEMP/orq-avd-tune"
LOGS="$RUNNER_TEMP/orq-avd-logs"
mkdir -p "$TUNE" "$LOGS"
cat > "$TUNE/avd-tuning.mjs" << 'ORQ_AVD_TUNING'
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

/** The guest command that prints the cutout rect SystemUI sizes the hole's window by (in pixels, like the cutout). */
export const CUTOUT_RECT_LOOKUP = "cmd overlay lookup android android:string/config_mainBuiltInDisplayCutoutRectApproximation";
/** The guest command that prints whether the cutout is drawn filled (`true`: without it no hole is drawn). */
export const CUTOUT_FILL_LOOKUP = "cmd overlay lookup android android:bool/config_fillMainBuiltInDisplayCutout";

/**
 * The guest commands (as root, run in order: fabricate all, disable, enable all) that carry a
 * display cutout in dp: `OrqCutout` with `dp` ({@link cutoutSpecInDp}'s, no `'`), `OrqCutoutRect`
 * with the rect approximation re-expressed in dp, `OrqCutoutFill` when the image fills the hole;
 * the device emulation overlays enabled in `overlayList` (`cmd overlay list`) are disabled.
 * `rect` and `fill` are what {@link CUTOUT_RECT_LOOKUP} and {@link CUTOUT_FILL_LOOKUP} printed.
 */
export function cutoutOverlayPlan(input) {
  if (input.dp.includes("'")) throw new Error("unexpected cutout spec");
  const looked = (text) => text.trim().replace(/^@\S+ -> /, "");
  const rect = cutoutSpecInDp(looked(input.rect), input.density);
  const overlays = [["OrqCutout", "string/config_mainBuiltInDisplayCutout", `0x03 '${input.dp}'`]];
  if (rect && !rect.includes("'")) overlays.push(["OrqCutoutRect", "string/config_mainBuiltInDisplayCutoutRectApproximation", `0x03 '${rect}'`]);
  if (looked(input.fill) === "true") overlays.push(["OrqCutoutFill", "bool/config_fillMainBuiltInDisplayCutout", "0x12 0xffffffff"]);
  const emulation = input.overlayList
    .split("\n")
    .map((line) => /^\s*\[x\]\s+(com\.android\.internal\.emulation\.[A-Za-z0-9_.]+)/.exec(line)?.[1])
    .filter((name) => name !== undefined);
  return {
    fabricate: overlays.map(([name, resource, value]) => `cmd overlay fabricate --target android --name ${name} android:${resource} ${value}`),
    disable: emulation.map((name) => `cmd overlay disable ${name}`),
    enable: overlays.map(([name]) => `cmd overlay enable com.android.shell:${name}`)
  };
}

/** Placeholders avdmanager 22 leaves behind; none may survive the patch. */
export function hasAvdPlaceholders(text) {
  return /=<(build|temp)>/.test(text);
}
ORQ_AVD_TUNING
cat > "$TUNE/tune.mjs" << 'ORQ_AVD_TUNE'
import { readFileSync, writeFileSync } from "node:fs";
import { cutoutOverlayPlan, cutoutSpecInDp, hasAvdPlaceholders, parseIni, patchAvdConfig } from "./avd-tuning.mjs";
const [command, ...args] = process.argv.slice(2);
if (command === "patch") {
  const [file, name, width, height, density, gpuMode] = args;
  const original = readFileSync(file, "utf8");
  const patched = patchAvdConfig(original, { name, hardware: { width: Number(width), height: Number(height), density: Number(density) }, gpuMode });
  if (hasAvdPlaceholders(patched)) {
    console.error(name + "'s config.ini still has avdmanager placeholders");
    process.exit(1);
  }
  writeFileSync(file, patched);
  const deviceDensity = Number(parseIni(original).get("hw.lcd.density"));
  console.log(Number.isInteger(deviceDensity) && deviceDensity > 0 ? String(deviceDensity) : "");
} else if (command === "cutout") {
  console.log(cutoutSpecInDp(args[0] ?? "", Number(args[1])) ?? "");
} else if (command === "cutout-plan") {
  const [part, dp, rect, fill, density, overlayList] = args;
  const commands = cutoutOverlayPlan({ dp, rect, fill, density: Number(density), overlayList })[part];
  if (!commands) process.exit(2);
  if (commands.length > 0) console.log(commands.join("\n"));
} else if (command === "avd-marker") {
  const [file, profile, configHash, deviceDensity] = args;
  const marker = { profile, configHash, createdAt: new Date().toISOString(), ...(deviceDensity ? { deviceDensity: Number(deviceDensity) } : {}), source: "cache" };
  writeFileSync(file, JSON.stringify(marker) + "\n");
} else if (command === "golden-marker") {
  const [file, gpu, configHash, sdk] = args;
  let emulatorRevision = null;
  try {
    emulatorRevision = /^Pkg\.Revision=(.+)$/m.exec(readFileSync(sdk + "/emulator/source.properties", "utf8"))?.[1]?.trim() ?? null;
  } catch {}
  const marker = { snapshot: "orq-golden", gpu, configHash, emulatorRevision, createdAt: new Date().toISOString(), source: "cache" };
  writeFileSync(file, JSON.stringify(marker) + "\n");
} else {
  process.exit(2);
}
ORQ_AVD_TUNE
CLK_TCK=$(getconf CLK_TCK)
CONSOLE_PORT=5554
GRPC_PORT=8554
SERIAL="emulator-$CONSOLE_PORT"
QEMU=
LAUNCHER=

warn() { echo "::warning::$*"; }
alive() { [ -n "$QEMU" ] && kill -0 "$QEMU" 2> /dev/null; }
ticks() { awk '{ sub(/^.*\) /, ""); print $12 + $13 }' "/proc/$1/stat" 2> /dev/null; }
sh_adb() { timeout "$1" adb -s "$SERIAL" shell "$2"; }

# adb emu kill, then SIGTERM, then SIGKILL (emulator.ts stopEmulator); the launcher's group last.
stop_emulator() {
  if alive; then
    timeout 10 adb -s "$SERIAL" emu kill > /dev/null 2>&1 || true
    end=$(($(date +%s) + $1))
    while alive && [ "$(date +%s)" -lt "$end" ]; do sleep 0.2; done
    if alive; then kill -TERM "$QEMU" 2> /dev/null || true; sleep 10; fi
    if alive; then kill -KILL "$QEMU" 2> /dev/null || true; sleep 1; fi
  fi
  if [ -n "$LAUNCHER" ]; then kill -TERM -- "-$LAUNCHER" 2> /dev/null || true; fi
  QEMU=
  LAUNCHER=
}

# The dp display cutout (golden.ts fixDisplayCutout, the overlays from avd-tuning.mjs cutoutOverlayPlan): best effort, as on a box host.
fix_cutout() {
  spec=$(sh_adb 30 'dumpsys display' | sed -n 's/.*cutoutSpec={\([^}]*\)}.*/\1/p' | head -1)
  dp=$(node "$TUNE/tune.mjs" cutout "$spec" "$1")
  if [ -z "$dp" ]; then echo "display cutout kept"; return 0; fi
  case "$dp" in *"'"*) warn "unexpected cutout spec"; return 1 ;; esac
  list=$(sh_adb 30 'cmd overlay list') || true
  root=$(timeout 30 adb -s "$SERIAL" root 2>&1) || { warn "adb root failed: $root"; return 1; }
  case "$root" in *"cannot run as root"*) warn "adb root failed: $root"; return 1 ;; esac
  sleep 1
  timeout 60 adb -s "$SERIAL" wait-for-device
  # What the emulation overlay also sets for the hole, read before it goes: its rect and its fill.
  rect=$(sh_adb 30 'cmd overlay lookup android android:string/config_mainBuiltInDisplayCutoutRectApproximation') || true
  fill=$(sh_adb 30 'cmd overlay lookup android android:bool/config_fillMainBuiltInDisplayCutout') || true
  failed=
  fabricate=$(node "$TUNE/tune.mjs" cutout-plan fabricate "$dp" "$rect" "$fill" "$1" "$list") || failed="unexpected cutout spec"
  disable=$(node "$TUNE/tune.mjs" cutout-plan disable "$dp" "$rect" "$fill" "$1" "$list") || failed="unexpected cutout spec"
  enable=$(node "$TUNE/tune.mjs" cutout-plan enable "$dp" "$rect" "$fill" "$1" "$list") || failed="unexpected cutout spec"
  if [ -z "$failed" ]; then
    while IFS= read -r command; do
      [ -n "$command" ] || continue
      out=$(sh_adb 30 "$command" 2>&1 < /dev/null) || failed=1
      if [ -n "$failed" ] || printf '%s' "$out" | grep -qiE 'error|exception'; then failed="fabricating the cutout overlay failed: $out"; break; fi
    done <<< "$fabricate"
  fi
  if [ -z "$failed" ]; then
    while IFS= read -r command; do
      [ -n "$command" ] || continue
      sh_adb 30 "$command" > /dev/null 2>&1 < /dev/null || true
    done <<< "$disable"
    while IFS= read -r command; do
      [ -n "$command" ] || continue
      out=$(sh_adb 30 "$command" 2>&1 < /dev/null) || failed=1
      if [ -n "$failed" ] || printf '%s' "$out" | grep -qi exception; then failed="enabling the cutout overlay failed: $out"; break; fi
    done <<< "$enable"
  fi
  if [ -z "$failed" ]; then
    # SystemUI keeps drawing the hole it drew at boot (the pixel one) until it starts again.
    before=$(sh_adb 30 'pidof com.android.systemui' | tr -d '\r')
    if [ -n "$before" ]; then
      sh_adb 30 "kill ${before%% *}" > /dev/null 2>&1 || true
      for _ in $(seq 60); do
        sleep 0.5
        now=$(sh_adb 30 'pidof com.android.systemui' | tr -d '\r')
        if [ -n "$now" ] && [ "$now" != "$before" ]; then break; fi
      done
      sleep 5
    fi
  fi
  timeout 30 adb -s "$SERIAL" unroot > /dev/null 2>&1 || true
  sleep 1
  timeout 60 adb -s "$SERIAL" wait-for-device || true
  if [ -n "$failed" ]; then warn "$failed"; return 1; fi
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if sh_adb 30 'dumpsys display' | grep -q 'cutoutSpec={[^}]*@dp'; then echo "display cutout fixed"; return 0; fi
    sleep 0.5
  done
  warn "the display did not take the dp cutout"
  return 1
}

# One golden boot of AVD $1 with GPU mode $2 (golden.ts createGoldenSnapshot with a named snapshot).
golden() {
  name=$1 gpu=$2 dir=$3 density=$4 device_density=$5
  log="$LOGS/golden-$name-$gpu.log"
  rm -rf "$dir/snapshots" "$dir/orq-box-golden.json"
  timeout 30 adb start-server > /dev/null 2>&1 || true
  setsid emulator '-avd' "$name" '-no-window' '-no-audio' '-no-boot-anim' '-no-metrics' '-accel' 'on' '-gpu' "$gpu" '-port' "$CONSOLE_PORT" '-grpc' "$GRPC_PORT" '-grpc-use-token' '-camera-back' 'none' '-camera-front' 'none' '-no-snapshot-load' '-no-snapshot-save' > "$log" 2>&1 < /dev/null &
  LAUNCHER=$!
  for _ in $(seq 150); do
    QEMU=$(pgrep -g "$LAUNCHER" '^qemu-system' | head -1 || true)
    if [ -n "$QEMU" ] || ! kill -0 "$LAUNCHER" 2> /dev/null; then break; fi
    sleep 0.2
  done
  if [ -z "$QEMU" ]; then warn "$name: the emulator did not start"; tail -40 "$log"; stop_emulator 5; return 1; fi
  started=$(date +%s)
  end=$((started + 600))
  until [ "$(timeout 5 adb -s "$SERIAL" shell getprop sys.boot_completed 2> /dev/null | tr -d '\r')" = 1 ]; do
    if ! alive; then warn "$name: exited during boot"; tail -40 "$log"; stop_emulator 5; return 1; fi
    if [ "$(date +%s)" -ge "$end" ]; then warn "$name: did not finish booting"; tail -40 "$log"; stop_emulator 5; return 1; fi
    sleep 1
  done
  echo "$name: booted in $(($(date +%s) - started)) s"
  # Settle: emulator CPU under 60 % of a core for two 10 s windows in a row (≤ 5 min).
  settle_end=$(($(date +%s) + 300))
  quiet=0
  while [ "$(date +%s)" -lt "$settle_end" ]; do
    before=$(ticks "$QEMU")
    sleep 10
    after=$(ticks "$QEMU")
    if [ -z "$before" ] || [ -z "$after" ]; then warn "$name: exited while settling"; stop_emulator 5; return 1; fi
    percent=$(((after - before) * 100 / CLK_TCK / 10))
    echo "$name: settling (emulator CPU $percent %)"
    if [ "$percent" -lt 60 ]; then quiet=$((quiet + 1)); else quiet=0; fi
    if [ "$quiet" -ge 2 ]; then break; fi
  done
  sh_adb 60 'settings put global window_animation_scale 0; settings put global transition_animation_scale 0; settings put global animator_duration_scale 0; settings put system screen_off_timeout 2147483647; settings put global hide_error_dialogs 1; svc power stayon true; input keyevent KEYCODE_WAKEUP' || { warn "$name: applying guest settings failed"; stop_emulator 5; return 1; }
  if [ -n "$device_density" ] && [ "$device_density" != "$density" ]; then fix_cutout "$device_density" || true; fi
  for apk in "$TOOLS"/node_modules/agent-device/android/snapshot-helper/dist/*.apk "$TOOLS"/node_modules/agent-device/android/ime-helper/dist/*.apk; do
    [ -f "$apk" ] || continue
    timeout 120 adb -s "$SERIAL" install -r -g "$apk" > /dev/null || warn "$name: pre-installing $apk failed"
  done
  sleep 3
  sh_adb 30 'am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS' > /dev/null || warn "$name: closing system dialogs failed"
  sleep 1
  saved=$(timeout 180 adb -s "$SERIAL" emu avd snapshot save orq-golden 2>&1) || { warn "$name: saving the snapshot failed: $saved"; stop_emulator 5; return 1; }
  case "$saved" in *KO*) warn "$name: saving the snapshot failed: $saved"; stop_emulator 5; return 1 ;; esac
  stop_emulator 180
  [ -f "$dir/snapshots/orq-golden/snapshot.pb" ] || { warn "$name: the snapshot was not saved"; tail -40 "$log"; return 1; }
  echo "$name: saved after $(($(date +%s) - started)) s in total"
}

# An AVD made as createAvd makes it, then its golden snapshot (GPU modes in order) and both markers.
make_profile() {
  name=$1 image=$2 device=$3 width=$4 height=$5 density=$6 profile=$7 hash=$8
  echo "::group::$name ($device, ${width}x${height} @${density})"
  dir="$ANDROID_AVD_HOME/$name.avd"
  rm -rf "$dir" "$ANDROID_AVD_HOME/$name.ini"
  echo no | avdmanager create avd --force --name "$name" --package "$image" --device "$device" --path "$dir"
  # Older avdmanagers write the .ini under ~/.android/avd whatever ANDROID_AVD_HOME says.
  if [ ! -f "$ANDROID_AVD_HOME/$name.ini" ] && [ -f "$ANDROID_USER_HOME/avd/$name.ini" ]; then
    mv "$ANDROID_USER_HOME/avd/$name.ini" "$ANDROID_AVD_HOME/$name.ini"
  fi
  device_density=$(node "$TUNE/tune.mjs" patch "$dir/config.ini" "$name" "$width" "$height" "$density" 'swangle_indirect')
  node "$TUNE/tune.mjs" avd-marker "$dir/orq-avd.json" "$profile" "$hash" "$device_density"
  made=
  for gpu in swiftshader_indirect swangle_indirect; do
    if golden "$name" "$gpu" "$dir" "$density" "$device_density"; then made=$gpu; break; fi
    warn "$name: the golden snapshot with -gpu $gpu failed"
  done
  if [ -z "$made" ]; then echo "::error::$name: no GPU mode made a golden snapshot"; exit 1; fi
  node "$TUNE/tune.mjs" golden-marker "$dir/orq-box-golden.json" "$made" "$hash" "$SDK"
  du -sh "$dir"
  echo "::endgroup::"
}

emulator -accel-check
make_profile 'orq-pixel-9' 'system-images;android-35;google_apis;x86_64' 'pixel_9' '720' '1616' '280' 'pixel-9' '4315e12699067d19'
make_profile 'orq-pixel-tablet' 'system-images;android-35;google_apis;x86_64' 'pixel_tablet' '1280' '800' '160' 'pixel-tablet' '3e4b45e65af65d7c'
make_profile 'orq-pixel-fold' 'system-images;android-35;google_apis;x86_64' 'pixel_fold' '1104' '920' '210' 'pixel-fold' 'ea218d2942ac8cc3'
timeout 30 adb kill-server || true
