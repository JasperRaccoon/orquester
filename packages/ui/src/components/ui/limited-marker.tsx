import type { ReactElement } from "react";
import type { SessionSummary } from "@orquester/api";

import { cn } from "../../lib/cn";
import { limitedMarker } from "../../lib/agent-chat/usage-limit.logic";

/**
 * The "Limited" marker of a chat stopped on its account's usage limit (`SessionSummary.usageLimit`),
 * beside the status dot on every surface that lists sessions. Its tooltip says when the limit
 * resets and whether the chat resumes by itself. Renders nothing for a chat that is not limited.
 */
export function LimitedMarker({
  session,
  className
}: {
  session: Pick<SessionSummary, "usageLimit"> | null | undefined;
  className?: string;
}): ReactElement | null {
  const marker = session ? limitedMarker(session, Date.now()) : null;
  if (!marker) return null;
  return (
    <span
      title={marker.title}
      aria-label={marker.title}
      data-limited="true"
      className={cn("shrink-0 rounded bg-warn-soft/60 px-1 text-[10px] font-medium leading-4 text-warn", className)}
    >
      {marker.label}
    </span>
  );
}
