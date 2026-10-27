import type {
  AccountSummary,
  AccountTestResult,
  AgentAccount,
  AgentConversationsResponse,
  AgentEventRequest,
  AgentUsage,
  BrowserClientMessage,
  BrowserSuggestionsResponse,
  BrowserSummary,
  ClaudeOAuthLink,
  ClaudeOAuthLinkStatus,
  CreateAccountRequest,
  CreateBrowserRequest,
  CreateProjectRequest,
  CreateSessionRequest,
  CreateTodoRequest,
  CreateWorkspaceRequest,
  DeviceLink,
  DeviceLinkStatus,
  EventMessage,
  FsCapabilitiesResponse,
  FsCreateRequest,
  FsEntry,
  FsFilesResponse,
  FsListResponse,
  FsReadResponse,
  FsRenameRequest,
  FsSearchResponse,
  FsUploadRequest,
  FsUploadResponse,
  FsWriteRequest,
  GitBranchesResponse,
  GitCommitDetail,
  GitDiffResponse,
  GitLogEntry,
  GitOpResult,
  GitStashActionRequest,
  GitStashCreateRequest,
  GitStashEntry,
  GitStatusChangedPayload,
  GitStatusResponse,
  GitWorkingDiffResponse,
  HealthResponse,
  ImportAgentAccountRequest,
  SubmitClaudeOAuthCodeRequest,
  KillProcessErrorResponse,
  KillProcessRequest,
  KillProcessResponse,
  MarkRecentProjectRequest,
  OpenRequest,
  OpenResult,
  OwnerSummary,
  ProjectSummary,
  ProjectTemplatesResponse,
  PushInfoResponse,
  PushSubscribeRequest,
  PushTestResponse,
  PushUnsubscribeRequest,
  RecentProjectSummary,
  RegistryKind,
  RegistryEntry,
  RegistryResponse,
  RenameSessionRequest,
  RepoSummary,
  ReorderSessionsRequest,
  ServerInfoResponse,
  SetAgentAccountDefaultsRequest,
  SetProtectArchivedRequest,
  SessionActivity,
  SessionActivityEvent,
  SessionInputRequest,
  SessionResizeRequest,
  SessionSummary,
  SessionUploadRequest,
  SessionUploadResponse,
  SystemPortsResponse,
  SystemProcessDetailsResponse,
  SystemProcessesResponse,
  SystemResourcesResponse,
  UpdateProjectRequest,
  UpdateTodoRequest,
  UpdateWorkspaceRequest,
  UsageAccount,
  UsageResponse,
  SubagentCacheTtlStatus,
  UsageWindow,
  WorkspaceSummary
} from "@orquester/api";
import {
  BROWSER_FRAME_TYPE_JPEG,
  DESKTOP_CHANNEL,
  DESKTOP_WS_PREFIXES,
  deviceQueryTokenAllowed,
  DEVICE_WS_PREFIXES,
  MAX_INITIAL_COMMAND,
  SECRET_REQUEST_EVENT_TYPE,
  SYSTEM_ACCOUNT_ID
} from "@orquester/api";
import {
  DAEMON_EVENTS_CHANNEL,
  DAEMON_STOPPING_EVENT,
  ORQUESTER_PROTOCOL_VERSION,
  ORQUESTER_SERVICE,
  type DaemonStoppingPayload
} from "@orquester/api";
import { isBinOnPath, RegistryService } from "./registry";
import { BrowserError, BrowserManager } from "./browsers";
import { DesktopAudioHub } from "./desktops/audio.ts";
import { DesktopHostProbe, resolveTool } from "./desktops/host-status.ts";
import { registerDesktopHttpRoutes } from "./desktops/http-routes.ts";
import { DesktopManager } from "./desktops/manager.ts";
import { registerDesktopWsRoutes } from "./desktops/ws-routes.ts";
import { registerAuthRoutes } from "./auth/routes.ts";
import { AuthSessionStore } from "./auth/sessions.ts";
import { LoginThrottle, clientIp } from "./auth/throttle.ts";
import { redactUrlTokens, sanitizeDevtoolsPath } from "./devtools.js";
import { UrlWatcher } from "./url-watcher";
import { AgentHooks } from "./agent-hooks";
import { DailyLogStream } from "./daily-log.ts";
import { daemonBuildInfo, type BuildInfo } from "./build-info.ts";
import { listAgentConversations } from "./agent-conversations.ts";
import { type ISessionManager, SessionError, createSessionManager, resumeLaunchArgs } from "./sessions";
import { createSessionStream } from "./session-stream";
import { AgentChatService, ChatSessionError, type CreateAgentChatRequest } from "./agent-chat/service.ts";
import { INVALID_OWNER, parseSessionOwner } from "./agent-chat/owner.ts";
import { ChatAwareSessionManager } from "./agent-chat/session-router.ts";
import { AGENT_VISUAL_ROUTE_PATTERN, registerAgentChatRoutes } from "./agent-chat/proxy-routes.ts";
// boxes: route patterns exempt from user auth (they do box auth).
import { BOX_HUB_PUBLIC_ROUTES } from "./boxes/hub/routes.ts";
import { LineageService } from "./agent-chat/lineage.ts";
import { DelegateStopCascade } from "./agent-chat/delegates.ts";
import { registerLineageRoutes } from "./agent-chat/lineage-routes.ts";
import { ChatLimitRecovery } from "./agent-chat/limit-recovery.ts";
import { ChatIdleCompaction } from "./agent-chat/idle-compaction.ts";
import { registerUsageLimitRoutes } from "./agent-chat/limit-recovery-routes.ts";
import { createCooldownStore } from "./workflows/agent/cooldowns.ts";
import { realClock } from "./workflows/factory.ts";
// umcp:t5 begin
import { registerReplySubscriptionRoutes } from "./agent-chat/lineage-routes.ts";
import { ReplyRouter } from "./agent-chat/replies.ts";
import { agentChatReplyOutboxFile } from "@orquester/config";
// umcp:t5 end
import { registerSecretRequestRoutes, SecretRequestRegistry } from "./agent-chat/secret-requests.ts";
// umcp:t3 begin
import { connectExecutor, createAgentToolsRuntime, type AgentToolsRuntime } from "./agent-tools/approval-port.ts";
import { registerAgentToolsRuntimeRoutes } from "./agent-tools/routes.ts";
import { executorPorts } from "./mcp/executor.ts";
// umcp:t3 end
// umcp:t6 begin
import { agentHostRoutes, SESSION_TOOLS_REFRESH_TIMEOUT_MS, type SessionToolsRefreshResponse } from "./agent-host/host-protocol.ts";
import { catalogFor } from "./mcp/catalog/index.ts";
import { canonicalProjectPath } from "./agent-tools/approval-port.ts";
import { registerSessionToolsManifestRoute, SessionToolsRefresher } from "./session-tools/session-tools-refresh.ts";
import { AGENT_PROFILE_CHANNEL, authRoutes, type AgentProfileAgentId } from "@orquester/api";
import { PUSH_CHANNEL, PUSH_NOTIFICATION_EVENT_TYPE } from "@orquester/api";
import { SECRET_FILES_CHANGED, SECRET_FILES_CHANNEL, SECRET_FILES_PLUGIN_ID, type PluginsResponse } from "@orquester/api";
// umcp:t6 end
// umcp:t9 begin
import { registerPushNotifyRoute } from "./push.ts";
// umcp:t9 end
import type { ActivityCause } from "./ansi-activity";
import { TodoError, TodoListManager } from "./todos";
import { RecentProjectsService, describeProjectPath } from "./recent-projects";
import { SavedPromptsService, publishSavedPromptEvents, registerSavedPromptRoutes } from "./saved-prompts.ts";
import { RepoIdentitiesService, publishRepoIdentityEvents } from "./repo-identities/service.ts";
import { registerRepoIdentityRoutes } from "./repo-identities/routes.ts";
import { GitHubLinkPreviewService } from "./github-links/service.ts";
import { registerGitHubLinkRoutes } from "./github-links/routes.ts";
import { SecretVaultStore } from "./secret-files/vault-store.ts";
import { SecretFilesService } from "./secret-files/service.ts";
import { registerSecretFilesRoutes } from "./secret-files/routes.ts";
import { registerTodoToggleRoute } from "./todo-items.ts";
import { PluginsService, publishPluginEvents } from "./plugins/plugins-service.ts";
import { registerPluginRoutes } from "./plugins/routes.ts";
import { KnowledgeService } from "./knowledge/service.ts";
import { KnowledgeLinkingService } from "./knowledge/linking/service.ts";
import { createDaemonWorkerSessions } from "./knowledge/linking/daemon-workers.ts";
import { ensureKnowledgeIndexerProfile } from "./knowledge/linking/indexer-profile.ts";
// boxes: Ephemeral AI VMs — the box service (projects in boxes, the plugin's routes).
import { isBoxLocation, sendBoxError, type BoxService } from "./boxes/service/index.ts";
// Device simulators plugin: the device service, its routes and the device tools' backend.
import { createDaemonDevices, type DaemonDevices } from "./devices/wiring.ts";
import { detectRepoInfo, remoteRepoFields } from "./repo-id";
import { Tmux, sessionPath, tmuxAvailable, tmuxVersionOk } from "./tmux";
import { SystemStatusService } from "./system-status";
import { DeviceLinkService } from "./device-link.ts";
import { grokAuthJsonFromDeviceTokens, httpGrokDeviceAuth, type GrokDeviceTokens } from "./grok-device-auth.ts";
import {
  codexAuthJsonFromDeviceTokens,
  httpCodexDeviceAuth,
  type CodexDeviceHandle,
  type CodexDeviceTokens
} from "./codex-device-auth.ts";
import { ClaudeOAuthLinkService } from "./claude-oauth-link.ts";
import { retireModelProxy } from "./model-proxy-retirement.ts";
import { Broadcaster } from "./broadcaster";
import { AccountError, AccountsService } from "./accounts";
import { cloneRefProblem } from "./workflows/git-remote";
import type { ProjectOps, WorkflowEngine } from "./workflows/contracts.ts";
import { WorkflowService, publishWorkflowEvents } from "./workflows/service.ts";
import { WorkflowSecretsService } from "./workflows/secrets.ts";
import { FileRunStore } from "./workflows/run-store.ts";
import { WorkflowStateStore } from "./workflows/state-store.ts";
import { registerWorkflowRoutes } from "./workflows/routes.ts";
import { readGitStatusShort } from "./workflows/projects.ts";
import { HANDOFF_GIT_STATUS_BYTES } from "@orquester/api/agent-chat";
import { AgentProfileService, publishAgentProfileEvents } from "./agent-profile/service.ts";
import { registerAgentProfileRoutes } from "./agent-profile/routes.ts";
import { SessionProfileService, publishSessionProfileEvents } from "./session-profiles/service.ts";
import { SessionProfileLifecycle, publishSessionProfilePrepareEvents } from "./session-profiles/lifecycle.ts";
import { SessionProfileStore } from "./session-profiles/store.ts";
import { registerSessionProfileRoutes } from "./session-profiles/routes.ts";
import { SessionProfileImports } from "./session-profiles/imports.ts";
import { createProfileLaunchResolver, SessionProfileNames } from "./session-profiles/launch.ts";
import { registerThreadLaunchProfileRoute } from "./agent-chat/profile-launch-route.ts";
import { createAgentProfileAdapters } from "./agent-profile/adapters/index.ts";
import { createProfileConverter } from "./agent-profile/convert.ts";
import { ProfileImportStore } from "./agent-profile/import.ts";
import { resolveAgentHomes } from "./agent-profile/homes.ts";
// umcp:t11 begin
import { DaemonMcpDetector, listProjectDirs, registerDaemonMcpServersRoutes } from "./agent-profile/daemon-mcp.ts";
// umcp:t11 end
import type { ValidationCatalog } from "./workflows/agent/validation-catalog.ts";
import { consoleWorkflowLogger, createWorkflowDaemon } from "./workflows/daemon-wiring.ts";
import { createInternalDaemonApi } from "./chat-client/index.ts";
import { AgentAccountsService } from "./agent-accounts.ts";
import { AgentAccountError } from "./agent-account-paths.ts";
import { PushService, isValidPushEndpoint } from "./push";
import { GitError, GitService, GitWatcher, passesGitEventFilter, workingDiffMaxBytes } from "./git";
import { UsageService } from "./usage";
import { UsageTokensScanner } from "./usage-tokens";
import { ChatThreadUsageScanner } from "./usage-chat-threads.ts";
import { SubagentCacheTtlController, type SubagentCacheTtl } from "./subagent-cache-ttl";
import {
  createClaudeSource,
  createCodexSource,
  createGrokSource,
  readUsagePrefs,
  claudeLiveUsageFromWindows,
  shouldHideSystemUsage,
  type ClaudeUsageSource
} from "./usage-sources";
import { UsageStateFile } from "./usage-state";
import { currentScopedWindows, currentWindow } from "./usage-parse";
import { listArchiveEntries } from "./archive";
import { ParquetRequestError, readParquetWindow } from "./parquet";
import { resolveZipTool, spawnDirZip } from "./zip";
import { FsSearchError, listProjectFiles, searchProjectFiles } from "./search";
import { InjectDaemonApi } from "./mcp/daemon-api.ts";
import { HtmlPreviewBrowser } from "./html-preview/index.ts";
import { registerMcp } from "./mcp/server.ts";
import { externalCredentialId, registerPrincipalHook, registerRemoteFieldStripping } from "./mcp/principal.ts";
import { registerSessionToolsRoute } from "./session-tools/route.ts";
// boxes: file routes of box projects (spec §8.7).
import type { BoxRegistry } from "./boxes/contracts.ts";
import { registerBoxFsRouting } from "./boxes/remote/fs/routes.ts";
import { boxAwareSecretFileIo } from "./boxes/remote/fs/secret-files.ts";
import { boxImageReader } from "./boxes/remote/fs/images.ts";
import {
  UploadTooLargeError,
  acceptRawBody,
  declaredLengthExceedsCap,
  discardUpload,
  isUploadTooLarge,
  receiveUpload,
  refuseUpload,
  uploadTempPath
} from "./upload-stream.ts";
import {
  type AppConfig,
  type ClientConfig,
  type ConfigVars,
  type DaemonConfig,
  type DaemonPaths,
  type RemoteConnectionConfig,
  type RemotesConfig,
  type WorkspaceMeta,
  type WorkspacesConfig,
  accountsConfigPath,
  agentAccountsDir,
  agentProfileImportsDir,
  agentAccountsFile,
  appConfigPath,
  authSessionsPath,
  browserProfilesDir,
  browsersIndexPath,
  createDefaultAppConfig,
  desktopsIndexPath,
  desktopsRuntimeDir,
  createDefaultClientConfig,
  createDefaultDaemonConfig,
  createDefaultRemotesConfig,
  createDefaultWorkspacesConfig,
  expandVars,
  keysDir,
  parseAppConfig,
  applyAppConfigUpdate,
  parseDaemonConfig,
  parseRemotesConfig,
  parseWorkspacesConfig,
  pushConfigPath,
  recentProjectsPath,
  remotesConfigPath,
  repoIconsDir,
  secretFilesDir,
  knowledgeWorkersDir,
  repoIdentitiesPath,
  resolveDaemonPaths,
  savedPromptsPath,
  sessionsIndexPath,
  workflowRunsDir,
  workflowSecretsPath,
  workflowStatePath,
  workflowsPath,
  tmuxSocketPath,
  todosIndexPath,
  usageTokensCacheFile,
  agentChatThreadsDir,
  subagentCacheTtlStateFile,
  usageStateFile,
  workspacesMetaPath,
  isValidName,
  agentChatMergeOutboxFile
} from "@orquester/config";
import { CHROMIUM_FAMILY_IDS, TEMPLATES } from "@orquester/registry";
import { assertInsideFsRoot, FsSandboxError } from "@orquester/config/fs";
import fastifyStatic from "@fastify/static";
import websocketPlugin from "@fastify/websocket";
import { WebSocket as UpstreamWebSocket } from "ws";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, platform as osPlatform } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fsPathFromQuery } from "./fs-path-query.js";
import { randomUUID } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import bcrypt from "bcryptjs";
// boxes: temporary boxes for agent chats (Ephemeral AI VMs spec §13).
import { registerTemporaryBoxRoutes, TemporaryBoxTools } from "./boxes/temporary/index.ts";
// boxes: every box module wired over the daemon's services.
import { createDaemonBoxes, type DaemonBoxes } from "./boxes/wiring.ts";

const daemonId = randomUUID();

/**
 * Hard ceiling on a single /api/fs/raw read: the in-memory + in-app download
 * limit for binary preview. See docs/superpowers/specs/2026-06-24-file-preview-design.md.
 */
const RAW_MAX_BYTES = 50 * 1024 * 1024;

/** Filesystem locations resolved (variables expanded) for this run. */
interface ResolvedPaths {
  /** `<appdir>` itself — every `@orquester/config` path helper takes this. */
  baseDir: string;
  daemonDir: string;
  configPath: string;
  /** app.json + remotes.json live under <appdir>/app and are shared by clients. */
  appConfigFile: string;
  remotesFile: string;
  /** Per-workspace metadata side-table (daemon-side, keyed by workspace name). */
  workspacesMetaFile: string;
  /** Fixed socket of the dedicated tmux server that owns session PTYs. */
  tmuxSocket: string;
  /** <appdir>/daemon/sessions.json — the reattach index. */
  sessionsIndexFile: string;
  /** <appdir>/daemon/browsers.json — the browser-tab index. */
  browsersIndexFile: string;
  /** <appdir>/daemon/browser-profiles — per-project Chromium user-data dirs (0700). */
  browserProfilesDir: string;
  /** <appdir>/daemon/desktops.json — the desktop-tab index. */
  desktopsIndexFile: string;
  /** <appdir>/daemon/desktops — per-desktop runtime dirs: sockets, cookies, logs (0700). */
  desktopsRuntimeDir: string;
  /** <appdir>/daemon/todos.json — the managed to-do list index. */
  todosIndexFile: string;
  /** <appdir>/daemon/recent-projects.json — the shared recent-projects list. */
  recentProjectsFile: string;
  /** <appdir>/daemon/saved-prompts.json — the shared saved-prompt library. */
  savedPromptsFile: string;
  /** <appdir>/daemon/workflows.json — automated workflow definitions (workflows spec §3.1). */
  workflowsFile: string;
  /** <appdir>/daemon/workflow-state.json — schedule/git cursors, account cooldowns. */
  workflowStateFile: string;
  /** <appdir>/daemon/workflow-secrets.json — secret values (0600; names only leave the daemon). */
  workflowSecretsFile: string;
  /** <appdir>/daemon/workflow-runs — one directory per run (§5.8). */
  workflowRunsDir: string;
  /** <appdir>/daemon/push.json — Web Push VAPID keypair + subscriptions (0600). */
  pushConfigFile: string;
  workspacesDir: string;
  /** <appdir>/daemon/keys — per-account SSH keys (created mode 0700). */
  keysDir: string;
  /** <appdir>/daemon/accounts.json — connected git accounts (daemon-side). */
  accountsFile: string;
  /** Sandbox root for the /api/fs browser API (default = workspacesDir). */
  fsRoot: string;
  logsDir: string;
  vars: ConfigVars;
}

export interface StartDaemonOptions {
  cwd?: string;
  appdir?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform | string;
  webDir?: string;
}

export interface RunningDaemon {
  daemonId: string;
  socketPath: string;
  workspacesDir: string;
  stop: () => Promise<void>;
}

/**
 * Fold the System ("base") reading plus every managed account into a single
 * head AgentUsage using the advertised "worst-account" strategy: for each of the
 * session and weekly windows independently, surface the window with the highest
 * utilization (percent used) across all sources — the account closest to its
 * quota, i.e. the worst remaining. This is what the top-bar chip and the pooled
 * bars render; the per-account breakdown stays in `accounts` untouched.
 *
 * `base` is the System account (null when the user runs managed accounts only).
 * Windows may be null on any source (not signed in / no data yet) and are simply
 * skipped, as is any window whose resetsAt has already passed (a stale source's
 * frozen pre-reset reading must not outlive its window). Since the base drives
 * the head numbers, it is also exposed as a `system` row so the panel can show
 * every source the aggregate drew from. If nothing has any window, the head
 * windows stay null.
 */
export function aggregateWorstAccountUsage(
  agent: string,
  base: AgentUsage | null,
  accounts: UsageAccount[],
  now: number
): AgentUsage {
  type Source = { stale: boolean; asOf?: string; session: UsageWindow | null; weekly: UsageWindow | null };
  const sources: Source[] = [];
  if (base) sources.push({ stale: base.stale, asOf: base.asOf, session: base.session, weekly: base.weekly });
  for (const a of accounts) sources.push({ stale: a.stale, asOf: a.asOf, session: a.session, weekly: a.weekly });

  // Pick the still-current window with the highest percent for a given field,
  // carrying the freshness/timestamp of the source it came from (an honest "as of").
  const worst = (pick: (s: Source) => UsageWindow | null): { window: UsageWindow | null; stale: boolean; asOf?: string } => {
    let best: { window: UsageWindow; stale: boolean; asOf?: string } | null = null;
    for (const s of sources) {
      const w = currentWindow(pick(s), now);
      if (!w) continue;
      if (best === null || w.percent > best.window.percent) {
        best = { window: w, stale: s.stale, asOf: s.asOf };
      }
    }
    return best ?? { window: null, stale: true, asOf: undefined };
  };

  const session = worst((s) => s.session);
  const weekly = worst((s) => s.weekly);
  const staleAccountCount = accounts.filter((a) => a.stale).length;
  const baseScoped = base ? currentScopedWindows(base.scopedWindows, now) : undefined;

  return {
    id: base?.id ?? agent,
    available: (base?.available ?? false) || accounts.some((a) => a.available),
    // The chip greys out only when neither shown window is a fresh reading.
    stale: session.stale && weekly.stale,
    plan: base?.plan ?? accounts.find((a) => a.plan)?.plan,
    session: session.window,
    weekly: weekly.window,
    asOf: session.asOf ?? weekly.asOf ?? base?.asOf,
    accounts,
    system: base
      ? {
          id: SYSTEM_ACCOUNT_ID,
          label: "System",
          available: base.available,
          stale: base.stale,
          plan: base.plan,
          session: currentWindow(base.session, now),
          weekly: currentWindow(base.weekly, now),
          ...(baseScoped ? { scopedWindows: baseScoped } : {}),
          asOf: base.asOf,
          ...(base.lastKnown ? { lastKnown: base.lastKnown } : {}),
          ...(base.loginExpiresAt ? { loginExpiresAt: base.loginExpiresAt } : {}),
          ...(base.needsReauth !== undefined ? { needsReauth: base.needsReauth } : {})
        }
      : undefined,
    aggregate: { strategy: "worst-account", accountCount: accounts.length, staleAccountCount }
  };
}

