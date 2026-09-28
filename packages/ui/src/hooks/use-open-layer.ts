import { useEffect } from "react";

import { openLayer } from "../lib/open-layers";

/**
 * Count the calling layer as open while `open` is true and it is mounted, so
 * the key handlers that read `anotherLayerOwnsTheKeyboard` stand down for it
 * and its own Escape listener gets the key (`lib/open-layers.ts`).
 *
 * **A registered layer must be able to close on its own Escape.** While it is
 * open, the chat stands down for it: Escape neither stops the turn nor leaves
 * the drill-in, the question card's 1–9 keys answer nothing, and
 * `Ctrl+Shift+A` does not jump. A layer that stays registered while its own
 * listener refuses the key therefore leaves all of that dead until something
 * else closes it. `ComposerPopover`'s listener refuses while its trigger has
 * no layout box; it is safe only because it also closes whenever the visible
 * chat tab moves away from its own thread (`dismissWhenChatTabLeaves`), which
 * is when a trigger loses its box. A layer that cannot take its Escape must
 * close, or pass `open: false`.
 *
 * An effect of its own, keyed on `open` alone: a layer's Escape listener
 * re-binds whenever its `onClose` changes identity, and the registration must
 * not churn with it. A passive effect, like every layer's own Escape listener,
 * and called ahead of it: a layer counts as open no later than it can close on
 * Escape. (A layout effect would also warn under the static renderer the
 * render checks use.)
 */
export function useOpenLayer(open: boolean): void {
  useEffect(() => open ? openLayer() : undefined, [open]);
}
