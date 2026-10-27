/**
 * `device_action`, `device_install` and `open_device`'s `app` on a leased device (devices spec §9).
 *
 * Every action kind maps onto agent-device ({@link planAction}; the table in the README), or onto
 * the host's own `adb` / `simctl` (`DeviceHost.run`) where agent-device lacks it or ends the session
 * (`close_app`, `open_url`, `logs`, Android emulator rotation). A host that drives devices itself
 * answers first (`DeviceHost.performAction`; null falls through).
 *
 * - Input actions run with `--settle`, so the result carries the snapshot diff.
 * - Coordinates: the agent and the action log speak device points (dp on Android); agent-device
 *   speaks pixels on Android (× the lease's `screen.scale`) and points on iOS.
 * - The action log's point for a ref tap is where agent-device says it tapped, else the ref's frame
 *   centre from the lease's last snapshot (kept per lease, cleared when refs expire).
 * - agent-device needs a session: iOS opens the foreground app (or Springboard) before its first
 *   action; a lost session (`SESSION_NOT_FOUND`) is reopened (Android: a bare `open`) and the
 *   action retried once. Another Orquester session still holding the device is stale (the service
 *   leases a device to one chat): it is closed and the call retried.
 * - `screenshot` returns the PNG, or a JPEG scaled to fit `DEVICE_SCREENSHOT_MAX_BASE64_CHARS`.
 * - Builds are streamed to the host (`uploadFile`; an `.app` directory as `<name>.app.tar`, which a
 *   host extracts and answers the `.app` path of), then installed by `DeviceHost.installApp` or
 *   agent-device `install`.
 */

import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import type { Readable } from "node:stream";

import type { DeviceActionInput, DevicePoint, DevicePressKey } from "@orquester/api";
import type { StoredDeviceLease } from "@orquester/config";

import { agentDeviceData, AgentDeviceError, agentDeviceSession, type AgentDeviceClient } from "./agent-device.ts";
import { DeviceError, isDeviceError } from "./errors.ts";
import type { DeviceActionOutcome, DeviceHost, DeviceRect } from "./host.ts";
import { DEVICE_SCREENSHOT_MAX_BASE64_CHARS, fitScreenshot } from "./screenshot-image.ts";

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
  /** The lease ended: end its agent-device session (Android restores its keyboard) and forget its state. Never rejects. */
  end?(ctx: DeviceActionContext): Promise<void>;
}

export interface DeviceActionExecutorDeps {
  agentDevice: AgentDeviceClient;
  logger: Pick<Console, "info" | "warn" | "error">;
}

// ---------------------------------------------------------------------------
// The mapping (pure)
// ---------------------------------------------------------------------------

/** How one action runs. */
export type ActionPlan =
  | { via: "agent-device"; command: string; args: string[]; stdin?: string; timeoutMs?: number }
  /** The host's own tool, one call per entry, in order. */
  | { via: "host"; tool: "adb" | "simctl"; calls: string[][] }
  /** Several steps of its own (`executeSpecial`). */
  | { via: "special"; kind: "snapshot" | "screenshot" | "logs" | "rotate-emulator" };

export interface PlanContext {
  platform: "ios" | "android";
  deviceId: string;
  /** agent-device coordinate units per device point (Android: pixels per dp; iOS: 1). */
  unitsPerPoint: number;
  /** The screen in device points in its current orientation, when known (directional swipes). */
  screen: { width: number; height: number } | null;
}

/** Permissions `settings permission` takes. */
export const DEVICE_PERMISSIONS = [
  "camera",
  "microphone",
  "photos",
  "contacts",
  "contacts-limited",
  "notifications",
  "calendar",
  "location",
  "location-always",
  "media-library",
  "motion",
  "reminders",
  "siri"
] as const;

const PRESS: Readonly<Record<DevicePressKey, string[] | null>> = {
  home: ["home"],
  back: ["back", "--settle"],
  enter: ["keyboard", "enter"],
  app_switch: ["app-switcher"],
  volume_up: ["hardware-button", "volume-up"],
  volume_down: ["hardware-button", "volume-down"],
  lock: null
};

const WAIT_DEFAULT_MS = 10_000;
const OPEN_TIMEOUT_MS = 150_000;

function units(value: number, ctx: PlanContext): string {
  return String(Math.round(value * ctx.unitsPerPoint));
}

