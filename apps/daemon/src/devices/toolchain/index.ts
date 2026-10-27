/**
 * The device toolchain on this host (devices spec §5): the pinned npm tools (`expo-device-hub`,
 * `agent-device`, `../tool-versions.json`) under `devicesToolsDir`, and the Android SDK, system
 * image and AVDs under `androidSdkDir` / `androidAvdDir`, all run with the appdir's private
 * environment (`../android/env.ts`).
 *
 * - npm tools (`npm-tools.ts`): staging dir + `.install-complete` sentinel + rename, one lock per
 *   tool, all but the current and previous version pruned; the hub's scrcpy-server jar pre-seeded
 *   from a pinned, checksummed download.
 * - Android (`android-sdk.ts`): cmdline-tools (pinned URL + SHA-256), `sdkmanager --licenses`
 *   (the owner's Install click is the acceptance), `platform-tools`, `emulator`, the API 35 image;
 *   one AVD per profile with a tuned `config.ini`. Golden snapshots need a running emulator and
 *   are made by the local host (`../android/golden.ts`) the first time a profile is opened.
 *
 * Every step is idempotent: what is installed is skipped, so a failed or cancelled setup resumes.
 */

import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";

import { ANDROID_SYSTEM_IMAGE, deviceProfile, type DeviceProfile } from "@orquester/api";

import { adbServerPort, type AndroidLayout, androidLayout, buildAndroidEnv } from "../android/env.ts";
import { execFile, type ExecFn } from "../android/exec.ts";
import { DeviceError } from "../errors.ts";
import type { DeviceHostProgress } from "../host.ts";
import {
  acceptLicenses,
  avdReady,
  createAvd,
  goldenReady,
  installCmdlineTools,
  installSdkPackages,
  packageInstalled,
  packageRevision,
  SDK_PACKAGES
} from "./android-sdk.ts";
import { type DownloadFn, downloadPinned } from "./download.ts";
import { findNpmCli, installNpmTool, isToolInstalled, TOOL_ENTRY, toolDir } from "./npm-tools.ts";

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
  /** The installed tool's entry module, run as `node <entry>` (no PATH lookup of `node`), or null. */
  toolEntry(name: DeviceToolName): string | null;
  /** The Android SDK's state. */
  androidStatus(profiles: readonly string[]): Promise<AndroidSdkStatus>;
  /** Install the SDK packages and system image, create the AVDs (golden snapshots: the local host, lazily). */
  ensureAndroid(profiles: readonly string[], signal: AbortSignal, onProgress?: (progress: DeviceHostProgress) => void): Promise<void>;
  /** cmdline-tools, licences, platform-tools and emulator. */
  ensureAndroidSdk(signal: AbortSignal, onProgress?: (progress: DeviceHostProgress) => void): Promise<void>;
  /** The API 35 system image (needs the SDK). */
  ensureSystemImage(signal: AbortSignal, onProgress?: (progress: DeviceHostProgress) => void): Promise<void>;
  /** A profile's AVD, made again when its hardware changed. `force` remakes it. The caller makes sure none of its instances runs. */
  ensureAvd(profileId: string, signal: AbortSignal, options?: { force?: boolean }): Promise<void>;
  /** Whether the AVD and its golden snapshot are current. */
  avdStatus(profileId: string): Promise<{ created: boolean; snapshot: boolean }>;
  /** The installed emulator's revision (part of a golden snapshot's identity). */
  emulatorRevision(): Promise<string | null>;
  /** The appdir's paths and the tools' private environment. */
  readonly layout: AndroidLayout;
  readonly env: NodeJS.ProcessEnv;
}

export interface DeviceToolchainDeps {
  appDir: string;
  env: NodeJS.ProcessEnv;
  logger: Pick<Console, "info" | "warn" | "error">;
  /** Tests: the program runner, the downloader and the node binary. */
  exec?: ExecFn;
  download?: DownloadFn;
  nodePath?: string;
  npmCli?: string | null;
}

function profileOf(id: string): DeviceProfile {
  const profile = deviceProfile(id);
  if (!profile || profile.platform !== "android") throw new DeviceError("INVALID_ARGUMENT", `${id} is not an Android profile.`);
  return profile;
}

