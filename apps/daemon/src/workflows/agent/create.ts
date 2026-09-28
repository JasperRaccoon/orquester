// Automated workflows — the catalogue check and the session create of an agent block (spec §5.1).
//
// The create is the MCP's `create_session`, spelled for an unattended run: `kind: "agent-chat"`,
// the registry refId, the project as `projectPath` and `cwd`, a title, `accountId` ALWAYS explicit
// ("system" included — an omitted one would silently become the family default), a top-level
// `model` for claudex only (a proxy model is the launch's ANTHROPIC_MODEL; claudemix never names
// one), `chat: {accountId, modelSelection, runtimeMode: "full-access"}` and the `owner` that ties the
// tab to the run. The model is validated against the provider catalogue first (the host only
// shape-checks), and the account's family is re-checked here: the daemon's create silently degrades a
// wrong-family id to the system login.
//
// `POST /api/sessions` has no command id, so a create is made idempotent across a restart by its
// `owner`: a session this block's owner names, created at or after the create began and not one the
// block already knows, IS the one the lost response would have named.

import type { CreateSessionRequest, SessionSummary, WorkflowSessionOwner } from "@orquester/api";
import type { CreateAgentChatSessionFields } from "@orquester/api/agent-chat";
import {
  expectOk,
  findAgent,
  launchesProxyModel,
  listSessions,
  loadAgents,
  resolveModelSelection,
  ToolError,
  validateAccountId,
  type AgentView,
  type DaemonApi
} from "../../chat-client/index.ts";
import type { AgentCandidate, CandidateCheck } from "./failover.ts";

export interface CatalogLabels {
  agentLabel: string;
  modelLabel: string;
}

/** One catalogue read per selection pass (`loadAgents` reads five routes). */
export class AgentCatalog {
  private agents: AgentView[] | null = null;
  constructor(private readonly api: DaemonApi) {}

  async list(): Promise<AgentView[]> {
    if (!this.agents) this.agents = await loadAgents(this.api, { includeLegacyModels: true });
    return this.agents;
  }

  invalidate(): void {
    this.agents = null;
  }

  async labels(agent: string, model: string): Promise<CatalogLabels> {
    try {
      const view = (await this.list()).find((a) => a.id === agent);
      const modelView = view?.models.find((m) => m.slug === model);
      return { agentLabel: view?.name ?? agent, modelLabel: modelView?.name ?? model };
    } catch {
      return { agentLabel: agent, modelLabel: model };
    }
  }

  /**
   * The catalogue's verdict on a candidate: the agent is installed and enabled, the model and its
   * options are ones the provider lists (normalised as the composer would), and the account is one
   * of the agent's family (seeded, for a proxy launcher). A refused agent or model passes over the
   * whole chain entry; a refused account only that account.
   */
  async check(candidate: AgentCandidate): Promise<CandidateCheck> {
    const agents = await this.list();
    const skipBase = { agent: candidate.agent, accountId: candidate.accountId, ...(candidate.accountLabel ? { label: candidate.accountLabel } : {}) };
    let view: AgentView;
    try {
      view = findAgent(agents, candidate.agent);
    } catch {
      return { ok: false, scope: "chain", skip: { ...skipBase, why: "catalog", detail: `${candidate.agent} is not a chat agent on this host` } };
    }
    if (!view.enabled) {
      return { ok: false, scope: "chain", skip: { ...skipBase, why: "catalog", detail: `${candidate.agent} is not available on this host${view.disabledReason ? ` (${view.disabledReason})` : ""}` } };
    }
    let selection;
    try {
      selection = resolveModelSelection(view, { model: candidate.model, options: Object.fromEntries(candidate.options.map((o) => [o.id, o.value])) });
    } catch (error) {
      return { ok: false, scope: "chain", skip: { ...skipBase, why: "catalog", detail: error instanceof Error ? error.message : String(error) } };
    }
    try {
      validateAccountId(view, candidate.accountId);
    } catch (error) {
      return { ok: false, scope: "account", skip: { ...skipBase, why: "unavailable", detail: error instanceof Error ? error.message : String(error) } };
    }
    return { ok: true, candidate: { ...candidate, model: selection.model, options: selection.options } };
  }
}

export const MAX_TITLE_CHARS = 300;

export function sessionTitle(workflowName: string, blockName: string, configured?: string): string {
  const title = configured?.trim() ? configured.trim() : `${workflowName} · ${blockName}`;
  return title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS - 1)}…` : title;
}

/** The `POST /api/sessions` body (§5.1 step 2). */
export function buildCreateBody(input: {
  candidate: AgentCandidate;
  projectPath: string;
  title: string;
  owner: WorkflowSessionOwner;
}): CreateSessionRequest {
  const { candidate } = input;
  const chat: CreateAgentChatSessionFields = {
    accountId: candidate.accountId,
    modelSelection: { model: candidate.model, options: candidate.options },
    runtimeMode: "full-access"
  };
  return {
    kind: "agent-chat",
    refId: candidate.agent,
    projectPath: input.projectPath,
    cwd: input.projectPath,
    title: input.title,
    accountId: candidate.accountId,
    ...(launchesProxyModel(candidate.agent) ? { model: candidate.model } : {}),
    chat,
    owner: input.owner
  };
}

function sameOwner(a: WorkflowSessionOwner | undefined, b: WorkflowSessionOwner): boolean {
  return Boolean(a && a.kind === b.kind && a.workflowId === b.workflowId && a.runId === b.runId && a.nodeId === b.nodeId);
}

/**
 * A session this owner created at or after `since` that the block does not know yet — the create
 * whose answer a restart lost. The newest wins.
 */
export async function findOwnedSession(api: DaemonApi, owner: WorkflowSessionOwner, since: string, known: readonly string[]): Promise<SessionSummary | null> {
  const sinceMs = Date.parse(since);
  const found = (await listSessions(api)).filter(
    (s) => s.kind === "agent-chat" && sameOwner(s.owner, owner) && !known.includes(s.id) && (!Number.isFinite(sinceMs) || Date.parse(s.createdAt) >= sinceMs)
  );
  found.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return found[0] ?? null;
}

/** Create the session. Throws the daemon's `ToolError` (HOST_UNAVAILABLE is the caller's to retry). */
export async function createSession(api: DaemonApi, body: CreateSessionRequest): Promise<SessionSummary> {
  let res;
  try {
    res = await api.request("POST", "/api/sessions", { body });
  } catch {
    throw new ToolError("HOST_UNAVAILABLE", "The daemon call failed.");
  }
  return expectOk<SessionSummary>(res, "create");
}