/** A swipe `direction` as two points (the finger moves that way), in points. */
export function swipePoints(direction: "up" | "down" | "left" | "right", screen: { width: number; height: number }): { from: DevicePoint; to: DevicePoint } {
  const { width: w, height: h } = screen;
  const vertical = { x: Math.round(w / 2), top: Math.round(h * 0.3), bottom: Math.round(h * 0.7) };
  const horizontal = { y: Math.round(h / 2), left: Math.round(w * 0.2), right: Math.round(w * 0.8) };
  switch (direction) {
    case "up":
      return { from: { x: vertical.x, y: vertical.bottom }, to: { x: vertical.x, y: vertical.top } };
    case "down":
      return { from: { x: vertical.x, y: vertical.top }, to: { x: vertical.x, y: vertical.bottom } };
    case "left":
      return { from: { x: horizontal.right, y: horizontal.y }, to: { x: horizontal.left, y: horizontal.y } };
    case "right":
      return { from: { x: horizontal.left, y: horizontal.y }, to: { x: horizontal.right, y: horizontal.y } };
  }
}

/** Quote one argument for the device's `sh` (adb shell joins its arguments into one command line). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A URL `open_url` accepts: any scheme (deep links too), no whitespace or control characters. */
function checkUrl(url: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(url)) throw new DeviceError("INVALID_ARGUMENT", "`url` must not contain spaces or control characters.");
  try {
    new URL(url);
  } catch {
    throw new DeviceError("INVALID_ARGUMENT", "`url` must be a full URL with a scheme (https://…, myapp://…).");
  }
  return url;
}

/** Map one validated action onto agent-device or the host's tool. Throws `INVALID_ARGUMENT` for what the platform cannot do. */
export function planAction(input: DeviceActionInput, ctx: PlanContext): ActionPlan {
  const target = (): string[] => (input.ref !== undefined ? [input.ref] : [units(input.x!, ctx), units(input.y!, ctx)]);
  switch (input.action) {
    case "snapshot":
    case "screenshot":
    case "logs":
      return { via: "special", kind: input.action };
    case "tap":
      return { via: "agent-device", command: "click", args: [...target(), "--settle"] };
    case "long_press":
      return { via: "agent-device", command: "longpress", args: [...target(), ...(input.durationMs !== undefined ? [String(input.durationMs)] : []), "--settle"] };
    case "fill":
      // The text goes through stdin: it never shows in argv.
      return { via: "agent-device", command: "fill", args: [input.ref!, "--text-stdin", "--settle"], stdin: input.text! };
    case "type":
      return { via: "agent-device", command: "type", args: ["--", input.text!] };
    case "press": {
      const key = input.key!;
      if (key === "lock") {
        if (ctx.platform === "ios") throw new DeviceError("INVALID_ARGUMENT", "iOS simulators cannot be locked from here; press home instead.");
        return { via: "agent-device", command: "hardware-button", args: ["sleep"] };
      }
      const [command, ...args] = PRESS[key]!;
      return { via: "agent-device", command: command!, args };
    }
    case "swipe": {
      let from = input.from;
      let to = input.to;
      if (input.direction !== undefined) {
        if (!ctx.screen) throw new DeviceError("UNAVAILABLE", "The screen size is not known yet: take a snapshot first, or swipe with from/to.");
        ({ from, to } = swipePoints(input.direction, ctx.screen));
      }
      return { via: "agent-device", command: "swipe", args: [units(from!.x, ctx), units(from!.y, ctx), units(to!.x, ctx), units(to!.y, ctx)] };
    }
    case "scroll":
      return { via: "agent-device", command: "scroll", args: [input.direction!, "--settle"] };
    case "open_app":
      return { via: "agent-device", command: "open", args: [input.app!], timeoutMs: OPEN_TIMEOUT_MS };
    case "close_app":
      // agent-device's `close <app>` ends the whole session; stop just the app.
      return ctx.platform === "ios"
        ? { via: "host", tool: "simctl", calls: [["terminate", ctx.deviceId, input.app!]] }
        : { via: "host", tool: "adb", calls: [["-s", ctx.deviceId, "shell", `am force-stop ${shellQuote(input.app!)}`]] };
    case "open_url": {
      // agent-device opens a URL inside the session's app; the system should pick the handler.
      const url = checkUrl(input.url!);
      return ctx.platform === "ios"
        ? { via: "host", tool: "simctl", calls: [["openurl", ctx.deviceId, url]] }
        : { via: "host", tool: "adb", calls: [["-s", ctx.deviceId, "shell", `am start -a android.intent.action.VIEW -d ${shellQuote(url)}`]] };
    }
    case "rotate":
      if (ctx.platform === "android" && ctx.deviceId.startsWith("emulator-")) return { via: "special", kind: "rotate-emulator" };
      return { via: "agent-device", command: "orientation", args: [input.orientation === "landscape" ? "landscape-left" : "portrait"] };
    case "appearance":
      return { via: "agent-device", command: "settings", args: ["appearance", input.appearance!] };
    case "location":
      return { via: "agent-device", command: "settings", args: ["location", "set", String(input.lat), String(input.lon)] };
    case "permissions": {
      const permission = input.permission!.toLowerCase();
      if (!(DEVICE_PERMISSIONS as readonly string[]).includes(permission)) {
        throw new DeviceError("INVALID_ARGUMENT", `Unknown permission ${input.permission}. Use one of: ${DEVICE_PERMISSIONS.join(", ")}.`);
      }
      return { via: "agent-device", command: "settings", args: ["permission", input.grant === "grant" ? "grant" : "deny", permission, "--app", input.app!] };
    }
    case "wait": {
      const timeout = input.timeoutMs ?? WAIT_DEFAULT_MS;
      const args = input.ref !== undefined ? [input.ref, String(timeout)] : ["--", "text", input.text!, String(timeout)];
      return { via: "agent-device", command: "wait", args, timeoutMs: timeout + 20_000 };
    }
  }
}

