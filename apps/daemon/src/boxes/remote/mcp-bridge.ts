/**
 * Box MCP bridge — the host side (spec 2026-10-19 §8.4).
 *
 * A box chat's CLI runs every MCP server the owner configured — unless it is
 * switched to "Run in box" — as `orq-agent mcp-bridge <serverId>`. That opens
 * an `mcp-bridge` channel to the daemon; this handler finds the entry the
 * agent host registered for that box and server id
 * (`agent-host/boxes/mcp-bridge-registry.ts`) and runs the REAL server here:
 *
 * - a **stdio** server is spawned on this machine with its own env (its
 *   secrets resolved here, in its process env only), its stdin/stdout piped to
 *   the channel; it is killed when the channel closes, and the channel ends
 *   when it exits;
 * - an **HTTP** server (on host loopback, or one whose headers are secrets) is
 *   reached from here: each newline-delimited JSON-RPC message from the box is
 *   sent through an MCP client transport carrying the headers, and every
 *   message it receives goes back down the channel. Orquester's own session
 *   tools ride this too, so their bearer never enters the box.
 *
 * Nothing here logs a message body, an env value or a header: a server's own
 * stderr is counted, not forwarded.
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import type { Duplex } from "node:stream";

import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import { readMcpBridgeEntry, type McpBridgeEntry, type McpBridgeHttpTarget, type McpBridgeStdioTarget } from "../../agent-host/boxes/mcp-bridge-registry.ts";
import type { BoxChannelHandler, BoxHub } from "../contracts.ts";

/** SIGTERM, then SIGKILL this long after, for a bridged stdio server whose channel closed. */
const MCP_BRIDGE_KILL_GRACE_MS = 2_000;
/**
 * Open bridge channels one box may hold at once. Each can be a process on this machine, and a
 * box is untrusted: past this, a new channel is refused (closed) until one of its own ends.
 * Comfortably above real use — every chat's CLI opens one per configured server.
 */
export const MCP_BRIDGE_MAX_CHANNELS_PER_BOX = 64;

export interface McpBridgeLogger {
  info?(message: string, detail?: Record<string, unknown>): void;
  warn?(message: string, detail?: Record<string, unknown>): void;
}

export interface McpBridgeDeps {
  /** `<appdir>`: where the registry lives. */
  appdir: string;
  /**
   * The environment a bridged stdio server starts from (its own env goes on top): the session
   * PATH and HOME a terminal gets. Default: PATH, HOME, USER, LANG and TMPDIR of this process.
   */
  baseEnv?: () => Record<string, string>;
  logger?: McpBridgeLogger;
  /** Tests. */
  spawn?: typeof nodeSpawn;
  /** Tests: the HTTP transport's fetch. */
  fetch?: typeof fetch;
  /** Default {@link MCP_BRIDGE_MAX_CHANNELS_PER_BOX}. */
  maxChannelsPerBox?: number;
}

function defaultBaseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "SHELL"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Register the `mcp-bridge` channel handler on the hub. */
export function registerMcpBridge(hub: Pick<BoxHub, "handleChannel">, deps: McpBridgeDeps): void {
  hub.handleChannel("mcp-bridge", mcpBridgeChannelHandler(deps));
}

/** The handler itself (exported for tests and for a hub that registers handlers its own way). */
export function mcpBridgeChannelHandler(deps: McpBridgeDeps): BoxChannelHandler {
  const max = deps.maxChannelsPerBox ?? MCP_BRIDGE_MAX_CHANNELS_PER_BOX;
  /** Box id → its open bridge channels, counted from the open (before any lookup or spawn). */
  const open = new Map<string, number>();
  return (context, spec, stream) => {
    if (spec.kind !== "mcp-bridge") {
      stream.destroy();
      return;
    }
    const held = open.get(context.boxId) ?? 0;
    if (held >= max) {
      deps.logger?.warn?.("boxes: an MCP bridge was refused: the box holds too many open bridges", { boxId: context.boxId, open: held });
      stream.destroy();
      return;
    }
    open.set(context.boxId, held + 1);
    let counted = true;
    const release = (): void => {
      if (!counted) return;
      counted = false;
      const left = (open.get(context.boxId) ?? 1) - 1;
      if (left > 0) open.set(context.boxId, left);
      else open.delete(context.boxId);
    };
    // `close` follows every end of the channel (destroyed, or both sides ended).
    stream.once("close", release);
    if (stream.destroyed) release();
    void (async () => {
      const entry = await readMcpBridgeEntry(deps.appdir, context.boxId, spec.serverId);
      if (entry === null) {
        deps.logger?.warn?.("boxes: an MCP bridge named an unknown server", { boxId: context.boxId });
        stream.destroy();
        return;
      }
      if (entry.target.transport === "stdio") {
        bridgeStdio(entry, entry.target, stream, deps);
      } else {
        await bridgeHttp(entry, entry.target, stream, deps);
      }
    })().catch((error: unknown) => {
      deps.logger?.warn?.("boxes: an MCP bridge failed", {
        boxId: context.boxId,
        error: error instanceof Error ? error.message : String(error)
      });
      stream.destroy();
    });
  };
}

