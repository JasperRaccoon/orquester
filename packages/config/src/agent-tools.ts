// agent-tools.json — the in-chat Orquester tools' settings, chat toolset overrides, toolset
// declines and approval grants (unified MCP design 2026-10-15 §9.6, §7.6).
//
//   <appdir>/daemon/agent-tools.json   (`agentToolsFile`, index.ts)
//
// This module imports only zod: the path helper lives in index.ts, which re-exports this file.
// The toolset catalogue (ids, labels, tools, per-agent defaults) lives in `@orquester/api`
// (`TOOLSETS`, `agent-tools.ts`); the resolver below takes it as an argument because this package
// cannot import that one.
//
// Tolerance (AGENTS.md): unknown top-level keys, unknown toolset ids, unknown agents and grants of
// unknown families or scopes are all kept and written back unchanged; a grant entry that does not
// read is kept verbatim (`unreadableGrants`) and never honoured. Anything that is not a version-1
// file THROWS, so the daemon moves it aside and starts from the defaults — with no grants (fail
// closed).
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
 * the read boundaries and toolset cards.
 */
export const AGENT_TOOL_GRANT_SCOPES: Readonly<Record<string, readonly AgentToolGrantScope[]>> = {
  workflows: ["chat"],
  desktops: ["chat", "project"],
  "saved-prompts": ["chat"],
  "cross-project": ["chat"],
  "agent-profile": [],
  "workflow-secrets": [],
  "cross-project-read": [],
  "cross-workspace-read": [],
  toolset: []
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

/** `toolsetId -> agentId -> on` (settings defaults) or `threadId -> toolsetId -> on` (chat overrides). */
export type AgentToolsBooleanMatrix = Record<string, Record<string, boolean>>;

export interface AgentToolsFile {
  version: 1;
  /** Bumped by every settings write; `PUT /api/agent-tools/settings` must name the current one. */
  revision: number;
  /** The master switch: off = only locked toolsets (`core`) in every chat. */
  enabled: boolean;
  toolsets: {
    /** Settings › Agent tools: `toolsetId -> agentId -> on`. Absent cells use the catalogue default. */
    defaults: AgentToolsBooleanMatrix;
    /** The chat's Tools chip / an approved `request_toolset`: `threadId -> toolsetId -> on`. */
    threads: AgentToolsBooleanMatrix;
    /** Every other key of `toolsets`, exactly as found. */
    extra?: Record<string, unknown>;
  };
  /** `threadId -> toolsetId -> ISO time the user denied the toolset card`. */
  toolsetDeclines: Record<string, Record<string, string>>;
  /**
   * Rows and cells of the three matrices this build cannot read (a non-object row, a non-boolean
   * or non-string cell — a newer build's value), kept VERBATIM and merged back on rewrite; never
   * honoured. A row's entry is the raw row when the row itself is unreadable, else an object of
   * its unreadable cells. Delete a thread with {@link removeThreadFromAgentTools}, which drops its
   * leftovers here too.
   */
  unreadableCells?: {
    defaults?: Record<string, unknown>;
    threads?: Record<string, unknown>;
    toolsetDeclines?: Record<string, unknown>;
  };
  grants: AgentToolGrantRecord[];
  /** Grant entries this build cannot read, kept verbatim and never honoured. */
  unreadableGrants: unknown[];
  /** Every top-level key this build does not know, exactly as found. */
  extra?: Record<string, unknown>;
}

export function createDefaultAgentToolsFile(): AgentToolsFile {
  return { version: 1, revision: 0, enabled: true, toolsets: { defaults: {}, threads: {} }, toolsetDeclines: {}, grants: [], unreadableGrants: [] };
}

const KNOWN_KEYS = new Set(["version", "revision", "enabled", "toolsets", "toolsetDeclines", "grants"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Own entries only, built with `fromEntries` so a key such as `__proto__` stays an own key. */
function entriesOf(value: unknown): [string, unknown][] {
  return isPlainRecord(value) ? Object.entries(value) : [];
}

/** A matrix split into the cells this build reads and the rest, kept verbatim ({@link mergeMatrix} reverses it). */
function readMatrix<T>(
  value: unknown,
  where: string,
  isCell: (cell: unknown) => cell is T
): { rows: Record<string, Record<string, T>>; unreadable: Record<string, unknown> } {
  if (value === undefined) return { rows: {}, unreadable: {} };
  if (!isPlainRecord(value)) throw new Error(`Not an agent-tools file (${where} is not an object)`);
  const rows: [string, Record<string, T>][] = [];
  const unreadable: [string, unknown][] = [];
  for (const [key, row] of entriesOf(value)) {
    if (!isPlainRecord(row)) {
      unreadable.push([key, row]);
      continue;
    }
    const good = entriesOf(row).filter((cell): cell is [string, T] => isCell(cell[1]));
    const bad = entriesOf(row).filter(([, cell]) => !isCell(cell));
    rows.push([key, Object.fromEntries(good)]);
    if (bad.length > 0) unreadable.push([key, Object.fromEntries(bad)]);
  }
  return { rows: Object.fromEntries(rows), unreadable: Object.fromEntries(unreadable) };
}

/** The matrix as written: every readable row with its unreadable cells put back; unreadable rows as found. */
function mergeMatrix(rows: Record<string, Record<string, unknown>>, unreadable: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: [string, unknown][] = [];
  for (const [key, row] of entriesOf(rows)) {
    const leftover = unreadable && Object.prototype.hasOwnProperty.call(unreadable, key) ? unreadable[key] : undefined;
    out.push([key, isPlainRecord(leftover) ? { ...leftover, ...(row as Record<string, unknown>) } : row]);
  }
  for (const [key, leftover] of entriesOf(unreadable)) {
    if (!Object.prototype.hasOwnProperty.call(rows, key)) out.push([key, leftover]);
  }
  return Object.fromEntries(out);
}

const isBoolean = (cell: unknown): cell is boolean => typeof cell === "boolean";
const isString = (cell: unknown): cell is string => typeof cell === "string";

/**
 * Read `agent-tools.json`. Tolerant of what a newer build of the same version wrote; THROWS on
 * anything that is not a version-1 file (not an object, another `version`, `grants` not a list, a
 * `toolsets` matrix that is not an object) so the caller moves it aside and applies the defaults —
 * grants then read as none.
 */
export function parseAgentToolsFile(raw: unknown): AgentToolsFile {
  if (!isPlainRecord(raw)) throw new Error("Not an agent-tools file (not an object)");
  if (raw.version !== undefined && raw.version !== 1) {
    throw new Error(`Not a version-1 agent-tools file (version ${JSON.stringify(raw.version)})`);
  }
  if (raw.grants !== undefined && !Array.isArray(raw.grants)) throw new Error("Not an agent-tools file (grants is not a list)");
  if (raw.toolsets !== undefined && !isPlainRecord(raw.toolsets)) throw new Error("Not an agent-tools file (toolsets is not an object)");
  const toolsetsRaw = isPlainRecord(raw.toolsets) ? raw.toolsets : {};
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
  const toolsetsExtra = Object.fromEntries(entriesOf(toolsetsRaw).filter(([key]) => key !== "defaults" && key !== "threads"));
  const extra = Object.fromEntries(entriesOf(raw).filter(([key]) => !KNOWN_KEYS.has(key)));
  const revision = typeof raw.revision === "number" && Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0;
  const defaults = readMatrix(toolsetsRaw.defaults, "toolsets.defaults", isBoolean);
  const threads = readMatrix(toolsetsRaw.threads, "toolsets.threads", isBoolean);
  const declines = readMatrix(raw.toolsetDeclines, "toolsetDeclines", isString);
  const unreadableCells = Object.fromEntries(
    (
      [
        ["defaults", defaults.unreadable],
        ["threads", threads.unreadable],
        ["toolsetDeclines", declines.unreadable]
      ] as const
    ).filter(([, cells]) => Object.keys(cells).length > 0)
  );
  return {
    version: 1,
    revision,
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
    toolsets: {
      defaults: defaults.rows,
      threads: threads.rows,
      ...(Object.keys(toolsetsExtra).length > 0 ? { extra: toolsetsExtra } : {})
    },
    toolsetDeclines: declines.rows,
    ...(Object.keys(unreadableCells).length > 0 ? { unreadableCells } : {}),
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
      revision: file.revision,
      enabled: file.enabled,
      toolsets: {
        ...(file.toolsets.extra ?? {}),
        defaults: mergeMatrix(file.toolsets.defaults, file.unreadableCells?.defaults),
        threads: mergeMatrix(file.toolsets.threads, file.unreadableCells?.threads)
      },
      toolsetDeclines: mergeMatrix(file.toolsetDeclines, file.unreadableCells?.toolsetDeclines),
      grants: [...file.grants, ...file.unreadableGrants]
    },
    null,
    2
  );
}

// ---------------------------------------------------------------------------
// Toolset resolution (§9.2)
// ---------------------------------------------------------------------------

/** What the resolver needs of a toolset (`@orquester/api`'s `TOOLSETS` entries satisfy it). */
export interface AgentToolsetDefaults {
  id: string;
  /** Always on (`core`): no setting, override or master switch turns it off. */
  locked: boolean;
  /** The catalogue default per agent; an agent absent here is off. */
  defaults: Readonly<Partial<Record<string, boolean>>>;
}

/**
 * The toolsets on in one chat, in catalogue order: locked toolsets always; with the master switch
 * off nothing else; otherwise the chat's override, else the Settings default for its agent, else
 * the catalogue default. Unknown ids in the file are ignored (and kept by the file).
 */
export function resolveThreadToolsets(
  file: AgentToolsFile,
  input: { threadId: string; agent: string; toolsets: readonly AgentToolsetDefaults[] }
): string[] {
  const overrides = ownRow(file.toolsets.threads, input.threadId);
  return input.toolsets
    .filter((toolset) => {
      if (toolset.locked) return true;
      if (!file.enabled) return false;
      const override = ownCell(overrides, toolset.id);
      if (override !== undefined) return override;
      const setting = ownCell(ownRow(file.toolsets.defaults, toolset.id), input.agent);
      if (setting !== undefined) return setting;
      return ownCell(toolset.defaults, input.agent) === true;
    })
    .map((toolset) => toolset.id);
}

function ownRow<T>(matrix: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(matrix, key) ? matrix[key] : undefined;
}

function ownCell(row: Readonly<Partial<Record<string, boolean>>> | undefined, key: string): boolean | undefined {
  if (!row || !Object.prototype.hasOwnProperty.call(row, key)) return undefined;
  const value = row[key];
  return typeof value === "boolean" ? value : undefined;
}

/** How long a denied toolset card blocks asking for that toolset again (spec §5.6, `TOOLSET_DECLINED`). */
export const AGENT_TOOLSET_DECLINE_MS = 30 * 60 * 1000;

/** The time (ms) until which `toolset` is declined in `threadId`, or null when it may be asked for. */
export function toolsetDeclinedUntil(file: AgentToolsFile, threadId: string, toolset: string, nowMs: number): number | null {
  const at = ownRow(ownRow(file.toolsetDeclines, threadId) ?? {}, toolset);
  if (typeof at !== "string") return null;
  const declinedAt = Date.parse(at);
  if (!Number.isFinite(declinedAt)) return null;
  const until = declinedAt + AGENT_TOOLSET_DECLINE_MS;
  return until > nowMs ? until : null;
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

/**
 * `file` without anything of `threadId` (spec §9.6: "thread entries and chat grants are deleted
 * with their thread"): its toolset overrides, its declines, their unreadable leftovers and its chat
 * grants. Project grants stay. A new object; `file` is not changed.
 */
export function removeThreadFromAgentTools(file: AgentToolsFile, threadId: string): AgentToolsFile {
  const without = <T>(record: Record<string, T> | undefined): Record<string, T> =>
    Object.fromEntries(entriesOf(record).filter(([key]) => key !== threadId)) as Record<string, T>;
  const unreadableCells = file.unreadableCells
    ? {
        ...(file.unreadableCells.defaults ? { defaults: file.unreadableCells.defaults } : {}),
        threads: without(file.unreadableCells.threads),
        toolsetDeclines: without(file.unreadableCells.toolsetDeclines)
      }
    : undefined;
  return {
    ...file,
    toolsets: { ...file.toolsets, threads: without(file.toolsets.threads) },
    toolsetDeclines: without(file.toolsetDeclines),
    ...(unreadableCells ? { unreadableCells } : {}),
    grants: file.grants.filter((grant) => !(grant.scope === "chat" && grant.threadId === threadId))
  };
}
