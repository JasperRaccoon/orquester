// Catalog family module `desktops` (get_desktops, control_desktop) — unified MCP design 2026-10-15
// §4 rows 40–41, §4.1 (ruling S4), plan Task 12. Both audiences, toolset `desktops`.
//
// A desktop is a virtual X display on the daemon's host that GUI apps run in, shown to the user as
// a tab (docs/superpowers/specs/2026-09-30-desktop-tab-design.md §7.4). Every call is an in-process
// client of the daemon's desktop routes (`desktopRoutes`) through DaemonApi only, so a desktop an
// agent opens appears in every client as the GUI's own would (`desktop.created`).
//
// Chat tiers: `open` and `launch_app` start processes on the host — Admin (`desktops`), with a card
// naming the command, the working directory and every env value in full (`./desktop-preview.ts`);
// `stop_app`, `close_window` and `close` only stop things — Act. A desktop's project is its target
// (§5.2); a chat caller's `cwd` must lie inside a project (ruling S6).

import { basename, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { DESKTOP_MAX_HEIGHT, DESKTOP_MAX_WIDTH, DESKTOP_MIN_HEIGHT, DESKTOP_MIN_WIDTH } from "@orquester/config";
import {
  DESKTOP_ENV_KEY_PATTERN,
  DESKTOP_MAX_COMMAND_LENGTH,
  DESKTOP_UNAVAILABLE_CODE,
  TOOL_APPROVAL_REASON_MAX_CHARS,
  desktopRoutes,
  type CreateDesktopRequest,
  type DesktopAppSummary,
  type DesktopHostStatus,
  type DesktopSummary,
  type LaunchAppRequest
} from "@orquester/api";
import { projectNamesFor, resolveProject } from "../addressing.ts";
import type { DaemonApi, DaemonResponse } from "../daemon-api.ts";
import { daemonError, ToolError } from "../errors.ts";
import { clipText, jsonBytes, MAX_ECHO_CHARS } from "../result.ts";
import { defineTool, READ_ONLY, type AnyOrquesterTool, type ScopeClaim, type ScopeContext } from "../catalog/contract.ts";
import { desktopPreview } from "./desktop-preview.ts";

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
  [DESKTOP_UNAVAILABLE_CODE]: " get_desktops {host: true} shows what is missing."
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
  return ref === undefined ? null : (await resolveProject(ctx.api, ref)).path;
}

/** `ws/p` of a project path, for cards (the path itself when it names no project). */
function labelOf(api: DaemonApi, projectPath: string): string {
  const names = projectNamesFor(projectPath, api.workspacesDir);
  return names.workspace && names.name ? `${names.workspace}/${names.name}` : projectPath;
}

/** A launch's working directory as the daemon runs it: absolute, or relative to the desktop's project. */
const cwdIn = (projectPath: string, cwd: string): string => (isAbsolute(cwd) ? resolve(cwd) : resolve(projectPath, cwd));

// ---------------------------------------------------------------------------
// get_desktops
// ---------------------------------------------------------------------------

const desktopIdArg = z.string().min(1).describe("A desktop's id (get_desktops).");

const getDesktops = defineTool({
  name: "get_desktops",
  title: "Get desktops",
  description:
    "Desktop tabs: virtual X displays on the daemon's host running GUI apps, shown to the user live. No desktopId: a project's desktops (id, title, status, size, audio, apps, open windows). desktopId: that one. desktopId + appId: the app's last 64 KiB of stdout/stderr (truncated: true when cut). host: true adds whether this host can run desktops (tools found, GPU, warnings, installHint: the apt-get line for what's missing — installing is for the host's owner; tell the user).",
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
    const host = args.host === true ? { host: expectDesktopOk<DesktopHostStatus>(await api.request("GET", desktopRoutes.host)) } : {};
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
      ...(args.cwd !== undefined ? { paths: [cwdIn(projectPath, args.cwd)] } : {})
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
      ...(args.cwd !== undefined ? { cwd: cwdIn(projectPath, args.cwd) } : {}),
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
    switch (args.action) {
      case "open": {
        const { projectPath } = await targetOf(args, ctx);
        const body: CreateDesktopRequest = { projectPath };
        if (args.title !== undefined) body.title = args.title;
        if (args.size !== undefined) body.size = { ...args.size };
        if (args.renderThreads !== undefined) body.renderThreads = args.renderThreads;
        if (args.command !== undefined) body.app = launchRequest({ command: args.command, cwd: args.cwd, env: args.env });
        return { desktop: expectDesktopOk<DesktopSummary>(await api.request("POST", desktopRoutes.create, { body })) };
      }
      case "launch_app": {
        const app = expectDesktopOk<DesktopAppSummary>(
          await api.request("POST", desktopRoutes.apps(args.desktopId!), { body: launchRequest({ command: args.command!, cwd: args.cwd, env: args.env }) })
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

/** This family in the catalog (`../catalog/index.ts`). */
export const desktopsFamily: readonly AnyOrquesterTool[] = [getDesktops, controlDesktop];
