/**
 * Verified install of the Knowledge Graph runtime (spec "Install and
 * updates"), in the ts-rust installer's discipline: every network access and
 * every child process goes through injected deps (the tests use fixtures), a
 * release is built in `.tmp/<version>-<uuid>/`, verified and smoke-tested
 * there, and only then renamed into `versions/<version>/`. Any failure
 * removes the staging dir and leaves `versions/` as it was. Which version is
 * current is the plugins service's business (plugins.json).
 *
 * Layout under `knowledgeRuntimeDir(appdir)`:
 *   versions/<mykg>/venv/      the relocatable venv with `mykg==<mykg>` and the prompt overlay
 *   versions/<mykg>/models/    the embedding model (`<models>/Xenova/all-MiniLM-L6-v2/…`)
 *   versions/<mykg>/tiktoken/  tiktoken's cache (`TIKTOKEN_CACHE_DIR`): the encodings myKG loads,
 *                              hash-checked, under tiktoken's own names (sha1 of the URL)
 *   versions/<mykg>/runtime.json  written last, after the smoke test: what was installed
 *   python/                    uv's managed CPython (`UV_PYTHON_INSTALL_DIR`), shared by the
 *                              venvs (a venv points at its interpreter by absolute path)
 *   home/                      HOME and the XDG dirs of every uv and myKG child
 *   .tmp/                      staging (uv itself, its cache, the venv being built); emptied on start
 *
 * uv is downloaded per install from its GitHub release (pinned, sha256 checked
 * against both Orquester's pin and the release's published `.sha256`) and
 * discarded with the staging dir. The pinned myKG installs from a shipped lock
 * with every artifact's hash (`--require-hashes`); a newer patch of the same
 * minor line installs its PyPI wheel by sha256 with the lock's other entries,
 * hashes included, as constraints (a dependency the lock lacks fails the
 * install). Only wheels: nothing is built from source (`--no-build`; a build's
 * own dependencies carry no hash). The smoke test runs `mykg --help`, then has the
 * installed myKG load and validate the config linking generates (its profile, its
 * LLM adapter, its tiktoken encoding from the cache, offline), with no extraction and
 * no LLM call. Children get a built-from-scratch env (never the daemon's own):
 * no credentials in argv or env, nothing written under the daemon user's HOME.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { KNOWLEDGE_CONCURRENCY_DEFAULT } from "@orquester/api";
import type { PluginInstalledVersion } from "@orquester/config";
import type { KnowledgeRuntime } from "../ports.ts";
import type { PluginRelease } from "../../plugins/updater.ts";
import { MYKG_PROFILE, writeMykgConfig } from "../linking/mykg-config.ts";
import {
  EMBEDDING_MODEL,
  type EmbeddingModelSpec,
  MYKG_LINE,
  MYKG_LOCKS,
  MYKG_PACKAGE,
  MYKG_PINNED_VERSION,
  MYKG_PINNED_WHEEL_SHA256,
  PYPI,
  PYTHON_VERSION,
  TIKTOKEN_ENCODINGS,
  type TiktokenEncodingSpec,
  type UvBuild,
  tiktokenCacheKey
} from "./pins.ts";
import { MYKG_PROMPTS_ROOT, applyOverlay, overlayApplied, overlayDigest } from "./overlay.ts";

const REGISTRY_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const EXTRACT_TIMEOUT_MS = 2 * 60_000;
const PYTHON_TIMEOUT_MS = 10 * 60_000;
const VENV_TIMEOUT_MS = 2 * 60_000;
const PACKAGES_TIMEOUT_MS = 20 * 60_000;
const KNOWLEDGE_SMOKE_TEST_TIMEOUT_MS = 60_000;

/** `./locks/`: the hashed lock of each shipped myKG version. */
export const MYKG_LOCKS_DIR = fileURLToPath(new URL("./locks/", import.meta.url));

/** Which install step failed; recorded as `lastError.step`. */
export type KnowledgeInstallStep =
  | "registry"
  | "download"
  | "integrity"
  | "extract"
  | "python"
  | "venv"
  | "packages"
  | "overlay"
  | "tiktoken"
  | "smoke-test"
  | "model"
  | "install";

export class KnowledgeInstallError extends Error {
  constructor(
    readonly step: KnowledgeInstallStep,
    message: string
  ) {
    super(message);
    this.name = "KnowledgeInstallError";
  }
}

