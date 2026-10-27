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
 * A key changes whenever what it covers changes (packages, AVD definitions, tool versions, Node
 * major, the Xcode build), so a stale cache is never restored; bump {@link DEVICE_CACHE_VERSION}
 * to drop every cache when the layout itself changes. Restore and save must use the same path
 * lists (`actions/cache` versions an entry by its paths): both come from the constants here.
 */

import { createHash } from "node:crypto";

import toolVersions from "../../devices/tool-versions.json" with { type: "json" };

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

/** Google's cmdline-tools archive (sdkmanager, avdmanager); needs Java 17+. */
export const ANDROID_CMDLINE_TOOLS_URL = "https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip";
export const ANDROID_SYSTEM_IMAGE = "system-images;android-35;google_apis;x86_64";
/** sdkmanager packages installed next to cmdline-tools. */
export const ANDROID_SDK_PACKAGES: readonly string[] = ["platform-tools", "emulator", ANDROID_SYSTEM_IMAGE];
/** The AVDs a device host offers: `name` → avdmanager device id (`avdmanager list device -c`). */
export const ANDROID_AVDS: ReadonlyArray<{ name: string; device: string }> = [
  { name: "orq-pixel-9", device: "pixel_9" },
  { name: "orq-pixel-tablet", device: "pixel_tablet" },
  { name: "orq-pixel-fold", device: "pixel_fold" }
];
/** The snapshot each AVD is cold-booted, settled (animations off) and saved as; leases boot from it read-only. */
export const ANDROID_GOLDEN_SNAPSHOT = "orq-golden";
/** A snapshot loads only with the GPU mode it was saved with: boot leases with this one. */
export const ANDROID_EMULATOR_GPU = "swiftshader_indirect";
/** config.ini lines set on every AVD before its golden snapshot (headless, no audio or cameras). */
export const ANDROID_AVD_CONFIG: Readonly<Record<string, string>> = {
  "hw.ramSize": "2048",
  "hw.audioInput": "no",
  "hw.audioOutput": "no",
  "hw.camera.back": "none",
  "hw.camera.front": "none",
  "hw.keyboard": "yes",
  showDeviceFrame: "no",
  "fastboot.forceColdBoot": "no"
};

function shortHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

/** Hash of everything the Android cache holds: a change to any of it is a new key. */
export const ANDROID_CACHE_HASH = shortHash({
  cmdlineTools: ANDROID_CMDLINE_TOOLS_URL,
  packages: ANDROID_SDK_PACKAGES,
  avds: ANDROID_AVDS,
  config: ANDROID_AVD_CONFIG,
  snapshot: ANDROID_GOLDEN_SNAPSHOT,
  gpu: ANDROID_EMULATOR_GPU
});
export const ANDROID_CACHE_KEY = `orq-devices-android-${ANDROID_CACHE_HASH}-${DEVICE_CACHE_VERSION}`;
export const ANDROID_CACHE_PATHS: readonly string[] = [BOX_ANDROID_SDK_DIR, BOX_ANDROID_AVD_DIR];

// ---------------------------------------------------------------------------
// Device tools (both) and the iOS runner (macOS boxes)
// ---------------------------------------------------------------------------

