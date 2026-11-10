// Catalog family module `desktops` (get_desktops, control_desktop, desktop_action) — unified MCP design
// 2026-10-15 §4 rows 40–41, §4.1 (ruling S4), plan Task 12; desktop_action: desktop agents spec
// 2026-11-10 §2.5. Both audiences, toolset `desktops`.
//
// A desktop is a virtual X display on the daemon's host that GUI apps run in, shown to the user as
// a tab (docs/superpowers/specs/2026-09-30-desktop-tab-design.md §7.4). Every call is an in-process
// client of the daemon's desktop routes (`desktopRoutes`) through DaemonApi only, so a desktop an
// agent opens appears in every client as the GUI's own would (`desktop.created`).
//
// Chat tiers: `open` and `launch_app` start processes on the host — Admin (`desktops`), with a card
// naming the command, the working directory and every env value in full (`./desktop-preview.ts`);
// `stop_app`, `close_window` and `close` only stop things — Act. A desktop's project is its target
// (§5.2); a chat caller's `cwd` must lie inside a project (ruling S6). `desktop_action` (screen,
// pointer, keys, clipboard) raises no card: Read for screenshot / wait / clipboard_get, Act otherwise.

import { basename, resolve } from "node:path";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { DESKTOP_MAX_HEIGHT, DESKTOP_MAX_WIDTH, DESKTOP_MIN_HEIGHT, DESKTOP_MIN_WIDTH } from "@orquester/config";
import {
  DESKTOP_ACTION_KINDS,
  DESKTOP_CLIPBOARD_MAX_BYTES,
  DESKTOP_CONTROLLED_BY_USER_CODE,
  DESKTOP_ENV_KEY_PATTERN,
  DESKTOP_IDLE_MAX_MS,
  DESKTOP_IDLE_MIN_MS,
  DESKTOP_MAX_COMMAND_LENGTH,
  DESKTOP_NOT_RUNNING_CODE,
  DESKTOP_RESIZED_CODE,
  DESKTOP_SCREENSHOT_MAX_MAX,
  DESKTOP_SCREENSHOT_MIN_MAX,
  DESKTOP_TYPE_MAX_CHARS,
  DESKTOP_UNAVAILABLE_CODE,
  DESKTOP_WAIT_MAX_TIMEOUT_MS,
  TOOL_APPROVAL_REASON_MAX_CHARS,
  desktopRoutes,
  isReadOnlyDesktopAction,
  type CreateDesktopRequest,
  type DesktopActionKind,
  type DesktopActionRequest,
  type DesktopActionResponse,
  type DesktopActor,
  type DesktopAppSummary,
  type DesktopHostStatus,
  type DesktopSummary,
  type DesktopToolReference,
  type LaunchAppRequest
} from "@orquester/api";
import { callerHostPath, projectNamesFor, resolveProject } from "../addressing.ts";
import type { DaemonApi, DaemonResponse } from "../daemon-api.ts";
import { daemonError, ToolError } from "../errors.ts";
import { clipText, jsonBytes, MAX_ECHO_CHARS } from "../result.ts";
import { defineTool, READ_ONLY, type AnyOrquesterTool, type ScopeClaim, type ScopeContext, type ToolCaller } from "../catalog/contract.ts";
import { imageResult } from "../../session-tools/results.ts";
import { agentLabel, desktopPreview } from "./desktop-preview.ts";

/** What an app's log returns at most: its tail, well under ok()'s 60 000-byte cap once JSON-escaped. */
const LOG_RESULT_BYTES = 50_000;
/** The most of the daemon's install hint an error quotes. */
const MAX_HINT_CHARS = 500;

const NOT_FOUND_HINT = " get_desktops shows the desktops with their apps and windows.";

const ERROR_HINTS: Record<string, string> = {
  NOT_FOUND: NOT_FOUND_HINT,
  DESKTOP_NOT_FOUND: NOT_FOUND_HINT,
  DESKTOP_APP_NOT_FOUND: NOT_FOUND_HINT,
  DESKTOP_WINDOW_NOT_FOUND: " get_desktops {desktopId} shows the desktop's current windows.",
  [DESKTOP_UNAVAILABLE_CODE]: " get_desktops {host: true} shows what is missing.",
  [DESKTOP_CONTROLLED_BY_USER_CODE]: " Reads still work; wait, or ask the user to give control back.",
  [DESKTOP_RESIZED_CODE]: " Take a new screenshot and use its screenshot_id.",
  DESKTOP_SCREENSHOT_NOT_FOUND: " Take a new screenshot and use its screenshot_id.",
  [DESKTOP_NOT_RUNNING_CODE]: " get_desktops {desktopId} shows its status."
};