/** A myKG release resolved from PyPI. */
export interface MykgRelease extends PluginRelease {
  version: string;
  /** sha256 hex of the release's `py3-none-any` wheel. */
  wheelSha256: string;
}

export interface CommandResult {
  /** The exit code, or null when killed by a signal or never started. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The spawn error code (ENOENT, EACCES, …) when the command did not start. */
  spawnError?: string;
}

export interface CommandOptions {
  cwd: string;
  /** Exactly the child's env. */
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface KnowledgeInstallerDeps {
  fetchJson(url: string, signal: AbortSignal): Promise<unknown>;
  fetchText(url: string, signal: AbortSignal): Promise<string>;
  /** Stream `url` into the file `dest`. */
  download(url: string, dest: string, signal: AbortSignal): Promise<void>;
  /** Run `command args…` (no shell) with exactly `options.env`, killed after `timeoutMs` or on `signal`. */
  run(command: string, args: readonly string[], options: CommandOptions): Promise<CommandResult>;
  now(): Date;
}

/** What `versions/<v>/runtime.json` records; written only after the smoke test passed. */
export interface KnowledgeRuntimeManifest {
  schema: 1;
  mykgVersion: string;
  wheelSha256: string;
  uvVersion: string;
  python: string;
  overlay: { line: string; digest: string; files: string[] };
  embeddingModel: { id: string; revision: string; dimensions: number };
  /** The tiktoken encodings in `tiktoken/` (absent in a manifest written before they were prefetched). */
  tiktokenEncodings?: string[];
  installedAt: string;
}

const MANIFEST_FILE = "runtime.json";

// ---- paths ---------------------------------------------------------------------------------------

export function knowledgeVersionsDir(runtimeDir: string): string {
  return join(runtimeDir, "versions");
}

export function knowledgeVersionDir(runtimeDir: string, version: string): string {
  return join(knowledgeVersionsDir(runtimeDir), version);
}

export function knowledgeStagingDir(runtimeDir: string): string {
  return join(runtimeDir, ".tmp");
}

/** uv's managed CPython installs, shared by every version's venv. */
export function knowledgePythonDir(runtimeDir: string): string {
  return join(runtimeDir, "python");
}

/** HOME (and the XDG dirs) of every uv and myKG child the runtime runs. */
export function knowledgeHomeDir(runtimeDir: string): string {
  return join(runtimeDir, "home");
}

/** The runtime an installed version provides (paths only; see {@link knowledgeRuntimeReady}). */
export function knowledgeRuntimeOf(
  runtimeDir: string,
  version: string,
  model: EmbeddingModelSpec = EMBEDDING_MODEL
): KnowledgeRuntime {
  const dir = knowledgeVersionDir(runtimeDir, version);
  return {
    mykgVersion: version,
    mykgBin: join(dir, "venv", "bin", "mykg"),
    pythonBin: join(dir, "venv", "bin", "python"),
    embeddingModelDir: join(dir, "models"),
    embeddingModelId: model.id,
    embeddingDimensions: model.dimensions,
    tiktokenCacheDir: join(dir, "tiktoken")
  };
}

export async function readKnowledgeManifest(versionDir: string): Promise<KnowledgeRuntimeManifest | null> {
  try {
    const value = JSON.parse(await readFile(join(versionDir, MANIFEST_FILE), "utf8")) as Partial<KnowledgeRuntimeManifest>;
    if (value?.schema !== 1 || typeof value.mykgVersion !== "string" || typeof value.overlay?.digest !== "string") return null;
    return value as KnowledgeRuntimeManifest;
  } catch {
    return null;
  }
}

/**
 * Whether `version` is installed and usable: its manifest (written after the
 * smoke test) names it, its mykg entry point and python (through the venv's
 * link to the shared interpreter) are there, and every model file has its
 * pinned size. With `overlayDigestNow`, the overlay it was installed with must
 * be that one too (an Orquester update that changes the prompts repairs it);
 * with `encodings`, every one must be in its tiktoken cache at its pinned size
 * (a runtime without them still runs: tiktoken would fetch them).
 */
export async function knowledgeRuntimeReady(
  runtimeDir: string,
  version: string,
  options: { overlayDigestNow?: string; model?: EmbeddingModelSpec; encodings?: readonly TiktokenEncodingSpec[] } = {}
): Promise<boolean> {
  const model = options.model ?? EMBEDDING_MODEL;
  const manifest = await readKnowledgeManifest(knowledgeVersionDir(runtimeDir, version));
  if (!manifest || manifest.mykgVersion !== version) return false;
  if (options.overlayDigestNow !== undefined && manifest.overlay.digest !== options.overlayDigestNow) return false;
  if (manifest.embeddingModel?.id !== model.id || manifest.embeddingModel?.revision !== model.revision) return false;
  const runtime = knowledgeRuntimeOf(runtimeDir, version, model);
  if (!(await isFile(runtime.mykgBin)) || !(await isFile(runtime.pythonBin))) return false;
  for (const file of model.files) {
    const info = await stat(join(runtime.embeddingModelDir, ...model.id.split("/"), ...file.path.split("/"))).catch(
      () => null
    );
    if (!info?.isFile() || info.size !== file.size) return false;
  }
  for (const encoding of options.encodings ?? []) {
    const info = await stat(join(runtime.tiktokenCacheDir, tiktokenCacheKey(encoding.url))).catch(() => null);
    if (!info?.isFile() || info.size !== encoding.size) return false;
  }
  return true;
}

// ---- env -----------------------------------------------------------------------------------------

/** Proxy and TLS settings a child may need to reach PyPI, GitHub and Hugging Face (no credentials of Orquester's). */
const PASSTHROUGH_ENV = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "LANG",
  "LC_ALL"
];

