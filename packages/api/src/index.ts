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
  /** 0-based char offset of the match start within the FULL original line (for editor jumps). */
  column: number;
  /** Length of the match in chars. */
  matchLength: number;
}

/**
 * Parameters for GET /api/fs/search. Omitting every optional field reproduces the
 * pre-existing literal, case-insensitive, unfiltered search behavior.
 */
export interface FsSearchRequest {
  /** Absolute path of the root to search under. */
  path: string;
  /** The query text (literal, unless `regex` is set). */
  q: string;
  /** Match case exactly. Defaults to case-insensitive. */
  caseSensitive?: boolean;
  /** Require word boundaries around each match. */
  wholeWord?: boolean;
  /** Treat `q` as a regular expression (rg-backed only; rejected without ripgrep). */
  regex?: boolean;
  /** Comma-separated glob field limiting which files are searched. */
  include?: string;
  /** Comma-separated glob field excluding files from the search. */
  exclude?: string;
  /** Cap on total matches returned. */
  maxResults?: number;
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

/** One column of a parquet file (from GET /api/fs/parquet). */
export interface ParquetColumn {
  name: string;
  /** Human-readable type label, e.g. "INT64" | "STRING" | "TIMESTAMP" | "LIST". */
  type: string;
}

export interface FsParquetResponse {
  /** False when the file can't be parsed (corrupt, exotic codec). */
  supported: boolean;
  /** Total rows in the file (not the window). */
  rowCount: number;
  columns: ParquetColumn[];
  /** Window of rows, positional per `columns`. Values are JSON-safe. */
  rows: unknown[][];
  /** Echo of the effective (clamped) window offset. */
  offset: number;
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

/** Per sub-account quota for agents that pool multiple logins. */
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
  id: string; // was "claude" | "codex"; opened up so new agents can report usage
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

export interface UsageTokenRow {
  agent: string;
  model: string;
  day: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** 1h-TTL subset of cacheWriteTokens (bills at 2x input instead of 1.25x).
   *  Optional: absent in cache files persisted before this field existed. */
  cacheWrite1hTokens?: number;
  costUsd: number | null;
  /** Per-class share of costUsd (cache = reads + writes). Optional: absent in
   *  cache files persisted before this field existed; null for unpriced models. */
  costBreakdown?: { input: number; output: number; cache: number } | null;
  costSource: "api_equivalent";
}
export interface UsageTokensResponse {
  rows: UsageTokenRow[];
  asOf: string;
}

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
  /**
   * Human-readable reason the entry is currently disabled at runtime (e.g. the
   * managed proxy is down or an upstream credential expired). Surfaced only when
   * effective `enabled` is false and the daemon set a runtime reason; absent
   * otherwise. Lets the UI explain a greyed-out launcher instead of hiding it.
   */
  disabledReason?: string;
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

/** Coarse liveness of a session, derived by the daemon (single source of truth). */
export type SessionActivityState = "working" | "waiting" | "idle";

/**
 * Why the session wants the user's eyes. "bell" = terminal BEL with no
 * structural hook info; "needs-input"/"finished" come from agent hooks.
 */
export type SessionAttention = "bell" | "needs-input" | "finished";

export interface SessionActivity {
  state: SessionActivityState;
  attention: SessionAttention | null;
  /** ISO timestamp of the last PTY output, null before first output. */
  lastOutputAt: string | null;
}

/** Payload of the "session.activity" event (channel "sessions"). */
export interface SessionActivityEvent {
  id: string;
  activity: SessionActivity;
}

/** Agents whose managed hooks report structural status to the daemon. */
export type AgentEventSource = "claude" | "codex" | "opencode";

/** Body of POST /api/sessions/:id/agent-event (unix-socket transport only). */
export interface AgentEventRequest {
  source: AgentEventSource;
  event: string;
  payload?: unknown;
}

export type AgentAccountAgent = "claude" | "codex";

export interface AgentAccount {
  id: string;
  agent: AgentAccountAgent;
  label: string;
  email: string | null;
  plan: string | null;
  needsReauth: boolean;
  createdAt: string;
  importedAt: string;
}

export interface AgentAccountsResponse {
  accounts: AgentAccount[];
  defaults: { claude: string | null; codex: string | null };
}

export interface ImportAgentAccountRequest {
  content?: string;
  from?: string;
  label?: string;
}

export interface SetAgentAccountDefaultsRequest {
  claude?: string | null;
  codex?: string | null;
}

export type AgentAccountsEventType = "agent-accounts.changed";

// CliProxy — the managed CLIProxyAPI process backing the claudex/claudemix
// launchers. Status is read-only over both transports; mutations are HTTP-only.

/** Upstream identity providers the managed proxy brokers. */
export type CliProxyProviderId = "codex" | "claude" | "openrouter";

/**
 * A restart-gated cliproxy mutation (config/openrouter-key/disable) refused
 * because dependent sessions are live — the parsed 409 body. Callers re-attempt
 * with `force` after confirming with the user.
 */
export type CliProxyMutationRefusal = { ok: false; affectedSessions: number };

export interface CliProxyProviderStatus {
  provider: CliProxyProviderId;
  state: "ok" | "missing" | "expired";
  lastVerifiedAt: string | null;
}

export interface CliProxyStatus {
  state: "off" | "downloading" | "building" | "starting" | "healthy" | "degraded" | "error";
  reasons: string[];
  detail: string | null;
  version: string | null;
  defaultModel: string;
  backgroundModel: string;
  providers: CliProxyProviderStatus[];
  accounts: { id: string; provider: CliProxyProviderId; label: string; email?: string }[];
  activeSessionCount: number;
  testedClaudeCliVersion: string | null;
}

/**
 * Body for `POST /api/cliproxy/accounts/seed` — the credential path. The daemon
 * reads that managed account's credential, converts it into CLIProxyAPI's
 * auth-file schema, stamps the deterministic routing prefix, and writes it into
 * `auth/` (spec §4). No secret material crosses this request.
 */
export interface CliProxySeedRequest {
  provider: "codex" | "claude";
  accountId: string;
}

/**
 * Body for `POST /api/cliproxy/accounts/unseed` — the reverse of a seed. Removes
 * the seeded credential from the proxy's `auth/` dir and restores Orquester's
 * ownership of the managed account's token (spec §4). Same shape as a seed.
 */
export type CliProxyUnseedRequest = CliProxySeedRequest;

/**
 * Sentinel `accountId` on a create-session request meaning "explicit System /
 * host identity" — resolve to no managed account even when a per-agent default
 * is set. Distinct from an OMITTED accountId, which resolves to the default.
 * Managed account ids are UUIDs, so this can never collide with a real one.
 */
export const SYSTEM_ACCOUNT_ID = "system";

export interface SessionSummary {
  id: string;
  kind: RegistryKind;
  /** Registry entry id this session was launched from (e.g. "bash", "claude"). */
  refId: string;
  /** Managed agent account this session was launched under, if any. */
  accountId?: string;
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
  /**
   * Effective model this session was launched with, for the claudex/claudemix
   * launchers only (the per-launch model pick, resolved to the concrete catalog
   * string). Absent for every other launcher and for pre-field records.
   */
  model?: string;
  /**
   * Launch-time model pre-flight (spec §8.4): referenced/configured models that
   * the live catalog did NOT offer when this claudex/claudemix session launched.
   * Advisory only — a missing model warns, it never blocks the launch — and it is
   * a one-time launch snapshot: absent for other launchers, when nothing was
   * missing, and on re-listed/persisted records.
   */
  missingModels?: string[];
  /** Live activity snapshot; absent in persisted indexes and for exited sessions. */
  activity?: SessionActivity;
}

export interface CreateSessionRequest {
  kind: RegistryKind;
  refId: string;
  projectPath?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  title?: string;
  accountId?: string;
  /**
   * Per-launch model pick — valid only for the claudex/claudemix launchers,
   * rejected with 400 for any other refId. Omitted → the manager's configured
   * default model. Validated against the proxy's live catalog before launch.
   */
  model?: string;
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

// Browsers — a server-side headless Chromium tab owned by the daemon (one
// Chromium PROCESS per project, one CDP page per tab). Streamed over /ws-browser.

export type BrowserViewportMode = "desktop" | "mobile";

export type BrowserStatus = "stopped" | "starting" | "running" | "crashed" | "error";

export interface BrowserSummary {
  id: string;
  projectPath: string;
  /** Last known URL (persisted; re-navigated to on relaunch). */
  url: string;
  /** Last known page title ("" until first load). */
  title: string;
  viewportMode: BrowserViewportMode;
  /** Per-project tab sort key (ascending); assigned by the daemon. */
  order: number;
  createdAt: string;
  status: BrowserStatus;
  /** False when Chromium had to be launched with --no-sandbox (UI shows a warning). */
  sandboxed: boolean;
  /** Launch/runtime error tail when status === "error". */
  errorMessage?: string;
}

export interface CreateBrowserRequest {
  projectPath: string;
  /** Initial URL; defaults to "about:blank". */
  url?: string;
}

export interface BrowserSuggestionsResponse {
  /** Detected dev-server origins for the project, most recent first (≤ 8). */
  urls: string[];
}

// Design Mode pick payload. Extracted in-page, then RE-CLAMPED server-side
// (see apps/daemon/src/browser-pick.ts) — page output is hostile.

export interface BrowserPickTarget {
  tagName: string;
  /** Verified-unique CSS selector (bottom-up, :nth-of-type disambiguated). */
  selector: string;
  /** Human-readable ancestor path, e.g. "div#app > main > button.save". */
  elementPath: string;
  cssClasses: string[];
  /** Allow-listed attributes only. */
  attributes: Record<string, string>;
  /** ~16-property getComputedStyle subset. */
  computedStyles: Record<string, string>;
  rectViewport: { x: number; y: number; width: number; height: number };
  accessibility: { role: string; name: string };
  /** React _debugSource, when the dev build provides it: "file:line:col". */
  reactSource?: string;
  reactComponents?: string[];
  textSnippet: string;
  /** outerHTML, scripts stripped, ≤ 4096 chars. */
  htmlSnippet: string;
}

export interface BrowserPickPayload {
  page: {
    /** Origin + path only (query/hash stripped). */
    url: string;
    title: string;
    viewport: { width: number; height: number };
    viewportMode: BrowserViewportMode;
  };
  target: BrowserPickTarget;
  /** Cropped PNG (element rect + 8px pad), base64, ≤ 2 MB; omitted on overflow. */
  screenshotBase64?: string;
}

// /ws-browser wire protocol. Server→client pixels are BINARY frames:
// [u8 type=BROWSER_FRAME_TYPE_JPEG][36-byte tab id (uuid ascii)][JPEG bytes].
// Everything else is JSON text.

export const BROWSER_FRAME_TYPE_JPEG = 1;

export interface BrowserStateMessage {
  t: "state";
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  viewportMode: BrowserViewportMode;
  status: BrowserStatus;
  sandboxed: boolean;
}

export type BrowserServerJsonMessage =
  | BrowserStateMessage
  | { t: "picked"; id: string; payload: BrowserPickPayload }
  /** Remote focus moved onto (true) / off (false) a text-editable element —
   *  drives the mobile client's auto keyboard raise/dismiss. */
  | { t: "focus"; id: string; editable: boolean }
  | { t: "end"; id: string }
  | { t: "pong" };

export type BrowserClientMessage =
  | { t: "sub"; id: string }
  | { t: "unsub"; id: string }
  | {
      t: "pointer";
      id: string;
      kind: "move" | "down" | "up";
      x: number;
      y: number;
      button: "none" | "left" | "middle" | "right";
      modifiers: number;
      clickCount: number;
    }
  | { t: "wheel"; id: string; x: number; y: number; dx: number; dy: number }
  | {
      t: "key";
      id: string;
      kind: "down" | "up" | "char";
      key: string;
      code: string;
      text?: string;
      modifiers: number;
      /** DOM keyCode → CDP windowsVirtualKeyCode; required for Chromium to act
       *  on non-printable keys (Backspace/Delete/arrows/Enter). */
      keyCode?: number;
    }
  | {
      t: "touch";
      id: string;
      kind: "start" | "move" | "end";
      points: Array<{ x: number; y: number }>;
    }
  | {
      /** Client clipboard text → CDP Input.insertText into the remote focus
       *  (the remote Chromium cannot see the viewer's clipboard). */
      t: "insertText";
      id: string;
      text: string;
    }
  | { t: "nav"; id: string; action: "goto" | "back" | "forward" | "reload"; url?: string }
  | { t: "viewport"; id: string; mode: BrowserViewportMode }
  | { t: "pick"; id: string; on: boolean }
  | { t: "ping" };

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

