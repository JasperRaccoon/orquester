/**
 * The {@link ApprovalPort} the catalog executor asks for cards and grants (unified MCP design
 * 2026-10-15 §3.2, §7, §9.3). It joins the card registry (`agent-chat/tool-approvals.ts`) and the
 * agent-tools store (`./service.ts`):
 *
 * - `request(card, signal)` opens the card and waits. On an approval with a grant choice the grant
 *   is recorded (only for a caller that is `full-access` and not workflow-owned at ANSWER time,
 *   the choice re-validated against the card's `grantOptions`); an approved toolset card turns the
 *   toolset on for the chat (persisted, then `onToolsetsChanged`); a denied one blocks asking again
 *   for 30 min.
 * - `findGrant(query)` answers from `agent-tools.json` (`lastUsedAt` stamped).
 * - `recordWorkflowInGrant(...)` adds a created workflow to the chat's `workflows` grant.
 *
 * **Defence in depth.** The executor's gate decides card / deny / allow; this port re-checks what it
 * can know itself, reading the caller's tab and thread: a workflow-owned caller never gets a card
 * (`ADMIN_NOT_AVAILABLE` for Admin, `PERMISSION_DENIED` otherwise) or a grant; grant options are
 * narrowed to what `grantOptionsFor` allows for the caller's CURRENT mode; a toolset card for a
 * toolset already on opens no card, one declined in the last 30 min is `TOOLSET_DECLINED`, and
 * only one per toolset per chat may be pending.
 */

import {
  grantOptionsFor,
  isToolsetId,
  toolsetById,
  type GrantScope,
  type SessionSummary,
  type ToolsetId
} from "@orquester/api";
import {
  agentChatRoutes,
  type ApprovalPreviewSection,
  type RuntimeMode,
  type ThreadReadResponse,
  type ToolApprovalAnswer
} from "@orquester/api/agent-chat";

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  AGENT_TOOLS_CHANGED_EVENT,
  AGENT_TOOLS_CHANNEL
} from "@orquester/api";
import { TOOL_APPROVAL_EVENT_TYPE } from "@orquester/api/agent-chat";
import { agentToolApprovalsJournalFile, agentToolsFile } from "@orquester/config";

import { isAgentAdapterId } from "../agent-host/adapters/index.ts";
import { ToolApprovalAnswerRefusal, ToolApprovalRegistry, type ToolApprovalClock } from "../agent-chat/tool-approvals.ts";
import type { ApprovalOutcome, ApprovalPort, ApprovalRequest, Grant, GrantQuery } from "../mcp/catalog/contract.ts";
import type { DaemonApi } from "../mcp/daemon-api.ts";
import type { ExecutorPorts } from "../mcp/executor.ts";
import { ToolError } from "../mcp/errors.ts";
import { AgentToolsService, type AgentToolsThreadInfo } from "./service.ts";

/** What the port knows of a caller now, read by the daemon (never from the card). */
export interface CallerTraits {
  /** The chat's permission mode now; null when it could not be read (no grant then — fail closed). */
  runtimeMode: RuntimeMode | null;
  workflowOwned: boolean;
  /** The chat's agent (resolving toolsets); null when unknown. */
  agent: string | null;
}

export interface ApprovalPortDeps {
  registry: ToolApprovalRegistry;
  tools: AgentToolsService;
  /** The caller's traits now, or null when it is no longer an open chat. */
  callerTraits(threadId: string): Promise<CallerTraits | null>;
  /** Cheap, synchronous: whether the chat or a lineage ancestor is owned by a workflow (§5.4). */
  workflowOwned(threadId: string): boolean;
}

/** The notice a `create_workflow` card carries when the new workflow will join the chat's grant. */
export const WORKFLOW_GRANT_NOTICE =
  "This chat's 'Allow workflows' grant will cover the new workflow: its later changes, runs and deletion from this chat won't ask again until you revoke the grant.";

const AGENT_TOOLS_OFF = (label: string): string =>
  `Agent tools are switched off in Settings › Agent tools, so ${label} cannot be turned on for this chat (it would have no effect). Ask the user to turn agent tools on.`;
const READ_ONLY_TOOLSET =
  "Agent tool settings are read-only until agent-tools.json is fixed and Orquester restarts, so this toolset cannot be turned on. Deny this card for now.";
