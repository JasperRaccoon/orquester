/**
 * Pinned npm tools under `devicesToolsDir` (devices spec §5): `<root>/<name>@<version>` is an npm
 * prefix holding exactly that version. An install goes to a staging dir with the daemon's own
 * Node and npm, runs its post-install step (the hub's scrcpy-server jar), writes the
 * `.install-complete` sentinel, then renames into place; a dir without the sentinel is not
 * installed. One lock per tool; versions other than the current and the previous one are pruned.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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
    const staging = join(root, `.staging-${name}@${version}-${randomUUID().slice(0, 8)}`);
    await mkdir(staging, { recursive: true });
    try {
      await writeFile(join(staging, "package.json"), `${JSON.stringify({ name: "orquester-device-tool", private: true }, null, 2)}\n`);
      const result = await deps.exec(
        deps.nodePath,
        [deps.npmCli, "install", "--prefix", staging, "--no-audit", "--no-fund", "--save-exact", "--loglevel=error", `${name}@${version}`],
        { env: deps.env, cwd: staging, signal, timeoutMs: 15 * 60_000, ...(onLine ? { onLine } : {}) }
      );
      signal.throwIfAborted();
      if (result.exitCode !== 0) throw new Error(`npm could not install ${name}@${version}: ${lastLine(result) || `exit ${result.exitCode}`}`);
      const entry = TOOL_ENTRY[name];
      if (entry && !existsSync(join(staging, entry.entry))) throw new Error(`${name}@${version} installed without ${entry.entry}.`);
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
