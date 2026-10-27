// agent-tools.json — the in-chat Orquester tools' approval grants (unified MCP design 2026-10-15
// §7.6, §9.6).
//
//   <appdir>/daemon/agent-tools.json   (`agentToolsFile`, index.ts)
//
// This module imports only zod: the path helper lives in index.ts, which re-exports this file.
//
// Every chat tool is on in every chat: this build reads only `grants`. Older builds also kept
// toolset switches here (`revision`, `enabled`, `toolsets.defaults` / `toolsets.threads`,
// `toolsetDeclines`); this build no longer interprets them but keeps them VERBATIM with every
// other key it does not know (`extra`), so an older build reading the file finds its data intact.
// A deleted chat's rows of those legacy keys still go with it ({@link removeThreadFromAgentTools}).
// No `version` bump: no field changed its type or meaning — this build only stopped reading some.
//
// Tolerance (AGENTS.md): unknown top-level keys and grants of unknown families or scopes are all
// kept and written back unchanged; a grant entry that does not read is kept verbatim
// (`unreadableGrants`) and never honoured. Anything that is not a version-1 file THROWS, so the
// daemon moves it aside and starts from the defaults — with no grants (fail closed).
//
// **Any change to an existing field's TYPE or MEANING must bump the file `version`** (the
// saved-prompts rule).

import { z } from "zod";

// ---------------------------------------------------------------------------
// The grant table (§7.6) — shared with `@orquester/api` (`GRANT_TABLE` re-exports it)
// ---------------------------------------------------------------------------

/** Where a grant applies: this chat only, or every chat of the caller's project. */
export type AgentToolGrantScope = "chat" | "project";

/**
 * Per approval family, the grant scopes a `full-access` caller may be offered (spec §7.6). Every
 * family absent here, or mapped to `[]`, is never grantable: `agent-profile`, `workflow-secrets`,
 * `secret-files`, the read boundaries, older builds' toolset cards and `boxes` (spend cards).
 */
export const AGENT_TOOL_GRANT_SCOPES: Readonly<Record<string, readonly AgentToolGrantScope[]>> = {
  workflows: ["chat"],
  desktops: ["chat", "project"],
  "saved-prompts": ["chat"],
  "cross-project": ["chat"],
  "agent-profile": [],
  "workflow-secrets": [],
  "secret-files": [],
  "cross-project-read": [],
  "cross-workspace-read": [],
  toolset: [],
  // boxes: renting a temporary box spends money — the owner approves every one (Ephemeral AI VMs spec §13.2).
  boxes: [],
  // devices: renting a device host spends money — a card per rental the owner did not pre-approve (devices spec §6.3).
  devices: []
};

/** The grant scopes `family` allows at all (before the per-call rules of {@link findGrant}). */
export function grantScopesOf(family: string): readonly AgentToolGrantScope[] {
  return Object.prototype.hasOwnProperty.call(AGENT_TOOL_GRANT_SCOPES, family) ? AGENT_TOOL_GRANT_SCOPES[family]! : [];
}

// ---------------------------------------------------------------------------
// Persisted shape
// ---------------------------------------------------------------------------

/**
 * One grant (spec §7.6 "Records"). `family` and `scope` are plain strings on read so a newer
 * build's grant survives an older build's rewrite; {@link findGrant} honours only the families and
 * scopes this build knows.
 */
export const agentToolGrantRecordSchema = z
  .object({
    id: z.string().min(1).max(200),
    family: z.string().min(1).max(64),
    scope: z.string().min(1).max(32),
    /** The caller's project (canonical path) when the grant was made. */
    projectPath: z.string(),
    /** Chat grants: the chat (= session/thread id). Deleted with that thread. */
    threadId: z.string().min(1).max(200).optional(),
    /** `cross-project` grants: the one other-workspace project they cover. */
    targetProjectPath: z.string().min(1).optional(),
    /** `workflows` chat grants: the workflows created or approved in that chat. */
    workflowIds: z.array(z.string().min(1).max(200)).optional(),
    createdAt: z.string(),
    lastUsedAt: z.string().optional()
  })
  .passthrough();
