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
  isRunActive,
  outputHandles,
  validateCron,
  nextRuns,
  parseExpressionPreviewRequest,
  validateWorkflow,
  WORKFLOW_BLOCK_CATALOG,
  WORKFLOW_BLOCK_GUIDES,
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
  type PreviewWorkflowExpressionResponse,
  type ReplaceWorkflowRequest,
  type RunWorkflowRequest,
  type RunWorkflowResponse,
  type SchedulePreviewResponse,
  type ValidateWorkflowResponse,
  type Workflow,
  type WorkflowBlockTypeInfo,
  type WorkflowBlockTypesResponse,
  type WorkflowNode,
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
  agentChainEntrySchema,
  waitConfigSchema,
  WORKFLOW_NODE_TYPES,
  WORKFLOW_SECRET_NAME_PATTERN
} from "@orquester/config";
import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ProjectOps, WorkflowEngine } from "./contracts.ts";
import { previewExpressions, type ExpressionPreviewRun } from "./expression-preview.ts";
import { isFinishedBlockStatus, WorkflowEngineError } from "./run-context.ts";
import {
  engineUnavailable,
  excerpt,
  invalidRequest,
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
  /**
   * Deletes a kept temporary project when the engine cannot (not attached yet, or its delete
   * failed) — the delete cascade must not drop the only record naming a directory it left behind.
   */
  projects?: Pick<ProjectOps, "deleteProject">;
  /**
   * Brings the agent catalogue validation reads (`service.catalog()`) up to date — bounded, never
   * rejects — before a write or a validate is judged against it.
   */
  agentCatalogReady?: () => Promise<void>;
}

/** Definitions may be 2 MiB (`maxDefinitionBytes`); a JSON body carrying one needs room around it. */
const WORKFLOW_WRITE_BODY_LIMIT = 3 * 1024 * 1024;

/** Default and maximum page sizes for the run history. */
const RUNS_PAGE_DEFAULT = 20;
const RUNS_PAGE_MAX = 100;
const LOG_WINDOW_DEFAULT = 256 * 1024;
const LOG_WINDOW_MAX = 4 * 1024 * 1024;
const SCHEDULE_PREVIEW_DEFAULT = 5;
const SCHEDULE_PREVIEW_MAX = 20;
/** How many recent runs the expression preview searches for one that reached its block. */
const PREVIEW_RUN_SEARCH = 20;
/** How long deleting a workflow waits for its cancelled runs to end. */
const CANCEL_WAIT_MS = 10_000;

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
function workflowBlockTypes(): WorkflowBlockTypesResponse {
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
      output: entry.output,
      guide: WORKFLOW_BLOCK_GUIDES[type]
    };
  });
  blockTypesCache = { types, expressionGuide: WORKFLOW_EXPRESSION_GUIDE };
  return blockTypesCache;
}

/** A workflow's rail row: the engine's (live trigger state) when attached, else the store's. */
function summarizeWorkflow(
  deps: Pick<WorkflowRouteDeps, "service" | "runStore" | "engine">,
  workflow: Workflow
): WorkflowSummary {
  const engine = deps.engine();
  if (engine !== null) return engine.summarize(workflow);
  return buildWorkflowSummary(workflow, { runStore: deps.runStore, validation: deps.service.validationOptions(workflow.id) });
}

/**
 * Delete a workflow and everything it owns: the definition first (so no trigger fires it again),
 * then its active runs are cancelled through the engine (when attached — a run of a deleted
 * workflow deletes its own temporary project as it ends), then the temporary projects its FINISHED
 * runs kept (a failed run keeps one `keepFailedTempDays`, and only its run record would ever sweep
 * it — the record goes next), then its runs and its secrets. An existing project is never touched.
 */
