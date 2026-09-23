import type { FastifyInstance } from "fastify";
import type { Readable } from "node:stream";
import type { EventMessage } from "@orquester/api";
import type { Broadcaster } from "../broadcaster.ts";
import type { AgentChatService } from "../agent-chat/service.ts";
import { UploadTooLargeError } from "../upload-stream.ts";

export type DaemonMethod = "GET" | "POST" | "PUT" | "DELETE";
export interface DaemonResponse { status: number; body: unknown }

/**
 * The one seam between the MCP tools and the daemon (spec §4.2). Production
 * runs the daemon's own routes in-process with the caller's bearer, so every
 * gate, validation and error code is the GUI's by construction.
 */
export interface DaemonApi {
  request(method: DaemonMethod, path: string, opts?: { query?: Record<string, string>; body?: unknown }): Promise<DaemonResponse>;
  /** Owns `bytes`: reads it or destroys it. InjectDaemonApi never throws here — a failed upload is an answer (§4.5 codes), as over HTTP. */
  uploadAttachment(sessionId: string, meta: { name: string; type?: string }, bytes: Readable): Promise<{ status: number; value: unknown }>;
  attachmentPath(sessionId: string, attachmentId: string): Promise<string | null>;
  subscribe(listener: (event: EventMessage) => void): () => void;
  readonly fsRoot: string;
  readonly workspacesDir: string;
}

type ChatUploads = Pick<AgentChatService, "uploadAttachment" | "attachmentPath">;

export class InjectDaemonApi implements DaemonApi {
  readonly fsRoot: string;
  readonly workspacesDir: string;
  constructor(private readonly opts: { app: FastifyInstance; authorization: string | undefined; agentChat: ChatUploads | null; broadcaster: Broadcaster; fsRoot: string; workspacesDir: string }) {
    this.fsRoot = opts.fsRoot;
    this.workspacesDir = opts.workspacesDir;
  }

  async request(method: DaemonMethod, path: string, opts?: { query?: Record<string, string>; body?: unknown }): Promise<DaemonResponse> {
    const qs = opts?.query ? new URLSearchParams(opts.query).toString() : "";
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.opts.authorization) headers.authorization = this.opts.authorization;
    if (opts?.body !== undefined) headers["content-type"] = "application/json";
    const res = await this.opts.app.inject({
      method,
      url: qs ? `${path}${path.includes("?") ? "&" : "?"}${qs}` : path,
      headers,
      payload: opts?.body === undefined ? undefined : JSON.stringify(opts.body)
    });
    let body: unknown = null;
    if (res.body) {
      try { body = JSON.parse(res.body); } catch { body = res.body; }
    }
    return { status: res.statusCode, body };
  }

  /**
   * A thrown upload (the host socket gone, the source stream destroyed) answers as the daemon's own upload route's catch
   * does: 413 UPLOAD_TOO_LARGE past the cap, else 503 HOST_UNAVAILABLE — its cause logged here and never returned (it
   * can name a host path), as sendCommand treats a thrown request. A stream left unread is destroyed, never leaked.
   */
  async uploadAttachment(sessionId: string, meta: { name: string; type?: string }, bytes: Readable): Promise<{ status: number; value: unknown }> {
    if (!this.opts.agentChat) {
      bytes.destroy();
      return { status: 503, value: { code: "HOST_UNAVAILABLE", message: "The agent host is restarting." } };
    }
    try {
      return await this.opts.agentChat.uploadAttachment(sessionId, { name: meta.name, type: meta.type }, bytes);
    } catch (error) {
      bytes.destroy();
      if (error instanceof UploadTooLargeError) return { status: 413, value: { code: "UPLOAD_TOO_LARGE", message: error.message } };
      console.error("[mcp] attachment upload failed", error);
      return { status: 503, value: { code: "HOST_UNAVAILABLE", message: "The attachment upload failed." } };
    }
  }

  async attachmentPath(sessionId: string, attachmentId: string): Promise<string | null> {
    if (!this.opts.agentChat) return null;
    return this.opts.agentChat.attachmentPath(sessionId, attachmentId);
  }

  subscribe(listener: (event: EventMessage) => void): () => void {
    // `Broadcaster.publish` drops a sink whose `send` throws — never throw here.
    const sink = { send: (data: string) => { try { listener(JSON.parse(data) as EventMessage); } catch { /* ignore */ } } };
    this.opts.broadcaster.add(sink);
    return () => this.opts.broadcaster.remove(sink);
  }
}
