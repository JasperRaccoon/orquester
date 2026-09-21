// Ported from T3 Code (MIT): apps/web/src/components/chat/ChatComposer.tsx (openControl),
// packages/shared/src/keybindings.ts
/**
 * One keybinding handler drives every composer control (spec §7.4).
 *
 * **Every composer control carries a `data-composer-shortcut` token.**
 * `openComposerControl` un-collapses and focuses the composer, then queries
 * `button[data-composer-shortcut~="<command>"]:not(:disabled)` inside the
 * composer shell, skipping `[inert]` and invisible nodes, and focuses and
 * clicks the match. That replaces one imperative handle per control — model,
 * effort, account, runtime mode, plan — with a DOM convention: a control that
 * moves into an overflow menu keeps working, and a menu that absorbs two
 * controls carries both tokens (the attribute is space-separated, matched with
 * `~=`).
 *
 * *T3: `ChatComposer.tsx:5880-5901` (`openControl`), `:1116` and
 * `CompactComposerControlsMenu.tsx:44-46` (the attribute sites, including the
 * multi-token value).*
 */

/** The tokens a control may advertise. */
export const COMPOSER_SHORTCUT_COMMANDS = [
  "model",
  "effort",
  "account",
  "mode",
  "plan",
  "attach",
  "send",
  "stop"
] as const;

export type ComposerShortcutCommand = (typeof COMPOSER_SHORTCUT_COMMANDS)[number];

/** The keydown fields the matcher reads, so it can be exercised as data. */
export interface ComposerKeyEvent {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat?: boolean;
}

/**
 * A composer keybinding. `key` is the platform-neutral chord the `Kbd`
 * primitive renders; `code` is what the matcher actually compares, so a layout
 * that rewrites `key` under a modifier still resolves.
 */
export interface ComposerKeybinding {
  key: string;
  code: string;
  command: ComposerShortcutCommand | "steerQueued";
}

/**
 * The table. It is a table rather than a set of per-component handlers because
 * **the one conflict on this host is resolved here, once**: T3 binds the
 * runtime-mode picker to `mod+shift+a`, which Orquester's Attention Center
 * already owns (`GlobalShortcutListener`), so the mode picker gets its own key
 * and nothing else moves.
 *
 * *T3: `keybindings.ts:44-55` — `composer.mode` (`mod+shift+a`),
 * `composer.effort`, `modelPicker.toggle` (`mod+shift+m`),
 * `thread.steerQueuedMessage` (`mod+shift+enter`).*
 */
export const COMPOSER_KEYBINDINGS: readonly ComposerKeybinding[] = [
  { key: "mod+shift+m", code: "KeyM", command: "model" },
  { key: "mod+shift+e", code: "KeyE", command: "effort" },
  // differs from T3: `mod+shift+a` is the Attention Center's on this host.
  { key: "mod+shift+y", code: "KeyY", command: "mode" },
  { key: "mod+shift+enter", code: "Enter", command: "steerQueued" }
];

/** Held keys must not machine-gun, and Alt is somebody else's chord. */
function isChordCandidate(event: ComposerKeyEvent): boolean {
  return !event.repeat && !event.altKey && event.shiftKey && (event.ctrlKey || event.metaKey);
}

export function matchComposerKeybinding(
  event: ComposerKeyEvent
): ComposerKeybinding["command"] | null {
  if (!isChordCandidate(event)) return null;
  for (const binding of COMPOSER_KEYBINDINGS) {
    const matches = event.code
      ? event.code === binding.code
      : event.key.toLowerCase() === binding.code.replace(/^Key/, "").toLowerCase();
    if (matches) return binding.command;
  }
  return null;
}

/** The chord to print beside a control, or `null` when it has no key. */
export function shortcutComboFor(command: ComposerShortcutCommand): string | null {
  return COMPOSER_KEYBINDINGS.find((binding) => binding.command === command)?.key ?? null;
}

/**
 * The first enabled, visible, non-inert control advertising `command`.
 *
 * `checkVisibility` is behind a capability check because jsdom and older
 * engines do not implement it; the fallback (an element with a layout box) is
 * the same question asked less precisely.
 */
export function findComposerShortcutTarget(
  shell: ParentNode | null | undefined,
  command: ComposerShortcutCommand
): HTMLElement | null {
  if (!shell) return null;
  const candidates = Array.from(
    shell.querySelectorAll<HTMLElement>(
      `button[data-composer-shortcut~="${command}"]:not(:disabled)`
    )
  );
  return (
    candidates.find((element) => {
      if (element.closest("[inert]")) return false;
      const withCheck = element as HTMLElement & {
        checkVisibility?: (options?: { visibilityProperty?: boolean }) => boolean;
      };
      if (typeof withCheck.checkVisibility === "function") {
        return withCheck.checkVisibility({ visibilityProperty: true });
      }
      return element.offsetParent !== null || element.getClientRects().length > 0;
    }) ?? null
  );
}
