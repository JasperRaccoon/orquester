import React, { useEffect, useRef } from "react";
import { useApi } from "../../context/orquester-context";
import type { ApiClient } from "../../lib/api-client";
import { isAnyLayerOpen } from "../../lib/open-layers";
import { ensureProjectIndex } from "../../lib/project-index";
import { insideShortcutBailZone } from "../../lib/session-nav";
import { useAppStore } from "../../store/app";
import { isCommandPaletteOpen, toggleCommandPalette } from "../command-palette";
import { agentSessionsSnapshot, focusAgentSession, verifiedAgentSessions } from "./agent-sessions";

/**
 * The app's single keyboard-shortcut listener: one capture-phase handler on
 * `window`, so a surface that owns its own keys (see `insideShortcutBailZone`)
 * can be excluded once, in one place.
 *
 * `Ctrl+Shift+A` steps through the Needs-Attention agents, newest flag first,
 * wrapping at the end. A cursor is required rather than "always take the top
 * one": focusing a tab clears only the bell/hook `attention`, not the
 * structural `waiting` state, so a session stuck at a permission prompt stays
 * in the group and would otherwise trap every press. Capture phase + a
 * `stopPropagation` keep the chord from the focused surface's own key
 * handling: a Design Mode browser tab forwards every keydown to its remote
 * page (`BrowserView`), and on macOS CodeMirror's emacs-style `Ctrl-Shift-a`
 * extends the selection. (Not xterm any more: `@xterm/xterm` 6.0.0 maps
 * Ctrl+letter to a C0 byte only without Shift, so the chord never reaches a
 * PTY as `\x01` on this version.)
 *
 * `Ctrl/Cmd+K` toggles the command palette, which owns the open state — the
 * shortcut only asks, and swallows the key only if the palette took it (a
 * disconnected client, or one with a blocking modal up, leaves it alone).
 */
/** The keydown fields the matchers read (so they can be exercised as data). */
export interface ShortcutEventLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat?: boolean;
}

/** A held key must not machine-gun the cycle, and Alt is somebody else's chord. */
function isChordCandidate(event: ShortcutEventLike): boolean {
  return !event.repeat && !event.altKey;
}

/** `Ctrl+Shift+A` — matched on the printable key only, never on two axes at once. */
export function matchesAttentionCycle(event: ShortcutEventLike): boolean {
  return (
    isChordCandidate(event) &&
    event.ctrlKey &&
    event.shiftKey &&
    !event.metaKey &&
    event.key.toLowerCase() === "a"
  );
}

/**
 * `Ctrl/Cmd+K` — matched on the physical key, so it survives a layout where the
 * modifier rewrites `key`; `key` is only the fallback for synthetic events that
 * carry no `code`.
 */
export function matchesPaletteToggle(event: ShortcutEventLike): boolean {
  const isK = event.code ? event.code === "KeyK" : event.key.toLowerCase() === "k";
  return (
    isChordCandidate(event) && isK && !event.shiftKey && (event.ctrlKey || event.metaKey)
  );
}

/**
 * A layer owns the screen and the keyboard: jumping a tab out from under an
 * open Settings modal, close-confirmation, palette, viewer or menu would leave
 * the layer floating over a view the user never asked for, and an Escape meant
 * to close it would act on the view beneath instead.
 *
 * The set is every layer that closes on Escape: the store's modals, the
 * palette, and whatever is registered as open (`lib/open-layers.ts` — every
 * `Modal`, `BottomSheet`, `Dropdown`, `ContextMenu`, `ComposerPopover` and the
 * `CommandPalette`, through `useOpenLayer`, and the right rail's dock while
 * focus is inside it, `useDockKeyboardLayer`). Those close from their own
 * `document` listeners, which every `window` capture handler runs before, and
 * the chat's Escape
 * stops the event when it acts: a layer missing from this set lost its
 * Escape to it.
 *
 * Exported because the chat's own keys — its Escape handlers (the shell's
 * listener in `AgentChatView` and the composer's two arms) and the question
 * card's 1–9 — must stand down for exactly the same set: two copies of this
 * list would drift, and the drift would only show up as a shortcut firing
 * under a modal.
 */
export function anotherLayerOwnsTheKeyboard(): boolean {
  const state = useAppStore.getState();
  return (
    state.settingsOpen ||
    state.authPrompt !== null ||
    state.pendingCloseTabId !== null ||
    isCommandPaletteOpen() ||
    isAnyLayerOpen()
  );
}

export const GlobalShortcutListener: React.FC = () => {
  const api = useApi();
  const cursorRef = useRef<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (matchesAttentionCycle(event)) {
        if (anotherLayerOwnsTheKeyboard()) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        void cycleAttention(api, cursorRef);
        return;
      }
      if (!matchesPaletteToggle(event)) {
        return;
      }
      // Ctrl+K is readline's kill-line in a terminal and belongs to the remote
      // page in a browser tab — never steal it there.
      if (insideShortcutBailZone(event.target)) {
        return;
      }
      if (toggleCommandPalette()) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [api]);

  return null;
};

/**
 * Async because the archived curtain has to be re-verified before we navigate:
 * the store alone cannot tell an archived project of another workspace from a
 * live one, so an unverified session is never a jump target. The index is
 * cached and the fetch deduped, so only the first press of a session pays for
 * it; every later press resolves immediately.
 */
async function cycleAttention(
  api: ApiClient,
  cursorRef: React.MutableRefObject<string | null>
): Promise<void> {
  const snapshot = agentSessionsSnapshot();
  const index = await ensureProjectIndex(api, useAppStore.getState().workspaces);
  const flagged = verifiedAgentSessions(snapshot, index).filter(
    (entry) => entry.bucket === "attention"
  );
  if (flagged.length === 0) {
    return;
  }
  // findIndex → -1 when the cursor's session left the group, so (-1 + 1) = 0
  // lands on the newest flag — the same place a first press goes.
  const at = flagged.findIndex((entry) => entry.session.id === cursorRef.current);
  const next = flagged[(at + 1) % flagged.length];
  cursorRef.current = next.session.id;
  focusAgentSession(next);
}