/**
 * A failed desktop route as a ToolError: the daemon's code passes through (daemonError), a hint appended. A 409
 * DESKTOP_UNAVAILABLE carries the host's `hint` — the `apt-get install` line for what is missing — which goes into
 * the text, since the route may send it without a message.
 */
function desktopError(res: DaemonResponse): ToolError {
  const error = daemonError(res);
  const body = res.body !== null && typeof res.body === "object" ? (res.body as Record<string, unknown>) : null;
  let message = error.message === DESKTOP_UNAVAILABLE_CODE ? "Desktops are unavailable on this host" : error.message;
  if (!/[.!?]$/.test(message)) message += ".";
  const hint = body && typeof body.hint === "string" && body.hint.trim() !== "" ? clipText(body.hint.trim(), MAX_HINT_CHARS) : null;
  if (hint && !message.includes(hint)) message += ` ${/[.!?]$/.test(hint) ? hint : `${hint}.`}`;
  message += ERROR_HINTS[error.code] ?? "";
  return new ToolError(error.code, message, error.detail);
}

function expectDesktopOk<T>(res: DaemonResponse): T {
  if (res.status >= 400) throw desktopError(res);
  return res.body as T;
}

/** Box errors of a project whose VM cannot be asked right now (boxes/remote/fs/errors.ts). */
const VM_AWAY_CODES = new Set(["BOX_NOT_READY", "BOX_DESTROYED", "DESKTOP_BOX_UNREACHABLE"]);

/**
 * The desktop prerequisites where `projectPath`'s desktops run (the host's without one).
 * boxes: a VM project whose VM is offline answers a status saying so, not an error, so
 * the rest of the result (the desktops) still comes back.
 */
async function hostStatusOf(api: DaemonApi, projectPath: string | null): Promise<DesktopHostStatus> {
  const res = await api.request("GET", desktopRoutes.host, projectPath ? { query: { projectPath } } : undefined);
  const code = (res.body as { code?: unknown } | null)?.code;
  if (res.status >= 400 && typeof code === "string" && VM_AWAY_CODES.has(code)) {
    const message = (res.body as { message?: unknown }).message;
    return {
      available: false,
      audioAvailable: false,
      tools: [],
      ffmpegPulse: false,
      ffmpegOpus: false,
      renderNode: false,
      tmuxUsable: false,
      warnings: [typeof message === "string" && message ? message : "The project's VM is not connected right now."],
      installHint: null
    };
  }
  return expectDesktopOk<DesktopHostStatus>(res);
}

/** The last characters of `text` whose JSON size fits `budget` bytes, never splitting a character. */
function tailJsonBytes(text: string, budget: number): { text: string; truncated: boolean } {
  if (jsonBytes(text) <= budget) return { text, truncated: false };
  const chars = Array.from(text);
  // The smallest start whose tail fits: every character costs at least one byte, so at most `budget` are kept.
  let lo = Math.max(0, chars.length - budget);
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (jsonBytes(chars.slice(mid).join("")) <= budget) hi = mid;
    else lo = mid + 1;
  }
  return { text: chars.slice(lo).join(""), truncated: true };
}

// ---------------------------------------------------------------------------
// Addressing
// ---------------------------------------------------------------------------

/** Every desktop, every project (the list route without `projectPath`). */
async function allDesktops(api: DaemonApi): Promise<DesktopSummary[]> {
  return expectDesktopOk<DesktopSummary[]>(await api.request("GET", desktopRoutes.list));
}

/** One desktop by id (there is no per-desktop GET: the full list is filtered). */
async function findDesktop(api: DaemonApi, desktopId: string): Promise<DesktopSummary> {
  const desktop = (await allDesktops(api)).find((candidate) => candidate.id === desktopId);
  if (!desktop) throw new ToolError("NOT_FOUND", `No desktop "${clipText(desktopId, MAX_ECHO_CHARS)}".${NOT_FOUND_HINT}`);
  return desktop;
}

/** `project` resolved to the path desktops are keyed by; a chat caller naming none means its own (null: none). */
async function projectOf(project: string | undefined, ctx: ScopeContext): Promise<string | null> {
  let ref = project;
  if (ref === undefined && ctx.caller.kind === "thread" && ctx.caller.projectPath && ctx.caller.workspace) {
    ref = `${ctx.caller.workspace}/${basename(ctx.caller.projectPath)}`;
  }
  return ref === undefined ? null : (await resolveProject(ctx.api, ref, ctx.caller)).path;
}

