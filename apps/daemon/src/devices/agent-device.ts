/**
 * Callstack's `agent-device` CLI, run by the daemon for one leased device (devices spec §4, §9):
 * always with `--config` pinned to the host's agent-device daemon (`DeviceHost.agentDeviceConfigPath`)
 * and `--session <leaseId>`, never through a shell, its token never in argv or a response.
 *
 * SEAM — owned by the agent-device work package. {@link createAgentDeviceClient} is a stand-in
 * that refuses every call until the real runner lands here.
 */

import type { StoredDeviceLease } from "@orquester/config";

import { DeviceError } from "./errors.ts";
import type { DeviceHost } from "./host.ts";
import type { DeviceToolchain } from "./toolchain/index.ts";

export interface AgentDeviceTarget {
  host: DeviceHost;
  /** A `ready` lease (its `deviceId` set). */
  lease: StoredDeviceLease;
}

export interface AgentDeviceResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** The parsed `--json` output, when the command printed one. */
  json?: unknown;
}

export interface AgentDeviceClient {
  /** Run `agent-device <command> …args` for the target's device. */
  run(target: AgentDeviceTarget, command: string, args: readonly string[], options: { signal: AbortSignal; timeoutMs?: number }): Promise<AgentDeviceResult>;
  /** Warm up a freshly ready host (iOS: build the XCTest runner) so the first snapshot is fast. */
  prepare?(host: DeviceHost, signal: AbortSignal): Promise<void>;
}

export interface AgentDeviceDeps {
  toolchain: DeviceToolchain;
  env: NodeJS.ProcessEnv;
  logger: Pick<Console, "info" | "warn" | "error">;
}

export function createAgentDeviceClient(_deps: AgentDeviceDeps): AgentDeviceClient {
  return {
    async run() {
      throw new DeviceError("UNAVAILABLE", "Driving devices is not available in this build yet.");
    }
  };
}
