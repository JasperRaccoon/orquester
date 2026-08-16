import React from "react";
import { Circle } from "lucide-react";
import { cn } from "../../lib/cn";
import { useSessionActivity } from "../../store/app";
import type { SessionStatus } from "../../types";

/**
 * Per-session status light shown on tabs and grid-cell headers, driven entirely
 * by the daemon's authoritative activity snapshot (see {@link useSessionActivity}):
 *   • gray         — the process has exited
 *   • amber        — working (agent/PTY busy)
 *   • amber pulse  — waiting / needs your input
 *   • green        — idle
 *   • green pulse  — finished, or a bell rang (awaiting the user)
 *
 * Subscribes to just this session's activity slice, so only its own dot
 * re-renders when the session transitions.
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
  const state = activity?.state ?? "idle";
  const attention = activity?.attention ?? null;
  const label =
    attention === "needs-input"
      ? "Needs your input"
      : attention === "finished"
        ? "Finished"
        : attention === "bell"
          ? "Waiting for you"
          : state === "working"
            ? "Working"
            : state === "waiting"
              ? "Waiting"
              : "Idle";
  return (
    <Circle
      size={7}
      aria-label={label}
      className={cn(
        "shrink-0",
        state === "working"
          ? "fill-warn text-warn"
          : state === "waiting"
            ? "fill-warn text-warn"
            : "fill-ok-vivid text-ok-vivid",
        (attention !== null || state === "waiting") && "animate-pulse",
        className
      )}
    />
  );
};
