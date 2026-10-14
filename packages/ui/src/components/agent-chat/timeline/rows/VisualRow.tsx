import React from "react";

import type { AgentChatTimelineRow } from "../../../../lib/agent-chat/contracts";
import { VisualFrame } from "../../visual/VisualFrame";
import { useTimelineRowContext } from "../context";

/**
 * An agent's published page (spec 2026-10-14 §2.5): framed inline in place of
 * its `html_render` tool row, left-aligned with the reply text. Keyed by the
 * page, so the frame — and the page's own state — survives re-derivation.
 */
export function VisualRow({
  row
}: {
  row: Extract<AgentChatTimelineRow, { kind: "visual" }>;
}): React.ReactElement | null {
  const { sessionId } = useTimelineRowContext();
  if (sessionId === undefined) {
    return null;
  }
  return (
    // `px-1`: the assistant text's own inset, so the page lines up with the reply.
    <div className="px-1">
      <VisualFrame sessionId={sessionId} htmlRender={row.htmlRender} />
    </div>
  );
}
