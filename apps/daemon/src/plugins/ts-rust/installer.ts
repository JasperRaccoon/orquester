/**
 * Verified install of one tsc-rs release from the npm registry (spec §4.1–4.2),
 * the removed `cliproxy-install.ts` pattern revived: every network access goes
 * through injected deps so the tests install local fixture tarballs.
 *
 * Layout under `<appdir>/daemon/plugins/ts-rust/`:
 *   versions/<version>/   the platform package's whole `lib/` dir — the native
 *                         `tsc` (`tsc.exe` on win32) needs the lib .d.ts files
 *                         shipped beside it
 *   .tmp/                 download and extract staging; emptied on start
 *
 * A release is downloaded into `.tmp/`, its sha512 checked against the
 * registry's `dist.integrity` before anything is extracted, smoke-tested, and
 * only then renamed into `versions/<version>`. Any failure removes the staging
 * dir and leaves `versions/` as it was. Which version is current is the plugins
 * service's business (plugins.json); this module never reads or writes it.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { PluginInstalledVersion } from "@orquester/config";

export const NPM_REGISTRY = "https://registry.npmjs.org";
const REGISTRY_TIMEOUT_MS = 30_000;
/** The platform tarball is ~50 MB; a stalled download must not hold the job queue forever. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const EXTRACT_TIMEOUT_MS = 2 * 60_000;
export const SMOKE_TEST_TIMEOUT_MS = 30_000;

/** Which install step failed; recorded as `lastError.step`. */
export type TsRustInstallStep = "registry" | "download" | "integrity" | "extract" | "smoke-test" | "install";

export class TsRustInstallError extends Error {
  constructor(
    readonly step: TsRustInstallStep,
    message: string
  ) {
    super(message);
    this.name = "TsRustInstallError";
  }
}

/** A release resolved from the registry: what `installTsRustRelease` downloads. */
export interface TsRustRelease {
  version: string;
  /** The platform package's `dist.tarball`. */
  tarball: string;
  /** The platform package's `dist.integrity` (SRI, sha512). */
  integrity: string;
}

export interface SmokeTestResult {
  /** The exit code, or null when killed by a signal or never started. */
  exitCode: number | null;
  stdout: string;
  timedOut: boolean;
  /** The spawn error code (ENOENT, EACCES, …) when the binary did not start. */
  spawnError?: string;
}

export interface SmokeTestOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface TsRustInstallerDeps {
  fetchJson(url: string, signal: AbortSignal): Promise<unknown>;
  /** Stream `url` into the file `dest`. */
  fetchTarball(url: string, dest: string, signal: AbortSignal): Promise<void>;
  /** Run `<binary> --version` with exactly `env`, killed after `timeoutMs` or on `signal`. */
  runSmokeTest(binary: string, options: SmokeTestOptions): Promise<SmokeTestResult>;
  now(): Date;
}

/** `@tsc-rs/<os>-<cpu>` for the daemon's platform, or null where tsc-rs ships no build. */
export function tsRustPlatformPackage(platform: string = process.platform, arch: string = process.arch): string | null {
  const os = platform === "linux" || platform === "darwin" || platform === "win32" ? platform : null;
  const cpu = arch === "x64" || arch === "arm64" ? arch : null;
  return os && cpu ? `@tsc-rs/${os}-${cpu}` : null;
}

export function tsRustBinaryName(platform: string = process.platform): string {
  return platform === "win32" ? "tsc.exe" : "tsc";
}

export function tsRustVersionsDir(pluginDir: string): string {
  return join(pluginDir, "versions");
}

export function tsRustBinaryPath(pluginDir: string, version: string, platform: string = process.platform): string {
  return join(tsRustVersionsDir(pluginDir), version, tsRustBinaryName(platform));
}

export function tsRustStagingDir(pluginDir: string): string {
  return join(pluginDir, ".tmp");
}

/**
 * The env the smoke test runs with: the daemon's own, minus every `ORQUESTER_*`
 * key (the appdir, the HTTP password and the like are none of tsc-rs's business).
 */
export function smokeTestEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("ORQUESTER_")));
}

