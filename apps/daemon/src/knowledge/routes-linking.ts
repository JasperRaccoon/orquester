/**
 * Knowledge Graph plugin — the linking routes (paths from `knowledgeRoutes`, `@orquester/api`
 * `knowledge.ts`) and the status event. Both transports, behind the same bearer hook as every
 * `/api` route. Every refusal is `{ code, message }` with a `KnowledgeErrorCode`.
 *
 * - `GET status` — `KnowledgeStatus`: the linking parts (`KnowledgeLinkingService.snapshot`)
 *   plus the counts the caller injects (entries, concepts, edges, collections, enabled, installed).
 * - `POST rebuild` — asks for a full re-extraction (now, or after the run in flight); answers the
 *   status. 409 `KNOWLEDGE_DISABLED` / `KNOWLEDGE_NOT_INSTALLED`.
 * - `GET rebuildEstimate` — `KnowledgeRebuildEstimate` (information only).
 * - `POST workerNext` / `POST workerSubmit` `KnowledgeWorkerSubmitRequest` — the worker protocol,
 *   on the unix-socket app only (`workerRoutes`): in-chat tools reach it through the in-process
 *   client, and nothing on the remote transport could ever be a worker. The calling session is ONLY the request's agent principal (the identity the daemon stamps on
 *   an in-chat tool call); a body `sessionId` is never trusted. It must be a session whose `owner`
 *   is `{kind: "knowledge-indexer"}` for the run in flight, else 403 `KNOWLEDGE_NOT_A_WORKER`. `workerNext` long-polls (see `linking/inbox.ts`);
 *   a client that goes away ends the wait.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  knowledgeRoutes,
  type KnowledgeRebuildEstimate,
  type KnowledgeStatus,
  type KnowledgeWorkerNextResponse,
  type KnowledgeWorkerSubmitResponse,
  type SessionOwner
} from "@orquester/api";
import type { KnowledgeLinkingService, KnowledgeLinkingSnapshot } from "./linking/service.ts";
import { KnowledgeError } from "./store/errors.ts";

/** Largest worker answer accepted, in UTF-16 code units (myKG's own cap is `max_tokens` = 32k). */
export const KNOWLEDGE_WORKER_ANSWER_MAX = 1_000_000;

/** The counts a status carries besides the linking parts. */
export interface KnowledgeStatusCounts {
  enabled: boolean;
  installed: boolean;
  entries: number;
  concepts: number;
  edges: number;
  collections: number;
  /** Entries with `linkState: "failed"`. */
  failedEntries: number;
  /** Whether the embedding model is installed and loadable (`KnowledgeStatus.embeddingModelReady`). */
  embeddingModelReady?: boolean;
  /** Automatic concept merges in effect (`KnowledgeStatus.conceptMerges`). */
  conceptMerges?: number;
}

export type KnowledgeLinkingRouteService = Pick<
  KnowledgeLinkingService,
  "snapshot" | "rebuild" | "rebuildEstimate" | "isActiveWorker" | "workerNext" | "workerSubmit"
>;

export interface KnowledgeLinkingRoutesDeps {
  linking: KnowledgeLinkingRouteService;
  counts: () => KnowledgeStatusCounts;
  /** The session's `owner` (`SessionSummary.owner`), or undefined for no such session. */
  sessionOwner: (sessionId: string) => SessionOwner | undefined;
  /** Register the worker routes (the unix-socket app; default). The remote app passes false. */
  workerRoutes?: boolean;
  logger?: { error(message: string): void };
}

export function buildKnowledgeStatus(snapshot: KnowledgeLinkingSnapshot, counts: KnowledgeStatusCounts): KnowledgeStatus {
  return {
    enabled: counts.enabled,
    installed: counts.installed,
    entries: counts.entries,
    concepts: counts.concepts,
    edges: counts.edges,
    collections: counts.collections,
    failedEntries: counts.failedEntries,
    linking: snapshot.linking,
    lastRun: snapshot.lastRun,
    recentRuns: snapshot.recentRuns,
    workers: snapshot.workers,
    tokens: snapshot.tokens,
    lastError: snapshot.lastError,
    ...(counts.embeddingModelReady !== undefined ? { embeddingModelReady: counts.embeddingModelReady } : {}),
    ...(counts.conceptMerges !== undefined ? { conceptMerges: counts.conceptMerges } : {})
  };
}

