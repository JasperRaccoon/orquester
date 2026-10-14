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
  settle(result: SessionSecretRequestResult): void;
}

export interface SecretRequestRegistryOptions {
  /** Publish one bus event (`sessions` channel, {@link SECRET_REQUEST_EVENT_TYPE}). */
  publish(payload: AgentChatSecretRequestEventPayload): void;
  timeoutMs?: number;
  now?: () => Date;
  newId?: () => string;
}

export type SecretAnswer = { answer: "provide"; value: string } | { answer: "decline" };

export class SecretRequestRegistry implements SessionSecretRequests {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly opts: SecretRequestRegistryOptions) {}

  /** Open a card in `threadId` and wait for its answer, `signal`, or the deadline. Never rejects. */
  request(
    threadId: string,
    input: SessionSecretRequestInput,
    signal: AbortSignal
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
      const settle = (result: SessionSecretRequestResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.pending.delete(summary.requestId);
        this.publish(summary, false, result.outcome);
        // The value leaves here, once, into the call that asked.
        resolve(result);
      };
      this.pending.set(summary.requestId, { summary, settle });
      signal.addEventListener("abort", onAbort, { once: true });
      this.publish(summary, true);
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
   * Answer one of `threadId`'s requests. False when it has none by that id —
   * already answered, ended, or another thread's.
   */
  answer(threadId: string, requestId: string, answer: SecretAnswer): boolean {
    const entry = this.pending.get(requestId);
    if (entry === undefined || entry.summary.sessionId !== threadId) {
      return false;
    }
    entry.settle(
      answer.answer === "provide" ? { outcome: "provided", value: answer.value } : { outcome: "declined" }
    );
    return true;
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

function refusal(code: SecretRequestErrorCode, message: string): SecretRequestErrorEnvelope {
  return { error: { code, message } };
}

const STATUS: Record<SecretRequestErrorCode, number> = {
  THREAD_NOT_FOUND: 404,
  SECRET_REQUEST_NOT_FOUND: 404,
  INVALID_ARGUMENT: 400
};

/**
 * The answer body, or null. The value is checked for shape and size only and
 * trimmed (a pasted value's stray newline); no message ever quotes it.
 */
export function parseSecretAnswer(body: unknown): SecretAnswer | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (record.answer === "decline") return { answer: "decline" };
  if (record.answer !== "provide" || typeof record.value !== "string") return null;
  const value = record.value.trim();
  if (value.length === 0 || value.length > SECRET_VALUE_MAX_CHARS) return null;
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
      if (!deps.registry.answer(id, requestId, answer)) {
        return send("SECRET_REQUEST_NOT_FOUND", "This request was already answered or has ended.");
      }
      const response: SecretRequestAnswerResponse = {
        ok: true,
        outcome: answer.answer === "provide" ? "provided" : "declined"
      };
      return response;
    }
  );
}
