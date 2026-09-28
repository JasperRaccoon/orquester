/**
 * The right rail's per-device state: which panel is docked beside the tab
 * content (desktop) and how wide the dock is. (A phone's section is not a
 * preference: `mobile-section.ts`, in memory.)
 *
 * A viewing preference, so it is persisted per device in localStorage and
 * never synced through the daemon — the same mold as `lib/panel-sizes.ts` and
 * `lib/view-mode.ts`: SSR-safe, every storage error swallowed, and the payload
 * validated FIELD BY FIELD on load, with a fallback per field. A payload an
 * older or newer bundle wrote outlives every deploy (AGENTS.md, "Adapter/
 * localStorage loads must go through a schema…"), so one bad field costs only
 * itself and nothing here can throw on what it reads.
 *
 * Stored under `orquester:right-rail` as
 * `{ "v": 1, "open": "prompts" | "history" | "workflows" | "profile" | null, "width": <px> }`. (Earlier
 * bundles also wrote a `sheet` field, the mobile sheet's last tab: ignored now,
 * and gone at the next write.)
 * `v` is written for a future migration; this version reads any payload field
 * by field whatever its `v`, so a rollback after a newer bundle wrote v2 keeps
 * whatever still validates.
 *
 * A tiny module store read through `useSyncExternalStore` — deliberately not a
 * slice of `store/app.ts`: nothing else in the app reads it, and a width drag
 * writes it every frame.
 */

import React from "react";

import type { RightRailPanelId } from "./types";

const RIGHT_RAIL_STORAGE_KEY = "orquester:right-rail";
const RIGHT_RAIL_STATE_VERSION = 1;

/** The dock's width (px): default, and the range a drag or a stored value is clamped into. */
export const RIGHT_RAIL_WIDTH_DEFAULT = 320;
export const RIGHT_RAIL_WIDTH_MIN = 260;
export const RIGHT_RAIL_WIDTH_MAX = 560;
/** The icon rail's own width (`w-11`). */
const RIGHT_RAIL_BAR_WIDTH = 44;
/**
 * What the tab content always keeps beside the dock and the rail (px). It wins
 * over the dock's minimum: a row too narrow for both draws the dock narrower.
 */
const RIGHT_RAIL_CONTENT_MIN = 360;

export interface RightRailState {
  /** The panel docked beside the tab content (desktop), or `null` with the dock closed. */
  readonly open: RightRailPanelId | null;
  /** The dock's width in px, within `[RIGHT_RAIL_WIDTH_MIN, RIGHT_RAIL_WIDTH_MAX]`. */
  readonly width: number;
}

export const RIGHT_RAIL_DEFAULT_STATE: RightRailState = Object.freeze({
  open: null,
  width: RIGHT_RAIL_WIDTH_DEFAULT
});

function isRightRailPanelId(value: unknown): value is RightRailPanelId {
  return value === "prompts" || value === "history" || value === "workflows" || value === "profile";
}

/* ── Clamps ─────────────────────────────────────────────────────────────── */

/** What the tab content and the rail keep beside the dock (px). */
const ROW_RESERVE = RIGHT_RAIL_BAR_WIDTH + RIGHT_RAIL_CONTENT_MIN;

/**
 * The widest the dock may be DRAWN in a row `rowWidth` px wide: the maximum,
 * and never so wide that the tab content drops below `RIGHT_RAIL_CONTENT_MIN`
 * beside the dock and the rail. The content's floor wins over the dock's
 * minimum, so in a narrow row the cap falls below `RIGHT_RAIL_WIDTH_MIN`, down
 * to 0 — the rule the dock's CSS bounds apply against the live row
 * (`RIGHT_RAIL_CSS_MIN_WIDTH` / `RIGHT_RAIL_CSS_MAX_WIDTH`). No (usable)
 * measurement → the maximum alone.
 */
function rightRailWidthCap(rowWidth?: number | null): number {
  let max = RIGHT_RAIL_WIDTH_MAX;
  if (typeof rowWidth === "number" && Number.isFinite(rowWidth) && rowWidth > 0) {
    max = Math.min(max, rowWidth - ROW_RESERVE);
  }
  return Math.max(0, Math.floor(max));
}

/**
 * {@link rightRailWidthCap}'s rule as the dock's CSS `min-width`/`max-width`,
 * resolved by the browser against the row (`100%`), so a window narrowed after
 * a drag still leaves the tab content its floor. The stored width sits between
 * them when the row has room; when it has not, both collapse to what is left.
 */
export const RIGHT_RAIL_CSS_MIN_WIDTH = `max(0px, min(${RIGHT_RAIL_WIDTH_MIN}px, 100% - ${ROW_RESERVE}px))`;
export const RIGHT_RAIL_CSS_MAX_WIDTH = `max(0px, min(${RIGHT_RAIL_WIDTH_MAX}px, 100% - ${ROW_RESERVE}px))`;

/**
 * Round to whole pixels and clamp to what the dock can be drawn at:
 * `[MIN, rightRailWidthCap(rowWidth)]`, or the cap alone when the row is too
 * narrow for the minimum. A non-finite value falls back to the default
 * (capped the same way).
 */
