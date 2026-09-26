import { useEffect } from "react";

import { openLayerEffect } from "../lib/open-layers";

/**
 * Count the calling layer as open while `open` is true and it is mounted, so
 * the key handlers that read `anotherLayerOwnsTheKeyboard` stand down for it
 * and its own Escape listener gets the key (`lib/open-layers.ts`).
 *
 * An effect of its own, keyed on `open` alone: a layer's Escape listener
 * re-binds whenever its `onClose` changes identity, and the registration must
 * not churn with it. A passive effect, like every layer's own Escape listener,
 * and called ahead of it: a layer counts as open no later than it can close on
 * Escape. (A layout effect would also warn under the static renderer the
 * render checks use.)
 */
export function useOpenLayer(open: boolean): void {
  useEffect(() => openLayerEffect(open), [open]);
}