const READ_ONLY_GRANT =
  "Agent tool settings are read-only until agent-tools.json is fixed and Orquester restarts, so the grant cannot be saved. Approve without a grant, or deny.";

export class AgentToolsApprovalPort implements ApprovalPort {
  /** `<threadId>\u0000<toolset>` of toolset cards pending now (one per toolset per chat). */
  private readonly pendingToolsets = new Set<string>();

  constructor(private readonly deps: ApprovalPortDeps) {}

  async findGrant(query: GrantQuery): Promise<Grant | null> {
    if (query.workflowOwned || this.deps.workflowOwned(query.threadId)) return null;
    return this.deps.tools.findGrant(query);
  }

  async request(card: ApprovalRequest, signal: AbortSignal): Promise<ApprovalOutcome> {
    const traits = await this.deps.callerTraits(card.threadId);
    if (!traits) throw new ToolError("THREAD_NOT_FOUND", "This chat is no longer open.");
    if (traits.workflowOwned || this.deps.workflowOwned(card.threadId)) {
      throw card.kind === "admin"
        ? new ToolError("ADMIN_NOT_AVAILABLE", "This chat runs inside an automated workflow: changes that need the user's approval are not available.")
        : new ToolError("PERMISSION_DENIED", "This chat runs inside an automated workflow: nothing here can ask the user for approval.");
    }
    const toolset = card.kind === "toolset" ? this.toolsetOf(card) : null;
    if (toolset !== null) {
      const until = this.deps.tools.toolsetDeclinedUntil(card.threadId, toolset);
      if (until !== null) {
        throw new ToolError(
          "TOOLSET_DECLINED",
          `The user declined ${toolsetById(toolset).label} in this chat; don't ask again before ${until}. Carry on without it or ask the user in your reply.`,
          { toolset, declinedUntil: until }
        );
      }
      if (traits.agent !== null && this.deps.tools.isToolsetOn(card.threadId, traits.agent, toolset)) {
        // Already on: nothing to ask (spec §13). No card was shown.
        return { outcome: "approved", approvalId: "" };
      }
      if (!this.deps.tools.snapshot().enabled) {
        // An override has no effect while the master switch is off: never a card that "approves" nothing.
        throw new ToolError("PERMISSION_DENIED", AGENT_TOOLS_OFF(toolsetById(toolset).label));
      }
      const key = `${card.threadId}\u0000${toolset}`;
      if (this.pendingToolsets.has(key)) {
        throw new ToolError("PERMISSION_DENIED", `A request for ${toolsetById(toolset).label} is already waiting for the user in this chat.`);
      }
      this.pendingToolsets.add(key);
      try {
        return await this.open(card, signal, traits, toolset);
      } finally {
        this.pendingToolsets.delete(key);
      }
    }
    return this.open(card, signal, traits, null);
  }

  /**
   * After an approved `create_workflow` ran: add its id to the chat's `workflows` grant named by
   * `grantId` — the one the approval created (`grant: "chat"`) or the one the card said the create
   * would join. Without `grantId` nothing joins (ruling: approving once never widens a grant).
   */
  async recordWorkflowInGrant(input: { threadId: string; callerProjectPath: string; workflowId: string; grantId: string }): Promise<void> {
    if (!input.grantId || this.deps.workflowOwned(input.threadId)) return;
    const traits = await this.deps.callerTraits(input.threadId);
    if (!traits || traits.workflowOwned || traits.runtimeMode !== "full-access") return;
    const grantId = input.grantId;
    this.deps.tools.recordWorkflowInGrant({ threadId: input.threadId, callerProjectPath: input.callerProjectPath, workflowId: input.workflowId, grantId });
  }

  // -------------------------------------------------------------------------

  /** A toolset card names its toolset (`ApprovalRequest.toolset`); one without is refused rather than guessed. */
  private toolsetOf(card: ApprovalRequest): ToolsetId {
    if (!isToolsetId(card.toolset)) throw new ToolError("INVALID_ARGUMENT", "A toolset card must name its toolset.");
    return card.toolset;
  }

