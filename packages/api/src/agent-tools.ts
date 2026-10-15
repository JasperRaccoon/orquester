/**
 * Agent tools — the in-chat Orquester tools' toolsets, tiers, grants and settings (unified MCP
 * design 2026-10-15 §6, §7.6, §9).
 *
 * One catalog serves external MCP clients and in-chat agents; for chats it is cut into TOOLSETS
 * the user turns on per agent (Settings › Agent tools) or per chat (the Tools chip, or an approved
 * `request_toolset` card). `core` is locked on. The daemon persists the choices and the grants in
 * `agent-tools.json` (`@orquester/config`'s `parseAgentToolsFile`, `resolveThreadToolsets`,
 * `findGrant`).
 *
 * Routes (both transports, bearer on HTTP): {@link agentToolsRoutes} and
 * `agentChatRoutes.agentTools(sessionId)`. Bus: channel {@link AGENT_TOOLS_CHANNEL}, event
 * {@link AGENT_TOOLS_CHANGED_EVENT}.
 */

import { AGENT_TOOL_GRANT_SCOPES, AGENT_TOOLSET_DECLINE_MS } from "@orquester/config";

import type { AgentAdapterId, RuntimeMode } from "./agent-chat/adapter-types.ts";
import type { ApprovalFamily, ToolApprovalGrantScope } from "./agent-chat/tool-approvals.ts";

// ---------------------------------------------------------------------------
// Tiers and toolsets (§6, §9.1)
// ---------------------------------------------------------------------------

/**
 * A tool's tier for chat callers (external callers are full trust): `read` changes nothing;
 * `act` changes Orquester state the user can see and undo, or stops work; `admin` is persistent or
 * runs code outside the agent's sandbox, and always raises a card.
 */
export type ToolTier = "read" | "act" | "admin";
export const TOOL_TIERS: readonly ToolTier[] = ["read", "act", "admin"];

export const TOOLSET_IDS = [
  "core",
  "reads",
  "notes",
  "chat-extras",
  "files-git",
  "workflow-authoring",
  "agent-profile-editing",
  "desktops"
] as const;
export type ToolsetId = (typeof TOOLSET_IDS)[number];

export function isToolsetId(value: unknown): value is ToolsetId {
  return typeof value === "string" && (TOOLSET_IDS as readonly string[]).includes(value);
}

/** The agents the Settings matrix has a column for, in its order. */
export const AGENT_TOOLS_AGENTS: readonly AgentAdapterId[] = ["claude", "codex", "grok", "opencode"];

/**
 * One tool of a toolset with its tier badge: the HIGHEST tier the tool reaches for a chat caller
 * (`control_desktop` is Admin for `open`/`launch_app` and Act otherwise → `admin`; `create_workflow`
 * is Read with `dryRun` → `admin`). `request_toolset` reads `act`: it raises a toolset card, never
 * an Admin one. The catalog's own tiers (daemon `mcp/catalog`) must agree (its registry test).
 */
export interface ToolsetToolSpec {
  name: string;
  tier: ToolTier;
}

export interface ToolsetSpec {
  id: ToolsetId;
  /** The Settings matrix row and the toolset card's name for it. */
  label: string;
  tools: readonly ToolsetToolSpec[];
  /** Always on; no setting, override or master switch turns it off. */
  locked: boolean;
  /** The catalogue default per agent (before Settings and chat overrides). */
  defaults: Readonly<Record<AgentAdapterId, boolean>>;
}

const ALL_ON: Readonly<Record<AgentAdapterId, boolean>> = { claude: true, codex: true, grok: true, opencode: true };
const ALL_OFF: Readonly<Record<AgentAdapterId, boolean>> = { claude: false, codex: false, grok: false, opencode: false };

const read = (name: string): ToolsetToolSpec => ({ name, tier: "read" });
const act = (name: string): ToolsetToolSpec => ({ name, tier: "act" });
const admin = (name: string): ToolsetToolSpec => ({ name, tier: "admin" });

/**
 * Every toolset, in Settings order, with its tools in catalog order (spec §9.1): 45 chat tools,
 * 22 on by default (`core` + `reads`). If the measured default set exceeds its byte budget, `reads`
 * defaults off for Codex and OpenCode (spec §9.5 fallback) — a change to `defaults` here only.
 */
