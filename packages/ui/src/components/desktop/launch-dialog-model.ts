/**
 * The launch dialog's pure logic (spec §10.2): suggestion ranking, env-row
 * validation and request building. `LaunchAppDialog` holds the form state and
 * renders; everything that decides what gets sent lives here.
 */

import fuzzysort from "fuzzysort";
import {
  DESKTOP_ENV_KEY_PATTERN,
  DESKTOP_MAX_COMMAND_LENGTH,
  type CreateDesktopRequest,
  type DesktopSize,
  type DesktopSuggestionsResponse,
  type LaunchAppRequest,
  type RecentLaunch
} from "@orquester/api";

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

export interface LaunchSuggestion {
  kind: "entry" | "executable" | "recent";
  /** What the row shows. */
  label: string;
  /** Secondary text (the command behind a `.desktop` name, a recent's cwd). */
  detail: string | null;
  /** What choosing it puts in the command input. */
  insert: string;
  /** A recent launch also restores its cwd and env. */
  recent: RecentLaunch | null;
}

/** Flatten a suggestions response into one list: recents, then entries, then executables. */
export function suggestionItems(response: DesktopSuggestionsResponse | null): LaunchSuggestion[] {
  if (!response) return [];
  const recent = response.recent.map<LaunchSuggestion>((r) => ({
    kind: "recent",
    label: r.command,
    detail: r.cwd || null,
    insert: r.command,
    recent: r
  }));
  const entries = response.entries.map<LaunchSuggestion>((e) => ({
    kind: "entry",
    label: e.name,
    detail: e.command,
    insert: e.command,
    recent: null
  }));
  const executables = response.executables.map<LaunchSuggestion>((path) => ({
    kind: "executable",
    label: path,
    detail: null,
    insert: executableCommand(path),
    recent: null
  }));
  return [...recent, ...entries, ...executables];
}

/** A project-relative executable as a command: `./path` (absolute paths stay as they are). */
export function executableCommand(path: string): string {
  if (path.startsWith("/") || path.startsWith("./") || path.startsWith("../")) return path;
  return `./${path}`;
}

/**
 * The suggestions to list for what is typed. Empty input lists the first
 * `limit` in their natural order (recents first); otherwise a fuzzy match over
 * the label and the inserted command, best first. An input that already equals
 * a suggestion's command lists nothing: the user has picked it.
 */
export function rankSuggestions(items: LaunchSuggestion[], query: string, limit = 8): LaunchSuggestion[] {
  const q = query.trim();
  if (!q) return items.slice(0, limit);
  if (items.some((item) => item.insert === q)) return [];
  return fuzzysort
    .go(q, items, { keys: ["label", "insert"], limit })
    .map((result) => result.obj);
}

// ---------------------------------------------------------------------------
// Form validation and requests
// ---------------------------------------------------------------------------

export interface EnvRow {
  id: string;
  key: string;
  value: string;
}

/** Error text for a command line, or null when it can be sent. */
export function commandError(command: string): string | null {
  if (!command.trim()) return "Enter a command";
  if (/[\r\n]/.test(command)) return "The command must be a single line";
  if (command.length > DESKTOP_MAX_COMMAND_LENGTH) {
    return `The command is longer than ${DESKTOP_MAX_COMMAND_LENGTH} characters`;
  }
  return null;
}

/**
 * Env rows → an env object, or per-row errors. A row with neither key nor
 * value is ignored (the blank row the form keeps at the end).
 */
export function envFromRows(rows: EnvRow[]): { env: Record<string, string>; errors: Record<string, string> } {
  const env: Record<string, string> = {};
  const errors: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key && !row.value) continue;
    if (!key) {
      errors[row.id] = "Enter a name";
    } else if (!DESKTOP_ENV_KEY_PATTERN.test(key)) {
      errors[row.id] = "Letters, digits and _ only, not starting with a digit";
    } else if (Object.prototype.hasOwnProperty.call(env, key)) {
      errors[row.id] = `${key} is set twice`;
    } else {
      env[key] = row.value;
    }
  }
  return { env, errors };
}

/** Env rows for a recent launch's env (in key order). */
export function rowsFromEnv(env: Record<string, string>, newId: () => string): EnvRow[] {
  return Object.entries(env).map(([key, value]) => ({ id: newId(), key, value }));
}

export interface LaunchForm {
  command: string;
  cwd: string;
  envRows: EnvRow[];
}

export type LaunchRequestResult =
  | { ok: true; request: LaunchAppRequest }
  | { ok: false; commandError: string | null; envErrors: Record<string, string> };

/** Validate the form and build the app launch; empty cwd/env are omitted (project root, no extras). */
export function buildLaunchRequest(form: LaunchForm): LaunchRequestResult {
  const cmdError = commandError(form.command);
  const { env, errors } = envFromRows(form.envRows);
  if (cmdError || Object.keys(errors).length > 0) {
    return { ok: false, commandError: cmdError, envErrors: errors };
  }
  const request: LaunchAppRequest = { command: form.command.trim() };
  const cwd = form.cwd.trim();
  if (cwd) request.cwd = cwd;
  if (Object.keys(env).length > 0) request.env = env;
  return { ok: true, request };
}

export interface SizePreset {
  id: string;
  label: string;
  /** Null for "Fit tab": no size is sent, the viewer resizes the display. */
  size: DesktopSize | null;
}

export const DESKTOP_SIZE_PRESETS: readonly SizePreset[] = [
  { id: "fit", label: "Fit tab", size: null },
  { id: "1280x800", label: "1280×800", size: { width: 1280, height: 800 } },
  { id: "1600x900", label: "1600×900", size: { width: 1600, height: 900 } },
  { id: "1920x1080", label: "1920×1080", size: { width: 1920, height: 1080 } }
];

export const DEFAULT_RENDER_THREADS = 4;
export const MIN_RENDER_THREADS = 1;
export const MAX_RENDER_THREADS = 16;

export function clampRenderThreads(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RENDER_THREADS;
  return Math.min(MAX_RENDER_THREADS, Math.max(MIN_RENDER_THREADS, Math.round(value)));
}

/**
 * `POST /api/desktops` for a new desktop running `app`. Size and render
 * threads are sent only when they differ from the defaults, so the daemon's
 * own defaults apply otherwise.
 */
export function buildCreateRequest(
  projectPath: string,
  app: LaunchAppRequest,
  advanced: { sizeId: string; renderThreads: number }
): CreateDesktopRequest {
  const request: CreateDesktopRequest = { projectPath, app };
  const size = DESKTOP_SIZE_PRESETS.find((p) => p.id === advanced.sizeId)?.size ?? null;
  if (size) request.size = { ...size };
  const threads = clampRenderThreads(advanced.renderThreads);
  if (threads !== DEFAULT_RENDER_THREADS) request.renderThreads = threads;
  return request;
}

/**
 * A daemon error as one line for the dialog: its message, plus the install
 * hint a `409 DESKTOP_UNAVAILABLE` carries. Duck-typed over `ApiError`.
 */
export function describeLaunchError(error: unknown): string {
  if (!error || typeof error !== "object") return String(error ?? "Launch failed");
  const e = error as { message?: unknown; serverMessage?: unknown; body?: unknown };
  const body = e.body && typeof e.body === "object" ? (e.body as Record<string, unknown>) : null;
  const message =
    (typeof e.serverMessage === "string" && e.serverMessage) ||
    (typeof e.message === "string" && e.message) ||
    "Launch failed";
  const hint = body && typeof body.hint === "string" && body.hint.trim() ? body.hint.trim() : null;
  return hint && !message.includes(hint) ? `${message} — ${hint}` : message;
}
