/**
 * Pinned npm tools under `devicesToolsDir` (devices spec §5): `<root>/<name>@<version>` is an npm
 * prefix holding exactly that version. An install goes to a staging dir with the daemon's own
 * Node and npm: the tool's shipped lockfile (`locks/<name>/`, every transitive dependency pinned
 * with its integrity hash) is installed with `npm ci --ignore-scripts` (no package lifecycle
 * script runs), then the explicit build steps ({@link NATIVE_PREBUILDS}) and the post-install step
 * (the hub's scrcpy-server jar) run, the `.install-complete` sentinel is written, and the dir is
 * renamed into place; a dir without the sentinel is not installed. One lock per tool; versions
 * other than the current and the previous one are pruned. Box hosts install both tools from
 * `locks/box-tools/` the same way ({@link BOX_TOOLS_LOCK}).
 *
 * Regenerate a lock after a version bump (`tool-versions.json`): in an empty dir with the
 * package.json below, `npm install --package-lock-only --ignore-scripts`.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type ExecFn, lastLine } from "../android/exec.ts";
import type { DownloadFn, PinnedDownload } from "./download.ts";
import { sha256File } from "./download.ts";
import { withLock } from "./lock.ts";

export const INSTALL_SENTINEL = ".install-complete";

/**
 * serve-emu (inside expo-device-hub) fetches this from GitHub on the first stream; it is pre-seeded
 * at install so streaming never downloads. SHA-256 computed from the official v4.0 release asset.
 */
export const SCRCPY_SERVER: PinnedDownload & { version: string; fileName: string } = {
  version: "4.0",
  fileName: "scrcpy-server-v4.0",
  url: "https://github.com/Genymobile/scrcpy/releases/download/v4.0/scrcpy-server-v4.0",
  sha256: "84924bd564a1eb6089c872c7521f968058977f91f5ff02514a8c74aff3210f3a",
  size: 732_226
};

/** The package's entry module, run with the daemon's node; and its `.bin` link. */
export const TOOL_ENTRY: Readonly<Record<string, { entry: string; bin: string }>> = {
  "expo-device-hub": { entry: "node_modules/expo-device-hub/dist/server/cli.mjs", bin: "node_modules/.bin/expo-device-hub" },
  "agent-device": { entry: "node_modules/agent-device/bin/agent-device.mjs", bin: "node_modules/.bin/agent-device" }
};

/** A shipped `package.json` + `package-lock.json` pair. */
export interface ToolLock {
  packageJson: string;
  packageLock: string;
}

const LOCKS_DIR = fileURLToPath(new URL("./locks/", import.meta.url));

function readLock(dir: string): ToolLock | null {
  try {
    return { packageJson: readFileSync(join(LOCKS_DIR, dir, "package.json"), "utf8"), packageLock: readFileSync(join(LOCKS_DIR, dir, "package-lock.json"), "utf8") };
  } catch {
    return null;
  }
}

/** Whether a lock pins exactly these top-level `name@version`s. */
export function lockPins(lock: ToolLock, pins: Readonly<Record<string, string>>): boolean {
  try {
    const pkg = JSON.parse(lock.packageJson) as { dependencies?: Record<string, string> };
    const locked = JSON.parse(lock.packageLock) as { packages?: Record<string, { version?: string }> };
    return Object.entries(pins).every(([name, version]) => pkg.dependencies?.[name] === version && locked.packages?.[`node_modules/${name}`]?.version === version);
  } catch {
    return false;
  }
}

/** The shipped lock of `name@version`, or null when this build ships none for that version. */
export function toolLock(name: string, version: string): ToolLock | null {
  const lock = /^[a-z0-9-]+$/.test(name) ? readLock(name) : null;
  return lock && lockPins(lock, { [name]: version }) ? lock : null;
}

/** Both pinned tools in one npm prefix (a box's tools dir: what the device-tools cache holds). */
export const BOX_TOOLS_LOCK: ToolLock | null = readLock("box-tools");

/**
 * Native builds lifecycle scripts would have run, run explicitly after `npm ci --ignore-scripts`:
 * package dir → the command in it. node-datachannel (the hub's WebRTC publisher only, loaded
 * lazily) fetches its prebuilt N-API binary; a failure only leaves WebRTC to the hub's own repair.
 */
