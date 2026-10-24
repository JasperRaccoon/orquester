import type {
  AccountSummary,
  AccountTestResult,
  AgentAccount,
  AgentAccountsResponse,
  AgentConversationsResponse,
  AuthInfoResponse,
  ClaudeOAuthLink,
  ClaudeOAuthLinkStatus,
  BrowserSummary,
  BrowserSuggestionsResponse,
  CreateAccountRequest,
  CreateBrowserRequest,
  CreateProjectRequest,
  CreateSessionRequest,
  CreateSavedPromptRequest,
  SecretFileCandidatesResponse,
  SecretFileCompareResponse,
  SecretFilesCloneRequest,
  SecretVaultResponse,
  SecretVaultsResponse,
  SetupSecretVaultRequest,
  UpdateSecretFilesRequest,
  FetchRepoFaviconRequest,
  GitHubLinkPreviewResponse,
  RepoIconUploadType,
  RepoIdentitiesResponse,
  RepoIdentityResponse,
  SetRepoEmojiRequest,
  SetRepoLabelRequest,
  CreateTodoRequest,
  CreateWorkspaceRequest,
  DeviceLink,
  DeviceLinkAgent,
  DeviceLinkStatus,
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
  KillProcessSignal,
  MarkRecentProjectRequest,
  OpenResult,
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
  GetSavedPromptResponse,
  ServerInfoResponse,
  SessionSummary,
  SessionUploadRequest,
  SessionUploadResponse,
  SetAgentAccountDefaultsRequest,
  SubmitClaudeOAuthCodeRequest,
  SystemPortsResponse,
  SystemProcessDetailsResponse,
  SystemProcessesResponse,
  SystemProcessesScope,
  SystemResourcesResponse,
  TodoListRecord,
  TodoScope,
  UpdateProjectRequest,
  UpdateSavedPromptRequest,
  UpdateTodoRequest,
  UpdateWorkspaceRequest,
  UsageResponse,
  SubagentCacheTtlStatus,
  UsageTokensResponse,
  WorkspaceSummary
} from "@orquester/api";
import type { ProfileReferencesResponse } from "@orquester/api";
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
import { bindThreadCacheScope } from "./agent-chat/persistent-cache";
import { fsPathQuery } from "./fs-path-query";
import { parsePluginActionResult, parsePluginsResponse } from "./plugins-state";
import { buildQueryString } from "./transporter";
import { AGENT_PROFILE_DAEMON_MCP_SERVERS_ROUTE, agentProfileRoutes, agentToolsRoutes, desktopRoutes, githubLinkRoutes, pluginRoutes, repoIdentityRoutes, secretFilesRoutes, sessionProfileRoutes, workflowRoutes } from "@orquester/api";
// boxes: the Ephemeral AI VMs plugin's routes and payloads.
import { boxRoutes } from "@orquester/api";
// The Knowledge Graph plugin's routes and payloads (answers validated by `lib/knowledge/validate.ts`).
import { knowledgeRoutes } from "@orquester/api";
import type {
  CreateKnowledgeCollectionRequest,
  KnowledgeCollectionsResponse,
  KnowledgeEntriesQuery,
  KnowledgeEntriesResponse,
  KnowledgeGraphQuery,
  KnowledgeGraphResponse,
  KnowledgeItemResponse,
  KnowledgeRebuildEstimate,
  KnowledgeSaveRequest,
  KnowledgeSaveResponse,
  KnowledgeSearchRequest,
  KnowledgeSearchResponse,
  KnowledgeSettings,
  KnowledgeStatus,
  UpdateKnowledgeCollectionRequest,
  UpdateKnowledgeEntryRequest,
  UpdateKnowledgeSettingsRequest
} from "@orquester/api";
import {
  parseKnowledgeCollectionsResponse,
  parseKnowledgeEntriesResponse,
  parseKnowledgeGraphResponse,
  parseKnowledgeItemResponse,
  parseKnowledgeRebuildEstimate,
  parseKnowledgeSearchResponse,
  parseKnowledgeSettings,
  parseKnowledgeStatus
} from "./knowledge/validate";
import {
  authRoutes,
  authSessionPath,
  type AuthIssuedTokenResponse,
  type AuthLoginRequest,
  type AuthSessionsResponse,
  type RevokeAuthSessionsResponse,
  type VerifyPasswordResponse
} from "@orquester/api";
import type {
  BlacksmithSetupResponse,
  BoxConfigChangeSet,
  BoxConfigChangesResponse,
  BoxConnectionSettings,
  BoxesResponse,
  BoxKind,
  BoxKindsResponse,
  BoxOffersResponse,
  BoxProviderId,
  BoxProviderInfo,
  BoxProvidersResponse,
  BoxResponse,
  DecideBoxConfigChangeRequest,
  SetBlacksmithSetupRequest,
  SetBoxConnectionRequest,
  SetBoxProviderCredentialsRequest
} from "@orquester/api";
// boxes: Global MCP servers' "Run in box" switch.
import type { BoxMcpRunInBoxResponse, SetBoxMcpRunInBoxRequest } from "@orquester/api";
import type {
  AddSessionProfilePluginRequest,
  CopySessionProfileItemsRequest,
  CreateSessionProfileItemRequest,
  CreateSessionProfileRequest,
  ImportSessionProfileFromGlobalRequest,
  ImportSessionProfileResponse,
  SessionProfileGlobalSourceResponse,
  SessionProfileImportGitRequest,
  SessionProfileImportResponse,
  TakeSessionProfileImportRequest,
  DeleteSessionProfileResponse,
  DuplicateSessionProfileRequest,
  SessionProfileDetail,
  SessionProfileInstructionsResponse,
  SessionProfileItemDetail,
  SessionProfileListResponse,
  SessionProfileMutationResponse,
  SessionProfilePrepareStatusResponse,
  UpdateSessionProfileItemRequest,
  UpdateSessionProfileRequest
} from "@orquester/api";
import type {
  AgentToolsResponse,
  DaemonMcpServersResponse,
  RevokeAgentToolGrantsResponse,
  ThreadAgentToolsResponse
} from "@orquester/api";
import type {
  PluginId,
  PluginInfo,
  PluginsResponse,
  SetPluginEnabledRequest,
  TsCheckerEngine
} from "@orquester/api";
import type {
  CreateDesktopRequest,
  DesktopAppSummary,
  DesktopHostStatus,
  DesktopSuggestionsResponse,
  DesktopSummary,
  DesktopWindowAction,
  LaunchAppRequest
} from "@orquester/api";
import type {
  AgentProfileAgentId,
  AgentProfileOverviewResponse,
  AgentProfileSnapshot,
  CopyProfileItemRequest,
  CreateProfileItemRequest,
  MarketplacePluginsResponse,
  MigrateLegacyInstructionsRequest,
  ProfileImportGitRequest,
  ProfileImportScanResponse,
  ProfileInstructionsResponse,
  ProfileItemDetail,
  ProfileMutationResponse,
  SetProfileItemEnabledRequest,
  TrustProfileItemRequest,
  UpdateProfileItemRequest,
  WriteProfileInstructionsRequest
} from "@orquester/api";
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
  WorkflowErrorCode,
  WorkflowProblem,
  WorkflowWriteResponse
} from "@orquester/api";
import {
  agentChatCommandPath,
  agentChatRoutes,
  type AgentHostStatusResponse,
  type AgentHostStopResponse,
  type AgentVisualUrlResponse,
  type CommandReceiptResponse,
  type McpAppOperation
} from "@orquester/api/agent-chat";
import { desktopVisualScheme, visualFrameSrc, type VisualFrameUrl } from "./agent-chat/visual-frame";
import type {
  ForkSessionRequest,
  ForkSessionResponse,
  MergeBackActionRequest,
  MergeBackActionResponse,
  MergeBackRequest,
  MergeBackResponse,
  SessionLineageResponse
} from "@orquester/api";
import type {
  SecretRequestAnswerRequest,
  SecretRequestAnswerResponse,
  SecretRequestListResponse,
  ThreadItemOutputResponse,
  ThreadItemResponse,
  ThreadPromptsQuery,
  ThreadPromptsResponse,
  ThreadPromptTextResponse,
  ToolApprovalAnswer,
  ToolApprovalAnswerResponse,
  ToolApprovalDetailResponse,
  ToolApprovalListResponse,
  TurnDiffQuery,
  TurnDiffResponse,
  UsageLimitActionResponse,
  UsageLimitSwitchRequest
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
  // (fs, the Grok device link) — accept both so refusal reasons reach the UI.
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
 * UI above it. It does not know or care which transport is in use.
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
    if (this.agentChatTransport === null) {
      this.agentChatTransport = resolveAgentChatTransport(this.transporter);
      // A thread store on this transport keeps its device cache under this daemon's scope.
      bindThreadCacheScope(this.agentChatTransport, this.connection);
    }
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

  /** Public auth metadata: whether a sign-in is required (and a username with it). */
  authInfo(signal?: AbortSignal): Promise<AuthInfoResponse> {
    return this.send("GET", authRoutes.info, { signal });
  }

  /** Sign in with the password: a new device session's token (shown once; store only it). */
  login(req: AuthLoginRequest): Promise<AuthIssuedTokenResponse> {
    return this.send("POST", authRoutes.login, { body: req });
  }

  /** Revoke the session this client signed in with. */
  logout(): Promise<void> {
    return this.send("POST", authRoutes.logout);
  }

  /** Check a retyped password on the daemon (`ok: false` when wrong; 429 while locked out). */
  verifyPassword(password: string): Promise<VerifyPasswordResponse> {
    return this.send("POST", authRoutes.verifyPassword, { body: { password } });
  }

  listAuthSessions(signal?: AbortSignal): Promise<AuthSessionsResponse> {
    return this.send("GET", authRoutes.sessions, { signal });
  }

  revokeAuthSession(id: string): Promise<void> {
    return this.send("DELETE", authSessionPath(id));
  }

  /** Revoke every other device session and API token. */
  revokeOtherAuthSessions(): Promise<RevokeAuthSessionsResponse> {
    return this.send("POST", authRoutes.revokeOthers);
  }

  /** Mint a named API token for an external client (shown once). */
  createApiToken(label: string): Promise<AuthIssuedTokenResponse> {
    return this.send("POST", authRoutes.tokens, { body: { label } });
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

  // --- Built-in plugins (Settings → Plugins) --------------------------------

  /** Every built-in plugin and its state. Rejects when the answer is not a plugins list. */
  async getPlugins(signal?: AbortSignal): Promise<PluginsResponse> {
    const response = parsePluginsResponse(await this.send<unknown>("GET", pluginRoutes.list, { signal }));
    if (!response) {
      throw new Error("The server sent a plugins list this app cannot read.");
    }
    return response;
  }

  /**
   * Turn a plugin on or off for the whole server. Resolves to the plugin's new
   * state, or null when the answer carries none (the `plugins.changed`
   * broadcast brings it then).
   */
  async setPluginEnabled(id: PluginId, enabled: boolean): Promise<PluginInfo | null> {
    const data = await this.send<unknown>("PUT", pluginRoutes.plugin(id), {
      body: { enabled } satisfies SetPluginEnabledRequest
    });
    return parsePluginActionResult(data, id);
  }

  /**
   * Choose the engine of a plugin that has several (ts-rust). Resolves like
   * {@link setPluginEnabled}; 409 where the engine has no build.
   */
  async setPluginEngine(id: PluginId, engine: TsCheckerEngine): Promise<PluginInfo | null> {
    const data = await this.send<unknown>("PUT", pluginRoutes.plugin(id), {
      body: { engine } satisfies SetPluginEnabledRequest
    });
    return parsePluginActionResult(data, id);
  }

  /** Queue an update check (202); its progress arrives as `plugins.changed`. */
  async checkPluginUpdates(id: PluginId): Promise<void> {
    await this.send<unknown>("POST", pluginRoutes.check(id));
  }

  /** Switch back to the previous version (409 without one). Resolves like {@link setPluginEnabled}. */
  async rollbackPlugin(id: PluginId): Promise<PluginInfo | null> {
    return parsePluginActionResult(await this.send<unknown>("POST", pluginRoutes.rollback(id)), id);
  }

  /** Delete the downloaded versions (409 while the plugin is on). Resolves like {@link setPluginEnabled}. */
  async removePluginDownloads(id: PluginId): Promise<PluginInfo | null> {
    return parsePluginActionResult(await this.send<unknown>("DELETE", pluginRoutes.downloads(id)), id);
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

  listProjectFiles(
    path: string,
    opts: { includeIgnored?: boolean } = {},
    signal?: AbortSignal
  ): Promise<FsFilesResponse> {
    return this.send("GET", "/api/fs/files", {
      query: { ...fsPathQuery(path), includeIgnored: opts.includeIgnored ? "1" : undefined },
      signal
    });
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
        maxResults: params.maxResults,
        includeIgnored: params.includeIgnored ? "1" : undefined
      },
      signal
    });
  }

  // boxes: `path` asks for the capabilities where that path lives — a box project's own
  // tools (archive listing, regex search); without it, or for a host path, the host answers.
  getFsCapabilities(signal?: AbortSignal, path?: string): Promise<FsCapabilitiesResponse> {
    return this.send("GET", "/api/fs/capabilities", { query: path ? { path } : undefined, signal });
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

  // --- Secret files (the "Secret files" plugin; vault per repo per workspace) ---

  listSecretVaults(signal?: AbortSignal): Promise<SecretVaultsResponse> {
    return this.send("GET", secretFilesRoutes.list, { signal });
  }

  getSecretVault(workspace: string, repoKey: string, signal?: AbortSignal): Promise<SecretVaultResponse> {
    return this.send("GET", secretFilesRoutes.vault, { query: { workspace, repoKey }, signal });
  }

  deleteSecretVault(workspace: string, repoKey: string): Promise<void> {
    return this.send("DELETE", secretFilesRoutes.vault, { query: { workspace, repoKey } });
  }

  /** The setup scan; `path` scans one hand-typed path instead of the conventional candidates. */
  scanSecretFileCandidates(
    workspace: string,
    repoKey: string,
    path?: string,
    signal?: AbortSignal
  ): Promise<SecretFileCandidatesResponse> {
    return this.send("GET", secretFilesRoutes.candidates, {
      query: { workspace, repoKey, ...(path !== undefined ? { path } : {}) },
      signal
    });
  }

  setupSecretVault(req: SetupSecretVaultRequest): Promise<SecretVaultResponse> {
    return this.send("POST", secretFilesRoutes.setup, { body: req });
  }

  updateSecretFiles(req: UpdateSecretFilesRequest): Promise<SecretVaultResponse> {
    return this.send("PUT", secretFilesRoutes.files, { body: req });
  }

  pushSecretFiles(req: SecretFilesCloneRequest): Promise<SecretVaultResponse> {
    return this.send("POST", secretFilesRoutes.push, { body: req });
  }

  resetSecretFiles(req: SecretFilesCloneRequest): Promise<SecretVaultResponse> {
    return this.send("POST", secretFilesRoutes.reset, { body: req });
  }

  compareSecretFile(
    workspace: string,
    repoKey: string,
    projectPath: string,
    path: string,
    signal?: AbortSignal
  ): Promise<SecretFileCompareResponse> {
    return this.send("GET", secretFilesRoutes.compare, { query: { workspace, repoKey, projectPath, path }, signal });
  }

  // boxes: --- Ephemeral AI VMs (`boxRoutes`; answers are validated by `lib/boxes/store.ts`) ---

  listBoxes(signal?: AbortSignal): Promise<BoxesResponse> {
    return this.send("GET", boxRoutes.list, { signal });
  }

  getBox(id: string, signal?: AbortSignal): Promise<BoxResponse> {
    return this.send("GET", boxRoutes.box(id), { signal });
  }

  /** Destroy a temporary box (a project box answers 409 `BOX_IS_PROJECT`: delete its project instead). */
  destroyBox(id: string): Promise<BoxResponse | undefined> {
    return this.send("DELETE", boxRoutes.box(id));
  }

  /** A box's setup log. The daemon serves text/plain, so this reads bytes rather than JSON. */
  async boxSetupLog(id: string, signal?: AbortSignal): Promise<string> {
    const path = boxRoutes.setupLog(id);
    if (!this.transporter.requestBytes) throw new Error("Logs are not supported on this connection.");
    const response = await this.transporter.requestBytes({ method: "GET", path, signal });
    if (!response.ok) {
      throw new ApiError(response.status, "GET", path, response.headers, undefined);
    }
    return new TextDecoder().decode(response.data);
  }

  listBoxKinds(signal?: AbortSignal): Promise<BoxKindsResponse> {
    return this.send("GET", boxRoutes.kinds, { signal });
  }

  listBoxProviders(signal?: AbortSignal): Promise<BoxProvidersResponse> {
    return this.send("GET", boxRoutes.providers, { signal });
  }

  /** Save a provider's credentials (write-only; the daemon validates them with a read call first). */
  setBoxProviderCredentials(id: BoxProviderId, req: SetBoxProviderCredentialsRequest): Promise<BoxProviderInfo> {
    return this.send("PUT", boxRoutes.provider(id), { body: req });
  }

  /** Forget a provider's credentials. */
  removeBoxProviderCredentials(id: BoxProviderId): Promise<BoxProviderInfo | undefined> {
    return this.send("DELETE", boxRoutes.provider(id));
  }

  getBoxOffers(id: BoxProviderId, kind: BoxKind, signal?: AbortSignal): Promise<BoxOffersResponse> {
    return this.send("GET", boxRoutes.offers(id, kind), { signal });
  }

  /** Start building the provider's prepared Windows image (202; progress arrives as provider changes). */
  prepareBoxWindowsImage(id: BoxProviderId): Promise<unknown> {
    return this.send("POST", boxRoutes.windowsImage(id));
  }

  getBoxConnection(signal?: AbortSignal): Promise<BoxConnectionSettings> {
    return this.send("GET", boxRoutes.connection, { signal });
  }

  /** Secret fields of `req` are write-only: the answer carries only `keyHint`. */
  setBoxConnection(req: SetBoxConnectionRequest): Promise<BoxConnectionSettings> {
    return this.send("PUT", boxRoutes.connection, { body: req });
  }

  /** Check that a box could reach this daemon; resolves to the settings with `reachable` set. */
  testBoxConnection(): Promise<BoxConnectionSettings> {
    return this.send("POST", boxRoutes.connectionTest);
  }

  /** "Set up for me": serve the daemon over `tailscale serve`, store that URL and check it. */
  setupBoxTailscaleServe(): Promise<BoxConnectionSettings> {
    return this.send("POST", boxRoutes.connectionTailscaleServe);
  }

  getBlacksmithSetup(signal?: AbortSignal): Promise<BlacksmithSetupResponse> {
    return this.send("GET", boxRoutes.blacksmith, { signal });
  }

  /** Pick the account / org; the daemon then runs the automatic steps (an empty body re-runs them). */
  setBlacksmithSetup(req: SetBlacksmithSetupRequest): Promise<BlacksmithSetupResponse> {
    return this.send("PUT", boxRoutes.blacksmith, { body: req });
  }

  /** Start the macOS test run (202): a box is started, connects, and is destroyed. */
  startBlacksmithTest(): Promise<unknown> {
    return this.send("POST", boxRoutes.blacksmithTest);
  }

  listBoxConfigChanges(signal?: AbortSignal): Promise<BoxConfigChangesResponse> {
    return this.send("GET", boxRoutes.configChanges, { signal });
  }

  decideBoxConfigChange(id: string, req: DecideBoxConfigChangeRequest): Promise<{ change: BoxConfigChangeSet }> {
    return this.send("POST", boxRoutes.configChange(id), { body: req });
  }

  /** Every Global MCP server's "Run in box" setting (`box-mcp.json`). */
  getBoxMcpRunInBox(signal?: AbortSignal): Promise<BoxMcpRunInBoxResponse> {
    return this.send("GET", boxRoutes.mcpRunInBox, { signal });
  }

  /** Switch one Global MCP server's "Run in box"; answers with every server's setting. */
  setBoxMcpRunInBox(req: SetBoxMcpRunInBoxRequest): Promise<BoxMcpRunInBoxResponse> {
    return this.send("PUT", boxRoutes.mcpRunInBox, { body: req });
  }

  // --- Knowledge Graph (`knowledgeRoutes`; the worker routes are the daemon's own) ---
  // Reads are validated here and reject with an Error when the answer is not
  // readable; refusals are ApiErrors whose body is `{ code, message }`.

  async getKnowledgeStatus(signal?: AbortSignal): Promise<KnowledgeStatus> {
    return readKnowledge(parseKnowledgeStatus(await this.send<unknown>("GET", knowledgeRoutes.status, { signal })), "status");
  }

  async getKnowledgeSettings(signal?: AbortSignal): Promise<KnowledgeSettings> {
    return readKnowledge(parseKnowledgeSettings(await this.send<unknown>("GET", knowledgeRoutes.settings, { signal })), "settings");
  }

  async updateKnowledgeSettings(req: UpdateKnowledgeSettingsRequest): Promise<KnowledgeSettings> {
    return readKnowledge(parseKnowledgeSettings(await this.send<unknown>("PUT", knowledgeRoutes.settings, { body: req })), "settings");
  }

  async listKnowledgeCollections(signal?: AbortSignal): Promise<KnowledgeCollectionsResponse> {
    const data = await this.send<unknown>("GET", knowledgeRoutes.collections, { signal });
    return readKnowledge(parseKnowledgeCollectionsResponse(data), "collections list");
  }

  /** The answer is not relied on: callers refetch the collections. */
  createKnowledgeCollection(req: CreateKnowledgeCollectionRequest): Promise<unknown> {
    return this.send("POST", knowledgeRoutes.collections, { body: req });
  }

  updateKnowledgeCollection(id: string, req: UpdateKnowledgeCollectionRequest): Promise<unknown> {
    return this.send("PATCH", knowledgeRoutes.collection(id), { body: req });
  }

  /** Entries left with no collection become Unfiled. */
  deleteKnowledgeCollection(id: string): Promise<unknown> {
    return this.send("DELETE", knowledgeRoutes.collection(id));
  }

  /** Newest first; `nextCursor` pages on. */
  async listKnowledgeEntries(query: KnowledgeEntriesQuery = {}, signal?: AbortSignal): Promise<KnowledgeEntriesResponse> {
    const data = await this.send<unknown>("GET", knowledgeRoutes.entries, {
      query: { collection: query.collection, cursor: query.cursor, limit: query.limit },
      signal
    });
    return readKnowledge(parseKnowledgeEntriesResponse(data), "entries list");
  }

  /** Edit an entry; changing only its collections never queues a linking run. */
  updateKnowledgeEntry(id: string, req: UpdateKnowledgeEntryRequest): Promise<unknown> {
    return this.send("PATCH", knowledgeRoutes.entry(id), { body: req });
  }

  deleteKnowledgeEntry(id: string): Promise<unknown> {
    return this.send("DELETE", knowledgeRoutes.entry(id));
  }

  /** An entry (`ke_…`) or a concept, with what it links to. */
  async getKnowledgeItem(id: string, signal?: AbortSignal): Promise<KnowledgeItemResponse> {
    return readKnowledge(parseKnowledgeItemResponse(await this.send<unknown>("GET", knowledgeRoutes.item(id), { signal })), "item");
  }

  async getKnowledgeGraph(query: KnowledgeGraphQuery = {}, signal?: AbortSignal): Promise<KnowledgeGraphResponse> {
    const data = await this.send<unknown>("GET", knowledgeRoutes.graph, {
      query: { collections: query.collections, focus: query.focus, depth: query.depth, limit: query.limit },
      signal
    });
    return readKnowledge(parseKnowledgeGraphResponse(data), "graph");
  }

  /** Hybrid search (meaning + keywords) over every collection the user can see. */
  async searchKnowledge(req: KnowledgeSearchRequest, signal?: AbortSignal): Promise<KnowledgeSearchResponse> {
    const data = await this.send<unknown>("POST", knowledgeRoutes.search, { body: req, signal });
    return readKnowledge(parseKnowledgeSearchResponse(data), "search result");
  }

  saveKnowledge(req: KnowledgeSaveRequest): Promise<KnowledgeSaveResponse> {
    return this.send("POST", knowledgeRoutes.save, { body: req });
  }

  /** Queue a full re-extraction of every entry. */
  rebuildKnowledge(): Promise<unknown> {
    return this.send("POST", knowledgeRoutes.rebuild, { body: {} });
  }

  async getKnowledgeRebuildEstimate(signal?: AbortSignal): Promise<KnowledgeRebuildEstimate> {
    const data = await this.send<unknown>("GET", knowledgeRoutes.rebuildEstimate, { signal });
    return readKnowledge(parseKnowledgeRebuildEstimate(data), "rebuild estimate");
  }

  // --- Repo identities (icon + label per git repo; daemon-persisted, shared) ---

  listRepoIdentities(signal?: AbortSignal): Promise<RepoIdentitiesResponse> {
    return this.send("GET", repoIdentityRoutes.list, { signal });
  }

  setRepoLabel(req: SetRepoLabelRequest): Promise<RepoIdentityResponse> {
    return this.send("PUT", repoIdentityRoutes.label, { body: req });
  }

  setRepoEmoji(req: SetRepoEmojiRequest): Promise<RepoIdentityResponse> {
    return this.send("PUT", repoIdentityRoutes.emoji, { body: req });
  }

  /** An image icon, streamed as the raw body (already shrunk to fit `REPO_ICON_MAX_BYTES`). */
  uploadRepoIcon(repoKey: string, contentType: RepoIconUploadType, data: BinaryBody): Promise<RepoIdentityResponse> {
    return this.send("POST", repoIdentityRoutes.icon, { query: { repoKey, contentType }, binaryBody: data });
  }

  /** Back to the default icon, whatever kind the current one is. */
  clearRepoIcon(repoKey: string): Promise<RepoIdentityResponse> {
    return this.send("DELETE", repoIdentityRoutes.icon, { query: { repoKey } });
  }

  /** The daemon fetches `domain`'s favicon and stores it as the repo's icon. */
  fetchRepoFavicon(req: FetchRepoFaviconRequest): Promise<RepoIdentityResponse> {
    return this.send("POST", repoIdentityRoutes.favicon, { body: req });
  }

  /** An image icon's bytes; `version` (from the identity) keeps a cache from serving stale ones. */
  async readRepoIcon(repoKey: string, version: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    if (!this.transporter.requestBytes) throw new Error("Repo icons are not supported on this connection.");
    const response = await this.transporter.requestBytes({
      method: "GET",
      path: repoIdentityRoutes.icon,
      query: { repoKey, v: version },
      signal
    });
    if (!response.ok) {
      throw new ApiError(response.status, "GET", repoIdentityRoutes.icon, response.headers, undefined);
    }
    return response.data;
  }

  // --- GitHub link previews (the chat's link pills) ------------------------

  /**
   * The pull request, issue or commit a GitHub link names. `projectPath` lets the daemon read
   * with the git account bound to that project's workspace; tokens never come back.
   */
  getGitHubLinkPreview(url: string, projectPath?: string | null, signal?: AbortSignal): Promise<GitHubLinkPreviewResponse> {
    return this.send("GET", githubLinkRoutes.preview, { query: { url, ...(projectPath ? { projectPath } : {}) }, signal });
  }

  // --- Saved prompts (the right rail; daemon-persisted, shared) ------------

  /** Every global prompt, plus `projectPath`'s own when given. */
  listSavedPrompts(projectPath: string | null, signal?: AbortSignal): Promise<SavedPromptListResponse> {
    return this.send("GET", "/api/saved-prompts", {
      query: projectPath ? { projectPath } : undefined,
      signal
    });
  }

  /** One prompt by id, whatever its scope (404 `SAVED_PROMPT_NOT_FOUND`). */
  getSavedPrompt(id: string, signal?: AbortSignal): Promise<GetSavedPromptResponse> {
    return this.send("GET", `/api/saved-prompts/${encodeURIComponent(id)}`, { signal });
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

  // --- Agent profile (agent profile spec §8) --------------------------------
  // A refusal is an ApiError whose body is `{error: {code, message}}`.

  getAgentProfileOverview(signal?: AbortSignal): Promise<AgentProfileOverviewResponse> {
    return this.send("GET", agentProfileRoutes.overview, { signal });
  }

  /** MCP servers in the agents' configs that reach this daemon's own `/mcp` (unified MCP design §12.1). */
  getDaemonMcpServers(signal?: AbortSignal): Promise<DaemonMcpServersResponse> {
    return this.send("GET", AGENT_PROFILE_DAEMON_MCP_SERVERS_ROUTE, { signal });
  }

  getAgentProfile(agent: AgentProfileAgentId, signal?: AbortSignal): Promise<AgentProfileSnapshot> {
    return this.send("GET", agentProfileRoutes.snapshot(agent), { signal });
  }

  getAgentProfileItem(agent: AgentProfileAgentId, id: string, signal?: AbortSignal): Promise<ProfileItemDetail> {
    return this.send("GET", agentProfileRoutes.item(agent, id), { signal });
  }

  createAgentProfileItem(agent: AgentProfileAgentId, req: CreateProfileItemRequest): Promise<ProfileMutationResponse> {
    return this.send("POST", agentProfileRoutes.items(agent), { body: req });
  }

  updateAgentProfileItem(
    agent: AgentProfileAgentId,
    id: string,
    req: UpdateProfileItemRequest
  ): Promise<ProfileMutationResponse> {
    return this.send("PUT", agentProfileRoutes.item(agent, id), { body: req });
  }

  setAgentProfileItemEnabled(
    agent: AgentProfileAgentId,
    id: string,
    req: SetProfileItemEnabledRequest
  ): Promise<ProfileMutationResponse> {
    return this.send("POST", agentProfileRoutes.itemEnabled(agent, id), { body: req });
  }

  trustAgentProfileItem(
    agent: AgentProfileAgentId,
    id: string,
    req: TrustProfileItemRequest
  ): Promise<ProfileMutationResponse> {
    return this.send("POST", agentProfileRoutes.itemTrust(agent, id), { body: req });
  }

  deleteAgentProfileItem(agent: AgentProfileAgentId, id: string, revision: string): Promise<ProfileMutationResponse> {
    return this.send("DELETE", agentProfileRoutes.item(agent, id), { query: { revision } });
  }

  copyAgentProfileItem(
    agent: AgentProfileAgentId,
    id: string,
    req: CopyProfileItemRequest
  ): Promise<ProfileMutationResponse> {
    return this.send("POST", agentProfileRoutes.itemCopy(agent, id), { body: req });
  }

  // Agent Profiles (`sessionProfileRoutes`, the same routes as `HttpOrquesterApiClient`'s).

  listSessionProfiles(signal?: AbortSignal): Promise<SessionProfileListResponse> {
    return this.send("GET", sessionProfileRoutes.list, { signal });
  }

  getSessionProfile(profileId: string, signal?: AbortSignal): Promise<SessionProfileDetail> {
    return this.send("GET", sessionProfileRoutes.profile(profileId), { signal });
  }

  createSessionProfile(req: CreateSessionProfileRequest): Promise<SessionProfileDetail> {
    return this.send("POST", sessionProfileRoutes.list, { body: req });
  }

  updateSessionProfile(profileId: string, req: UpdateSessionProfileRequest): Promise<SessionProfileDetail> {
    return this.send("PUT", sessionProfileRoutes.profile(profileId), { body: req });
  }

  /**
   * `expectWorkflowUses`: the delete guard (`DeleteSessionProfileQuery`) — the ids of the workflows
   * the confirmation showed as using the profile (`[]`: none); a mismatch is 409 `WORKFLOW_USES_CHANGED`.
   */
  deleteSessionProfile(
    profileId: string,
    revision: string,
    options: { expectWorkflowUses?: readonly string[] } = {}
  ): Promise<DeleteSessionProfileResponse> {
    const expect = options.expectWorkflowUses === undefined ? {} : { expectWorkflowUses: options.expectWorkflowUses.join(",") };
    return this.send("DELETE", sessionProfileRoutes.profile(profileId), { query: { revision, ...expect } });
  }

  /** The workflows whose agent blocks launch with the profile (the delete confirmation lists them). */
  getProfileWorkflowReferences(profileId: string, signal?: AbortSignal): Promise<ProfileReferencesResponse> {
    return this.send("GET", workflowRoutes.profileReferences(profileId), { signal });
  }

  duplicateSessionProfile(profileId: string, req: DuplicateSessionProfileRequest = {}): Promise<SessionProfileDetail> {
    return this.send("POST", sessionProfileRoutes.duplicate(profileId), { body: req });
  }

  getSessionProfileItem(profileId: string, itemId: string, signal?: AbortSignal): Promise<SessionProfileItemDetail> {
    return this.send("GET", sessionProfileRoutes.item(profileId, itemId), { signal });
  }

  createSessionProfileItem(profileId: string, req: CreateSessionProfileItemRequest): Promise<SessionProfileMutationResponse> {
    return this.send("POST", sessionProfileRoutes.items(profileId), { body: req });
  }

  updateSessionProfileItem(
    profileId: string,
    itemId: string,
    req: UpdateSessionProfileItemRequest
  ): Promise<SessionProfileMutationResponse> {
    return this.send("PUT", sessionProfileRoutes.item(profileId, itemId), { body: req });
  }

  deleteSessionProfileItem(profileId: string, itemId: string, revision: string): Promise<SessionProfileMutationResponse> {
    return this.send("DELETE", sessionProfileRoutes.item(profileId, itemId), { query: { revision } });
  }

  setSessionProfileItemEnabled(
    profileId: string,
    itemId: string,
    revision: string,
    enabled: boolean
  ): Promise<SessionProfileMutationResponse> {
    return this.send("POST", sessionProfileRoutes.itemEnabled(profileId, itemId), { body: { revision, enabled } });
  }

  readSessionProfileInstructions(profileId: string, signal?: AbortSignal): Promise<SessionProfileInstructionsResponse> {
    return this.send("GET", sessionProfileRoutes.instructions(profileId), { signal });
  }

  writeSessionProfileInstructions(profileId: string, revision: string, text: string): Promise<SessionProfileDetail> {
    return this.send("PUT", sessionProfileRoutes.instructions(profileId), { body: { revision, text } });
  }

  getSessionProfilePrepareStatus(profileId: string, signal?: AbortSignal): Promise<SessionProfilePrepareStatusResponse> {
    return this.send("GET", sessionProfileRoutes.prepareStatus(profileId), { signal });
  }

  /** What Import from Global offers of `agent`'s own setup (`exists` checked against the profile). */
  getSessionProfileGlobalSource(
    profileId: string,
    agent: AgentProfileAgentId,
    signal?: AbortSignal
  ): Promise<SessionProfileGlobalSourceResponse> {
    return this.send("GET", sessionProfileRoutes.importGlobal(profileId), { query: { agent }, signal });
  }

  importSessionProfileFromGlobal(profileId: string, req: ImportSessionProfileFromGlobalRequest): Promise<SessionProfileImportResponse> {
    return this.send("POST", sessionProfileRoutes.importGlobal(profileId), { body: req });
  }

  scanSessionProfileGitImport(profileId: string, req: SessionProfileImportGitRequest): Promise<ProfileImportScanResponse> {
    return this.send("POST", sessionProfileRoutes.importGit(profileId), { body: req });
  }

  /** Streams a `.zip` or `.md` file (never base64): the daemon extracts and scans it for the profile. */
  scanSessionProfileUpload(
    profileId: string,
    name: string,
    data: BinaryBody,
    onProgress?: (sent: number, total: number) => void
  ): Promise<ProfileImportScanResponse> {
    return this.send("POST", sessionProfileRoutes.importUpload(profileId), {
      query: { name },
      binaryBody: data,
      onUploadProgress: onProgress
    });
  }

  takeSessionProfileImport(profileId: string, importId: string, req: TakeSessionProfileImportRequest): Promise<SessionProfileImportResponse> {
    return this.send("POST", sessionProfileRoutes.importScan(profileId, importId), { body: req });
  }

  copySessionProfileItems(profileId: string, req: CopySessionProfileItemsRequest): Promise<SessionProfileImportResponse> {
    return this.send("POST", sessionProfileRoutes.copyFrom(profileId), { body: req });
  }

  addSessionProfilePlugin(profileId: string, req: AddSessionProfilePluginRequest): Promise<SessionProfileImportResponse> {
    return this.send("POST", sessionProfileRoutes.plugins(profileId), { body: req });
  }

  /** The profile's portable `.zip` (no secret values), over the transport's byte channel. */
  async exportSessionProfile(profileId: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    if (!this.transporter.requestBytes) throw new Error("Export is not supported on this connection.");
    const path = sessionProfileRoutes.exportProfile(profileId);
    const response = await this.transporter.requestBytes({ method: "GET", path, signal });
    if (!response.ok) {
      // The refusal's JSON body arrives as bytes: decode it so the reason reaches the UI.
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder().decode(response.data));
      } catch {
        body = undefined;
      }
      throw new ApiError(response.status, "GET", path, response.headers, body);
    }
    return response.data;
  }

  /** A NEW profile from an export `.zip`, streamed as the raw body. */
  importSessionProfile(
    name: string,
    data: BinaryBody,
    onProgress?: (sent: number, total: number) => void
  ): Promise<ImportSessionProfileResponse> {
    return this.send("POST", sessionProfileRoutes.importProfile, { query: { name }, binaryBody: data, onUploadProgress: onProgress });
  }

  getAgentProfileInstructions(agent: AgentProfileAgentId, signal?: AbortSignal): Promise<ProfileInstructionsResponse> {
    return this.send("GET", agentProfileRoutes.instructions(agent), { signal });
  }

  writeAgentProfileInstructions(
    agent: AgentProfileAgentId,
    req: WriteProfileInstructionsRequest
  ): Promise<ProfileMutationResponse> {
    return this.send("PUT", agentProfileRoutes.instructions(agent), { body: req });
  }

  migrateAgentProfileLegacyInstructions(
    agent: AgentProfileAgentId,
    req: MigrateLegacyInstructionsRequest
  ): Promise<ProfileMutationResponse> {
    return this.send("POST", agentProfileRoutes.instructionsMigrateLegacy(agent), { body: req });
  }

  scanAgentProfileGitImport(agent: AgentProfileAgentId, req: ProfileImportGitRequest): Promise<ProfileImportScanResponse> {
    return this.send("POST", agentProfileRoutes.importGit(agent), { body: req });
  }

  /** Streams a `.zip` or `.md` file (never base64): the daemon extracts and scans it. */
  scanAgentProfileUpload(
    agent: AgentProfileAgentId,
    name: string,
    data: BinaryBody,
    onProgress?: (sent: number, total: number) => void
  ): Promise<ProfileImportScanResponse> {
    return this.send("POST", agentProfileRoutes.importUpload(agent), {
      query: { name },
      binaryBody: data,
      onUploadProgress: onProgress
    });
  }

  listAgentProfileMarketplacePlugins(
    agent: AgentProfileAgentId,
    marketplace: string,
    signal?: AbortSignal
  ): Promise<MarketplacePluginsResponse> {
    return this.send("GET", agentProfileRoutes.marketplacePlugins(agent, marketplace), { signal });
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

  /**
   * One window of a code/shell block's log (`…/log?stream=&offset=&maxBytes=`,
   * no follow): the redacted text plus the daemon's own position in the RAW
   * file (`X-Log-Next-Offset`) — the only offset a resume may use, since
   * redaction changes the text's length. A non-2xx answer throws.
   */
  async readWorkflowNodeLogWindow(
    runId: string,
    nodeId: string,
    opts: { stream?: "stdout" | "stderr"; offset?: number; maxBytes?: number },
    signal?: AbortSignal
  ): Promise<WorkflowLogWindow> {
    const path = workflowRoutes.nodeLog(runId, nodeId);
    if (!this.transporter.requestBytes) throw new Error("Logs are not supported on this connection.");
    const response = await this.transporter.requestBytes({
      method: "GET",
      path,
      query: { stream: opts.stream, offset: opts.offset, maxBytes: opts.maxBytes },
      signal
    });
    if (!response.ok) {
      let body: unknown;
      try {
        const text = new TextDecoder().decode(response.data);
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = undefined;
      }
      throw new WorkflowApiError(response.status, "GET", path, response.headers, body);
    }
    return parseWorkflowLogWindow(response.data, response.headers ?? {}, opts.offset ?? 0);
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

  getSubagentCacheTtlStatus(signal?: AbortSignal): Promise<SubagentCacheTtlStatus> {
    return this.send("GET", "/api/usage/subagent-cache-ttl", { signal });
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

  // Device-code account links for Grok and Codex: the daemon drives the
  // provider's device flow and broadcasts `<agent>-link.changed` on the
  // agent-accounts channel as it advances; a granted link becomes a managed
  // account.

  getDeviceLink(agent: DeviceLinkAgent, signal?: AbortSignal): Promise<DeviceLinkStatus> {
    return this.send("GET", `/api/agent-accounts/${agent}/link`, { signal });
  }

  /** Start a link. 409 while one is already pending, 502 when the provider fails. */
  startDeviceLink(agent: DeviceLinkAgent): Promise<DeviceLink> {
    return this.send("POST", `/api/agent-accounts/${agent}/link`);
  }

  /** Cancel a pending link; idempotent. */
  cancelDeviceLink(agent: DeviceLinkAgent): Promise<DeviceLinkStatus> {
    return this.send("DELETE", `/api/agent-accounts/${agent}/link`);
  }

  // Claude's sign-in link: the daemon hands out the Claude.ai authorize URL and
  // exchanges the code its callback page shows; `claude-link.changed` carries
  // the state.

  getClaudeOAuthLink(signal?: AbortSignal): Promise<ClaudeOAuthLinkStatus> {
    return this.send("GET", "/api/agent-accounts/claude/link", { signal });
  }

  /** Start a sign-in. 409 while one is already pending. */
  startClaudeOAuthLink(): Promise<ClaudeOAuthLink> {
    return this.send("POST", "/api/agent-accounts/claude/link");
  }

  /** Complete the pending sign-in with the pasted code. 400 for a code that is
   *  malformed or refused, 409 with nothing pending. */
  submitClaudeOAuthCode(req: SubmitClaudeOAuthCodeRequest): Promise<AgentAccount> {
    return this.send("POST", "/api/agent-accounts/claude/link/code", { body: req });
  }

  /** Cancel a pending sign-in; idempotent. */
  cancelClaudeOAuthLink(): Promise<ClaudeOAuthLinkStatus> {
    return this.send("DELETE", "/api/agent-accounts/claude/link");
  }

  installRegistryEntry(id: string): Promise<RegistryActionResult> {
    return this.send("POST", `/api/registry/${encodeURIComponent(id)}/install`);
  }

  updateRegistryEntry(id: string): Promise<RegistryActionResult> {
    return this.send("POST", `/api/registry/${encodeURIComponent(id)}/update`);
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

  // Thread lineage (spec 2026-10-14 §6) — daemon-owned chat routes.

  /** A new chat tab whose conversation is this one's up to a message. */
  forkSession(id: string, req: ForkSessionRequest): Promise<ForkSessionResponse> {
    return this.send("POST", agentChatRoutes.fork(id), { body: req });
  }

  /** Send a fork's result to its parent; queued by the daemon while the parent is busy. */
  mergeBackSession(id: string, req: MergeBackRequest): Promise<MergeBackResponse> {
    return this.send("POST", agentChatRoutes.mergeBack(id), { body: req });
  }

  /** Deliver now, or discard, a merge the parent has not taken (from the fork or the parent). */
  mergeBackAction(id: string, mergeId: string, req: MergeBackActionRequest): Promise<MergeBackActionResponse> {
    return this.send("POST", agentChatRoutes.mergeBackItem(id, mergeId), { body: req });
  }

  /** The session's parent, its children and the merges waiting on either. */
  sessionLineage(id: string, signal?: AbortSignal): Promise<SessionLineageResponse> {
    return this.send("GET", agentChatRoutes.lineage(id), { signal });
  }

  /**
   * A chat turn's unified diff (agent chat spec §6.3), for the changed-files
   * card's "view diff". Shows every change by default; `ignoreWhitespace`
   * hides whitespace-only ones.
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

  /**
   * A frameable URL for an agent's published page (spec 2026-10-14 §2.2):
   * the daemon mints a short-lived signed path over this authenticated
   * transport, and the frame loads it — from this connection's endpoint on
   * the web, through the desktop's page scheme on the desktop. Rejects when
   * the daemon refuses, or this connection cannot frame a page at all.
   */
  async agentVisualUrl(id: string, attachmentId: string): Promise<VisualFrameUrl> {
    const minted = await this.send<AgentVisualUrlResponse>("POST", agentChatRoutes.visualUrl(id, attachmentId), {
      body: {}
    });
    const path = typeof minted?.path === "string" ? minted.path : "";
    const expiresAt = typeof minted?.expiresAt === "number" && Number.isFinite(minted.expiresAt) ? minted.expiresAt : 0;
    const desktopScheme = desktopVisualScheme();
    const src = visualFrameSrc(path, {
      kind: this.transportKind,
      endpoint: this.connection.endpoint,
      ...(desktopScheme !== undefined ? { desktopScheme } : {})
    });
    if (src === null) {
      throw new Error("Pages cannot be shown on this connection.");
    }
    return { src, expiresAt };
  }

  /**
   * One request of the MCP App a completed tool row carries (spec 2026-10-14
   * §3): `operation` with its body, answered by the daemon through the
   * thread's live provider session. Rejects with the daemon's own message,
   * which is what the app is told.
   */
  async mcpAppRequest<T>(
    id: string,
    itemId: string,
    operation: McpAppOperation,
    body: Record<string, unknown>
  ): Promise<T> {
    try {
      return await this.send<T>("POST", agentChatRoutes.mcpApp(id, itemId, operation), { body });
    } catch (error) {
      if (error instanceof ApiError) {
        throw new Error(error.serverMessage ?? `The request failed (${error.status}).`);
      }
      throw error;
    }
  }

  /** The thread's pending `request_secret` cards (daemon memory; never a value). */
  listSecretRequests(id: string, signal?: AbortSignal): Promise<SecretRequestListResponse> {
    return this.send("GET", agentChatRoutes.secretRequests(id), { signal });
  }

  /**
   * Answer one. The value rides in this body only — never a URL, a log, a
   * store — and the response carries the outcome alone. A failure's
   * `ApiError` holds the daemon's answer, which never quotes the body.
   */
  answerSecretRequest(
    id: string,
    requestId: string,
    body: SecretRequestAnswerRequest
  ): Promise<SecretRequestAnswerResponse> {
    return this.send("POST", agentChatRoutes.secretRequest(id, requestId), { body });
  }

  /** The chat's pending Orquester approval cards (unified MCP §7.3; never a secret value). */
  listToolApprovals(id: string, signal?: AbortSignal): Promise<ToolApprovalListResponse> {
    return this.send("GET", agentChatRoutes.toolApprovals(id), { signal });
  }

  /** One pending card with its WHOLE preview ("View all"). */
  getToolApproval(id: string, approvalId: string, signal?: AbortSignal): Promise<ToolApprovalDetailResponse> {
    return this.send("GET", agentChatRoutes.toolApproval(id, approvalId), { signal });
  }

  /**
   * Answer a card — the only way to (§7.3). Card secrets ride in this body only, never a URL, a
   * log or a store; the response carries the outcome alone.
   */
  answerToolApproval(id: string, approvalId: string, body: ToolApprovalAnswer): Promise<ToolApprovalAnswerResponse> {
    return this.send("POST", agentChatRoutes.toolApproval(id, approvalId), { body });
  }

  /**
   * Usage-limit recovery (`agentChatRoutes.usageLimit`): arm (`true`) or cancel the automatic
   * resume of a chat stopped on its usage limit. Answers the chat's state after it.
   */
  setUsageLimitAutoResume(id: string, armed: boolean): Promise<UsageLimitActionResponse> {
    return this.send("POST", agentChatRoutes.usageLimit(id, "auto-resume"), { body: { armed } });
  }

  /** Send the continue message into a limited chat now; a retry with the same `commandId` never sends twice. */
  resumeLimitedChat(id: string, commandId: string): Promise<UsageLimitActionResponse> {
    return this.send("POST", agentChatRoutes.usageLimit(id, "resume"), { body: { commandId } });
  }

  /** Move a limited chat to another account of its agent (the daemon's pick without `accountId`) and continue. */
  switchLimitedChat(id: string, body: UsageLimitSwitchRequest): Promise<UsageLimitActionResponse> {
    return this.send("POST", agentChatRoutes.usageLimit(id, "switch"), { body });
  }

  /** Dismiss the "switched account after a usage limit" notice. */
  dismissLimitFailover(id: string): Promise<UsageLimitActionResponse> {
    return this.send("POST", agentChatRoutes.usageLimit(id, "dismiss-failover"), { body: {} });
  }

  /** Settings › Agent tools: every grant (§7.6). */
  getAgentTools(signal?: AbortSignal): Promise<AgentToolsResponse> {
    return this.send("GET", agentToolsRoutes.settings, { signal });
  }

  /** Revoke one grant (204; 404 `GRANT_NOT_FOUND` once it is gone). */
  async revokeAgentToolGrant(grantId: string): Promise<void> {
    await this.send("DELETE", agentToolsRoutes.grant(grantId));
  }

  /** Revoke every grant, or every grant of one chat. */
  revokeAgentToolGrants(threadId?: string): Promise<RevokeAgentToolGrantsResponse> {
    return this.send("DELETE", agentToolsRoutes.grants, threadId ? { query: { threadId } } : {});
  }

  /** One chat's grants (the Tools chip). */
  getThreadAgentTools(id: string, signal?: AbortSignal): Promise<ThreadAgentToolsResponse> {
    return this.send("GET", agentChatRoutes.agentTools(id), { signal });
  }

  /** An Agent Profile chat's own `/` and `$` catalog (unvalidated: read it with `parseThreadCatalogResponse`). */
  getThreadCatalog(id: string, signal?: AbortSignal): Promise<unknown> {
    return this.send("GET", agentChatRoutes.catalog(id), { signal });
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

  // Desktops (virtual X displays streamed over RFB + Opus)

  /** boxes: with `projectPath`, the prerequisites where that project's desktops run (its VM for a box project). */
  desktopHostStatus(signal?: AbortSignal, projectPath?: string): Promise<DesktopHostStatus> {
    return this.send("GET", desktopRoutes.host, { query: projectPath ? { projectPath } : undefined, signal });
  }

  listDesktops(projectPath?: string, signal?: AbortSignal): Promise<DesktopSummary[]> {
    return this.send("GET", desktopRoutes.list, {
      query: projectPath ? { projectPath } : undefined,
      signal
    });
  }

  desktopSuggestions(projectPath: string, signal?: AbortSignal): Promise<DesktopSuggestionsResponse> {
    return this.send("GET", desktopRoutes.suggestions, { query: { projectPath }, signal });
  }

  createDesktop(body: CreateDesktopRequest): Promise<DesktopSummary> {
    return this.send("POST", desktopRoutes.create, { body });
  }

  stopDesktop(id: string): Promise<DesktopSummary> {
    return this.send("POST", desktopRoutes.stop(id));
  }

  restartDesktop(id: string): Promise<DesktopSummary> {
    return this.send("POST", desktopRoutes.restart(id));
  }

  closeDesktop(id: string): Promise<void> {
    return this.send("DELETE", desktopRoutes.desktop(id));
  }

  launchDesktopApp(id: string, body: LaunchAppRequest): Promise<DesktopAppSummary> {
    return this.send("POST", desktopRoutes.apps(id), { body });
  }

  stopDesktopApp(id: string, appId: string, force = false): Promise<void> {
    return this.send("DELETE", desktopRoutes.app(id, appId), { query: force ? { force: "1" } : undefined });
  }

  /** The app's log tail. The daemon serves text/plain, so this reads bytes rather than JSON. */
  async desktopAppLog(id: string, appId: string, signal?: AbortSignal): Promise<string> {
    const path = desktopRoutes.appLog(id, appId);
    if (!this.transporter.requestBytes) throw new Error("Logs are not supported on this connection.");
    const response = await this.transporter.requestBytes({ method: "GET", path, signal });
    if (!response.ok) {
      throw new ApiError(response.status, "GET", path, response.headers, undefined);
    }
    return new TextDecoder().decode(response.data);
  }

  desktopWindowAction(id: string, windowId: string, action: DesktopWindowAction): Promise<void> {
    return this.send("POST", desktopRoutes.windowAction(id, windowId, action));
  }

  /**
   * Authenticated ws(s):// URL for a desktop socket path (`desktopRoutes.vncSocket(id)` /
   * `audioSocket(id)`), or null on transports without WebSockets (the desktop unix
   * socket — same availability as browser tabs). The bearer rides as ?token=.
   */
  desktopSocketUrl(path: string): string | null {
    if (this.transportKind !== "http") {
      return null;
    }
    const base = this.connection.endpoint.replace(/\/$/, "").replace(/^http/, "ws");
    const token = this.connection.password ? `?token=${encodeURIComponent(this.connection.password)}` : "";
    return `${base}${path}${token}`;
  }

  // System status (host observability). No push events exist for any of these —
  // callers poll them, and only while their surface is on screen.

  systemResources(signal?: AbortSignal): Promise<SystemResourcesResponse> {
    return this.send("GET", "/api/system/resources", { signal });
  }

  systemProcesses(signal?: AbortSignal, scope: SystemProcessesScope = "tree"): Promise<SystemProcessesResponse> {
    return this.send("GET", scope === "host" ? "/api/system/processes?scope=host" : "/api/system/processes", { signal });
  }

  systemProcessDetails(pid: number, signal?: AbortSignal): Promise<SystemProcessDetailsResponse> {
    return this.send("GET", `/api/system/processes/${pid}`, { signal });
  }

  systemPorts(signal?: AbortSignal): Promise<SystemPortsResponse> {
    return this.send("GET", "/api/system/ports", { signal });
  }

  /** The agent host and a deploy's pending drain-restart, with what it waits on (Settings → Host status). */
  agentHostStatus(signal?: AbortSignal): Promise<AgentHostStatusResponse> {
    return this.send("GET", agentChatRoutes.hostStatus, { signal });
  }

  /** Restart the agent host NOW, whatever is running — every turn and background task stops. */
  restartAgentHost(): Promise<AgentHostStopResponse> {
    return this.send("POST", agentChatRoutes.hostStop, { body: {} });
  }

  /** Stop one background task of a chat (`task/stop`), outside its own view. */
  stopAgentTask(sessionId: string, taskId: string): Promise<CommandReceiptResponse> {
    return this.send("POST", agentChatCommandPath(sessionId, "task/stop"), {
      body: { commandId: newCommandId(), taskId }
    });
  }

  /** End a chat's provider session (`session/stop`), and with it everything the session runs. */
  stopAgentSession(sessionId: string): Promise<CommandReceiptResponse> {
    return this.send("POST", agentChatCommandPath(sessionId, "session/stop"), {
      body: { commandId: newCommandId() }
    });
  }

  /**
   * Signal a pid and its descendants — SIGTERM, or SIGKILL to force. Refusals come back as a 400 whose body
   * carries a {@link KillProcessErrorCode} — thrown as an ApiError, so callers
   * read `error.body.code` to tell "protected" from "not managed".
   */
  killSystemProcess(pid: number, signal: KillProcessSignal = "SIGTERM"): Promise<KillProcessResponse> {
    return this.send("POST", "/api/system/processes/kill", { body: { pid, signal } });
  }
}

export interface WorkflowLogWindow {
  text: string;
  /** Where the next window starts, in the raw file's bytes (the daemon's word). */
  nextOffset: number;
  /** The window reached the file's end (as it is now). */
  eof: boolean;
  /** The file's size when read. */
  size: number;
  /** The daemon still writes this log (the block runs). */
  live: boolean;
}

function headerOf(headers: Record<string, string>, name: string): string | undefined {
  if (name in headers) return headers[name];
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === lower) return value;
  return undefined;
}

/** A log window's body and `X-Log-*` headers. Headers missing (a proxy stripped them): the window is the whole rest. */
export function parseWorkflowLogWindow(data: ArrayBuffer, headers: Record<string, string>, offset: number): WorkflowLogWindow {
  const text = new TextDecoder().decode(data);
  const next = Number(headerOf(headers, "x-log-next-offset"));
  const size = Number(headerOf(headers, "x-log-size"));
  const eofHeader = headerOf(headers, "x-log-eof");
  const nextOffset = Number.isFinite(next) && next >= offset ? next : offset + data.byteLength;
  return {
    text,
    nextOffset,
    eof: eofHeader === undefined ? true : eofHeader === "1",
    size: Number.isFinite(size) ? size : nextOffset,
    live: headerOf(headers, "x-log-live") === "1"
  };
}

/** A validated knowledge answer, or a rejection naming what could not be read. */
function readKnowledge<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`The server sent a knowledge ${what} this app cannot read.`);
  return value;
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

/** A §6.2 command id (the idempotency key), minted by the client. */
function newCommandId(): string {
  const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoRef?.randomUUID) return cryptoRef.randomUUID();
  return `id-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}