/** An install step failed: the message is for the owner (Settings → Devices shows it). */
function failed(what: string, error: unknown): DeviceError {
  if (error instanceof DeviceError) return error;
  const reason = error instanceof Error ? error.message : String(error);
  return new DeviceError("UNAVAILABLE", `${what} failed: ${reason}`);
}

export function createDeviceToolchain(deps: DeviceToolchainDeps): DeviceToolchain {
  const layout = androidLayout(deps.appDir);
  const nodePath = deps.nodePath ?? process.execPath;
  const env = buildAndroidEnv(layout, deps.env, { user: deps.env.USER || safeUser(), nodePath, adbPort: adbServerPort(deps.appDir) });
  const exec = deps.exec ?? execFile;
  const download = deps.download ?? downloadPinned;
  const npmCli = deps.npmCli === undefined ? findNpmCli(nodePath) : deps.npmCli;
  const paths = { sdk: layout.sdk, avd: layout.avd };
  const sdkDeps = { exec, download, env, downloads: layout.downloads };

  const prepareDirs = async () => {
    await mkdir(layout.devices, { recursive: true, mode: 0o700 });
    for (const dir of [layout.tmp, layout.home, layout.androidUser, layout.downloads, layout.npmCache, layout.logs]) await mkdir(dir, { recursive: true });
    await mkdir(layout.runtime, { recursive: true, mode: 0o700 });
  };

  const toolchain: DeviceToolchain = {
    layout,
    env,

    async tools() {
      return DEVICE_TOOL_NAMES.map((name) => {
        const version = DEVICE_TOOL_VERSIONS[name];
        const installed = isToolInstalled(layout.tools, name, version);
        return { name, version, installed, path: installed ? toolDir(layout.tools, name, version) : null };
      });
    },

    async ensureTool(name, signal, onProgress) {
      const version = DEVICE_TOOL_VERSIONS[name];
      const step = `tool:${name}`;
      const label = `Installing ${name} ${version}`;
      if (isToolInstalled(layout.tools, name, version)) return toolDir(layout.tools, name, version);
      if (!npmCli) throw new DeviceError("UNAVAILABLE", `npm was not found next to ${nodePath}; reinstall Node.js with npm.`);
      await prepareDirs();
      onProgress?.({ step, label, state: "running" });
      try {
        const dir = await installNpmTool(layout.tools, name, version, { exec, download, nodePath, npmCli, env, downloads: layout.downloads }, signal, (line) =>
          onProgress?.({ step, label, state: "running", logLine: line })
        );
        onProgress?.({ step, label, state: "done", detail: version });
        return dir;
      } catch (error) {
        onProgress?.({ step, label, state: "failed" });
        if (signal.aborted) throw new DeviceError("CANCELLED", "The install was cancelled.");
        throw failed(`Installing ${name}`, error);
      }
    },

    toolBin(name) {
      const version = DEVICE_TOOL_VERSIONS[name];
      return isToolInstalled(layout.tools, name, version) ? join(toolDir(layout.tools, name, version), TOOL_ENTRY[name]!.bin) : null;
    },

    toolEntry(name) {
      const version = DEVICE_TOOL_VERSIONS[name];
      return isToolInstalled(layout.tools, name, version) ? join(toolDir(layout.tools, name, version), TOOL_ENTRY[name]!.entry) : null;
    },

    async androidStatus(profiles) {
      const packages = [
        { id: "cmdline-tools", installed: packageInstalled(layout.sdk, "cmdline-tools") },
        ...SDK_PACKAGES.map((id) => ({ id, installed: packageInstalled(layout.sdk, id) })),
        { id: ANDROID_SYSTEM_IMAGE, installed: packageInstalled(layout.sdk, ANDROID_SYSTEM_IMAGE) }
      ];
      const avds = await Promise.all(profiles.filter((id) => deviceProfile(id)?.platform === "android").map(async (profile) => ({ profile, ...(await toolchain.avdStatus(profile)) })));
      return { packages, avds };
    },

    async ensureAndroidSdk(signal, onProgress) {
      const step = "android-sdk";
      const label = "Installing the Android SDK";
      if (packageInstalled(layout.sdk, "cmdline-tools") && SDK_PACKAGES.every((id) => packageInstalled(layout.sdk, id))) return;
      await prepareDirs();
      const report = (percent: number | null, line: string, base: number, span: number) =>
        onProgress?.({ step, label, state: "running", logLine: line, ...(percent !== null ? { detail: `${Math.round(base + (percent / 100) * span)} %` } : {}) });
      try {
        onProgress?.({ step, label, state: "running", detail: "Command-line tools" });
        await installCmdlineTools(paths, sdkDeps, signal, (percent, line) => report(percent, line, 0, 30));
        onProgress?.({ step, label, state: "running", detail: "Accepting the Android SDK licences" });
        await acceptLicenses(paths, sdkDeps, signal);
        await installSdkPackages(paths, SDK_PACKAGES, sdkDeps, signal, (percent, line) => report(percent, line, 30, 70));
        onProgress?.({ step, label, state: "done", detail: "Installed" });
      } catch (error) {
        onProgress?.({ step, label, state: "failed" });
        if (signal.aborted) throw new DeviceError("CANCELLED", "The install was cancelled.");
        throw failed("Installing the Android SDK", error);
      }
    },

    async ensureSystemImage(signal, onProgress) {
      const step = "system-image";
      const label = "Downloading the Android 15 system image";
      if (packageInstalled(layout.sdk, ANDROID_SYSTEM_IMAGE)) return;
      if (!packageInstalled(layout.sdk, "cmdline-tools")) await toolchain.ensureAndroidSdk(signal, onProgress);
      try {
        onProgress?.({ step, label, state: "running" });
        await acceptLicenses(paths, sdkDeps, signal);
        await installSdkPackages(paths, [ANDROID_SYSTEM_IMAGE], sdkDeps, signal, (percent, line) =>
          onProgress?.({ step, label, state: "running", logLine: line, ...(percent !== null ? { detail: `${percent} %` } : {}) })
        );
        onProgress?.({ step, label, state: "done", detail: ANDROID_SYSTEM_IMAGE });
      } catch (error) {
        onProgress?.({ step, label, state: "failed" });
        if (signal.aborted) throw new DeviceError("CANCELLED", "The install was cancelled.");
        throw failed("Installing the Android system image", error);
      }
    },

    async ensureAvd(profileId, signal, options = {}) {
      const profile = profileOf(profileId);
      if (!options.force && (await avdReady(layout.avd, profile))) return;
      if (!packageInstalled(layout.sdk, profile.systemImage ?? ANDROID_SYSTEM_IMAGE) || !packageInstalled(layout.sdk, "cmdline-tools")) {
        throw new DeviceError("PLATFORM_NOT_READY", "The Android SDK and system image are not installed yet. Ask the owner to install them in Settings → Devices.");
      }
      await prepareDirs();
      try {
        await createAvd(paths, profile, { exec, env }, signal);
      } catch (error) {
        if (signal.aborted) throw new DeviceError("CANCELLED", "The install was cancelled.");
        throw failed(`Creating the ${profile.label} emulator`, error);
      }
    },

    async avdStatus(profileId) {
      const profile = deviceProfile(profileId);
      if (!profile || profile.platform !== "android") return { created: false, snapshot: false };
      const created = await avdReady(layout.avd, profile);
      return { created, snapshot: created && (await goldenReady(layout.avd, profile, await toolchain.emulatorRevision())) };
    },

    emulatorRevision() {
      return packageRevision(layout.sdk, "emulator");
    },

    async ensureAndroid(profiles, signal, onProgress) {
      await toolchain.ensureAndroidSdk(signal, onProgress);
      await toolchain.ensureSystemImage(signal, onProgress);
      for (const profile of profiles) {
        const label = `Creating the ${deviceProfile(profile)?.label ?? profile} emulator`;
        onProgress?.({ step: `avd:${profile}`, label, state: "running" });
        await toolchain.ensureAvd(profile, signal);
        onProgress?.({ step: `avd:${profile}`, label, state: "done" });
      }
    }
  };
  return toolchain;
}

function safeUser(): string {
  try {
    return userInfo().username;
  } catch {
    return "orquester";
  }
}

