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
  ServerInfoResponse,
  SessionInputRequest,
  SessionResizeRequest,
  SessionSummary,
  WorkspaceSummary
} from "@orquester/api";
import { RegistryService } from "./registry";
import { SessionError, SessionManager } from "./sessions";
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
  resolveDaemonPaths
} from "@orquester/config";
import Fastify, { type FastifyInstance } from "fastify";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const daemonId = randomUUID();
const packageVersion = "0.0.0";

/** Filesystem locations resolved (variables expanded) for this run. */
interface ResolvedPaths {
  daemonDir: string;
  configPath: string;
  /** app.json + remotes.json live under <appdir>/app and are shared by clients. */
  appConfigFile: string;
  remotesFile: string;
  workspacesDir: string;
  logsDir: string;
  vars: ConfigVars;
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const appdirArg = parseAppdir(process.argv.slice(2));
  const appdir = resolveAppdir(appdirArg ?? process.env.ORQUESTER_APPDIR, cwd);

  const paths = resolveDaemonPaths({
    homeDir: homedir(),
    platform: platform(),
    cwd,
    appdir,
    env: process.env
  });
  const config = await loadConfig(paths);
  validateTransportConfig(config);

  const resolved: ResolvedPaths = {
    daemonDir: paths.daemonDir,
    configPath: paths.configPath,
    appConfigFile: appConfigPath(paths.baseDir),
    remotesFile: remotesConfigPath(paths.baseDir),
    workspacesDir: expandVars(config.workspacesDir, paths.vars),
    logsDir: expandVars(config.logsDir, paths.vars),
    vars: paths.vars
  };
  await prepareDirs(resolved);

  const logStream = createWriteStream(dailyLogFile(resolved.logsDir), { flags: "a" });
  const clientConfig = createDefaultClientConfig(paths.socketPath);

  // Shared, transport-agnostic services. Sessions live here so they survive
  // client disconnects and are visible across every transport/client.
  const registry = new RegistryService(resolved.daemonDir);
  await registry.init();
  const sessions = new SessionManager(registry);
  const broadcaster = new Broadcaster();
  sessions.lifecycle.on("created", (s: SessionSummary) =>
    broadcaster.publish("sessions", "session.created", s)
  );
  sessions.lifecycle.on("exited", (s: SessionSummary) =>
    broadcaster.publish("sessions", "session.exited", s)
  );
  sessions.lifecycle.on("closed", (payload: { id: string }) =>
    broadcaster.publish("sessions", "session.closed", payload)
  );

  const services: Services = { registry, sessions, broadcaster };
  const started: string[] = [];
  const servers: FastifyInstance[] = [];

  // The local unix socket transport is always present.
  {
    const app = createServer(config, resolved, clientConfig, logStream, services, {
      authRequired: false,
      mode: "local"
    });
    servers.push(app);

    if (platform() !== "win32") {
      await rm(paths.socketPath, { force: true });
    }

    await app.listen({ path: paths.socketPath });
    started.push(`unix:${paths.socketPath}`);
  }

  // The external HTTP transport is opt-in (daemon.json -> transports.http.enabled).
  if (config.transports.http.enabled) {
    const app = createServer(config, resolved, clientConfig, logStream, services, {
      authRequired: true,
      mode: "remote"
    });
    servers.push(app);
    await app.listen({
      host: config.transports.http.host,
      port: config.transports.http.port
    });
    started.push(`http://${config.transports.http.host}:${config.transports.http.port}`);
  }

  process.on("SIGINT", () => shutdown(servers, sessions));
  process.on("SIGTERM", () => shutdown(servers, sessions));

  console.log(
    `Orquester daemon ${daemonId} listening on ${started.join(", ")} (workspaces: ${resolved.workspacesDir})`
  );
}

interface Services {
  registry: RegistryService;
  sessions: SessionManager;
  broadcaster: Broadcaster;
}

