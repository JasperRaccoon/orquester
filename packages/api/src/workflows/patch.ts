// Automated workflows — patch operations (spec §8.2) and the create request's materialisation.
//
// `applyWorkflowPatch` applies ops IN ORDER to a copy and throws `WorkflowPatchError` naming the
// first op that cannot apply — the caller then keeps the original (the batch is atomic). It checks
// what one op can break (references, handles, schemas of touched blocks) but not the whole
// workflow: the daemon runs `validateWorkflow` on the result before saving.

import {
  WORKFLOW_NODE_TYPES,
  workflowNodeSchema,
  workflowProjectSchema,
  workflowRecordSchema,
  workflowSettingsSchema,
  type WorkflowNode,
  type WorkflowProject
} from "@orquester/config";

import { defaultNodeConfig, defaultNodeName } from "./block-types.ts";
import { rewriteNodeReferences } from "./expressions.ts";
import { mapNodeTemplateFields } from "./fields.ts";
import { acceptsInput, outputHandles } from "./graph.ts";
import { autoLayout, placeNewNodes } from "./layout.ts";
import {
  WORKFLOW_LIMITS,
  WORKFLOW_NODE_NAME_PATTERN,
  type CreateWorkflowRequest,
  type Workflow,
  type WorkflowEdge,
  type WorkflowNodeRef,
  type WorkflowPatchNodeInput,
  type WorkflowPatchOp
} from "./types.ts";

export class WorkflowPatchError extends Error {
  constructor(
    /** 0-based index of the op that failed (for a create: nodes first, then edges). */
    readonly opIndex: number,
    message: string
  ) {
    super(message);
    this.name = "WorkflowPatchError";
  }
}

export interface PatchEnvironment {
  mintId: () => string;
  /** The clock `updatedAt` / `createdAt` read. */
  now: Date | (() => Date);
}

const nowIso = (env: PatchEnvironment): string => (typeof env.now === "function" ? env.now() : env.now).toISOString();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface ZodIssueLike {
  path: (string | number)[];
  message: string;
}
function firstIssue(issues: readonly ZodIssueLike[]): string {
  const issue = issues[0];
  if (issue === undefined) return "invalid";
  return issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message;
}

/** Resolve a node reference: an id first, then a name. */
export function findWorkflowNode(workflow: Pick<Workflow, "nodes">, ref: WorkflowNodeRef): WorkflowNode | undefined {
  return workflow.nodes.find((node) => node.id === ref) ?? workflow.nodes.find((node) => node.name === ref);
}

class Patcher {
  /** Nodes added without a position, placed once every op has applied. */
  readonly unplaced = new Set<string>();

  constructor(
    readonly workflow: Workflow,
    readonly env: PatchEnvironment
  ) {}

  fail(index: number, message: string): never {
    throw new WorkflowPatchError(index, message);
  }

  node(index: number, ref: WorkflowNodeRef | undefined, role = "block"): WorkflowNode {
    if (typeof ref !== "string" || ref.length === 0) this.fail(index, `Name the ${role} (its id or name)`);
    const node = findWorkflowNode(this.workflow, ref);
    if (node === undefined) this.fail(index, `There is no block "${ref}"`);
    return node;
  }

  checkName(index: number, name: unknown, exceptId?: string): string {
    if (typeof name !== "string" || !WORKFLOW_NODE_NAME_PATTERN.test(name)) {
      this.fail(index, `"${String(name).slice(0, 60)}" is not a valid block name: a letter, then letters, digits or _ (at most 40)`);
    }
    if (this.workflow.nodes.some((node) => node.name === name && node.id !== exceptId)) {
      this.fail(index, `A block named "${name}" already exists`);
    }
    return name;
  }

  parseNode(index: number, candidate: unknown): WorkflowNode {
    const parsed = workflowNodeSchema.safeParse(candidate);
    if (!parsed.success) {
      const name = isRecord(candidate) && typeof candidate.name === "string" ? candidate.name : "the block";
      this.fail(index, `${name}: ${firstIssue(parsed.error.issues)}`);
    }
    return parsed.data;
  }

