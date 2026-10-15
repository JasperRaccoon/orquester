/**
 * The Orquester tool contract (unified MCP design 2026-10-15 §3.2): every tool is defined once,
 * declares its audiences, chat tier, toolset and scope claim, and is run only by the executor
 * (`../executor.ts`) — for the external `/mcp` server and the in-chat `orquester` server alike.
 *
 * Types and the identity helper only. This module is reachable from `catalog/index.ts`, which the
 * agent host loads statically: it imports types alone (never a daemon service).
 */

import type { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AdminFamily, ApprovalFamily, ApprovalKind, ApprovalPreviewSection, TOOL_APPROVAL_LIMIT, ToolApprovalGrantScope, ToolsetId, ToolTier } from "@orquester/api";
import type { AgentAdapterId, CausedBy, InteractionMode, RuntimeMode, ThreadMessageOrigin, ThreadReplyMode } from "@orquester/api/agent-chat";
import type { AgentToolGrantQuery, AgentToolGrantRecord } from "@orquester/config";

import type { DaemonApi } from "../daemon-api.ts";
import type { FsTools } from "../fs-tools.ts";
import type { TodoTools } from "../todo-tools.ts";
import type { SessionSecretRequests } from "../../session-tools/contract.ts";

export type { AdminFamily, ApprovalFamily, ApprovalKind, ToolsetId };

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Who a tool is advertised to: external MCP clients, in-chat agents, or both. */
export type Audience = "external" | "chat";
export const AUDIENCES: readonly Audience[] = ["external", "chat"];

/** A tool's chat tier (§6). External callers are full trust. */
export type Tier = ToolTier;

/**
 * The error codes the unified catalog adds (spec §4.3) to the existing ones (`INVALID_ARGUMENT`,
 * `THREAD_NOT_FOUND`, `PERMISSION_DENIED`, `CANCELLED`, and the wire's `WAIT_CYCLE`,
 * `TARGET_BUSY`, `REPLY_SUBSCRIPTION_LIMIT` from `@orquester/api/agent-chat`). Thrown as
 * `ToolError(code, message)`.
 */
export const ORQUESTER_TOOL_ERROR_CODES = {
  /** The tool exists but its toolset is off in this chat; the message names the toolset and suggests `request_toolset`. */
  TOOL_NOT_ENABLED: "TOOL_NOT_ENABLED",
  /** No tool of that name for this audience. */
  TOOL_NOT_FOUND: "TOOL_NOT_FOUND",
  /** The user denied the card; the message quotes their reason. */
  APPROVAL_DENIED: "APPROVAL_DENIED",
  /** The card expired (`ADMIN_APPROVAL_TIMEOUT_MS`). */
  APPROVAL_TIMEOUT: "APPROVAL_TIMEOUT",
  /** The whole preview would exceed `TOOL_APPROVAL_FULL_PREVIEW_MAX_BYTES`: "split the change into smaller calls". */
  PREVIEW_TOO_LARGE: "PREVIEW_TOO_LARGE",
  /** A pinned revision, content hash or commit changed between the card and the write; nothing was written. */
  PREVIEW_STALE: "PREVIEW_STALE",
  /** The exchange reached `MAX_EXCHANGE_HOPS`: "summarise for your user instead". */
  EXCHANGE_LIMIT: "EXCHANGE_LIMIT",
  /** A project outside the sandbox or not found — never confirmed to exist. */
  PROJECT_NOT_FOUND: "PROJECT_NOT_FOUND",
  /** An Admin call from a workflow-owned chat (§5.4): never a card. */
  ADMIN_NOT_AVAILABLE: "ADMIN_NOT_AVAILABLE",
  /** `request_toolset` for a toolset the user denied in the last 30 minutes. */
  TOOLSET_DECLINED: "TOOLSET_DECLINED",
  /** `MAX_PENDING_TOOL_APPROVALS_PER_THREAD` cards already wait in this chat: wait for answers, batch changes. */
  APPROVAL_LIMIT: "APPROVAL_LIMIT"
} as const satisfies Record<string, string> & { APPROVAL_LIMIT: typeof TOOL_APPROVAL_LIMIT };
export type OrquesterToolErrorCode = (typeof ORQUESTER_TOOL_ERROR_CODES)[keyof typeof ORQUESTER_TOOL_ERROR_CODES];

