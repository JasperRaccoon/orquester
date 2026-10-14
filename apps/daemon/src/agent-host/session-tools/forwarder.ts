/**
 * Agent host — the forwarder: one session-tool call, sent to the daemon's
 * socket-only route (`daemonRoutesForHost.sessionToolCall`) and answered with
 * the `CallToolResult` the daemon's handler built (design §1.1).
 *
 * It never throws and never hangs on a dead daemon: a socket that refuses or
 * vanishes (a deploy restarting the daemon) is the agent-facing error result
 * "Orquester is restarting; retry in a few seconds.". Cancelling the call
 * (`signal`) drops the connection, which the daemon's route turns into the
 * handler's own abort. There is deliberately no response deadline: a wait
 * tool answers late, and its own bound is the tool's business.
 */

import { request as httpRequest } from "node:http";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  cancelledResult,
  daemonUnavailableResult,
  errorResult
} from "../../session-tools/results.ts";
import {
  agentHostAuthValue,
  daemonRoutesForHost,
  type SessionToolCallRequest
} from "../host-protocol.ts";

/** The most of a daemon answer read back: room for an image result. */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export interface DaemonForwarderOptions {
  /** The daemon's unix socket, read per call. */
  socketPath: () => string;
  /** The agent host's own token — the daemon checks it. */
  token: string;
}

export type ForwardSessionToolCall = (
  call: SessionToolCallRequest,
  signal: AbortSignal
) => Promise<CallToolResult>;

function isCallToolResult(value: unknown): value is CallToolResult {
  return (
    value !== null &&
    typeof value === "object" &&
    Array.isArray((value as { content?: unknown }).content)
  );
}

/** The `{code, message}` a daemon refusal carries, as text the agent can read. */
function refusal(status: number, body: string): CallToolResult {
  let code = status === 404 ? "THREAD_NOT_FOUND" : status === 401 ? "UNAUTHORIZED" : "UNAVAILABLE";
  let message = `The daemon refused the call (HTTP ${status}).`;
  try {
    const parsed = JSON.parse(body) as { code?: unknown; message?: unknown };
    if (typeof parsed.code === "string") code = parsed.code;
    if (typeof parsed.message === "string") message = parsed.message;
  } catch {
    // A route-miss from a daemon that predates the route, or a crash: the defaults say enough.
  }
  return status === 503 ? daemonUnavailableResult() : errorResult(code, message);
}

export function createDaemonForwarder(options: DaemonForwarderOptions): ForwardSessionToolCall {
  return (call, signal) =>
    new Promise<CallToolResult>((resolve) => {
      if (signal.aborted) {
        resolve(cancelledResult());
        return;
      }
      const payload = JSON.stringify(call);
      let settled = false;
      const settle = (result: CallToolResult): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const req = httpRequest(
        {
          socketPath: options.socketPath(),
          // No keep-alive pool: a socket pooled from a daemon that has since
          // restarted would fail the next call as "restarting" for nothing.
          agent: false,
          path: daemonRoutesForHost.sessionToolCall,
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
              settle(errorResult("RESULT_TOO_LARGE", "The tool's result was too large to return."));
              return;
            }
            chunks.push(chunk);
          });
          res.on("error", () => settle(daemonUnavailableResult()));
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            const status = res.statusCode ?? 502;
            if (status !== 200) {
              settle(refusal(status, body));
              return;
            }
            try {
              const parsed: unknown = JSON.parse(body);
              settle(isCallToolResult(parsed) ? parsed : errorResult("INTERNAL", "The daemon answered with no result."));
            } catch {
              settle(errorResult("INTERNAL", "The daemon answered with no result."));
            }
          });
        }
      );
      const onAbort = (): void => {
        req.destroy();
        settle(cancelledResult());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      // ECONNREFUSED / ENOENT (no daemon), ECONNRESET / socket hang up (it
      // died mid-call): all the same to the agent.
      req.on("error", () => settle(signal.aborted ? cancelledResult() : daemonUnavailableResult()));
      req.end(payload);
    });
}
