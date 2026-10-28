/**
 * The per-thread manifest of the in-chat `orquester` server (unified MCP design 2026-10-15 §9.4):
 * which chat tools ONE provider session of a thread advertises — every chat tool, but no
 * always-Admin one to a workflow-owned chat (§5.4), the box tools only while a box can be
 * rented (Ephemeral AI VMs §13), the knowledge tools only while the Knowledge Graph plugin is
 * on (its spec, "Agent tools"), the device tools only while devices can be used (devices spec §9)
 * — its instruction block (§10) and the MCP servers it must deny
 * (§12.1). The agent host asks for it at every provider-session start
 * (`daemonRoutesForHost.sessionToolsManifest`) and is handed a new one when the daemon pushes one
 * (`agentHostRoutes.sessionToolsRefresh`).
 *
 * Pure: the daemon's service (`./session-tools-refresh.ts`) reads the thread and the
 * daemon-pointing servers and passes them in.
 */

import { isAbsolute, relative, resolve } from "node:path";

import type { DaemonPointingServer } from "@orquester/api";
import type { AgentAdapterId } from "@orquester/api/agent-chat";

import type { SessionToolsManifest } from "../agent-host/host-protocol.ts";
import type { AnyOrquesterTool } from "../mcp/catalog/contract.ts";
import { composeOrquesterInstructions, KNOWLEDGE_WORKER_INSTRUCTIONS } from "./instructions.ts";

/** The thread a manifest is for, as the daemon's records say. */
export interface ManifestThread {
  agentId: AgentAdapterId;
  /** The account home its provider runs in: `"system"` or the managed account id. */
  home: string;
  /** Every spelling of its project root the daemon knows (the tab's and the canonical one); none when unbound. */
  projectPaths: readonly string[];
  /**
   * Every spelling of its cwd (the tab's and the canonical one) when it is a directory INSIDE the
   * project: the project-level configs of every directory from the root down to it are loaded too.
   */
  cwdPaths?: readonly string[];
  /**
   * Its cwd's real path leaves its project, or its project's real path leaves the workspaces root:
   * what its CLI loads cannot be told, so EVERY daemon-pointing server of its agent known in any
   * scope or home is denied by name (an unrelated same-named server too — harmless otherwise).
   */
  denyEveryKnown?: boolean;
  /** Spec §5.4: no Admin tool is advertised to it. */
  workflowOwned: boolean;
}

export interface ManifestInput {
  thread: ManifestThread;
  /** The chat audience of the catalog, in catalog order (`catalogFor("chat")`). */
  catalog: readonly AnyOrquesterTool[];
  /** The daemon-pointing MCP servers the agent-profile service found (Task 11's read; [] until known). */
  daemonPointing: readonly DaemonPointingServer[];
  /** boxes: whether temporary boxes can be rented now (the Ephemeral AI VMs plugin is wired); absent = no. */
  boxesAvailable?: boolean;
  /** Devices: whether the device tools are usable (the plugin is on, agents may use devices, a platform is enabled); absent = no. */
  devicesAvailable?: boolean;
  /** Knowledge Graph: the plugin's view of this chat; absent = the plugin is off. */
  knowledge?: ManifestKnowledge;
}

/** Knowledge Graph plugin: what the manifest needs to know about one chat (`knowledge/visibility.ts` builds it). */
export interface ManifestKnowledge {
  /** The plugin is enabled on this server: its chat tools are advertised. */
  enabled: boolean;
  /**
   * One of the plugin's worker sessions (`owner.kind === "knowledge-indexer"`): it is advertised
   * the two worker tools and nothing else, with {@link KNOWLEDGE_WORKER_INSTRUCTIONS} as its block.
   */
  worker: boolean;
  /** The chat can see something (Global, or a profile ticking a collection that exists): `knowledge_search` and `knowledge_get` are advertised. */
  searchable: boolean;
  /** The names of the collections it sees (the knowledge line; none = no line). */
  visibleCollectionNames: readonly string[];
}

/** The two tools only a knowledge worker session is advertised. */
export const KNOWLEDGE_WORKER_TOOLS: readonly string[] = ["knowledge_worker_next_task", "knowledge_worker_submit"];
/** The knowledge tools a chat that sees no collection is not advertised: they act on entries it can see (saving and listing collections stay). */
export const KNOWLEDGE_SEARCH_TOOLS: readonly string[] = ["knowledge_search", "knowledge_get", "knowledge_insights", "knowledge_update", "knowledge_delete", "knowledge_merge"];

