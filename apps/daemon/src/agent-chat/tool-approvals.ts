/**
 * Agent chat — Orquester approval cards (unified MCP design 2026-10-15 §7): the registry of
 * pending cards and their routes. Modelled on `secret-requests.ts`.
 *
 * A chat agent's Admin call, a call across a project boundary its permission mode does not cover,
 * and `request_toolset` each open a CARD (`admin` | `boundary` | `toolset`) in the chat. The call
 * waits here — for the user's answer on the card route, the card's deadline
 * (`ADMIN_APPROVAL_TIMEOUT_MS`, injected clock), or its `signal` (tool-call abort, Stop, the
 * session ending, the host's connection dropping) — and nothing else ever settles it: never
 * `respond_to_request`, never a provider request route.
 *
 * - **Memory only.** Pending cards and the secrets an answer carries live in this process. A
 *   small journal (ids only — no title, preview, argument or value) records which cards are open,
 *   so a daemon that died with cards pending resolves each one as `cancelled` at its next boot
 *   ({@link ToolApprovalRegistry.recover}): one log line and a `closed` event per card. A card is
 *   never approved by anything but an answer.
 * - **Secrets** typed into a card go from the answer body to the waiting call, once, and are never
 *   stored, logged, broadcast or returned.
 * - **Text safety.** Every string of a card is sanitised before anyone sees it
 *   (`parseToolApprovalSummary`: labels single-line with bidi/control/zero-width characters
 *   stripped, prose stripped, code and diffs with visible escapes).
 * - **One log line per decision**: thread, tool, kind, family, outcome (+ the grant scope) — never
 *   arguments, previews or values.
 *
 * Routes (both transports; remote HTTP's bearer hook guards them like every chat route):
 * `GET agentChatRoutes.toolApprovals(id)`, `GET`/`POST agentChatRoutes.toolApproval(id, aid)`.
 * Only a person answers: a request carrying an agent or external principal is refused 403.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  ADMIN_APPROVAL_TIMEOUT_MS,
  agentChatRoutes,
  approvalPreviewBytes,
  parseToolApprovalSummary,
  summarizeApprovalPreview,
  MAX_PENDING_TOOL_APPROVALS_PER_THREAD,
  TOOL_APPROVAL_EVENT_TYPE,
  TOOL_APPROVAL_FULL_PREVIEW_MAX_BYTES,
  TOOL_APPROVAL_LIMIT,
  TOOL_APPROVAL_REASON_MAX_CHARS,
  validateToolApprovalAnswer,
  type AgentChatToolApprovalEventPayload,
  type ApprovalFamily,
  type ApprovalKind,
  type ApprovalPreviewSection,
  type CallerPrincipal,
  type ToolApprovalAnswer,
  type ToolApprovalAnswerResponse,
  type ToolApprovalDetailResponse,
  type ToolApprovalErrorCode,
  type ToolApprovalGrantScope,
  type ToolApprovalListResponse,
  type ToolApprovalOutcome,
  type ToolApprovalScopeProject,
  type ToolApprovalSummary
} from "@orquester/api/agent-chat";

import { writeFileAtomic } from "../agent-hooks.ts";
import { ToolError } from "../mcp/errors.ts";
import type { ApprovalOutcome } from "../mcp/catalog/contract.ts";

// ---------------------------------------------------------------------------
// Inputs and hooks
// ---------------------------------------------------------------------------

/** A card to open. Strings may be agent-derived: the registry sanitises every one. */
export interface ToolApprovalOpenInput {
  threadId: string;
  tool: string;
  kind: ApprovalKind;
  family: ApprovalFamily;
  title: string;
  scope: { label: string; projects?: ToolApprovalScopeProject[] };
  reason?: string;
  /** The WHOLE preview; the summary the bus and list carry is cut from it. */
  sections: ApprovalPreviewSection[];
  secretFields: { key: string; label: string }[];
  grantOptions: ToolApprovalGrantScope[];
}

/** A refusal of one answer, before the card settles (the card stays pending). */
export class ToolApprovalAnswerRefusal extends Error {
  constructor(
    readonly code: ToolApprovalErrorCode,
    message: string,
    /** The HTTP status (default: 409 for `APPROVAL_NOT_PENDING`, 503 for `AGENT_TOOLS_UNAVAILABLE`, else 400). */
    readonly status?: number
  ) {
    super(message);
    this.name = "ToolApprovalAnswerRefusal";
  }
}