/** Run the stdio server here and pipe it to the channel; either side ending ends the other. */
function bridgeStdio(entry: McpBridgeEntry, target: McpBridgeStdioTarget, stream: Duplex, deps: McpBridgeDeps): void {
  const spawn = deps.spawn ?? nodeSpawn;
  const env = { ...(deps.baseEnv ?? defaultBaseEnv)(), ...target.env };
  let child: ChildProcess;
  try {
    child = spawn(target.command, target.args, {
      ...(target.cwd !== undefined ? { cwd: target.cwd } : env.HOME !== undefined ? { cwd: env.HOME } : {}),
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true
    });
  } catch (error) {
    deps.logger?.warn?.("boxes: a bridged MCP server could not start", {
      boxId: entry.boxId,
      server: entry.name,
      error: error instanceof Error ? error.message : String(error)
    });
    stream.destroy();
    return;
  }
  let exited = false;
  let stderrLines = 0;
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrLines += chunk.toString("utf8").split("\n").length - 1;
  });
  child.on("error", (error) => {
    deps.logger?.warn?.("boxes: a bridged MCP server failed", { boxId: entry.boxId, server: entry.name, error: error.message });
    stream.destroy();
  });
  child.on("exit", (code, signal) => {
    exited = true;
    deps.logger?.info?.("boxes: a bridged MCP server exited", {
      boxId: entry.boxId,
      server: entry.name,
      code,
      signal,
      stderrLines
    });
    stream.end();
  });
  child.stdin?.on("error", () => undefined);
  child.stdout?.pipe(stream, { end: false });
  stream.pipe(child.stdin!, { end: true });
  const stop = (): void => {
    if (exited) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (!exited) child.kill("SIGKILL");
    }, MCP_BRIDGE_KILL_GRACE_MS);
    timer.unref();
  };
  stream.once("close", stop);
  stream.once("error", stop);
}

/** The `result.protocolVersion` of an `initialize` answer, which the HTTP transport then sends as a header. */
function negotiatedVersion(message: JSONRPCMessage): string | null {
  const result = (message as { result?: { protocolVersion?: unknown } }).result;
  return typeof result?.protocolVersion === "string" ? result.protocolVersion : null;
}

/** Relay newline-delimited JSON-RPC between the channel and an HTTP MCP server reached from here. */
async function bridgeHttp(entry: McpBridgeEntry, target: McpBridgeHttpTarget, stream: Duplex, deps: McpBridgeDeps): Promise<void> {
  const requestInit: RequestInit = { headers: { ...target.headers } };
  const url = new URL(target.url);
  const transport: Transport & { setProtocolVersion?: (version: string) => void } =
    target.transport === "sse"
      ? new SSEClientTransport(url, { requestInit, ...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}) })
      : new StreamableHTTPClientTransport(url, { requestInit, ...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}) });
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    void transport.close().catch(() => undefined);
    stream.end();
  };
  transport.onmessage = (message) => {
    const version = negotiatedVersion(message);
    if (version !== null) transport.setProtocolVersion?.(version);
    if (!closed) stream.write(serializeMessage(message));
  };
  transport.onerror = (error) => {
    deps.logger?.warn?.("boxes: a bridged HTTP MCP server failed a request", {
      boxId: entry.boxId,
      server: entry.name,
      error: error.message
    });
  };
  transport.onclose = close;
  await transport.start();

  const buffer = new ReadBuffer();
  stream.on("data", (chunk: Buffer) => {
    buffer.append(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    for (;;) {
      let message: JSONRPCMessage | null;
      try {
        message = buffer.readMessage();
      } catch {
        // One line that is not JSON-RPC: dropped, as a stdio server would answer nothing to it.
        continue;
      }
      if (message === null) break;
      void transport.send(message).catch((error: unknown) => {
        deps.logger?.warn?.("boxes: a bridged HTTP MCP request could not be sent", {
          boxId: entry.boxId,
          server: entry.name,
          error: error instanceof Error ? error.message : String(error)
        });
        // A request that cannot be sent must still be answered, or the box's CLI waits forever.
        const id = (message as { id?: unknown }).id;
        if ((typeof id === "string" || typeof id === "number") && !closed) {
          stream.write(
            serializeMessage({
              jsonrpc: "2.0",
              id,
              error: { code: -32603, message: `The MCP server "${entry.name}" could not be reached from Orquester.` }
            })
          );
        }
      });
    }
  });
  stream.once("end", close);
  stream.once("close", close);
  stream.once("error", close);
}
