// Automated workflows — the REST surface (spec §8.1), every path in `workflowRoutes`.
//
// Registered on BOTH transports (the unix socket and the HTTP app, whose global bearer hook gates
// `/api/*` already). Every refusal is `{error: {code, message, problems?}}` (`WorkflowError`).
//
// Definitions and secrets are served by their stores. Runs are the engine's while it is attached
// (`engine()` non-null); before that — and whenever it is absent — run history, a run's detail and a
// block's output are read from the run store alone (run.json), so the run view works during boot.
// Everything that needs the engine to ACT (run, test a block, cancel, delete a temp project, the
// account preview) answers 503 `ENGINE_UNAVAILABLE` while it is null.
//
// The log route streams a block's stdout/stderr as plain text, ALWAYS through a redactor built
// from the workflow's secrets: `?follow=1` holds the reply open (hijacked, like `/events`) and
// writes each redacted chunk as the file grows until the block's log is no longer live or the
// client hangs up; without it one window is answered, its position in `X-Log-*` headers.

import { basename, dirname, join, resolve } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  outputHandles,
  validateCron,
  nextRuns,
  validateWorkflow,
  WORKFLOW_BLOCK_CATALOG,
  WORKFLOW_EXPRESSION_GUIDE,
  workflowRoutes,
  type AgentChainEntry,
  type AccountPreviewResponse,
  type CreateWorkflowRequest,
  type GetWorkflowNodeOutputResponse,
  type GetWorkflowResponse,
  type GetWorkflowRunResponse,
  type ListWorkflowRunsResponse,
  type ListWorkflowSecretsResponse,
  type ListWorkflowsResponse,
  type PatchWorkflowRequest,
  type ReplaceWorkflowRequest,
  type RunWorkflowRequest,
  type RunWorkflowResponse,
  type SchedulePreviewResponse,
  type ValidateWorkflowResponse,
  type Workflow,
  type WorkflowBlockTypeInfo,
  type WorkflowBlockTypesResponse,
  type WorkflowNodeType,
  type WorkflowSummary,
  type WorkflowWriteResponse
} from "@orquester/api";
import {
  agentConfigSchema,
  codeConfigSchema,
  httpConfigSchema,
  ifConfigSchema,
  mergeConfigSchema,
  noteConfigSchema,
  shellConfigSchema,
  stopConfigSchema,
  subWorkflowConfigSchema,
  switchConfigSchema,
  triggerGitConfigSchema,
  triggerManualConfigSchema,
  triggerScheduleConfigSchema,
  waitConfigSchema,
  WORKFLOW_NODE_TYPES
} from "@orquester/config";
import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { WorkflowEngine } from "./contracts.ts";
import {
  engineUnavailable,
  invalidRequest,
  isWorkflowError,
  nodeNotFound,
  runNotFound,
  WorkflowError,
  workflowNotFound
} from "./errors.ts";
import type { FileRunStore } from "./run-store.ts";
import { persistedRunToWire } from "./run-store.ts";
import { followLog, readLogWindow } from "./sandbox/log-reader.ts";
import { createRedactor } from "./sandbox/redact.ts";
import type { WorkflowSecretsService } from "./secrets.ts";
import type { WorkflowService } from "./service.ts";
import { buildWorkflowSummary } from "./summary.ts";

export interface WorkflowRouteDeps {
  service: WorkflowService;
  secrets: WorkflowSecretsService;
  runStore: FileRunStore;
  /** The engine once attached (`attachWorkflowEngine`), else null. Read per request. */
  engine: () => WorkflowEngine | null;
  /** Saved prompt ids, for `POST /api/workflows/validate`. */
  savedPromptIds: () => string[];
  /**
   * Resolves `GET /api/workflows?projectPath=` to the project it names — its path as stored and its
   * workspace NAME — or null when it is not a `<workspaces>/<ws>/<project>` path. Defaults to the
   * path's parent directory name as the workspace.
   */
  projectPathFilter?: (projectPath: string) => { path: string; workspace: string } | null;
  /** How often a followed log is re-read at its end (tests shorten it). */
  logPollMs?: number;
}

