import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  DESKTOP_ENV_KEY_PATTERN,
  DESKTOP_MAX_COMMAND_LENGTH,
  DESKTOP_UNAVAILABLE_CODE,
  type DesktopAppSummary,
  type DesktopHostStatus,
  type DesktopSuggestionsResponse,
  type DesktopSummary,
  desktopRoutes
} from "@orquester/api";
import { FsSandboxError, assertInsideFsRoot } from "@orquester/config/fs";
import { type DesktopManager, DesktopError, type LaunchAppInput } from "./manager.ts";
import { findProjectExecutables, scanDesktopEntries } from "./suggestions.ts";
import { isReservedAppEnvKey } from "./host-env.ts";

/** The manager surface the routes use (a stub in the route tests). */
export type DesktopRoutesService = Pick<
  DesktopManager,
  | "hostStatus"
  | "list"
  | "get"
  | "recentLaunches"
  | "create"
  | "stop"
  | "restart"
  | "close"
  | "launchApp"
  | "stopApp"
  | "appLog"
  | "windowAction"
>;

export interface DesktopRoutesDeps {
  desktops: DesktopRoutesService;
  /** The file browser's sandbox root; a getter because PUT /api/config/daemon can move it. */
  fsRoot: () => string;
}

const MAX_ENV_VARS = 256;
const MAX_TITLE_LENGTH = 200;

const singleLine = (value: string): boolean => !/[\n\r\0]/.test(value);