/** `ws/p` of a project path, for cards (the path itself when it names no project). */
function labelOf(api: DaemonApi, projectPath: string): string {
  const names = projectNamesFor(projectPath, api.workspacesDir);
  return names.workspace && names.name ? `${names.workspace}/${names.name}` : projectPath;
}

/** A launch's working directory as the daemon runs it: absolute, or relative to the desktop's project (as the caller spells it, `callerHostPath`). */
const cwdIn = (caller: ToolCaller, projectPath: string, cwd: string): string => resolve(callerHostPath(caller, cwd, projectPath));

// ---------------------------------------------------------------------------
// get_desktops
// ---------------------------------------------------------------------------

const desktopIdArg = z.string().min(1).describe("A desktop's id (get_desktops).");

const getDesktops = defineTool({
  name: "get_desktops",
  title: "Get desktops",
  description:
    "Desktop tabs: virtual X displays on the daemon's host (in a Linux VM project: inside its VM; such a desktop has box: {id, connected}) running GUI apps, shown to the user live. No desktopId: a project's desktops (id, title, status, size, audio, apps, open windows with their bounds, control: who drives its input). desktopId: that one. desktopId + appId: the app's last 64 KiB of stdout/stderr (truncated: true when cut). host: true adds whether the desktops' machine (the project's VM for a VM project) can run desktops (tools found, GPU, warnings, installHint: the apt-get line for what's missing — installing is for the host's owner; tell the user).",
  externalNote: "Without project: every project's desktops.",
  input: {
    project: z.string().min(1).optional().describe("\"<workspace>/<project>\" or a path."),
    desktopId: desktopIdArg.optional(),
    appId: z.string().min(1).optional().describe("With desktopId: that app's output."),
    host: z.boolean().optional().describe("Add the host's desktop support status.")
  },
  audiences: ["external", "chat"],
  toolset: "desktops",
  tier: "read",
  async scope(args, ctx) {
    if (args.appId !== undefined && args.desktopId === undefined) throw new ToolError("INVALID_ARGUMENT", "appId needs desktopId.");
    if (args.desktopId !== undefined && args.project !== undefined) throw new ToolError("INVALID_ARGUMENT", "Pass desktopId or project, not both.");
    const claim: ScopeClaim = { projects: [], sessions: [], reads: "metadata", writes: false, causesTurnIn: [] };
    if (args.desktopId !== undefined) {
      const desktop = await findDesktop(ctx.api, args.desktopId);
      // An app's output is content (§5.2), like a tool's output.
      return { ...claim, projects: [desktop.projectPath], reads: args.appId !== undefined ? "content" : "metadata" };
    }
    const projectPath = await projectOf(args.project, ctx);
    if (projectPath === null && ctx.caller.kind === "thread" && args.host !== true) {
      throw new ToolError("INVALID_ARGUMENT", "This chat has no project: pass project.");
    }
    return { ...claim, projects: projectPath ? [projectPath] : [] };
  },
  annotations: READ_ONLY,
  resultKind: "json",
  async run(args, ctx) {
    const { api } = ctx;
    // boxes: with a project (or a desktop), the status is that project's machine's (its VM for a box project).
    const hostProject =
      args.host !== true
        ? null
        : args.desktopId !== undefined
          ? (await findDesktop(api, args.desktopId)).projectPath
          : await projectOf(args.project, ctx);
    const host = args.host === true ? { host: await hostStatusOf(api, hostProject) } : {};
    if (args.desktopId !== undefined && args.appId !== undefined) {
      const body = expectDesktopOk<unknown>(await api.request("GET", desktopRoutes.appLog(args.desktopId, args.appId)));
      // text/plain; the in-process client parses a body that happens to be JSON, so give such a log back as text.
      const raw = typeof body === "string" ? body : body === null ? "" : JSON.stringify(body);
      const log = tailJsonBytes(raw, LOG_RESULT_BYTES);
      return { desktopId: args.desktopId, appId: args.appId, text: log.text, ...(log.truncated ? { truncated: true } : {}), ...host };
    }
    if (args.desktopId !== undefined) return { desktop: await findDesktop(api, args.desktopId), ...host };
    const projectPath = await projectOf(args.project, ctx);
    if (projectPath === null && ctx.caller.kind === "thread") return host;
    const desktops = expectDesktopOk<DesktopSummary[]>(await api.request("GET", desktopRoutes.list, projectPath ? { query: { projectPath } } : undefined));
    return { desktops, ...host };
  }
});

