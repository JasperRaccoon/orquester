/**
 * The composer's half of the `data-composer-shortcut` convention (spec §7.4).
 *
 * **The keybinding table itself is not here.** It lives in
 * `lib/agent-chat/keybindings.logic.ts` (W11) and that is the single source of
 * truth for every chord, including the one conflict this host has: T3 binds
 * the runtime-mode picker to `Ctrl/Cmd+Shift+A`, which the Attention Center
 * already owns, so the table moves it to `Ctrl/Cmd+Shift+M`. This module used
 * to carry a second table that had resolved the same conflict differently
 * (`mod+shift+y`); two tables meant the label a chip printed and the chord that
 * actually fired could disagree, which is exactly the bug a single table
 * exists to prevent.
 *
 * What remains here is the DOM half — finding the control a command names —
 * plus the thin adapters the composer components call.
 */

import {
  chatShortcutLabel,
  composerControlSelector,
  isOperableControl,
  resolveChatShortcut,
  type ChatShortcutCommand,
  type ChatShortcutEventLike,
  type ComposerControlCommand
} from "../../../lib/agent-chat/keybindings.logic";
import { isAppleLike } from "../primitives";

/** Re-exported under the name the composer components already use. */
export type ComposerShortcutCommand = ComposerControlCommand;
export type { ChatShortcutCommand, ChatShortcutEventLike };
export { resolveChatShortcut };

/**
 * The chord to print beside a control, already resolved for this platform, or
 * `null` when the command has no chord. Pass it to `Kbd` as children — the
 * label is platform-resolved text, not a neutral `mod+…` combo.
 */
export function shortcutLabelFor(
  command: ComposerShortcutCommand,
  apple = isAppleLike()
): string | null {
  return chatShortcutLabel({ kind: "control", command }, apple);
}

/**
 * The first enabled, visible, non-inert control advertising `command`.
 *
 * The selector and the operability rule both come from the shared module, so a
 * control that moves into an overflow menu keeps working and a menu that
 * absorbs two controls can carry both tokens (the attribute is
 * space-separated, matched with `~=`).
 */
export function findComposerShortcutTarget(
  shell: ParentNode | null | undefined,
  command: ComposerShortcutCommand
): HTMLElement | null {
  if (!shell) return null;
  const candidates = Array.from(
    shell.querySelectorAll<HTMLElement>(composerControlSelector(command))
  );
  return candidates.find((element) => isOperableControl(element)) ?? null;
}
