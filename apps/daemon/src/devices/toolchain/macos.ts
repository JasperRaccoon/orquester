/**
 * What an Apple Silicon Mac's Android host installs for itself beside the SDK (tailnet machines
 * spec §4.4 item 2), pinned and checksummed, under its device dir: no sudo, no Homebrew needed.
 *
 * - Java for the SDK tools (sdkmanager, avdmanager need 17 or newer): Eclipse Temurin's 17 JRE for
 *   macOS aarch64, used only when the Mac has no Java 17+ of its own (`/usr/libexec/java_home`).
 * - ffmpeg with libx264 for the hub's streams: Martin Riedl's static macOS arm64 build of FFmpeg
 *   9.1 (GPL, `--enable-libx264`, ad-hoc signed), used only when no ffmpeg with libx264 is on the
 *   Mac's PATH (Homebrew's is in `/opt/homebrew/bin`).
 *
 * Both arrive with `curl`, so macOS sets no quarantine on them.
 */

import { posix } from "node:path";

import type { DeviceExecutor } from "../android/executor.ts";
import { lastLine } from "../android/exec.ts";
import type { PinnedDownload } from "./download.ts";

/** Temurin 17.0.21.1+2 JRE, macOS aarch64 (the SHA-256 Adoptium publishes beside it). */
export const TEMURIN_JRE_MAC_ARM64: PinnedDownload & { version: string; dir: string } = {
  url: "https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.21.1%2B2/OpenJDK17U-jre_aarch64_mac_hotspot_17.0.21.1_2.tar.gz",
  sha256: "398046289ca1acef2d3800d74c55a31f08b2fee32a17ee7c1c4e4ad7489f8311",
  size: 42_828_495,
  version: "17.0.21.1+2",
  /** The archive's top directory (`<dir>/Contents/Home` is `JAVA_HOME`). */
  dir: "jdk-17.0.21.1+2-jre"
};

/** FFmpeg 9.1 for macOS arm64 (static; libx264), a zip holding the one `ffmpeg` binary (the SHA-256 the build page publishes). */
export const FFMPEG_MAC_ARM64: PinnedDownload & { version: string } = {
  url: "https://ffmpeg.martin-riedl.de/download/macos/arm64/1795207104_9.1/ffmpeg.zip",
  sha256: "1f66e9a690a7f1c9e60b012379f8869c11818d1797f45b21dbb2f2564ba61ae1",
  size: 28_623_086,
  version: "9.1"
};

/** Where the pinned JRE lives under a device root: `JAVA_HOME`. */
export function macJreHome(root: string): string {
  return posix.join(root, "jre", TEMURIN_JRE_MAC_ARM64.dir, "Contents", "Home");
}

/** The dir the pinned ffmpeg is put in (first on the Mac host's PATH). */
export function macFfmpegBinDir(root: string): string {
  return posix.join(root, "ffmpeg", "bin");
}

export interface MacInstallDeps {
  executor: DeviceExecutor;
  /** The device root (`<root>/jre`, `<root>/ffmpeg`). */
  root: string;
  /** Kept downloads (`<root>/cache/downloads`). */
  downloads: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}

/** Download, verify and unpack the pinned JRE to {@link macJreHome}; resolves `JAVA_HOME`. */
export async function installMacJre(deps: MacInstallDeps): Promise<string> {
  const x = deps.executor;
  const archive = posix.join(deps.downloads, posix.basename(decodeURIComponent(new URL(TEMURIN_JRE_MAC_ARM64.url).pathname)));
  await x.download(TEMURIN_JRE_MAC_ARM64, archive, { signal: deps.signal });
  const jre = posix.join(deps.root, "jre");
  const staging = posix.join(deps.root, ".staging-jre");
  await x.remove(staging);
  await x.mkdir(staging);
  try {
    const untar = await x.exec("/usr/bin/tar", ["-xzf", archive, "-C", staging], { env: deps.env, signal: deps.signal, timeoutMs: 5 * 60_000 });
    if (untar.exitCode !== 0) throw new Error(`Unpacking Java failed: ${lastLine(untar) || `exit ${untar.exitCode}`}`);
    if (!(await x.exists(posix.join(staging, TEMURIN_JRE_MAC_ARM64.dir, "Contents", "Home", "bin", "java")))) throw new Error("The Java archive has no Contents/Home/bin/java.");
    // One JRE at a time: an older pin's goes.
    await x.remove(jre);
    await x.mkdir(jre);
    await x.rename(posix.join(staging, TEMURIN_JRE_MAC_ARM64.dir), posix.join(jre, TEMURIN_JRE_MAC_ARM64.dir));
  } finally {
    await x.remove(staging);
  }
  await x.remove(archive);
  const home = macJreHome(deps.root);
  const check = await x.exec(posix.join(home, "bin", "java"), ["-version"], { env: deps.env, signal: deps.signal, timeoutMs: 60_000 });
  if (check.exitCode !== 0) throw new Error(`The installed Java does not run: ${lastLine(check) || `exit ${check.exitCode}`}`);
  return home;
}

/** Download, verify and unpack the pinned ffmpeg into {@link macFfmpegBinDir}, then check its libx264. */
export async function installMacFfmpeg(deps: MacInstallDeps): Promise<void> {
  const x = deps.executor;
  const archive = posix.join(deps.downloads, `ffmpeg-${FFMPEG_MAC_ARM64.version}-macos-arm64.zip`);
  await x.download(FFMPEG_MAC_ARM64, archive, { signal: deps.signal });
  const bin = macFfmpegBinDir(deps.root);
  const staging = posix.join(deps.root, ".staging-ffmpeg");
  await x.remove(staging);
  await x.mkdir(staging);
  try {
    const unzip = await x.exec("/usr/bin/unzip", ["-q", "-o", archive, "-d", staging], { env: deps.env, signal: deps.signal, timeoutMs: 5 * 60_000 });
    if (unzip.exitCode !== 0) throw new Error(`Unpacking ffmpeg failed: ${lastLine(unzip) || `exit ${unzip.exitCode}`}`);
    const unpacked = posix.join(staging, "ffmpeg");
    if (!(await x.exists(unpacked))) throw new Error("The ffmpeg archive has no ffmpeg binary.");
    await x.exec("/bin/chmod", ["755", unpacked], { env: deps.env, signal: deps.signal, timeoutMs: 30_000 });
    await x.mkdir(bin);
    await x.remove(posix.join(bin, "ffmpeg"));
    await x.rename(unpacked, posix.join(bin, "ffmpeg"));
  } finally {
    await x.remove(staging);
  }
  await x.remove(archive);
  const encoders = await x.exec(posix.join(bin, "ffmpeg"), ["-hide_banner", "-encoders"], { env: deps.env, signal: deps.signal, timeoutMs: 60_000 });
  if (encoders.exitCode !== 0 || !/\blibx264\b/.test(encoders.stdout)) throw new Error(`The installed ffmpeg does not run with libx264: ${lastLine(encoders) || `exit ${encoders.exitCode}`}`);
}