export function clampRightRailWidth(px: number, rowWidth?: number | null): number {
  const max = rightRailWidthCap(rowWidth);
  const rounded = Math.round(px);
  if (!Number.isFinite(rounded)) {
    return Math.min(RIGHT_RAIL_WIDTH_DEFAULT, max);
  }
  return Math.min(max, Math.max(RIGHT_RAIL_WIDTH_MIN, rounded));
}

/* ── Parse / serialize ──────────────────────────────────────────────────── */

/**
 * Any parsed value → a valid state, field by field. Only a finite positive
 * number is a width (clamped into range); only a known panel id — or, for
 * `open`, an explicit `null` — is a panel.
 */
function sanitizeRightRailState(value: unknown): RightRailState {
  const record =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const open = isRightRailPanelId(record.open) ? record.open : RIGHT_RAIL_DEFAULT_STATE.open;
  const rawWidth = record.width;
  const width =
    typeof rawWidth === "number" && Number.isFinite(rawWidth) && rawWidth > 0
      ? clampRightRailWidth(rawWidth)
      : RIGHT_RAIL_DEFAULT_STATE.width;
  return { open, width };
}

/** The stored string → a valid state. Nothing stored, or anything unparsable, is the defaults. */
export function parseRightRailState(raw: string | null | undefined): RightRailState {
  if (typeof raw !== "string" || raw.length === 0) {
    return RIGHT_RAIL_DEFAULT_STATE;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return RIGHT_RAIL_DEFAULT_STATE;
  }
  return sanitizeRightRailState(parsed);
}

export function serializeRightRailState(state: RightRailState): string {
  return JSON.stringify({
    v: RIGHT_RAIL_STATE_VERSION,
    open: state.open,
    width: state.width
  });
}

/* ── Storage ────────────────────────────────────────────────────────────── */

/** The two browser storage methods this module uses. */
interface RightRailStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * The browser's `localStorage`, or `null` where there is none (SSR, node) —
 * or where merely touching it throws (a locked-down profile).
 */
function defaultStorage(): RightRailStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Load the persisted state; the defaults on any failure. */
export function loadRightRailState(): RightRailState {
  try {
    return parseRightRailState(defaultStorage()?.getItem(RIGHT_RAIL_STORAGE_KEY));
  } catch {
    return RIGHT_RAIL_DEFAULT_STATE;
  }
}

/** Persist the state; a storage failure is non-fatal (it stays in memory). */
export function saveRightRailState(state: RightRailState): void {
  try {
    defaultStorage()?.setItem(RIGHT_RAIL_STORAGE_KEY, serializeRightRailState(state));
  } catch {
    /* ignore quota/availability errors — the state stays in memory only */
  }
}

/* ── The store ──────────────────────────────────────────────────────────── */

/** Loaded on first read, so importing this module never touches storage. */
let current: RightRailState | null = null;
const listeners = new Set<() => void>();

/** The current state — a stable object until something changes (the `useSyncExternalStore` snapshot). */
export function rightRailState(): RightRailState {
  if (current === null) {
    current = loadRightRailState();
  }
  return current;
}

export function subscribeRightRail(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The right rail's state, re-rendering on every change. */
export function useRightRailState(): RightRailState {
  return React.useSyncExternalStore(subscribeRightRail, rightRailState, rightRailState);
}

/**
 * Apply a change. `persist` writes it to storage even when the state already
 * holds it — a drag's release commits the value its last frame previewed.
 * Listeners hear only a real change, and an unchanged state keeps its object.
 */
function update(patch: Partial<RightRailState>, persist: boolean): void {
  const previous = rightRailState();
  const next: RightRailState = { ...previous, ...patch };
  const changed = next.open !== previous.open || next.width !== previous.width;
  if (changed) {
    current = next;
  }
  if (persist) {
    saveRightRailState(changed ? next : previous);
  }
  if (changed) {
    for (const listener of [...listeners]) {
      listener();
    }
  }
}

/** A rail button: open that panel, switch to it, or — when it is the open one — close the dock. */
export function toggleRightRailPanel(id: RightRailPanelId): void {
  update({ open: rightRailState().open === id ? null : id }, true);
}

/** Open a panel in the dock, or close the dock with `null`. */
export function setRightRailOpen(id: RightRailPanelId | null): void {
  update({ open: id }, true);
}

/**
 * The dock's width. A live drag passes `persist: false` on every frame and
 * `persist: true` once, on release (the sidebar's pattern); `rowWidth` caps it
 * so the tab content keeps its floor. The state keeps the width the dock gets
 * when there is room — never below the minimum: a row too narrow for it draws
 * the dock narrower (the CSS bounds) without storing that.
 */
export function setRightRailWidth(
  px: number,
  options: { persist: boolean; rowWidth?: number | null }
): void {
  const width = Math.max(RIGHT_RAIL_WIDTH_MIN, clampRightRailWidth(px, options.rowWidth));
  update({ width }, options.persist);
}

/** Double-click on the resize handle: back to the default width. */
export function resetRightRailWidth(): void {
  update({ width: RIGHT_RAIL_WIDTH_DEFAULT }, true);
}
