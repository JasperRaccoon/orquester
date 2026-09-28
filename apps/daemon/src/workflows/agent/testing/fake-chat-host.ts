// A faithful in-memory stand-in for the daemon's chat routes, as `DaemonApi` sees them — for the
// agent block's tests, and reusable by the MCP / e2e builders.
//
// What it simulates (the parts a workflow drives):
//   - the catalogue reads `loadAgents` makes: /api/registry, /api/agent/providers,
//     /api/agent-accounts, /api/cliproxy, /api/cliproxy/models;
//   - POST /api/sessions (a chat tab + thread, `owner` recorded), GET /api/sessions, DELETE;
//   - the commands: /turn (a new turn, or a steer into the running one), /interrupt (settles the
//     running turn `interrupted`, cancels pending requests, stops background work), /answer,
//     /approval, /dismiss, /account (refused with 409 COMMAND_REJECTED while anything is in flight —
//     the host's `identitySwitchRefusal` — and on demand), every one deduplicated by `commandId`
//     through a receipt map exactly as the host's receipts do;
//   - GET …/thread snapshots (head, items, turns, pending requests) and GET …/items/:id;
//   - `session.updated` on the bus after every change, carrying the summary's chat fields
//     (latestTurn, chatSessionStatus, pending flags, the actionable plan, backgroundLiveness).
//
// Provider behaviour is scripted per turn (`behaviour`): a list of steps — reply, ask, ask for an
// approval, hit a usage limit (failed turn, parked Claude warning, at start, legacy text), fail
// auth, fail, propose a plan, start background work (which can hit a limit, or wake the parent into
// a provider-started turn), or hang. Time is the injected fake clock's; nothing here sleeps.

import type { AgentAccount, AgentAccountsResponse, EventMessage, SessionSummary } from "@orquester/api";
import {
  isPlanImplementationMessage,
  type AgentAdapterId,
  type PendingApproval,
  type PendingUserInput,
  type ThreadActivityItem,
  type ThreadItem,
  type ThreadMessageItem,
  type ThreadSessionStatus,
  type ThreadSnapshotPayload,
  type Turn,
  type UserInputQuestion
} from "@orquester/api/agent-chat";
import type { DaemonApi, DaemonMethod, DaemonResponse } from "../../../mcp/daemon-api.ts";
import type { FakeClock } from "./fake-clock.ts";

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export interface FakeModelOption {
  id: string;
  label: string;
  type: "select" | "boolean";
  options?: { id: string; label: string; isDefault?: boolean }[];
}

export interface FakeModel {
  slug: string;
  name: string;
  isDefault?: boolean;
  options?: FakeModelOption[];
}

export interface FakeAgent {
  /** Registry refId. */
  id: string;
  name: string;
  adapter: AgentAdapterId;
  enabled?: boolean;
  models: FakeModel[];
}

const EFFORT: FakeModelOption = {
  id: "effort",
  label: "Effort",
  type: "select",
  options: [
    { id: "low", label: "Low" },
    { id: "high", label: "High", isDefault: true }
  ]
};

export const DEFAULT_FAKE_AGENTS: FakeAgent[] = [
  { id: "claude", name: "Claude Code", adapter: "claude", models: [{ slug: "opus", name: "Opus", isDefault: true, options: [EFFORT] }, { slug: "sonnet", name: "Sonnet", options: [EFFORT] }] },
  { id: "claudemix", name: "Claude Mix", adapter: "claude", models: [{ slug: "opus", name: "Opus", isDefault: true, options: [EFFORT] }] },
  { id: "codex", name: "Codex", adapter: "codex", models: [{ slug: "gpt-5", name: "GPT-5", isDefault: true, options: [EFFORT] }] },
  { id: "grok", name: "Grok", adapter: "grok", models: [{ slug: "grok-4", name: "Grok 4", isDefault: true }] },
  { id: "opencode", name: "OpenCode", adapter: "opencode", models: [{ slug: "oc/model", name: "OC Model", isDefault: true }] }
];

// ---------------------------------------------------------------------------
// Scripted provider behaviour
// ---------------------------------------------------------------------------