export async function startDaemon(options: StartDaemonOptions = {}): Promise<RunningDaemon> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const runtimePlatform = options.platform ?? osPlatform();
  const appdir = resolveAppdir(options.appdir ?? env.ORQUESTER_APPDIR, cwd);

  const paths = resolveDaemonPaths({
    homeDir: options.homeDir ?? homedir(),
    platform: runtimePlatform,
    cwd,
    appdir,
    env
  });
  const config = await loadConfig(paths, env);
  validateTransportConfig(config);

  const resolved: ResolvedPaths = {
    baseDir: paths.baseDir,
    daemonDir: paths.daemonDir,
    configPath: paths.configPath,
    appConfigFile: appConfigPath(paths.baseDir),
    remotesFile: remotesConfigPath(paths.baseDir),
    workspacesMetaFile: workspacesMetaPath(paths.baseDir),
    tmuxSocket: tmuxSocketPath(paths.baseDir),
    sessionsIndexFile: sessionsIndexPath(paths.baseDir),
    browsersIndexFile: browsersIndexPath(paths.baseDir),
    browserProfilesDir: browserProfilesDir(paths.baseDir),
    desktopsIndexFile: desktopsIndexPath(paths.baseDir),
    desktopsRuntimeDir: desktopsRuntimeDir(paths.baseDir),
    todosIndexFile: todosIndexPath(paths.baseDir),
    recentProjectsFile: recentProjectsPath(paths.baseDir),
    savedPromptsFile: savedPromptsPath(paths.baseDir),
    workflowsFile: workflowsPath(paths.baseDir),
    workflowStateFile: workflowStatePath(paths.baseDir),
    workflowSecretsFile: workflowSecretsPath(paths.baseDir),
    workflowRunsDir: workflowRunsDir(paths.baseDir),
    pushConfigFile: pushConfigPath(paths.baseDir),
    workspacesDir: expandVars(config.workspacesDir, paths.vars),
    keysDir: keysDir(paths.baseDir),
    accountsFile: accountsConfigPath(paths.baseDir),
    fsRoot: config.transports.http.fsRoot
      ? expandVars(config.transports.http.fsRoot, paths.vars)
      : expandVars(config.workspacesDir, paths.vars),
    logsDir: expandVars(config.logsDir, paths.vars),
    vars: paths.vars
  };
  await prepareDirs(resolved);

  const buildInfo = daemonBuildInfo();
  // Rolled over at local midnight and at its size cap; old days pruned (daily-log.ts).
  const logStream = new DailyLogStream({ logsDir: () => resolved.logsDir });
  const clientConfig = createDefaultClientConfig(paths.socketPath);

  // Shared, transport-agnostic services. Sessions live here so they survive
  // client disconnects and are visible across every transport/client. The
  // backend is tmux-backed (persists across daemon restarts) where a tmux binary
  // is present — the VPS and any Linux/macOS host with tmux — and falls back to
  // a direct node-pty backend on hosts without tmux (Windows, stock macOS), so
  // the desktop built-in daemon keeps creating sessions everywhere.
  const registry = new RegistryService(resolved.daemonDir);
  const tmux = new Tmux(resolved.tmuxSocket);
  const agentHooks = new AgentHooks(resolved.daemonDir, resolved.vars.userhome);
  const agentAccounts = new AgentAccountsService({
    indexFile: agentAccountsFile(paths.baseDir),
    accountsDir: agentAccountsDir(paths.baseDir),
    userhome: resolved.vars.userhome,
    now: () => Date.now(),
    logger: console
  });
  const usageTokens = new UsageTokensScanner({
    userhome: resolved.vars.userhome,
    cacheFile: usageTokensCacheFile(paths.baseDir),
    now: () => Date.now(),
    accountHomes: () => [
      // Token-transcript scanning knows the Claude/Codex session formats only;
      // grok homes are skipped (Grok Build has no scanner support yet).
      ...agentAccounts
        .list()
        .accounts.filter((a): a is typeof a & { agent: "claude" | "codex" } => a.agent !== "grok")
        .map((a) => ({ agent: a.agent, home: agentAccounts.homePath(a.agent, a.id) }))
    ]
  });
  // Grok's usage per day, from Orquester's own chat logs (it has no transcript the scanner reads).
  const chatThreadUsage = new ChatThreadUsageScanner({ threadsDir: agentChatThreadsDir(paths.baseDir), agents: ["grok"], now: () => Date.now(), logger: console });
  // Auto mode of the Claude subagent cache lifetime decides from the requests
  // the scanner already holds. A daemon that just started has scanned nothing:
  // ask for a scan and keep the stored decision until it is in.
  const subagentCacheTtl = new SubagentCacheTtlController({
    stateFile: subagentCacheTtlStateFile(paths.baseDir),
    now: () => Date.now(),
    requests: (sinceMs) => {
      const requests = usageTokens.subagentRequests(sinceMs);
      if (!requests) usageTokens.requestRecompute();
      return requests;
    }
  });
  /**
   * The full launch env for one agent — account home and the Claude harness options.
   * Lifted out of the
   * session manager's `resolveExtraEnv` seam because a chat thread must get
   * EXACTLY the env a terminal launch gets today (chat spec §3.1 "Launch
   * environment"); two copies would drift on the first change.
   */
  const resolveAgentLaunchEnv = async (entry: RegistryEntry, ctx: { accountId?: string }) => {
    // Claude harness stream/API timeout (spec
    // 2026-07-29-claude-agent-timeout-setting-design.md §3). Read fresh per
    // launch so a settings change applies to the next session with no daemon
    // restart; readAppConfigFile already falls back to schema defaults on a
    // missing or corrupt file, so this cannot throw.
    const { claudeTimeoutMinutes, claudeSubagentCacheTtl } = (await readAppConfigFile(resolved.appConfigFile)).agents;
    return buildAgentLaunchEnv(
      entry.id,
      {
        timeoutMinutes: claudeTimeoutMinutes,
        // Only a Claude launch reads it, and only auto mode has anything to decide.
        subagentCacheTtl: entry.id === "claude" ? await subagentCacheTtl.resolve(claudeSubagentCacheTtl) : "5m"
      },
      await agentAccounts.resolveLaunchEnv(entry.id, ctx.accountId)
    );
  };

  // Web push and the event bus are dependency-free and are built here (rather
  // than below with the rest) because the agent-chat service needs both, and it
  // in turn has to exist before the session manager, which persists its tab
  // records (chat spec §5.2).
  const broadcaster = new Broadcaster();
  // Every push also goes on the event bus: the desktop app shows it as a native notification.
  const push = new PushService(resolved.pushConfigFile, console, {
    onNotification: (event) => broadcaster.publish(PUSH_CHANNEL, PUSH_NOTIFICATION_EVENT_TYPE, event)
  });

  // Chromium resolves through the registry's probed browser entries; no
  // bundled download. Only CDP-speaking (Chromium-family) browsers can drive
  // puppeteer-core — see CHROMIUM_FAMILY_IDS. The browser tabs and the agent
  // pages' preview browser (each a process of its own) both launch it.
  const resolveChromium = (): string | undefined =>
    registry.list().browsers.find((b) => CHROMIUM_FAMILY_IDS.has(b.id) && b.enabled && b.resolvedBin)?.resolvedBin;

  // The supervised agent host (chat spec §3.1). `init()` runs after
  // `sessions.reattach()`, so the chat tab records are already loaded.
  const agentChatTmux = tmuxAvailable() && tmuxVersionOk() ? tmux : null;
  // Agent pages (design 2026-10-14 §2.1): previews and publish-time heights, in a browser of their
  // own per call, never the browser tabs' process. Stopped with the daemon (its previews killed);
  // the profiles a daemon that died mid-preview left behind are swept at boot (D-M4).
  const htmlPreview = new HtmlPreviewBrowser({
    resolveChromium,
    log: (message, error) => console.warn(message, error ?? "")
  });
  void htmlPreview.sweepStaleProfiles().then((removed) => {
    if (removed.length > 0) console.log(`[html-preview] removed ${removed.length} stale preview profile(s)`);
  });
  const agentChat = new AgentChatService({
    baseDir: paths.baseDir,
    daemonSocketPath: paths.socketPath,
    daemonDir: resolved.daemonDir,
    platform: runtimePlatform,
    cwd,
    sessionPath: sessionPath(),
    env,
    tmux: agentChatTmux,
    broadcaster,
    push,
    registryEntry: (refId) => registry.get(refId),
    resolveLaunchEnv: (entry, ctx) => resolveAgentLaunchEnv(entry, ctx),
    htmlPreview,
    // §7.7: "sign in again" only when NO account of the family is valid — the
    // host probes under the daemon user's own login, which may well be stale
    // while every managed account is fine.
    listManagedAccounts: () => agentAccounts.list(),
    systemClaudeConfigFile: () =>
      env.CLAUDE_CONFIG_DIR
        ? join(env.CLAUDE_CONFIG_DIR, ".claude.json")
        : join(resolved.vars.userhome, ".claude.json"),
    // The ONE path a chat launch may grant Claude project trust for. Accepting
    // the request's `cwd` would let a client permanently enable an arbitrary
    // directory's Claude hooks (arbitrary shell as the daemon user, which holds
    // scoped passwordless sudo) — and, for a system-home thread, for every
    // future terminal `claude` tab on that path too. Same confinement the fs
    // routes use: realpath, must be inside `fsRoot`.
    // §6.3 attachment read-back. The host resolved and guarded the path (it
    // owns that namespace); the daemon only streams it, with the same
    // attachment headers the other download routes use.
    sendAttachment: async (reply, path) => {
      const info = await stat(path).catch(() => null);
      if (!info?.isFile()) {
        return reply.code(404).send({ code: "NOT_FOUND", message: "Attachment is gone." });
      }
      return reply
        .header("Content-Type", "application/octet-stream")
        .header("Content-Length", String(info.size))
        .header("Content-Disposition", contentDisposition(basename(path)))
        .send(createReadStream(path));
    },
    resolveTrustedProjectDir: async (projectPath) => {
      if (!projectPath) return null;
      try {
        return await assertInsideFsRoot(resolved.fsRoot, projectPath);
      } catch {
        return null;
      }
    },
    // boxes: html_render / html_preview read a box project's images in its box (spec §8.9).
    // `services` is read per call: no page is published before it exists.
    localImages: (projectDir) => boxImageReader(services.boxRegistry, projectDir),
    // "Continue in another agent": the working tree handed over with the transcript, read as the
    // workflow handoff reads it. `git` is created below; a fork only runs once the daemon is up.
    gitStatusShort: (projectPath) => readGitStatusShort(git, projectPath, HANDOFF_GIT_STATUS_BYTES),
    logger: console
  });

  // boxes: begin
  // Git hosting accounts and the built-in plugins are built here (started below, where they were)
  // because the box modules need both before the session manager exists.
  const accounts = new AccountsService(resolved.accountsFile, resolved.keysDir);
  // Built-in plugins (Settings → Plugins; plugins spec §4–5): plugins.json, the TypeScript engine install and
  // its hourly update check, and the preload new sessions load through NODE_OPTIONS. Started before
  // any transport serves or any chat or workflow run starts, so new sessions already see the
  // preload; its update checks run in the background.
  const plugins = new PluginsService({
    baseDir: paths.baseDir,
    // A getter: PUT /api/config/daemon moves it, then calls `workspacesChanged`.
    workspacesDir: () => resolved.workspacesDir,
    writeJson: writeJsonFile,
    env,
    logger: console
  });
  publishPluginEvents(plugins, broadcaster);
  // Ephemeral AI VMs (spec 2026-10-19): the hub, the box service, sync, tooling and the box
  // terminals the session manager wraps (`boxes/wiring.ts` says what is wired when).
  const boxes: DaemonBoxes = createDaemonBoxes({
    baseDir: paths.baseDir,
    keysDir: resolved.keysDir,
    home: resolved.vars.userhome,
    env,
    daemonHttp: () => ({ host: config.transports.http.host, port: config.transports.http.port }),
    accounts,
    agentAccounts,
    plugins,
    broadcaster,
    catalog: registry,
    workspacesDir: () => resolved.workspacesDir,
    accountsFile: resolved.accountsFile,
    workspacesMetaFile: resolved.workspacesMetaFile,
    writeJson: writeJsonFile,
    sessionPath,
    logger: console
  });
  // boxes: end

  // boxes: a box project's terminals run in its box; the host manager stays the only writer of
  // `sessions.json` (box terminals and chat tabs contribute their records to it).
  const ptySessions = boxes.wrapSessions(
    (indexContributor) =>
      createSessionManager(registry, tmux, resolved.sessionsIndexFile, {
        resolveExtraEnv: async (entry, ctx) => {
          if (entry.kind !== "agent") return null;
          try {
            return await resolveAgentLaunchEnv(entry, ctx);
          } catch (error) {
            throw new SessionError(error instanceof Error ? error.message : String(error));
          }
        },
        daemonSockPath: paths.socketPath,
        onAgentLaunch: (entry, launchEnv) => agentHooks.ensureForEntry(entry.id, launchEnv),
        // Chat tabs share `sessions.json`; the PTY manager stays its only writer.
        indexContributor
      }),
    agentChat.indexContributor()
  );
  agentChat.setPersist(() => ptySessions.persistIndexNow());

  // The delegate stop cascade: a chat stopped, interrupted or closed stops the chats it delegated
  // tasks to (`delegates.ts`). Its interrupts go through the daemon's own API (`attachApi` below);
  // a close is heard here, while the closing tab's record is still readable.
  const delegateStops = new DelegateStopCascade({ sessions: agentChat.chat, logger: console });

  // One session list over both backends, so every existing surface (tab strip,
  // Attention Center, palette, upload sweep, delete cascade, kill guard) treats
  // `agent-chat` as the agent kind without learning a second service (§7.1).
  const sessions: ChatAwareSessionManager = new ChatAwareSessionManager(
    ptySessions,
    agentChat.chat,
    {
      create: (req) =>
        agentChat.createSession(
          req as CreateAgentChatRequest,
          sessions.nextOrder(req.projectPath ?? "")
        ),
      onClose: (id) => {
        delegateStops.closing(id);
        agentChat.deleteThread(id);
      },
      onRename: (id, title, opts) => agentChat.renameThread(id, title, opts)
    }
  );
  // Thread lineage (spec 2026-10-14 §6): the merge-back queue survives a restart; its delivery
  // starts once the daemon's own API exists (`attachApi` below).
  // Whether the tab records loaded (set by the reattach below): until then a queued merge never
  // takes a missing tab for a deleted thread.
  let sessionsReattached = false;
  const lineage = new LineageService({
    sessions: agentChat.chat,
    outboxFile: agentChatMergeOutboxFile(paths.baseDir),
    logger: console,
    // Both tabs of a merge show it while the parent has not taken it (GUI and MCP).
    setPendingMerges: (sessionId, merges) => agentChat.chat.setPendingMerges(sessionId, merges),
    sessionsLoaded: () => sessionsReattached
  });
  await lineage.load();
  // boxes: git in a box project runs in its box (`accounts` is built above, with the box modules).
  const git = new GitService({ route: boxes.gitRoute });
  const todos = new TodoListManager(resolved.todosIndexFile, console);
  await todos.load();
  const recentProjects = new RecentProjectsService(
    resolved.recentProjectsFile,
    resolved.workspacesDir,
    console,
    // Same tolerant side-table read the workspace/project listings use, so a
    // recents row is behind the archive curtain exactly when the sidebar's is.
    () => readWorkspacesMeta(resolved.workspacesMetaFile)
  );
  await recentProjects.load();
  // The saved-prompt library (the right rail). A first run seeds the starter
  // prompts; a file it cannot read is moved aside, never written over.
  const savedPrompts = new SavedPromptsService({
    file: resolved.savedPromptsFile,
    git,
    // Getters: PUT /api/config/daemon reassigns both in place, and the routes
    // read them per request — a startup copy would 400 every project prompt.
    workspacesDir: () => resolved.workspacesDir,
    fsRoot: () => resolved.fsRoot,
    logger: console
  });
  await savedPrompts.load();
  // Repo identities (a label and icon per git repo, spec 2026-10-18 §2). A file it cannot read
  // is moved aside, never written over; unreferenced icon files are swept.
  const repoIdentities = new RepoIdentitiesService({
    file: repoIdentitiesPath(paths.baseDir),
    iconsDir: repoIconsDir(paths.baseDir),
    logger: console
  });
  await repoIdentities.load();
  // GitHub link previews for the chat's link pills: read with the git account bound to the
  // project's workspace when it has a GitHub token (else another stored GitHub account, else
  // anonymously). In memory only; the token never leaves the service.
  const githubLinks = new GitHubLinkPreviewService({
    resolveCredential: async ({ owner, projectPath }) => {
      const described = projectPath ? describeProjectPath(resolved.workspacesDir, projectPath) : null;
      const preferredAccountId = described
        ? (await readWorkspacesMeta(resolved.workspacesMetaFile)).workspaces.find((w) => w.name === described.workspace)
            ?.gitAccountId
        : undefined;
      return accounts.githubReadCredential({ owner, preferredAccountId: preferredAccountId ?? null });
    },
    logger: console
  });
  // Built-in plugins: built above (with the box modules), started here.
  await plugins.start();
  // boxes: the box records load (a reattached box terminal finds its box) and the plugin switch is followed.
  await boxes.start().catch((error) => console.error("Box service start failed", error instanceof Error ? error.message : error));
  // Secret files (the "Secret files" plugin, spec 2026-10-19): one vault per repo per workspace,
  // synced to every clone while the plugin is on. A store it cannot load leaves it read-only (503).
  const secretVaults = new SecretVaultStore({ dir: secretFilesDir(paths.baseDir), logger: console });
  await secretVaults.load().catch((error) => console.error("Secret files store load failed", error instanceof Error ? error.name : error));
  const secretFiles = new SecretFilesService({
    store: secretVaults,
    // Every workspace's projects, read per call (PUT /api/config/daemon may move the root). A project
    // of an archived workspace is hidden from the sidebar, so it counts as archived.
    listProjects: async () => {
      const workspaces = await listWorkspaces(resolved.workspacesDir, resolved.workspacesMetaFile);
      const lists = await Promise.all(
        workspaces.map(async (workspace) =>
          (await listProjects(resolved.workspacesDir, workspace.name, resolved.workspacesMetaFile)).map((project) => ({
            ...project,
            isArchived: project.isArchived === true || workspace.isArchived === true
          }))
        )
      );
      return lists.flat();
    },
    pluginEnabled: async () => (await plugins.get(SECRET_FILES_PLUGIN_ID)).enabled,
    onPluginChange: (listener) => {
      const onChanged = (response: PluginsResponse) =>
        listener(response.plugins.some((plugin) => plugin.id === SECRET_FILES_PLUGIN_ID && plugin.enabled));
      plugins.events.on("changed", onChanged);
      return () => void plugins.events.off("changed", onChanged);
    },
    publish: (payload) => broadcaster.publish(SECRET_FILES_CHANNEL, SECRET_FILES_CHANGED, payload),
    // Every clone write checks the clone root's realpath stays inside the (current) workspaces root.
    workspacesRoot: () => resolved.workspacesDir,
    logger: console,
    // boxes: a clone in a box project is read, written and watched in its box (spec §8.7).
    // `services` is read per call: the service starts only after it exists.
    ...boxAwareSecretFileIo(() => services.boxRegistry)
  });
  // Automated workflows (workflows spec §3, §5.7, §5.8): definitions, secrets, runs and runtime
  // state. Each store is tolerant at load — a file it cannot parse is moved aside, one it cannot
  // read leaves that store read-only (503 WORKFLOWS_UNAVAILABLE) — so none of them blocks boot.
  // The ENGINE is attached later (attachWorkflowEngine, after agentChat.init()); until then the
  // routes serve definitions, secrets and run history from these stores alone.
  const workflowSecrets = new WorkflowSecretsService({ file: resolved.workflowSecretsFile, logger: console });
  await workflowSecrets.load();
  // The agent catalogue validation checks chains against lives in the workflow daemon (built
  // below, fed the daemon's own client at start): late-bound, nothing is checked before it.
  let workflowValidationCatalog: ValidationCatalog | null = null;
  // The Agent Profiles that exist (an agent block naming a missing one warns): late-bound too,
  // nothing is checked until the profiles have been listed (below).
  let workflowProfileIds: (() => string[] | undefined) | null = null;
  const workflows = new WorkflowService({
    file: resolved.workflowsFile,
    logger: console,
    secretNames: (workflowId) => workflowSecrets.names(workflowId),
    savedPromptIds: () => savedPrompts.allIds(),
    sessionProfileIds: () => workflowProfileIds?.(),
    agentCatalog: () => workflowValidationCatalog?.current()
  });
  await workflows.load();
  const workflowRuns = new FileRunStore({ dir: resolved.workflowRunsDir, logger: console });
  await workflowRuns.init();
  const workflowState = new WorkflowStateStore({ path: resolved.workflowStateFile, logger: console });
  await workflowState.load();
  // Push a project's git status to whoever is looking at it. The watcher polls
  // ONLY projects with a live `/events?project=…` subscriber and only emits on a
  // real change, so an unwatched (or idle) repo costs nothing.
  const gitWatcher = new GitWatcher(git, (path, status) =>
    broadcaster.publish("projects", "project.git.changed", { path, status } satisfies GitStatusChangedPayload)
  );
  // Stream registry changes (install/update status, detected versions) to clients.
  // The same event is the ONLY place the daemon learns that an install/update
  // finished or that an agent's version moved, so it is also where the agent
  // host is told to re-probe that provider — otherwise a CLI updated from
  // Settings → Agents leaves the host serving the catalog it probed under the
  // old binary (chat design spec §3.2; fire-and-forget, debounced per adapter).
  registry.events.on("changed", (entry: RegistryEntry) => {
    broadcaster.publish("registry", "registry.changed", entry);
    agentChat.onRegistryEntryChanged(entry);
  });
  agentAccounts.events.on("changed", (payload) => broadcaster.publish("agent-accounts", "agent-accounts.changed", payload));
  // Each Claude source's last reading and endpoint timing, persisted: a restart shows the last
  // numbers at once and never re-asks the rate-limited usage endpoint inside its window.
  const usageState = new UsageStateFile(usageStateFile(paths.baseDir));
  await usageState.load();
  const claudeAccountSource = (home?: string) =>
    createClaudeSource({
      userhome: resolved.vars.userhome,
      now: () => Date.now(),
      claudeHome: home,
      logger: console,
      state: { store: usageState, key: `claude:${home ?? ""}` }
    });
  const codexAccountSource = (home?: string) =>
    createCodexSource({ userhome: resolved.vars.userhome, now: () => Date.now(), codexHome: home, logger: console });
  const grokCliHome = process.env.GROK_HOME || join(resolved.vars.userhome, ".grok");
  // Grok System = the CLI login only. Managed homes are polled per-account below
  // (authFile), so they are NOT on the System chain.
  const grokAccountSource = (home?: string) =>
    createGrokSource({
      grokHome: grokCliHome,
      authFile: home ? join(home, "auth.json") : undefined,
      now: () => Date.now(),
      logger: console
    });
  // Each usage source keeps its rate-limit backoff (429/Retry-After) and last-good
  // reading in closure state, so it MUST outlive a single recompute — the fs
  // watcher can fire recompute() every 500ms. Build each source once (keyed by
  // agent + resolved home; "" = the System account) and reuse it, so a fresh
  // closure with backoffUntil=0 isn't created on every recompute (which would
  // hammer the usage endpoints and drop the last-known values).
  const usageSources = new Map<string, () => Promise<AgentUsage | null>>();
  const usageSource = (
    agent: "claude" | "codex" | "grok",
    make: (home?: string) => () => Promise<AgentUsage | null>,
    home?: string
  ): (() => Promise<AgentUsage | null>) => {
    const key = `${agent}:${home ?? ""}`;
    let source = usageSources.get(key);
    if (!source) {
      source = make(home);
      usageSources.set(key, source);
    }
    return source;
  };

  async function agentWithAccounts(
    agent: "claude" | "codex" | "grok",
    makeSource: (home?: string) => () => Promise<AgentUsage | null>
  ): Promise<AgentUsage | null> {
    const managed = agentAccounts.list().accounts.filter((a) => a.agent === agent);
    // With managed accounts present, drop the System row when its credentials
    // are expired (nothing refreshes them → a permanent "—") or it is the same
    // login as a managed account (a duplicate row). Skipping the fetch also
    // avoids double-polling one account's usage endpoint.
    const hideSystem =
      managed.length > 0 &&
      (await shouldHideSystemUsage(agent, {
        userhome: resolved.vars.userhome,
        now: Date.now(),
        grokHome: agent === "grok" ? grokCliHome : undefined,
        managedHomes: managed.map((a) => agentAccounts.homePath(agent, a.id))
      }).catch(() => false));
    const base = hideSystem ? null : await usageSource(agent, makeSource)(); // System account
    // No managed accounts → the System reading is the whole story (Grok already
    // attaches a labeled account row from the credential email when known).
    if (managed.length === 0) return base;
    // Otherwise always surface every managed account so the panel can show them all.
    const accounts: UsageAccount[] = [];
    // boxes: only host-local sessions refresh their account (spec 2026-10-19 boxes §7).
    const live = sessions.hostLocalAccountIds();
    for (const acct of managed) {
      // Keep an idle account's token warm so its usage never renders stale.
      await agentAccounts.ensureFreshForUsage(agent, acct.id, live).catch(() => undefined);
      const u = await usageSource(agent, makeSource, agentAccounts.homePath(agent, acct.id))().catch(() => null);
      const currentAccount = agentAccounts.list().accounts.find((a) => a.id === acct.id) ?? acct;
      accounts.push({
        id: acct.id,
        label: acct.label,
        available: u?.available ?? false,
        stale: u?.stale ?? true,
        plan: u?.plan,
        session: u?.session ?? null,
        weekly: u?.weekly ?? null,
        ...(u?.scopedWindows ? { scopedWindows: u.scopedWindows } : {}),
        ...(u?.lastKnown ? { lastKnown: u.lastKnown } : {}),
        loginExpiresAt: currentAccount.loginExpiresAt ?? u?.loginExpiresAt,
        needsReauth: currentAccount.needsReauth || u?.needsReauth === true,
        asOf: u?.asOf
      });
    }
    // Strip any single-cred accounts[] the Grok source may have attached — the
    // aggregate rebuilds the labeled list from managed accounts (+ System).
    const baseHead = base ? { ...base, accounts: undefined } : null;
    return aggregateWorstAccountUsage(agent, baseHead, accounts, Date.now());
  }

  const usage = new UsageService({
    fetchClaude: () => agentWithAccounts("claude", claudeAccountSource),
    readCodex: () => agentWithAccounts("codex", codexAccountSource),
    readGrok: () => agentWithAccounts("grok", grokAccountSource),
    getPrefs: () => readUsagePrefs(resolved.appConfigFile)
  });
  usage.events.on("changed", (u) => broadcaster.publish("usage", "usage.changed", u));
  // Live usage: every Claude chat thread reports its account's windows off its own model
  // responses (`rate_limit_event.unifiedWindows`); the host hands the latest on in the thread's
  // summary. It goes to that account's source — numbers that move with every response, at no
  // cost to the usage endpoint's budget, which is then asked only for idle accounts.
  let liveRecompute: ReturnType<typeof setTimeout> | undefined;
  agentChat.setUsageLimitsListener(({ refId, limits }) => {
    if (registry.get(refId)?.chat?.adapter !== "claude") return;
    let home: string | undefined;
    if (limits.home === "account") {
      const managed = agentAccounts.list().accounts.some((a) => a.agent === "claude" && a.id === limits.accountId);
      if (!managed) return;
      home = agentAccounts.homePath("claude", limits.accountId);
    }
    const live = claudeLiveUsageFromWindows(limits.windows, limits.observedAt);
    if (!live) return;
    const source = usageSource("claude", claudeAccountSource, home) as ClaudeUsageSource;
    if (!source.ingestLive(live) || liveRecompute) return;
    liveRecompute = setTimeout(() => {
      liveRecompute = undefined;
      void usage.recompute();
    }, 1_000);
    liveRecompute.unref?.();
  });
  // NOT started here: the first recompute needs the managed-accounts index
  // (loaded by agentAccounts.init() below). Started before it, the boot reading
  // saw zero managed accounts, fell back to the System login — expired on a host
  // that only uses managed accounts — and cached "Claude: not logged in" for a
  // full 5-minute tick after every daemon restart.
  await usageTokens.init();
  await subagentCacheTtl.init();
  {
    const { watch } = await import("node:fs");
    // With dozens of live agent sessions the watchers fire continuously; keep
    // the debounce coarse and route the transcript scan through the scanner's
    // rate-limited entry point (leading + trailing run per 30 s window). An
    // unthrottled 500 ms nudge re-parsed every active transcript nonstop and
    // pegged the daemon's event loop (multi-second terminal latency).
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const nudge = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        void usage.recompute();
        usageTokens.requestRecompute();
      }, 5_000);
      debounce.unref?.();
    };
    // Watch only the transcript roots (claude writes debug/statsig/todo files
    // all over its config dir — those must not trigger scans).
    const claudeConfig = process.env.CLAUDE_CONFIG_DIR || join(resolved.vars.userhome, ".claude");
    // Fall back to the config dir while projects/ doesn't exist yet (first
    // run): fs.watch can't attach to a missing dir, and transcripts would
    // otherwise go unwatched until a restart. The nudge is rate-limited, so
    // the noisier fallback watch is still cheap.
    const claudeProjects = join(claudeConfig, "projects");
    for (const dir of [
      join(process.env.CODEX_HOME || join(resolved.vars.userhome, ".codex"), "sessions"),
      existsSync(claudeProjects) ? claudeProjects : claudeConfig
    ]) {
      try {
        const watcher = watch(dir, { recursive: true }, nudge);
        watcher.on("error", (error) => {
          console.warn(`Usage watcher disabled for ${dir}:`, error);
          watcher.close();
        });
      } catch {
        /* dir may not exist yet; the poll still covers it */
      }
    }
  }
  await registry.init();
  // Reattach to any tmux sessions that outlived a previous daemon process
  // (KillMode=process keeps the tmux server alive across restarts). No-op on the
  // local backend. Best-effort: a tmux/socket error must not block startup.
  await sessions
    .reattach()
    .then(() => {
      sessionsReattached = true;
    })
    .catch((error) => console.error("Session reattach failed", error));
  // The removed model proxy's one-time handover: stop it and hand the accounts
  // it refreshed back to the refresher started below, fresher tokens first.
  await retireModelProxy({
    daemonDir: resolved.daemonDir,
    killServiceSession: tmuxAvailable() && tmuxVersionOk() ? (name) => tmux.killServiceSession(name) : undefined,
    managedCredentialPath: (agent, id) => join(agentAccounts.homePath(agent, id), MANAGED_CRED_FILENAME[agent])
  }).catch((error) => console.error("Model proxy retirement failed", error));
  await agentAccounts.init();
  // After reattach, so a tab still running under a deleted account keeps its
  // home until it is closed. Best-effort: a sweep error must not block startup.
  await agentAccounts
    .pruneOrphanHomes(sessions.liveAccountIds())
    .then((removed) => {
      for (const dir of removed) console.warn(`Removed orphan account home ${dir}`);
    })
    .catch((error) => console.error("Orphan account home sweep failed", error));
  // boxes: box sessions never refresh, so they never stop the daemon refresher (spec 2026-10-19 boxes §7).
  agentAccounts.startRefresher(() => sessions.hostLocalAccountIds());
  // First usage reading only now: managed accounts are loaded and reattached
  // sessions are known (its token-freshness pass consults liveAccountIds()).
  usage.start();
  // Sweep terminal-upload dirs for sessions that didn't survive (orphans from a
  // crash): keep only dirs whose id matches a now-live session. Best-effort.
  await sweepOrphanUploads(
    resolved.daemonDir,
    new Set(sessions.list().map((s) => s.id))
  ).catch(() => undefined);
  sessions.lifecycle.on("created", (s: SessionSummary) =>
    broadcaster.publish("sessions", "session.created", s)
  );
  // When a session goes away — whether it exited on its own ("exited", carries a
  // SessionSummary) or was closed/cascaded ("closed", carries just { id }) —
  // broadcast the event AND drop its uploaded files (best-effort;
  // removeSessionUploads swallows errors).
  sessions.lifecycle.on("exited", (s: SessionSummary) => {
    broadcaster.publish("sessions", "session.exited", s);
    void removeSessionUploads(resolved.daemonDir, s.id);
  });
  sessions.lifecycle.on("closed", (payload: { id: string }) => {
    // `{id}` only, as the wire's `session.closed` names it: the chat manager's internal
    // `rolledBack` (a fork's own rollback) is the daemon's business, not a client's.
    broadcaster.publish("sessions", "session.closed", { id: payload.id });
    void removeSessionUploads(resolved.daemonDir, payload.id);
  });
  sessions.lifecycle.on("updated", (s: SessionSummary) =>
    broadcaster.publish("sessions", "session.updated", s)
  );
  // Activity transitions → event bus (all clients render the same dot) AND push.
  // Push policy: structural hook attentions push per-type; bells push only for
  // agent sessions that have never delivered a hook event (no double-notify).
  sessions.lifecycle.on(
    "activity",
    (event: {
      id: string;
      activity: SessionActivity;
      cause: ActivityCause;
      hasHookSource: boolean;
      kind: RegistryKind;
    }) => {
      broadcaster.publish("sessions", "session.activity", {
        id: event.id,
        activity: event.activity
      } satisfies SessionActivityEvent);
      // Chat spec §6.4 widens this gate from "agent" to include "agent-chat".
      // A chat tab produces no bells and no managed-hook events, so in practice
      // its pushes come from the protocol path in `agent-chat/summary.ts`; the
      // gate is widened anyway so a future chat-side `activity` emission is not
      // silently swallowed here.
      if (event.kind !== "agent" && event.kind !== "agent-chat") {
        return;
      }
      const summary = sessions.get(event.id);
      if (!summary) {
        return;
      }
      if (event.cause === "hook" && event.activity.attention === "needs-input") {
        void push.notifyStructural(summary, "needs-input");
      } else if (event.cause === "hook" && event.activity.attention === "finished") {
        void push.notifyStructural(summary, "finished");
      } else if (event.cause === "bell" && !event.hasHookSource) {
        void push.notifyAttention(summary);
      }
    }
  );

  // To-do list lifecycle → event bus (channel "todos"). Each payload is a full
  // TodoListRecord; clients reconcile their cache/tabs by id (§6).
  todos.lifecycle.on("created", (r) => broadcaster.publish("todos", "todo.created", r));
  todos.lifecycle.on("updated", (r) => broadcaster.publish("todos", "todo.updated", r));
  todos.lifecycle.on("deleted", (r) => broadcaster.publish("todos", "todo.deleted", r));

  // Recent projects → event bus (channel "projects"). The payload is the whole
  // list (short, capped at 30) so a client just replaces its copy.
  recentProjects.lifecycle.on("changed", (list) =>
    broadcaster.publish("projects", "recentProjects.changed", list)
  );

  // Saved prompts → event bus (channel "saved-prompts"): every change, cascades
  // included, as `savedPrompt.upserted` (the whole prompt) / `savedPrompt.deleted`.
  publishSavedPromptEvents(savedPrompts, broadcaster);
  // Repo identities → event bus (channel "repo-identities"), `repoIdentity.changed`.
  publishRepoIdentityEvents(repoIdentities, broadcaster);

  // ---- Agent profile (agent profile spec §4.2) ------------------------------------------------
  // Settings → Agent config: the manager of each agent CLI's own global config. Built here, after
  // `registry.init()` (an adapter takes its CLI's resolved bin) and `agentAccounts.init()` (Codex
  // writes hook trust for every managed home). Its watchers are armed once the transports serve
  // (`agentProfile.start()` below) and closed in `stop()`; changes go out on "agent-profile".
  const agentProfileHomes = resolveAgentHomes(env, resolved.vars.userhome);
  // Git and upload imports (spec §6); `existing` marks the candidates the agent already has.
  const agentProfileImports: ProfileImportStore = new ProfileImportStore({
    dir: agentProfileImportsDir(paths.baseDir),
    existing: async (agent): Promise<Set<string>> => {
      // An Agent Profile scan (`portable`) marks `exists` against the profile itself.
      if (agent === "portable") return new Set();
      const snapshot = await agentProfile.snapshot(agent);
      return new Set(snapshot.items.map((item) => `${item.kind}:${item.name}`));
    },
    logger: { info: (message) => console.log(message), warn: (message) => console.warn(message) }
  });
  const agentProfile: AgentProfileService = new AgentProfileService({
    adapters: createAgentProfileAdapters({
      homes: agentProfileHomes,
      appdir: paths.baseDir,
      bin: (agent) => registry.get(agent)?.resolvedBin ?? null,
      // OpenCode has no managed accounts; the other three list their family's homes.
      accountHomes: async (agent) =>
        agent === "opencode"
          ? []
          : agentAccounts
              .list()
              .accounts.filter((account) => account.agent === agent)
              .map((account) => agentAccounts.homePath(agent, account.id)),
      logger: console,
      now: () => new Date()
    }),
    // Read per call: an install or update from Settings > Agents patches the entry in place.
    agentInfo: (agent) => {
      const entry = registry.get(agent);
      const installed = Boolean(entry?.enabled && entry.resolvedBin);
      return installed && entry?.version ? { installed, version: entry.version } : { installed };
    },
    homes: agentProfileHomes,
    converter: createProfileConverter({ tempRoot: agentProfileImportsDir(paths.baseDir) }),
    imports: agentProfileImports,
    // `opencode serve` caches its global config for its whole life: after an OpenCode write the
    // host recycles its idle servers so the next turn reads the new config (spec §4.8).
    afterWrite: (agent) => (agent === "opencode" ? agentChat.recycleIdleOpenCodeServers() : undefined),
    logger: console
  });
  publishAgentProfileEvents(agentProfile, broadcaster);
  // ---- end agent profile ----------------------------------------------------------------------

  // ---- Agent Profiles (spec 2026-10-18) ------------------------------------------------------
  // Orquester-owned per-session profiles under `<appdir>/daemon/session-profiles/`; changes go out
  // on "session-profiles". The preparation lifecycle builds each profile's prepared dirs (per agent,
  // per account for Codex) in the background and answers launches through `ensureReady`; it
  // re-prepares on profile changes and on Global config changes seen by Agent config's watcher.
  const sessionProfileStore = new SessionProfileStore({ appdir: paths.baseDir });
  const sessionProfileLifecycle = new SessionProfileLifecycle({
    appdir: paths.baseDir,
    store: sessionProfileStore,
    systemHomes: agentProfileHomes,
    accountHome: (agent, accountId) =>
      agentAccounts.getRecord(accountId)?.agent === agent ? agentAccounts.homePath(agent, accountId) : null,
    defaultAccountId: (agent) => (agent === "opencode" ? null : (agentAccounts.list().defaults[agent] ?? null)),
    // Read per call: an install or update from Settings > Agents patches the entry in place.
    cliVersion: (agent) => registry.get(agent)?.version ?? null,
    // Preparers that run the CLI (Codex seeds its profile home's state DB).
    cliBin: (agent) => registry.get(agent)?.resolvedBin ?? null,
    // The prepared versions the agent host's live sessions (and starts in flight) launched from
    // (`GET /profiles/leases`): the GC never removes one. It rejects when the host cannot say
    // (down, restarting, an older host), and that GC pass then removes nothing.
    // `start()` below runs before the host is adopted: its pass removes nothing, so the lifecycle
    // collects again whenever a host becomes healthy (and on its own slow periodic pass).
    leases: {
      inUse: () => agentChat.profileLeases(),
      // Before the host is adopted the boot pass skips quietly instead of warning "not running".
      available: () => agentChat.isHostHealthy(),
      onAvailable: (listener) => agentChat.onHostHealthy(listener)
    },
    logger: console
  });
  // Filling profiles (spec §4.5): Import from Global through Agent config (copies; Global is never
  // written), git / zip / md scans through Agent config's import store, copies between profiles,
  // marketplace plugins into each profile's own plugin cache, export and import of a profile.
  const sessionProfileImports = new SessionProfileImports({
    store: sessionProfileStore,
    global: agentProfile,
    scanner: agentProfileImports,
    workDir: agentProfileImportsDir(paths.baseDir)
  });
  const sessionProfiles = new SessionProfileService({
    store: sessionProfileStore,
    prepareStatus: sessionProfileLifecycle.prepareStatusSource,
    imports: sessionProfileImports
  });
  await sessionProfiles.init().catch((error) => console.error("Agent Profiles: preparing the store failed", error));
  publishSessionProfileEvents(sessionProfiles, broadcaster);
  publishSessionProfilePrepareEvents(sessionProfileLifecycle, broadcaster);
  sessionProfileLifecycle.attach(sessionProfiles.events);
  agentProfile.lifecycle.on("filesChanged", ({ agent }: { agent: AgentProfileAgentId }) => sessionProfileLifecycle.globalConfigChanged(agent));
  // Staging cleanup and the scan of prepared dirs; stale ones re-prepare in the background.
  await sessionProfileLifecycle.start().catch((error) => console.error("Agent Profiles: starting preparation failed", error));
  // Chat launches with a profile (create, fork, its reconcile, account and profile switches, and
  // the host's refresh before every session start): the current prepared version through
  // `ensureReady`, its manifest section, and the agent's launch contribution over the account's
  // launch (`session-profiles/launch.ts`). A deleted profile's fallback notice names it from the
  // store's `deleted.json` (durable across restarts); the live ids feed workflow validation.
  const sessionProfileNames = new SessionProfileNames();
  void sessionProfileNames.track(sessionProfiles);
  workflowProfileIds = () => sessionProfileNames.liveIds();
  agentChat.setSessionProfiles({
    resolve: createProfileLaunchResolver({
      lifecycle: sessionProfileLifecycle,
      accountHome: (agent, accountId) =>
        accountId === null
          ? { claude: agentProfileHomes.claudeDir, codex: agentProfileHomes.codexHome, grok: agentProfileHomes.grokHome, opencode: agentProfileHomes.opencodeDir }[agent]
          : agentAccounts.getRecord(accountId)?.agent === agent
            ? agentAccounts.homePath(agent, accountId)
            : null
    }),
    profileName: (profileId) => sessionProfiles.deletedName(profileId),
    catalog: (profileId, agent) => sessionProfiles.composerCatalog(profileId, agent)
  });

  // Workflows → event bus (channel "workflows"): `workflow.upserted` (the rail summary — the
  // engine's, with live trigger state, once attached), `workflow.deleted`, `workflowSecrets.changed`
  // (no names, no values). Run events are published by the engine itself.
  //
  // The workflow runtime (workflows/daemon-wiring.ts): the engine with every block executor, the
  // agent block and its account preview, the scheduler and the git poller, and the ONE summary
  // builder. Built here, started after `agentChat.init()` (below, once the unix app exists).
  // Usage is read synchronously by account selection: the service's latest reading, kept current.
  let workflowUsage: UsageResponse = { agents: [] };
  let workflowUsageSeen = false;
  usage.events.on("changed", (reading: UsageResponse) => {
    workflowUsageSeen = true;
    workflowUsage = reading;
  });
  // The service started above: take what it already holds (no recompute), unless a change beat us.
  const cachedUsage = await usage.snapshot();
  if (!workflowUsageSeen) workflowUsage = cachedUsage;
  const workflowTmp = join(paths.baseDir, "tmp");
  await mkdir(workflowTmp, { recursive: true }).catch(() => undefined);
  const workflowDaemon = createWorkflowDaemon({
    service: workflows,
    secrets: workflowSecrets,
    runStore: workflowRuns,
    state: workflowState,
    broadcaster,
    usage: { snapshot: () => workflowUsage },
    accounts: {
      list: () => agentAccounts.list()
    },
    git,
    gitRemote: accounts,
    readWorkspaceMeta: async (workspace) =>
      (await readWorkspacesMeta(resolved.workspacesMetaFile)).workspaces.find((w) => w.name === workspace) ?? null,
    savedPrompts,
    // Getters: PUT /api/config/daemon reassigns both in place.
    workspacesDir: () => resolved.workspacesDir,
    fsRoot: () => resolved.fsRoot,
    appdirTmp: workflowTmp,
    push,
    logger: consoleWorkflowLogger,
    // boxes: a box project's shell and code blocks run in its box.
    boxSandbox: boxes.workflowSandbox
  });
  workflowValidationCatalog = workflowDaemon.validationCatalog;
  // Usage-limit recovery for interactive chats (`agent-chat/limit-recovery.ts`): the host's
  // per-thread limit notice (the summary poll) → the chat's recovery state, the resume at the
  // reset and the opt-in account failover. It shares the workflows' cooldown store (one
  // `workflow-state.json`), usage reading and accounts, so chats and workflows agree on which
  // accounts are spent. The tab records are loaded (reattach above): `start` rebuilds every
  // persisted schedule; its sends wait for the daemon's own API (`attachApi` below).
  const limitRecovery = new ChatLimitRecovery({
    chat: agentChat.chat,
    cooldowns: createCooldownStore(workflowState, realClock),
    usage: { snapshot: () => workflowUsage },
    accounts: { list: () => agentAccounts.list() },
    prefs: async () => {
      const agents = (await readAppConfigFile(resolved.appConfigFile)).agents;
      return { autoResume: agents.autoResumeLimitedChats, switchAccount: agents.switchAccountOnUsageLimit };
    },
    adapterOf: (refId) => registry.get(refId)?.chat?.adapter ?? null,
    clock: realClock,
    logger: console
  });
  agentChat.setUsageLimitNoticeListener((threadId, notice) => limitRecovery.onNotice(threadId, notice));
  limitRecovery.start();
  // Idle Claude compaction (`agent-chat/idle-compaction.ts`): each open chat's prompt-cache
  // candidate (the summary poll) → a `/compact` two minutes before the cache expires, when the
  // setting says so. Nothing persisted: the first poll after a restart re-arms from the logs.
  const idleCompaction = new ChatIdleCompaction({
    chat: agentChat.chat,
    prefs: async () => (await readAppConfigFile(resolved.appConfigFile)).agents,
    adapterOf: (refId) => registry.get(refId)?.chat?.adapter ?? null,
    clock: realClock,
    logger: console
  });
  agentChat.setIdleCompactionListener((threadId, candidate) => idleCompaction.onCandidate(threadId, candidate));
  idleCompaction.start();
  publishWorkflowEvents({
    service: workflows,
    secrets: workflowSecrets,
    // The runtime's view of the bus: its trigger-state watcher notes every row that goes out.
    broadcaster: workflowDaemon.events,
    // The builder itself — never `summarizeWorkflow`, which delegates to the engine, which calls
    // this builder (the recursion the engine refuses).
    summarize: (workflow) => workflowDaemon.summarize(workflow)
  });

  // Server-side browser tabs (Design Mode), on `resolveChromium` (above).
  const browsers = new BrowserManager({
    indexFile: resolved.browsersIndexFile,
    profilesDir: resolved.browserProfilesDir,
    resolveChromium
  });
  await browsers.load();
  browsers.lifecycle.on("created", (b) => broadcaster.publish("browser", "browser.created", b));
  browsers.lifecycle.on("updated", (b) => broadcaster.publish("browser", "browser.updated", b));
  browsers.lifecycle.on("closed", (p) => broadcaster.publish("browser", "browser.closed", p));

  // Desktop tabs (desktop spec §5): virtual X displays in tmux service sessions
  // on the sessions' tmux server, so they outlive the daemon like terminals do.
  // Reattached after `sessions.reattach()` (above); best-effort like it.
  const desktopHost = new DesktopHostProbe();
  const desktopAudio = new DesktopAudioHub({
    ffmpegPath: resolveTool("ffmpeg"),
    log: (message, error) => console.warn(message, error ?? "")
  });
  const desktops = new DesktopManager({
    baseDir: paths.baseDir,
    indexFile: resolved.desktopsIndexFile,
    tmux,
    hostStatus: () => desktopHost.status(),
    audio: desktopAudio,
    // boxes: desktops of Linux box projects run in their VM.
    boxes: boxes.desktops
  });
  await desktops.load();
  desktops.on("created", (d) => broadcaster.publish(DESKTOP_CHANNEL, "desktop.created", d));
  desktops.on("updated", (d) => broadcaster.publish(DESKTOP_CHANNEL, "desktop.updated", d));
  desktops.on("closed", (p) => broadcaster.publish(DESKTOP_CHANNEL, "desktop.closed", p));
  desktops.on("windows", (p) => broadcaster.publish(DESKTOP_CHANNEL, "desktop.windows", p));
  await desktops.reattach().catch((error) => console.error("Desktop reattach failed", error));

  // Dev-server URL suggestions: fed from every session's PTY output.
  const urlWatcher = new UrlWatcher();
  sessions.lifecycle.on("output", ({ id, data }: { id: string; data: string }) => {
    const summary = sessions.get(id);
    if (summary?.projectPath) urlWatcher.ingest(summary.projectPath, data);
  });

  // The Grok and Codex accounts' device-code links and the Claude account's
  // sign-in link (Settings → Accounts): a granted link becomes a managed account.
  const grokDeviceLink = new DeviceLinkService({
    name: "Grok",
    auth: httpGrokDeviceAuth,
    credential: (tokens) => grokAuthJsonFromDeviceTokens(tokens),
    importAccount: (content) => agentAccounts.importAccount({ content })
  });
  grokDeviceLink.events.on("changed", (status) => broadcaster.publish("agent-accounts", "grok-link.changed", status));
  const codexDeviceLink = new DeviceLinkService({
    name: "Codex",
    auth: httpCodexDeviceAuth,
    credential: (tokens) => codexAuthJsonFromDeviceTokens(tokens),
    importAccount: (content) => agentAccounts.importAccount({ content })
  });
  codexDeviceLink.events.on("changed", (status) => broadcaster.publish("agent-accounts", "codex-link.changed", status));
  const claudeOAuthLink = new ClaudeOAuthLinkService({
    importAccount: (content, identity) => agentAccounts.importAccount({ content }, identity)
  });
  claudeOAuthLink.events.on("changed", (status) => broadcaster.publish("agent-accounts", "claude-link.changed", status));
  // `request_secret` cards (design 2026-10-14 §5): in memory only, values
  // handed straight to the waiting session-tool call.
  const secretRequests = new SecretRequestRegistry({
    publish: (payload) => broadcaster.publish("sessions", SECRET_REQUEST_EVENT_TYPE, payload),
    // A pending card is a pending question for the tab, the Attention Center and push.
    onChange: (threadId) => agentChat.secretRequestsChanged(threadId)
  });
  agentChat.setSecretRequests(secretRequests);
  // Knowledge Graph plugin (spec 2026-10-23): one server-wide knowledge base for agent chats. Built
  // here (it follows the plugin record, the chats' tabs and the Agent Profiles), started below once
  // the daemon's in-process API exists; while the plugin is off nothing of it is read, indexed or loaded.
  const knowledge = new KnowledgeService({
    appdir: paths.baseDir,
    plugins,
    accounts: agentAccounts,
    // The tab is the record of a chat's profile: a chat whose profile was deleted reads `null`
    // (Global) once its next start fell back; its owner says whether it is an indexing session.
    session: (sessionId) => {
      const tab = agentChat.chat.get(sessionId);
      return tab ? { profileId: tab.profileId ?? null, ...(tab.owner ? { owner: tab.owner } : {}) } : null;
    },
    profiles: sessionProfileStore,
    onProfileChange: (listener) => {
      const onChange = ({ profileId }: { profileId: string }) => listener(profileId);
      sessionProfiles.events.on("changed", onChange);
      sessionProfiles.events.on("deleted", onChange);
      return () => {
        sessionProfiles.events.off("changed", onChange);
        sessionProfiles.events.off("deleted", onChange);
      };
    },
    publisher: broadcaster,
    // Linking (built when the knowledge base first opens, after `knowledge.start()` below): the myKG
    // run queue, answered by unattended Claude Code chats it starts through the daemon's own API with
    // the workflow Agent block's account selection, failover and shared cooldowns.
    linking: ({ store, graph, runtime, settings }) => {
      const api = services.internalApi;
      if (!api) throw new Error("the daemon's in-process API does not exist yet");
      const workers = createDaemonWorkerSessions({
        api,
        accounts: { list: () => agentAccounts.list() },
        usage: { snapshot: () => workflowUsage },
        cooldowns: createCooldownStore(workflowState, realClock),
        clock: realClock,
        settings: () => settings.get(),
        workDir: knowledgeWorkersDir(paths.baseDir),
        ensureProfile: () => ensureKnowledgeIndexerProfile(sessionProfiles),
        logger: console
      });
      return new KnowledgeLinkingService({ appdir: paths.baseDir, runtime, settings, store, graph, workers, clock: realClock, logger: console });
    },
    // `services` is read per call: the refresher is built below.
    toolsChanged: () => {
      void services.sessionToolsRefresher
        ?.refresh(null)
        .catch((error) => console.warn("session-tools: knowledge tools refresh failed", error instanceof Error ? error.message : String(error)));
    },
    logger: console
  });
  // The remote transport's sessions and API tokens. Bound to the password at boot: a hash changed
  // while the daemon was down (a hand edit, `deploy.sh rotate-password`) signs every device out.
  const authSessions = new AuthSessionStore({ file: authSessionsPath(paths.baseDir), logger: console });
  await authSessions.load();
  await authSessions.syncPassword(config.transports.http.passwordHash);
  // Device simulators (devices spec 2026-10-27): the device service exists while the plugin is on
  // (`devices/wiring.ts`); it follows the plugin from `devices.start()` below. Chats are read from
  // their tab records (loaded by the reattach above; a failed reattach releases nothing).
  const devices: DaemonDevices = createDaemonDevices({
    baseDir: paths.baseDir,
    env,
    plugins,
    broadcaster,
    boxes: () => boxes,
    threadTitle: (id) => agentChat.chat.get(id)?.title ?? null,
    threadProject: (id) => agentChat.chat.get(id)?.projectPath || null,
    threadExists: (id) => !sessionsReattached || agentChat.chat.has(id),
    logger: console
  });
  const services: Services = {
    buildInfo,
    authSessions,
    secretRequests,
    registry, sessions, grokDeviceLink, codexDeviceLink, claudeOAuthLink, accounts, git, gitWatcher, todos, recentProjects, savedPrompts, repoIdentities, githubLinks, usage, usageTokens, chatThreadUsage, subagentCacheTtl, push, broadcaster, agentAccounts, browsers, urlWatcher, agentChat,
    plugins,
    secretFiles,
    knowledge,
    desktops, desktopAudio,
    agentProfile,
    sessionProfiles,
    sessionProfileLifecycle,
    workflows, workflowSecrets, workflowRuns, workflowState, workflowEngine: null, internalApi: null,
    lineage,
    limitRecovery,
    idleCompaction,
    delegateStops,
    workflowProjects: workflowDaemon.runtime.projects,
    workflowCatalogReady: () => workflowDaemon.validationCatalog.ready(),
    // boxes: the box service, which paths are in box projects, and the rest of the box wiring.
    boxes: boxes.service,
    boxRegistry: boxes.registry,
    boxWiring: boxes,
    devices
  };
  // umcp:t3 begin
  // Orquester approval cards (memory only; a journal of open ids resolves a crash's leftovers as
  // cancelled) and `agent-tools.json` (the grants). A pending card is pending user input like a
  // secret card; a closed chat's cards and chat grants go.
  const agentToolsRuntime = createAgentToolsRuntime({
    baseDir: paths.baseDir,
    publish: (channel, type, payload) => broadcaster.publish(channel, type, payload),
    onApprovalsChanged: (threadId) => agentChat.secretRequestsChanged(threadId),
    tab: (id) => agentChat.chat.get(id),
    agentOf: (id) => agentChat.sessionToolThread(id)?.agentId ?? null,
    api: () => services.internalApi,
    projectExists: (path) => existsSync(path),
    logger: console
  });
  await agentToolsRuntime.load();
  agentChat.setSecretRequests({
    list: (threadId) => secretRequests.list(threadId),
    approvals: (threadId) => agentToolsRuntime.approvals.pendingTitles(threadId)
  });
  agentChat.chat.lifecycle.on("closed", ({ id, rolledBack }: { id: string; rolledBack?: boolean }) => {
    if (!rolledBack) agentToolsRuntime.threadClosed(id);
  });
  services.agentToolsRuntime = agentToolsRuntime;
  // The catalog executor (both transports) asks THIS port for cards and grants. Before this runs
  // no transport serves yet; after the disconnect at stop, cards are refused. Every chat tool is on
  // in every chat: there are no toolsets to resolve.
  const disconnectExecutor = connectExecutor(agentToolsRuntime, executorPorts);
  // umcp:t3 end
  // boxes: begin
  // Temporary boxes for agent chats (Ephemeral AI VMs spec §13): the box MCP tools' daemon side.
  // The box service attaches itself with `temporaryBoxTools.connect({ boxes, hub, registry })` once
  // its records are loaded; until then the box tools are not advertised and answer BOXES_DISABLED.
  // A closed chat's temporary boxes are destroyed (`chat-closed`, spec §13.3).
  const temporaryBoxTools = new TemporaryBoxTools({ isChatOpen: (id) => agentChat.chat.has(id), logger: console });
  agentChat.chat.lifecycle.on("closed", ({ id, rolledBack }: { id: string; rolledBack?: boolean }) => {
    if (!rolledBack) temporaryBoxTools.chatClosed(id);
  });
  services.temporaryBoxTools = temporaryBoxTools;
  // Devices: a closed chat's leases end (their devices are turned off).
  agentChat.chat.lifecycle.on("closed", ({ id, rolledBack }: { id: string; rolledBack?: boolean }) => {
    if (!rolledBack) devices.chatClosed(id);
  });
  await devices.start().catch((error) => console.error("Device service start failed", error instanceof Error ? error.message : error));
  // The rest of the box wiring over the session list, browser tabs and chats: the token broker,
  // git auth, the MCP bridge, dev-server forwards, agent chats in boxes, the Template command, and
  // the box tools (connected while the plugin is on).
  await boxes
    .attach({ sessions, browsers, agentChat, agentProfile, temporaryBoxTools })
    .catch((error) => console.error("Box wiring failed", error instanceof Error ? error.message : error));
  // boxes: end
  // umcp:t6 begin
  // The chat transport (unified MCP design 2026-10-15 §9.4, §12.1): per-thread manifests for the
  // agent host (every chat tool; no always-Admin one for a workflow-owned chat), pushed to it when a
  // refused launch's denials become known (applied in-session where the provider re-lists, else at
  // the chat's next idle point).
  const sessionToolsRefresher = new SessionToolsRefresher({
    thread: (id) => {
      const tab = agentChat.chat.get(id);
      const info = tab ? agentChat.sessionToolThread(id) : null;
      if (!tab || !info) return null;
      return {
        agentId: info.agentId,
        home: tab.accountId ? tab.accountId : "system",
        projectPath: tab.projectPath,
        canonicalProjectPath: tab.projectPath ? canonicalProjectPath(tab.projectPath) : "",
        // A chat started in a directory inside its project loads the configs down to it too.
        ...(tab.cwd ? { cwd: tab.cwd, canonicalCwd: canonicalProjectPath(tab.cwd) } : {})
      };
    },
    openThreads: () => agentChat.chat.list().map((tab) => tab.id),
    catalog: () => catalogFor("chat"),
    // boxes: the box tools are advertised only while a box can be rented.
    boxesAvailable: () => temporaryBoxTools.available(),
    // Devices: the device tools only while the plugin is on, agents may use devices and a platform is enabled.
    devicesAvailable: () => devices.toolsAvailable(),
    // Knowledge Graph: the plugin's view of each chat (on or off, worker or not, what it sees).
    knowledgeForSession: (threadId) => knowledge.knowledgeForSession(threadId),
    api: () => services.internalApi,
    pushToHost: async (id, manifest): Promise<SessionToolsRefreshResponse | null> => {
      const route = agentChat.routeDeps();
      if (!route.isHostHealthy()) return null;
      try {
        const response = await route.client.json<SessionToolsRefreshResponse>("POST", agentHostRoutes.sessionToolsRefresh(id), { manifest }, { timeoutMs: SESSION_TOOLS_REFRESH_TIMEOUT_MS });
        // 404: a host that predates the route — the change applies at the session's next start.
        return response.status === 200 && response.value ? response.value : null;
      } catch {
        return null;
      }
    },
    logger: console
  });
  agentChat.chat.lifecycle.on("closed", ({ id }: { id: string }) => sessionToolsRefresher.forget(id));
  // boxes: when boxes become rentable (or stop being), every open chat gets its new tool list.
  temporaryBoxTools.onAvailabilityChange(() => {
    void sessionToolsRefresher.refresh(null).catch((error) => console.warn("session-tools: box tools refresh failed", error instanceof Error ? error.message : String(error)));
  });
  // Devices: likewise when the device tools come or go.
  devices.onToolsChange(() => {
    void sessionToolsRefresher.refresh(null).catch((error) => console.warn("session-tools: device tools refresh failed", error instanceof Error ? error.message : String(error)));
  });
  // A changed MCP server config (agent profile) is read afresh by the next manifest.
  const agentProfileSink = {
    send: (data: string) => {
      // Cheap pre-filter (every bus event passes here), then the typed check on the parsed event.
      if (!data.includes(AGENT_PROFILE_CHANNEL)) return;
      let channel: unknown;
      try {
        channel = (JSON.parse(data) as { channel?: unknown }).channel;
      } catch {
        return;
      }
      if (channel === AGENT_PROFILE_CHANNEL) sessionToolsRefresher.invalidateDaemonPointing();
    }
  };
  broadcaster.add(agentProfileSink);
  services.sessionToolsRefresher = sessionToolsRefresher;
  // umcp:t6 end

  // The agent host (chat spec §3.1), adopted or spawned AFTER reattach so the
  // chat tab records are already loaded, and before any transport serves.
  // Best-effort: a host failure must not block the daemon — every chat route
  // then answers 503 HOST_UNAVAILABLE.
  await agentChat.init().catch((error) => console.error("Agent host init failed", error));
  // The static web build the HTTP transport optionally serves.
  const webDirEnv = options.webDir ?? env.ORQUESTER_WEB_DIR;
  const webDir = webDirEnv ? resolve(cwd, webDirEnv) : undefined;
  const serveWeb = webDir && existsSync(join(webDir, "index.html")) ? webDir : undefined;

  // The local unix socket transport is always present.
  if (runtimePlatform !== "win32") {
    await rm(paths.socketPath, { force: true });
  }
  const unixServer = createServer(config, resolved, clientConfig, logStream, services, {
    authRequired: false,
    mode: "local"
  });
  // umcp:t5 begin
  // Reply subscriptions (unified MCP design 2026-10-15 §8.3): persisted before posting, delivered
  // through the lineage delivery queue. The router starts and stops with that queue (its
  // `attachApi` below binds both); its routes are SOCKET-ONLY — the unix app alone.
  const replies = new ReplyRouter({
    outboxFile: agentChatReplyOutboxFile(paths.baseDir),
    sessions: agentChat.chat,
    queue: lineage,
    logger: console,
    sessionsLoaded: () => sessionsReattached
  });
  await replies.load();
  lineage.setDeliveryListener(replies);
  delegateStops.setListener(replies);
  registerReplySubscriptionRoutes(unixServer, {
    replies: () => replies,
    isChatSession: (id) => agentChat.chat.has(id)
  });
  // umcp:t5 end
  await unixServer.listen({ path: paths.socketPath });

  // The daemon's in-process client of its OWN REST API for the workflow engine's agent blocks
  // (workflows spec §2 "Driving agents"). Bound to the UNIX app on purpose: it is always on and
  // never rebuilt, and it needs no bearer — the HTTP app is hot-reloadable (a reference to it goes
  // stale on the next config change) and would 401 an unauthenticated call. Every route gate the
  // GUI meets applies to the engine through it by construction. `fsRoot`/`workspacesDir` are read
  // once here, as the MCP's per-request client reads them.
  services.internalApi = createInternalDaemonApi({
    app: unixServer,
    broadcaster,
    agentChat,
    // Getters: the client lives as long as the daemon, and PUT /api/config/daemon moves both.
    fsRoot: () => resolved.fsRoot,
    workspacesDir: () => resolved.workspacesDir,
    // boxes: the box MCP tools' streamed operations.
    boxes: temporaryBoxTools,
    // boxes: read_file / directory reads of box projects go to the box.
    boxRegistry: () => services.boxRegistry,
    // Devices: the device MCP tools' operations (null while the plugin is off).
    devices: () => devices.service()
  });

  lineage.attachApi(services.internalApi);
  // Knowledge Graph: follows the plugin (after `plugins.start()`), and with it on opens the knowledge
  // base — linking loads its graph and resumes an interrupted run, its worker chats going through
  // the in-process API just made. Before the boot manifest refresh below, so chats see its collections.
  await knowledge.start().catch((error) => console.error("Knowledge Graph start failed", error instanceof Error ? error.message : error));
  limitRecovery.attachApi(services.internalApi);
  idleCompaction.attachApi(services.internalApi);
  delegateStops.attachApi(services.internalApi);
  // umcp:t6 — every chat tool is on in every chat: a provider session the host kept across this
  // boot (launched by an older build, with fewer tools) is handed the current manifest once. The
  // host answers `unchanged` for an equal list, else applies it in-session or at the chat's next
  // idle point (never under a running turn). Best effort.
  void sessionToolsRefresher.refresh(null).catch((error) => console.warn("session-tools: boot refresh failed", error instanceof Error ? error.message : String(error)));

  /**
   * Attach the workflow engine: after `agentChat.init()` (above — a resumed agent block re-enters
   * its watcher against the adopted host) and after `services.internalApi` exists (the engine's
   * ChatClient rides it). From then on the workflow routes run, test and cancel through it; before
   * it they answer 503 ENGINE_UNAVAILABLE and history is read from the run store alone. `start`
   * resumes every unfinished run, starts the queue and the sweepers, then arms the scheduler and the
   * git poller. `stop()` below stops it before flushing the workflow stores.
   */
  const attachWorkflowEngine = (engine: WorkflowEngine): void => {
    services.workflowEngine = engine;
  };
  attachWorkflowEngine(workflowDaemon.runtime.engine);
  // Runs resume and missed schedules fire as the engine starts, and their account selection reads
  // usage at once: let the first reading land first (the persisted one, usually no request at all).
  await usage.whenFirstReading(15_000);
  await workflowDaemon.start(services.internalApi).catch((error) => console.error("Workflow engine start failed", error));

  // The external HTTP transport is opt-in and hot-reloadable: changing its
  // config (password / host / port / enabled) restarts THIS transport only —
  // the daemon, sessions (PTYs) and the unix transport keep running. Connected
  // clients are dropped and reconnect (re-authenticating on a password change).
  let httpServer: FastifyInstance | null = null;
  const publishDaemonStopping = (reason: DaemonStoppingPayload["reason"]): void => {
    broadcaster.publish(DAEMON_EVENTS_CHANNEL, DAEMON_STOPPING_EVENT, { reason } satisfies DaemonStoppingPayload);
  };
  const startHttp = async () => {
    if (!config.transports.http.enabled) {
      return;
    }
    const app = createServer(config, resolved, clientConfig, logStream, services, {
      authRequired: true,
      mode: "remote",
      serveWeb
    });
    await app.listen({ host: config.transports.http.host, port: config.transports.http.port });
    httpServer = app;
    console.log(
      `http transport on ${config.transports.http.host}:${config.transports.http.port}${serveWeb ? " (+web)" : ""}`
    );
  };
  const stopHttp = async () => {
    if (httpServer) {
      const server = httpServer;
      httpServer = null;
      // close() waits for open connections to end first; long-lived WebSocket
      // clients would otherwise hold it open until the stop timeout. Force-drop
      // lingering sockets so close() resolves promptly (clients reconnect).
      const closed = server.close();
      server.server.closeAllConnections?.();
      await closed.catch(() => undefined);
    }
  };
  services.reloadHttp = async () => {
    // Clients on the remote transport learn why their connection is about to drop.
    publishDaemonStopping("http-restart");
    await stopHttp();
    try {
      await startHttp();
    } catch (error) {
      console.error("Failed to (re)start HTTP transport", error);
    }
  };

  await startHttp();
  // Agent profile change detection (fs watchers on each installed agent's config), after boot.
  agentProfile.start();
  // Secret files: follows the plugin; while on, watches clones and runs its first reconcile in the background.
  await secretFiles.start().catch((error) => console.error("Secret files start failed", error instanceof Error ? error.name : error));

  const stop = async () => {
    // First, while the event streams still flow: clients show "restarting"
    // instead of a bare network error for the gap that follows.
    publishDaemonStopping("shutdown");
    usage.stop();
    clearTimeout(liveRecompute);
    await usageState.flush();
    // Workflows first: the engine stops its timers, triggers and sweepers (never a sandbox child —
    // those are detached and survive, §5.8), then every workflow store's write chain is flushed.
    // Both are fast; the 3 s backstop in cli.ts bounds them regardless.
    await workflowDaemon.stop().catch((error) => console.error("Workflow engine stop failed", error));
    await Promise.all([workflows.flush(), workflowSecrets.flush(), workflowRuns.flush(), workflowState.flush()]);
    // Knowledge Graph: linking (its child and worker sessions), search and the embedder stop, and the
    // store's queued writes land. Started here, before the plugins and the agent host stop; awaited
    // last, bounded, with the secret files below.
    const knowledgeStopped = knowledge.stop().catch((error) => console.error("Knowledge Graph stop failed", error instanceof Error ? error.message : error));
    // Devices: before the plugins (no switch is followed any more). Setups and boots in flight are
    // cancelled; devices keep running and a restart reattaches.
    await devices.stop().catch((error) => console.error("Device service stop failed", error instanceof Error ? error.message : error));
    // Plugins: the hourly timer, and a running download or smoke test cancelled (its staging dir is
    // emptied at the next start); queued plugins.json writes land.
    await plugins.stop().catch((error) => console.error("Plugins stop failed", error));
    // Secret files: watchers, timers and git children stop at once (nothing new starts or writes a
    // clone); an operation already in flight is awaited last, bounded, below.
    secretFiles.stop();
    const secretFilesIdle = secretFiles.idle().catch((error) => console.error("Secret files stop failed", error instanceof Error ? error.name : error));
    // Agent profile: its watchers and debounce timers, each adapter's long-lived helpers (a codex
    // app-server may take its whole kill grace to exit) and the import trees. Started here, awaited
    // last: it must not hold up the session and agent-host shutdown below within cli.ts's 3 s backstop.
    const agentProfileStopped = Promise.all([
      agentProfile.stop().catch((error) => console.error("Agent profile stop failed", error)),
      agentProfileImports.stop().catch((error) => console.error("Agent profile imports stop failed", error))
    ]);
    agentAccounts.stopRefresher();
    // Aborts preparations in flight (their staging dirs are emptied at the next start).
    sessionProfileLifecycle.stop();
    gitWatcher.stop();
    // Detach (don't kill) sessions: the tmux backend leaves its server running so
    // the next boot reattaches; the local backend has no server, so its shutdown()
    // terminates the child PTYs (they'd die with the daemon regardless).
    sessions.shutdown();
    // Stops supervising only: under tmux the agent host is deliberately left
    // running so in-flight turns survive the deploy (chat spec §3.1).
    delegateStops.stop();
    await lineage.stop();
    limitRecovery.stop();
    idleCompaction.stop();
    // umcp:t3 begin
    // Disconnect FIRST, while the transports may still serve: new calls get no card or grant
    // (PERMISSION_DENIED). Then pending cards end `cancelled`
    // ("restarting"), and a call already past the port lookup is cancelled the same way.
    disconnectExecutor();
    await agentToolsRuntime.shutdown().catch((error) => console.error("Agent tools stop failed", error));
    // umcp:t3 end
    // boxes: host-side port forwards close; detached jobs keep running in their boxes.
    await temporaryBoxTools.shutdown().catch((error) => console.error("Temporary box tools stop failed", error));
    // boxes: timers, setup runs, watchers and box links stop (boxes and their processes keep running).
    await boxes.stop().catch((error) => console.error("Box wiring stop failed", error));
    // umcp:t6 begin
    broadcaster.remove(agentProfileSink);
    sessionToolsRefresher.stop();
    // umcp:t6 end
    await htmlPreview.stop();
    await agentChat.stop();
    await browsers.shutdown();
    // Desktops keep running in tmux; only their watchers, window trackers and
    // audio encoders (daemon children) stop.
    await desktops.shutdown();
    desktopAudio.shutdown();
    await stopHttp();
    const unixClosed = unixServer.close();
    unixServer.server.closeAllConnections?.();
    await unixClosed.catch(() => undefined);
    await logStream.close();
    await agentProfileStopped;
    // Last, and bounded: a secret-files vault write in flight lands, a stuck one never holds the exit;
    // the same for the knowledge base's last writes.
    let secretFilesBound: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all([secretFilesIdle, knowledgeStopped]),
      new Promise<void>((resolve) => {
        secretFilesBound = setTimeout(resolve, 1000);
        secretFilesBound.unref?.();
      })
    ]);
    clearTimeout(secretFilesBound);
  };

  const running = buildInfo.commit ? ` ${buildInfo.version ?? "?"} (${buildInfo.commit.slice(0, 12)})` : "";
  console.log(`Orquester daemon${running} ${daemonId} on unix:${paths.socketPath} (workspaces: ${resolved.workspacesDir})`);

  return {
    daemonId,
    socketPath: paths.socketPath,
    workspacesDir: resolved.workspacesDir,
    stop
  };
}