// ---------------------------------------------------------------------------
// control_desktop
// ---------------------------------------------------------------------------

const ACTIONS = ["open", "launch_app", "stop_app", "close_window", "close"] as const;
type Action = (typeof ACTIONS)[number];

const controlInput = {
  action: z.enum(ACTIONS),
  project: z.string().min(1).optional().describe("open: \"<workspace>/<project>\" or a path."),
  desktopId: desktopIdArg.optional(),
  appId: z.string().min(1).optional().describe("stop_app: the app's id."),
  windowId: z.string().min(1).optional().describe("close_window: the window's id (0x… hex)."),
  command: z
    .string()
    .min(1)
    .max(DESKTOP_MAX_COMMAND_LENGTH)
    .refine((command) => !/[\r\n]/.test(command), "must be a single line")
    .optional()
    .describe("One shell command line, run as `sh -c 'exec <command>'` with DISPLAY and audio wired to the desktop, e.g. \"xterm\"."),
  cwd: z.string().min(1).optional().describe("Absolute, or relative to the project (default)."),
  env: z
    .record(z.string().regex(DESKTOP_ENV_KEY_PATTERN, "is not an environment variable name"), z.string())
    .optional()
    .describe("Extra env vars for the app, applied last."),
  title: z.string().min(1).max(200).optional().describe("open: the tab's title (default \"Desktop\")."),
  size: z
    .object({
      width: z.number().int().min(DESKTOP_MIN_WIDTH).max(DESKTOP_MAX_WIDTH),
      height: z.number().int().min(DESKTOP_MIN_HEIGHT).max(DESKTOP_MAX_HEIGHT)
    })
    .strict()
    .optional()
    .describe("open: pixels (default 1280×800)."),
  renderThreads: z.number().int().min(1).max(256).optional().describe("open: software-OpenGL threads per app (LP_NUM_THREADS, default 4)."),
  force: z.boolean().optional().describe("stop_app: SIGKILL at once."),
  reason: z.string().max(TOOL_APPROVAL_REASON_MAX_CHARS).optional().describe("Why, shown on the approval card.")
};
type ControlArgs = z.infer<z.ZodObject<typeof controlInput>>;

/** The fields each action takes (required, then allowed; `reason` always) — anything else given is refused. */
const ACTION_FIELDS: Readonly<Record<Action, { required: readonly (keyof ControlArgs)[]; allowed: readonly (keyof ControlArgs)[] }>> = {
  open: { required: [], allowed: ["project", "title", "size", "renderThreads", "command", "cwd", "env"] },
  launch_app: { required: ["desktopId", "command"], allowed: ["cwd", "env"] },
  stop_app: { required: ["desktopId", "appId"], allowed: ["force"] },
  close_window: { required: ["desktopId", "windowId"], allowed: [] },
  close: { required: ["desktopId"], allowed: [] }
};
const FIELD_KEYS = ["project", "desktopId", "appId", "windowId", "command", "cwd", "env", "title", "size", "renderThreads", "force"] as const;

function checkAction(args: ControlArgs, external: boolean): void {
  const fields = ACTION_FIELDS[args.action];
  for (const key of fields.required) {
    if (args[key] === undefined) throw new ToolError("INVALID_ARGUMENT", `control_desktop ${args.action} needs ${key}.`);
  }
  for (const key of FIELD_KEYS) {
    if (args[key] !== undefined && !fields.required.includes(key) && !fields.allowed.includes(key)) {
      throw new ToolError("INVALID_ARGUMENT", `control_desktop ${args.action} takes no ${key}.`);
    }
  }
  if (args.action === "open") {
    if (external && args.project === undefined) throw new ToolError("INVALID_ARGUMENT", "control_desktop open needs project.");
    if (args.command === undefined && (args.cwd !== undefined || args.env !== undefined)) {
      throw new ToolError("INVALID_ARGUMENT", "cwd and env apply to the first app: pass command too, or launch it later with launch_app.");
    }
  }
}

function launchRequest(args: { command: string; cwd?: string; env?: Record<string, string> }): LaunchAppRequest {
  const app: LaunchAppRequest = { command: args.command };
  if (args.cwd !== undefined) app.cwd = args.cwd;
  if (args.env !== undefined) app.env = { ...args.env };
  return app;
}

