/**
 * The agent overlay's geometry and words, pure: which action-log rows draw a mark over the device
 * (a tap ripple with its label, a swipe trail, a typed-text bubble), and where on the screen as
 * seen (0..1, top-left 0,0, in the current orientation — the `onTouch` / `projectPoint` space).
 *
 * Action points are in points (dp on Android) in the device's orientation when it acted; the
 * lease's `screen` is its portrait size in points. A landscape device swaps the two sides.
 */

import type { DeviceActionEntry, DeviceScreen } from "@orquester/api";

export type ScreenOrientation = "portrait" | "portrait_upside_down" | "landscape_left" | "landscape_right";

export interface NormalizedPoint {
  x: number;
  y: number;
}

export type OverlayMark =
  | { kind: "tap"; id: string; at: NormalizedPoint | null; label: string; long: boolean; failed: boolean }
  | { kind: "swipe"; id: string; from: NormalizedPoint; to: NormalizedPoint; label: string; failed: boolean }
  | { kind: "text"; id: string; at: NormalizedPoint | null; text: string; failed: boolean }
  | { kind: "key"; id: string; label: string; failed: boolean };

/** How long a mark stays (spec §10.1). */
export const OVERLAY_MARK_MS = 1200;

const clamp = (value: number) => Math.min(1, Math.max(0, value));

function isLandscape(orientation: ScreenOrientation): boolean {
  return orientation === "landscape_left" || orientation === "landscape_right";
}

/** The screen's size in points in `orientation`, or null when unknown. */
function orientedScreen(screen: Pick<DeviceScreen, "width" | "height"> | undefined, orientation: ScreenOrientation): { width: number; height: number } | null {
  if (!screen || !(screen.width > 0) || !(screen.height > 0)) return null;
  const short = Math.min(screen.width, screen.height);
  const long = Math.max(screen.width, screen.height);
  return isLandscape(orientation) ? { width: long, height: short } : { width: short, height: long };
}

/** A point in points → 0..1 over the screen as seen; null without a screen size. */
function normalizePoint(point: { x: number; y: number } | undefined, screen: Pick<DeviceScreen, "width" | "height"> | undefined, orientation: ScreenOrientation): NormalizedPoint | null {
  const size = orientedScreen(screen, orientation);
  if (!point || !size || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  return { x: clamp(point.x / size.width), y: clamp(point.y / size.height) };
}

/** `@e7 Search` → `Search`; a bare `@e7` stays. */
function targetLabel(target: string | undefined): string | null {
  const text = target?.trim();
  if (!text) return null;
  const stripped = text.replace(/^@e\d+\s+/, "").trim();
  return stripped.length > 0 ? stripped : text;
}

/** A synthetic swipe through the centre for a direction-only swipe or scroll (a finger, so a scroll down moves up). */
function directionTrail(direction: string, finger: boolean): { from: NormalizedPoint; to: NormalizedPoint } | null {
  const travel = 0.28;
  const vectors: Record<string, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
  const vector = vectors[direction];
  if (!vector) return null;
  const sign = finger ? 1 : -1;
  const [dx, dy] = [vector[0] * sign * travel, vector[1] * sign * travel];
  return { from: { x: 0.5 - dx / 2, y: 0.5 - dy / 2 }, to: { x: 0.5 + dx / 2, y: 0.5 + dy / 2 } };
}

/** The direction a summary names ("Scrolled down"), for rows that carry no points. */
function directionOf(summary: string): string | null {
  const match = /\b(up|down|left|right)\b/i.exec(summary);
  return match ? match[1]!.toLowerCase() : null;
}

const KEY_WORDS: Record<string, string> = {
  home: "Home",
  back: "Back",
  enter: "Enter",
  app_switch: "App switcher",
  volume_up: "Volume up",
  volume_down: "Volume down",
  lock: "Lock"
};

/** The key a press row names ("Pressed home" → "Home"). */
function keyLabel(summary: string): string {
  const lower = summary.toLowerCase();
  for (const [key, label] of Object.entries(KEY_WORDS)) {
    if (lower.includes(key.replace("_", " ")) || lower.includes(key)) return label;
  }
  return summary.replace(/^pressed\s+/i, "") || "Key";
}

/** The text a typing row typed: its quoted part, else its summary. */
function typedText(summary: string): string {
  const quoted = /[“"](.+)[”"]/.exec(summary);
  return (quoted ? quoted[1]! : summary).slice(0, 120);
}

/** The mark an agent's action draws, or null (reads, app launches, and the user's own input). */
export function overlayMarkOf(entry: DeviceActionEntry, screen: Pick<DeviceScreen, "width" | "height"> | undefined, orientation: ScreenOrientation): OverlayMark | null {
  if (entry.actor !== "agent") return null;
  const failed = !entry.ok;
  switch (entry.kind) {
    case "tap":
    case "long_press":
      return {
        kind: "tap",
        id: entry.id,
        at: normalizePoint(entry.point, screen, orientation),
        label: targetLabel(entry.target) ?? entry.summary,
        long: entry.kind === "long_press",
        failed
      };
    case "swipe":
    case "scroll": {
      const from = normalizePoint(entry.from, screen, orientation);
      const to = normalizePoint(entry.to, screen, orientation);
      const direction = directionOf(entry.summary);
      const trail = from && to ? { from, to } : direction ? directionTrail(direction, entry.kind === "swipe") : null;
      return trail ? { kind: "swipe", id: entry.id, ...trail, label: entry.summary, failed } : null;
    }
    case "fill":
    case "type":
      return { kind: "text", id: entry.id, at: normalizePoint(entry.point, screen, orientation), text: typedText(entry.summary), failed };
    case "press":
      return { kind: "key", id: entry.id, label: keyLabel(entry.summary), failed };
    default:
      return null;
  }
}

/**
 * The rows that arrived since the overlay last looked (`seen` ids), oldest first: only actions that
 * happen while the device is on screen animate, never the history a load brings.
 */
export function newOverlayEntries(entries: readonly DeviceActionEntry[], seen: ReadonlySet<string>): DeviceActionEntry[] {
  return entries.filter((entry) => !seen.has(entry.id));
}
