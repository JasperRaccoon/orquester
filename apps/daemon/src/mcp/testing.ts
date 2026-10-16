import { basename, dirname } from "node:path";
import type { Readable } from "node:stream";
import type { EventMessage, PromptReferencesResponse, Workflow, WorkflowProject, WorkflowReferencesResponse } from "@orquester/api";
import { threadHeadOf, threadHeadQueryOf, type HtmlRenderReference, type ThreadSnapshotPayload } from "@orquester/api/agent-chat";
import type {
  DaemonApi,
  DaemonMethod,
  DaemonOutcome,
  DaemonResponse,
  HtmlPreview,
  HtmlPreviewRequest,
  HtmlRenderPublishRequest
} from "./daemon-api.ts";
import { WorkflowReferenceIndex } from "../workflows/reference-index.ts";

type Call = { method: DaemonMethod; path: string; query?: Record<string, string>; body?: unknown };
type Responder = DaemonResponse | ((call: { query?: Record<string, string>; body?: unknown; path: string }) => DaemonResponse);

/**
 * In-memory DaemonApi for tool tests. The rules a test can rely on:
 *
 * - Routes. `on(method, path, responder)` registers a route; a request takes the NEWEST registered route whose method
 *   matches and whose path matches — exactly, or as a prefix when the registered path ends in `*`
 *   (`"/api/sessions/*"`). Exact and prefix routes are not ranked: registration order alone decides, so a later `on`
 *   overrides an earlier one for the paths it covers. `opts.query` never takes part in matching (a `?` written into
 *   `path` itself is part of the path and matches literally); a function responder receives `{query, body, path}` and
 *   can branch on it.
 * - Answers. A responder is a canned `DaemonResponse` or a function returning one; a function that throws makes
 *   `request` reject (a transport failure). An unmatched request answers `404 {code: "NOT_FOUND"}`; it never throws.
 *   Every request, matched or not, is appended to `calls` (`query`/`body` only when given).
 * - Thread heads. A `GET /api/sessions/:id/head` no route matches is answered as the daemon answers it against a host
 *   without the head route: from that session's `/thread` route (its snapshot through `threadHeadOf`, any other answer
 *   passed through) — {@link headFromThreadRead}. Only the head call is recorded in `calls`.
 * - Uploads. `uploadAttachment` reads the whole stream into `uploads`, then answers with the `onUpload` handler, else
 *   a 200 AttachmentRef (`image` for an image/* type); a source stream that errors makes it reject. InjectDaemonApi
 *   answers that case 503 HOST_UNAVAILABLE instead: `countingLimit` (agent-chat/service.ts) forwards the source's error
 *   into the body the host client is sending, the upload fails, and the seam maps the throw.
 * - Bus. `emit` delivers synchronously, as `Broadcaster.publish` does over the sinks `InjectDaemonApi.subscribe` adds:
 *   it walks the LIVE subscriber set in subscription order (a listener removed mid-delivery is skipped, one added is
 *   reached), each `subscribe` call is its own subscription even for the same function, and a listener that throws is
 *   swallowed and stays subscribed. The one difference: every listener gets the same event object, where production
 *   parses a copy per subscription — so a listener must not mutate the event.
 */
