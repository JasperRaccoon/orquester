import type {
  CreateProjectRequest,
  CreateSessionRequest,
  CreateWorkspaceRequest,
  EventMessage,
  FsCreateRequest,
  FsEntry,
  FsListResponse,
  FsReadResponse,
  FsWriteRequest,
  HealthResponse,
  OpenRequest,
  OpenResult,
  ProjectSummary,
  RegistryResponse,
  RenameSessionRequest,
  ReorderSessionsRequest,
  ServerInfoResponse,
  SessionInputRequest,
  SessionResizeRequest,
  SessionSummary,
  WorkspaceSummary
} from "@orquester/api";
import { RegistryService } from "./registry";
import { type ISessionManager, SessionError, createSessionManager } from "./sessions";
import { Tmux } from "./tmux";
import { Broadcaster } from "./broadcaster";
import {
  type AppConfig,
  type ClientConfig,
  type ConfigVars,
  type DaemonConfig,
  type DaemonPaths,
  type RemoteConnectionConfig,
  type RemotesConfig,
  appConfigPath,
  createDefaultAppConfig,
  createDefaultClientConfig,
  createDefaultDaemonConfig,
  createDefaultRemotesConfig,
  dailyLogFile,
  expandVars,
  parseAppConfig,
  parseDaemonConfig,
  parseRemotesConfig,
  remotesConfigPath,
  resolveDaemonPaths,
  sessionsIndexPath,
  tmuxSocketPath
} from "@orquester/config";
import fastifyStatic from "@fastify/static";
import websocketPlugin from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, platform as osPlatform } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { stat } from "node:fs/promises";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";

const daemonId = randomUUID();
const packageVersion = "0.0.0";

/** Filesystem locations resolved (variables expanded) for this run. */
interface ResolvedPaths {
  daemonDir: string;
  configPath: string;
  /** app.json + remotes.json live under <appdir>/app and are shared by clients. */
  appConfigFile: string;
  remotesFile: string;
  /** Fixed socket of the dedicated tmux server that owns session PTYs. */
  tmuxSocket: string;
  /** <appdir>/daemon/sessions.json — the reattach index. */
  sessionsIndexFile: string;
  workspacesDir: string;
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
    tmuxSocket: tmuxSocketPath(paths.baseDir),
    sessionsIndexFile: sessionsIndexPath(paths.baseDir),
    workspacesDir: expandVars(config.workspacesDir, paths.vars),
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
  const sessions = createSessionManager(registry, tmux, resolved.sessionsIndexFile);
  const broadcaster = new Broadcaster();
  // Stream registry changes (install/update status, detected versions) to clients.
  registry.events.on("changed", (entry) => broadcaster.publish("registry", "registry.changed", entry));
  await registry.init();
  // Reattach to any tmux sessions that outlived a previous daemon process
  // (KillMode=process keeps the tmux server alive across restarts). No-op on the
  // local backend. Best-effort: a tmux/socket error must not block startup.
  await sessions.reattach().catch((error) => console.error("Session reattach failed", error));
  sessions.lifecycle.on("created", (s: SessionSummary) =>
    broadcaster.publish("sessions", "session.created", s)
  );
  sessions.lifecycle.on("exited", (s: SessionSummary) =>
    broadcaster.publish("sessions", "session.exited", s)
  );
  sessions.lifecycle.on("closed", (payload: { id: string }) =>
    broadcaster.publish("sessions", "session.closed", payload)
  );
  sessions.lifecycle.on("updated", (s: SessionSummary) =>
    broadcaster.publish("sessions", "session.updated", s)
  );

  const services: Services = { registry, sessions, broadcaster };

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
      await server.close().catch(() => undefined);
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
    // Detach (don't kill) sessions: the tmux backend leaves its server running so
    // the next boot reattaches; the local backend has no server, so its shutdown()
    // terminates the child PTYs (they'd die with the daemon regardless).
    sessions.shutdown();
    await stopHttp();
    await unixServer.close().catch(() => undefined);
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
  broadcaster: Broadcaster;
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
  const { registry, sessions } = services;

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
      (url.startsWith("/api") || url.startsWith("/events")) && url !== "/api/auth/info";
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

