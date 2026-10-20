/**
 * The per-thread manifest of the in-chat `orquester` server (unified MCP design 2026-10-15 §9.4):
 * which chat tools ONE provider session of a thread advertises — every chat tool, but no
 * always-Admin one to a workflow-owned chat (§5.4), and the box tools only while a box can be
 * rented (Ephemeral AI VMs §13) — its instruction block (§10) and the MCP
 * servers it must deny (§12.1). The agent host asks for it at every provider-session start
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
import { composeOrquesterInstructions } from "./instructions.ts";

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
}

/** True when a tool is Admin whatever its arguments — never advertised to a workflow-owned chat (§5.4). */
export function alwaysAdmin(tool: AnyOrquesterTool): boolean {
  return tool.tier === "admin";
}

/**
 * The chat tools a thread advertises, in catalog order: all of them, less the always-Admin ones for
 * a workflow-owned chat — and (boxes) less the `boxes` toolset while no box can be rented, so no
 * chat pays for tools it cannot use.
 */
export function advertisedChatTools(catalog: readonly AnyOrquesterTool[], workflowOwned: boolean, boxesAvailable = false): string[] {
  return catalog.filter((tool) => !(workflowOwned && alwaysAdmin(tool)) && (boxesAvailable || tool.toolset !== "boxes")).map((tool) => tool.name);
}

const samePath = (a: string, b: string): boolean => a !== "" && b !== "" && resolve(a) === resolve(b);

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
      samePath(root, dir) ||
      // An ancestor of the project (Codex reads from its project root — the git root, maybe above).
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
export function denyFor(thread: ManifestThread, servers: readonly DaemonPointingServer[]): string[] {
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
  return {
    tools: advertisedChatTools(input.catalog, input.thread.workflowOwned, input.boxesAvailable === true),
    instructions: composeOrquesterInstructions({ workflowOwned: input.thread.workflowOwned }),
    deny: denyFor(input.thread, input.daemonPointing)
  };
}
