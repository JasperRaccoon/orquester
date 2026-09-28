import type {
  AccountSummary,
  AccountTestResult,
  AgentAccount,
  AgentAccountsResponse,
  AgentConversationsResponse,
  AgentSummary,
  AuthInfoResponse,
  BrowserSummary,
  BrowserSuggestionsResponse,
  CreateAccountRequest,
  CreateBrowserRequest,
  CreateProjectRequest,
  CreateSessionRequest,
  CliProxyMutationRefusal,
  CliProxyProviderStatus,
  CliProxyRouterProviderRequest,
  CliProxySeedRequest,
  CliProxyStatus,
  CliProxyUnseedRequest,
  CliProxyXaiLink,
  CreateSavedPromptRequest,
  CreateTodoRequest,
  CreateWorkspaceRequest,
  EventMessage,
  FsArchiveResponse,
  FsCapabilitiesResponse,
  FsFilesResponse,
  FsListResponse,
  FsParquetResponse,
  FsReadResponse,
  FsSearchRequest,
  FsSearchResponse,
  FsUploadRequest,
  FsUploadResponse,
  GitBranchesResponse,
  GitCommitDetail,
  GitCommitRequest,
  GitDiffResponse,
  GitLogEntry,
  GitOpResult,
  GitStashActionRequest,
  GitStashCreateRequest,
  GitStashEntry,
  GitStatusResponse,
  GitWorkingDiffResponse,
  HealthResponse,
  ImportAgentAccountRequest,
  KillProcessResponse,
  MarkRecentProjectRequest,
  OpenResult,
  OpenTargetSummary,
  OwnerSummary,
  ProjectSummary,
  ProjectTemplatesResponse,
  PushInfoResponse,
  PushSubscribeRequest,
  PushTestResponse,
  PushUnsubscribeRequest,
  RecentProjectSummary,
  RegistryActionResult,
  RegistryResponse,
  RepoSummary,
  SavedPrompt,
  SavedPromptListResponse,
  ServerInfoResponse,
  SessionSummary,
  SessionUploadRequest,
  SessionUploadResponse,
  SetAgentAccountDefaultsRequest,
  SystemPortsResponse,
  SystemProcessesResponse,
  SystemResourcesResponse,
  TodoListRecord,
  TodoScope,
  UpdateProjectRequest,
  UpdateSavedPromptRequest,
  UpdateTodoRequest,
  UpdateWorkspaceRequest,
  UsageResponse,
  UsageTokensResponse,
  WorkspaceSummary
} from "@orquester/api";
import type { AppConfig, DaemonConfig, RemoteConnectionConfig } from "@orquester/config";
import type { UiConnection } from "../types";
import type {
  BinaryBody,
  SessionChannel,
  StreamHandle,
  StreamHandlers,
  Transporter,
  TransportMethod,
  TransportRequest
} from "./transporter";
import type { WsBrowserChannel } from "./transporters/ws-browser-channel";
import {
  resolveAgentChatTransport,
  type AgentChatTransport
} from "./agent-chat/transport";
import { fsPathQuery } from "./fs-path-query";
import { buildQueryString } from "./transporter";
import { workflowRoutes } from "@orquester/api";
import type {
  AccountPreviewRequest,
  AccountPreviewResponse,
  CreateWorkflowRequest,
  GetWorkflowNodeOutputResponse,
  GetWorkflowResponse,
  GetWorkflowRunResponse,
  ListWorkflowRunsResponse,
  ListWorkflowSecretsResponse,
  ListWorkflowsResponse,
  PatchWorkflowRequest,
  ReplaceWorkflowRequest,
  RunWorkflowRequest,
  RunWorkflowResponse,
  SchedulePreviewResponse,
  ValidateWorkflowRequest,
  ValidateWorkflowResponse,
  WorkflowBlockTypesResponse,
  WorkflowErrorCode,
  WorkflowProblem,
  WorkflowWriteResponse
} from "@orquester/api";
import { agentChatRoutes } from "@orquester/api/agent-chat";
import type {
  ThreadItemOutputResponse,
  ThreadItemResponse,
  ThreadPromptsQuery,
  ThreadPromptsResponse,
  ThreadPromptTextResponse,
  TurnDiffQuery,
  TurnDiffResponse
} from "@orquester/api/agent-chat";

export interface ApiRequestOptions {
  query?: TransportRequest["query"];
  body?: unknown;
  /** Raw upload bytes (see {@link TransportRequest.binaryBody}); exclusive with `body`. */
  binaryBody?: TransportRequest["binaryBody"];
  /** Upload progress sink for a `binaryBody` request (see {@link TransportRequest.onUploadProgress}). */
  onUploadProgress?: TransportRequest["onUploadProgress"];
  signal?: AbortSignal;
}

