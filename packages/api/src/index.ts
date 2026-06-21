import type { ClientConfig, DaemonConfig } from "@orquester/config";

export type RuntimeMode = "desktop-local" | "desktop-remote" | "web-remote";

export interface ApiEnvelope<T> {
  data: T;
}

export interface ApiErrorPayload {
  code: string;
  message: string;
}

export interface HealthResponse {
  ok: true;
}

export interface ServerInfoResponse {
  name: string;
  dataDir: string;
  workspacesDir: string;
  capabilities: {
    terminals: boolean;
    sessions: boolean;
    agents: boolean;
    docker: boolean;
  };
}

/**
 * A workspace is a top-level directory inside the daemon `workspacesDir`.
 * `(workspacesDir)/<name>` => workspace "name".
 */
export interface WorkspaceSummary {
  name: string;
  path: string;
  projectCount: number;
  /**
   * Git account this workspace is bound to, from workspaces.json (Phase 4).
   * `null`/absent = no binding (default git identity). The UI resolves the id
   * to a label from its accounts store; this contract carries only the id.
   */
  gitAccountId?: string | null;
  /** ISO creation timestamp from workspaces.json, when present. */
  createdAt?: string;
}

/**
 * A project is a sub-directory of a workspace directory.
 * `(workspacesDir)/<workspace>/<name>` => project "name".
 */
export interface ProjectSummary {
  name: string;
  workspace: string;
  path: string;
}

export interface CreateWorkspaceRequest {
  name: string;
  /** Optional git account to bind (Phase 4 wires the picker; undefined here). */
  gitAccountId?: string;
}

/**
 * Public view of a connected git account. Deliberately omits `keyPath`, the
 * GitHub `token`, and any private-key material — the daemon never returns
 * where/what the private key is, nor the token (only `repoAccess` reflects it).
 */
export interface AccountSummary {
  id: string;
  label: string;
  githubLogin: string;
  gitName: string;
  gitEmail: string;
  /** OpenSSH public key (safe to display/copy). */
  publicKey: string;
  /**
   * True when a GitHub token is persisted for this account (`!!account.token`),
   * enabling repo list/create. The token itself is never returned.
   */
  repoAccess: boolean;
  createdAt: string;
}

export interface CreateAccountRequest {
  /** User-facing label; also used in the SSH key comment + GitHub key title. */
  label: string;
  /** GitHub PAT — used transiently to upload the key + read identity, then discarded. */
  token: string;
}

/** Result of `POST /api/accounts/:id/test` (an `ssh -T git@github.com` probe). */
export interface AccountTestResult {
  ok: boolean;
  /** GitHub login parsed from the "Hi <login>!" greeting, when ok. */
  login?: string;
  /** Human-readable detail (success greeting or failure reason). */
  message?: string;
}

/**
 * A GitHub repository the account can reach, as projected by
 * `GET /api/accounts/:id/repos`. Carries only what the create-project picker
 * needs; the clone uses `sshUrl` (token never enters a clone URL/argv).
 */
export interface RepoSummary {
  /** "owner/name". */
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  /** git@github.com:owner/name.git — the SSH clone URL. */
  sshUrl: string;
  defaultBranch: string;
  description: string | null;
}

/**
 * Body for `POST /api/workspaces/:workspace/projects`. Discriminated on
 * `source`, which is OPTIONAL and defaults to "empty" so existing callers (the
 * "New Folder"/name-only path) keep working unchanged. Repo modes resolve the
 * GitHub account from the workspace's `gitAccountId`.
 */
export type CreateProjectRequest =
  | { source?: "empty"; name: string }
  /** `url`: full URL, `git@…`, or `owner/repo`; `name` overrides the dest dir. */
  | { source: "clone"; url: string; name?: string }
  | {
      source: "create";
      owner: string;
      name: string;
      visibility: "private" | "public";
      description?: string;
    };

/** A filesystem entry returned by the file browser. */
export interface FsEntry {
  name: string;
  path: string;
  kind: "dir" | "file";
  size: number;
}

