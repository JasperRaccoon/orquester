import type {
  AccountSummary,
  AccountTestResult,
  AgentAccount,
  AgentAccountsResponse,
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
  CliProxySeedRequest,
  CliProxyStatus,
  CliProxyUnseedRequest,
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
  GitStatusResponse,
  HealthResponse,
  ImportAgentAccountRequest,
  OpenResult,
  OpenTargetSummary,
  ProjectSummary,
  PushInfoResponse,
  PushSubscribeRequest,
  PushTestResponse,
  PushUnsubscribeRequest,
  RegistryActionResult,
  RegistryResponse,
  RepoSummary,
  ServerInfoResponse,
  SessionSummary,
  SessionUploadRequest,
  SessionUploadResponse,
  SetAgentAccountDefaultsRequest,
  TodoListRecord,
  TodoScope,
  UpdateTodoRequest,
  UsageResponse,
  UsageTokensResponse,
  WorkspaceSummary
} from "@orquester/api";
import type { AppConfig, DaemonConfig, RemoteConnectionConfig } from "@orquester/config";
import type { UiConnection } from "../types";
import type {
  SessionChannel,
  StreamHandle,
  StreamHandlers,
  Transporter,
  TransportMethod,
  TransportRequest
} from "./transporter";
import type { WsBrowserChannel } from "./transporters/ws-browser-channel";

export interface ApiRequestOptions {
  query?: TransportRequest["query"];
  body?: unknown;
  signal?: AbortSignal;
}

function serverMessageFromBody(body: unknown): string | null {
  if (body && typeof body === "object" && "message" in body) {
    const message = (body as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
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

  constructor(
    public readonly connection: UiConnection,
    private readonly transporter: Transporter
  ) {
    this.channel = transporter.sessionChannel?.() ?? null;
  }

  get transportKind(): string {
    return this.transporter.kind;
  }

  /** Low-level escape hatch for endpoints not yet wrapped below. */
  async send<T>(method: TransportMethod, path: string, options: ApiRequestOptions = {}): Promise<T> {
    const response = await this.transporter.request<T>({
      method,
      path,
      query: options.query,
      body: options.body,
      signal: options.signal
    });

    if (!response.ok) {
      throw new ApiError(response.status, method, path, response.headers, response.data);
    }

    return response.data;
  }

  /**
   * POST/PUT for the restart-gated cliproxy mutations: the daemon answers a live
   * dependent-session conflict with 409 { ok:false, affectedSessions }. Turn that
   * into a first-class refusal value (not an ApiError throw) so the caller can
   * offer a force-confirm flow; every other non-2xx still throws via {@link send}.
   */
  private async mutateAllowingRefusal<T>(
    method: TransportMethod,
    path: string,
    body?: unknown
  ): Promise<T | CliProxyMutationRefusal> {
    try {
      return await this.send<T>(method, path, { body });
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
  openEvents(onEvent: (event: EventMessage) => void, onEnd?: () => void): () => void {
    let buffer = "";
    const handle = this.transporter.openStream("/events", {
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

  /** Org logins the account belongs to (needs a persisted token; 400 otherwise). */
  listOrgs(accountId: string, signal?: AbortSignal): Promise<string[]> {
    return this.send("GET", `/api/accounts/${encodeURIComponent(accountId)}/orgs`, { signal });
  }

  /** Persist a GitHub token for repo access. The token is only sent, never read back. */
  setAccountToken(accountId: string, token: string): Promise<void> {
    return this.send("POST", `/api/accounts/${encodeURIComponent(accountId)}/token`, {
      body: { token }
    });
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

  // --- File browser --------------------------------------------------------

  listFiles(path: string, signal?: AbortSignal): Promise<FsListResponse> {
    return this.send("GET", "/api/fs", { query: { path }, signal });
  }

  readFile(path: string, signal?: AbortSignal): Promise<FsReadResponse> {
    return this.send("GET", "/api/fs/read", { query: { path }, signal });
  }

  /** Raw bytes of a file (binary-safe) for the preview viewers. */
  async readFileBytes(path: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    if (!this.transporter.requestBytes) {
      throw new Error("Binary preview is not supported on this connection.");
    }
    const response = await this.transporter.requestBytes({
      method: "GET",
      path: "/api/fs/raw",
      query: { path },
      signal
    });
    if (!response.ok) {
      throw new ApiError(response.status, "GET", "/api/fs/raw", response.headers, undefined);
    }
    return response.data;
  }

  listArchive(path: string, signal?: AbortSignal): Promise<FsArchiveResponse> {
    return this.send("GET", "/api/fs/archive", { query: { path }, signal });
  }

  readParquet(
    path: string,
    opts: { offset?: number; limit?: number; orderBy?: string; desc?: boolean } = {},
    signal?: AbortSignal
  ): Promise<FsParquetResponse> {
    return this.send("GET", "/api/fs/parquet", {
      query: {
        path,
        offset: opts.offset,
        limit: opts.limit,
        orderBy: opts.orderBy,
        desc: opts.desc ? "1" : undefined
      },
      signal
    });
  }

  listProjectFiles(path: string, signal?: AbortSignal): Promise<FsFilesResponse> {
    return this.send("GET", "/api/fs/files", { query: { path }, signal });
  }

  searchFs(params: FsSearchRequest, signal?: AbortSignal): Promise<FsSearchResponse> {
    return this.send("GET", "/api/fs/search", {
      query: {
        path: params.path,
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
    const params = new URLSearchParams({ path });
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
      query: { path },
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

  uploadFsEntry(body: FsUploadRequest): Promise<FsUploadResponse> {
    return this.send("POST", "/api/fs/upload", { body });
  }

  deleteFsEntry(path: string): Promise<{ ok: true }> {
    return this.send("DELETE", "/api/fs", { query: { path } });
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

  // --- Git -----------------------------------------------------------------

  gitStatus(path: string, signal?: AbortSignal): Promise<GitStatusResponse> {
    return this.send("GET", "/api/git/status", { query: { path }, signal });
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
    cfg: { defaultModel?: string; backgroundModel?: string },
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

  setCliProxyOpenRouterKey(
    key: string,
    force?: boolean
  ): Promise<{ ok: boolean; affectedSessions?: number }> {
    return this.mutateAllowingRefusal<{ ok: boolean; affectedSessions?: number }>(
      "POST",
      "/api/cliproxy/openrouter/key",
      { key, force: Boolean(force) }
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
   * bridge) with a JSON body — NOT the multiplexed `/ws` channel, which only
   * carries sub/unsub/input/resize.
   */
  uploadSessionFile(id: string, body: SessionUploadRequest): Promise<SessionUploadResponse> {
    return this.send("POST", `/api/sessions/${encodeURIComponent(id)}/upload`, { body });
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

  renameSession(id: string, title: string): Promise<SessionSummary> {
    return this.send("PUT", `/api/sessions/${encodeURIComponent(id)}`, { body: { title } });
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
