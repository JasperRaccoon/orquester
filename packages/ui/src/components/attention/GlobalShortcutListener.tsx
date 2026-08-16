import React, { useEffect, useRef } from "react";
import { useApi } from "../../context/orquester-context";
import type { ApiClient } from "../../lib/api-client";
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
 * `stopPropagation` matter because xterm sees `Ctrl+Shift+A` as plain `Ctrl+A`
 * and would encode `\x01` (beginning of line) into the focused PTY.
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
 * A blocking layer owns the screen: jumping a tab out from under an open
 * Settings modal, close-confirmation or palette would leave the layer floating
 * over a view the user never asked for. Same gate the palette's own opener uses.
 */
function anotherLayerHasTheKeyboard(): boolean {
  const state = useAppStore.getState();
  return (
    state.settingsOpen ||
    state.authPrompt !== null ||
    state.pendingCloseTabId !== null ||
    isCommandPaletteOpen()
  );
}

export const GlobalShortcutListener: React.FC = () => {
  const api = useApi();
  const cursorRef = useRef<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (matchesAttentionCycle(event)) {
        if (anotherLayerHasTheKeyboard()) {
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