export async function deleteWorkflowCascade(
  deps: Pick<WorkflowRouteDeps, "service" | "secrets" | "runStore" | "engine" | "projects">,
  id: string,
  revision?: number
): Promise<void> {
  await deps.service.delete(id, revision);
  const engine = deps.engine();
  const cancelled: string[] = [];
  if (engine !== null) {
    for (const run of deps.runStore.activeForWorkflow(id)) {
      cancelled.push(run.id);
      await engine.cancel(run.id).catch((error) => console.error(`Failed to cancel workflow run ${run.id}`, error));
    }
    // Let the cancelled runs end (bounded): each deletes its own temporary project as it ends, and
    // its sandbox children are killed before the run directory goes.
    if (cancelled.length > 0 && engine.waitForRun) {
      const waitForRun = engine.waitForRun.bind(engine);
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all(cancelled.map((runId) => waitForRun(runId).catch(() => undefined))),
        new Promise<void>((resolveTimeout) => {
          timer = setTimeout(resolveTimeout, CANCEL_WAIT_MS);
        })
      ]);
      clearTimeout(timer);
    }
  }
  // The temporary projects the finished runs kept. A run whose project could not be deleted keeps
  // its record (due for the sweeper now): it is the only thing that names the directory.
  const keep = new Set<string>();
  let before: string | undefined;
  for (let page = 0; page < 50; page += 1) {
    const listing = await deps.runStore.listForWorkflow(id, before !== undefined ? { before, limit: 100 } : { limit: 100 });
    for (const run of listing.runs) {
      if (!run.tempProject || run.tempProject.deleted) continue;
      // A run the engine held (cancelled above) deletes its own project as it ends, and its record
      // is no longer written: it is the engine's, not this loop's.
      if (cancelled.includes(run.id) || (engine !== null && isRunActive(run.status))) continue;
      let gone = false;
      if (engine !== null) {
        gone = await engine.deleteTempProject(run.id).catch((error) => {
          console.error(`Failed to delete the temporary project of workflow run ${run.id}`, error);
          return false;
        });
      }
      if (!gone && deps.projects && !isRunActive(run.status)) {
        gone = await deps.projects
          .deleteProject(run.tempProject.path)
          .then(() => true)
          .catch((error) => {
            console.error(`Failed to delete the temporary project of workflow run ${run.id}`, error);
            return false;
          });
      }
      if (!gone) keep.add(run.id);
    }
    if (listing.before === null) break;
    before = listing.before;
  }
  for (const runId of keep) {
    const run = await deps.runStore.load(runId).catch(() => null);
    if (run?.tempProject && !run.tempProject.deleted) {
      run.tempProject = { path: run.tempProject.path, deleted: false, deleteAfter: new Date().toISOString() };
      await deps.runStore.save(run).catch(() => undefined);
    }
  }
  await deps.runStore.deleteForWorkflow(id, { keep });
  await deps.secrets.deleteForWorkflow(id);
}

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof WorkflowError) {
    return reply.code(error.status).send(error.body());
  }
  // The engine's refusals carry their status, code and (INVALID_WORKFLOW) problems.
  if (error instanceof WorkflowEngineError) {
    const status = Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 500;
    return reply.code(status).send({
      error: { code: error.code, message: error.message, ...(error.problems !== undefined ? { problems: error.problems } : {}) }
    });
  }
  // A body over the route's limit (Fastify refuses it before the handler runs).
  const fastifyCode = (error as { code?: unknown } | null)?.code;
  if (fastifyCode === "FST_ERR_CTP_BODY_TOO_LARGE" || (error as { statusCode?: unknown } | null)?.statusCode === 413) {
    return reply.code(413).send({
      error: { code: "LIMIT_EXCEEDED", message: `The request body is larger than ${WORKFLOW_WRITE_BODY_LIMIT / 1024 / 1024} MiB.` }
    });
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
  /** Up-to-date agent catalogue before a definition is judged (a no-op without one). */
  const catalogReady = async (): Promise<void> => {
    await deps.agentCatalogReady?.().catch(() => undefined);
  };

  const guarded =
    (handler: (request: WorkflowRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
      try {
        return await handler(request as WorkflowRequest, reply);
      } catch (error) {
        return sendError(reply, error);
      }
    };

  /** Write routes: room for a 2 MiB definition, and a too-big body answered in the workflow shape. */
  const writeRoute = {
    bodyLimit: WORKFLOW_WRITE_BODY_LIMIT,
    errorHandler: (error: unknown, _request: FastifyRequest, reply: FastifyReply) => sendError(reply, error)
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
    writeRoute,
    guarded(async (request, reply) => {
      await catalogReady();
      const response: WorkflowWriteResponse = await service.create(request.body as CreateWorkflowRequest);
      return reply.code(201).send(response);
    })
  );

  app.post(
    workflowRoutes.validate,
    writeRoute,
    guarded(async (request): Promise<ValidateWorkflowResponse> => {
      if (!isRecord(request.body) || !("workflow" in request.body)) throw invalidRequest("The body must be {workflow}.");
      const candidate = request.body.workflow;
      const id = isRecord(candidate) && typeof candidate.id === "string" ? candidate.id : undefined;
      await catalogReady();
      const catalog = service.catalog();
      const { problems } = validateWorkflow(candidate, {
        secretNames: secrets.names(id),
        savedPromptIds: deps.savedPromptIds(),
        knownWorkflowIds: service.list().map((workflow) => workflow.id),
        strictScheduleIntervals: true,
        ...(catalog ? { catalog } : {})
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
      const chain: AgentChainEntry[] = [];
      for (const [index, entry] of request.body.chain.entries()) {
        const parsed = agentChainEntrySchema.safeParse(entry);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          const where = issue && issue.path.length > 0 ? `.${issue.path.join(".")}` : "";
          throw invalidRequest(`chain[${index}]${where}: ${issue?.message ?? "is not an agent chain entry"}`);
        }
        chain.push(parsed.data);
      }
      const projectPath = optionalString(request.body.projectPath);
      return { decision: await engine.accountPreview(chain, projectPath) };
    })
  );

  app.get(
    "/api/workflows/:id",
    guarded(async (request): Promise<GetWorkflowResponse> => {
      const workflow = service.require(request.params.id);
      await catalogReady();
      return { workflow, problems: service.problems(workflow) };
    })
  );

  app.put(
    "/api/workflows/:id",
    writeRoute,
    guarded(
      async (request): Promise<WorkflowWriteResponse> => {
        await catalogReady();
        return service.replace(request.params.id, request.body as ReplaceWorkflowRequest);
      }
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
    writeRoute,
    guarded(
      async (request): Promise<WorkflowWriteResponse> => {
        await catalogReady();
        return service.patch(request.params.id, request.body as PatchWorkflowRequest);
      }
    )
  );

  app.post(
    "/api/workflows/:id/duplicate",
    guarded(async (request, reply) => {
      await catalogReady();
      return reply.code(201).send(await service.duplicate(request.params.id));
    })
  );

  // ---- Expression preview (read-only) -----------------------------------------------------------

  /** A run with a reader of its blocks' whole outputs: the engine's while attached, else the run store's. */
  const loadPreviewRun = async (runId: string): Promise<Omit<ExpressionPreviewRun, "how"> | null> => {
    const engine = deps.engine();
    if (engine !== null) {
      const run = await engine.getRun(runId);
      if (!run) return null;
      return { run, output: async (nodeId) => (await engine.nodeOutput(runId, nodeId)).output };
    }
    const persisted = await runStore.load(runId);
    if (!persisted) return null;
    return {
      run: persistedRunToWire(persisted),
      output: async (nodeId) => {
        const block = persisted.blocks[nodeId];
        if (block?.outputFile !== undefined) {
          try {
            return await runStore.readOutputFile(block.outputFile);
          } catch {
            // The file is gone or unreadable: the inline preview is all there is.
          }
        }
        return block?.output;
      }
    };
  };

  /** The requested run, else the latest that reached `node`, else the latest (a skipped fire holds nothing). */
  const previewSource = async (workflow: Workflow, node: WorkflowNode | null, runId: string | undefined): Promise<ExpressionPreviewRun | null> => {
    if (runId !== undefined) {
      const loaded = await loadPreviewRun(runId);
      if (!loaded) throw runNotFound(runId);
      if (loaded.run.workflowId !== workflow.id) {
        throw new WorkflowError(404, "RUN_NOT_FOUND", `Run ${excerpt(runId)} is not a run of this workflow.`);
      }
      return { ...loaded, how: "requested" };
    }
    const engine = deps.engine();
    const opts = { limit: PREVIEW_RUN_SEARCH };
    const listing = engine !== null ? await engine.listRuns(workflow.id, opts) : await runStore.listForWorkflow(workflow.id, opts);
    // The fallback: the newest run with a finished block (a queued run holds no data yet), else the newest.
    let newest: Omit<ExpressionPreviewRun, "how"> | null = null;
    let withData: Omit<ExpressionPreviewRun, "how"> | null = null;
    for (const summary of listing.runs) {
      if (summary.status === "skipped") continue;
      const loaded = await loadPreviewRun(summary.id).catch(() => null);
      if (!loaded) continue;
      newest ??= loaded;
      const hasData = Object.values(loaded.run.blocks).some((block) => isFinishedBlockStatus(block.status));
      if (hasData) withData ??= loaded;
      if (node === null) {
        if (hasData) break;
        continue;
      }
      const block = loaded.run.blocks[node.id];
      if (block && block.status !== "pending" && block.status !== "queued" && block.status !== "skipped") {
        return { ...loaded, how: "reached-node" };
      }
    }
    const chosen = withData ?? newest;
    if (!chosen) return null;
    const note =
      newest && chosen !== newest
        ? `The newest run (${newest.run.id}, ${newest.run.status}) has no finished block yet: run ${chosen.run.id} was used.`
        : undefined;
    return { ...chosen, how: "latest", ...(note ? { note } : {}) };
  };

  app.post(
    "/api/workflows/:id/expression-preview",
    writeRoute,
    guarded(async (request): Promise<PreviewWorkflowExpressionResponse> => {
      const parsed = parseExpressionPreviewRequest(request.body);
      if (!parsed.ok) throw invalidRequest(parsed.error);
      const workflow = service.require(request.params.id);
      const ref = parsed.request.node;
      let node: WorkflowNode | null = null;
      if (ref !== undefined) {
        node = workflow.nodes.find((candidate) => candidate.id === ref) ?? workflow.nodes.find((candidate) => candidate.name === ref) ?? null;
        if (node === null) throw new WorkflowError(404, "NODE_NOT_FOUND", `The workflow has no block with id or name ${excerpt(ref)}.`);
      }
      const source = await previewSource(workflow, node, parsed.request.runId);
      return previewExpressions({ workflow, request: parsed.request, node, source, secrets: secrets.resolve(workflow.id), now: new Date() });
    })
  );

  // ---- Runs -------------------------------------------------------------------------------------

  app.post(
    "/api/workflows/:id/run",
    writeRoute,
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
              redactor
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
    // A workflow that does not exist (never did, or was deleted) is a 404, never the global list.
    guarded(async (request): Promise<ListWorkflowSecretsResponse> => ({
      secrets: secrets.list(secretScope(optionalString(request.query.workflowId)))
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
      // The same checks as PUT: a name a secret can have, a workflow that exists.
      const workflowId = secretScope(optionalString(request.query.workflowId));
      if (!WORKFLOW_SECRET_NAME_PATTERN.test(request.params.name)) {
        throw new WorkflowError(400, "SECRET_INVALID", "Not a valid secret name: an uppercase letter, then uppercase letters, digits or _ (at most 64).");
      }
      await secrets.delete(request.params.name, workflowId);
      return reply.code(204).send();
    })
  );
}