/** The base env of every runtime child: PATH, HOME/XDG inside the runtime dir, proxy/TLS passthrough. */
export function knowledgeChildEnv(runtimeDir: string, daemonEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const home = knowledgeHomeDir(runtimeDir);
  const env: NodeJS.ProcessEnv = {
    PATH: daemonEnv.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_BIN_HOME: join(home, ".local", "bin")
  };
  for (const key of PASSTHROUGH_ENV) {
    const value = daemonEnv[key];
    if (value !== undefined) env[key] = value;
  }
  env.LANG ??= "C.UTF-8";
  return env;
}

/** {@link knowledgeChildEnv} plus everything uv keeps inside the runtime dir. */
function uvEnv(runtimeDir: string, staging: string, daemonEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const home = knowledgeHomeDir(runtimeDir);
  return {
    ...knowledgeChildEnv(runtimeDir, daemonEnv),
    TMPDIR: join(staging, "tmp"),
    UV_CACHE_DIR: join(staging, "uv-cache"),
    UV_PYTHON_INSTALL_DIR: knowledgePythonDir(runtimeDir),
    UV_PYTHON_BIN_DIR: join(home, ".local", "bin"),
    UV_TOOL_DIR: join(home, "uv-tools"),
    UV_TOOL_BIN_DIR: join(home, ".local", "bin"),
    UV_PYTHON_PREFERENCE: "only-managed",
    UV_NO_CONFIG: "1",
    UV_NO_PROGRESS: "1",
    UV_NO_MODIFY_PATH: "1",
    // The cache goes with the staging dir: copy, never link into it.
    UV_LINK_MODE: "copy"
  };
}

/** The env myKG runs with inside a version's venv (the smoke test, and the linking runs' base). */
export function mykgEnv(runtimeDir: string, venvDir: string, daemonEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base = knowledgeChildEnv(runtimeDir, daemonEnv);
  return { ...base, PATH: `${join(venvDir, "bin")}:${base.PATH}`, VIRTUAL_ENV: venvDir, PYTHONNOUSERSITE: "1" };
}

// ---- PyPI ----------------------------------------------------------------------------------------

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** Whether `version` is a plain release of the pinned minor line at or past the pinned one. */
function inMykgLine(version: string): boolean {
  const match = VERSION_PATTERN.exec(version);
  const pinned = VERSION_PATTERN.exec(MYKG_PINNED_VERSION);
  if (!match || !pinned) return false;
  return `${match[1]}.${match[2]}` === MYKG_LINE && Number(match[3]) >= Number(pinned[3]);
}

/** The sha256 of a release's non-yanked `py3-none-any` wheel among its PyPI files, or null. */
function wheelSha256(files: unknown): string | null {
  if (!Array.isArray(files)) return null;
  for (const file of files) {
    const f = file as { packagetype?: unknown; filename?: unknown; yanked?: unknown; digests?: { sha256?: unknown } };
    if (f.packagetype !== "bdist_wheel" || f.yanked === true) continue;
    if (typeof f.filename !== "string" || !f.filename.endsWith("-py3-none-any.whl")) continue;
    const sha = f.digests?.sha256;
    if (typeof sha === "string" && SHA256_PATTERN.test(sha)) return sha;
  }
  return null;
}

