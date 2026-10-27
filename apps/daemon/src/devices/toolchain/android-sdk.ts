/**
 * The Android SDK under `androidSdkDir` (devices spec §5): Google's cmdline-tools archive (pinned
 * URL and SHA-256), the licences (`sdkmanager --licenses`, answered yes: the owner's Install click
 * is the acceptance), then `platform-tools`, `emulator` and the API 35 system image; and one AVD per
 * profile under `androidAvdDir` (`avdmanager create avd`, then the tuned `config.ini`). Files and
 * programs go through a {@link DeviceExecutor}: this machine by default, or a Linux box host's SDK.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { ANDROID_SYSTEM_IMAGE, type DeviceProfile } from "@orquester/api";

import { avdConfigHash, avdHardware, avdName, hasAvdPlaceholders, patchAvdConfig } from "../android/avd-config.ts";
import { type ExecFn, lastLine } from "../android/exec.ts";
import { type DeviceExecutor, LOCAL_EXECUTOR } from "../android/executor.ts";
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

/** The files that mark a package installed: any group whose files all exist. */
function packageMarkers(sdk: string, id: string): string[][] {
  switch (id) {
    case "cmdline-tools":
      return [[sdkmanagerPath(sdk), avdmanagerPath(sdk)]];
    case "platform-tools":
      return [[adbPath(sdk)]];
    case "emulator":
      return [[emulatorPath(sdk)]];
    default:
      return [[join(packageDir(sdk, id), "system.img")], [join(packageDir(sdk, id), "package.xml")]];
  }
}

/** Whether a package is installed on this machine (its marker file exists). */
export function packageInstalled(sdk: string, id: string): boolean {
  return packageMarkers(sdk, id).some((group) => group.every((path) => existsSync(path)));
}

/** {@link packageInstalled} where `executor` runs. */
export async function packageInstalledOn(executor: DeviceExecutor, sdk: string, id: string): Promise<boolean> {
  for (const group of packageMarkers(sdk, id)) {
    let all = true;
    for (const path of group) if (!(await executor.exists(path))) all = false;
    if (all) return true;
  }
  return false;
}

/** `Pkg.Revision` of an installed package (the emulator's version is part of a snapshot's identity). */
export async function packageRevision(sdk: string, id: string, executor: DeviceExecutor = LOCAL_EXECUTOR): Promise<string | null> {
  const text = await executor.readText(join(packageDir(sdk, id), "source.properties"));
  return text === null ? null : (/^Pkg\.Revision=(.+)$/m.exec(text)?.[1]?.trim() ?? null);
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
  /** Where the SDK is (absent: this machine); `exec` and `download` must act there too. */
  executor?: DeviceExecutor;
}