export const NATIVE_PREBUILDS: Readonly<Record<string, { script: string; args: readonly string[] }>> = {
  "node_modules/node-datachannel": { script: "node_modules/prebuild-install/bin.js", args: ["-r", "napi"] }
};

/** `npm ci` flags of every pinned install: the lockfile only, no lifecycle scripts. */
export const NPM_CI_ARGS: readonly string[] = ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"];

/**
 * POSIX shell run in an npm prefix holding a shipped `package.json` + `package-lock.json` (a box's
 * tools dir): `npm ci --ignore-scripts`, then {@link NATIVE_PREBUILDS} (best effort). Constant text.
 */
export const NPM_CI_SCRIPT = `npm ${NPM_CI_ARGS.join(" ")}
prefix=$(pwd)
${Object.entries(NATIVE_PREBUILDS)
  .map(
    ([pkg, step]) => `if [ -f '${pkg}/package.json' ] && [ -f '${step.script}' ]; then
  (cd '${pkg}' && node "$prefix/${step.script}" ${step.args.join(" ")}) || echo "warning: the prebuilt binary of ${pkg.replace("node_modules/", "")} was not installed" >&2
fi`
  )
  .join("\n")}
`;

export function toolDir(root: string, name: string, version: string): string {
  return join(root, `${name}@${version}`);
}

/** Where serve-emu looks for the jar inside a hub install. */
export function scrcpyJarPath(hubDir: string): string {
  return join(hubDir, "node_modules", "expo-device-hub", "vendor", "serve-emu", "vendor", SCRCPY_SERVER.fileName);
}

/** Installed: the sentinel and the entry module exist (and the hub has its jar). */
export function isToolInstalled(root: string, name: string, version: string): boolean {
  const dir = toolDir(root, name, version);
  const entry = TOOL_ENTRY[name];
  if (!existsSync(join(dir, INSTALL_SENTINEL)) || (entry && !existsSync(join(dir, entry.entry)))) return false;
  return name !== "expo-device-hub" || existsSync(scrcpyJarPath(dir));
}

export interface NpmInstallDeps {
  exec: ExecFn;
  download: DownloadFn;
  /** The daemon's node. */
  nodePath: string;
  /** npm's CLI script (`…/npm/bin/npm-cli.js`). */
  npmCli: string;
  env: NodeJS.ProcessEnv;
  /** Kept downloads (the scrcpy jar). */
  downloads: string;
  /** Tests: the pinned jar instead of {@link SCRCPY_SERVER}. */
  scrcpy?: PinnedDownload;
  /** Tests: the lock to install instead of the shipped one ({@link toolLock}). */
  lock?: ToolLock;
}

/** Copy the verified scrcpy-server jar into a hub install (downloaded once into `downloads`). */
export async function seedScrcpyServer(hubDir: string, deps: Pick<NpmInstallDeps, "download" | "downloads" | "scrcpy">, signal: AbortSignal): Promise<void> {
  const pinned = deps.scrcpy ?? SCRCPY_SERVER;
  const cached = join(deps.downloads, SCRCPY_SERVER.fileName);
  await deps.download(pinned, cached, { signal });
  if ((await sha256File(cached)) !== pinned.sha256) throw new Error("The scrcpy-server download does not match its pinned checksum.");
  const target = scrcpyJarPath(hubDir);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(cached, target);
}

/**
 * Install `name@version` under `root` unless it is installed; resolves its dir. `onLine` gets npm's
 * output lines.
 */
