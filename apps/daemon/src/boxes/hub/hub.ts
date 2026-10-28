/**
 * The daemon's side of every box link (`BoxHub`, contracts.ts): accepts the
 * connect WebSocket, authenticates the box's `hello`, runs the version
 * handshake, and keeps one `BoxConnection` per box valid across reconnects.
 * Box → host requests and box-opened channels go to the registered handlers.
 * Each box that has connected gets a local relay socket for the agent host.
 *
 * Never logs a control frame's params, env or results, nor any token.
 */

import { EventEmitter } from "node:events";
import { Duplex } from "node:stream";

import {
  BOX_HEARTBEAT_MS,
  BOX_PROTOCOL_VERSION,
  boxAgentPlatform,
  boxPathMapFor,
  boxRoutes,
  parseControlMessage,
  type BoxAgentConfig,
  type BoxAuth,
  type BoxBoxToHostMethods,
  type BoxChannelSpec,
  type BoxHello,
  type BoxMethodName,
  type BoxReject,
  type BoxRejectCode,
  type BoxWelcome
} from "@orquester/api";
import { boxSocketPath, type StoredBox } from "@orquester/config";
import type { WebSocket } from "ws";

import { DEFAULT_REQUEST_TIMEOUT_MS, LinkedBoxConnection, channelDuplex } from "../client/connection.ts";
import { BoxError, BoxMux, type MuxChannel } from "../client/mux.ts";
import type {
  BoxChannelHandler,
  BoxConnection,
  BoxForwardOutcome,
  BoxHub,
  BoxRawRequestHandler,
  BoxRequestContext,
  BoxRequestHandler,
  VerifyGithubOidc
} from "../contracts.ts";
import { githubOidcAudience, parseGithubOidcAuthorization } from "../github/oidc.ts";
import { boxIdOfSecret, hashSecret, mintBoxSecret, secretMatches, unverifiedJwtAudience } from "./auth.ts";
import type { BoxAgentBuilds } from "./builds.ts";
import { BoxRelayServer } from "./relay.ts";

/** Box records as the hub needs them (implemented by boxes/service over boxes.json). */
export interface BoxRecordStore {
  get(boxId: string): StoredBox | undefined;
  /** Apply `mutate` to the stored record and persist it; rejects when the record is gone or `mutate` throws. */
  update(boxId: string, mutate: (record: StoredBox) => void): Promise<StoredBox>;
}

export interface BoxHubLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface BoxHubDeps {
  appdir: string;
  records: BoxRecordStore;
  verifyGithubOidc: VerifyGithubOidc;
  /** The daemon URLs boxes dial (public URL, tailnet URL); their origins are the accepted OIDC audiences. */
  daemonUrls: () => string[];
  /** Source of `orq-agent` builds for the version handshake; null skips the handshake. */
  builds: BoxAgentBuilds | null;
  /** False refuses every box with BOXES_DISABLED (plugin off). Default: enabled. */
  enabled?: () => boolean;
  now?: () => number;
  logger?: BoxHubLogger;
  /** Heartbeat interval sent in `welcome` and used for the daemon's own pings. */
  heartbeatMs?: number;
  /** Per-box relay sockets (default true). */
  relay?: boolean;
}

/** The hub plus what the routes need. */
export interface BoxHubServer extends BoxHub {
  /** Serve one connect WebSocket (listeners are attached synchronously). */
  acceptWebSocket(socket: WebSocket): void;
  /** Box auth for the agent-binary route: `Bearer <bootstrap|credential>` or `GitHubOIDC <jwt>` + `X-Orq-Box-Id`. */
  authorizeDownload(headers: Record<string, string | string[] | undefined>): Promise<{ boxId: string } | null>;
  readonly builds: BoxAgentBuilds | null;
  /**
   * Drop every live link (the plugin was turned off). The boxes keep running and keep redialling;
   * `enabled` decides whether they are let back in (else their hello gets `BOXES_DISABLED`).
   */
  disconnectAll(reason: string): void;
  close(): Promise<void>;
}

const HELLO_TIMEOUT_MS = 30_000;
/**
 * Largest WebSocket message a box may send before its hello is authenticated
 * (a hello is a few KiB): an unauthenticated peer cannot make the daemon buffer
 * the ws default of 100 MiB per message.
 */