/** The call's target: the project it opens in, or the desktop it acts on (and that desktop's project). */
async function targetOf(args: ControlArgs, ctx: ScopeContext): Promise<{ projectPath: string; desktop?: DesktopSummary }> {
  if (args.action === "open") {
    const projectPath = await projectOf(args.project, ctx);
    if (projectPath === null) throw new ToolError("INVALID_ARGUMENT", "This chat has no project: pass project.");
    return { projectPath };
  }
  const desktop = await findDesktop(ctx.api, args.desktopId!);
  return { projectPath: desktop.projectPath, desktop };
}

const controlDesktop = defineTool({
  name: "control_desktop",
  title: "Control desktops",
  description:
    "Open and drive desktop tabs (see get_desktops). open: a new desktop (virtual display, window manager, audio; the user sees it live), optionally launching a first app (command). launch_app: another GUI app in a running desktop. stop_app: SIGTERM its process group, SIGKILL after 5 s (force: at once); unsaved work is lost. close_window: ask a window to close (the app may prompt to save). close: stop every app, remove the tab. Missing host packages: open answers DESKTOP_UNAVAILABLE with the install line, for the host's owner.",
  chatNote:
    "open and launch_app run host commands: they need the user's approval.",
  input: controlInput,
  audiences: ["external", "chat"],
  toolset: "desktops",
  tier: (args) => (args.action === "open" || args.action === "launch_app" ? "admin" : "act"),
  adminFamily: "desktops",
  async scope(args, ctx) {
    checkAction(args, ctx.caller.kind === "external");
    const { projectPath } = await targetOf(args, ctx);
    return {
      projects: [projectPath],
      sessions: [],
      reads: "none",
      writes: true,
      causesTurnIn: [],
      // Ruling S6: a chat caller's working directory must lie inside a project.
      ...(args.cwd !== undefined ? { paths: [cwdIn(ctx.caller, projectPath, args.cwd)] } : {})
    };
  },
  async approval(args, ctx) {
    const { projectPath, desktop } = await targetOf(args, ctx);
    return desktopPreview({
      action: args.action,
      agentId: ctx.caller.kind === "thread" ? ctx.caller.agentId : undefined,
      projectLabel: labelOf(ctx.api, projectPath),
      ...(desktop ? { desktop } : {}),
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.size !== undefined ? { size: args.size } : {}),
      ...(args.renderThreads !== undefined ? { renderThreads: args.renderThreads } : {}),
      ...(args.command !== undefined ? { command: args.command } : {}),
      ...(args.cwd !== undefined ? { cwd: cwdIn(ctx.caller, projectPath, args.cwd) } : {}),
      ...(args.env !== undefined ? { env: args.env } : {}),
      ...(args.appId !== undefined ? { appId: args.appId } : {}),
      ...(args.windowId !== undefined ? { windowId: args.windowId } : {}),
      ...(args.force !== undefined ? { force: args.force } : {})
    });
  },
  // Launching an app runs anything, so no closed world; stop and close destroy unsaved work.
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  resultKind: "json",
  async run(args, ctx) {
    checkAction(args, ctx.caller.kind === "external");
    const { api } = ctx;
    // A Windows box chat's cwd (`C:\orq\…`, `sub\dir`) goes as the host path its scope claimed; any other caller's as given.
    const cwd = args.cwd !== undefined && ctx.caller.kind === "thread" && ctx.caller.boxPaths ? cwdIn(ctx.caller, (await targetOf(args, ctx)).projectPath, args.cwd) : args.cwd;
    switch (args.action) {
      case "open": {
        const { projectPath } = await targetOf(args, ctx);
        const body: CreateDesktopRequest = { projectPath };
        if (args.title !== undefined) body.title = args.title;
        if (args.size !== undefined) body.size = { ...args.size };
        if (args.renderThreads !== undefined) body.renderThreads = args.renderThreads;
        if (args.command !== undefined) body.app = launchRequest({ command: args.command, cwd, env: args.env });
        return { desktop: expectDesktopOk<DesktopSummary>(await api.request("POST", desktopRoutes.create, { body })) };
      }
      case "launch_app": {
        const app = expectDesktopOk<DesktopAppSummary>(
          await api.request("POST", desktopRoutes.apps(args.desktopId!), { body: launchRequest({ command: args.command!, cwd, env: args.env }) })
        );
        return { app };
      }
      case "stop_app": {
        const force = args.force === true;
        expectDesktopOk(await api.request("DELETE", desktopRoutes.app(args.desktopId!, args.appId!), force ? { query: { force: "1" } } : undefined));
        return { stopped: true, desktopId: args.desktopId!, appId: args.appId!, force };
      }
      case "close_window":
        expectDesktopOk(await api.request("POST", desktopRoutes.windowAction(args.desktopId!, args.windowId!, "close")));
        return { done: true, desktopId: args.desktopId!, windowId: args.windowId!, action: "close" };
      case "close":
        expectDesktopOk(await api.request("DELETE", desktopRoutes.desktop(args.desktopId!)));
        return { closed: true, desktopId: args.desktopId! };
    }
  }
});

