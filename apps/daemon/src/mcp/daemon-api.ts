import type { FastifyInstance } from "fastify";
import type { Readable } from "node:stream";
import type { EventMessage } from "@orquester/api";
import type { HtmlRenderAppearance, HtmlRenderReference } from "@orquester/api/agent-chat";
import type { Broadcaster } from "../broadcaster.ts";
import type { AgentChatService } from "../agent-chat/service.ts";
import { HtmlRenderPublishError } from "../agent-chat/html-render-publish.ts";
import { HtmlPreviewError, type HtmlPreview } from "../html-preview/index.ts";
import { isUploadTooLarge, UploadTooLargeError } from "../upload-stream.ts";

export type DaemonMethod = "GET" | "POST" | "PUT" | "DELETE";
export interface DaemonResponse { status: number; body: unknown }

/** An answer or a refusal whose message is written for the agent; never a throw. */
export type DaemonOutcome<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

/** `html_render` (design 2026-10-14 §2.1): a page for the calling thread. */
export interface HtmlRenderPublishRequest {
  threadId: string;
  html: string;
  title: string;
  height: number;
  signal?: AbortSignal;
}

/** `html_preview` (design 2026-10-14 §2.1). */
export interface HtmlPreviewRequest {
  threadId: string;
  html: string;
  width?: number;
  appearance?: HtmlRenderAppearance;
  signal?: AbortSignal;
}

export type { HtmlPreview };

/**
 * The one seam between the MCP tools and the daemon (spec §4.2). Production
 * runs the daemon's own routes in-process with the caller's bearer, so every
 * gate, validation and error code is the GUI's by construction.
 */
export interface DaemonApi {
  request(method: DaemonMethod, path: string, opts?: { query?: Record<string, string>; body?: unknown }): Promise<DaemonResponse>;
  /** Owns `bytes`: reads it or destroys it. InjectDaemonApi never throws here — a failed upload is an answer (§4.5 codes), as over HTTP. */
  uploadAttachment(sessionId: string, meta: { name: string; type?: string }, bytes: Readable): Promise<{ status: number; value: unknown }>;
  subscribe(listener: (event: EventMessage) => void): () => void;
  /** Publish a visual page into `threadId` (its project's images inlined, heights measured). */
  publishHtmlRender(request: HtmlRenderPublishRequest): Promise<DaemonOutcome<HtmlRenderReference>>;
  /** Screenshot a page in headless Chromium, as `threadId`'s reader would see it. */
  previewHtmlRender(request: HtmlPreviewRequest): Promise<DaemonOutcome<HtmlPreview>>;
  readonly fsRoot: string;
  readonly workspacesDir: string;
}

type ChatUploads = Pick<AgentChatService, "uploadAttachment" | "publishHtmlRender" | "previewHtmlRender">;

const HOST_RESTARTING: DaemonOutcome<never> = { ok: false, code: "HOST_UNAVAILABLE", message: "The agent host is restarting." };

/**
 * A visual page's refusal, as the agent reads it. The publisher's and the
 * preview's own messages are written for the agent and pass through; a failed
 * store's cause (the host's own text) is logged, never echoed.
 */
function visualRefusal(error: unknown): DaemonOutcome<never> {
  if (error instanceof HtmlRenderPublishError) {
    if (error.code === "cancelled") return { ok: false, code: "CANCELLED", message: error.message };
    if (error.code === "store-failed") {
      console.error("[session-tools] an html_render page could not be stored", error);
      return { ok: false, code: "UNAVAILABLE", message: "The page could not be saved. Try again in a few seconds." };
    }
    return { ok: false, code: "INVALID_ARGUMENT", message: error.message };
  }
  if (error instanceof HtmlPreviewError) {
    const code = error.code === "timeout" ? "TIMEOUT" : error.code === "cancelled" ? "CANCELLED" : "UNAVAILABLE";
    return { ok: false, code, message: error.message };
  }
  console.error("[session-tools] an html page failed", error);
  return { ok: false, code: "INTERNAL", message: "The page could not be rendered." };
}

/** A path the client reads: fixed, or read at every use (a long-lived client follows `PUT /api/config/daemon`). */
export type LivePath = string | (() => string);

export class InjectDaemonApi implements DaemonApi {
  constructor(private readonly opts: { app: FastifyInstance; authorization: string | undefined; agentChat: ChatUploads | null; broadcaster: Broadcaster; fsRoot: LivePath; workspacesDir: LivePath }) {}

  get fsRoot(): string {
    return typeof this.opts.fsRoot === "function" ? this.opts.fsRoot() : this.opts.fsRoot;
  }

  get workspacesDir(): string {
    return typeof this.opts.workspacesDir === "function" ? this.opts.workspacesDir() : this.opts.workspacesDir;
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
   * A thrown upload answers as the daemon's own upload route's catch does: 413 UPLOAD_TOO_LARGE past the cap — the
   * refusal thrown bare or carried as a wrapper's `cause` (`isUploadTooLarge`), answered with its own message, never the
   * wrapper's — else 503 HOST_UNAVAILABLE, its cause logged here and never returned (it can name a host path), as
   * sendCommand treats a thrown request. Besides the cap, two things throw: the host socket gone, and a source stream
   * that fails mid-read (a `{path}` attachment's file hitting EIO, or truncated under it) — `countingLimit`
   * (agent-chat/service.ts) forwards the source's error into the body the host client is sending, which fails the
   * upload. A stream left unread is destroyed, never leaked.
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
      if (isUploadTooLarge(error)) return { status: 413, value: { code: "UPLOAD_TOO_LARGE", message: new UploadTooLargeError().message } };
      console.error("[mcp] attachment upload failed", error);
      return { status: 503, value: { code: "HOST_UNAVAILABLE", message: "The attachment upload failed." } };
    }
  }

  async publishHtmlRender(request: HtmlRenderPublishRequest): Promise<DaemonOutcome<HtmlRenderReference>> {
    if (!this.opts.agentChat) return HOST_RESTARTING;
    try {
      return { ok: true, value: await this.opts.agentChat.publishHtmlRender(request) };
    } catch (error) {
      return visualRefusal(error);
    }
  }

  async previewHtmlRender(request: HtmlPreviewRequest): Promise<DaemonOutcome<HtmlPreview>> {
    if (!this.opts.agentChat) return HOST_RESTARTING;
    try {
      return { ok: true, value: await this.opts.agentChat.previewHtmlRender(request) };
    } catch (error) {
      return visualRefusal(error);
    }
  }

  subscribe(listener: (event: EventMessage) => void): () => void {
    // `Broadcaster.publish` drops a sink whose `send` throws — never throw here.
    const sink = { send: (data: string) => { try { listener(JSON.parse(data) as EventMessage); } catch { /* ignore */ } } };
    this.opts.broadcaster.add(sink);
    return () => this.opts.broadcaster.remove(sink);
  }
}