export const BOX_PRE_AUTH_MAX_MESSAGE_BYTES = 64 * 1024;
/**
 * Largest message on an authenticated link: data frames are at most
 * BOX_MAX_FRAME_PAYLOAD + 5 bytes; control frames (a large `fs.readdir`
 * answer) get what orq-agent itself accepts from the daemon.
 */
export const BOX_LINK_MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
/** Frames a box may send after its hello and before the welcome (orq-agent sends none). */
const EARLY_MAX_BYTES = 64 * 1024;
const OIDC_TIMEOUT_MS = 30_000;
const UPDATE_TIMEOUT_MS = 5 * 60_000;
/** WebSocket close codes the hub uses. */
const CLOSE_REPLACED = 4000;
const CLOSE_REVOKED = 4001;
const CLOSE_PROTOCOL = 1002;
const CLOSE_POLICY = 1008;
const CLOSE_HEARTBEAT = 4002;

const noopLogger: BoxHubLogger = { info: () => undefined, warn: () => undefined };

type AuthResult = { ok: true; boxId: string; record: StoredBox; credential?: string } | { ok: false; code: BoxRejectCode; message: string };

interface LiveLink {
  socket: WebSocket;
  mux: BoxMux;
  heartbeat: NodeJS.Timeout;
}

function rawDataToBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Set the largest message `socket` accepts from now on. The daemon registers
 * one `@fastify/websocket` server for every route, so the limit is per socket:
 * ws keeps it on the socket's receiver, which checks each frame's announced
 * length before buffering it (and closes with 1009 when it is too long).
 */
function limitMessageBytes(socket: WebSocket, bytes: number): void {
  const receiver = (socket as unknown as { _receiver?: { _maxPayload?: unknown } })._receiver;
  if (receiver && typeof receiver._maxPayload === "number") receiver._maxPayload = bytes;
}