  addNode(index: number, input: WorkflowPatchNodeInput | undefined): WorkflowNode {
    if (!isRecord(input)) this.fail(index, "add_node needs a node");
    if (this.workflow.nodes.length >= WORKFLOW_LIMITS.maxNodes) {
      this.fail(index, `At most ${WORKFLOW_LIMITS.maxNodes} blocks per workflow`);
    }
    const type = input.type;
    if (!(WORKFLOW_NODE_TYPES as readonly string[]).includes(type)) {
      this.fail(index, `Unknown block type "${String(type)}" (types: ${WORKFLOW_NODE_TYPES.join(", ")})`);
    }
    const config = defaultNodeConfig(type) as Record<string, unknown>;
    if (input.config !== undefined && !isRecord(input.config)) this.fail(index, "config must be an object");
    const id = input.id ?? this.env.mintId();
    if (typeof id !== "string" || id.length === 0) this.fail(index, "A block id must be a non-empty text");
    if (this.workflow.nodes.some((node) => node.id === id)) this.fail(index, `A block with the id "${id}" already exists`);
    const name =
      input.name === undefined
        ? defaultNodeName(type, this.workflow.nodes.map((node) => node.name))
        : this.checkName(index, input.name);
    const candidate: Record<string, unknown> = {
      id,
      type,
      name,
      position: input.position ?? { x: 0, y: 0 },
      config: { ...config, ...((input.config as Record<string, unknown> | undefined) ?? {}) }
    };
    for (const key of ["disabled", "notes", "retry", "timeoutMinutes", "projectOverride"] as const) {
      if (input[key] !== undefined) candidate[key] = input[key];
    }
    const node = this.parseNode(index, candidate);
    this.workflow.nodes.push(node);
    if (input.position === undefined) this.unplaced.add(node.id);
    return node;
  }

  updateNode(index: number, ref: WorkflowNodeRef, set: Record<string, unknown> | undefined): void {
    const node = this.node(index, ref);
    if (!isRecord(set)) this.fail(index, "update_node needs `set`");
    // A rename first: it may rewrite references inside this very block's config.
    if ("name" in set && set.name !== node.name) this.renameNode(index, node.id, set.name);
    const next: Record<string, unknown> = { ...findWorkflowNode(this.workflow, node.id)! };
    for (const [key, value] of Object.entries(set)) {
      switch (key) {
        case "id":
        case "type":
          this.fail(index, `A block's ${key} cannot change (remove it and add a new one)`);
          break;
        case "name":
          break;
        case "position":
          next.position = value;
          this.unplaced.delete(node.id);
          break;
        case "config": {
          if (!isRecord(value)) this.fail(index, "config must be an object");
          // The rename above may have rewritten references in this very node: start from the current config.
          const current = { ...(findWorkflowNode(this.workflow, node.id)!.config as Record<string, unknown>) };
          for (const [configKey, configValue] of Object.entries(value)) {
            if (configValue === null) delete current[configKey];
            else current[configKey] = configValue;
          }
          next.config = current;
          break;
        }
        case "disabled":
        case "notes":
        case "retry":
        case "timeoutMinutes":
        case "projectOverride":
          if (value === null) delete next[key];
          else next[key] = value;
          break;
        default:
          this.fail(index, `Unknown block field "${key}" (settable: name, position, config, disabled, notes, retry, timeoutMinutes, projectOverride)`);
      }
    }
    const parsed = this.parseNode(index, next);
    const position = this.workflow.nodes.findIndex((candidate) => candidate.id === node.id);
    this.workflow.nodes[position] = parsed;
  }

  removeNode(index: number, ref: WorkflowNodeRef): void {
    const node = this.node(index, ref);
    this.workflow.nodes = this.workflow.nodes.filter((candidate) => candidate.id !== node.id);
    this.workflow.edges = this.workflow.edges.filter((edge) => edge.source !== node.id && edge.target !== node.id);
    if (this.workflow.pinned && node.id in this.workflow.pinned) {
      const { [node.id]: _dropped, ...rest } = this.workflow.pinned;
      void _dropped;
      if (Object.keys(rest).length === 0) delete this.workflow.pinned;
      else this.workflow.pinned = rest;
    }
    this.unplaced.delete(node.id);
  }

  renameNode(index: number, ref: WorkflowNodeRef, to: unknown): void {
    const node = this.node(index, ref);
    if (to === node.name) return;
    const from = node.name;
    const name = this.checkName(index, to, node.id);
    this.workflow.nodes = this.workflow.nodes.map((candidate) => {
      let updated = mapNodeTemplateFields(candidate, (value) => rewriteNodeReferences(value, from, name));
      if (updated.type === "agent" && updated.config.session.kind === "continue" && updated.config.session.fromNode === from) {
        updated = structuredClone(updated);
        if (updated.type === "agent" && updated.config.session.kind === "continue") updated.config.session.fromNode = name;
      }
      if (updated.id === node.id) updated = { ...updated, name };
      return updated;
    });
  }

