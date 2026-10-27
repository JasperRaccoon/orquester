import type { FastifyInstance } from "fastify";
import type { Readable } from "node:stream";
import type { BoxSummary, DeviceActionInput, DeviceLeaseSummary, DevicePlatform, EventMessage } from "@orquester/api";
import { PRINCIPAL_TOKEN_HEADER, type CallerPrincipal, type HtmlRenderAppearance, type HtmlRenderReference } from "@orquester/api/agent-chat";
import type { Broadcaster } from "../broadcaster.ts";
import type { AgentChatService } from "../agent-chat/service.ts";
import { HtmlRenderPublishError } from "../agent-chat/html-render-publish.ts";
import { HtmlPreviewError, type HtmlPreview } from "../html-preview/index.ts";
import { isUploadTooLarge, UploadTooLargeError } from "../upload-stream.ts";
import { FsTools, type ListFilesResult, type ReadFileWindowResult } from "./fs-tools.ts";
import type { BoxRegistry } from "../boxes/contracts.ts";
import { mintPrincipalToken } from "./principal.ts";
// boxes: the temporary-box operations (Ephemeral AI VMs spec §13), types only.
import type { BoxExecRequest, BoxExecResult, BoxForwardResult, BoxJobOutput, BoxTransferResult } from "../boxes/temporary/contract.ts";
import type { TemporaryBoxTools } from "../boxes/temporary/tools.ts";
// Devices: the device tools' operations (devices spec §9), types and the outcome adapter.
import {
  runDeviceTool,
  type DeviceCallOptions,
  type DeviceOpenPlan,
  type DeviceToolActionResult,
  type DeviceToolCloseInput,
  type DeviceToolInstallInput,
  type DeviceToolInstallResult,
  type DeviceToolList,
  type DeviceToolOpenInput,
  type DeviceToolOpenResult,
  type DeviceToolsPort
} from "../devices/tools-port.ts";

export type { DeviceCallOptions };

export type DaemonMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export interface DaemonResponse { status: number; body: unknown }

/**
 * One request's options. `principal` (unified MCP design 2026-10-15, `@orquester/api`
 * `agent-chat/principal.ts`): who the request acts for — the in-process client mints a single-use
 * nonce for it (`./principal.ts`), sends it in the principal header, and releases it once the
 * request settled; the route reads `request.principal`. Absent: the request is the user's.
 */
export interface DaemonRequestOptions { query?: Record<string, string>; body?: unknown; principal?: CallerPrincipal }

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

// boxes: begin
/**
 * One temporary-box operation's options: who acts (`withPrincipal` forces the caller's, as for
 * `request`) and the call's abort. The daemon enforces ownership with that principal: an agent
 * reaches only its own chat's boxes.
 */
export interface DaemonBoxCallOptions {
  principal?: CallerPrincipal;
  signal?: AbortSignal;
}
// boxes: end

/**
 * The one seam between the MCP tools and the daemon (spec §4.2). Production
 * runs the daemon's own routes in-process with the caller's bearer, so every
 * gate, validation and error code is the GUI's by construction.
 */