export function createBoxHub(deps: BoxHubDeps): BoxHubServer {
  const logger = deps.logger ?? noopLogger;
  const now = deps.now ?? Date.now;
  const heartbeatMs = deps.heartbeatMs ?? BOX_HEARTBEAT_MS;
  const relayEnabled = deps.relay ?? true;

  const connections = new Map<string, LinkedBoxConnection>();
  const links = new Map<string, LiveLink>();
  const relays = new Map<string, BoxRelayServer>();
  const forwards = new Map<string, BoxAgentConfig["forwards"]>();
  const revoked = new Set<string>();
  const requestHandlers = new Map<string, BoxRawRequestHandler>();
  const channelHandlers = new Map<string, BoxChannelHandler>();
  const changes = new EventEmitter();
  changes.setMaxListeners(0);
  let closed = false;

  const context = (boxId: string): BoxRequestContext => {
    const record = deps.records.get(boxId);
    if (!record) throw new BoxError("BOX_UNKNOWN", "The box record is gone");
    return { boxId, record };
  };

  const audiences = (): string[] => {
    const out = new Set<string>();
    for (const url of deps.daemonUrls()) {
      try {
        out.add(githubOidcAudience(url));
      } catch {
        // A malformed configured URL is not an audience.
      }
    }
    return [...out];
  };

  const verifyOidc = async (boxId: string, jwt: string): Promise<AuthResult> => {
    const record = deps.records.get(boxId);
    if (!record) return { ok: false, code: "AUTH_FAILED", message: "Unknown box" };
    if (record.state === "destroyed" || revoked.has(boxId)) return { ok: false, code: "BOX_DESTROYED", message: "This box was destroyed" };
    const ref = record.providerRef ?? {};
    const repository = typeof ref.repository === "string" ? ref.repository : null;
    const runId = ref.runId === undefined || ref.runId === null ? null : String(ref.runId);
    if (!repository || !runId) return { ok: false, code: "AUTH_FAILED", message: "This box has no GitHub dispatch to check against" };
    const claimed = unverifiedJwtAudience(jwt) ?? [];
    const audience = audiences().find((candidate) => claimed.includes(candidate));
    if (!audience) return { ok: false, code: "AUTH_FAILED", message: "The OIDC token is for another audience" };
    const verdict = await deps.verifyGithubOidc(jwt, { repository, runId, audience }, { signal: AbortSignal.timeout(OIDC_TIMEOUT_MS), now });
    if (!verdict.ok) return { ok: false, code: "AUTH_FAILED", message: `GitHub OIDC: ${verdict.message}` };
    return { ok: true, boxId, record };
  };

  const authenticate = async (auth: BoxAuth): Promise<AuthResult> => {
    switch (auth?.kind) {
      case "bootstrap": {
        const token = typeof auth.token === "string" ? auth.token : "";
        const boxId = boxIdOfSecret(token);
        const record = boxId ? deps.records.get(boxId) : undefined;
        if (!boxId || !record) return { ok: false, code: "AUTH_FAILED", message: "Unknown bootstrap token" };
        if (record.state === "destroyed" || revoked.has(boxId)) return { ok: false, code: "BOX_DESTROYED", message: "This box was destroyed" };
        const expected = record.bootstrapTokenHash;
        if (!secretMatches(token, expected)) return { ok: false, code: "AUTH_FAILED", message: "Invalid or already used bootstrap token" };
        const expires = record.bootstrapExpiresAt ? Date.parse(record.bootstrapExpiresAt) : NaN;
        if (!Number.isFinite(expires) || expires <= now()) return { ok: false, code: "AUTH_FAILED", message: "The bootstrap token expired" };
        const credential = mintBoxSecret(boxId);
        try {
          // Single use: consume it in the same write that stores the credential.
          const updated = await deps.records.update(boxId, (r) => {
            if (r.bootstrapTokenHash !== expected) throw new BoxError("AUTH_FAILED", "The bootstrap token was used concurrently");
            r.credentialHash = hashSecret(credential);
            delete r.bootstrapTokenHash;
            delete r.bootstrapExpiresAt;
          });
          return { ok: true, boxId, record: updated, credential };
        } catch {
          return { ok: false, code: "AUTH_FAILED", message: "Invalid or already used bootstrap token" };
        }
      }
      case "credential": {
        const boxId = typeof auth.boxId === "string" ? auth.boxId : "";
        const credential = typeof auth.credential === "string" ? auth.credential : "";
        const record = boxId ? deps.records.get(boxId) : undefined;
        if (!record || boxIdOfSecret(credential) !== boxId) return { ok: false, code: "AUTH_FAILED", message: "Invalid box credential" };
        if (record.state === "destroyed" || revoked.has(boxId)) return { ok: false, code: "BOX_DESTROYED", message: "This box was destroyed" };
        if (!secretMatches(credential, record.credentialHash)) return { ok: false, code: "AUTH_FAILED", message: "Invalid box credential" };
        return { ok: true, boxId, record };
      }
      case "github-oidc": {
        const boxId = typeof auth.boxId === "string" ? auth.boxId : "";
        const jwt = typeof auth.jwt === "string" ? auth.jwt : "";
        if (!boxId || !jwt) return { ok: false, code: "AUTH_FAILED", message: "Missing OIDC token" };
        try {
          return await verifyOidc(boxId, jwt);
        } catch (error) {
          return { ok: false, code: "AUTH_FAILED", message: `GitHub OIDC check failed: ${(error as Error).message}` };
        }
      }
      default:
        return { ok: false, code: "AUTH_FAILED", message: "Unknown authentication kind" };
    }
  };

  const ensureRelay = async (boxId: string, connection: LinkedBoxConnection): Promise<void> => {
    if (!relayEnabled || relays.has(boxId) || closed) return;
    const relay = new BoxRelayServer(boxId, connection, boxSocketPath(deps.appdir, boxId), logger);
    relays.set(boxId, relay);
    try {
      await relay.start();
    } catch (error) {
      relays.delete(boxId);
      logger.warn("box relay socket could not start", { boxId, error: (error as Error).message });
    }
  };

  const touchRecord = (boxId: string, hello: BoxHello | null): void => {
    deps.records
      .update(boxId, (record) => {
        record.lastSeenAt = new Date(now()).toISOString();
        if (hello) {
          record.os = hello.sys.os;
          record.arch = hello.sys.arch;
          record.libc = hello.sys.libc;
        }
      })
      .catch((error: Error) => logger.warn("could not update the box record", { boxId, error: error.message }));
  };

  const serveBoxRequest = async (boxId: string, method: string, params: unknown, signal: AbortSignal): Promise<unknown> => {
    const handler = requestHandlers.get(method);
    if (!handler) throw new BoxError("UNKNOWN_METHOD", `Unknown method ${method}`);
    return handler(context(boxId), params, signal);
  };

  const serveBoxChannel = (boxId: string, spec: BoxChannelSpec): ((channel: MuxChannel) => void) | null => {
    const handler = channelHandlers.get(spec?.kind);
    if (!handler) return null;
    let ctx: BoxRequestContext;
    try {
      ctx = context(boxId);
    } catch {
      return null;
    }
    return (channel) => {
      const stream: Duplex = channelDuplex(channel);
      try {
        handler(ctx, spec, stream);
      } catch (error) {
        logger.warn("box channel handler failed", { boxId, kind: spec.kind, error: (error as Error).message });
        stream.destroy();
      }
    };
  };

  const dropLink = (boxId: string, link: LiveLink): void => {
    clearInterval(link.heartbeat);
    if (links.get(boxId) === link) {
      links.delete(boxId);
      const connection = connections.get(boxId);
      if (connection?.currentLinkIs(link.mux)) {
        connection.detachLink(link.mux);
        changes.emit("change", boxId, false);
      }
      touchRecord(boxId, null);
    }
    // Only now fail the link's channels: everyone (the relay's clients too)
    // already knows the box is away, so a detached process's viewer that
    // loses its channel waits for the reconnect instead of reattaching into
    // a link that is not there.
    link.mux.shutdown();
  };

  const reject = (socket: WebSocket, code: BoxRejectCode, message: string, upgradeUrl?: string): void => {
    const frame: BoxReject = upgradeUrl ? { t: "reject", code, message, upgradeUrl } : { t: "reject", code, message };
    try {
      socket.send(JSON.stringify(frame));
      socket.close(CLOSE_POLICY, code);
    } catch {
      socket.terminate();
    }
  };

  /** Version handshake: ask an outdated agent to update; true = keep serving this link. */
  const handshakeVersion = async (boxId: string, hello: BoxHello, mux: BoxMux, socket: WebSocket): Promise<boolean> => {
    if (!deps.builds) return true;
    let current: { version: string } | null = null;
    try {
      current = await deps.builds.current();
    } catch (error) {
      logger.warn("orq-agent builds unavailable", { error: (error as Error).message });
    }
    if (!current || current.version === hello.agentVersion) return true;
    const platform = boxAgentPlatform(hello.sys.os, hello.sys.arch, hello.sys.libc);
    const build = await deps.builds.resolve(platform).catch(() => null);
    const url = boxRoutes.agentBinary(platform);
    if (!build) {
      logger.warn("no orq-agent build for an outdated box; serving it as is", { boxId, platform });
      return true;
    }
    try {
      await mux.request("agent.update", { url, sha256: build.sha256 }, { timeoutMs: UPDATE_TIMEOUT_MS });
      logger.info("orq-agent updating", { boxId, from: hello.agentVersion, to: build.version });
      // The agent restarts; the link drops and comes back with the new version.
      return false;
    } catch (error) {
      if ((error as BoxError).code === "BUSY") {
        // Detached processes are running: the protocol is compatible, so serve
        // it now; the agent applies the update once they end.
        logger.info("orq-agent update deferred by the box", { boxId });
        return true;
      }
      logger.warn("orq-agent update failed", { boxId, code: (error as BoxError).code });
      reject(socket, "AGENT_OUTDATED", "This orq-agent is outdated and could not update itself", url);
      return false;
    }
  };

  const establish = async (socket: WebSocket, hello: BoxHello, auth: Extract<AuthResult, { ok: true }>, early: (Buffer | string)[], feed: { target: ((data: Buffer, binary: boolean) => void) | null }): Promise<void> => {
    const { boxId } = auth;
    // Authentication awaited (a GitHub OIDC check, a record write): the box
    // may have been revoked or destroyed meanwhile. Check again, synchronously
    // with linking it.
    const current = deps.records.get(boxId);
    if (closed || revoked.has(boxId) || !current || current.state === "destroyed") {
      logger.warn("box connection refused", { code: "BOX_DESTROYED", auth: hello.auth?.kind });
      reject(socket, "BOX_DESTROYED", "This box was destroyed");
      if (auth.credential && current) {
        // The credential minted for this connect must not outlive the revoke.
        const minted = hashSecret(auth.credential);
        await deps.records
          .update(boxId, (record) => {
            if (record.credentialHash === minted) delete record.credentialHash;
          })
          .catch((error: Error) => logger.warn("could not clear the box credentials", { boxId, error: error.message }));
      }
      return;
    }
    limitMessageBytes(socket, BOX_LINK_MAX_MESSAGE_BYTES);
    const previous = links.get(boxId);
    if (previous) {
      // A new connection for the same box replaces the old one.
      previous.socket.close(CLOSE_REPLACED, "replaced by a newer connection");
      dropLink(boxId, previous);
    }
    const paths = boxPathMapFor(hello.sys.os);
    const welcome: BoxWelcome = {
      t: "welcome",
      boxId,
      ...(auth.credential ? { credential: auth.credential } : {}),
      config: { paths, heartbeatMs, forwards: forwards.get(boxId) ?? [] }
    };
    socket.send(JSON.stringify(welcome));

    let connection = connections.get(boxId);
    const mux = new BoxMux(
      {
        sendText: (text) => {
          if (socket.readyState === socket.OPEN) socket.send(text);
        },
        sendBinary: (frame) => {
          if (socket.readyState === socket.OPEN) socket.send(frame);
        }
      },
      {
        onRequest: (method, params, signal) => serveBoxRequest(boxId, method, params, signal),
        onChannel: (spec) => serveBoxChannel(boxId, spec),
        onEvent: (name, data) => connections.get(boxId)?.emitEvent(name, data)
      }
    );
    let lastSeen = now();
    const link: LiveLink = {
      socket,
      mux,
      heartbeat: setInterval(() => {
        if (now() - lastSeen > 3 * heartbeatMs) {
          logger.warn("box link silent; closing it", { boxId });
          socket.close(CLOSE_HEARTBEAT, "heartbeat timeout");
          socket.terminate();
          return;
        }
        mux.sendControl({ t: "ping", id: now() });
      }, heartbeatMs)
    };
    link.heartbeat.unref?.();
    links.set(boxId, link);
    feed.target = (data, binary) => {
      lastSeen = now();
      if (binary) {
        mux.receiveBinary(data);
        return;
      }
      const message = parseControlMessage(data.toString("utf8"));
      if (!message) {
        socket.close(CLOSE_PROTOCOL, "malformed control frame");
        return;
      }
      if (message.t === "hello" || message.t === "welcome" || message.t === "reject") return;
      mux.receiveControl(message);
    };
    socket.on("close", () => dropLink(boxId, link));
    for (const frame of early.splice(0)) feed.target(Buffer.isBuffer(frame) ? frame : Buffer.from(frame), Buffer.isBuffer(frame));

    if (!(await handshakeVersion(boxId, hello, mux, socket))) return;
    if (links.get(boxId) !== link) return;

    const info = { sys: hello.sys, paths, agentVersion: hello.agentVersion, procs: hello.procs ?? [] };
    if (!connection) {
      connection = new LinkedBoxConnection(boxId, info, { replay: true });
      connections.set(boxId, connection);
    }
    connection.attachLink(mux, info);
    touchRecord(boxId, hello);
    logger.info("box connected", { boxId, agentVersion: hello.agentVersion, auth: hello.auth.kind });
    changes.emit("change", boxId, true);
    await ensureRelay(boxId, connection);
  };

  const hub: BoxHubServer = {
    builds: deps.builds,

    acceptWebSocket(socket) {
      if (closed) {
        socket.close(1001, "daemon shutting down");
        return;
      }
      // Nothing large is accepted until the hello is authenticated.
      limitMessageBytes(socket, BOX_PRE_AUTH_MAX_MESSAGE_BYTES);
      // Frames that arrive while the hello is being authenticated are kept
      // in order (up to EARLY_MAX_BYTES) and handed to the link once it exists.
      const early: (Buffer | string)[] = [];
      let earlyBytes = 0;
      const feed: { target: ((data: Buffer, binary: boolean) => void) | null } = { target: null };
      let gotHello = false;
      const helloTimer = setTimeout(() => {
        if (!gotHello) socket.close(CLOSE_POLICY, "no hello");
      }, HELLO_TIMEOUT_MS);
      helloTimer.unref?.();
      socket.on("error", () => undefined);
      socket.on("close", () => clearTimeout(helloTimer));
      socket.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
        const buffer = rawDataToBuffer(data);
        if (feed.target) {
          feed.target(buffer, isBinary);
          return;
        }
        if (gotHello) {
          earlyBytes += buffer.byteLength;
          if (earlyBytes > EARLY_MAX_BYTES) {
            early.length = 0;
            socket.close(CLOSE_POLICY, "too much data before the welcome");
            return;
          }
          early.push(isBinary ? buffer : buffer.toString("utf8"));
          return;
        }
        gotHello = true;
        clearTimeout(helloTimer);
        const hello = isBinary ? null : parseControlMessage(buffer.toString("utf8"));
        if (!hello || hello.t !== "hello" || typeof hello.sys !== "object" || hello.sys === null) {
          socket.close(CLOSE_PROTOCOL, "expected hello");
          return;
        }
        if (hello.protocol !== BOX_PROTOCOL_VERSION) {
          reject(socket, "PROTOCOL_MISMATCH", `The daemon speaks box protocol ${BOX_PROTOCOL_VERSION}`);
          return;
        }
        if (deps.enabled && !deps.enabled()) {
          reject(socket, "BOXES_DISABLED", "The Ephemeral AI VMs plugin is disabled");
          return;
        }
        void authenticate(hello.auth)
          .then(async (result) => {
            if (socket.readyState !== socket.OPEN) return;
            if (!result.ok) {
              logger.warn("box connection refused", { code: result.code, auth: hello.auth?.kind });
              reject(socket, result.code, result.message);
              return;
            }
            await establish(socket, hello, result, early, feed);
          })
          .catch((error: Error) => {
            logger.warn("box connection failed", { error: error.message });
            socket.terminate();
          });
      });
    },

    async authorizeDownload(headers) {
      const authorization = headerValue(headers.authorization);
      if (!authorization) return null;
      const oidc = parseGithubOidcAuthorization(authorization, headerValue(headers["x-orq-box-id"]));
      if (oidc) {
        const result = await verifyOidc(oidc.boxId, oidc.jwt).catch(() => null);
        return result?.ok ? { boxId: result.boxId } : null;
      }
      const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
      if (!match) return null;
      const secret = match[1]!;
      const boxId = boxIdOfSecret(secret);
      const record = boxId ? deps.records.get(boxId) : undefined;
      if (!boxId || !record || record.state === "destroyed" || revoked.has(boxId)) return null;
      if (secretMatches(secret, record.credentialHash)) return { boxId };
      // The bootstrap token also downloads (the bootstrap script fetches the
      // agent before its first connect); downloading does not consume it.
      const expires = record.bootstrapExpiresAt ? Date.parse(record.bootstrapExpiresAt) : NaN;
      if (secretMatches(secret, record.bootstrapTokenHash) && Number.isFinite(expires) && expires > now()) return { boxId };
      return null;
    },

    get(boxId) {
      return connections.get(boxId);
    },

    waitConnected(boxId, options = {}) {
      const existing = connections.get(boxId);
      if (existing?.connected) return Promise.resolve(existing as BoxConnection);
      return new Promise((resolve, rejectWait) => {
        const cleanup = (): void => {
          changes.off("change", onChange);
          if (timer) clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
        };
        const onChange = (id: string, connected: boolean): void => {
          const connection = connections.get(id);
          if (id !== boxId || !connected || !connection) return;
          cleanup();
          resolve(connection);
        };
        const onAbort = (): void => {
          cleanup();
          rejectWait(new BoxError("ABORTED", "Aborted"));
        };
        const timer =
          options.timeoutMs !== undefined
            ? setTimeout(() => {
                cleanup();
                rejectWait(new BoxError("BOX_CONNECT_TIMEOUT", `Box ${boxId} did not connect within ${options.timeoutMs} ms`));
              }, options.timeoutMs)
            : null;
        if (options.signal?.aborted) {
          onAbort();
          return;
        }
        options.signal?.addEventListener("abort", onAbort, { once: true });
        changes.on("change", onChange);
      });
    },

    async issueBootstrapToken(boxId, ttlMs) {
      const token = mintBoxSecret(boxId);
      await deps.records.update(boxId, (record) => {
        record.bootstrapTokenHash = hashSecret(token);
        record.bootstrapExpiresAt = new Date(now() + ttlMs).toISOString();
      });
      revoked.delete(boxId);
      return token;
    },

    async revoke(boxId) {
      revoked.add(boxId);
      const link = links.get(boxId);
      if (link) {
        link.socket.close(CLOSE_REVOKED, "box revoked");
        dropLink(boxId, link);
      }
      const relay = relays.get(boxId);
      relays.delete(boxId);
      await relay?.close();
      const connection = connections.get(boxId);
      connections.delete(boxId);
      connection?.rejectWaiters(new BoxError("BOX_DESTROYED", "The box was revoked"));
      forwards.delete(boxId);
      if (deps.records.get(boxId)) {
        await deps.records
          .update(boxId, (record) => {
            delete record.credentialHash;
            delete record.bootstrapTokenHash;
            delete record.bootstrapExpiresAt;
          })
          .catch((error: Error) => logger.warn("could not clear the box credentials", { boxId, error: error.message }));
      }
    },

    async setForwards(boxId, next) {
      const previous = forwards.get(boxId) ?? [];
      forwards.set(boxId, next.map((f) => ({ ...f })));
      // Sent on the link itself, not through the connection: the welcome's list re-establishes the
      // forwards on a reconnect, so the connection must not replay them (a removed one would return).
      const mux = connections.get(boxId)?.currentMux();
      if (!mux) return [];
      const options = { timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS };
      const nextPorts = new Set(next.map((f) => f.boxPort));
      const changed = next.filter((spec) => previous.find((f) => f.boxPort === spec.boxPort)?.target !== spec.target);
      // Unlistened first: a new forward may take a port just given up.
      await Promise.all(
        previous.filter((old) => !nextPorts.has(old.boxPort)).map((old) => mux.request("forward.unlisten", { boxPort: old.boxPort }, options).catch(() => undefined))
      );
      return await Promise.all(
        changed.map(async (spec): Promise<BoxForwardOutcome> => {
          try {
            await mux.request("forward.listen", spec, options);
            return { boxPort: spec.boxPort, error: null };
          } catch (error) {
            logger.warn("forward.listen failed", { boxId, boxPort: spec.boxPort, error: (error as Error).message });
            return { boxPort: spec.boxPort, error: error as BoxError };
          }
        })
      );
    },

    handle<K extends BoxMethodName<BoxBoxToHostMethods>>(method: K, handler: BoxRequestHandler<K>) {
      requestHandlers.set(method, handler as unknown as BoxRawRequestHandler);
    },

    handleRaw(method, handler) {
      requestHandlers.set(method, handler);
    },

    handleChannel(kind, handler) {
      channelHandlers.set(kind, handler);
    },

    onConnectionChange(listener) {
      changes.on("change", listener);
      return () => changes.off("change", listener);
    },

    disconnectAll(reason) {
      for (const [boxId, link] of [...links]) {
        // A plain close: the box redials and its next hello gets the BOXES_DISABLED reject.
        link.socket.close(CLOSE_POLICY, reason.slice(0, 120));
        dropLink(boxId, link);
      }
    },

    async close() {
      closed = true;
      for (const [boxId, link] of [...links]) {
        link.socket.close(1001, "daemon shutting down");
        dropLink(boxId, link);
      }
      await Promise.all([...relays.values()].map((relay) => relay.close()));
      relays.clear();
    }
  };
  return hub;
}