export type ProviderStep =
  | { kind: "wait"; ms: number }
  /** An assistant message (the parent's unless `agentId`). */
  | { kind: "say"; text: string; messageKind?: "answer" | "commentary"; agentId?: string }
  /** A structured question; the step blocks until it is answered (or the turn is interrupted). */
  | { kind: "ask"; questions: UserInputQuestion[]; responseMode?: "message" }
  /** A tool approval; blocks until decided. */
  | { kind: "approval"; detail?: string }
  /**
   * A usage limit. Default: a `runtime.error {reason:"usage_limit"}` and the turn settles `failed`.
   * `parked`: a Claude-style `runtime.warning` and the turn stays running until interrupted.
   * `atStart`: the provider never starts — the turn fails with no turn id and the session reads `error`.
   * `legacy`: no `reason` field — only the legacy message prefix says what it is.
   */
  | { kind: "limit"; resetsAt?: string; parked?: boolean; atStart?: boolean; legacy?: boolean; message?: string }
  /** The login was refused: `runtime.error {reason:"auth"}`, turn failed, session `error`. */
  | { kind: "auth"; message?: string }
  /** An ordinary failure with no reason: turn failed, session `error` with `lastError`. */
  | { kind: "fail"; message: string }
  /** A proposed plan (the model called ExitPlanMode anyway); the turn completes with it actionable. */
  | { kind: "plan"; markdown: string }
  /** Background work that outlives the turn: liveness set while `steps` run, cleared after. */
  | { kind: "background"; liveness?: "working" | "monitoring"; steps: ProviderStep[]; forever?: boolean }
  /** Inside background work: the provider wakes the parent into a turn of its own. */
  | { kind: "wake"; steps: ProviderStep[] }
  /** Never finishes on its own. */
  | { kind: "hang" };

export interface FakeTurnInfo {
  sessionId: string;
  refId: string;
  model: string;
  /** "system" for the daemon user's own login. */
  accountId: string;
  input: string;
  /** 1-based, per session. */
  turnNumber: number;
  providerStarted: boolean;
}

