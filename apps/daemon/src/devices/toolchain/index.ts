/**
 * The device toolchain on this host (devices spec §5): the pinned npm tools (`expo-device-hub`,
 * `agent-device`, `../tool-versions.json`) under `devicesToolsDir`, and the Android SDK, system
 * image and AVDs under `androidSdkDir` / `androidAvdDir`.
 *
 * SEAM — owned by the toolchain work package. This file fixes the interface the hosts and the
 * service use; {@link createDeviceToolchain} is a stand-in that reports every tool missing and
 * refuses installs until the real installer lands here (staging dir + `.install-complete`
 * sentinel + rename, one lock per tool, prune all but current and previous; `sdkmanager`
 * licences accepted by the owner's click).
 */

import { readFileSync } from "node:fs";

import { devicesToolsDir } from "@orquester/config";

import type { DeviceHostProgress } from "../host.ts";
import { DeviceError } from "../errors.ts";

/** The npm tools the daemon pins. */
export type DeviceToolName = "expo-device-hub" | "agent-device";
export const DEVICE_TOOL_NAMES: readonly DeviceToolName[] = ["expo-device-hub", "agent-device"];

/** `tool-versions.json`: name → pinned version. */
export const DEVICE_TOOL_VERSIONS: Readonly<Record<DeviceToolName, string>> = Object.freeze(
  JSON.parse(readFileSync(new URL("../tool-versions.json", import.meta.url), "utf8")) as Record<DeviceToolName, string>
);

export interface DeviceToolStatus {
  name: DeviceToolName;
  /** The pinned version. */
  version: string;
  installed: boolean;
  /** Its install dir (`<devicesToolsDir>/<name>@<version>`) when installed. */
  path: string | null;
}

/** One Android SDK piece's state, for the local host's readiness. */
export interface AndroidSdkStatus {
  /** `cmdline-tools`, `platform-tools`, `emulator`, the system image package. */
  packages: { id: string; installed: boolean }[];
  /** Profiles with an AVD, and whether each has its golden snapshot. */
  avds: { profile: string; created: boolean; snapshot: boolean }[];
}

export interface DeviceToolchain {
  /** Every pinned tool's state. */
  tools(): Promise<DeviceToolStatus[]>;
  /** Install the pinned version when missing; resolves its install dir. */
  ensureTool(name: DeviceToolName, signal: AbortSignal, onProgress?: (progress: DeviceHostProgress) => void): Promise<string>;
  /** The executable of an installed tool (`node_modules/.bin/<bin>`), or null. */
  toolBin(name: DeviceToolName): string | null;
  /** The Android SDK's state. */
  androidStatus(profiles: readonly string[]): Promise<AndroidSdkStatus>;
  /** Install the SDK packages and system image, create the AVDs and their golden snapshots. */
  ensureAndroid(profiles: readonly string[], signal: AbortSignal, onProgress?: (progress: DeviceHostProgress) => void): Promise<void>;
}

export interface DeviceToolchainDeps {
  appDir: string;
  env: NodeJS.ProcessEnv;
  logger: Pick<Console, "info" | "warn" | "error">;
}

const NOT_READY = "Installing device tools is not available in this build yet.";

/** Stand-in toolchain (see the module comment): nothing is installed, installs are refused. */
export function createDeviceToolchain(deps: DeviceToolchainDeps): DeviceToolchain {
  const root = devicesToolsDir(deps.appDir);
  return {
    async tools() {
      return DEVICE_TOOL_NAMES.map((name) => ({ name, version: DEVICE_TOOL_VERSIONS[name], installed: false, path: null }));
    },
    async ensureTool(name) {
      throw new DeviceError("UNAVAILABLE", `${NOT_READY} (${name} → ${root})`);
    },
    toolBin() {
      return null;
    },
    async androidStatus(profiles) {
      return { packages: [], avds: profiles.map((profile) => ({ profile, created: false, snapshot: false })) };
    },
    async ensureAndroid() {
      throw new DeviceError("UNAVAILABLE", NOT_READY);
    }
  };
}