const READ_ONLY_MESSAGE =
  "Agent tool settings are read-only until agent-tools.json is fixed and Orquester restarts, so this approval cannot be saved. Approve without a grant, or deny.";

/** A read-only store's refusal (the store throws `AgentToolsError` with status 503). */
function isUnavailable(error: unknown): boolean {
  return (error as { status?: unknown; code?: unknown })?.status === 503 || (error as { code?: unknown })?.code === "AGENT_TOOLS_UNAVAILABLE";
}

/** What the opener does around an answer (the approval port: grants, toolset overrides, declines). */
export interface ToolApprovalHooks {
  /** Resolves true once the call's result reached the host; false when dropped (→ `not_delivered`). */
  delivered?: Promise<boolean>;
  /**
   * Async checks on an approval before it takes effect (e.g. the caller is still `full-access` for
   * a grant). Throw {@link ToolApprovalAnswerRefusal} to refuse the answer; the card stays pending.
   */
  prepareApproval?(answer: ToolApprovalAnswer): Promise<void>;
  /**
   * The approval's side effects, synchronous and run only once the card is known to be settling
   * (a grant recorded, a toolset turned on). Returns the grant the answer created, if any.
   */
  commitApproval?(answer: ToolApprovalAnswer): { grantId?: string };
  /** A denial's side effects (a toolset decline). */
  onDenied?(answer: ToolApprovalAnswer): void;
}

