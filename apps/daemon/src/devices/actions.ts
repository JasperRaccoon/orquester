/**
 * `device_action` and `device_install` on a leased device (devices spec §9): each action kind
 * mapped onto agent-device (`snapshot -i` with `@eN` refs, `tap`, `fill`, `press`, `swipe`, …,
 * `--settle` after input so the result carries the snapshot diff), screenshots as images, ref taps
 * resolved to a point from the last snapshot (for the panel's overlay), builds streamed to the host
 * and installed.
 *
 * SEAM — owned by the actions work package. The service calls {@link DeviceActionExecutor} with a
 * validated input (`validateDeviceActionInput`) on a lease the controller rules allow, then records
 * the result's `log` in the action log and keeps its `image` as a screenshot.
 * {@link createDeviceActionExecutor} is a stand-in that refuses until the real one lands here.
 */

import type { DeviceActionInput, DevicePoint } from "@orquester/api";
import type { StoredDeviceLease } from "@orquester/config";

import type { AgentDeviceClient } from "./agent-device.ts";
import { DeviceError } from "./errors.ts";
import type { DeviceHost } from "./host.ts";

export interface DeviceActionContext {
  host: DeviceHost;
  /** A `ready` lease. */
  lease: StoredDeviceLease;
}

/** What the action log shows for it (the service adds actor, kind and `ok`). */
export interface DeviceActionLogFields {
  summary: string;
  point?: DevicePoint;
  from?: DevicePoint;
  to?: DevicePoint;
  target?: string;
}

export interface DeviceActionResult {
  log: DeviceActionLogFields;
  /** Compact text for the agent: the snapshot tree, the settle diff, the log lines. */
  text?: string;
  /** A screenshot (`screenshot`, or an action that returns one). */
  image?: { mimeType: "image/png" | "image/jpeg"; data: Buffer; width: number; height: number };
  /** Extra JSON fields for the agent's result. */
  details?: Record<string, unknown>;
}

export interface DeviceInstallResult {
  /** The installed app's bundle id / package, when it could be read. */
  appId: string | null;
  summary: string;
}

export interface DeviceActionExecutor {
  /** Run one action. Rejects with a `DeviceError` written for the agent. */
  execute(ctx: DeviceActionContext, input: DeviceActionInput, signal: AbortSignal): Promise<DeviceActionResult>;
  /**
   * Stream a build from THIS machine to the device's host (`DeviceHost.uploadFile`; an `.app`
   * directory archived on the way) and install it. `localPath` is a real path the service already
   * checked lies inside the calling chat's project.
   */
  install(ctx: DeviceActionContext, localPath: string, signal: AbortSignal): Promise<DeviceInstallResult>;
  /** Launch an app (the `open_device` `app` argument). */
  launch(ctx: DeviceActionContext, app: string, signal: AbortSignal): Promise<void>;
}

export interface DeviceActionExecutorDeps {
  agentDevice: AgentDeviceClient;
  logger: Pick<Console, "info" | "warn" | "error">;
}

const NOT_READY = "Driving devices is not available in this build yet.";

export function createDeviceActionExecutor(_deps: DeviceActionExecutorDeps): DeviceActionExecutor {
  return {
    async execute() {
      throw new DeviceError("UNAVAILABLE", NOT_READY);
    },
    async install() {
      throw new DeviceError("UNAVAILABLE", NOT_READY);
    },
    async launch() {
      throw new DeviceError("UNAVAILABLE", NOT_READY);
    }
  };
}
