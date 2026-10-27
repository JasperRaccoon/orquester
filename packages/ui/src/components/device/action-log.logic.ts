/**
 * The action log drawer's rows, pure: the daemon's log (agent and user actions it recorded) merged
 * with what this panel did itself (buttons, gestures, control changes) and has not seen echoed
 * back, oldest first, with times, actors and failures; plus the windowing the drawer virtualizes with.
 */

import type { DeviceActionEntry, DeviceActor } from "@orquester/api";

/** Something this panel did, logged locally (the daemon may not record panel input). */
export interface LocalDeviceAction {
  id: string;
  leaseId: string;
  at: string;
  summary: string;
  ok: boolean;
  error?: string;
}

export interface ActionLogRow {
  id: string;
  at: number;
  /** "14:02:31". */
  time: string;
  actor: DeviceActor;
  /** "Claude", "You". */
  who: string;
  text: string;
  failed: boolean;
  /** Why it failed, in one line. */
  error: string | null;
}

function clock(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The log as the drawer lists it: merged, de-duplicated by id, ordered by time (stable). */
export function actionLogRows(
  entries: readonly DeviceActionEntry[],
  local: readonly LocalDeviceAction[],
  agentName: string,
  limit = 400
): ActionLogRow[] {
  const rows: ActionLogRow[] = [];
  const ids = new Set<string>();
  const push = (row: ActionLogRow) => {
    if (ids.has(row.id)) return;
    ids.add(row.id);
    rows.push(row);
  };
  for (const entry of entries) {
    const at = Date.parse(entry.at);
    if (!Number.isFinite(at)) continue;
    push({
      id: entry.id,
      at,
      time: clock(at),
      actor: entry.actor,
      who: entry.actor === "agent" ? agentName : "You",
      text: oneLine(entry.summary) || entry.kind,
      failed: !entry.ok,
      error: entry.ok ? null : oneLine(entry.error ?? "") || "Failed"
    });
  }
  for (const action of local) {
    const at = Date.parse(action.at);
    if (!Number.isFinite(at)) continue;
    push({
      id: `local:${action.id}`,
      at,
      time: clock(at),
      actor: "user",
      who: "You",
      text: oneLine(action.summary),
      failed: !action.ok,
      error: action.ok ? null : oneLine(action.error ?? "") || "Failed"
    });
  }
  // Stable: equal times keep their arrival order.
  return rows.sort((a, b) => a.at - b.at).slice(-limit);
}

/** The collapsed drawer's one line: "12 actions · Tapped “Search”" (null with nothing logged). */
export function actionLogHeadline(rows: readonly ActionLogRow[]): { count: string; last: ActionLogRow | null } {
  const last = rows.at(-1) ?? null;
  return { count: rows.length === 1 ? "1 action" : `${rows.length} actions`, last };
}

/** A user gesture's log line: a tap, a long press, or a swipe by how far and how long it went. */
export function gestureSummary(from: { x: number; y: number }, to: { x: number; y: number }, ms: number): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 0.02) return ms >= 500 ? "Long-pressed the screen" : "Tapped the screen";
  const direction = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
  return `Swiped ${direction}`;
}

/** The slice of a fixed-height list to render: `[start, end)` with `overscan` rows either side. */
export function visibleRange(scrollTop: number, viewport: number, rowHeight: number, count: number, overscan = 6): { start: number; end: number } {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const first = Math.min(count, Math.floor(Math.max(0, scrollTop) / rowHeight));
  const visible = Math.ceil(Math.max(0, viewport) / rowHeight) + 1;
  const start = Math.min(count, Math.max(0, first - overscan));
  const end = Math.min(count, first + visible + overscan);
  return { start, end: Math.max(start, end) };
}
