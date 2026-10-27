/**
 * The private environment of one appdir's Android tooling (devices spec §5, spikes §2): every
 * piece (sdkmanager, avdmanager, the emulators, adb, the hub, agent-device) runs with its homes,
 * caches and runtime files under `devicesDir(appDir)` and its own adb server port, so two appdirs
 * on one machine (the live daemon and a dev checkout) never share an adb server, an AVD or a
 * state file. Only an allowlist of the daemon's environment is passed through (no daemon secrets).
 */

import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import { androidAvdDir, androidSdkDir, devicesDir, devicesHubStatePath, devicesRuntimeDir, devicesToolsDir } from "@orquester/config";

/** Every path the local Android host and the toolchain use for one appdir. */
export interface AndroidLayout {
  devices: string;
  tools: string;
  sdk: string;
  avd: string;
  /** `XDG_RUNTIME_DIR` (0700): emulator discovery files and gRPC tokens. */
  runtime: string;
  /** `TMPDIR`: emulator overlays (`android-$USER/`), npm and Java scratch. */
  tmp: string;
  /** `HOME` of the tools: caches that follow `HOME`. */
  home: string;
  /** `ANDROID_USER_HOME` and `ANDROID_EMULATOR_HOME` (adb keys, emulator prefs). */
  androidUser: string;
  /** `EXPO_DEVICE_HUB_STATE_DIR`: the hub's `server-<port>.json` (token inside, 0600). */
  hubState: string;
  agentDeviceState: string;
  agentDeviceHome: string;
  agentDeviceClaims: string;
  /** The `--config` file pinned to this host's agent-device daemon (0600). */
  agentDeviceConfig: string;
  /** Per-emulator and hub log files. */
  logs: string;
  /** Builds streamed in for `install` (`uploadFile`). */
  uploads: string;
  /** `npm_config_cache`. */
  npmCache: string;
  /** Downloads kept between installs (cmdline-tools zip, scrcpy-server). */
  downloads: string;
  /** The host's process record (`hub.json`: hub pid/port, emulator pids). */
  stateFile: string;
}

export function androidLayout(appDir: string): AndroidLayout {
  const devices = devicesDir(appDir);
  const agentDevice = join(devices, "agent-device");
  return {
    devices,
    tools: devicesToolsDir(appDir),
    sdk: androidSdkDir(appDir),
    avd: androidAvdDir(appDir),
    runtime: devicesRuntimeDir(appDir),
    tmp: join(devices, "tmp"),
    home: join(devices, "home"),
    androidUser: join(devices, "android-user"),
    hubState: join(devices, "hub-state"),
    agentDeviceState: join(agentDevice, "state"),
    agentDeviceHome: join(agentDevice, "home"),
    agentDeviceClaims: join(agentDevice, "claims"),
    agentDeviceConfig: join(agentDevice, "config.json"),
    logs: join(devices, "logs"),
    uploads: join(devices, "uploads"),
    npmCache: join(devices, "cache", "npm"),
    downloads: join(devices, "cache", "downloads"),
    stateFile: devicesHubStatePath(appDir)
  };
}

/** Private adb server ports: 16000–19999, derived from the appdir (never 5037, the default). */
export const ADB_PORT_BASE = 16_000;
export const ADB_PORT_SPAN = 4_000;

export function adbServerPort(appDir: string): number {
  const digest = createHash("sha256").update(appDir).digest();
  return ADB_PORT_BASE + (digest.readUInt32BE(0) % ADB_PORT_SPAN);
}

/** Variables of the daemon's environment the tools may see. */
const PASSTHROUGH = ["PATH", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TZ", "JAVA_HOME", "SHELL", "TERM"] as const;

export interface AndroidEnvOptions {
  /** `USER`/`LOGNAME` (the emulator names its overlay dir after it). */
  user: string;
  /** The daemon's node binary: its directory goes first on PATH (the tools' `#!/usr/bin/env node`). */
  nodePath: string;
  /** The private adb server port. */
  adbPort: number;
}

/** The environment every Android tool, the hub and agent-device run with. */
export function buildAndroidEnv(layout: AndroidLayout, base: NodeJS.ProcessEnv, options: AndroidEnvOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PASSTHROUGH) if (base[key] !== undefined) env[key] = base[key];
  const sdkPath = [join(layout.sdk, "platform-tools"), join(layout.sdk, "emulator"), join(layout.sdk, "cmdline-tools", "latest", "bin")];
  const basePath = base.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  env.PATH = [dirname(options.nodePath), ...sdkPath, basePath].join(":");
  Object.assign(env, {
    USER: options.user,
    LOGNAME: options.user,
    HOME: layout.home,
    TMPDIR: layout.tmp,
    XDG_RUNTIME_DIR: layout.runtime,
    XDG_CACHE_HOME: join(layout.home, ".cache"),
    XDG_CONFIG_HOME: join(layout.home, ".config"),
    XDG_DATA_HOME: join(layout.home, ".local", "share"),
    ANDROID_HOME: layout.sdk,
    ANDROID_SDK_ROOT: layout.sdk,
    ANDROID_USER_HOME: layout.androidUser,
    ANDROID_EMULATOR_HOME: layout.androidUser,
    ANDROID_AVD_HOME: layout.avd,
    ANDROID_ADB_SERVER_PORT: String(options.adbPort),
    EXPO_DEVICE_HUB_STATE_DIR: layout.hubState,
    // The hub never launches emulators here (--hide-boot-device); should it ever, same flags.
    EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS: "-gpu swangle_indirect -no-snapshot-save -no-metrics -camera-back none -camera-front none",
    AGENT_DEVICE_STATE_DIR: layout.agentDeviceState,
    AGENT_DEVICE_HOME: layout.agentDeviceHome,
    AGENT_DEVICE_CLAIMS_DIR: layout.agentDeviceClaims,
    AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: "0",
    AGENT_DEVICE_DAEMON_SERVER_MODE: "http",
    AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1",
    npm_config_cache: layout.npmCache,
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    NO_UPDATE_NOTIFIER: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0"
  });
  return env;
}

/** The marker a process of this appdir carries in its environment (orphan checks read `/proc/<pid>/environ`). */
export function appdirMarker(layout: AndroidLayout): { key: string; value: string } {
  return { key: "ANDROID_AVD_HOME", value: layout.avd };
}