// ---------------------------------------------------------------------------
// Results (pure)
// ---------------------------------------------------------------------------

interface SnapshotNode {
  ref?: unknown;
  kind?: unknown;
  type?: unknown;
  label?: unknown;
  value?: unknown;
  identifier?: unknown;
  enabled?: unknown;
  selected?: unknown;
  rect?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
}

const TEXT_CAP = 20_000;

function clipText(text: string): string {
  return text.length > TEXT_CAP ? `${text.slice(0, TEXT_CAP)}\n… (cut at ${TEXT_CAP} characters)` : text;
}

function quoted(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? `"${value.replace(/\s+/g, " ").slice(0, 200)}"` : null;
}

/** A `snapshot -i --json` answer as compact text (`@e7 [button] "Search"`), and its refs' frames in points. */
export function renderSnapshot(data: Record<string, unknown>, unitsPerPoint: number): { text: string; refs: Record<string, DeviceRect>; count: number } {
  const nodes = (Array.isArray(data.nodes) ? data.nodes : []) as SnapshotNode[];
  const refs: Record<string, DeviceRect> = {};
  const lines: string[] = [];
  for (const node of nodes) {
    if (typeof node.ref !== "string") continue;
    const kind = typeof node.kind === "string" ? node.kind : typeof node.type === "string" ? node.type.split(".").pop() : "element";
    const label = quoted(node.label) ?? quoted(node.identifier);
    const value = typeof node.value === "string" && node.value !== node.label ? quoted(node.value) : null;
    const flags = [node.enabled === false ? "[disabled]" : null, node.selected === true ? "[selected]" : null].filter(Boolean);
    lines.push([`@${node.ref}`, `[${kind}]`, label, value ? `= ${value}` : null, ...flags].filter(Boolean).join(" "));
    const rect = node.rect;
    if (rect && [rect.x, rect.y, rect.width, rect.height].every((n) => typeof n === "number" && Number.isFinite(n))) {
      refs[node.ref] = {
        x: (rect.x as number) / unitsPerPoint,
        y: (rect.y as number) / unitsPerPoint,
        width: (rect.width as number) / unitsPerPoint,
        height: (rect.height as number) / unitsPerPoint
      };
    }
  }
  const notes: string[] = [];
  if (data.truncated === true) notes.push("The tree was cut: scroll or scope to see the rest.");
  const keyboard = data.keyboard as { kind?: unknown } | undefined;
  if (keyboard && typeof keyboard.kind === "string" && keyboard.kind !== "absent") notes.push("The keyboard is up.");
  const header = `Snapshot: ${lines.length} elements${notes.length > 0 ? ` (${notes.join(" ")})` : ""}`;
  return { text: clipText([header, ...lines].join("\n")), refs, count: lines.length };
}

/** An input action's `settle` as text: the diff, or why there is none. */
export function renderSettle(data: Record<string, unknown>): string | null {
  const settle = data.settle as { settled?: unknown; diff?: { summary?: { additions?: unknown; removals?: unknown }; lines?: unknown }; hint?: unknown } | undefined;
  if (!settle) return null;
  const lines = Array.isArray(settle.diff?.lines) ? (settle.diff!.lines as { kind?: unknown; text?: unknown }[]) : null;
  if (settle.settled !== true || !lines) return "The screen did not settle, so there is no diff: take a snapshot to see it.";
  if (lines.length === 0) return "No change on screen.";
  const out = lines
    .filter((line) => typeof line.text === "string")
    .map((line) => `${line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "} ${line.text as string}`);
  const summary = settle.diff?.summary;
  const head = `Screen changed (+${Number(summary?.additions ?? 0)} −${Number(summary?.removals ?? 0)}); refs below are current:`;
  return clipText([head, ...out].join("\n"));
}

function center(rect: DeviceRect): DevicePoint {
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
}

