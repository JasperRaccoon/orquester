// An in-memory daemon for the workflow tools' tests: the routes of `workflowRoutes`, answering the bodies
// @orquester/api's workflow types promise, on top of FakeDaemonApi (whose explicit `on` routes still win, so a test can
// override any route with a canned answer). Definitions go through the shared core the real routes use:
// `createWorkflowFromRequest`, `applyWorkflowPatch` and `validateWorkflow`. Runs are driven by the test
// (`finishRun`), which publishes `workflowRun.*` on the "workflows" channel as the engine does.

import {
  applyWorkflowPatch,
  createWorkflowFromRequest,
  isRunActive,
  isTriggerType,
  triggerSummaryText,
  validateWorkflow,
  WORKFLOW_BLOCK_CATALOG,
  WORKFLOW_EXPRESSION_GUIDE,
  WORKFLOWS_CHANNEL,
  WorkflowPatchError,
  outputHandles,
  type CreateWorkflowRequest,
  type PatchWorkflowRequest,
  type RunWorkflowRequest,
  type Workflow,
  type WorkflowBlockRun,
  type WorkflowRun,
  type WorkflowRunStatus,
  type WorkflowRunSummary,
  type WorkflowSecretName,
  type WorkflowSummary
} from "@orquester/api";
import type { WorkflowNode, WorkflowNodeType } from "@orquester/config";
import type { DaemonMethod, DaemonResponse } from "../daemon-api.ts";
import { busEvent, FakeDaemonApi } from "../testing.ts";

const T0 = Date.parse("2026-09-28T10:00:00.000Z");
const err = (status: number, code: string, message: string, extra: Record<string, unknown> = {}): DaemonResponse => ({ status, body: { error: { code, message, ...extra } } });

export class FakeWorkflowDaemon extends FakeDaemonApi {
  workflows = new Map<string, Workflow>();
  runs = new Map<string, WorkflowRun>();
  /** Whole block outputs (the run detail carries previews). */
  outputs = new Map<string, unknown>();
  secrets: (WorkflowSecretName & { value: string })[] = [];
  /** Called with every run started, so a test can finish it (or not). */
  onRunStarted: ((run: WorkflowRun) => void) | null = null;
  private ids = 0;
  private clock = 0;

  private mintId = (): string => `id-${(this.ids += 1)}`;
  private now = (): Date => new Date(T0 + (this.clock += 1000));

  override async request(method: DaemonMethod, path: string, opts?: { query?: Record<string, string>; body?: unknown }): Promise<DaemonResponse> {
    const canned = await super.request(method, path, opts);
    const miss = canned.status === 404 && typeof (canned.body as { message?: unknown })?.message === "string" && (canned.body as { message: string }).message.startsWith("no fake route");
    if (!miss) return canned;
    return this.route(method, path, opts?.query ?? {}, opts?.body);
  }

  summaryOf(w: Workflow): WorkflowSummary {
    const runs = [...this.runs.values()].filter((r) => r.workflowId === w.id);
    const problems = validateWorkflow(w).problems;
    return {
      id: w.id, name: w.name, ...(w.description ? { description: w.description } : {}), enabled: w.enabled, revision: w.revision, project: w.project,
      triggers: w.nodes.filter((n) => isTriggerType(n.type)).map((n) => ({ nodeId: n.id, type: n.type, text: triggerSummaryText(n) })),
      nodeCount: w.nodes.length, errorCount: problems.filter((p) => p.severity === "error").length,
      ...(runs.length ? { lastRun: runs.at(-1)! } : {}), activeRuns: runs.filter((r) => isRunActive(r.status)),
      createdAt: w.createdAt, updatedAt: w.updatedAt
    };
  }

  /** End a run: blocks settle, `workflowRun.updated` then `workflowRun.finished` are published. */
  finishRun(runId: string, status: WorkflowRunStatus = "succeeded", blocks: Record<string, Partial<WorkflowBlockRun>> = {}, finalOutput?: unknown): void {
    const run = this.runs.get(runId)!;
    for (const [ref, patch] of Object.entries(blocks)) {
      const node = run.definition.nodes.find((n) => n.id === ref || n.name === ref)!;
      run.blocks[node.id] = { nodeId: node.id, name: node.name, type: node.type, status: "succeeded", attempt: 1, ...patch };
      if ("output" in patch) this.outputs.set(`${runId}/${node.id}`, patch.output);
    }
    run.status = status;
    run.endedAt = this.now().toISOString();
    if (finalOutput !== undefined) run.finalOutput = finalOutput;
    const summary = this.summaryOfRun(run);
    this.emit(busEvent("workflowRun.updated", { run: summary, blocks: Object.values(run.blocks) }, WORKFLOWS_CHANNEL));
    this.emit(busEvent("workflowRun.finished", { run: summary }, WORKFLOWS_CHANNEL));
  }

