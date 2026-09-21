/**
 * Agent chat — the composer keybinding table and the `data-composer-shortcut`
 * convention (spec §7.4).
 *
 * Ported from T3 Code (MIT): `packages/shared/src/keybindings.ts:44-55` (the
 * command names and their default chords) and
 * `apps/web/src/components/chat/ChatComposer.tsx:5880-5901` (`openControl`).
 *
 * **Every composer control carries a `data-composer-shortcut` token and one
 * keybinding handler drives them all.** `openControl(command)` un-collapses and
 * focuses the composer inside a `flushSync`, then queries
 * `button[data-composer-shortcut~="<command>"]:not(:disabled)` within the
 * composer shell, skipping `[inert]` and invisible nodes, and focuses-and-
 * clicks the match. That replaces one imperative handle per control — model,
 * account, runtime mode, plan — with a DOM convention.
 *
 * **The one conflict, resolved once, here and not per component:**
 * `Ctrl/Cmd+Shift+A` is T3's runtime-mode picker but is already the Attention
 * Center's cycle on this host (`matchesAttentionCycle` in
 * `components/attention/GlobalShortcutListener.tsx`), so the mode picker gets
 * `Ctrl/Cmd+Shift+M` instead.
 *
 * No React import.
 */

/** The keydown fields the matchers read, so they can be exercised as data. */
export interface ChatShortcutEventLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat?: boolean;
}

/**
 * Every composer control's token. The value is what goes in
 * `data-composer-shortcut`, and a control may carry several (space-separated)
 * when an overflow menu absorbs two of them — hence `~=` in the selector.
 */
export type ComposerControlCommand =
  | "model"
  | "effort"
  | "mode"
  | "plan"
  | "attach"
  | "send"
  | "stop";

/**
 * Every token that a mounted composer actually carries.
 *
 * `account` and `compact` were in this union with **no DOM target**, so
 * `openControl("account")` was a silent no-op that read like a bug (fix-wave
 * R7-12) — the account chip deliberately carries no token (see
 * `ComposerChips.tsx`) and compaction is reached through the context meter,
 * not a composer control. A token belongs here only once a control advertises
 * it.
 */
export const COMPOSER_CONTROL_COMMANDS: readonly ComposerControlCommand[] = [
  "model",
  "effort",
  "mode",
  "plan",
  "attach",
  "send",
  "stop"
];

/** Actions the composer performs directly rather than by clicking a control. */
export type ChatShortcutCommand =
  | { kind: "control"; command: ComposerControlCommand }
  | { kind: "steer-queued" }
  | { kind: "interrupt" }
  | { kind: "scroll-to-end" };

function isChordCandidate(event: ChatShortcutEventLike): boolean {
  return !event.repeat && !event.altKey;
}

const mod = (event: ChatShortcutEventLike): boolean => event.ctrlKey || event.metaKey;

/**
 * The table. One function, so a new binding is a new arm here and a new
 * `data-composer-shortcut` token on the control — never a second listener.
 */
export function resolveChatShortcut(event: ChatShortcutEventLike): ChatShortcutCommand | null {
  if (!isChordCandidate(event)) {
    return null;
  }
  const key = event.key.toLowerCase();

  // Escape interrupts when a turn is active (the caller gates on that).
  if (key === "escape" && !mod(event) && !event.shiftKey) {
    return { kind: "interrupt" };
  }
  if (!mod(event)) {
    return null;
  }
  if (event.shiftKey && key === "enter") {
    // Send the head of the queue now, leaving the current draft alone (§7.4).
    return { kind: "steer-queued" };
  }
  if (event.shiftKey && key === "m") {
    // T3 uses mod+shift+A; that chord is the Attention Center's here (§7.4).
    return { kind: "control", command: "mode" };
  }
  if (event.shiftKey) {
    return null;
  }
  switch (key) {
    case "/":
      return { kind: "control", command: "model" };
    case "e":
      return { kind: "control", command: "effort" };
    case "j":
      return { kind: "scroll-to-end" };
    default:
      return null;
  }
}

/** The human-readable chord for a command, for a tooltip or a hint row. */
export function chatShortcutLabel(
  command: ChatShortcutCommand,
  isAppleLike: boolean
): string | null {
  const modKey = isAppleLike ? "⌘" : "Ctrl";
  switch (command.kind) {
    case "interrupt":
      return "Esc";
    case "steer-queued":
      return `${modKey}+Shift+Enter`;
    case "scroll-to-end":
      return `${modKey}+J`;
    case "control":
      switch (command.command) {
        case "model":
          return `${modKey}+/`;
        case "effort":
          return `${modKey}+E`;
        case "mode":
          return `${modKey}+Shift+M`;
        default:
          return null;
      }
  }
}

/**
 * The selector `openControl` runs inside the composer shell. Kept here so the
 * attribute name has exactly one definition.
 */
export const COMPOSER_SHORTCUT_ATTRIBUTE = "data-composer-shortcut";

export function composerControlSelector(command: ComposerControlCommand): string {
  return `button[${COMPOSER_SHORTCUT_ATTRIBUTE}~="${command}"]:not(:disabled)`;
}

/**
 * Whether a matched node may actually be driven: an `[inert]` subtree and an
 * invisible node are both "present but not operable", and clicking either
 * would be a silent no-op the user reads as a broken shortcut.
 *
 * Split out from the DOM walk so it can be tested with a plain stub.
 */
export function isOperableControl(node: {
  hasAttribute?(name: string): boolean;
  closest?(selector: string): unknown;
  getClientRects?(): { length: number };
}): boolean {
  if (node.hasAttribute?.("inert")) {
    return false;
  }
  if (node.closest?.("[inert]")) {
    return false;
  }
  const rects = node.getClientRects?.();
  return rects === undefined || rects.length > 0;
}