function pointOf(data: Record<string, unknown>, xKey: string, yKey: string, unitsPerPoint: number): DevicePoint | undefined {
  const x = data[xKey];
  const y = data[yKey];
  return typeof x === "number" && typeof y === "number" ? { x: Math.round(x / unitsPerPoint), y: Math.round(y / unitsPerPoint) } : undefined;
}

/** Where a tap landed (points): agent-device's answer, else the ref's frame centre from the last snapshot. */
export function resolvePoint(input: Pick<DeviceActionInput, "ref" | "x" | "y">, data: Record<string, unknown>, refs: Readonly<Record<string, DeviceRect>>, unitsPerPoint: number): DevicePoint | undefined {
  const reported = pointOf(data, "x", "y", unitsPerPoint);
  if (reported) return reported;
  if (input.ref !== undefined) {
    const rect = refs[input.ref.replace(/^@/, "")];
    return rect ? center(rect) : undefined;
  }
  return input.x !== undefined && input.y !== undefined ? { x: input.x, y: input.y } : undefined;
}

/** The action log's line for an action that succeeded. */
export function defaultSummary(input: DeviceActionInput, data: Record<string, unknown> = {}): string {
  const label = typeof data.refLabel === "string" && data.refLabel !== "" ? ` “${data.refLabel.slice(0, 60)}”` : "";
  const where = input.ref !== undefined ? `${input.ref}${label}` : `(${input.x}, ${input.y})`;
  const chars = (text: string | undefined) => `${[...(text ?? "")].length} character${[...(text ?? "")].length === 1 ? "" : "s"}`;
  switch (input.action) {
    case "snapshot":
      return "Read the screen";
    case "tap":
      return `Tapped ${where}`;
    case "long_press":
      return `Long-pressed ${where}`;
    case "fill":
      return `Filled ${where} with ${chars(input.text)}`;
    case "type":
      return `Typed ${chars(input.text)}`;
    case "press":
      return `Pressed ${input.key?.replace(/_/g, " ")}`;
    case "swipe":
      return input.direction ? `Swiped ${input.direction}` : "Swiped";
    case "scroll":
      return `Scrolled ${input.direction}`;
    case "open_app":
      return `Opened ${input.app}`;
    case "close_app":
      return `Closed ${input.app}`;
    case "open_url": {
      let host = input.url ?? "";
      try {
        host = new URL(host).host || new URL(host).protocol;
      } catch {
        // keep it
      }
      return `Opened ${host.slice(0, 80)}`;
    }
    case "screenshot":
      return "Took a screenshot";
    case "logs":
      return `Read ${input.seconds ?? 10} s of logs`;
    case "rotate":
      return `Rotated to ${input.orientation}`;
    case "appearance":
      return `Switched to ${input.appearance} appearance`;
    case "location":
      return `Set the location to ${input.lat?.toFixed(4)}, ${input.lon?.toFixed(4)}`;
    case "permissions":
      return `${input.grant === "grant" ? "Granted" : "Revoked"} ${input.permission} for ${input.app}`;
    case "wait":
      return input.ref !== undefined ? `Waited for ${input.ref}` : `Waited for “${(input.text ?? "").slice(0, 60)}”`;
  }
}

/** An outcome (agent-device's, or a host's own) as the service's result. */
export function toActionResult(input: DeviceActionInput, outcome: DeviceActionOutcome): DeviceActionResult {
  return {
    log: {
      summary: outcome.summary ?? defaultSummary(input),
      ...(outcome.point ? { point: outcome.point } : {}),
      ...(outcome.from ? { from: outcome.from } : {}),
      ...(outcome.to ? { to: outcome.to } : {}),
      ...(outcome.target ? { target: outcome.target } : {})
    },
    ...(outcome.text !== undefined ? { text: outcome.text } : {}),
    ...(outcome.image ? { image: outcome.image } : {}),
    ...(outcome.details ? { details: outcome.details } : {})
  };
}

// Android emulators rotate for real (what the encoder captures) only by tilting the accelerometer
// (T3 Code, MIT: DeviceActions.ts). A landscape-native tablet sits a quarter turn further on.
const EMULATOR_GRAVITY = { portrait: "0:9.81:0", landscape_left: "9.81:0:0", landscape_right: "-9.81:0:0", portrait_upside_down: "0:-9.81:0" } as const;
const LANDSCAPE_NATIVE = { portrait: "landscape_right", landscape: "portrait" } as const;

function isLandscapeNative(wmSize: string): boolean {
  const sizes = [...wmSize.matchAll(/size: (\d+)x(\d+)/g)];
  const last = sizes.at(-1);
  return last !== undefined && Number(last[1]) > Number(last[2]);
}

// ---------------------------------------------------------------------------
// The executor
// ---------------------------------------------------------------------------