export type FakeBehaviour = (turn: FakeTurnInfo) => ProviderStep[];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface Waiter {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

class Stopped extends Error {}

export interface FakeSessionState {
  id: string;
  refId: string;
  adapter: AgentAdapterId;
  title: string;
  projectPath: string;
  cwd: string;
  accountId: string;
  model: string;
  options: { id: string; value: string | boolean }[];
  runtimeMode: string;
  owner?: SessionSummary["owner"];
  createdAt: string;
  order: number;
  status: ThreadSessionStatus;
  activeTurnId: string | null;
  lastError?: string;
  items: ThreadItem[];
  turns: Turn[];
  approvals: PendingApproval[];
  userInputs: PendingUserInput[];
  backgroundLiveness: "working" | "monitoring" | null;
  backgroundCount: number;
  receipts: Map<string, { seq: number }>;
  seq: number;
  /** Bumped by every interrupt: running step loops of an older epoch stop. */
  epoch: number;
  closed: boolean;
  waiters: Map<string, Waiter>;
  /** The request body of every command this session received, in order (duplicates included). */
  commands: { name: string; body: Record<string, unknown>; deduped: boolean }[];
}

export interface FakeChatHostOptions {
  clock: FakeClock;
  agents?: FakeAgent[];
  accounts?: AgentAccount[];
  defaults?: AgentAccountsResponse["defaults"];
  /** claudex/claudemix: the ids seeded into the model proxy. */
  seeded?: string[];
  behaviour?: FakeBehaviour;
  fsRoot?: string;
  workspacesDir?: string;
}

const FAMILY: Record<string, string> = { claude: "claude", claudemix: "claude", codex: "codex", claudex: "codex", grok: "grok" };

export class FakeChatHost implements DaemonApi {
  readonly fsRoot: string;
  readonly workspacesDir: string;
  readonly clock: FakeClock;
  agents: FakeAgent[];
  accounts: AgentAccount[];
  defaults: AgentAccountsResponse["defaults"];
  seeded: Set<string>;
  behaviour: FakeBehaviour;
  readonly sessions = new Map<string, FakeSessionState>();
  /** Every turn the provider ran, in order. */
  readonly turnLog: FakeTurnInfo[] = [];
  /** Every request, in order. */
  readonly calls: { method: DaemonMethod; path: string; body?: unknown }[] = [];
  /** Account switches still to refuse (409), whatever the session's state. */
  refuseAccountSwitches = 0;
  /** Session creates still to refuse with 503 HOST_UNAVAILABLE. */
  unavailableCreates = 0;
  private listeners = new Set<{ listener: (event: EventMessage) => void }>();
  private nextSession = 0;
  private nextItem = 0;
  private nextTurn = 0;
  private nextRequest = 0;
  private nextEvent = 0;

  constructor(opts: FakeChatHostOptions) {
    this.clock = opts.clock;
    this.agents = opts.agents ?? DEFAULT_FAKE_AGENTS;
    this.accounts = opts.accounts ?? [];
    this.defaults = opts.defaults ?? { claude: null, codex: null, grok: null };
    this.seeded = new Set(opts.seeded ?? []);
    this.behaviour = opts.behaviour ?? (() => [{ kind: "say", text: "Done." }]);
    this.fsRoot = opts.fsRoot ?? "/w";
    this.workspacesDir = opts.workspacesDir ?? "/w";
  }

  // --- DaemonApi --------------------------------------------------------------

  subscribe(listener: (event: EventMessage) => void): () => void {
    const entry = { listener };
    this.listeners.add(entry);
    return () => { this.listeners.delete(entry); };
  }

  listenerCount(): number {
    return this.listeners.size;
  }

  async uploadAttachment(): Promise<{ status: number; value: unknown }> {
    return { status: 503, value: { code: "HOST_UNAVAILABLE", message: "uploads are not simulated" } };
  }

  async request(method: DaemonMethod, path: string, opts?: { query?: Record<string, string>; body?: unknown }): Promise<DaemonResponse> {
    this.calls.push({ method, path, ...(opts?.body !== undefined ? { body: structuredClone(opts.body) } : {}) });
    const body = (opts?.body ?? {}) as Record<string, unknown>;
    if (method === "GET" && path === "/api/registry") return ok(this.registry());
    if (method === "GET" && path === "/api/agent/providers") return ok(this.providers());
    if (method === "GET" && path === "/api/agent-accounts") return ok({ accounts: this.accounts, defaults: this.defaults });
    if (method === "GET" && path === "/api/cliproxy") return ok({ accounts: [...this.seeded].map((id) => ({ id })), routerProviders: [], defaultModel: null });
    if (method === "GET" && path === "/api/cliproxy/models") return ok({ models: [] });
    if (method === "GET" && path === "/api/sessions") {
      const projectPath = opts?.query?.projectPath;
      return ok([...this.sessions.values()].filter((s) => !s.closed && (!projectPath || s.projectPath === projectPath)).map((s) => this.summary(s)));
    }
    if (method === "POST" && path === "/api/sessions") return this.create(body);
    const match = /^\/api\/sessions\/([^/]+)(\/.*)?$/.exec(path);
    if (!match) return fail(404, "NOT_FOUND", `no fake route for ${method} ${path}`);
    const s = this.sessions.get(decodeURIComponent(match[1]!));
    if (!s || s.closed) return fail(404, "THREAD_NOT_FOUND", "No chat session with that id.");
    const rest = match[2] ?? "";
    if (method === "DELETE" && rest === "") return this.close(s);
    if (method === "GET" && rest === "/thread") return ok({ kind: "snapshot", thread: this.snapshot(s) });
    const item = /^\/items\/(.+)$/.exec(rest);
    if (method === "GET" && item) {
      const found = s.items.find((i) => i.id === decodeURIComponent(item[1]!));
      return found ? ok({ item: structuredClone(found) }) : fail(404, "ITEM_NOT_FOUND", "No such item.");
    }
    if (method === "POST") {
      const name = rest.slice(1);
      if (["turn", "interrupt", "answer", "approval", "dismiss", "account", "session/stop"].includes(name)) return this.command(s, name, body);
    }
    return fail(404, "NOT_FOUND", `no fake route for ${method} ${path}`);
  }

  // --- test helpers -------------------------------------------------------------

  session(id: string): FakeSessionState {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`no fake session ${id}`);
    return s;
  }

  /** The sessions a workflow block owns, in creation order. */
  sessionsOwnedBy(nodeId: string): FakeSessionState[] {
    return [...this.sessions.values()].filter((s) => s.owner?.nodeId === nodeId);
  }

  commandCount(name: string): number {
    let n = 0;
    for (const s of this.sessions.values()) n += s.commands.filter((c) => c.name === name && !c.deduped).length;
    return n;
  }

  /** Close a tab from outside (the user). */
  closeSession(id: string): void {
    this.close(this.session(id));
  }

  // --- internals ------------------------------------------------------------------

  private now(): string {
    return this.clock.now().toISOString();
  }

  private registry(): unknown {
    return {
      shells: [],
      agents: this.agents.map((a) => ({ id: a.id, name: a.name, kind: "agent", bin: [a.id], enabled: a.enabled !== false, resolvedBin: `/bin/${a.id}`, chat: { adapter: a.adapter } })),
      ides: [],
      fileExplorers: [],
      browsers: []
    };
  }

  private providers(): unknown {
    const byAdapter = new Map<string, FakeAgent>();
    for (const a of this.agents) if (!byAdapter.has(a.adapter)) byAdapter.set(a.adapter, a);
    return {
      providers: [...byAdapter.entries()].map(([adapter, a]) => ({
        id: adapter,
        installed: true,
        version: "1.0.0",
        status: "ready",
        auth: { status: "authenticated" },
        models: a.models.map((m) => ({ slug: m.slug, name: m.name, ...(m.isDefault ? { isDefault: true } : {}), capabilities: { optionDescriptors: m.options ?? [] } })),
        capabilities: {}
      }))
    };
  }

  private create(body: Record<string, unknown>): DaemonResponse {
    if (this.unavailableCreates > 0) {
      this.unavailableCreates -= 1;
      return fail(503, "HOST_UNAVAILABLE", "The agent host is restarting.");
    }
    if (body.kind !== "agent-chat") return fail(400, "INVALID_ARGUMENT", "only agent-chat sessions are simulated");
    const refId = String(body.refId ?? "");
    const agent = this.agents.find((a) => a.id === refId);
    if (!agent || agent.enabled === false) return fail(400, "INVALID_ARGUMENT", `Registry entry "${refId}" is not available.`);
    const chat = (body.chat ?? {}) as { accountId?: string; modelSelection?: { model: string; options?: { id: string; value: string | boolean }[] }; runtimeMode?: string };
    let accountId = typeof body.accountId === "string" && body.accountId ? body.accountId : "system";
    // The daemon's silent degrade: a wrong-family id launches the system login.
    if (accountId !== "system") {
      const account = this.accounts.find((a) => a.id === accountId);
      if (!account || account.agent !== FAMILY[refId]) accountId = "system";
    }
    const id = `s${++this.nextSession}`;
    const s: FakeSessionState = {
      id,
      refId,
      adapter: agent.adapter,
      title: String(body.title ?? agent.name),
      projectPath: String(body.projectPath ?? ""),
      cwd: String(body.cwd ?? body.projectPath ?? ""),
      accountId,
      model: chat.modelSelection?.model ?? agent.models[0]?.slug ?? "",
      options: chat.modelSelection?.options ?? [],
      runtimeMode: chat.runtimeMode ?? "approval-required",
      ...(body.owner ? { owner: body.owner as SessionSummary["owner"] } : {}),
      createdAt: this.now(),
      order: this.nextSession,
      status: "idle",
      activeTurnId: null,
      items: [],
      turns: [],
      approvals: [],
      userInputs: [],
      backgroundLiveness: null,
      backgroundCount: 0,
      receipts: new Map(),
      seq: 0,
      epoch: 0,
      closed: false,
      waiters: new Map(),
      commands: []
    };
    this.sessions.set(id, s);
    const summary = this.summary(s);
    this.emit("session.created", summary);
    return ok(summary);
  }

  private close(s: FakeSessionState): DaemonResponse {
    s.closed = true;
    s.epoch += 1;
    for (const w of s.waiters.values()) w.reject(new Stopped());
    s.waiters.clear();
    this.emit("session.closed", { id: s.id });
    return ok({ ok: true });
  }

  private command(s: FakeSessionState, name: string, body: Record<string, unknown>): DaemonResponse {
    const commandId = typeof body.commandId === "string" ? body.commandId : "";
    if (!commandId) return fail(400, "INVALID_COMMAND", "commandId is required.");
    const receipt = s.receipts.get(commandId);
    s.commands.push({ name, body: structuredClone(body), deduped: receipt !== undefined });
    if (receipt) return ok(receipt);
    const result = this.apply(s, name, body);
    if (result.status >= 400) return result;
    s.seq += 1;
    const r = { seq: s.seq };
    s.receipts.set(commandId, r);
    this.publish(s);
    return ok(r);
  }

  private apply(s: FakeSessionState, name: string, body: Record<string, unknown>): DaemonResponse {
    switch (name) {
      case "turn": {
        const input = String(body.input ?? "");
        if (!input.trim()) return fail(400, "INVALID_COMMAND", "input is required.");
        const running = s.turns.at(-1);
        if (running && (running.state === "running" || running.state === "pending")) {
          // A steer: the message joins the running turn.
          this.pushMessage(s, "user", input, running.turnId);
          return ok({});
        }
        this.startTurn(s, input, false);
        return ok({});
      }
      case "interrupt": {
        this.interrupt(s);
        return ok({});
      }
      case "answer": {
        const requestId = String(body.requestId ?? "");
        const req = s.userInputs.find((r) => r.requestId === requestId);
        if (!req) return fail(409, "COMMAND_REJECTED", "That request is no longer pending.");
        s.userInputs = s.userInputs.filter((r) => r !== req);
        this.pushActivity(s, "user-input.resolved", "User input submitted", { requestId, answers: body.answers }, req.turnId ?? null);
        s.waiters.get(requestId)?.resolve(body.answers);
        s.waiters.delete(requestId);
        return ok({});
      }
      case "approval": {
        const requestId = String(body.requestId ?? "");
        const req = s.approvals.find((r) => r.requestId === requestId);
        if (!req) return fail(409, "COMMAND_REJECTED", "That request is no longer pending.");
        s.approvals = s.approvals.filter((r) => r !== req);
        this.pushActivity(s, "approval.resolved", "Approval resolved", { requestId, decision: body.decision }, s.activeTurnId);
        s.waiters.get(requestId)?.resolve(body.decision);
        s.waiters.delete(requestId);
        return ok({});
      }
      case "dismiss": {
        const requestId = String(body.requestId ?? "");
        s.userInputs = s.userInputs.filter((r) => r.requestId !== requestId);
        s.waiters.get(requestId)?.resolve(null);
        s.waiters.delete(requestId);
        return ok({});
      }
      case "account": {
        const accountId = String(body.accountId ?? "");
        if (s.adapter === "opencode") return fail(400, "INVALID_COMMAND", "OpenCode threads always run under the server's own identity.");
        if (accountId !== "system") {
          const account = this.accounts.find((a) => a.id === accountId);
          if (!account || account.agent !== FAMILY[s.refId]) return fail(400, "INVALID_COMMAND", "That account cannot run this agent.");
        }
        if (this.refuseAccountSwitches > 0) {
          this.refuseAccountSwitches -= 1;
          return fail(409, "COMMAND_REJECTED", "Wait for the background work to finish before switching accounts.");
        }
        const refusal = this.switchRefusal(s);
        if (refusal) return fail(409, "COMMAND_REJECTED", refusal);
        if (accountId === s.accountId) return ok({});
        s.accountId = accountId;
        this.pushActivity(s, "thread.identity-changed", "Account switched", { accountId }, null);
        return ok({});
      }
      case "session/stop": {
        this.interrupt(s);
        s.status = "stopped";
        return ok({});
      }
      default:
        return fail(404, "NOT_FOUND", name);
    }
  }

  private switchRefusal(s: FakeSessionState): string | null {
    const last = s.turns.at(-1);
    if (s.activeTurnId !== null || s.status === "running" || s.status === "starting" || last?.state === "running" || last?.state === "pending") {
      return "Wait for the agent to finish the current turn before switching accounts.";
    }
    if (s.approvals.length + s.userInputs.length > 0) return "Answer the agent's open request before switching accounts.";
    if (s.backgroundLiveness) return "Wait for the background work to finish before switching accounts.";
    return null;
  }

  private interrupt(s: FakeSessionState): void {
    s.epoch += 1;
    const now = this.now();
    const last = s.turns.at(-1);
    if (last && (last.state === "running" || last.state === "pending")) {
      last.state = "interrupted";
      last.completedAt = now;
    }
    for (const r of s.userInputs) this.pushActivity(s, "user-input.resolved", "Question cancelled", { requestId: r.requestId, withdrawn: true }, r.turnId ?? null);
    for (const r of s.approvals) this.pushActivity(s, "approval.resolved", "Request cancelled", { requestId: r.requestId, decision: "cancel" }, s.activeTurnId);
    s.userInputs = [];
    s.approvals = [];
    for (const w of s.waiters.values()) w.reject(new Stopped());
    s.waiters.clear();
    s.backgroundLiveness = null;
    s.backgroundCount = 0;
    s.activeTurnId = null;
    if (s.status === "running" || s.status === "starting") s.status = "ready";
  }

  private startTurn(s: FakeSessionState, input: string, providerStarted: boolean, stepsOverride?: ProviderStep[]): void {
    const now = this.now();
    if (!providerStarted) this.pushMessage(s, "user", input, null);
    const turnNumber = s.turns.length + 1;
    const info: FakeTurnInfo = { sessionId: s.id, refId: s.refId, model: s.model, accountId: s.accountId, input, turnNumber, providerStarted };
    this.turnLog.push(info);
    const steps = stepsOverride ?? this.behaviour(info);
    const first = steps[0];
    if (first?.kind === "limit" && first.atStart) {
      const message = first.message ?? limitMessage(s.refId, first);
      s.turns.push({ turnId: null, state: "failed", turnCount: null, requestedAt: now, startedAt: null, completedAt: now, assistantMessageId: null, errorMessage: message });
      this.pushActivity(s, "runtime.error", message, limitPayload(message, first, "error"), null, "error");
      s.status = "error";
      s.lastError = message;
      return;
    }
    const turnId = `turn-${++this.nextTurn}`;
    // The user message joins the turn it opened.
    const lastUser = providerStarted ? undefined : [...s.items].reverse().find((i): i is ThreadMessageItem => i.kind === "message" && i.role === "user");
    if (lastUser && lastUser.turnId === null) lastUser.turnId = turnId;
    s.turns.push({ turnId, state: "running", turnCount: turnNumber, requestedAt: now, startedAt: now, completedAt: null, assistantMessageId: null, ...(lastUser ? { userMessageId: lastUser.id } : {}) });
    s.activeTurnId = turnId;
    s.status = "running";
    s.lastError = undefined;
    void this.runTurn(s, turnId, steps, s.epoch);
  }

  private async runTurn(s: FakeSessionState, turnId: string, steps: ProviderStep[], epoch: number): Promise<void> {
    const turn = s.turns.find((t) => t.turnId === turnId)!;
    let outcome: "completed" | "failed" | "stopped";
    try {
      outcome = await this.runSteps(s, steps, turnId, epoch);
    } catch (error) {
      if (error instanceof Stopped) return;
      throw error;
    }
    if (outcome !== "completed" || s.epoch !== epoch || s.closed) return;
    if (turn.state !== "running") return;
    turn.state = "completed";
    turn.completedAt = this.now();
    s.activeTurnId = null;
    s.status = "ready";
    this.publish(s);
  }

  private async runSteps(s: FakeSessionState, steps: ProviderStep[], turnId: string | null, epoch: number): Promise<"completed" | "failed" | "stopped"> {
    for (const step of steps) {
      if (s.epoch !== epoch || s.closed) return "stopped";
      switch (step.kind) {
        case "wait":
          await this.clock.sleep(step.ms);
          break;
        case "say":
          this.pushMessage(s, "assistant", step.text, turnId, step.agentId, step.messageKind);
          this.publish(s);
          break;
        case "ask": {
          const requestId = `q${++this.nextRequest}`;
          s.userInputs.push({
            requestId,
            createdAt: this.now(),
            questions: step.questions,
            ...(step.responseMode ? { responseMode: step.responseMode } : {}),
            dismissible: step.responseMode === "message",
            turnId
          });
          this.pushActivity(s, "user-input.requested", "Question", { requestId, questions: step.questions }, turnId);
          this.publish(s);
          await this.await(s, requestId);
          break;
        }
        case "approval": {
          const requestId = `a${++this.nextRequest}`;
          s.approvals.push({ requestId, requestKind: "command", createdAt: this.now(), ...(step.detail ? { detail: step.detail } : {}) });
          this.pushActivity(s, "approval.requested", "Approval requested", { requestId }, turnId, "approval");
          this.publish(s);
          await this.await(s, requestId);
          break;
        }
        case "limit": {
          const message = step.message ?? limitMessage(s.refId, step);
          if (step.parked) {
            this.pushActivity(s, "runtime.warning", message, limitPayload(message, step, "warning"), turnId, "info");
            this.publish(s);
            await new Promise(() => undefined); // parked until interrupted (the epoch moves; this never resolves)
            return "stopped";
          }
          this.pushActivity(s, "runtime.error", message, limitPayload(message, step, "error"), turnId, "error");
          this.failTurn(s, turnId, message, false);
          return "failed";
        }
        case "auth": {
          const message = step.message ?? "Claude is not logged in. Run /login.";
          this.pushActivity(s, "runtime.error", message, { message, class: "provider_error", reason: "auth" }, turnId, "error");
          this.failTurn(s, turnId, message, true);
          return "failed";
        }
        case "fail": {
          this.pushActivity(s, "runtime.error", step.message, { message: step.message, class: "provider_error" }, turnId, "error");
          this.failTurn(s, turnId, step.message, true);
          return "failed";
        }
        case "plan":
          this.pushActivity(s, "turn.proposed.completed", "Proposed plan", { planMarkdown: step.markdown }, turnId);
          this.publish(s);
          break;
        case "background":
          void this.runBackground(s, step, epoch);
          break;
        case "wake":
          this.startTurn(s, "", true, step.steps);
          break;
        case "hang":
          await new Promise(() => undefined);
          return "stopped";
      }
    }
    return "completed";
  }

  private async runBackground(s: FakeSessionState, step: Extract<ProviderStep, { kind: "background" }>, epoch: number): Promise<void> {
    s.backgroundCount += 1;
    s.backgroundLiveness = step.liveness ?? "working";
    this.publish(s);
    let outcome: "completed" | "stopped" | "woke";
    try {
      outcome = await this.runBackgroundSteps(s, step.steps, epoch);
    } catch (error) {
      if (error instanceof Stopped) return;
      throw error;
    }
    if (outcome === "completed" && !step.forever && s.epoch === epoch && !s.closed) this.endBackground(s);
  }

  private endBackground(s: FakeSessionState): void {
    s.backgroundCount = Math.max(0, s.backgroundCount - 1);
    if (s.backgroundCount === 0) s.backgroundLiveness = null;
    this.publish(s);
  }

  /** Background steps: a limit here is an error row with no turn to fail; `wake` ends the work and wakes the parent. */
  private async runBackgroundSteps(s: FakeSessionState, steps: ProviderStep[], epoch: number): Promise<"completed" | "stopped" | "woke"> {
    for (const step of steps) {
      if (s.epoch !== epoch || s.closed) return "stopped";
      if (step.kind === "wait") {
        await this.clock.sleep(step.ms);
      } else if (step.kind === "say") {
        this.pushMessage(s, "assistant", step.text, null, step.agentId ?? "bg-agent", step.messageKind);
        this.publish(s);
      } else if (step.kind === "limit") {
        const message = step.message ?? limitMessage(s.refId, step);
        this.pushActivity(s, "runtime.error", message, limitPayload(message, step, "error"), null, "error", "bg-agent");
        this.publish(s);
        await new Promise(() => undefined); // the background agent is stuck until interrupted
        return "stopped";
      } else if (step.kind === "wake") {
        this.endBackground(s);
        this.startTurn(s, "", true, step.steps);
        this.publish(s);
        return "woke";
      } else if (step.kind === "hang") {
        await new Promise(() => undefined);
        return "stopped";
      }
    }
    if (s.epoch !== epoch || s.closed) return "stopped";
    return "completed";
  }

  private async await(s: FakeSessionState, requestId: string): Promise<unknown> {
    return new Promise((resolve, reject) => { s.waiters.set(requestId, { resolve, reject }); });
  }

  private failTurn(s: FakeSessionState, turnId: string | null, message: string, sessionError: boolean): void {
    const now = this.now();
    const turn = s.turns.find((t) => t.turnId === turnId);
    if (turn && (turn.state === "running" || turn.state === "pending")) {
      turn.state = "failed";
      turn.completedAt = now;
      turn.errorMessage = message;
    }
    s.activeTurnId = null;
    s.status = sessionError ? "error" : "ready";
    if (sessionError) s.lastError = message;
    this.publish(s);
  }

  private pushMessage(s: FakeSessionState, role: ThreadMessageItem["role"], text: string, turnId: string | null, agentId?: string, messageKind?: "answer" | "commentary"): void {
    const now = this.now();
    s.items.push({
      kind: "message",
      id: `m${++this.nextItem}`,
      role,
      text,
      turnId,
      ...(agentId ? { agentId } : {}),
      ...(messageKind ? { messageKind } : {}),
      streaming: false,
      createdAt: now,
      updatedAt: now
    });
  }

  private pushActivity(s: FakeSessionState, activityKind: string, summary: string, payload: unknown, turnId: string | null, tone: ThreadActivityItem["tone"] = "info", agentId?: string): void {
    const now = this.now();
    s.items.push({ kind: "activity", id: `i${++this.nextItem}`, tone, activityKind, summary, payload, turnId, ...(agentId ? { agentId } : {}), createdAt: now, updatedAt: now });
  }

  private hasActionablePlan(s: FakeSessionState): boolean {
    for (let i = s.items.length - 1; i >= 0; i -= 1) {
      const item = s.items[i]!;
      if (item.kind === "message" && item.role === "user" && isPlanImplementationMessage(item.text)) return false;
      if (item.kind === "activity" && item.activityKind === "turn.proposed.completed") return true;
    }
    return false;
  }

  summary(s: FakeSessionState): SessionSummary {
    const last = s.turns.at(-1);
    return {
      id: s.id,
      kind: "agent-chat",
      refId: s.refId,
      ...(s.accountId !== "system" ? { accountId: s.accountId } : {}),
      title: s.title,
      projectPath: s.projectPath,
      cwd: s.cwd,
      cols: 0,
      rows: 0,
      status: s.closed ? "exited" : "running",
      order: s.order,
      createdAt: s.createdAt,
      ...(s.owner ? { owner: s.owner } : {}),
      activity: { state: s.status === "running" ? "working" : "idle", attention: null, lastOutputAt: null, needsAttentionAt: null },
      hasPendingApprovals: s.approvals.length > 0,
      hasPendingUserInput: s.userInputs.length > 0,
      hasActionableProposedPlan: this.hasActionablePlan(s),
      backgroundLiveness: s.backgroundLiveness,
      latestTurn: last ? { turnId: last.turnId, state: last.state, startedAt: last.startedAt, completedAt: last.completedAt } : null,
      chatSessionStatus: s.status,
      goal: null
    };
  }

  snapshot(s: FakeSessionState): ThreadSnapshotPayload {
    const now = this.now();
    return structuredClone({
      head: {
        id: s.id,
        projectPath: s.projectPath,
        cwd: s.cwd,
        title: s.title,
        adapter: s.adapter,
        refId: s.refId,
        accountId: s.accountId === "system" ? "" : s.accountId,
        home: s.accountId === "system" ? "system" : "account",
        modelSelection: { model: s.model, options: s.options },
        runtimeMode: s.runtimeMode as ThreadSnapshotPayload["head"]["runtimeMode"],
        session: { status: s.status, activeTurnId: s.activeTurnId, ...(s.lastError ? { lastError: s.lastError } : {}) },
        turnCount: s.turns.length,
        seq: s.seq,
        createdAt: s.createdAt,
        updatedAt: now
      },
      items: s.items,
      turns: s.turns,
      checkpoints: [],
      pending: { approvals: s.approvals, userInputs: s.userInputs },
      roster: [],
      seq: s.seq
    });
  }

  private publish(s: FakeSessionState): void {
    if (s.closed) return;
    this.emit("session.updated", this.summary(s));
  }

  private emit(type: string, payload: unknown): void {
    const event: EventMessage = { id: `e${++this.nextEvent}`, channel: "sessions", type, createdAt: this.now(), payload };
    for (const entry of [...this.listeners]) {
      try { entry.listener(event); } catch { /* the Broadcaster drops nothing for a throwing sink here */ }
    }
  }
}