// The version becomes a directory name under versions/: a plain semver only.
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Ask the registry for the latest tsc-rs and its platform package's tarball. */
export async function resolveTsRustRelease(
  platformPackage: string,
  deps: Pick<TsRustInstallerDeps, "fetchJson">,
  signal: AbortSignal
): Promise<TsRustRelease> {
  return step("registry", REGISTRY_TIMEOUT_MS, signal, async (bounded) => {
    const latest = await deps.fetchJson(`${NPM_REGISTRY}/tsc-rs/latest`, bounded);
    const version = field(latest, "version");
    if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
      throw new Error("the registry returned no valid tsc-rs version");
    }
    const name = platformPackage.replace("/", "%2f");
    const meta = await deps.fetchJson(`${NPM_REGISTRY}/${name}/${encodeURIComponent(version)}`, bounded);
    if (field(meta, "version") !== version) {
      throw new Error(`the registry has no ${platformPackage}@${version}`);
    }
    const dist = field(meta, "dist");
    const tarball = field(dist, "tarball");
    const integrity = field(dist, "integrity");
    if (typeof tarball !== "string" || !tarball.startsWith("https://")) {
      throw new Error(`${platformPackage}@${version} has no https tarball`);
    }
    if (typeof integrity !== "string" || sha512Digests(integrity).length === 0) {
      throw new Error(`${platformPackage}@${version} has no sha512 integrity`);
    }
    return { version, tarball, integrity };
  });
}

export interface InstallTsRustOptions {
  platform?: string;
  /** The daemon's env; the smoke test gets it minus `ORQUESTER_*` keys. */
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  smokeTestTimeoutMs?: number;
}

/**
 * Download, verify, extract and smoke-test `release`, then rename it into
 * `versions/<version>`. A leftover dir of the same version (an older install
 * the state no longer names) is replaced. Returns the record to store as
 * `current`; throws a {@link TsRustInstallError} naming the failed step.
 */
export async function installTsRustRelease(
  pluginDir: string,
  release: TsRustRelease,
  deps: TsRustInstallerDeps,
  options: InstallTsRustOptions
): Promise<PluginInstalledVersion> {
  if (!VERSION_PATTERN.test(release.version)) {
    throw new TsRustInstallError("install", `invalid tsc-rs version "${release.version}"`);
  }
  const platform = options.platform ?? process.platform;
  const staging = join(tsRustStagingDir(pluginDir), `${release.version}-${randomUUID()}`);
  try {
    await step("download", DOWNLOAD_TIMEOUT_MS, options.signal, async (bounded) => {
      await mkdir(staging, { recursive: true, mode: 0o700 });
      await deps.fetchTarball(release.tarball, join(staging, "package.tgz"), bounded);
    });

    await step("integrity", 0, options.signal, async () => {
      const actual = await sha512Base64(join(staging, "package.tgz"));
      if (!sha512Digests(release.integrity).includes(actual)) {
        throw new Error("the download does not match the registry's sha512 integrity");
      }
    });

    const libDir = join(staging, "extract", "package", "lib");
    const binary = join(libDir, tsRustBinaryName(platform));
    await step("extract", EXTRACT_TIMEOUT_MS, options.signal, async (bounded) => {
      await mkdir(join(staging, "extract"), { mode: 0o700 });
      // Relative archive path with cwd: GNU tar would read a `C:`-style path as a remote host.
      await run("tar", ["-xzf", "package.tgz", "-C", "extract"], staging, bounded);
      const info = await stat(binary).catch(() => null);
      if (!info?.isFile()) {
        throw new Error(`the package has no lib/${tsRustBinaryName(platform)}`);
      }
      await chmod(libDir, 0o755);
      await chmod(binary, 0o755);
    });

    await step("smoke-test", 0, options.signal, async () => {
      const timeoutMs = options.smokeTestTimeoutMs ?? SMOKE_TEST_TIMEOUT_MS;
      const result = await deps.runSmokeTest(binary, {
        cwd: libDir,
        env: smokeTestEnv(options.env),
        timeoutMs,
        signal: options.signal
      });
      if (result.spawnError) {
        throw new Error(`tsc-rs --version failed to start (${result.spawnError})`);
      }
      if (result.timedOut) {
        throw new Error(`tsc-rs --version did not finish within ${Math.round(timeoutMs / 1000)}s`);
      }
      if (result.exitCode !== 0) {
        throw new Error(`tsc-rs --version exited with ${result.exitCode === null ? "a signal" : `code ${result.exitCode}`}`);
      }
      if (!result.stdout.split(/\r?\n/).some((line) => line.startsWith("Version "))) {
        throw new Error("tsc-rs --version printed no version line");
      }
    });

    await step("install", 0, options.signal, async () => {
      const target = join(tsRustVersionsDir(pluginDir), release.version);
      await mkdir(tsRustVersionsDir(pluginDir), { recursive: true });
      const replaced = join(staging, "replaced");
      const hadTarget = await rename(target, replaced).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        }
      );
      try {
        await rename(libDir, target);
      } catch (error) {
        if (hadTarget) await rename(replaced, target).catch(() => undefined);
        throw error;
      }
    });
    return { version: release.version, integrity: release.integrity, installedAt: deps.now().toISOString() };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Delete every `versions/*` dir not named in `keep`. */
