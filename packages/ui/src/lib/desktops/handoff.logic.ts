/**
 * Desktops — the agent ↔ user handoff, pure (spec 2026-11-10 §3): reading the daemon's control
 * state and action entries (never trusted as sent), the toolbar pill, the implicit takeover, the
 * size-lock notice, the per-desktop ring of recent actions with its unseen count, and the action
 * log's rows.
 *
 * A desktop nobody automated (`control` null or absent, no actions) produces nothing here: every
 * piece of handoff UI is hidden for it.
 */

import {
  DESKTOP_ACTION_LOG_LIMIT,
  isDesktopActionKind,
  type DesktopActionEntry,
  type DesktopActionEventPayload,
  type DesktopActor,
  type DesktopControl,
  type DesktopController
} from "@orquester/api";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A short one-line text, or undefined (empty, or not a string). Longer ones are cut. */
function oneLine(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const LABEL_MAX = 60;
const SUMMARY_MAX = 200;
/** What an entry's `text` may hold (the daemon cuts typed text to 60 chars). */
export const DESKTOP_TYPED_TEXT_MAX = 60;

// ---------------------------------------------------------------------------
// Reading what the daemon sends
// ---------------------------------------------------------------------------

export function parseDesktopActor(value: unknown): DesktopActor | undefined {
  if (!isRecord(value)) return undefined;
  const label = oneLine(value.label, LABEL_MAX);
  if (label === undefined) return undefined;
  if (value.kind === "chat") {
    return typeof value.threadId === "string" && value.threadId !== "" ? { kind: "chat", threadId: value.threadId, label } : undefined;
  }
  return value.kind === "external" ? { kind: "external", label } : undefined;
}

/** `DesktopSummary.control` as the UI may use it: absent, malformed and `null` all read as `null`. */
export function parseDesktopControl(value: unknown): DesktopControl | null {
  if (!isRecord(value)) return null;
  const controller = value.controller;
  if ((controller !== "agent" && controller !== "user") || typeof value.since !== "string") return null;
  const actor = parseDesktopActor(value.actor);
  return { controller, since: value.since, ...(actor ? { actor } : {}) };
}

function point(value: unknown): { x: number; y: number } | undefined {
  return isRecord(value) && Number.isFinite(value.x) && Number.isFinite(value.y) ? { x: value.x as number, y: value.y as number } : undefined;
}

const BUTTONS = new Set(["left", "middle", "right"]);
const DIRECTIONS = new Set(["up", "down", "left", "right"]);

/** One action-log entry, or null when it is not one. Unknown fields are dropped. */
export function parseDesktopActionEntry(value: unknown): DesktopActionEntry | null {
  if (!isRecord(value)) return null;
  const { id, at, kind, ok } = value;
  const actor = parseDesktopActor(value.actor);
  if (typeof id !== "string" || id === "" || typeof at !== "string" || !Number.isFinite(Date.parse(at))) return null;
  if (!actor || !isDesktopActionKind(kind) || typeof ok !== "boolean") return null;
  const entry: DesktopActionEntry = { id, at, actor, kind, summary: oneLine(value.summary, SUMMARY_MAX) ?? kind, ok };
  const from = point(value.point);
  if (from) entry.point = from;
  const to = point(value.to);
  if (to) entry.to = to;
  if (typeof value.button === "string" && BUTTONS.has(value.button)) entry.button = value.button as DesktopActionEntry["button"];
  if (Number.isInteger(value.count) && (value.count as number) > 0) entry.count = value.count as number;
  if (typeof value.direction === "string" && DIRECTIONS.has(value.direction)) entry.direction = value.direction as DesktopActionEntry["direction"];
  // Typed text keeps its spaces; only a line's worth is ever shown.
  if (typeof value.text === "string" && value.text !== "") entry.text = value.text.slice(0, DESKTOP_TYPED_TEXT_MAX);
  const keys = oneLine(value.keys, 80);
  if (keys !== undefined) entry.keys = keys;
  if (typeof value.screenshotId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value.screenshotId)) entry.screenshotId = value.screenshotId;
  const error = oneLine(value.error, SUMMARY_MAX);
  if (error !== undefined) entry.error = error;
  return entry;
}

export function parseDesktopActionEvent(value: unknown): DesktopActionEventPayload | null {
  if (!isRecord(value) || typeof value.desktopId !== "string" || value.desktopId === "") return null;
  const entry = parseDesktopActionEntry(value.entry);
  return entry ? { desktopId: value.desktopId, entry } : null;
}

