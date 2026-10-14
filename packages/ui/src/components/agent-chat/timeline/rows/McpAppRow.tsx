import React from "react";

import type { AgentChatTimelineRow } from "../../../../lib/agent-chat/contracts";
import { McpAppFrame } from "../../mcp-app/McpAppFrame";
import { useTimelineRowContext } from "../context";

/**
 * An MCP App (spec 2026-10-14 §3), framed inline in place of the tool call
 * that produced it, left-aligned with the reply text. Keyed by the snapshot,
 * so the frame — and the app's session with its host — survives
 * re-derivation.
 */
export function McpAppRow({
  row
}: {
  row: Extract<AgentChatTimelineRow, { kind: "mcp-app" }>;
}): React.ReactElement | null {
  const { sessionId, readOnly } = useTimelineRowContext();
  if (sessionId === undefined) {
    return null;
  }
  return (
    // `px-1`: the assistant text's own inset, so the app lines up with the reply.
    <div className="px-1">
      <McpAppFrame sessionId={sessionId} itemId={row.itemId} app={row.mcpApp} readOnly={readOnly} />
    </div>
  );
}
