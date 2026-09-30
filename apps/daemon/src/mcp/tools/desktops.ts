// Desktop tabs through the MCP (docs/superpowers/specs/2026-09-30-desktop-tab-design.md §7.4).
//
// A desktop is a virtual X display on the daemon's host that GUI apps run in, shown to the user as a tab. Every tool is
// an in-process client of the daemon's desktop routes (`desktopRoutes`), through DaemonApi only, so a desktop an agent
// opens appears in every client as the GUI's own would (`desktop.created`).

import { z } from "zod";
import { DESKTOP_MAX_HEIGHT, DESKTOP_MAX_WIDTH, DESKTOP_MIN_HEIGHT, DESKTOP_MIN_WIDTH } from "@orquester/config";
import {
  DESKTOP_ENV_KEY_PATTERN,
  DESKTOP_MAX_COMMAND_LENGTH,
  DESKTOP_UNAVAILABLE_CODE,
  desktopRoutes,
  type CreateDesktopRequest,
  type DesktopAppSummary,
  type DesktopHostStatus,
  type DesktopSummary,
  type LaunchAppRequest
} from "@orquester/api";
import { resolveProject } from "../addressing.ts";
import type { DaemonResponse } from "../daemon-api.ts";
import { daemonError, ToolError } from "../errors.ts";
import { clipText, jsonBytes, MAX_ECHO_CHARS } from "../result.ts";
import { defineTool, DESTRUCTIVE, MUTATING, READ_ONLY, type ToolDef } from "../tool.ts";

/** What desktop_app_log returns of a log at most: its tail, well under ok()'s 60 000-byte cap once JSON-escaped. */
const LOG_RESULT_BYTES = 50_000;
/** The most of the daemon's install hint an error quotes. */
const MAX_HINT_CHARS = 500;

const NOT_FOUND_HINT = " desktops_list shows the desktops with their apps and ids; desktop_windows shows a desktop's window ids.";