/** Default and maximum page sizes for the run history. */
const RUNS_PAGE_DEFAULT = 20;
const RUNS_PAGE_MAX = 100;
const LOG_WINDOW_DEFAULT = 256 * 1024;
const LOG_WINDOW_MAX = 4 * 1024 * 1024;
const SCHEDULE_PREVIEW_DEFAULT = 5;
const SCHEDULE_PREVIEW_MAX = 20;

const CONFIG_SCHEMAS: Record<WorkflowNodeType, ZodTypeAny> = {
  "trigger.manual": triggerManualConfigSchema,
  "trigger.schedule": triggerScheduleConfigSchema,
  "trigger.git": triggerGitConfigSchema,
  agent: agentConfigSchema,
  code: codeConfigSchema,
  shell: shellConfigSchema,
  http: httpConfigSchema,
  if: ifConfigSchema,
  switch: switchConfigSchema,
  merge: mergeConfigSchema,
  stop: stopConfigSchema,
  wait: waitConfigSchema,
  workflow: subWorkflowConfigSchema,
  note: noteConfigSchema
};

let blockTypesCache: WorkflowBlockTypesResponse | null = null;

/** The block catalogue with each type's config as JSON schema (built once). */
export function workflowBlockTypes(): WorkflowBlockTypesResponse {
  if (blockTypesCache !== null) return blockTypesCache;
  const types: WorkflowBlockTypeInfo[] = WORKFLOW_NODE_TYPES.map((type) => {
    const entry = WORKFLOW_BLOCK_CATALOG[type];
    return {
      type,
      category: entry.category,
      title: entry.title,
      description: entry.description,
      handles: outputHandles({ id: "example", type, config: entry.example }),
      configSchema: zodToJsonSchema(CONFIG_SCHEMAS[type], { $refStrategy: "none" }),
      example: entry.example,
      output: entry.output
    };
  });
  blockTypesCache = { types, expressionGuide: WORKFLOW_EXPRESSION_GUIDE };
  return blockTypesCache;
}

/** A workflow's rail row: the engine's (live trigger state) when attached, else the store's. */
export function summarizeWorkflow(
  deps: Pick<WorkflowRouteDeps, "service" | "runStore" | "engine">,
  workflow: Workflow
): WorkflowSummary {
  const engine = deps.engine();
  if (engine !== null) return engine.summarize(workflow);
  return buildWorkflowSummary(workflow, { runStore: deps.runStore, validation: deps.service.validationOptions(workflow.id) });
}

/**
 * Delete a workflow and everything it owns: the definition first (so no trigger fires it again),
 * then its active runs are cancelled through the engine (when attached), then its runs and its
 * secrets are deleted. Project directories are never touched.
 */