export const TOOLSETS: readonly ToolsetSpec[] = [
  {
    id: "core",
    label: "Chats & delegation",
    locked: true,
    defaults: ALL_ON,
    tools: [
      read("list_projects"),
      read("list_agents"),
      read("list_sessions"),
      read("get_session"),
      read("read_transcript"),
      read("search_sessions"),
      act("create_session"),
      act("send_message"),
      read("wait_for_session"),
      act("control_session"),
      act("fork_session"),
      act("merge_back_session"),
      read("get_usage"),
      read("html_preview"),
      act("html_render"),
      act("request_secret"),
      act("request_toolset")
    ]
  },
  {
    id: "reads",
    label: "Workflows, profiles & prompts (read)",
    locked: false,
    defaults: ALL_ON,
    tools: [read("list_workflows"), read("get_workflow"), read("get_workflow_runs"), read("get_agent_profile"), read("list_saved_prompts")]
  },
  {
    id: "notes",
    label: "Todos & saved-prompt editing",
    locked: false,
    defaults: ALL_OFF,
    tools: [read("list_todos"), act("update_todos"), admin("update_saved_prompts")]
  },
  {
    id: "chat-extras",
    label: "More chat control",
    locked: false,
    defaults: ALL_OFF,
    tools: [
      act("update_session"),
      act("respond_to_request"),
      read("get_turn_diff"),
      read("read_tool_output"),
      read("list_conversations"),
      act("notify_user")
    ]
  },
  {
    id: "files-git",
    label: "Files & git (read)",
    locked: false,
    defaults: ALL_OFF,
    tools: [read("read_file"), read("get_git_state")]
  },
  {
    id: "workflow-authoring",
    label: "Workflow authoring (changes need your approval)",
    locked: false,
    defaults: ALL_OFF,
    tools: [
      read("list_workflow_block_types"),
      admin("create_workflow"),
      admin("update_workflow"),
      admin("delete_workflow"),
      read("preview_expression"),
      admin("run_workflow"),
      act("cancel_workflow_run"),
      read("list_workflow_secrets"),
      admin("set_workflow_secret")
    ]
  },
  {
    id: "agent-profile-editing",
    label: "Agent-profile changes (need your approval)",
    locked: false,
    defaults: ALL_OFF,
    tools: [admin("edit_agent_profile")]
  },
  {
    id: "desktops",
    label: "Desktops (opening needs your approval)",
    locked: false,
    defaults: ALL_OFF,
    tools: [read("get_desktops"), admin("control_desktop")]
  }
];

/** A toolset by id. */
export function toolsetById(id: ToolsetId): ToolsetSpec {
  return TOOLSETS.find((toolset) => toolset.id === id)!;
}

/** The toolset a chat tool belongs to, or undefined for a name no toolset lists. */
export function toolsetOfTool(name: string): ToolsetId | undefined {
  return TOOLSETS.find((toolset) => toolset.tools.some((tool) => tool.name === name))?.id;
}

/** Every chat tool name, in toolset then catalog order. */
export function chatToolNames(): string[] {
  return TOOLSETS.flatMap((toolset) => toolset.tools.map((tool) => tool.name));
}

/** The toolsets on for an agent when nothing is configured (the catalogue defaults). */
export function defaultToolsetsFor(agent: AgentAdapterId): ToolsetId[] {
  return TOOLSETS.filter((toolset) => toolset.locked || toolset.defaults[agent]).map((toolset) => toolset.id);
}

// ---------------------------------------------------------------------------
// Grants (§7.6)
// ---------------------------------------------------------------------------

export type GrantScope = ToolApprovalGrantScope;

/** The families a grant can ever be made for. */
export type GrantFamily = "workflows" | "desktops" | "saved-prompts" | "cross-project";

/**
 * Per card family, the grant scopes a `full-access` caller may be offered (spec §7.6). The
 * per-call rules on top — full-access only, never for workflow-owned callers, never across
 * projects for Admin, never for workflow-referenced prompt edits — are {@link grantOptionsFor}'s
 * (cards) and `findGrant`'s (`@orquester/config`, honouring).
 */
export const GRANT_TABLE = AGENT_TOOL_GRANT_SCOPES as Readonly<Record<ApprovalFamily, readonly GrantScope[]>>;

export interface GrantOptionsInput {
  family: ApprovalFamily;
  /** The caller's permission mode when the card opens. */
  callerRuntimeMode: RuntimeMode;
  workflowOwned: boolean;
  /**
   * Admin: the call reaches a project other than the caller's own (any member of a workflow's
   * project union, a temp project in a workspace, a prompt or desktop of another project).
   */
  crossProject: boolean;
  /** A `workflows` card raised by editing a saved prompt a workflow references. */
  workflowReferencedPrompt?: boolean;
}

/** The `grantOptions` a card offers (spec §7.6, MUST 8): empty unless every rule allows one. */
export function grantOptionsFor(input: GrantOptionsInput): GrantScope[] {
  if (input.callerRuntimeMode !== "full-access" || input.workflowOwned) return [];
  if (input.workflowReferencedPrompt === true) return [];
  if (input.family !== "cross-project" && input.crossProject) return [];
  return [...(GRANT_TABLE[input.family] ?? [])];
}

/** A grant as the wire shows it (`agent-tools.json`'s record; spec §7.6 "Records"). */
export interface AgentToolGrant {
  id: string;
  /** A {@link GrantFamily}; a newer build's family reads as a plain string and is never honoured here. */
  family: GrantFamily | (string & {});
  scope: GrantScope | (string & {});
  /** The caller's project when the grant was made. */
  projectPath: string;
  /** Chat grants: the chat. */
  threadId?: string;
  /** `cross-project` grants: the one other-workspace project. */
  targetProjectPath?: string;
  /** `workflows` chat grants: the workflows created or approved in that chat. */
  workflowIds?: string[];
  createdAt: string;
  lastUsedAt?: string;
}