export async function installNpmTool(
  root: string,
  name: string,
  version: string,
  deps: NpmInstallDeps,
  signal: AbortSignal,
  onLine?: (line: string) => void
): Promise<string> {
  const dir = toolDir(root, name, version);
  await mkdir(root, { recursive: true, mode: 0o700 });
  return withLock(join(root, `.${name}.lock`), signal, async () => {
    if (isToolInstalled(root, name, version)) return dir;
    // Installed except the jar (a hub from before pre-seeding, or the jar was removed): repair in place.
    if (name === "expo-device-hub" && existsSync(join(dir, INSTALL_SENTINEL))) {
      await seedScrcpyServer(dir, deps, signal);
      if (isToolInstalled(root, name, version)) return dir;
    }
    const lock = deps.lock ?? toolLock(name, version);
    if (!lock) throw new Error(`This build ships no lockfile for ${name}@${version}.`);
    const staging = join(root, `.staging-${name}@${version}-${randomUUID().slice(0, 8)}`);
    await mkdir(staging, { recursive: true });
    try {
      await writeFile(join(staging, "package.json"), lock.packageJson);
      await writeFile(join(staging, "package-lock.json"), lock.packageLock);
      const result = await deps.exec(deps.nodePath, [deps.npmCli, ...NPM_CI_ARGS, "--prefix", staging], {
        env: deps.env,
        cwd: staging,
        signal,
        timeoutMs: 15 * 60_000,
        ...(onLine ? { onLine } : {})
      });
      signal.throwIfAborted();
      if (result.exitCode !== 0) throw new Error(`npm could not install ${name}@${version}: ${lastLine(result) || `exit ${result.exitCode}`}`);
      const entry = TOOL_ENTRY[name];
      if (entry && !existsSync(join(staging, entry.entry))) throw new Error(`${name}@${version} installed without ${entry.entry}.`);
      await runNativePrebuilds(staging, deps, signal, onLine);
      if (name === "expo-device-hub") await seedScrcpyServer(staging, deps, signal);
      await writeFile(join(staging, INSTALL_SENTINEL), `${JSON.stringify({ name, version, installedAt: new Date().toISOString() })}\n`);
      await rm(dir, { recursive: true, force: true });
      await rename(staging, dir);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    await pruneToolVersions(root, name, version).catch(() => undefined);
    return dir;
  });
}

/** The explicit build steps of {@link NATIVE_PREBUILDS} present in `prefix` (best effort: a failure is reported, not thrown). */
export async function runNativePrebuilds(prefix: string, deps: Pick<NpmInstallDeps, "exec" | "nodePath" | "env">, signal: AbortSignal, onLine?: (line: string) => void): Promise<void> {
  for (const [pkg, step] of Object.entries(NATIVE_PREBUILDS)) {
    const dir = join(prefix, pkg);
    const script = join(prefix, step.script);
    if (!existsSync(join(dir, "package.json")) || !existsSync(script)) continue;
    const result = await deps.exec(deps.nodePath, [script, ...step.args], { env: deps.env, cwd: dir, signal, timeoutMs: 5 * 60_000, ...(onLine ? { onLine } : {}) });
    if (result.exitCode !== 0) onLine?.(`warning: the prebuilt binary of ${pkg.replace("node_modules/", "")} was not installed (${lastLine(result) || `exit ${result.exitCode}`}); the hub fetches it when WebRTC is first used.`);
  }
}

/** Remove every `<name>@*` except `current` and the most recently installed other one; staging leftovers go too. */
export async function pruneToolVersions(root: string, name: string, current: string): Promise<string[]> {
  const entries = await readdir(root).catch(() => [] as string[]);
  const prefix = `${name}@`;
  const others: { entry: string; installedAt: number }[] = [];
  const removed: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith(`.staging-${prefix}`)) {
      await rm(join(root, entry), { recursive: true, force: true });
      removed.push(entry);
      continue;
    }
    if (!entry.startsWith(prefix) || entry === `${prefix}${current}`) continue;
    const sentinel = await stat(join(root, entry, INSTALL_SENTINEL)).catch(() => null);
    others.push({ entry, installedAt: sentinel?.mtimeMs ?? 0 });
  }
  others.sort((a, b) => b.installedAt - a.installedAt);
  const keep = others.find((other) => other.installedAt > 0);
  for (const other of others) {
    if (other === keep) continue;
    await rm(join(root, other.entry), { recursive: true, force: true });
    removed.push(other.entry);
  }
  return removed;
}

/** npm's CLI next to the daemon's node (`<prefix>/lib/node_modules/npm/bin/npm-cli.js`). */
export function findNpmCli(nodePath: string): string | null {
  const prefix = dirname(dirname(nodePath));
  for (const candidate of [join(prefix, "lib", "node_modules", "npm", "bin", "npm-cli.js"), join(dirname(nodePath), "node_modules", "npm", "bin", "npm-cli.js")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