/** One launch-env contribution: env vars, optional unsets, effective account. */
type LaunchEnv = { env: Record<string, string>; unset?: string[]; accountId?: string };

/** Add the Claude harness options while preserving the managed account and credential removals. */
export function buildAgentLaunchEnv(
  entryId: string,
  claude: { timeoutMinutes: number; subagentCacheTtl: SubagentCacheTtl },
  accountEnv: LaunchEnv | null
): LaunchEnv | null {
  const isClaude = entryId === "claude";
  if (!accountEnv && !isClaude) return null;
  const merged: LaunchEnv = { env: { ...accountEnv?.env } };
  if (isClaude) {
    const ms = String(claude.timeoutMinutes * 60_000);
    Object.assign(merged.env, {
      API_TIMEOUT_MS: ms,
      CLAUDE_STREAM_IDLE_TIMEOUT_MS: ms,
      CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS: ms,
      // Takes precedence over `subagentPromptCacheTtl` in Claude's own settings.
      CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: claude.subagentCacheTtl
    });
  }
  if (accountEnv?.unset?.length) merged.unset = [...accountEnv.unset];
  if (accountEnv?.accountId !== undefined) merged.accountId = accountEnv.accountId;
  return merged;
}

/** On-disk credential filename per managed agent. */
const MANAGED_CRED_FILENAME = { claude: ".credentials.json", codex: "auth.json", grok: "auth.json" } as const;