/**
 * The latest myKG release of the pinned minor line (at or past the pinned
 * version, with a usable wheel), or exactly `pinned`. The pinned version
 * itself resolves without the network: its hash is Orquester's.
 */
export async function resolveMykgRelease(
  deps: Pick<KnowledgeInstallerDeps, "fetchJson">,
  signal: AbortSignal,
  pinned?: string
): Promise<MykgRelease> {
  return step("registry", REGISTRY_TIMEOUT_MS, signal, async (bounded) => {
    if (pinned === MYKG_PINNED_VERSION) return { version: pinned, wheelSha256: MYKG_PINNED_WHEEL_SHA256 };
    if (pinned !== undefined) {
      if (!inMykgLine(pinned)) throw new Error(`myKG ${pinned} is not a ${MYKG_LINE}.x release Orquester can install`);
      const meta = (await deps.fetchJson(`${PYPI}/${MYKG_PACKAGE}/${encodeURIComponent(pinned)}/json`, bounded)) as {
        info?: { version?: unknown };
        urls?: unknown;
      };
      if (meta?.info?.version !== pinned) throw new Error(`PyPI has no ${MYKG_PACKAGE} ${pinned}`);
      const sha = wheelSha256(meta.urls);
      if (!sha) throw new Error(`${MYKG_PACKAGE} ${pinned} has no usable wheel on PyPI`);
      return { version: pinned, wheelSha256: sha };
    }
    const index = (await deps.fetchJson(`${PYPI}/${MYKG_PACKAGE}/json`, bounded)) as { releases?: unknown };
    const releases = index?.releases;
    if (typeof releases !== "object" || releases === null) throw new Error("PyPI returned no myKG releases");
    let best: MykgRelease | null = null;
    for (const [version, files] of Object.entries(releases as Record<string, unknown>)) {
      if (!inMykgLine(version)) continue;
      // The pinned release is Orquester's tested one: always a candidate, with its own hash.
      const sha = version === MYKG_PINNED_VERSION ? MYKG_PINNED_WHEEL_SHA256 : wheelSha256(files);
      if (!sha) continue;
      if (!best || patchOf(version) > patchOf(best.version)) best = { version, wheelSha256: sha };
    }
    // The pinned release always installs, even when PyPI lists nothing newer (or lists it oddly).
    return best ?? { version: MYKG_PINNED_VERSION, wheelSha256: MYKG_PINNED_WHEEL_SHA256 };
  });
}

function patchOf(version: string): number {
  return Number(VERSION_PATTERN.exec(version)?.[3] ?? -1);
}

// ---- install -------------------------------------------------------------------------------------

export interface InstallKnowledgeRuntimeOptions {
  /** The host's pinned uv build. */
  uv: UvBuild;
  /** The daemon's env: only PATH and proxy/TLS settings reach the children. */
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  /** The prompt overlay root and the locks dir (the shipped ones by default; tests pass fixtures). */
  overlayRoot?: string;
  locksDir?: string;
  /** The embedding model and the tiktoken encodings (the pinned ones by default). */
  model?: EmbeddingModelSpec;
  encodings?: readonly TiktokenEncodingSpec[];
  smokeTestTimeoutMs?: number;
}

/**
 * Download uv, install the managed Python, build the venv with `release`,
 * overlay the prompts, prefetch tiktoken's encodings, smoke-test (`--help`
 * and the generated config), fetch the embedding model, and rename it
 * all into `versions/<version>/`. A leftover dir of the same version (one the
 * state no longer names) is replaced. Returns the record to store as
 * `current` (`integrity` is the wheel's `sha256:<hex>`); throws a
 * {@link KnowledgeInstallError} naming the failed step.
 */
