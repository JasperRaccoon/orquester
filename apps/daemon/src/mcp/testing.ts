import type { Readable } from "node:stream";
import type { EventMessage } from "@orquester/api";
import type { DaemonApi, DaemonMethod, DaemonResponse } from "./daemon-api.ts";

type Call = { method: DaemonMethod; path: string; query?: Record<string, string>; body?: unknown };
type Responder = DaemonResponse | ((call: { query?: Record<string, string>; body?: unknown }) => DaemonResponse);

/** In-memory DaemonApi for tool tests: canned responses by `METHOD path` (a trailing `*` is a prefix match). */
export class FakeDaemonApi implements DaemonApi {
  calls: Call[] = [];
  uploads: { sessionId: string; meta: { name: string; type?: string }; bytes: Buffer }[] = [];
  attachmentPaths = new Map<string, string>();
  fsRoot = "/w";
  workspacesDir = "/w";
  private routes: { method: DaemonMethod; path: string; responder: Responder }[] = [];
  private listeners = new Set<(event: EventMessage) => void>();
  private uploadHandler: ((sessionId: string, meta: { name: string; type?: string }, bytes: Buffer) => { status: number; value: unknown }) | null = null;

  on(method: DaemonMethod, path: string, responder: Responder): this {
    this.routes.unshift({ method, path, responder });
    return this;
  }
  onUpload(handler: (sessionId: string, meta: { name: string; type?: string }, bytes: Buffer) => { status: number; value: unknown }): this {
    this.uploadHandler = handler;
    return this;
  }
  emit(event: EventMessage): void { for (const l of [...this.listeners]) l(event); }
  listenerCount(): number { return this.listeners.size; }

  async request(method: DaemonMethod, path: string, opts?: { query?: Record<string, string>; body?: unknown }): Promise<DaemonResponse> {
    const call: Call = { method, path };
    if (opts?.query) call.query = opts.query;
    if (opts?.body !== undefined) call.body = opts.body;
    this.calls.push(call);
    const route = this.routes.find((r) => r.method === method && (r.path.endsWith("*") ? path.startsWith(r.path.slice(0, -1)) : r.path === path));
    if (!route) return { status: 404, body: { code: "NOT_FOUND", message: `no fake route for ${method} ${path}` } };
    return typeof route.responder === "function" ? route.responder({ query: opts?.query, body: opts?.body }) : route.responder;
  }
  async uploadAttachment(sessionId: string, meta: { name: string; type?: string }, bytes: Readable): Promise<{ status: number; value: unknown }> {
    const chunks: Buffer[] = [];
    for await (const c of bytes) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
    const buf = Buffer.concat(chunks);
    this.uploads.push({ sessionId, meta, bytes: buf });
    if (this.uploadHandler) return this.uploadHandler(sessionId, meta, buf);
    const image = /^image\//.test(meta.type ?? "");
    return { status: 200, value: { type: image ? "image" : "file", id: `${sessionId}-att-${this.uploads.length}`, name: meta.name, mimeType: meta.type, sizeBytes: buf.length } };
  }
  async attachmentPath(sessionId: string, attachmentId: string): Promise<string | null> {
    return this.attachmentPaths.get(attachmentId) ?? `/appdir/daemon/agent/threads/${sessionId}/attachments/${attachmentId}`;
  }
  subscribe(listener: (event: EventMessage) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}

/** A bus event as the daemon publishes it. */
export function busEvent(type: string, payload: unknown, channel = "sessions"): EventMessage {
  return { id: `${type}-${Math.random()}`, channel, type, createdAt: new Date().toISOString(), payload } as EventMessage;
}