interface Services {
  /** The version and commit this daemon runs, read once at boot (build-info.ts). */
  buildInfo: BuildInfo;
  registry: RegistryService;
  sessions: ISessionManager;
  /** The Grok and Codex accounts' device-code links (Settings → Accounts). */
  grokDeviceLink: DeviceLinkService<string, GrokDeviceTokens>;
  codexDeviceLink: DeviceLinkService<CodexDeviceHandle, CodexDeviceTokens>;
  /** The Claude account's sign-in link (Settings → Accounts). */
  claudeOAuthLink: ClaudeOAuthLinkService;
  accounts: AccountsService;
  git: GitService;
  /** Refcounted per-project git status poller behind `project.git.changed`. */
  gitWatcher: GitWatcher;
  todos: TodoListManager;
  /** Daemon-owned recent-projects list, shared by every connected client. */
  recentProjects: RecentProjectsService;
  /** Daemon-owned saved-prompt library (the right rail), shared by every client. */
  savedPrompts: SavedPromptsService;
  /** Daemon-owned repo identities (a label and icon per git repo), shared by every client. */
  repoIdentities: RepoIdentitiesService;
  /** GitHub link previews for the chat's link pills. Optional: route tests build a partial `services`. */
  githubLinks?: GitHubLinkPreviewService;
  /** Built-in plugins (Settings → Plugins): plugins.json, the TypeScript engine (tsrs or tsc-rs) install, the session preload. */
  plugins: PluginsService;
  /** The "Secret files" plugin's vaults and sync engine: ONE instance both transports share. Optional: route tests build a partial `services`. */
  secretFiles?: SecretFilesService;
  /** The Knowledge Graph plugin: ONE instance both transports share. Optional: route tests build a partial `services`. */
  knowledge?: KnowledgeService;
  // boxes: the Ephemeral AI VMs box service (spec 2026-10-19). Optional: route tests build a partial `services`.
  boxes?: BoxService;
  /** Each agent CLI's own global config (agent profile spec §4): Settings → Agent config. */
  agentProfile: AgentProfileService;
  /** Orquester-owned per-session Agent Profiles (spec 2026-10-18). */
  sessionProfiles: SessionProfileService;
  /** Agent Profiles' prepared dirs: `ensureReady(profileId, agent, accountId)` for launches, `status`, `markStale`. */
  sessionProfileLifecycle: SessionProfileLifecycle;
  /** Automated workflow definitions (workflows spec §3.1). */
  workflows: WorkflowService;
  /** Workflow secrets — names out, values only to the engine (§5.7). */
  workflowSecrets: WorkflowSecretsService;
  /** Workflow runs on disk (§5.8). */
  workflowRuns: FileRunStore;
  /** Schedule/git cursors and account cooldowns (§3.1); the engine and triggers own its contents. */
  workflowState: WorkflowStateStore;
  /**
   * The workflow engine, once `attachWorkflowEngine` (in `startDaemon`) has run; null before.
   * The routes read it per request.
   */
  workflowEngine: WorkflowEngine | null;
  /** Temporary-project deletes for the workflow delete cascade when the engine cannot do them. */
  workflowProjects?: Pick<ProjectOps, "deleteProject">;
  /** Brings the workflow validation's agent catalogue up to date (bounded) before a write. */
  workflowCatalogReady?: () => Promise<void>;
  /**
   * The daemon's in-process, unauthenticated client of its own REST API, bound to the unix app
   * (see its construction in `startDaemon`); null until that app exists. The engine's ChatClient.
   */
  internalApi: InjectDaemonApi | null;
  /** Pending `request_secret` cards, memory only (optional: route-level tests build a partial `services`). */
  secretRequests?: SecretRequestRegistry;
  // umcp:t3 begin
  /** Approval cards and their grants (unified MCP §7, §9.6). Optional: route tests build a partial `services`. */
  agentToolsRuntime?: AgentToolsRuntime;
  // umcp:t3 end
  // umcp:t6 begin
  /** The chat transport's manifests and manifest pushes (unified MCP §9.4). Optional: route tests build a partial `services`. */
  sessionToolsRefresher?: SessionToolsRefresher;
  // umcp:t6 end
  // boxes: temporary boxes for agent chats (routes and the box tools' operations). Optional: route tests build a partial `services`.
  temporaryBoxTools?: TemporaryBoxTools;
  usage: UsageService;
  usageTokens: UsageTokensScanner;
  /** Per-day usage from Orquester's own chat logs, for agents without a transcript scanner (Grok). Optional: route tests build a partial `services`. */
  chatThreadUsage?: ChatThreadUsageScanner;
  /** The Claude subagent cache lifetime as it applies now (auto mode's decision). */
  subagentCacheTtl: SubagentCacheTtlController;
  push: PushService;
  broadcaster: Broadcaster;
  agentAccounts: AgentAccountsService;
  browsers: BrowserManager;
  /** Desktop tabs (desktop spec §5). */
  desktops: DesktopManager;
  /** Per-desktop Opus encoders behind /ws-desktop-audio. */
  desktopAudio: DesktopAudioHub;
  urlWatcher: UrlWatcher;
  /**
   * The agent-chat half: the supervised agent host, the chat tab records and
   * the §6.2/§6.3 proxy routes (chat design spec §3.1, §5.2, §6).
   */
  agentChat: AgentChatService;
  /**
   * Thread lineage (spec 2026-10-14 §6): parents, children and the merge-back queue. Optional:
   * route-level tests build a partial `services`.
   */
  lineage?: LineageService;
  /** Usage-limit recovery of interactive chats. Optional: route-level tests build a partial `services`. */
  limitRecovery?: ChatLimitRecovery;
  /** Idle Claude compaction. Optional: route-level tests build a partial `services`. */
  idleCompaction?: ChatIdleCompaction;
  /**
   * The delegate stop cascade (`agent-chat/delegates.ts`): the command routes report every
   * accepted interrupt and stop to it. Optional: route-level tests build a partial `services`.
   */
  delegateStops?: DelegateStopCascade;
  /** Restart the HTTP transport (set in main once the lifecycle exists). */
  reloadHttp?: () => Promise<void>;
  /**
   * The remote transport's login sessions and API tokens (`auth/sessions.ts`). Optional: route
   * tests build a partial `services` (each app then gets an empty in-memory store).
   */
  authSessions?: AuthSessionStore;
  // boxes: which paths live in a box project (boxes/service). Absent: every path is a host path
  // (route tests). Read per request.
  boxRegistry?: BoxRegistry;
  // boxes: the rest of the box wiring (hub, sync, tooling, forwards, broker routes). Optional: route tests build a partial `services`.
  boxWiring?: DaemonBoxes;
  /** Device simulators: the device service (while the plugin is on) and its routes. Optional: route tests build a partial `services`. */
  devices?: DaemonDevices;
}

