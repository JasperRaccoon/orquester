/**
 * The daemon end of every `orq-<name>` alias's ProxyCommand (spec 2026-11-22 §4.3): a Unix socket
 * (`sshProxySocketPath`, 0600) where `ssh-proxy-helper.mjs` writes one {@link SshProxyRequest}
 * line, reads one {@link SshProxyResponse} line, and then carries raw SSH bytes. The decision and
 * the upstream (an `ssh` channel to orq-agent's built-in server, or `openTcp(22)` to the box's
 * sshd) are the caller's (`open`); this module only frames, answers and pipes.
 *
 * Like the box relay sockets, it is unauthenticated local control (spec §7.3): mode 0600 in the
 * appdir, so only the daemon's user reaches it. A stale socket file from a crash is replaced.
 */

import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import type { Duplex } from "node:stream";

import { SSH_PROXY_PROTOCOL_VERSION, type SshProxyErrorCode, type SshProxyRequest, type SshProxyResponse } from "@orquester/api";

/** Longest first line accepted (a request is well under 300 bytes). */
const MAX_REQUEST_BYTES = 4096;
/** How long a client may take to send its first line before it is dropped. */
const REQUEST_TIMEOUT_MS = 10_000;

export type SshProxyOutcome =
  | { ok: true; via: "ssh-server" | "sshd"; stream: Duplex }
  | { ok: false; code: SshProxyErrorCode; message: string; fix?: string };

export interface SshProxyServerOptions {
  socketPath: string;
  /** Authorize the request and open its upstream. Must not throw (a throw answers `SSH_UNAVAILABLE`). */
  open(request: SshProxyRequest): Promise<SshProxyOutcome>;
  logger?: { warn(message: string, meta?: Record<string, unknown>): void };
}

const ALIAS = /^[a-z0-9][a-z0-9-]{0,80}$/;
const THREAD = /^[A-Za-z0-9._-]{1,128}$/;

/** A request line as the helper writes it; null for anything else. */
export function parseSshProxyRequest(line: string): SshProxyRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== SSH_PROXY_PROTOCOL_VERSION || typeof record.alias !== "string" || !ALIAS.test(record.alias)) return null;
  if (record.threadId !== undefined && (typeof record.threadId !== "string" || !THREAD.test(record.threadId))) return null;
  return { v: SSH_PROXY_PROTOCOL_VERSION, alias: record.alias, ...(typeof record.threadId === "string" ? { threadId: record.threadId } : {}) };
}

export class SshProxyServer {
  private server: Server | null = null;
  private readonly clients = new Set<Socket>();

  constructor(private readonly options: SshProxyServerOptions) {}

  async start(): Promise<void> {
    const { socketPath } = this.options;
    await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
    try {
      const info = await lstat(socketPath);
      if (!info.isSocket()) throw new Error(`${socketPath} exists and is not a socket`);
      await unlink(socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const server = createServer({ allowHalfOpen: true }, (socket) => this.serve(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(socketPath, 0o600);
    server.on("error", (error) => this.options.logger?.warn("agent SSH proxy socket error", { error: error.message }));
    this.server = server;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const client of [...this.clients]) client.destroy();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(this.options.socketPath).catch(() => undefined);
  }

  private serve(socket: Socket): void {
    this.clients.add(socket);
    socket.once("close", () => this.clients.delete(socket));
    socket.on("error", () => socket.destroy());
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => socket.destroy(), REQUEST_TIMEOUT_MS);
    timer.unref?.();
    const answer = (response: SshProxyResponse): void => {
      socket.write(`${JSON.stringify(response)}\n`);
    };
    const refuse = (code: SshProxyErrorCode, message: string, fix?: string): void => {
      answer({ ok: false, code, message, ...(fix ? { fix } : {}) });
      socket.end();
    };
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) {
        if (buffered.length > MAX_REQUEST_BYTES) {
          socket.off("data", onData);
          clearTimeout(timer);
          refuse("BAD_REQUEST", "The proxy request line is too long.");
        }
        return;
      }
      socket.off("data", onData);
      socket.pause();
      clearTimeout(timer);
      const request = parseSshProxyRequest(buffered.subarray(0, newline).toString("utf8"));
      const early = buffered.subarray(newline + 1);
      if (!request) {
        refuse("BAD_REQUEST", "The proxy request was not understood; the Orquester ssh config may be from another version.");
        return;
      }
      void this.connect(socket, request, early, answer, refuse);
    };
    socket.on("data", onData);
  }

  private async connect(
    socket: Socket,
    request: SshProxyRequest,
    early: Buffer,
    answer: (response: SshProxyResponse) => void,
    refuse: (code: SshProxyErrorCode, message: string, fix?: string) => void
  ): Promise<void> {
    let outcome: SshProxyOutcome;
    try {
      outcome = await this.options.open(request);
    } catch {
      outcome = { ok: false, code: "SSH_UNAVAILABLE", message: `${request.alias} could not be reached.` };
    }
    if (!outcome.ok) {
      if (!socket.destroyed) refuse(outcome.code, outcome.message, outcome.fix);
      return;
    }
    const upstream = outcome.stream;
    if (socket.destroyed) {
      upstream.destroy();
      return;
    }
    answer({ ok: true, via: outcome.via });
    if (early.length > 0) upstream.write(early);
    // Half-open both ways: ssh's end of input travels on and the answer still comes back.
    socket.pipe(upstream);
    upstream.pipe(socket);
    upstream.on("error", () => socket.destroy());
    socket.once("close", () => upstream.destroy());
    upstream.once("close", () => socket.end());
    socket.resume();
  }
}
