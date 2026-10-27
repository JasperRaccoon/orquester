/**
 * The Android SDK under `androidSdkDir` (devices spec §5): Google's cmdline-tools archive (pinned
 * URL and SHA-256), the licences (`sdkmanager --licenses`, answered yes: the owner's Install click
 * is the acceptance), then `platform-tools`, `emulator` and the API 35 system image; and one AVD per
 * profile under `androidAvdDir` (`avdmanager create avd`, then the tuned `config.ini`).
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ANDROID_SYSTEM_IMAGE, type DeviceProfile } from "@orquester/api";

import { avdConfigHash, avdHardware, avdName, hasAvdPlaceholders, patchAvdConfig } from "../android/avd-config.ts";
import { type ExecFn, lastLine } from "../android/exec.ts";
import type { DownloadFn, PinnedDownload } from "./download.ts";

/** cmdline-tools 15859902 (rev 22.0), the build the spike measured; SHA-256 of Google's archive. */
export const CMDLINE_TOOLS: PinnedDownload & { revision: string } = {
  url: "https://dl.google.com/android/repository/commandlinetools-linux-15859902_latest.zip",
  sha256: "4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583",
  size: 181_833_628,
  revision: "22.0"
};

export const SDK_PACKAGES = ["platform-tools", "emulator"] as const;
export const ANDROID_LICENSE_URL = "https://developer.android.com/studio/terms";

export interface SdkPaths {
  sdk: string;
  avd: string;
}

export const sdkmanagerPath = (sdk: string) => join(sdk, "cmdline-tools", "latest", "bin", "sdkmanager");
export const avdmanagerPath = (sdk: string) => join(sdk, "cmdline-tools", "latest", "bin", "avdmanager");
export const adbPath = (sdk: string) => join(sdk, "platform-tools", "adb");
export const emulatorPath = (sdk: string) => join(sdk, "emulator", "emulator");

/** The installed directory of an sdkmanager package id (`system-images;android-35;…` → `system-images/android-35/…`). */
export function packageDir(sdk: string, id: string): string {
  return join(sdk, ...id.split(";"));
}

/** Whether a package is installed (its marker file exists). */
export function packageInstalled(sdk: string, id: string): boolean {
  switch (id) {
    case "cmdline-tools":
      return existsSync(sdkmanagerPath(sdk)) && existsSync(avdmanagerPath(sdk));
    case "platform-tools":
      return existsSync(adbPath(sdk));
    case "emulator":
      return existsSync(emulatorPath(sdk));
    default:
      return existsSync(join(packageDir(sdk, id), "system.img")) || existsSync(join(packageDir(sdk, id), "package.xml"));
  }
}

