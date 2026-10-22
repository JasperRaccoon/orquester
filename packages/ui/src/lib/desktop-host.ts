/**
 * The desktop shell's native integration, as the shared UI sees it: system
 * notifications for the daemon's pushes, the dock/taskbar attention badge,
 * application-menu actions, and the titlebar's frame. The Electron preload
 * exposes a {@link DesktopHost}; the web runtime has none.
 *
 * The rules are pure (which push becomes a notification, what the badge
 * counts, what a bridge payload may say) so they test without a window; the
 * mounted `DesktopNotifications` component wires them to the store, and
 * `desktop-host-nav.ts` opens what a notification points at.
 */

import {
  PUSH_CHANNEL,
  PUSH_NOTIFICATION_EVENT_TYPE,
  type PushNotificationEvent,
  type PushNotificationKind,
  type SessionActivity
} from "@orquester/api";

/** What clicking a notification opens. */
export type DesktopNotificationTarget =
  | { kind: "session"; sessionId: string }
  | { kind: "workflow"; workflowId: string; runId: string | null };

/** One system notification, as the renderer asks the shell to show it. */
export interface DesktopNotificationRequest {
  title: string;
  body: string;
  /** A later notification with the same tag replaces this one. */
  tag: string;
  target: DesktopNotificationTarget | null;
}

/** A command from the native application menu that the UI carries out. */
export type DesktopMenuAction = "open-settings";

/**
 * The preload's bridge. Every member is optional: a packaged app can run a
 * newer renderer bundle against the preload it shipped with.
 */
export interface DesktopHost {
  /** `process.platform` of the shell. */
  platform?: string;
  /**
   * Whether the window has the OS's own caption buttons: false for a
   * frameless window on Windows and Linux, which then needs the in-app ones
   * whatever the setting says.
   */
  nativeWindowControls?: boolean;
  /** The titlebar setting was saved: the shell rebuilds the window if its frame must change. */
  titlebarChanged?(): void;
  notify?(request: DesktopNotificationRequest): void;
  setBadgeCount?(count: number): void;
  /** A notification was clicked (the payload is unvalidated). Returns the unsubscribe. */
  onNotificationOpen?(listener: (target: unknown) => void): () => void;
  /** An application-menu item was chosen (the payload is unvalidated). Returns the unsubscribe. */
  onMenuAction?(listener: (action: unknown) => void): () => void;
}

// ---------------------------------------------------------------------------
// Bridge and bus payloads
// ---------------------------------------------------------------------------

const TITLE_MAX = 200;
const BODY_MAX = 500;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const KINDS: ReadonlySet<PushNotificationKind> = new Set<PushNotificationKind>([
  "attention",
  "needs-input",
  "finished",
  "plan-ready",
  "approval",
  "agent",
  "workflow"
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const idOf = (value: unknown): string | null => (typeof value === "string" && ID.test(value) ? value : null);

/** A `push.notification` payload off the event bus, or null when it is not one we can show. */
export function parsePushNotificationEvent(payload: unknown): PushNotificationEvent | null {
  if (!isRecord(payload)) return null;
  const { kind, title, body, tag } = payload;
  if (typeof kind !== "string" || !KINDS.has(kind as PushNotificationKind)) return null;
  if (typeof title !== "string" || title.trim() === "") return null;
  if (typeof tag !== "string" || !TAG.test(tag)) return null;
  const event: PushNotificationEvent = {
    kind: kind as PushNotificationKind,
    title: title.trim().slice(0, TITLE_MAX),
    body: typeof body === "string" ? body.trim().slice(0, BODY_MAX) : "",
    tag
  };
  const sessionId = idOf(payload.sessionId);
  if (sessionId) event.sessionId = sessionId;
  const workflowId = idOf(payload.workflowId);
  if (workflowId) {
    event.workflowId = workflowId;
    const runId = idOf(payload.runId);
    if (runId) event.runId = runId;
  }
  return event;
}

/** A clicked notification's target as the shell hands it back, or null. */
export function parseNotificationTarget(raw: unknown): DesktopNotificationTarget | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "session") {
    const sessionId = idOf(raw.sessionId);
    return sessionId ? { kind: "session", sessionId } : null;
  }
  if (raw.kind === "workflow") {
    const workflowId = idOf(raw.workflowId);
    return workflowId ? { kind: "workflow", workflowId, runId: idOf(raw.runId) } : null;
  }
  return null;
}

/** An application-menu action, or null when it is not one the UI knows. */
export function parseMenuAction(raw: unknown): DesktopMenuAction | null {
  return raw === "open-settings" ? raw : null;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export interface NotificationContext {
  /** Settings → General → Desktop notifications. */
  enabled: boolean;
  /** The app window has focus and is visible. */
  windowFocused: boolean;
  /** The session tab on screen, or null. */
  viewingSessionId: string | null;
}

function targetOf(event: PushNotificationEvent): DesktopNotificationTarget | null {
  if (event.kind === "workflow" && event.workflowId) {
    return { kind: "workflow", workflowId: event.workflowId, runId: event.runId ?? null };
  }
  return event.sessionId ? { kind: "session", sessionId: event.sessionId } : null;
}

/**
 * The system notification a push becomes, or null. A session's push shows
 * unless the user is looking at that session in the focused window; a
 * workflow run's only while the window is unfocused (the in-app toast tells
 * a user who is in the app); one that names nothing always shows.
 */
// Adapted from T3 Code (MIT): apps/web/src/components/ThreadNotificationCoordinator.tsx
export function desktopNotificationFor(
  event: PushNotificationEvent,
  context: NotificationContext
): DesktopNotificationRequest | null {
  if (!context.enabled) return null;
  const target = targetOf(event);
  if (target?.kind === "session" && context.windowFocused && context.viewingSessionId === target.sessionId) {
    return null;
  }
  if (target?.kind === "workflow" && context.windowFocused) return null;
  return { title: event.title, body: event.body, tag: event.tag, target };
}

/** The slice of an Opened Agents entry the badge reads. */
export interface BadgeEntry {
  bucket: "attention" | "finished" | "active" | "idle";
  activity: Pick<SessionActivity, "attention"> | undefined;
}

/**
 * Sessions that need the user: blocked on them (a raised attention or a
 * question/approval wait), or ended and not yet looked at. Looking at a tab
 * clears its attention, so the count falls as the user catches up.
 */
export function desktopBadgeCount(entries: readonly BadgeEntry[]): number {
  return entries.filter(
    (entry) => entry.bucket === "attention" || (entry.bucket === "finished" && entry.activity?.attention != null)
  ).length;
}

// ---------------------------------------------------------------------------
// The push feed (fed by the app store's event router)
// ---------------------------------------------------------------------------

const pushListeners = new Set<(event: PushNotificationEvent) => void>();

/** The app store's hook into the `push` channel: a valid `push.notification` reaches every listener. */
export function observePushEvent(event: { channel: string; type: string; payload: unknown }): void {
  if (event.channel !== PUSH_CHANNEL || event.type !== PUSH_NOTIFICATION_EVENT_TYPE) return;
  const parsed = parsePushNotificationEvent(event.payload);
  if (parsed === null) return;
  for (const listener of [...pushListeners]) listener(parsed);
}

export function subscribePushNotifications(listener: (event: PushNotificationEvent) => void): () => void {
  pushListeners.add(listener);
  return () => {
    pushListeners.delete(listener);
  };
}
