/**
 * Agent host — the HTTP-over-unix-socket API the daemon proxies (spec §3.1,
 * §6.1–§6.3, §8).
 *
 * Plain `node:http`, not Fastify: the §6.3 stream charges its 8 MiB budget on
 * the socket's own `drain`, which means the route needs the raw
 * {@link ServerResponse}. Everything else here is a thin translation of an
 * HTTP request into one orchestrator call.
 *
 * Auth is the 0600 token file, compared in constant time. `GET /health` is
 * answered **only after the command gate opens** (§3.1), so "the socket
 * answers" and "the host can take work" are the same fact — the daemon's probe
 * is the readiness probe.
 */

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmod, mkdir, open, rm, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  AGENT_CHAT_COMMAND_NAMES,
  MAX_TURN_FILE_BYTES,
  type AgentChatCommandName,
  type AgentChatStreamFrame,
  type AgentHostStopResponse,
  type AgentProvidersResponse,
  type RefreshProviderResponse,
  type ThreadItemResponse,
  type TurnDiffResponse
} from "@orquester/api/agent-chat";

import type { AdapterLogger } from "../adapter.ts";
import {
  AGENT_HOST_AUTH_HEADER,
  AGENT_HOST_PROTOCOL_VERSION,
  agentHostRoutes,
  type AgentHostHealthResponse,
  type CreateHostThreadRequest,
  type SetThreadIdentityRequest
} from "../host-protocol.ts";
import type { ThreadStore } from "../services.ts";
import {
  AgentChatCommandError,
  isAgentChatCommandError,
  statusForCode
} from "../orchestration/errors.ts";
import { isAgentAdapterId } from "../adapters/index.ts";
import { redactStderr } from "../support/stderr.ts";
import { DeadlineExceededError, withDeadline } from "../support/deadline.ts";
import type { Orchestrator } from "../orchestration/orchestrator.ts";
import {
  agentHostExtraRoutes,
  type AgentHostThreadSummary,
  type AttachmentPathResponse
} from "./extra-routes.ts";
import { createThreadStream, type ThreadStream } from "./stream.ts";

/** Command bodies are small; §4.1 caps `input` at 120 000 characters. */
const MAX_JSON_BODY_BYTES = 4 * 1024 * 1024;

/**
 * How long `GET /health` waits on the command gate before answering 503.
 * Comfortably inside the daemon's own `AGENT_HOST_PREPARED_TIMEOUT_MS` (120 s)
 * so a slow-but-healthy start still reports ready, while a gate that never
 * opens fails rather than hanging the probe.
 */
const HEALTH_GATE_TIMEOUT_MS = 30_000;

export interface AgentHostServerOptions {
  orchestrator: Orchestrator;
  /**
   * The store, plus the staging dir W2's implementation exposes beyond the
   * `ThreadStore` seam — a `.part` file written there is swept by the §5.1
   * 1 h sweep, one written into `<appdir>/tmp` is swept by nothing.
   */
  store: ThreadStore & { pendingAttachmentsDir?(): string };
  logger: AdapterLogger;
  hostInstanceId: string;
  token: string;
  socketPath: string;
  /** `<appdir>/tmp` — `/tmp` is unavailable under `ProtectSystem=strict`. */
  tmpDir: string;
  /** Collapsed to `~` in any message that leaves the host (§3.1 redaction). */
  homeDirs?: readonly string[];
  /** Exact secrets the host injected, masked wherever they surface. */
  secretLiterals?: readonly string[];
  /**
   * Confines the optional `cwd` of `POST /providers/:id/refresh` (§4.6.4),
   * which otherwise becomes an arbitrary spawn cwd and readdir root.
   */
  isAllowedCwd?(cwd: string): boolean;
  startedAt: string;
  pid?: number;
  /** See `AgentHostHealthResponse.codeStamp`. */
  codeStamp?: string | null;
  /** Called by `POST /stop`: writes the §3.3 markers, then drains and stops. */
  onStop(): Promise<AgentHostStopResponse>;
  /** A watcher handle the provider registry's demand gate counts (§3.2). */
  addProviderWatcher?(): () => void;
}