export interface DaemonApi {
  request(method: DaemonMethod, path: string, opts?: DaemonRequestOptions): Promise<DaemonResponse>;
  /** Owns `bytes`: reads it or destroys it. InjectDaemonApi never throws here — a failed upload is an answer (§4.5 codes), as over HTTP. */
  uploadAttachment(sessionId: string, meta: { name: string; type?: string }, bytes: Readable): Promise<{ status: number; value: unknown }>;
  subscribe(listener: (event: EventMessage) => void): () => void;
  /** Publish a visual page into `threadId` (its project's images inlined, heights measured). */
  publishHtmlRender(request: HtmlRenderPublishRequest): Promise<DaemonOutcome<HtmlRenderReference>>;
  /** Screenshot a page in headless Chromium, as `threadId`'s reader would see it. */
  previewHtmlRender(request: HtmlPreviewRequest): Promise<DaemonOutcome<HtmlPreview>>;
  /**
   * A directory listing inside the sandbox (`FsTools.listFiles`, D-19): a relative path is taken from `fsRoot`. Throws
   * `ToolError`s written for the agent. Optional so the many test doubles of this seam need not grow it; `read_file`
   * answers UNAVAILABLE without it.
   */
  listDirectory?(path: string): Promise<ListFilesResult>;
  /** A text file's byte window inside the sandbox (`FsTools.readFileWindow`); a directory throws `FsDirectoryError`. */
  readFileRange?(path: string, opts: { offset?: number; maxBytes?: number }): Promise<ReadFileWindowResult>;
  // boxes: begin
  // The temporary-box operations (Ephemeral AI VMs spec §13): streamed or abortable, so not routes
  // (the box records are: `temporaryBoxRoutes`). Optional so the many test doubles of this seam
  // need not grow them; the box tools answer BOXES_DISABLED without them.
  /** Until the box is ready (event-driven), it fails, `timeoutMs` passes or the call aborts. */
  boxWaitReady?(boxId: string, timeoutMs: number, opts?: DaemonBoxCallOptions): Promise<DaemonOutcome<BoxSummary>>;
  /** Run a command in the box: foreground (output tails) or a background job. */
  boxExec?(boxId: string, request: BoxExecRequest, opts?: DaemonBoxCallOptions): Promise<DaemonOutcome<BoxExecResult>>;
  /** A background job's state and output tail; `waitMs` > 0 waits for its exit (bounded). */
  boxJobOutput?(boxId: string, jobId: string, waitMs: number, opts?: DaemonBoxCallOptions): Promise<DaemonOutcome<BoxJobOutput>>;
  /** A file or directory from the calling chat's project into the box, streamed. */
  boxUpload?(boxId: string, request: { localPath: string; remotePath: string }, opts?: DaemonBoxCallOptions): Promise<DaemonOutcome<BoxTransferResult>>;
  /** A file or directory from the box into the calling chat's project, streamed. */
  boxDownload?(boxId: string, request: { remotePath: string; localPath: string }, opts?: DaemonBoxCallOptions): Promise<DaemonOutcome<BoxTransferResult>>;
  /** A box port on a host loopback port, until the box is destroyed. */
  boxForwardPort?(boxId: string, port: number, opts?: DaemonBoxCallOptions): Promise<DaemonOutcome<BoxForwardResult>>;
  // boxes: end
  // Devices (devices spec §9): the calling chat's devices, for an agent principal only (the chat is
  // the principal's, never an argument). Optional like the box operations; the device tools answer
  // DEVICES_DISABLED without them, and they answer it themselves while the plugin is off.
  /** `list_devices`: hosts, profiles, this chat's leases, other chats' devices as busy. */
  devicesList?(opts?: DeviceCallOptions): Promise<DaemonOutcome<DeviceToolList>>;
  /** What `open_device` would rent first (its spend card), or nothing. */
  devicesPlanOpen?(platform: DevicePlatform, opts?: DeviceCallOptions): Promise<DaemonOutcome<DeviceOpenPlan>>;
  /** Lease and boot a device (waits up to 9 min, then answers `starting`). */
  deviceOpen?(input: DeviceToolOpenInput, opts?: DeviceCallOptions): Promise<DaemonOutcome<DeviceToolOpenResult>>;
  /** One `device_action` on one of the chat's devices (`device`: key or lease id; absent: its only one). */
  deviceAction?(device: string | undefined, input: DeviceActionInput, opts?: DeviceCallOptions): Promise<DaemonOutcome<DeviceToolActionResult>>;
  /** Stream a build from the chat's project to the device's host and install it. */
  deviceInstall?(input: DeviceToolInstallInput, opts?: DeviceCallOptions): Promise<DaemonOutcome<DeviceToolInstallResult>>;
  /** Release one of the chat's devices. */
  deviceClose?(input: DeviceToolCloseInput, opts?: DeviceCallOptions): Promise<DaemonOutcome<{ lease: DeviceLeaseSummary }>>;
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

// boxes: the answer while no box backend is wired (the external transport's clients, tests).
const BOXES_UNWIRED: DaemonOutcome<never> = { ok: false, code: "BOXES_DISABLED", message: "Temporary boxes are not available here." };

export class InjectDaemonApi implements DaemonApi {
  constructor(
    private readonly opts: {
      app: FastifyInstance;
      authorization: string | undefined;
      agentChat: ChatUploads | null;
      broadcaster: Broadcaster;
      fsRoot: LivePath;
      workspacesDir: LivePath;
      // boxes: the temporary-box backend (the daemon's own client of itself has it).
      boxes?: TemporaryBoxTools | null;
      // boxes: which paths live in a box project, for the file reads (absent: all host).
      boxRegistry?: () => BoxRegistry | undefined;
      // Devices: the device service (null while the plugin is off; absent: not wired here).
      devices?: () => DeviceToolsPort | null;
    }
  ) {}

  get fsRoot(): string {
    return typeof this.opts.fsRoot === "function" ? this.opts.fsRoot() : this.opts.fsRoot;
  }

  get workspacesDir(): string {
    return typeof this.opts.workspacesDir === "function" ? this.opts.workspacesDir() : this.opts.workspacesDir;
  }

