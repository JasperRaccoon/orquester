/**
 * Agent chat — the secrets agents ask the user for (`request_secret`, design
 * `2026-10-14-agent-visuals-and-session-tools-design.md` §5 "Secrets").
 *
 * Adapted from T3 Code (MIT): `apps/server/src/secrets/SecretRequests.ts` and
 * the `requestSecret` wait in `apps/server/src/mcp/OrchestratorMcpService.ts`.
 * Unlike T3 (which keeps the value in its secret store under a one-use
 * reference), nothing here is ever written anywhere: a request lives in this
 * process's memory while its tool call waits, and the value the user types
 * goes from the answer route straight to that waiting call — then nothing
 * here holds it. A daemon restart loses every pending request; the waiting
 * call then answers "Orquester is restarting" and the agent can ask again.
 *
 * The routes are daemon-owned (never proxied to the agent host) and answer
 * with the outcome only. Every client learns of a card opening and closing
 * from the `agentChat.secretRequest` bus event, which carries the request's
 * name, prompt and purpose — never a value.
 */

import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import {
  agentChatRoutes,
  SECRET_REQUEST_EVENT_TYPE,
  SECRET_REQUEST_TIMEOUT_MS,
  SECRET_VALUE_MAX_CHARS,
  type AgentChatSecretRequestEventPayload,
  type SecretRequestAnswerResponse,
  type SecretRequestErrorCode,
  type SecretRequestErrorEnvelope,
  type SecretRequestListResponse,
  type SecretRequestOutcome,
  type SecretRequestSummary
} from "@orquester/api/agent-chat";

import type {
  SessionSecretRequestInput,
  SessionSecretRequestResult,
  SessionSecretRequests
} from "../session-tools/contract.ts";

/** An answer body is a value and a word: anything bigger is refused unread. */
const ANSWER_BODY_LIMIT = 64 * 1024;

interface Pending {
  readonly summary: SecretRequestSummary;
  /** The waiting call's own word on whether its result reached the agent host. */
  readonly delivered: Promise<boolean> | undefined;
  /** End the wait. `announce: false` leaves the close event to the caller. */
  settle(result: SessionSecretRequestResult, announce?: boolean): void;
}

/**
 * How long a provided value's call may take to hand its result over before
 * the answer is reported as not delivered. A safety bound only: the route
 * resolves `delivered` as soon as its reply finishes or its connection drops.
 */
const DELIVERY_BOUND_MS = 30_000;

/**
 * What an answer did: delivered (the call's result left the daemon), declined,
 * not delivered (the call stopped waiting first), or unconfirmed (handed to
 * the call, whose result had not left the daemon within the bound — it may
 * or may not reach the agent).
 */
export type SecretAnswerOutcome = "provided" | "declined" | "not_delivered" | "unconfirmed";

export interface SecretRequestRegistryOptions {
  /** Publish one bus event (`sessions` channel, {@link SECRET_REQUEST_EVENT_TYPE}). */
  publish(payload: AgentChatSecretRequestEventPayload): void;
  /** A thread's pending set changed (the summary's attention state follows it). */
  onChange?(threadId: string): void;
  /** How long a provided answer waits for its call's result to leave (tests shorten it). */
  deliveryBoundMs?: number;
  timeoutMs?: number;
  now?: () => Date;
  newId?: () => string;
}

export type SecretAnswer = { answer: "provide"; value: string } | { answer: "decline" };

