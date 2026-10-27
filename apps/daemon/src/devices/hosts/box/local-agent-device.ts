/**
 * The agent-device CLI on this machine for box hosts: the actions layer runs it here, with the
 * host's 0600 `--config` pointing it at the box's agent-device daemon through the forwarded port.
 *
 * The device toolchain owns pinned installs (`toolchain/`): its `toolBin` and `ensureTool` are
 * used when it has them. Until it can install, the same layout is installed here (devices spec §5:
 * `<devicesToolsDir>/agent-device@<version>`, npm into a staging dir with this daemon's Node,
 * `.install-complete` sentinel, renamed into place; `npm ci --ignore-scripts` from the shipped
 * lockfile), so the toolchain finds it later.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";

import { devicesToolsDir } from "@orquester/config";

import { DEVICE_TOOL_VERSIONS } from "../../../boxes/github/device-cache.ts";
import type { DeviceToolchain } from "../../toolchain/index.ts";
import { NPM_CI_ARGS, toolLock } from "../../toolchain/npm-tools.ts";

const VERSION = DEVICE_TOOL_VERSIONS["agent-device"];
const INSTALL_TIMEOUT_MS = 10 * 60_000;

function localAgentDeviceDir(appDir: string): string {
  return join(devicesToolsDir(appDir), `agent-device@${VERSION}`);
}

function entryIn(dir: string): string {
  return join(dir, "node_modules", "agent-device", "bin", "agent-device.mjs");
}

/** The installed pinned CLI's entry script (the toolchain's, or this layout's), or null. */
export function localAgentDeviceEntry(appDir: string, toolchain?: Pick<DeviceToolchain, "toolBin">): string | null {
  const bin = toolchain?.toolBin("agent-device") ?? null;
  if (bin) {
    try {
      return realpathSync(bin);
    } catch {
      // Fall through to the layout below.
    }
  }
  const dir = localAgentDeviceDir(appDir);
  try {
    if (readFileSync(join(dir, ".install-complete"), "utf8").trim() === VERSION && existsSync(entryIn(dir))) return entryIn(dir);
  } catch {
    // Not installed.
  }
  return null;
}

const installs = new Map<string, Promise<string>>();

/** Install the pinned CLI when missing (one install per appdir at a time); resolves its entry script. */
export function ensureLocalAgentDevice(input: { appDir: string; toolchain?: DeviceToolchain; signal: AbortSignal }): Promise<string> {
  const ready = localAgentDeviceEntry(input.appDir, input.toolchain);
  if (ready) return Promise.resolve(ready);
  const running = installs.get(input.appDir);
  if (running) return running;
  const run = install(input).finally(() => installs.delete(input.appDir));
  installs.set(input.appDir, run);
  return run;
}

async function install(input: { appDir: string; toolchain?: DeviceToolchain; signal: AbortSignal }): Promise<string> {
  if (input.toolchain) {
    try {
      await input.toolchain.ensureTool("agent-device", input.signal);
      const entry = localAgentDeviceEntry(input.appDir, input.toolchain);
      if (entry) return entry;
    } catch {
      // The toolchain cannot install (yet): install the same layout here.
    }
  }
  const dir = localAgentDeviceDir(input.appDir);
  await mkdir(dirname(dir), { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(dirname(dir), ".install-agent-device-"));
  try {
    const nodeDir = dirname(process.execPath);
    const npm = existsSync(join(nodeDir, "npm")) ? join(nodeDir, "npm") : "npm";
    // The shipped lockfile, no lifecycle scripts (agent-device has no native build).
    const lock = toolLock("agent-device", VERSION);
    if (!lock) throw new Error(`this build ships no lockfile for agent-device@${VERSION}`);
    await writeFile(join(staging, "package.json"), lock.packageJson);
    await writeFile(join(staging, "package-lock.json"), lock.packageLock);
    await new Promise<void>((resolve, reject) => {
      execFile(
        npm,
        [...NPM_CI_ARGS, "--prefix", staging],
        {
          env: { ...process.env, PATH: `${nodeDir}${delimiter}${process.env.PATH ?? ""}`, npm_config_update_notifier: "false" },
          timeout: INSTALL_TIMEOUT_MS,
          maxBuffer: 8 * 1024 * 1024,
          signal: input.signal
        },
        (error, _stdout, stderr) => (error ? reject(new Error(`npm ci agent-device@${VERSION} failed: ${String(stderr).trim().split("\n").slice(-3).join(" ") || error.message}`)) : resolve())
      );
    });
    if (!existsSync(entryIn(staging))) throw new Error(`npm installed no agent-device@${VERSION} entry`);
    await writeFile(join(staging, ".install-complete"), VERSION);
    await rm(dir, { recursive: true, force: true });
    await rename(staging, dir);
    return entryIn(dir);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