export async function installKnowledgeRuntime(
  runtimeDir: string,
  release: MykgRelease,
  deps: KnowledgeInstallerDeps,
  options: InstallKnowledgeRuntimeOptions
): Promise<PluginInstalledVersion> {
  if (!VERSION_PATTERN.test(release.version) || !inMykgLine(release.version)) {
    throw new KnowledgeInstallError("install", `invalid myKG version "${release.version}"`);
  }
  if (!SHA256_PATTERN.test(release.wheelSha256)) {
    throw new KnowledgeInstallError("install", `invalid wheel sha256 for myKG ${release.version}`);
  }
  const overlayRoot = options.overlayRoot ?? MYKG_PROMPTS_ROOT;
  const locksDir = options.locksDir ?? MYKG_LOCKS_DIR;
  const model = options.model ?? EMBEDDING_MODEL;
  const encodings = options.encodings ?? TIKTOKEN_ENCODINGS;
  const { uv: build, signal } = options;
  const staging = join(knowledgeStagingDir(runtimeDir), `${release.version}-${randomUUID()}`);
  const built = join(staging, "runtime");
  const venv = join(built, "venv");
  const tiktokenDir = join(built, "tiktoken");
  const env = uvEnv(runtimeDir, staging, options.env);
  const uvBin = join(staging, "uv", `uv-${build.target}`, "uv");
  const runStep = async (name: KnowledgeInstallStep, timeoutMs: number, command: string, args: string[]) =>
    step(name, timeoutMs, signal, async (bounded) => {
      const result = await deps.run(command, args, { cwd: staging, env, timeoutMs, signal: bounded });
      assertSucceeded(result, `${command.endsWith("/uv") ? "uv" : command} ${args[0] ?? ""}`.trim(), timeoutMs);
      return result;
    });

  try {
    await step("download", DOWNLOAD_TIMEOUT_MS, signal, async (bounded) => {
      await mkdir(join(staging, "tmp"), { recursive: true, mode: 0o700 });
      await mkdir(knowledgeHomeDir(runtimeDir), { recursive: true, mode: 0o700 });
      await deps.download(build.url, join(staging, "uv.tar.gz"), bounded);
    });

    await step("integrity", REGISTRY_TIMEOUT_MS, signal, async (bounded) => {
      const published = (await deps.fetchText(build.sha256Url, bounded)).trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      if (published !== build.sha256) {
        throw new Error(`uv ${build.version}'s published sha256 does not match the one Orquester pins`);
      }
      if ((await sha256Hex(join(staging, "uv.tar.gz"))) !== build.sha256) {
        throw new Error(`the uv ${build.version} download does not match its sha256`);
      }
    });

    await step("extract", EXTRACT_TIMEOUT_MS, signal, async (bounded) => {
      await mkdir(join(staging, "uv"), { mode: 0o700 });
      // Relative archive path with cwd: GNU tar would read a `C:`-style path as a remote host.
      await runTar(["-xzf", "uv.tar.gz", "-C", "uv"], staging, knowledgeChildEnv(runtimeDir, options.env), bounded);
      if (!(await isFile(uvBin))) throw new Error(`the uv archive has no uv-${build.target}/uv`);
      await chmod(uvBin, 0o755);
    });

    await runStep("python", PYTHON_TIMEOUT_MS, uvBin, ["python", "install", PYTHON_VERSION, "--no-bin"]);

    await mkdir(built, { mode: 0o700 });
    await runStep("venv", VENV_TIMEOUT_MS, uvBin, [
      "venv",
      "--relocatable",
      "--no-project",
      "--python",
      PYTHON_VERSION,
      "--python-preference",
      "only-managed",
      venv
    ]);

    const requirements = await step("packages", 0, signal, () =>
      writeRequirements(staging, release, locksDir)
    );
    await runStep("packages", PACKAGES_TIMEOUT_MS, uvBin, [
      "pip",
      "install",
      "--python",
      join(venv, "bin", "python"),
      "--compile-bytecode",
      "--no-build",
      ...requirements
    ]);

    const overlay = await step("overlay", 0, signal, async () => {
      const promptsDir = await installedPromptsDir(venv);
      const files = await applyOverlay(MYKG_LINE, promptsDir, overlayRoot);
      if (!(await overlayApplied(MYKG_LINE, promptsDir, overlayRoot))) throw new Error("the prompt overlay did not take");
      return { line: MYKG_LINE, digest: await overlayDigest(MYKG_LINE, overlayRoot), files };
    });

    await step("tiktoken", DOWNLOAD_TIMEOUT_MS, signal, async (bounded) => {
      await mkdir(tiktokenDir, { recursive: true });
      for (const encoding of encodings) {
        const dest = join(tiktokenDir, tiktokenCacheKey(encoding.url));
        await deps.download(encoding.url, dest, bounded);
        if ((await sha256Hex(dest)) !== encoding.sha256) {
          throw new Error(`tiktoken's ${encoding.name} encoding does not match its sha256`);
        }
      }
    });

    await step("smoke-test", 0, signal, async () => {
      const timeoutMs = options.smokeTestTimeoutMs ?? KNOWLEDGE_SMOKE_TEST_TIMEOUT_MS;
      const env = { ...mykgEnv(runtimeDir, venv, options.env), TIKTOKEN_CACHE_DIR: tiktokenDir };
      const help = await deps.run(join(venv, "bin", "mykg"), ["--help"], { cwd: staging, env, timeoutMs, signal });
      assertSucceeded(help, "mykg --help", timeoutMs);
      if (!help.stdout.includes("extract-graph")) throw new Error("mykg --help lists no extract-graph command");

      // The config linking writes, loaded and checked by this myKG from a dir of its own.
      const smokeDir = join(staging, "smoke");
      await writeMykgConfig(smokeDir, { concurrency: KNOWLEDGE_CONCURRENCY_DEFAULT });
      const check = await deps.run(
        join(venv, "bin", "python"),
        ["-I", "-c", MYKG_CONFIG_CHECK, MYKG_PROFILE, join(smokeDir, "intermediate")],
        { cwd: smokeDir, env, timeoutMs, signal }
      );
      if (check.spawnError || check.timedOut) assertSucceeded(check, "the config check", timeoutMs);
      const report = check.exitCode === 0 ? parseConfigCheck(check.stdout) : null;
      if (report?.profile !== MYKG_PROFILE) {
        const detail = lastLines(check.stderr || check.stdout) || `exit ${check.exitCode ?? "by a signal"}`;
        throw new Error(`myKG ${release.version} rejected the generated config (profile ${MYKG_PROFILE}): ${detail}`);
      }
    });

    await step("model", DOWNLOAD_TIMEOUT_MS, signal, async (bounded) => {
      const modelDir = join(built, "models", ...model.id.split("/"));
      for (const file of model.files) {
        const dest = join(modelDir, ...file.path.split("/"));
        await mkdir(dirname(dest), { recursive: true });
        await deps.download(model.fileUrl(file.path), dest, bounded);
        if ((await sha256Hex(dest)) !== file.sha256) {
          throw new Error(`${model.id}/${file.path} does not match its sha256`);
        }
      }
    });

    const installedAt = deps.now().toISOString();
    await step("install", 0, signal, async () => {
      const manifest: KnowledgeRuntimeManifest = {
        schema: 1,
        mykgVersion: release.version,
        wheelSha256: release.wheelSha256,
        uvVersion: build.version,
        python: PYTHON_VERSION,
        overlay,
        embeddingModel: { id: model.id, revision: model.revision, dimensions: model.dimensions },
        tiktokenEncodings: encodings.map((encoding) => encoding.name),
        installedAt
      };
      await writeFile(join(built, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
      const target = knowledgeVersionDir(runtimeDir, release.version);
      await mkdir(knowledgeVersionsDir(runtimeDir), { recursive: true });
      const replaced = join(staging, "replaced");
      const hadTarget = await rename(target, replaced).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        }
      );
      try {
        await rename(built, target);
      } catch (error) {
        if (hadTarget) await rename(replaced, target).catch(() => undefined);
        throw error;
      }
    });
    return { version: release.version, integrity: `sha256:${release.wheelSha256}`, installedAt };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * The config check of the smoke test (`python -I -c <this> <profile> <intermediate dir>`, cwd
 * = the dir holding the generated `mykg_config.yaml`). Importing `mykg.config` finds that file,
 * resolves the selected profile and reads every constant (a missing key raises); `mykg.pipeline`
 * imports every step module against it; `load_adapter` builds the profile's LLM adapter (the
 * agent adapter only makes its inbox and outbox dirs: no call); and the configured tiktoken
 * encoding loads with tiktoken's downloader replaced, so only the prefetched cache can serve it.
 * Prints one JSON line.
 */
export const MYKG_CONFIG_CHECK = `
import json, sys
import tiktoken, tiktoken.load

def offline(blobpath):
    raise RuntimeError("tiktoken tried to download " + blobpath + ": it is not in the runtime's cache")

tiktoken.load.read_file = offline

import mykg.config as cfg
import mykg.pipeline
from mykg.llm.config import load_adapter

profile, intermediate = sys.argv[1], sys.argv[2]
selected = cfg.RAW.get("profile")
if selected != profile:
    raise SystemExit("the config selects profile %r, not %r" % (selected, profile))
adapter = load_adapter(intermediate_dir=intermediate)
encoding = tiktoken.get_encoding(cfg.CHUNK_TIKTOKEN_ENCODING)
encoding.encode("smoke test")
print(json.dumps({"config": str(cfg.CONFIG_PATH), "profile": selected, "provider": cfg.RAW.get("provider"),
                  "adapter": type(adapter).__name__, "encoding": encoding.name}))
`;

/** The config check's report (its last stdout line), or null when it printed none. */
function parseConfigCheck(stdout: string): { profile?: unknown } | null {
  const line = stdout.trim().split(/\r?\n/).at(-1) ?? "";
  try {
    const value = JSON.parse(line) as unknown;
    return typeof value === "object" && value !== null ? (value as { profile?: unknown }) : null;
  } catch {
    return null;
  }
}

/**
 * The `uv pip install` arguments for `release`: the shipped lock with every
 * hash when there is one for it; else its wheel by sha256, with every other
 * entry of the pinned lock (version, marker and hashes) as a constraint. uv
 * checks a constraint's hashes, and `--require-hashes` refuses a package with
 * none, so no byte installs unverified on either path.
 */
async function writeRequirements(staging: string, release: MykgRelease, locksDir: string): Promise<string[]> {
  const own = MYKG_LOCKS[release.version];
  if (own) return ["--require-hashes", "-r", join(locksDir, own)];
  const pinnedLock = MYKG_LOCKS[MYKG_PINNED_VERSION];
  if (!pinnedLock) throw new Error(`no lock for myKG ${MYKG_PINNED_VERSION}`);
  const constraints = lockWithout(await readFile(join(locksDir, pinnedLock), "utf8"), MYKG_PACKAGE);
  await writeFile(join(staging, "constraints.txt"), constraints);
  await writeFile(join(staging, "requirements.txt"), `${MYKG_PACKAGE}==${release.version} --hash=sha256:${release.wheelSha256}\n`);
  return ["--require-hashes", "-r", join(staging, "requirements.txt"), "-c", join(staging, "constraints.txt")];
}

/** A hashed lock without `name`'s entry (its requirement line and the continuation lines under it) and comments. */
function lockWithout(lock: string, name: string): string {
  const out: string[] = [];
  let dropping = false;
  for (const line of lock.split(/\r?\n/)) {
    if (line.startsWith(" ") || line.startsWith("\t")) {
      if (!dropping) out.push(line);
      continue;
    }
    dropping = line.startsWith(`${name}==`) || line.startsWith("#");
    if (!dropping && line.trim() !== "") out.push(line);
  }
  return `${out.join("\n")}\n`;
}

/** `name==version[ ; marker]` of every requirement in a hashed lock (hashes and comments dropped). */
export function parseLockVersions(lock: string): string[] {
  const out: string[] = [];
  for (const raw of lock.split(/\r?\n/)) {
    if (raw.startsWith(" ") || raw.startsWith("\t") || raw.startsWith("#")) continue;
    const line = raw.replace(/\\\s*$/, "").trim();
    if (/^[A-Za-z0-9._-]+==[^\s;]+/.test(line)) out.push(line);
  }
  return out;
}

/** `<venv>/lib/python3.X/site-packages/mykg/prompts`. */
async function installedPromptsDir(venv: string): Promise<string> {
  const lib = join(venv, "lib");
  const names = (await readdir(lib).catch(() => [] as string[])).filter((name) => /^python3\.\d+$/.test(name));
  for (const name of names) {
    const dir = join(lib, name, "site-packages", MYKG_PACKAGE, "prompts");
    if ((await stat(dir).catch(() => null))?.isDirectory()) return dir;
  }
  throw new Error("the installed myKG has no prompts directory");
}

function assertSucceeded(result: CommandResult, label: string, timeoutMs: number): void {
  if (result.spawnError) throw new Error(`${label} failed to start (${result.spawnError})`);
  if (result.timedOut) throw new Error(`${label} did not finish within ${Math.round(timeoutMs / 1000)}s`);
  if (result.exitCode !== 0) {
    const detail = lastLines(result.stderr || result.stdout);
    const code = result.exitCode === null ? "a signal" : `code ${result.exitCode}`;
    throw new Error(detail ? `${label} exited with ${code}: ${detail}` : `${label} exited with ${code}`);
  }
}

/** The last few non-empty lines of a child's output, capped, for an error message. */
function lastLines(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const tail = lines.slice(-3).join(" | ");
  return tail.length > 400 ? `${tail.slice(0, 399)}…` : tail;
}

// ---- prune, remove, staging ---------------------------------------------------------------------

/** Delete every `versions/*` dir not named in `keep`. */
export async function pruneKnowledgeVersions(runtimeDir: string, keep: readonly string[]): Promise<void> {
  const dir = knowledgeVersionsDir(runtimeDir);
  const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  });
  for (const name of names) {
    if (!keep.includes(name)) await rm(join(dir, name), { recursive: true, force: true });
  }
}

