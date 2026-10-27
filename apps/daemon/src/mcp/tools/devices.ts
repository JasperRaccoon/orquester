/**
 * Catalog family `devices` (devices spec §9): iOS simulators and Android emulators an agent chat
 * leases and drives — `list_devices`, `open_device`, `device_action`, `device_install`,
 * `close_device`. Chat-only (like the box tools); the daemon advertises them only while the
 * "Device simulators" plugin is on, agents may use devices and a platform is enabled.
 *
 * - **Leases.** A chat holds up to 3 devices, each exclusively; the daemon resolves the `device`
 *   handle (its key `<hostId>/<deviceId>`, or the lease id) among the calling chat's own leases only.
 * - **Control.** The user watches in the Device panel and may take over: input actions then fail
 *   `DEVICE_CONTROLLED_BY_USER`; read-only ones (snapshot, screenshot, logs, wait) still run.
 * - **Spend.** `open_device` raises a `devices` spend card only when it must rent a Mac host the
 *   owner did not pre-approve (its `scope` asks the daemon for the plan; the card pins what it rents).
 * - **Results** carry a `deviceRef` (`{device, leaseId?, screenshotId?, name?, action?, summary?}`)
 *   kept through slimming, so the chat row shows the device, its words ("Tapped “Search”") and a
 *   screenshot thumbnail after a reload, without the image in the transcript.
 *
 * Everything goes through `DaemonApi` (D-1): this module imports types and pure contracts only.
 */

import { isAbsolute, resolve } from "node:path";

import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  DEVICE_ACTION_KINDS,
  DEVICE_DIRECTIONS,
  DEVICE_LOGS_MAX_SECONDS,
  DEVICE_PRESS_KEYS,
  DEVICE_PROFILES,
  DEVICE_TEXT_MAX_CHARS,
  DEVICE_WAIT_MAX_MS,
  isReadOnlyDeviceAction,
  type ApprovalPreviewSection,
  type DeviceActionInput,
  type DeviceActionKind,
  type DeviceLeaseSummary,
  type DeviceToolReference
} from "@orquester/api";

import type { DeviceToolList } from "../../devices/tools-port.ts";
import { defineTool, DESTRUCTIVE, type AnyOrquesterTool, type ApprovalPreview, type ScopeClaim, type ScopeContext, type ThreadCaller, type ToolCaller } from "../catalog/contract.ts";
import type { DaemonApi, DaemonOutcome } from "../daemon-api.ts";
import { ToolError } from "../errors.ts";
import { ok } from "../result.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DISABLED = "Device simulators are not available right now. Ask the owner to turn the plugin on in Settings → Plugins.";

function threadCaller(caller: ToolCaller, tool: string): ThreadCaller {
  if (caller.kind !== "thread") throw new ToolError("TOOL_NOT_FOUND", `${tool} is a chat tool.`);
  return caller;
}

function unwrap<T>(outcome: DaemonOutcome<T>): T {
  if (!outcome.ok) throw new ToolError(outcome.code, outcome.message);
  return outcome.value;
}

/** The method, or a refusal when this transport has no device backend. */
function method<K extends keyof DaemonApi>(api: DaemonApi, key: K): NonNullable<DaemonApi[K]> {
  const fn = api[key];
  if (typeof fn !== "function") throw new ToolError("DEVICES_DISABLED", DISABLED);
  return (fn as (...args: unknown[]) => unknown).bind(api) as NonNullable<DaemonApi[K]>;
}

/** A call on the caller's own devices: no project, the caller itself. */
function ownScope(ctx: ScopeContext, reads: ScopeClaim["reads"], writes: boolean): ScopeClaim {
  return { projects: [], sessions: ctx.caller.kind === "thread" ? [ctx.caller.threadId] : [], self: "allow", reads, writes, causesTurnIn: [] };
}

/** How a lease reads in results. */
function leaseView(lease: DeviceLeaseSummary): Record<string, unknown> {
  return {
    device: lease.key ?? lease.id,
    lease_id: lease.id,
    platform: lease.platform,
    name: lease.name,
    os: lease.osVersion,
    state: lease.state,
    controller: lease.controller,
    ...(lease.screen ? { screen: { width: lease.screen.width, height: lease.screen.height } } : {}),
    ...(lease.progress ? { starting: lease.progress.label } : {}),
    ...(lease.error ? { error: lease.error } : {})
  };
}

/** `readDeviceToolReference`'s caps on the row's words (longer ones would be dropped, not cut). */
const REF_NAME_MAX = 120;
const REF_SUMMARY_MAX = 200;