// ---------------------------------------------------------------------------
// The caller
// ---------------------------------------------------------------------------

/**
 * Who calls. Derived by the DAEMON — the external transport's authentication, or the chat route's
 * authenticated host request plus the thread's own tab and snapshot — never from arguments.
 */
export type ToolCaller =
  | { kind: "external" }
  | {
      kind: "thread";
      threadId: string;
      /** Its tab title (provenance names it). */
      title: string;
      /** Canonical project root; "" when the chat is bound to no project (every target is then "other"). */
      projectPath: string;
      /** The project's workspace name; "" with no project. */
      workspace: string;
      cwd: string;
      agentId: AgentAdapterId;
      /** Unique per call (the provider's tool-call id where it names one). */
      callId: string;
      /** The chat's permission mode NOW. */
      runtimeMode: RuntimeMode;
      /** Its running turn is in plan mode. */
      planning: boolean;
      /** Its session record, or any lineage ancestor's, is owned by a workflow (§5.4). */
      workflowOwned: boolean;
      /** The running turn's `causedBy` (§8.4) as `{id: exchangeId, hop}`, or null for a user-authored turn. */
      exchange: { id: string; hop: number } | null;
      /** Resolves true once the call's result reached the host; false when dropped. */
      delivered?: Promise<boolean>;
    };

export type ThreadCaller = Extract<ToolCaller, { kind: "thread" }>;

// ---------------------------------------------------------------------------
// Scope (§5)
// ---------------------------------------------------------------------------

/** What a call reads or changes, as the gate judges it. Computed by `tool.scope` from the arguments. */
export interface ScopeClaim {
  /** Canonical project paths read or changed (workflows: the whole union, §4.1). */
  projects: string[];
  /** A workflow temp project not created yet, by workspace. */
  pendingProjects?: { workspace: string }[];
  /** Sessions read or acted on. */
  sessions: string[];
  /** The read class (§5.2): `metadata` (lists, status, settings, …) or `content` (transcripts, files, diffs, …). */
  reads: "none" | "metadata" | "content";
  /** Changes Orquester state (plan mode refuses a data-changing Act). */
  writes: boolean;
  /** Sessions the call causes a turn in: the turn policy and the exchange apply to each. */
  causesTurnIn: string[];
  /** Refusal text when a target is not the caller's own child (lineage parent + `agentCreated`). */
  ownChildrenOnly?: string;
  /** What the call does when it targets the caller itself. */
  self?: "allow" | "refuse" | "title-only";
  /** Filesystem paths the call reads or uses as cwd: each must lie inside a project (§5.1). */
  paths?: string[];
  /**
   * What only `scope`'s own lookup can tell about THIS call (a stored record's state — e.g. whether a
   * saved prompt is agent-made or used by a workflow): read by the tool's `tier(args, scope)` /
   * `adminFamily(args, scope)`. Ignored for a tool whose tier is fixed.
   */
  resolved?: { tier: Tier; adminFamily?: AdminFamily };
}

/** What `scope` and `approval` may use: the call context before any approval exists. */
export type ScopeContext = Pick<CallContext, "api" | "signal" | "now" | "caller">;

// ---------------------------------------------------------------------------
// Approvals (§7) — the port is implemented in `agent-tools/approval-port.ts`
// ---------------------------------------------------------------------------

export type GrantQuery = AgentToolGrantQuery;
export type Grant = AgentToolGrantRecord;

/**
 * What a tool's `approval()` returns: the card's content. The executor adds the kind, family,
 * scope projects with their git identities, grant options, deadline, and freezes the arguments.
 */