export function createServer(
  config: DaemonConfig,
  resolved: ResolvedPaths,
  clientConfig: ClientConfig,
  logStream: { write(line: string): void },
  services: Services,
  options: { authRequired: boolean; mode: "local" | "remote"; serveWeb?: string }
): FastifyInstance {
  const { registry, sessions, accounts, git, todos, recentProjects, usage, usageTokens, subagentCacheTtl, push, agentAccounts } = services;

  const app = Fastify({
    // Remote requests arrive via Caddy on loopback (reverse_proxy 127.0.0.1:47831),
    // so trust ONLY the loopback hop. proxy-addr then resolves request.ip to the
    // closest UNtrusted address — the real client IP that Caddy appended to
    // X-Forwarded-For — instead of the literal 127.0.0.1 socket peer. This is what
    // makes the per-IP login throttle key on the actual client (see clientIp).
    // The unix-socket transport has no proxy, so leave it off there.
    trustProxy: options.mode === "remote" ? "127.0.0.1" : false,
    // find-my-way's default (100) is shorter than an agent profile item id in its URL
    // (`command%3A<64>%2F<64>`, `plugin%3A<name>%40<marketplace>`): such a route would 404.
    // Every handler bounds and validates its own parameters.
    maxParamLength: 2048,
    logger: {
      level: "info",
      stream: logStream,
      serializers: {
        // Strip credentials from request logs (TLS protects them on the wire,
        // but they must never land in plaintext logs): the WS/download ?token=
        // and its percent-encoded form inside the DevTools iframe's ?wss= value.
        req(request: { method: string; url: string }) {
          return { method: request.method, url: redactUrlTokens(request.url) };
        }
      }
    }
  });

  const throttle = new LoginThrottle();
  // Password guesses (login, verify) have their own count: a valid bearer's success on the same
  // IP must not reset it.
  const passwordThrottle = new LoginThrottle();
  const authSessions = services.authSessions ?? new AuthSessionStore();

  // Open streams (event stream, WebSockets) by the session that authenticated them: a request
  // re-checks its bearer every time, but a stream outlives that check, so revoking a session
  // closes its streams too.
  const liveStreams = new Map<string, Set<() => void>>();
  const trackStream = (sessionId: string, close: () => void): (() => void) => {
    const set = liveStreams.get(sessionId) ?? new Set<() => void>();
    set.add(close);
    liveStreams.set(sessionId, set);
    return () => {
      set.delete(close);
      if (set.size === 0 && liveStreams.get(sessionId) === set) liveStreams.delete(sessionId);
    };
  };
  const stopRevokeWatch = authSessions.onRevoked((ids) => {
    for (const id of ids) {
      const closers = liveStreams.get(id);
      liveStreams.delete(id);
      for (const close of closers ?? []) close();
    }
  });
  app.addHook("onClose", async () => stopRevokeWatch());
  /**
   * The `?token=` check of a WebSocket route: true when auth is off or the token is a live session
   * (the socket is then closed if that session is revoked).
   */
  const authorizeSocket = (token: string | undefined, socket: { close(code?: number, reason?: string): void; once(event: "close", listener: () => void): unknown }): boolean => {
    if (!options.authRequired) return true;
    const session = authSessions.verify(token);
    if (!session) return false;
    socket.once("close", trackStream(session.id, () => socket.close(1008, "unauthorized")));
    return true;
  };

  /**
   * Tie a gated request's response to its session: revoking the session destroys a response that
   * is already streaming (a hijacked NDJSON stream — events, chat events, terminal output, MCP — or
   * a streamed download). One still being computed is left to finish (a logout's own reply), but if
   * it hijacks afterwards — a stream that opens after a wait — it is destroyed then. Every route
   * behind the bearer hook gets this, so no streaming route has to remember to register itself.
   */
  const endOnRevoke = (sessionId: string, reply: FastifyReply): void => {
    let revoked = false;
    const streaming = (): boolean => reply.sent || reply.raw.headersSent;
    const end = (): void => {
      if (!reply.raw.writableEnded) reply.raw.destroy();
    };
    const untrack = trackStream(sessionId, () => {
      if (streaming()) end();
      else revoked = true;
    });
    reply.raw.once("close", untrack);
    const hijack = reply.hijack.bind(reply);
    reply.hijack = () => {
      const result = hijack();
      if (revoked) queueMicrotask(end);
      return result;
    };
  };

  app.decorateRequest("authSession", null);

  app.addHook("onRequest", async (request, reply) => {
    // The multiplexed session WebSocket authenticates itself via a query token
    // (browsers can't set WS headers) and must skip the bearer logic below.
    const rawPath = request.url.split("?")[0] ?? "";
    // The router matches the percent-DECODED path (`/%61pi/sessions` is routed to
    // `/api/sessions`), so the gate is decided on the raw path, its decoded form AND the
    // matched route's own pattern — never on the raw request line alone.
    const routePath: string | undefined = request.routeOptions.url;
    if (rawPath === "/ws" || routePath === "/ws") {
      return;
    }
    // An agent's page is framed by an iframe, which cannot send the bearer:
    // the route matched here is authorised by its own HMAC signature
    // (`agent-chat/visual-urls.ts`) and refuses anything that does not carry
    // one (spec 2026-10-14 §2.2). Only the matched route pattern lets it
    // through, never a path prefix.
    if (routePath === AGENT_VISUAL_ROUTE_PATTERN) {
      return;
    }
    // boxes: the box connect WebSocket and the orq-agent download authenticate the
    // box themselves (bootstrap token, box credential or GitHub OIDC) and accept
    // nothing else. Only these matched route patterns, never a path prefix.
    if (routePath !== undefined && BOX_HUB_PUBLIC_ROUTES.includes(routePath)) {
      return;
    }

    // Only the API + event stream are token-gated; the static web client, its
    // assets and the public auth info and login endpoints load freely (the web
    // app then authenticates its API calls with its session token).
    const decodedPath = safeDecodePath(rawPath);
    const url = routePath ?? decodedPath ?? rawPath;
    const gated = (path: string | undefined): boolean =>
      path !== undefined &&
      (path.startsWith("/api") || path.startsWith("/events") || path.startsWith("/mcp")) &&
      path !== authRoutes.info &&
      path !== authRoutes.login;
    // A path that does not even decode is refused unless authenticated.
    const needsAuth = decodedPath === undefined || gated(rawPath) || gated(decodedPath) || gated(routePath);
    if (!options.authRequired || !needsAuth) {
      return;
    }

    const ip = clientIp(request);
    const retryAfterMs = throttle.retryAfterMs(ip);
    if (retryAfterMs > 0) {
      reply.header("retry-after", String(Math.ceil(retryAfterMs / 1000)));
      return reply.code(429).send({
        code: "TOO_MANY_ATTEMPTS",
        message: "Too many failed login attempts. Try again later."
      });
    }

    // A browser download navigation (<a download>) can't set an Authorization
    // header, so /api/fs/download also accepts the token as ?token= — the
    // same trick /ws uses. Scoped to that route (and the device media routes
    // below); the token is redacted from logs by the request serializer
    // above. Only a live session or API token
    // passes (auth/sessions.ts) — never the stored password hash.
    const headerToken = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    // Devices: a kept screenshot and a lease thumbnail load from `<img>` the same way (GET/HEAD of
    // matched route patterns only, never a prefix; the hub proxy and every POST need the header).
    const queryTokenRoute = url === "/api/fs/download" || deviceQueryTokenAllowed(request.method, routePath);
    const queryToken = queryTokenRoute ? (request.query as { token?: string }).token : undefined;
    const session = authSessions.verify(headerToken ?? queryToken);
    if (!session) {
      throttle.recordFailure(ip);
      return reply.code(401).send({
        code: "UNAUTHORIZED",
        message: "A valid bearer token is required for this daemon transport."
      });
    }
    throttle.recordSuccess(ip);
    request.authSession = session;
    endOnRevoke(session.id, reply);
  });

  // umcp:t2 begin — principals (unified MCP design 2026-10-15; `@orquester/api` principal.ts).
  // After the bearer hook: an unauthenticated request never reaches the token registry. Both apps
  // resolve the in-process principal token; a request without one is the user's (the GUI, a local
  // CLI, a direct REST call with the bearer). The remote app also strips socket-trusted body
  // fields (`causedBy` on turns and merge-backs) before any route reads them.
  registerPrincipalHook(app);
  if (options.mode === "remote") registerRemoteFieldStripping(app);
  // umcp:t2 end

  // Public `info` (whether auth is needed — never the hash, a salt or the username) and `login`;
  // the session and token management routes behind the bearer hook (auth/routes.ts).
  registerAuthRoutes(app, {
    mode: options.mode,
    store: authSessions,
    passwordThrottle,
    credentials: () => ({ username: config.transports.http.username, passwordHash: config.transports.http.passwordHash })
  });

  // Public liveness only. Daemon id / version / mode / transports are not
  // disclosed to unauthenticated callers (moved behind /api/info, which is gated).
  // The service marker and the wire protocol generation are: the web client is
  // served from here anyway, and a client must tell "not an Orquester daemon"
  // and "incompatible protocol" from "unreachable" before it signs in.
  app.get("/health", async (): Promise<HealthResponse> => ({
    ok: true,
    service: ORQUESTER_SERVICE,
    protocol: ORQUESTER_PROTOCOL_VERSION
  }));

  app.get("/api/info", async (): Promise<ServerInfoResponse> => ({
    name: "Orquester daemon",
    version: services.buildInfo.version,
    commit: services.buildInfo.commit,
    dataDir: resolved.daemonDir,
    workspacesDir: resolved.workspacesDir,
    protocol: ORQUESTER_PROTOCOL_VERSION,
    build: services.buildInfo.commit?.slice(0, 12) ?? null,
    capabilities: {
      terminals: true,
      sessions: true,
      agents: true,
      docker: false
    }
  }));

  app.get("/api/config/daemon", async (): Promise<DaemonConfig> => sanitizeDaemonConfig(config));
  app.get("/api/config/client", async (): Promise<ClientConfig> => clientConfig);

  // Update daemon.json. Security boundary: only over the local unix socket —
  // an external HTTP client can read but not change the daemon config.
  app.put("/api/config/daemon", async (request, reply): Promise<DaemonConfig | void> => {
    if (options.mode === "remote") {
      return reply.code(403).send({
        code: "FORBIDDEN",
        message: "Daemon config can only be changed locally over the unix socket."
      });
    }

    const body = (request.body ?? {}) as Partial<DaemonConfig>;
    const httpPatch = (body.transports?.http ?? {}) as Partial<{
      enabled: boolean;
      host: string;
      port: number;
      username: string;
      password: string;
    }>;
    // Username is not editable through this endpoint, but a client may echo back
    // a GET response in which it was masked. Drop the sentinel so the real
    // username (preserved from the existing config) is never overwritten by it.
    if (httpPatch.username === "********") {
      delete httpPatch.username;
    }

    // Merge + persist + apply inside the shared daemon.json queue: the
    // protect-archived route below does a read-modify-write of the same file,
    // and an unserialized interleaving would let its stale copy revert this save
    // (e.g. a freshly set passwordHash) on disk while memory kept the new value.
    // The merge itself has to run in here too — every value it carries over from
    // the live config (`protectArchivedData`, the existing passwordHash) must be
    // read AFTER any queued write ahead of us landed, or a toggle that won the
    // race gets overwritten with the value we sampled before it.
    const outcome = await queueDaemonConfigWrite(
      async (): Promise<{ merged: DaemonConfig } | { code: string; message: string }> => {
        // A new plaintext password (when provided) is hashed; otherwise keep the
        // existing hash. We never persist plaintext.
        const passwordHash =
          httpPatch.password && httpPatch.password !== "********"
            ? hashPassword(httpPatch.password)
            : config.transports.http.passwordHash;

        let merged: DaemonConfig;
        try {
          merged = parseDaemonConfig({
            version: 1,
            workspacesDir: body.workspacesDir ?? config.workspacesDir,
            logsDir: body.logsDir ?? config.logsDir,
            // Not managed by this route (see the dedicated endpoint below) —
            // carry the live value through so a config save can't silently
            // reset it.
            protectArchivedData: config.protectArchivedData,
            transports: {
              http: {
                ...config.transports.http,
                ...httpPatch,
                password: undefined,
                passwordHash
              }
            }
          });
        } catch {
          return { code: "INVALID_CONFIG", message: "Invalid daemon config." };
        }

        if (merged.transports.http.enabled && !merged.transports.http.passwordHash) {
          return {
            code: "PASSWORD_REQUIRED",
            message: "Enabling external HTTP access requires a password (min 8 chars)."
          };
        }

        await writeJsonFile(resolved.configPath, merged);
        // Apply live in-process (no daemon restart): update the shared config + dirs,
        // then hot-restart the HTTP transport so the new password/host/port/enabled
        // take effect immediately. Sessions (PTYs) and the unix transport are untouched.
        Object.assign(config, merged);
        return { merged };
      }
    );

    if (!("merged" in outcome)) {
      return reply.code(400).send({ code: outcome.code, message: outcome.message });
    }
    const merged = outcome.merged;
    // A new password signs every device out; API tokens stay (auth/sessions.ts).
    await authSessions.syncPassword(merged.transports.http.passwordHash);
    resolved.workspacesDir = expandVars(merged.workspacesDir, resolved.vars);
    resolved.fsRoot = merged.transports.http.fsRoot
      ? expandVars(merged.transports.http.fsRoot, resolved.vars)
      : resolved.workspacesDir;
    resolved.logsDir = expandVars(merged.logsDir, resolved.vars);
    await mkdir(resolved.workspacesDir, { recursive: true }).catch(() => undefined);
    // The TypeScript engine preload has the workspaces root baked in: rewrite it for the new one.
    void services.plugins.workspacesChanged();
    // boxes: boxes get tooling preloads that bake in the new root.
    services.boxWiring?.workspacesChanged();
    void services.reloadHttp?.();

    return sanitizeDaemonConfig(config);
  });

  // "Protect archived data" toggle. Deliberately allowed on BOTH transports —
  // unlike the full daemon-config PUT above — because it guards a client-side
  // UI curtain, not daemon security posture, and the remote web client must be
  // able to flip it. The UI enforces retype-to-disable on its side. (Spec:
  // docs/superpowers/specs/2026-07-26-archive-workspaces-projects-design.md)
  app.put<{ Body: SetProtectArchivedRequest }>(
    "/api/config/daemon/protect-archived",
    async (request, reply): Promise<DaemonConfig | void> => {
      if (typeof request.body?.enabled !== "boolean") {
        return reply
          .code(400)
          .send({ code: "INVALID_CONFIG", message: "`enabled` must be a boolean." });
      }
      const enabled = request.body.enabled;
      // Persist ONLY the field this route manages. daemon.json used to be
      // writable from the unix socket alone; now that a remote client can hit
      // this route, serializing the whole in-memory config would let a UI
      // curtain toggle silently overwrite any on-disk divergence (e.g. a
      // daemon.json hand-edited since boot). Re-read + re-validate the file and
      // patch the one field.
      //
      // An unreadable/corrupt file fails the request instead of being healed
      // from memory: boot (`loadConfig`) always materializes daemon.json, so
      // there is no legitimate "no file yet" case here, and writing the live
      // in-memory config out would bake env-derived values (the
      // ORQUESTER_HTTP_PASSWORD hash, host, port) into a deliberately partial
      // file — silently pinning the password against future rotation. Same rule
      // as workspaces.json: never self-heal a corrupt file by overwriting it.
      //
      // The whole read-modify-write runs in the shared daemon.json queue so a
      // concurrent PUT /api/config/daemon can neither be read half-applied nor
      // be reverted by this write. The in-memory flag is flipped only AFTER the
      // write lands — a failed write (EACCES/ENOSPC) must 500 with memory and
      // disk still agreeing.
      const ok = await queueDaemonConfigWrite(async () => {
        let persisted: DaemonConfig;
        try {
          persisted = parseDaemonConfig(JSON.parse(await readFile(resolved.configPath, "utf8")));
          persisted.protectArchivedData = enabled;
          // Never write a plaintext password back out (boot already migrates the
          // file; this guards a hand-edit made since).
          migrateHttpPassword(persisted);
        } catch (error) {
          console.error("Failed to read daemon config; refusing to overwrite it", error);
          return false;
        }
        await writeJsonFile(resolved.configPath, persisted);
        config.protectArchivedData = enabled;
        return true;
      });
      if (!ok) {
        return reply.code(500).send({
          code: "CONFIG_UNREADABLE",
          message: "daemon.json is unreadable; refusing to overwrite it."
        });
      }
      return sanitizeDaemonConfig(config);
    }
  );

  if (options.mode === "local") {
    app.post("/api/daemon/shutdown", async (_request, reply) => {
      services.broadcaster.publish("daemon", "daemon.shutdown", {});
      return reply.code(204).send();
    });
  }

  // A directory created, renamed or deleted directly under the workspaces root is a workspace
  // change: the plugins service re-checks the workspaces root its preload has baked in (only a
  // root move changes anything; plugins are on for the whole server). `parentDir` is a realpath.
  // Optional chaining here and in the workspace routes: their route tests stub `services` without plugins.
  const notifyWorkspacesChanged = async (parentDir: string): Promise<void> => {
    const root = await realpath(resolved.workspacesDir).catch(() => resolve(resolved.workspacesDir));
    if (parentDir === root) {
      void services.plugins?.workspacesChanged();
      // boxes: boxes get tooling preloads that bake in the new root.
      services.boxWiring?.workspacesChanged();
    }
  };

  // Filesystem-backed workspaces & projects:
  //   (workspacesDir)/<workspace>           -> a workspace
  //   (workspacesDir)/<workspace>/<project> -> a project
  app.get("/api/workspaces", async (): Promise<WorkspaceSummary[]> =>
    listWorkspaces(resolved.workspacesDir, resolved.workspacesMetaFile)
  );

  app.post("/api/workspaces", async (request, reply): Promise<WorkspaceSummary | void> => {
    const body = request.body as CreateWorkspaceRequest | undefined;
    const name = body?.name;
    if (!isValidName(name)) {
      return reply.code(400).send({ code: "INVALID_NAME", message: "Invalid workspace name." });
    }

    const path = join(resolved.workspacesDir, name);
    await mkdir(path, { recursive: true });

    // Upsert the metadata side-table entry (keyed by name) — MERGE, never
    // replace: `mkdir -p` succeeds on an existing dir, so this route also fires
    // for a workspace that already exists but is hidden because it is archived.
    // Replacing the entry outright would wipe that workspace's per-project
    // archive flags (resurfacing projects the user archived) and its
    // gitAccountId/createdAt. `isArchived` is reset to false on purpose: the
    // caller just asked for this workspace to exist, so it must be visible.
    const createdAt = new Date().toISOString();
    const entry = await mutateWorkspacesMeta(resolved.workspacesMetaFile, (meta) => {
      const previous = meta.workspaces.find((w) => w.name === name);
      const next: WorkspaceMeta = {
        name,
        gitAccountId: body?.gitAccountId ?? previous?.gitAccountId,
        createdAt: previous?.createdAt ?? createdAt,
        isArchived: false,
        archivedProjects: previous?.archivedProjects ?? []
      };
      meta.workspaces = [...meta.workspaces.filter((w) => w.name !== name), next];
      return next;
    });

    // Bind the git account (immutable): write the include file + register the
    // global includeIf rule for this workspace's realpath. Best-effort — a
    // binding failure must not orphan the just-created dir/metadata.
    if (entry.gitAccountId) {
      await services.accounts.bindWorkspace(entry.gitAccountId, path).catch((error) => {
        app.log.error({ err: error }, "git account binding failed");
      });
    }
    void services.plugins?.workspacesChanged();
    // boxes: boxes get tooling preloads that bake in the new root.
    services.boxWiring?.workspacesChanged();

    return {
      name,
      path,
      projectCount: 0,
      gitAccountId: entry.gitAccountId ?? null,
      createdAt: entry.createdAt,
      isArchived: false
    };
  });

  app.put<{ Params: { workspace: string }; Body: UpdateWorkspaceRequest }>(
    "/api/workspaces/:workspace",
    async (request, reply): Promise<WorkspaceSummary | void> => {
      const { workspace } = request.params;
      if (!isValidName(workspace)) {
        return reply.code(400).send({ code: "INVALID_NAME", message: "Invalid workspace name." });
      }
      const target = join(resolved.workspacesDir, workspace);
      const safe = await resolveWithinWorkspaces(target, resolved.workspacesDir);
      if (!safe) {
        return reply.code(404).send();
      }

      // Merge into the meta entry IN PLACE — never replace it (that would
      // clobber gitAccountId/createdAt) and never re-append it (moving the entry
      // to the end rewrites the file even for a no-op, defeating
      // `mutateWorkspacesMeta`'s skip-if-unchanged guard). Workspaces predating
      // the side-table get an entry created on the spot. Serialized so a
      // concurrent mutation of workspaces.json can't be lost.
      await mutateWorkspacesMeta(resolved.workspacesMetaFile, (meta) => {
        let entry = meta.workspaces.find((w) => w.name === workspace);
        if (!entry) {
          entry = {
            name: workspace,
            createdAt: new Date().toISOString(),
            isArchived: false,
            archivedProjects: []
          };
          meta.workspaces.push(entry);
        }
        if (typeof request.body?.isArchived === "boolean") {
          entry.isArchived = request.body.isArchived;
        }
      });

      const all = await listWorkspaces(resolved.workspacesDir, resolved.workspacesMetaFile);
      const summary = all.find((w) => w.name === workspace);
      if (!summary) {
        return reply.code(404).send();
      }
      return summary;
    }
  );

  app.get<{ Params: { workspace: string } }>(
    "/api/workspaces/:workspace/projects",
    async (request, reply): Promise<ProjectSummary[] | void> => {
      const { workspace } = request.params;
      if (!isValidName(workspace)) {
        return reply.code(400).send({ code: "INVALID_NAME", message: "Invalid workspace name." });
      }
      // The UI re-lists after a clone lands: a (debounced) secret-files reconcile picks up new clones.
      services.secretFiles?.notifyProjectsListed();
      // boxes: a box project's stub dir has no .git; its repo fields and box come from its record.
      const projects = await listProjects(resolved.workspacesDir, workspace, resolved.workspacesMetaFile);
      return services.boxes ? services.boxes.projects.decorate(projects) : projects;
    }
  );

  /**
   * Record one interaction with a project path. Best-effort and SILENT: a path
   * outside the fs sandbox, or one that isn't a `<workspace>/<project>` dir, is
   * simply not recorded — never an error, because the caller (a session launch)
   * already succeeded. The sandbox check runs on the realpath, but the entry stores the
   * caller's path so it keeps matching `ProjectSummary.path` (which is the raw
   * `<workspacesDir>/<ws>/<project>` join, symlinks unresolved).
   */
  const markRecentProject = async (path: unknown): Promise<void> => {
    if (typeof path !== "string" || path.length === 0) {
      return;
    }
    try {
      await assertInsideFsRoot(resolved.fsRoot, path);
      await recentProjects.markInteracted(resolve(path));
    } catch {
      // Outside the sandbox, or unreadable — nothing to record.
    }
  };

  // Recent projects. Daemon-owned (not per-browser localStorage) so every
  // device sees the same list. The daemon also marks automatically on session
  // create; this POST is for the pure-navigation interactions only a client
  // knows about.
  app.get(
    "/api/projects/recent",
    async (): Promise<RecentProjectSummary[]> => recentProjects.list()
  );

  app.post<{ Body: MarkRecentProjectRequest }>(
    "/api/projects/recent",
    async (request): Promise<RecentProjectSummary[]> => {
      await markRecentProject(request.body?.path);
      // snapshot(), not list(): the mark already broadcast the new list, and a
      // liveness sweep here would make one POST emit "recentProjects.changed"
      // twice. The sweep belongs to GET.
      return recentProjects.snapshot();
    }
  );

  app.put<{ Params: { workspace: string; project: string }; Body: UpdateProjectRequest }>(
    "/api/workspaces/:workspace/projects/:project",
    async (request, reply): Promise<ProjectSummary | void> => {
      const { workspace, project } = request.params;
      if (!isValidName(workspace) || !isValidName(project)) {
        return reply.code(400).send({ code: "INVALID_NAME", message: "Invalid name." });
      }
      const target = join(resolved.workspacesDir, workspace, project);
      const safe = await resolveWithinWorkspaces(target, resolved.workspacesDir);
      if (!safe) {
        return reply.code(404).send();
      }

      // Same merge-not-replace rule as the workspace PUT above (and the same
      // serialization against concurrent workspaces.json writers).
      const entry = await mutateWorkspacesMeta(resolved.workspacesMetaFile, (meta) => {
        let next = meta.workspaces.find((w) => w.name === workspace);
        if (!next) {
          next = {
            name: workspace,
            createdAt: new Date().toISOString(),
            isArchived: false,
            archivedProjects: []
          };
          meta.workspaces.push(next);
        }
        if (typeof request.body?.isArchived === "boolean") {
          const without = next.archivedProjects.filter((name) => name !== project);
          next.archivedProjects = request.body.isArchived ? [...without, project] : without;
        }
        return next;
      });

      return {
        name: project,
        workspace,
        path: target,
        isArchived: entry.archivedProjects.includes(project)
      };
    }
  );

  app.post<{ Params: { workspace: string }; Body: CreateProjectRequest }>(
    "/api/workspaces/:workspace/projects",
    async (request, reply): Promise<ProjectSummary | void> => {
      const { workspace } = request.params;
      if (!isValidName(workspace)) {
        return reply.code(400).send({ code: "INVALID_NAME", message: "Invalid workspace name." });
      }
      const body = request.body ?? ({ name: "" } as CreateProjectRequest);
      const workspaceDir = join(resolved.workspacesDir, workspace);

      // boxes: a project in a new box (Ephemeral AI VMs §8.1) — validated, stubbed on the host and
      // set up in the background by the box service; this answers at once with the project.
      const location: unknown = body.location;
      if (location !== undefined && location !== null && (location as { kind?: unknown }).kind !== "host") {
        if (!isBoxLocation(location)) {
          return reply.code(400).send({ code: "BOX_INVALID_REQUEST", message: "Unknown project location." });
        }
        if (!services.boxes) {
          return reply.code(409).send({ code: "BOXES_DISABLED", message: "Ephemeral AI VMs is not available on this daemon." });
        }
        try {
          const gitAccountId =
            (await readWorkspacesMeta(resolved.workspacesMetaFile)).workspaces.find((w) => w.name === workspace)?.gitAccountId ?? null;
          await mkdir(workspaceDir, { recursive: true });
          const created = await services.boxes.projects.create({ workspace, workspaceDir, body, gitAccountId });
          await pruneArchivedProject(resolved.workspacesMetaFile, workspace, created.name);
          return created;
        } catch (error) {
          return sendBoxError(reply, error);
        }
      }

      // Empty (or absent source): today's behavior — mkdir the validated name.
      if (body.source === undefined || body.source === "empty") {
        const name = body.name;
        if (!isValidName(name)) {
          return reply.code(400).send({ code: "INVALID_NAME", message: "Invalid name." });
        }
        const path = join(workspaceDir, name);
        // `mkdir -p` succeeds on an existing dir, so a name that collides with a
        // populated project would silently "create" it — and the client's next
        // step is to type a scaffolder into a terminal there, which either
        // refuses or scribbles over someone's work. Refuse first, with a code the
        // UI can turn into "that name is taken". An existing EMPTY dir is still
        // fine (re-creating an abandoned shell of a project is the legit case).
        const occupants = await readdir(path).catch((error: unknown) =>
          isNodeError(error) && error.code === "ENOENT" ? [] : null
        );
        if (occupants === null || occupants.length > 0) {
          // "That name is taken" is unhelpable advice when the taker is
          // invisible: an archived project is hidden from the sidebar, so the
          // user sees an empty slot and a refusal. Name the real situation and
          // the one action that resolves it (restoring is the only path back —
          // re-creating the name deliberately does not un-archive).
          const archived = (await readWorkspacesMeta(resolved.workspacesMetaFile)).workspaces
            .find((w) => w.name === workspace)
            ?.archivedProjects.includes(name);
          return reply.code(409).send({
            code: "DIRECTORY_NOT_EMPTY",
            message: archived
              ? `"${name}" is an archived project — restore it from the Archived panel.`
              : `"${name}" already exists and is not empty.`
          });
        }
        await mkdir(path, { recursive: true });
        // `mkdir -p` also succeeds on an existing dir, so this can land on a
        // project whose name is still in `archivedProjects` (archived, hence
        // invisible in the sidebar). Prune it, or the "created" project would
        // never show up. Mirrors the delete-side pruning.
        await pruneArchivedProject(resolved.workspacesMetaFile, workspace, name);
        return { name, workspace, path, isArchived: false };
      }

      // Repo modes (clone/create) resolve the git account from the WORKSPACE's
      // gitAccountId. 400 if the workspace has no linked account (the no-token case
      // is enforced by the accounts methods, which throw AccountError(400)).
      const accountId = (await readWorkspacesMeta(resolved.workspacesMetaFile)).workspaces.find(
        (w) => w.name === workspace
      )?.gitAccountId;
      if (!accountId) {
        return reply.code(400).send({
          code: "NO_GIT_ACCOUNT",
          message: "This workspace has no linked git account."
        });
      }

      try {
        if (body.source === "clone") {
          if (typeof body.url !== "string" || body.url.trim().length === 0) {
            return reply
              .code(400)
              .send({ code: "INVALID_URL", message: "A repository URL is required." });
          }
          // Provider-aware parse + clone (SSH preferred, HTTPS fallback) lives in
          // the service, which also owns the already-exists check (it knows the
          // final dir name once the URL is resolved).
          const preferredName = body.name;
          if (preferredName !== undefined && !isValidName(preferredName)) {
            return reply.code(400).send({ code: "INVALID_NAME", message: "Invalid name." });
          }
          const refProblem = body.ref === undefined ? null : cloneRefProblem(body.ref);
          if (refProblem) {
            return reply.code(400).send({ code: "INVALID_REF", message: refProblem });
          }
          await mkdir(workspaceDir, { recursive: true });
          const { name, transport, notice } = await accounts.cloneFromInput(
            accountId,
            body.url,
            preferredName,
            workspaceDir,
            {
              ...(body.ref === undefined ? {} : { ref: body.ref }),
              // Only an automated caller (a workflow's temporary project) gets the 10-minute
              // ceiling and the prompt-free env; the New Project dialog's clone is unbounded.
              ...(body.unattended === true ? { unattended: true } : {})
            }
          );
          // A stale archived name (dir removed outside orquester) would hide
          // the fresh clone — prune it, same as the empty branch above.
          await pruneArchivedProject(resolved.workspacesMetaFile, workspace, name);
          // A clone of a repo with a secret-files vault gets its files before this answers (never throws).
          await services.secretFiles?.notifyProjectCreated(join(workspaceDir, name));
          return {
            name,
            workspace,
            path: join(workspaceDir, name),
            isArchived: false,
            clone: { transport, ...(notice ? { notice } : {}) }
          };
        }

        if (body.source === "create") {
          // Make the repo (REST), then clone it over the transport the account
          // can actually authenticate on (SSH, or HTTPS while a DC key upload
          // is still pending).
          const name = body.name;
          if (!isValidName(name)) {
            return reply.code(400).send({ code: "INVALID_NAME", message: "Invalid name." });
          }
          const path = join(workspaceDir, name);
          if (existsSync(path)) {
            return reply.code(409).send({ code: "ALREADY_EXISTS", message: `"${name}" already exists.` });
          }
          const repo = await accounts.createRepo(accountId, {
            owner: body.owner,
            name,
            visibility: body.visibility,
            ...(body.description ? { description: body.description } : {})
          });
          await mkdir(workspaceDir, { recursive: true });
          const clone = await accounts.cloneCreatedRepo(accountId, repo, name, workspaceDir);
          await pruneArchivedProject(resolved.workspacesMetaFile, workspace, name);
          await services.secretFiles?.notifyProjectCreated(path);
          return { name, workspace, path, isArchived: false, clone };
        }

        return reply.code(400).send({ code: "INVALID_REQUEST", message: "Unknown project source." });
      } catch (error) {
        const status = error instanceof AccountError ? error.status : 500;
        const message = error instanceof Error ? error.message : "Could not create the project.";
        return reply.code(status).send({ code: "ACCOUNT_ERROR", message });
      }
    }
  );

  app.delete<{ Params: { workspace: string; project: string } }>(
    "/api/workspaces/:workspace/projects/:project",
    async (request, reply): Promise<void> => {
      const { workspace, project } = request.params;
      if (!isValidName(workspace) || !isValidName(project)) {
        return reply.code(400).send({ code: "INVALID_NAME", message: "Invalid name." });
      }

      const target = join(resolved.workspacesDir, workspace, project);
      const safe = await resolveWithinWorkspaces(target, resolved.workspacesDir);
      if (!safe) {
        // Either gone or outside the workspaces root — 404 (don't leak which).
        return reply.code(404).send();
      }

      // boxes: a box project's box is destroyed (and confirmed gone) before anything is removed;
      // a failed destroy keeps the project ("Destroy failed — retry" is this DELETE again).
      try {
        await services.boxes?.projects.beforeDelete(target);
      } catch (error) {
        return sendBoxError(reply, error);
      }

      // Cascade against `target` (the non-realpath join), not `safe`: sessions
      // store projectPath as the raw client-sent join path (sessions.ts:122/552
      // ← listProjects index.ts), so closeByProjectPrefix must match that form,
      // not the realpath, or symlinked workspace roots (e.g. /tmp → /private/tmp)
      // never match and the dir is removed while sessions keep running.
      sessions.closeByProjectPrefix(target);
      // Cascade-close this project's browser tabs (kills its Chromium too).
      await services.browsers.closeForProject(target, safe);
      // And its desktops (their hosts and apps); they match either spelling.
      await services.desktops.closeForProject(safe);
      await rm(safe, { recursive: true, force: true });
      // Only now that the directory is gone: cascade-delete this project's
      // to-do lists (match `target`, the raw-join path used as the list refKey
      // — not the realpath `safe`) and its folder-scoped saved prompts. Shared
      // repository prompts survive deleting a checkout. A failed rm must not
      // leave the project on disk with its data deleted.
      await todos.deleteByProjectPath(target);
      await services.savedPrompts.deleteForProject(target);
      // boxes: the destroyed box's record stays (month totals) but no longer owns the path.
      await services.boxes?.projects.afterDelete(target).catch((error) => console.error("Failed to unlink the project's box record", error));

      // Prune the archive flag so a recreated same-name project starts fresh
      // (mirrors the workspace delete pruning its whole meta entry). Non-fatal:
      // the directory is already gone, so a corrupt workspaces.json (the strict
      // read throws rather than clobbering it) must not turn a delete that
      // succeeded into a 500 — log it and let the stale flag be pruned on the
      // next create of the same name.
      await pruneArchivedProject(resolved.workspacesMetaFile, workspace, project).catch((error) =>
        console.error("Failed to prune archived project from workspaces meta", error)
      );

      return reply.code(204).send();
    }
  );

  app.delete<{ Params: { workspace: string } }>(
    "/api/workspaces/:workspace",
    async (request, reply): Promise<void> => {
      const { workspace } = request.params;
      if (!isValidName(workspace)) {
        return reply.code(400).send({ code: "INVALID_NAME", message: "Invalid workspace name." });
      }

      const target = join(resolved.workspacesDir, workspace);
      const safe = await resolveWithinWorkspaces(target, resolved.workspacesDir);
      if (!safe) {
        return reply.code(404).send();
      }

      // boxes: every box project's box in it is destroyed (and confirmed gone) first; any failure keeps the workspace.
      try {
        await services.boxes?.projects.beforeWorkspaceDelete(target);
      } catch (error) {
        return sendBoxError(reply, error);
      }

      // Kill every session under the workspace, remove the tree, then prune the
      // metadata entry (keyed by name). Cascade against `target` (non-realpath
      // join), not `safe`: stored projectPaths use the raw join form, so matching
      // the realpath would miss every session under a symlinked workspace root.
      sessions.closeByProjectPrefix(target);
      // Every browser tab and desktop of every project in it (prefix matches).
      await services.browsers.closeForProject(target, safe);
      await services.desktops.closeForProject(safe);
      // Drop the git includeIf binding BEFORE removing the tree: unbindWorkspace
      // realpaths the dir to rebuild the same matcher bindWorkspace used, so it
      // must run while the dir still exists (on macOS the literal /tmp path and
      // its /private/tmp realpath differ — a post-rm fallback wouldn't match).
      await services.accounts.unbindWorkspace(target).catch(() => undefined);
      await rm(safe, { recursive: true, force: true });
      void services.plugins?.workspacesChanged();
      // boxes: boxes get tooling preloads that bake in the new root.
      services.boxWiring?.workspacesChanged();
      // Only now that the tree is gone: cascade-delete the workspace's own to-do
      // lists AND every list under a project inside it (`workspace` = name
      // refKey; `target` = raw-join path), and the saved prompts of every
      // project inside it that have only folder scope. Repository prompts stay
      // shared with other checkouts. A failed rm must not leave the projects on
      // disk with their data deleted.
      await todos.deleteByWorkspace(workspace, target);
      await services.savedPrompts.deleteForWorkspace(target);
      // boxes: unlink the destroyed boxes' records from the removed projects.
      await services.boxes?.projects.afterWorkspaceDelete(target).catch((error) => console.error("Failed to unlink the workspace's box records", error));
      // Non-fatal, same as the project delete above: the tree is already gone,
      // so a corrupt workspaces.json must not report a 500 for a delete that
      // actually succeeded.
      await mutateWorkspacesMeta(resolved.workspacesMetaFile, (meta) => {
        meta.workspaces = meta.workspaces.filter((w) => w.name !== workspace);
      }).catch((error) =>
        console.error("Failed to prune workspace from workspaces meta", error)
      );

      return reply.code(204).send();
    }
  );

  // App config (app.json) + remote servers (remotes.json) live on the daemon so
  // they're shared across every client connected to it. Editable on any transport.
  app.get("/api/config/app", async (): Promise<AppConfig> => readAppConfigFile(resolved.appConfigFile));

  app.put("/api/config/app", async (request, reply): Promise<AppConfig | void> => {
    const current = await readAppConfigFile(resolved.appConfigFile);
    // The file as written, unknown fields included; a missing or unreadable one is the defaults.
    let raw: unknown = current;
    try {
      raw = JSON.parse(await readFile(resolved.appConfigFile, "utf8")) as unknown;
    } catch {
      raw = current;
    }
    try {
      // Field-wise per group, keeping what this build or the client does not know
      // (`applyAppConfigUpdate`): an older client's `{agents}` lacks newer fields.
      const { config: merged, stored } = applyAppConfigUpdate(raw, request.body);
      await writeJsonFile(resolved.appConfigFile, stored);
      // A usage-limit setting moved: armed chats follow at once (off disarms, on re-arms).
      if (
        merged.agents.autoResumeLimitedChats !== current.agents.autoResumeLimitedChats ||
        merged.agents.switchAccountOnUsageLimit !== current.agents.switchAccountOnUsageLimit
      ) {
        services.limitRecovery?.prefsChanged({
          autoResume: merged.agents.autoResumeLimitedChats,
          switchAccount: merged.agents.switchAccountOnUsageLimit
        });
      }
      // The idle-compaction setting moved: armed chats follow at once (off cancels, on arms).
      if (
        merged.agents.claudeIdleCompaction !== current.agents.claudeIdleCompaction ||
        JSON.stringify(merged.agents.claudeIdleCompactionByAccount) !==
          JSON.stringify(current.agents.claudeIdleCompactionByAccount)
      ) {
        services.idleCompaction?.prefsChanged();
      }
      return merged;
    } catch {
      return reply.code(400).send({ code: "INVALID_CONFIG", message: "Invalid app config." });
    }
  });

  app.get(
    "/api/config/remotes",
    async (): Promise<RemoteConnectionConfig[]> =>
      (await readRemotesFile(resolved.remotesFile)).remotes
  );

  app.put("/api/config/remotes", async (request, reply): Promise<RemoteConnectionConfig[] | void> => {
    try {
      const parsed = parseRemotesConfig({
        version: 1,
        remotes: Array.isArray(request.body) ? request.body : []
      });
      await writeJsonFile(resolved.remotesFile, parsed);
      return parsed.remotes;
    } catch {
      return reply.code(400).send({ code: "INVALID_CONFIG", message: "Invalid remotes config." });
    }
  });

  // Connected git accounts. Unlike PUT /api/config/daemon (unix-socket-only),
  // these ARE allowed over remote HTTP: the transport is TLS + password gated,
  // and no response ever returns the private key or the PAT — an authenticated
  // client can create/bind accounts but cannot exfiltrate key material.
  app.get("/api/accounts", async (): Promise<AccountSummary[]> => accounts.list());

  app.post("/api/accounts", async (request, reply): Promise<AccountSummary | void> => {
    try {
      return await accounts.add((request.body ?? {}) as CreateAccountRequest);
    } catch (error) {
      const status = error instanceof AccountError ? error.status : 500;
      const message = error instanceof Error ? error.message : "Could not connect the account.";
      return reply.code(status).send({ code: "ACCOUNT_ERROR", message });
    }
  });

  app.delete<{ Params: { id: string } }>(
    "/api/accounts/:id",
    async (request, reply): Promise<void> => {
      try {
        const bound = (await readWorkspacesMeta(resolved.workspacesMetaFile)).workspaces
          .filter((w) => w.gitAccountId === request.params.id)
          .map((w) => w.name);
        await accounts.remove(request.params.id, bound);
        return reply.code(204).send();
      } catch (error) {
        const status = error instanceof AccountError ? error.status : 500;
        const message = error instanceof Error ? error.message : "Could not remove the account.";
        return reply.code(status).send({ code: "ACCOUNT_ERROR", message });
      }
    }
  );

  app.post<{ Params: { id: string } }>(
    "/api/accounts/:id/test",
    async (request, reply): Promise<AccountTestResult | void> => {
      try {
        return await accounts.test(request.params.id);
      } catch (error) {
        const status = error instanceof AccountError ? error.status : 500;
        const message = error instanceof Error ? error.message : "Could not test the account.";
        return reply.code(status).send({ code: "ACCOUNT_ERROR", message });
      }
    }
  );

  // Set/replace an account's provider token (for REST list/create repos).
  // Validated against the account's login; stored at rest (0600), never returned.
  // `tokenExpiresAt` is user-entered (Bitbucket tokens always expire).
  app.post<{ Params: { id: string }; Body: { token?: string; tokenExpiresAt?: string } }>(
    "/api/accounts/:id/token",
    async (request, reply): Promise<void> => {
      try {
        await accounts.setToken(
          request.params.id,
          request.body?.token ?? "",
          request.body?.tokenExpiresAt
        );
        return reply.code(204).send();
      } catch (error) {
        const status = error instanceof AccountError ? error.status : 500;
        const message = error instanceof Error ? error.message : "Could not save the token.";
        return reply.code(status).send({ code: "ACCOUNT_ERROR", message });
      }
    }
  );

  // Bitbucket DC manual key-upload flow: the user pasted the public key on the
  // instance; verify it landed and clear the pending flag.
  app.post<{ Params: { id: string } }>(
    "/api/accounts/:id/confirm-key",
    async (request, reply): Promise<AccountSummary | void> => {
      try {
        return await accounts.confirmKey(request.params.id);
      } catch (error) {
        const status = error instanceof AccountError ? error.status : 500;
        const message = error instanceof Error ? error.message : "Key confirmation failed.";
        return reply.code(status).send({ code: "ACCOUNT_ERROR", message });
      }
    }
  );

  // List repos the account can reach (owner/collaborator/org member). 400 if the
  // account has no token (repoAccess:false).
  app.get<{ Params: { id: string } }>(
    "/api/accounts/:id/repos",
    async (request, reply): Promise<RepoSummary[] | void> => {
      try {
        return await accounts.listRepos(request.params.id);
      } catch (error) {
        const status = error instanceof AccountError ? error.status : 500;
        const message = error instanceof Error ? error.message : "Could not list repositories.";
        return reply.code(status).send({ code: "ACCOUNT_ERROR", message });
      }
    }
  );

  // Owners the account can create repos under (create-owner picker): the user +
  // GitHub orgs, Bitbucket Cloud workspaces, or DC projects. 400 if no token.
  app.get<{ Params: { id: string } }>(
    "/api/accounts/:id/orgs",
    async (request, reply): Promise<OwnerSummary[] | void> => {
      try {
        return await accounts.listOwners(request.params.id);
      } catch (error) {
        const status = error instanceof AccountError ? error.status : 500;
        const message = error instanceof Error ? error.message : "Could not list owners.";
        return reply.code(status).send({ code: "ACCOUNT_ERROR", message });
      }
    }
  );

  // boxes: a path inside a box project is answered by the box before the handlers below run
  // (one preHandler hook, boxes/remote/fs/routes.ts); host paths reach them unchanged.
  registerBoxFsRouting(app, {
    boxes: () => services.boxRegistry,
    fsRoot: () => resolved.fsRoot,
    rawMaxBytes: RAW_MAX_BYTES,
    closeUnder: async (safe, raw) => {
      sessions.closeByProjectPrefix(safe);
      sessions.closeByProjectPrefix(raw);
      await services.browsers.closeForProject(safe, raw);
      await services.desktops.closeForProject(safe);
    }
  });

  // File browser: list a directory.
  app.get<{ Querystring: { path?: string; p?: string } }>(
    "/api/fs",
    async (request, reply): Promise<FsListResponse | void> => {
      const path = fsPathFromQuery(request.query);
      if (!path) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: "path required." });
      }
      try {
        const safe = await assertInsideFsRoot(resolved.fsRoot, path);
        return await listFiles(safe);
      } catch (error) {
        if (error instanceof FsSandboxError) {
          return reply.code(403).send({ code: "FS_FORBIDDEN", message: error.message });
        }
        return reply.code(400).send({
          code: "FS_ERROR",
          message: error instanceof Error ? error.message : "Cannot read directory."
        });
      }
    }
  );

  // File browser: recursive file listing for search / quick-open.
  app.get<{ Querystring: { path?: string; p?: string; includeIgnored?: string } }>(
    "/api/fs/files",
    async (request, reply): Promise<FsFilesResponse | void> => {
      const path = fsPathFromQuery(request.query);
      if (!path) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: "path required." });
      }
      const abort = new AbortController();
      const onClose = () => abort.abort();
      reply.raw.on("close", onClose);
      try {
        const safe = await assertInsideFsRoot(resolved.fsRoot, path);
        return await listProjectFiles(resolved.fsRoot, safe, {
          includeIgnored: request.query.includeIgnored === "1",
          signal: abort.signal
        });
      } catch (error) {
        if (abort.signal.aborted) return;
        if (error instanceof FsSandboxError) {
          return reply.code(403).send({ code: "FS_FORBIDDEN", message: error.message });
        }
        if (error instanceof FsSearchError) {
          return reply.code(error.status).send({ code: error.code, message: error.message });
        }
        return reply.code(400).send({
          code: "FS_ERROR",
          message: error instanceof Error ? error.message : "Cannot list project files."
        });
      } finally {
        reply.raw.off("close", onClose);
      }
    }
  );

  // File browser: content search across a project subtree.
  app.get<{
    Querystring: {
      path?: string; p?: string;
      q?: string;
      caseSensitive?: string;
      wholeWord?: string;
      regex?: string;
      include?: string;
      exclude?: string;
      maxResults?: string;
      includeIgnored?: string;
    };
  }>(
    "/api/fs/search",
    async (request, reply): Promise<FsSearchResponse | void> => {
      const { q } = request.query;
      const path = fsPathFromQuery(request.query);
      if (!path || !q) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: "path and q required." });
      }
      const abort = new AbortController();
      const onClose = () => abort.abort();
      reply.raw.on("close", onClose);
      try {
        const safe = await assertInsideFsRoot(resolved.fsRoot, path);
        // `engine` is deliberately NOT read from the query: backend selection is an
        // internal/test seam, never client-controlled.
        return await searchProjectFiles(resolved.fsRoot, safe, {
          query: q,
          caseSensitive: request.query.caseSensitive === "1",
          wholeWord: request.query.wholeWord === "1",
          regex: request.query.regex === "1",
          include: request.query.include,
          exclude: request.query.exclude,
          maxResults: request.query.maxResults,
          includeIgnored: request.query.includeIgnored === "1",
          signal: abort.signal
        });
      } catch (error) {
        if (abort.signal.aborted) return;
        if (error instanceof FsSandboxError) {
          return reply.code(403).send({ code: "FS_FORBIDDEN", message: error.message });
        }
        if (error instanceof FsSearchError) {
          return reply
            .code(error.status)
            .send({ code: error.code, message: error.message, ...(error.field ? { field: error.field } : {}) });
        }
        return reply.code(400).send({
          code: "FS_ERROR",
          message: error instanceof Error ? error.message : "Cannot search files."
        });
      } finally {
        reply.raw.off("close", onClose);
      }
    }
  );

  // Read a file's text content (capped at 1 MB).
  app.get<{ Querystring: { path?: string; p?: string } }>(
    "/api/fs/read",
    async (request, reply): Promise<FsReadResponse | void> => {
      const path = fsPathFromQuery(request.query);
      if (!path) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: "path required." });
      }
      try {
        const safe = await assertInsideFsRoot(resolved.fsRoot, path);
        const buffer = await readFile(safe);
        const cap = 1024 * 1024;
        return {
          path: safe,
          content: buffer.subarray(0, cap).toString("utf8"),
          size: buffer.length,
          truncated: buffer.length > cap
        };
      } catch (error) {
        if (error instanceof FsSandboxError) {
          return reply.code(403).send({ code: "FS_FORBIDDEN", message: error.message });
        }
        return reply.code(400).send({
          code: "FS_ERROR",
          message: error instanceof Error ? error.message : "Cannot read file."
        });
      }
    }
  );

  // Read a file's RAW bytes (binary-safe, no decode) for the preview viewers.
  // Capped at RAW_MAX_BYTES; the client picks the real MIME and rewraps the
  // bytes in a typed Blob, so octet-stream here is both safe and sufficient.
  app.get<{ Querystring: { path?: string; p?: string } }>("/api/fs/raw", async (request, reply) => {
    const path = fsPathFromQuery(request.query);
    if (!path) {
      void reply.code(400).send({ code: "INVALID_REQUEST", message: "path required." });
      return;
    }
    try {
      const safe = await assertInsideFsRoot(resolved.fsRoot, path);
      const info = await stat(safe);
      if (!info.isFile()) {
        void reply.code(400).send({ code: "FS_ERROR", message: "Not a file." });
        return;
      }
      if (info.size > RAW_MAX_BYTES) {
        void reply.code(413).send({
          code: "FS_TOO_LARGE",
          message: `File exceeds the ${Math.floor(RAW_MAX_BYTES / (1024 * 1024))} MB preview limit.`
        });
        return;
      }
      const buffer = await readFile(safe);
      void reply.header("X-Content-Type-Options", "nosniff").type("application/octet-stream").send(buffer);
    } catch (error) {
      if (error instanceof FsSandboxError) {
        void reply.code(403).send({ code: "FS_FORBIDDEN", message: error.message });
        return;
      }
      void reply.code(400).send({
        code: "FS_ERROR",
        message: error instanceof Error ? error.message : "Cannot read file."
      });
    }
  });

  // List an archive's contents (no extraction) for the preview viewer.
  app.get<{ Querystring: { path?: string; p?: string } }>("/api/fs/archive", async (request, reply) => {
    const path = fsPathFromQuery(request.query);
    if (!path) {
      void reply.code(400).send({ code: "INVALID_REQUEST", message: "path required." });
      return;
    }
    try {
      const safe = await assertInsideFsRoot(resolved.fsRoot, path);
      void reply.send(await listArchiveEntries(safe));
    } catch (error) {
      if (error instanceof FsSandboxError) {
        void reply.code(403).send({ code: "FS_FORBIDDEN", message: error.message });
        return;
      }
      void reply.code(400).send({
        code: "FS_ERROR",
        message: error instanceof Error ? error.message : "Cannot read archive."
      });
    }
  });

  // Read a parquet file's schema + a window of rows for the preview viewer.
  // Windowed server-side (hyparquet random-access) — no file-size cap; sort
  // (orderBy/desc) is served from a cached row order after the first scan.
  app.get<{
    Querystring: { path?: string; p?: string; offset?: string; limit?: string; orderBy?: string; desc?: string };
  }>("/api/fs/parquet", async (request, reply) => {
    const { offset, limit, orderBy, desc } = request.query;
    const path = fsPathFromQuery(request.query);
    if (!path) {
      void reply.code(400).send({ code: "INVALID_REQUEST", message: "path required." });
      return;
    }
    try {
      const safe = await assertInsideFsRoot(resolved.fsRoot, path);
      const info = await stat(safe);
      if (!info.isFile()) {
        void reply.code(400).send({ code: "FS_ERROR", message: "Not a file." });
        return;
      }
      void reply.send(
        await readParquetWindow(safe, {
          offset: offset === undefined ? undefined : Number(offset),
          limit: limit === undefined ? undefined : Number(limit),
          orderBy,
          desc: desc === "1"
        })
      );
    } catch (error) {
      if (error instanceof FsSandboxError) {
        void reply.code(403).send({ code: "FS_FORBIDDEN", message: error.message });
        return;
      }
      if (error instanceof ParquetRequestError) {
        void reply.code(400).send({ code: "FS_ERROR", message: error.message });
        return;
      }
      void reply.code(400).send({
        code: "FS_ERROR",
        message: error instanceof Error ? error.message : "Cannot read parquet file."
      });
    }
  });

  // File-browser capabilities probe: whether the server can zip a folder for
  // download (a zip tool is on PATH). Single-file download never needs a tool.
  app.get("/api/fs/capabilities", async (): Promise<FsCapabilitiesResponse> => {
    const tool = resolveZipTool();
    return { folderZip: tool !== null, zipTool: tool?.bin ?? null };
  });

  // Download a file (streamed, uncapped) or a folder (zipped on the fly via a
  // host tool, streamed). Distinct from /api/fs/raw, which is the 50 MB-capped,
  // in-memory inline-preview route. Auth: this route also accepts ?token= (see
  // the onRequest hook) so a native <a download> works without a header.
  app.get<{ Querystring: { path?: string; p?: string } }>("/api/fs/download", async (request, reply) => {
    const path = fsPathFromQuery(request.query);
    if (!path) {
      void reply.code(400).send({ code: "INVALID_REQUEST", message: "path required." });
      return;
    }
    let safe: string;
    try {
      safe = await assertInsideFsRoot(resolved.fsRoot, path);
    } catch (error) {
      if (error instanceof FsSandboxError) {
        void reply.code(403).send({ code: "FS_FORBIDDEN", message: error.message });
        return;
      }
      void reply.code(400).send({
        code: "FS_ERROR",
        message: error instanceof Error ? error.message : "Cannot resolve path."
      });
      return;
    }

    let info;
    try {
      info = await stat(safe);
    } catch {
      void reply.code(404).send({ code: "FS_ERROR", message: "Not found." });
      return;
    }
    const name = basename(safe);

    // File: stream the bytes as-is. createReadStream (not readFile) means no
    // memory cap; Content-Length from the stat gives the browser a progress bar.
    if (info.isFile()) {
      // MUST be `return reply.send(stream)`, NOT `void reply.send(stream); return;`.
      // In an async handler a stream send is still piping when the function
      // resolves to `undefined`, so Fastify sends that `undefined` and clobbers
      // the stream — content-length:0, empty body. (A buffer send like
      // /api/fs/raw is immune because it completes inline.) Returning the reply
      // tells Fastify the response is taken.
      return reply
        .header("Content-Disposition", contentDisposition(name))
        .header("Content-Length", String(info.size))
        .header("X-Content-Type-Options", "nosniff")
        .type("application/octet-stream")
        .send(createReadStream(safe));
    }

    // Directory: spawn a zip tool and stream its stdout (hijack pattern, as the
    // session-output route does). Zip size is unknown up front, so it's chunked.
    if (info.isDirectory()) {
      const child = spawnDirZip(safe);
      if (!child) {
        void reply.code(501).send({
          code: "FS_UNSUPPORTED",
          message: "No zip tool (bsdtar/zip/7z) on the server PATH."
        });
        return;
      }
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "application/zip",
        "content-disposition": contentDisposition(`${name}.zip`),
        "x-content-type-options": "nosniff",
        "cache-control": "no-cache"
      });
      // pipe() ends reply.raw when stdout ends. Drain stderr so a chatty tool
      // (zip warns on e.g. empty dirs) can't block on a full pipe. Kill the
      // child if the client disconnects; destroy the socket on a spawn error.
      child.stdout.pipe(reply.raw);
      child.stderr.resume();
      child.on("error", () => reply.raw.destroy());
      // A non-zero exit (e.g. an unreadable subdir) means the zip is incomplete.
      // stdout closing would otherwise end the chunked response cleanly, so the
      // client would see a truncated body as a successful 200. Destroy the socket
      // instead so the aborted transfer fails visibly. Harmless on a clean exit
      // (code 0 → no-op; destroy() on an already-finished socket is idempotent).
      child.on("close", (code) => {
        if (code) reply.raw.destroy();
      });
      request.raw.on("close", () => child.kill());
      return;
    }

    void reply.code(400).send({ code: "FS_ERROR", message: "Not a file or folder." });
  });

  // Write (save) a file's text content.
  app.put("/api/fs/write", async (request, reply): Promise<{ ok: true } | void> => {
    const body = (request.body ?? {}) as Partial<FsWriteRequest>;
    if (!body.path || typeof body.content !== "string") {
      return reply.code(400).send({ code: "INVALID_REQUEST", message: "path and content required." });
    }
    try {
      const safe = await assertInsideFsRoot(resolved.fsRoot, body.path);
      await writeFile(safe, body.content, "utf8");
      return { ok: true };
    } catch (error) {
      if (error instanceof FsSandboxError) {
        return reply.code(403).send({ code: "FS_FORBIDDEN", message: error.message });
      }
      return reply.code(400).send({
        code: "FS_ERROR",
        message: error instanceof Error ? error.message : "Cannot write file."
      });
    }
  });

  // Create a file or directory.
  app.post("/api/fs/create", async (request, reply): Promise<{ ok: true } | void> => {
    const body = (request.body ?? {}) as Partial<FsCreateRequest>;
    if (!body.path || (body.kind !== "file" && body.kind !== "dir")) {
      return reply.code(400).send({ code: "INVALID_REQUEST", message: "path and kind required." });
    }
    try {
      const safe = await assertInsideFsRoot(resolved.fsRoot, body.path);
      if (body.kind === "dir") {
        await mkdir(safe, { recursive: true });
        await notifyWorkspacesChanged(dirname(safe));
      } else {
        await mkdir(dirname(safe), { recursive: true });
        await writeFile(safe, "", { flag: "wx" });
      }
      return { ok: true };
    } catch (error) {
      if (error instanceof FsSandboxError) {
        return reply.code(403).send({ code: "FS_FORBIDDEN", message: error.message });
      }
      return reply.code(400).send({
        code: "FS_ERROR",
        message: error instanceof Error ? error.message : "Cannot create entry."
      });
    }
  });

  // Rename a file or directory in place (same parent dir — not a move). Sibling
  // of /api/fs/create: same fsRoot sandbox + error mapping. A name conflict is a
  // 409 FS_EXISTS (not FS_ERROR) so the client keeps its inline editor open.
  // The sandbox check realpaths the PARENT dir only, keeping the leaf literal:
  // realpathing the entry itself would follow a symlink and rename its target
  // (in the target's directory — pnpm's node_modules is full of such links),
  // and on a case-insensitive FS it folds a case-only rename ("Foo" → "foo")
  // back to the on-disk casing, turning it into a silent no-op. The dev+ino
  // comparison still lets a case-only rename of the same inode through while a
  // real occupant is a 409. Sessions running inside a renamed dir are left
  // alone: their cwd follows the inode.
  app.post("/api/fs/rename", async (request, reply): Promise<{ ok: true } | void> => {
    const body = (request.body ?? {}) as Partial<FsRenameRequest>;
    if (!body.path || typeof body.newName !== "string" || !body.newName.trim()) {
      return reply.code(400).send({ code: "INVALID_REQUEST", message: "path and newName required." });
    }
    const newName = body.newName.trim();
    if (/[\\/]/.test(newName) || newName === "." || newName === "..") {
      return reply
        .code(400)
        .send({ code: "INVALID_REQUEST", message: "newName must be a plain file or folder name." });
    }
    try {
      const realRoot = await realpath(resolved.fsRoot).catch(() => resolve(resolved.fsRoot));
      const resolvedPath = resolve(body.path);
      if (resolvedPath === realRoot || resolvedPath === resolve(resolved.fsRoot)) {
        return reply.code(400).send({ code: "FS_ERROR", message: "Cannot rename the workspaces root." });
      }
      const parent = await assertInsideFsRoot(resolved.fsRoot, dirname(resolvedPath));
      const source = join(parent, basename(resolvedPath));
      if (newName === basename(source)) {
        return { ok: true }; // no-op rename
      }
      // A single validated segment inside the sandboxed parent — inside fsRoot
      // by construction, so no second realpath (which would reintroduce the
      // symlink-follow and case-folding problems above).
      const target = join(parent, newName);
      const sourceStat = await lstat(source); // ENOENT → FS_ERROR below
      const existing = await lstat(target).catch(() => null);
      if (existing && !(existing.dev === sourceStat.dev && existing.ino === sourceStat.ino)) {
        return reply
          .code(409)
          .send({ code: "FS_EXISTS", message: `A file or folder named "${newName}" already exists.` });
      }
      await rename(source, target);
      await notifyWorkspacesChanged(parent);
      return { ok: true };
    } catch (error) {
      if (error instanceof FsSandboxError) {
        return reply.code(403).send({ code: "FS_FORBIDDEN", message: error.message });
      }
      return reply.code(400).send({
        code: "FS_ERROR",
        message: error instanceof Error ? error.message : "Cannot rename entry."
      });
    }
  });

  // Upload one file into the project tree (a folder is many requests from the
  // client). Sibling of /api/fs/create: same fsRoot sandbox + error mapping.
  // The file arrives as a RAW application/octet-stream body with the metadata
  // in the query string; it is streamed to a temp file beside its destination
  // and renamed into place, so memory stays flat whatever the size and the
  // shared MAX_UPLOAD_BYTES cap is enforced by receiveUpload rather than a
  // bodyLimit (see upload-stream.ts). Conflicts are decided AFTER the body has
  // been received: a pre-existing target comes back as { conflict:true } (200,
  // NOT an error) in reply to a completed request, so the client can prompt;
  // "overwrite"/"rename" act only on an explicit user choice. The client
  // supplies destDir + relativePath, but the joined final path is re-sanitized
  // and assertInsideFsRoot'd, so nothing escapes fsRoot.
  app.register(async (scope) => {
    acceptRawBody(scope);
    scope.post<{ Querystring: Partial<FsUploadRequest> }>(
      "/api/fs/upload",
      async (request, reply): Promise<FsUploadResponse | void> => {
        const { destDir, relativePath, onConflict = "error" } = request.query;
        if (!destDir || !relativePath) {
          return refuseUpload(reply, 400, "INVALID_REQUEST", "destDir and relativePath required.");
        }
        if (onConflict !== "error" && onConflict !== "overwrite" && onConflict !== "rename") {
          return refuseUpload(reply, 400, "INVALID_REQUEST", "onConflict must be error, overwrite or rename.");
        }
        // Sanitize the relative path: split on either separator, drop empties,
        // reject any "."/".." segment. assertInsideFsRoot below is authoritative;
        // this is defense in depth + a clean 400 for obvious garbage.
        const segments = relativePath.split(/[\\/]+/).filter((s) => s.length > 0);
        if (segments.length === 0 || segments.some((s) => s === "." || s === "..")) {
          return refuseUpload(reply, 400, "INVALID_REQUEST", "relativePath is invalid.");
        }
        if (declaredLengthExceedsCap(request.headers)) {
          return refuseUpload(reply, 413, "UPLOAD_TOO_LARGE", new UploadTooLargeError().message);
        }
        const leaf = segments[segments.length - 1];
        const fileConflict: FsUploadResponse = { path: "", name: leaf, size: 0, conflict: true, conflictKind: "file" };

        let tmp: string | undefined;
        try {
          const safeDir = await assertInsideFsRoot(resolved.fsRoot, destDir);
          const target = await assertInsideFsRoot(resolved.fsRoot, join(safeDir, ...segments));

          // The temp file lives in the destination dir (same filesystem as the
          // target, so the final rename is atomic). Creating it here — and the
          // relativePath's parent chain below — can hit a path segment that is
          // already a FILE: mkdir fails ENOTDIR/EEXIST, a file/dir type clash
          // surfaced as a conflict the client resolves (Skip / Keep both), not a
          // 500. Other mkdir errors (ENOSPC, EACCES) rethrow to the outer catch.
          try {
            await mkdir(safeDir, { recursive: true });
          } catch (error) {
            const code = (error as NodeJS.ErrnoException)?.code;
            if (code === "ENOTDIR" || code === "EEXIST") {
              reply.header("connection", "close"); // body unread — see refuseUpload
              return fileConflict;
            }
            throw error;
          }
          tmp = uploadTempPath(safeDir);
          const size = await receiveUpload(request.raw, tmp);

          try {
            await mkdir(dirname(target), { recursive: true });
          } catch (error) {
            const code = (error as NodeJS.ErrnoException)?.code;
            if (code === "ENOTDIR" || code === "EEXIST") {
              await discardUpload(tmp);
              return fileConflict;
            }
            throw error;
          }

          if (onConflict === "error") {
            const existing = await stat(target).catch(() => null);
            if (existing) {
              await discardUpload(tmp);
              return { ...fileConflict, conflictKind: existing.isDirectory() ? "dir" : "file" };
            }
            await rename(tmp, target);
            return { path: target, name: leaf, size };
          }

          if (onConflict === "rename") {
            const renamed = await nextAvailableName(target);
            await rename(tmp, renamed);
            return { path: renamed, name: basename(renamed), size };
          }

          // "overwrite" — rename replaces an existing file atomically. EISDIR if
          // a directory is there (the client never offers Replace for a dir
          // clash) → mapped to FS_ERROR below.
          await rename(tmp, target);
          return { path: target, name: leaf, size };
        } catch (error) {
          if (tmp) {
            await discardUpload(tmp);
          }
          if (error instanceof FsSandboxError) {
            return refuseUpload(reply, 403, "FS_FORBIDDEN", error.message);
          }
          if (error instanceof UploadTooLargeError) {
            return refuseUpload(reply, 413, "UPLOAD_TOO_LARGE", error.message);
          }
          const code = (error as NodeJS.ErrnoException)?.code === "ENOSPC" ? 507 : 400;
          return reply.code(code).send({
            code: "FS_ERROR",
            message: error instanceof Error ? error.message : "Cannot store the uploaded file."
          });
        }
      }
    );
  });

  // Delete a file or directory from the project tree. Sibling of /api/fs/create:
  // same fsRoot sandbox + error mapping. `recursive` removes a non-empty dir;
  // `force:false` so a missing path is a real error, not a silent no-op. Refuses
  // to delete the sandbox root itself (resolve the realpath both sides first so a
  // symlinked root can't be matched away).
  app.delete<{ Querystring: { path?: string } }>(
    "/api/fs",
    async (request, reply): Promise<{ ok: true } | void> => {
      const path = request.query.path;
      if (!path) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: "path required." });
      }
      try {
        const safe = await assertInsideFsRoot(resolved.fsRoot, path);
        const realRoot = await realpath(resolved.fsRoot).catch(() => resolve(resolved.fsRoot));
        if (safe === realRoot) {
          return reply.code(400).send({ code: "FS_ERROR", message: "Cannot delete the workspaces root." });
        }
        // Close any sessions rooted at the deleted tree first (like the project/
        // workspace delete routes) so a terminal can't keep running in a now-
        // deleted cwd and leave an orphan tab. Match both the realpath (`safe`)
        // and the raw resolved form — sessions store the raw client-join path.
        sessions.closeByProjectPrefix(safe);
        sessions.closeByProjectPrefix(resolve(path));
        // Browser tabs and desktops rooted in the deleted tree too.
        await services.browsers.closeForProject(safe, resolve(path));
        await services.desktops.closeForProject(safe);
        await rm(safe, { recursive: true, force: false });
        await notifyWorkspacesChanged(dirname(safe));
        return { ok: true };
      } catch (error) {
        if (error instanceof FsSandboxError) {
          return reply.code(403).send({ code: "FS_FORBIDDEN", message: error.message });
        }
        return reply.code(400).send({
          code: "FS_ERROR",
          message: error instanceof Error ? error.message : "Cannot delete entry."
        });
      }
    }
  );

  // Git — a project's repo as a GitHub-Desktop-style tab. Stateless: every route
  // resolves + sandboxes `path` (the project dir) to fsRoot the same way the
  // /api/fs/* routes do, then shells out via GitService. Errors map FsSandboxError
  // → 403 and GitError.status (else 500) → { code:"GIT_ERROR", message } via the
  // shared `gitError` helper. Allowed on both transports (no secret returned),
  // exactly like /api/accounts.

  // Status of the project's repo (isRepo:false — never an error — for non-repos).
  app.get<{ Querystring: { path?: string } }>(
    "/api/git/status",
    async (request, reply): Promise<GitStatusResponse | void> => {
      const path = request.query.path;
      if (!path) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: "path required." });
      }
      try {
        const safe = await assertInsideFsRoot(resolved.fsRoot, path);
        return await git.status(safe);
      } catch (error) {
        return gitError(reply, error);
      }
    }
  );

  // The project's uncommitted changes as ONE patch, cut to `maxBytes` (a saved
  // prompt's `{diff}`), plus its untracked files. isRepo:false — never an
  // error — for non-repos, like status.
  app.get<{ Querystring: { path?: string; maxBytes?: string } }>(
    "/api/git/working-diff",
    async (request, reply): Promise<GitWorkingDiffResponse | void> => {
      const { path, maxBytes } = request.query;
      if (!path) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: "path required." });
      }
      try {
        const safe = await assertInsideFsRoot(resolved.fsRoot, path);
        return await git.workingDiff(safe, workingDiffMaxBytes(typeof maxBytes === "string" ? maxBytes : undefined));
      } catch (error) {
        return gitError(reply, error);
      }
    }
  );

  // Unified diff for one file (working tree, index, or a commit).
  app.get<{ Querystring: { path?: string; file?: string; staged?: string; commit?: string } }>(
    "/api/git/diff",
    async (request, reply): Promise<GitDiffResponse | void> => {
      const { path, file, staged, commit } = request.query;
      if (!path || !file) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: "path and file required." });
      }
      try {
        const safe = await assertInsideFsRoot(resolved.fsRoot, path);
        return await git.diff(safe, file, { staged: staged === "true", commit });
      } catch (error) {
        return gitError(reply, error);
      }
    }
  );

  // Commit log (newest first), paged by skip/limit.
  app.get<{ Querystring: { path?: string; skip?: string; limit?: string } }>(
    "/api/git/log",
    async (request, reply): Promise<GitLogEntry[] | void> => {
      const path = request.query.path;
      if (!path) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: "path required." });
      }
      try {
        const safe = await assertInsideFsRoot(resolved.fsRoot, path);
        const skip = request.query.skip ? Number.parseInt(request.query.skip, 10) : undefined;
        const limit = request.query.limit ? Number.parseInt(request.query.limit, 10) : undefined;
        return await git.log(safe, { skip, limit });
      } catch (error) {
        return gitError(reply, error);
      }
    }
  );

  // Full detail (metadata + per-file stats) for a single commit.
  app.get<{ Querystring: { path?: string; sha?: string } }>(
    "/api/git/commit",
    async (request, reply): Promise<GitCommitDetail | void> => {
      const { path, sha } = request.query;
      if (!path || !sha) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: "path and sha required." });
      }
      try {
        const safe = await assertInsideFsRoot(resolved.fsRoot, path);
        return await git.commitDetail(safe, sha);
      } catch (error) {
        return gitError(reply, error);
      }
    }
  );

  // Local + remote-tracking branches.
  app.get<{ Querystring: { path?: string } }>(
    "/api/git/branches",
    async (request, reply): Promise<GitBranchesResponse | void> => {
      const path = request.query.path;
      if (!path) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: "path required." });
      }
      try {
        const safe = await assertInsideFsRoot(resolved.fsRoot, path);
        return await git.branches(safe);
      } catch (error) {
        return gitError(reply, error);
      }
    }
  );

  // Stage files (or everything when `files` is empty).
  app.post<{ Body: { path?: string; files?: string[] } }>(
    "/api/git/stage",
    async (request, reply): Promise<GitOpResult | void> => {
      const { path, files } = request.body ?? {};
      if (!path) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: "path required." });
      }
      try {
        const safe = await assertInsideFsRoot(resolved.fsRoot, path);
        return await git.stage(safe, files ?? []);
      } catch (error) {
        return gitError(reply, error);
      }
    }
  );

  // Unstage files (or the whole index when `files` is empty).
  app.post<{ Body: { path?: string; files?: string[] } }>(
    "/api/git/unstage",
    async (request, reply): Promise<GitOpResult | void> => {
      const { path, files } = request.body ?? {};
      if (!path) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: "path required." });
      }
      try {
        const safe = await assertInsideFsRoot(resolved.fsRoot, path);
        return await git.unstage(safe, files ?? []);
      } catch (error) {
        return gitError(reply, error);
      }
    }
  );

  // Commit the staged changes (identity comes from ambient/includeIf config).
  app.post<{ Body: { path?: string; summary?: string; description?: string } }>(
    "/api/git/commit",
    async (request, reply): Promise<GitOpResult | void> => {
      const { path, summary, description } = request.body ?? {};
      if (!path) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: "path required." });
      }
      try {
        const safe = await assertInsideFsRoot(resolved.fsRoot, path);
        return await git.commit(safe, summary ?? "", description);
      } catch (error) {
        return gitError(reply, error);
      }
    }
  );

  // Discard working-tree changes for the given files (destructive; client-gated).
  app.post<{ Body: { path?: string; files?: string[] } }>(
    "/api/git/discard",
    async (request, reply): Promise<GitOpResult | void> => {
      const { path, files } = request.body ?? {};
      if (!path) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: "path required." });
      }
      try {
        const safe = await assertInsideFsRoot(resolved.fsRoot, path);
        return await git.discard(safe, files ?? []);
      } catch (error) {
        return gitError(reply, error);
      }
    }
  );

  // Fetch all remotes (prune stale tracking refs).
  app.post<{ Body: { path?: string } }>(
    "/api/git/fetch",
    async (request, reply): Promise<GitOpResult | void> => {
      const path = request.body?.path;
      if (!path) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: "path required." });
      }
      try {
        const safe = await assertInsideFsRoot(resolved.fsRoot, path);
        return await git.fetch(safe);
      } catch (error) {
        return gitError(reply, error);
      }
    }
  );

  // Pull (fast-forward/merge, no editor).
  app.post<{ Body: { path?: string } }>(
    "/api/git/pull",
    async (request, reply): Promise<GitOpResult | void> => {
      const path = request.body?.path;
      if (!path) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: "path required." });
      }
      try {
        const safe = await assertInsideFsRoot(resolved.fsRoot, path);
        return await git.pull(safe);
      } catch (error) {
        return gitError(reply, error);
      }
    }
  );

  // Push the current branch.
  app.post<{ Body: { path?: string } }>(
    "/api/git/push",
    async (request, reply): Promise<GitOpResult | void> => {
      const path = request.body?.path;
      if (!path) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: "path required." });
      }
      try {
        const safe = await assertInsideFsRoot(resolved.fsRoot, path);
        return await git.push(safe);
      } catch (error) {
        return gitError(reply, error);
      }
    }
  );

  // Switch branches.
  app.post<{ Body: { path?: string; branch?: string } }>(
    "/api/git/checkout",
    async (request, reply): Promise<GitOpResult | void> => {
      const { path, branch } = request.body ?? {};
      if (!path) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: "path required." });
      }
      try {
        const safe = await assertInsideFsRoot(resolved.fsRoot, path);
        return await git.checkout(safe, branch ?? "");
      } catch (error) {
        return gitError(reply, error);
      }
    }
  );

  // Stashes. Mutations address a stash by its POSITION in `git stash list`; the
  // daemon builds the `stash@{n}` ref itself so no client can name a raw
  // revision through these routes.
  app.get<{ Querystring: { path?: string } }>(
    "/api/git/stashes",
    async (request, reply): Promise<GitStashEntry[] | void> => {
      const path = request.query.path;
      if (!path) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: "path required." });
      }
      try {
        const safe = await assertInsideFsRoot(resolved.fsRoot, path);
        return await git.stashList(safe);
      } catch (error) {
        return gitError(reply, error);
      }
    }
  );

  // Stash the working tree (optionally including untracked files).
  app.post<{ Body: Partial<GitStashCreateRequest> }>(
    "/api/git/stash",
    async (request, reply): Promise<GitOpResult | void> => {
      const { path, message, includeUntracked } = request.body ?? {};
      if (!path) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: "path required." });
      }
      try {
        const safe = await assertInsideFsRoot(resolved.fsRoot, path);
        return await git.stashCreate(safe, { message, includeUntracked });
      } catch (error) {
        return gitError(reply, error);
      }
    }
  );

  // Apply / pop / drop one stash. Same body shape for all three: the POSITION in
  // the list plus the SHA the client saw there. The index alone is a racy handle
  // (another client can push/drop a stash and shift the list under this one, so a
  // Drop would destroy an unrelated, unrecoverable stash) — the service re-checks
  // that `stash@{index}` still resolves to `sha` and answers 409 otherwise.
  for (const [suffix, run] of [
    ["apply", (cwd: string, index: number, sha: string) => git.stashApply(cwd, index, sha)],
    ["pop", (cwd: string, index: number, sha: string) => git.stashPop(cwd, index, sha)],
    ["drop", (cwd: string, index: number, sha: string) => git.stashDrop(cwd, index, sha)]
  ] as const) {
    app.post<{ Body: Partial<GitStashActionRequest> }>(
      `/api/git/stash/${suffix}`,
      async (request, reply): Promise<GitOpResult | void> => {
        const { path, index, sha } = request.body ?? {};
        if (!path || typeof index !== "number" || !sha) {
          return reply
            .code(400)
            .send({ code: "INVALID_REQUEST", message: "path, index and sha required." });
        }
        try {
          const safe = await assertInsideFsRoot(resolved.fsRoot, path);
          return await run(safe, index, sha);
        } catch (error) {
          return gitError(reply, error);
        }
      }
    );
  }

  // System status — host resources, every process on the host (this daemon's own
  // tree marked managed), and the TCP ports the managed processes listen on.
  // Linux-only (all three read /proc); off Linux each route answers
  // `supported: false`, mirroring /api/fs/capabilities' host gating. Everything
  // is best-effort: a /proc entry that vanished mid-scan is skipped, never a
  // 500. No background poller — resources are computed on demand
  // behind a short cache (the Broadcaster exposes no client-count signal to gate
  // one on, and an always-on poller on a VPS is not worth the wakeups).
  const systemStatus = new SystemStatusService({
    fsRoot: resolved.fsRoot,
    tmuxSocket: resolved.tmuxSocket,
    listSessionIds: () => new Set(sessions.list().map((session) => session.id)),
    // The agent host is infrastructure, not a user process: refuse it the way
    // the tmux server is refused (chat spec §3.1 "Kill guard"). Provider
    // CHILDREN stay legal targets — see `extraRootPids` below, which is what
    // actually makes them reachable on a tmux host.
    protectedPids: () => {
      const pids: Array<{ pid: number; label: string; role: "agent-host" }> = [];
      for (const hostPid of services.agentChat?.protectedPids() ?? []) {
        pids.push({ pid: hostPid, label: "the agent host that runs your chat threads", role: "agent-host" });
      }
      return pids;
    },
    // The agent host runs in the `orqsvc-agent-host` service session, which
    // `panePids()` excludes from the daemon-tree roots — so without this a
    // runaway `codex`/`opencode` child of a chat thread answers
    // PROCESS_NOT_MANAGED, contradicting §3.1.
    extraRootPids: () => services.agentChat?.protectedPids() ?? []
  });

  app.get("/api/system/resources", async (): Promise<SystemResourcesResponse> => systemStatus.resources());

  // `?scope=host` lists the whole host; without it only the daemon's own tree,
  // which is all a client that predates whole-host listing knows how to show.
  app.get<{ Querystring: { scope?: string } }>(
    "/api/system/processes",
    async (request): Promise<SystemProcessesResponse> =>
      systemStatus.processes(request.query.scope === "host" ? "host" : "tree")
  );

  // One process' expanded row: exe, cwd, open fds and cgroup, read on demand.
  app.get<{ Params: { pid: string } }>(
    "/api/system/processes/:pid",
    async (request, reply): Promise<SystemProcessDetailsResponse | KillProcessErrorResponse> => {
      const details = await systemStatus.processDetails(Number(request.params.pid));
      return details ?? reply.code(400).send({ code: "INVALID_PID", message: "Invalid pid." });
    }
  );

  // Guarded kill: refused for any pid outside this daemon's tree, and for the
  // daemon and the tmux server themselves (see SystemStatusService.kill).
  // SIGTERM unless the body asks for SIGKILL. The service's own code is passed
  // through verbatim so a client can distinguish a bad request from a protected
  // target from an unsupported host.
  app.post<{ Body: Partial<KillProcessRequest> }>(
    "/api/system/processes/kill",
    async (request, reply): Promise<KillProcessResponse | KillProcessErrorResponse> => {
      const result = await systemStatus.kill(Number(request.body?.pid), request.body?.signal ?? "SIGTERM");
      if (!result.ok) {
        return reply.code(400).send({ code: result.code, message: result.error });
      }
      return { ok: true, killed: result.killed, signal: result.signal };
    }
  );

  app.get("/api/system/ports", async (): Promise<SystemPortsResponse> => systemStatus.ports());

  // Past conversations of every installed agent for one project, merged and
  // newest-first, read out of each CLI's own history dir. Fail-soft on purpose:
  // a missing/invalid/out-of-sandbox path or an unreadable history answers with
  // an empty list rather than an error — this only feeds a "resume" picker.
  app.get<{ Querystring: { path?: string } }>(
    "/api/agents/conversations",
    async (request): Promise<AgentConversationsResponse> => {
      const path = request.query.path;
      if (!path) {
        return { conversations: [] };
      }
      try {
        // Sandbox gate only. The LOOKUP uses the lexical path, not the realpath
        // this returns: agents key their history by the path a session was
        // launched with, which is the workspaces path as listed to the client.
        await assertInsideFsRoot(resolved.fsRoot, path);
        // daemonDir lets the scan reach the MANAGED agent homes
        // (agent-accounts/<family>/<id>/home), not just
        // the daemon's own HOME — most sessions here run under one of those.
        return {
          conversations: await listAgentConversations(resolve(path), {
            daemonDir: resolved.daemonDir,
            accountIds: new Set(agentAccounts.list().accounts.map((account) => account.id))
          })
        };
      } catch {
        return { conversations: [] };
      }
    }
  );

  // Registry (shells & agents)
  app.get("/api/registry", async (): Promise<RegistryResponse> => registry.list());

  // Project scaffold templates: the static catalog plus this host's availability.
  // Probed per request rather than cached, so a tool installed from a terminal
  // session (npm/uv/cargo) lights its template up on the next modal open. The
  // command itself is never run here — the client types it into a terminal tab,
  // so availability is probed against the SESSION PATH (which prepends
  // ~/.local/bin, ~/.cargo/bin, ~/go/bin, … to the daemon's narrow systemd PATH)
  // rather than the daemon's own: the card must match what that shell can run.
  app.get("/api/templates", async (): Promise<ProjectTemplatesResponse> => {
    const path = sessionPath();
    return {
      templates: TEMPLATES.map((t) => {
        const missing = t.requires.filter((bin) => !isBinOnPath(bin, path));
        return {
          id: t.id,
          name: t.name,
          category: t.category,
          icon: t.icon,
          requires: [...t.requires],
          variants: t.variants.map((v) => ({
            id: v.id,
            name: v.name,
            icon: v.icon,
            command: v.command,
            options: v.options.map((o) => ({ ...o }))
          })),
          available: missing.length === 0,
          missing
        };
      })
    };
  });

  app.get<{ Querystring: { refresh?: string } }>("/api/usage", async (request): Promise<UsageResponse> =>
    usage.snapshot(request.query.refresh === "1")
  );

  app.get("/api/usage/tokens", async (request) => {
    const force = (request.query as { refresh?: string })?.refresh === "1";
    return usageTokens.snapshot(force);
  });

  // Grok's usage from Orquester's own chat logs ("Orquester chats only"): get_usage's weekly cost.
  app.get<{ Querystring: { agent?: string } }>("/api/usage/chat-threads", async (request, reply) => {
    const agent = request.query.agent;
    if (agent !== "grok") return reply.code(400).send({ code: "INVALID_REQUEST", message: "agent must be grok." });
    if (!services.chatThreadUsage) return reply.code(503).send({ code: "UNAVAILABLE", message: "Chat usage is not available." });
    return services.chatThreadUsage.snapshot(agent);
  });

  // Read fresh, like a launch does: this is what the next Claude session gets.
  app.get("/api/usage/subagent-cache-ttl", async (): Promise<SubagentCacheTtlStatus> =>
    subagentCacheTtl.status((await readAppConfigFile(resolved.appConfigFile)).agents.claudeSubagentCacheTtl)
  );

  // Managed agent accounts (Claude/Codex credential homes) — import/list/remove/defaults.
  app.get("/api/agent-accounts", async () => {
    await agentAccounts.refreshLoginStatuses();
    return agentAccounts.list();
  });

  app.post("/api/agent-accounts", async (request, reply) => {
    const body = (request.body ?? {}) as ImportAgentAccountRequest;
    // Reading an arbitrary host path bypasses the /api/fs sandbox, so allow it
    // only over the local unix socket; remote clients must upload `content`.
    if (options.mode === "remote" && body.from?.trim()) {
      return reply.code(403).send({
        error: "Importing from a host path is only allowed locally over the unix socket; upload the file content instead."
      });
    }
    try {
      // `fromSystem: "grok"` adopts the host's own terminal `grok login` — a
      // FIXED server-side path (no traversal surface), so it stays allowed on
      // the remote transport where arbitrary `from` paths are refused above.
      if (body.fromSystem === "grok") {
        const from = join(process.env.GROK_HOME || join(resolved.vars.userhome, ".grok"), "auth.json");
        try {
          return await agentAccounts.importAccount({ from, label: body.label });
        } catch (error) {
          if ((error as { code?: string }).code === "ENOENT") {
            return reply.code(400).send({
              error: "No grok login found on the server — run `grok login` in a terminal first."
            });
          }
          throw error;
        }
      }
      return await agentAccounts.importAccount(body);
    } catch (error) {
      if (error instanceof AgentAccountError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });

  app.delete("/api/agent-accounts/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    // A session still running under the account would write its next line into
    // the deleted home and re-create it as an orphan, so it goes first.
    if (sessions.liveAccountIds().has(id)) {
      const titles = sessions
        .list()
        .filter((session) => session.accountId === id)
        .map((session) => `"${session.title}"`);
      return reply.code(409).send({
        error: `This account is still in use by ${titles.length > 0 ? titles.join(", ") : "an open tab"}. Close ${titles.length === 1 ? "that tab" : "those tabs"} first, then remove it.`
      });
    }
    try {
      await agentAccounts.removeAccount(id);
      return { ok: true };
    } catch (error) {
      if (error instanceof AgentAccountError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });

  // The Grok and Codex accounts' device-code links. Start answers the prompt to
  // show the user and polls the provider in the background; the state moves on
  // the agent-accounts channel (`<agent>-link.changed`), and a granted link
  // becomes a managed account (`agent-accounts.changed`).
  for (const [agent, link] of [
    ["grok", services.grokDeviceLink],
    ["codex", services.codexDeviceLink]
  ] as const) {
    app.get(`/api/agent-accounts/${agent}/link`, async (): Promise<DeviceLinkStatus> => link.status());

    app.post(`/api/agent-accounts/${agent}/link`, async (_request, reply): Promise<DeviceLink | undefined> => {
      const res = await link.start();
      if (!res.ok) return reply.code(res.code === "conflict" ? 409 : 502).send({ error: res.error });
      return res.link;
    });

    app.delete(`/api/agent-accounts/${agent}/link`, async (): Promise<DeviceLinkStatus> => link.cancel());
  }

  // The Claude account's sign-in link. Start answers the Claude.ai authorize
  // URL; the code its callback page shows comes back on `/code`, and the
  // daemon exchanges it for a managed account. State moves on
  // `claude-link.changed`.
  app.get("/api/agent-accounts/claude/link", async (): Promise<ClaudeOAuthLinkStatus> => services.claudeOAuthLink.status());

  app.post("/api/agent-accounts/claude/link", async (_request, reply): Promise<ClaudeOAuthLink | undefined> => {
    const res = services.claudeOAuthLink.start();
    if (!res.ok) return reply.code(409).send({ error: res.error });
    return res.link;
  });

  app.post("/api/agent-accounts/claude/link/code", async (request, reply): Promise<AgentAccount | undefined> => {
    const body = (request.body ?? {}) as Partial<SubmitClaudeOAuthCodeRequest>;
    if (typeof body.code !== "string" || !body.code.trim()) {
      return reply.code(400).send({ error: "Paste the code from the Claude sign-in page." });
    }
    const res = await services.claudeOAuthLink.submit(body.code);
    if (!res.ok) {
      const status = { idle: 409, conflict: 409, invalid: 400, upstream: 502 }[res.code];
      return reply.code(status).send({ error: res.error });
    }
    return res.account;
  });

  app.delete("/api/agent-accounts/claude/link", async (): Promise<ClaudeOAuthLinkStatus> => services.claudeOAuthLink.cancel());

  app.put("/api/agent-accounts/defaults", async (request, reply) => {
    const body = (request.body ?? {}) as SetAgentAccountDefaultsRequest;
    try {
      return await agentAccounts.setDefaults(body);
    } catch (error) {
      if (error instanceof AgentAccountError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>("/api/registry/:id/version", async (request) =>
    registry.version(request.params.id)
  );

  app.post<{ Params: { id: string } }>("/api/registry/:id/install", async (request) =>
    registry.install(request.params.id)
  );

  app.post<{ Params: { id: string } }>("/api/registry/:id/update", async (request) =>
    registry.update(request.params.id)
  );

  // Launch an ide/file-explorer/browser on a path (fire-and-forget).
  app.post("/api/open", async (request, reply): Promise<OpenResult | void> => {
    const body = (request.body ?? {}) as OpenRequest;
    if (!body.targetId || !body.path) {
      return reply.code(400).send({ code: "INVALID_REQUEST", message: "targetId and path required." });
    }
    return registry.openTarget(body.targetId, body.path);
  });

  // Agent chat — every §6.2 command and §6.3 read, proxied to the agent host
  // over its unix socket. Registered on BOTH transports, inheriting their auth
  // unchanged (chat spec §6): bearer on HTTP, none on the socket. Declared
  // before `/api/sessions/:id` so the more specific paths are unambiguous.
  // (Optional-chained: route-level tests build a partial `services`.)
  const agentChatDeps = services.agentChat?.routeDeps();
  if (agentChatDeps) {
    registerAgentChatRoutes(app, {
      ...agentChatDeps,
      onStopCommand: (id, command, body) => services.delegateStops?.commandAccepted(id, command, body),
      beforeStopCommand: (id, command, body) => services.delegateStops?.commandRequested(id, command, body) ?? (() => undefined)
    });
    // Thread lineage (spec 2026-10-14 §6): fork, merge back, the lineage read.
    registerLineageRoutes(app, {
      lineage: () => services.lineage ?? null,
      isChatSession: (id) => services.agentChat.chat.has(id),
      // A fork opens after every tab of its parent's project, as a new chat tab does.
      fork: (parentId, body) => {
        const projectPath = services.agentChat.chat.get(parentId)?.projectPath ?? "";
        return services.agentChat.forkSession(
          parentId,
          body,
          sessions.list(projectPath).reduce((max, s) => Math.max(max, s.order), -1) + 1
        );
      }
    });
    // Usage-limit recovery: arm/cancel the automatic resume, resume now, switch and continue.
    registerUsageLimitRoutes(app, {
      recovery: () => services.limitRecovery ?? null,
      isChatSession: (id) => services.agentChat.chat.has(id)
    });
    // The `request_secret` cards: daemon-owned, never proxied to the host.
    if (services.secretRequests) {
      registerSecretRequestRoutes(app, {
        registry: services.secretRequests,
        isChatSession: (id) => agentChatDeps.chatSession(id) !== undefined
      });
    }
  }
  // umcp:t3 begin
  // Approval cards and agent tools: daemon-owned, both transports (the bearer hook guards remote).
  if (services.agentToolsRuntime) {
    registerAgentToolsRuntimeRoutes(app, services.agentToolsRuntime);
  }
  // umcp:t3 end
  // boxes: the temporary-box routes, both transports (ownership by the request's principal).
  if (services.temporaryBoxTools) {
    registerTemporaryBoxRoutes(app, services.temporaryBoxTools);
  }

  // Sessions (PTYs and chat tabs — one list, one per-project order)
  app.get<{ Querystring: { projectPath?: string } }>(
    "/api/sessions",
    async (request): Promise<SessionSummary[]> => sessions.list(request.query.projectPath)
  );

  app.post("/api/sessions", async (request, reply): Promise<SessionSummary | void> => {
    const body = (request.body ?? {}) as CreateSessionRequest;
    // workflows §5.10: only a chat tab can be a workflow's, and its owner must parse.
    if (body.owner !== undefined) {
      const owner = parseSessionOwner(body.owner);
      if (!owner.ok || body.kind !== "agent-chat") {
        return reply.code(400).send({
          code: INVALID_OWNER,
          message: owner.ok ? "owner is only accepted for agent-chat sessions." : owner.message
        });
      }
      body.owner = owner.owner;
    }
    // Agent Profiles run in chat tabs only: a terminal launch naming one would silently start
    // with the agent's Global setup, so it is refused (absent or null = Global, as ever).
    if (body.kind !== "agent-chat" && body.profileId !== undefined && body.profileId !== null) {
      return reply.code(400).send({
        code: "INVALID_PROFILE",
        message: "profileId is only accepted for agent-chat sessions: a terminal launch always uses the agent's own (Global) setup."
      });
    }
    // A chat tab takes the §6.1 path: the tab record, then the host thread. It
    // shares nothing with the PTY branch below.
    if (body.kind === "agent-chat") {
      try {
        const summary = await services.agentChat.createSession(
          body as CreateAgentChatRequest,
          sessions.list(body.projectPath ?? "").reduce((max, s) => Math.max(max, s.order), -1) + 1
        );
        // A knowledge indexer's worker chat runs in the plugin's own work dir: never a project.
        if (summary.owner?.kind !== "knowledge-indexer") await markRecentProject(summary.projectPath);
        return summary;
      } catch (error) {
        const code = error instanceof ChatSessionError ? error.code : "SESSION_UNAVAILABLE";
        const message =
          error instanceof Error ? error.message : "Failed to create the chat session.";
        const ownerSessionId =
          error instanceof ChatSessionError ? error.ownerSessionId : undefined;
        return reply
          .code(code === "HOST_UNAVAILABLE" ? 503 : 400)
          .send({ code, message, ...(ownerSessionId ? { ownerSessionId } : {}) });
      }
    }
    // `initialCommand` is TYPED into the fresh PTY (see sessions.ts), so it gets
    // /input's trust — with two bounds /input can't have: one line, and no
    // control bytes. A raw keystroke stream legitimately carries ESC; a launch
    // command must not, or a client could smuggle a terminal control sequence
    // into a tab it never showed the user.
    if (body.initialCommand !== undefined) {
      const command = body.initialCommand;
      if (
        typeof command !== "string" ||
        command.length > MAX_INITIAL_COMMAND ||
        // (control bytes are exactly what this class rejects)
        /[\u0000-\u001f\u007f]/.test(command)
      ) {
        return reply.code(400).send({
          code: "INVALID_INITIAL_COMMAND",
          message: `initialCommand must be a single line of at most ${MAX_INITIAL_COMMAND} characters.`
        });
      }
    }
    // "Resume this conversation" must never degrade into "start a fresh one":
    // if the id is unusable (rejected shape, or an agent with no resume flags)
    // the launch is refused so the client can say so, instead of silently
    // opening an empty session the user believes is their old one.
    if (typeof body.resumeConversationId === "string" && body.resumeConversationId.trim()) {
      const resumeEntry = registry.get(body.refId);
      if (!resumeEntry || resumeLaunchArgs(resumeEntry, body.resumeConversationId).length === 0) {
        return reply.code(400).send({
          code: "RESUME_UNAVAILABLE",
          message: "That conversation cannot be resumed with this agent."
        });
      }
    }
    let summary: SessionSummary;
    try {
      summary = await sessions.create(body);
    } catch (error) {
      const message = error instanceof SessionError ? error.message : "Failed to create session.";
      return reply.code(400).send({ code: "SESSION_UNAVAILABLE", message });
    }
    // Launching a tab in a project is the strongest "I'm working here" signal
    // the daemon sees, so it feeds the shared recent-projects list itself
    // rather than trusting each client to report it.
    await markRecentProject(summary.projectPath);
    return summary;
  });

  app.delete<{ Params: { id: string } }>(
    "/api/sessions/:id",
    async (request, reply): Promise<void> => {
      const ok = sessions.close(request.params.id);
      return reply.code(ok ? 204 : 404).send();
    }
  );

  app.put<{ Params: { id: string }; Body: RenameSessionRequest }>(
    "/api/sessions/:id",
    async (request, reply): Promise<SessionSummary | void> => {
      const summary = sessions.rename(request.params.id, request.body?.title ?? "", {
        seed: request.body?.seed === true
      });
      if (!summary) {
        return reply.code(404).send();
      }
      return summary;
    }
  );

  app.post<{ Body: ReorderSessionsRequest }>(
    "/api/sessions/reorder",
    async (request, reply): Promise<void> => {
      const { projectPath, ids } = request.body ?? { projectPath: "", ids: [] };
      sessions.reorder(projectPath, ids);
      return reply.code(204).send();
    }
  );

  app.post<{ Params: { id: string }; Body: SessionInputRequest }>(
    "/api/sessions/:id/input",
    async (request, reply): Promise<void> => {
      sessions.input(request.params.id, request.body?.data ?? "");
      return reply.code(204).send();
    }
  );

  // Browser tabs — server-side Chromium (Design Mode). CRUD only here; the
  // live stream + input ride /ws-browser.
  app.get<{ Querystring: { projectPath?: string } }>(
    "/api/browsers",
    async (request): Promise<BrowserSummary[]> =>
      services.browsers.list(request.query.projectPath)
  );

  app.get<{ Querystring: { projectPath?: string } }>(
    "/api/browsers/suggestions",
    async (request): Promise<BrowserSuggestionsResponse> => {
      const projectPath = request.query.projectPath;
      if (!projectPath) return { urls: [] };
      const sniffed = services.urlWatcher.suggestions(projectPath);
      // boxes: a box project's dev servers are offered at their host-side forwards.
      return { urls: services.boxWiring ? await services.boxWiring.browserSuggestions(projectPath, sniffed) : sniffed };
    }
  );

  app.post<{ Body: CreateBrowserRequest }>(
    "/api/browsers",
    async (request, reply): Promise<BrowserSummary | void> => {
      const body = request.body ?? ({} as CreateBrowserRequest);
      if (!body.projectPath) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: "projectPath is required." });
      }
      try {
        return await services.browsers.create(body.projectPath, body.url);
      } catch (error) {
        const status = error instanceof BrowserError ? error.statusCode : 500;
        const message = error instanceof Error ? error.message : "Failed to create browser tab.";
        return reply.code(status).send({ code: "BROWSER_UNAVAILABLE", message });
      }
    }
  );

  app.delete<{ Params: { id: string } }>(
    "/api/browsers/:id",
    async (request, reply): Promise<void> => {
      await services.browsers.close(request.params.id);
      return reply.code(204).send();
    }
  );

  // Desktop tabs (desktop spec §7.1) — CRUD, apps and window actions; the view
  // and sound ride /ws-desktop and /ws-desktop-audio. Launch bodies may carry
  // credentials in `env`: the request logger above logs only method + URL.
  registerDesktopHttpRoutes(app, {
    desktops: services.desktops,
    fsRoot: () => resolved.fsRoot,
    // boxes: a box project's paths are checked in its VM, where its desktops run.
    boxes: () => services.boxRegistry
  });

  // Embedded-DevTools frontend assets — reverse-proxied from the tab's own
  // Chromium, which serves a prebuilt, version-matched DevTools bundle at
  // /devtools/*. Remote-only (HTTP transport); never on the unix socket.
  // Unauthenticated within remote by design: these are generic Chrome files at
  // the same trust level as the SPA bundle, behind an unguessable tab UUID —
  // the sensitive channel is the authenticated /ws-devtools proxy, and the
  // DevTools frontend is sandboxed + CSP-locked client-side (see Task 5/6).
  // Chromium's /json/* discovery endpoints are deliberately NOT reachable here
  // (the sanitizer pins the path under /devtools/).
  if (options.mode === "remote") {
    app.get<{ Params: { browserId: string; "*": string } }>(
      "/devtools-frontend/:browserId/*",
      async (request, reply) => {
        const rest = sanitizeDevtoolsPath(request.params["*"]);
        if (!rest) {
          return reply.code(404).send({ code: "NOT_FOUND", message: "Route not found." });
        }
        let port: number;
        try {
          port = await services.browsers.devtoolsPort(request.params.browserId);
        } catch (error) {
          const status = error instanceof BrowserError ? error.statusCode : 500;
          return reply.code(status).send({ code: "BROWSER_UNAVAILABLE", message: "Browser tab is not running." });
        }
        const upstream = await new Promise<IncomingMessage>((resolvePromise, rejectPromise) => {
          const req = httpRequest(
            {
              host: "127.0.0.1",
              port,
              path: `/devtools/${rest}`,
              method: "GET",
              // Chrome 403s any non-localhost Host (DNS-rebinding guard); the
              // public hostname from the Caddy hop must never reach it.
              headers: { host: `127.0.0.1:${port}` },
              // Unauthenticated route → never let a request pin a
              // daemon→Chromium connection open indefinitely.
              timeout: 10_000
            },
            resolvePromise
          );
          req.on("timeout", () => req.destroy(new Error("devtools upstream timeout")));
          req.on("error", rejectPromise);
          // Client (or the proxy) went away → tear the upstream down so it
          // can't accumulate. Fastify aborts request.raw on client disconnect.
          request.raw.on("close", () => req.destroy());
          req.end();
        }).catch(() => null);
        if (!upstream) {
          return reply.code(502).send({ code: "BROWSER_UNAVAILABLE", message: "DevTools upstream unreachable." });
        }
        // If the client already left, drop the upstream response too.
        request.raw.on("close", () => upstream.destroy());
        void reply.header("cache-control", "no-store");
        const contentType = upstream.headers["content-type"];
        if (contentType) void reply.header("content-type", contentType);
        return reply.code(upstream.statusCode ?? 502).send(upstream);
      }
    );
  }

  if (options.mode === "local") {
    // Managed agent hooks report lifecycle events here (see the agent-status
    // design doc). Socket-only: sessions always run on the daemon's host, and
    // the unix socket is the single-user trust boundary — the HTTP transport
    // never exposes this surface. 204 fail-open on unknown events so a hook
    // can never break an agent.
    app.post<{ Params: { id: string }; Body: AgentEventRequest }>(
      "/api/sessions/:id/agent-event",
      async (request, reply): Promise<void> => {
        const body = request.body ?? ({} as AgentEventRequest);
        if (
          (body.source !== "claude" &&
            body.source !== "codex" &&
            body.source !== "opencode" &&
            body.source !== "grok") ||
          typeof body.event !== "string"
        ) {
          return reply.code(204).send();
        }
        const known = sessions.agentEvent(request.params.id, body);
        return reply.code(known ? 204 : 404).send();
      }
    );
  }

  // Accept a file dropped/pasted onto a terminal, persist it to a daemon-private
  // dir, and return the absolute on-disk path (the client injects that path into
  // the session so the running agent can read it — see the file-drop design doc).
  // The client supplies only bytes + a name hint; the daemon fully controls the
  // directory and final name (random-prefixed, sanitized), so there is no
  // path-traversal surface. Inherits the bearer-auth hook (it lives under /api).
  // The bytes arrive as a RAW application/octet-stream body (name/type in the
  // query string) streamed to a temp file and renamed into place; the shared
  // MAX_UPLOAD_BYTES cap is enforced by receiveUpload (see upload-stream.ts).
  app.register(async (scope) => {
    acceptRawBody(scope);
    scope.post<{ Params: { id: string }; Querystring: Partial<SessionUploadRequest> }>(
      "/api/sessions/:id/upload",
      async (request, reply): Promise<SessionUploadResponse | void> => {
        const { id } = request.params;
        if (!sessions.get(id)) {
          return refuseUpload(reply, 404, "SESSION_NOT_FOUND", "Session does not exist.");
        }
        if (declaredLengthExceedsCap(request.headers)) {
          return refuseUpload(reply, 413, "UPLOAD_TOO_LARGE", new UploadTooLargeError().message);
        }

        // Chat spec §6.3: a chat upload reuses this exact raw-binary path, but
        // the bytes stream straight through to the agent host, which claims the
        // file into the thread's attachment namespace, mints its id, re-checks
        // the §4.1 bounds against the file it stat'd, and cleans it up with the
        // rest of the thread on delete. A terminal upload keeps its own dir.
        if (sessions.get(id)?.kind === "agent-chat") {
          // Every refusal here leaves `request.raw` unread, so it must answer
          // with `Connection: close` or Node drains the whole body first — the
          // same rule the terminal branch follows through `refuseUpload`.
          if (!services.agentChat) {
            return refuseUpload(reply, 503, "HOST_UNAVAILABLE", "The agent host is restarting.");
          }
          try {
            const uploaded = await services.agentChat.uploadAttachment(id, request.query, request.raw);
            // The host's answer is relayed as is: its `{error}` envelope is what
            // the chat transport reads, so `refuseUpload`'s `{code, message}`
            // cannot carry it. A host refusal can still leave the body unread,
            // and then it closes the socket the same way.
            if (relayedUploadClosesConnection(uploaded.status, request.raw)) {
              reply.header("connection", "close");
            }
            return reply.code(uploaded.status).send(uploaded.value ?? undefined);
          } catch (error) {
            // The cap is the caller's failure, never the host's. The service
            // hands it on typed; the predicate also reads it through the host
            // client's HOST_UNAVAILABLE wrapper, so a 413 never depends on who
            // unwrapped it.
            if (isUploadTooLarge(error)) {
              return refuseUpload(reply, 413, "UPLOAD_TOO_LARGE", new UploadTooLargeError().message);
            }
            request.log?.warn?.({ err: error }, "agent chat attachment upload failed");
            return refuseUpload(reply, 503, "HOST_UNAVAILABLE", "The agent host is restarting.");
          }
        }

        const name = uploadFileName(request.query.name ?? "", request.query.type);
        const dir = sessionUploadsDir(resolved.daemonDir, id);
        const path = join(dir, name);
        // Mirror the accounts.json / keys conventions: 0700 dir, 0600 file. A
        // filesystem failure (disk full, permission denied, …) must surface as a
        // clean error, not an unhandled rejection: map ENOSPC to 507, else 500.
        let tmp: string | undefined;
        try {
          await mkdir(dir, { recursive: true, mode: 0o700 });
          tmp = uploadTempPath(dir);
          const size = await receiveUpload(request.raw, tmp, 0o600);
          // The clients skip 0-byte files; an empty body here is malformed —
          // reject it rather than handing the agent an empty file.
          if (size === 0) {
            await discardUpload(tmp);
            return reply.code(400).send({ code: "INVALID_REQUEST", message: "Empty upload." });
          }
          await rename(tmp, path);
          return { path, name, size };
        } catch (error) {
          if (tmp) {
            await discardUpload(tmp);
          }
          if (error instanceof UploadTooLargeError) {
            return refuseUpload(reply, 413, "UPLOAD_TOO_LARGE", error.message);
          }
          const code = (error as NodeJS.ErrnoException)?.code === "ENOSPC" ? 507 : 500;
          return reply.code(code).send({
            code: "UPLOAD_FAILED",
            message: error instanceof Error ? error.message : "Cannot store the uploaded file."
          });
        }
      }
    );
  });

  app.post<{ Params: { id: string }; Body: SessionResizeRequest }>(
    "/api/sessions/:id/resize",
    async (request, reply): Promise<void> => {
      const { cols, rows } = request.body ?? { cols: 0, rows: 0 };
      sessions.resize(request.params.id, cols, rows);
      return reply.code(204).send();
    }
  );

  // Live output stream: replays the current buffer, then streams raw PTY bytes
  // until the session exits or the client disconnects. Plain chunked HTTP so it
  // works identically over the unix socket and over remote HTTP. Input/resize
  // use the POST endpoints above.
  app.get<{ Params: { id: string } }>("/api/sessions/:id/output", async (request, reply) => {
    const { id } = request.params;
    const summary = sessions.get(id);
    if (!summary) {
      void reply.code(404).send();
      return;
    }

    // Capture scrollback BEFORE hijacking so an await can't race the raw stream.
    const replay = await sessions.scrollback(id);

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "application/octet-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no"
    });
    reply.raw.write(replay);

    // Re-read the LIVE status after the await: the pre-await `summary` is a clone
    // and can't reflect a transition that happened during scrollback(). If the
    // session exited while capture-pane was in flight (a real several-ms window on
    // the tmux backend), the attach PTY's onExit already emitted "exit" with no
    // subscriber yet — installing one below would never see an end and the client
    // pane would hang. End immediately instead.
    const current = sessions.get(id);
    if (!current || current.status === "exited") {
      reply.raw.end();
      return;
    }

    const unsubscribe = sessions.subscribe(
      id,
      (data) => reply.raw.write(data),
      () => reply.raw.end()
    );
    request.raw.on("close", unsubscribe);
  });

  // To-do lists — daemon-owned, synced checklists (channel "todos"). Allowed on
  // both transports like /api/sessions and /api/accounts (no secret returned).
  // Errors map TodoError.status (else 500) to { code:"TODO_ERROR", message }.
  app.get<{ Querystring: { scope?: string; refKey?: string } }>("/api/todos", async (request, reply) => {
    const { scope, refKey } = request.query;
    if ((scope !== "workspace" && scope !== "project") || !refKey) {
      return reply.code(400).send({ code: "BAD_REQUEST", message: "scope and refKey required" });
    }
    return reply.send(todos.list(scope, refKey));
  });

  app.post<{ Body: CreateTodoRequest }>("/api/todos", async (request, reply) => {
    const body = (request.body ?? {}) as CreateTodoRequest;
    try {
      const rec = await todos.create(body.scope, body.refKey, body.name);
      return reply.code(201).send(rec);
    } catch (error) {
      const status = error instanceof TodoError ? error.status : 500;
      return reply.code(status).send({ code: "TODO_ERROR", message: (error as Error).message });
    }
  });

  app.put<{ Params: { id: string }; Body: UpdateTodoRequest }>("/api/todos/:id", async (request, reply) => {
    const body = (request.body ?? {}) as UpdateTodoRequest;
    try {
      const rec = await todos.update(request.params.id, { name: body.name, body: body.body });
      return reply.send(rec);
    } catch (error) {
      const status = error instanceof TodoError ? error.status : 500;
      return reply.code(status).send({ code: "TODO_ERROR", message: (error as Error).message });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/todos/:id", async (request, reply) => {
    try {
      await todos.delete(request.params.id);
      return reply.code(204).send();
    } catch (error) {
      const status = error instanceof TodoError ? error.status : 500;
      return reply.code(status).send({ code: "TODO_ERROR", message: (error as Error).message });
    }
  });

  // umcp:t12 begin — the saved-prompt routes live with their service (unified MCP design
  // 2026-10-15 D-16): `createdBy` and the pin refusal read the server-stamped principal, and the
  // list rows carry `usedByWorkflows` (with each workflow's workspace) from the workflow store's
  // reference index. The atomic todo-item toggle beside the other /api/todos routes (update_todos toggle).
  registerSavedPromptRoutes(app, {
    service: services.savedPrompts,
    workflowReferences: () => services.workflows.references,
    workspacesDir: () => resolved.workspacesDir
  });
  registerTodoToggleRoute(app, todos);
  // umcp:t12 end

  // Repo identities (spec 2026-10-18 §2). Both transports; the bearer hook gates HTTP like every
  // /api route — no ?token= exemption (clients fetch icon bytes with auth).
  registerRepoIdentityRoutes(app, { service: services.repoIdentities });
  // GitHub link previews (the chat's link pills). Both transports; the bearer hook gates HTTP.
  if (services.githubLinks) {
    registerGitHubLinkRoutes(app, { service: services.githubLinks });
  }
  if (services.secretFiles) {
    registerSecretFilesRoutes(app, { service: services.secretFiles, logger: console });
  }

  // Built-in plugins (plugins spec §5.3). Both transports, like the protect-archived toggle:
  // enabling downloads and runs a verified binary, which is no more than a remote user can do
  // already (installing agent CLIs, running shells), and nothing here is secret.
  registerPluginRoutes(app, { plugins: services.plugins });
  // Knowledge Graph (its spec, "Agent tools", "Settings → Plugins entry"): settings, the data routes,
  // status and rebuild on both transports (the bearer hook gates HTTP). In-chat tools reach them
  // through the unix app's in-process client with the agent's stamped principal — the only
  // identity the worker routes accept, which are therefore the unix app's alone.
  services.knowledge?.registerRoutes(app, options.mode);
  // boxes: the Ephemeral AI VMs routes (boxRoutes), on both transports like the plugin routes above.
  services.boxes?.registerRoutes(app);
  // Devices (`deviceRoutes`): both transports; the hub proxy on the remote one only (streams need HTTP).
  services.devices?.registerRoutes(app, options.mode);

  // Automated workflows (workflows spec §8.1) — definitions, runs, logs, secrets. Both
  // transports; the bearer hook above gates HTTP. Secret values are write-only.
  registerWorkflowRoutes(app, {
    service: services.workflows,
    secrets: services.workflowSecrets,
    runStore: services.workflowRuns,
    engine: () => services.workflowEngine,
    ...(services.workflowProjects ? { projects: services.workflowProjects } : {}),
    ...(services.workflowCatalogReady ? { agentCatalogReady: services.workflowCatalogReady } : {}),
    savedPromptIds: () => services.savedPrompts.allIds(),
    // `?projectPath=` names `<workspacesDir>/<ws>/<project>`, read per request (PUT
    // /api/config/daemon can move the workspaces dir).
    projectPathFilter: (projectPath) => {
      const described = describeProjectPath(resolved.workspacesDir, projectPath);
      return described
        ? { path: join(resolved.workspacesDir, described.workspace, described.name), workspace: described.workspace }
        : null;
    }
  });

  // Agent profile (agent profile spec §8): each agent CLI's global config. Both transports; the
  // bearer hook above gates HTTP. MCP secret values never leave the daemon.
  registerAgentProfileRoutes(app, {
    service: services.agentProfile,
    importsDir: agentProfileImportsDir(resolved.baseDir)
  });

  // Agent Profiles (spec 2026-10-18 §4): Orquester-owned per-session profiles. Both transports;
  // the bearer hook above gates HTTP. MCP secret values never leave the daemon.
  // A delete's `expectWorkflowUses` (the delete guard, §5.5) is checked against the workflow
  // store's reference index in the delete's own step.
  registerSessionProfileRoutes(app, {
    service: services.sessionProfiles,
    importsDir: agentProfileImportsDir(resolved.baseDir),
    workflowReferences: () => services.workflows.references
  });

  // umcp:t11 begin — daemon-pointing MCP servers (unified MCP design 2026-10-15 §12.1): every MCP
  // server in a CLI's user config (system home and every managed account home) or a project-level
  // config that reaches THIS daemon's /mcp, by its bearer (the transport's own constant-time check;
  // the credential never leaves the daemon) or its URL. GET on both transports (the chat manifest's
  // `deny`, the agent-profile panel); the card preview's check is socket-only.
  registerDaemonMcpServersRoutes(app, {
    mode: options.mode,
    detector: new DaemonMcpDetector(
      {
        // A peek: finding a token in a config file is not a use of it.
        verifyBearer: (token) => authSessions.verify(token, false) !== null,
        httpPort: () => config.transports.http.port,
        // No public origin is configured anywhere: a proxied URL is caught by its bearer.
        publicOrigins: () => [],
        env: (name) => process.env[name]
      },
      {
        homes: resolveAgentHomes(process.env, resolved.vars?.userhome),
        accountHomes: async (agent) =>
          agent === "opencode"
            ? []
            : agentAccounts.list().accounts.filter((account) => account.agent === agent).map((account) => ({ id: account.id, home: agentAccounts.homePath(agent, account.id) })),
        projects: () => listProjectDirs(resolved.workspacesDir),
        workspacesRoot: () => resolved.workspacesDir,
        logger: console
      }
    ),
    current: (agent, id) => services.agentProfile.mcpCandidate(agent, id)
  });
  // umcp:t11 end

  // Web Push (PWA attention notifications). Allowed on both transports like
  // /api/sessions and /api/accounts — the response never carries the VAPID
  // private key (only the public key + a count). The bearer-auth hook gates
  // these on remote HTTP automatically.

  // Public VAPID key + subscription count. Triggers lazy VAPID generation.
  app.get("/api/push/info", async (): Promise<PushInfoResponse> => push.info());

  // Register (upsert) a browser subscription.
  app.post<{ Body: PushSubscribeRequest }>("/api/push/subscriptions", async (request, reply): Promise<void> => {
    const body = (request.body ?? {}) as Partial<PushSubscribeRequest>;
    if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
      return reply.code(400).send({ code: "INVALID_REQUEST", message: "endpoint and keys required." });
    }
    if (!isValidPushEndpoint(body.endpoint)) {
      return reply.code(400).send({ code: "INVALID_REQUEST", message: "endpoint must be a public https URL." });
    }
    await push.subscribe({ endpoint: body.endpoint, keys: body.keys, userAgent: body.userAgent });
    return reply.code(204).send();
  });

  // Remove a subscription by endpoint.
  app.delete<{ Body: PushUnsubscribeRequest }>("/api/push/subscriptions", async (request, reply): Promise<void> => {
    const body = (request.body ?? {}) as Partial<PushUnsubscribeRequest>;
    if (!body.endpoint) {
      return reply.code(400).send({ code: "INVALID_REQUEST", message: "endpoint required." });
    }
    await push.unsubscribe(body.endpoint);
    return reply.code(204).send();
  });

  // Send a test push to every subscription; returns how many were delivered.
  app.post("/api/push/test", async (): Promise<PushTestResponse> => ({ sent: await push.sendTest() }));

  // umcp:t9 begin — `notify_user`'s push (unified MCP design 2026-10-15 §4.1): rate-limited by request.principal.
  registerPushNotifyRoute(app, push);
  // umcp:t9 end

  // Daemon event bus (newline-delimited JSON): lifecycle broadcasts + heartbeat.
  app.get<{ Querystring: { project?: string } }>("/events", async (request, reply) => {
    // Optional per-project git subscription. While this stream is open the
    // daemon polls that project's status and pushes `project.git.changed` — and
    // ONLY to the clients that asked for that project, since a status blob is
    // useless noise to everyone else. Refcounted in the watcher, so several
    // clients (or reconnects) on one project share one poll loop, and the
    // stream's close hook below is what stops it.
    let watchedProject: string | null = null;
    if (request.query.project) {
      try {
        watchedProject = await assertInsideFsRoot(resolved.fsRoot, request.query.project);
      } catch (error) {
        return gitError(reply, error);
      }
    }

    // The client can hang up BEFORE this handler registers anything — during the
    // sandbox check above, or during an auth hook. Its "close" then fires while
    // no listener exists, and the sink + heartbeat + watcher refcount below would
    // leak for the lifetime of the daemon. Nothing is registered yet at this
    // point, so bailing out IS the whole cleanup; hijack first so Fastify doesn't
    // try to serialize a reply onto the dead socket.
    if (request.raw.destroyed) {
      reply.hijack();
      return;
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "application/x-ndjson",
      "cache-control": "no-cache",
      "x-accel-buffering": "no"
    });

    const sink = {
      send: (data: string) => {
        // Status blobs go only to the streams watching that project; everything
        // else passes through. Decided by the event's real `type` — see
        // passesGitEventFilter (and its tests) for why the substring alone isn't.
        if (!passesGitEventFilter(data, watchedProject)) return;
        reply.raw.write(`${data}\n`);
      }
    };
    services.broadcaster.add(sink);
    if (watchedProject) {
      services.gitWatcher.subscribe(watchedProject);
    }

    const timer = setInterval(() => {
      const event: EventMessage = {
        id: randomUUID(),
        channel: "daemon",
        type: "daemon.heartbeat",
        createdAt: new Date().toISOString(),
        payload: { daemonId }
      };
      sink.send(JSON.stringify(event));
    }, 15_000);

    // Revoking the session that opened this stream destroys it (the bearer hook's endOnRevoke);
    // the close below cleans up then too.
    request.raw.on("close", () => {
      clearInterval(timer);
      services.broadcaster.remove(sink);
      if (watchedProject) {
        services.gitWatcher.unsubscribe(watchedProject);
      }
    });
  });

  // Multiplexed session I/O over a single WebSocket. The web client opens ONE
  // socket for ALL its terminals (output + input + resize) instead of one
  // streaming HTTP connection each, so it no longer hits the browser's
  // ~6-connections-per-origin cap (which otherwise froze input/resize once more
  // than ~4 terminals were open).
  //
  // @fastify/websocket is registered ONCE, here at the root, for all three WS
  // routes. Each registration hooks its own listener on the Node server's
  // `upgrade` event, so registering it per route scope (as this once did) made
  // every WebSocket handshake fire N listeners: the first assigned the socket
  // and routed, the other N-1 threw ERR_HTTP_SOCKET_ASSIGNED — two spurious
  // "websocket upgrade failed" warnings per connection, burying real ones. The
  // routes stay in encapsulated child contexts only so they are declared after
  // the plugin has loaded (avvio loads plugins in registration order).
  void app.register(websocketPlugin);
  // boxes: config-change, stats and "Run in box" routes on both transports; the box connect
  // WebSocket and orq-agent downloads (box-authenticated) on the remote one, after the WebSocket
  // plugin; the agent host's token and sync routes on the unix socket only.
  services.boxWiring?.registerRoutes(app, options.mode);
  void app.register(async (instance) => {
    instance.get("/ws", { websocket: true }, (socket, request) => {
      if (!authorizeSocket((request.query as { token?: string }).token, socket)) {
        socket.close(1008, "unauthorized");
        return;
      }

      // Subscriptions, backpressure and resyncs live in session-stream.ts.
      const stream = createSessionStream(socket, sessions);
      socket.on("message", (raw) => void stream.onMessage(raw.toString()));
      socket.on("close", () => stream.onClose());
    });
  });

  // Browser-tab streaming: binary JPEG frames out, JSON control in. Kept off
  // /ws so the terminal channel's text-only fast path is untouched.
  void app.register(async (instance) => {
    instance.get("/ws-browser", { websocket: true }, (socket, request) => {
      if (!authorizeSocket((request.query as { token?: string }).token, socket)) {
        socket.close(1008, "unauthorized");
        return;
      }

      const subs = new Map<string, () => void>();
      const SEND_HWM = 1_500_000; // skip frames when the socket is backed up (mobile data)
      const sendJson = (msg: unknown) => {
        try {
          socket.send(JSON.stringify(msg));
        } catch {
          /* socket closing */
        }
      };
      const sendFrame = (id: string, jpeg: Buffer) => {
        if (socket.bufferedAmount > SEND_HWM) return; // latest-frame-wins; CDP acks continue
        const header = Buffer.alloc(37);
        header.writeUInt8(BROWSER_FRAME_TYPE_JPEG, 0);
        header.write(id, 1, 36, "ascii");
        try {
          socket.send(Buffer.concat([header, jpeg]));
        } catch {
          /* socket closing */
        }
      };

      socket.on("message", async (raw, isBinary) => {
        if (isBinary) return; // client never sends binary
        let msg: BrowserClientMessage;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.t === "ping") {
          sendJson({ t: "pong" });
          return;
        }
        const id = "id" in msg ? msg.id : undefined;
        if (!id) return;

        if (msg.t === "sub") {
          subs.get(id)?.();
          const placeholder = () => {};
          subs.set(id, placeholder);
          const unsub = await services.browsers
            .subscribe(id, {
              onFrame: (jpeg) => sendFrame(id, jpeg),
              onState: (state) => sendJson(state),
              onPicked: (payload) => sendJson({ t: "picked", id, payload }),
              onFocus: (editable) => sendJson({ t: "focus", id, editable }),
              onEnd: () => sendJson({ t: "end", id })
            })
            .catch(() => null);
          if (!unsub) {
            subs.delete(id);
            sendJson({ t: "end", id });
            return;
          }
          if (subs.get(id) !== placeholder) {
            unsub();
            return;
          } // raced by unsub — honor it
          subs.set(id, unsub);
        } else if (msg.t === "unsub") {
          subs.get(id)?.();
          subs.delete(id);
        } else if (msg.t === "pointer") {
          services.browsers.dispatchPointer(id, msg.kind, msg.x, msg.y, msg.button, msg.modifiers, msg.clickCount);
        } else if (msg.t === "wheel") {
          services.browsers.dispatchWheel(id, msg.x, msg.y, msg.dx, msg.dy);
        } else if (msg.t === "key") {
          services.browsers.dispatchKey(id, msg.kind, msg.key, msg.code, msg.text, msg.modifiers, msg.keyCode);
        } else if (msg.t === "touch") {
          services.browsers.dispatchTouch(id, msg.kind, msg.points);
        } else if (msg.t === "insertText" && typeof msg.text === "string") {
          services.browsers.insertText(id, msg.text);
        } else if (msg.t === "nav") {
          await services.browsers.navigate(id, msg.action, msg.url).catch(() => undefined);
        } else if (msg.t === "viewport") {
          await services.browsers.setViewport(id, msg.mode).catch(() => undefined);
        } else if (msg.t === "pick") {
          await services.browsers.setPick(id, msg.on).catch(() => undefined);
        }
      });

      socket.on("close", () => {
        for (const unsub of subs.values()) unsub();
        subs.clear();
      });
    });
  });

  // Desktop RFB relay and Opus audio (desktop spec §7.2), in their own child
  // context like /ws-browser; `?token=` is checked after the upgrade (1008).
  void app.register(async (instance) => {
    await registerDesktopWsRoutes(instance, {
      authorize: (token, socket) => authorizeSocket(token, socket),
      vncSocketPath: (id) => services.desktops.vncSocketPath(id),
      // boxes: a VM desktop's RFB socket is reached through its box link.
      vncStream: (id) => services.desktops.vncStream(id),
      audioSource: (id) => services.desktops.audioSource(id),
      audio: services.desktopAudio
    });
  });

  // Device streams (devices spec §8): the hub relay, `?token=` checked after the upgrade like the
  // desktop relay above.
  if (services.devices) {
    const devicesWiring = services.devices;
    void app.register(async (instance) => {
      await devicesWiring.registerWsRoutes(instance, { authorize: (token, socket) => authorizeSocket(token, socket) });
    });
  }

  // Embedded-DevTools CDP WebSocket — remote-only (HTTP transport). The real
  // DevTools frontend speaks raw CDP to the tab's page target through this
  // authenticated pipe (?token= because browsers can't set WS headers). Routed
  // by our stable tab id; the volatile Chrome target id is resolved at upgrade
  // time so the iframe URL survives tab relaunches. DevTools attaches as a
  // SECOND CDP session — multi-session is native since Chrome 63 and doesn't
  // disturb the screencast/picker session.
  if (options.mode === "remote") {
    void app.register(async (instance) => {
      instance.get<{ Params: { browserId: string } }>(
        "/ws-devtools/:browserId",
        { websocket: true },
        (socket, request) => {
          if (!authorizeSocket((request.query as { token?: string }).token, socket)) {
            socket.close(1008, "unauthorized");
            return;
          }

          // CDP is stateful → never drop frames; PAUSE/RESUME on a high-water
          // mark instead. A single frame is capped by maxPayload; the pre-open
          // client queue is bounded by bytes AND count (fail-closed).
          const SEND_HWM = 8 * 1024 * 1024;
          const PENDING_MAX_BYTES = 8 * 1024 * 1024;
          const PENDING_MAX_MSGS = 512;

          let upstream: UpstreamWebSocket | null = null;
          let closed = false;
          const pending: Array<{ data: Buffer; binary: boolean }> = [];
          let pendingBytes = 0;

          const closeBoth = (code: number, reason: string) => {
            if (closed) return;
            closed = true;
            try { socket.close(code, reason); } catch { /* closing */ }
            try { upstream?.close(); } catch { /* closing */ }
          };
          // Pause `from` until `bufferedAmount` on `to` drains below the HWM.
          const relievePressure = (from: { pause(): void; resume(): void }, to: { bufferedAmount: number }) => {
            from.pause();
            const check = () => {
              if (closed) return;
              if (to.bufferedAmount > SEND_HWM) setTimeout(check, 25);
              else from.resume();
            };
            check();
          };

          // Attach the client listener SYNCHRONOUSLY (fastify-websocket drops
          // messages that arrive before a listener exists): buffer into the
          // bounded queue until the upstream handshake completes.
          socket.on("message", (data: Buffer, isBinary: boolean) => {
            if (closed) return;
            if (upstream && upstream.readyState === UpstreamWebSocket.OPEN) {
              upstream.send(data, { binary: isBinary });
              if (upstream.bufferedAmount > SEND_HWM) relievePressure(socket, upstream);
              return;
            }
            pendingBytes += data.length;
            pending.push({ data, binary: isBinary });
            if (pending.length > PENDING_MAX_MSGS || pendingBytes > PENDING_MAX_BYTES) {
              closeBoth(1011, "devtools buffer overflow");
            }
          });
          socket.on("close", () => closeBoth(1000, "client closed"));
          socket.on("error", () => closeBoth(1011, "client error"));

          void (async () => {
            let endpoint: { port: number; targetId: string };
            try {
              endpoint = await services.browsers.devtoolsEndpoint(request.params.browserId);
            } catch {
              closeBoth(1011, "browser tab not running");
              return;
            }
            if (closed) return;
            upstream = new UpstreamWebSocket(
              `ws://127.0.0.1:${endpoint.port}/devtools/page/${endpoint.targetId}`,
              {
                // Loopback Host (Chrome's DNS-rebinding guard); ws sends no
                // Origin, so Chrome's CDP origin check passes without an
                // allowlist — that's why no --remote-allow-origins is set.
                headers: { host: `127.0.0.1:${endpoint.port}` },
                maxPayload: 32 * 1024 * 1024,
                // Mirror the asset route's 10s guard: a hung CDP handshake must
                // not leave the client+upstream sockets open indefinitely.
                handshakeTimeout: 10_000
              }
            );
            upstream.on("open", () => {
              for (const m of pending) upstream!.send(m.data, { binary: m.binary });
              pending.length = 0;
              pendingBytes = 0;
            });
            upstream.on("message", (data, isBinary) => {
              if (closed) return;
              try { socket.send(data as Buffer, { binary: isBinary }); } catch { /* closing */ }
              if (socket.bufferedAmount > SEND_HWM) relievePressure(upstream!, socket);
            });
            upstream.on("close", () => closeBoth(1000, "devtools upstream closed"));
            upstream.on("error", () => closeBoth(1011, "devtools upstream error"));
          })();
        }
      );
    });
  }

  // umcp:t6 begin — the in-chat server's per-thread manifest (unified MCP design 2026-10-15 §9.4):
  // SOCKET-ONLY, and the agent host's bearer besides (it names a thread's MCP denials).
  if (options.mode === "local" && services.sessionToolsRefresher) {
    registerSessionToolsManifestRoute(app, {
      authorizeHost: (authorization) => services.agentChat?.authorizeHostRequest(authorization) ?? false,
      refresher: services.sessionToolsRefresher
    });
  }
  // umcp:t6 end

  // Agent Profiles (spec 2026-10-18 §6.5): the agent host's refresh before every session start
  // of a profile thread. SOCKET-ONLY, and the agent host's bearer besides (it answers a thread's
  // launch environment).
  if (options.mode === "local" && services.agentChat) {
    const agentChat = services.agentChat;
    registerThreadLaunchProfileRoute(app, {
      authorizeHost: (authorization) => agentChat.authorizeHostRequest(authorization),
      resolve: (threadId, profileId, accountId) => agentChat.threadLaunchProfile(threadId, profileId, accountId),
      logger: console
    });
  }

  // umcp:t2 begin — both transports of the unified catalog (design 2026-10-15 §3.3), through ONE
  // executor whose port (`executorPorts.approvals`) the umcp:t3 block wires.
  // Session tools (design 2026-10-14 §1.1) — the agent host's call-back
  // route, SOCKET-ONLY: never on remote HTTP. It also requires the host's
  // own bearer, and derives the caller from the thread's tab record and
  // snapshot. Handlers reach the daemon through the unix app's in-process
  // client, as the workflow engine does, each request carrying the agent's principal.
  if (options.mode === "local") {
    registerSessionToolsRoute(app, {
      authorizeHost: (authorization) => services.agentChat?.authorizeHostRequest(authorization) ?? false,
      resolveThread: (threadId) => services.agentChat?.sessionToolThread(threadId) ?? null,
      api: () => services.internalApi,
      ...(services.secretRequests ? { secretRequests: services.secretRequests } : {})
    });
  }

  // Orquester MCP — HTTP-only. The unix socket is unauthenticated, so full
  // session drive must never be reachable there; register /mcp only on remote.
  // Each request's tools call this app's own routes in-process with the
  // caller's bearer (spec §4.2), so every gate and error code is the GUI's;
  // each call acts as the external principal of the authenticated credential.
  if (options.mode === "remote") {
    registerMcp(app, {
      createApi: (authorization) =>
        new InjectDaemonApi({
          app,
          authorization,
          agentChat: services.agentChat ?? null,
          broadcaster: services.broadcaster,
          fsRoot: resolved.fsRoot,
          workspacesDir: resolved.workspacesDir,
          // boxes: read_file / directory reads of box projects go to the box.
          boxRegistry: () => services.boxRegistry
        }),
      credentialId: () => externalCredentialId(config.transports.http.username)
    });
  }
  // umcp:t2 end

  // Serve the static web client build for everything outside the API, with an
  // SPA fallback to index.html. Reserved prefixes stay JSON 404s.
  //
  // wildcard:true registers a single GET /* that resolves files from disk
  // per-request, so a rebuilt dist (new content-hash filenames) is served
  // immediately — no daemon restart needed. wildcard:false enumerates files
  // once at registration, so after a deploy that rebuilds the SPA the running
  // daemon 404s every new asset hash; the SPA fallback then returns index.html
  // for *.js requests → the browser's "Expected a module but got text/html".
  // On a miss @fastify/static calls reply.callNotFound(), routing to the SPA
  // fallback below; more-specific /api,/health,/events,/ws routes are never
  // shadowed by /*.
  if (options.serveWeb) {
    void app.register(fastifyStatic, { root: options.serveWeb, wildcard: true });
    app.setNotFoundHandler((request, reply) => {
      const url = request.url;
      const isApi =
        url.startsWith("/api") ||
        url.startsWith("/health") ||
        url.startsWith("/events") ||
        url.startsWith("/mcp") ||
        url.startsWith("/devtools-frontend") ||
        url.startsWith("/ws-devtools") ||
        DESKTOP_WS_PREFIXES.some((prefix) => url.startsWith(prefix)) ||
        DEVICE_WS_PREFIXES.some((prefix) => url.startsWith(prefix));
      if (request.method !== "GET" || isApi) {
        return reply.code(404).send({ code: "NOT_FOUND", message: "Route not found." });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}

/** Parse `--appdir <path>` or `--appdir=<path>` from CLI args. */
export function parseAppdir(args: string[]): string | undefined {
  const eq = args.find((arg) => arg.startsWith("--appdir="));
  if (eq) {
    return eq.slice("--appdir=".length);
  }

  const index = args.indexOf("--appdir");
  if (index !== -1 && args[index + 1]) {
    return args[index + 1];
  }

  return undefined;
}

/** Resolve a (possibly relative) appdir to an absolute path, or undefined. */
function resolveAppdir(raw: string | undefined, cwd: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  return resolve(cwd, raw);
}

/** Root of the daemon-private terminal-upload store: <appdir>/daemon/uploads. */
function uploadsRootDir(daemonDir: string): string {
  return join(daemonDir, "uploads");
}

/** Per-session upload dir: <appdir>/daemon/uploads/<sessionId>. */
function sessionUploadsDir(daemonDir: string, sessionId: string): string {
  return join(uploadsRootDir(daemonDir), sessionId);
}

/**
 * Close a rejected chat upload while body bytes remain on the socket. `complete`
 * tracks the HTTP parser; `readableEnded` may remain false after all bytes arrive
 * if the agent host stopped consuming. Injected requests without `complete` are
 * treated as incomplete. Successful uploads have already consumed their body.
 */
function relayedUploadClosesConnection(status: number, request: { readonly complete?: boolean }): boolean {
  return status >= 400 && request.complete !== true;
}

/** Minimal MIME → extension map for naming clipboard images that carry no filename. */
const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "application/pdf": "pdf",
  "text/plain": "txt"
};

/**
 * Build the final on-disk basename for an uploaded file. The client only sends a
 * name HINT (and a MIME type); the daemon owns the real name. We strip any
 * directory components, keep `[A-Za-z0-9._-]` (dropping spaces and anything
 * else), and — if nothing usable remains — synthesize one from the MIME type
 * (`pasted.<ext>`). A short random id is ALWAYS prefixed so names never collide,
 * never contain spaces (no shell quoting needed) and cannot be path traversal.
 */
function uploadFileName(rawName: string, mime: string | undefined): string {
  // Drop directory components first (defense in depth — the result is also
  // sanitized below), then keep only safe characters.
  const base = rawName.replace(/[\\/]+/g, "/").split("/").pop() ?? "";
  let safe = base.replace(/[^A-Za-z0-9._-]/g, "");
  if (!safe || safe === "." || safe === "..") {
    const ext = mimeExtension(mime);
    safe = ext ? `pasted.${ext}` : "pasted";
  }
  return `${randomUUID().slice(0, 8)}-${safe}`;
}

/** Map a MIME type to a file extension, or undefined when unknown. */
function mimeExtension(mime: string | undefined): string | undefined {
  if (!mime) {
    return undefined;
  }
  return MIME_EXTENSIONS[mime.split(";")[0].trim().toLowerCase()];
}

/**
 * Remove uploaded files for sessions that are no longer live (best-effort).
 * Called on the session lifecycle ("exited"/"closed") to drop a single session's
 * dir, and on boot (sweep) to clear orphan dirs left by a crash. Errors are
 * swallowed — stale upload files are harmless, and cleanup must never break a
 * lifecycle handler or startup.
 */
async function removeSessionUploads(daemonDir: string, sessionId: string): Promise<void> {
  await rm(sessionUploadsDir(daemonDir, sessionId), { recursive: true, force: true }).catch(
    () => undefined
  );
}

/**
 * On boot, remove any uploads/<id> dir whose <id> is not a currently-live
 * session — orphans from a previous daemon process that crashed before its
 * lifecycle cleanup ran. Best-effort; a missing/empty uploads root is a no-op.
 */
async function sweepOrphanUploads(daemonDir: string, liveIds: Set<string>): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(uploadsRootDir(daemonDir));
  } catch {
    return; // no uploads dir yet (or unreadable) — nothing to sweep.
  }
  await Promise.all(
    entries
      .filter((id) => !liveIds.has(id))
      .map((id) => removeSessionUploads(daemonDir, id))
  );
}

