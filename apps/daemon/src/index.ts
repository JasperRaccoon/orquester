import type {
  AccountSummary,
  AccountTestResult,
  AgentEventRequest,
  BrowserClientMessage,
  BrowserSuggestionsResponse,
  BrowserSummary,
  CreateAccountRequest,
  CreateBrowserRequest,
  CreateProjectRequest,
  CreateSessionRequest,
  CreateTodoRequest,
  CreateWorkspaceRequest,
  EventMessage,
  FsCapabilitiesResponse,
  FsCreateRequest,
  FsEntry,
  FsFilesResponse,
  FsListResponse,
  FsReadResponse,
  FsSearchResponse,
  FsUploadRequest,
  FsUploadResponse,
  FsWriteRequest,
  GitBranchesResponse,
  GitCommitDetail,
  GitDiffResponse,
  GitLogEntry,
  GitOpResult,
  GitStatusResponse,
  HealthResponse,
  ImportAgentAccountRequest,
  OpenRequest,
  OpenResult,
  ProjectSummary,
  PushInfoResponse,
  PushSubscribeRequest,
  PushTestResponse,
  PushUnsubscribeRequest,
  RegistryKind,
  RegistryResponse,
  RenameSessionRequest,
  RepoSummary,
  ReorderSessionsRequest,
  ServerInfoResponse,
  SetAgentAccountDefaultsRequest,
  SessionActivity,
  SessionActivityEvent,
  SessionInputRequest,
  SessionResizeRequest,
  SessionSummary,
  SessionUploadRequest,
  SessionUploadResponse,
  UpdateTodoRequest,
  UsageResponse,
  WorkspaceSummary
} from "@orquester/api";
import { BROWSER_FRAME_TYPE_JPEG } from "@orquester/api";
import { RegistryService } from "./registry";
import { BrowserError, BrowserManager } from "./browsers";
import { UrlWatcher } from "./url-watcher";
import { AgentHooks } from "./agent-hooks";
import { type ISessionManager, SessionError, createSessionManager } from "./sessions";
import type { ActivityCause } from "./ansi-activity";
import { TodoError, TodoListManager } from "./todos";
import { Tmux } from "./tmux";
import { Broadcaster } from "./broadcaster";
import { AccountError, AccountsService } from "./accounts";
import { AgentAccountsService } from "./agent-accounts.ts";
import { AgentAccountError } from "./agent-account-paths.ts";
import { PushService, isValidPushEndpoint } from "./push";
import { GitError, GitService } from "./git";
import { UsageService } from "./usage";
import { UsageTokensScanner } from "./usage-tokens";
import { createClaudeSource, createCodexSource, readUsagePrefs } from "./usage-sources";
import { listArchiveEntries } from "./archive";
import { resolveZipTool, spawnDirZip } from "./zip";
import { FsSearchError, listProjectFiles, searchProjectFiles } from "./search";
import { TerminalControl } from "./mcp/terminal-control.ts";
import { TodoTools } from "./mcp/todo-tools.ts";
import { FsTools } from "./mcp/fs-tools.ts";
import { registerMcp } from "./mcp/server.ts";
import {
  type AppConfig,
  type ClientConfig,
  type ConfigVars,
  type DaemonConfig,
  type DaemonPaths,
  type RemoteConnectionConfig,
  type RemotesConfig,
  type WorkspacesConfig,
  accountsConfigPath,
  agentAccountsDir,
  agentAccountsFile,
  appConfigPath,
  browserProfilesDir,
  browsersIndexPath,
  createDefaultAppConfig,
  createDefaultClientConfig,
  createDefaultDaemonConfig,
  createDefaultRemotesConfig,
  createDefaultWorkspacesConfig,
  dailyLogFile,
  expandVars,
  keysDir,
  parseAppConfig,
  parseDaemonConfig,
  parseRemotesConfig,
  parseWorkspacesConfig,
  pushConfigPath,
  remotesConfigPath,
  resolveDaemonPaths,
  sessionsIndexPath,
  tmuxSocketPath,
  todosIndexPath,
  usageTokensCacheFile,
  workspacesMetaPath,
  isValidName
} from "@orquester/config";
import { assertInsideFsRoot, FsSandboxError } from "@orquester/config/fs";
import fastifyStatic from "@fastify/static";
import websocketPlugin from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { createReadStream, createWriteStream, existsSync, type WriteStream } from "node:fs";
import { mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, platform as osPlatform } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { stat } from "node:fs/promises";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";

const daemonId = randomUUID();
const packageVersion = "0.0.0";

/**
 * Hard cap on a single terminal file upload (decoded bytes). The upload route's
 * Fastify `bodyLimit` is set higher (~40 MB) to leave room for base64 inflation
 * (+~33%) and JSON overhead; this is the post-decode ceiling enforced in the
 * handler. See docs/superpowers/specs/2026-06-22-terminal-file-drop-design.md.
 */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Hard ceiling on a single /api/fs/raw read: the in-memory + in-app download
 * limit for binary preview. See docs/superpowers/specs/2026-06-24-file-preview-design.md.
 */
const RAW_MAX_BYTES = 50 * 1024 * 1024;

/** Filesystem locations resolved (variables expanded) for this run. */
interface ResolvedPaths {
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
  /** <appdir>/daemon/todos.json — the managed to-do list index. */
  todosIndexFile: string;
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
    daemonDir: paths.daemonDir,
    configPath: paths.configPath,
    appConfigFile: appConfigPath(paths.baseDir),
    remotesFile: remotesConfigPath(paths.baseDir),
    workspacesMetaFile: workspacesMetaPath(paths.baseDir),
    tmuxSocket: tmuxSocketPath(paths.baseDir),
    sessionsIndexFile: sessionsIndexPath(paths.baseDir),
    browsersIndexFile: browsersIndexPath(paths.baseDir),
    browserProfilesDir: browserProfilesDir(paths.baseDir),
    todosIndexFile: todosIndexPath(paths.baseDir),
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

