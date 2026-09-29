// Automated workflows — the definitions store, `<appdir>/daemon/workflows.json` (spec §3.1, §8.1).
//
// Durability is the saved-prompts model, record for record (`apps/daemon/src/saved-prompts.ts`):
//
// - the parse is entry-wise tolerant (`parseWorkflowsFile`): a record this build cannot read (a
//   newer shape, a repeated id) and every unknown top-level key are written back VERBATIM on every
//   save — never listed, never counted, never touched;
// - a file that does not parse, or names a version this build does not know, is MOVED ASIDE to
//   `workflows.json.corrupt-<stamp>` and the store starts empty — it is never overwritten;
// - a file that cannot even be READ (EACCES, EMFILE, …) — or a corrupt one that cannot be moved —
//   may hold the user's workflows, so it is left alone and every mutation answers 503
//   `WORKFLOWS_UNAVAILABLE` before memory is touched;
// - writes are chained and atomic (0600), each serializing the map when it RUNS, so the last write
//   carries the latest state; a failed write is logged and the next one catches the file up.
//
// Every write is revision-checked (409 `REVISION_CONFLICT` naming the current revision), bumps the
// revision and `updatedAt`, and answers `{workflow, problems}` from `validateWorkflow`. A
// definition with errors may be SAVED, but only while it is disabled: an enabled workflow never
// holds an error, so a write that would leave one enabled with errors is refused whole (400
// `INVALID_WORKFLOW` with the problems) — enabling included. Records are never mutated in place: a
// change replaces the map entry, so an object already handed out stays what it was.

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile, rename } from "node:fs/promises";
import {
  applyWorkflowPatch,
  createWorkflowFromRequest,
  hasWorkflowErrors,
  validateWorkflow,
  WORKFLOW_LIMITS,
  WORKFLOWS_CHANNEL,
  WorkflowPatchError,
  type CreateWorkflowRequest,
  type PatchWorkflowRequest,
  type ReplaceWorkflowRequest,
  type ValidateWorkflowOptions,
  type Workflow,
  type WorkflowAgentCatalog,
  type WorkflowDeletedPayload,
  type WorkflowProblem,
  type WorkflowSecretsChangedPayload,
  type WorkflowSummary,
  type WorkflowUpsertedPayload,
  type WorkflowWriteResponse
} from "@orquester/api";
import { parseWorkflowsFile } from "@orquester/config";
import { writeFileAtomic } from "../agent-hooks.ts";
import type { Broadcaster } from "../broadcaster.ts";
import type { WorkflowStore } from "./contracts.ts";
import { excerpt, invalidRequest, WorkflowError, workflowNotFound } from "./errors.ts";
import { jsonBytes } from "./run-context.ts";

export interface WorkflowServiceOptions {
  /** `workflowsPath(baseDir)`. */
  file: string;
  logger?: Pick<Console, "warn" | "error">;
  /** Secret names a workflow can read (global + its own) — validation context. */
  secretNames?: (workflowId: string | undefined) => readonly string[];
  /** Saved prompt ids — validation context. */
  savedPromptIds?: () => readonly string[];
  /** The host's agent catalogue (agent/validation-catalog.ts), when read — validation context. */
  agentCatalog?: () => WorkflowAgentCatalog | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function patchError(error: unknown, what: "op" | "item"): WorkflowError {
  if (error instanceof WorkflowPatchError) {
    const where = what === "op" ? `Operation ${error.opIndex}` : `Item ${error.opIndex}`;
    return new WorkflowError(400, "INVALID_WORKFLOW", `${where}: ${error.message}`, undefined, error.opIndex);
  }
  return new WorkflowError(400, "INVALID_WORKFLOW", error instanceof Error ? error.message : "The workflow is invalid.");
}

export class WorkflowService implements WorkflowStore {
  /** Emits `"upserted"` (the whole {@link Workflow}) and `"deleted"` (`{id}`) after each write lands. */
  readonly lifecycle = new EventEmitter();
  private readonly workflows = new Map<string, Workflow>();
  private rejected: unknown[] = [];
  private extra: Record<string, unknown> = {};
  private writes: Promise<void> = Promise.resolve();
  private blockedReason: string | null = null;
  private readonly file: string;
  private readonly logger: Pick<Console, "warn" | "error">;
  private readonly secretNames: (workflowId: string | undefined) => readonly string[];
  private readonly savedPromptIds: () => readonly string[];
  private readonly agentCatalog: () => WorkflowAgentCatalog | undefined;