  connect(index: number, op: Extract<WorkflowPatchOp, { op: "connect" }>): WorkflowEdge {
    const source = this.node(index, op.source, "source block");
    const target = this.node(index, op.target, "target block");
    const handle = op.sourceHandle ?? "success";
    const handles = outputHandles(source);
    if (!handles.includes(handle)) {
      this.fail(
        index,
        handles.length === 0
          ? `${source.name} has no outputs`
          : `${source.name} has no "${handle}" output (it has ${handles.join(", ")})`
      );
    }
    if (!acceptsInput(target)) this.fail(index, `${target.name} takes no input`);
    if (source.id === target.id) this.fail(index, `${source.name} cannot connect to itself`);
    if (
      this.workflow.edges.some(
        (edge) => edge.source === source.id && edge.target === target.id && edge.sourceHandle === handle
      )
    ) {
      this.fail(index, `${source.name} → ${target.name} (${handle}) is already connected`);
    }
    if (this.workflow.edges.length >= WORKFLOW_LIMITS.maxEdges) {
      this.fail(index, `At most ${WORKFLOW_LIMITS.maxEdges} connections per workflow`);
    }
    const edge: WorkflowEdge = { id: this.env.mintId(), source: source.id, sourceHandle: handle, target: target.id };
    this.workflow.edges.push(edge);
    return edge;
  }

  disconnect(index: number, op: Extract<WorkflowPatchOp, { op: "disconnect" }>): void {
    const before = this.workflow.edges.length;
    if (op.edgeId !== undefined) {
      this.workflow.edges = this.workflow.edges.filter((edge) => edge.id !== op.edgeId);
      if (this.workflow.edges.length === before) this.fail(index, `There is no connection "${op.edgeId}"`);
      return;
    }
    const source = this.node(index, op.source, "source block");
    const target = this.node(index, op.target, "target block");
    this.workflow.edges = this.workflow.edges.filter(
      (edge) =>
        !(
          edge.source === source.id &&
          edge.target === target.id &&
          (op.sourceHandle === undefined || edge.sourceHandle === op.sourceHandle)
        )
    );
    if (this.workflow.edges.length === before) {
      this.fail(index, `${source.name} is not connected to ${target.name}${op.sourceHandle ? ` (${op.sourceHandle})` : ""}`);
    }
  }

  apply(index: number, op: WorkflowPatchOp): void {
    if (!isRecord(op)) this.fail(index, "An op must be an object");
    switch (op.op) {
      case "add_node":
        this.addNode(index, op.node);
        return;
      case "update_node":
        this.updateNode(index, op.node, op.set);
        return;
      case "remove_node":
        this.removeNode(index, op.node);
        return;
      case "rename_node":
        this.renameNode(index, op.node, op.to);
        return;
      case "connect":
        this.connect(index, op);
        return;
      case "disconnect":
        this.disconnect(index, op);
        return;
      case "set_settings": {
        if (!isRecord(op.settings)) this.fail(index, "set_settings needs `settings`");
        const current = this.workflow.settings as Record<string, unknown>;
        const merged: Record<string, unknown> = { ...current };
        for (const [key, value] of Object.entries(op.settings)) {
          if (value === null || value === undefined) delete merged[key];
          else if (key === "notify" && isRecord(value)) merged.notify = { ...(current.notify as object), ...value };
          else merged[key] = value;
        }
        const parsed = workflowSettingsSchema.safeParse(merged);
        if (!parsed.success) this.fail(index, `settings: ${firstIssue(parsed.error.issues)}`);
        this.workflow.settings = parsed.data;
        return;
      }
      case "set_project": {
        const parsed = workflowProjectSchema.safeParse(op.project);
        if (!parsed.success) this.fail(index, `project: ${firstIssue(parsed.error.issues)}`);
        this.workflow.project = parsed.data as WorkflowProject;
        return;
      }
      case "set_enabled":
        if (typeof op.enabled !== "boolean") this.fail(index, "set_enabled needs `enabled`: true or false");
        this.workflow.enabled = op.enabled;
        return;
      case "set_name": {
        const name = typeof op.name === "string" ? op.name.trim() : "";
        if (name.length === 0 || name.length > WORKFLOW_LIMITS.maxNameLength) {
          this.fail(index, `A workflow name is 1–${WORKFLOW_LIMITS.maxNameLength} characters`);
        }
        this.workflow.name = name;
        if (op.description === null) delete this.workflow.description;
        else if (typeof op.description === "string") this.workflow.description = op.description;
        return;
      }
      case "set_pinned": {
        const node = this.node(index, op.node);
        const pinned = { ...(this.workflow.pinned ?? {}) };
        if (op.output === null || op.output === undefined) delete pinned[node.id];
        else pinned[node.id] = structuredClone(op.output);
        if (Object.keys(pinned).length === 0) delete this.workflow.pinned;
        else this.workflow.pinned = pinned;
        return;
      }
      default: {
        const unknown: never = op;
        this.fail(index, `Unknown op "${String((unknown as { op?: unknown }).op)}"`);
      }
    }
  }