  async request(method: DaemonMethod, path: string, opts?: DaemonRequestOptions): Promise<DaemonResponse> {
    const qs = opts?.query ? new URLSearchParams(opts.query).toString() : "";
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.opts.authorization) headers.authorization = this.opts.authorization;
    if (opts?.body !== undefined) headers["content-type"] = "application/json";
    // A fresh single-use nonce per request; `app.inject` never crosses the network, and the
    // token is released below whether or not the route resolved it.
    const minted = opts?.principal ? mintPrincipalToken(opts.principal) : null;
    if (minted) headers[PRINCIPAL_TOKEN_HEADER] = minted.token;
    let res;
    try {
      res = await this.opts.app.inject({
        method,
        url: qs ? `${path}${path.includes("?") ? "&" : "?"}${qs}` : path,
        headers,
        payload: opts?.body === undefined ? undefined : JSON.stringify(opts.body)
      });
    } finally {
      minted?.release();
    }
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

  /** Read at every call: `fsRoot` follows `PUT /api/config/daemon`. */
  listDirectory(path: string): Promise<ListFilesResult> {
    return new FsTools({ fsRoot: this.fsRoot, ...(this.opts.boxRegistry ? { boxes: this.opts.boxRegistry } : {}) }).listFiles(path);
  }

  readFileRange(path: string, opts: { offset?: number; maxBytes?: number }): Promise<ReadFileWindowResult> {
    return new FsTools({ fsRoot: this.fsRoot, ...(this.opts.boxRegistry ? { boxes: this.opts.boxRegistry } : {}) }).readFileWindow(path, opts);
  }

  // boxes: begin
  async boxWaitReady(boxId: string, timeoutMs: number, opts?: DaemonBoxCallOptions): Promise<DaemonOutcome<BoxSummary>> {
    return this.opts.boxes ? this.opts.boxes.waitReady(boxId, timeoutMs, opts) : BOXES_UNWIRED;
  }

  async boxExec(boxId: string, request: BoxExecRequest, opts?: DaemonBoxCallOptions): Promise<DaemonOutcome<BoxExecResult>> {
    return this.opts.boxes ? this.opts.boxes.exec(boxId, request, opts) : BOXES_UNWIRED;
  }

  async boxJobOutput(boxId: string, jobId: string, waitMs: number, opts?: DaemonBoxCallOptions): Promise<DaemonOutcome<BoxJobOutput>> {
    return this.opts.boxes ? this.opts.boxes.jobOutput(boxId, jobId, waitMs, opts) : BOXES_UNWIRED;
  }

  async boxUpload(boxId: string, request: { localPath: string; remotePath: string }, opts?: DaemonBoxCallOptions): Promise<DaemonOutcome<BoxTransferResult>> {
    return this.opts.boxes ? this.opts.boxes.upload(boxId, request, opts) : BOXES_UNWIRED;
  }

  async boxDownload(boxId: string, request: { remotePath: string; localPath: string }, opts?: DaemonBoxCallOptions): Promise<DaemonOutcome<BoxTransferResult>> {
    return this.opts.boxes ? this.opts.boxes.download(boxId, request, opts) : BOXES_UNWIRED;
  }

  async boxForwardPort(boxId: string, port: number, opts?: DaemonBoxCallOptions): Promise<DaemonOutcome<BoxForwardResult>> {
    return this.opts.boxes ? this.opts.boxes.forwardPort(boxId, port, opts) : BOXES_UNWIRED;
  }
  // boxes: end

  // Devices: each operation acts for the principal's chat (`runDeviceTool`).
  private devices(): DeviceToolsPort | null {
    return this.opts.devices?.() ?? null;
  }

  devicesList(opts?: DeviceCallOptions): Promise<DaemonOutcome<DeviceToolList>> {
    return runDeviceTool(this.devices(), opts, (port, threadId) => port.toolList(threadId));
  }

  devicesPlanOpen(platform: DevicePlatform, opts?: DeviceCallOptions): Promise<DaemonOutcome<DeviceOpenPlan>> {
    return runDeviceTool(this.devices(), opts, (port, threadId) => port.toolPlanOpen(threadId, platform));
  }

  deviceOpen(input: DeviceToolOpenInput, opts?: DeviceCallOptions): Promise<DaemonOutcome<DeviceToolOpenResult>> {
    return runDeviceTool(this.devices(), opts, (port, threadId, signal) => port.toolOpen(threadId, input, signal));
  }

  deviceAction(device: string | undefined, input: DeviceActionInput, opts?: DeviceCallOptions): Promise<DaemonOutcome<DeviceToolActionResult>> {
    return runDeviceTool(this.devices(), opts, (port, threadId, signal) => port.toolAction(threadId, device, input, signal));
  }

