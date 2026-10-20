/**
 * The {@link ApprovalPort} the catalog executor asks for cards and grants (unified MCP design
 * 2026-10-15 §3.2, §7). It joins the card registry (`agent-chat/tool-approvals.ts`) and the
 * agent-tools store (`./service.ts`):
 *
 * - `request(card, signal)` opens the card and waits. An approval with a grant choice is accepted
 *   only for a caller that is `full-access` and not workflow-owned at ANSWER time (the choice
 *   re-validated against the card's `grantOptions`); the grant itself is recorded only when the
 *   executor calls the outcome's `commitGrant`, after the call passed the post-card gate re-run —
 *   re-checking Full access then too.
 * - `findGrant(query)` answers from `agent-tools.json` (`lastUsedAt` stamped).
 * - `recordWorkflowInGrant(...)` adds a created workflow to the chat's `workflows` grant.
 *
 * **Defence in depth.** The executor's gate decides card / deny / allow; this port re-checks what it
 * can know itself, reading the caller's tab and thread: a workflow-owned caller never gets a card
 * (`ADMIN_NOT_AVAILABLE` for Admin, `PERMISSION_DENIED` otherwise) or a grant; grant options are
 * narrowed to what `grantOptionsFor` allows for the caller's CURRENT mode. Older builds' `toolset`
 * cards (`request_toolset`) are never opened: every chat tool is on in every chat.
 */

