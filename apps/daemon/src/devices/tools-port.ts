/**
 * What the `devices` MCP tools reach through `DaemonApi` (devices spec §9): the device service's
 * agent-facing operations, always for ONE chat — the calling agent's, taken from its principal by
 * `InjectDaemonApi` (never from arguments). Types and one adapter: the tool module
 * (`mcp/tools/devices.ts`) imports this file's types alone.
 */

import type {
  DeviceActionEntry,
  DeviceActionInput,
  DeviceHostSummary,
  DeviceLeaseSummary,
  DevicePlatform,
  DeviceProfile
} from "@orquester/api";
import type { CallerPrincipal } from "@orquester/api/agent-chat";

import { isDeviceError } from "./errors.ts";
import type { DeviceRentalQuote } from "./host.ts";

/** An answer or a refusal written for the agent (the same shape as `DaemonOutcome`). */
export type DeviceOutcome<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

/** One device operation's options: who acts (`withPrincipal` forces the caller's) and its abort. */
export interface DeviceCallOptions {
  principal?: CallerPrincipal;
  signal?: AbortSignal;
}

/** `list_devices`. */
export interface DeviceToolList {
  hosts: DeviceHostSummary[];
  /** The profiles of the enabled platforms. */
  profiles: DeviceProfile[];
  platforms: { platform: DevicePlatform; enabled: boolean; ready: boolean; detail: string | null }[];
  /** This chat's leases (lost ones included until they expire). */
  mine: DeviceLeaseSummary[];
  /** Other chats' devices: busy. */
  busy: { key: string | null; platform: DevicePlatform; name: string; chat: string | null }[];
}

/** What `open_device` would need before it runs (its spend card): a rental, or nothing. */
export interface DeviceOpenPlan {
  rental: DeviceRentalQuote | null;
}

export interface DeviceToolOpenInput {
  platform: DevicePlatform;
  profile?: string;
  app?: string;
  fresh?: boolean;
  /** The owner approved the rental this open may need (its spend card). */
  rentalApproved?: boolean;
}

export interface DeviceToolOpenResult {
  lease: DeviceLeaseSummary;
  /** False when the wait ran out while the device was still starting (`lease.state === "starting"`). */
  ready: boolean;
  /** What it is doing now, when not ready. */
  progress?: string;
  /** A note (the `app` could not be launched, …). */
  note?: string;
}

export interface DeviceToolActionResult {
  lease: DeviceLeaseSummary;
  entry: DeviceActionEntry;
  text?: string;
  /** A screenshot, base64, already capped for an MCP image block. */
  image?: { mimeType: "image/png" | "image/jpeg"; base64: string; width: number; height: number };
  /** The kept screenshot's id (`deviceRef.screenshotId`). */
  screenshotId?: string;
  details?: Record<string, unknown>;
}

export interface DeviceToolInstallInput {
  device?: string;
  /** An absolute host path (the tool resolved a relative one against the chat's cwd). */
  path: string;
}

export interface DeviceToolInstallResult {
  lease: DeviceLeaseSummary;
  appId: string | null;
  summary: string;
}

export interface DeviceToolCloseInput {
  device?: string;
  shutdown?: boolean;
}

/** The device service's agent operations (implemented by `DeviceService`). They throw `DeviceError`s. */
export interface DeviceToolsPort {
  toolList(threadId: string): DeviceToolList;
  toolPlanOpen(threadId: string, platform: DevicePlatform): DeviceOpenPlan;
  toolOpen(threadId: string, input: DeviceToolOpenInput, signal: AbortSignal): Promise<DeviceToolOpenResult>;
  toolAction(threadId: string, device: string | undefined, input: DeviceActionInput, signal: AbortSignal): Promise<DeviceToolActionResult>;
  toolInstall(threadId: string, input: DeviceToolInstallInput, signal: AbortSignal): Promise<DeviceToolInstallResult>;
  toolClose(threadId: string, input: DeviceToolCloseInput): Promise<{ lease: DeviceLeaseSummary }>;
}

const UNWIRED: DeviceOutcome<never> = { ok: false, code: "DEVICES_DISABLED", message: "Device simulators are off. Ask the owner to turn the plugin on in Settings → Plugins." };

/**
 * Run one tool operation for the calling agent's chat: refuses callers that are not an agent chat,
 * and turns a thrown `DeviceError` into an outcome. Anything else is logged and answered `INTERNAL`
 * (its text may name host paths).
 */
export async function runDeviceTool<T>(
  port: DeviceToolsPort | null,
  opts: DeviceCallOptions | undefined,
  run: (port: DeviceToolsPort, threadId: string, signal: AbortSignal) => T | Promise<T>
): Promise<DeviceOutcome<T>> {
  if (!port) return UNWIRED;
  const principal = opts?.principal;
  if (principal?.kind !== "agent") return { ok: false, code: "PERMISSION_DENIED", message: "The device tools are for agent chats only." };
  try {
    return { ok: true, value: await run(port, principal.threadId, opts?.signal ?? new AbortController().signal) };
  } catch (error) {
    if (isDeviceError(error)) return { ok: false, code: error.code, message: error.message };
    console.error("[devices] a device tool failed", error);
    return { ok: false, code: "INTERNAL", message: "The device operation failed." };
  }
}