export interface ApprovalPreview {
  /** One line, composed from structured arguments ("Claude wants to add the skill `x` to Claude Code"). */
  title: string;
  /** For a tool whose `adminFamily` depends on the arguments, the one this call is. */
  family?: AdminFamily;
  /** The scope badge text ("Global — every Claude Code chat"). */
  scopeLabel: string;
  /** The WHOLE preview (§7.1, MUST 5). Over `TOOL_APPROVAL_FULL_PREVIEW_MAX_BYTES` → `PREVIEW_TOO_LARGE`. */
  sections: ApprovalPreviewSection[];
  /** Masked inputs the card asks for (`{ask: true}` values, workflow secrets). */
  secretFields?: { key: string; label: string }[];
  /**
   * Everything the preview read, frozen: `name -> revision | sha256 | commit` (§7.2). `run`
   * re-verifies each immediately before writing and refuses `PREVIEW_STALE` on any mismatch.
   */
  pins?: Record<string, string>;
  /** `workflows` family: the workflow acted on (grant coverage). Absent for a create. */
  workflowId?: string;
  /** `workflows` family raised by a saved-prompt edit a workflow references: never grantable. */
  workflowReferencedPrompt?: boolean;
  /**
   * `workflows` family: the OTHER workflows the call runs or wires in (sub-workflows, recursively).
   * A grant covers the call only when the same grant also covers each of them (§7.6: a grant covers
   * only workflows created or approved in that chat). A grant the user CHOOSES on such a card
   * (`grantChosen`) is made for the workflow AND these, so the card must name each of them.
   */
  childWorkflowIds?: string[];
  /** This call is never covered by a grant and its card offers none (e.g. a scope member that no longer resolves: fail closed). */
  ungrantable?: boolean;
}

/** One card the executor asks the port to show and wait on. */
export interface ApprovalRequest {
  /*
   * The port re-checks what it can from these (defence in depth; the gate stays authoritative):
   * grant options are narrowed to what the caller's CURRENT traits allow, with
   * `pendingProjects` / `workflowReferencedPrompt` / other projects in `scope` never grantable.
   */
  threadId: string;
  /** The caller's canonical project root ("" when it has none): the project a grant is recorded for. */
  callerProjectPath: string;
  tool: string;
  kind: ApprovalKind;
  family: ApprovalFamily;
  title: string;
  scope: { label: string; projects?: { path: string; workspace: string; gitAccountLabel?: string }[] };
  reason?: string;
  /** The whole preview; the port derives the ≤ 64 KiB summary (`summarizeApprovalPreview`). */
  sections: ApprovalPreviewSection[];
  secretFields: { key: string; label: string }[];
  /** `grantOptionsFor(...)` at card time. */
  grantOptions: ToolApprovalGrantScope[];
  /** `workflows` grants: the workflow the approval covers (a create's new id is added after it runs). */
  workflowId?: string;
  /** `cross-project` grants: the target project. */
  targetProjectPath?: string;
  /** Kind `toolset` (`request_toolset`): the toolset the card turns on for the chat. Required for that kind. */
  toolset?: ToolsetId;
  /** `workflows` family raised by a saved-prompt edit a workflow references (`ApprovalPreview`): never grantable. */
  workflowReferencedPrompt?: boolean;
  /** `ScopeClaim.pendingProjects`: workflow temp projects not created yet, by workspace — never grantable. */
  pendingProjects?: { workspace: string }[];
  /** Resolves once the call's result reached the host (the tool row's outcome `not_delivered` otherwise). */
  delivered?: Promise<boolean>;
}

/**
 * Why a card ended `cancelled`: the waiting call went away (`aborted` — its signal), the chat tab
 * `closed`, or Orquester is `restarting` (shutdown). Absent: unknown (an older port). The card's
 * own deadline is never a cancellation: it ends `timed_out`.
 */
export type ApprovalCancelReason = "aborted" | "closed" | "restarting";

/** How a card ended, for the waiting call. Secrets only on `approved`, for this one write. */
export type ApprovalOutcome =
  | {
      outcome: "approved";
      approvalId: string;
      grantId?: string;
      /** With `grantId`: that grant's reach (the scope the user chose, or the chat grant a create joined). */
      grantScope?: "chat" | "project";
      /** The grant scope the user CHOSE on this card; absent for approve-once (a create joining the chat's grant included). */
      grantChosen?: ToolApprovalGrantScope;
      secrets?: Record<string, string>;
    }
  | { outcome: "denied"; approvalId: string; reason?: string }
  | { outcome: "timed_out"; approvalId: string }
  | { outcome: "cancelled"; approvalId: string; reason?: ApprovalCancelReason };