export interface AgentHostServer {
  listen(): Promise<void>;
  close(): Promise<void>;
  readonly server: Server;
  readonly openStreams: number;
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) {
    // Still compare something of equal length so the failure costs the same.
    const padded = Buffer.alloc(a.length);
    b.copy(padded);
    timingSafeEqual(a, padded);
    return false;
  }
  return timingSafeEqual(a, b);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const declared = Number.parseInt(request.headers["content-length"] ?? "", 10);
  if (Number.isFinite(declared) && declared > MAX_JSON_BODY_BYTES) {
    throw new AgentChatCommandError("INVALID_COMMAND", "Request body is too large.");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.length;
    if (total > MAX_JSON_BODY_BYTES) {
      throw new AgentChatCommandError("INVALID_COMMAND", "Request body is too large.");
    }
    chunks.push(buffer);
  }
  if (total === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new AgentChatCommandError("INVALID_COMMAND", "Request body is not valid JSON.");
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(payload));
  response.end(payload);
}

function sendError(
  response: ServerResponse,
  error: unknown,
  logger: AdapterLogger,
  redact: (message: string) => string,
  hostReady: () => boolean
): void {
  if (isAgentChatCommandError(error)) {
    sendJson(response, statusForCode(error.code), error.toEnvelope());
    return;
  }
  // E9: a deadline is a REFUSAL, not an internal fault. Falling through to the
  // 500 below told the client `COMMAND_REJECTED` with a status that §6.2 gives
  // no retry rule for, so a slow first provider probe looked like a host bug.
  //
  // Which refusal depends on why we were waiting. Before the command gate
  // opens, the host is still booting: §6.2 says `HOST_UNAVAILABLE`, whose
  // contract is "retry the same `commandId` once the host is back", and whose
  // rejection is deliberately NOT recorded as a receipt. After the gate, the
  // host is up and this one step ran out of time, which is a 409 the client
  // may surface and retry as a new command.
  if (error instanceof DeadlineExceededError) {
    const code = hostReady() ? "COMMAND_REJECTED" : "HOST_UNAVAILABLE";
    sendJson(response, statusForCode(code), {
      error: { code, message: redact(error.message) }
    });
    return;
  }
  logger.error("agent-host: unhandled request failure", error);
  sendJson(response, 500, {
    error: {
      code: "COMMAND_REJECTED",
      // An unexpected `ENOENT … '/var/lib/orquester/daemon/agent/threads/<id>/
      // meta.json'` would otherwise reach the browser verbatim: the stderr path
      // collapses home paths and masks token shapes, and this is the one place
      // the redaction boundary was asymmetric.
      message: redact(error instanceof Error ? error.message : "Internal host error.")
    }
  });
}

const COMMAND_NAMES: ReadonlySet<string> = new Set(AGENT_CHAT_COMMAND_NAMES);

/**
 * A thread id becomes a directory name (`threads/<id>/`), the target of a
 * recursive `rm` on delete and the `launch.json` path. The daemon mints UUIDs
 * and gates every per-session route on its own tab record, so nothing
 * reachable violates this today — but the host is a separate process with its
 * own trust boundary, and `[^/]+` in the route regex happily matches a
 * percent-encoded `..`. One guard at the boundary is cheaper than trusting
 * every future caller.
 */
const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSafeThreadId(value: string): boolean {
  return THREAD_ID_PATTERN.test(value) && !value.split(/[/\\]/).includes("..");
}

function parseAfter(url: URL): number | undefined {
  const raw = url.searchParams.get("after");
  if (raw === null) return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) {
    throw new AgentChatCommandError("INVALID_COMMAND", "`after` must be a non-negative integer.");
  }
  return value;
}