export interface FsListResponse {
  path: string;
  /** Parent directory, or null at the filesystem root. */
  parent: string | null;
  entries: FsEntry[];
}

export interface FsReadResponse {
  path: string;
  content: string;
  size: number;
  /** True when the file was larger than the read cap and content is partial. */
  truncated: boolean;
}

export interface FsCreateRequest {
  path: string;
  kind: "file" | "dir";
}

export interface FsWriteRequest {
  path: string;
  content: string;
}

/** Public auth metadata for the HTTP transport (no secrets). */
export interface AuthInfoResponse {
  authRequired: boolean;
  /** bcrypt salt prefix the client uses to derive the bearer hash, or null. */
  salt: string | null;
  /**
   * Whether the credential also needs a username (UI hint; shows the username
   * field). True when auth is required. The username itself is never returned.
   */
  requiresUsername: boolean;
}

/** A pluggable coding agent the daemon detected on the host. */
export interface AgentSummary {
  id: string;
  name: string;
  installed: boolean;
  version?: string;
}

/** An editor/IDE or OS tool a project folder can be opened with. */
export interface OpenTargetSummary {
  id: string;
  name: string;
  kind: "ide" | "explorer" | "terminal";
  available: boolean;
}

// Registry — shells & agents share the same shape.

export type RegistryKind = "shell" | "agent" | "ide" | "file-explorer" | "browser";

/** Kinds that launch a persistent PTY session. */
export type SessionKind = Extract<RegistryKind, "shell" | "agent">;

/** Kinds the "Open in…" menu can launch (fire-and-forget, with a path). */
export type OpenKind = Extract<RegistryKind, "ide" | "file-explorer" | "browser">;

/** Lifecycle of a daemon-managed install/update for an agent. */
export type RegistryInstallState = "idle" | "installing" | "error";

export interface RegistryEntry {
  id: string;
  name: string;
  kind: RegistryKind;
  /** Candidate binaries (names and/or absolute install paths); first found wins (cached). */
  bin: string[];
  /** Extra args passed to the resolved bin when a session is launched (e.g. ["--d"]). */
  args?: string[];
  /** Extra environment variables set on the session process when launched. */
  env?: Record<string, string>;
  /** True only when a candidate bin resolved AND the entry is not disabled. */
  enabled: boolean;
  /** Absolute path of the resolved bin, when found. */
  resolvedBin?: string;
  /** Flag to print a version (agents only), e.g. "--version". */
  versionFlag?: string;
  /** Installed version, detected by running the version flag at startup (cached). */
  version?: string;
  /** Shell command to install the bin (agents only). */
  installCmd?: string;
  /** Shell command to update the bin (agents only). */
  updateCmd?: string;
  /** Live install/update status (daemon-managed, streamed over events). */
  installState: RegistryInstallState;
  /** Captured output when `installState === "error"`. */
  installError?: string;
}

export interface RegistryResponse {
  shells: RegistryEntry[];
  agents: RegistryEntry[];
  ides: RegistryEntry[];
  fileExplorers: RegistryEntry[];
  browsers: RegistryEntry[];
}

export interface RegistryActionResult {
  ok: boolean;
  exitCode: number;
  output: string;
}

export interface OpenRequest {
  /** Registry entry id of an ide/file-explorer/browser target. */
  targetId: string;
  /** Absolute path to open (a project folder). */
  path: string;
}

export interface OpenResult {
  ok: boolean;
  message?: string;
}

// Sessions — a live PTY (shell or agent) owned by the daemon. Open sessions
// for a project are that project's tabs; they outlive client disconnects.

export type SessionStatus = "running" | "exited";

export interface SessionSummary {
  id: string;
  kind: RegistryKind;
  /** Registry entry id this session was launched from (e.g. "bash", "claude"). */
  refId: string;
  title: string;
  /** Project the tab belongs to ("" = not bound to a project). */
  projectPath: string;
  cwd: string;
  cols: number;
  rows: number;
  status: SessionStatus;
  exitCode?: number;
  /** Per-project tab sort key (ascending); assigned by the daemon. */
  order: number;
  createdAt: string;
}

