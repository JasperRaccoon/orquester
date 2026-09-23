import type { Readable } from "node:stream";
import type { EventMessage } from "@orquester/api";
import type { DaemonApi, DaemonMethod, DaemonResponse } from "./daemon-api.ts";

type Call = { method: DaemonMethod; path: string; query?: Record<string, string>; body?: unknown };
type Responder = DaemonResponse | ((call: { query?: Record<string, string>; body?: unknown }) => DaemonResponse);

/**
 * In-memory DaemonApi for tool tests. The rules a test can rely on:
 *
 * - Routes. `on(method, path, responder)` registers a route; a request takes the NEWEST registered route whose method
 *   matches and whose path matches — exactly, or as a prefix when the registered path ends in `*`
 *   (`"/api/sessions/*"`). Exact and prefix routes are not ranked: registration order alone decides, so a later `on`
 *   overrides an earlier one for the paths it covers. The query never takes part in matching; a function responder
 *   receives `{query, body}` and can branch on it.
 * - Answers. A responder is a canned `DaemonResponse` or a function returning one; a function that throws makes
 *   `request` reject (a transport failure). An unmatched request answers `404 {code: "NOT_FOUND"}`; it never throws.
 *   Every request, matched or not, is appended to `calls` (`query`/`body` only when given).
 * - Uploads. `uploadAttachment` reads the whole stream into `uploads`, then answers with the `onUpload` handler, else
 *   a 200 AttachmentRef (`image` for an image/* type); a source stream that errors makes it reject, where
 *   InjectDaemonApi answers 503 HOST_UNAVAILABLE. `attachmentPath` answers from `attachmentPaths`, else a path under a
 *   fake appdir.
 * - Bus. `emit` delivers synchronously, as `Broadcaster.publish` does over the sinks `InjectDaemonApi.subscribe` adds:
 *   it walks the LIVE subscriber set in subscription order (a listener removed mid-delivery is skipped, one added is
 *   reached), each `subscribe` call is its own subscription even for the same function, and a listener that throws is
 *   swallowed and stays subscribed. The one difference: every listener gets the same event object, where production
 *   parses a copy per subscription — so a listener must not mutate the event.
 */
export class FakeDaemonApi implements DaemonApi {
  calls: Call[] = [];
  uploads: { sessionId: string; meta: { name: string; type?: string }; bytes: Buffer }[] = [];
  attachmentPaths = new Map<string, string>();
  fsRoot = "/w";
  workspacesDir = "/w";
  private routes: { method: DaemonMethod; path: string; responder: Responder }[] = [];
  /** One entry per `subscribe` call, as the Broadcaster holds one sink per call. */
  private listeners = new Set<{ listener: (event: EventMessage) => void }>();
  private uploadHandler: ((sessionId: string, meta: { name: string; type?: string }, bytes: Buffer) => { status: number; value: unknown }) | null = null;

  on(method: DaemonMethod, path: string, responder: Responder): this {
    this.routes.unshift({ method, path, responder });
    return this;
  }
  onUpload(handler: (sessionId: string, meta: { name: string; type?: string }, bytes: Buffer) => { status: number; value: unknown }): this {
    this.uploadHandler = handler;
    return this;
  }
  emit(event: EventMessage): void {
    for (const entry of this.listeners) {
      try { entry.listener(event); } catch { /* swallowed, and the listener stays: InjectDaemonApi's sink never throws */ }
    }
  }
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
    const entry = { listener };
    this.listeners.add(entry);
    return () => { this.listeners.delete(entry); };
  }
}

/** A bus event as the daemon publishes it. */
export function busEvent(type: string, payload: unknown, channel = "sessions"): EventMessage {
  return { id: `${type}-${Math.random()}`, channel, type, createdAt: new Date().toISOString(), payload } as EventMessage;
}