function serverMessageFromBody(body: unknown): string | null {
  // Daemon error bodies carry either `{ message }` (git/registry) or `{ error }`
  // (cliproxy refusals, fs) — accept both so refusal reasons reach the UI.
  // The workflow routes nest it: `{ error: { code, message } }`.
  if (body && typeof body === "object") {
    for (const key of ["message", "error"] as const) {
      const value = (body as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
      if (key === "error" && value && typeof value === "object") {
        const nested = (value as Record<string, unknown>).message;
        if (typeof nested === "string" && nested.trim()) {
          return nested.trim();
        }
      }
    }
  }
  return null;
}

function serverFieldFromBody(body: unknown): string | null {
  if (body && typeof body === "object" && "field" in body) {
    const field = (body as { field?: unknown }).field;
    if (typeof field === "string" && field.trim()) {
      return field.trim();
    }
  }
  return null;
}

/**
 * ApiClient is the "server manager": it owns the active {@link UiConnection}
 * and its {@link Transporter}, and exposes typed daemon endpoints to the
 * services/hooks above it. It does not know or care which transport is in use.
 *
 * NOTE: skeleton — endpoints are wired but no client-side logic/caching yet.
 */
export class ApiClient {
  /** Multiplexed session I/O (web/HTTP); null on transports without it (unix). */
  private readonly channel: SessionChannel | null;

  /** Lazily built once per client, so a re-render never re-opens a stream. */
  private agentChatTransport: AgentChatTransport | null = null;

  constructor(
    public readonly connection: UiConnection,
    private readonly transporter: Transporter
  ) {
    this.channel = transporter.sessionChannel?.() ?? null;
  }

  get transportKind(): string {
    return this.transporter.kind;
  }

  /**
   * The agent-chat surface (spec §7.1): `{stream, command, read, …}` for the
   * §6.2 commands and the §6.3 chunked-NDJSON thread stream.
   *
   * Built from this client's transporter — `request` + `openStream`, which
   * every runtime already has — so it works unchanged on the web HTTP
   * transport and on the desktop unix-socket transport (§6.5: nothing in the
   * chat UI depends on WebSockets). A transporter may override it by
   * implementing `agentChat()`.
   */
  get agentChat(): AgentChatTransport {
    this.agentChatTransport ??= resolveAgentChatTransport(this.transporter);
    return this.agentChatTransport;
  }

  /** Low-level escape hatch for endpoints not yet wrapped below. */
  async send<T>(method: TransportMethod, path: string, options: ApiRequestOptions = {}): Promise<T> {
    const response = await this.transporter.request<T>({
      method,
      path,
      query: options.query,
      body: options.body,
      binaryBody: options.binaryBody,
      onUploadProgress: options.onUploadProgress,
      signal: options.signal
    });

    if (!response.ok) {
      throw new ApiError(response.status, method, path, response.headers, response.data);
    }

    return response.data;
  }

  /**
   * POST/PUT/DELETE for the restart-gated cliproxy mutations: the daemon answers
   * a live dependent-session conflict with 409 { ok:false, affectedSessions }. Turn
   * that into a first-class refusal value (not an ApiError throw) so the caller can
   * offer a force-confirm flow; every other non-2xx still throws via {@link send}.
   * DELETE routes carry no body, so `force` rides the query string instead.
   */
  private async mutateAllowingRefusal<T>(
    method: TransportMethod,
    path: string,
    body?: unknown,
    query?: ApiRequestOptions["query"]
  ): Promise<T | CliProxyMutationRefusal> {
    try {
      return await this.send<T>(method, path, { body, query });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const parsed = e.body as { affectedSessions?: number } | null | undefined;
        return { ok: false, affectedSessions: parsed?.affectedSessions ?? 0 };
      }
      throw e;
    }
  }

  /**
   * Subscribe to the daemon event bus (NDJSON). `onEnd` fires when the stream
   * closes (e.g. the transport restarted) — used to detect disconnects.
   * Returns an unsubscribe fn.
   */
  openEvents(
    onEvent: (event: EventMessage) => void,
    onEnd?: () => void,
    opts?: { project?: string }
  ): () => void {
    let buffer = "";
    // `?project=` additionally subscribes this stream to that project's git
    // status: the daemon polls it only while such a stream is open, and sends
    // `project.git.changed` to these subscribers alone. Refcounted server-side
    // and released when the stream closes, so it is reconnect-safe.
    const query = opts?.project ? `?project=${encodeURIComponent(opts.project)}` : "";
    const handle = this.transporter.openStream(`/events${query}`, {
      onData: (chunk) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.trim()) {
            try {
              onEvent(JSON.parse(line) as EventMessage);
            } catch {
              /* ignore malformed line */
            }
          }
          newline = buffer.indexOf("\n");
        }
      },
      onEnd: () => onEnd?.()
    });
    return () => handle.close();
  }

  // Daemon meta

  health(signal?: AbortSignal): Promise<HealthResponse> {
    return this.send("GET", "/health", { signal });
  }

  info(signal?: AbortSignal): Promise<ServerInfoResponse> {
    return this.send("GET", "/api/info", { signal });
  }

  /** Public auth metadata (whether a token is required + bcrypt salt to derive it). */
  authInfo(signal?: AbortSignal): Promise<AuthInfoResponse> {
    return this.send("GET", "/api/auth/info", { signal });
  }

  getDaemonConfig(signal?: AbortSignal): Promise<DaemonConfig> {
    return this.send("GET", "/api/config/daemon", { signal });
  }

  /** Update daemon.json. Daemon rejects this (403) over the remote HTTP transport. */
  updateDaemonConfig(patch: Partial<DaemonConfig>): Promise<DaemonConfig> {
    return this.send("PUT", "/api/config/daemon", { body: patch });
  }

  /** The one daemon-config field writable over remote HTTP (UI curtain toggle). */
  setProtectArchived(enabled: boolean): Promise<DaemonConfig> {
    return this.send("PUT", "/api/config/daemon/protect-archived", { body: { enabled } });
  }

  // --- App config + remote servers (shared, daemon-persisted) --------------

  getAppConfig(signal?: AbortSignal): Promise<AppConfig> {
    return this.send("GET", "/api/config/app", { signal });
  }

  updateAppConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
    return this.send("PUT", "/api/config/app", { body: patch });
  }

  listRemotes(signal?: AbortSignal): Promise<RemoteConnectionConfig[]> {
    return this.send("GET", "/api/config/remotes", { signal });
  }

  saveRemotes(remotes: RemoteConnectionConfig[]): Promise<RemoteConnectionConfig[]> {
    return this.send("PUT", "/api/config/remotes", { body: remotes });
  }

  // --- Git accounts (daemon-persisted; allowed over remote HTTP) -----------

  listAccounts(signal?: AbortSignal): Promise<AccountSummary[]> {
    return this.send("GET", "/api/accounts", { signal });
  }

  createAccount(req: CreateAccountRequest): Promise<AccountSummary> {
    return this.send("POST", "/api/accounts", { body: req });
  }

  removeAccount(id: string): Promise<void> {
    return this.send("DELETE", `/api/accounts/${encodeURIComponent(id)}`);
  }

  testAccount(id: string): Promise<AccountTestResult> {
    return this.send("POST", `/api/accounts/${encodeURIComponent(id)}/test`);
  }

  /** Repos the account can reach (needs a persisted token; 400 otherwise). */
  listRepos(accountId: string, signal?: AbortSignal): Promise<RepoSummary[]> {
    return this.send("GET", `/api/accounts/${encodeURIComponent(accountId)}/repos`, { signal });
  }

  /** Owners the account can create repos under (needs a persisted token; 400 otherwise). */
  listOwners(accountId: string, signal?: AbortSignal): Promise<OwnerSummary[]> {
    return this.send("GET", `/api/accounts/${encodeURIComponent(accountId)}/orgs`, { signal });
  }

  /**
   * Persist a provider token for repo access. The token is only sent, never read
   * back. `tokenExpiresAt` is user-entered (Bitbucket tokens always expire).
   */
  setAccountToken(accountId: string, token: string, tokenExpiresAt?: string): Promise<void> {
    return this.send("POST", `/api/accounts/${encodeURIComponent(accountId)}/token`, {
      body: { token, ...(tokenExpiresAt ? { tokenExpiresAt } : {}) }
    });
  }

  /** DC manual-key flow: verify the pasted key landed, clear the pending flag. */
  confirmAccountKey(accountId: string): Promise<AccountSummary> {
    return this.send("POST", `/api/accounts/${encodeURIComponent(accountId)}/confirm-key`);
  }

  // Workspaces & projects (filesystem-backed)

  listWorkspaces(signal?: AbortSignal): Promise<WorkspaceSummary[]> {
    return this.send("GET", "/api/workspaces", { signal });
  }

  createWorkspace(req: CreateWorkspaceRequest, signal?: AbortSignal): Promise<WorkspaceSummary> {
    return this.send("POST", "/api/workspaces", { body: req, signal });
  }

  listProjects(workspace: string, signal?: AbortSignal): Promise<ProjectSummary[]> {
    return this.send("GET", `/api/workspaces/${encodeURIComponent(workspace)}/projects`, { signal });
  }

  updateWorkspace(name: string, req: UpdateWorkspaceRequest): Promise<WorkspaceSummary> {
    return this.send("PUT", `/api/workspaces/${encodeURIComponent(name)}`, { body: req });
  }

  /** Daemon-owned recent-projects list (shared across devices), newest first. */
  listRecentProjects(signal?: AbortSignal): Promise<RecentProjectSummary[]> {
    return this.send("GET", "/api/projects/recent", { signal });
  }

  /**
   * Record one interaction with `path`. Returns the daemon's updated list; the
   * daemon also broadcasts `recentProjects.changed`, so this response is just a
   * fast local path for the client that made the mark.
   */
  markProjectInteracted(path: string): Promise<RecentProjectSummary[]> {
    return this.send("POST", "/api/projects/recent", {
      body: { path } satisfies MarkRecentProjectRequest
    });
  }

  /**
   * Past agent conversations for one project, merged across agents and newest
   * first. Scans each CLI's own history dir server-side, so it can take ~1s on a
   * busy project — callers cache it (see the store's agentConversationsByProject).
   */
  listAgentConversations(
    projectPath: string,
    signal?: AbortSignal
  ): Promise<AgentConversationsResponse> {
    return this.send("GET", "/api/agents/conversations", {
      query: { path: projectPath },
      signal
    });
  }

  updateProject(
    workspace: string,
    name: string,
    req: UpdateProjectRequest
  ): Promise<ProjectSummary> {
    return this.send(
      "PUT",
      `/api/workspaces/${encodeURIComponent(workspace)}/projects/${encodeURIComponent(name)}`,
      { body: req }
    );
  }

  // --- File browser --------------------------------------------------------

  listFiles(path: string, signal?: AbortSignal): Promise<FsListResponse> {
    return this.send("GET", "/api/fs", { query: fsPathQuery(path), signal });
  }

  readFile(path: string, signal?: AbortSignal): Promise<FsReadResponse> {
    return this.send("GET", "/api/fs/read", { query: fsPathQuery(path), signal });
  }

  /** Raw bytes of a file (binary-safe) for the preview viewers. */
  async readFileBytes(path: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    if (!this.transporter.requestBytes) {
      throw new Error("Binary preview is not supported on this connection.");
    }
    const response = await this.transporter.requestBytes({
      method: "GET",
      path: "/api/fs/raw",
      query: fsPathQuery(path),
      signal
    });
    if (!response.ok) {
      throw new ApiError(response.status, "GET", "/api/fs/raw", response.headers, undefined);
    }
    return response.data;
  }

  listArchive(path: string, signal?: AbortSignal): Promise<FsArchiveResponse> {
    return this.send("GET", "/api/fs/archive", { query: fsPathQuery(path), signal });
  }

  readParquet(
    path: string,
    opts: { offset?: number; limit?: number; orderBy?: string; desc?: boolean } = {},
    signal?: AbortSignal
  ): Promise<FsParquetResponse> {
    return this.send("GET", "/api/fs/parquet", {
      query: {
        ...fsPathQuery(path),
        offset: opts.offset,
        limit: opts.limit,
        orderBy: opts.orderBy,
        desc: opts.desc ? "1" : undefined
      },
      signal
    });
  }

  listProjectFiles(path: string, signal?: AbortSignal): Promise<FsFilesResponse> {
    return this.send("GET", "/api/fs/files", { query: fsPathQuery(path), signal });
  }

  searchFs(params: FsSearchRequest, signal?: AbortSignal): Promise<FsSearchResponse> {
    return this.send("GET", "/api/fs/search", {
      query: {
        ...fsPathQuery(params.path),
        q: params.q,
        caseSensitive: params.caseSensitive ? "1" : undefined,
        wholeWord: params.wholeWord ? "1" : undefined,
        regex: params.regex ? "1" : undefined,
        // Pass glob fields verbatim (only when non-empty) so the daemon reproduces
        // today's unfiltered behavior when they're absent.
        include: params.include && params.include.trim() ? params.include : undefined,
        exclude: params.exclude && params.exclude.trim() ? params.exclude : undefined,
        maxResults: params.maxResults
      },
      signal
    });
  }

  getFsCapabilities(signal?: AbortSignal): Promise<FsCapabilitiesResponse> {
    return this.send("GET", "/api/fs/capabilities", { signal });
  }

  /**
   * Build an authenticated URL for a native browser download (<a download>) of a
   * file or folder zip — or null when the transport can't be reached that way
   * (the desktop unix socket). The bearer rides as ?token= because a download
   * navigation can't set an Authorization header; the daemon accepts it only on
   * this route.
   */
  buildDownloadUrl(path: string): string | null {
    if (this.transportKind !== "http") {
      return null;
    }
    const base = this.connection.endpoint.replace(/\/$/, "");
    const params = new URLSearchParams(fsPathQuery(path));
    if (this.connection.password) {
      params.set("token", this.connection.password);
    }
    return `${base}/api/fs/download?${params.toString()}`;
  }

  /**
   * URL of the embedded DevTools frontend for a browser tab, or null when the
   * transport can't reach it (the desktop unix socket — same availability as
   * browser tabs). The frontend assets are proxied from the tab's Chromium;
   * the ws/wss param points the frontend at the daemon's authenticated CDP
   * proxy, with the bearer riding as ?token= (the /ws-browser trick). The
   * token therefore appears in the iframe/pop-out URL — accepted for a
   * single-user tool; see the design doc's security note.
   */
  buildDevtoolsUrl(browserId: string): string | null {
    if (this.transportKind !== "http") {
      return null;
    }
    const base = this.connection.endpoint.replace(/\/$/, "");
    const hostPath = `${base.replace(/^https?:\/\//, "")}/ws-devtools/${browserId}`;
    const wsValue = this.connection.password
      ? `${hostPath}?token=${encodeURIComponent(this.connection.password)}`
      : hostPath;
    const param = base.startsWith("https") ? "wss" : "ws";
    return `${base}/devtools-frontend/${browserId}/inspector.html?${param}=${encodeURIComponent(wsValue)}`;
  }

  /**
   * Buffered download (file bytes or a folder zip) for transports without a
   * native download URL (the desktop unix socket). Rides requestBytes, the same
   * channel readFileBytes uses.
   */
  async downloadBytes(path: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    if (!this.transporter.requestBytes) {
      throw new Error("Download is not supported on this connection.");
    }
    const response = await this.transporter.requestBytes({
      method: "GET",
      path: "/api/fs/download",
      query: fsPathQuery(path),
      signal
    });
    if (!response.ok) {
      throw new ApiError(response.status, "GET", "/api/fs/download", response.headers, undefined);
    }
    return response.data;
  }

  createFsEntry(path: string, kind: "file" | "dir"): Promise<{ ok: true }> {
    return this.send("POST", "/api/fs/create", { body: { path, kind } });
  }

  saveFile(path: string, content: string): Promise<{ ok: true }> {
    return this.send("PUT", "/api/fs/write", { body: { path, content } });
  }

  /**
   * Upload one file into the project tree. `data` (a dropped/picked `File`)
   * goes on the wire as a raw octet-stream body — nothing is base64'd, so the
   * only size limit is the daemon's MAX_UPLOAD_BYTES; `meta` rides the query.
   */
  uploadFsEntry(
    meta: FsUploadRequest,
    data: BinaryBody,
    onProgress?: (sent: number, total: number) => void
  ): Promise<FsUploadResponse> {
    return this.send("POST", "/api/fs/upload", {
      query: { destDir: meta.destDir, relativePath: meta.relativePath, onConflict: meta.onConflict },
      binaryBody: data,
      onUploadProgress: onProgress
    });
  }

  deleteFsEntry(path: string): Promise<{ ok: true }> {
    return this.send("DELETE", "/api/fs", { query: { path } });
  }

  renameFsEntry(path: string, newName: string): Promise<{ ok: true }> {
    return this.send("POST", "/api/fs/rename", { body: { path, newName } });
  }

  // --- To-do lists (daemon-persisted, synced) ------------------------------

  listTodos(scope: TodoScope, refKey: string, signal?: AbortSignal): Promise<TodoListRecord[]> {
    return this.send("GET", "/api/todos", { query: { scope, refKey }, signal });
  }

  createTodo(req: CreateTodoRequest): Promise<TodoListRecord> {
    return this.send("POST", "/api/todos", { body: req });
  }

  updateTodo(id: string, patch: UpdateTodoRequest): Promise<TodoListRecord> {
    return this.send("PUT", `/api/todos/${encodeURIComponent(id)}`, { body: patch });
  }

  deleteTodo(id: string): Promise<void> {
    return this.send("DELETE", `/api/todos/${encodeURIComponent(id)}`);
  }

  // --- Saved prompts (the right rail; daemon-persisted, shared) ------------

  /** Every global prompt, plus `projectPath`'s own when given. */
  listSavedPrompts(projectPath: string | null, signal?: AbortSignal): Promise<SavedPromptListResponse> {
    return this.send("GET", "/api/saved-prompts", {
      query: projectPath ? { projectPath } : undefined,
      signal
    });
  }

  createSavedPrompt(req: CreateSavedPromptRequest): Promise<SavedPrompt> {
    return this.send("POST", "/api/saved-prompts", { body: req });
  }

  updateSavedPrompt(id: string, patch: UpdateSavedPromptRequest): Promise<SavedPrompt> {
    return this.send("PUT", `/api/saved-prompts/${encodeURIComponent(id)}`, { body: patch });
  }

  deleteSavedPrompt(id: string): Promise<void> {
    return this.send("DELETE", `/api/saved-prompts/${encodeURIComponent(id)}`);
  }

  /** An Insert or a Send used the prompt: bumps `lastUsedAt` / `useCount`. */
  markSavedPromptUsed(id: string): Promise<SavedPrompt> {
    return this.send("POST", `/api/saved-prompts/${encodeURIComponent(id)}/used`);
  }

  // --- Automated workflows (workflows spec §8.1) ---------------------------

  /**
   * One workflow route: a refusal is a {@link WorkflowApiError} carrying the
   * daemon's `code` and, for `INVALID_WORKFLOW`, its `problems`.
   */
  private async workflowSend<T>(
    method: TransportMethod,
    path: string,
    options: ApiRequestOptions = {}
  ): Promise<T> {
    try {
      return await this.send<T>(method, path, options);
    } catch (error) {
      if (error instanceof ApiError && !(error instanceof WorkflowApiError)) {
        throw WorkflowApiError.from(error, method, path);
      }
      throw error;
    }
  }

  /** Every workflow's rail row; `projectPath` narrows to that project's. */
  listWorkflows(projectPath?: string | null, signal?: AbortSignal): Promise<ListWorkflowsResponse> {
    return this.workflowSend("GET", workflowRoutes.list, {
      query: projectPath ? { projectPath } : undefined,
      signal
    });
  }

  getWorkflow(id: string, signal?: AbortSignal): Promise<GetWorkflowResponse> {
    return this.workflowSend("GET", workflowRoutes.workflow(id), { signal });
  }

  createWorkflow(req: CreateWorkflowRequest): Promise<WorkflowWriteResponse> {
    return this.workflowSend("POST", workflowRoutes.create, { body: req });
  }

  /** Replace the whole definition; a stale `revision` is a 409 `REVISION_CONFLICT`. */
  replaceWorkflow(id: string, req: ReplaceWorkflowRequest): Promise<WorkflowWriteResponse> {
    return this.workflowSend("PUT", workflowRoutes.workflow(id), { body: req });
  }

  /** Atomic patch operations (§8.2). */
  patchWorkflow(id: string, req: PatchWorkflowRequest): Promise<WorkflowWriteResponse> {
    return this.workflowSend("POST", workflowRoutes.patch(id), { body: req });
  }

  validateWorkflow(req: ValidateWorkflowRequest, signal?: AbortSignal): Promise<ValidateWorkflowResponse> {
    return this.workflowSend("POST", workflowRoutes.validate, { body: req, signal });
  }

  duplicateWorkflow(id: string): Promise<WorkflowWriteResponse> {
    return this.workflowSend("POST", workflowRoutes.duplicate(id));
  }

  /** Cancels its runs and deletes them and its secrets. */
  deleteWorkflow(id: string): Promise<void> {
    return this.workflowSend("DELETE", workflowRoutes.workflow(id));
  }

  /** `{runId}`, or `{runId:null, skipped:"overlap"}` when the overlap policy skipped it (`force` overrides). */
  runWorkflow(id: string, req: RunWorkflowRequest = {}): Promise<RunWorkflowResponse> {
    return this.workflowSend("POST", workflowRoutes.run(id), { body: req });
  }

  /** "Test block": one block, its upstream inputs from pinned data or the last run. */
  testWorkflowNode(id: string, nodeId: string, req: RunWorkflowRequest = {}): Promise<RunWorkflowResponse> {
    return this.workflowSend("POST", workflowRoutes.testNode(id, nodeId), { body: req });
  }

  listWorkflowRuns(
    id: string,
    opts: { before?: string | null; limit?: number } = {},
    signal?: AbortSignal
  ): Promise<ListWorkflowRunsResponse> {
    return this.workflowSend("GET", workflowRoutes.runs(id), {
      query: { before: opts.before ?? undefined, limit: opts.limit },
      signal
    });
  }

  getWorkflowRun(runId: string, signal?: AbortSignal): Promise<GetWorkflowRunResponse> {
    return this.workflowSend("GET", workflowRoutes.runDetail(runId), { signal });
  }

  cancelWorkflowRun(runId: string): Promise<void> {
    return this.workflowSend("POST", workflowRoutes.runCancel(runId));
  }

  deleteWorkflowRunTempProject(runId: string): Promise<void> {
    return this.workflowSend("POST", workflowRoutes.runDeleteTempProject(runId));
  }

  /** A block's whole output (a run summary carries only a preview). */
  getWorkflowNodeOutput(runId: string, nodeId: string, signal?: AbortSignal): Promise<GetWorkflowNodeOutputResponse> {
    return this.workflowSend("GET", workflowRoutes.nodeOutput(runId, nodeId), { signal });
  }

  /**
   * A code/shell block's log as a chunked stream (`…/log?stream=&offset=&follow=1`),
   * read like the other chunked routes: decoded text chunks, then `onEnd`.
   * Open it only while the log is on screen, and close the handle when it leaves.
   */
  openWorkflowNodeLog(
    runId: string,
    nodeId: string,
    opts: { stream?: "stdout" | "stderr"; offset?: number; follow?: boolean },
    handlers: StreamHandlers
  ): StreamHandle {
    const query = buildQueryString({
      stream: opts.stream,
      offset: opts.offset,
      follow: opts.follow ? 1 : undefined
    });
    return this.transporter.openStream(`${workflowRoutes.nodeLog(runId, nodeId)}${query}`, handlers);
  }

  /** "Who would run now?" for an agent block's chain. */
  previewWorkflowAccount(req: AccountPreviewRequest, signal?: AbortSignal): Promise<AccountPreviewResponse> {
    return this.workflowSend("POST", workflowRoutes.accountPreview, { body: req, signal });
  }

  previewWorkflowSchedule(
    opts: { cron: string; tz?: string; count?: number },
    signal?: AbortSignal
  ): Promise<SchedulePreviewResponse> {
    return this.workflowSend("GET", workflowRoutes.schedulePreview, {
      query: { cron: opts.cron, tz: opts.tz, count: opts.count },
      signal
    });
  }

  workflowBlockTypes(signal?: AbortSignal): Promise<WorkflowBlockTypesResponse> {
    return this.workflowSend("GET", workflowRoutes.blockTypes, { signal });
  }

  /** Secret NAMES (never values): the global ones, plus `workflowId`'s own when given. */
  listWorkflowSecrets(workflowId?: string | null, signal?: AbortSignal): Promise<ListWorkflowSecretsResponse> {
    return this.workflowSend("GET", workflowRoutes.secrets, {
      query: workflowId ? { workflowId } : undefined,
      signal
    });
  }

  /** Set or replace a secret (write-only); global without `workflowId`. */
  setWorkflowSecret(name: string, value: string, workflowId?: string | null): Promise<void> {
    return this.workflowSend("PUT", workflowRoutes.secret(name), {
      query: workflowId ? { workflowId } : undefined,
      body: { value }
    });
  }

  deleteWorkflowSecret(name: string, workflowId?: string | null): Promise<void> {
    return this.workflowSend("DELETE", workflowRoutes.secret(name), {
      query: workflowId ? { workflowId } : undefined
    });
  }

  // --- Git -----------------------------------------------------------------

  gitStatus(path: string, signal?: AbortSignal): Promise<GitStatusResponse> {
    return this.send("GET", "/api/git/status", { query: { path }, signal });
  }

  /** The project's uncommitted changes as one capped patch (a saved prompt's `{diff}`). */
  gitWorkingDiff(
    path: string,
    maxBytes?: number,
    signal?: AbortSignal
  ): Promise<GitWorkingDiffResponse> {
    return this.send("GET", "/api/git/working-diff", {
      query: { path, maxBytes },
      signal
    });
  }

  gitDiff(
    path: string,
    file: string,
    opts?: { staged?: boolean; commit?: string },
    signal?: AbortSignal
  ): Promise<GitDiffResponse> {
    return this.send("GET", "/api/git/diff", {
      query: { path, file, staged: opts?.staged ? "true" : undefined, commit: opts?.commit },
      signal
    });
  }

  gitLog(
    path: string,
    opts?: { skip?: number; limit?: number },
    signal?: AbortSignal
  ): Promise<GitLogEntry[]> {
    return this.send("GET", "/api/git/log", {
      query: { path, skip: opts?.skip?.toString(), limit: opts?.limit?.toString() },
      signal
    });
  }

  gitCommitDetail(path: string, sha: string, signal?: AbortSignal): Promise<GitCommitDetail> {
    return this.send("GET", "/api/git/commit", { query: { path, sha }, signal });
  }

  gitBranches(path: string, signal?: AbortSignal): Promise<GitBranchesResponse> {
    return this.send("GET", "/api/git/branches", { query: { path }, signal });
  }

  gitStage(path: string, files: string[]): Promise<GitOpResult> {
    return this.send("POST", "/api/git/stage", { body: { path, files } });
  }

  gitUnstage(path: string, files: string[]): Promise<GitOpResult> {
    return this.send("POST", "/api/git/unstage", { body: { path, files } });
  }

  gitCommit(req: GitCommitRequest): Promise<GitOpResult> {
    return this.send("POST", "/api/git/commit", { body: req });
  }

  gitDiscard(path: string, files: string[]): Promise<GitOpResult> {
    return this.send("POST", "/api/git/discard", { body: { path, files } });
  }

  gitFetch(path: string): Promise<GitOpResult> {
    return this.send("POST", "/api/git/fetch", { body: { path } });
  }

  gitPull(path: string): Promise<GitOpResult> {
    return this.send("POST", "/api/git/pull", { body: { path } });
  }

  gitPush(path: string): Promise<GitOpResult> {
    return this.send("POST", "/api/git/push", { body: { path } });
  }

  gitCheckout(path: string, branch: string): Promise<GitOpResult> {
    return this.send("POST", "/api/git/checkout", { body: { path, branch } });
  }

  gitStashes(path: string, signal?: AbortSignal): Promise<GitStashEntry[]> {
    return this.send("GET", "/api/git/stashes", { query: { path }, signal });
  }

  gitStashCreate(req: GitStashCreateRequest): Promise<GitOpResult> {
    return this.send("POST", "/api/git/stash", { body: req });
  }

  /**
   * Apply a stash by its position in the list, keeping it. `sha` is the one the
   * caller saw at that position: the daemon 409s if the list shifted since, so a
   * stale row can never act on someone else's stash.
   */
  gitStashApply(req: GitStashActionRequest): Promise<GitOpResult> {
    return this.send("POST", "/api/git/stash/apply", { body: req });
  }

  /** Apply a stash by its position in the list and drop it. */
  gitStashPop(req: GitStashActionRequest): Promise<GitOpResult> {
    return this.send("POST", "/api/git/stash/pop", { body: req });
  }

  gitStashDrop(req: GitStashActionRequest): Promise<GitOpResult> {
    return this.send("POST", "/api/git/stash/drop", { body: req });
  }

  createProject(
    workspace: string,
    req: CreateProjectRequest,
    signal?: AbortSignal
  ): Promise<ProjectSummary> {
    return this.send("POST", `/api/workspaces/${encodeURIComponent(workspace)}/projects`, {
      body: req,
      signal
    });
  }

  deleteWorkspace(name: string): Promise<void> {
    return this.send("DELETE", `/api/workspaces/${encodeURIComponent(name)}`);
  }

  deleteProject(workspace: string, name: string): Promise<void> {
    return this.send(
      "DELETE",
      `/api/workspaces/${encodeURIComponent(workspace)}/projects/${encodeURIComponent(name)}`
    );
  }

  // Catalog (agents / open targets)

  listAgents(signal?: AbortSignal): Promise<AgentSummary[]> {
    return this.send("GET", "/api/agents", { signal });
  }

  listOpenTargets(signal?: AbortSignal): Promise<OpenTargetSummary[]> {
    return this.send("GET", "/api/open-targets", { signal });
  }

  // Registry (shells & agents)

  listRegistry(signal?: AbortSignal): Promise<RegistryResponse> {
    return this.send("GET", "/api/registry", { signal });
  }

  /** Project scaffold catalog + this daemon host's per-template availability. */
  listProjectTemplates(signal?: AbortSignal): Promise<ProjectTemplatesResponse> {
    return this.send("GET", "/api/templates", { signal });
  }

  getUsage(force?: boolean, signal?: AbortSignal): Promise<UsageResponse> {
    return this.send("GET", `/api/usage${force ? "?refresh=1" : ""}`, { signal });
  }

  getUsageTokens(force?: boolean, signal?: AbortSignal): Promise<UsageTokensResponse> {
    return this.send("GET", `/api/usage/tokens${force ? "?refresh=1" : ""}`, { signal });
  }

  getAgentAccounts(signal?: AbortSignal): Promise<AgentAccountsResponse> {
    return this.send("GET", "/api/agent-accounts", { signal });
  }

  importAgentAccount(req: ImportAgentAccountRequest): Promise<AgentAccount> {
    return this.send("POST", "/api/agent-accounts", { body: req });
  }

  removeAgentAccount(id: string): Promise<{ ok: true }> {
    return this.send("DELETE", `/api/agent-accounts/${encodeURIComponent(id)}`);
  }

  setAgentAccountDefaults(req: SetAgentAccountDefaultsRequest): Promise<AgentAccountsResponse> {
    return this.send("PUT", "/api/agent-accounts/defaults", { body: req });
  }

  // CliProxy — the managed CLIProxyAPI backing the claudex/claudemix launchers.
  // Status/models read over either transport; mutations are HTTP-only.

  getCliProxyStatus(signal?: AbortSignal): Promise<CliProxyStatus> {
    return this.send("GET", "/api/cliproxy", { signal });
  }

  getCliProxyModels(signal?: AbortSignal): Promise<{ models: string[]; asOf: string | null }> {
    return this.send("GET", "/api/cliproxy/models", { signal });
  }

  enableCliProxy(): Promise<CliProxyStatus> {
    return this.send("POST", "/api/cliproxy/enable");
  }

  disableCliProxy(force?: boolean): Promise<{ ok: boolean; affectedSessions?: number }> {
    return this.mutateAllowingRefusal<{ ok: boolean; affectedSessions?: number }>(
      "POST",
      "/api/cliproxy/disable",
      { force: Boolean(force) }
    );
  }

  setCliProxyConfig(
    cfg: {
      defaultModel?: string;
      backgroundModel?: string;
      modelOverrides?: Record<string, { contextWindow?: number; compactWindow?: number; compactPct?: number }>;
    },
    force?: boolean
  ): Promise<CliProxyStatus | CliProxyMutationRefusal> {
    return this.mutateAllowingRefusal<CliProxyStatus>("PUT", "/api/cliproxy/config", {
      ...cfg,
      force: Boolean(force)
    });
  }

  seedCliProxyAccount(req: CliProxySeedRequest): Promise<CliProxyProviderStatus> {
    return this.send("POST", "/api/cliproxy/accounts/seed", { body: req });
  }

  unseedCliProxyAccount(req: CliProxyUnseedRequest): Promise<CliProxyProviderStatus> {
    return this.send("POST", "/api/cliproxy/accounts/unseed", { body: req });
  }

  // Router providers (OpenRouter/TokenRouter presets or any custom
  // OpenAI-compatible gateway). Every mutation is restart-gated exactly like
  // setCliProxyConfig: a 409 comes back as { ok:false, affectedSessions } so the
  // caller can re-attempt with `force`. Keys only ever travel INTO the daemon —
  // no route here ever returns key material.

  putCliProxyRouterProvider(
    id: string,
    cfg: CliProxyRouterProviderRequest,
    force?: boolean
  ): Promise<CliProxyStatus | CliProxyMutationRefusal> {
    return this.mutateAllowingRefusal<CliProxyStatus>(
      "PUT",
      `/api/cliproxy/providers/${encodeURIComponent(id)}`,
      { ...cfg, force: Boolean(force) }
    );
  }

  deleteCliProxyRouterProvider(
    id: string,
    force?: boolean
  ): Promise<CliProxyStatus | CliProxyMutationRefusal> {
    return this.mutateAllowingRefusal<CliProxyStatus>(
      "DELETE",
      `/api/cliproxy/providers/${encodeURIComponent(id)}`,
      undefined,
      { force: force ? "true" : undefined }
    );
  }

  setCliProxyRouterKey(
    id: string,
    key: string,
    force?: boolean
  ): Promise<{ ok: boolean; affectedSessions?: number }> {
    return this.mutateAllowingRefusal<{ ok: boolean; affectedSessions?: number }>(
      "POST",
      `/api/cliproxy/providers/${encodeURIComponent(id)}/key`,
      { key, force: Boolean(force) }
    );
  }

  clearCliProxyRouterKey(
    id: string,
    force?: boolean
  ): Promise<{ ok: boolean; affectedSessions?: number }> {
    return this.mutateAllowingRefusal<{ ok: boolean; affectedSessions?: number }>(
      "DELETE",
      `/api/cliproxy/providers/${encodeURIComponent(id)}/key`,
      undefined,
      { force: force ? "true" : undefined }
    );
  }

  /** Browse the models a keyed router provider advertises upstream (read-only). */
  getCliProxyRouterCatalog(id: string, signal?: AbortSignal): Promise<{ models: string[] }> {
    return this.send("GET", `/api/cliproxy/providers/${encodeURIComponent(id)}/catalog`, { signal });
  }

  // xAI OAuth (Grok) account. No key and no seeded credential: the proxy owns
  // the tokens, so linking is just an RFC 8628 device-code prompt the daemon
  // starts and then polls, broadcasting `cliproxy.changed` as it advances.

  /**
   * Start the device-code flow. The returned prompt is also carried on
   * `CliProxyStatus.xai.link` (so a reload mid-flow still shows it) — callers
   * may render either. Requires a running proxy (409 otherwise).
   */
  linkCliProxyXai(): Promise<CliProxyXaiLink> {
    return this.send("POST", "/api/cliproxy/xai/link");
  }

  /**
   * Cancel an in-flight link, or unlink the account. Unlink is session-gated
   * like the router mutations (409 → { ok:false, affectedSessions }), though
   * nothing restarts: the proxy hot-discovers the auth-dir change.
   */
  unlinkCliProxyXai(force?: boolean): Promise<CliProxyStatus | CliProxyMutationRefusal> {
    return this.mutateAllowingRefusal<CliProxyStatus>(
      "DELETE",
      "/api/cliproxy/xai/link",
      undefined,
      { force: force ? "true" : undefined }
    );
  }

  installRegistryEntry(id: string): Promise<RegistryActionResult> {
    return this.send("POST", `/api/registry/${encodeURIComponent(id)}/install`);
  }

  updateRegistryEntry(id: string): Promise<RegistryActionResult> {
    return this.send("POST", `/api/registry/${encodeURIComponent(id)}/update`);
  }

  registryVersion(id: string): Promise<RegistryActionResult> {
    return this.send("GET", `/api/registry/${encodeURIComponent(id)}/version`);
  }

  /** Launch an ide/file-explorer/browser target on a path. */
  open(targetId: string, path: string): Promise<OpenResult> {
    return this.send("POST", "/api/open", { body: { targetId, path } });
  }

  // --- Web Push (web runtime only; bearer-gated on remote HTTP) -------------

  /** VAPID public key + subscription count; triggers lazy key generation. */
  pushInfo(signal?: AbortSignal): Promise<PushInfoResponse> {
    return this.send("GET", "/api/push/info", { signal });
  }

  pushSubscribe(req: PushSubscribeRequest): Promise<void> {
    return this.send("POST", "/api/push/subscriptions", { body: req });
  }

  pushUnsubscribe(req: PushUnsubscribeRequest): Promise<void> {
    return this.send("DELETE", "/api/push/subscriptions", { body: req });
  }

  /** Send a fixed test notification to every subscription. */
  pushTest(): Promise<PushTestResponse> {
    return this.send("POST", "/api/push/test");
  }

  // Sessions (PTYs)

  listSessions(projectPath?: string, signal?: AbortSignal): Promise<SessionSummary[]> {
    return this.send("GET", "/api/sessions", {
      query: projectPath ? { projectPath } : undefined,
      signal
    });
  }

  createSession(req: CreateSessionRequest): Promise<SessionSummary> {
    return this.send("POST", "/api/sessions", { body: req });
  }

  closeSession(id: string): Promise<void> {
    return this.send("DELETE", `/api/sessions/${encodeURIComponent(id)}`);
  }

  /**
   * A chat turn's unified diff (agent chat spec §6.3), for the changed-files
   * card's "view diff". Whitespace-insensitive by default, as §5.4 specifies.
   *
   * An ordinary request on both transports — nothing about a chat read needs
   * the multiplexed channel, which carries terminal bytes only.
   */
  agentChatTurnDiff(
    id: string,
    turnCount: number,
    query?: TurnDiffQuery
  ): Promise<TurnDiffResponse> {
    return this.agentChat.turnDiff(id, turnCount, query);
  }

  /** One activity item's full, unslimmed payload (§5.6's "load full output"). */
  agentChatItem(id: string, itemId: string): Promise<ThreadItemResponse> {
    return this.agentChat.readItem(id, itemId);
  }

  /**
   * The whole streamed output of the tool call an item belongs to, as the
   * host joins its chunks (§6.3 `GET …/items/:itemId/output`, read window by
   * window) — "load full output" on a command whose output streamed. `null`
   * where the host has none to give (a 404) or the transport cannot ask: the
   * caller reads the item instead.
   */
  agentChatItemOutput(
    id: string,
    itemId: string,
    signal?: AbortSignal
  ): Promise<ThreadItemOutputResponse | null> {
    return this.agentChat.readItemOutput?.(id, itemId, signal) ?? Promise.resolve(null);
  }

  /**
   * The thread's own user prompts, newest first, from the host's index — the
   * right rail's History. `indexed:false` from a host without an index; an
   * `ApiError` 404 from a host that predates the route.
   */
  agentChatPrompts(
    id: string,
    query: ThreadPromptsQuery = {},
    signal?: AbortSignal
  ): Promise<ThreadPromptsResponse> {
    return this.send("GET", agentChatRoutes.prompts(id), {
      query: { before: query.before, limit: query.limit },
      signal
    });
  }

  /** One prompt's whole text, for a History entry cut at the page's cap. */
  agentChatPromptText(
    id: string,
    messageId: string,
    signal?: AbortSignal
  ): Promise<ThreadPromptTextResponse> {
    return this.send("GET", agentChatRoutes.promptText(id, messageId), { signal });
  }

  sendSessionInput(id: string, data: string): Promise<void> {
    if (this.channel) {
      this.channel.sendInput(id, data);
      return Promise.resolve();
    }
    return this.send("POST", `/api/sessions/${encodeURIComponent(id)}/input`, { body: { data } });
  }

  /**
   * Upload a dropped/pasted file to the session's daemon and get back the
   * absolute daemon-side path. Rides the normal request path (HTTP/socket
   * bridge) as a raw octet-stream body — NOT the multiplexed `/ws` channel,
   * which only carries sub/unsub/input/resize.
   */
  uploadSessionFile(
    id: string,
    meta: SessionUploadRequest,
    data: BinaryBody,
    onProgress?: (sent: number, total: number) => void
  ): Promise<SessionUploadResponse> {
    return this.send("POST", `/api/sessions/${encodeURIComponent(id)}/upload`, {
      query: { name: meta.name, type: meta.type },
      binaryBody: data,
      onUploadProgress: onProgress
    });
  }

  resizeSession(id: string, cols: number, rows: number): Promise<void> {
    if (this.channel) {
      this.channel.resize(id, cols, rows);
      return Promise.resolve();
    }
    return this.send("POST", `/api/sessions/${encodeURIComponent(id)}/resize`, {
      body: { cols, rows }
    });
  }

  /**
   * `opts.seed` marks a chat thread's CLIENT-generated first-message title
   * (agent chat §7.7) rather than a rename the user typed, so a provider
   * retitle may still replace it. Omitted everywhere else.
   */
  renameSession(
    id: string,
    title: string,
    opts?: { seed?: boolean }
  ): Promise<SessionSummary> {
    return this.send("PUT", `/api/sessions/${encodeURIComponent(id)}`, {
      body: opts?.seed ? { title, seed: true } : { title }
    });
  }

  reorderSessions(projectPath: string, ids: string[]): Promise<void> {
    return this.send("POST", "/api/sessions/reorder", { body: { projectPath, ids } });
  }

  /** Open the live output stream for a session (buffer replay + live bytes). */
  openSessionOutput(id: string, handlers: StreamHandlers): StreamHandle {
    return this.channel
      ? this.channel.openOutput(id, handlers)
      : this.transporter.openStream(`/api/sessions/${encodeURIComponent(id)}/output`, handlers);
  }

  // Browsers (server-side headless Chromium tabs)

  listBrowsers(projectPath?: string, signal?: AbortSignal): Promise<BrowserSummary[]> {
    return this.send("GET", "/api/browsers", {
      query: projectPath ? { projectPath } : undefined,
      signal
    });
  }

  createBrowser(body: CreateBrowserRequest): Promise<BrowserSummary> {
    return this.send("POST", "/api/browsers", { body });
  }

  closeBrowser(id: string): Promise<void> {
    return this.send("DELETE", `/api/browsers/${encodeURIComponent(id)}`);
  }

  browserSuggestions(projectPath: string, signal?: AbortSignal): Promise<BrowserSuggestionsResponse> {
    return this.send("GET", "/api/browsers/suggestions", { query: { projectPath }, signal });
  }

  /** Undefined on transports without browser streaming (desktop unix socket). */
  browserChannel(): WsBrowserChannel | undefined {
    return this.transporter.browserChannel?.();
  }

  // System status (host observability). No push events exist for any of these —
  // callers poll them, and only while their surface is on screen.

  systemResources(signal?: AbortSignal): Promise<SystemResourcesResponse> {
    return this.send("GET", "/api/system/resources", { signal });
  }

  systemProcesses(signal?: AbortSignal): Promise<SystemProcessesResponse> {
    return this.send("GET", "/api/system/processes", { signal });
  }

  systemPorts(signal?: AbortSignal): Promise<SystemPortsResponse> {
    return this.send("GET", "/api/system/ports", { signal });
  }

  /**
   * SIGTERM a pid and its descendants. Refusals come back as a 400 whose body
   * carries a {@link KillProcessErrorCode} — thrown as an ApiError, so callers
   * read `error.body.code` to tell "protected" from "not managed".
   */
  killSystemProcess(pid: number): Promise<KillProcessResponse> {
    return this.send("POST", "/api/system/processes/kill", { body: { pid } });
  }
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    method: string,
    path: string,
    /** Response headers (lowercased keys), e.g. `retry-after` on a 429. */
    public readonly headers?: Record<string, string>,
    /** Parsed error body the daemon sent (e.g. `{ code, message }`), if any. */
    public readonly body?: unknown
  ) {
    const serverMessage = serverMessageFromBody(body);
    super(`Orquester API ${method} ${path} failed with status ${status}${serverMessage ? `: ${serverMessage}` : ""}`);
    this.name = "ApiError";
  }

  /**
   * The daemon's human-readable error message (`body.message`) when present —
   * e.g. git's stderr for a failed fetch/pull/push. Null when the body carried
   * no usable message, so callers can fall back to the generic `.message`.
   */
  get serverMessage(): string | null {
    return serverMessageFromBody(this.body);
  }

  /**
   * The offending field the daemon flagged (`body.field`, e.g. "include" /
   * "exclude" / "query" on an INVALID_GLOB), so the UI can attach the error to
   * the right input. Null when the body carried no field.
   */
  get serverField(): string | null {
    return serverFieldFromBody(this.body);
  }

  /** Parsed `Retry-After` (seconds) when present, else null. Set on 429s. */
  get retryAfterSeconds(): number | null {
    // Case-insensitive lookup: most transports lowercase header keys, but the
    // desktop NodeHttpClient path can surface a capitalized `Retry-After`.
    const headers = this.headers;
    let raw = headers?.["retry-after"];
    if (raw === undefined && headers) {
      for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === "retry-after") {
          raw = value;
          break;
        }
      }
    }
    if (!raw) {
      return null;
    }
    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  }
}

