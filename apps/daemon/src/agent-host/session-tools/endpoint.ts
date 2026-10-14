/**
 * Agent host — the loopback MCP endpoint Codex, Grok and OpenCode reach their
 * `orquester` tools through (design §1.2): Streamable HTTP, stateless, JSON
 * responses, on `127.0.0.1:<ephemeral port>/mcp`, one listener per host
 * process, started on the first credential issued.
 *
 * Every request must carry a live credential (`Authorization: Bearer …`,
 * `credentials.ts`) — anything else is a 401 — and the thread a call acts as
 * is the one that credential was issued for, never anything in the request.
 *
 * Cancellation: a provider that cancels a call sends `notifications/cancelled`
 * naming its JSON-RPC id, in a separate POST a stateless server cannot tie to
 * the first. So in-flight calls are filed by (grant, request id) and such a
 * notification aborts its own grant's call; a request whose connection closes
 * before its answer aborts its calls too.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { SessionToolDefinition } from "../../session-tools/contract.ts";
import { bearerToken, type SessionToolCredentials, type SessionToolGrantScope } from "./credentials.ts";
import { buildSessionToolsMcpServer, type SessionToolInvocation } from "./mcp-server.ts";

/** 16 MiB, as the daemon's own route. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

export const SESSION_TOOLS_ENDPOINT_PATH = "/mcp";

export interface SessionToolsEndpoint {
  /** `http://127.0.0.1:<port>/mcp`. */
  readonly url: string;
  close(): Promise<void>;
}

export interface SessionToolsEndpointOptions {
  credentials: SessionToolCredentials;
  tools: readonly SessionToolDefinition[];
  /** Run one call as `scope`'s thread. */
  invoke(scope: SessionToolGrantScope, invocation: SessionToolInvocation): Promise<CallToolResult>;
  logger?: { warn(message: string, detail?: unknown): void };
}

const jsonRpcError = (res: ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}): void => {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
};

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** The JSON-RPC ids a body's `notifications/cancelled` messages name. */
function cancelledRequestIds(body: unknown): Array<string | number> {
  const messages = Array.isArray(body) ? body : [body];
  const ids: Array<string | number> = [];
  for (const message of messages) {
    if (message === null || typeof message !== "object") continue;
    const record = message as { method?: unknown; params?: { requestId?: unknown } };
    const id = record.params?.requestId;
    if (record.method === "notifications/cancelled" && (typeof id === "string" || typeof id === "number")) {
      ids.push(id);
    }
  }
  return ids;
}

export async function startSessionToolsEndpoint(options: SessionToolsEndpointOptions): Promise<SessionToolsEndpoint> {
  /** `<grantId>\0<request id>` → the call's abort. */
  const inFlight = new Map<string, AbortController>();
  const key = (grantId: string, requestId: string | number): string => `${grantId}\u0000${typeof requestId}:${requestId}`;

  let port = 0;
  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      options.logger?.warn("session-tools endpoint: request failed", { error: String(error) });
      jsonRpcError(res, 500, -32603, "Internal error");
    });
  });

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? "").split("?")[0];
    if (path !== SESSION_TOOLS_ENDPOINT_PATH) {
      jsonRpcError(res, 404, -32601, "Not found");
      return;
    }
    const scope = options.credentials.verify(bearerToken(req.headers.authorization));
    if (scope === null) {
      req.resume();
      jsonRpcError(res, 401, -32001, "Unauthorized");
      return;
    }
    if (req.method !== "POST") {
      // Stateless: no server-initiated stream, no session to delete.
      req.resume();
      jsonRpcError(res, 405, -32000, "Method not allowed.", { allow: "POST" });
      return;
    }
    const raw = await readBody(req);
    if (raw === null) {
      jsonRpcError(res, 413, -32600, "Request too large");
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      jsonRpcError(res, 400, -32700, "Parse error");
      return;
    }
    for (const requestId of cancelledRequestIds(body)) {
      inFlight.get(key(scope.grantId, requestId))?.abort();
    }

    // Everything this request started ends with its connection.
    const connection = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) connection.abort();
    });

    const mcp = buildSessionToolsMcpServer(options.tools, async (invocation) => {
      const call = new AbortController();
      const abort = () => call.abort();
      connection.signal.addEventListener("abort", abort, { once: true });
      invocation.signal.addEventListener("abort", abort, { once: true });
      const id = invocation.requestId === undefined ? null : key(scope.grantId, invocation.requestId);
      if (id !== null) inFlight.set(id, call);
      try {
        return await options.invoke(scope, { ...invocation, signal: call.signal });
      } finally {
        if (id !== null && inFlight.get(id) === call) inFlight.delete(id);
        connection.signal.removeEventListener("abort", abort);
        invocation.signal.removeEventListener("abort", abort);
      }
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      // A browser page cannot rebind a name onto this port and drive it.
      enableDnsRebindingProtection: true,
      allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`]
    });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  // A provider keeps its connection alive between calls; never let that hold the host's exit.
  server.unref();

  return {
    url: `http://127.0.0.1:${port}${SESSION_TOOLS_ENDPOINT_PATH}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const controller of inFlight.values()) controller.abort();
        inFlight.clear();
        server.close(() => resolve());
        server.closeAllConnections();
      })
  };
}