  // CliProxy — the managed CLIProxyAPI backing the claudex/claudemix launchers.
  // Status/models read over either transport; mutations are HTTP-only (403 over
  // the Unix socket) and never carry secret material.

  getCliProxyStatus(): Promise<CliProxyStatus> {
    return this.get("/api/cliproxy");
  }

  getCliProxyModels(): Promise<{ models: string[]; asOf: string | null }> {
    return this.get("/api/cliproxy/models");
  }

  enableCliProxy(): Promise<CliProxyStatus> {
    return this.post("/api/cliproxy/enable");
  }

  disableCliProxy(force?: boolean): Promise<{ ok: boolean; affectedSessions?: number }> {
    return this.mutateAllowingRefusal("POST", "/api/cliproxy/disable", { force: Boolean(force) });
  }

  setCliProxyConfig(
    cfg: { defaultModel?: string; backgroundModel?: string; claudeDefaultModel?: string },
    force?: boolean
  ): Promise<CliProxyStatus | CliProxyMutationRefusal> {
    return this.mutateAllowingRefusal("PUT", "/api/cliproxy/config", { ...cfg, force: Boolean(force) });
  }

  seedCliProxyAccount(req: CliProxySeedRequest): Promise<CliProxyProviderStatus> {
    return this.post("/api/cliproxy/accounts/seed", req);
  }

