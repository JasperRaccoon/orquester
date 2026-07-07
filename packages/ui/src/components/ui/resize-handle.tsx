import React from "react";
import { cn } from "../../lib/cn";
import {
  useResizeDrag,
  type ResizeOrientation,
  type UseResizeDragOptions
} from "../../hooks/use-resize-drag";

export interface ResizeHandleProps extends UseResizeDragOptions {
  /**
   * Extra classes on the root. Use this for placement — e.g. a grid-view
   * divider passes absolute-positioning classes/`style` so the handle overlays
   * a track boundary; inline seams need nothing (the root sits in flow as a 1px
   * column/row and the hit area straddles it without affecting layout).
   */
  className?: string;
  style?: React.CSSProperties;
  "aria-label"?: string;
}

/**
 * A draggable divider: a 1px visible seam line (matching the neutral panel
 * borders) plus a wider invisible hit area straddling it. The hit area is
 * absolutely positioned so it never affects layout, carries `touch-action:none`
 * (Pointer Events own the gesture) and `app-no-drag` (inert on web; protects the
 * Electron titlebar drag band), and exposes `role="separator"` +
 * `aria-orientation`. Double-click resets via `onReset`.
 *
 * Wraps {@link useResizeDrag} entirely, so seam components pass only sizing
 * props (`getCurrent`/`onResize`/`onCommit`/clamp) and never touch the hook.
 */
export const ResizeHandle: React.FC<ResizeHandleProps> = ({
  className,
  style,
  "aria-label": ariaLabel,
  ...dragOpts
}) => {
  const orientation: ResizeOrientation = dragOpts.orientation;
  const vertical = orientation === "vertical";
  const { dragging, handlers } = useResizeDrag(dragOpts);

  return (
    <div
      className={cn("group relative shrink-0", vertical ? "w-0 self-stretch" : "h-0 w-full", className)}
      style={style}
    >
      {/* Idle-transparent 1px seam: the root has ZERO in-flow footprint (w-0/h-0),
          so an inline seam never adds a pixel beside its pane — the pane's own
          border-box border shows through at rest, keeping default layouts
          byte-identical to pre-feature. The seam paints only on hover/drag. */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute transition-colors group-hover:bg-neutral-600",
          dragging && "bg-neutral-500",
          vertical ? "inset-y-0 left-0 w-px" : "inset-x-0 top-0 h-px"
        )}
      />
      {/* Wider invisible hit target straddling the seam; layout-neutral. */}
      <div
        role="separator"
        aria-orientation={orientation}
        aria-label={ariaLabel}
        className={cn(
          "app-no-drag absolute z-10",
          vertical
            ? "inset-y-0 left-1/2 w-3 -translate-x-1/2 cursor-col-resize"
            : "inset-x-0 top-1/2 h-3 -translate-y-1/2 cursor-row-resize",
          dragOpts.disabled && "pointer-events-none"
        )}
        style={{ touchAction: "none" }}
        {...handlers}
      />
    </div>
  );
};