/** "Remove downloads": the whole runtime dir (versions, the managed Python, the children's HOME). */
export async function removeKnowledgeRuntime(runtimeDir: string): Promise<void> {
  await rm(runtimeDir, { recursive: true, force: true });
}

/** Empty the staging dir: whatever is in it was left by a daemon that stopped mid-install. */
export async function clearKnowledgeStaging(runtimeDir: string): Promise<void> {
  await rm(knowledgeStagingDir(runtimeDir), { recursive: true, force: true });
}

// ---- real deps -----------------------------------------------------------------------------------

/** Network over `fetchImpl` (the global `fetch` by default), the real process runner and clock. */
export function knowledgeInstallerDepsWithFetch(
  fetchImpl: typeof fetch = (input, init) => fetch(input, init)
): KnowledgeInstallerDeps {
  const get = async (url: string, signal: AbortSignal, accept?: string): Promise<Response> => {
    const response = await fetchImpl(url, { signal, redirect: "follow", ...(accept ? { headers: { accept } } : {}) });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
    return response;
  };
  return {
    fetchJson: async (url, signal) => (await get(url, signal, "application/json")).json(),
    fetchText: async (url, signal) => (await get(url, signal)).text(),
    download: async (url, dest, signal) => {
      const response = await get(url, signal);
      if (!response.body) throw new Error(`HTTP ${response.status} from ${url} had no body`);
      await pipeline(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        createWriteStream(dest, { mode: 0o644 }),
        { signal }
      );
    },
    run: runCommand,
    now: () => new Date()
  };
}