  unseedCliProxyAccount(req: CliProxyUnseedRequest): Promise<CliProxyProviderStatus> {
    return this.post("/api/cliproxy/accounts/unseed", req);
  }

  setCliProxyOpenRouterKey(
    key: string,
    force?: boolean
  ): Promise<{ ok: boolean; affectedSessions?: number }> {
    return this.mutateAllowingRefusal("POST", "/api/cliproxy/openrouter/key", {
      key,
      force: Boolean(force)
    });
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

  private async put<T>(path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "PUT",
      headers: {
        ...this.authHeaders(),
        ...(body === undefined ? {} : { "Content-Type": "application/json" })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`Orquester API request failed: ${response.status} ${response.statusText}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }

  // POST/PUT for the restart-gated cliproxy mutations: a 409 refusal is a
  // first-class value ({ ok:false, affectedSessions }), not an exception, so the
  // caller can offer a force-confirm flow; every other non-2xx still throws.
  private async mutateAllowingRefusal<T>(
    method: "POST" | "PUT",
    path: string,
    body?: unknown
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...this.authHeaders(),
        ...(body === undefined ? {} : { "Content-Type": "application/json" })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });

    if (response.status === 409) {
      const parsed = (await response.json().catch(() => null)) as
        | { affectedSessions?: number }
        | null;
      return { ok: false, affectedSessions: parsed?.affectedSessions ?? 0 } as T;
    }

    if (!response.ok) {
      throw new Error(`Orquester API request failed: ${response.status} ${response.statusText}`);
    }

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