/**
 * Resolve `target` and verify it is `root` itself or strictly inside it (after
 * following symlinks). Returns the realpath when safe, else null. Used to make
 * the destructive delete endpoints reject path traversal / symlink escapes.
 */
async function resolveWithinWorkspaces(target: string, root: string): Promise<string | null> {
  let realTarget: string;
  let realRoot: string;
  try {
    realTarget = await realpath(target);
    realRoot = await realpath(root);
  } catch {
    return null; // target (or root) doesn't exist
  }
  if (realTarget === realRoot || realTarget.startsWith(realRoot + sep)) {
    return realTarget;
  }
  return null;
}

async function listDirectories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function listWorkspaces(
  workspacesDir: string,
  metaFile: string
): Promise<WorkspaceSummary[]> {
  const names = await listDirectories(workspacesDir);
  const meta = await readWorkspacesMeta(metaFile);
  const byName = new Map(meta.workspaces.map((w) => [w.name, w]));
  return Promise.all(
    names.map(async (name) => {
      const path = join(workspacesDir, name);
      const projects = await listDirectories(path);
      const entry = byName.get(name);
      // Counted against the directory listing, so names left over in
      // `archivedProjects` for since-deleted dirs never inflate it.
      const archived = new Set(entry?.archivedProjects ?? []);
      return {
        name,
        path,
        projectCount: projects.length,
        archivedProjectCount: projects.filter((project) => archived.has(project)).length,
        gitAccountId: entry?.gitAccountId ?? null,
        createdAt: entry?.createdAt,
        isArchived: entry?.isArchived ?? false
      };
    })
  );
}