  private open(card: ApprovalRequest, signal: AbortSignal, traits: CallerTraits, toolset: ToolsetId | null): Promise<ApprovalOutcome> {
    const grantOptions = this.allowedGrantOptions(card, traits);
    // A create in a chat that holds a `workflows` grant: the new workflow joins it (§7.6, ruling) —
    // and the card says so. Re-decided with the caller's traits when the answer arrives.
    const joinable = this.joinableWorkflowGrant(card, grantOptions);
    const sections: ApprovalPreviewSection[] = joinable
      ? [{ kind: "warning", level: "caution", text: WORKFLOW_GRANT_NOTICE }, ...card.sections]
      : card.sections;
    /** The grant an approved create joins, decided at answer time (absent: none). */
    let joinGrantId: string | undefined;
    return this.deps.registry.open(
      {
        threadId: card.threadId,
        tool: card.tool,
        kind: card.kind,
        family: card.family,
        title: card.title,
        scope: card.scope,
        ...(card.reason !== undefined ? { reason: card.reason } : {}),
        sections,
        secretFields: card.secretFields,
        grantOptions
      },
      signal,
      {
        ...(card.delivered !== undefined ? { delivered: card.delivered } : {}),
        prepareApproval: async (answer) => {
          joinGrantId = undefined;
          if (toolset !== null) {
            if (!this.deps.tools.snapshot().enabled) {
              throw new ToolApprovalAnswerRefusal("AGENT_TOOLS_DISABLED", `${AGENT_TOOLS_OFF(toolsetById(toolset).label)} Deny this card, or turn agent tools on first.`, 409);
            }
            if (this.deps.tools.isReadOnly()) throw new ToolApprovalAnswerRefusal("AGENT_TOOLS_UNAVAILABLE", READ_ONLY_TOOLSET, 503);
          }
          if (answer.grant === undefined && !joinable) return;
          // The caller must still be `full-access` (and not workflow-owned) when a grant is made or joined.
          const now = await this.deps.callerTraits(card.threadId);
          const stillFull = !!now && !now.workflowOwned && now.runtimeMode === "full-access" && !this.deps.workflowOwned(card.threadId);
          if (answer.grant === undefined) {
            // The create joins the chat's grant only if the caller is still allowed one, and the grant still exists.
            const grant = stillFull && !this.deps.tools.isReadOnly() ? this.deps.tools.chatWorkflowGrant(card.threadId, card.callerProjectPath) : null;
            joinGrantId = grant?.id;
            return;
          }
          if (!stillFull || !this.allowedGrantOptions(card, now!).includes(answer.grant)) {
            throw new ToolApprovalAnswerRefusal("INVALID_ARGUMENT", "This chat is no longer in Full access: approve without a grant.");
          }
          if (this.deps.tools.isReadOnly()) throw new ToolApprovalAnswerRefusal("AGENT_TOOLS_UNAVAILABLE", READ_ONLY_GRANT, 503);
        },
        commitApproval: (answer) => this.commit(card, answer, toolset, joinGrantId),
        onDenied: () => {
          if (toolset !== null) this.deps.tools.recordToolsetDecline(card.threadId, toolset);
        }
      }
    );
  }

  /** The card's grant options narrowed to what the caller's current traits allow (§7.6, MUST 8). */
  private allowedGrantOptions(card: ApprovalRequest, traits: CallerTraits): GrantScope[] {
    if (traits.runtimeMode === null) return [];
    // A temp project not created yet, or another project in the scope, is never granted (Admin).
    const crossProject =
      card.family !== "cross-project" &&
      ((card.scope.projects ?? []).some((project) => project.path !== card.callerProjectPath) || (card.pendingProjects?.length ?? 0) > 0);
    const allowed = grantOptionsFor({
      family: card.family,
      callerRuntimeMode: traits.runtimeMode,
      workflowOwned: traits.workflowOwned,
      crossProject: crossProject || card.callerProjectPath === "",
      ...(card.workflowReferencedPrompt === true ? { workflowReferencedPrompt: true } : {})
    });
    return card.grantOptions.filter((scope) => allowed.includes(scope));
  }

  /**
   * The chat's `workflows` grant a `create_workflow` card would join, or null: only a create, only
   * where the card may offer a chat grant at all (the caller's own project, full-access).
   */
  private joinableWorkflowGrant(card: ApprovalRequest, grantOptions: readonly GrantScope[]): boolean {
    if (card.family !== "workflows" || card.tool !== "create_workflow" || card.workflowId !== undefined || !grantOptions.includes("chat")) return false;
    return this.deps.tools.chatWorkflowGrant(card.threadId, card.callerProjectPath) !== null;
  }