// ---------------------------------------------------------------------------
// desktop_action
// ---------------------------------------------------------------------------

// Factories: one instance in two fields is listed as a "$ref" (see `catalog/registry.test.ts`). The
// daemon checks every point and region against the display.
const coordinate = () => z.number().min(0);
const pixel = () => z.number().int().min(0);

const desktopActionInput = {
  desktopId: desktopIdArg,
  action: z.enum(DESKTOP_ACTION_KINDS as unknown as [DesktopActionKind, ...DesktopActionKind[]]),
  x: coordinate().optional().describe("Pixels of screenshot_id's image, else of the display. Default: the pointer."),
  y: coordinate().optional(),
  screenshot_id: z.string().min(1).max(64).optional(),
  button: z.enum(["left", "middle", "right"]).optional(),
  count: z.number().int().min(1).max(3).optional().describe("click: 2 double, 3 triple."),
  modifiers: z.array(z.enum(["ctrl", "shift", "alt", "super"])).max(4).optional(),
  to_x: coordinate().optional(),
  to_y: coordinate().optional(),
  direction: z.enum(["up", "down", "left", "right"]).optional(),
  amount: z.number().int().min(1).max(50).optional().describe("scroll: wheel clicks (3)."),
  keys: z.string().min(1).max(200).optional().describe("\"ctrl+shift+t\", \"Return\", \"alt+F4\"."),
  repeat: z.number().int().min(1).max(20).optional(),
  text: z.string().optional().describe("type (\\n is Return) or clipboard_set."),
  region: z.object({ x: pixel(), y: pixel(), width: pixel().min(1), height: pixel().min(1) }).strict().optional().describe("Display pixels."),
  window_id: z.string().min(1).max(20).optional(),
  max_size: z.number().int().min(DESKTOP_SCREENSHOT_MIN_MAX).max(DESKTOP_SCREENSHOT_MAX_MAX).optional().describe("Long edge bound (1920)."),
  for: z.enum(["idle", "change"]).optional().describe("wait: still for idle_ms (default), or changed after since (a seq)."),
  idle_ms: z.number().int().min(DESKTOP_IDLE_MIN_MS).max(DESKTOP_IDLE_MAX_MS).optional(),
  since: z.number().int().min(0).optional(),
  timeout_ms: z.number().int().min(1).max(DESKTOP_WAIT_MAX_TIMEOUT_MS).optional(),
  screenshot: z.boolean().optional().describe("Input: then a screenshot once the screen settles.")
};
type DesktopActionArgs = z.infer<z.ZodObject<typeof desktopActionInput>>;
type ActionField = Exclude<keyof DesktopActionArgs, "desktopId" | "action">;

const SETTLED_SHOT: readonly ActionField[] = ["screenshot", "max_size"];
const POINT: readonly ActionField[] = ["x", "y", "screenshot_id"];

/** The fields each action takes (required, then allowed), as the daemon checks them — anything else given is refused. */
const DESKTOP_ACTION_FIELDS: Readonly<Record<DesktopActionKind, { required: readonly ActionField[]; allowed: readonly ActionField[] }>> = {
  screenshot: { required: [], allowed: ["region", "window_id", "max_size"] },
  wait: { required: [], allowed: ["for", "idle_ms", "since", "region", "timeout_ms"] },
  move: { required: ["x", "y"], allowed: ["screenshot_id", ...SETTLED_SHOT] },
  click: { required: [], allowed: [...POINT, "button", "count", "modifiers", ...SETTLED_SHOT] },
  mouse_down: { required: [], allowed: [...POINT, "button", ...SETTLED_SHOT] },
  mouse_up: { required: [], allowed: [...POINT, "button", ...SETTLED_SHOT] },
  drag: { required: ["x", "y", "to_x", "to_y"], allowed: ["screenshot_id", "button", "modifiers", ...SETTLED_SHOT] },
  scroll: { required: ["direction"], allowed: [...POINT, "amount", "modifiers", ...SETTLED_SHOT] },
  key: { required: ["keys"], allowed: ["repeat", ...SETTLED_SHOT] },
  type: { required: ["text"], allowed: [...SETTLED_SHOT] },
  clipboard_get: { required: [], allowed: [] },
  clipboard_set: { required: ["text"], allowed: [] }
};
const ACTION_FIELD_KEYS = Object.keys(desktopActionInput).filter((key) => key !== "desktopId" && key !== "action") as ActionField[];