import { grantOptionsFor, type GrantScope, type SessionSummary } from "@orquester/api";
import {
  agentChatRoutes,
  type ApprovalPreviewSection,
  type RuntimeMode,
  type ThreadHeadResponse,
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
import { AgentToolsService, type AgentToolsThreadInfo, type NewAgentToolGrant } from "./service.ts";

/** What the port knows of a caller now, read by the daemon (never from the card). */
export interface CallerTraits {
  /** The chat's permission mode now; null when it could not be read (no grant then — fail closed). */
  runtimeMode: RuntimeMode | null;
  workflowOwned: boolean;
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

const READ_ONLY_GRANT =
  "Agent tool settings are read-only until agent-tools.json is fixed and Orquester restarts, so the grant cannot be saved. Approve without a grant, or deny.";

export class AgentToolsApprovalPort implements ApprovalPort {
  constructor(private readonly deps: ApprovalPortDeps) {}

  async findGrant(query: GrantQuery): Promise<Grant | null> {
    if (query.workflowOwned || this.deps.workflowOwned(query.threadId)) return null;
    return this.deps.tools.findGrant(query);
  }

  async request(card: ApprovalRequest, signal: AbortSignal): Promise<ApprovalOutcome> {
    const traits = await this.deps.callerTraits(card.threadId);
    if (!traits) throw new ToolError("THREAD_NOT_FOUND", "This chat is no longer open.");
    // boxes: a `spend` card (renting a box) opens for a workflow-owned chat too — its owner gets the
    // card's push and may answer it in the workflow's chat tab; unanswered, it expires (spec §13.1).
    if (card.kind !== "spend" && (traits.workflowOwned || this.deps.workflowOwned(card.threadId))) {
      throw card.kind === "admin"
        ? new ToolError("ADMIN_NOT_AVAILABLE", "This chat runs inside an automated workflow: changes that need the user's approval are not available.")
        : new ToolError("PERMISSION_DENIED", "This chat runs inside an automated workflow: nothing here can ask the user for approval.");
    }
    // The legacy kind: every tool is on already, so such a card would approve nothing.
    if (card.kind === "toolset") throw new ToolError("INVALID_ARGUMENT", "Toolset cards are no longer used: every Orquester tool is on in every chat.");
    return this.open(card, signal, traits);
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

  private open(card: ApprovalRequest, signal: AbortSignal, traits: CallerTraits): Promise<ApprovalOutcome> {
    const grantOptions = this.allowedGrantOptions(card, traits);
    // A create in a chat that holds a `workflows` grant: the new workflow joins it (§7.6, ruling) —
    // and the card says so. Re-decided with the caller's traits when the answer arrives.
    const joinable = this.joinableWorkflowGrant(card, grantOptions);
    const sections: ApprovalPreviewSection[] = joinable
      ? [{ kind: "warning", level: "caution", text: WORKFLOW_GRANT_NOTICE }, ...card.sections]
      : card.sections;
    /** The grant an approved create joins, decided at answer time (absent: none). */
    let joinGrantId: string | undefined;
    /** The grant the user chose, planned at answer time and recorded by the outcome's `commitGrant`. */
    let chosen: { input: NewAgentToolGrant; id: string } | undefined;
    const outcome = this.deps.registry.open(
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
        commitApproval: (answer) => {
          const committed = this.commit(card, answer, joinGrantId);
          chosen = committed.chosen;
          return committed.result;
        }
      }
    );
    return outcome.then((settled) => {
      const plan = chosen;
      if (settled.outcome !== "approved" || plan === undefined) return settled;
      let once: Promise<{ grantId: string; grantScope: "chat" | "project" } | null> | undefined;
      return { ...settled, commitGrant: () => (once ??= this.commitGrant(card.threadId, plan)) };
    });
  }

  /**
   * Record the grant an approved card chose — called by the executor once the call passed the
   * post-card gate re-run. Only while the caller is still `full-access` and not workflow-owned; null
   * (nothing recorded) otherwise, or when the store refuses.
   */
  private async commitGrant(threadId: string, plan: { input: NewAgentToolGrant; id: string }): Promise<{ grantId: string; grantScope: "chat" | "project" } | null> {
    if (this.deps.workflowOwned(threadId)) return null;
    const traits = await this.deps.callerTraits(threadId);
    if (!traits || traits.workflowOwned || traits.runtimeMode !== "full-access" || this.deps.tools.isReadOnly()) return null;
    try {
      return { grantId: this.deps.tools.addGrant(plan.input, plan.id), grantScope: plan.input.scope };
    } catch (error) {
      console.error("[agent-tools] could not record a grant", error instanceof Error ? error.name : "unknown error");
      return null;
    }
  }

  /** The card's grant options narrowed to what the caller's current traits allow (§7.6, MUST 8). */
  private allowedGrantOptions(card: ApprovalRequest, traits: CallerTraits): GrantScope[] {
    if (traits.runtimeMode === null) return [];
    // Workspace-level data lies outside the caller's project wherever it is: never a grant, whatever the card offers.
    if ((card.workspaceTargets?.length ?? 0) > 0) return [];
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

  private commit(
    card: ApprovalRequest,
    answer: ToolApprovalAnswer,
    joinGrantId: string | undefined
  ): { result: { grantId?: string; grantScope?: "chat" | "project" }; chosen?: { input: NewAgentToolGrant; id: string } } {
    if (answer.grant !== undefined) {
      // Planned, not recorded: the outcome's `commitGrant` records it once the call passed its re-gate.
      const input: NewAgentToolGrant = {
        family: card.family,
        scope: answer.grant,
        projectPath: card.callerProjectPath,
        threadId: card.threadId,
        ...(card.family === "cross-project" && card.targetProjectPath !== undefined ? { targetProjectPath: card.targetProjectPath } : {}),
        ...(card.family === "workflows" && card.workflowId !== undefined ? { workflowId: card.workflowId } : {})
      };
      const id = this.deps.tools.plannedGrantId(input);
      return { result: { grantId: id, grantScope: answer.grant }, chosen: { input, id } };
    }
    // Ruling: approving ONCE never widens a standing grant. Only a create the card said would join
    // (decided at answer time) returns the grant; the executor adds the new id after the create ran
    // (`recordWorkflowInGrant`). A plain approval of a run/update/delete joins nothing.
    return { result: joinGrantId !== undefined ? { grantId: joinGrantId, grantScope: "chat" } : {} };
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
 * The trait reader the daemon wires: the tab (does it exist, its owner and lineage) and
 * the thread's permission mode from its head, read through the daemon's own API. A failed read
 * leaves the mode unknown (`null`: no grant is offered or made).
 */
export function callerTraitsFromDaemon(deps: {
  tab(id: string): TabLike | undefined;
  api(): DaemonApi | null;
}): (threadId: string) => Promise<CallerTraits | null> {
  return async (threadId) => {
    if (!deps.tab(threadId)) return null;
    let runtimeMode: RuntimeMode | null = null;
    const api = deps.api();
    if (api) {
      try {
        // The thread's head (`threadHeadOf`): its permission mode is all this reads.
        const res = await api.request("GET", agentChatRoutes.threadHead(threadId));
        const body = res.body as ThreadHeadResponse | null;
        if (res.status === 200 && body?.head) runtimeMode = body.head.runtimeMode;
      } catch {
        runtimeMode = null;
      }
    }
    return { runtimeMode, workflowOwned: workflowOwnedFromTabs(threadId, deps.tab) };
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
  /** A chat tab closed: its pending cards are cancelled, its chat grants deleted. */
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
    callerTraits: callerTraitsFromDaemon({ tab: deps.tab, api: deps.api }),
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
 * Point the catalog executor (both transports) at this runtime: cards and grants through its port.
 * Returns the disconnect, called at shutdown BEFORE the runtime stops: from then on no card opens
 * and no grant is honoured (the executor refuses `PERMISSION_DENIED`) while the transports still
 * serve. The port is cleared only while it is still this runtime's.
 */
export function connectExecutor(runtime: Pick<AgentToolsRuntime, "port">, ports: ExecutorPorts): () => void {
  ports.approvals = runtime.port;
  return () => {
    if (ports.approvals === runtime.port) ports.approvals = null;
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
