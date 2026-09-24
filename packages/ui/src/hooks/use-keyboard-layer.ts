import { useEffect } from "react";

import { openKeyboardLayer } from "../lib/keyboard-layers";

/**
 * Hold a keyboard layer (`lib/keyboard-layers.ts`) for exactly as long as
 * `open` is true: registered when it opens, released when it closes or the
 * component unmounts.
 *
 * Every portaled overlay that closes on Escape calls this — the dropdown, the
 * composer's popover, the modal, the sheet, the context menu — so the chat's
 * capture-phase Escape listeners stand down while it is up and the Escape is
 * the overlay's to close (`components/ui/keyboard-layer-wiring.test.ts`).
 */
export function useKeyboardLayer(open: boolean): void {
  useEffect(() => (open ? openKeyboardLayer() : undefined), [open]);
}
