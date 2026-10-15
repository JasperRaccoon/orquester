/**
 * The agent-profile panel's flag on an MCP server that reaches this Orquester's own `/mcp`
 * (unified MCP design 2026-10-15 §12.1): Orquester turns such a server off inside the chats it
 * launches, and the row says so. The list is `GET /api/agent-profile/daemon-mcp-servers`.
 */

import type { AgentProfileAgentId, DaemonPointingReason, DaemonPointingServer, ProfileItem } from "@orquester/api";

/** The chip's text. */
export const DAEMON_POINTING_LABEL = "Disabled inside Orquester chats";

/**
 * Why the row's server is flagged, or null. A user-scope entry of the daemon user's own home names
 * the item the panel lists (`mcp:<name>`); account-home and project-level entries are other configs.
 */
export function daemonPointingReasonFor(
  item: Pick<ProfileItem, "kind" | "name">,
  agent: AgentProfileAgentId,
  servers: readonly DaemonPointingServer[] | null | undefined
): DaemonPointingReason | null {
  if (item.kind !== "mcp" || !servers) return null;
  const match = servers.find((server) => server.agent === agent && server.home === "system" && server.scope === "user" && server.name === item.name);
  return match?.reason ?? null;
}

/** The chip's tooltip: why, and what it means. */
export function daemonPointingTitle(reason: DaemonPointingReason): string {
  const why =
    reason === "bearer"
      ? "It carries this Orquester's own credential"
      : reason === "url"
        ? "It points at this Orquester's own /mcp"
        : "It is named \"orquester\", like Orquester's own in-chat server";
  return `${why}, which would give a chat full control of Orquester without approvals. Orquester turns it off inside the chats it launches; it still works outside Orquester.`;
}
