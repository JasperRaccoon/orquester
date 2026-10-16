/**
 * The scenario world (unified MCP design 2026-10-15 §14.2.11, plan Task 15): the daemon's REAL
 * routes and services wired the way `index.ts` wires them — on two in-process Fastify apps, the
 * unix-socket one (`local`: the chat transport, the manifest and reply-subscription routes) and the
 * remote HTTP one (`remote`: the external `/mcp`, the GUI's routes, socket-trusted fields stripped)
 * — over a FAKE agent host: chat tabs, threads, turns and provider snapshots held in memory and
 * served on the same paths the daemon's chat proxy serves them.
 *
 * Real: the principal hook and nonces; the session-tool call route (`buildThreadCaller`, THE
 * executor, the catalog); the external `/mcp` server; the approval cards, grants and agent-tools
 * store (`createAgentToolsRuntime`, `connectExecutor`); the lineage gate on `POST /api/sessions`,
 * the delivery queue and the reply router with its socket-only routes; the saved-prompt store and
 * routes; the workflow store, routes, engine and run store; the agent-profile service, its Claude
 * adapter and routes; the daemon-pointing detector and its route; the chat-manifest refresher and
 * its route; the token-usage scanner over a temp home. Faked: the agent host (tabs, threads,
 * turns, providers), the workspace/account listings and the quota snapshot.
 *
 * Nothing listens on a port and no provider CLI runs. Waits are receipts, bus events and drains,
 * never sleeps. A person answers a card as the GUI does: `POST` on the card route of the remote
 * app, no principal.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type InjectOptions } from "fastify";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  type AccountSummary,
  type AgentAccountsResponse,
  type EventMessage,
  type ProjectSummary,
  type SessionSummary,
  type UsageResponse,
  type WorkspaceSummary
} from "@orquester/api";
import {
  agentChatRoutes,
  threadHeadOf,
  threadHeadQueryOf,
  TOOL_APPROVAL_EVENT_TYPE,
  type AgentChatToolApprovalEventPayload,
  type CausedBy,
  type ProviderModel,
  type RuntimeMode,
  type ThreadItem,
  type ThreadSnapshotPayload,
  type ToolApprovalAnswer,
  type ToolApprovalSummary,
  type Turn
} from "@orquester/api/agent-chat";
import {
  agentChatMergeOutboxFile,
  agentChatThreadsDir,
  agentChatReplyOutboxFile,
  agentProfileBackupsDir,
  agentProfileImportsDir,
  agentProfileStashDir,
  savedPromptsPath,
  usageTokensCacheFile,
  workflowRunsDir,
  workflowSecretsPath,
  workflowStatePath,
  workflowsPath
} from "@orquester/config";

import { daemonRoutesForHost } from "../../agent-host/host-protocol.ts";
import { gateSessionCreateBody, principalOf, registerLineageRoutes, registerReplySubscriptionRoutes } from "../../agent-chat/lineage-routes.ts";
import { LineageService } from "../../agent-chat/lineage.ts";
import { ReplyRouter } from "../../agent-chat/replies.ts";
import { createdChildLineage } from "../../agent-chat/service.ts";
import { DaemonMcpDetector, listProjectDirs, registerDaemonMcpServersRoutes } from "../../agent-profile/daemon-mcp.ts";
import { ClaudeProfileAdapter } from "../../agent-profile/adapters/claude/index.ts";
import type { AgentHomes } from "../../agent-profile/adapters/types.ts";
import { createProfileConverter } from "../../agent-profile/convert.ts";
import { ProfileBackups, ProfileStash } from "../../agent-profile/infra/index.ts";
import { registerAgentProfileRoutes } from "../../agent-profile/routes.ts";
import { AgentProfileService } from "../../agent-profile/service.ts";
import { canonicalProjectPath, connectExecutor, createAgentToolsRuntime, type AgentToolsRuntime } from "../../agent-tools/approval-port.ts";
import { registerAgentToolsRuntimeRoutes } from "../../agent-tools/routes.ts";
import { Broadcaster } from "../../broadcaster.ts";
import { GitService } from "../../git.ts";
import { registerSavedPromptRoutes, SavedPromptsService } from "../../saved-prompts.ts";
import { registerSessionToolsRoute } from "../../session-tools/route.ts";
import { registerSessionToolsManifestRoute, SessionToolsRefresher } from "../../session-tools/toolset-refresh.ts";
import { ChatThreadUsageScanner } from "../../usage-chat-threads.ts";
import { UsageTokensScanner } from "../../usage-tokens.ts";
import { createWorkflowDaemon, type WorkflowDaemon } from "../../workflows/daemon-wiring.ts";
import { registerWorkflowRoutes } from "../../workflows/routes.ts";
import { FileRunStore } from "../../workflows/run-store.ts";
import { WorkflowSecretsService } from "../../workflows/secrets.ts";
import { publishWorkflowEvents, WorkflowService } from "../../workflows/service.ts";
import { WorkflowStateStore } from "../../workflows/state-store.ts";
import { FakeGitRemote } from "../../workflows/testing/daemon-harness.ts";
import { silentLogger } from "../../workflows/testing/fakes.ts";
import { catalogFor } from "../catalog/index.ts";
import { InjectDaemonApi } from "../daemon-api.ts";
import { executorPorts } from "../executor.ts";
import { registerPrincipalHook, registerRemoteFieldStripping } from "../principal.ts";
import { registerMcp } from "../server.ts";

/** The agent host's own bearer on the session-tool routes (the 0600 `agent-host.token`). */
export const HOST_BEARER = "Bearer scenario-host-token";
/** The daemon's own HTTP bearer: what a daemon-pointing user MCP server would carry. */
export const DAEMON_BEARER = "c2NlbmFyaW86JDJhJDEyJHNjZW5hcmlvLWhhc2g=";
/** The daemon's HTTP port as the detector compares URLs (nothing listens on it). */
export const DAEMON_PORT = 47_123;