/** The tools cache key for an OS (native modules differ per OS and Node major). */
export function deviceToolsCacheKey(os: BlacksmithOs): string {
  return `orq-devices-tools-${os}-node${DEVICE_NODE_VERSION}-${shortHash(DEVICE_TOOL_VERSIONS)}-${DEVICE_CACHE_VERSION}`;
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

/** Single-quote a value for bash. */
function sq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

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

/** Install the pinned device tools into {@link BOX_DEVICE_TOOLS_DIR}. */
export const DEVICE_TOOLS_STEP_SCRIPT = `set -eu
mkdir -p ${BOX_DEVICE_TOOLS_DIR}
cd ${BOX_DEVICE_TOOLS_DIR}
[ -f package.json ] || printf '{ "private": true }\\n' > package.json
npm install --no-audit --no-fund --save-exact ${Object.entries(DEVICE_TOOL_VERSIONS)
  .map(([name, version]) => sq(`${name}@${version}`))
  .join(" ")}
./node_modules/.bin/agent-device --version
`;

/** Install cmdline-tools and {@link ANDROID_SDK_PACKAGES} into {@link BOX_ANDROID_SDK_DIR} (needs Java 17+). */
export const ANDROID_SDK_STEP_SCRIPT = `set -eu
SDK=${BOX_ANDROID_SDK_DIR}
mkdir -p "$SDK/cmdline-tools" ${BOX_ANDROID_AVD_DIR}
curl -fsSL --retry 3 -o "$RUNNER_TEMP/cmdline-tools.zip" ${sq(ANDROID_CMDLINE_TOOLS_URL)}
rm -rf "$SDK/cmdline-tools/latest" "$RUNNER_TEMP/cmdline-tools"
unzip -q "$RUNNER_TEMP/cmdline-tools.zip" -d "$RUNNER_TEMP"
mv "$RUNNER_TEMP/cmdline-tools" "$SDK/cmdline-tools/latest"
rm -f "$RUNNER_TEMP/cmdline-tools.zip"
SM="$SDK/cmdline-tools/latest/bin/sdkmanager"
yes 2> /dev/null | "$SM" --sdk_root="$SDK" --licenses > /dev/null || true
"$SM" --sdk_root="$SDK" --install ${ANDROID_SDK_PACKAGES.map(sq).join(" ")}
"$SDK/emulator/emulator" -version | head -1
`;

/**
 * Create {@link ANDROID_AVDS} and save each one's golden snapshot: cold boot headless, wait for
 * boot, turn animations off, `adb emu avd snapshot save`, stop the emulator.
 */
export const ANDROID_AVD_STEP_SCRIPT = `set -eu
SDK=${BOX_ANDROID_SDK_DIR}
export ANDROID_HOME="$SDK" ANDROID_SDK_ROOT="$SDK" ANDROID_AVD_HOME=${BOX_ANDROID_AVD_DIR}
export PATH="$SDK/cmdline-tools/latest/bin:$SDK/platform-tools:$SDK/emulator:$PATH"
mkdir -p "$ANDROID_AVD_HOME"
# adb emu commands need an empty console auth token.
: > "$HOME/.emulator_console_auth_token"
adb start-server
emulator -accel-check
port=5554
serial="emulator-$port"
for spec in ${ANDROID_AVDS.map((avd) => `${avd.name}:${avd.device}`).join(" ")}; do
  name=\${spec%%:*}
  device=\${spec#*:}
  echo "::group::$name ($device)"
  rm -rf "$ANDROID_AVD_HOME/$name.avd" "$ANDROID_AVD_HOME/$name.ini"
  echo no | avdmanager create avd -n "$name" -k ${sq(ANDROID_SYSTEM_IMAGE)} -d "$device" -p "$ANDROID_AVD_HOME/$name.avd" --force
  # Older avdmanagers write the .ini under ~/.android/avd whatever ANDROID_AVD_HOME says.
  if [ ! -f "$ANDROID_AVD_HOME/$name.ini" ] && [ -f "$HOME/.android/avd/$name.ini" ]; then
    mv "$HOME/.android/avd/$name.ini" "$ANDROID_AVD_HOME/$name.ini"
  fi
  cfg="$ANDROID_AVD_HOME/$name.avd/config.ini"
  sed -i -E '/^(${Object.keys(ANDROID_AVD_CONFIG)
    .map((key) => key.replace(/\./g, "\\."))
    .join("|")})=/d' "$cfg"
  cat >> "$cfg" << 'CONFIG'
${Object.entries(ANDROID_AVD_CONFIG)
  .map(([key, value]) => `${key}=${value}`)
  .join("\n")}
CONFIG
  log="$RUNNER_TEMP/emulator-$name.log"
  emulator -avd "$name" -port "$port" -no-window -no-audio -no-boot-anim -accel on -gpu ${ANDROID_EMULATOR_GPU} \\
    -no-snapshot-load -no-snapshot-save -camera-back none -camera-front none > "$log" 2>&1 < /dev/null &
  pid=$!
  end=$(($(date +%s) + 600))
  until [ "$(adb -s "$serial" shell getprop sys.boot_completed 2> /dev/null | tr -d '\\r')" = 1 ] &&
    [ "$(adb -s "$serial" shell getprop init.svc.bootanim 2> /dev/null | tr -d '\\r')" = stopped ]; do
    if ! kill -0 "$pid" 2> /dev/null; then echo "::error::the $name emulator exited"; tail -40 "$log"; exit 1; fi
    if [ "$(date +%s)" -ge "$end" ]; then echo "::error::$name did not boot within 10 min"; tail -40 "$log"; exit 1; fi
    sleep 2
  done
  until adb -s "$serial" shell pm path android > /dev/null 2>&1; do
    if [ "$(date +%s)" -ge "$end" ]; then echo "::error::$name's package manager did not start"; exit 1; fi
    sleep 2
  done
  for scale in window_animation_scale transition_animation_scale animator_duration_scale; do
    adb -s "$serial" shell settings put global "$scale" 0
  done
  adb -s "$serial" emu avd snapshot save ${ANDROID_GOLDEN_SNAPSHOT}
  adb -s "$serial" emu kill || true
  end=$(($(date +%s) + 120))
  while kill -0 "$pid" 2> /dev/null; do
    if [ "$(date +%s)" -ge "$end" ]; then kill -9 "$pid" || true; break; fi
    sleep 1
  done
  [ -d "$ANDROID_AVD_HOME/$name.avd/snapshots/${ANDROID_GOLDEN_SNAPSHOT}" ] || { echo "::error::$name has no ${ANDROID_GOLDEN_SNAPSHOT} snapshot"; tail -40 "$log"; exit 1; }
  du -sh "$ANDROID_AVD_HOME/$name.avd"
  echo "::endgroup::"
done
adb kill-server || true
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