function ok(body: unknown): DaemonResponse {
  return { status: 200, body };
}

function fail(status: number, code: string, message: string): DaemonResponse {
  return { status, body: { error: { code, message } } };
}

function limitMessage(refId: string, step: { resetsAt?: string }): string {
  const who = refId.startsWith("grok") ? "Grok" : refId.startsWith("codex") || refId === "claudex" ? "Codex" : refId === "opencode" ? "OpenCode" : "Claude";
  return `${who} usage limit reached.${step.resetsAt ? ` Resets at ${step.resetsAt}.` : ""}`;
}

function limitPayload(message: string, step: { resetsAt?: string; legacy?: boolean }, kind: "error" | "warning"): Record<string, unknown> {
  if (step.legacy) return kind === "error" ? { message, class: "provider_error" } : { message };
  return {
    message,
    ...(kind === "error" ? { class: "provider_error" } : {}),
    reason: "usage_limit",
    ...(step.resetsAt ? { resetsAt: step.resetsAt } : {})
  };
}

/** Behaviour helper: pick steps by the account a turn runs on (else `fallback`). */
export function byAccount(map: Record<string, ProviderStep[] | ((turn: FakeTurnInfo) => ProviderStep[])>, fallback: ProviderStep[] = [{ kind: "say", text: "Done." }]): FakeBehaviour {
  return (turn) => {
    const hit = map[`${turn.refId}:${turn.accountId}`] ?? map[turn.accountId] ?? map[turn.refId];
    if (!hit) return fallback;
    return typeof hit === "function" ? hit(turn) : hit;
  };
}
