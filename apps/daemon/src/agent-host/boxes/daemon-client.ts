/**
 * Agent host — the daemon calls a box launch makes (spec 2026-10-19 §7, §8.3,
 * §8.5), over the daemon's unix socket with the host's own bearer:
 *
 * - `daemonRoutesForHost.boxToken` — the token broker's short-lived access
 *   token for one agent account (never a refresh token);
 * - `daemonRoutesForHost.boxSync` — the config and transcript sync seams
 *   (`BoxConfigSync`, `BoxTranscriptSync`), which live in the daemon.
 *
 * Every call is bounded. A token's value is never logged: errors carry the
 * daemon's code and message only.
 */

import { request as httpRequest } from "node:http";

import type { AgentTokenGrant, BoxSyncScope, BoxTranscriptSync } from "../../boxes/contracts.ts";
import { agentHostAuthValue, daemonRoutesForHost, type BoxSyncRequest, type BoxTokenRequest } from "../host-protocol.ts";

/** The token broker, as a box launch sees it. */
export interface BoxTokenSource {
  getToken(request: BoxTokenRequest, signal?: AbortSignal): Promise<AgentTokenGrant>;
}

type TranscriptRequest = Parameters<BoxTranscriptSync["pullAfterTurn"]>[1];

/** The sync seams, as a box launch sees them (the daemon owns the implementations). */
export interface BoxSyncClient {
  ensureSynced(boxId: string, scope: BoxSyncScope, signal?: AbortSignal): Promise<void>;
  pushForResume(boxId: string, request: TranscriptRequest, signal?: AbortSignal): Promise<void>;
  pullAfterTurn(boxId: string, request: TranscriptRequest, signal?: AbortSignal): Promise<void>;
  turnEnded(boxId: string, threadId: string, signal?: AbortSignal): Promise<void>;
  /** A live turn started: the box changes it makes wait for its {@link turnEnded}. */
  turnStarted(boxId: string, threadId: string, signal?: AbortSignal): Promise<void>;
}

/** A refusal or failure of a daemon box call, with the daemon's own code. */
export class BoxDaemonCallError extends Error {
  readonly code: string;
  readonly status: number | null;

  constructor(code: string, message: string, status: number | null) {
    super(message);
    this.name = "BoxDaemonCallError";
    this.code = code;
    this.status = status;
  }
}

/** A token is asked for at a spawn: the broker may refresh on demand first. */
export const BOX_TOKEN_TIMEOUT_MS = 60_000;
/** A full hash comparison may run before a CLI starts (spec §8.3). */
export const BOX_SYNC_TIMEOUT_MS = 10 * 60_000;
/** A turn's transcript mirror and its config-change set. */
export const BOX_TURN_SYNC_TIMEOUT_MS = 2 * 60_000;
/** A turn's start mark: an in-memory note in the daemon, no box I/O. */
export const BOX_TURN_START_TIMEOUT_MS = 15_000;

const MAX_RESPONSE_BYTES = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface DaemonCallOptions {
  socketPath: () => string;
  token: string;
}