/** The executor's view of approvals and grants. */
export interface ApprovalPort {
  /** The grant covering a gated call, or null (`findGrant` rules; `lastUsedAt` stamped on a hit). */
  findGrant(query: GrantQuery): Promise<Grant | null>;
  /** Open a card and wait for the user, the deadline or `signal` (→ `cancelled`). */
  request(card: ApprovalRequest, signal: AbortSignal): Promise<ApprovalOutcome>;
  /**
   * After an approved `create_workflow` ran — or, for the sub-workflows a card named, right after the
   * user chose a grant on it: add the workflow's id to the chat's `workflows`
   * grant named by `grantId` — the approved outcome's `grantId` (the grant the approval created with
   * `grant: "chat"`, or the one the card said the create would join). Called ONLY with that id:
   * approving once never widens a standing grant (ruling). A no-op when `grantId` is not that chat's
   * `workflows` chat grant in `callerProjectPath`, or when the caller is no longer `full-access`.
   */
  recordWorkflowInGrant(input: { threadId: string; callerProjectPath: string; workflowId: string; grantId: string }): Promise<void>;
}

// ---------------------------------------------------------------------------
// The call context
// ---------------------------------------------------------------------------

/**
 * After an APPROVED toolset card, what the chat transport did with the change (Task 6's refresh
 * answer, awaited before the call resumes): `now` — the live session has the tools; `after-restart`
 * — a restart at the next idle point is pending and the automatic continue turn is scheduled;
 * `pending` — the change waits for the session's next start (no host answer, a superseded push, no
 * live session): nothing restarts or continues on its own.
 */
export type ToolsetApplyOutcome = "now" | "after-restart" | "pending";

/** A toolset card's outcome; `applied` only on an approved real card the transport answered for. */
export type ToolsetCardOutcome = ApprovalOutcome & { applied?: ToolsetApplyOutcome };

/** What `request_toolset` asks the executor to show (`CallContext.requestToolsetCard`). */
export interface ToolsetCardInput {
  toolset: ToolsetId;
  /** One line, composed by the tool from structured data ("Claude asks to enable Workflow authoring for this chat"). */
  title: string;
  /** The toolset label, its tools with tiers. */
  sections: ApprovalPreviewSection[];
  /** The agent's reason, shown labelled as its words. */
  reason?: string;
}

/**
 * TEMPORARY (deleted with `catalog/legacy.ts` in Task 14): the todo and file services the external
 * `/mcp`'s pre-catalog handlers take (`ToolContext.todos` / `.files`) until Tasks 9 and 12 route them
 * through `DaemonApi`.
 */
export interface LegacyToolServices {
  todos: TodoTools;
  files: FsTools;
}

