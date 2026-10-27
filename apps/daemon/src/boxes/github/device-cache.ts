/**
 * Device-host caches on Blacksmith boxes (Devices phase 2, spec §2 goal 6 and §5): where a device
 * host keeps the Android SDK, AVDs and device tools in the box, the `actions/cache` keys and paths
 * the workflows restore and save them under, and the shell scripts the cache-warming workflow
 * (`orquester-device-cache.yml`) runs to build them.
 *
 * The device service imports the box paths from here so the box it drives finds what the box
 * workflow restored. Box runs only restore (a destroy cancels the run, so a post-job save would
 * never run); the separate cache-warming run builds and saves.
 *
 * A key changes whenever what it covers changes (packages, tool versions, Node major, the Xcode
 * build; the Android key hashes its generated AVD script, which the box host's own AVD modules
 * write), so a stale cache is never restored; bump {@link DEVICE_CACHE_VERSION}
 * to drop every cache when the layout itself changes. Restore and save must use the same path
 * lists (`actions/cache` versions an entry by its paths): both come from the constants here.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { ANDROID_SYSTEM_IMAGE as API_ANDROID_SYSTEM_IMAGE, deviceProfile, type DeviceProfile } from "@orquester/api";
import { DEFAULT_ANDROID_DEVICE_PROFILE_IDS } from "@orquester/config";

import { avdHardware, avdName, CUTOUT_FILL_LOOKUP, CUTOUT_RECT_LOOKUP } from "../../devices/android/avd-config.ts";
import { CONSOLE_PORT_MIN, EMULATOR_GPU_MODE, emulatorArgs, grpcPortFor } from "../../devices/android/emulator.ts";
import { androidLayoutAt } from "../../devices/android/env.ts";
import {
  CLOSE_SYSTEM_DIALOGS_SCRIPT,
  GOLDEN_BOOT_TIMEOUT_MS,
  GUEST_SETTINGS_SCRIPT,
  SETTLE_CPU_PERCENT,
  SETTLE_MAX_MS,
  SETTLE_WINDOW_MS,
  SYSTEM_UI_PIDOF,
  SYSTEM_UI_POLL,
  SYSTEM_UI_SETTLE_MS
} from "../../devices/android/golden.ts";
import toolVersions from "../../devices/tool-versions.json" with { type: "json" };
import { CMDLINE_TOOLS, profileHash, SDK_PACKAGES } from "../../devices/toolchain/android-sdk.ts";
import { BOX_TOOLS_LOCK, NPM_CI_SCRIPT } from "../../devices/toolchain/npm-tools.ts";

/** Which OS a Blacksmith box runs. */
export type BlacksmithOs = "macos" | "linux";
export const BLACKSMITH_OSES: readonly BlacksmithOs[] = ["macos", "linux"];
/** What the box workflow prepares before `orq-agent` starts: `devices` restores the device caches. */
export type BlacksmithPrepare = "none" | "devices";
export const BLACKSMITH_PREPARES: readonly BlacksmithPrepare[] = ["none", "devices"];

/** Pinned device tools (`apps/daemon/src/devices/tool-versions.json`, owned by the device service). */
export const DEVICE_TOOL_VERSIONS: Readonly<{ "agent-device": string; "expo-device-hub": string }> = toolVersions;

/** Bump to drop every device cache (a layout change the keys below do not cover). */
export const DEVICE_CACHE_VERSION = "v1";

// ---------------------------------------------------------------------------
// Box paths (the workflow's paths step makes /var/lib/orquester the runner user's)
// ---------------------------------------------------------------------------