  placeUnplaced(): void {
    if (this.unplaced.size === 0) return;
    const positions = placeNewNodes(this.workflow, this.unplaced);
    this.workflow.nodes = this.workflow.nodes.map((node) =>
      positions[node.id] ? { ...node, position: positions[node.id]! } : node
    );
    this.unplaced.clear();
  }
}

/**
 * Apply ops in order to a copy of `workflow` and return it with `updatedAt` stamped (the revision is
 * the daemon's). Throws `WorkflowPatchError` naming the first op that cannot apply.
 */
export function applyWorkflowPatch(workflow: Workflow, ops: readonly WorkflowPatchOp[], env: PatchEnvironment): Workflow {
  if (!Array.isArray(ops)) throw new WorkflowPatchError(0, "ops must be a list");
  const patcher = new Patcher(structuredClone(workflow), env);
  ops.forEach((op, index) => patcher.apply(index, op));
  patcher.placeUnplaced();
  patcher.workflow.updatedAt = nowIso(env);
  return patcher.workflow;
}

/**
 * The workflow a `POST /api/workflows` creates: a fresh id, revision 0, timestamps, settings and
 * block defaults, minted names, and positions for blocks that lack them (all of them when
 * `autoLayout`). Edges name blocks by id or name. Throws `WorkflowPatchError` (its `opIndex`
 * counts the request's nodes, then its edges).
 */
export function createWorkflowFromRequest(request: CreateWorkflowRequest, env: PatchEnvironment): Workflow {
  if (!isRecord(request)) throw new WorkflowPatchError(0, "The request must be an object");
  const name = typeof request.name === "string" ? request.name.trim() : "";
  if (name.length === 0 || name.length > WORKFLOW_LIMITS.maxNameLength) {
    throw new WorkflowPatchError(0, `A workflow name is 1–${WORKFLOW_LIMITS.maxNameLength} characters`);
  }
  const stamp = nowIso(env);
  const base = workflowRecordSchema.safeParse({
    id: env.mintId(),
    name,
    ...(typeof request.description === "string" && request.description.length > 0 ? { description: request.description } : {}),
    enabled: request.enabled ?? false,
    revision: 0,
    project: request.project,
    settings: request.settings ?? {},
    nodes: [],
    edges: [],
    createdAt: stamp,
    updatedAt: stamp
  });
  if (!base.success) throw new WorkflowPatchError(0, firstIssue(base.error.issues));
  const patcher = new Patcher(base.data, env);
  const nodes = Array.isArray(request.nodes) ? request.nodes : [];
  const edges = Array.isArray(request.edges) ? request.edges : [];
  nodes.forEach((node, index) => patcher.addNode(index, node));
  edges.forEach((edge, offset) => {
    const index = nodes.length + offset;
    if (!isRecord(edge)) patcher.fail(index, "An edge must be an object");
    const created = patcher.connect(index, { op: "connect", source: edge.source, sourceHandle: edge.sourceHandle, target: edge.target });
    if (edge.id !== undefined) {
      if (typeof edge.id !== "string" || edge.id.length === 0) patcher.fail(index, "An edge id must be a non-empty text");
      if (patcher.workflow.edges.some((other) => other !== created && other.id === edge.id)) {
        patcher.fail(index, `Two connections share the id "${edge.id}"`);
      }
      created.id = edge.id;
    }
  });
  if (request.autoLayout) {
    const positions = autoLayout(patcher.workflow);
    patcher.workflow.nodes = patcher.workflow.nodes.map((node) =>
      positions[node.id] ? { ...node, position: positions[node.id]! } : node
    );
    // Notes are never laid out: place the unpositioned ones below.
    const notes = patcher.workflow.nodes.filter((node) => node.type === "note" && patcher.unplaced.has(node.id));
    patcher.unplaced.clear();
    for (const note of notes) patcher.unplaced.add(note.id);
  }
  patcher.placeUnplaced();
  return patcher.workflow;
}