  constructor(options: WorkflowServiceOptions) {
    this.file = options.file;
    this.logger = options.logger ?? console;
    this.secretNames = options.secretNames ?? (() => []);
    this.savedPromptIds = options.savedPromptIds ?? (() => []);
    this.agentCatalog = options.agentCatalog ?? (() => undefined);
    this.lifecycle.setMaxListeners(50);
  }

  async load(): Promise<void> {
    this.workflows.clear();
    this.rejected = [];
    this.extra = {};
    this.blockedReason = null;
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") return;
      this.block(`workflows.json could not be read (${code ?? "unknown error"})`, error);
      return;
    }
    let parsed;
    try {
      parsed = parseWorkflowsFile(JSON.parse(text));
    } catch (error) {
      await this.quarantine(error instanceof Error ? error.message : String(error));
      return;
    }
    for (const workflow of parsed.workflows) this.workflows.set(workflow.id, workflow);
    this.rejected = parsed.rejected;
    this.extra = parsed.extra;
    if (this.rejected.length > 0) {
      this.logger.warn(
        `workflows.json: ${this.rejected.length} workflow(s) this build cannot read (malformed, a newer shape, or a ` +
          "repeated id) are not listed; they stay in the file untouched."
      );
    }
  }

  /** Why mutations are refused this run, or null. */
  get blocked(): string | null {
    return this.blockedReason;
  }

  // ---- WorkflowStore ------------------------------------------------------------------------

  list(): Workflow[] {
    return [...this.workflows.values()];
  }

  get(id: string): Workflow | null {
    return this.workflows.get(id) ?? null;
  }

  onChanged(listener: (workflow: Workflow) => void): () => void {
    this.lifecycle.on("upserted", listener);
    return () => this.lifecycle.off("upserted", listener);
  }

  onDeleted(listener: (id: string) => void): () => void {
    const wrapped = (payload: WorkflowDeletedPayload): void => listener(payload.id);
    this.lifecycle.on("deleted", wrapped);
    return () => this.lifecycle.off("deleted", wrapped);
  }

  // ---- Reads --------------------------------------------------------------------------------

  require(id: string): Workflow {
    const workflow = this.workflows.get(id);
    if (!workflow) throw workflowNotFound(id);
    return workflow;
  }

  /**
   * The validation context for a workflow (its visible secret names, saved prompts, workflow ids,
   * and the host's agent catalogue when one has been read).
   */
  validationOptions(workflowId?: string): ValidateWorkflowOptions {
    const catalog = this.catalog();
    return {
      secretNames: [...this.secretNames(workflowId)],
      savedPromptIds: [...this.savedPromptIds()],
      knownWorkflowIds: [...this.workflows.keys()],
      ...(catalog ? { catalog } : {})
    };
  }

  /** The host's agent catalogue as validation last read it, or undefined. */
  catalog(): WorkflowAgentCatalog | undefined {
    try {
      return this.agentCatalog();
    } catch {
      return undefined;
    }
  }

  problems(workflow: Workflow): WorkflowProblem[] {
    return validateWorkflow(workflow, this.validationOptions(workflow.id)).problems;
  }

  // ---- Mutations ----------------------------------------------------------------------------

  async create(request: CreateWorkflowRequest): Promise<WorkflowWriteResponse> {
    this.requireWritable();
    if (!isRecord(request)) throw invalidRequest("The request body must be a JSON object.");
    this.requireRoom();
    let draft: Workflow;
    try {
      draft = createWorkflowFromRequest(request, { mintId: randomUUID, now: () => new Date() });
    } catch (error) {
      throw patchError(error, "item");
    }
    const response = this.check(draft);
    return this.write(response);
  }

  async replace(id: string, body: ReplaceWorkflowRequest): Promise<WorkflowWriteResponse> {
    this.requireWritable();
    if (!isRecord(body) || !isRecord(body.workflow)) {
      throw invalidRequest("The body must be {revision, workflow}.");
    }
    const current = this.require(id);
    this.requireRevision(current, body.revision);
    const candidate = {
      ...body.workflow,
      id: current.id,
      revision: current.revision + 1,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString()
    };
    return this.write(this.check(candidate));
  }