async function listProjects(
  workspacesDir: string,
  workspace: string,
  metaFile: string
): Promise<ProjectSummary[]> {
  const names = await listDirectories(join(workspacesDir, workspace));
  const meta = await readWorkspacesMeta(metaFile);
  const archived = new Set(
    meta.workspaces.find((w) => w.name === workspace)?.archivedProjects ?? []
  );
  return Promise.all(
    names.map(async (name) => {
      const path = join(workspacesDir, workspace, name);
      const repo = await detectRepoInfo(path);
      // repoKey/repoName/cloneUrl come together off a parseable origin, credentials stripped.
      const remote = repo?.originUrl ? remoteRepoFields(repo.originUrl) : null;
      return {
        name,
        workspace,
        path,
        isArchived: archived.has(name),
        ...(repo === null ? {} : { repoId: repo.repoId }),
        ...(remote ?? {})
      };
    })
  );
}

/**
 * Build a `Content-Disposition: attachment` value. The ASCII filename="" form is
 * a fallback with control/quote/backslash and non-ASCII bytes replaced by "_";
 * the RFC 5987 filename*=UTF-8'' form carries the real (possibly non-ASCII) name
 * for browsers that honor it.
 */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Map a thrown error from a /api/git/* handler to a reply: a sandbox escape →
 * 403 FS_FORBIDDEN (as the fs routes do), a GitError → its `status`, anything
 * else → 500, both as { code:"GIT_ERROR", message }.
 */