export class FakeDaemonApi implements DaemonApi {
  calls: Call[] = [];
  uploads: { sessionId: string; meta: { name: string; type?: string }; bytes: Buffer }[] = [];
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
    const route = this.find(method, path);
    const head = method === "GET" && !route ? /^\/api\/sessions\/([^/]+)\/head$/.exec(path) : null;
    if (head) {
      const threadPath = `/api/sessions/${head[1]}/thread`;
      const thread = this.find("GET", threadPath);
      if (thread) return headFromThreadRead(this.answer(thread, { path: threadPath }), opts?.query);
    }
    if (!route) return { status: 404, body: { code: "NOT_FOUND", message: `no fake route for ${method} ${path}` } };
    return this.answer(route, { query: opts?.query, body: opts?.body, path });
  }
  private find(method: DaemonMethod, path: string): { responder: Responder } | undefined {
    return this.routes.find((r) => r.method === method && (r.path.endsWith("*") ? path.startsWith(r.path.slice(0, -1)) : r.path === path));
  }
  private answer(route: { responder: Responder }, call: { query?: Record<string, string>; body?: unknown; path: string }): DaemonResponse {
    return typeof route.responder === "function" ? route.responder(call) : route.responder;
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
  /** `html_render` publishes, as the toolkit asked for them; answered by {@link onPublishHtml}. */
  publishes: HtmlRenderPublishRequest[] = [];
  /** `html_preview` requests; answered by {@link onPreviewHtml}. */
  previews: HtmlPreviewRequest[] = [];
  private publishHandler: (request: HtmlRenderPublishRequest) => DaemonOutcome<HtmlRenderReference> | Promise<DaemonOutcome<HtmlRenderReference>> =
    () => ({ ok: false, code: "UNAVAILABLE", message: "no fake publish" });
  private previewHandler: (request: HtmlPreviewRequest) => DaemonOutcome<HtmlPreview> | Promise<DaemonOutcome<HtmlPreview>> =
    () => ({ ok: false, code: "UNAVAILABLE", message: "no fake preview" });
  onPublishHtml(handler: FakeDaemonApi["publishHandler"]): this {
    this.publishHandler = handler;
    return this;
  }
  onPreviewHtml(handler: FakeDaemonApi["previewHandler"]): this {
    this.previewHandler = handler;
    return this;
  }
  async publishHtmlRender(request: HtmlRenderPublishRequest): Promise<DaemonOutcome<HtmlRenderReference>> {
    this.publishes.push(request);
    return this.publishHandler(request);
  }
  async previewHtmlRender(request: HtmlPreviewRequest): Promise<DaemonOutcome<HtmlPreview>> {
    this.previews.push(request);
    return this.previewHandler(request);
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

/**
 * A `GET …/head` answer from a `GET …/thread` one, as the daemon's proxy derives it from a host that predates the head
 * route: a snapshot through `threadHeadOf` (with the head's query), anything else — an error, an events answer — as
 * it came.
 */
export function headFromThreadRead(read: DaemonResponse, query?: Record<string, string>): DaemonResponse {
  const body = read.body as { kind?: unknown; thread?: unknown } | null;
  if (read.status >= 400 || body?.kind !== "snapshot") return read;
  return { status: read.status, body: threadHeadOf(body.thread as ThreadSnapshotPayload, threadHeadQueryOf(query ?? {})) };
}

/**
 * The workflow reference index's routes (`workflowRoutes.workflowReferences` / `promptReferences`),
 * answered as the daemon answers them: by a REAL {@link WorkflowReferenceIndex} rebuilt from
 * `workflows()` (and `unreadable()`, records the store cannot read) on every request.
 */
export function serveWorkflowReferences(
  api: FakeDaemonApi,
  workflows: () => readonly Workflow[],
  unreadable: () => readonly unknown[] = () => [],
  /** An existing project's workspace, as the daemon's wired `projectPathFilter` names it (none: unknown). */
  workspaceOfPath: (projectPath: string) => string | undefined = (projectPath) => basename(dirname(projectPath))
): FakeDaemonApi {
  const index = (): WorkflowReferenceIndex => {
    const built = new WorkflowReferenceIndex();
    built.rebuild({ workflows: workflows(), unreadable: unreadable() });
    return built;
  };
  const workspaceOf = (project: WorkflowProject): string | undefined => (project.kind === "temp" ? project.workspace : workspaceOfPath(project.projectPath));
  const withWorkspace = <T extends { project: WorkflowProject }>(entry: T): T & { workspace?: string } => {
    const workspace = workspaceOf(entry.project);
    return { ...entry, ...(workspace ? { workspace } : {}) };
  };
  const tail = (path: string, prefix: string) => decodeURIComponent(path.slice(prefix.length));
  const WORKFLOWS = "/api/workflow-references/workflows/";
  const PROMPTS = "/api/workflow-references/prompts/";
  api.on("GET", `${WORKFLOWS}*`, ({ path }) => {
    const id = tail(path, WORKFLOWS);
    const built = index();
    const answer = built.callers(id);
    const body: WorkflowReferencesResponse = {
      version: answer.version,
      workflowId: id,
      calls: built.calls(id),
      callers: answer.callers === null ? null : answer.callers.map((caller) => withWorkspace(caller)),
      ...(answer.unknownReason ? { unknownReason: answer.unknownReason } : {})
    };
    return { status: 200, body };
  });
  api.on("GET", `${PROMPTS}*`, ({ path }) => {
    const promptId = tail(path, PROMPTS);
    const answer = index().promptUses(promptId);
    const body: PromptReferencesResponse = {
      version: answer.version,
      promptId,
      workflows: answer.workflows.map((use) => withWorkspace(use)),
      ...(answer.unknownReason ? { unknownReason: answer.unknownReason } : {})
    };
    return { status: 200, body };
  });
  return api;
}
