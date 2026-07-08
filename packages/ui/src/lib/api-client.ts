import type {
  AccountSummary,
  AccountTestResult,
  AgentSummary,
  AuthInfoResponse,
  CreateAccountRequest,
  CreateProjectRequest,
  CreateSessionRequest,
  CreateTodoRequest,
  CreateWorkspaceRequest,
  EventMessage,
  FsArchiveResponse,
  FsCapabilitiesResponse,
  FsListResponse,
  FsReadResponse,
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
  TodoListRecord,
  TodoScope,
  UpdateTodoRequest,
  UsageResponse,
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

export interface ApiRequestOptions {
  query?: TransportRequest["query"];
  body?: unknown;
  signal?: AbortSignal;
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
    super(`Orquester API ${method} ${path} failed with status ${status}`);
    this.name = "ApiError";
  }

  /**
   * The daemon's human-readable error message (`body.message`) when present —
   * e.g. git's stderr for a failed fetch/pull/push. Null when the body carried
   * no usable message, so callers can fall back to the generic `.message`.
   */
  get serverMessage(): string | null {
    const body = this.body;
    if (body && typeof body === "object" && "message" in body) {
      const message = (body as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) {
        return message.trim();
      }
    }
    return null;
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
