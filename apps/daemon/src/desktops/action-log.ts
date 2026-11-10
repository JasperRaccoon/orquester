// Each desktop's action log (spec 2026-11-10 §3.3): the last DESKTOP_ACTION_LOG_LIMIT automation
// actions, reads included, in memory only (a restart starts it empty; it goes when the desktop
// closes), oldest first. The automation service appends a row for every action and sends it out
// as `desktop.action`; the tab's overlay and Activity list draw from it. Typed text is kept cut to
// 60 characters; clipboard contents never are.

import { randomUUID } from "node:crypto";
import {
  DESKTOP_ACTION_LOG_LIMIT,
  type DesktopActionEntry,
  type DesktopActionKind,
  type DesktopModifier,
  type DesktopMouseButton,
  type DesktopScrollDirection
} from "@orquester/api";

/** A row before the log stamps it. */
export type DesktopActionDraft = Omit<DesktopActionEntry, "id" | "at">;

const SUMMARY_MAX_CHARS = 200;
/** What a `type` row keeps of the text (in its summary too). */
export const DESKTOP_LOGGED_TEXT_MAX_CHARS = 60;

export class DesktopActionLog {
  private readonly logs = new Map<string, DesktopActionEntry[]>();

  constructor(private readonly options: { now?: () => Date } = {}) {}

  /** Append a row (stamped with an id and time; the summary one short line); returns it. */
  append(desktopId: string, draft: DesktopActionDraft): DesktopActionEntry {
    const summary = draft.summary.replace(/\s+/g, " ").trim();
    const entry: DesktopActionEntry = {
      ...draft,
      id: randomUUID(),
      at: (this.options.now?.() ?? new Date()).toISOString(),
      summary: summary.length > SUMMARY_MAX_CHARS ? `${summary.slice(0, SUMMARY_MAX_CHARS - 1)}…` : summary
    };
    const log = this.logs.get(desktopId) ?? [];
    log.push(entry);
    if (log.length > DESKTOP_ACTION_LOG_LIMIT) log.splice(0, log.length - DESKTOP_ACTION_LOG_LIMIT);
    this.logs.set(desktopId, log);
    return entry;
  }

  /** The desktop's rows, oldest first (a copy). */
  list(desktopId: string): DesktopActionEntry[] {
    return [...(this.logs.get(desktopId) ?? [])];
  }

  /** The desktop closed: its log goes. */
  forget(desktopId: string): void {
    this.logs.delete(desktopId);
  }
}

// ---------------------------------------------------------------------------
// Summaries ("Clicked at 412, 300", "Typed “hello”", "Pressed Ctrl+Shift+T")
// ---------------------------------------------------------------------------

/** What a summary is made of: the action as run, coordinates in display pixels. */
export interface DesktopActionFacts {
  kind: DesktopActionKind;
  point?: { x: number; y: number };
  to?: { x: number; y: number };
  button?: DesktopMouseButton;
  count?: number;
  modifiers?: readonly DesktopModifier[];
  direction?: DesktopScrollDirection;
  amount?: number;
  keys?: string;
  repeat?: number;
  /** type: the text (cut here); clipboard_set: only its length is told. */
  text?: string;
  wait?: { for: "idle" | "change"; waitedMs: number; timedOut: boolean };
}

const MODIFIER_LABELS: Record<DesktopModifier, string> = { ctrl: "Ctrl", shift: "Shift", alt: "Alt", super: "Super" };

/** Key names as a person reads them; anything else is kept as given (X keysym names are case-sensitive). */
const KEY_LABELS: Record<string, string> = {
  ctrl: "Ctrl", control: "Ctrl", shift: "Shift", alt: "Alt", option: "Alt",
  super: "Super", cmd: "Super", meta: "Super", win: "Super",
  enter: "Enter", return: "Return", esc: "Esc", escape: "Esc", tab: "Tab", space: "Space",
  backspace: "Backspace", delete: "Delete", del: "Delete", insert: "Insert", home: "Home", end: "End",
  pageup: "PageUp", page_up: "PageUp", pagedown: "PageDown", page_down: "PageDown",
  up: "Up", down: "Down", left: "Left", right: "Right", menu: "Menu", print: "Print", capslock: "CapsLock"
};

