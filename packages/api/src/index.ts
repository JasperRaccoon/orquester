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

/** One project file returned by GET /api/fs/files (recursive listing for search/quick-open). */
export interface FsProjectFile {
  /** Path relative to the searched root, using forward slashes. */
  path: string;
  size: number;
}

export interface FsFilesResponse {
  /** Absolute path of the searched root. */
  root: string;
  files: FsProjectFile[];
  /** True when the listing was capped (more files exist than returned). */
  truncated: boolean;
}

/** One match within a file (from GET /api/fs/search). */
export interface FsSearchMatch {
  /** 1-based line number. */
  line: number;
  /** The matched line, trimmed and capped to ~300 chars. */
  text: string;
  /** Match start char offset within `text`. */
  start: number;
  /** Match end char offset within `text`. */
  end: number;
}

export interface FsSearchFileResult {
  /** Path relative to the searched root, using forward slashes. */
  path: string;
  size: number;
  matches: FsSearchMatch[];
  /** True when this file had more matches than returned. */
  truncated: boolean;
}

export interface FsSearchResponse {
  files: FsSearchFileResult[];
  totalMatches: number;
  /** True when the overall result limit was reached. */
  limitHit: boolean;
  /** Tool used to search (diagnostics). */
  tool: "rg" | "node";
}

/** One entry inside an archive (from GET /api/fs/archive). */
export interface ArchiveEntry {
  /** POSIX-separated path within the archive, e.g. "src/index.ts". */
  name: string;
  size: number;
  dir: boolean;
}

export interface FsArchiveResponse {
  /** False when no host tool can read this archive format. */
  supported: boolean;
  entries: ArchiveEntry[];
  /** True when the listing was capped (more entries exist than returned). */
  truncated: boolean;
  /** Tool used (diagnostics), e.g. "7z" | "bsdtar". */
  tool?: string;
  /** Why unsupported, when supported is false. */
  reason?: string;
}

export interface FsCreateRequest {
  path: string;
  kind: "file" | "dir";
}

export interface FsWriteRequest {
  path: string;
  content: string;
}

export interface FsUploadRequest {
  /** Absolute directory under fsRoot the upload lands in. */
  destDir: string;
  /** Path within the upload, POSIX-separated, e.g. "folder 1/folder 2/file_c.txt". */
  relativePath: string;
  /** base64-encoded file bytes. */
  dataBase64: string;
  /** Conflict policy when the target already exists. Default "error". */
  onConflict?: "error" | "overwrite" | "rename";
}

export interface FsUploadResponse {
  /** Absolute final path written (after any rename); "" when conflict is true. */
  path: string;
  /** Final basename actually written (differs from the source under "rename"). */
  name: string;
  /** Bytes written (0 when conflict is true). */
  size: number;
  /**
   * True when the write did NOT happen because the target — or an intermediate
   * path segment — already existed: either onConflict was "error" and the
   * target existed, OR a file occupies an intermediate directory in
   * relativePath (reported for ANY onConflict, since mkdir then fails). In this
   * case path is "" and size is 0; see conflictKind.
   */
  conflict?: boolean;
  /** What already occupied the path (drives the type-clash message). */
  conflictKind?: "file" | "dir";
}

/** Server-side file-browser capabilities (GET /api/fs/capabilities). */
export interface FsCapabilitiesResponse {
  /** True when the server can produce a folder zip (a zip tool is on PATH). */
  folderZip: boolean;
  /** Resolved zip tool basename for diagnostics ("bsdtar"|"zip"|"7z"|…), or null. */
  zipTool: string | null;
}

// Git — a project's git repo surfaced as a GitHub-Desktop-style tab. Stateless;
// the daemon shells out to `git` in the project dir (no PTY/session).

export type GitFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "typechange"
  | "untracked"
  | "conflicted";

/** A changed file in the working tree / index. A file may be both staged and unstaged. */
export interface GitFileChange {
  path: string;
  status: GitFileStatus;
  /** Present in the index (will be committed). */
  staged: boolean;
  /** Has working-tree changes not yet staged. */
  unstaged: boolean;
  /** Original path for renames/copies. */
  oldPath?: string;
}

export interface GitStatusResponse {
  isRepo: boolean;
  /** Current branch name; null when detached or no commits yet. */
  branch: string | null;
  detached: boolean;
  /** Upstream ref, e.g. "origin/main"; null when none. */
  upstream: string | null;
  ahead: number;
  behind: number;
  /** ISO timestamp from .git/FETCH_HEAD mtime, or null if never fetched. */
  lastFetched: string | null;
  files: GitFileChange[];
}