export async function deleteWorkflowCascade(
  deps: Pick<WorkflowRouteDeps, "service" | "secrets" | "runStore" | "engine">,
  id: string,
  revision?: number
): Promise<void> {
  await deps.service.delete(id, revision);
  const engine = deps.engine();
  if (engine !== null) {
    for (const run of deps.runStore.activeForWorkflow(id)) {
      await engine.cancel(run.id).catch((error) => console.error(`Failed to cancel workflow run ${run.id}`, error));
    }
  }
  await deps.runStore.deleteForWorkflow(id);
  await deps.secrets.deleteForWorkflow(id);
}

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (isWorkflowError(error)) {
    return reply.code(error.status).send(error.body());
  }
  reply.log.error({ err: error }, "workflow route failed");
  return reply.code(500).send({ error: { code: "INTERNAL", message: "The workflow request failed; see the daemon log." } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function intQuery(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw invalidRequest(`${name} must be an integer.`);
  return Math.min(max, Math.max(min, n));
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function defaultProjectFilter(projectPath: string): { path: string; workspace: string } {
  const path = resolve(projectPath);
  return { path, workspace: basename(dirname(path)) };
}

type WorkflowRequest = FastifyRequest<{
  Params: Record<string, string>;
  Querystring: Record<string, string | undefined>;
  Body: unknown;
}>;

export function registerWorkflowRoutes(app: FastifyInstance, deps: WorkflowRouteDeps): void {
  const { service, secrets, runStore } = deps;

  const guarded =
    (handler: (request: WorkflowRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
      try {
        return await handler(request as WorkflowRequest, reply);
      } catch (error) {
        return sendError(reply, error);
      }
    };

  const requireEngine = (): WorkflowEngine => {
    const engine = deps.engine();
    if (engine === null) throw engineUnavailable();
    return engine;
  };

  /** A run the store or the engine knows; its workflow id is what redaction and ownership read. */
  const requireRunSummary = async (runId: string): Promise<{ workflowId: string }> => {
    const known = runStore.summaryOf(runId);
    if (known) return known;
    const engine = deps.engine();
    const run = engine !== null ? await engine.getRun(runId) : await runStore.load(runId);
    if (!run) throw runNotFound(runId);
    return run;
  };

  // ---- Definitions ----------------------------------------------------------------------------

  app.get(
    workflowRoutes.list,
    guarded(async (request): Promise<ListWorkflowsResponse> => {
      let workflows = service.list();
      const projectPath = optionalString(request.query.projectPath);
      if (projectPath !== undefined) {
        const target = (deps.projectPathFilter ?? defaultProjectFilter)(projectPath);
        if (target === null) throw invalidRequest("projectPath must be a project directory, <workspaces>/<workspace>/<project>.");
        const targetPath = resolve(target.path);
        workflows = workflows.filter((workflow) =>
          workflow.project.kind === "existing"
            ? resolve(workflow.project.projectPath) === targetPath
            : workflow.project.workspace === target.workspace
        );
      }
      const summaries = workflows
        .map((workflow) => summarizeWorkflow(deps, workflow))
        .sort((a, b) => (a.updatedAt === b.updatedAt ? 0 : a.updatedAt < b.updatedAt ? 1 : -1));
      return { workflows: summaries };
    })
  );

  app.post(
    workflowRoutes.create,
    guarded(async (request, reply) => {
      const response: WorkflowWriteResponse = await service.create(request.body as CreateWorkflowRequest);
      return reply.code(201).send(response);
    })
  );

  app.post(
    workflowRoutes.validate,
    guarded(async (request): Promise<ValidateWorkflowResponse> => {
      if (!isRecord(request.body) || !("workflow" in request.body)) throw invalidRequest("The body must be {workflow}.");
      const candidate = request.body.workflow;
      const id = isRecord(candidate) && typeof candidate.id === "string" ? candidate.id : undefined;
      const { problems } = validateWorkflow(candidate, {
        secretNames: secrets.names(id),
        savedPromptIds: deps.savedPromptIds(),
        knownWorkflowIds: service.list().map((workflow) => workflow.id)
      });
      return { problems };
    })
  );

  app.get(
    workflowRoutes.blockTypes,
    guarded(async (): Promise<WorkflowBlockTypesResponse> => workflowBlockTypes())
  );

  app.get(
    workflowRoutes.schedulePreview,
    guarded(async (request): Promise<SchedulePreviewResponse> => {
      const cron = typeof request.query.cron === "string" ? request.query.cron : "";
      const tz = optionalString(request.query.tz) ?? "UTC";
      const count = intQuery(request.query.count, SCHEDULE_PREVIEW_DEFAULT, 1, SCHEDULE_PREVIEW_MAX, "count");
      const error = validateCron(cron, tz);
      if (error !== null) return { valid: false, error, next: [] };
      return { valid: true, next: nextRuns(cron, tz, count) };
    })
  );

  app.post(
    workflowRoutes.accountPreview,
    guarded(async (request): Promise<AccountPreviewResponse> => {
      const engine = requireEngine();
      if (!isRecord(request.body) || !Array.isArray(request.body.chain)) throw invalidRequest("The body must be {chain, projectPath?}.");
      const projectPath = optionalString(request.body.projectPath);
      return { decision: await engine.accountPreview(request.body.chain as AgentChainEntry[], projectPath) };
    })
  );

  app.get(
    "/api/workflows/:id",
    guarded(async (request): Promise<GetWorkflowResponse> => {
      const workflow = service.require(request.params.id);
      return { workflow, problems: service.problems(workflow) };
    })
  );

  app.put(
    "/api/workflows/:id",
    guarded(
      async (request): Promise<WorkflowWriteResponse> => service.replace(request.params.id, request.body as ReplaceWorkflowRequest)
    )
  );

  app.delete(
    "/api/workflows/:id",
    guarded(async (request, reply) => {
      const revision =
        request.query.revision === undefined || request.query.revision === ""
          ? undefined
          : intQuery(request.query.revision, 0, 0, Number.MAX_SAFE_INTEGER, "revision");
      await deleteWorkflowCascade(deps, request.params.id, revision);
      return reply.code(204).send();
    })
  );

  app.post(
    "/api/workflows/:id/patch",
    guarded(
      async (request): Promise<WorkflowWriteResponse> => service.patch(request.params.id, request.body as PatchWorkflowRequest)
    )
  );

  app.post(
    "/api/workflows/:id/duplicate",
    guarded(async (request, reply) => reply.code(201).send(await service.duplicate(request.params.id)))
  );

  // ---- Runs -------------------------------------------------------------------------------------

  app.post(
    "/api/workflows/:id/run",
    guarded(async (request): Promise<RunWorkflowResponse> => {
      const engine = requireEngine();
      service.require(request.params.id);
      const body = request.body ?? {};
      if (!isRecord(body)) throw invalidRequest("The body must be a JSON object.");
      return engine.run(request.params.id, body as RunWorkflowRequest);
    })
  );

  app.post(
    "/api/workflows/:id/nodes/:nodeId/test",
    guarded(async (request): Promise<RunWorkflowResponse> => {
      const engine = requireEngine();
      const workflow = service.require(request.params.id);
      if (!workflow.nodes.some((node) => node.id === request.params.nodeId)) throw nodeNotFound(request.params.nodeId);
      return engine.testNode(workflow.id, request.params.nodeId);
    })
  );

  app.get(
    "/api/workflows/:id/runs",
    guarded(async (request): Promise<ListWorkflowRunsResponse> => {
      service.require(request.params.id);
      const limit = intQuery(request.query.limit, RUNS_PAGE_DEFAULT, 1, RUNS_PAGE_MAX, "limit");
      const before = optionalString(request.query.before);
      const opts = { limit, ...(before !== undefined ? { before } : {}) };
      const engine = deps.engine();
      return engine !== null ? engine.listRuns(request.params.id, opts) : runStore.listForWorkflow(request.params.id, opts);
    })
  );

  app.get(
    "/api/workflow-runs/:runId",
    guarded(async (request): Promise<GetWorkflowRunResponse> => {
      const engine = deps.engine();
      if (engine !== null) {
        const run = await engine.getRun(request.params.runId);
        if (!run) throw runNotFound(request.params.runId);
        return { run };
      }
      const persisted = await runStore.load(request.params.runId);
      if (!persisted) throw runNotFound(request.params.runId);
      return { run: persistedRunToWire(persisted) };
    })
  );

  app.get(
    "/api/workflow-runs/:runId/nodes/:nodeId/output",
    guarded(async (request): Promise<GetWorkflowNodeOutputResponse> => {
      const { runId, nodeId } = request.params;
      const engine = deps.engine();
      if (engine !== null) {
        await requireRunSummary(runId);
        const found = await engine.nodeOutput(runId, nodeId);
        if (!found.found) throw nodeNotFound(nodeId);
        return { output: found.output ?? null };
      }
      const run = await runStore.load(runId);
      if (!run) throw runNotFound(runId);
      const block = run.blocks[nodeId];
      if (!block) throw nodeNotFound(nodeId);
      if (block.outputFile !== undefined) {
        try {
          return { output: await runStore.readOutputFile(block.outputFile) };
        } catch {
          // The file is gone or unreadable: the inline preview is all there is.
        }
      }
      return { output: block.output ?? null };
    })
  );

  app.get(
    "/api/workflow-runs/:runId/nodes/:nodeId/log",
    guarded(
      async (request, reply) => {
        const { runId, nodeId } = request.params;
        const stream = request.query.stream ?? "stdout";
        if (stream !== "stdout" && stream !== "stderr") throw invalidRequest("stream must be stdout or stderr.");
        const offset = intQuery(request.query.offset, 0, 0, Number.MAX_SAFE_INTEGER, "offset");
        const maxBytes = intQuery(request.query.maxBytes, LOG_WINDOW_DEFAULT, 1, LOG_WINDOW_MAX, "maxBytes");
        const follow = request.query.follow === "1" || request.query.follow === "true";
        const summary = await requireRunSummary(runId);

        let path: string | null;
        const engine = deps.engine();
        if (engine !== null) {
          path = await engine.nodeLogPath(runId, nodeId, stream);
        } else {
          const run = await runStore.load(runId);
          if (!run) throw runNotFound(runId);
          const block = run.blocks[nodeId];
          if (!block) throw nodeNotFound(nodeId);
          path = block.attempt >= 1 ? join(runStore.attemptPath(runId, nodeId, block.attempt), `${stream}.log`) : null;
        }
        const isLive = (): boolean => deps.engine()?.isNodeLogLive(runId, nodeId) ?? false;
        const redactor = createRedactor(secrets.resolve(summary.workflowId));

        if (!follow) {
          const window =
            path === null
              ? { text: "", nextOffset: offset, eof: true, size: 0 }
              : await readLogWindow(path, offset, maxBytes, redactor, { holdTail: isLive() });
          return reply
            .header("x-log-next-offset", String(window.nextOffset))
            .header("x-log-eof", window.eof ? "1" : "0")
            .header("x-log-size", String(window.size))
            .header("x-log-live", isLive() ? "1" : "0")
            .type("text/plain; charset=utf-8")
            .send(window.text);
        }

        // Follow: the client may hang up before anything is registered.
        reply.hijack();
        if (request.raw.destroyed) return;
        reply.raw.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-cache",
          "x-accel-buffering": "no"
        });
        const abort = new AbortController();
        const onClose = (): void => abort.abort();
        request.raw.on("close", onClose);
        reply.raw.on("close", onClose);
        try {
          if (path !== null) {
            for await (const chunk of followLog(path, {
              offset,
              isLive,
              signal: abort.signal,
              redactor,
              ...(deps.logPollMs !== undefined ? { pollMs: deps.logPollMs } : {})
            })) {
              if (abort.signal.aborted) break;
              if (!reply.raw.write(chunk)) {
                await new Promise<void>((resolveDrain) => {
                  const done = (): void => {
                    reply.raw.off("drain", done);
                    abort.signal.removeEventListener("abort", done);
                    resolveDrain();
                  };
                  reply.raw.once("drain", done);
                  abort.signal.addEventListener("abort", done, { once: true });
                });
              }
            }
          }
        } catch (error) {
          request.log.warn({ err: error }, "workflow log follow ended with an error");
        } finally {
          request.raw.off("close", onClose);
          reply.raw.off("close", onClose);
          if (!reply.raw.writableEnded) reply.raw.end();
        }
        return reply;
      }
    )
  );

  app.post(
    "/api/workflow-runs/:runId/cancel",
    guarded(async (request) => {
      const engine = requireEngine();
      await requireRunSummary(request.params.runId);
      const cancelled = await engine.cancel(request.params.runId);
      if (!cancelled) throw new WorkflowError(409, "RUN_NOT_ACTIVE", "The run is not running.");
      return { cancelled: true };
    })
  );

  app.post(
    "/api/workflow-runs/:runId/delete-temp-project",
    guarded(async (request) => {
      const engine = requireEngine();
      await requireRunSummary(request.params.runId);
      return { deleted: await engine.deleteTempProject(request.params.runId) };
    })
  );

  // ---- Secrets (names out, values in) -----------------------------------------------------------

  const secretScope = (workflowId: string | undefined): string | undefined => {
    if (workflowId === undefined) return undefined;
    if (!service.get(workflowId)) throw workflowNotFound(workflowId);
    return workflowId;
  };

  app.get(
    workflowRoutes.secrets,
    guarded(async (request): Promise<ListWorkflowSecretsResponse> => ({
      secrets: secrets.list(optionalString(request.query.workflowId))
    }))
  );

  app.put(
    "/api/workflow-secrets/:name",
    guarded(
      async (request): Promise<ListWorkflowSecretsResponse> => {
        const workflowId = secretScope(optionalString(request.query.workflowId));
        if (!isRecord(request.body) || typeof request.body.value !== "string") {
          throw new WorkflowError(400, "SECRET_INVALID", "The body must be {value} with a string value.");
        }
        await secrets.set(request.params.name, request.body.value, workflowId);
        return { secrets: secrets.list(workflowId) };
      }
    )
  );

  app.delete(
    "/api/workflow-secrets/:name",
    guarded(async (request, reply) => {
      await secrets.delete(request.params.name, optionalString(request.query.workflowId));
      return reply.code(204).send();
    })
  );
}
