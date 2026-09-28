import React from "react";
import { ChevronLeft } from "lucide-react";

import { cn } from "../../../lib/cn";
import {
  TurnDiffBody,
  turnDiffTitle,
  useTurnDiff,
  type TurnDiffRequest
} from "../../agent-chat/timeline/TurnDiffModal";

/**
 * A turn's diff INSIDE the panel — a phone's way to show it. The
 * app's modal layer (z-100) sits below the bottom sheet (z-110), so a modal
 * opened from inside the sheet would open behind it; the sheet shows the diff
 * in place instead. It is laid OVER the list, which stays mounted and
 * scrolled where it was, so Back returns to the same place. Same read and
 * same body as `TurnDiffModal`.
 *
 * The keyboard lands on Back, and Escape is Back — stopped here, so it never
 * reaches the sheet, which would close altogether.
 */
export function TurnDiffInline({
  request,
  onBack,
  className
}: {
  request: TurnDiffRequest;
  onBack: () => void;
  className?: string;
}): React.ReactElement {
  const state = useTurnDiff(request);
  const backRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    backRef.current?.focus({ preventScroll: true });
  }, [request]);
  return (
    <div
      className={cn("flex min-h-0 flex-1 flex-col", className)}
      data-history-diff=""
      role="region"
      aria-label={turnDiffTitle(request)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          onBack();
        }
      }}
    >
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-neutral-800 px-2">
        <button
          ref={backRef}
          type="button"
          onClick={onBack}
          className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-500"
        >
          <ChevronLeft size={14} aria-hidden />
          Back
        </button>
        <span className="min-w-0 truncate text-sm text-neutral-200">{turnDiffTitle(request)}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {state !== null ? <TurnDiffBody state={state} /> : null}
      </div>
    </div>
  );
}