    const authorized = authorizeCredential(
      request.headers.authorization?.replace(/^Bearer\s+/i, ""),
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

  // Filesystem-backed workspaces & projects:
  //   (workspacesDir)/<workspace>           -> a workspace
  //   (workspacesDir)/<workspace>/<project> -> a project
  app.get("/api/workspaces", async (): Promise<WorkspaceSummary[]> =>
    listWorkspaces(resolved.workspacesDir)
  );

  app.post("/api/workspaces", async (request, reply): Promise<WorkspaceSummary | void> => {
    const name = (request.body as CreateWorkspaceRequest | undefined)?.name;
    if (!isValidName(name)) {
      return reply.code(400).send({ code: "INVALID_NAME", message: "Invalid workspace name." });
    }

    const path = join(resolved.workspacesDir, name);
    await mkdir(path, { recursive: true });
    return { name, path, projectCount: 0 };
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

  app.post<{ Params: { workspace: string } }>(
    "/api/workspaces/:workspace/projects",
    async (request, reply): Promise<ProjectSummary | void> => {
      const { workspace } = request.params;
      const name = (request.body as CreateProjectRequest | undefined)?.name;
      if (!isValidName(workspace) || !isValidName(name)) {
        return reply.code(400).send({ code: "INVALID_NAME", message: "Invalid name." });
      }

      const path = join(resolved.workspacesDir, workspace, name);
      await mkdir(path, { recursive: true });
      return { name, workspace, path };
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

  // Registry (shells & agents)
  app.get("/api/registry", async (): Promise<RegistryResponse> => registry.list());

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
      return sessions.create((request.body ?? {}) as CreateSessionRequest);
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

    if (summary.status === "exited") {
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
          if (summary.status === "exited") {
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
        } else if (msg.t === "unsub") {
          subs.get(id)?.();
          subs.delete(id);
        } else if (msg.t === "input" && typeof msg.data === "string") {
          sessions.input(id, msg.data);
        } else if (msg.t === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
          sessions.resize(id, msg.cols, msg.rows);
        }
      });

      socket.on("close", () => {
        for (const unsub of subs.values()) {
          unsub();
        }
        subs.clear();
      });
    });
  });

  // Serve the static web client build for everything outside the API, with an
  // SPA fallback to index.html. Reserved prefixes stay JSON 404s.
  if (options.serveWeb) {
    void app.register(fastifyStatic, { root: options.serveWeb, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      const url = request.url;
      const isApi =
        url.startsWith("/api") || url.startsWith("/health") || url.startsWith("/events");
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

/** Reject names that would escape the workspaces directory. */
function isValidName(name: string | undefined): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    !name.startsWith(".") &&
    !name.includes("/") &&
    !name.includes("\\")
  );
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

async function listWorkspaces(workspacesDir: string): Promise<WorkspaceSummary[]> {
  const names = await listDirectories(workspacesDir);
  return Promise.all(
    names.map(async (name) => {
      const path = join(workspacesDir, name);
      const projects = await listDirectories(path);
      return { name, path, projectCount: projects.length };
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
 * Resolve `target` to a realpath and confirm it is inside `root` (also a
 * realpath). Rejects `..` traversal and symlink escapes. For not-yet-existing
 * targets (create/write) the deepest existing ancestor is realpath'd instead,
 * then the remaining segments are appended, so a brand-new file under the root
 * still passes. Throws FsSandboxError when outside the root.
 */
async function assertInsideFsRoot(root: string, target: string): Promise<string> {
  const realRoot = await realpath(root).catch(() => resolve(root));
  const resolved = resolve(target);
  // Walk up the resolved (non-realpath) path to the deepest existing ancestor so
  // create/write of a not-yet-existing path still works.
  let ancestor = resolved;
  for (;;) {
    try {
      await realpath(ancestor);
      break;
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        break;
      }
      ancestor = parent;
    }
  }
  // Realpath the existing ancestor, then re-attach the not-yet-existing tail by
  // path.join (never byte-splicing two differently-resolved strings — the
  // realpath'd ancestor may carry a prefix like macOS `/private`).
  const realAncestor = await realpath(ancestor).catch(() => ancestor);
  const tail = relative(ancestor, resolved);
  const finalPath = tail ? join(realAncestor, tail) : realAncestor;
  // Containment check on the realpath'd result: rel must stay within realRoot
  // (empty == the root itself, otherwise no leading `..` segment and not
  // absolute — sep-anchored so a child literally named e.g. `..foo` is allowed).
  const rel = relative(realRoot, finalPath);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new FsSandboxError(`Path is outside the sandbox: ${target}`);
  }
  return finalPath;
}

/** Thrown when an /api/fs path escapes fsRoot. */
class FsSandboxError extends Error {}

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
  private readonly state = new Map<string, { fails: number; lockedUntil: number; strikes: number }>();
  private static readonly MAX_FAILS = 5;
  private static readonly BASE_LOCKOUT_MS = 15 * 60 * 1000;
  private static readonly MAX_LOCKOUT_MS = 24 * 60 * 60 * 1000;

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
    const entry = this.state.get(ip) ?? { fails: 0, lockedUntil: 0, strikes: 0 };
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
