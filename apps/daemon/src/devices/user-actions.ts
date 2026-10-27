/**
 * The Device panel's buttons that are not hub input (`deviceRoutes.userAction`): rotate (Android
 * emulators through the accelerometer, so the captured video turns too; iOS through agent-device's
 * `orientation`), restart the foreground app, switch the appearance, and power off.
 *
 * They are the user's: never refused because the agent holds control (the service hands control to
 * the user before running one), recorded in the action log with `actor: "user"`, failures included.
 * `power_off` turns the device off and ends the lease, like the panel's "Power off and release".
 */

import type { DeviceActionEntry, DeviceActionInput, DeviceActionKind, DeviceLeaseSummary, DeviceUserActionRequest, DeviceUserActionResponse } from "@orquester/api";
import type { StoredDeviceLease } from "@orquester/config";

import type { DeviceActionExecutor } from "./actions.ts";
import type { DeviceActionDraft } from "./action-log.ts";
import { DeviceError, isDeviceError } from "./errors.ts";
import type { DeviceHost } from "./host.ts";
import { describeLease } from "./leases.ts";

/** What a user action needs from the service. */
export interface UserActionContext {
  /** The lease, already under the user's control. */
  lease: StoredDeviceLease;
  /** Its host, or null when it is gone. */
  host: DeviceHost | null;
  actions: DeviceActionExecutor;
  /** Append a row (the service adds `actor: "user"`). */
  record(draft: Omit<DeviceActionDraft, "actor">): DeviceActionEntry;
  /** Turn the device off and end the lease; the released summary. */
  powerOff(): Promise<DeviceLeaseSummary | null>;
  /** The lease as the wire shows it now. */
  summary(): DeviceLeaseSummary | null;
  logger: Pick<Console, "error">;
}

/** The action-log kind a user action is filed under (the log speaks `DeviceActionKind`s). */
const LOG_KIND: Readonly<Record<DeviceUserActionRequest["kind"], DeviceActionKind>> = {
  rotate: "rotate",
  appearance: "appearance",
  restart_app: "open_app",
  power_off: "press"
};

/** What the failure row says ("Restart app failed"). */
const FAILED: Readonly<Record<DeviceUserActionRequest["kind"], string>> = {
  rotate: "Rotate failed",
  appearance: "Appearance change failed",
  restart_app: "Restart app failed",
  power_off: "Power off failed"
};

function actionInput(request: Extract<DeviceUserActionRequest, { kind: "rotate" | "appearance" }>): DeviceActionInput {
  return request.kind === "rotate" ? { action: "rotate", orientation: request.orientation } : { action: "appearance", appearance: request.appearance };
}

/** Run one user action on a lease the user now controls. Rejects with a `DeviceError` for the owner. */
export async function runUserAction(ctx: UserActionContext, request: DeviceUserActionRequest, signal: AbortSignal): Promise<DeviceUserActionResponse> {
  const { lease } = ctx;
  const kind = LOG_KIND[request.kind];
  if (request.kind === "power_off") {
    // The row goes out (`devices.action`) before the lease ends and its log with it.
    const entry = ctx.record({ kind, summary: "Powered off and released the device", ok: true });
    const released = await ctx.powerOff();
    if (!released) throw new DeviceError("DEVICE_NOT_LEASED", "There is no such lease.");
    return { lease: released, entry };
  }
  if (lease.state === "lost" || !ctx.host) throw new DeviceError("DEVICE_LOST", `${describeLease(lease)} is gone.`);
  if (lease.state !== "ready" || lease.deviceId === null) throw new DeviceError("UNAVAILABLE", `${describeLease(lease)} is not ready.`);
  const target = { host: ctx.host, lease };
  let summary: string;
  try {
    if (request.kind === "restart_app") {
      if (!ctx.actions.restartApp) throw new DeviceError("UNAVAILABLE", "This device cannot restart apps.");
      const { appId } = await ctx.actions.restartApp(target, signal);
      summary = `Restarted ${appId}`;
    } else {
      const result = await ctx.actions.execute(target, actionInput(request), signal);
      summary = result.log.summary;
    }
  } catch (error) {
    const message = isDeviceError(error) ? error.message : `${FAILED[request.kind]}.`;
    ctx.record({ kind, summary: FAILED[request.kind], ok: false, error: message });
    if (isDeviceError(error)) throw error;
    ctx.logger.error(`[devices] ${request.kind} on ${describeLease(lease)} failed`, error instanceof Error ? error.message : String(error));
    throw new DeviceError("UNAVAILABLE", message);
  }
  const entry = ctx.record({ kind, summary, ok: true });
  const current = ctx.summary();
  if (!current) throw new DeviceError("DEVICE_NOT_LEASED", "The device was released meanwhile.");
  return { lease: current, entry };
}