export interface CallContext {
  /** The daemon's own REST API, in-process: every gate the GUI meets applies by construction. */
  api: DaemonApi;
  /** Aborted when the caller goes away; every wait honours it. */
  signal: AbortSignal;
  now(): number;
  caller: ToolCaller;
  turn: {
    /** The interaction mode of a turn this call causes (plan carries on, §5.3). */
    interactionMode: InteractionMode;
    /**
     * The text with its provenance header (v2, §8.2) for a turn this call causes. `senderReachable:
     * false` (with `replyMode: "none"`): the receiver may not message the caller back, and is told so.
     */
    provenance(origin: ThreadMessageOrigin, text: string, replyMode: ThreadReplyMode, opts?: { senderReachable?: boolean }): string;
    /** The `causedBy` of a turn this call causes (§8.4); absent for external callers' turns. */
    causedBy?: CausedBy;
  };
  /** `request_secret`'s port; absent where none is wired (tests). */
  secretRequests?: SessionSecretRequests;
  /**
   * Chat callers only (absent for external ones): the ONE way a tool raises a toolset card
   * (`request_toolset`, spec §9.3). The executor owns the `ApprovalPort`, so it opens the card for
   * the calling chat — kind and family `toolset`, `ApprovalRequest.toolset` set, no grant options —
   * and refuses a workflow-owned caller before any card (§5.4).
   */
  requestToolsetCard?(input: ToolsetCardInput): Promise<ToolsetCardOutcome>;
  /** TEMPORARY: legacy external handlers only ({@link LegacyToolServices}); absent where none is wired. */
  legacy?: LegacyToolServices;
  /**
   * Set when an OLD agent host called a legacy chat name that the daemon aliases onto this tool
   * (`session-tools/legacy-aliases.ts`, spec §14.1) and the alias keeps the old semantics a mapped
   * argument cannot say: `thread_send` with `wait` — `send_message` `reply: "wait"` WITHOUT the
   * queue rule's notify conversion (a timeout returns, nothing is delivered later). The tool's own
   * name is unchanged; only the semantics the legacy caller was promised differ.
   */
  legacyAlias?: string;
  /** Set when the call passed a card or a grant. */
  approval?: {
    outcome: "approved" | "granted";
    approvalId?: string;
    grantId?: string;
    /** Card secret values for this write only: never logged, stored, returned. */
    secrets?: Record<string, string>;
    /** The frozen pins (`ApprovalPreview.pins`) to re-verify before writing. */
    pins?: Record<string, string>;
  };
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

/** MCP tool annotations: hints describing the MOST dangerous action the tool can take. */
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export type ToolResultKind = "json" | "text" | "image";

export interface OrquesterTool<Shape extends z.ZodRawShape = z.ZodRawShape> {
  /** `^[a-z][a-z0-9_]{0,47}$`; external names win (D-8). */
  name: string;
  title: string;
  /** ≤ 1 000 bytes (`html_render` / `html_preview` ≤ 2 000). */
  description: string;
  /** Appended for chat callers only. */
  chatNote?: string;
  /** Appended for external callers only. */
  externalNote?: string;
  input: Shape;
  /** Keys stripped from the external schema (an external call naming one is `INVALID_ARGUMENT`). */
  chatOnlyInput?: readonly (keyof Shape)[];
  /** Keys stripped from the chat schema. */
  externalOnlyInput?: readonly (keyof Shape)[];
  audiences: readonly Audience[];
  toolset: ToolsetId;
  /**
   * The chat tier, fixed or per call: from the arguments (e.g. `dryRun` → read) and the resolved
   * scope claim (`ScopeClaim.resolved`, what `scope` looked up). Called by the executor AFTER `scope`,
   * once per call; the gate, the card, grant options and the turn policy all use that one value.
   * Advertised as its widest (`admin`) wherever no call is at hand (external `_meta`, TOOLSETS badges).
   */
  tier: Tier | ((args: z.infer<z.ZodObject<Shape>>, scope: ScopeClaim) => Tier);
  /** Required when the tier can be `admin`; per call like `tier`. */
  adminFamily?: AdminFamily | ((args: z.infer<z.ZodObject<Shape>>, scope: ScopeClaim) => AdminFamily);
  /** Allowed while the caller plans even though it changes something (`html_render`, `request_secret`, …). */
  planSafe?: boolean;
  scope(args: z.infer<z.ZodObject<Shape>>, ctx: ScopeContext): Promise<ScopeClaim>;
  /** The card's content; required when the tier can be `admin`. */
  approval?(args: z.infer<z.ZodObject<Shape>>, ctx: ScopeContext): Promise<ApprovalPreview>;
  annotations: ToolAnnotations;
  resultKind: ToolResultKind;
  /** Result keys whose string values are secrets handed to the agent (masked by the host afterwards). */
  secretResultKeys?: readonly string[];
  /** Called ONLY by the executor, with the frozen arguments. */
  run(args: z.infer<z.ZodObject<Shape>>, ctx: CallContext): Promise<Record<string, unknown> | CallToolResult>;
}

/** Any tool, whatever its shape (each one is checked by {@link defineTool}). */
export type AnyOrquesterTool = OrquesterTool<any>;

/** Identity helper that infers a tool's argument type from its shape. */
export function defineTool<Shape extends z.ZodRawShape>(tool: OrquesterTool<Shape>): OrquesterTool<Shape> {
  return tool;
}

// ---------------------------------------------------------------------------
// Annotation presets (as the external server has spelled them)
// ---------------------------------------------------------------------------

/**
 * `openWorldHint: false` says a tool touches only the daemon's own state. A read qualifies; a tool
 * that drives an agent does not — the agent it drives can reach anything — so it keeps the default.
 */
export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
export const MUTATING: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false };
export const MUTATING_IDEMPOTENT: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true };
export const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true };
/** A write that stays inside the daemon's own state: the same hints, and no open world. */
export const closedWorld = (annotations: ToolAnnotations): ToolAnnotations => ({ ...annotations, openWorldHint: false });