/** POST `body` to `path`; resolves the 200 answer's JSON, rejects with {@link BoxDaemonCallError}. */
function postJson(
  options: DaemonCallOptions,
  path: string,
  body: unknown,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  what: string
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const payload = JSON.stringify(body);
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const req = httpRequest(
      {
        socketPath: options.socketPath(),
        agent: false,
        path,
        method: "POST",
        headers: {
          host: "daemon.localhost",
          authorization: agentHostAuthValue(options.token),
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(payload))
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        let received = 0;
        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > MAX_RESPONSE_BYTES) {
            res.destroy();
            settle(() => reject(new BoxDaemonCallError("UNAVAILABLE", `Orquester's answer to ${what} was too large.`, null)));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", () =>
          settle(() => reject(new BoxDaemonCallError("UNAVAILABLE", `Orquester's answer to ${what} was cut off.`, null)))
        );
        res.on("end", () => {
          let parsed: unknown = null;
          try {
            const text = Buffer.concat(chunks).toString("utf8");
            parsed = text.length === 0 ? null : JSON.parse(text);
          } catch {
            parsed = null;
          }
          const status = res.statusCode ?? 502;
          if (status >= 200 && status < 300) {
            settle(() => resolve(parsed));
            return;
          }
          const code = isRecord(parsed) && typeof parsed.code === "string" ? parsed.code : status === 404 ? "NOT_SUPPORTED" : "UNAVAILABLE";
          const message =
            isRecord(parsed) && typeof parsed.message === "string"
              ? parsed.message
              : status === 404
                ? `This Orquester build cannot ${what} for a box.`
                : `Orquester answered ${status} to ${what}.`;
          settle(() => reject(new BoxDaemonCallError(code, message, status)));
        });
      }
    );
    const timer = setTimeout(() => {
      req.destroy();
      settle(() => reject(new BoxDaemonCallError("TIMEOUT", `Orquester did not ${what} in time.`, null)));
    }, timeoutMs);
    const onAbort = (): void => {
      req.destroy();
      settle(() => reject(new BoxDaemonCallError("ABORTED", `Stopped waiting for Orquester to ${what}.`, null)));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    req.on("error", (error) =>
      settle(() => reject(new BoxDaemonCallError("UNAVAILABLE", `Orquester could not be reached to ${what}: ${error.message}`, null)))
    );
    req.end(payload);
  });
}

/** An `AgentTokenGrant` off the wire, field-wise; null when it is not one. */
export function parseAgentTokenGrant(value: unknown): AgentTokenGrant | null {
  if (!isRecord(value) || typeof value.accessToken !== "string" || value.accessToken.length === 0) return null;
  const expiresAt = typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt) ? value.expiresAt : null;
  const extra: Record<string, string> = {};
  if (isRecord(value.extra)) {
    for (const [key, entry] of Object.entries(value.extra)) {
      if (typeof entry === "string") extra[key] = entry;
    }
  }
  return { accessToken: value.accessToken, expiresAt, ...(Object.keys(extra).length > 0 ? { extra } : {}) };
}

export function createDaemonBoxTokenSource(options: DaemonCallOptions & { timeoutMs?: number }): BoxTokenSource {
  return {
    async getToken(request, signal) {
      const value = await postJson(
        options,
        daemonRoutesForHost.boxToken,
        request,
        options.timeoutMs ?? BOX_TOKEN_TIMEOUT_MS,
        signal,
        `issue a ${request.agent} login token`
      );
      const grant = parseAgentTokenGrant(value);
      if (grant === null) {
        throw new BoxDaemonCallError("UNAVAILABLE", "Orquester's login token answer did not read.", 200);
      }
      return grant;
    }
  };
}

export function createDaemonBoxSyncClient(
  options: DaemonCallOptions & { timeoutMs?: number; turnTimeoutMs?: number; turnStartTimeoutMs?: number }
): BoxSyncClient {
  const call = (body: BoxSyncRequest, timeoutMs: number, signal: AbortSignal | undefined, what: string): Promise<void> =>
    postJson(options, daemonRoutesForHost.boxSync, body, timeoutMs, signal, what).then(() => undefined);
  const launchTimeout = options.timeoutMs ?? BOX_SYNC_TIMEOUT_MS;
  const turnTimeout = options.turnTimeoutMs ?? BOX_TURN_SYNC_TIMEOUT_MS;
  return {
    ensureSynced: (boxId, scope, signal) =>
      call({ op: "ensureSynced", boxId, scope }, launchTimeout, signal, "sync the agent configuration into the box"),
    pushForResume: (boxId, request, signal) =>
      call({ op: "pushForResume", boxId, transcript: request }, launchTimeout, signal, "copy the chat's transcript into the box"),
    pullAfterTurn: (boxId, request, signal) =>
      call({ op: "pullAfterTurn", boxId, transcript: request }, turnTimeout, signal, "copy the chat's transcript back from the box"),
    turnEnded: (boxId, threadId, signal) =>
      call({ op: "turnEnded", boxId, threadId }, turnTimeout, signal, "collect the turn's configuration changes"),
    turnStarted: (boxId, threadId, signal) =>
      call(
        { op: "turnStarted", boxId, threadId },
        options.turnStartTimeoutMs ?? BOX_TURN_START_TIMEOUT_MS,
        signal,
        "note the turn's start for its configuration changes"
      )
  };
}
