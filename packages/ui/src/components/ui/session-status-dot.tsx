import React from "react";
import { Circle } from "lucide-react";
import { cn } from "../../lib/cn";
import { useSessionActivity } from "../../store/app";
import type { AgentChatBackgroundLiveness } from "@orquester/api";
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
  /**
   * A chat session's §6.4 background-liveness column, read straight off
   * `SessionSummary` — this surface re-derives nothing (chat spec §7.7).
   *
   * `"monitoring"` (a watch loop still running after the turn settled) borrows
   * the in-motion colour **without its pulse**: it is not finished, but nothing
   * is asking for the user either. `"working"` is already folded into
   * `activity.state` by the daemon and needs nothing here.
   */
  backgroundLiveness?: AgentChatBackgroundLiveness | null;
  className?: string;
}> = ({ sessionId, status, backgroundLiveness, className }) => {
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
  // Monitoring only reads through where nothing louder is showing: the daemon
  // resolves a monitoring thread to `idle` with NO "finished" stamp precisely so
  // that a settled turn whose watch loops are still running isn't called
  // finished (§6.4). Anything with an attention stamp or a non-idle state
  // outranks it.
  const monitoring = backgroundLiveness === "monitoring" && state === "idle" && attention === null;
  const label = monitoring
    ? "Monitoring"
    : attention === "needs-input"
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
        state === "working" || state === "waiting" || monitoring
          ? "fill-warn text-warn"
          : "fill-ok-vivid text-ok-vivid",
        // Monitoring is deliberately NOT pulsed: the pulse means "act now".
        !monitoring && (attention !== null || state === "waiting") && "animate-pulse",
        className
      )}
    />
  );
};