  async patch(id: string, body: PatchWorkflowRequest): Promise<WorkflowWriteResponse> {
    this.requireWritable();
    if (!isRecord(body) || !Array.isArray(body.ops)) throw invalidRequest("The body must be {revision, ops}.");
    const current = this.require(id);
    this.requireRevision(current, body.revision);
    let next: Workflow;
    try {
      next = applyWorkflowPatch(current, body.ops, { mintId: randomUUID, now: () => new Date() });
    } catch (error) {
      throw patchError(error, "op");
    }
    return this.write(
      this.check({ ...next, id: current.id, revision: current.revision + 1, createdAt: current.createdAt })
    );
  }

  /** A copy under new ids (workflow, blocks, connections), named "<name> (copy)", disabled. */
  async duplicate(id: string): Promise<WorkflowWriteResponse> {
    this.requireWritable();
    const source = this.require(id);
    this.requireRoom();
    const copy = structuredClone(source);
    const nodeIds = new Map<string, string>();
    for (const node of copy.nodes) nodeIds.set(node.id, randomUUID());
    copy.nodes = copy.nodes.map((node) => ({ ...node, id: nodeIds.get(node.id)! }));
    copy.edges = copy.edges.map((edge) => ({
      ...edge,
      id: randomUUID(),
      source: nodeIds.get(edge.source) ?? edge.source,
      target: nodeIds.get(edge.target) ?? edge.target
    }));
    if (copy.pinned !== undefined) {
      copy.pinned = Object.fromEntries(
        Object.entries(copy.pinned).map(([nodeId, value]) => [nodeIds.get(nodeId) ?? nodeId, value])
      );
    }
    const suffix = " (copy)";
    const stamp = new Date().toISOString();
    const candidate: Workflow = {
      ...copy,
      id: randomUUID(),
      name: `${source.name.slice(0, WORKFLOW_LIMITS.maxNameLength - suffix.length).trimEnd()}${suffix}`,
      enabled: false,
      revision: 0,
      createdAt: stamp,
      updatedAt: stamp
    };
    return this.write(this.check(candidate));
  }

  /** Remove a definition (the caller cascades runs and secrets). `revision`, when given, is checked. */
  async delete(id: string, revision?: number): Promise<Workflow> {
    this.requireWritable();
    const current = this.require(id);
    if (revision !== undefined) this.requireRevision(current, revision);
    this.workflows.delete(id);
    await this.persist();
    const payload: WorkflowDeletedPayload = { id };
    this.lifecycle.emit("deleted", payload);
    return current;
  }

  /** Waits for every write started so far. Never rejects. */
  async flush(): Promise<void> {
    await this.writes.catch(() => undefined);
  }

  // ---- Internals ----------------------------------------------------------------------------

  /** Validate a candidate definition and apply the write rules (limits, schema, enabled ⇒ no errors). */
  private check(candidate: unknown): WorkflowWriteResponse {
    const record = candidate as Record<string, unknown>;
    const nodes = Array.isArray(record.nodes) ? record.nodes.length : 0;
    const edges = Array.isArray(record.edges) ? record.edges.length : 0;
    if (nodes > WORKFLOW_LIMITS.maxNodes) {
      throw new WorkflowError(400, "LIMIT_EXCEEDED", `A workflow has at most ${WORKFLOW_LIMITS.maxNodes} blocks (this one has ${nodes}).`);
    }
    if (edges > WORKFLOW_LIMITS.maxEdges) {
      throw new WorkflowError(400, "LIMIT_EXCEEDED", `A workflow has at most ${WORKFLOW_LIMITS.maxEdges} connections (this one has ${edges}).`);
    }
    const bytes = jsonBytes(candidate);
    if (bytes > WORKFLOW_LIMITS.maxDefinitionBytes) {
      throw new WorkflowError(
        400,
        "LIMIT_EXCEEDED",
        `The definition is ${Math.ceil(bytes / 1024)} KiB; the limit is ${WORKFLOW_LIMITS.maxDefinitionBytes / 1024} KiB.`
      );
    }
    const id = typeof record.id === "string" ? record.id : undefined;
    // A save is strict: an "every N" preset that cannot run evenly is an error here, a warning on
    // a stored definition (which keeps running).
    const result = validateWorkflow(candidate, { ...this.validationOptions(id), strictScheduleIntervals: true });
    if (result.workflow === null) {
      const errors = result.problems.filter((problem) => problem.severity === "error");
      throw new WorkflowError(
        400,
        "INVALID_WORKFLOW",
        `The workflow cannot be saved: ${errors[0]?.message ?? "it does not match the workflow schema"}`,
        result.problems
      );
    }
    if (result.workflow.enabled && hasWorkflowErrors(result.problems)) {
      const count = result.problems.filter((problem) => problem.severity === "error").length;
      throw new WorkflowError(
        400,
        "INVALID_WORKFLOW",
        `An enabled workflow cannot have errors (${count}). Fix them, or save it disabled.`,
        result.problems
      );
    }
    return { workflow: result.workflow, problems: result.problems };
  }

