/**
 * Agent tools — the in-chat Orquester tools' tiers, toolsets and grants (unified MCP design
 * 2026-10-15 §6, §7.6).
 *
 * One catalog serves external MCP clients and in-chat agents. Every chat tool is advertised to
 * every chat (a workflow-owned chat gets no always-Admin tool, §5.4); there is no per-agent or
 * per-chat switch. TOOLSETS only GROUP the tools (a label, and the `orquester/toolset` `_meta` tag
 * external clients see). Admin calls and project boundaries raise approval cards; the daemon
 * persists the grants a card makes in `agent-tools.json` (`@orquester/config`'s
 * `parseAgentToolsFile`, `findGrant`).
 *
 * Routes (both transports, bearer on HTTP): {@link agentToolsRoutes} and
 * `agentChatRoutes.agentTools(sessionId)`. Bus: channel {@link AGENT_TOOLS_CHANNEL}, event
 * {@link AGENT_TOOLS_CHANGED_EVENT}.
 */

import { AGENT_TOOL_GRANT_SCOPES } from "@orquester/config";

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

/** The groups chat tools are filed under (a label and the `orquester/toolset` tag; never a switch). */
export const TOOLSET_IDS = [
  "core",
  "reads",
  "notes",
  "chat-extras",
  "files-git",
  "workflow-authoring",
  "agent-profile-editing",
  "desktops",
  "secret-files",
  // boxes: temporary boxes for agent chats (Ephemeral AI VMs spec §13).
  "boxes"
] as const;
export type ToolsetId = (typeof TOOLSET_IDS)[number];

export function isToolsetId(value: unknown): value is ToolsetId {
  return typeof value === "string" && (TOOLSET_IDS as readonly string[]).includes(value);
}

/**
 * One tool of a toolset with its tier badge: the HIGHEST tier the tool reaches for a chat caller
 * (`control_desktop` is Admin for `open`/`launch_app` and Act otherwise → `admin`; `create_workflow`
 * is Read with `dryRun` → `admin`). The catalog's own tiers (daemon `mcp/catalog`) must agree (its
 * registry test).
 */
export interface ToolsetToolSpec {
  name: string;
  tier: ToolTier;
}

/** A group of chat tools: a label only — every toolset is on in every chat. */
export interface ToolsetSpec {
  id: ToolsetId;
  label: string;
  tools: readonly ToolsetToolSpec[];
}

const read = (name: string): ToolsetToolSpec => ({ name, tier: "read" });
const act = (name: string): ToolsetToolSpec => ({ name, tier: "act" });
const admin = (name: string): ToolsetToolSpec => ({ name, tier: "admin" });

/** Every toolset, with its tools in catalog order (spec §9.1): 54 chat tools, all advertised to every chat (the `boxes` ones while boxes can be rented). */
export const TOOLSETS: readonly ToolsetSpec[] = [
  {
    id: "core",
    label: "Chats & delegation",
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
      act("request_secret")
    ]
  },
  {
    id: "reads",
    label: "Workflows, agent config & prompts (read)",
    tools: [read("list_workflows"), read("get_workflow"), read("get_workflow_runs"), read("get_agent_profile"), read("list_saved_prompts")]
  },
  {
    id: "notes",
    label: "Todos & saved-prompt editing",
    tools: [read("list_todos"), act("update_todos"), admin("update_saved_prompts")]
  },
  {
    id: "chat-extras",
    label: "More chat control",
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
    tools: [read("read_file"), read("get_git_state")]
  },
  {
    id: "workflow-authoring",
    label: "Workflow authoring (changes need your approval)",
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
    label: "Agent-config changes (need your approval)",
    tools: [admin("edit_agent_profile")]
  },
  {
    id: "desktops",
    label: "Desktops (opening needs your approval)",
    tools: [read("get_desktops"), admin("control_desktop")]
  },
  {
    id: "secret-files",
    label: "Secret files (pushing needs your approval)",
    tools: [read("secret_files_status"), admin("push_secret_files")]
  },
  // boxes: advertised only while the Ephemeral AI VMs plugin can rent a box (`session-tools/manifest.ts`).
  // `create_box` is Act: its card is a `spend` card, raised in every permission mode.
  {
    id: "boxes",
    label: "Temporary boxes (renting needs your approval)",
    tools: [
      act("create_box"),
      read("list_boxes"),
      act("box_exec"),
      read("box_exec_output"),
      act("box_upload"),
      act("box_download"),
      act("box_forward_port"),
      act("destroy_box")
    ]
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
// Settings and the chat's Tools chip — wire
// ---------------------------------------------------------------------------

/**
 * `GET /api/agent-tools` — Settings › Agent tools. Older daemons also sent `revision`, `enabled`
 * and `toolsets` (the removed toolset switches); clients ignore them.
 */
export interface AgentToolsResponse {
  /** Every grant, newest first. */
  grants: AgentToolGrant[];
}

/** `GET agentChatRoutes.agentTools(sessionId)` — the chat's Tools chip (older daemons also sent toolset fields; ignored). */
export interface ThreadAgentToolsResponse {
  threadId: string;
  agent: AgentAdapterId;
  /** Workflow-owned chats get no Admin tools and no cards (spec §5.4). */
  workflowOwned: boolean;
  /** This chat's grants and its project's project grants. */
  grants: AgentToolGrant[];
}

/** `DELETE /api/agent-tools/grants?threadId=` (Revoke all, or all of one chat) → this. */
export interface RevokeAgentToolGrantsResponse {
  revoked: number;
}

/** The routes' own refusals (besides `INVALID_ARGUMENT`, `THREAD_NOT_FOUND`). */
export type AgentToolsErrorCode =
  | "GRANT_NOT_FOUND"
  /** 403: a grant revocation from an agent or external principal — only a person changes these. */
  | "PERMISSION_DENIED"
  /** 503: `agent-tools.json` is unreadable or corrupt and could not be moved aside — the store is read-only for this run. */
  | "AGENT_TOOLS_UNAVAILABLE";

/** The daemon-owned agent-tools routes (both transports). */
export const agentToolsRoutes = {
  /** `GET` → {@link AgentToolsResponse}. */
  settings: "/api/agent-tools",
  /** `DELETE` (optional `?threadId=`) → {@link RevokeAgentToolGrantsResponse}. */
  grants: "/api/agent-tools/grants",
  /** `DELETE` one grant → 204; 404 `GRANT_NOT_FOUND`. */
  grant: (grantId: string): string => `/api/agent-tools/grants/${encodeURIComponent(grantId)}`
} as const;

/** The `/events` channel agent-tools changes are broadcast on. */
export const AGENT_TOOLS_CHANNEL = "agent-tools";
export const AGENT_TOOLS_CHANGED_EVENT = "agentTools.changed";

/**
 * `agentTools.changed` — coarse; the client re-reads. `threadId` when only one chat's grants
 * changed (its Tools chip re-reads); absent for a project-grant change or a revoke-all. (Older
 * daemons also sent a `revision`.)
 */
export interface AgentToolsChangedPayload {
  threadId?: string;
}
