/**
 * Pure state helpers for desktop tabs (spec §10.1): shape checks for what the
 * daemon sends on the `desktop` channel and `GET /api/desktops`, and the list
 * reducers the app store applies them with. A payload that fails its check is
 * dropped rather than allowed to reach shared UI state.
 */

import type {
  DesktopAppSummary,
  DesktopSummary,
  DesktopWindow,
  DesktopWindowsPayload
} from "@orquester/api";

const DESKTOP_STATUSES = new Set(["starting", "running", "stopped", "error"]);
const APP_STATUSES = new Set(["starting", "running", "exited"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isDesktopWindow(value: unknown): value is DesktopWindow {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    isStringOrNull(value.appId) &&
    isStringOrNull(value.wmClass) &&
    typeof value.maximized === "boolean"
  );
}

function isDesktopApp(value: unknown): value is DesktopAppSummary {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.command === "string" &&
    typeof value.status === "string" &&
    APP_STATUSES.has(value.status)
  );
}

/**
 * A `DesktopSummary` the UI can render, or null. Unknown fields ride along
 * (a newer daemon may add some); the fields tabs, the close flow and the
 * viewer read are checked.
 */
export function parseDesktopSummary(value: unknown): DesktopSummary | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id === "" ||
    typeof value.projectPath !== "string" ||
    typeof value.title !== "string" ||
    typeof value.order !== "number" ||
    typeof value.createdAt !== "string" ||
    typeof value.status !== "string" ||
    !DESKTOP_STATUSES.has(value.status) ||
    !isRecord(value.size) ||
    typeof value.size.width !== "number" ||
    typeof value.size.height !== "number" ||
    !Array.isArray(value.apps) ||
    !value.apps.every(isDesktopApp) ||
    !Array.isArray(value.windows) ||
    !value.windows.every(isDesktopWindow) ||
    !isStringOrNull(value.activeWindowId ?? null)
  ) {
    return null;
  }
  return { ...(value as unknown as DesktopSummary), activeWindowId: (value.activeWindowId as string | null) ?? null };
}

/** The valid entries of a `GET /api/desktops` response (anything else → empty). */
export function parseDesktopList(value: unknown): DesktopSummary[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(parseDesktopSummary).filter((d): d is DesktopSummary => d !== null);
}

export function parseDesktopWindowsPayload(value: unknown): DesktopWindowsPayload | null {
  if (
    !isRecord(value) ||
    typeof value.desktopId !== "string" ||
    !Array.isArray(value.windows) ||
    !value.windows.every(isDesktopWindow) ||
    !isStringOrNull(value.activeWindowId ?? null)
  ) {
    return null;
  }
  return {
    desktopId: value.desktopId,
    windows: value.windows,
    activeWindowId: (value.activeWindowId as string | null) ?? null
  };
}

/** Replace a desktop by id, or append it. */
export function upsertDesktopIn(desktops: DesktopSummary[], desktop: DesktopSummary): DesktopSummary[] {
  const at = desktops.findIndex((d) => d.id === desktop.id);
  if (at === -1) return [...desktops, desktop];
  const next = desktops.slice();
  next[at] = desktop;
  return next;
}

/**
 * Patch one desktop's window list and active window. Returns the same array
 * when the desktop is unknown, so an event for another client's desktop that
 * never reached this one is a no-op render-wise.
 */
export function applyDesktopWindows(
  desktops: DesktopSummary[],
  payload: DesktopWindowsPayload
): DesktopSummary[] {
  const at = desktops.findIndex((d) => d.id === payload.desktopId);
  if (at === -1) return desktops;
  const next = desktops.slice();
  next[at] = { ...desktops[at], windows: payload.windows, activeWindowId: payload.activeWindowId };
  return next;
}

/** Add (or replace) one app on a desktop — a launch's response, ahead of its event. */
export function upsertDesktopApp(
  desktops: DesktopSummary[],
  desktopId: string,
  app: DesktopAppSummary
): DesktopSummary[] {
  const at = desktops.findIndex((d) => d.id === desktopId);
  if (at === -1) return desktops;
  const desktop = desktops[at];
  const appAt = desktop.apps.findIndex((a) => a.id === app.id);
  const apps = appAt === -1 ? [...desktop.apps, app] : desktop.apps.map((a) => (a.id === app.id ? app : a));
  const next = desktops.slice();
  next[at] = { ...desktop, apps };
  return next;
}

/** Apps that closing the desktop would terminate. */
export function runningDesktopApps(desktop: DesktopSummary): DesktopAppSummary[] {
  return desktop.apps.filter((a) => a.status === "running" || a.status === "starting");
}

/**
 * A short label for an app: its command's program name, without the directory
 * or any leading `KEY=value` assignments.
 */
export function desktopAppLabel(app: Pick<DesktopAppSummary, "command">): string {
  const words = app.command.trim().split(/\s+/);
  const first = words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) ?? "";
  const base = first.split("/").pop() ?? first;
  return base || app.command.trim() || "app";
}

/** Tab title: `<title> · <active window title>` while a window is active. */
export function desktopTabTitle(desktop: DesktopSummary): string {
  const title = desktop.title || "Desktop";
  const active = desktop.activeWindowId
    ? desktop.windows.find((w) => w.id === desktop.activeWindowId)
    : undefined;
  return active?.title ? `${title} · ${active.title}` : title;
}

/** The close-confirm body for a desktop with running apps (spec §10.6). */
export function desktopCloseMessage(desktop: DesktopSummary): string {
  const running = runningDesktopApps(desktop);
  const names = running.map(desktopAppLabel).join(", ");
  const count = running.length === 1 ? "1 app is running" : `${running.length} apps are running`;
  return `Stop desktop “${desktop.title || "Desktop"}”? ${count}: ${names}. They will be terminated.`;
}