  private commit(card: ApprovalRequest, answer: ToolApprovalAnswer, toolset: ToolsetId | null, joinGrantId: string | undefined): { grantId?: string } {
    if (toolset !== null) this.deps.tools.enableToolsetForThread(card.threadId, toolset);
    if (answer.grant !== undefined) {
      const grantId = this.deps.tools.addGrant({
        family: card.family,
        scope: answer.grant,
        projectPath: card.callerProjectPath,
        threadId: card.threadId,
        ...(card.family === "cross-project" && card.targetProjectPath !== undefined ? { targetProjectPath: card.targetProjectPath } : {}),
        ...(card.family === "workflows" && card.workflowId !== undefined ? { workflowId: card.workflowId } : {})
      });
      return { grantId };
    }
    // Ruling: approving ONCE never widens a standing grant. Only a create the card said would join
    // (decided at answer time) returns the grant; the executor adds the new id after the create ran
    // (`recordWorkflowInGrant`). A plain approval of a run/update/delete joins nothing.
    return joinGrantId !== undefined ? { grantId: joinGrantId } : {};
  }
}

// ---------------------------------------------------------------------------
// Traits from the daemon's own state
// ---------------------------------------------------------------------------

/** The tab fields the trait reader needs. */
export type TabLike = Pick<SessionSummary, "owner" | "lineage">;

/**
 * Whether `threadId`'s tab, or any ancestor's along its lineage, is owned by a workflow (§5.4).
 * Walks the open tabs; a cycle or a missing ancestor ends the walk. The executor's gate
 * (`mcp/gate/scope.ts`) is authoritative — this is the port's own second look.
 */
export function workflowOwnedFromTabs(threadId: string, tab: (id: string) => TabLike | undefined): boolean {
  const seen = new Set<string>();
  let id: string | undefined = threadId;
  while (id !== undefined && !seen.has(id)) {
    seen.add(id);
    const summary = tab(id);
    if (!summary) return false;
    if (summary.owner?.kind === "workflow") return true;
    // The inheritable marker (stamped at creation) survives a closed creator's tab.
    if (summary.lineage?.workflowOwned === true) return true;
    id = summary.lineage?.parentThreadId;
  }
  return false;
}

/**
 * The trait reader the daemon wires: the tab (does it exist, its agent, its owner and lineage) and
 * the thread's permission mode from its snapshot, read through the daemon's own API. A failed read
 * leaves the mode unknown (`null`: no grant is offered or made).
 */
export function callerTraitsFromDaemon(deps: {
  tab(id: string): TabLike | undefined;
  agentOf(id: string): string | null;
  api(): DaemonApi | null;
}): (threadId: string) => Promise<CallerTraits | null> {
  return async (threadId) => {
    if (!deps.tab(threadId)) return null;
    let runtimeMode: RuntimeMode | null = null;
    const api = deps.api();
    if (api) {
      try {
        const res = await api.request("GET", agentChatRoutes.thread(threadId));
        const body = res.body as ThreadReadResponse | null;
        if (res.status === 200 && body?.kind === "snapshot") runtimeMode = body.thread.head.runtimeMode;
      } catch {
        runtimeMode = null;
      }
    }
    return { runtimeMode, workflowOwned: workflowOwnedFromTabs(threadId, deps.tab), agent: deps.agentOf(threadId) };
  };
}

// ---------------------------------------------------------------------------
// The runtime the daemon wires (index.ts `umcp:t3`)
// ---------------------------------------------------------------------------

/** The cards, the store and the port, built together. */
export interface AgentToolsRuntime {
  tools: AgentToolsService;
  approvals: ToolApprovalRegistry;
  /** The executor's {@link ApprovalPort} (Task 2 wires it into both transports). */
  port: AgentToolsApprovalPort;
  /** Whether `id` is an open chat tab. */
  isChatSession(id: string): boolean;
  /** A chat's agent, project and workflow-owned trait, or null when it is not an open chat. */
  threadInfo(id: string): AgentToolsThreadInfo | null;
  /** Boot: read `agent-tools.json`, resolve cards left open by a previous run as `cancelled`. */
  load(): Promise<void>;
  /** A chat tab closed: its pending cards are cancelled, its overrides, declines and chat grants deleted. */
  threadClosed(threadId: string): void;
  /** Shutdown: pending cards cancelled, queued writes flushed. */
  shutdown(): Promise<void>;
}

