/**
 * Ephemeral AI VMs — the daemon's socket-only route the agent host calls around a box CLI's life
 * (`daemonRoutesForHost.boxSync`, spec 2026-10-19 §8.3, §8.5): the config sync before every CLI
 * start, the transcript push before a resume, the transcript mirror and the config-change set
 * after every turn, and the mark of every turn's start. The implementations are the sync track's (`BoxConfigSync`,
 * `BoxTranscriptSync`); this only carries the agent host's calls to them.
 *
 * Registered ONLY on the unix-socket app, never on remote HTTP, and it requires the agent host's
 * own bearer besides. Every path in a body is a HOST path. A failure answers `{code, message}`.
 */

import type { FastifyInstance } from "fastify";

import { daemonRoutesForHost, type BoxSyncRequest, type BoxTranscriptRef } from "../agent-host/host-protocol.ts";
import type { BoxConfigSync, BoxTranscriptSync } from "../boxes/contracts.ts";

export interface BoxHostRoutesDeps {
  /** True only for the agent host's own bearer. */
  authorizeHost(authorization: string | undefined): boolean;
  sync: BoxConfigSync;
  transcripts: BoxTranscriptSync;
  logger?: { warn?: (...a: unknown[]) => void };
}

const AGENTS = new Set(["claude", "codex", "grok", "opencode"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbsoluteHostPath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && value.length < 4096 && !value.includes("\0");
}

function parseTranscript(value: unknown): BoxTranscriptRef | null {
  if (!isRecord(value) || typeof value.agent !== "string" || !AGENTS.has(value.agent)) return null;
  if (!isAbsoluteHostPath(value.configRoot) || !isAbsoluteHostPath(value.cwd)) return null;
  const sessionRef = value.sessionRef;
  if (sessionRef !== null && (typeof sessionRef !== "string" || sessionRef.length === 0 || sessionRef.length > 256)) return null;
  return { agent: value.agent as BoxTranscriptRef["agent"], configRoot: value.configRoot, cwd: value.cwd, sessionRef };
}

/** The body, field-wise; null for anything that is not one. */
export function parseBoxSyncRequest(body: unknown): BoxSyncRequest | null {
  if (!isRecord(body) || typeof body.boxId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(body.boxId)) return null;
  const boxId = body.boxId;
  switch (body.op) {
    case "ensureSynced": {
      const scope = body.scope;
      if (!isRecord(scope) || typeof scope.agent !== "string" || !AGENTS.has(scope.agent)) return null;
      if (!Array.isArray(scope.configRoots) || scope.configRoots.length > 16 || !scope.configRoots.every(isAbsoluteHostPath)) return null;
      const threadId = scope.threadId;
      if (threadId !== null && (typeof threadId !== "string" || threadId.length === 0 || threadId.length > 256)) return null;
      return {
        op: "ensureSynced",
        boxId,
        scope: { agent: scope.agent as BoxTranscriptRef["agent"], configRoots: [...scope.configRoots], threadId }
      };
    }
    case "pushForResume":
    case "pullAfterTurn": {
      const transcript = parseTranscript(body.transcript);
      return transcript === null ? null : { op: body.op, boxId, transcript };
    }
    case "turnEnded":
    case "turnStarted":
      return typeof body.threadId === "string" && body.threadId.length > 0 && body.threadId.length <= 256
        ? { op: body.op, boxId, threadId: body.threadId }
        : null;
    default:
      return null;
  }
}

export function registerBoxHostRoutes(app: FastifyInstance, deps: BoxHostRoutesDeps): void {
  app.post(daemonRoutesForHost.boxSync, async (request, reply) => {
    if (!deps.authorizeHost(request.headers.authorization)) {
      return reply.code(401).send({ code: "UNAUTHORIZED", message: "Only the agent host may sync a box launch." });
    }
    const body = parseBoxSyncRequest(request.body);
    if (body === null) {
      return reply.code(400).send({ code: "INVALID_ARGUMENT", message: "Not a box sync request." });
    }
    // The agent host going away ends the wait. `close` on the response, not the request: a
    // request's `close` fires as soon as its body has been read.
    const gone = new AbortController();
    const onClose = (): void => {
      if (!reply.raw.writableEnded) gone.abort();
    };
    reply.raw.once("close", onClose);
    try {
      switch (body.op) {
        case "ensureSynced":
          await deps.sync.ensureSynced(body.boxId, body.scope, gone.signal);
          break;
        case "pushForResume":
          await deps.transcripts.pushForResume(body.boxId, body.transcript, gone.signal);
          break;
        case "pullAfterTurn":
          await deps.transcripts.pullAfterTurn(body.boxId, body.transcript, gone.signal);
          break;
        case "turnEnded":
          await deps.sync.turnEnded(body.boxId, body.threadId);
          break;
        case "turnStarted":
          // In memory only, so it needs no box link. A sync without the hook groups by the debounce.
          deps.sync.turnStarted?.(body.boxId, body.threadId);
          break;
      }
      return reply.code(204).send();
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      deps.logger?.warn?.(`boxes: the agent host's ${body.op} for ${body.boxId} failed`, error instanceof Error ? error.message : String(error));
      return reply.code(typeof code === "string" && code === "BOX_NOT_READY" ? 409 : 500).send({
        code: typeof code === "string" ? code : "BOX_SYNC_FAILED",
        message: error instanceof Error ? error.message : "The box sync failed."
      });
    } finally {
      reply.raw.off("close", onClose);
    }
  });
}