function gitError(reply: FastifyReply, error: unknown): void {
  if (error instanceof FsSandboxError) {
    void reply.code(403).send({ code: "FS_FORBIDDEN", message: error.message });
    return;
  }
  const status = error instanceof GitError ? error.status : 500;
  const message = error instanceof Error ? error.message : "Git operation failed.";
  // boxes: a box project's git panel learns BOX_NOT_READY (its box is away) rather than GIT_ERROR.
  const code = error instanceof GitError && error.code ? error.code : "GIT_ERROR";
  void reply.code(status).send({ code, message });
}

/**
 * Given a desired absolute file path, return it if free, else the next free
 * `name (n).ext` in the same directory (n = 1, 2, …). Backs the upload route's
 * "rename" (keep-both) conflict resolution. A leading-dot name (".env") is kept
 * whole — its dot is not an extension.
 */
async function nextAvailableName(desired: string): Promise<string> {
  const dir = dirname(desired);
  const base = basename(desired);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  for (let n = 1; ; n++) {
    const candidate = join(dir, `${stem} (${n})${ext}`);
    try {
      await stat(candidate);
    } catch {
      return candidate; // stat threw → does not exist → free
    }
  }
}

/** List a directory for the file browser (dirs first, dotfiles included). */
async function listFiles(path: string): Promise<FsListResponse> {
  const dirents = await readdir(path, { withFileTypes: true });
  const entries: FsEntry[] = await Promise.all(
    dirents.map(async (dirent) => {
      const full = join(path, dirent.name);
      const kind = dirent.isDirectory() ? "dir" : "file";
      let size = 0;
      if (kind === "file") {
        try {
          size = (await stat(full)).size;
        } catch {
          size = 0;
        }
      }
      return { name: dirent.name, path: full, kind, size } as FsEntry;
    })
  );

  entries.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === "dir" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  const parent = dirname(path);
  return { path, parent: parent === path ? null : parent, entries };
}

async function readAppConfigFile(file: string): Promise<AppConfig> {
  try {
    return parseAppConfig(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return createDefaultAppConfig();
  }
}

async function readRemotesFile(file: string): Promise<RemotesConfig> {
  try {
    return parseRemotesConfig(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return createDefaultRemotesConfig();
  }
}

/**
 * Tolerant read for the *read-only* paths (listings, lookups): a missing or
 * unreadable workspaces.json degrades to an empty side-table so the sidebar
 * still lists the directories on disk. Never use this as the basis of a write —
 * see `readWorkspacesMetaStrict`.
 */
async function readWorkspacesMeta(file: string): Promise<WorkspacesConfig> {
  try {
    return parseWorkspacesConfig(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return createDefaultWorkspacesConfig();
  }
}

/**
 * Read for the read-modify-write paths. Unlike the tolerant reader above this
 * distinguishes "no file yet" (→ a fresh default, safe to write) from "the file
 * exists but is unreadable/corrupt" (→ throw). Writing a default over a corrupt
 * file would silently drop every workspace's gitAccountId/createdAt/archive
 * state, so the mutation fails loud instead and leaves the file intact for
 * hand-repair — mirroring `sessions.reattach()`, which refuses to reap orphans
 * when sessions.json is corrupt.
 *
 * The detail (absolute path, parse error) is logged server-side only: there is
 * no Fastify error handler, so a thrown message reaches the remote client in the
 * 500 body — and the appdir path is exactly what `sanitizeDaemonConfig` masks
 * everywhere else.
 */
async function readWorkspacesMetaStrict(file: string): Promise<WorkspacesConfig> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return createDefaultWorkspacesConfig();
    }
    console.error(`Failed to read workspaces meta (${file})`, error);
    throw new Error("workspaces.json is unreadable; refusing to overwrite it.");
  }
  try {
    return parseWorkspacesConfig(JSON.parse(raw));
  } catch (error) {
    console.error(`Failed to parse workspaces meta (${file})`, error);
    throw new Error("workspaces.json is unreadable; refusing to overwrite it.");
  }
}

async function writeWorkspacesMeta(file: string, value: WorkspacesConfig): Promise<void> {
  await writeJsonFile(file, value);
}

/**
 * Serializes every write of daemon.json. Both writers (the full
 * `PUT /api/config/daemon` and the remote-allowed protect-archived toggle,
 * which read-modify-writes the file) must share this queue: unserialized, the
 * toggle's stale in-flight copy can revert a config save on disk while the live
 * in-memory config keeps the new value — divergence that only surfaces at the
 * next restart. Module-level on purpose: both transports run in one process.
 */
let daemonConfigQueue: Promise<unknown> = Promise.resolve();

function queueDaemonConfigWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = daemonConfigQueue.then(task);
  // Keep the chain alive after a failed write (a rejected queue head would
  // reject every later write).
  daemonConfigQueue = run.catch(() => undefined);
  return run;
}

/**
 * Serializes every read-modify-write of workspaces.json. Without it two
 * concurrent mutations (archive two projects at once, delete while archiving,
 * …) both read the pre-write file and the second write silently drops the
 * first one's change. Module-level on purpose: both transports (unix socket +
 * HTTP) run in one process and must share the queue.
 */
let workspacesMetaQueue: Promise<unknown> = Promise.resolve();

/**
 * Run `mutate` against a freshly read workspaces.json and persist the result,
 * with all such mutations serialized against each other (see the queue above).
 * Two safety rules:
 *  - the read is STRICT (`readWorkspacesMetaStrict`) — a corrupt file throws
 *    instead of being silently replaced by an empty side-table;
 *  - the write is skipped when the mutation changed nothing, so the no-op
 *    prunes that run on every project create/delete never touch the file.
 */
async function mutateWorkspacesMeta<T>(
  file: string,
  mutate: (meta: WorkspacesConfig) => T | Promise<T>
): Promise<T> {
  const run = workspacesMetaQueue.then(async () => {
    const meta = await readWorkspacesMetaStrict(file);
    const before = JSON.stringify(meta);
    const result = await mutate(meta);
    if (JSON.stringify(meta) !== before) {
      await writeWorkspacesMeta(file, meta);
    }
    return result;
  });
  // Keep the chain alive after a failed mutation (a rejected queue head would
  // reject every later mutation).
  workspacesMetaQueue = run.catch(() => undefined);
  return run;
}

/**
 * Drop a project name from its workspace's `archivedProjects`. Used on both
 * delete and (re)create so a project directory that occupies a name left over
 * in the archive list can never come back invisible: `listProjects` flags any
 * listed name as archived and every client filters those rows out.
 */
async function pruneArchivedProject(
  metaFile: string,
  workspace: string,
  project: string
): Promise<void> {
  await mutateWorkspacesMeta(metaFile, (meta) => {
    const entry = meta.workspaces.find((w) => w.name === workspace);
    if (!entry) {
      return;
    }
    entry.archivedProjects = entry.archivedProjects.filter((name) => name !== project);
  });
}

/**
 * Persist JSON state atomically: write a sibling temp file, then rename over
 * the target (rename is atomic within a filesystem). A crash or a SIGTERM
 * hard-exit mid-write can therefore never leave a truncated half-JSON file
 * behind — readers see either the old or the new content.
 */
async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    // Create the temp file restrictive (0600) rather than at the ambient umask:
    // it can hold secrets (daemon.json's bcrypt passwordHash) and would
    // otherwise sit world-readable for the window between write and chmod.
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    // rename() carries the temp file's mode over, so replay the target's own
    // mode first — a tightened daemon.json must not silently widen on every
    // save, and a pre-existing non-secret file must not silently tighten to
    // 0600 either. A brand-new file lands at 0644, matching what the ambient
    // umask used to produce.
    const mode = await stat(file).then(
      (info) => info.mode & 0o777,
      () => 0o644
    );
    await chmod(tmp, mode).catch(() => undefined);
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** bcrypt-hash a plaintext password (stable hash persisted at rest). Cost 12
 *  slows offline cracking / per-guess derivation if a hash ever leaks; the
 *  expensive hash runs only at password-set and client-side login, so
 *  per-request auth stays cheap. */
function hashPassword(plaintext: string): string {
  return bcrypt.hashSync(plaintext, bcrypt.genSaltSync(12));
}

/** A request path percent-decoded as the router sees it; `undefined` when it is not valid percent-encoding. */
function safeDecodePath(path: string): string | undefined {
  try {
    return decodeURIComponent(path);
  } catch {
    return undefined;
  }
}

/**
 * Migrate a legacy/env plaintext `password` into a bcrypt `passwordHash` and
 * drop the plaintext. Returns true when the config changed (needs persisting).
 */
function migrateHttpPassword(config: DaemonConfig): boolean {
  const http = config.transports.http;
  if (http.password) {
    if (!http.passwordHash) {
      http.passwordHash = hashPassword(http.password);
    }
    http.password = undefined;
    return true;
  }
  return false;
}

async function loadConfig(paths: DaemonPaths, env: NodeJS.ProcessEnv): Promise<DaemonConfig> {
  const defaults = createDefaultDaemonConfig({ env });
  let config: DaemonConfig;
  let fileExists = true;

  try {
    const raw = await readFile(paths.configPath, "utf8");
    const fromDisk = JSON.parse(raw) as Partial<DaemonConfig>;
    config = parseDaemonConfig({
      ...defaults,
      ...fromDisk,
      transports: {
        http: { ...defaults.transports.http, ...fromDisk.transports?.http }
      }
    });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      config = defaults;
      fileExists = false;
    } else {
      throw error;
    }
  }

  // Hash any plaintext password and persist so nothing sensitive stays at rest.
  const changed = migrateHttpPassword(config);
  if (!fileExists || changed) {
    await mkdir(paths.daemonDir, { recursive: true });
    await writeFile(paths.configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }
  return config;
}

function validateTransportConfig(config: DaemonConfig): void {
  if (config.transports.http.enabled && !config.transports.http.passwordHash) {
    throw new Error(
      "HTTP transport requires a password (ORQUESTER_HTTP_PASSWORD or transports.http.password in daemon.json)."
    );
  }
}

async function prepareDirs(resolved: ResolvedPaths): Promise<void> {
  await mkdir(resolved.daemonDir, { recursive: true });
  await mkdir(resolved.logsDir, { recursive: true });
  await mkdir(resolved.workspacesDir, { recursive: true });
  await mkdir(resolved.keysDir, { recursive: true, mode: 0o700 });
  await mkdir(resolved.browserProfilesDir, { recursive: true, mode: 0o700 });
  await mkdir(resolved.desktopsRuntimeDir, { recursive: true, mode: 0o700 });
  await chmod(resolved.desktopsRuntimeDir, 0o700);
}

function sanitizeDaemonConfig(config: DaemonConfig): DaemonConfig {
  // Never expose credential material over the wire. The hash is no bearer
  // (only session tokens are, auth/sessions.ts) but it is an offline-crackable
  // copy of the password, and the username is deliberately withheld too — same
  // invariant as /api/auth/info, which only reports `requiresUsername`, never
  // the username itself. Both are masked with the same sentinel the schema
  // accepts as a string; the fsRoot (sandbox root path) is server-internal.
  // The client only ever needs enabled/host/port back.
  return {
    ...config,
    transports: {
      ...config.transports,
      http: {
        ...config.transports.http,
        username: "********",
        password: undefined,
        passwordHash: config.transports.http.passwordHash ? "********" : undefined,
        fsRoot: undefined
      }
    }
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