/** A `GET actionLog` answer's valid entries (anything else: none). */
export function parseDesktopActionLog(value: unknown): DesktopActionEntry[] {
  const entries = isRecord(value) && Array.isArray(value.entries) ? value.entries : [];
  return entries.map(parseDesktopActionEntry).filter((entry): entry is DesktopActionEntry => entry !== null);
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** Who acted, mid-sentence: the actor's label ("Claude"), else "the agent". */
export function actorName(actor: DesktopActor | undefined): string {
  return actor?.label ?? "the agent";
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export interface DesktopControlPill {
  tone: "agent" | "user";
  text: string;
  action: { label: string; controller: DesktopController; ariaLabel: string };
}

/** The toolbar pill (R2.4): who controls the desktop and the handoff button, or null when nobody does. */
export function desktopControlPill(control: DesktopControl | null | undefined): DesktopControlPill | null {
  if (!control) return null;
  const name = actorName(control.actor);
  if (control.controller === "agent") {
    return {
      tone: "agent",
      text: `${capitalized(name)} is controlling`,
      action: { label: "Take over", controller: "user", ariaLabel: `Take over control of the desktop from ${name}` }
    };
  }
  return {
    tone: "user",
    text: "You have control",
    action: {
      label: "Give back",
      controller: "agent",
      ariaLabel: control.actor ? `Give control of the desktop back to ${name}` : "Release control of the desktop"
    }
  };
}

/** The toast after an implicit takeover (R2.4). */
export function takeoverToastText(actor: DesktopActor | undefined): string {
  return `You took control from ${actorName(actor)}`;
}

/** R2.3: the View area's notice while an agent controls the desktop, or null. */
export function sizeLockNotice(control: DesktopControl | null | undefined): string | null {
  return control?.controller === "agent" ? `Size locked while ${actorName(control.actor)} works` : null;
}

/**
 * Whether the user's input now takes control (R2.2): only while an agent controls the desktop, and
 * once per agent stint — `tookFrom` is the `since` of the control this viewer already took over
 * (the PUT is in flight, or its `desktop.updated` has not arrived yet).
 */
export function inputTakesOver(control: DesktopControl | null | undefined, tookFrom: string | null): boolean {
  return control?.controller === "agent" && control.since !== tookFrom;
}

// ---------------------------------------------------------------------------
// The per-desktop ring of recent actions
// ---------------------------------------------------------------------------

export interface DesktopActionRing {
  /** Oldest first, at most {@link DESKTOP_ACTION_LOG_LIMIT}. */
  readonly entries: readonly DesktopActionEntry[];
  /** Live actions since the log was last looked at (the Activity badge). */
  readonly unseen: number;
  /** The daemon's log was loaded once on this connection. */
  readonly loaded: boolean;
}

export const EMPTY_DESKTOP_RING: DesktopActionRing = { entries: [], unseen: 0, loaded: false };

function byTime(a: DesktopActionEntry, b: DesktopActionEntry): number {
  return Date.parse(a.at) - Date.parse(b.at);
}

/**
 * A live `desktop.action`: appended once (by id), the ring kept to the last 50. It counts as unseen
 * unless the log is open (`viewing`).
 */
export function appendDesktopAction(ring: DesktopActionRing, entry: DesktopActionEntry, viewing: boolean): DesktopActionRing {
  if (ring.entries.some((row) => row.id === entry.id)) return ring;
  const entries = [...ring.entries, entry].sort(byTime).slice(-DESKTOP_ACTION_LOG_LIMIT);
  return { ...ring, entries, unseen: viewing ? 0 : Math.min(DESKTOP_ACTION_LOG_LIMIT, ring.unseen + 1) };
}

/** The daemon's log merged in (history: it never counts as unseen). */
export function mergeDesktopActionLog(ring: DesktopActionRing, loaded: readonly DesktopActionEntry[]): DesktopActionRing {
  const ids = new Set(ring.entries.map((entry) => entry.id));
  const fresh = loaded.filter((entry) => !ids.has(entry.id));
  const entries = fresh.length === 0 ? ring.entries : [...ring.entries, ...fresh].sort(byTime).slice(-DESKTOP_ACTION_LOG_LIMIT);
  return { ...ring, entries, loaded: true };
}

/** The badge on the Activity button, or null with nothing unseen. */
export function unseenBadge(unseen: number): string | null {
  if (!(unseen > 0)) return null;
  return unseen > 9 ? "9+" : String(unseen);
}

/** Whether the desktop shows any handoff UI at all: someone controls it, or agents acted on it. */
export function desktopHasHandoff(control: DesktopControl | null | undefined, ring: DesktopActionRing): boolean {
  return Boolean(control) || ring.entries.length > 0;
}

// ---------------------------------------------------------------------------
// The action log's rows
// ---------------------------------------------------------------------------

export interface DesktopActionLogRow {
  id: string;
  /** "14:02:31". */
  time: string;
  /** ISO, for `<time dateTime>`. */
  at: string;
  who: string;
  text: string;
  failed: boolean;
  error: string | null;
  screenshotId: string | null;
}

function clock(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** The popover's rows: newest first. */
export function desktopActionLogRows(entries: readonly DesktopActionEntry[]): DesktopActionLogRow[] {
  return [...entries].reverse().map((entry) => ({
    id: entry.id,
    time: clock(Date.parse(entry.at)),
    at: entry.at,
    who: entry.actor.label,
    text: entry.summary,
    failed: !entry.ok,
    error: entry.ok ? null : (entry.error ?? "Failed"),
    screenshotId: entry.screenshotId ?? null
  }));
}

// ---------------------------------------------------------------------------
// Key combos
// ---------------------------------------------------------------------------

const KEY_NAMES: Readonly<Record<string, string>> = {
  ctrl: "Ctrl",
  control: "Ctrl",
  shift: "Shift",
  alt: "Alt",
  option: "Alt",
  super: "Super",
  cmd: "Super",
  meta: "Super",
  win: "Super",
  enter: "Enter",
  return: "Enter",
  esc: "Esc",
  escape: "Esc",
  tab: "Tab",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  pageup: "PgUp",
  page_up: "PgUp",
  pagedown: "PgDn",
  page_down: "PgDn",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  menu: "Menu",
  print: "Print",
  capslock: "Caps Lock"
};

/** "ctrl+shift+t" → "Ctrl+Shift+T", "alt+F4" → "Alt+F4", "Return" → "Enter". */
export function formatDesktopKeys(keys: string): string {
  return keys
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => KEY_NAMES[part.toLowerCase()] ?? (/^f\d{1,2}$/i.test(part) ? part.toUpperCase() : part.length === 1 ? part.toUpperCase() : part))
    .join("+");
}