const WORKFLOW_ERROR_CODES: ReadonlySet<string> = new Set<WorkflowErrorCode>([
  "WORKFLOW_NOT_FOUND",
  "RUN_NOT_FOUND",
  "NODE_NOT_FOUND",
  "REVISION_CONFLICT",
  "INVALID_WORKFLOW",
  "INVALID_REQUEST",
  "WORKFLOWS_UNAVAILABLE",
  "LIMIT_EXCEEDED",
  "SECRET_INVALID",
  "RUN_NOT_ACTIVE",
  "ENGINE_UNAVAILABLE"
]);

/** One validation problem off the wire, field by field; `null` when unusable. */
function sanitizeWorkflowProblem(value: unknown): WorkflowProblem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const severity = record.severity;
  if (severity !== "error" && severity !== "warning" && severity !== "info") return null;
  if (typeof record.message !== "string") return null;
  const problem: WorkflowProblem = {
    severity,
    code: typeof record.code === "string" ? record.code : "unknown",
    message: record.message
  };
  if (typeof record.nodeId === "string") problem.nodeId = record.nodeId;
  if (typeof record.edgeId === "string") problem.edgeId = record.edgeId;
  if (typeof record.field === "string") problem.field = record.field;
  return problem;
}

/**
 * A refused workflow route (`{ error: { code, message, problems? } }`). An
 * {@link ApiError}, so every generic handler still reads it; `code` is `null`
 * for a body that named none (an older daemon's route-miss 404, a proxy error).
 */