  summaryOfRun(run: WorkflowRun): WorkflowRunSummary {
    const { definition: _d, triggerPayload: _t, blocks: _b, takenEdges: _te, deadEdges: _de, finalOutput: _f, ...summary } = run;
    return summary;
  }

  private route(method: DaemonMethod, path: string, query: Record<string, string>, body: unknown): DaemonResponse {
    const [pathname] = path.split("?");
    const parts = pathname!.split("/").slice(1).map(decodeURIComponent); // ["api", "workflows", …]
    if (parts[0] !== "api") return { status: 404, body: { code: "NOT_FOUND", message: "not a route" } };
    if (parts[1] === "workflows") return this.workflowRoute(method, parts.slice(2), query, body);
    if (parts[1] === "workflow-runs") return this.runRoute(method, parts.slice(2));
    if (parts[1] === "workflow-secrets") return this.secretRoute(method, parts.slice(2), query, body);
    return { status: 404, body: { code: "NOT_FOUND", message: "not a route" } };
  }

  private workflowRoute(method: DaemonMethod, rest: string[], query: Record<string, string>, body: unknown): DaemonResponse {
    if (rest.length === 0 && method === "GET") {
      const list = [...this.workflows.values()].filter((w) => !query.projectPath || (w.project.kind === "existing" && w.project.projectPath === query.projectPath));
      return { status: 200, body: { workflows: list.map((w) => this.summaryOf(w)) } };
    }
    if (rest.length === 0 && method === "POST") {
      try {
        const created = createWorkflowFromRequest(body as CreateWorkflowRequest, { mintId: this.mintId, now: this.now });
        const { problems } = validateWorkflow(created);
        if (created.enabled && problems.some((p) => p.severity === "error")) return err(400, "INVALID_WORKFLOW", "The workflow has errors and cannot be enabled", { problems });
        this.workflows.set(created.id, created);
        return { status: 200, body: { workflow: created, problems } };
      } catch (e) {
        if (e instanceof WorkflowPatchError) return err(400, "INVALID_REQUEST", e.message, { opIndex: e.opIndex });
        throw e;
      }
    }
    if (rest[0] === "block-types" && method === "GET") {
      const types = (Object.keys(WORKFLOW_BLOCK_CATALOG) as WorkflowNodeType[]).map((type) => {
        const entry = WORKFLOW_BLOCK_CATALOG[type];
        const node = { id: "x", type, name: "X", position: { x: 0, y: 0 }, config: entry.example } as unknown as WorkflowNode;
        return { type, category: entry.category, title: entry.title, description: entry.description, handles: outputHandles(node), configSchema: { type: "object", title: `${entry.title} config`, properties: { example: { description: "x".repeat(200) } } }, example: entry.example, output: entry.output };
      });
      return { status: 200, body: { types, expressionGuide: WORKFLOW_EXPRESSION_GUIDE } };
    }
    if (rest[0] === "validate" && method === "POST") {
      return { status: 200, body: { problems: validateWorkflow((body as { workflow: unknown }).workflow).problems } };
    }
    const w = this.workflows.get(rest[0] ?? "");
    if (!w) return err(404, "WORKFLOW_NOT_FOUND", `No workflow "${rest[0]}"`);
    if (rest.length === 1 && method === "GET") return { status: 200, body: { workflow: w, problems: validateWorkflow(w).problems } };
    if (rest.length === 1 && method === "DELETE") {
      this.workflows.delete(w.id);
      return { status: 200, body: { ok: true } };
    }
    if (rest[1] === "patch" && method === "POST") {
      const req = body as PatchWorkflowRequest;
      if (req.revision !== w.revision) return err(409, "REVISION_CONFLICT", `The workflow is at revision ${w.revision}, not ${req.revision}`);
      let next: Workflow;
      try {
        next = applyWorkflowPatch(w, req.ops, { mintId: this.mintId, now: this.now });
      } catch (e) {
        // No opIndex in the body: the tool must find the op itself.
        if (e instanceof WorkflowPatchError) return err(400, "INVALID_REQUEST", e.message);
        throw e;
      }
      const { problems } = validateWorkflow(next);
      if (next.enabled && problems.some((p) => p.severity === "error")) return err(400, "INVALID_WORKFLOW", "The workflow has errors and cannot be enabled", { problems });
      next.revision = w.revision + 1;
      this.workflows.set(w.id, next);
      return { status: 200, body: { workflow: next, problems } };
    }
    if (rest[1] === "run" && method === "POST") {
      const req = (body ?? {}) as RunWorkflowRequest;
      const active = [...this.runs.values()].some((r) => r.workflowId === w.id && isRunActive(r.status));
      if (active && w.settings.overlap === "skip" && !req.force) return { status: 200, body: { runId: null, skipped: "overlap" } };
      const id = `run-${this.runs.size + 1}`;
      const queuedAt = this.now().toISOString();
      const run: WorkflowRun = {
        id, workflowId: w.id, workflowName: w.name, status: "running", trigger: { kind: "manual", text: "Run manually" }, test: false,
        queuedAt, startedAt: queuedAt, definition: structuredClone(w), triggerPayload: { kind: "manual", input: req.input ?? null },
        blocks: {}, takenEdges: [], deadEdges: []
      };
      this.runs.set(id, run);
      this.emit(busEvent("workflowRun.started", { run: this.summaryOfRun(run) }, WORKFLOWS_CHANNEL));
      this.onRunStarted?.(run);
      return { status: 200, body: { runId: id } };
    }
    if (rest[1] === "runs" && method === "GET") {
      const all = [...this.runs.values()].filter((r) => r.workflowId === w.id).reverse();
      const start = query.before ? all.findIndex((r) => r.id === query.before) + 1 : 0;
      const limit = Number(query.limit ?? 20);
      const page = all.slice(start, start + limit);
      return { status: 200, body: { runs: page.map((r) => this.summaryOfRun(r)), before: start + limit < all.length ? page.at(-1)!.id : null } };
    }
    return { status: 404, body: { code: "NOT_FOUND", message: "not a route" } };
  }

