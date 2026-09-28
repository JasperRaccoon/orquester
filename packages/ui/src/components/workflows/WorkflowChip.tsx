import React from "react";
import { Workflow } from "lucide-react";
import type { SessionSummary } from "@orquester/api";
import { cn } from "../../lib/cn";
import { openWorkflowRun, workflowRunTargetOf } from "../../lib/workflows/open-bridge";

/**
 * The "Workflow" chip on a chat tab an automated workflow started (workflows spec §5.10). Clicking it
 * opens the run through the open-run bridge; with nothing listening the click does nothing.
 *
 * It stops only its OWN click from reaching the tab (which would activate it): a drag that starts
 * on the chip still drags the tab, and a double-click still renames it.
 *
 * `compact` is the touch layout (the phone's tab sheet): the icon alone, sized to be tapped.
 */
export const WorkflowChip: React.FC<{
  session: Pick<SessionSummary, "kind" | "owner"> | null | undefined;
  compact?: boolean;
  className?: string;
  /** After a listener took the run — the phone's tab sheet closes so the run shows. */
  onOpened?: () => void;
}> = ({ session, compact = false, className, onOpened }) => {
  const target = workflowRunTargetOf(session);
  if (!target) return null;
  return (
    <button
      type="button"
      // The icon-only chip needs a name; the full one's visible "Workflow" is its name.
      aria-label={compact ? "Open the workflow run that started this chat" : undefined}
      title="Started by a workflow — open the run"
      onClick={(event) => {
        event.stopPropagation();
        if (openWorkflowRun(target)) onOpened?.();
      }}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded bg-info-500/15 text-info-300 hover:bg-info-500/25",
        compact ? "h-9 w-9 justify-center" : "px-1 text-[10px] leading-4",
        className
      )}
    >
      <Workflow size={compact ? 16 : 10} aria-hidden="true" />
      {compact ? null : <span>Workflow</span>}
    </button>
  );
};