/** Device state in a box. */
export const BOX_DEVICES_DIR = "/var/lib/orquester/devices";
/** `ANDROID_HOME`/`ANDROID_SDK_ROOT`: cmdline-tools, platform-tools, emulator, the system image. */
export const BOX_ANDROID_SDK_DIR = `${BOX_DEVICES_DIR}/android-sdk`;
/** `ANDROID_AVD_HOME`: the AVDs of {@link ANDROID_AVDS} with their golden snapshots. */
export const BOX_ANDROID_AVD_DIR = `${BOX_DEVICES_DIR}/avd`;
/** npm prefix of the pinned device tools: binaries in `node_modules/.bin`. */
export const BOX_DEVICE_TOOLS_DIR = `${BOX_DEVICES_DIR}/tools`;
/** agent-device's iOS XCTest runner build (DerivedData, ~25 MB); agent-device keeps it in the runner user's home. */
export const BOX_APPLE_RUNNER_DIR = "~/.agent-device/apple-runner";
/** The Node major `actions/setup-node` installs for device tools (part of the tools cache key: native modules). */
export const DEVICE_NODE_VERSION = "22";

/** A pinned tool's binary in a box. */
export function boxDeviceToolBin(tool: keyof typeof DEVICE_TOOL_VERSIONS): string {
  return `${BOX_DEVICE_TOOLS_DIR}/node_modules/.bin/${tool}`;
}

// ---------------------------------------------------------------------------
// Android (Linux boxes)
// ---------------------------------------------------------------------------

/** The system image every profile runs (the API's; the box host installs the same one). */
export const ANDROID_SYSTEM_IMAGE = API_ANDROID_SYSTEM_IMAGE;
/** sdkmanager packages installed next to cmdline-tools: the box host's list ({@link SDK_PACKAGES} and the image). */
export const ANDROID_SDK_PACKAGES: readonly string[] = [...SDK_PACKAGES, ANDROID_SYSTEM_IMAGE];
/**
 * The profiles the cache holds an AVD and golden snapshot of: Settings' default Android profiles
 * (a box host makes any other profile's AVD itself, on its first open).
 */
export const ANDROID_CACHE_PROFILES: readonly DeviceProfile[] = DEFAULT_ANDROID_DEVICE_PROFILE_IDS.map((id) => {
  const profile = deviceProfile(id);
  if (!profile || profile.platform !== "android") throw new Error(`unknown Android profile ${id}`);
  return profile;
});
/** The snapshot each AVD's golden boot is saved as (`adb emu avd snapshot save`); leases boot from it read-only. */
export const ANDROID_GOLDEN_SNAPSHOT = "orq-golden";
/**
 * GPU modes a rented Linux host's golden snapshot is tried with, in order (the cache's script and a
 * box host making its own alike); the one that worked is recorded in {@link BOX_GOLDEN_MARKER}
 * (a snapshot loads only with the mode it was saved with).
 */
export const ANDROID_RENTED_GPU_MODES: readonly string[] = ["swiftshader_indirect", "swangle_indirect"];
/** `<avd>/orq-<profile>.avd/orq-box-golden.json`: a box golden snapshot's GPU mode, config hash and emulator revision. */
export const BOX_GOLDEN_MARKER = "orq-box-golden.json";
/** The cache's AVDs and golden snapshots carry this as their markers' `source`. */
export const ANDROID_CACHE_SOURCE = "cache";
/** Bump to drop the Android cache alone (a change its script does not show); 2: AVDs tuned like a box host's. */
export const ANDROID_CACHE_VERSION = "v2";

/** The box layout the Android tools run with (`android-host.ts` uses the same for a rented host). */
const BOX_ANDROID_LAYOUT = androidLayoutAt(BOX_DEVICES_DIR);

// ---------------------------------------------------------------------------
// Android step scripts (bash; constants only — no workflow input reaches them)
// ---------------------------------------------------------------------------

