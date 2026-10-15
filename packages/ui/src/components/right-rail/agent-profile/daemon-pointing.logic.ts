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

const AGENTS = new Set(["claude", "codex", "grok", "opencode"]);
const REASONS = new Set(["bearer", "url", "name"]);

/** The route's answer, validated before it reaches the panel: malformed rows are dropped, a malformed body is `null`. */
export function parseDaemonMcpServers(value: unknown): DaemonPointingServer[] | null {
  if (value === null || typeof value !== "object" || !Array.isArray((value as { servers?: unknown }).servers)) return null;
  const out: DaemonPointingServer[] = [];
  for (const raw of (value as { servers: unknown[] }).servers) {
    if (raw === null || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    if (!AGENTS.has(row.agent as string) || typeof row.home !== "string" || (row.scope !== "user" && row.scope !== "project")) continue;
    if (typeof row.name !== "string" || !REASONS.has(row.reason as string)) continue;
    out.push({
      agent: row.agent as AgentProfileAgentId,
      home: row.home,
      scope: row.scope,
      ...(typeof row.projectPath === "string" ? { projectPath: row.projectPath } : {}),
      name: row.name,
      reason: row.reason as DaemonPointingReason
    });
  }
  return out;
}