export type AgentToolGrantRecord = z.infer<typeof agentToolGrantRecordSchema>;

export interface AgentToolsFile {
  version: 1;
  grants: AgentToolGrantRecord[];
  /** Grant entries this build cannot read, kept verbatim and never honoured. */
  unreadableGrants: unknown[];
  /**
   * Every top-level key this build does not know, exactly as found — older builds' toolset
   * switches (`revision`, `enabled`, `toolsets`, `toolsetDeclines`) among them.
   */
  extra?: Record<string, unknown>;
}

export function createDefaultAgentToolsFile(): AgentToolsFile {
  return { version: 1, grants: [], unreadableGrants: [] };
}

const KNOWN_KEYS = new Set(["version", "grants"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Own entries only, built with `fromEntries` so a key such as `__proto__` stays an own key. */
function entriesOf(value: unknown): [string, unknown][] {
  return isPlainRecord(value) ? Object.entries(value) : [];
}

/**
 * Read `agent-tools.json`. Tolerant of what another build of the same version wrote; THROWS on
 * anything that is not a version-1 file (not an object, another `version`, `grants` not a list)
 * so the caller moves it aside and applies the defaults — grants then read as none.
 */
export function parseAgentToolsFile(raw: unknown): AgentToolsFile {
  if (!isPlainRecord(raw)) throw new Error("Not an agent-tools file (not an object)");
  if (raw.version !== undefined && raw.version !== 1) {
    throw new Error(`Not a version-1 agent-tools file (version ${JSON.stringify(raw.version)})`);
  }
  if (raw.grants !== undefined && !Array.isArray(raw.grants)) throw new Error("Not an agent-tools file (grants is not a list)");
  const grants: AgentToolGrantRecord[] = [];
  const unreadableGrants: unknown[] = [];
  const ids = new Set<string>();
  for (const entry of (raw.grants as unknown[] | undefined) ?? []) {
    const parsed = agentToolGrantRecordSchema.safeParse(entry);
    if (parsed.success && !ids.has(parsed.data.id)) {
      ids.add(parsed.data.id);
      grants.push(parsed.data);
    } else {
      unreadableGrants.push(entry);
    }
  }
  const extra = Object.fromEntries(entriesOf(raw).filter(([key]) => !KNOWN_KEYS.has(key)));
  return {
    version: 1,
    grants,
    unreadableGrants,
    ...(Object.keys(extra).length > 0 ? { extra } : {})
  };
}

/** The file as written: unknown keys first, then the known ones; unreadable grants after the readable ones. */
export function serializeAgentToolsFile(file: AgentToolsFile): string {
  return JSON.stringify(
    {
      ...(file.extra ?? {}),
      version: 1,
      grants: [...file.grants, ...file.unreadableGrants]
    },
    null,
    2
  );
}

// ---------------------------------------------------------------------------
// Grants (§7.6)
// ---------------------------------------------------------------------------

/** One gated call, as the gate asks whether a grant already covers it. */
export interface AgentToolGrantQuery {
  /** The card's family (`AdminFamily` or a boundary family). */
  family: string;
  /** The caller's permission mode NOW: only `full-access` is ever honoured a grant. */
  callerRuntimeMode: string;
  /** A workflow-owned caller (spec §5.4) never uses a grant. */
  workflowOwned: boolean;
  /** The calling chat. */
  threadId: string;
  /** The caller's own project (canonical); "" when the chat has none. */
  projectPath: string;
  /**
   * Admin: every project the call reads or changes (`ScopeClaim.projects`; for workflows the whole
   * union). Any member other than `projectPath` makes the call cross-project Admin: never granted.
   */
  projects: readonly string[];
  /** A workflow temp project not created yet (`ScopeClaim.pendingProjects`): never granted. */
  pendingProjects?: number;
  /**
   * Workspace-level targets the call reaches (`ScopeClaim.workspaces`: data a workspace owns outside
   * any project): outside the caller's project, so an Admin call reaching any is never granted.
   */
  workspaceTargets?: number;
  /** `cross-project`: the other-workspace project the Act targets. */
  targetProjectPath?: string;
  /** `workflows`: the workflow acted on; absent for a create, which a grant never covers. */
  workflowId?: string;
  /** `workflows` family raised by a saved-prompt edit a workflow references: never granted. */
  workflowReferencedPrompt?: boolean;
}

/**
 * The grant that covers `query`, or null (spec §7.6, MUST 8): only a `full-access`, non
 * workflow-owned caller; only families and scopes the table allows; Admin only inside the caller's
 * own project (a workflow's whole union); `workflows` only for a workflow created or approved in
 * that chat; `cross-project` only for its one target project. Grants of unknown families or
 * scopes, or of another chat, never match.
 */
export function findGrant(file: AgentToolsFile, query: AgentToolGrantQuery): AgentToolGrantRecord | null {
  if (query.callerRuntimeMode !== "full-access" || query.workflowOwned) return null;
  const scopes = grantScopesOf(query.family);
  if (scopes.length === 0 || query.workflowReferencedPrompt === true) return null;
  const chatGrant = (grant: AgentToolGrantRecord): boolean =>
    grant.scope === "chat" && scopes.includes("chat") && grant.threadId === query.threadId && grant.projectPath === query.projectPath;
  if (query.family === "cross-project") {
    const target = query.targetProjectPath;
    if (!target) return null;
    return file.grants.find((grant) => grant.family === "cross-project" && chatGrant(grant) && grant.targetProjectPath === target) ?? null;
  }
  // Admin families: never across projects, never for a temp project not created yet.
  if (
    query.projectPath === "" ||
    (query.pendingProjects ?? 0) > 0 ||
    (query.workspaceTargets ?? 0) > 0 ||
    query.projects.some((project) => project !== query.projectPath)
  ) {
    return null;
  }
  for (const grant of file.grants) {
    if (grant.family !== query.family) continue;
    if (query.family === "workflows") {
      if (chatGrant(grant) && query.workflowId !== undefined && (grant.workflowIds ?? []).includes(query.workflowId)) return grant;
      continue;
    }
    if (chatGrant(grant)) return grant;
    if (grant.scope === "project" && scopes.includes("project") && grant.projectPath === query.projectPath) return grant;
  }
  return null;
}

/** `record` without its own key `key`, or `record` itself when it has none (or is not an object). */
function withoutKey(record: unknown, key: string): unknown {
  if (!isPlainRecord(record) || !Object.prototype.hasOwnProperty.call(record, key)) return record;
  return Object.fromEntries(entriesOf(record).filter(([k]) => k !== key));
}

/**
 * `file` without anything of `threadId` (spec §9.6: "thread entries and chat grants are deleted
 * with their thread"): its chat grants, and its rows of older builds' legacy keys
 * (`toolsets.threads`, `toolsetDeclines`). Project grants stay. A new object, or `file` itself
 * when nothing of the thread is in it; `file` is not changed.
 */
export function removeThreadFromAgentTools(file: AgentToolsFile, threadId: string): AgentToolsFile {
  const grants = file.grants.filter((grant) => !(grant.scope === "chat" && grant.threadId === threadId));
  let extra = file.extra;
  if (extra) {
    const toolsets = extra.toolsets;
    const threads = isPlainRecord(toolsets) ? withoutKey(toolsets.threads, threadId) : undefined;
    const declines = withoutKey(extra.toolsetDeclines, threadId);
    if (isPlainRecord(toolsets) && threads !== toolsets.threads) extra = { ...extra, toolsets: { ...toolsets, threads } };
    if (declines !== extra.toolsetDeclines) extra = { ...extra, toolsetDeclines: declines };
  }
  if (grants.length === file.grants.length && extra === file.extra) return file;
  return { ...file, grants, ...(extra ? { extra } : {}) };
}