  private async write(response: WorkflowWriteResponse): Promise<WorkflowWriteResponse> {
    this.workflows.set(response.workflow.id, response.workflow);
    await this.persist();
    this.lifecycle.emit("upserted", response.workflow);
    return response;
  }

  private requireRevision(current: Workflow, revision: unknown): void {
    if (typeof revision !== "number" || !Number.isInteger(revision)) {
      throw invalidRequest("revision must be the integer revision the edit was based on.");
    }
    if (revision !== current.revision) {
      throw new WorkflowError(
        409,
        "REVISION_CONFLICT",
        `The workflow changed since it was read: the current revision is ${current.revision} (the edit was based on ${revision}). Reload it and apply the change again.`
      );
    }
  }

  private requireRoom(): void {
    if (this.workflows.size >= WORKFLOW_LIMITS.maxWorkflows) {
      throw new WorkflowError(
        400,
        "LIMIT_EXCEEDED",
        `There are already ${WORKFLOW_LIMITS.maxWorkflows} workflows, the most this daemon keeps. Delete one to add another.`
      );
    }
  }

  private requireWritable(): void {
    if (this.blockedReason !== null) {
      throw new WorkflowError(
        503,
        "WORKFLOWS_UNAVAILABLE",
        `Workflows are read-only: ${this.blockedReason}. Nothing is saved until the file is fixed and the daemon restarts.`
      );
    }
  }

  private block(reason: string, error: unknown): void {
    this.blockedReason = reason;
    this.logger.error(`${reason}: ${String(error)}. Workflows are read-only until it is fixed and the daemon restarts.`);
  }

  private async quarantine(detail: string): Promise<void> {
    const aside = `${this.file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
      await rename(this.file, aside);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      this.block(`workflows.json is corrupt and could not be moved aside (${code ?? "unknown error"})`, `${excerpt(detail, 300)}; ${String(error)}`);
      return;
    }
    this.logger.warn(`workflows.json is corrupt (${excerpt(detail, 300)}); moved it to ${aside} and started with no workflows.`);
  }

  private persist(): Promise<void> {
    const write = async (): Promise<void> => {
      if (this.blockedReason !== null) return;
      const data = { version: 1 as const, workflows: [...this.workflows.values(), ...this.rejected], ...this.extra };
      try {
        await writeFileAtomic(this.file, `${JSON.stringify(data, null, 2)}\n`, 0o600, false);
      } catch (error) {
        this.logger.error("Failed to persist workflows", error);
      }
    };
    this.writes = this.writes.then(write, write);
    return this.writes;
  }
}

/**
 * Definition and secret changes → the `/events` bus, on {@link WORKFLOWS_CHANNEL}:
 * `workflow.upserted` (the summary), `workflow.deleted` ({id}), `workflowSecrets.changed`
 * ({workflowId}, names never included — the client re-reads the list). Run events are the engine's.
 */
export function publishWorkflowEvents(input: {
  service: Pick<WorkflowService, "lifecycle">;
  secrets?: { lifecycle: EventEmitter };
  broadcaster: Pick<Broadcaster, "publish">;
  summarize: (workflow: Workflow) => WorkflowSummary;
}): void {
  const { service, secrets, broadcaster, summarize } = input;
  service.lifecycle.on("upserted", (workflow: Workflow) => {
    let summary: WorkflowSummary;
    try {
      summary = summarize(workflow);
    } catch (error) {
      console.error("Failed to summarize a workflow for its event", error);
      return;
    }
    const payload: WorkflowUpsertedPayload = { workflow: summary };
    broadcaster.publish(WORKFLOWS_CHANNEL, "workflow.upserted", payload);
  });
  service.lifecycle.on("deleted", (payload: WorkflowDeletedPayload) =>
    broadcaster.publish(WORKFLOWS_CHANNEL, "workflow.deleted", payload)
  );
  secrets?.lifecycle.on("changed", (payload: WorkflowSecretsChangedPayload) =>
    broadcaster.publish(WORKFLOWS_CHANNEL, "workflowSecrets.changed", payload)
  );
}