const quiet = { log: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

// ---------------------------------------------------------------------------
// The fake agent host
// ---------------------------------------------------------------------------

export type ScenarioAgent = "claude" | "codex" | "grok" | "opencode";

interface FakeThread {
  seq: number;
  runtimeMode: RuntimeMode;
  model: string;
  turns: Turn[];
  items: ThreadItem[];
  events: { seq: number; type: string; commandId: string | null; payload: Record<string, unknown> }[];
  history?: ThreadSnapshotPayload["history"];
}

/** A provider catalogue as the host's probes report it (one model list per adapter). */
export const PROVIDER_MODELS: Readonly<Record<ScenarioAgent, ProviderModel[]>> = {
  claude: [
    {
      slug: "default", name: "Default (recommended)", subProvider: "claude-opus-5-5", isDefault: true,
      capabilities: { optionDescriptors: [{ id: "effort", label: "Effort", type: "select", options: [{ id: "low", label: "Low" }, { id: "high", label: "High", isDefault: true }] }] }
    } as ProviderModel,
    { slug: "sonnet", name: "Sonnet", shortName: "Sonnet 5", subProvider: "claude-sonnet-5", capabilities: null },
    { slug: "claude-opus-4-8", name: "Opus 4.8", isLegacy: true, capabilities: null }
  ],
  codex: [
    {
      slug: "gpt-5.6-terra", name: "GPT-5.6 Terra", isDefault: true,
      capabilities: { optionDescriptors: [{ id: "reasoningEffort", label: "Reasoning", type: "select", options: [{ id: "medium", label: "Medium", isDefault: true }, { id: "high", label: "High" }] }] }
    } as ProviderModel,
    { slug: "gpt-5.6-luna", name: "GPT-5.6 Luna", capabilities: null }
  ],
  grok: [{ slug: "grok-build", name: "Grok Build", isDefault: true, capabilities: null }],
  opencode: [{ slug: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", subProvider: "anthropic", isDefault: true, capabilities: null }]
};

const AGENT_NAMES: Readonly<Record<ScenarioAgent, string>> = { claude: "Claude Code", codex: "Codex", grok: "Grok Build", opencode: "OpenCode" };

export interface ChatSeed {
  agent?: ScenarioAgent;
  /** Canonical project path ("" = no project). */
  project: string;
  title?: string;
  runtimeMode?: RuntimeMode;
  owner?: SessionSummary["owner"];
  lineage?: SessionSummary["lineage"];
  model?: string;
}

export interface SettleOptions {
  tokenUsage?: Turn["tokenUsage"];
  totalCostUsd?: number;
  model?: string;
  state?: Turn["state"];
}

/**
 * The agent host as the daemon's routes see it: chat tabs (the session list), each tab's thread
 * (turns, items, events by seq, command receipts, `ifIdle`) and the provider snapshots. A turn
 * runs until the test settles it with a final reply.
 */
export class FakeHost {
  readonly tabs = new Map<string, SessionSummary>();
  readonly threads = new Map<string, FakeThread>();
  /** Every accepted turn post, in order. */
  readonly posts: { sessionId: string; body: Record<string, any> }[] = [];
  /** Manifests pushed to the host (an in-session toolset refresh). */
  readonly pushes: { threadId: string; tools: string[]; deny: string[] }[] = [];
  private readonly receipts = new Map<string, { status: number; body: unknown }>();
  private readonly postWaiters = new Map<string, (() => void)[]>();
  private ids = 0;

  constructor(private readonly publish: (type: string, payload: unknown) => void) {}

  /** `LineageSessions` for the delivery queue and the reply router. */
  readonly listing = { get: (id: string) => this.tabs.get(id), list: () => [...this.tabs.values()] };

  addChat(id: string, seed: ChatSeed): SessionSummary {
    const agent = seed.agent ?? "claude";
    const tab = {
      id, kind: "agent-chat", refId: agent, title: seed.title ?? id, projectPath: seed.project, cwd: seed.project,
      cols: 0, rows: 0, status: "running", order: this.tabs.size, createdAt: "2026-10-15T00:00:00.000Z", chatSessionStatus: "ready",
      ...(seed.owner ? { owner: seed.owner } : {}), ...(seed.lineage ? { lineage: seed.lineage } : {})
    } as SessionSummary;
    this.tabs.set(id, tab);
    this.threads.set(id, { seq: 1, runtimeMode: seed.runtimeMode ?? "full-access", model: seed.model ?? PROVIDER_MODELS[agent][0]!.slug, turns: [], items: [], events: [] });
    return tab;
  }

  setMode(id: string, mode: RuntimeMode): void {
    this.threads.get(id)!.runtimeMode = mode;
  }

  setHistory(id: string, history: ThreadSnapshotPayload["history"]): void {
    this.threads.get(id)!.history = history;
  }

  private active(t: FakeThread): Turn | undefined {
    return t.turns.find((turn) => turn.state === "running" || turn.state === "pending");
  }

  runningTurn(id: string): Turn | undefined {
    return this.active(this.threads.get(id)!);
  }

  snapshot(id: string): ThreadSnapshotPayload {
    const t = this.threads.get(id)!;
    const tab = this.tabs.get(id)!;
    const running = this.active(t);
    return {
      head: {
        id, projectPath: tab.projectPath, cwd: tab.cwd, title: tab.title, adapter: tab.refId, refId: tab.refId, accountId: tab.accountId ?? "", home: "system",
        modelSelection: { model: t.model, options: [] }, runtimeMode: t.runtimeMode,
        session: { status: running ? "running" : "ready", activeTurnId: running?.turnId ?? null, lastError: null }, turnCount: t.turns.length, seq: t.seq,
        createdAt: "2026-10-15T00:00:00.000Z", updatedAt: "2026-10-15T00:00:00.000Z"
      },
      items: t.items, turns: t.turns, checkpoints: [], pending: { approvals: [], userInputs: [] }, roster: [], seq: t.seq,
      ...(t.history ? { history: t.history } : {})
    } as unknown as ThreadSnapshotPayload;
  }

  /** The tab's derived fields follow its thread; a `session.updated` goes out on the bus. */
  touch(id: string): void {
    const tab = this.tabs.get(id);
    const t = this.threads.get(id);
    if (tab && t) {
      const last = t.turns.at(-1);
      this.tabs.set(id, {
        ...tab, chatSessionStatus: this.active(t) ? "running" : "ready",
        ...(last ? { latestTurn: { turnId: last.turnId!, state: last.state, startedAt: last.startedAt, completedAt: last.completedAt } } : {})
      } as SessionSummary);
    }
    this.publish("session.updated", this.tabs.get(id) ?? { id });
  }

  private startTurn(sessionId: string, body: Record<string, any>, commandId: string | null): void {
    const t = this.threads.get(sessionId)!;
    const messageId = `msg-${(this.ids += 1)}`;
    const running = this.active(t);
    const interactionMode = body.interactionMode === "plan" ? "plan" : "default";
    t.seq += 1;
    t.events.push({ seq: t.seq, type: "thread.message-sent", commandId, payload: { messageId, role: "user", text: body.input, turnId: running?.turnId ?? null } });
    t.items.push({
      kind: "message", id: messageId, role: "user", text: body.input, turnId: running?.turnId ?? null, streaming: false, createdAt: "t", updatedAt: "t",
      interactionMode, ...(body.context ? { context: body.context } : {})
    } as ThreadItem);
    if (!running) {
      t.seq += 1;
      const turnId = `turn-${this.ids}`;
      t.events.push({ seq: t.seq, type: "thread.turn-start-requested", commandId, payload: { turnId: null, messageId } });
      t.turns.push({
        turnId, state: "running", turnCount: t.turns.length + 1, requestedAt: "t", startedAt: "t", completedAt: null, assistantMessageId: null,
        userMessageId: messageId, interactionMode, ...(body.causedBy ? { causedBy: body.causedBy as CausedBy } : {})
      } as Turn);
    }
  }

  /** The user types into a chat (a user-authored turn: no exchange). */
  userTurn(id: string, text: string, opts: { plan?: boolean } = {}): void {
    this.startTurn(id, { input: text, interactionMode: opts.plan ? "plan" : "default" }, null);
    this.touch(id);
  }

  /** The chat's running turn ends with `reply` as its final message. */
  settle(id: string, reply: string, opts: SettleOptions = {}): void {
    const t = this.threads.get(id)!;
    const turn = this.active(t)!;
    turn.state = opts.state ?? "completed";
    turn.completedAt = "t";
    if (opts.tokenUsage) turn.tokenUsage = opts.tokenUsage;
    if (opts.totalCostUsd !== undefined) turn.totalCostUsd = opts.totalCostUsd;
    if (opts.model) turn.model = opts.model;
    t.items.push({ kind: "message", id: `a-${turn.turnId}`, role: "assistant", text: reply, turnId: turn.turnId, streaming: false, createdAt: "t", updatedAt: "t" } as ThreadItem);
    t.seq += 1;
    this.touch(id);
  }

  /** Resolves on the next turn posted to `id`. */
  nextPost(id: string): Promise<void> {
    return new Promise<void>((resolve) => {
      this.postWaiters.set(id, [...(this.postWaiters.get(id) ?? []), resolve]);
    });
  }

  postsTo(id: string): Record<string, any>[] {
    return this.posts.filter((post) => post.sessionId === id).map((post) => post.body);
  }

  /** The daemon's session and chat-proxy routes, answered from the host's memory. */
  register(app: FastifyInstance, deps: { providers: () => unknown; closed: (id: string) => void }): void {
    const notFound = (reply: FastifyReply) => reply.code(404).send({ error: { code: "THREAD_NOT_FOUND", message: "No chat session with that id." } });
    app.get<{ Querystring: { projectPath?: string } }>("/api/sessions", async (request) =>
      [...this.tabs.values()].filter((tab) => !request.query.projectPath || tab.projectPath === request.query.projectPath)
    );
    // `POST /api/sessions` for a chat tab: the lineage gate (`registerLineageRoutes`' preHandler) ran
    // first; this stands in for `AgentChatService.createSession`'s lineage stamping.
    app.post("/api/sessions", async (request, reply) => {
      const body = request.body as Record<string, any>;
      // Defence in depth: the real route's gate already ran in the preHandler.
      gateSessionCreateBody(body, principalOf(request));
      if (body.kind !== "agent-chat") return reply.code(400).send({ code: "SESSION_UNAVAILABLE", message: "Only chat tabs in scenarios." });
      if (!body.projectPath || !existsSync(body.projectPath)) return reply.code(400).send({ code: "SESSION_UNAVAILABLE", message: "No such project." });
      const fields = body.chat ?? {};
      let lineage: SessionSummary["lineage"] | undefined;
      if (fields.lineage) {
        const parent = this.tabs.get(fields.lineage.parentThreadId);
        if (!parent) return reply.code(400).send({ code: "INVALID_LINEAGE", message: "lineage must name a chat session as parent." });
        if (fields.lineage.relation !== "delegate" && fields.lineage.relation !== "opened") return reply.code(400).send({ code: "INVALID_LINEAGE", message: "relation must be delegate or opened." });
        // The service's own stamping (depth, agentCreated, the inherited workflow-ownership marker).
        lineage = createdChildLineage(parent, { relation: fields.lineage.relation, agentCreated: fields.lineage.agentCreated === true }, (id) => this.tabs.get(id), "2026-10-15T00:00:00.000Z");
      }
      const id = `chat-${(this.ids += 1)}`;
      const tab = this.addChat(id, {
        agent: body.refId, project: body.projectPath, title: body.title, runtimeMode: fields.runtimeMode,
        ...(lineage ? { lineage } : {}), ...(body.owner ? { owner: body.owner } : {}), model: fields.modelSelection?.model
      });
      if (body.cwd) this.tabs.set(id, { ...tab, cwd: body.cwd });
      this.touch(id);
      return this.tabs.get(id);
    });
    app.put<{ Params: { id: string } }>("/api/sessions/:id", async (request, reply) => {
      const tab = this.tabs.get(request.params.id);
      if (!tab) return reply.code(404).send();
      this.tabs.set(tab.id, { ...tab, title: String((request.body as { title?: string })?.title ?? tab.title) });
      return this.tabs.get(tab.id);
    });
    app.delete<{ Params: { id: string } }>("/api/sessions/:id", async (request, reply) => {
      if (!this.tabs.delete(request.params.id)) return reply.code(404).send();
      this.threads.delete(request.params.id);
      deps.closed(request.params.id);
      this.publish("session.closed", { id: request.params.id });
      return reply.code(204).send();
    });
    app.get(agentChatRoutes.providers, async () => deps.providers());
    app.get<{ Params: { id: string }; Querystring: { after?: string } }>(decodeURIComponent(agentChatRoutes.thread(":id")), async (request, reply) => {
      const t = this.threads.get(request.params.id);
      if (!t) return notFound(reply);
      if (request.query.after !== undefined) return { kind: "events", seq: t.seq, events: t.events.filter((event) => event.seq > Number(request.query.after)) };
      return { kind: "snapshot", thread: this.snapshot(request.params.id) };
    });
    // The head, as the daemon derives it from a snapshot (`threadHeadOf`, its fallback for a host without `/head`).
    app.get<{ Params: { id: string }; Querystring: Record<string, string> }>(decodeURIComponent(agentChatRoutes.threadHead(":id")), async (request, reply) => {
      if (!this.threads.get(request.params.id)) return notFound(reply);
      return threadHeadOf(this.snapshot(request.params.id), threadHeadQueryOf(request.query));
    });
    app.post<{ Params: { id: string } }>(decodeURIComponent(agentChatRoutes.turn(":id")), async (request, reply) => {
      const id = request.params.id;
      const t = this.threads.get(id);
      if (!t) return notFound(reply);
      const body = request.body as Record<string, any>;
      const recorded = this.receipts.get(body.commandId);
      if (recorded) return reply.code(recorded.status).send(recorded.body);
      if (body.ifIdle === true && this.active(t)) return reply.code(409).send({ error: { code: "TURN_NOT_IDLE", message: "working" } });
      this.posts.push({ sessionId: id, body });
      this.startTurn(id, body, body.commandId ?? null);
      for (const wake of this.postWaiters.get(id)?.splice(0) ?? []) wake();
      const answer = { status: 200, body: { seq: t.seq } };
      if (body.commandId) this.receipts.set(body.commandId, answer);
      this.touch(id);
      return answer.body;
    });
    app.post<{ Params: { id: string } }>(decodeURIComponent(agentChatRoutes.interrupt(":id")), async (request, reply) => {
      const t = this.threads.get(request.params.id);
      if (!t) return notFound(reply);
      const running = this.active(t);
      if (running) {
        running.state = "interrupted";
        running.completedAt = "t";
        t.seq += 1;
        this.touch(request.params.id);
      }
      return { seq: t.seq };
    });
    // The host's search index: every message containing the query, in every thread (or one project's).
    app.get<{ Querystring: { q?: string; limit?: string; projectPath?: string } }>(agentChatRoutes.search, async (request) => {
      const q = (request.query.q ?? "").toLowerCase();
      const hits = [...this.threads.entries()].flatMap(([threadId, t]) => {
        const tab = this.tabs.get(threadId);
        if (!tab || (request.query.projectPath && tab.projectPath !== request.query.projectPath)) return [];
        return t.items.flatMap((item) =>
          item.kind === "message" && item.text.toLowerCase().includes(q)
            ? [{ threadId, projectPath: tab.projectPath, title: tab.title, turnId: item.turnId, ordinal: null, kind: "message", id: item.id, role: item.role, activityKind: null, snippet: item.text, at: "2026-10-15T00:00:00.000Z", seq: t.seq }]
            : []
        );
      });
      const limit = Number(request.query.limit ?? 50);
      return { query: request.query.q ?? "", hits: hits.slice(0, limit), truncated: hits.length > limit, indexed: true };
    });
    app.get<{ Querystring: { path?: string } }>("/api/agents/conversations", async () => ({ conversations: [] }));
  }
}

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

export interface WorkspaceSeed {
  /** `<workspace>` → its project names. */
  projects: Record<string, string[]>;
  /** `<workspace>` → its git account id (an `AccountSummary` below). */
  gitAccounts?: Record<string, string>;
}

export interface CardWatch {
  /** The next card opened (already open, or the next one). */
  next(): Promise<ToolApprovalSummary>;
  /** Every card opened so far, in order. */
  readonly opened: ToolApprovalSummary[];
}

export interface ScenarioWorld {
  root: string;
  workspacesDir: string;
  appdir: string;
  homes: AgentHomes;
  /** Canonical project paths by `workspace/project`. */
  project(name: string): string;
  host: FakeHost;
  local: FastifyInstance;
  remote: FastifyInstance;
  /** The daemon's own in-process client over the unix app (the chat transport's and the engine's). */
  internalApi: InjectDaemonApi;
  runtime: AgentToolsRuntime;
  savedPrompts: SavedPromptsService;
  workflows: { service: WorkflowService; runStore: FileRunStore; secrets: WorkflowSecretsService; daemon: WorkflowDaemon };
  agentProfile: AgentProfileService;
  lineage: LineageService;
  router: ReplyRouter;
  refresher: SessionToolsRefresher;
  usageTokens: UsageTokensScanner;
  /** The quota snapshot `GET /api/usage` answers. */
  quota: UsageResponse;
  /** The managed agent accounts `GET /api/agent-accounts` answers. */
  agentAccounts: AgentAccountsResponse;
  events: EventMessage[];
  cards: CardWatch;
  /** A tool call from chat `threadId`, through the socket-only session-tool route as the host makes it. */
  chat(threadId: string, name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  /** A tool call from an external MCP client, through `/mcp` on the remote app. */
  external(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  /** The user answers a card on its card route (the GUI, remote app, no principal). */
  answer(card: ToolApprovalSummary, answer: ToolApprovalAnswer): Promise<{ status: number; body: any }>;
  /** The card a running call opens; fails at once when the call settles without one. */
  cardFor(pending: Promise<CallToolResult>, what: string): Promise<ToolApprovalSummary>;
  /** A chat call that opens exactly one card, which the user answers as given. */
  carded(threadId: string, name: string, args: Record<string, unknown>, answer: ToolApprovalAnswer): Promise<{ card: ToolApprovalSummary; result: CallToolResult; answered: { ok: true; outcome: string; grantId?: string } }>;
  /** A chat call that must open no card (one that opens is denied and fails the test). */
  uncarded(threadId: string, name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  /** A GUI request on the remote app (the user's own principal). */
  user(options: InjectOptions): Promise<{ status: number; body: any }>;
  /** Lets every queue lane, router evaluation and store write settle (no clock). */
  drain(): Promise<void>;
  close(): Promise<void>;
}

const providerSnapshot = (agent: ScenarioAgent) => ({
  id: agent, refIds: [agent], installed: true, version: "1.0.0", status: "ready", auth: { status: "authenticated" }, checkedAt: "2026-10-15T00:00:00.000Z",
  slashCommands: [], skills: [], models: PROVIDER_MODELS[agent],
  capabilities: { showPlanModeToggle: agent !== "codex", supportsConversationRollback: true, reportsContextWindow: agent === "claude" }
});

const gitAccount = (id: string, label: string, login: string): AccountSummary =>
  ({ id, label, provider: "github", login, githubLogin: login, host: "github.com", gitName: label, gitEmail: `${login}@example.com`, publicKey: "ssh-ed25519 AAAA" }) as AccountSummary;

export async function scenarioWorld(seed: WorkspaceSeed): Promise<ScenarioWorld> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "umcp-scenarios-")));
  const workspacesDir = join(root, "workspaces");
  const appdir = join(root, "appdir");
  const home = join(root, "home");
  await mkdir(join(appdir, "daemon"), { recursive: true });
  await mkdir(join(appdir, "tmp"), { recursive: true });
  for (const [workspace, projects] of Object.entries(seed.projects)) {
    for (const project of projects) await mkdir(join(workspacesDir, workspace, project), { recursive: true });
  }
  const homes: AgentHomes = {
    home, claudeDir: join(home, ".claude"), claudeJson: join(home, ".claude.json"), codexHome: join(home, ".codex"),
    grokHome: join(home, ".grok"), opencodeDir: join(home, ".config", "opencode"), agentsSkillsDir: join(home, ".agents", "skills")
  };
  await mkdir(homes.claudeDir, { recursive: true });
  const project = (name: string): string => {
    const [workspace, name2] = name.split("/");
    return join(workspacesDir, workspace!, name2!);
  };

  // The bus, as the daemon's broadcaster; every event kept in order (the secrets scenario reads them all).
  const broadcaster = new Broadcaster();
  const events: EventMessage[] = [];
  broadcaster.add({
    send(data: string) {
      events.push(JSON.parse(data) as EventMessage);
    }
  });

  // Cards: every `opened` payload on the bus, handed out in order.
  const opened: ToolApprovalSummary[] = [];
  const unread: ToolApprovalSummary[] = [];
  const cardWaiters: ((card: ToolApprovalSummary) => void)[] = [];
  broadcaster.add({
    send(data: string) {
      const event = JSON.parse(data) as EventMessage;
      if (event.type !== TOOL_APPROVAL_EVENT_TYPE) return;
      const payload = event.payload as AgentChatToolApprovalEventPayload;
      if (!payload.opened) return;
      opened.push(payload.opened);
      const waiter = cardWaiters.shift();
      if (waiter) waiter(payload.opened);
      else unread.push(payload.opened);
    }
  });
  const cards: CardWatch = {
    opened,
    next: () => (unread.length > 0 ? Promise.resolve(unread.shift()!) : new Promise((resolve) => cardWaiters.push(resolve)))
  };
  /** Runs `call`, which must open NO card: one that opens is denied at once and the call fails the test. */
  const noCard = async <T>(call: () => Promise<T>): Promise<T> => {
    assert.equal(unread.length, 0, "a card from an earlier call is still unanswered");
    const unexpected: ToolApprovalSummary[] = [];
    const guard = (card: ToolApprovalSummary) => {
      unexpected.push(card);
      void answer(card, { decision: "deny", reason: "unexpected card" });
      cardWaiters.unshift(guard);
    };
    cardWaiters.unshift(guard);
    try {
      return await call();
    } finally {
      const index = cardWaiters.indexOf(guard);
      if (index >= 0) cardWaiters.splice(index, 1);
      assert.deepEqual(unexpected.map((card) => card.title), [], "the call opened a card");
    }
  };

  const host = new FakeHost((type, payload) => broadcaster.publish("sessions", type, payload));
  const local = Fastify({ logger: false });
  const remote = Fastify({ logger: false });
  let internalApi!: InjectDaemonApi;

  // Agent tools: cards, grants, toolsets (index.ts umcp:t3).
  const runtime = createAgentToolsRuntime({
    baseDir: appdir,
    publish: (channel, type, payload) => broadcaster.publish(channel, type, payload),
    onApprovalsChanged: () => undefined,
    tab: (id) => host.tabs.get(id),
    agentOf: (id) => host.tabs.get(id)?.refId ?? null,
    api: () => internalApi,
    projectExists: (path) => existsSync(path),
    // A card the test never answers ends in a minute, not the production 30: no scenario can hang.
    timeoutMs: 60_000,
    logger: quiet
  });
  await runtime.load();
  const disconnectExecutor = connectExecutor(runtime, executorPorts);

  // Lineage queue and reply router (umcp:t5).
  let n = 0;
  const lineage = new LineageService({
    sessions: host.listing, outboxFile: agentChatMergeOutboxFile(appdir), recheckMs: 0, newId: () => `m-${(n += 1)}`,
    setPendingMerges: (sessionId, merges) => {
      const tab = host.tabs.get(sessionId);
      if (tab) host.tabs.set(sessionId, { ...tab, ...(merges.length > 0 ? { pendingMerges: merges } : { pendingMerges: undefined }) });
    },
    logger: quiet
  });
  await lineage.load();
  const router = new ReplyRouter({ outboxFile: agentChatReplyOutboxFile(appdir), sessions: host.listing, queue: lineage, recheckMs: 0, newId: () => `r-${(n += 1)}`, logger: quiet });
  await router.load();
  lineage.setDeliveryListener(router);

  // Saved prompts (umcp:t12) and workflows (the engine as startDaemon wires it).
  const savedPrompts = new SavedPromptsService({ file: savedPromptsPath(appdir), workspacesDir: () => workspacesDir, fsRoot: () => workspacesDir, logger: quiet });
  await savedPrompts.load();
  const secrets = new WorkflowSecretsService({ file: workflowSecretsPath(appdir), logger: quiet });
  await secrets.load();
  let catalogRef: WorkflowDaemon["validationCatalog"] | null = null;
  const service = new WorkflowService({
    file: workflowsPath(appdir), logger: quiet, secretNames: (workflowId) => secrets.names(workflowId),
    savedPromptIds: () => savedPrompts.allIds(), agentCatalog: () => catalogRef?.current()
  });
  await service.load();
  const runStore = new FileRunStore({ dir: workflowRunsDir(appdir), logger: quiet });
  await runStore.init();
  const state = new WorkflowStateStore({ path: workflowStatePath(appdir), logger: quiet });
  await state.load();
  const daemon = createWorkflowDaemon({
    service, secrets, runStore, state, broadcaster,
    usage: { snapshot: (): UsageResponse => ({ agents: [] }) },
    accounts: { list: (): AgentAccountsResponse => ({ accounts: [], defaults: { claude: null, codex: null, grok: null } }) as AgentAccountsResponse },
    git: new GitService(), gitRemote: new FakeGitRemote(),
    readWorkspaceMeta: async (workspace) => (seed.gitAccounts?.[workspace] ? { gitAccountId: seed.gitAccounts[workspace]! } : null),
    savedPrompts: { get: (id: string) => savedPrompts.get(id) },
    workspacesDir: () => workspacesDir, fsRoot: () => workspacesDir, appdirTmp: join(appdir, "tmp"), push: null, logger: silentLogger()
  });
  catalogRef = daemon.validationCatalog;
  publishWorkflowEvents({ service, secrets, broadcaster: daemon.events, summarize: (workflow) => daemon.summarize(workflow) });

  // The agent profile (Claude in a temp home).
  const backups = { backups: new ProfileBackups({ dir: agentProfileBackupsDir(appdir) }), stash: new ProfileStash({ dir: agentProfileStashDir(appdir) }) };
  const claudeProfile = new ClaudeProfileAdapter({ homes, appdir, bin: "/unused/claude", accountHomes: async () => [], logger: quiet, now: () => new Date() }, backups);
  const agentProfile = new AgentProfileService({
    adapters: { claude: claudeProfile }, agentInfo: (agent) => ({ installed: agent === "claude" }), homes, logger: quiet,
    converter: createProfileConverter({ tempRoot: agentProfileImportsDir(appdir) })
  });

  // Daemon-pointing MCP servers (umcp:t11): the daemon's bearer and port as the transport checks them.
  const detector = new DaemonMcpDetector(
    { verifyBearer: (token) => token === DAEMON_BEARER, httpPort: () => DAEMON_PORT, publicOrigins: () => [], env: () => undefined },
    { homes, accountHomes: async () => [], projects: () => listProjectDirs(workspacesDir), workspacesRoot: () => workspacesDir, logger: quiet }
  );

  // The chat manifest and toolset pushes (umcp:t6); the fake host applies every push live.
  const refresher = new SessionToolsRefresher({
    thread: (id) => {
      const tab = host.tabs.get(id);
      if (!tab) return null;
      return { agentId: tab.refId as ScenarioAgent, home: "system", projectPath: tab.projectPath, canonicalProjectPath: tab.projectPath ? canonicalProjectPath(tab.projectPath) : "" };
    },
    openThreads: () => [...host.tabs.keys()],
    resolvedToolsets: (id, agent) => runtime.tools.resolvedToolsets(id, agent),
    agentToolsEnabled: () => runtime.tools.snapshot().enabled,
    catalog: () => catalogFor("chat"),
    api: () => internalApi,
    pushToHost: async (threadId, manifest) => {
      host.pushes.push({ threadId, tools: [...manifest.tools], deny: [...manifest.deny] });
      return { applied: "live" } as never;
    },
    logger: quiet
  });
  runtime.tools.setAdvertisedToolsets((id) => refresher.advertisedToolsets(id));
  const offToolsetsChanged = runtime.tools.onToolsetsChanged((id) => refresher.toolsetsChanged(id));
  const previousToolsetApproved = executorPorts.onToolsetApproved;
  executorPorts.onToolsetApproved = (caller, toolset, signal) => refresher.toolsetApproved(caller, toolset, signal);

  // Token usage (the Cost tab's scanner over this world's home) and the quota snapshot.
  const usageTokens = new UsageTokensScanner({ userhome: home, cacheFile: usageTokensCacheFile(appdir), now: () => Date.now() });
  await usageTokens.init();
  // Grok's usage from this world's chat logs (the daemon's own scanner and route).
  const chatThreadUsage = new ChatThreadUsageScanner({ threadsDir: agentChatThreadsDir(appdir), agents: ["grok"], now: () => Date.now() });
  const world = {
    quota: { agents: [] } as UsageResponse,
    agentAccounts: { accounts: [], defaults: { claude: null, codex: null, grok: null } } as AgentAccountsResponse
  };

  // Workspace and git-account listings (the daemon reads them from workspaces.json and accounts.json).
  const accounts: AccountSummary[] = [gitAccount("acct-jasper", "JasperDev (GitHub)", "jasperdev"), gitAccount("acct-acme", "Acme Bot (GitHub)", "acme-bot")];
  const workspaces = (): WorkspaceSummary[] =>
    Object.keys(seed.projects).map((name) => {
      const id = seed.gitAccounts?.[name] ?? null;
      const account = accounts.find((row) => row.id === id);
      return {
        name, path: join(workspacesDir, name), projectCount: seed.projects[name]!.length, gitAccountId: id,
        gitAccount: account ? { label: account.label, login: account.login, provider: account.provider } : null, isArchived: false
      };
    });
  const registry = {
    shells: [], ides: [], fileExplorers: [], browsers: [],
    agents: (["claude", "codex", "grok", "opencode"] as const).map((id) => ({ id, kind: "agent", name: AGENT_NAMES[id], bin: [id], enabled: true, installState: "idle", chat: { adapter: id } }))
  };

  const registerShared = (app: FastifyInstance, mode: "local" | "remote"): void => {
    registerPrincipalHook(app);
    if (mode === "remote") registerRemoteFieldStripping(app);
    registerLineageRoutes(app, {
      lineage: () => lineage,
      isChatSession: (id) => host.tabs.has(id),
      fork: async () => {
        throw Object.assign(new Error("Forks are not part of these scenarios."), { code: "FORK_UNAVAILABLE" });
      }
    });
    registerAgentToolsRuntimeRoutes(app, runtime);
    host.register(app, {
      providers: () => ({ hostInstanceId: "scenario-host", providers: (["claude", "codex", "grok", "opencode"] as const).map(providerSnapshot) }),
      closed: (id) => runtime.threadClosed(id)
    });
    app.get("/api/registry", async () => registry);
    app.get("/api/agent-accounts", async (): Promise<AgentAccountsResponse> => world.agentAccounts);
    app.get("/api/accounts", async () => accounts);
    app.get("/api/workspaces", async () => workspaces());
    app.get<{ Params: { workspace: string } }>("/api/workspaces/:workspace/projects", async (request, reply): Promise<ProjectSummary[] | FastifyReply> => {
      const names = seed.projects[request.params.workspace];
      if (!names) return reply.code(404).send();
      return names.map((name) => ({ name, workspace: request.params.workspace, path: join(workspacesDir, request.params.workspace, name), repoId: `github.com/jaspersito/${name.replace(/-\d+$/, "")}` }));
    });
    app.get("/api/projects/recent", async () => []);
    app.get("/api/usage", async () => world.quota);
    app.get<{ Querystring: { refresh?: string } }>("/api/usage/tokens", async (request) => usageTokens.snapshot(request.query.refresh === "1"));
    app.get<{ Querystring: { agent?: string } }>("/api/usage/chat-threads", async (request, reply) =>
      request.query.agent === "grok" ? chatThreadUsage.snapshot("grok") : reply.code(400).send({ code: "INVALID_REQUEST", message: "agent must be grok." })
    );
    registerSavedPromptRoutes(app, { service: savedPrompts, workflows: () => service.list(), workspacesDir: () => workspacesDir });
    registerWorkflowRoutes(app, {
      service, secrets, runStore, engine: () => daemon.runtime.engine, savedPromptIds: () => savedPrompts.allIds(),
      agentCatalogReady: async () => catalogRef?.ready()
    });
    registerAgentProfileRoutes(app, { service: agentProfile, importsDir: agentProfileImportsDir(appdir) });
    registerDaemonMcpServersRoutes(app, { detector, mode, current: (agent, id) => agentProfile.mcpCandidate(agent, id) });
  };

  registerShared(local, "local");
  // Socket-only (index.ts: the unix app alone).
  registerReplySubscriptionRoutes(local, { replies: () => router, isChatSession: (id) => host.tabs.has(id) });
  registerSessionToolsManifestRoute(local, { authorizeHost: (authorization) => authorization === HOST_BEARER, refresher });
  registerSessionToolsRoute(local, {
    authorizeHost: (authorization) => authorization === HOST_BEARER,
    resolveThread: (threadId) => {
      const tab = host.tabs.get(threadId);
      return tab ? { projectPath: tab.projectPath, cwd: tab.cwd, agentId: tab.refId as ScenarioAgent } : null;
    },
    api: () => internalApi
  });
  registerShared(remote, "remote");
  let externalApi!: InjectDaemonApi;
  registerMcp(remote, { createApi: () => externalApi, credentialId: () => "cred_scenario" });
  // `/mcp` under `app.inject`: the MCP SDK's transport answers through @hono/node-server's listener,
  // which, after responding, "drains" the request body unless the IncomingMessage is destroyed
  // (`drainIncoming`). Fastify has already consumed the body and light-my-request's request never
  // emits 'end', so the drain's timer fires and calls `socket.destroySoon()` — which
  // light-my-request's fake socket lacks: an uncaught TypeError after the test ends. Marking the
  // consumed request destroyed tells the drain there is nothing left to read (a real socket
  // needs no such help). Test transport only; the daemon's `/mcp` route is unchanged.
  remote.addHook("preHandler", async (request: FastifyRequest) => {
    if (request.url === "/mcp") (request.raw as unknown as { destroyed: boolean }).destroyed = true;
  });
  await local.ready();
  await remote.ready();
  internalApi = new InjectDaemonApi({ app: local, authorization: undefined, agentChat: null, broadcaster, fsRoot: workspacesDir, workspacesDir });
  externalApi = new InjectDaemonApi({ app: remote, authorization: undefined, agentChat: null, broadcaster, fsRoot: workspacesDir, workspacesDir });

  lineage.attachApi(internalApi);
  await router.whenReady();
  await daemon.start(internalApi);

  let calls = 0;
  const chat = async (threadId: string, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> => {
    const res = await local.inject({
      method: "POST", url: daemonRoutesForHost.sessionToolCall, headers: { authorization: HOST_BEARER, "content-type": "application/json" },
      payload: JSON.stringify({ threadId, callId: `call-${(calls += 1)}`, name, arguments: args })
    });
    if (res.statusCode !== 200) throw new Error(`session-tool route answered ${res.statusCode}: ${res.body}`);
    return res.json() as CallToolResult;
  };
  let rpc = 0;
  const external = async (name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> => {
    const res = await remote.inject({
      method: "POST", url: "/mcp",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: (rpc += 1), method: "tools/call", params: { name, arguments: args } }
    });
    if (res.statusCode !== 200) throw new Error(`/mcp answered ${res.statusCode}: ${res.body}`);
    const envelope = res.json() as { result?: CallToolResult; error?: unknown };
    if (!envelope.result) throw new Error(`/mcp error: ${res.body}`);
    return envelope.result;
  };
  const user = async (options: InjectOptions) => {
    const res = await remote.inject(options);
    let body: any = null;
    try { body = res.body ? JSON.parse(res.body) : null; } catch { body = res.body; }
    return { status: res.statusCode, body };
  };
  const answer = (card: ToolApprovalSummary, response: ToolApprovalAnswer) =>
    user({ method: "POST", url: agentChatRoutes.toolApproval(card.threadId, card.approvalId), payload: response as unknown as Record<string, unknown> });
  /** The card `pending` opens; the call settling first fails at once (never a wait for a card that will not come). */
  const cardFor = async (pending: Promise<CallToolResult>, what: string): Promise<ToolApprovalSummary> => {
    const waiter = cards.next();
    const first = await Promise.race([waiter.then((card) => ({ card })), pending.then((result) => ({ result }))]);
    if ("card" in first) return first.card;
    // Withdraw the waiter, so a later card is not handed to it.
    cardWaiters.splice(0, cardWaiters.length);
    return assert.fail(`${what} opened no card; it answered ${JSON.stringify(first.result.structuredContent).slice(0, 400)}`);
  };
  /** A call that opens one card, answered by the user as given. */
  const carded = async (threadId: string, name: string, args: Record<string, unknown>, response: ToolApprovalAnswer) => {
    assert.equal(unread.length, 0, "a card from an earlier call is still unanswered");
    const pending = chat(threadId, name, args);
    const card = await cardFor(pending, name);
    const answered = await answer(card, response);
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    return { card, result: await pending, answered: answered.body as { ok: true; outcome: string; grantId?: string } };
  };

  /** The queue and the router until neither has work in flight (each can hand the other more). */
  const drain = async (): Promise<void> => {
    do {
      await lineage.whenIdle();
      await router.whenIdle();
    } while (lineage.hasWorkInFlight() || router.hasWorkInFlight());
  };

  let closed = false;
  return {
    root, workspacesDir, appdir, homes, project, host, local, remote, internalApi, runtime, savedPrompts,
    workflows: { service, runStore, secrets, daemon }, agentProfile, lineage, router, refresher, usageTokens,
    get quota() { return world.quota; },
    set quota(value: UsageResponse) { world.quota = value; },
    get agentAccounts() { return world.agentAccounts; },
    set agentAccounts(value: AgentAccountsResponse) { world.agentAccounts = value; },
    events, cards, chat, external, answer, cardFor, carded, uncarded: (threadId, name, args = {}) => noCard(() => chat(threadId, name, args)), user, drain,
    async close() {
      if (closed) return;
      closed = true;
      offToolsetsChanged();
      executorPorts.onToolsetApproved = previousToolsetApproved;
      refresher.stop();
      disconnectExecutor();
      await runtime.shutdown();
      await lineage.stop();
      await daemon.stop();
      await Promise.all([service.flush(), secrets.flush(), runStore.flush(), state.flush()]);
      await agentProfile.stop();
      await local.close();
      await remote.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

/** A file under the world's home, its directories made. */
export async function writeHomeFile(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

/** A tool result's structured content. */
export const out = (result: CallToolResult): Record<string, any> => result.structuredContent as Record<string, any>;