// Launch values may be credentials: no message below ever echoes a value (and
// the request logger only logs method + redacted URL, never bodies).
const launchSchema = z.object({
  command: z
    .string()
    .refine(singleLine, "command must be a single line")
    .transform((command) => command.trim())
    .refine((command) => command.length > 0, "command is required")
    .refine(
      (command) => command.length <= DESKTOP_MAX_COMMAND_LENGTH,
      `command is longer than ${DESKTOP_MAX_COMMAND_LENGTH} characters`
    ),
  cwd: z.string().refine(singleLine, "cwd must be a single line").optional(),
  env: z
    .record(z.string())
    .superRefine((env, ctx) => {
      const entries = Object.entries(env);
      if (entries.length > MAX_ENV_VARS) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `at most ${MAX_ENV_VARS} environment variables` });
      }
      for (const [key, value] of entries) {
        if (!DESKTOP_ENV_KEY_PATTERN.test(key)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "environment variable names must match [A-Za-z_][A-Za-z0-9_]*" });
        } else if (isReservedAppEnvKey(key)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${key} is reserved (names starting with __orq_ or ORQ_APP_)` });
        } else if (!singleLine(value)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `the value of ${key} must be a single line` });
        }
      }
    })
    .optional()
});

const createSchema = z.object({
  projectPath: z.string().min(1, "projectPath is required"),
  title: z
    .string()
    .max(MAX_TITLE_LENGTH, `title is longer than ${MAX_TITLE_LENGTH} characters`)
    .refine(singleLine, "title must be a single line")
    .optional(),
  // Clamped to the display bounds by the record schema.
  size: z.object({ width: z.number().finite(), height: z.number().finite() }).optional(),
  renderThreads: z.number().int().min(1).optional(),
  app: launchSchema.optional()
});

/** The realpath of a directory inside the fs root (FsSandboxError outside it; 400 when not a directory). */
async function sandboxedDir(fsRoot: string, path: string, field: string): Promise<string> {
  const real = await assertInsideFsRoot(fsRoot, path);
  const info = await stat(real).catch(() => null);
  if (!info?.isDirectory()) {
    throw new DesktopError(400, "INVALID_REQUEST", `${field} is not a directory.`);
  }
  return real;
}

/** A launch request → the manager's input: `cwd` resolved against the project, sandboxed, realpath'd. */
async function launchInput(
  fsRoot: string,
  projectPath: string,
  request: z.infer<typeof launchSchema>
): Promise<LaunchAppInput> {
  const cwd = request.cwd?.trim()
    ? isAbsolute(request.cwd.trim())
      ? request.cwd.trim()
      : resolve(projectPath, request.cwd.trim())
    : projectPath;
  return {
    command: request.command,
    cwd: await sandboxedDir(fsRoot, cwd, "cwd"),
    env: request.env ?? {}
  };
}

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof FsSandboxError) {
    return reply.code(403).send({ code: "FS_FORBIDDEN", message: error.message });
  }
  if (error instanceof z.ZodError) {
    return reply.code(400).send({
      code: "INVALID_REQUEST",
      message: error.issues.map((issue) => (issue.path.length ? `${issue.path.join(".")}: ` : "") + issue.message).join("; ")
    });
  }
  if (error instanceof DesktopError) {
    return reply.code(error.status).send({
      code: error.code,
      message: error.message,
      ...(error.code === DESKTOP_UNAVAILABLE_CODE ? { hint: error.hint } : {})
    });
  }
  return reply.code(500).send({
    code: "DESKTOP_ERROR",
    message: error instanceof Error ? error.message : "Desktop operation failed."
  });
}

/**
 * The desktop REST routes (desktop spec §7.1), on both transports like the
 * browser routes. `projectPath` and every `cwd` pass `assertInsideFsRoot`, and
 * the manager keeps the realpath next to the client's spelling (the UI's project key). The live view rides the WebSocket
 * routes (ws-routes.ts).
 */
export function registerDesktopHttpRoutes(app: FastifyInstance, deps: DesktopRoutesDeps): void {
  const { desktops } = deps;

  app.get(desktopRoutes.host, async (): Promise<DesktopHostStatus> => desktops.hostStatus());

  app.get<{ Querystring: { projectPath?: string } }>(
    desktopRoutes.list,
    async (request, reply): Promise<DesktopSummary[] | FastifyReply> => {
      try {
        const projectPath = request.query.projectPath;
        if (!projectPath) return desktops.list();
        return desktops.list(projectPath, await assertInsideFsRoot(deps.fsRoot(), projectPath));
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.get<{ Querystring: { projectPath?: string } }>(
    desktopRoutes.suggestions,
    async (request, reply): Promise<DesktopSuggestionsResponse | FastifyReply> => {
      try {
        if (!request.query.projectPath) {
          throw new DesktopError(400, "INVALID_REQUEST", "projectPath is required.");
        }
        const projectPath = await sandboxedDir(deps.fsRoot(), request.query.projectPath, "projectPath");
        const [entries, executables] = await Promise.all([
          scanDesktopEntries(),
          findProjectExecutables(projectPath)
        ]);
        return { entries, executables, recent: desktops.recentLaunches(projectPath) };
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.post(desktopRoutes.create, async (request, reply): Promise<DesktopSummary | FastifyReply> => {
    try {
      const body = createSchema.parse(request.body ?? {});
      const fsRoot = deps.fsRoot();
      const projectRealPath = await sandboxedDir(fsRoot, body.projectPath, "projectPath");
      const app = body.app ? await launchInput(fsRoot, projectRealPath, body.app) : undefined;
      return await desktops.create({
        projectPath: body.projectPath,
        projectRealPath,
        title: body.title,
        size: body.size,
        renderThreads: body.renderThreads,
        app
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>(
    "/api/desktops/:id/stop",
    async (request, reply): Promise<DesktopSummary | FastifyReply> => {
      try {
        return await desktops.stop(request.params.id);
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.post<{ Params: { id: string } }>(
    "/api/desktops/:id/restart",
    async (request, reply): Promise<DesktopSummary | FastifyReply> => {
      try {
        return await desktops.restart(request.params.id);
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.delete<{ Params: { id: string } }>("/api/desktops/:id", async (request, reply): Promise<FastifyReply> => {
    try {
      await desktops.close(request.params.id);
      return reply.code(204).send();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>(
    "/api/desktops/:id/apps",
    async (request, reply): Promise<DesktopAppSummary | FastifyReply> => {
      try {
        const desktop = desktops.get(request.params.id);
        if (!desktop) throw new DesktopError(404, "DESKTOP_NOT_FOUND", "No such desktop.");
        const body = launchSchema.parse(request.body ?? {});
        return await desktops.launchApp(
          request.params.id,
          await launchInput(deps.fsRoot(), desktop.projectPath, body)
        );
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.delete<{ Params: { id: string; appId: string }; Querystring: { force?: string } }>(
    "/api/desktops/:id/apps/:appId",
    async (request, reply): Promise<FastifyReply> => {
      try {
        const force = request.query.force === "1" || request.query.force === "true";
        desktops.stopApp(request.params.id, request.params.appId, force);
        return reply.code(204).send();
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.get<{ Params: { id: string; appId: string } }>(
    "/api/desktops/:id/apps/:appId/log",
    async (request, reply): Promise<FastifyReply> => {
      try {
        const text = await desktops.appLog(request.params.id, request.params.appId);
        return reply.type("text/plain; charset=utf-8").send(text);
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.post<{ Params: { id: string; windowId: string; action: string } }>(
    "/api/desktops/:id/windows/:windowId/:action",
    async (request, reply): Promise<FastifyReply> => {
      try {
        const action = z
          .enum(["activate", "maximize", "close"], { message: "action must be activate, maximize or close" })
          .parse(request.params.action);
        await desktops.windowAction(request.params.id, request.params.windowId, action);
        return reply.code(204).send();
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );
}
