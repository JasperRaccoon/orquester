/**
 * Settings › Agent tools (unified MCP §7.6) — the pure half: how a grant reads (shared with the
 * chat's Tools chip).
 *
 * No React import. Tested by `agent-tools-settings.logic.test.ts`.
 */

import type { AgentToolGrant } from "@orquester/api";

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