/** "ctrl+shift+t" → "Ctrl+Shift+T", "alt+f4" → "Alt+F4". */
export function keyComboLabel(keys: string): string {
  const parts = keys.split("+").filter((part) => part !== "");
  // A trailing "+" names the plus key itself ("ctrl++").
  if (keys.endsWith("+")) parts.push("+");
  return parts
    .map((part) => {
      const lower = part.toLowerCase();
      if (KEY_LABELS[lower]) return KEY_LABELS[lower];
      if (/^f\d{1,2}$/.test(lower) || [...part].length === 1) return part.toUpperCase();
      return part;
    })
    .join("+");
}

/** The first {@link DESKTOP_LOGGED_TEXT_MAX_CHARS} characters of typed text (never split inside one). */
export function loggedText(text: string): string {
  const chars = [...text];
  return chars.length <= DESKTOP_LOGGED_TEXT_MAX_CHARS ? text : `${chars.slice(0, DESKTOP_LOGGED_TEXT_MAX_CHARS - 1).join("")}…`;
}

const at = (point: { x: number; y: number }): string => `${point.x}, ${point.y}`;

function seconds(ms: number): string {
  const value = (ms / 1000).toFixed(1);
  return `${value.endsWith(".0") ? value.slice(0, -2) : value} s`;
}

function withModifiers(text: string, modifiers: readonly DesktopModifier[] | undefined): string {
  return modifiers && modifiers.length > 0 ? `${text} with ${modifiers.map((m) => MODIFIER_LABELS[m]).join("+")}` : text;
}

function clickWord(button: DesktopMouseButton, count: number): string {
  const times = count === 3 ? "Triple-" : count === 2 ? "Double-" : "";
  const which = button === "right" ? "right-" : button === "middle" ? "middle-" : "";
  const word = `${times}${which}clicked`;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** The log line of a successful action. */
export function actionSummary(facts: DesktopActionFacts): string {
  const button = facts.button ?? "left";
  switch (facts.kind) {
    case "screenshot":
      return "Took a screenshot";
    case "wait": {
      const wait = facts.wait ?? { for: "idle", waitedMs: 0, timedOut: false };
      const what = wait.for === "idle" ? "settle" : "change";
      return `Waited ${seconds(wait.waitedMs)} for the screen to ${what}${wait.timedOut ? " (timed out)" : ""}`;
    }
    case "move":
      return `Moved the pointer to ${at(facts.point!)}`;
    case "click":
      return withModifiers(`${clickWord(button, facts.count ?? 1)} at ${at(facts.point!)}`, facts.modifiers);
    case "mouse_down":
      return `Pressed the ${button} button at ${at(facts.point!)}`;
    case "mouse_up":
      return `Released the ${button} button at ${at(facts.point!)}`;
    case "drag":
      return withModifiers(`Dragged from ${at(facts.point!)} to ${at(facts.to!)}`, facts.modifiers);
    case "scroll":
      return withModifiers(`Scrolled ${facts.direction} ${facts.amount ?? 3} at ${at(facts.point!)}`, facts.modifiers);
    case "key": {
      const repeat = facts.repeat ?? 1;
      return `Pressed ${keyComboLabel(facts.keys ?? "")}${repeat > 1 ? ` ×${repeat}` : ""}`;
    }
    case "type":
      return `Typed “${loggedText(facts.text ?? "")}”`;
    case "clipboard_get":
      return "Read the clipboard";
    case "clipboard_set": {
      const length = [...(facts.text ?? "")].length;
      return `Set the clipboard (${length} character${length === 1 ? "" : "s"})`;
    }
  }
}

const FAILED: Record<DesktopActionKind, string> = {
  screenshot: "take a screenshot",
  wait: "wait for the screen",
  move: "move the pointer",
  click: "click",
  mouse_down: "press a mouse button",
  mouse_up: "release a mouse button",
  drag: "drag",
  scroll: "scroll",
  key: "press keys",
  type: "type",
  clipboard_get: "read the clipboard",
  clipboard_set: "set the clipboard"
};

/** The log line of an action that failed or was refused (its error goes in the row's `error`). */
export function failedActionSummary(kind: DesktopActionKind, keys?: string): string {
  return kind === "key" && keys ? `Could not press ${keyComboLabel(keys)}` : `Could not ${FAILED[kind]}`;
}
