/**
 * Settings › Agent tools (unified MCP §9.2, §7.6) — the pure half: the toolsets × agents matrix,
 * what a cell change sends, tier counts, and how a grant reads (shared with the chat's Tools chip).
 *
 * No React import. Tested by `agent-tools-settings.logic.test.ts`.
 */

import {
  AGENT_TOOLS_AGENTS,
  type AgentAdapterId,
  type AgentToolGrant,
  type AgentToolsetView,
  type ToolTier,
  type UpdateAgentToolsSettingsRequest
} from "@orquester/api";

/** The matrix's column headers (spec §9.2). */
export const AGENT_TOOLS_AGENT_LABELS: Readonly<Record<AgentAdapterId, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok",
  opencode: "OpenCode"
};

export const TIER_LABELS: Readonly<Record<ToolTier, string>> = { read: "Read", act: "Act", admin: "Admin" };

/** `{read: 4, act: 1, admin: 4}` — what the row's tier badges count. */
export function tierCounts(view: Pick<AgentToolsetView, "tools">): Record<ToolTier, number> {
  const counts: Record<ToolTier, number> = { read: 0, act: 0, admin: 0 };
  for (const tool of view.tools) counts[tool.tier] += 1;
  return counts;
}

/** `3.1 KB` of `tools/list` (the measured budget cost, spec §9.5); null when unmeasured. */
export function formatToolsetBytes(bytes: number | undefined): string | null {
  if (bytes === undefined) return null;
  if (bytes < 1000) return `${bytes} B`;
  return `${(bytes / 1000).toFixed(1)} KB`;
}

export interface MatrixCell {
  agent: AgentAdapterId;
  /** On for that agent's chats unless a chat overrides it. */
  on: boolean;
  /** Differs from the catalogue default (the user changed it). */
  customised: boolean;
  /** Locked toolsets (`core`) have no switch. */
  locked: boolean;
}

export interface MatrixRow {
  id: AgentToolsetView["id"];
  label: string;
  locked: boolean;
  toolCount: number;
  bytes: string | null;
  tiers: Record<ToolTier, number>;
  cells: MatrixCell[];
}

/** The matrix: one row per toolset in the daemon's order, one cell per agent in column order. */
export function agentToolsMatrix(toolsets: readonly AgentToolsetView[]): MatrixRow[] {
  return toolsets.map((view) => ({
    id: view.id,
    label: view.label,
    locked: view.locked,
    toolCount: view.tools.length,
    bytes: formatToolsetBytes(view.bytes),
    tiers: tierCounts(view),
    cells: AGENT_TOOLS_AGENTS.map((agent) => ({
      agent,
      on: view.locked || view.defaults[agent] === true,
      customised: !view.locked && view.defaults[agent] !== view.catalogDefaults[agent],
      locked: view.locked
    }))
  }));
}

/**
 * What flipping one cell sends: the new value — or `null` when it lands back on the catalogue
 * default, so the file holds only real choices and a later catalogue change still reaches it.
 * Null for a locked toolset (no request at all).
 */
export function matrixCellUpdate(
  view: AgentToolsetView,
  agent: AgentAdapterId,
  on: boolean,
  revision: number
): UpdateAgentToolsSettingsRequest | null {
  if (view.locked) return null;
  const value = on === view.catalogDefaults[agent] ? null : on;
  return { revision, defaults: { [view.id]: { [agent]: value } } };
}

/** Every customised cell back to the catalogue default. */
export function matrixResetUpdate(toolsets: readonly AgentToolsetView[], revision: number): UpdateAgentToolsSettingsRequest | null {
  const defaults: NonNullable<UpdateAgentToolsSettingsRequest["defaults"]> = {};
  for (const view of toolsets) {
    if (view.locked) continue;
    for (const agent of AGENT_TOOLS_AGENTS) {
      if (view.defaults[agent] !== view.catalogDefaults[agent]) {
        defaults[view.id] = { ...(defaults[view.id] ?? {}), [agent]: null };
      }
    }
  }
  return Object.keys(defaults).length > 0 ? { revision, defaults } : null;
}

const GRANT_FAMILY_LABELS: Readonly<Record<string, string>> = {
  workflows: "Workflow changes",
  desktops: "Desktops",
  "saved-prompts": "Saved-prompt edits",
  "cross-project": "Actions in another project"
};

/** A project path's last two segments: `workspace/project`. */
export function shortProjectPath(path: string): string {
  const segments = path.split(/[/\\]/).filter(Boolean);
  return segments.length <= 2 ? segments.join("/") || path : segments.slice(-2).join("/");
}

export interface GrantLine {
  id: string;
  /** "Workflow changes" — a newer daemon's family reads as itself. */
  what: string;
  /** "This chat" / "Chat “Plan the API”" / "Project acme/web". */
  where: string;
  /** "3 workflows", "in acme/api" — or null. */
  detail: string | null;
  scope: string;
}

/**
 * How a grant reads in a list. `titleOf` names a chat by id (the open tabs); `currentThreadId`
 * makes the chat's own grants read "This chat".
 */
export function describeGrant(
  grant: AgentToolGrant,
  titleOf: (threadId: string) => string | null,
  currentThreadId?: string
): GrantLine {
  const what = GRANT_FAMILY_LABELS[grant.family] ?? grant.family;
  let where: string;
  if (grant.scope === "chat") {
    const title = grant.threadId ? titleOf(grant.threadId) : null;
    where = grant.threadId !== undefined && grant.threadId === currentThreadId ? "This chat" : title ? `Chat “${title}”` : "A chat";
  } else if (grant.scope === "project") {
    where = `Project ${shortProjectPath(grant.projectPath)}`;
  } else {
    where = grant.scope;
  }
  const parts: string[] = [];
  if (grant.workflowIds && grant.workflowIds.length > 0) {
    parts.push(`${grant.workflowIds.length} workflow${grant.workflowIds.length === 1 ? "" : "s"}`);
  }
  if (grant.targetProjectPath) parts.push(`in ${shortProjectPath(grant.targetProjectPath)}`);
  return { id: grant.id, what, where, detail: parts.length > 0 ? parts.join(" · ") : null, scope: grant.scope };
}

/** The footnote under the matrix (spec §9.2). */
export const AGENT_TOOLS_APPLY_NOTE =
  "Changes reach open chats at their next idle point (the agent session restarts and keeps the conversation).";
