import React from "react";

import type { AgentChatTimelineRow } from "../../../../lib/agent-chat/contracts";
import { useChatHost } from "../../chat-host";
import { useTimelineRowContext } from "../context";

/**
 * An MCP App (spec 2026-10-14 §3), framed inline in place of the tool call
 * that produced it, left-aligned with the reply text. Keyed by the snapshot,
 * so the frame — and the app's session with its host — survives
 * re-derivation. The frame is the chat host's (`ChatHost.McpAppFrame`); a
 * host without one names the app's tool instead.
 */
export function McpAppRow({
  row
}: {
  row: Extract<AgentChatTimelineRow, { kind: "mcp-app" }>;
}): React.ReactElement | null {
  const { sessionId, readOnly } = useTimelineRowContext();
  const { McpAppFrame } = useChatHost();
  if (sessionId === undefined) {
    return null;
  }
  return (
    // `px-1`: the assistant text's own inset, so the app lines up with the reply.
    <div className="px-1">
      {McpAppFrame ? (
        <McpAppFrame sessionId={sessionId} itemId={row.itemId} app={row.mcpApp} readOnly={readOnly} />
      ) : (
        <p className="text-xs text-neutral-500" data-mcp-app={row.mcpApp.tool}>
          {row.mcpApp.tool} · {row.mcpApp.server}
        </p>
      )}
    </div>
  );
}