  const logStream = createWriteStream(dailyLogFile(resolved.logsDir), { flags: "a" });
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
    now: () => Date.now(),
    logger: console
  });
  const sessions = createSessionManager(registry, tmux, resolved.sessionsIndexFile, {
    resolveExtraEnv: async (entry, accountId) => {
      if (entry.kind !== "agent") return null;
      try {
        return await agentAccounts.resolveLaunchEnv(entry.id, accountId);
      } catch (error) {
        throw new SessionError(error instanceof Error ? error.message : String(error));
      }
    },
    daemonSockPath: paths.socketPath,
    onAgentLaunch: (entry, launchEnv) => agentHooks.ensureForEntry(entry.id, launchEnv)
  });
  const accounts = new AccountsService(resolved.accountsFile, resolved.keysDir);
  const git = new GitService();
  const todos = new TodoListManager(resolved.todosIndexFile, console);
  await todos.load();
  const push = new PushService(resolved.pushConfigFile, console);
  const broadcaster = new Broadcaster();
  // Stream registry changes (install/update status, detected versions) to clients.
  registry.events.on("changed", (entry) => broadcaster.publish("registry", "registry.changed", entry));
  agentAccounts.events.on("changed", (payload) => broadcaster.publish("agent-accounts", "agent-accounts.changed", payload));
  const baseClaude = createClaudeSource({ userhome: resolved.vars.userhome, now: () => Date.now(), logger: console });
  const usage = new UsageService({
    fetchClaude: baseClaude,
    readCodex: createCodexSource({ userhome: resolved.vars.userhome, now: () => Date.now() }),
    getPrefs: () => readUsagePrefs(resolved.appConfigFile),
    now: () => Date.now()
  });
  usage.events.on("changed", (u) => broadcaster.publish("usage", "usage.changed", u));
  usage.start();
  const usageTokens = new UsageTokensScanner({
    userhome: resolved.vars.userhome,
    cacheFile: usageTokensCacheFile(paths.baseDir),
    now: () => Date.now()
  });
  await usageTokens.init();
  {
    const { watch } = await import("node:fs");
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const nudge = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        void usage.recompute();
        void usageTokens.recompute();
      }, 500);
    };
    for (const dir of [
      join(process.env.CODEX_HOME || join(resolved.vars.userhome, ".codex"), "sessions"),
      process.env.CLAUDE_CONFIG_DIR || join(resolved.vars.userhome, ".claude")
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
  await sessions.reattach().catch((error) => console.error("Session reattach failed", error));
  await agentAccounts.init();
  agentAccounts.startRefresher(() => sessions.liveAccountIds());
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
    broadcaster.publish("sessions", "session.closed", payload);
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
      if (event.kind !== "agent") {
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

  // Server-side browser tabs (Design Mode). Chromium resolves through the
  // registry's probed browser entries; no bundled download.
  const browsers = new BrowserManager({
    indexFile: resolved.browsersIndexFile,
    profilesDir: resolved.browserProfilesDir,
    resolveChromium: () =>
      registry.list().browsers.find((b) => b.enabled && b.resolvedBin)?.resolvedBin
  });
  await browsers.load();
  browsers.lifecycle.on("created", (b) => broadcaster.publish("browser", "browser.created", b));
  browsers.lifecycle.on("updated", (b) => broadcaster.publish("browser", "browser.updated", b));
  browsers.lifecycle.on("closed", (p) => broadcaster.publish("browser", "browser.closed", p));

  // Dev-server URL suggestions: fed from every session's PTY output.
  const urlWatcher = new UrlWatcher();
  sessions.lifecycle.on("output", ({ id, data }: { id: string; data: string }) => {
    const summary = sessions.get(id);
    if (summary?.projectPath) urlWatcher.ingest(summary.projectPath, data);
  });

  const services: Services = {
    registry, sessions, accounts, git, todos, usage, usageTokens, push, broadcaster, agentAccounts, browsers, urlWatcher
  };

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
  await unixServer.listen({ path: paths.socketPath });

  // The external HTTP transport is opt-in and hot-reloadable: changing its
  // config (password / host / port / enabled) restarts THIS transport only —
  // the daemon, sessions (PTYs) and the unix transport keep running. Connected
  // clients are dropped and reconnect (re-authenticating on a password change).
  let httpServer: FastifyInstance | null = null;
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
    await stopHttp();
    try {
      await startHttp();
    } catch (error) {
      console.error("Failed to (re)start HTTP transport", error);
    }
  };

  await startHttp();

  const stop = async () => {
    usage.stop();
    agentAccounts.stopRefresher();
    // Detach (don't kill) sessions: the tmux backend leaves its server running so
    // the next boot reattaches; the local backend has no server, so its shutdown()
    // terminates the child PTYs (they'd die with the daemon regardless).
    sessions.shutdown();
    await browsers.shutdown();
    await stopHttp();
    const unixClosed = unixServer.close();
    unixServer.server.closeAllConnections?.();
    await unixClosed.catch(() => undefined);
  };

  console.log(`Orquester daemon ${daemonId} on unix:${paths.socketPath} (workspaces: ${resolved.workspacesDir})`);

  return {
    daemonId,
    socketPath: paths.socketPath,
    workspacesDir: resolved.workspacesDir,
    stop
  };
}

interface Services {
  registry: RegistryService;
  sessions: ISessionManager;
  accounts: AccountsService;
  git: GitService;
  todos: TodoListManager;
  usage: UsageService;
  usageTokens: UsageTokensScanner;
  push: PushService;
  broadcaster: Broadcaster;
  agentAccounts: AgentAccountsService;
  browsers: BrowserManager;
  urlWatcher: UrlWatcher;
  /** Restart the HTTP transport (set in main once the lifecycle exists). */
  reloadHttp?: () => Promise<void>;
}

function createServer(
  config: DaemonConfig,
  resolved: ResolvedPaths,
  clientConfig: ClientConfig,
  logStream: WriteStream,
  services: Services,
  options: { authRequired: boolean; mode: "local" | "remote"; serveWeb?: string }
): FastifyInstance {
  const { registry, sessions, accounts, git, todos, usage, usageTokens, push, agentAccounts } = services;

  const app = Fastify({
    // Remote requests arrive via Caddy on loopback (reverse_proxy 127.0.0.1:47831),
    // so trust ONLY the loopback hop. proxy-addr then resolves request.ip to the
    // closest UNtrusted address — the real client IP that Caddy appended to
    // X-Forwarded-For — instead of the literal 127.0.0.1 socket peer. This is what
    // makes the per-IP login throttle key on the actual client (see clientIp).
    // The unix-socket transport has no proxy, so leave it off there.
    trustProxy: options.mode === "remote" ? "127.0.0.1" : false,
    logger: {
      level: "info",
      stream: logStream,
      serializers: {
        // Strip the WS `?token=` from request logs (TLS protects it on the wire,
        // but it must never land in plaintext logs). Other query params are kept.
        req(request: { method: string; url: string }) {
          return { method: request.method, url: request.url.replace(/([?&]token=)[^&]*/i, "$1[redacted]") };
        }
      }
    }
  });

  const throttle = new LoginThrottle();

  app.addHook("onRequest", async (request, reply) => {
    // The multiplexed session WebSocket authenticates itself via a query token
    // (browsers can't set WS headers) and must skip the bearer logic below.
    if (request.url.split("?")[0] === "/ws") {
      return;
    }

    // Only the API + event stream are token-gated; the static web client, its
    // assets and the public auth-info endpoint load freely (the web app then
    // authenticates its API calls with the credential bearer).
    const url = request.url.split("?")[0];
    const needsAuth =
      (url.startsWith("/api") || url.startsWith("/events") || url.startsWith("/mcp")) &&
      url !== "/api/auth/info";
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
    // header, so /api/fs/download also accepts the credential as ?token= — the
    // same trick /ws uses. Scoped to this one route; the token is redacted from
    // logs by the request serializer above.
    const headerToken = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const queryToken = url === "/api/fs/download" ? (request.query as { token?: string }).token : undefined;
    const authorized = authorizeCredential(
      headerToken ?? queryToken,
      config.transports.http.username,
      config.transports.http.passwordHash
    );
    if (!authorized) {
      throttle.recordFailure(ip);
      return reply.code(401).send({
        code: "UNAUTHORIZED",
        message: "A valid bearer token is required for this daemon transport."
      });
    }
    throttle.recordSuccess(ip);
  });

  // Public: tells the web client whether auth is needed and the bcrypt salt to
  // derive the bearer (the same hash the daemon stores). Never exposes the hash
  // OR the username — only whether a username is required.
  app.get("/api/auth/info", async () => {
    const authRequired = options.mode === "remote" && Boolean(config.transports.http.passwordHash);
    return {
      authRequired,
      salt: config.transports.http.passwordHash
        ? config.transports.http.passwordHash.slice(0, 29)
        : null,
      requiresUsername: authRequired
    };
  });

  // Public liveness only. Daemon id / version / mode / transports are not
  // disclosed to unauthenticated callers (moved behind /api/info, which is gated).
  app.get("/health", async (): Promise<HealthResponse> => ({ ok: true }));

  app.get("/api/info", async (): Promise<ServerInfoResponse> => ({
    name: "Orquester daemon",
    dataDir: resolved.daemonDir,
    workspacesDir: resolved.workspacesDir,
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
    // A new plaintext password (when provided) is hashed; otherwise keep the
    // existing hash. We never persist plaintext.
    const passwordHash =
      httpPatch.password && httpPatch.password !== "********"
        ? hashPassword(httpPatch.password)
        : config.transports.http.passwordHash;
    // Username is not editable through this endpoint, but a client may echo back
    // a GET response in which it was masked. Drop the sentinel so the real
    // username (preserved from the existing config) is never overwritten by it.
    if (httpPatch.username === "********") {
      delete httpPatch.username;
    }

    let merged: DaemonConfig;
    try {
      merged = parseDaemonConfig({
        version: 1,
        workspacesDir: body.workspacesDir ?? config.workspacesDir,
        logsDir: body.logsDir ?? config.logsDir,
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
      return reply.code(400).send({ code: "INVALID_CONFIG", message: "Invalid daemon config." });
    }

    if (merged.transports.http.enabled && !merged.transports.http.passwordHash) {
      return reply.code(400).send({
        code: "PASSWORD_REQUIRED",
        message: "Enabling external HTTP access requires a password (min 8 chars)."
      });
    }

    await writeFile(resolved.configPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");

    // Apply live in-process (no daemon restart): update the shared config + dirs,
    // then hot-restart the HTTP transport so the new password/host/port/enabled
    // take effect immediately. Sessions (PTYs) and the unix transport are untouched.
    Object.assign(config, merged);
    resolved.workspacesDir = expandVars(merged.workspacesDir, resolved.vars);
    resolved.fsRoot = merged.transports.http.fsRoot
      ? expandVars(merged.transports.http.fsRoot, resolved.vars)
      : resolved.workspacesDir;
    resolved.logsDir = expandVars(merged.logsDir, resolved.vars);
    await mkdir(resolved.workspacesDir, { recursive: true }).catch(() => undefined);
    void services.reloadHttp?.();

    return sanitizeDaemonConfig(config);
  });

  if (options.mode === "local") {
    app.post("/api/daemon/shutdown", async (_request, reply) => {
      services.broadcaster.publish("daemon", "daemon.shutdown", {});
      return reply.code(204).send();
    });
  }

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

    // Upsert the metadata side-table entry (keyed by name).
    const createdAt = new Date().toISOString();
    const meta = await readWorkspacesMeta(resolved.workspacesMetaFile);
    const entry = { name, gitAccountId: body?.gitAccountId, createdAt };
    meta.workspaces = [...meta.workspaces.filter((w) => w.name !== name), entry];
    await writeWorkspacesMeta(resolved.workspacesMetaFile, meta);

    // Bind the git account (immutable): write the include file + register the
    // global includeIf rule for this workspace's realpath. Best-effort — a
    // binding failure must not orphan the just-created dir/metadata.
    if (entry.gitAccountId) {
      await services.accounts.bindWorkspace(entry.gitAccountId, path).catch((error) => {
        app.log.error({ err: error }, "git account binding failed");
      });
    }

    return { name, path, projectCount: 0, gitAccountId: entry.gitAccountId ?? null, createdAt };
  });

  app.get<{ Params: { workspace: string } }>(
    "/api/workspaces/:workspace/projects",
    async (request, reply): Promise<ProjectSummary[] | void> => {
      const { workspace } = request.params;
      if (!isValidName(workspace)) {
        return reply.code(400).send({ code: "INVALID_NAME", message: "Invalid workspace name." });
      }
      return listProjects(resolved.workspacesDir, workspace);
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

      // Empty (or absent source): today's behavior — mkdir the validated name.
      if (body.source === undefined || body.source === "empty") {
        const name = body.name;
        if (!isValidName(name)) {
          return reply.code(400).send({ code: "INVALID_NAME", message: "Invalid name." });
        }
        const path = join(workspaceDir, name);
        await mkdir(path, { recursive: true });
        return { name, workspace, path };
      }

      // Repo modes (clone/create) resolve the GitHub account from the WORKSPACE's
      // gitAccountId. 400 if the workspace has no linked account (the no-token case
      // is enforced by the accounts methods, which throw AccountError(400)).
      const accountId = (await readWorkspacesMeta(resolved.workspacesMetaFile)).workspaces.find(
        (w) => w.name === workspace
      )?.gitAccountId;
      if (!accountId) {
        return reply.code(400).send({
          code: "NO_GIT_ACCOUNT",
          message: "This workspace has no linked GitHub account."
        });
      }

      try {
        if (body.source === "clone") {
          const sshUrl = normalizeRepoUrl(body.url);
          if (!sshUrl) {
            return reply.code(400).send({ code: "INVALID_URL", message: "Unrecognized repository URL." });
          }
          const name = body.name ?? repoNameFromSshUrl(sshUrl);
          if (!isValidName(name)) {
            return reply.code(400).send({ code: "INVALID_NAME", message: "Invalid name." });
          }
          const path = join(workspaceDir, name);
          if (existsSync(path)) {
            return reply.code(409).send({ code: "ALREADY_EXISTS", message: `"${name}" already exists.` });
          }
          await mkdir(workspaceDir, { recursive: true });
          await accounts.cloneRepo(accountId, sshUrl, name, workspaceDir);
          return { name, workspace, path };
        }

        if (body.source === "create") {
          // Make the repo (REST), then clone the returned SSH URL.
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
          await accounts.cloneRepo(accountId, repo.sshUrl, name, workspaceDir);
          return { name, workspace, path };
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

      // Cascade against `target` (the non-realpath join), not `safe`: sessions
      // store projectPath as the raw client-sent join path (sessions.ts:122/552
      // ← listProjects index.ts), so closeByProjectPrefix must match that form,
      // not the realpath, or symlinked workspace roots (e.g. /tmp → /private/tmp)
      // never match and the dir is removed while sessions keep running.
      sessions.closeByProjectPrefix(target);
      // Cascade-close this project's browser tabs (kills its Chromium too).
      await services.browsers.closeForProject(target);
      // Cascade-delete this project's to-do lists (match `target`, the raw-join
      // path used as the list refKey — not the realpath `safe`).
      await todos.deleteByProjectPath(target);
      await rm(safe, { recursive: true, force: true });
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

      // Kill every session under the workspace, remove the tree, then prune the
      // metadata entry (keyed by name). Cascade against `target` (non-realpath
      // join), not `safe`: stored projectPaths use the raw join form, so matching
      // the realpath would miss every session under a symlinked workspace root.
      sessions.closeByProjectPrefix(target);
      // Cascade-delete the workspace's own to-do lists AND every list under a
      // project inside it (`workspace` = name refKey; `target` = raw-join path).
      await todos.deleteByWorkspace(workspace, target);
      // Drop the git includeIf binding BEFORE removing the tree: unbindWorkspace
      // realpaths the dir to rebuild the same matcher bindWorkspace used, so it
      // must run while the dir still exists (on macOS the literal /tmp path and
      // its /private/tmp realpath differ — a post-rm fallback wouldn't match).
      await services.accounts.unbindWorkspace(target).catch(() => undefined);
      await rm(safe, { recursive: true, force: true });
      const meta = await readWorkspacesMeta(resolved.workspacesMetaFile);
      meta.workspaces = meta.workspaces.filter((w) => w.name !== workspace);
      await writeWorkspacesMeta(resolved.workspacesMetaFile, meta);

      return reply.code(204).send();
    }
  );

  // App config (app.json) + remote servers (remotes.json) live on the daemon so
  // they're shared across every client connected to it. Editable on any transport.
  app.get("/api/config/app", async (): Promise<AppConfig> => readAppConfigFile(resolved.appConfigFile));

  app.put("/api/config/app", async (request, reply): Promise<AppConfig | void> => {
    const current = await readAppConfigFile(resolved.appConfigFile);
    try {
      const merged = parseAppConfig({ ...current, ...((request.body as object) ?? {}) });
      await writeJsonFile(resolved.appConfigFile, merged);
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

  // Set/replace an account's GitHub PAT (for REST list/create repos). Validated
  // against the account's githubLogin; stored at rest (0600), never returned.
  app.post<{ Params: { id: string }; Body: { token?: string } }>(
    "/api/accounts/:id/token",
    async (request, reply): Promise<void> => {
      try {
        await accounts.setToken(request.params.id, request.body?.token ?? "");
        return reply.code(204).send();
      } catch (error) {
        const status = error instanceof AccountError ? error.status : 500;
        const message = error instanceof Error ? error.message : "Could not save the token.";
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

  // List the org logins the account belongs to (create-owner picker). 400 if no token.
  app.get<{ Params: { id: string } }>(
    "/api/accounts/:id/orgs",
    async (request, reply): Promise<string[] | void> => {
      try {
        return await accounts.listOrgs(request.params.id);
      } catch (error) {
        const status = error instanceof AccountError ? error.status : 500;
        const message = error instanceof Error ? error.message : "Could not list organizations.";
        return reply.code(status).send({ code: "ACCOUNT_ERROR", message });
      }
    }
  );

  // File browser: list a directory.
  app.get<{ Querystring: { path?: string } }>(
    "/api/fs",
    async (request, reply): Promise<FsListResponse | void> => {
      const path = request.query.path;
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
  app.get<{ Querystring: { path?: string } }>(
    "/api/fs/files",
    async (request, reply): Promise<FsFilesResponse | void> => {
      const path = request.query.path;
      if (!path) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: "path required." });
      }
      const abort = new AbortController();
      const onClose = () => abort.abort();
      reply.raw.on("close", onClose);
      try {
        const safe = await assertInsideFsRoot(resolved.fsRoot, path);
        return await listProjectFiles(resolved.fsRoot, safe, { signal: abort.signal });
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
      path?: string;
      q?: string;
      caseSensitive?: string;
      wholeWord?: string;
      regex?: string;
      include?: string;
      exclude?: string;
      maxResults?: string;
    };
  }>(
    "/api/fs/search",
    async (request, reply): Promise<FsSearchResponse | void> => {
      const { path, q } = request.query;
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
  app.get<{ Querystring: { path?: string } }>(
    "/api/fs/read",
    async (request, reply): Promise<FsReadResponse | void> => {
      const path = request.query.path;
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
  app.get<{ Querystring: { path?: string } }>("/api/fs/raw", async (request, reply) => {
    const path = request.query.path;
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
  app.get<{ Querystring: { path?: string } }>("/api/fs/archive", async (request, reply) => {
    const path = request.query.path;
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
  app.get<{ Querystring: { path?: string } }>("/api/fs/download", async (request, reply) => {
    const path = request.query.path;
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

  // Upload one file into the project tree (a folder is many requests from the
  // client). Sibling of /api/fs/create: same fsRoot sandbox + error mapping,
  // plus the session-upload route's base64/bodyLimit/ENOSPC handling. Writes
  // with `wx` by default so an upload never silently clobbers — a pre-existing
  // target comes back as { conflict:true } (200, NOT an error) so the client
  // can prompt; "overwrite"/"rename" act only on an explicit user choice. The
  // client supplies destDir + relativePath, but the joined final path is
  // re-sanitized and assertInsideFsRoot'd, so nothing escapes fsRoot.
  app.post<{ Body: FsUploadRequest }>(
    "/api/fs/upload",
    { bodyLimit: 40 * 1024 * 1024 },
    async (request, reply): Promise<FsUploadResponse | void> => {
      const body = (request.body ?? {}) as Partial<FsUploadRequest>;
      if (!body.destDir || !body.relativePath || typeof body.dataBase64 !== "string") {
        return reply
          .code(400)
          .send({ code: "INVALID_REQUEST", message: "destDir, relativePath and dataBase64 required." });
      }
      // Sanitize the relative path: split on either separator, drop empties,
      // reject any "."/".." segment. assertInsideFsRoot below is authoritative;
      // this is defense in depth + a clean 400 for obvious garbage.
      const segments = body.relativePath.split(/[\\/]+/).filter((s) => s.length > 0);
      if (segments.length === 0 || segments.some((s) => s === "." || s === "..")) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: "relativePath is invalid." });
      }
      const onConflict = body.onConflict ?? "error";

      const buffer = Buffer.from(body.dataBase64, "base64");
      if (buffer.length > MAX_UPLOAD_BYTES) {
        return reply.code(413).send({
          code: "UPLOAD_TOO_LARGE",
          message: `File exceeds the ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB upload limit.`
        });
      }
      // Buffer.from(…, "base64") silently drops invalid chars → empty buffer.
      if (buffer.length === 0) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: "dataBase64 is not valid base64." });
      }

      const leaf = segments[segments.length - 1];
      try {
        const safeDir = await assertInsideFsRoot(resolved.fsRoot, body.destDir);
        const target = await assertInsideFsRoot(resolved.fsRoot, join(safeDir, ...segments));

        // Create the parent chain. If a path segment is already a FILE, mkdir
        // fails ENOTDIR/EEXIST — a file/dir type clash, surfaced as a conflict
        // the client resolves (Skip / Keep both), not a 500. Other mkdir errors
        // (ENOSPC, EACCES) rethrow to the outer catch.
        try {
          await mkdir(dirname(target), { recursive: true });
        } catch (error) {
          const code = (error as NodeJS.ErrnoException)?.code;
          if (code === "ENOTDIR" || code === "EEXIST") {
            return { path: "", name: leaf, size: 0, conflict: true, conflictKind: "file" };
          }
          throw error;
        }

        if (onConflict === "error") {
          try {
            await writeFile(target, buffer, { flag: "wx" });
          } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
              const existing = await stat(target).catch(() => null);
              return {
                path: "",
                name: leaf,
                size: 0,
                conflict: true,
                conflictKind: existing?.isDirectory() ? "dir" : "file"
              };
            }
            throw error;
          }
          return { path: target, name: leaf, size: buffer.length };
        }

        if (onConflict === "rename") {
          const renamed = await nextAvailableName(target);
          await writeFile(renamed, buffer, { flag: "wx" });
          return { path: renamed, name: basename(renamed), size: buffer.length };
        }

        // "overwrite" — replace. EISDIR if a directory is there (the client
        // never offers Replace for a dir clash) → mapped to FS_ERROR below.
        await writeFile(target, buffer);
        return { path: target, name: leaf, size: buffer.length };
      } catch (error) {
        if (error instanceof FsSandboxError) {
          return reply.code(403).send({ code: "FS_FORBIDDEN", message: error.message });
        }
        const code = (error as NodeJS.ErrnoException)?.code === "ENOSPC" ? 507 : 400;
        return reply.code(code).send({
          code: "FS_ERROR",
          message: error instanceof Error ? error.message : "Cannot store the uploaded file."
        });
      }
    }
  );

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
        await rm(safe, { recursive: true, force: false });
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

  // Registry (shells & agents)
  app.get("/api/registry", async (): Promise<RegistryResponse> => registry.list());

  app.get<{ Querystring: { refresh?: string } }>("/api/usage", async (request): Promise<UsageResponse> =>
    usage.snapshot(request.query.refresh === "1")
  );

  app.get("/api/usage/tokens", async (request) => {
    const force = (request.query as { refresh?: string })?.refresh === "1";
    return usageTokens.snapshot(force);
  });

  // Managed agent accounts (Claude/Codex credential homes) — import/list/remove/defaults.
  app.get("/api/agent-accounts", async () => agentAccounts.list());

  app.post("/api/agent-accounts", async (request, reply) => {
    const body = (request.body ?? {}) as ImportAgentAccountRequest;
    try {
      return await agentAccounts.importAccount(body);
    } catch (error) {
      if (error instanceof AgentAccountError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });

  app.delete("/api/agent-accounts/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await agentAccounts.removeAccount(id);
      return { ok: true };
    } catch (error) {
      if (error instanceof AgentAccountError) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });

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

  // Sessions (PTYs)
  app.get<{ Querystring: { projectPath?: string } }>(
    "/api/sessions",
    async (request): Promise<SessionSummary[]> => sessions.list(request.query.projectPath)
  );

  app.post("/api/sessions", async (request, reply): Promise<SessionSummary | void> => {
    try {
      return await sessions.create((request.body ?? {}) as CreateSessionRequest);
    } catch (error) {
      const message = error instanceof SessionError ? error.message : "Failed to create session.";
      return reply.code(400).send({ code: "SESSION_UNAVAILABLE", message });
    }
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
      const summary = sessions.rename(request.params.id, request.body?.title ?? "");
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
      return { urls: projectPath ? services.urlWatcher.suggestions(projectPath) : [] };
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
          (body.source !== "claude" && body.source !== "codex" && body.source !== "opencode") ||
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
  // The route-level bodyLimit overrides the 256 KB global default so a base64
  // 25 MB file fits; MAX_UPLOAD_BYTES is the post-decode ceiling.
  app.post<{ Params: { id: string }; Body: SessionUploadRequest }>(
    "/api/sessions/:id/upload",
    { bodyLimit: 40 * 1024 * 1024 },
    async (request, reply): Promise<SessionUploadResponse | void> => {
      const { id } = request.params;
      if (!sessions.get(id)) {
        return reply.code(404).send({ code: "SESSION_NOT_FOUND", message: "Session does not exist." });
      }
      const body = (request.body ?? {}) as Partial<SessionUploadRequest>;
      if (typeof body.dataBase64 !== "string" || body.dataBase64.length === 0) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: "dataBase64 required." });
      }
      const buffer = Buffer.from(body.dataBase64, "base64");
      if (buffer.length > MAX_UPLOAD_BYTES) {
        return reply.code(413).send({
          code: "UPLOAD_TOO_LARGE",
          message: `File exceeds the ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB upload limit.`
        });
      }
      // Buffer.from(…, "base64") silently drops invalid chars, so garbage input
      // decodes to an empty buffer. A non-empty payload that yields zero bytes is
      // malformed — reject it rather than writing an empty file.
      if (buffer.length === 0) {
        return reply.code(400).send({ code: "INVALID_REQUEST", message: "dataBase64 is not valid base64." });
      }

      const name = uploadFileName(body.name ?? "", body.type);
      const dir = sessionUploadsDir(resolved.daemonDir, id);
      const path = join(dir, name);
      // Mirror the accounts.json / keys conventions: 0700 dir, 0600 file. A
      // filesystem failure (disk full, permission denied, …) must surface as a
      // clean error, not an unhandled rejection: map ENOSPC to 507, else 500.
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await writeFile(path, buffer, { mode: 0o600 });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code === "ENOSPC" ? 507 : 500;
        return reply.code(code).send({
          code: "UPLOAD_FAILED",
          message: error instanceof Error ? error.message : "Cannot store the uploaded file."
        });
      }

      return { path, name, size: buffer.length };
    }
  );

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

  // Daemon event bus (newline-delimited JSON): lifecycle broadcasts + heartbeat.
  app.get("/events", (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "application/x-ndjson",
      "cache-control": "no-cache",
      "x-accel-buffering": "no"
    });

    const sink = { send: (data: string) => reply.raw.write(`${data}\n`) };
    services.broadcaster.add(sink);

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

    request.raw.on("close", () => {
      clearInterval(timer);
      services.broadcaster.remove(sink);
    });
  });

  // Multiplexed session I/O over a single WebSocket. The web client opens ONE
  // socket for ALL its terminals (output + input + resize) instead of one
  // streaming HTTP connection each, so it no longer hits the browser's
  // ~6-connections-per-origin cap (which otherwise froze input/resize once more
  // than ~4 terminals were open). Registered in an encapsulated context so the
  // plugin is loaded before the route is declared.
  void app.register(async (instance) => {
    await instance.register(websocketPlugin);
    instance.get("/ws", { websocket: true }, (socket, request) => {
      if (options.authRequired) {
        const token = (request.query as { token?: string }).token;
        if (!authorizeCredential(token, config.transports.http.username, config.transports.http.passwordHash)) {
          socket.close(1008, "unauthorized");
          return;
        }
      }

      const subs = new Map<string, () => void>();
      // Ids whose sub-time scrollback was captured before the client reported its
      // real terminal size; re-sent once on the first resize after the sub so an
      // alt-screen grid that was captured at the wrong width arrives un-wrapped.
      const resyncPending = new Set<string>();
      const send = (msg: unknown) => {
        try {
          socket.send(JSON.stringify(msg));
        } catch {
          /* socket closing */
        }
      };

      socket.on("message", async (raw) => {
        let msg: { t?: string; id?: string; data?: string; cols?: number; rows?: number };
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        // Liveness probe: mobile browsers kill a backgrounded tab's socket
        // without a close frame, so the client pings on wake and treats a
        // missing pong as a dead socket (see WsSessionChannel.wake).
        if (msg.t === "ping") {
          send({ t: "pong" });
          return;
        }
        const id = msg.id;
        if (!id) {
          return;
        }
        if (msg.t === "sub") {
          const summary = sessions.get(id);
          if (!summary) {
            send({ t: "end", id });
            return;
          }
          // Cancel any prior subscription and reserve this id's slot SYNCHRONOUSLY
          // with a unique placeholder before the await below. `ws` drains queued
          // frames into this async handler at each await point, so a back-to-back
          // `unsub` (fast tab close, or a strict-mode dev double-mount — see
          // WsSessionChannel.openOutput/close) runs DURING this await. Reserving the
          // slot lets that unsub remove it, and the identity check after the await
          // lets the unsub — or a newer sub — win instead of installing an emitter
          // listener the client already cancelled (which would leak and keep
          // streaming output for a closed stream).
          subs.get(id)?.();
          const pending = () => {};
          subs.set(id, pending);
          send({ t: "out", id, data: await sessions.scrollback(id) });
          // A racing unsub (or a newer sub) replaced our placeholder while we
          // awaited — honor it and do not install the subscription.
          if (subs.get(id) !== pending) {
            return;
          }
          // Re-read the LIVE status after the await — the pre-await `summary` is a
          // clone and can't reflect a transition during scrollback(). If the
          // command exited (or the session was closed) while capture-pane was in
          // flight, the attach PTY's onExit already emitted "exit" with no
          // subscriber, so subscribing now would never deliver an end and the
          // client's terminal pane would hang open. Send end + drop the slot.
          const current = sessions.get(id);
          if (!current || current.status === "exited") {
            subs.delete(id);
            send({ t: "end", id });
            return;
          }
          subs.set(
            id,
            sessions.subscribe(
              id,
              (data) => send({ t: "out", id, data }),
              () => send({ t: "end", id })
            )
          );
          resyncPending.add(id);
        } else if (msg.t === "unsub") {
          subs.get(id)?.();
          subs.delete(id);
          resyncPending.delete(id);
        } else if (msg.t === "input" && typeof msg.data === "string") {
          sessions.input(id, msg.data);
        } else if (msg.t === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
          sessions.resize(id, msg.cols, msg.rows);
          // The first resize after a sub is the client's REAL terminal size. The
          // sub-time scrollback was captured before the client fit (often at the
          // 80-col default), so an alt-screen TUI grid landed wrapped/garbled. Now
          // the pane matches the client: re-capture at the correct width and re-send,
          // once. The brief wait lets tmux apply the resize (SIGWINCH → window
          // resize) before we snapshot. Reliable regardless of whether the agent
          // emits more output — an idle agent would otherwise stay garbled.
          if (resyncPending.delete(id)) {
            await new Promise((resolve) => setTimeout(resolve, 80));
            if (subs.has(id)) {
              send({ t: "out", id, data: await sessions.scrollback(id) });
            }
          }
        }
      });

      socket.on("close", () => {
        for (const unsub of subs.values()) {
          unsub();
        }
        subs.clear();
        resyncPending.clear();
      });
    });
  });

  // Browser-tab streaming: binary JPEG frames out, JSON control in. Kept off
  // /ws so the terminal channel's text-only fast path is untouched.
  void app.register(async (instance) => {
    await instance.register(websocketPlugin);
    instance.get("/ws-browser", { websocket: true }, (socket, request) => {
      if (options.authRequired) {
        const token = (request.query as { token?: string }).token;
        if (!authorizeCredential(token, config.transports.http.username, config.transports.http.passwordHash)) {
          socket.close(1008, "unauthorized");
          return;
        }
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
          services.browsers.dispatchKey(id, msg.kind, msg.key, msg.code, msg.text, msg.modifiers);
        } else if (msg.t === "touch") {
          services.browsers.dispatchTouch(id, msg.kind, msg.points);
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

  // Terminal-control MCP — HTTP-only. The unix socket is unauthenticated, so full
  // terminal drive must never be reachable there; register /mcp only on remote.
  if (options.mode === "remote") {
    const control = new TerminalControl({
      sessions: services.sessions,
      registry: services.registry,
      workspacesDir: resolved.workspacesDir,
      fsRoot: resolved.fsRoot,
      listWorkspaces: () => listWorkspaces(resolved.workspacesDir, resolved.workspacesMetaFile),
      listProjects: (workspace) => listProjects(resolved.workspacesDir, workspace),
    });
    registerMcp(app, {
      control,
      todos: new TodoTools({ todos, workspacesDir: resolved.workspacesDir }),
      files: new FsTools({ fsRoot: resolved.fsRoot }),
      getUsage: (force) => usage.snapshot(force),
    });
  }

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
        url.startsWith("/mcp");
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

/**
 * Normalize a GitHub repo reference to its SSH clone URL
 * (`git@github.com:owner/repo.git`). Accepts `https://github.com/owner/repo`
 * (optional `.git`), the SSH form itself, and the `owner/repo` shorthand.
 * Returns undefined if it can't be parsed (the route maps that to 400). The
 * clone uses SSH only — no token ever enters the URL.
 */
function normalizeRepoUrl(url: string | undefined): string | undefined {
  if (typeof url !== "string") {
    return undefined;
  }
  const trimmed = url.trim();
  const part = "[A-Za-z0-9._-]+";
  const repoRe = new RegExp(`^(${part})/(${part}?)$`);
  const httpsRe = new RegExp(`^https?://github\\.com/(${part})/(${part}?)(?:\\.git)?/?$`, "i");
  const sshRe = new RegExp(`^git@github\\.com:(${part})/(${part}?)(?:\\.git)?$`, "i");
  const match = trimmed.match(httpsRe) ?? trimmed.match(sshRe) ?? trimmed.match(repoRe);
  if (!match) {
    return undefined;
  }
  const owner = match[1];
  const repo = match[2].replace(/\.git$/i, "");
  if (!owner || !repo) {
    return undefined;
  }
  return `git@github.com:${owner}/${repo}.git`;
}

/** Derive the repo name (the dir `git clone` would create) from an SSH clone URL. */
function repoNameFromSshUrl(sshUrl: string): string {
  const tail = sshUrl.split("/").pop() ?? "";
  return tail.replace(/\.git$/i, "");
}

/** Root of the daemon-private terminal-upload store: <appdir>/daemon/uploads. */
function uploadsRootDir(daemonDir: string): string {
  return join(daemonDir, "uploads");
}

/** Per-session upload dir: <appdir>/daemon/uploads/<sessionId>. */
function sessionUploadsDir(daemonDir: string, sessionId: string): string {
  return join(uploadsRootDir(daemonDir), sessionId);
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
      return {
        name,
        path,
        projectCount: projects.length,
        gitAccountId: entry?.gitAccountId ?? null,
        createdAt: entry?.createdAt
      };
    })
  );
}

async function listProjects(workspacesDir: string, workspace: string): Promise<ProjectSummary[]> {
  const names = await listDirectories(join(workspacesDir, workspace));
  return names.map((name) => ({
    name,
    workspace,
    path: join(workspacesDir, workspace, name)
  }));
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
  void reply.code(status).send({ code: "GIT_ERROR", message });
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

async function readWorkspacesMeta(file: string): Promise<WorkspacesConfig> {
  try {
    return parseWorkspacesConfig(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return createDefaultWorkspacesConfig();
  }
}

async function writeWorkspacesMeta(file: string, value: WorkspacesConfig): Promise<void> {
  await writeJsonFile(file, value);
}

async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** bcrypt-hash a plaintext password (stable hash persisted at rest). Cost 12
 *  slows offline cracking / per-guess derivation if a hash ever leaks; the
 *  expensive hash runs only at password-set and client-side login, so
 *  per-request auth stays cheap. */
function hashPassword(plaintext: string): string {
  return bcrypt.hashSync(plaintext, bcrypt.genSaltSync(12));
}

/** Constant-time string comparison. */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Decode a credential bearer/token of the form base64("<username>:<hash>").
 * Splits on the FIRST ":" (a bcrypt hash contains no ":", but be defensive).
 * Returns empty strings when the input is missing or not valid base64 — the
 * caller still runs the full constant-time check so a malformed credential is
 * indistinguishable from a wrong one.
 */
function decodeCredential(token: string | undefined): { user: string; hash: string } {
  if (!token) {
    return { user: "", hash: "" };
  }
  let decoded: string;
  try {
    decoded = Buffer.from(token, "base64").toString("utf8");
  } catch {
    return { user: "", hash: "" };
  }
  const sep = decoded.indexOf(":");
  if (sep === -1) {
    return { user: "", hash: "" };
  }
  return { user: decoded.slice(0, sep), hash: decoded.slice(sep + 1) };
}

/** Normalize a username for comparison (matches the config-side transform). */
function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

/** Fixed-length sha256 digest so timingSafeEqual gets equal-length buffers. */
function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * Constant-time credential check with NO early return: both the username and
 * the password-hash comparisons are always computed, so wrong-username,
 * wrong-length and wrong-password are indistinguishable (no enumeration).
 */
function authorizeCredential(
  token: string | undefined,
  expectedUsername: string,
  expectedHash: string | undefined
): boolean {
  if (!expectedHash) {
    return false;
  }
  const { user, hash } = decodeCredential(token);
  const userOk = timingSafeEqual(sha256(normalizeUsername(user)), sha256(expectedUsername));
  const passOk = timingSafeEqual(sha256(hash), sha256(expectedHash));
  return userOk && passOk;
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
}

function sanitizeDaemonConfig(config: DaemonConfig): DaemonConfig {
  // Never expose credential material over the wire. The hash is a
  // bearer-equivalent (the client derives its own via the public salt at
  // /api/auth/info), and the username is deliberately withheld too — same
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

/**
 * Per-IP failed-login throttle with escalating lockout. Single-user, so real
 * failures are rare: 5 fails within the window → locked out, with the lockout
 * doubling on each subsequent breach (15 min, 30, 60 … capped). Keyed on the
 * proxy-supplied client IP (X-Forwarded-For); this is defense-in-depth on top
 * of fail2ban (OS-layer ban on the daemon's 401 log lines, Phase 0).
 */
class LoginThrottle {
  private readonly state = new Map<
    string,
    { fails: number; lockedUntil: number; strikes: number; burstStartAt: number }
  >();
  private static readonly MAX_FAILS = 5;
  private static readonly BASE_LOCKOUT_MS = 15 * 60 * 1000;
  private static readonly MAX_LOCKOUT_MS = 24 * 60 * 60 * 1000;
  // One login attempt fans out into several authenticated requests (workspaces,
  // sessions, registry, events, …), so a single wrong password yields a burst of
  // near-simultaneous 401s. Collapse failures within this window into ONE counted
  // attempt so a lone typo can't trip the lockout instantly.
  private static readonly BURST_WINDOW_MS = 2000;
  // Bound the per-IP map: only sweep once it grows past this, then drop entries
  // that are neither locked nor part of a recent burst.
  private static readonly PRUNE_THRESHOLD = 1024;
  private static readonly STALE_AFTER_MS = 10 * 60 * 1000;

  /** Ms remaining on an active lockout for this IP, or 0 if not locked. */
  retryAfterMs(ip: string): number {
    const entry = this.state.get(ip);
    if (!entry || entry.lockedUntil <= Date.now()) {
      return 0;
    }
    return entry.lockedUntil - Date.now();
  }

  /** Record a failed attempt; locks the IP once MAX_FAILS is reached. */
  recordFailure(ip: string): void {
    const entry = this.state.get(ip) ?? { fails: 0, lockedUntil: 0, strikes: 0, burstStartAt: 0 };
    const now = Date.now();
    this.prune(now);
    // Burst collapse: failures arriving within BURST_WINDOW_MS of the FIRST failure
    // of the current burst belong to one login attempt's fan-out (or a rapid
    // auto-reconnect), so they don't count. The window is anchored to that first
    // failure and is NEVER refreshed — otherwise a sustained stream of guesses
    // (even 1/sec) would keep the window alive forever and pin `fails` at 1, so the
    // IP would never lock. Anchoring lets a real fan-out collapse to one strike
    // while a continuous attack advances ~one strike per BURST_WINDOW_MS.
    if (entry.fails > 0 && now - entry.burstStartAt < LoginThrottle.BURST_WINDOW_MS) {
      this.state.set(ip, entry);
      return;
    }
    entry.burstStartAt = now;
    entry.fails += 1;
    if (entry.fails >= LoginThrottle.MAX_FAILS) {
      const lockout = Math.min(
        LoginThrottle.BASE_LOCKOUT_MS * 2 ** entry.strikes,
        LoginThrottle.MAX_LOCKOUT_MS
      );
      entry.lockedUntil = Date.now() + lockout;
      entry.strikes += 1;
      entry.fails = 0;
    }
    this.state.set(ip, entry);
  }

  // Opportunistic eviction so a distinct-IP spray can't grow `state` without
  // bound: entries that are neither locked nor mid-burst carry no useful state.
  // Cheap by default; sweeps the whole map only once it gets large.
  private prune(now: number): void {
    if (this.state.size <= LoginThrottle.PRUNE_THRESHOLD) {
      return;
    }
    for (const [ip, entry] of this.state) {
      if (entry.lockedUntil <= now && now - entry.burstStartAt > LoginThrottle.STALE_AFTER_MS) {
        this.state.delete(ip);
      }
    }
  }

  /** Clear an IP's failure count after a successful auth. */
  recordSuccess(ip: string): void {
    this.state.delete(ip);
  }
}

/**
 * Client IP used to key the login throttle.
 *
 * TRUSTED-HOP ASSUMPTION: exactly ONE trusted proxy (Caddy) fronts the daemon on
 * loopback. Caddy's default `reverse_proxy` APPENDS the real client IP to whatever
 * the client sent, so `X-Forwarded-For` is `<client-supplied…>, <real-client-ip>`
 * — the entry we trust is the RIGHTMOST one (the hop Caddy added), never the
 * leftmost (which is fully attacker-controlled and would let an attacker rotate it
 * per request to evade the per-IP throttle).
 *
 * With `trustProxy: "127.0.0.1"` set on the remote Fastify instance, proxy-addr
 * already computes exactly this (request.ip = closest untrusted address = the
 * rightmost XFF hop), so request.ip is authoritative; the manual rightmost parse
 * below is a belt-and-suspenders fallback that still refuses the client-controlled
 * leftmost value. If the deployment ever inserts more than one proxy hop, both
 * trustProxy and this helper must be updated together.
 */
function clientIp(request: { headers: Record<string, unknown>; ip: string }): string {
  if (request.ip) {
    return request.ip;
  }
  const xff = request.headers["x-forwarded-for"];
  const raw = Array.isArray(xff) ? xff[xff.length - 1] : xff;
  if (typeof raw === "string" && raw.length > 0) {
    const parts = raw.split(",");
    return parts[parts.length - 1]!.trim();
  }
  return request.ip;
}