function checkDesktopAction(args: DesktopActionArgs): void {
  const fields = DESKTOP_ACTION_FIELDS[args.action];
  for (const key of fields.required) {
    if (args[key] === undefined) throw new ToolError("INVALID_ARGUMENT", `desktop_action ${args.action} needs ${key}.`);
  }
  for (const key of ACTION_FIELD_KEYS) {
    if (args[key] !== undefined && !fields.required.includes(key) && !fields.allowed.includes(key)) {
      throw new ToolError("INVALID_ARGUMENT", `desktop_action ${args.action} takes no ${key}.`);
    }
  }
  if ((args.x === undefined) !== (args.y === undefined)) throw new ToolError("INVALID_ARGUMENT", "x and y go together.");
  if (args.screenshot_id !== undefined && args.x === undefined) throw new ToolError("INVALID_ARGUMENT", "screenshot_id names the space of x and y: pass them too.");
  if (args.region !== undefined && args.window_id !== undefined) throw new ToolError("INVALID_ARGUMENT", "Pass region or window_id, not both.");
  if (!isReadOnlyDesktopAction(args.action) && args.max_size !== undefined && args.screenshot !== true) {
    throw new ToolError("INVALID_ARGUMENT", "max_size goes with screenshot: true.");
  }
  if (args.action === "wait" && (args.for ?? "idle") === "idle" && args.since !== undefined) throw new ToolError("INVALID_ARGUMENT", "since goes with for: \"change\".");
  if (args.action === "wait" && args.for === "change" && args.idle_ms !== undefined) throw new ToolError("INVALID_ARGUMENT", "idle_ms goes with for: \"idle\".");
  if (args.action === "type" && [...(args.text ?? "")].length > DESKTOP_TYPE_MAX_CHARS) {
    throw new ToolError("INVALID_ARGUMENT", `text is longer than ${DESKTOP_TYPE_MAX_CHARS} characters: type it in parts.`);
  }
  if (args.action === "clipboard_set" && Buffer.byteLength(args.text ?? "", "utf8") > DESKTOP_CLIPBOARD_MAX_BYTES) {
    throw new ToolError("INVALID_ARGUMENT", `text is larger than ${DESKTOP_CLIPBOARD_MAX_BYTES} bytes.`);
  }
}

/** Who acts, as the desktop's action log and control pill name it. */
function actorOf(caller: ToolCaller): DesktopActor {
  if (caller.kind === "external") return { kind: "external", label: "MCP client" };
  return { kind: "chat", threadId: caller.threadId, label: caller.agentId ? agentLabel(caller.agentId) : "Agent" };
}

/** The tool's arguments as the daemon's request. */
function actionRequest(args: DesktopActionArgs, actor: DesktopActor): DesktopActionRequest {
  const request: DesktopActionRequest = { action: args.action, actor };
  if (args.x !== undefined) request.x = args.x;
  if (args.y !== undefined) request.y = args.y;
  if (args.screenshot_id !== undefined) request.screenshotId = args.screenshot_id;
  if (args.button !== undefined) request.button = args.button;
  if (args.count !== undefined) request.count = args.count;
  if (args.modifiers !== undefined) request.modifiers = [...args.modifiers];
  if (args.to_x !== undefined) request.toX = args.to_x;
  if (args.to_y !== undefined) request.toY = args.to_y;
  if (args.direction !== undefined) request.direction = args.direction;
  if (args.amount !== undefined) request.amount = args.amount;
  if (args.keys !== undefined) request.keys = args.keys;
  if (args.repeat !== undefined) request.repeat = args.repeat;
  if (args.text !== undefined) request.text = args.text;
  if (args.region !== undefined) request.region = { ...args.region };
  if (args.window_id !== undefined) request.windowId = args.window_id;
  if (args.max_size !== undefined) request.maxSize = args.max_size;
  if (args.for !== undefined) request.for = args.for;
  if (args.idle_ms !== undefined) request.idleMs = args.idle_ms;
  if (args.since !== undefined) request.since = args.since;
  if (args.timeout_ms !== undefined) request.timeoutMs = args.timeout_ms;
  if (args.screenshot !== undefined) request.screenshot = args.screenshot;
  return request;
}