export async function pruneTsRustVersions(pluginDir: string, keep: readonly string[]): Promise<void> {
  const dir = tsRustVersionsDir(pluginDir);
  const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  });
  for (const name of names) {
    if (!keep.includes(name)) {
      await rm(join(dir, name), { recursive: true, force: true });
    }
  }
}

/** Delete `versions/` entirely ("Remove downloads"). */
export async function removeTsRustVersions(pluginDir: string): Promise<void> {
  await rm(tsRustVersionsDir(pluginDir), { recursive: true, force: true });
}

/** Empty the staging dir: whatever is in it was left by a daemon that stopped mid-install. */
export async function clearTsRustStaging(pluginDir: string): Promise<void> {
  await rm(tsRustStagingDir(pluginDir), { recursive: true, force: true });
}

/** Real registry access over the global `fetch`. Used by the daemon, never by the tests. */
export const defaultTsRustInstallerDeps: TsRustInstallerDeps = {
  fetchJson: async (url, signal) => {
    const response = await fetch(url, { signal, headers: { accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${url}`);
    }
    return response.json();
  },
  fetchTarball: async (url, dest, signal) => {
    const response = await fetch(url, { signal });
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status} from ${url}`);
    }
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(dest, { mode: 0o600 }),
      { signal }
    );
  },
  runSmokeTest: runVersionCommand,
  now: () => new Date()
};

/** `<binary> --version` through execFile: no shell, exactly the given env, SIGKILL on timeout. */
export function runVersionCommand(binary: string, options: SmokeTestOptions): Promise<SmokeTestResult> {
  return new Promise((resolve) => {
    execFile(
      binary,
      ["--version"],
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeoutMs,
        killSignal: "SIGKILL",
        signal: options.signal,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        encoding: "utf8"
      },
      (error, stdout) => {
        if (!error) {
          resolve({ exitCode: 0, stdout, timedOut: false });
          return;
        }
        const code = (error as NodeJS.ErrnoException).code as unknown;
        if (typeof code === "string") {
          resolve({ exitCode: null, stdout, timedOut: false, spawnError: code });
          return;
        }
        resolve({
          exitCode: typeof code === "number" ? code : null,
          stdout,
          timedOut: error.killed === true && error.signal === "SIGKILL"
        });
      }
    );
  });
}

/**
 * Run one install step: abort-aware, bounded by `timeoutMs` (0 = no own bound),
 * and any failure rethrown as a {@link TsRustInstallError} for that step.
 */
async function step<T>(
  name: TsRustInstallStep,
  timeoutMs: number,
  signal: AbortSignal,
  body: (bounded: AbortSignal) => Promise<T>
): Promise<T> {
  const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null;
  const bounded = timeout ? AbortSignal.any([signal, timeout]) : signal;
  try {
    if (signal.aborted) throw new Error("cancelled");
    return await body(bounded);
  } catch (error) {
    if (error instanceof TsRustInstallError) throw error;
    if (signal.aborted) throw new TsRustInstallError(name, "cancelled");
    if (timeout?.aborted) {
      throw new TsRustInstallError(name, `timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw new TsRustInstallError(name, error instanceof Error ? error.message : String(error));
  }
}

function run(command: string, args: string[], cwd: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, signal, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) {
        const detail = String(stderr).trim().split(/\r?\n/)[0];
        reject(new Error(detail ? `${command} failed: ${detail}` : `${command} failed: ${error.message}`));
        return;
      }
      resolve();
    });
  });
}

/** The base64 sha512 digests an SRI string names (other algorithms are ignored). */
function sha512Digests(integrity: string): string[] {
  return integrity
    .split(/\s+/)
    .filter((token) => token.startsWith("sha512-"))
    .map((token) => token.slice("sha512-".length).split("?")[0] ?? "")
    .filter((digest) => digest.length > 0);
}

async function sha512Base64(file: string): Promise<string> {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("base64");
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}
