/**
 * The Usage view's keyboard shortcuts (spec §6.4): `c` / `t` / `l` pick the
 * tab, plain `1`–`4` the range (not on Limits, which has none). No modifiers:
 * ⌘⇧3 / ⌘⇧4 are macOS screenshots. They stand down while the user types (an
 * input, textarea, select or contenteditable) and while a dialog or menu is
 * open (`isAnyLayerOpen`, or a target inside a `role="dialog"` such as a `Modal`).
 */

import { shortcutKeys, isAppleLike } from "../agent-chat/primitives/shortcut";
import type { UsageRangeOption, UsageTab } from "./types";

export const USAGE_TAB_SHORTCUTS: Readonly<Record<UsageTab, string>> = { cost: "c", tokens: "t", limits: "l" };

export const USAGE_RANGE_SHORTCUTS: Readonly<Record<UsageRangeOption, string>> = {
  "24h": "1",
  "7d": "2",
  "30d": "3",
  "90d": "4"
};

const RANGE_BY_KEY: Readonly<Record<string, UsageRangeOption>> = { "1": "24h", "2": "7d", "3": "30d", "4": "90d" };
const TAB_BY_KEY: Readonly<Record<string, UsageTab>> = { c: "cost", t: "tokens", l: "limits" };

/** The parts of a `KeyboardEvent` the resolver reads. */
export interface UsageShortcutEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
  target: EventTarget | null;
}

export interface UsageShortcutContext {
  /** The tab showing now (ranges do nothing on Limits). */
  tab: UsageTab;
  /** A dialog, sheet or menu is open somewhere in the app. */
  layerOpen: boolean;
}

export type UsageShortcut = { kind: "tab"; tab: UsageTab } | { kind: "range"; range: UsageRangeOption };

interface TargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
}

function typingOrInDialog(target: EventTarget | null): boolean {
  const el = target as TargetLike | null;
  if (!el || typeof el !== "object") return false;
  const tag = typeof el.tagName === "string" ? el.tagName.toUpperCase() : "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable === true) return true;
  return typeof el.closest === "function" && el.closest('[role="dialog"],[aria-modal="true"],[contenteditable="true"]') != null;
}

/** What a keydown does in the Usage view, or null when it is not one of its shortcuts (or must not act). */
export function resolveUsageShortcut(event: UsageShortcutEvent, context: UsageShortcutContext): UsageShortcut | null {
  if (event.defaultPrevented || event.repeat || event.isComposing) return null;
  if (context.layerOpen || typingOrInDialog(event.target)) return null;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  const range = RANGE_BY_KEY[event.key];
  if (range) return context.tab === "limits" ? null : { kind: "range", range };
  const tab = TAB_BY_KEY[event.key.toLowerCase()];
  return tab ? { kind: "tab", tab } : null;
}

/** "7 days (2)" / "Cost (C)": a control's title with its shortcut. */
export function shortcutTitle(label: string, combo: string): string {
  return `${label} (${shortcutKeys(combo).join(isAppleLike() ? "" : "+")})`;
}
