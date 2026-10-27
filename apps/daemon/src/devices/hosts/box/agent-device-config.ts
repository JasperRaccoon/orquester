/**
 * The agent-device `--config` file of a box device host: a JSON object of agent-device flag keys
 * (`daemonBaseUrl`, `daemonAuthToken`; agent-device 0.21 reads `--config`/`AGENT_DEVICE_CONFIG`
 * files with exactly the flags' camelCase names) pointing the daemon's CLI at the box's agent-device
 * daemon through its `forwardToHost` port. The file holds the daemon's token: 0600 in a 0700 dir,
 * written atomically, never returned.
 */

import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { devicesDir } from "@orquester/config";

/** `<appdir>/daemon/devices/hosts/<host>/agent-device.json` (`box:abc` → `box-abc`). */
export function boxAgentDeviceConfigPath(appDir: string, hostId: string): string {
  return join(devicesDir(appDir), "hosts", hostId.replace(/[^A-Za-z0-9_-]/g, "-"), "agent-device.json");
}

export function agentDeviceConfigText(endpoint: { baseUrl: string; token: string }): string {
  return `${JSON.stringify({ daemonBaseUrl: endpoint.baseUrl, daemonAuthToken: endpoint.token }, null, 2)}\n`;
}

/** Write (or keep, when unchanged) the config file; resolves its path. */
export async function writeAgentDeviceConfig(file: string, endpoint: { baseUrl: string; token: string }): Promise<string> {
  const text = agentDeviceConfigText(endpoint);
  const dir = dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  if ((await readFile(file, "utf8").catch(() => null)) === text) {
    await chmod(file, 0o600);
    return file;
  }
  const temporary = join(dir, `.agent-device-${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
  return file;
}

export async function removeAgentDeviceConfig(file: string): Promise<void> {
  await rm(file, { force: true });
}