/** Single-quote a value for bash. */
function sq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Install cmdline-tools (the box host's pinned build, checksum verified) and {@link ANDROID_SDK_PACKAGES} into {@link BOX_ANDROID_SDK_DIR} (needs Java 17+). */
export const ANDROID_SDK_STEP_SCRIPT = `set -eu
SDK=${BOX_ANDROID_SDK_DIR}
mkdir -p "$SDK/cmdline-tools" ${BOX_ANDROID_AVD_DIR}
curl -fsSL --retry 3 -o "$RUNNER_TEMP/cmdline-tools.zip" ${sq(CMDLINE_TOOLS.url)}
sum=$(sha256sum "$RUNNER_TEMP/cmdline-tools.zip" | awk '{ print $1 }')
if [ "$sum" != ${sq(CMDLINE_TOOLS.sha256)} ]; then
  echo "::error::cmdline-tools checksum mismatch ($sum)"
  exit 1
fi
rm -rf "$SDK/cmdline-tools/latest" "$RUNNER_TEMP/cmdline-tools"
unzip -q "$RUNNER_TEMP/cmdline-tools.zip" -d "$RUNNER_TEMP"
mv "$RUNNER_TEMP/cmdline-tools" "$SDK/cmdline-tools/latest"
rm -f "$RUNNER_TEMP/cmdline-tools.zip"
SM="$SDK/cmdline-tools/latest/bin/sdkmanager"
yes 2> /dev/null | "$SM" --sdk_root="$SDK" --licenses > /dev/null || true
"$SM" --sdk_root="$SDK" --install ${ANDROID_SDK_PACKAGES.map(sq).join(" ")}
"$SDK/emulator/emulator" -version | head -1
`;

/** The emulator flags of a golden boot (`emulator.ts` `emulatorArgs`) with the AVD, ports and GPU mode as shell variables. */
function goldenBootArgs(): string {
  const sentinels = new Map([
    ["ORQ_AVD", '"$name"'],
    ["ORQ_GPU", '"$gpu"'],
    ["65531", '"$CONSOLE_PORT"'],
    ["65533", '"$GRPC_PORT"']
  ]);
  return emulatorArgs({ avd: "ORQ_AVD", consolePort: 65531, grpcPort: 65533, golden: true, gpu: "ORQ_GPU", snapshot: ANDROID_GOLDEN_SNAPSHOT })
    .map((arg) => sentinels.get(arg) ?? sq(arg))
    .join(" ");
}

/** `tune.mjs`: runs `avd-tuning.mjs` (the daemon's own config patch, dp cutout and its overlays) in the workflow. */
const AVD_TUNE_DRIVER = `import { readFileSync, writeFileSync } from "node:fs";
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
  if (commands.length > 0) console.log(commands.join("\\n"));
} else if (command === "avd-marker") {
  const [file, profile, configHash, deviceDensity] = args;
  const marker = { profile, configHash, createdAt: new Date().toISOString(), ...(deviceDensity ? { deviceDensity: Number(deviceDensity) } : {}), source: ${JSON.stringify(ANDROID_CACHE_SOURCE)} };
  writeFileSync(file, JSON.stringify(marker) + "\\n");
} else if (command === "golden-marker") {
  const [file, gpu, configHash, sdk] = args;
  let emulatorRevision = null;
  try {
    emulatorRevision = /^Pkg\\.Revision=(.+)$/m.exec(readFileSync(sdk + "/emulator/source.properties", "utf8"))?.[1]?.trim() ?? null;
  } catch {}
  const marker = { snapshot: ${JSON.stringify(ANDROID_GOLDEN_SNAPSHOT)}, gpu, configHash, emulatorRevision, createdAt: new Date().toISOString(), source: ${JSON.stringify(ANDROID_CACHE_SOURCE)} };
  writeFileSync(file, JSON.stringify(marker) + "\\n");
} else {
  process.exit(2);
}
`;

/** The AVD tuning module's text (`devices/android/avd-tuning.mjs`), embedded verbatim. */
const AVD_TUNING_SOURCE = readFileSync(new URL("../../devices/android/avd-tuning.mjs", import.meta.url), "utf8");

/** One `make_profile` call: the profile's AVD as `avdmanager` and `createAvd` make it, and its config hash. */
function makeProfileCall(profile: DeviceProfile): string {
  const hardware = avdHardware(profile);
  return `make_profile ${[avdName(profile.id), profile.systemImage ?? ANDROID_SYSTEM_IMAGE, hardware.device, String(hardware.width), String(hardware.height), String(hardware.density), profile.id, profileHash(profile)].map(sq).join(" ")}`;
}

/**
 * Create {@link ANDROID_CACHE_PROFILES}' AVDs and golden snapshots exactly as a Linux box host
 * makes its own (`hosts/box/android-host.ts` with `toolchain/android-sdk.ts` `createAvd` and
 * `android/golden.ts` `createGoldenSnapshot`), so a host the cache restored runs the same tuned
 * framebuffers: `avdmanager create avd` from the pinned cmdline-tools, the config patch of
 * `avd-tuning.mjs` (embedded verbatim), the box layout's environment, the golden boot's flags
 * (`emulatorArgs`), `sys.boot_completed`, the CPU settle, the guest settings, the dp display cutout
 * (`adb root`, the overlays of `avd-tuning.mjs` `cutoutOverlayPlan`, a SystemUI restart),
 * agent-device's helper APKs, the system-dialog broadcast, a named save; GPU modes tried in {@link ANDROID_RENTED_GPU_MODES} order. Each AVD gets the box
 * host's markers (`orq-avd.json`, {@link BOX_GOLDEN_MARKER} with the GPU mode that worked), with
 * `source: "cache"`. Needs the device tools restored first (the helper APKs).
 */
export const ANDROID_AVD_STEP_SCRIPT = `set -eu
SDK=${BOX_ANDROID_SDK_DIR}
TOOLS=${BOX_DEVICE_TOOLS_DIR}
export ANDROID_HOME="$SDK" ANDROID_SDK_ROOT="$SDK" ANDROID_AVD_HOME=${BOX_ANDROID_LAYOUT.avd}
export ANDROID_USER_HOME=${BOX_ANDROID_LAYOUT.androidUser} ANDROID_EMULATOR_HOME=${BOX_ANDROID_LAYOUT.androidUser}
export HOME=${BOX_ANDROID_LAYOUT.home} TMPDIR=${BOX_ANDROID_LAYOUT.tmp} XDG_RUNTIME_DIR=${BOX_ANDROID_LAYOUT.runtime}
export PATH="$SDK/platform-tools:$SDK/emulator:$SDK/cmdline-tools/latest/bin:$PATH"
mkdir -p "$ANDROID_AVD_HOME" "$ANDROID_USER_HOME" "$HOME" "$TMPDIR" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
TUNE="$RUNNER_TEMP/orq-avd-tune"
LOGS="$RUNNER_TEMP/orq-avd-logs"
mkdir -p "$TUNE" "$LOGS"
cat > "$TUNE/avd-tuning.mjs" << 'ORQ_AVD_TUNING'
${AVD_TUNING_SOURCE.trimEnd()}
ORQ_AVD_TUNING
cat > "$TUNE/tune.mjs" << 'ORQ_AVD_TUNE'
${AVD_TUNE_DRIVER.trimEnd()}
ORQ_AVD_TUNE
CLK_TCK=$(getconf CLK_TCK)
CONSOLE_PORT=${CONSOLE_PORT_MIN}
GRPC_PORT=${grpcPortFor(CONSOLE_PORT_MIN)}
SERIAL="emulator-$CONSOLE_PORT"
QEMU=
LAUNCHER=

warn() { echo "::warning::$*"; }
alive() { [ -n "$QEMU" ] && kill -0 "$QEMU" 2> /dev/null; }
ticks() { awk '{ sub(/^.*\\) /, ""); print $12 + $13 }' "/proc/$1/stat" 2> /dev/null; }
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
  spec=$(sh_adb 30 'dumpsys display' | sed -n 's/.*cutoutSpec={\\([^}]*\\)}.*/\\1/p' | head -1)
  dp=$(node "$TUNE/tune.mjs" cutout "$spec" "$1")
  if [ -z "$dp" ]; then echo "display cutout kept"; return 0; fi
  case "$dp" in *"'"*) warn "unexpected cutout spec"; return 1 ;; esac
  list=$(sh_adb 30 'cmd overlay list') || true
  root=$(timeout 30 adb -s "$SERIAL" root 2>&1) || { warn "adb root failed: $root"; return 1; }
  case "$root" in *"cannot run as root"*) warn "adb root failed: $root"; return 1 ;; esac
  sleep 1
  timeout 60 adb -s "$SERIAL" wait-for-device
  # What the emulation overlay also sets for the hole, read before it goes: its rect and its fill.
  rect=$(sh_adb 30 ${sq(CUTOUT_RECT_LOOKUP)}) || true
  fill=$(sh_adb 30 ${sq(CUTOUT_FILL_LOOKUP)}) || true
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
    before=$(sh_adb 30 ${sq(SYSTEM_UI_PIDOF)} | tr -d '\\r')
    if [ -n "$before" ]; then
      sh_adb 30 "kill \${before%% *}" > /dev/null 2>&1 || true
      for _ in $(seq ${SYSTEM_UI_POLL.tries}); do
        sleep ${SYSTEM_UI_POLL.intervalMs / 1000}
        now=$(sh_adb 30 ${sq(SYSTEM_UI_PIDOF)} | tr -d '\\r')
        if [ -n "$now" ] && [ "$now" != "$before" ]; then break; fi
      done
      sleep ${SYSTEM_UI_SETTLE_MS / 1000}
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
  rm -rf "$dir/snapshots" "$dir/${BOX_GOLDEN_MARKER}"
  timeout 30 adb start-server > /dev/null 2>&1 || true
  setsid emulator ${goldenBootArgs()} > "$log" 2>&1 < /dev/null &
  LAUNCHER=$!
  for _ in $(seq 150); do
    QEMU=$(pgrep -g "$LAUNCHER" '^qemu-system' | head -1 || true)
    if [ -n "$QEMU" ] || ! kill -0 "$LAUNCHER" 2> /dev/null; then break; fi
    sleep 0.2
  done
  if [ -z "$QEMU" ]; then warn "$name: the emulator did not start"; tail -40 "$log"; stop_emulator 5; return 1; fi
  started=$(date +%s)
  end=$((started + ${Math.round(GOLDEN_BOOT_TIMEOUT_MS / 1000)}))
  until [ "$(timeout 5 adb -s "$SERIAL" shell getprop sys.boot_completed 2> /dev/null | tr -d '\\r')" = 1 ]; do
    if ! alive; then warn "$name: exited during boot"; tail -40 "$log"; stop_emulator 5; return 1; fi
    if [ "$(date +%s)" -ge "$end" ]; then warn "$name: did not finish booting"; tail -40 "$log"; stop_emulator 5; return 1; fi
    sleep 1
  done
  echo "$name: booted in $(($(date +%s) - started)) s"
  # Settle: emulator CPU under ${SETTLE_CPU_PERCENT} % of a core for two ${SETTLE_WINDOW_MS / 1000} s windows in a row (≤ ${SETTLE_MAX_MS / 60_000} min).
  settle_end=$(($(date +%s) + ${SETTLE_MAX_MS / 1000}))
  quiet=0
  while [ "$(date +%s)" -lt "$settle_end" ]; do
    before=$(ticks "$QEMU")
    sleep ${SETTLE_WINDOW_MS / 1000}
    after=$(ticks "$QEMU")
    if [ -z "$before" ] || [ -z "$after" ]; then warn "$name: exited while settling"; stop_emulator 5; return 1; fi
    percent=$(((after - before) * 100 / CLK_TCK / ${SETTLE_WINDOW_MS / 1000}))
    echo "$name: settling (emulator CPU $percent %)"
    if [ "$percent" -lt ${SETTLE_CPU_PERCENT} ]; then quiet=$((quiet + 1)); else quiet=0; fi
    if [ "$quiet" -ge 2 ]; then break; fi
  done
  sh_adb 60 ${sq(GUEST_SETTINGS_SCRIPT)} || { warn "$name: applying guest settings failed"; stop_emulator 5; return 1; }
  if [ -n "$device_density" ] && [ "$device_density" != "$density" ]; then fix_cutout "$device_density" || true; fi
  for apk in "$TOOLS"/node_modules/agent-device/android/snapshot-helper/dist/*.apk "$TOOLS"/node_modules/agent-device/android/ime-helper/dist/*.apk; do
    [ -f "$apk" ] || continue
    timeout 120 adb -s "$SERIAL" install -r -g "$apk" > /dev/null || warn "$name: pre-installing $apk failed"
  done
  sleep 3
  sh_adb 30 ${sq(CLOSE_SYSTEM_DIALOGS_SCRIPT)} > /dev/null || warn "$name: closing system dialogs failed"
  sleep 1
  saved=$(timeout 180 adb -s "$SERIAL" emu avd snapshot save ${ANDROID_GOLDEN_SNAPSHOT} 2>&1) || { warn "$name: saving the snapshot failed: $saved"; stop_emulator 5; return 1; }
  case "$saved" in *KO*) warn "$name: saving the snapshot failed: $saved"; stop_emulator 5; return 1 ;; esac
  stop_emulator 180
  [ -f "$dir/snapshots/${ANDROID_GOLDEN_SNAPSHOT}/snapshot.pb" ] || { warn "$name: the snapshot was not saved"; tail -40 "$log"; return 1; }
  echo "$name: saved after $(($(date +%s) - started)) s in total"
}

# An AVD made as createAvd makes it, then its golden snapshot (GPU modes in order) and both markers.
make_profile() {
  name=$1 image=$2 device=$3 width=$4 height=$5 density=$6 profile=$7 hash=$8
  echo "::group::$name ($device, \${width}x\${height} @\${density})"
  dir="$ANDROID_AVD_HOME/$name.avd"
  rm -rf "$dir" "$ANDROID_AVD_HOME/$name.ini"
  echo no | avdmanager create avd --force --name "$name" --package "$image" --device "$device" --path "$dir"
  # Older avdmanagers write the .ini under ~/.android/avd whatever ANDROID_AVD_HOME says.
  if [ ! -f "$ANDROID_AVD_HOME/$name.ini" ] && [ -f "$ANDROID_USER_HOME/avd/$name.ini" ]; then
    mv "$ANDROID_USER_HOME/avd/$name.ini" "$ANDROID_AVD_HOME/$name.ini"
  fi
  device_density=$(node "$TUNE/tune.mjs" patch "$dir/config.ini" "$name" "$width" "$height" "$density" ${sq(EMULATOR_GPU_MODE)})
  node "$TUNE/tune.mjs" avd-marker "$dir/orq-avd.json" "$profile" "$hash" "$device_density"
  made=
  for gpu in ${ANDROID_RENTED_GPU_MODES.join(" ")}; do
    if golden "$name" "$gpu" "$dir" "$density" "$device_density"; then made=$gpu; break; fi
    warn "$name: the golden snapshot with -gpu $gpu failed"
  done
  if [ -z "$made" ]; then echo "::error::$name: no GPU mode made a golden snapshot"; exit 1; fi
  node "$TUNE/tune.mjs" golden-marker "$dir/${BOX_GOLDEN_MARKER}" "$made" "$hash" "$SDK"
  du -sh "$dir"
  echo "::endgroup::"
}

emulator -accel-check
${ANDROID_CACHE_PROFILES.map(makeProfileCall).join("\n")}
timeout 30 adb kill-server || true
`;

function shortHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

/** Hash of everything the Android cache holds (the pinned cmdline-tools, the packages, the script that makes the AVDs): a change to any of it is a new key. */
export const ANDROID_CACHE_HASH = shortHash({ cmdlineTools: CMDLINE_TOOLS.sha256, packages: ANDROID_SDK_PACKAGES, avds: ANDROID_AVD_STEP_SCRIPT });
export const ANDROID_CACHE_KEY = `orq-devices-android-${ANDROID_CACHE_HASH}-${ANDROID_CACHE_VERSION}`;
export const ANDROID_CACHE_PATHS: readonly string[] = [BOX_ANDROID_SDK_DIR, BOX_ANDROID_AVD_DIR];

// ---------------------------------------------------------------------------
// Device tools (both) and the iOS runner (macOS boxes)
// ---------------------------------------------------------------------------

/**
 * simslim (MIT, mobai-app/simslim): turns off a simulator's unneeded background daemons (~4x less
 * memory). Pinned release binary (ad-hoc signed, darwin arm64) with its SHA-256; installed into
 * `<tools>/simslim/<tag>/simslim`, so the device-tools cache carries it.
 */
export const SIMSLIM_RELEASE = Object.freeze({
  version: "0.13.0",
  tag: "v0.13.0",
  url: "https://github.com/MobAI-App/simslim/releases/download/v0.13.0/simslim-v0.13.0-macos-arm64.tar.gz",
  sha256: "76807efb5beb57b73b40959eea04defe21fc18265811a495db1509b5e7be07c1"
});
/** simslim's binary under a tools dir. */
export const SIMSLIM_TOOL_PATH = `simslim/${SIMSLIM_RELEASE.tag}/simslim`;

/**
 * Install the pinned simslim into `$TOOLS` (POSIX sh; `$TOOLS` from the env, the rest constants).
 * Prints `simslim <version>` when it is there, or `simslim-unsupported <reason>` (exit 0) on a Mac
 * it cannot run on; exits non-zero when the download or the checksum fails.
 */
export const SIMSLIM_INSTALL_SCRIPT = `set -eu
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo "simslim-unsupported $(uname -s) $(uname -m)"
  exit 0
fi
bin="$TOOLS/${SIMSLIM_TOOL_PATH}"
if [ -x "$bin" ] && [ "$("$bin" --version 2> /dev/null)" = ${sq(`simslim ${SIMSLIM_RELEASE.version}`)} ]; then
  "$bin" --version
  exit 0
fi
tmp=$(mktemp -d "\${TMPDIR:-/tmp}/orq-simslim.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
curl -fsSL --retry 3 -o "$tmp/simslim.tar.gz" ${sq(SIMSLIM_RELEASE.url)}
sum=$(shasum -a 256 "$tmp/simslim.tar.gz" | awk '{ print $1 }')
if [ "$sum" != ${sq(SIMSLIM_RELEASE.sha256)} ]; then
  echo "simslim: checksum mismatch ($sum)" >&2
  exit 1
fi
tar -xzf "$tmp/simslim.tar.gz" -C "$tmp" simslim
mkdir -p "$(dirname "$bin")"
chmod 755 "$tmp/simslim"
mv "$tmp/simslim" "$bin"
"$bin" --version
`;

/** The tools cache key for an OS (native modules differ per OS and Node major). */
export function deviceToolsCacheKey(os: BlacksmithOs): string {
  return `orq-devices-tools-${os}-node${DEVICE_NODE_VERSION}-${shortHash({ tools: DEVICE_TOOL_VERSIONS, lock: deviceToolsLock().packageLock, simslim: SIMSLIM_RELEASE.sha256 })}-${DEVICE_CACHE_VERSION}`;
}

/** The shipped lockfile both tools install from (box installs and the cache alike). */
function deviceToolsLock(): NonNullable<typeof BOX_TOOLS_LOCK> {
  if (!BOX_TOOLS_LOCK) throw new Error("the device tools lockfile is missing from this build");
  return BOX_TOOLS_LOCK;
}
export const DEVICE_TOOLS_CACHE_PATHS: readonly string[] = [BOX_DEVICE_TOOLS_DIR];

/**
 * The iOS runner cache key for an Xcode build (`xcodebuild -version`'s "Build version", e.g.
 * `17E202`). The workflows pass `${{ steps.xcode.outputs.build }}`.
 */
export function appleRunnerCacheKey(xcodeBuild: string): string {
  return `orq-devices-apple-runner-${xcodeBuild}-agent-device-${DEVICE_TOOL_VERSIONS["agent-device"]}-${DEVICE_CACHE_VERSION}`;
}
export const APPLE_RUNNER_CACHE_PATHS: readonly string[] = [BOX_APPLE_RUNNER_DIR];

// ---------------------------------------------------------------------------
// Step scripts (bash; constants only — no workflow input reaches them)
// ---------------------------------------------------------------------------

/** Make /dev/kvm usable by the runner user (Linux; Blacksmith x64 runners have nested virtualization). */
export const KVM_STEP_SCRIPT = `set -eu
echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' | sudo tee /etc/udev/rules.d/99-orq-kvm.rules > /dev/null
sudo udevadm control --reload-rules
if [ -e /dev/kvm ]; then
  sudo udevadm trigger --name-match=kvm
  ls -l /dev/kvm
else
  echo "::warning::this runner has no /dev/kvm"
fi
`;

/** Read the Xcode build into the step output `build` (empty when unreadable: the runner cache is skipped). */
export const XCODE_BUILD_STEP_SCRIPT = `set -eu
build=$(xcodebuild -version 2>/dev/null | awk '/^Build version/ { print $3 }') || build=
case "$build" in
  '' | *[!A-Za-z0-9]*) echo "::warning::could not read the Xcode build"; build= ;;
esac
echo "build=$build" >> "$GITHUB_OUTPUT"
`;

/**
 * Install the pinned device tools into {@link BOX_DEVICE_TOOLS_DIR} from the shipped lockfile
 * (`npm ci --ignore-scripts`: every dependency pinned with its integrity, no lifecycle script),
 * and simslim on macOS.
 */
export const DEVICE_TOOLS_STEP_SCRIPT = `set -eu
mkdir -p ${BOX_DEVICE_TOOLS_DIR}
cd ${BOX_DEVICE_TOOLS_DIR}
cat > package.json << 'ORQ_PACKAGE_JSON'
${deviceToolsLock().packageJson.trimEnd()}
ORQ_PACKAGE_JSON
cat > package-lock.json << 'ORQ_PACKAGE_LOCK'
${deviceToolsLock().packageLock.trimEnd()}
ORQ_PACKAGE_LOCK
${NPM_CI_SCRIPT}./node_modules/.bin/agent-device --version
if [ "$(uname -s)" = Darwin ]; then
  TOOLS=${BOX_DEVICE_TOOLS_DIR} sh -c ${sq(SIMSLIM_INSTALL_SCRIPT)}
fi
`;

/**
 * Build agent-device's iOS runner (macOS): boot a simulator of the newest iOS runtime, open
 * Settings and take an interactive snapshot (the first use builds the XCTest runner into
 * {@link BOX_APPLE_RUNNER_DIR}), then delete the simulator.
 */
export const APPLE_RUNNER_STEP_SCRIPT = `set -eu
AD=${boxDeviceToolBin("agent-device")}
picked=$(xcrun simctl list -j runtimes | node -e '
const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
const version = (r) => String(r.version || "0").split(".").map(Number);
const newer = (a, b) => { const x = version(a), y = version(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };
const runtimes = (data.runtimes || []).filter((r) => r.isAvailable && (r.platform === "iOS" || String(r.identifier).includes(".iOS-"))).sort(newer);
const runtime = runtimes[runtimes.length - 1];
const phones = runtime ? (runtime.supportedDeviceTypes || []).filter((t) => t.productFamily === "iPhone") : [];
if (!runtime || phones.length === 0) process.exit(1);
console.log(runtime.identifier + " " + phones[phones.length - 1].identifier);
') || { echo "::error::no iOS runtime with an iPhone device type"; exit 1; }
runtime=\${picked%% *}
type=\${picked#* }
udid=$(xcrun simctl create orq-cache-warm "$type" "$runtime")
cleanup() {
  "$AD" close > /dev/null 2>&1 || true
  xcrun simctl shutdown "$udid" > /dev/null 2>&1 || true
  xcrun simctl delete "$udid" > /dev/null 2>&1 || true
}
trap cleanup EXIT
xcrun simctl boot "$udid"
xcrun simctl bootstatus "$udid" -b
"$AD" open com.apple.Preferences --platform ios --udid "$udid"
"$AD" snapshot -i
[ -d "$HOME/.agent-device/apple-runner" ] || { echo "::error::agent-device built no runner"; exit 1; }
du -sh "$HOME/.agent-device/apple-runner"
`;