export interface CreateSessionRequest {
  kind: RegistryKind;
  refId: string;
  projectPath?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  title?: string;
}

export interface RenameSessionRequest {
  /** New label; empty/whitespace reverts to the registry entry's default name. */
  title: string;
}

export interface ReorderSessionsRequest {
  /** Project whose session tabs are being reordered. */
  projectPath: string;
  /** Session ids in the desired left-to-right order. */
  ids: string[];
}

export interface SessionInputRequest {
  data: string;
}

export interface SessionResizeRequest {
  cols: number;
  rows: number;
}

/** Frames pushed from daemon to client over the session stream. */
export type SessionStreamMessage =
  | { type: "buffer"; data: string }
  | { type: "output"; data: string }
  | { type: "exit"; exitCode: number };

/** Frames sent from client to daemon over the session stream. */
export type SessionInputMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

export interface EventMessage<TPayload = unknown> {
  id: string;
  channel: string;
  type: string;
  createdAt: string;
  payload: TPayload;
}

export interface SubscriptionRequest {
  channels: string[];
}

export interface OrquesterApi {
  health(): Promise<HealthResponse>;
  info(): Promise<ServerInfoResponse>;
  daemonConfig(): Promise<DaemonConfig>;
  clientConfig(): Promise<ClientConfig>;
  listWorkspaces(): Promise<WorkspaceSummary[]>;
  listProjects(workspace: string): Promise<ProjectSummary[]>;
}

export interface HttpApiClientOptions {
  baseUrl: string;
  password?: string;
  fetch?: typeof fetch;
}

export class HttpOrquesterApiClient implements OrquesterApi {
  private readonly baseUrl: string;
  private readonly password?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.password = options.password;
    this.fetchImpl = options.fetch ?? fetch;
  }

  health(): Promise<HealthResponse> {
    return this.get("/health");
  }

  info(): Promise<ServerInfoResponse> {
    return this.get("/api/info");
  }

  daemonConfig(): Promise<DaemonConfig> {
    return this.get("/api/config/daemon");
  }

  clientConfig(): Promise<ClientConfig> {
    return this.get("/api/config/client");
  }

  listWorkspaces(): Promise<WorkspaceSummary[]> {
    return this.get("/api/workspaces");
  }

  listProjects(workspace: string): Promise<ProjectSummary[]> {
    return this.get(`/api/workspaces/${encodeURIComponent(workspace)}/projects`);
  }

  createProject(workspace: string, req: CreateProjectRequest): Promise<ProjectSummary> {
    return this.post(`/api/workspaces/${encodeURIComponent(workspace)}/projects`, req);
  }

  listRepos(accountId: string): Promise<RepoSummary[]> {
    return this.get(`/api/accounts/${encodeURIComponent(accountId)}/repos`);
  }

  listOrgs(accountId: string): Promise<string[]> {
    return this.get(`/api/accounts/${encodeURIComponent(accountId)}/orgs`);
  }

  setAccountToken(accountId: string, token: string): Promise<void> {
    return this.post(`/api/accounts/${encodeURIComponent(accountId)}/token`, { token });
  }

  eventsUrl(): string {
    const url = new URL(this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/events";
    return url.toString();
  }

  private async get<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: this.authHeaders()
    });

    if (!response.ok) {
      throw new Error(`Orquester API request failed: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<T>;
  }

  private async post<T>(path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        ...this.authHeaders(),
        ...(body === undefined ? {} : { "Content-Type": "application/json" })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`Orquester API request failed: ${response.status} ${response.statusText}`);
    }

    // 204 No Content (e.g. POST /api/accounts/:id/token) has an empty body —
    // response.json() would throw. Void-returning callers get undefined.
    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }

  private authHeaders(): Record<string, string> {
    if (!this.password) {
      return {};
    }

    return {
      Authorization: `Bearer ${this.password}`
    };
  }
}