/** The real deps over the global `fetch`. Used by the daemon, never by the unit tests. */
export const defaultKnowledgeInstallerDeps: KnowledgeInstallerDeps = knowledgeInstallerDepsWithFetch();

/** execFile: no shell, exactly the given env, SIGKILL on timeout, output captured (16 MB cap). */
export function runCommand(command: string, args: readonly string[], options: CommandOptions): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeoutMs,
        killSignal: "SIGKILL",
        signal: options.signal,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8"
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ exitCode: 0, stdout, stderr, timedOut: false });
          return;
        }
        const code = (error as NodeJS.ErrnoException).code as unknown;
        if (typeof code === "string" && code !== "ABORT_ERR") {
          resolve({ exitCode: null, stdout, stderr, timedOut: false, spawnError: code });
          return;
        }
        resolve({
          exitCode: typeof code === "number" ? code : null,
          stdout,
          stderr,
          timedOut: error.killed === true && error.signal === "SIGKILL"
        });
      }
    );
  });
}

// ---- helpers -------------------------------------------------------------------------------------

/**
 * Run one install step: abort-aware, bounded by `timeoutMs` (0 = no own bound),
 * and any failure rethrown as a {@link KnowledgeInstallError} for that step.
 */
async function step<T>(
  name: KnowledgeInstallStep,
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
    if (error instanceof KnowledgeInstallError) throw error;
    if (signal.aborted) throw new KnowledgeInstallError(name, "cancelled");
    if (timeout?.aborted) throw new KnowledgeInstallError(name, `timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw new KnowledgeInstallError(name, error instanceof Error ? error.message : String(error));
  }
}

function runTar(args: string[], cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("tar", args, { cwd, env, signal, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) {
        const detail = String(stderr).trim().split(/\r?\n/)[0];
        reject(new Error(detail ? `tar failed: ${detail}` : `tar failed: ${error.message}`));
        return;
      }
      resolve();
    });
  });
}

export async function sha256Hex(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (info) => info.isFile(),
    () => false
  );
}