/** The registry's timer source: injected so tests drive the deadline without sleeping. */
export interface ToolApprovalClock {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export const SYSTEM_APPROVAL_CLOCK: ToolApprovalClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

export interface ToolApprovalRegistryOptions {
  /** Publish one bus event (`sessions` channel, {@link TOOL_APPROVAL_EVENT_TYPE}). Never carries a value. */
  publish(payload: AgentChatToolApprovalEventPayload): void;
  /** A thread's pending set changed (its attention and push follow). */
  onChange?(threadId: string): void;
  /** One line per decision (default `console.log`). Never arguments, previews or values. */
  log?(line: string): void;
  clock?: ToolApprovalClock;
  timeoutMs?: number;
  newId?: () => string;
  /**
   * Where the ids of open cards are journaled so a crash resolves them as `cancelled` at the next
   * boot. Absent: no journal (tests).
   */
  journalFile?: string;
  logger?: { warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };
}

interface Pending {
  readonly summary: ToolApprovalSummary;
  /** The whole sanitised preview. */
  readonly sections: ApprovalPreviewSection[];
  readonly hooks: ToolApprovalHooks;
  /** An answer is being prepared: a second answer is 409, the deadline and signal still win. */
  answering: boolean;
  settle(outcome: ApprovalOutcome, logExtra?: string): boolean;
}

/** How long a closed card's id is remembered so a late answer reads 409, not 404. */
const CLOSED_MEMORY_MS = 2 * 60 * 60 * 1000;
const CLOSED_MEMORY_MAX = 2_000;

/** A journal line: ids and kinds only. */
interface JournalEntry {
  approvalId: string;
  threadId: string;
  tool: string;
  kind: string;
  family: string;
  requestedAt: string;
}

export type ToolApprovalAnswerResult =
  | { ok: true; response: ToolApprovalAnswerResponse }
  | { ok: false; status: number; code: ToolApprovalErrorCode; message: string };

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export class ToolApprovalRegistry {
  private readonly pending = new Map<string, Pending>();
  /** approvalId → {threadId, closedAt}: answered, expired or cancelled cards (bounded). */
  private readonly closed = new Map<string, { threadId: string; closedAt: number }>();
  private readonly clock: ToolApprovalClock;
  private journalWrites: Promise<void> = Promise.resolve();

  constructor(private readonly opts: ToolApprovalRegistryOptions) {
    this.clock = opts.clock ?? SYSTEM_APPROVAL_CLOCK;
  }

  /**
   * Open a card and wait for its answer, the deadline, or `signal`. Rejects only when the card
   * cannot be shown at all (a preview over the 1 MiB cap → `PREVIEW_TOO_LARGE`; an unreadable
   * card). The approved outcome carries the card's secret values for the one waiting call.
   */
  open(input: ToolApprovalOpenInput, signal: AbortSignal, hooks: ToolApprovalHooks = {}): Promise<ApprovalOutcome> {
    const approvalId = (this.opts.newId ?? (() => `ta_${randomUUID()}`))();
    if (signal.aborted) {
      this.decisionLog(input, approvalId, "cancelled", "before the card opened");
      return Promise.resolve({ outcome: "cancelled", approvalId, reason: "aborted" });
    }
    if (this.list(input.threadId).length >= MAX_PENDING_TOOL_APPROVALS_PER_THREAD) {
      return Promise.reject(
        new ToolError(
          TOOL_APPROVAL_LIMIT,
          `${MAX_PENDING_TOOL_APPROVALS_PER_THREAD} approval cards are already waiting for the user in this chat; wait for them to be answered, and batch related changes into one call.`
        )
      );
    }
    if (approvalPreviewBytes(input.sections) > TOOL_APPROVAL_FULL_PREVIEW_MAX_BYTES) {
      return Promise.reject(new ToolError("PREVIEW_TOO_LARGE", "This change's preview is over 1 MiB: split the change into smaller calls."));
    }
    const nowMs = this.clock.now();
    const timeoutMs = this.opts.timeoutMs ?? ADMIN_APPROVAL_TIMEOUT_MS;
    const full = parseToolApprovalSummary({
      approvalId,
      threadId: input.threadId,
      tool: input.tool,
      kind: input.kind,
      family: input.family,
      title: input.title,
      scope: input.scope,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      sections: input.sections,
      fullPreview: false,
      secretFields: input.secretFields,
      grantOptions: input.grantOptions,
      requestedAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + timeoutMs).toISOString()
    });
    if (full === null || full.kind === "unknown" || full.family === "unknown") {
      return Promise.reject(new ToolError("INVALID_ARGUMENT", "The approval card could not be composed."));
    }
    const { sections, fullPreview } = summarizeApprovalPreview(full.sections);
    const summary: ToolApprovalSummary = {
      ...full,
      kind: full.kind,
      family: full.family,
      ...(full.reason !== undefined ? { reason: full.reason.slice(0, TOOL_APPROVAL_REASON_MAX_CHARS) } : {}),
      sections,
      fullPreview
    };
    const fullSections = full.sections;

    return new Promise<ApprovalOutcome>((resolve) => {
      let settled = false;
      let timer: unknown;
      const onAbort = (): void => {
        entry.settle({ outcome: "cancelled", approvalId, reason: "aborted" }, "the call was cancelled");
      };
      const entry: Pending = {
        summary,
        sections: fullSections,
        hooks,
        answering: false,
        settle: (outcome, logExtra) => {
          if (settled) return false;
          settled = true;
          this.clock.clearTimer(timer);
          signal.removeEventListener("abort", onAbort);
          this.pending.delete(approvalId);
          this.remember(approvalId, summary.threadId);
          this.publish({ threadId: summary.threadId, closed: { approvalId, outcome: outcome.outcome as ToolApprovalOutcome } });
          this.decisionLog(summary, approvalId, outcome.outcome, logExtra);
          this.changed(summary.threadId);
          this.journal();
          // The secrets (on an approval) leave here, once, into the call that waits.
          resolve(outcome);
          if (outcome.outcome === "approved") this.watchDelivery(summary, approvalId, hooks.delivered);
          return true;
        }
      };
      this.pending.set(approvalId, entry);
      timer = this.clock.setTimer(() => {
        entry.settle({ outcome: "timed_out", approvalId });
      }, timeoutMs);
      signal.addEventListener("abort", onAbort, { once: true });
      this.publish({ threadId: summary.threadId, opened: summary });
      this.changed(summary.threadId);
      this.journal();
    });
  }

