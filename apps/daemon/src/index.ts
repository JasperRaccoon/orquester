import websocket from "@fastify/websocket";
import type {
  CreateProjectRequest,
  CreateWorkspaceRequest,
  EventMessage,
  HealthResponse,
  ProjectSummary,
  ServerInfoResponse,
  WorkspaceSummary
} from "@orquester/api";
import {
  type ClientConfig,
  type DaemonConfig,
  type DaemonPaths,
  createDefaultClientConfig,
  createDefaultDaemonConfig,
  dailyLogFile,
  expandVars,
  parseDaemonConfig,
  resolveDaemonPaths
} from "@orquester/config";
import Fastify, { type FastifyInstance } from "fastify";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const daemonId = randomUUID();
const packageVersion = "0.0.0";

/** Filesystem locations resolved (variables expanded) for this run. */
interface ResolvedPaths {
  daemonDir: string;
  workspacesDir: string;
  logsDir: string;
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
    workspacesDir: expandVars(config.workspacesDir, paths.vars),
    logsDir: expandVars(config.logsDir, paths.vars)
  };
  await prepareDirs(resolved);

  const logStream = createWriteStream(dailyLogFile(resolved.logsDir), { flags: "a" });
  const clientConfig = createDefaultClientConfig(paths.socketPath);
  const started: string[] = [];
  const servers: FastifyInstance[] = [];

  // The local unix socket transport is always present.
  {
    const app = createServer(config, resolved, clientConfig, logStream, {
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
    const app = createServer(config, resolved, clientConfig, logStream, {
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

  process.on("SIGINT", () => shutdown(servers));
  process.on("SIGTERM", () => shutdown(servers));

  console.log(
    `Orquester daemon ${daemonId} listening on ${started.join(", ")} (workspaces: ${resolved.workspacesDir})`
  );
}

function createServer(
  config: DaemonConfig,
  resolved: ResolvedPaths,
  clientConfig: ClientConfig,
  logStream: WriteStream,
  options: { authRequired: boolean; mode: "local" | "remote" }
): FastifyInstance {
  const app = Fastify({
    logger: { level: "info", stream: logStream }
  });

  void app.register(websocket);

  app.addHook("onRequest", async (request, reply) => {
    if (!options.authRequired || request.url === "/health") {
      return;
    }

    const expected = config.transports.http.password;
    const actual = request.headers.authorization?.replace(/^Bearer\s+/i, "");

    if (!expected || actual !== expected) {
      await reply.code(401).send({
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
      terminals: false,
      sessions: false,
      agents: false,
      docker: false
    }
  }));

  app.get("/api/config/daemon", async (): Promise<DaemonConfig> => sanitizeDaemonConfig(config));
  app.get("/api/config/client", async (): Promise<ClientConfig> => clientConfig);

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

  app.get("/events", { websocket: true }, (connection) => {
    const timer = setInterval(() => {
      const event: EventMessage = {
        id: randomUUID(),
        channel: "daemon",
        type: "daemon.heartbeat",
        createdAt: new Date().toISOString(),
        payload: {
          daemonId
        }
      };

      connection.send(JSON.stringify(event));
    }, 10_000);

    connection.on("close", () => clearInterval(timer));
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

async function shutdown(servers: FastifyInstance[]): Promise<void> {
  await Promise.all(servers.map((server) => server.close()));
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
