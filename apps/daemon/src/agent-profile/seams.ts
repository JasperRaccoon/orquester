/**
 * The two seams the agent profile service calls out through for work that
 * lands later (spec §6): the cross-agent converter (`convert.ts`) and the
 * import scanner (`import.ts`). Both are optional service dependencies; until
 * they are wired the service falls back to {@link identityConverter} for a
 * copy and answers every import route 503 (`importsUnavailable`).
 *
 * Both work on {@link PortableItem}s, which carry REAL secret values (an MCP
 * server's env and headers): nothing here may log, serialize or echo one.
 */

import {
  AGENT_PROFILE_AGENT_LABELS,
  MCP_TRANSPORTS,
  type AgentProfileAgentId,
  type ProfileImportScanResponse
} from "@orquester/api";
import type { PortableItem } from "./adapters/types.ts";
import { AgentProfileError, profileErrors } from "./errors.ts";

export interface ProfileConversion {
  /** The item rewritten for the target agent. A skill `dir` it creates is owned by the service from then on. */
  item: PortableItem;
  /** What the owner should know: fields dropped, a command turned into a skill, … */
  notes: string[];
}

/**
 * Rewrites a portable item lifted out of `from` for `to` (names checked against
 * the target's rules, frontmatter keys mapped, MCP fields translated). Throws
 * `profileErrors.invalidItem` / `profileErrors.invalidName` when the item
 * cannot exist on the target. Never mutates its input.
 */
export type ProfileConverter = (
  item: PortableItem,
  from: AgentProfileAgentId,
  to: AgentProfileAgentId
) => ProfileConversion | Promise<ProfileConversion>;

/** What `take` hands over: the picked items, ready for the target agent, and how to let them go. */
export interface ProfileImportTake {
  items: PortableItem[];
  /**
   * Frees whatever the import holds (its clone or extracted upload, every skill
   * `dir` in `items`). The service calls it exactly once, after the last
   * `importItem`, whether or not the import succeeded.
   */
  release(): Promise<void>;
}

/**
 * The import scanner (spec §6: Git URL, upload). A scan leaves its tree under
 * `agentProfileImportsDir(appdir)/<importId>/` until `take` or its own expiry.
 */
export interface ProfileImports {
  scanGit(agent: AgentProfileAgentId, url: string): Promise<ProfileImportScanResponse>;
  /**
   * Scans an uploaded `.zip` or `.md`. `filePath` belongs to the CALLER (the
   * upload route) and is deleted as soon as this returns or throws: whatever
   * the import needs later must be extracted or copied into its own import
   * directory during the call.
   */
  scanUpload(agent: AgentProfileAgentId, name: string, filePath: string): Promise<ProfileImportScanResponse>;
  /** Throws `profileErrors.importNotFound` for an unknown or expired `importId`. */
  take(agent: AgentProfileAgentId, importId: string, picks: string[]): Promise<ProfileImportTake>;
}

/** Every import route's answer while no {@link ProfileImports} is wired. */
export function importsUnavailable(): AgentProfileError {
  return new AgentProfileError(503, "AGENT_PROFILE_ERROR", "Imports are not available yet.");
}

/**
 * The copy fallback while no real converter is wired: it only passes items
 * whose shape is the same on every agent. Skills (a `SKILL.md` directory) and
 * commands (markdown + frontmatter) travel unchanged — the service still
 * checks the target can create that kind and accepts the name. An MCP server
 * keeps its portable fields, is refused when the target has no such
 * transport, and loses the source agent's own `advanced` extras (the keys are
 * named in a note; they are never secret).
 */
export const identityConverter: ProfileConverter = (item, from, to) => {
  if (item.kind !== "mcp") {
    return { item, notes: [] };
  }
  const { advanced, ...server } = item.server;
  if (!MCP_TRANSPORTS[to].includes(server.transport)) {
    throw profileErrors.invalidItem(
      `${AGENT_PROFILE_AGENT_LABELS[to]} does not support ${server.transport} MCP servers.`
    );
  }
  const dropped = Object.keys(advanced ?? {});
  return {
    item: { kind: "mcp", server },
    notes:
      dropped.length > 0
        ? [`Dropped ${AGENT_PROFILE_AGENT_LABELS[from]}-only settings: ${dropped.sort().join(", ")}.`]
        : []
  };
};