const NOT_A_WORKER = (): KnowledgeError =>
  new KnowledgeError("KNOWLEDGE_NOT_A_WORKER", "Only the Knowledge Graph indexer's worker chats of the run in flight may call this.");

/** The calling chat: the agent principal's thread (server-stamped), never a body field. */
function callerSession(request: FastifyRequest): string {
  const principal = (request as { principal?: { kind?: string; threadId?: unknown } }).principal;
  if (principal?.kind === "agent" && typeof principal.threadId === "string" && principal.threadId) return principal.threadId;
  throw NOT_A_WORKER();
}

function bodyOf(request: FastifyRequest): Record<string, unknown> {
  const body = request.body;
  return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

/** Aborts when the client goes away before the answer is sent. */
function clientGone(reply: FastifyReply): AbortSignal {
  const controller = new AbortController();
  reply.raw.once?.("close", () => {
    if (!reply.raw.writableFinished) controller.abort();
  });
  return controller.signal;
}

export function registerKnowledgeLinkingRoutes(app: FastifyInstance, deps: KnowledgeLinkingRoutesDeps): void {
  const { linking } = deps;
  const fail = (reply: FastifyReply, error: unknown): FastifyReply => {
    if (error instanceof KnowledgeError) return reply.code(error.status).send({ code: error.code, message: error.message });
    deps.logger?.error(`knowledge: a linking request failed (${error instanceof Error ? error.name : typeof error})`);
    return reply.code(500).send({ code: "KNOWLEDGE_ERROR", message: "The request failed." });
  };
  const status = (): KnowledgeStatus => buildKnowledgeStatus(linking.snapshot(), deps.counts());
  const requireWorker = (sessionId: string): void => {
    if (!linking.isActiveWorker(deps.sessionOwner(sessionId))) throw NOT_A_WORKER();
  };

  app.get(knowledgeRoutes.status, async (_request, reply): Promise<KnowledgeStatus | void> => {
    try {
      return status();
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post(knowledgeRoutes.rebuild, async (_request, reply): Promise<KnowledgeStatus | void> => {
    try {
      const counts = deps.counts();
      if (!counts.enabled) throw new KnowledgeError("KNOWLEDGE_DISABLED", "The Knowledge Graph plugin is off.");
      if (!counts.installed) throw new KnowledgeError("KNOWLEDGE_NOT_INSTALLED", "myKG is not installed yet.");
      await linking.rebuild();
      return status();
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.get(knowledgeRoutes.rebuildEstimate, async (_request, reply): Promise<KnowledgeRebuildEstimate | void> => {
    try {
      return await linking.rebuildEstimate();
    } catch (error) {
      return fail(reply, error);
    }
  });

  if (deps.workerRoutes === false) return;

  app.post(knowledgeRoutes.workerNext, async (request, reply): Promise<KnowledgeWorkerNextResponse | void> => {
    try {
      const sessionId = callerSession(request);
      requireWorker(sessionId);
      return await linking.workerNext(sessionId, clientGone(reply));
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post(knowledgeRoutes.workerSubmit, async (request, reply): Promise<KnowledgeWorkerSubmitResponse | void> => {
    try {
      const body = bodyOf(request);
      const sessionId = callerSession(request);
      requireWorker(sessionId);
      const { taskId, answer } = body;
      if (typeof taskId !== "string" || taskId.trim() === "" || taskId.length > 200) {
        throw new KnowledgeError("KNOWLEDGE_INVALID", "taskId must be the id of the task you answer.");
      }
      if (typeof answer !== "string") throw new KnowledgeError("KNOWLEDGE_INVALID", "answer must be the JSON text the task asks for.");
      if (answer.length > KNOWLEDGE_WORKER_ANSWER_MAX) throw new KnowledgeError("KNOWLEDGE_TOO_LARGE", "The answer is too large.");
      return await linking.workerSubmit(sessionId, taskId, answer, clientGone(reply));
    } catch (error) {
      return fail(reply, error);
    }
  });
}