const ERROR_HINTS: Record<string, string> = {
  NOT_FOUND: NOT_FOUND_HINT,
  DESKTOP_NOT_FOUND: NOT_FOUND_HINT,
  DESKTOP_APP_NOT_FOUND: NOT_FOUND_HINT,
  DESKTOP_WINDOW_NOT_FOUND: " desktop_windows shows the desktop's current windows.",
  [DESKTOP_UNAVAILABLE_CODE]: " desktop_host_status shows what is missing."
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

const projectArg = z.string().describe("The project: an absolute path or \"<workspace>/<project>\".");
const desktopIdArg = z.string().min(1).describe("The desktop's id (desktops_list).");
const commandArg = z.string().min(1).max(DESKTOP_MAX_COMMAND_LENGTH)
  .refine((command) => !/[\r\n]/.test(command), "must be a single line")
  .describe("One shell command line, run as `sh -c 'exec <command>'` with DISPLAY and audio wired to the desktop, e.g. \"xterm\" or \"./build/bin/editor --level 2\".");
const cwdArg = z.string().min(1).optional().describe("Working directory: absolute, or relative to the project; default: the project.");
const envArg = z.record(z.string().regex(DESKTOP_ENV_KEY_PATTERN, "is not an environment variable name"), z.string()).optional()
  .describe("Extra environment variables for the app, applied last (they can override LP_NUM_THREADS or anything else).");

function launchRequest(args: { command: string; cwd?: string; env?: Record<string, string> }): LaunchAppRequest {
  const app: LaunchAppRequest = { command: args.command };
  if (args.cwd !== undefined) app.cwd = args.cwd;
  if (args.env !== undefined) app.env = args.env;
  return app;
}

const desktopsList = defineTool({
  name: "desktops_list",
  title: "List desktops",
  description: "The desktop tabs — virtual X displays on the daemon's host that GUI apps run in — of one project, or of every project: id, title, status (starting, running, stopped, error), size, audio, the apps launched in it (id, command, status, exit code) and its open windows. Use a desktop's id with desktop_launch_app, desktop_windows and desktop_close.",
  input: { projectPath: projectArg.optional().describe("Only this project's desktops: an absolute path or \"<workspace>/<project>\"; omit for every project.") },
  annotations: READ_ONLY,
  async run(args, { api }) {
    // `!== undefined`: an empty projectPath is refused by resolveProject, never read as "every project".
    const query = args.projectPath !== undefined ? { projectPath: (await resolveProject(api, args.projectPath)).path } : undefined;
    const desktops = expectDesktopOk<DesktopSummary[]>(await api.request("GET", desktopRoutes.list, query ? { query } : undefined));
    return { desktops };
  }
});

const desktopHostStatus = defineTool({
  name: "desktop_host_status",
  title: "Check the desktop host",
  description: "Whether this host can run desktops, before desktop_open: available (Xvnc, Openbox, D-Bus and a usable tmux ≥ 3.2 are present), audioAvailable (PulseAudio and ffmpeg with pulse and libopus), each tool's path, whether a GPU render node exists (else OpenGL is software-rendered), warnings, and installHint — the apt-get line for whatever is missing. Installing is for the host's owner; tell the user rather than running it.",
  input: {},
  annotations: READ_ONLY,
  async run(_args, { api }) {
    return { ...expectDesktopOk<DesktopHostStatus>(await api.request("GET", desktopRoutes.host)) };
  }
});

const desktopOpen = defineTool({
  name: "desktop_open",
  title: "Open a desktop",
  description: "Open a desktop tab in a project: a virtual X display on the daemon's host, with a window manager and audio, that GUI apps run in and the user sees and controls live as a tab in every client. Optionally launch a first app into it (command). Several apps can share one desktop; launch more with desktop_launch_app. Check desktop_host_status first: without the host packages this answers DESKTOP_UNAVAILABLE with the install line. Returns the desktop; while status is \"starting\" its display is still coming up.",
  input: {
    projectPath: projectArg,
    title: z.string().min(1).max(200).optional().describe("The tab's title; default \"Desktop\"."),
    size: z.object({
      width: z.number().int().min(DESKTOP_MIN_WIDTH).max(DESKTOP_MAX_WIDTH),
      height: z.number().int().min(DESKTOP_MIN_HEIGHT).max(DESKTOP_MAX_HEIGHT)
    }).strict().optional().describe(`The display size in pixels, ${DESKTOP_MIN_WIDTH}×${DESKTOP_MIN_HEIGHT} to ${DESKTOP_MAX_WIDTH}×${DESKTOP_MAX_HEIGHT}; default 1280×800.`),
    renderThreads: z.number().int().min(1).max(256).optional().describe("Software-OpenGL (llvmpipe) threads per app, LP_NUM_THREADS; default 4, at most the host's core count."),
    command: commandArg.optional().describe("A first app to launch once the display is up: one shell command line, e.g. \"xterm\"."),
    cwd: cwdArg.describe("The first app's working directory: absolute, or relative to the project; default: the project. Needs command."),
    env: envArg.describe("The first app's extra environment variables. Needs command.")
  },
  annotations: MUTATING,
  async run(args, { api }) {
    if (args.command === undefined && (args.cwd !== undefined || args.env !== undefined)) {
      throw new ToolError("INVALID_ARGUMENT", "cwd and env apply to the first app: pass command too, or launch it later with desktop_launch_app.");
    }
    const project = await resolveProject(api, args.projectPath);
    const body: CreateDesktopRequest = { projectPath: project.path };
    if (args.title !== undefined) body.title = args.title;
    if (args.size !== undefined) body.size = args.size;
    if (args.renderThreads !== undefined) body.renderThreads = args.renderThreads;
    if (args.command !== undefined) body.app = launchRequest({ command: args.command, cwd: args.cwd, env: args.env });
    const desktop = expectDesktopOk<DesktopSummary>(await api.request("POST", desktopRoutes.create, { body }));
    return { desktop };
  }
});

const desktopLaunchApp = defineTool({
  name: "desktop_launch_app",
  title: "Launch an app in a desktop",
  description: "Start a GUI app in a running desktop, next to the apps already in it (they share one display and one audio output). Returns the app with its id: desktop_app_log reads its output, desktop_stop_app stops it, and its windows appear in desktop_windows once it opens them.",
  input: { desktopId: desktopIdArg, command: commandArg, cwd: cwdArg, env: envArg },
  annotations: MUTATING,
  async run(args, { api }) {
    const app = expectDesktopOk<DesktopAppSummary>(await api.request("POST", desktopRoutes.apps(args.desktopId), { body: launchRequest(args) }));
    return { app };
  }
});

const desktopWindows = defineTool({
  name: "desktop_windows",
  title: "List a desktop's windows",
  description: "The top-level windows open in a desktop, as the tab's window bar shows them: id (0x… hex), title, the app that owns it (appId, or null for one no launched app claims), WM_CLASS and maximized; the active window; and the desktop's apps. Use a window's id with desktop_window_action.",
  input: { desktopId: desktopIdArg },
  annotations: READ_ONLY,
  async run(args, { api }) {
    // No per-desktop GET: the list route without projectPath lists every project's desktops.
    const desktops = expectDesktopOk<DesktopSummary[]>(await api.request("GET", desktopRoutes.list));
    const desktop = desktops.find((d) => d.id === args.desktopId);
    if (!desktop) throw new ToolError("NOT_FOUND", `No desktop "${clipText(args.desktopId, MAX_ECHO_CHARS)}".${NOT_FOUND_HINT}`);
    return {
      desktopId: desktop.id,
      status: desktop.status,
      windows: desktop.windows,
      activeWindowId: desktop.activeWindowId,
      apps: desktop.apps.map((app) => ({ id: app.id, command: app.command, status: app.status }))
    };
  }
});

const desktopWindowAction = defineTool({
  name: "desktop_window_action",
  title: "Act on a desktop window",
  description: "Activate (raise and focus), maximize or close one window of a desktop, as the tab's window bar does. maximize toggles: on a maximized window it restores it. close is graceful (_NET_CLOSE_WINDOW), so the app may ask to save instead of closing; desktop_stop_app ends an app outright.",
  input: {
    desktopId: desktopIdArg,
    windowId: z.string().min(1).describe("The window's id from desktop_windows (0x… hex)."),
    action: z.enum(["activate", "maximize", "close"]).describe("activate, maximize (a toggle) or close.")
  },
  annotations: MUTATING,
  async run(args, { api }) {
    expectDesktopOk(await api.request("POST", desktopRoutes.windowAction(args.desktopId, args.windowId, args.action)));
    return { done: true, desktopId: args.desktopId, windowId: args.windowId, action: args.action };
  }
});

const desktopAppLog = defineTool({
  name: "desktop_app_log",
  title: "Read an app's output",
  description: "The recent stdout and stderr of an app launched in a desktop (the daemon keeps its last 64 KiB), newest at the end — for why an app failed to start or what it printed. A log too long for one result keeps its tail (truncated: true).",
  input: { desktopId: desktopIdArg, appId: z.string().min(1).describe("The app's id (desktops_list, or desktop_launch_app's answer).") },
  annotations: READ_ONLY,
  async run(args, { api }) {
    const body = expectDesktopOk<unknown>(await api.request("GET", desktopRoutes.appLog(args.desktopId, args.appId)));
    // text/plain; the in-process client parses a body that happens to be JSON, so give such a log back as text.
    const raw = typeof body === "string" ? body : body === null ? "" : JSON.stringify(body);
    const log = tailJsonBytes(raw, LOG_RESULT_BYTES);
    return { desktopId: args.desktopId, appId: args.appId, text: log.text, ...(log.truncated ? { truncated: true } : {}) };
  }
});

const desktopStopApp = defineTool({
  name: "desktop_stop_app",
  title: "Stop an app in a desktop",
  description: "Stop one app in a desktop: SIGTERM to its process group, then SIGKILL if it is still alive after 5 s — or at once with force. Unsaved work in it is lost. The desktop and its other apps keep running.",
  input: {
    desktopId: desktopIdArg,
    appId: z.string().min(1).describe("The app's id (desktops_list)."),
    force: z.boolean().default(false).describe("SIGKILL at once instead of SIGTERM first.")
  },
  annotations: DESTRUCTIVE,
  async run(args, { api }) {
    expectDesktopOk(await api.request("DELETE", desktopRoutes.app(args.desktopId, args.appId), args.force ? { query: { force: "1" } } : undefined));
    return { stopped: true, desktopId: args.desktopId, appId: args.appId, force: args.force };
  }
});

const desktopClose = defineTool({
  name: "desktop_close",
  title: "Close a desktop",
  description: "Close a desktop tab: stops every app in it (unsaved work is lost), shuts its display down and removes the tab from every client, as closing the tab does. Stop a single app with desktop_stop_app instead.",
  input: { desktopId: desktopIdArg },
  annotations: DESTRUCTIVE,
  async run(args, { api }) {
    expectDesktopOk(await api.request("DELETE", desktopRoutes.desktop(args.desktopId)));
    return { closed: true, desktopId: args.desktopId };
  }
});

export const desktopTools: ToolDef[] = [desktopsList, desktopHostStatus, desktopOpen, desktopLaunchApp, desktopWindows, desktopWindowAction, desktopAppLog, desktopStopApp, desktopClose];