  deviceInstall(input: DeviceToolInstallInput, opts?: DeviceCallOptions): Promise<DaemonOutcome<DeviceToolInstallResult>> {
    return runDeviceTool(this.devices(), opts, (port, threadId, signal) => port.toolInstall(threadId, input, signal));
  }

  deviceClose(input: DeviceToolCloseInput, opts?: DeviceCallOptions): Promise<DaemonOutcome<{ lease: DeviceLeaseSummary }>> {
    return runDeviceTool(this.devices(), opts, (port, threadId) => port.toolClose(threadId, input));
  }

  subscribe(listener: (event: EventMessage) => void): () => void {
    // `Broadcaster.publish` drops a sink whose `send` throws — never throw here.
    const sink = { send: (data: string) => { try { listener(JSON.parse(data) as EventMessage); } catch { /* ignore */ } } };
    this.opts.broadcaster.add(sink);
    return () => this.opts.broadcaster.remove(sink);
  }
}

/**
 * `api` with every request acting for `principal` (the catalog executor's per-call binding): each
 * `request` mints its own nonce. The binding is FORCED: a `principal` a tool passes is replaced,
 * so only the executor ever decides who a tool's request acts for.
 */
export function withPrincipal(api: DaemonApi, principal: CallerPrincipal): DaemonApi {
  return {
    request: (method, path, opts) => api.request(method, path, { ...opts, principal }),
    uploadAttachment: (sessionId, meta, bytes) => api.uploadAttachment(sessionId, meta, bytes),
    subscribe: (listener) => api.subscribe(listener),
    publishHtmlRender: (request) => api.publishHtmlRender(request),
    previewHtmlRender: (request) => api.previewHtmlRender(request),
    ...(api.listDirectory ? { listDirectory: (path: string) => api.listDirectory!(path) } : {}),
    ...(api.readFileRange ? { readFileRange: (path: string, opts: { offset?: number; maxBytes?: number }) => api.readFileRange!(path, opts) } : {}),
    // boxes: each box operation acts for the bound principal too (a tool cannot choose another).
    ...(api.boxWaitReady ? { boxWaitReady: (boxId: string, timeoutMs: number, opts?: DaemonBoxCallOptions) => api.boxWaitReady!(boxId, timeoutMs, { ...opts, principal }) } : {}),
    ...(api.boxExec ? { boxExec: (boxId: string, request: BoxExecRequest, opts?: DaemonBoxCallOptions) => api.boxExec!(boxId, request, { ...opts, principal }) } : {}),
    ...(api.boxJobOutput ? { boxJobOutput: (boxId: string, jobId: string, waitMs: number, opts?: DaemonBoxCallOptions) => api.boxJobOutput!(boxId, jobId, waitMs, { ...opts, principal }) } : {}),
    ...(api.boxUpload ? { boxUpload: (boxId: string, request: { localPath: string; remotePath: string }, opts?: DaemonBoxCallOptions) => api.boxUpload!(boxId, request, { ...opts, principal }) } : {}),
    ...(api.boxDownload ? { boxDownload: (boxId: string, request: { remotePath: string; localPath: string }, opts?: DaemonBoxCallOptions) => api.boxDownload!(boxId, request, { ...opts, principal }) } : {}),
    ...(api.boxForwardPort ? { boxForwardPort: (boxId: string, port: number, opts?: DaemonBoxCallOptions) => api.boxForwardPort!(boxId, port, { ...opts, principal }) } : {}),
    // Devices: each device operation acts for the bound principal's chat too.
    ...(api.devicesList ? { devicesList: (opts?: DeviceCallOptions) => api.devicesList!({ ...opts, principal }) } : {}),
    ...(api.devicesPlanOpen ? { devicesPlanOpen: (platform: DevicePlatform, opts?: DeviceCallOptions) => api.devicesPlanOpen!(platform, { ...opts, principal }) } : {}),
    ...(api.deviceOpen ? { deviceOpen: (input: DeviceToolOpenInput, opts?: DeviceCallOptions) => api.deviceOpen!(input, { ...opts, principal }) } : {}),
    ...(api.deviceAction
      ? { deviceAction: (device: string | undefined, input: DeviceActionInput, opts?: DeviceCallOptions) => api.deviceAction!(device, input, { ...opts, principal }) }
      : {}),
    ...(api.deviceInstall ? { deviceInstall: (input: DeviceToolInstallInput, opts?: DeviceCallOptions) => api.deviceInstall!(input, { ...opts, principal }) } : {}),
    ...(api.deviceClose ? { deviceClose: (input: DeviceToolCloseInput, opts?: DeviceCallOptions) => api.deviceClose!(input, { ...opts, principal }) } : {}),
    get fsRoot() { return api.fsRoot; },
    get workspacesDir() { return api.workspacesDir; }
  };
}