export interface AgentToolsRuntimeDeps {
  /** The appdir (`paths.baseDir`). */
  baseDir: string;
  publish(channel: string, type: string, payload: unknown): void;
  /** A chat's pending cards changed (its attention follows). */
  onApprovalsChanged(threadId: string): void;
  tab(id: string): (TabLike & { projectPath: string }) | undefined;
  /** The chat's agent adapter id, or null. */
  agentOf(id: string): string | null;
  api(): DaemonApi | null;
  projectExists?(path: string): boolean;
  logger?: { warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void; log?: (...args: unknown[]) => void };
  /** Tests: the card clock, timeout and ids. */
  clock?: ToolApprovalClock;
  timeoutMs?: number;
}

export function createAgentToolsRuntime(deps: AgentToolsRuntimeDeps): AgentToolsRuntime {
  const logger = deps.logger ?? console;
  const tools = new AgentToolsService({
    file: agentToolsFile(deps.baseDir),
    publish: (payload) => deps.publish(AGENT_TOOLS_CHANNEL, AGENT_TOOLS_CHANGED_EVENT, payload),
    ...(deps.projectExists ? { projectExists: deps.projectExists } : {}),
    logger
  });
  const approvals = new ToolApprovalRegistry({
    publish: (payload) => deps.publish("sessions", TOOL_APPROVAL_EVENT_TYPE, payload),
    onChange: (threadId) => deps.onApprovalsChanged(threadId),
    log: (line) => (logger.log ?? console.log)(line),
    journalFile: agentToolApprovalsJournalFile(deps.baseDir),
    ...(deps.clock ? { clock: deps.clock } : {}),
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    logger
  });
  const workflowOwned = (id: string): boolean => workflowOwnedFromTabs(id, deps.tab);
  const port = new AgentToolsApprovalPort({
    registry: approvals,
    tools,
    callerTraits: callerTraitsFromDaemon({ tab: deps.tab, agentOf: deps.agentOf, api: deps.api }),
    workflowOwned
  });
  return {
    tools,
    approvals,
    port,
    isChatSession: (id) => deps.tab(id) !== undefined,
    threadInfo: (id) => {
      const tab = deps.tab(id);
      const agent = tab ? deps.agentOf(id) : null;
      if (!tab || agent === null || !isAgentAdapterId(agent)) return null;
      // Grants record the caller's CANONICAL project root (the executor's `callerProjectPath`).
      return { agent, projectPath: canonicalProjectPath(tab.projectPath), workflowOwned: workflowOwned(id) };
    },
    async load() {
      await tools.load();
      await approvals.recover();
    },
    threadClosed(threadId) {
      approvals.cancelThread(threadId);
      try {
        tools.removeThread(threadId);
      } catch (error) {
        logger.warn?.("agent-tools: a closed chat's settings could not be removed", error instanceof Error ? error.name : typeof error);
      }
    },
    async shutdown() {
      await approvals.shutdown();
      await tools.flush();
    }
  };
}

/**
 * Point the catalog executor (both transports) at this runtime: cards and grants through its port,
 * a chat's toolsets resolved from its store (overrides, settings, master switch). Returns the
 * disconnect (shutdown): later calls find no port and fail closed.
 *
 * An approved toolset card fires `tools.onToolsetsChanged` listeners in a microtask after the card
 * settles but BEFORE the awaiting `request()` resumes in the executor (the tool result is not sent
 * yet): a listener only schedules its re-list/restart for the chat's next idle point.
 */
export function connectExecutor(runtime: Pick<AgentToolsRuntime, "port" | "tools">, ports: ExecutorPorts): () => void {
  ports.approvals = runtime.port;
  ports.enabledToolsets = async (caller) => new Set(runtime.tools.resolvedToolsets(caller.threadId, caller.agentId));
  return () => {
    if (ports.approvals === runtime.port) ports.approvals = null;
    ports.enabledToolsets = null;
  };
}

/** A project root as grants record it: realpath, else the resolved path; "" stays "". */
export function canonicalProjectPath(path: string): string {
  if (path === "") return "";
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}