/** The chat row's summary cap (`DesktopToolReference.summary`, one line). */
const REF_SUMMARY_MAX = 200;

/** The result's `desktopRef` (kept through slimming): the desktop, a kept screenshot, and the row's words. */
function desktopRef(desktop: DesktopSummary, result: DesktopActionResponse): DesktopToolReference {
  const line = result.summary.replace(/[\u0000-\u001f\u007f\u2028\u2029\s]+/g, " ").trim();
  const chars = [...line];
  const summary = chars.length <= REF_SUMMARY_MAX ? line : `${chars.slice(0, REF_SUMMARY_MAX - 1).join("")}…`;
  return {
    desktopId: desktop.id,
    projectPath: desktop.projectPath,
    ...(result.screenshot ? { screenshotId: result.screenshot.screenshotId } : {}),
    action: result.action,
    ...(summary ? { summary } : {})
  };
}

const desktopAction = defineTool({
  name: "desktop_action",
  title: "Use a desktop",
  description:
    "See and drive a desktop (get_desktops) as the user watches. Loop: screenshot → act with its screenshot_id (x, y in that image's pixels) → wait, or screenshot: true → look again. screenshot crops to region or window_id. wait: until the screen (or region) is still, or changed after since. move, click, mouse_down/up, drag (to_x, to_y), scroll; key; type; clipboard_get/set. After a resize, older screenshot_ids fail DESKTOP_RESIZED. While the user has control, input fails DESKTOP_CONTROLLED_BY_USER (wait or ask); reads work.",
  chatNote: "Every action shows in the user's desktop tab.",
  input: desktopActionInput,
  audiences: ["external", "chat"],
  toolset: "desktops",
  // Screenshots, waits and reading the clipboard change nothing; no action raises a card.
  tier: (args) => (isReadOnlyDesktopAction(args.action) ? "read" : "act"),
  async scope(args, ctx) {
    checkDesktopAction(args);
    const desktop = await findDesktop(ctx.api, args.desktopId);
    // The screen and the clipboard are content.
    return { projects: [desktop.projectPath], sessions: [], reads: "content", writes: !isReadOnlyDesktopAction(args.action), causesTurnIn: [] };
  },
  // Input can do anything an app lets a person do.
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  resultKind: "image",
  async run(args, ctx): Promise<Record<string, unknown> | CallToolResult> {
    checkDesktopAction(args);
    const { api } = ctx;
    const desktop = await findDesktop(api, args.desktopId);
    const request = actionRequest(args, actorOf(ctx.caller));
    // Abortable where the daemon offers it: the call going away ends a wait and stops a long type.
    const result = expectDesktopOk<DesktopActionResponse>(
      api.desktopAction
        ? await api.desktopAction(desktop.id, request, { signal: ctx.signal })
        : await api.request("POST", desktopRoutes.actions(desktop.id), { body: request })
    );
    const shot = result.screenshot;
    const value: Record<string, unknown> = {
      desktopId: result.desktopId,
      action: result.action,
      summary: result.summary,
      seq: result.seq,
      display: { width: result.display.width, height: result.display.height },
      ...(result.cursor ? { cursor: { x: result.cursor.x, y: result.cursor.y } } : {}),
      ...(result.changed !== undefined ? { changed: result.changed } : {}),
      ...(result.timedOut !== undefined ? { timed_out: result.timedOut } : {}),
      ...(result.waitedMs !== undefined ? { waited_ms: result.waitedMs } : {}),
      ...(result.text !== undefined ? { text: result.text } : {}),
      ...(shot
        ? { screenshot: { screenshot_id: shot.screenshotId, width: shot.width, height: shot.height, scale: shot.scale, origin: { x: shot.origin.x, y: shot.origin.y }, mime_type: shot.mimeType } }
        : {}),
      ...(result.control?.controller === "user" ? { note: "The user has control now: input fails until they give it back." } : {}),
      desktopRef: desktopRef(desktop, result)
    };
    return shot ? imageResult({ data: shot.base64, mimeType: shot.mimeType }, value) : value;
  }
});

/** This family in the catalog (`../catalog/index.ts`). */
export const desktopsFamily: readonly AnyOrquesterTool[] = [getDesktops, controlDesktop, desktopAction];