/** One line of at most `max` characters: control characters and line breaks become spaces. */
function refText(text: string, max: number): string | undefined {
  // eslint-disable-next-line no-control-regex
  const line = text.replace(/[\u0000-\u001f\u007f\u2028\u2029\s]+/g, " ").trim();
  if (line === "") return undefined;
  const chars = [...line];
  return chars.length <= max ? line : `${chars.slice(0, max - 1).join("")}…`;
}

/**
 * The result's `deviceRef` (kept through slimming): the device, its lease, a kept screenshot, and
 * the words a reloaded chat row reads ("Opened Pixel 9", "Tapped “Search”") — the device's name,
 * and for `device_action` the action and its action-log summary.
 */
export function deviceRef(lease: DeviceLeaseSummary, extra: { screenshotId?: string; action?: DeviceActionKind; summary?: string } = {}): DeviceToolReference {
  const name = refText(lease.name, REF_NAME_MAX);
  const summary = extra.summary !== undefined ? refText(extra.summary, REF_SUMMARY_MAX) : undefined;
  return {
    device: lease.key ?? lease.id,
    leaseId: lease.id,
    ...(extra.screenshotId ? { screenshotId: extra.screenshotId } : {}),
    ...(name ? { name } : {}),
    ...(extra.action ? { action: extra.action } : {}),
    ...(summary ? { summary } : {})
  };
}

/**
 * Sent back with every opened device (≤ 6 lines): the rest of the guidance the instruction line
 * leaves out, per platform (devices spikes: iOS needs an app session before a snapshot, and its
 * first call warms agent-device's runner; `open` re-issues refs).
 */
export function deviceQuickStart(platform: "ios" | "android"): string {
  return [
    platform === "ios"
      ? 'Open the app first ({action:"open_app",app:"<bundle id>"}; Settings is com.apple.Preferences), then {action:"snapshot"}: the screen as @eN refs. The first iOS call may take ~30 s.'
      : '{action:"snapshot"} first: the screen as an accessibility tree with @eN refs.',
    'Prefer refs to x/y points: {action:"tap",ref:"@e3"}, {action:"fill",ref:"@e5",text:"…"}. Input returns the diff with current refs; after open_app, open_url or rotate, snapshot again (refs expire).',
    '{action:"screenshot"} returns an image; {action:"logs",seconds:10} recent logs; {action:"wait",text:"…"} for slow screens.',
    platform === "ios"
      ? "device_install {path} takes a simulator .app (or .ipa) in this project and answers its bundle id; press home for the home screen."
      : "device_install {path} takes an .apk in this project and answers its package; press back/home to navigate.",
    "The user watches the Device panel and may take control: input then fails DEVICE_CONTROLLED_BY_USER (reads still work); wait, or ask them to give it back.",
    "close_device when done."
  ].join("\n");
}

// ---------------------------------------------------------------------------
// list_devices
// ---------------------------------------------------------------------------

function listView(list: DeviceToolList): Record<string, unknown> {
  return {
    platforms: list.platforms.map((entry) => ({ platform: entry.platform, enabled: entry.enabled, ready: entry.ready, ...(entry.detail ? { detail: entry.detail } : {}) })),
    hosts: list.hosts.map((host) => ({
      id: host.id,
      kind: host.kind,
      label: host.label,
      platforms: host.platforms,
      status: host.status,
      capacity: `${host.capacity.used}/${host.capacity.total}`,
      ...(host.readiness.ready ? {} : { missing: host.readiness.checks.filter((check) => check.state !== "ok").map((check) => check.label) })
    })),
    profiles: list.profiles.map((profile) => ({ id: profile.id, platform: profile.platform, name: profile.label, form: profile.formFactor, os: profile.os })),
    my_devices: list.mine.map(leaseView),
    busy: list.busy.map((entry) => ({ device: entry.key, platform: entry.platform, name: entry.name, ...(entry.chat ? { chat: entry.chat } : {}) }))
  };
}

const listDevices = defineTool({
  name: "list_devices",
  title: "List devices",
  description:
    "The device platforms (iOS, Android) and whether each is ready, the hosts that run devices (status, capacity, what is missing), the device profiles you can open, this chat's devices (`device` handles for the other device tools) and devices other chats hold (busy).",
  chatNote: "Call it before open_device, and to check on a device that was still starting.",
  input: {},
  audiences: ["chat"],
  toolset: "devices",
  tier: "read",
  scope: async (_args, ctx) => ownScope(ctx, "metadata", false),
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  resultKind: "json",
  async run(_args, { api, caller }) {
    threadCaller(caller, "list_devices");
    return listView(unwrap(await method(api, "devicesList")()));
  }
});