export interface GitDiffResponse {
  /** Raw unified diff text (git diff / git show output, --no-color). Empty when no diff. */
  diff: string;
  binary: boolean;
}

export interface GitLogEntry {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  authorName: string;
  authorEmail: string;
  /** ISO author date. */
  date: string;
  /** Decorations: branch/tag names on this commit, e.g. ["main", "origin/main", "v1.2"]. */
  refs: string[];
}

export interface GitCommitFile {
  path: string;
  oldPath?: string;
  status: GitFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface GitCommitDetail {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  authorName: string;
  authorEmail: string;
  date: string;
  files: GitCommitFile[];
}

export interface GitBranch {
  name: string;
  current: boolean;
  upstream?: string;
}

export interface GitBranchesResponse {
  current: string | null;
  local: GitBranch[];
  /** Remote-tracking branch names, e.g. ["origin/main", "origin/dev"]. */
  remote: string[];
}

export interface GitCommitRequest {
  path: string;
  summary: string;
  description?: string;
}

/** Generic result for git mutations (stage/unstage/commit/discard/fetch/pull/push/checkout). */
export interface GitOpResult {
  ok: true;
  /** Combined stdout/stderr of the op (shown for fetch/pull/push), trimmed. */
  output?: string;
}

// To-do lists — daemon-owned, synced checklists. One record per list; the checklist
// is GitHub task-list markdown in `body`. Scoped to a workspace (refKey = workspace
// name) or a project (refKey = project path). No PTY/session.

export type TodoScope = "workspace" | "project";

export interface TodoListRecord {
  id: string;
  name: string;            // free-form, renamable (NOT a filename)
  scope: TodoScope;
  refKey: string;          // workspace name (scope "workspace") | project path (scope "project")
  body: string;            // "- [ ] a\n- [x] b" ; "" when empty
  createdAt: string;       // ISO
  updatedAt: string;       // ISO (TodoListRecord timestamp)
}

export interface CreateTodoRequest {
  scope: TodoScope;
  refKey: string;
  name?: string;           // default "Untitled"
}

/** Patch: send only the fields you change. */
export interface UpdateTodoRequest {
  name?: string;
  body?: string;
}

/** `/events` channel "todos"; type one of these. Payload is always a full TodoListRecord
 *  (for "todo.deleted" it is the record as it was at deletion — clients remove by id). */
export type TodoEventType = "todo.created" | "todo.updated" | "todo.deleted";

/** One quota window (0–100 % used) with its reset time (ISO 8601). */
export interface UsageWindow {
  percent: number;
  resetsAt?: string;
  /** Optional capacity fields when a multi-account source provides them. */
  used?: number;
  limit?: number;
  remaining?: number;
}

/** Per sub-account quota for agents that pool multiple logins (e.g. TeamClaude). */
export interface UsageAccount {
  id: string;
  label?: string;
  available: boolean;
  stale: boolean;
  plan?: string;
  session: UsageWindow | null;
  weekly: UsageWindow | null;
  asOf?: string;
}

export interface AgentUsage {
  id: "claude" | "codex";
  /** installed + logged in + at least one window present. */
  available: boolean;
  /** data known but the token/log is expired/old (last-known shown greyed). */
  stale: boolean;
  /** e.g. "Max 20x", "Pro". */
  plan?: string;
  /** rolling 5-hour window (aggregate when multi-account). */
  session: UsageWindow | null;
  weekly: UsageWindow | null;
  /** ISO time the reading was actually obtained (for an honest "as of"). */
  asOf?: string;
  /** Per-account breakdown when the agent pools multiple accounts. */
  accounts?: UsageAccount[];
  /** How the top-level session/weekly windows were aggregated. */
  aggregate?: {
    strategy: "equal-weight" | "capacity-weighted" | "source-provided" | "worst-account";
    accountCount: number;
    staleAccountCount?: number;
  };
}

export interface UsageResponse {
  /** Only logged-in agents; empty ⇒ the widget hides. Freshness lives on each
   *  agent's `asOf`; there is deliberately no top-level poll timestamp. */
  agents: AgentUsage[];
}

export type UsageEventType = "usage.changed";

// Web Push — the PWA subscribes browsers to attention pushes that fire when an
// agent session rings the terminal bell. The daemon owns a VAPID keypair; only
// the public key ever crosses the wire (the private key stays in push.json).

export interface PushInfoResponse {
  supported: boolean;
  vapidPublicKey: string;
  subscriptionCount: number;
}

export interface PushSubscriptionKeys {
  p256dh: string;
  auth: string;
}

export interface PushSubscribeRequest {
  endpoint: string;
  keys: PushSubscriptionKeys;
  userAgent?: string;
}

export interface PushUnsubscribeRequest {
  endpoint: string;
}

export interface PushTestResponse {
  sent: number;
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
  /** Launch the resolved bin as a child of a real shell instead of execing it directly. */
  launchViaShell?: boolean;
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

// Addons — installable companion tools (e.g. TeamClaude). Not launchable as sessions.

export interface AddonEntry {
  id: string;
  name: string;
  description?: string;
  /** Local, reviewed markdown shown in the Settings → Addons card. */
  readmeMarkdown: string;
  installed: boolean;
  /** Master activate toggle (only meaningful when installed). */
  enabled: boolean;
  resolvedBin?: string;
  version?: string;
  installCmd?: string;
  updateCmd?: string;
  installState: RegistryInstallState;
  installError?: string;
}

export interface AddonsResponse {
  addons: AddonEntry[];
}

/** Safe TeamClaude account summary — never includes tokens. */
export interface TeamClaudeAccountSummary {
  name: string;
  type?: string;
  priority?: number;
  disabled?: boolean;
  hasCredentials: boolean;
  orgName?: string;
}

export interface TeamClaudeStormRamp {
  enabled: boolean;
  startConc: number;
  stepConc: number;
  stepMs: number;
  windowMs: number;
}

export interface TeamClaudeStatus {
  installed: boolean;
  enabled: boolean;
  running: boolean;
  version?: string;
  /** Org avatar (GitHub) for the addon card. */
  logoUrl: string;
  port: number;
  switchThreshold: number;
  /** Background quota-probe interval seconds (0 = off). */
  quotaProbeSeconds: number;
  /** Keep-warm interval seconds (0 = off). */
  warmupSeconds: number;
  autoUpdate: boolean;
  upstream: string;
  stormRamp: TeamClaudeStormRamp;
  /** sx.org residential proxy mode; key never returned. */
  sxMode: "always" | "429" | "off";
  sxKeyConfigured: boolean;
  accounts: TeamClaudeAccountSummary[];
  installState: RegistryInstallState;
  installError?: string;
  lastError?: string;
  readmeMarkdown: string;
}

export interface TeamClaudeSettingsUpdate {
  enabled?: boolean;
  switchThreshold?: number;
  port?: number;
  quotaProbeSeconds?: number;
  warmupSeconds?: number;
  autoUpdate?: boolean;
  upstream?: string;
  stormRamp?: Partial<TeamClaudeStormRamp>;
  sxMode?: "always" | "429" | "off";
  /** Write-only; set empty string to clear. Never returned. */
  sxApiKey?: string;
}

export interface TeamClaudeImportRequest {
  /** Optional path to Claude Code credentials.json on the daemon host; omit for default. */
  from?: string;
  /** Raw credentials.json contents (client upload / drag-drop). Mutually exclusive with `from`. */
  content?: string;
}

export interface TeamClaudeApiKeyRequest {
  apiKey: string;
  name?: string;
}

export interface TeamClaudeAccountActionRequest {
  name: string;
}

export interface TeamClaudePriorityRequest {
  name: string;
  priority: number;
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

/** Body for `POST /api/sessions/:id/upload` — a file dropped/pasted onto a terminal. */
export interface SessionUploadRequest {
  /** Original filename (may be empty for clipboard images). */
  name: string;
  /** MIME type if known (e.g. "image/png"). */
  type?: string;
  /** Base64-encoded file bytes. */
  dataBase64: string;
}

export interface SessionUploadResponse {
  /** Absolute daemon-side path the agent can read. */
  path: string;
  /** Final on-disk basename (sanitized). */
  name: string;
  /** Bytes written. */
  size: number;
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
  usage(force?: boolean): Promise<UsageResponse>;
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

  uploadSessionFile(id: string, body: SessionUploadRequest): Promise<SessionUploadResponse> {
    return this.post(`/api/sessions/${encodeURIComponent(id)}/upload`, body);
  }

  uploadFsEntry(body: FsUploadRequest): Promise<FsUploadResponse> {
    return this.post("/api/fs/upload", body);
  }

  getFsCapabilities(): Promise<FsCapabilitiesResponse> {
    return this.get("/api/fs/capabilities");
  }

  usage(force?: boolean): Promise<UsageResponse> {
    return this.get(`/api/usage${force ? "?refresh=1" : ""}`);
  }

  deleteFsEntry(path: string): Promise<{ ok: true }> {
    return this.delete(`/api/fs?path=${encodeURIComponent(path)}`);
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

  private async delete<T>(path: string): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "DELETE",
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