// ---------------------------------------------------------------------------
// Settings and chat toolsets — wire
// ---------------------------------------------------------------------------

/** One toolset as Settings › Agent tools shows it. */
export interface AgentToolsetView {
  id: ToolsetId;
  label: string;
  locked: boolean;
  tools: ToolsetToolSpec[];
  /** The toolset's `tools/list` bytes as the host serialises them (spec §9.5), when measured. */
  bytes?: number;
  /** The catalogue default per agent. */
  catalogDefaults: Record<AgentAdapterId, boolean>;
  /** The effective default per agent: the Settings cell, else the catalogue default. */
  defaults: Record<AgentAdapterId, boolean>;
}

/** `GET /api/agent-tools` — Settings › Agent tools. */
export interface AgentToolsResponse {
  /** Pass it back on `PUT /api/agent-tools/settings`. */
  revision: number;
  /** The master switch: off = only locked toolsets in every chat. */
  enabled: boolean;
  toolsets: AgentToolsetView[];
  /** Every grant, newest first. */
  grants: AgentToolGrant[];
}

/**
 * `PUT /api/agent-tools/settings` → {@link AgentToolsResponse}. `defaults` cells are merged
 * (`null` clears one back to the catalogue default); a locked toolset's cells are refused. A stale
 * `revision` is 409 `REVISION_MISMATCH`.
 */
export interface UpdateAgentToolsSettingsRequest {
  revision: number;
  enabled?: boolean;
  defaults?: Partial<Record<ToolsetId, Partial<Record<AgentAdapterId, boolean | null>>>>;
}

/** `GET agentChatRoutes.agentTools(sessionId)` — the chat's Tools chip. */
export interface ThreadAgentToolsResponse {
  threadId: string;
  agent: AgentAdapterId;
  /** The chat's own overrides (absent toolset = inherit the agent default). */
  overrides: Partial<Record<ToolsetId, boolean>>;
  /** The toolsets on in this chat now, in catalog order. */
  resolved: ToolsetId[];
  /** Workflow-owned chats get no Admin tools and no cards (spec §5.4). */
  workflowOwned: boolean;
  /** This chat's grants and its project's project grants. */
  grants: AgentToolGrant[];
}

/**
 * `PUT agentChatRoutes.agentTools(sessionId)` → {@link ThreadAgentToolsResponse}: set (`true` /
 * `false`) or clear (`null` = inherit) this chat's overrides. Locked toolsets are refused. Takes
 * effect at the chat's next idle point.
 */
export interface UpdateThreadAgentToolsRequest {
  toolsets: Partial<Record<ToolsetId, boolean | null>>;
}

/** `DELETE /api/agent-tools/grants?threadId=` (Revoke all, or all of one chat) → this. */
export interface RevokeAgentToolGrantsResponse {
  revoked: number;
}

/** The routes' own refusals (besides `INVALID_ARGUMENT`, `THREAD_NOT_FOUND`). */
export type AgentToolsErrorCode = "REVISION_MISMATCH" | "GRANT_NOT_FOUND" | "TOOLSET_LOCKED";

/** The daemon-owned agent-tools routes (both transports). */
export const agentToolsRoutes = {
  /** `GET` → {@link AgentToolsResponse}. */
  settings: "/api/agent-tools",
  /** `PUT` {@link UpdateAgentToolsSettingsRequest} → {@link AgentToolsResponse}. */
  updateSettings: "/api/agent-tools/settings",
  /** `DELETE` (optional `?threadId=`) → {@link RevokeAgentToolGrantsResponse}. */
  grants: "/api/agent-tools/grants",
  /** `DELETE` one grant → 204; 404 `GRANT_NOT_FOUND`. */
  grant: (grantId: string): string => `/api/agent-tools/grants/${encodeURIComponent(grantId)}`
} as const;

/** The `/events` channel agent-tools changes are broadcast on. */
export const AGENT_TOOLS_CHANNEL = "agent-tools";
export const AGENT_TOOLS_CHANGED_EVENT = "agentTools.changed";

/**
 * `agentTools.changed` — coarse; the client re-reads. `threadId` when only one chat's overrides or
 * grants changed (its Tools chip re-reads); absent for a settings or project-grant change.
 */
export interface AgentToolsChangedPayload {
  revision: number;
  threadId?: string;
}

// ---------------------------------------------------------------------------
// request_toolset (§9.3)
// ---------------------------------------------------------------------------

/** A denied toolset card blocks asking for that toolset again in that chat this long (`TOOLSET_DECLINED`). */
export const TOOLSET_DECLINE_MS = AGENT_TOOLSET_DECLINE_MS;

/**
 * `request_toolset`'s result once the toolset is on in the chat: `now` — the provider re-listed its
 * tools and they can be called in this turn; `after-restart` — end the turn, the chat's provider
 * session restarts with resume and Orquester posts an automatic continue turn.
 */
export interface RequestToolsetResult {
  enabled: true;
  toolset: ToolsetId;
  available: "now" | "after-restart";
}