interface LeaseState {
  /** The last snapshot's refs (points); cleared when refs expire. */
  refs: Record<string, DeviceRect>;
  /** iOS: an app session is open. */
  sessionOpen: boolean;
  /** Android pixels per dp from a snapshot, when the lease has no screen. */
  density: number | null;
  /** The screen in points from a snapshot's viewport. */
  viewport: { width: number; height: number } | null;
}

const LOG_LINES = 300;
const LOG_CHARS = 32_000;
const INSTALL_TIMEOUT_MS = 300_000;
const END_TIMEOUT_MS = 15_000;
const BUILD_EXTENSIONS = { android: [".apk"], ios: [".app", ".ipa", ".zip"] } as const;

function lastLines(text: string): string {
  const lines = text.split("\n").filter((line) => line.trim() !== "" && !line.startsWith("--------- beginning of"));
  const tail = lines.slice(-LOG_LINES).join("\n");
  return tail.length > LOG_CHARS ? tail.slice(tail.length - LOG_CHARS) : tail;
}

/** An Orquester session name (`agentDeviceSession`). */
const ORQUESTER_SESSION = /^orq-[0-9a-f]{16}$/;

/** The stale Orquester session a `DEVICE_IN_USE` names, when it is not the lease's own. */
export function staleHolder(error: unknown, lease: StoredDeviceLease): string | null {
  if (!(error instanceof AgentDeviceError) || error.cliCode !== "DEVICE_IN_USE" || lease.deviceId === null) return null;
  const holder = error.details?.session;
  if (typeof holder !== "string" || !ORQUESTER_SESSION.test(holder)) return null;
  return holder === agentDeviceSession(lease.threadId, lease.hostId, lease.deviceId) ? null : holder;
}

/**
 * agent-device's Android guard after input: the session's app (from its last `open <app>`) is not in
 * front any more — the launcher, Settings or System UI is. The input WAS sent (agent-device checks
 * after it runs), so this is not a failure: the agent drives the whole device. A permission dialog
 * over the app is a real stop and stays an error.
 */
export function leftSessionApp(error: unknown): { expected: string; foreground: string } | null {
  if (!(error instanceof AgentDeviceError) || error.cliCode !== "COMMAND_FAILED" || !error.details) return null;
  const { expectedPackage, foregroundPackage, permissionDialog } = error.details;
  if (typeof expectedPackage !== "string" || typeof foregroundPackage !== "string" || permissionDialog === true) return null;
  return { expected: expectedPackage, foreground: foregroundPackage };
}