// ---------------------------------------------------------------------------
// open_device
// ---------------------------------------------------------------------------

const PROFILE_IDS = DEVICE_PROFILES.map((profile) => profile.id) as [string, ...string[]];
const APP_ID = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,254}$/, "a bundle id or package name");

function money(usd: number): string {
  return `$${usd < 1 ? usd.toFixed(3) : usd.toFixed(2)}`;
}

const openDevice = defineTool({
  name: "open_device",
  title: "Open a device",
  description:
    "Lease an iOS simulator or Android emulator for this chat and wait until it has booted (Android: seconds; iOS may first rent a Mac host: minutes, and if the owner has not pre-approved renting, their approval on a card). Returns the device handle, name, OS, screen size and a quick start. If it is still starting after 9 minutes it answers state starting: check with list_devices. A chat holds up to 3 devices; each is yours alone until close_device or the chat closes.",
  chatNote: "The device appears in the user's Device panel at once.",
  input: {
    platform: z.enum(["ios", "android"]),
    profile: z.enum(PROFILE_IDS).optional().describe("A profile id from list_devices; default: the platform's first (iPhone 17 Pro, Pixel 9)."),
    app: APP_ID.optional().describe("Launch this installed app once booted."),
    fresh: z.boolean().optional().describe("A clean device, never a reused one.")
  },
  audiences: ["chat"],
  toolset: "devices",
  tier: "act",
  // Only a call that must rent a host the owner did not pre-approve spends (looked up by `scope`).
  spendFamily: (_args, scope) => scope.resolved?.spendFamily,
  async scope(args, ctx) {
    const claim = ownScope(ctx, "none", true);
    if (ctx.caller.kind !== "thread" || !ctx.api.devicesPlanOpen) return claim;
    const plan = await ctx.api.devicesPlanOpen(args.platform, { signal: ctx.signal });
    if (!plan.ok || !plan.value.rental?.needsApproval) return claim;
    return { ...claim, resolved: { tier: "act", spendFamily: "devices" } };
  },
  async approval(args, ctx): Promise<ApprovalPreview> {
    threadCaller(ctx.caller, "open_device");
    const plan = unwrap(await method(ctx.api, "devicesPlanOpen")(args.platform, { signal: ctx.signal }));
    const rental = plan.rental;
    if (!rental) throw new ToolError("PREVIEW_STALE", "No host needs renting any more: call open_device again.");
    const worst = rental.hourlyUsd !== null ? (rental.hourlyUsd * rental.lifetimeMinutes) / 60 : null;
    const sections: ApprovalPreviewSection[] = [
      {
        kind: "fields",
        title: "The host",
        rows: [
          { label: "Host", value: `${rental.providerLabel} — ${rental.sizeLabel}` },
          { label: "For", value: `${args.platform === "ios" ? "iPhone & iPad" : "Android"} devices, shared by every chat` },
          { label: "Estimated price", value: rental.hourlyUsd !== null ? `${money(rental.hourlyUsd)}/h` : "unknown" },
          { label: "Time limit", value: `${Math.round(rental.lifetimeMinutes / 60)} h` },
          { label: "Worst case", value: worst !== null ? money(worst) : "unknown" }
        ]
      },
      {
        kind: "warning",
        level: "caution",
        text: `${rental.providerLabel} bills your account until the host is destroyed: when no device has used it for a while, at its time limit, or from Settings → Devices.`
      }
    ];
    return {
      title: `Rent a ${args.platform === "ios" ? "Mac" : "device"} host for a device`,
      scopeLabel: `Billed to your ${rental.providerLabel} account`,
      sections,
      pins: { provider: rental.provider, size: rental.size },
      ungrantable: true
    };
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  resultKind: "json",
  async run(args, ctx) {
    threadCaller(ctx.caller, "open_device");
    const opened = unwrap(
      await method(ctx.api, "deviceOpen")(
        {
          platform: args.platform,
          ...(args.profile !== undefined ? { profile: args.profile } : {}),
          ...(args.app !== undefined ? { app: args.app } : {}),
          ...(args.fresh !== undefined ? { fresh: args.fresh } : {}),
          // The card pinned the rental the owner approved.
          rentalApproved: ctx.approval?.pins?.provider !== undefined
        },
        { signal: ctx.signal }
      )
    );
    return {
      ...leaseView(opened.lease),
      ready: opened.ready,
      ...(opened.progress ? { progress: opened.progress, note: "Still starting: check it with list_devices." } : {}),
      ...(opened.note ? { note: opened.note } : {}),
      ...(opened.ready ? { quick_start: deviceQuickStart(opened.lease.platform) } : {}),
      deviceRef: deviceRef(opened.lease)
    };
  }
});

// ---------------------------------------------------------------------------
// device_action
// ---------------------------------------------------------------------------

const deviceHandle = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .optional()
  .describe("A device from open_device or list_devices; default: this chat's only device.");
const point = z.object({ x: z.number().min(0).max(10_000), y: z.number().min(0).max(10_000) }).strict();

const deviceActionInput = {
  device: deviceHandle,
  action: z.enum(DEVICE_ACTION_KINDS as unknown as [DeviceActionKind, ...DeviceActionKind[]]),
  ref: z.string().trim().regex(/^@?e\d{1,6}$/, "an @eN ref").optional().describe("An @eN ref from the last snapshot."),
  x: z.number().min(0).max(10_000).optional().describe("Points, when no ref fits."),
  y: z.number().min(0).max(10_000).optional(),
  text: z.string().max(DEVICE_TEXT_MAX_CHARS).optional(),
  key: z.enum(DEVICE_PRESS_KEYS).optional(),
  direction: z.enum(DEVICE_DIRECTIONS as unknown as ["up", "down", "left", "right"]).optional(),
  from: point.optional(),
  to: point.optional(),
  app: APP_ID.optional().describe("Bundle id or package."),
  url: z.string().trim().min(1).max(2_000).optional(),
  seconds: z.number().int().min(1).max(DEVICE_LOGS_MAX_SECONDS).optional(),
  duration_ms: z.number().int().min(100).max(10_000).optional(),
  orientation: z.enum(["portrait", "landscape"]).optional(),
  appearance: z.enum(["light", "dark"]).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  permission: z.string().trim().min(1).max(64).optional().describe("camera, photos, location, notifications, …"),
  grant: z.enum(["grant", "revoke"]).optional(),
  timeout_ms: z.number().int().min(100).max(DEVICE_WAIT_MAX_MS).optional()
};

type DeviceActionArgs = z.infer<z.ZodObject<typeof deviceActionInput>>;

/** The tool's arguments as the daemon's action input. */
function actionInput(args: DeviceActionArgs): DeviceActionInput {
  const input: DeviceActionInput = { action: args.action };
  if (args.ref !== undefined) input.ref = args.ref.startsWith("@") ? args.ref : `@${args.ref}`;
  if (args.x !== undefined) input.x = args.x;
  if (args.y !== undefined) input.y = args.y;
  if (args.text !== undefined) input.text = args.text;
  if (args.key !== undefined) input.key = args.key;
  if (args.direction !== undefined) input.direction = args.direction;
  if (args.from !== undefined) input.from = args.from;
  if (args.to !== undefined) input.to = args.to;
  if (args.app !== undefined) input.app = args.app;
  if (args.url !== undefined) input.url = args.url;
  if (args.seconds !== undefined) input.seconds = args.seconds;
  if (args.duration_ms !== undefined) input.durationMs = args.duration_ms;
  if (args.orientation !== undefined) input.orientation = args.orientation;
  if (args.appearance !== undefined) input.appearance = args.appearance;
  if (args.lat !== undefined) input.lat = args.lat;
  if (args.lon !== undefined) input.lon = args.lon;
  if (args.permission !== undefined) input.permission = args.permission;
  if (args.grant !== undefined) input.grant = args.grant;
  if (args.timeout_ms !== undefined) input.timeoutMs = args.timeout_ms;
  return input;
}

const deviceAction = defineTool({
  name: "device_action",
  title: "Use a device",
  description:
    "Drive one of this chat's devices. snapshot: the screen as an accessibility tree with @eN refs (prefer refs to coordinates). tap/long_press (ref or x,y), fill (ref, text), type (text), press (key), swipe (direction or from/to), scroll (direction), open_app/close_app (app), open_url (url), screenshot (an image), logs (seconds), rotate (orientation), appearance, location (lat, lon), permissions (app, permission, grant), wait (text or ref, timeout_ms). Input returns the new snapshot's diff. While the user controls the device input fails DEVICE_CONTROLLED_BY_USER (wait or ask); reads still work.",
  chatNote: "Every action shows in the user's Device panel.",
  input: deviceActionInput,
  audiences: ["chat"],
  toolset: "devices",
  // Snapshots, screenshots, logs and waits change nothing.
  tier: (args) => (isReadOnlyDeviceAction(args.action) ? "read" : "act"),
  planSafe: false,
  scope: async (args, ctx) => (isReadOnlyDeviceAction(args.action) ? ownScope(ctx, "content", false) : ownScope(ctx, "content", true)),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  resultKind: "image",
  async run(args, ctx): Promise<Record<string, unknown> | CallToolResult> {
    threadCaller(ctx.caller, "device_action");
    const result = unwrap(await method(ctx.api, "deviceAction")(args.device, actionInput(args), { signal: ctx.signal }));
    const value: Record<string, unknown> = {
      device: result.lease.key ?? result.lease.id,
      action: args.action,
      summary: result.entry.summary,
      ...(result.text !== undefined ? { result: result.text } : {}),
      ...(result.details ?? {}),
      ...(result.image ? { screenshot: { width: result.image.width, height: result.image.height, mime_type: result.image.mimeType } } : {}),
      ...(result.lease.controller === "user" ? { note: "The user has control now: input waits until they give it back." } : {}),
      deviceRef: deviceRef(result.lease, { ...(result.screenshotId ? { screenshotId: result.screenshotId } : {}), action: args.action, summary: result.entry.summary })
    };
    if (!result.image) return value;
    const json = ok(value);
    return { content: [{ type: "image", data: result.image.base64, mimeType: result.image.mimeType }, ...json.content], structuredContent: json.structuredContent };
  }
});

// ---------------------------------------------------------------------------
// device_install / close_device
// ---------------------------------------------------------------------------

/** A host path the agent gave: relative ones are taken from its cwd (else its project root). */
function hostPath(caller: ThreadCaller, path: string): string {
  if (caller.projectPath === "") throw new ToolError("NO_PROJECT", "This chat has no project, so there is no build to install.");
  return isAbsolute(path) ? path : resolve(caller.cwd || caller.projectPath, path);
}

const deviceInstall = defineTool({
  name: "device_install",
  title: "Install a build",
  description:
    "Install an app build from this chat's project on one of its devices: an .apk (Android), or a simulator .app directory or .ipa (iOS). The build is streamed to the device's host. Returns the bundle id or package to open with device_action open_app.",
  chatNote: "Build for the simulator/emulator first (an iOS device build will not install).",
  input: {
    device: deviceHandle,
    path: z.string().min(1).max(4096).describe("The build inside this chat's project (relative: from your cwd).")
  },
  audiences: ["chat"],
  toolset: "devices",
  tier: "act",
  scope: async (args, ctx) => {
    const claim = ownScope(ctx, "content", true);
    return ctx.caller.kind === "thread" ? { ...claim, paths: [hostPath(ctx.caller, args.path)] } : claim;
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  resultKind: "json",
  async run(args, { api, caller, signal }) {
    const thread = threadCaller(caller, "device_install");
    const installed = unwrap(
      await method(api, "deviceInstall")({ ...(args.device !== undefined ? { device: args.device } : {}), path: hostPath(thread, args.path) }, { signal })
    );
    return { device: installed.lease.key ?? installed.lease.id, app: installed.appId, summary: installed.summary, deviceRef: deviceRef(installed.lease) };
  }
});

const closeDevice = defineTool({
  name: "close_device",
  title: "Close a device",
  description: "Release one of this chat's devices so other chats can use it (it also goes when this chat closes or sits idle for an hour). shutdown: true also turns it off.",
  input: {
    device: deviceHandle,
    shutdown: z.boolean().optional().describe("Also turn the device off. Default false.")
  },
  audiences: ["chat"],
  toolset: "devices",
  tier: "act",
  // Releasing frees a host (and its spend) and is never refused while planning.
  planSafe: true,
  scope: async (_args, ctx) => ownScope(ctx, "none", true),
  annotations: { ...DESTRUCTIVE, openWorldHint: false },
  resultKind: "json",
  async run(args, { api, caller }) {
    threadCaller(caller, "close_device");
    const { lease } = unwrap(
      await method(api, "deviceClose")({ ...(args.device !== undefined ? { device: args.device } : {}), ...(args.shutdown !== undefined ? { shutdown: args.shutdown } : {}) })
    );
    return { closed: true, device: lease.key ?? lease.id, deviceRef: deviceRef(lease) };
  }
});

/** This family in the catalog (`../catalog/index.ts`). */
export const devicesFamily: readonly AnyOrquesterTool[] = [listDevices, openDevice, deviceAction, deviceInstall, closeDevice];