export function createAgentHostServer(options: AgentHostServerOptions): AgentHostServer {
  const { orchestrator, store, logger, hostInstanceId, token, socketPath } = options;
  const expectedAuth = `Bearer ${token}`;
  const redactMessage = (message: string): string =>
    redactStderr(message, {
      ...(options.homeDirs !== undefined ? { homeDirs: options.homeDirs } : {}),
      ...(options.secretLiterals !== undefined ? { literals: options.secretLiterals } : {})
    });
  const streams = new Set<ThreadStream>();

  const handleCommand = async (
    response: ServerResponse,
    request: IncomingMessage,
    threadId: string,
    name: AgentChatCommandName
  ): Promise<void> => {
    const body = await readJsonBody(request);
    const receipt = await orchestrator.command(threadId, name, body);
    sendJson(response, 200, receipt);
  };

  const handleAttachmentUpload = async (
    request: IncomingMessage,
    response: ServerResponse,
    threadId: string,
    url: URL
  ): Promise<void> => {
    const name = url.searchParams.get("name");
    if (name === null || name.length === 0) {
      throw new AgentChatCommandError("INVALID_COMMAND", "`name` is required.");
    }
    const mimeType = url.searchParams.get("type") ?? undefined;
    const declared = Number.parseInt(request.headers["content-length"] ?? "", 10);
    // Refused before a byte is read when the declared length is already over.
    if (Number.isFinite(declared) && declared > MAX_TURN_FILE_BYTES) {
      response.setHeader("connection", "close");
      throw new AgentChatCommandError("INVALID_COMMAND", "Attachment exceeds the 50 MiB limit.");
    }
    // The staging file lives in a directory the store's own `.part` sweeper
    // walks, so the 1 h TTL of §5.1 is a real backstop rather than dead
    // configuration — `<appdir>/tmp` is swept by nothing.
    const stagingDir = store.pendingAttachmentsDir?.() ?? options.tmpDir;
    await mkdir(stagingDir, { recursive: true });
    const tempPath = join(
      stagingDir,
      `attachment-${Date.now()}-${Math.random().toString(36).slice(2)}.part`
    );
    // ONE finally covers the whole receive AND the claim: the mid-body cap
    // throw and any client abort both escape the receive, and a temp file left
    // behind by either fills the one writable carve-out the appdir has.
    try {
      const handle = await open(tempPath, "w", 0o600);
      let received = 0;
      try {
        for await (const chunk of request) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
          received += buffer.length;
          if (received > MAX_TURN_FILE_BYTES) {
            response.setHeader("connection", "close");
            throw new AgentChatCommandError(
              "INVALID_COMMAND",
              "Attachment exceeds the 50 MiB limit."
            );
          }
          await handle.write(buffer);
        }
      } finally {
        await handle.close();
      }
      // The bounds that matter are checked by the store against the STAT'd
      // file, not against what the client claimed (§6.3).
      const ref = await store.putAttachment({
        threadId,
        name,
        ...(mimeType !== undefined ? { mimeType } : {}),
        sourcePath: tempPath
      });
      sendJson(response, 200, ref);
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  };

  const route = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://agent-host.localhost");
    const path = url.pathname;
    const method = request.method ?? "GET";

    // ---- auth -------------------------------------------------------------
    const provided = request.headers[AGENT_HOST_AUTH_HEADER];
    const header = Array.isArray(provided) ? provided[0] : provided;
    if (typeof header !== "string" || !constantTimeEquals(header, expectedAuth)) {
      // One identical answer for every failure mode.
      sendJson(response, 401, { error: { code: "COMMAND_REJECTED", message: "Unauthorized." } });
      return;
    }

    // ---- readiness --------------------------------------------------------
    if (path === agentHostRoutes.health && method === "GET") {
      // Answered only after the command gate opens: a bound socket is not
      // readiness (§8). Bounded, though — the server runs with no request
      // timeout so the long-lived stream is never cut, which would otherwise
      // let a host whose gate never opens hang the daemon's readiness probe
      // forever instead of failing it.
      try {
        await withDeadline(orchestrator.ready, {
          timeoutMs: HEALTH_GATE_TIMEOUT_MS,
          label: "agent-host/health"
        });
      } catch (error) {
        sendJson(response, 503, {
          error: {
            code: "HOST_UNAVAILABLE",
            message: redactMessage(
              error instanceof Error ? error.message : "The agent host is not ready."
            )
          }
        });
        return;
      }
      const body: AgentHostHealthResponse = {
        ok: true,
        protocolVersion: AGENT_HOST_PROTOCOL_VERSION,
        hostInstanceId,
        liveThreadIds: orchestrator.liveThreadIds(),
        activeTurnThreadIds: orchestrator.activeTurnThreadIds(),
        pid: options.pid ?? process.pid,
        startedAt: options.startedAt,
        codeStamp: options.codeStamp ?? null,
        providersRevision: orchestrator.providersChangeCount()
      };
      sendJson(response, 200, body);
      return;
    }

    // ---- host-level -------------------------------------------------------
    if (path === agentHostRoutes.providers && method === "GET") {
      const release = options.addProviderWatcher?.();
      // The demand gate counts a read as one tick of interest; the background
      // loop stops again once nothing is watching (§3.2).
      setTimeout(() => release?.(), 60_000).unref?.();
      const body: AgentProvidersResponse = {
        providers: orchestrator.providers(),
        hostInstanceId
      };
      sendJson(response, 200, body);
      return;
    }

    if (path === agentHostRoutes.stop && method === "POST") {
      const body = await options.onStop();
      sendJson(response, 200, body);
      return;
    }

    const refreshMatch = /^\/providers\/([^/]+)\/refresh$/.exec(path);
    if (refreshMatch && method === "POST") {
      const adapterId = decodeURIComponent(refreshMatch[1]!);
      if (!isAgentAdapterId(adapterId)) {
        sendJson(response, 404, {
          error: { code: "THREAD_NOT_FOUND", message: `Unknown adapter '${adapterId}'.` }
        });
        return;
      }
      const requestBody = (await readJsonBody(request)) as { cwd?: unknown };
      const rawCwd = typeof requestBody?.cwd === "string" ? requestBody.cwd : undefined;
      // The cwd becomes a spawn cwd and a `<cwd>/.claude/skills` readdir, so it
      // is confined the way every other path-taking route on this daemon is.
      // An out-of-root value is dropped rather than refused: a machine-level
      // refresh is still a valid answer.
      const cwd = rawCwd !== undefined && options.isAllowedCwd?.(rawCwd) === false
        ? undefined
        : rawCwd;
      const result = await orchestrator.refreshProvider(
        adapterId,
        cwd !== undefined ? { cwd } : undefined
      );
      const body: RefreshProviderResponse = result;
      sendJson(response, 200, body);
      return;
    }

    // ---- thread-level -----------------------------------------------------
    if (path === agentHostRoutes.createThread && method === "POST") {
      const body = (await readJsonBody(request)) as CreateHostThreadRequest;
      const head = await orchestrator.createThread(body);
      sendJson(response, 200, head);
      return;
    }

    const threadMatch = /^\/threads\/([^/]+)(\/.*)?$/.exec(path);
    if (!threadMatch) {
      sendJson(response, 404, {
        error: { code: "THREAD_NOT_FOUND", message: `No route for ${method} ${path}.` }
      });
      return;
    }
    const threadId = decodeURIComponent(threadMatch[1]!);
    if (!isSafeThreadId(threadId)) {
      sendJson(response, 400, {
        error: { code: "INVALID_COMMAND", message: "Malformed thread id." }
      });
      return;
    }
    const rest = threadMatch[2] ?? "";

    if (rest === "") {
      if (method === "DELETE") {
        await orchestrator.deleteThread(threadId);
        sendJson(response, 200, { ok: true });
        return;
      }
      if (method === "PUT") {
        const body = (await readJsonBody(request)) as { title?: unknown; seed?: unknown };
        const title = typeof body?.title === "string" ? body.title : undefined;
        // `seed` = the client's auto-generated first-message title (§7.7), not
        // a rename the user typed. It must stay replaceable by a provider
        // retitle, so it is carried through rather than collapsed into one
        // "the title changed" call.
        const seed = body?.seed === true;
        const receipt = await orchestrator.updateThread(
          threadId,
          title !== undefined ? { title, seed } : {}
        );
        sendJson(response, 200, receipt);
        return;
      }
    }

    // §3.4's account switch. Not in `COMMAND_NAMES`: the daemon owns the
    // client-facing route and calls this with an identity it has already
    // resolved, so nothing here re-reads the accounts store.
    if (rest === "/identity" && method === "POST") {
      const body = (await readJsonBody(request)) as SetThreadIdentityRequest;
      const receipt = await orchestrator.setIdentity(threadId, body);
      sendJson(response, 200, receipt);
      return;
    }

    if (rest === "/thread" && method === "GET") {
      const after = parseAfter(url);
      const body = await orchestrator.readThread(threadId, after);
      sendJson(response, 200, body);
      return;
    }

    if (rest === "/events" && method === "GET") {
      const after = parseAfter(url);
      const releaseWatcher = options.addProviderWatcher?.();
      const stream = createThreadStream({
        response,
        hostInstanceId,
        subscribe: (listener) => orchestrator.subscribe(threadId, { onEvents: listener }),
        read: async (): Promise<AgentChatStreamFrame[]> => {
          const read = await orchestrator.readThread(threadId, after);
          if (read.kind === "snapshot") {
            return [{ kind: "snapshot", thread: read.thread }];
          }
          return read.events.map((event) => ({
            kind: "event" as const,
            seq: event.seq,
            event
          }));
        },
        onClose: () => {
          streams.delete(stream);
          releaseWatcher?.();
        }
      });
      streams.add(stream);
      await stream.start();
      return;
    }

    if (rest === "/summary" && method === "GET") {
      const summary = orchestrator.summary(threadId);
      if (!summary) {
        // The thread exists but nothing is loaded yet: read it first.
        await orchestrator.readThread(threadId);
      }
      // `pendingRequests` is always present, even for a thread that answered
      // nothing: the daemon iterates it without a guard.
      const body: AgentHostThreadSummary = orchestrator.summary(threadId) ?? {
        pendingRequests: []
      };
      sendJson(response, 200, body);
      return;
    }

    const diffMatch = /^\/turns\/(\d+)\/diff$/.exec(rest);
    if (diffMatch && method === "GET") {
      const turnCount = Number.parseInt(diffMatch[1]!, 10);
      const ignoreWhitespace = url.searchParams.get("ignoreWhitespace") !== "0";
      const result = await orchestrator.readTurnDiff(threadId, turnCount, { ignoreWhitespace });
      if (!result) {
        sendJson(response, 404, {
          error: { code: "THREAD_NOT_FOUND", message: `No checkpoint for turn ${turnCount}.` }
        });
        return;
      }
      const body: TurnDiffResponse = result;
      sendJson(response, 200, body);
      return;
    }

    const itemMatch = /^\/items\/([^/]+)$/.exec(rest);
    if (itemMatch && method === "GET") {
      const itemId = decodeURIComponent(itemMatch[1]!);
      const item = await orchestrator.readItem(threadId, itemId);
      if (!item) {
        sendJson(response, 404, {
          error: { code: "THREAD_NOT_FOUND", message: `No item '${itemId}'.` }
        });
        return;
      }
      const body: ThreadItemResponse = { item };
      sendJson(response, 200, body);
      return;
    }

    if (rest === "/attachments" && method === "POST") {
      await handleAttachmentUpload(request, response, threadId, url);
      return;
    }

    const attachmentMatch = /^\/attachments\/([^/]+)$/.exec(rest);
    if (attachmentMatch && method === "GET") {
      const attachmentId = decodeURIComponent(attachmentMatch[1]!);
      try {
        const body: AttachmentPathResponse = {
          path: await store.resolveAttachment(threadId, attachmentId)
        };
        sendJson(response, 200, body);
      } catch {
        sendJson(response, 404, {
          error: { code: "THREAD_NOT_FOUND", message: `No attachment '${attachmentId}'.` }
        });
      }
      return;
    }

    const commandName = rest.slice(1);
    if (method === "POST" && COMMAND_NAMES.has(commandName)) {
      await handleCommand(response, request, threadId, commandName as AgentChatCommandName);
      return;
    }

    sendJson(response, 404, {
      error: { code: "THREAD_NOT_FOUND", message: `No route for ${method} ${path}.` }
    });
  };

  // Mirrors the command gate for the error mapping: `orchestrator.ready` is a
  // promise, and `sendError` runs synchronously on a failed request.
  let hostReady = false;
  void orchestrator.ready.then(
    () => {
      hostReady = true;
    },
    () => {
      // A failed gate is not readiness; every command answers with the gate's
      // own error anyway.
    }
  );

  const server = createServer((request, response) => {
    void route(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        try {
          response.end();
        } catch {
          // Already gone.
        }
        logger.warn("agent-host: request failed after headers were sent", error);
        return;
      }
      sendError(response, error, logger, redactMessage, () => hostReady);
    });
  });
  // The stream keeps its own heartbeat; a socket that goes quiet is the
  // client's business, not the host's.
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;
  server.requestTimeout = 0;

  return {
    server,
    get openStreams() {
      return streams.size;
    },
    async listen(): Promise<void> {
      if (!socketPath.startsWith("\\\\.\\pipe\\")) {
        await mkdir(dirname(socketPath), { recursive: true });
        // A stale socket from a host that died without cleaning up would make
        // `listen` fail with EADDRINUSE; the daemon has already established
        // that nothing answers on it.
        await unlink(socketPath).catch(() => undefined);
      }
      // `chmod` after `listen` leaves a window where the socket carries umask
      // perms (`srwxr-xr-x` at the usual 022) and another local user can
      // `connect()`. They would still need the 0600 token, but the window is
      // avoidable: create it under a 0077 umask and restore afterwards.
      const previousUmask =
        typeof process.umask === "function" ? process.umask(0o077) : undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(socketPath, () => {
            server.off("error", reject);
            resolve();
          });
        });
      } finally {
        if (previousUmask !== undefined) {
          process.umask(previousUmask);
        }
      }
      if (!socketPath.startsWith("\\\\.\\pipe\\")) {
        await chmod(socketPath, 0o600).catch(() => undefined);
      }
    },
    async close(): Promise<void> {
      for (const stream of [...streams]) {
        stream.close("host");
      }
      streams.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Long-lived NDJSON responses would otherwise hold `close()` open, the
        // same reason the daemon calls `closeAllConnections` on shutdown.
        server.closeAllConnections?.();
      });
      if (!socketPath.startsWith("\\\\.\\pipe\\")) {
        await unlink(socketPath).catch(() => undefined);
      }
    }
  };
}