/** Download, verify and unpack cmdline-tools into `<sdk>/cmdline-tools/latest`. */
export async function installCmdlineTools(paths: SdkPaths, deps: SdkDeps, signal: AbortSignal, onProgress: (percent: number | null, line: string) => void): Promise<void> {
  const x = deps.executor ?? LOCAL_EXECUTOR;
  if (await packageInstalledOn(x, paths.sdk, "cmdline-tools")) return;
  await x.mkdir(paths.sdk);
  const zip = join(deps.downloads, "commandlinetools-linux.zip");
  await deps.download(CMDLINE_TOOLS, zip, {
    signal,
    onProgress: (received, total) => onProgress(total ? Math.round((received / total) * 100) : null, `Downloading Android command-line tools (${Math.round(received / 1e6)} MB)`)
  });
  const staging = join(paths.sdk, ".staging-cmdline-tools");
  await x.remove(staging);
  await x.mkdir(staging);
  try {
    const unzip = await deps.exec("unzip", ["-q", "-o", zip, "-d", staging], { env: deps.env, signal, timeoutMs: 5 * 60_000 });
    if (unzip.exitCode !== 0) {
      throw new Error(unzip.exitCode === -1 ? "unzip is not installed on this machine (apt install unzip)." : `Unpacking the command-line tools failed: ${lastLine(unzip)}`);
    }
    const unpacked = join(staging, "cmdline-tools");
    if (!(await x.exists(join(unpacked, "bin", "sdkmanager")))) throw new Error("The command-line tools archive has no bin/sdkmanager.");
    await x.mkdir(join(paths.sdk, "cmdline-tools"));
    await x.remove(join(paths.sdk, "cmdline-tools", "latest"));
    await x.rename(unpacked, join(paths.sdk, "cmdline-tools", "latest"));
  } finally {
    await x.remove(staging);
  }
  await x.remove(zip);
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
  const x = deps.executor ?? LOCAL_EXECUTOR;
  const missing: string[] = [];
  for (const id of ids) if (!(await packageInstalledOn(x, paths.sdk, id))) missing.push(id);
  if (missing.length === 0) return;
  const result = await deps.exec(sdkmanagerPath(paths.sdk), [`--sdk_root=${paths.sdk}`, "--install", ...missing], {
    env: deps.env,
    signal,
    input: "y\n".repeat(16),
    timeoutMs: 60 * 60_000,
    onLine: (line) => onProgress(parseSdkPercent(line), line)
  });
  signal.throwIfAborted();
  const still: string[] = [];
  for (const id of missing) if (!(await packageInstalledOn(x, paths.sdk, id))) still.push(id);
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

async function readJson<T>(path: string, executor: DeviceExecutor): Promise<T | null> {
  try {
    const text = await executor.readText(path);
    return text === null ? null : (JSON.parse(text) as T);
  } catch {
    return null;
  }
}

export function profileHash(profile: DeviceProfile): string {
  return avdConfigHash(profile.id, avdHardware(profile), profile.systemImage ?? ANDROID_SYSTEM_IMAGE);
}

/** The AVD exists, was patched, and matches the current hardware table. */
export async function avdReady(avdHome: string, profile: DeviceProfile, executor: DeviceExecutor = LOCAL_EXECUTOR): Promise<boolean> {
  const dir = avdDir(avdHome, profile.id);
  if (!(await executor.exists(join(avdHome, `${avdName(profile.id)}.ini`))) || !(await executor.exists(join(dir, "config.ini")))) return false;
  const marker = await readJson<AvdMarker>(join(dir, "orq-avd.json"), executor);
  return marker?.configHash === profileHash(profile);
}

/** The golden snapshot exists and was saved for this AVD config and emulator revision. */
export async function goldenReady(avdHome: string, profile: DeviceProfile, emulatorRevision: string | null, executor: DeviceExecutor = LOCAL_EXECUTOR): Promise<boolean> {
  const dir = avdDir(avdHome, profile.id);
  if (!(await executor.exists(join(dir, "snapshots", "default_boot", "snapshot.pb")))) return false;
  const marker = await readJson<GoldenMarker>(join(dir, "orq-golden.json"), executor);
  return marker?.configHash === profileHash(profile) && marker.emulatorRevision === emulatorRevision;
}

export async function writeGoldenMarker(avdHome: string, profile: DeviceProfile, emulatorRevision: string | null, executor: DeviceExecutor = LOCAL_EXECUTOR): Promise<void> {
  const marker: GoldenMarker = { configHash: profileHash(profile), emulatorRevision, createdAt: new Date().toISOString() };
  await executor.writeText(join(avdDir(avdHome, profile.id), "orq-golden.json"), `${JSON.stringify(marker)}\n`);
}

/** Drop a stale snapshot so the next golden boot starts cold and clean. */
export async function clearGolden(avdHome: string, profileId: string, executor: DeviceExecutor = LOCAL_EXECUTOR): Promise<void> {
  const dir = avdDir(avdHome, profileId);
  await executor.remove(join(dir, "snapshots"));
  await executor.remove(join(dir, "orq-golden.json"));
}

/** (Re)create a profile's AVD and patch its config. The caller makes sure no instance of it runs. */
export async function createAvd(paths: SdkPaths, profile: DeviceProfile, deps: Pick<SdkDeps, "exec" | "env" | "executor">, signal: AbortSignal): Promise<void> {
  const x = deps.executor ?? LOCAL_EXECUTOR;
  const name = avdName(profile.id);
  const hardware = avdHardware(profile);
  const dir = avdDir(paths.avd, profile.id);
  await x.mkdir(paths.avd);
  await x.remove(dir);
  await x.remove(join(paths.avd, `${name}.ini`));
  const result = await deps.exec(
    avdmanagerPath(paths.sdk),
    ["create", "avd", "--force", "--name", name, "--package", profile.systemImage ?? ANDROID_SYSTEM_IMAGE, "--device", hardware.device, "--path", dir],
    { env: deps.env, signal, input: "no\n", timeoutMs: 2 * 60_000 }
  );
  const configPath = join(dir, "config.ini");
  if (result.exitCode !== 0 || !(await x.exists(configPath))) {
    throw new Error(`Creating the ${profile.label} emulator failed: ${lastLine(result) || `exit ${result.exitCode}`}`);
  }
  // Older avdmanagers write the .ini under ~/.android/avd whatever ANDROID_AVD_HOME says.
  const ini = join(paths.avd, `${name}.ini`);
  const stray = deps.env.ANDROID_USER_HOME ? join(deps.env.ANDROID_USER_HOME, "avd", `${name}.ini`) : null;
  if (!(await x.exists(ini)) && stray && (await x.exists(stray))) await x.rename(stray, ini);
  const patched = patchAvdConfig((await x.readText(configPath)) ?? "", { name, hardware });
  if (hasAvdPlaceholders(patched)) throw new Error(`The ${profile.label} emulator's config.ini still has avdmanager placeholders.`);
  await x.writeText(configPath, patched);
  const marker: AvdMarker = { profile: profile.id, configHash: profileHash(profile), createdAt: new Date().toISOString() };
  await x.writeText(join(dir, "orq-avd.json"), `${JSON.stringify(marker)}\n`);
}

/** AVD names Orquester made (`orq-*.ini`) in the AVD home. */
export async function listOrqAvds(avdHome: string, executor: DeviceExecutor = LOCAL_EXECUTOR): Promise<string[]> {
  return (await executor.list(avdHome)).filter((entry) => entry.startsWith("orq-") && entry.endsWith(".ini")).map((entry) => entry.slice(0, -4));
}