export class SecretRequestRegistry implements SessionSecretRequests {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly opts: SecretRequestRegistryOptions) {}

  /**
   * Open a card in `threadId` and wait for its answer, `signal`, or the
   * deadline. Never rejects. `delivered` — the route's — resolves true once
   * the call's result has been handed to the agent host, false when it was
   * dropped: a provided answer is only reported `provided` once it is true.
   */
  request(
    threadId: string,
    input: SessionSecretRequestInput,
    signal: AbortSignal,
    delivered?: Promise<boolean>
  ): Promise<SessionSecretRequestResult> {
    if (signal.aborted) {
      return Promise.resolve({ outcome: "cancelled" });
    }
    const summary: SecretRequestSummary = {
      requestId: (this.opts.newId ?? randomUUID)(),
      sessionId: threadId,
      name: input.name,
      prompt: input.prompt,
      ...(input.purpose !== undefined && input.purpose.length > 0 ? { purpose: input.purpose } : {}),
      createdAt: (this.opts.now?.() ?? new Date()).toISOString()
    };
    return new Promise<SessionSecretRequestResult>((resolve) => {
      let settled = false;
      const timer = setTimeout(
        () => settle({ outcome: "timed_out" }),
        this.opts.timeoutMs ?? SECRET_REQUEST_TIMEOUT_MS
      );
      timer.unref?.();
      const onAbort = () => settle({ outcome: "cancelled" });
      const settle = (result: SessionSecretRequestResult, announce = true): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.pending.delete(summary.requestId);
        if (announce) this.publish(summary, false, result.outcome);
        this.changed(threadId);
        // The value leaves here, once, into the call that asked.
        resolve(result);
      };
      this.pending.set(summary.requestId, { summary, delivered, settle });
      signal.addEventListener("abort", onAbort, { once: true });
      this.publish(summary, true);
      this.changed(threadId);
    });
  }

  /** The thread's pending requests, oldest first. */
  list(threadId: string): SecretRequestSummary[] {
    return [...this.pending.values()]
      .map((entry) => entry.summary)
      .filter((summary) => summary.sessionId === threadId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Answer one of `threadId`'s requests; null when it has none by that id —
   * already answered, ended, or another thread's. A provided value goes to the
   * waiting call at once; the outcome (on the bus and to the caller) is
   * `provided` only once that call's result was handed over, else
   * `not_delivered` (the card closes `cancelled`): the agent stopped waiting
   * between the answer and its result leaving the daemon.
   */
  async answer(threadId: string, requestId: string, answer: SecretAnswer): Promise<SecretAnswerOutcome | null> {
    const entry = this.pending.get(requestId);
    if (entry === undefined || entry.summary.sessionId !== threadId) {
      return null;
    }
    if (answer.answer === "decline") {
      entry.settle({ outcome: "declined" });
      return "declined";
    }
    entry.settle({ outcome: "provided", value: answer.value }, false);
    const delivery = await boundedDelivery(entry.delivered, this.opts.deliveryBoundMs);
    // Unconfirmed: the call did receive it; whether its result got out is unknown.
    this.publish(entry.summary, false, delivery === "dropped" ? "cancelled" : "provided");
    return delivery === "delivered" ? "provided" : delivery === "dropped" ? "not_delivered" : "unconfirmed";
  }

  private changed(threadId: string): void {
    try {
      this.opts.onChange?.(threadId);
    } catch {
      // The attention state is a view; it must never strand the waiting call.
    }
  }

  private publish(request: SecretRequestSummary, open: boolean, outcome?: SecretRequestOutcome): void {
    try {
      this.opts.publish({
        id: request.sessionId,
        request,
        open,
        ...(outcome !== undefined ? { outcome } : {})
      });
    } catch {
      // A bus failure must never strand the waiting call.
    }
  }
}

/** The route's word ("delivered" where no route is involved), or "unconfirmed" past {@link DELIVERY_BOUND_MS}. */
async function boundedDelivery(
  delivered: Promise<boolean> | undefined,
  boundMs = DELIVERY_BOUND_MS
): Promise<"delivered" | "dropped" | "unconfirmed"> {
  if (delivered === undefined) return "delivered";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<"unconfirmed">((resolve) => {
    // Not unref'd: an answer is in flight and the route awaits it.
    timer = setTimeout(() => resolve("unconfirmed"), boundMs);
  });
  try {
    return await Promise.race([
      delivered.then(
        (ok) => (ok ? ("delivered" as const) : ("dropped" as const)),
        () => "dropped" as const
      ),
      bound
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function refusal(code: SecretRequestErrorCode, message: string): SecretRequestErrorEnvelope {
  return { error: { code, message } };
}

const STATUS: Record<SecretRequestErrorCode, number> = {
  THREAD_NOT_FOUND: 404,
  SECRET_REQUEST_NOT_FOUND: 404,
  SECRET_NOT_DELIVERED: 409,
  INVALID_ARGUMENT: 400
};

/**
 * The answer body, or null. The value is checked for shape and size only and
 * passed on exactly as typed — an all-whitespace value is refused, nothing is
 * trimmed; no message ever quotes it.
 */
export function parseSecretAnswer(body: unknown): SecretAnswer | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (record.answer === "decline") return { answer: "decline" };
  if (record.answer !== "provide" || typeof record.value !== "string") return null;
  const value = record.value;
  if (value.trim().length === 0 || value.length > SECRET_VALUE_MAX_CHARS) return null;
  return { answer: "provide", value };
}

/** The shared builder's path with its percent-encoded `:param` placeholders decoded (as `proxy-routes.ts`). */
function pattern(path: string): string {
  return decodeURIComponent(path);
}

export interface SecretRequestRouteDeps {
  registry: SecretRequestRegistry;
  /** True when `id` is a chat session this daemon knows. */
  isChatSession(id: string): boolean;
}

/**
 * `GET /api/sessions/:id/secret-requests` and `POST …/:requestId`, on both
 * transports: remote HTTP's auth hook guards them as every chat route.
 */
export function registerSecretRequestRoutes(app: FastifyInstance, deps: SecretRequestRouteDeps): void {
  app.get<{ Params: { id: string } }>(pattern(agentChatRoutes.secretRequests(":id")), async (request, reply) => {
    const { id } = request.params;
    if (!deps.isChatSession(id)) {
      return reply.code(404).send(refusal("THREAD_NOT_FOUND", "No chat session with that id."));
    }
    const response: SecretRequestListResponse = { requests: deps.registry.list(id) };
    return response;
  });

  app.post<{ Params: { id: string; requestId: string } }>(
    pattern(agentChatRoutes.secretRequest(":id", ":requestId")),
    { bodyLimit: ANSWER_BODY_LIMIT },
    async (request, reply) => {
      const { id, requestId } = request.params;
      const send = (code: SecretRequestErrorCode, message: string) =>
        reply.code(STATUS[code]).send(refusal(code, message));
      if (!deps.isChatSession(id)) {
        return send("THREAD_NOT_FOUND", "No chat session with that id.");
      }
      const answer = parseSecretAnswer(request.body);
      if (answer === null) {
        return send(
          "INVALID_ARGUMENT",
          `Send {"answer":"decline"} or {"answer":"provide","value":<1–${SECRET_VALUE_MAX_CHARS} characters>}.`
        );
      }
      const outcome = await deps.registry.answer(id, requestId, answer);
      if (outcome === null) {
        return send("SECRET_REQUEST_NOT_FOUND", "This request was already answered or has ended.");
      }
      if (outcome === "not_delivered") {
        return send(
          "SECRET_NOT_DELIVERED",
          "The agent stopped waiting before your answer reached it; it was discarded, not sent."
        );
      }
      const response: SecretRequestAnswerResponse = { ok: true, outcome };
      return response;
    }
  );
}