  /** The thread's pending cards (summaries), oldest first. */
  list(threadId: string): ToolApprovalSummary[] {
    return [...this.pending.values()]
      .map((entry) => entry.summary)
      .filter((summary) => summary.threadId === threadId)
      .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt) || a.approvalId.localeCompare(b.approvalId));
  }

  /** One pending card with its WHOLE preview, or null. */
  detail(threadId: string, approvalId: string): ToolApprovalSummary | null {
    const entry = this.pending.get(approvalId);
    if (!entry || entry.summary.threadId !== threadId) return null;
    return { ...entry.summary, sections: entry.sections, fullPreview: false };
  }

  /** The thread's pending cards as the attention summary needs them: id and title. */
  pendingTitles(threadId: string): { approvalId: string; title: string }[] {
    return this.list(threadId).map((summary) => ({ approvalId: summary.approvalId, title: summary.title }));
  }

  /** Whether a card is still pending. */
  isPending(approvalId: string): boolean {
    return this.pending.has(approvalId);
  }

  /**
   * Answer one card: validated against the card (`grant ∈ grantOptions`, every secret field, the
   * reason sanitised). 404 when the card is unknown (never existed, or dropped by a restart); 409
   * `APPROVAL_NOT_PENDING` when it already ended or another answer is being applied; 400 for a
   * malformed answer. Never echoes a value.
   */
  async answer(threadId: string, approvalId: string, body: unknown): Promise<ToolApprovalAnswerResult> {
    const entry = this.pending.get(approvalId);
    if (!entry || entry.summary.threadId !== threadId) {
      const closed = this.closed.get(approvalId);
      if (closed && closed.threadId === threadId) {
        return { ok: false, status: 409, code: "APPROVAL_NOT_PENDING", message: "This card is no longer pending: it was answered, it expired, or the agent stopped waiting." };
      }
      return { ok: false, status: 404, code: "APPROVAL_NOT_FOUND", message: "No such approval card (it may have ended when Orquester restarted)." };
    }
    if (entry.answering) {
      return { ok: false, status: 409, code: "APPROVAL_NOT_PENDING", message: "Another answer to this card is being applied." };
    }
    const check = validateToolApprovalAnswer(body, entry.summary);
    if (!check.ok) return { ok: false, status: 400, code: "INVALID_ARGUMENT", message: check.message };
    const answer = check.answer;
    if (answer.decision === "deny") {
      if (!entry.settle({ outcome: "denied", approvalId, ...(answer.reason ? { reason: answer.reason } : {}) })) {
        return notPending();
      }
      try {
        entry.hooks.onDenied?.(answer);
      } catch (error) {
        this.opts.logger?.error?.("tool-approvals: a denial's follow-up failed", errorName(error));
      }
      return { ok: true, response: { ok: true, outcome: "denied" } };
    }
    entry.answering = true;
    try {
      await entry.hooks.prepareApproval?.(answer);
    } catch (error) {
      entry.answering = false;
      if (error instanceof ToolApprovalAnswerRefusal) {
        const status = error.status ?? (error.code === "APPROVAL_NOT_PENDING" ? 409 : error.code === "AGENT_TOOLS_UNAVAILABLE" ? 503 : 400);
        return { ok: false, status, code: error.code, message: error.message };
      }
      if (isUnavailable(error)) return { ok: false, status: 503, code: "AGENT_TOOLS_UNAVAILABLE", message: READ_ONLY_MESSAGE };
      this.opts.logger?.error?.("tool-approvals: preparing an approval failed", errorName(error));
      return { ok: false, status: 400, code: "INVALID_ARGUMENT", message: "The approval could not be applied; try again." };
    }
    // The deadline or the signal may have won while the answer was prepared.
    if (!this.pending.has(approvalId)) return notPending();
    let grantId: string | undefined;
    try {
      grantId = entry.hooks.commitApproval?.(answer).grantId;
    } catch (error) {
      entry.answering = false;
      if (isUnavailable(error)) return { ok: false, status: 503, code: "AGENT_TOOLS_UNAVAILABLE", message: READ_ONLY_MESSAGE };
      this.opts.logger?.error?.("tool-approvals: applying an approval failed", errorName(error));
      return { ok: false, status: 400, code: "INVALID_ARGUMENT", message: "The approval could not be applied; try again." };
    }
    const outcome: ApprovalOutcome = {
      outcome: "approved",
      approvalId,
      ...(grantId !== undefined ? { grantId } : {}),
      ...(answer.secrets !== undefined ? { secrets: answer.secrets } : {})
    };
    entry.settle(outcome, answer.grant !== undefined ? `grant=${answer.grant}` : undefined);
    return { ok: true, response: { ok: true, outcome: "approved", ...(grantId !== undefined ? { grantId } : {}) } };
  }

  /** End every pending card of a thread (its tab closed): `cancelled`. */
  cancelThread(threadId: string): void {
    for (const entry of [...this.pending.values()]) {
      if (entry.summary.threadId === threadId) entry.settle({ outcome: "cancelled", approvalId: entry.summary.approvalId, reason: "closed" }, "chat closed");
    }
  }

  /** End every pending card (daemon shutdown): `cancelled`, then flush the journal. */
  async shutdown(): Promise<void> {
    for (const entry of [...this.pending.values()]) {
      entry.settle({ outcome: "cancelled", approvalId: entry.summary.approvalId, reason: "restarting" }, "Orquester is restarting");
    }
    await this.journalWrites;
  }

  /**
   * Boot: every card the journal says was open when the daemon last stopped is resolved as
   * `cancelled` — a `closed` event and a log line each — and the journal is cleared. An answer to
   * one is then 404 (the card is gone), never an approval. Never throws.
   */
  async recover(): Promise<void> {
    const file = this.opts.journalFile;
    if (!file) return;
    let entries: JournalEntry[] = [];
    try {
      const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
      const list = raw !== null && typeof raw === "object" && Array.isArray((raw as { open?: unknown }).open) ? (raw as { open: unknown[] }).open : [];
      entries = list.filter(isJournalEntry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        this.opts.logger?.warn?.("tool-approvals: the open-card journal could not be read; starting with none", errorName(error));
      }
    }
    for (const entry of entries) {
      if (this.pending.has(entry.approvalId)) continue;
      // Not remembered: an answer to it is 404 like any card a restart dropped (spec §13).
      this.publish({ threadId: entry.threadId, closed: { approvalId: entry.approvalId, outcome: "cancelled" } });
      this.decisionLog(entry, entry.approvalId, "cancelled", "Orquester restarted");
    }
    this.journal();
    await this.journalWrites;
  }

  // -------------------------------------------------------------------------

  private watchDelivery(summary: ToolApprovalSummary, approvalId: string, delivered: Promise<boolean> | undefined): void {
    if (!delivered) return;
    void delivered.then(
      (ok) => {
        if (!ok) this.notDelivered(summary, approvalId);
      },
      () => this.notDelivered(summary, approvalId)
    );
  }

  private notDelivered(summary: ToolApprovalSummary, approvalId: string): void {
    this.publish({ threadId: summary.threadId, closed: { approvalId, outcome: "not_delivered" } });
    this.decisionLog(summary, approvalId, "not_delivered", "the call's result never reached the agent");
  }

  private remember(approvalId: string, threadId: string): void {
    const now = this.clock.now();
    this.closed.set(approvalId, { threadId, closedAt: now });
    for (const [id, closed] of this.closed) {
      if (this.closed.size <= CLOSED_MEMORY_MAX && now - closed.closedAt < CLOSED_MEMORY_MS) break;
      this.closed.delete(id);
    }
  }

  private decisionLog(card: { threadId: string; tool: string; kind: string; family: string }, approvalId: string, outcome: string, extra?: string): void {
    const line = `[tool-approvals] thread=${card.threadId} approval=${approvalId} tool=${card.tool} kind=${card.kind} family=${card.family} outcome=${outcome}${extra ? ` (${extra})` : ""}`;
    try {
      (this.opts.log ?? console.log)(line);
    } catch {
      // Logging must never strand the waiting call.
    }
  }

  private changed(threadId: string): void {
    try {
      this.opts.onChange?.(threadId);
    } catch {
      // The attention state is a view; it must never strand the waiting call.
    }
  }

  private publish(payload: AgentChatToolApprovalEventPayload): void {
    try {
      this.opts.publish(payload);
    } catch {
      // A bus failure must never strand the waiting call.
    }
  }

  /** Rewrite the journal with the cards open NOW (serialized; each write reads the state when it runs). */
  private journal(): void {
    const file = this.opts.journalFile;
    if (!file) return;
    const write = async (): Promise<void> => {
      const open: JournalEntry[] = [...this.pending.values()].map(({ summary }) => ({
        approvalId: summary.approvalId,
        threadId: summary.threadId,
        tool: summary.tool,
        kind: summary.kind,
        family: summary.family,
        requestedAt: summary.requestedAt
      }));
      try {
        await writeFileAtomic(file, `${JSON.stringify({ version: 1, open }, null, 2)}\n`, 0o600);
      } catch (error) {
        this.opts.logger?.error?.("tool-approvals: the open-card journal could not be written", errorName(error));
      }
    };
    this.journalWrites = this.journalWrites.then(write, write);
  }
}