/** `Pkg.Revision` of an installed package (the emulator's version is part of a snapshot's identity). */
export async function packageRevision(sdk: string, id: string): Promise<string | null> {
  try {
    const text = await readFile(join(packageDir(sdk, id), "source.properties"), "utf8");
    return /^Pkg\.Revision=(.+)$/m.exec(text)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

/** sdkmanager progress: `[====    ] 45% Downloading …`. */
export function parseSdkPercent(line: string): number | null {
  const match = /(\d{1,3})%/.exec(line);
  if (!match) return null;
  const value = Number(match[1]);
  return value >= 0 && value <= 100 ? value : null;
}

export interface SdkDeps {
  exec: ExecFn;
  download: DownloadFn;
  env: NodeJS.ProcessEnv;
  downloads: string;
}

/** Download, verify and unpack cmdline-tools into `<sdk>/cmdline-tools/latest`. */
export async function installCmdlineTools(paths: SdkPaths, deps: SdkDeps, signal: AbortSignal, onProgress: (percent: number | null, line: string) => void): Promise<void> {
  if (packageInstalled(paths.sdk, "cmdline-tools")) return;
  await mkdir(paths.sdk, { recursive: true });
  const zip = join(deps.downloads, "commandlinetools-linux.zip");
  await deps.download(CMDLINE_TOOLS, zip, {
    signal,
    onProgress: (received, total) => onProgress(total ? Math.round((received / total) * 100) : null, `Downloading Android command-line tools (${Math.round(received / 1e6)} MB)`)
  });
  const staging = join(paths.sdk, ".staging-cmdline-tools");
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    const unzip = await deps.exec("unzip", ["-q", "-o", zip, "-d", staging], { env: deps.env, signal, timeoutMs: 5 * 60_000 });
    if (unzip.exitCode !== 0) {
      throw new Error(unzip.exitCode === -1 ? "unzip is not installed on this machine (apt install unzip)." : `Unpacking the command-line tools failed: ${lastLine(unzip)}`);
    }
    const unpacked = join(staging, "cmdline-tools");
    if (!existsSync(join(unpacked, "bin", "sdkmanager"))) throw new Error("The command-line tools archive has no bin/sdkmanager.");
    await mkdir(join(paths.sdk, "cmdline-tools"), { recursive: true });
    await rm(join(paths.sdk, "cmdline-tools", "latest"), { recursive: true, force: true });
    await rename(unpacked, join(paths.sdk, "cmdline-tools", "latest"));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  await rm(zip, { force: true });
}

/** Accept the SDK licences (the owner's Install click is the acceptance). */
export async function acceptLicenses(paths: SdkPaths, deps: SdkDeps, signal: AbortSignal): Promise<void> {
  const result = await deps.exec(sdkmanagerPath(paths.sdk), [`--sdk_root=${paths.sdk}`, "--licenses"], {
    env: deps.env,
    signal,
    input: "y\n".repeat(64),
    timeoutMs: 5 * 60_000
  });
  if (result.exitCode !== 0) throw new Error(`Accepting the Android SDK licences failed: ${lastLine(result) || `exit ${result.exitCode}`}`);
}

/** `sdkmanager --install` the packages that are missing. */
export async function installSdkPackages(
  paths: SdkPaths,
  ids: readonly string[],
  deps: SdkDeps,
  signal: AbortSignal,
  onProgress: (percent: number | null, line: string) => void
): Promise<void> {
  const missing = ids.filter((id) => !packageInstalled(paths.sdk, id));
  if (missing.length === 0) return;
  const result = await deps.exec(sdkmanagerPath(paths.sdk), [`--sdk_root=${paths.sdk}`, "--install", ...missing], {
    env: deps.env,
    signal,
    input: "y\n".repeat(16),
    timeoutMs: 60 * 60_000,
    onLine: (line) => onProgress(parseSdkPercent(line), line)
  });
  signal.throwIfAborted();
  const still = missing.filter((id) => !packageInstalled(paths.sdk, id));
  if (result.exitCode !== 0 || still.length > 0) {
    throw new Error(`Installing ${still.join(", ") || missing.join(", ")} failed: ${lastLine(result) || `exit ${result.exitCode}`}`);
  }
}

// ---------------------------------------------------------------------------
// AVDs
// ---------------------------------------------------------------------------

/** `<avd>/orq-<profile>.avd/orq-avd.json`: the AVD was made (and patched) for this config. */
export interface AvdMarker {
  profile: string;
  configHash: string;
  createdAt: string;
}

/** `<avd>/orq-<profile>.avd/orq-golden.json`: its golden snapshot was saved for this config and emulator. */
export interface GoldenMarker {
  configHash: string;
  emulatorRevision: string | null;
  createdAt: string;
}

export const avdDir = (avdHome: string, profileId: string) => join(avdHome, `${avdName(profileId)}.avd`);

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function profileHash(profile: DeviceProfile): string {
  return avdConfigHash(profile.id, avdHardware(profile), profile.systemImage ?? ANDROID_SYSTEM_IMAGE);
}

/** The AVD exists, was patched, and matches the current hardware table. */
export async function avdReady(avdHome: string, profile: DeviceProfile): Promise<boolean> {
  const dir = avdDir(avdHome, profile.id);
  if (!existsSync(join(avdHome, `${avdName(profile.id)}.ini`)) || !existsSync(join(dir, "config.ini"))) return false;
  const marker = await readJson<AvdMarker>(join(dir, "orq-avd.json"));
  return marker?.configHash === profileHash(profile);
}

/** The golden snapshot exists and was saved for this AVD config and emulator revision. */
export async function goldenReady(avdHome: string, profile: DeviceProfile, emulatorRevision: string | null): Promise<boolean> {
  const dir = avdDir(avdHome, profile.id);
  if (!existsSync(join(dir, "snapshots", "default_boot", "snapshot.pb"))) return false;
  const marker = await readJson<GoldenMarker>(join(dir, "orq-golden.json"));
  return marker?.configHash === profileHash(profile) && marker.emulatorRevision === emulatorRevision;
}

export async function writeGoldenMarker(avdHome: string, profile: DeviceProfile, emulatorRevision: string | null): Promise<void> {
  const marker: GoldenMarker = { configHash: profileHash(profile), emulatorRevision, createdAt: new Date().toISOString() };
  await writeFile(join(avdDir(avdHome, profile.id), "orq-golden.json"), `${JSON.stringify(marker)}\n`);
}

/** Drop a stale snapshot so the next golden boot starts cold and clean. */
export async function clearGolden(avdHome: string, profileId: string): Promise<void> {
  const dir = avdDir(avdHome, profileId);
  await rm(join(dir, "snapshots"), { recursive: true, force: true });
  await rm(join(dir, "orq-golden.json"), { force: true });
}

/** (Re)create a profile's AVD and patch its config. The caller makes sure no instance of it runs. */
export async function createAvd(paths: SdkPaths, profile: DeviceProfile, deps: Pick<SdkDeps, "exec" | "env">, signal: AbortSignal): Promise<void> {
  const name = avdName(profile.id);
  const hardware = avdHardware(profile);
  const dir = avdDir(paths.avd, profile.id);
  await mkdir(paths.avd, { recursive: true });
  await rm(dir, { recursive: true, force: true });
  await rm(join(paths.avd, `${name}.ini`), { force: true });
  const result = await deps.exec(
    avdmanagerPath(paths.sdk),
    ["create", "avd", "--force", "--name", name, "--package", profile.systemImage ?? ANDROID_SYSTEM_IMAGE, "--device", hardware.device, "--path", dir],
    { env: deps.env, signal, input: "no\n", timeoutMs: 2 * 60_000 }
  );
  if (result.exitCode !== 0 || !existsSync(join(dir, "config.ini"))) {
    throw new Error(`Creating the ${profile.label} emulator failed: ${lastLine(result) || `exit ${result.exitCode}`}`);
  }
  const configPath = join(dir, "config.ini");
  const patched = patchAvdConfig(await readFile(configPath, "utf8"), { name, hardware });
  if (hasAvdPlaceholders(patched)) throw new Error(`The ${profile.label} emulator's config.ini still has avdmanager placeholders.`);
  await writeFile(configPath, patched);
  const marker: AvdMarker = { profile: profile.id, configHash: profileHash(profile), createdAt: new Date().toISOString() };
  await writeFile(join(dir, "orq-avd.json"), `${JSON.stringify(marker)}\n`);
}

/** AVD names Orquester made (`orq-*.ini`) in the AVD home. */
export async function listOrqAvds(avdHome: string): Promise<string[]> {
  return (await readdir(avdHome).catch(() => [] as string[])).filter((entry) => entry.startsWith("orq-") && entry.endsWith(".ini")).map((entry) => entry.slice(0, -4));
}
