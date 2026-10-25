// --- System notifications and the attention badge ---
//
// The renderer decides what to notify (`packages/ui/src/lib/desktop-host.ts`)
// and asks this process to show it; the request crosses the context bridge,
// so it is untrusted here and validated before it reaches a Notification, the
// dock badge or the taskbar overlay.

/** What a clicked notification opens; handed back to the renderer unchanged. */
export type NotificationTarget =
  | { kind: "session"; sessionId: string }
  | { kind: "workflow"; workflowId: string; runId: string | null };

export interface NotificationRequest {
  title: string;
  body: string;
  tag: string;
  target: NotificationTarget | null;
}

const TITLE_MAX = 200;
const BODY_MAX = 500;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
/** Highest count the badge shows; anything above it is still "a lot". */
const BADGE_MAX = 9_999;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const idOf = (value: unknown): string | null => (typeof value === "string" && ID.test(value) ? value : null);

function parseTarget(raw: unknown): NotificationTarget | null | undefined {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw)) return undefined;
  if (raw.kind === "session") {
    const sessionId = idOf(raw.sessionId);
    return sessionId ? { kind: "session", sessionId } : undefined;
  }
  if (raw.kind === "workflow") {
    const workflowId = idOf(raw.workflowId);
    if (!workflowId) return undefined;
    return { kind: "workflow", workflowId, runId: raw.runId === null || raw.runId === undefined ? null : idOf(raw.runId) };
  }
  return undefined;
}

/** `orquester:notify`'s payload, or null when any field is not what the renderer sends. */
export function parseNotificationRequest(payload: unknown): NotificationRequest | null {
  if (!isRecord(payload)) return null;
  const { title, body, tag } = payload;
  if (typeof title !== "string" || title.trim() === "") return null;
  if (body !== undefined && typeof body !== "string") return null;
  if (typeof tag !== "string" || !TAG.test(tag)) return null;
  const target = parseTarget(payload.target);
  if (target === undefined) return null;
  return {
    title: title.trim().slice(0, TITLE_MAX),
    body: (body ?? "").trim().slice(0, BODY_MAX),
    tag,
    target
  };
}

/** `orquester:badge`'s payload: a whole count, capped; null when it is not a count. */
export function parseBadgeCount(payload: unknown): number | null {
  if (typeof payload !== "number" || !Number.isSafeInteger(payload) || payload < 0) return null;
  return Math.min(payload, BADGE_MAX);
}

/** The taskbar overlay's accessible description (Windows reads it out). */
export function badgeDescription(count: number): string {
  if (count === 0) return "";
  return `${count} session${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} your attention`;
}

/** Overlay dot colour (#e5484d, the same red as T3's badge). */
const DOT = { r: 0xe5, g: 0x48, b: 0x4d } as const;

/**
 * The Windows taskbar overlay: a red dot, as raw premultiplied BGRA pixels for
 * `nativeImage.createFromBitmap` (no canvas in this process, and no image data
 * accepted from the renderer). The count is in the overlay's description.
 */
// Adapted from T3 Code (MIT): apps/web/src/threadNotifications.ts
export function badgeOverlayBitmap(size = 16): Buffer {
  const pixels = Buffer.alloc(size * size * 4);
  const centre = size / 2;
  const radius = size / 2 - 0.5;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x + 0.5 - centre, y + 0.5 - centre);
      // One pixel of edge anti-aliasing.
      const alpha = Math.max(0, Math.min(1, radius - distance + 0.5));
      const offset = (y * size + x) * 4;
      pixels[offset] = Math.round(DOT.b * alpha);
      pixels[offset + 1] = Math.round(DOT.g * alpha);
      pixels[offset + 2] = Math.round(DOT.r * alpha);
      pixels[offset + 3] = Math.round(255 * alpha);
    }
  }
  return pixels;
}

/** How long a shown notification is held for its click handler before it is let go. */
const NOTIFICATION_HOLD_MS = 30 * 60_000;

/**
 * Shown notifications by tag. Holding one keeps its click handler from being
 * collected; a newer one with the same tag replaces it. Electron does not
 * promise a `close` event on Linux or Windows (a toast can sit in the action
 * centre for good), so each hold also lapses after 30 minutes, and the caller
 * releases on click, close and failure.
 */
export class NotificationRegistry<T> {
  private readonly held = new Map<string, { item: T; timer: ReturnType<typeof setTimeout> }>();

  /** Hold `item` under `tag`; returns the one it replaces, for the caller to close. */
  hold(tag: string, item: T): T | undefined {
    const previous = this.held.get(tag);
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(() => this.release(tag, item), NOTIFICATION_HOLD_MS);
    this.held.set(tag, { item, timer });
    return previous?.item;
  }

  /** Let go of `item`, if it is still the one held under `tag`. */
  release(tag: string, item: T): void {
    const entry = this.held.get(tag);
    if (!entry || entry.item !== item) return;
    clearTimeout(entry.timer);
    this.held.delete(tag);
  }
}