function notPending(): ToolApprovalAnswerResult {
  return { ok: false, status: 409, code: "APPROVAL_NOT_PENDING", message: "This card is no longer pending: the agent stopped waiting." };
}

function isJournalEntry(value: unknown): value is JournalEntry {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return ["approvalId", "threadId", "tool", "kind", "family", "requestedAt"].every((key) => typeof v[key] === "string" && (v[key] as string).length <= 512);
}

/** An error's name and code only: messages can quote values. */
function errorName(error: unknown): string {
  if (error instanceof Error) return `${error.name}${(error as { code?: unknown }).code ? ` ${String((error as { code?: unknown }).code)}` : ""}`;
  return typeof error;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** An answer carries a decision, a reason and up to a few secret values: anything bigger is refused unread. */
const ANSWER_BODY_LIMIT = 256 * 1024;

/** The shared builder's path with its percent-encoded `:param` placeholders decoded (as `proxy-routes.ts`). */
function pattern(path: string): string {
  return decodeURIComponent(path);
}

/** The request's server-stamped principal (Task 2's `onRequest` hook); none = the user. */
export function requestPrincipal(request: FastifyRequest): CallerPrincipal {
  const principal = (request as FastifyRequest & { principal?: CallerPrincipal }).principal;
  return principal ?? { kind: "user" };
}

function refusal(code: ToolApprovalErrorCode, message: string): { error: { code: ToolApprovalErrorCode; message: string } } {
  return { error: { code, message } };
}

export interface ToolApprovalRouteDeps {
  registry: ToolApprovalRegistry;
  /** True when `id` is a chat session this daemon knows. */
  isChatSession(id: string): boolean;
}

/**
 * `GET /api/sessions/:id/tool-approvals`, `GET`/`POST …/:approvalId`, on both transports. Answers
 * only from a person: an agent or external principal is refused 403 `PERMISSION_DENIED`.
 */
export function registerToolApprovalRoutes(app: FastifyInstance, deps: ToolApprovalRouteDeps): void {
  app.get<{ Params: { id: string } }>(pattern(agentChatRoutes.toolApprovals(":id")), async (request, reply) => {
    const { id } = request.params;
    if (!deps.isChatSession(id)) return reply.code(404).send(refusal("THREAD_NOT_FOUND", "No chat session with that id."));
    const response: ToolApprovalListResponse = { approvals: deps.registry.list(id) };
    return response;
  });

  app.get<{ Params: { id: string; approvalId: string } }>(pattern(agentChatRoutes.toolApproval(":id", ":approvalId")), async (request, reply) => {
    const { id, approvalId } = request.params;
    if (!deps.isChatSession(id)) return reply.code(404).send(refusal("THREAD_NOT_FOUND", "No chat session with that id."));
    const approval = deps.registry.detail(id, approvalId);
    if (!approval) return reply.code(404).send(refusal("APPROVAL_NOT_FOUND", "No such pending approval card."));
    const response: ToolApprovalDetailResponse = { approval };
    return response;
  });

  app.post<{ Params: { id: string; approvalId: string } }>(
    pattern(agentChatRoutes.toolApproval(":id", ":approvalId")),
    { bodyLimit: ANSWER_BODY_LIMIT },
    async (request, reply) => {
      const { id, approvalId } = request.params;
      if (requestPrincipal(request).kind !== "user") {
        return reply.code(403).send(refusal("PERMISSION_DENIED", "Only a person answers approval cards, on the card itself."));
      }
      if (!deps.isChatSession(id)) return reply.code(404).send(refusal("THREAD_NOT_FOUND", "No chat session with that id."));
      const result = await deps.registry.answer(id, approvalId, request.body);
      if (!result.ok) return reply.code(result.status).send(refusal(result.code, result.message));
      return result.response;
    }
  );
}