export class WorkflowApiError extends ApiError {
  constructor(
    status: number,
    method: string,
    path: string,
    headers?: Record<string, string>,
    body?: unknown
  ) {
    super(status, method, path, headers, body);
    this.name = "WorkflowApiError";
  }

  static from(error: ApiError, method: string, path: string): WorkflowApiError {
    return new WorkflowApiError(error.status, method, path, error.headers, error.body);
  }

  private get errorObject(): Record<string, unknown> | null {
    const body = this.body;
    if (!body || typeof body !== "object") return null;
    const inner = (body as Record<string, unknown>).error;
    return inner && typeof inner === "object" && !Array.isArray(inner) ? (inner as Record<string, unknown>) : null;
  }

  /** The daemon's code, when it is one this client knows. */
  get code(): WorkflowErrorCode | null {
    const code = this.errorObject?.code ?? (this.body as { code?: unknown } | undefined)?.code;
    return typeof code === "string" && WORKFLOW_ERROR_CODES.has(code) ? (code as WorkflowErrorCode) : null;
  }

  /** `INVALID_WORKFLOW`'s problems (sanitized); `[]` otherwise. */
  get problems(): WorkflowProblem[] {
    const raw = this.errorObject?.problems;
    if (!Array.isArray(raw)) return [];
    const problems: WorkflowProblem[] = [];
    for (const entry of raw) {
      const problem = sanitizeWorkflowProblem(entry);
      if (problem !== null) problems.push(problem);
    }
    return problems;
  }
}