function createServer(
  config: DaemonConfig,
  resolved: ResolvedPaths,
  clientConfig: ClientConfig,
  logStream: WriteStream,
  services: Services,
  options: { authRequired: boolean; mode: "local" | "remote" }
): FastifyInstance {
  const { registry, sessions } = services;
  // Remote (HTTP) clients are cross-origin (web app / desktop renderer), so the
  // remote transport is permissive on CORS; it is still bearer-token protected.
  const cors = options.mode === "remote";
  const corsHeaders: Record<string, string> = cors ? { "access-control-allow-origin": "*" } : {};

  const app = Fastify({
    logger: { level: "info", stream: logStream }
  });

  app.addHook("onRequest", async (request, reply) => {
    if (cors) {
      // reply.header() is synchronous — do not await (awaiting the reply
      // deadlocks the request).
      reply.header("access-control-allow-origin", "*");
      reply.header("access-control-allow-headers", "authorization, content-type");
      reply.header("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
      if (request.method === "OPTIONS") {
        return reply.code(204).send();
      }
    }

    if (!options.authRequired || request.url === "/health") {
      return;
    }

    const expected = config.transports.http.password;
    const actual = request.headers.authorization?.replace(/^Bearer\s+/i, "");

    if (!expected || actual !== expected) {
      return reply.code(401).send({
        code: "UNAUTHORIZED",
        message: "A valid bearer token is required for this daemon transport."
      });
    }
  });

  app.get("/health", async (): Promise<HealthResponse> => ({
    ok: true,
    daemonId,
    version: packageVersion,
    mode: options.mode,
    transports: ["unix" as const, ...(config.transports.http.enabled ? (["http"] as const) : [])]
  }));

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
      password: string;
    }>;
    const nextPassword =
      !httpPatch.password || httpPatch.password === "********"
        ? config.transports.http.password
        : httpPatch.password;

    let merged: DaemonConfig;
    try {
      merged = parseDaemonConfig({
        version: 1,
        workspacesDir: body.workspacesDir ?? config.workspacesDir,
        logsDir: body.logsDir ?? config.logsDir,
        transports: { http: { ...config.transports.http, ...httpPatch, password: nextPassword } }
      });
    } catch {
      return reply.code(400).send({ code: "INVALID_CONFIG", message: "Invalid daemon config." });
    }

    if (merged.transports.http.enabled && !merged.transports.http.password) {
      return reply.code(400).send({
        code: "PASSWORD_REQUIRED",
        message: "Enabling external HTTP access requires a password (min 8 chars)."
      });
    }

    await writeFile(resolved.configPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");

    // Apply what we safely can in-process; transport changes need a restart.
    Object.assign(config, merged);
    resolved.workspacesDir = expandVars(merged.workspacesDir, resolved.vars);
    resolved.logsDir = expandVars(merged.logsDir, resolved.vars);
    await mkdir(resolved.workspacesDir, { recursive: true }).catch(() => undefined);

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
        return await listFiles(path);
      } catch (error) {
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
        const buffer = await readFile(path);
        const cap = 1024 * 1024;
        return {
          path,
          content: buffer.subarray(0, cap).toString("utf8"),
          size: buffer.length,
          truncated: buffer.length > cap
        };
      } catch (error) {
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
      await writeFile(body.path, body.content, "utf8");
      return { ok: true };
    } catch (error) {
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
      if (body.kind === "dir") {
        await mkdir(body.path, { recursive: true });
      } else {
        await mkdir(dirname(body.path), { recursive: true });
        await writeFile(body.path, "", { flag: "wx" });
      }
      return { ok: true };
    } catch (error) {
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
  app.get<{ Params: { id: string } }>("/api/sessions/:id/output", (request, reply) => {
    const { id } = request.params;
    const summary = sessions.get(id);
    if (!summary) {
      void reply.code(404).send();
      return;
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "application/octet-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
      ...corsHeaders
    });
    reply.raw.write(sessions.buffer(id));

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
      "x-accel-buffering": "no",
      ...corsHeaders
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

  return app;
}

/** Parse `--appdir <path>` or `--appdir=<path>` from CLI args. */
function parseAppdir(args: string[]): string | undefined {
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

async function loadConfig(paths: DaemonPaths): Promise<DaemonConfig> {
  const defaults = createDefaultDaemonConfig({ env: process.env });

  try {
    const raw = await readFile(paths.configPath, "utf8");
    const fromDisk = JSON.parse(raw) as Partial<DaemonConfig>;

    return parseDaemonConfig({
      ...defaults,
      ...fromDisk,
      transports: {
        http: {
          ...defaults.transports.http,
          ...fromDisk.transports?.http
        }
      }
    });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      // Persist defaults so the user has a daemon.json to edit.
      await mkdir(paths.daemonDir, { recursive: true });
      await writeFile(paths.configPath, `${JSON.stringify(defaults, null, 2)}\n`, "utf8");
      return defaults;
    }

    throw error;
  }
}

function validateTransportConfig(config: DaemonConfig): void {
  if (config.transports.http.enabled && !config.transports.http.password) {
    throw new Error(
      "HTTP transport requires ORQUESTER_HTTP_PASSWORD or transports.http.password in daemon.json."
    );
  }
}

async function prepareDirs(resolved: ResolvedPaths): Promise<void> {
  await mkdir(resolved.daemonDir, { recursive: true });
  await mkdir(resolved.logsDir, { recursive: true });
  await mkdir(resolved.workspacesDir, { recursive: true });
}

function sanitizeDaemonConfig(config: DaemonConfig): DaemonConfig {
  return {
    ...config,
    transports: {
      ...config.transports,
      http: {
        ...config.transports.http,
        password: config.transports.http.password ? "********" : undefined
      }
    }
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function shutdown(servers: FastifyInstance[], sessions: SessionManager): Promise<void> {
  sessions.closeAll();
  await Promise.all(servers.map((server) => server.close()));
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
