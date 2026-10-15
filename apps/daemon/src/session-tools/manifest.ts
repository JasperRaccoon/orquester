/**
 * The per-thread manifest of the in-chat `orquester` server (unified MCP design 2026-10-15 §9.4):
 * which chat tools ONE provider session of a thread advertises, its instruction block (§10) and
 * the MCP servers it must deny (§12.1). The agent host asks for it at every provider-session start
 * (`daemonRoutesForHost.sessionToolsManifest`) and is handed a new one when the thread's toolsets
 * change (`agentHostRoutes.sessionToolsRefresh`).
 *
 * Pure: the daemon's service (`./toolset-refresh.ts`) reads the thread, its toolsets and the
 * daemon-pointing servers and passes them in, so a catalog tool module (`request_toolset`) can
 * import {@link toolsetAvailability} without pulling anything else in.
 */

import { resolve } from "node:path";

import type { AgentAdapterId } from "@orquester/api/agent-chat";
import type { DaemonPointingServer } from "@orquester/api";

import type { SessionToolsManifest } from "../agent-host/host-protocol.ts";
import type { AnyOrquesterTool } from "../mcp/catalog/contract.ts";
import { composeOrquesterInstructions } from "./instructions.ts";

/**
 * Whether a provider takes a changed tool list INTO ITS RUNNING SESSION (spec §9.3), from the
 * Task 6 probes (report `task-6-report.md`, README "Probe evidence"):
 * - Claude Code 2.1.285: re-lists on `notifications/tools/list_changed` from the in-process SDK
 *   server (and from HTTP servers) — the new tools reach the model's next request.
 * - Codex 0.159.0: the notification is delivered and ignored (no `tools/list`); a
 *   `config/mcpServer/reload` does not reconnect the thread's server either.
 * - Grok 1.0.46: delivered and ignored.
 * - OpenCode 1.18.34: re-lists at once — but the host's loopback endpoint is stateless (no
 *   server-initiated stream), so the notification cannot reach it: restart path.
 */
export const SESSION_TOOLS_LIVE_REFRESH: Readonly<Record<AgentAdapterId, boolean>> = {
  claude: true,
  codex: false,
  grok: false,
  opencode: false
};

/**
 * `request_toolset`'s `available` (spec §9.3): `now` where the running session takes the new list
 * at once, else `after-restart` — the agent ends its turn, the host restarts the session with
 * resume, and the daemon posts the automatic continue turn.
 */
export function toolsetAvailability(agent: AgentAdapterId | string): "now" | "after-restart" {
  return Object.prototype.hasOwnProperty.call(SESSION_TOOLS_LIVE_REFRESH, agent) &&
    SESSION_TOOLS_LIVE_REFRESH[agent as AgentAdapterId]
    ? "now"
    : "after-restart";
}

/** The thread a manifest is for, as the daemon's records say. */
export interface ManifestThread {
  agentId: AgentAdapterId;
  /** The account home its provider runs in: `"system"` or the managed account id. */
  home: string;
  /** Every spelling of its project root the daemon knows (the tab's and the canonical one); none when unbound. */
  projectPaths: readonly string[];
  /** Spec §5.4: no Admin tool is advertised to it. */
  workflowOwned: boolean;
}

export interface ManifestInput {
  thread: ManifestThread;
  /** The thread's resolved toolsets (`AgentToolsService.resolvedToolsets`). */
  toolsets: readonly string[];
  /** The master switch (Settings › Agent tools); off → only `core`, and no toolset can be asked for. */
  agentToolsEnabled: boolean;
  /** The chat audience of the catalog, in catalog order (`catalogFor("chat")`). */
  catalog: readonly AnyOrquesterTool[];
  /** The daemon-pointing MCP servers the agent-profile service found (Task 11's read; [] until known). */
  daemonPointing: readonly DaemonPointingServer[];
}

/** True when a tool is Admin whatever its arguments — never advertised to a workflow-owned chat (§5.4). */
export function alwaysAdmin(tool: AnyOrquesterTool): boolean {
  return tool.tier === "admin";
}

/** Tools a workflow-owned chat can never use, whatever their tier: `request_toolset` (nobody approves a card there, §5.4). */
const NEVER_FOR_WORKFLOW_OWNED: ReadonlySet<string> = new Set(["request_toolset"]);

/** The chat tools a thread advertises, in catalog order. */
export function advertisedChatTools(catalog: readonly AnyOrquesterTool[], toolsets: ReadonlySet<string>, workflowOwned: boolean): string[] {
  return catalog
    .filter((tool) => toolsets.has(tool.toolset) && !(workflowOwned && (alwaysAdmin(tool) || NEVER_FOR_WORKFLOW_OWNED.has(tool.name))))
    .map((tool) => tool.name);
}

const samePath = (a: string, b: string): boolean => a !== "" && b !== "" && resolve(a) === resolve(b);

/**
 * The servers to deny in this thread: its agent's, in ITS account home (user scope) or its
 * project's config (project scope) — exactly the ones its CLI will load. Codex refuses a thread
 * whose config names a server it does not have (`mcp_servers.<absent>.enabled = false` → "invalid
 * transport", probed on 0.159.0), so a name from another home is never sent. Sorted, unique.
 */
export function denyFor(thread: ManifestThread, servers: readonly DaemonPointingServer[]): string[] {
  const names = new Set<string>();
  for (const server of servers) {
    if (server.agent !== thread.agentId || typeof server.name !== "string" || server.name === "") continue;
    const inScope =
      server.scope === "project"
        ? server.projectPath !== undefined && thread.projectPaths.some((path) => samePath(path, server.projectPath!))
        : server.home === thread.home;
    if (inScope) names.add(server.name);
  }
  return [...names].sort();
}

/** The manifest of one thread. */
export function buildSessionToolsManifest(input: ManifestInput): SessionToolsManifest {
  const toolsets = new Set(input.toolsets);
  return {
    tools: advertisedChatTools(input.catalog, toolsets, input.thread.workflowOwned),
    instructions: composeOrquesterInstructions({
      enabledToolsets: toolsets,
      workflowOwned: input.thread.workflowOwned,
      canRequestToolsets: input.agentToolsEnabled && !input.thread.workflowOwned
    }),
    deny: denyFor(input.thread, input.daemonPointing),
    toolsets: [...input.toolsets]
  };
}