/**
 * The chat tools a thread advertises, in catalog order: all of them, less the always-Admin ones for
 * a workflow-owned chat — and (boxes) less the `boxes` toolset while no box can be rented, so no
 * chat pays for tools it cannot use; (devices) less the `devices` toolset likewise. Knowledge Graph:
 * the `knowledge` toolset only while the plugin is on, without the entry tools
 * ({@link KNOWLEDGE_SEARCH_TOOLS}) for a chat that sees no collection, and never the worker tools; a
 * worker session gets ONLY the worker tools.
 */
function advertisedChatTools(
  catalog: readonly AnyOrquesterTool[],
  workflowOwned: boolean,
  boxesAvailable = false,
  knowledge?: ManifestKnowledge,
  devicesAvailable = false
): string[] {
  if (knowledge?.worker === true) return catalog.filter((tool) => KNOWLEDGE_WORKER_TOOLS.includes(tool.name)).map((tool) => tool.name);
  const knowledgeTool = (tool: AnyOrquesterTool): boolean => {
    if (KNOWLEDGE_WORKER_TOOLS.includes(tool.name)) return false;
    if (tool.toolset !== "knowledge") return true;
    if (knowledge?.enabled !== true) return false;
    return knowledge.searchable || !KNOWLEDGE_SEARCH_TOOLS.includes(tool.name);
  };
  return catalog
    .filter(
      (tool) =>
        !(workflowOwned && tool.tier === "admin") &&
        (boxesAvailable || tool.toolset !== "boxes") &&
        (devicesAvailable || tool.toolset !== "devices") &&
        knowledgeTool(tool)
    )
    .map((tool) => tool.name);
}

/** `dir` is `parent` or a directory inside it (lexically). */
export const isWithinDir = (dir: string, parent: string): boolean => {
  if (dir === "" || parent === "") return false;
  const rel = relative(resolve(parent), resolve(dir));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * Whether a project-scope config in `dir` is one this thread's CLI loads: its project root, or a
 * directory on the way from it down to the thread's cwd (Codex loads each `.codex/config.toml` on
 * that path; Claude, OpenCode and Grok search upward from the cwd).
 */
const loadsProjectConfigIn = (thread: ManifestThread, dir: string): boolean =>
  thread.projectPaths.some(
    (root) =>
      // The project root or an ancestor (Codex's git root may be above it).
      isWithinDir(root, dir) ||
      (isWithinDir(dir, root) && (thread.cwdPaths ?? []).some((cwd) => isWithinDir(cwd, dir)))
  );

/**
 * The servers to deny in this thread: its agent's, in ITS account home (user scope) or its
 * project's configs (project scope: the root's, and every directory's down to its cwd) — exactly
 * the ones its CLI will load. Codex refuses a thread
 * whose config names a server it does not have (`mcp_servers.<absent>.enabled = false` → "invalid
 * transport", probed on 0.159.0), so a name from another home is never sent. Sorted, unique.
 */
function denyFor(thread: ManifestThread, servers: readonly DaemonPointingServer[]): string[] {
  const names = new Set<string>();
  for (const server of servers) {
    if (server.agent !== thread.agentId || typeof server.name !== "string" || server.name === "") continue;
    if (thread.denyEveryKnown) {
      names.add(server.name);
      continue;
    }
    // A user server every home of the agent loads (Grok's inherited ~/.claude.json, `allHomes`) is
    // denied in every home; any other only in its own.
    const inScope =
      server.scope === "project"
        ? server.projectPath !== undefined && loadsProjectConfigIn(thread, server.projectPath)
        : server.allHomes === true || server.home === thread.home;
    // `loadedByHomes` is display only: a Codex denial of a server its config does not load is
    // harmless (the session sends a disabled stub for it), so trust is never predicted here.
    if (inScope) names.add(server.name);
  }
  return [...names].sort();
}

/** The manifest of one thread. */
export function buildSessionToolsManifest(input: ManifestInput): SessionToolsManifest {
  const knowledge = input.knowledge;
  const tools = advertisedChatTools(input.catalog, input.thread.workflowOwned, input.boxesAvailable === true, knowledge, input.devicesAvailable === true);
  const instructions =
    knowledge?.worker === true
      ? KNOWLEDGE_WORKER_INSTRUCTIONS
      : composeOrquesterInstructions({
          workflowOwned: input.thread.workflowOwned,
          // The devices line names list_devices: only where it is advertised.
          devices: tools.includes("list_devices"),
          // The line names knowledge_search: only where it is advertised.
          ...(knowledge?.enabled === true && tools.includes("knowledge_search") ? { knowledgeCollections: knowledge.visibleCollectionNames } : {})
        });
  return { tools, instructions, deny: denyFor(input.thread, input.daemonPointing) };
}
