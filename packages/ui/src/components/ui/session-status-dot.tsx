import React from "react";
import { Circle } from "lucide-react";
import { cn } from "../../lib/cn";
import { useSessionActivity } from "../../store/app";
import type { SessionStatus } from "../../types";

/**
 * Per-session status light shown on tabs and grid-cell headers:
 *   • gray          — the process has exited
 *   • amber         — working (PTY output flowing within the last few seconds)
 *   • green         — idle / waiting for the user to type
 *   • pulsing green — an agent rang the terminal bell and is awaiting the user
 *
 * Subscribes to just this session's activity slice (see {@link useSessionActivity}),
 * so only its own dot re-renders when the session transitions.
 */
export const SessionStatusDot: React.FC<{
  sessionId: string;
  status: SessionStatus;
  className?: string;
}> = ({ sessionId, status, className }) => {
  const activity = useSessionActivity(sessionId);
  if (status === "exited") {
    return (
      <Circle
        size={7}
        aria-label="Exited"
        className={cn("shrink-0 fill-neutral-600 text-neutral-600", className)}
      />
    );
  }
  const working = activity?.state === "working";
  const attention = activity?.attention ?? false;
  return (
    <Circle
      size={7}
      aria-label={working ? "Working" : attention ? "Waiting for you" : "Idle"}
      className={cn(
        "shrink-0",
        working ? "fill-amber-400 text-amber-400" : "fill-green-400 text-green-400",
        attention && "animate-pulse",
        className
      )}
    />
  );
};