function appIdOf(data: Record<string, unknown>): string | null {
  for (const key of ["appId", "bundleId", "appBundleId", "package", "packageName"]) {
    const value = data[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

export function createDeviceActionExecutor(deps: DeviceActionExecutorDeps): DeviceActionExecutor {
  const states = new Map<string, LeaseState>();
  const stateOf = (lease: StoredDeviceLease): LeaseState => {
    let state = states.get(lease.id);
    if (!state) {
      state = { refs: {}, sessionOpen: false, density: null, viewport: null };
      states.set(lease.id, state);
    }
    return state;
  };
  const platformOf = (lease: StoredDeviceLease): "ios" | "android" => (lease.platform === "ios" ? "ios" : "android");
  const unitsPerPoint = (lease: StoredDeviceLease, state: LeaseState): number =>
    platformOf(lease) === "ios" ? 1 : (lease.screen?.scale ?? state.density ?? 1);

  const once = (ctx: DeviceActionContext, command: string, args: string[], signal: AbortSignal, options: { timeoutMs?: number; stdin?: string } = {}) =>
    deps.agentDevice
      .run(ctx, command, args, { signal, ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}), ...(options.stdin !== undefined ? { stdin: options.stdin } : {}) })
      .then((result) => agentDeviceData(result, command));

  /**
   * One call; when another Orquester session still holds the device (an earlier lease whose session
   * was never closed: a crash, a restart), it is stale — the service leases a device to one chat
   * only — so it is closed and the call retried once. Anyone else's session is left alone.
   */
  const raw = async (ctx: DeviceActionContext, command: string, args: string[], signal: AbortSignal, options: { timeoutMs?: number; stdin?: string } = {}) => {
    try {
      return await once(ctx, command, args, signal, options);
    } catch (error) {
      const holder = staleHolder(error, ctx.lease);
      if (!holder) throw error;
      deps.logger.info(`[devices] closing a stale agent-device session on ${ctx.lease.hostId}/${ctx.lease.deviceId}`);
      await deps.agentDevice.run(ctx, "close", [], { signal, timeoutMs: END_TIMEOUT_MS, session: holder }).catch(() => undefined);
      return once(ctx, command, args, signal, options);
    }
  };

  /** Open an app session on what the device shows (iOS: its foreground app, else Springboard). */
  const openSession = async (ctx: DeviceActionContext, signal: AbortSignal): Promise<void> => {
    const state = stateOf(ctx.lease);
    if (platformOf(ctx.lease) === "ios") {
      try {
        await raw(ctx, "open", ["--foreground"], signal, { timeoutMs: OPEN_TIMEOUT_MS });
      } catch (error) {
        if (signal.aborted) throw error;
        await raw(ctx, "open", ["com.apple.springboard"], signal, { timeoutMs: OPEN_TIMEOUT_MS });
      }
    } else {
      // A bare `open` starts a session on whatever is in front (opening the launcher's package fails).
      await raw(ctx, "open", [], signal, { timeoutMs: OPEN_TIMEOUT_MS });
    }
    state.sessionOpen = true;
    state.refs = {};
  };

  /** Run with an app session: iOS opens one first; a lost one is reopened and the call retried once. */
  const call = async (ctx: DeviceActionContext, command: string, args: string[], signal: AbortSignal, options: { timeoutMs?: number; stdin?: string } = {}) => {
    const state = stateOf(ctx.lease);
    if (platformOf(ctx.lease) === "ios" && !state.sessionOpen && command !== "open") await openSession(ctx, signal);
    try {
      return await raw(ctx, command, args, signal, options);
    } catch (error) {
      if (!(error instanceof AgentDeviceError) || error.cliCode !== "SESSION_NOT_FOUND" || command === "open") throw error;
      state.sessionOpen = false;
      await openSession(ctx, signal);
      return raw(ctx, command, args, signal, options);
    }
  };

  const hostRun = async (ctx: DeviceActionContext, tool: "adb" | "simctl", args: string[], signal: AbortSignal, what: string): Promise<string> => {
    const result = await ctx.host.run(tool, args, { signal, timeoutMs: 30_000 }).catch((error: unknown) => {
      if (isDeviceError(error)) throw error;
      throw new DeviceError("UNAVAILABLE", `${what} failed: the device host did not run ${tool}.`);
    });
    // `adb shell` exits 0 on a failed `am start`: its error lines tell.
    const failed = result.exitCode !== 0 || /^(Error|Exception)\b/m.test(result.stdout);
    if (failed) {
      const line = `${result.stderr}\n${result.stdout}`.trim().split("\n").filter(Boolean).find((entry) => /error|exception|invalid|unknown/i.test(entry)) ?? `exit code ${result.exitCode}`;
      throw new DeviceError("UNAVAILABLE", `${what} failed: ${line.trim().slice(0, 300)}`);
    }
    return result.stdout;
  };

  const snapshot = async (ctx: DeviceActionContext, signal: AbortSignal) => {
    const state = stateOf(ctx.lease);
    const data = await call(ctx, "snapshot", ["-i"], signal, { timeoutMs: 45_000 });
    const android = data.androidSnapshot as { pixelDensity?: unknown } | undefined;
    if (typeof android?.pixelDensity === "number" && android.pixelDensity > 0) state.density = android.pixelDensity;
    const upp = unitsPerPoint(ctx.lease, state);
    const viewport = data.viewport as { width?: unknown; height?: unknown } | undefined;
    if (typeof viewport?.width === "number" && typeof viewport.height === "number") state.viewport = { width: viewport.width / upp, height: viewport.height / upp };
    const rendered = renderSnapshot(data, upp);
    state.refs = rendered.refs;
    return rendered;
  };

  const special = async (ctx: DeviceActionContext, input: DeviceActionInput, kind: "snapshot" | "screenshot" | "logs" | "rotate-emulator", signal: AbortSignal): Promise<DeviceActionOutcome> => {
    const { lease } = ctx;
    const deviceId = lease.deviceId!;
    switch (kind) {
      case "snapshot": {
        const rendered = await snapshot(ctx, signal);
        return { text: rendered.text, summary: `Read the screen (${rendered.count} elements)`, refs: rendered.refs };
      }
      case "screenshot": {
        const dir = await mkdtemp(join(tmpdir(), "orq-device-shot-"));
        try {
          const path = join(dir, "screen.png");
          const data = await call(ctx, "screenshot", [path], signal, { timeoutMs: 45_000 });
          const png = await readFile(typeof data.path === "string" && data.path.startsWith(dir) ? data.path : path);
          const fitted = fitScreenshot(png, DEVICE_SCREENSHOT_MAX_BASE64_CHARS);
          return { image: fitted, text: `Screenshot ${fitted.width}×${fitted.height}${fitted.mimeType === "image/jpeg" ? " (JPEG, scaled to fit)" : ""}.` };
        } catch (error) {
          if (isDeviceError(error)) throw error;
          throw new DeviceError("UNAVAILABLE", "The screenshot could not be read. Try again.");
        } finally {
          await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        }
      }
      case "logs": {
        const seconds = Math.min(60, Math.max(1, input.seconds ?? 10));
        let text: string;
        if (platformOf(lease) === "ios") {
          text = await hostRun(ctx, "simctl", ["spawn", deviceId, "log", "show", "--last", `${seconds}s`, "--style", "compact"], signal, "Reading logs");
        } else {
          const now = Number((await hostRun(ctx, "adb", ["-s", deviceId, "shell", "date", "+%s"], signal, "Reading logs")).trim());
          if (!Number.isFinite(now)) throw new DeviceError("UNAVAILABLE", "Reading logs failed: the device clock could not be read.");
          text = await hostRun(ctx, "adb", ["-s", deviceId, "logcat", "-d", "-v", "time", "-t", `${now - seconds}.000`], signal, "Reading logs");
        }
        const tail = lastLines(text);
        return { text: tail === "" ? `No log lines in the last ${seconds} s.` : tail };
      }
      case "rotate-emulator": {
        const wm = await hostRun(ctx, "adb", ["-s", deviceId, "shell", "wm", "size"], signal, "Rotating");
        const wanted = input.orientation === "landscape" ? "landscape_left" : "portrait";
        const rotation = isLandscapeNative(wm) ? LANDSCAPE_NATIVE[input.orientation === "landscape" ? "landscape" : "portrait"] : wanted;
        await hostRun(ctx, "adb", ["-s", deviceId, "shell", "settings", "put", "system", "accelerometer_rotation", "1"], signal, "Rotating");
        await hostRun(ctx, "adb", ["-s", deviceId, "shell", "cmd", "window", "user-rotation", "free"], signal, "Rotating");
        await hostRun(ctx, "adb", ["-s", deviceId, "emu", "sensor", "set", "acceleration", EMULATOR_GRAVITY[rotation]], signal, "Rotating");
        stateOf(lease).refs = {};
        return { text: `Rotated to ${input.orientation}. Refs from earlier snapshots are stale: snapshot again.` };
      }
    }
  };

  const execute = async (ctx: DeviceActionContext, input: DeviceActionInput, signal: AbortSignal): Promise<DeviceActionOutcome> => {
    const { lease } = ctx;
    if (lease.deviceId === null) throw new DeviceError("UNAVAILABLE", "The device is still starting. Call list_devices to see when it is ready.");
    const state = stateOf(lease);
    let upp = unitsPerPoint(lease, state);
    const screenPoints = () => (lease.screen ? { width: lease.screen.width, height: lease.screen.height } : state.viewport);
    if (input.action === "swipe" && input.direction !== undefined && !screenPoints()) {
      await snapshot(ctx, signal);
      upp = unitsPerPoint(lease, state);
    }
    const plan = planAction(input, { platform: platformOf(lease), deviceId: lease.deviceId, unitsPerPoint: upp, screen: screenPoints() });
    if (plan.via === "special") return special(ctx, input, plan.kind, signal);
    if (plan.via === "host") {
      for (const args of plan.calls) await hostRun(ctx, plan.tool, args, signal, defaultSummary(input));
      if (input.action === "close_app") state.refs = {};
      return {};
    }
    let data: Record<string, unknown>;
    try {
      data = await call(ctx, plan.command, plan.args, signal, { ...(plan.timeoutMs !== undefined ? { timeoutMs: plan.timeoutMs } : {}), ...(plan.stdin !== undefined ? { stdin: plan.stdin } : {}) });
    } catch (error) {
      const left = leftSessionApp(error);
      if (!left) throw error;
      const outcome: DeviceActionOutcome = { summary: defaultSummary(input) };
      const point = input.action === "tap" || input.action === "long_press" ? resolvePoint(input, {}, state.refs, upp) : undefined;
      if (point) outcome.point = point;
      // The session still names the app it opened, so every later input would trip the same guard:
      // end it, and the next action reopens one on whatever is in front.
      await raw(ctx, "close", [], signal, { timeoutMs: END_TIMEOUT_MS }).catch(() => undefined);
      state.sessionOpen = false;
      state.refs = {};
      outcome.text = `Done. ${left.foreground} is in front now (not ${left.expected}). Refs expired: take a snapshot.`;
      return outcome;
    }
    const outcome: DeviceActionOutcome = { summary: defaultSummary(input, data) };
    switch (input.action) {
      case "tap":
      case "long_press":
      case "fill": {
        const point = resolvePoint(input, data, state.refs, upp);
        if (point) outcome.point = point;
        if (input.ref !== undefined) outcome.target = typeof data.refLabel === "string" && data.refLabel !== "" ? `${input.ref} ${data.refLabel.slice(0, 60)}` : input.ref;
        break;
      }
      case "swipe": {
        const from = input.from ?? pointOf(data, "x1", "y1", upp);
        const to = input.to ?? pointOf(data, "x2", "y2", upp);
        if (from) outcome.from = from;
        if (to) outcome.to = to;
        break;
      }
      case "scroll": {
        const from = pointOf(data, "x1", "y1", upp);
        const to = pointOf(data, "x2", "y2", upp);
        if (from) outcome.from = from;
        if (to) outcome.to = to;
        break;
      }
      case "open_app":
        state.sessionOpen = true;
        outcome.text = `Opened ${input.app}. Refs from earlier snapshots expired: take a snapshot.`;
        break;
      case "wait":
        outcome.text = "Found it.";
        break;
      default:
        break;
    }
    const settled = renderSettle(data);
    if (settled !== null) {
      outcome.text = settled;
      // The settle re-issued refs: earlier frames no longer match them.
      state.refs = {};
    } else if (outcome.text === undefined && typeof data.message === "string") {
      outcome.text = data.message.slice(0, 500);
    }
    if (typeof data.warning === "string") outcome.text = `${outcome.text ?? ""}\nNote: ${data.warning.slice(0, 300)}`.trim();
    if (Array.isArray(data.warnings)) {
      const warnings = data.warnings.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.slice(0, 300));
      if (warnings.length > 0) outcome.text = `${outcome.text ?? ""}\nNote: ${warnings.join(" ")}`.trim();
    }
    return outcome;
  };

  /** A build as one stream: a file as-is, an `.app` directory as a tar archive. */
  const buildStream = async (localPath: string): Promise<{ stream: Readable; name: string }> => {
    const info = await stat(localPath);
    if (!info.isDirectory()) return { stream: createReadStream(localPath), name: basename(localPath) };
    const child = spawn("tar", ["-cf", "-", "-C", dirname(localPath), basename(localPath)], { stdio: ["ignore", "pipe", "ignore"], shell: false });
    child.once("error", (error) => child.stdout.destroy(error));
    return { stream: child.stdout, name: `${basename(localPath)}.tar` };
  };

  return {
    async execute(ctx, input, signal) {
      const state = stateOf(ctx.lease);
      if (ctx.host.performAction) {
        const own = await ctx.host.performAction(ctx.lease, input, signal);
        if (own) {
          if (own.refs) state.refs = { ...own.refs };
          return toActionResult(input, own);
        }
      }
      const outcome = await execute(ctx, input, signal);
      if (outcome.refs) state.refs = outcome.refs;
      return toActionResult(input, outcome);
    },

    async install(ctx, localPath, signal) {
      const { lease, host } = ctx;
      const platform = platformOf(lease);
      const ext = extname(localPath).toLowerCase();
      if (!(BUILD_EXTENSIONS[platform] as readonly string[]).includes(ext)) {
        throw new DeviceError(
          "INVALID_ARGUMENT",
          platform === "android" ? "Android installs an .apk build." : "iOS simulators install a simulator .app (or an .ipa / zipped .app): device builds will not run."
        );
      }
      const { stream, name } = await buildStream(localPath);
      let uploaded: string;
      try {
        uploaded = (await host.uploadFile(stream, name, signal)).path;
      } catch (error) {
        stream.destroy();
        if (isDeviceError(error)) throw error;
        throw new DeviceError("UNAVAILABLE", `Sending ${basename(localPath)} to the device host failed. Try again.`);
      }
      if (host.installApp) return host.installApp(lease, uploaded, signal);
      const data = await call(ctx, "install", [uploaded], signal, { timeoutMs: INSTALL_TIMEOUT_MS });
      const appId = appIdOf(data);
      return { appId, summary: appId ? `Installed ${appId}. Open it with device_action {action:"open_app",app:"${appId}"}.` : `Installed ${basename(localPath)}.` };
    },

    async launch(ctx, app, signal) {
      await call(ctx, "open", [app], signal, { timeoutMs: OPEN_TIMEOUT_MS });
      const state = stateOf(ctx.lease);
      state.sessionOpen = true;
      state.refs = {};
    },

    async end(ctx) {
      const known = states.has(ctx.lease.id);
      states.delete(ctx.lease.id);
      if (!known || ctx.lease.deviceId === null) return;
      try {
        await deps.agentDevice.run(ctx, "close", [], { signal: AbortSignal.timeout(END_TIMEOUT_MS), timeoutMs: END_TIMEOUT_MS });
      } catch (error) {
        deps.logger.warn(`[devices] ending the agent-device session of ${ctx.lease.id} failed`, error instanceof Error ? error.message : String(error));
      }
    }
  };
}
