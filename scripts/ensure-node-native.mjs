#!/usr/bin/env node
/**
 * Ensure the daemon's native modules load under the Node running this script.
 *
 * The daemon runs under plain Node (tsx), but the desktop build's
 * electron-builder rebuilds the same pnpm-installed better-sqlite3 and
 * node-pty IN PLACE for Electron's ABI. Afterwards the daemon cannot load them
 * ("NODE_MODULE_VERSION ..." / "Module did not self-register").
 *
 * This probes each module in a child `node` (a bad binary cannot crash this
 * script), rebuilds only the failing ones for the running Node with
 * `pnpm rebuild`, and probes again. Exit 0 when everything loads, 1 when a
 * module is still broken. Nothing is rebuilt (and nothing touches the network)
 * when every probe passes.
 *
 * Usage: node scripts/ensure-node-native.mjs
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TAG = "[ensure-node-native]";
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// Probe from the daemon's package so module resolution matches the daemon's.
const daemonDir = join(repoRoot, "apps", "daemon");

/** Native modules the daemon loads under Node, each with a minimal exercise. */
export const NATIVE_MODULES = [
  // better-sqlite3's JS loads without its binding; the first open loads it.
  { name: "better-sqlite3", probe: "new (require('better-sqlite3'))(':memory:').close();" },
  // node-pty loads its binding when the module is required.
  { name: "node-pty", probe: "require('node-pty');" }
];

/** Load-and-exercise one module in a child node. Returns null or an error line. */
export function probeInChild(mod) {
  const result = spawnSync(process.execPath, ["-e", mod.probe], {
    cwd: daemonDir,
    encoding: "utf8",
    timeout: 60_000
  });
  if (result.status === 0) return null;
  if (result.error) return result.error.message;
  const lines = `${result.stderr ?? ""}`.split("\n").map((line) => line.trim()).filter(Boolean);
  const errorLine = lines.find((line) => /error/i.test(line)) ?? lines[0];
  return errorLine ?? `exited with ${result.signal ?? `code ${result.status}`}`;
}

/** `pnpm rebuild` the named packages for the running Node. Returns true on success. */
export function pnpmRebuild(names) {
  // -r: the packages are dependencies of workspace projects, not of the root.
  const result = spawnSync("pnpm", ["rebuild", "-r", ...names], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32"
  });
  return result.status === 0;
}

/**
 * The decision logic: probe every module, rebuild the failing ones once, probe
 * those again. `probe(mod)` returns null when the module loads, else an error.
 */
export function ensureNodeNative({ modules = NATIVE_MODULES, probe = probeInChild, rebuild = pnpmRebuild, log = console.log } = {}) {
  const failing = [];
  for (const mod of modules) {
    const error = probe(mod);
    if (error) failing.push({ mod, error });
  }
  if (failing.length === 0) return { ok: true, rebuilt: [], broken: [] };

  for (const { mod, error } of failing) {
    log(`${TAG} ${mod.name} does not load under Node ${process.version}: ${error}`);
  }
  const names = failing.map(({ mod }) => mod.name);
  log(`${TAG} rebuilding for Node ${process.version}: ${names.join(", ")}`);
  const rebuildOk = rebuild(names);

  const broken = [];
  for (const { mod } of failing) {
    const error = probe(mod);
    if (error) broken.push({ name: mod.name, error });
  }
  if (!rebuildOk && broken.length === 0) {
    log(`${TAG} pnpm rebuild reported a failure, but every module loads now`);
  }
  return { ok: broken.length === 0, rebuilt: names, broken };
}

/** CLI entry: returns the process exit code. */
export function main(options) {
  const result = ensureNodeNative(options);
  const log = options?.log ?? console.log;
  const error = options?.error ?? console.error;
  if (result.ok) {
    if (result.rebuilt.length > 0) log(`${TAG} rebuilt and verified: ${result.rebuilt.join(", ")}`);
    return 0;
  }
  for (const { name, error: why } of result.broken) {
    error(`${TAG} ERROR: ${name} still does not load under Node ${process.version} after rebuild: ${why}`);
  }
  error(`${TAG} the daemon cannot start until this is fixed; check the rebuild output above`);
  error(`${TAG} (a compiler toolchain — python3, make, g++ — is needed when no prebuilt binary exists)`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