  private runRoute(method: DaemonMethod, rest: string[]): DaemonResponse {
    const run = this.runs.get(rest[0] ?? "");
    if (!run) return err(404, "RUN_NOT_FOUND", `No run "${rest[0]}"`);
    if (rest.length === 1 && method === "GET") return { status: 200, body: { run } };
    if (rest[1] === "cancel" && method === "POST") {
      if (!isRunActive(run.status)) return err(409, "RUN_NOT_ACTIVE", "The run is not active");
      this.finishRun(run.id, "cancelled");
      return { status: 200, body: { ok: true } };
    }
    if (rest[1] === "nodes" && rest[3] === "output" && method === "GET") {
      const key = `${run.id}/${rest[2]}`;
      if (!run.blocks[rest[2] ?? ""]) return err(404, "NODE_NOT_FOUND", `No block "${rest[2]}"`);
      return { status: 200, body: { output: this.outputs.get(key) ?? run.blocks[rest[2]!]!.output } };
    }
    return { status: 404, body: { code: "NOT_FOUND", message: "not a route" } };
  }

  private secretRoute(method: DaemonMethod, rest: string[], query: Record<string, string>, body: unknown): DaemonResponse {
    if (rest.length === 0 && method === "GET") {
      const visible = this.secrets.filter((s) => s.scope === "global" || s.workflowId === query.workflowId);
      return { status: 200, body: { secrets: visible.map(({ value: _v, ...name }) => name) } };
    }
    if (rest.length === 1 && method === "PUT") {
      const value = (body as { value: string }).value;
      const scope = query.workflowId ? "workflow" : "global";
      this.secrets = this.secrets.filter((s) => !(s.name === rest[0] && s.workflowId === query.workflowId));
      this.secrets.push({ name: rest[0]!, scope, ...(query.workflowId ? { workflowId: query.workflowId } : {}), updatedAt: this.now().toISOString(), short: value.length < 4, value });
      return { status: 200, body: { ok: true } };
    }
    return { status: 404, body: { code: "NOT_FOUND", message: "not a route" } };
  }
}
