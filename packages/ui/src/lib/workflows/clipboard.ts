/**
 * Copy / paste / duplicate of workflow blocks (workflows spec §7.2).
 *
 * The clipboard holds JSON with a marker, so a paste recognises its own
 * payload among whatever else the user copied — as `text/plain` (what every
 * clipboard carries, so it works across workflows, tabs and windows) and, where
 * the browser allows it, under {@link WORKFLOW_CLIPBOARD_MIME} too.
 *
 * A paste never reuses anything: every block gets a fresh id; a name keeps its
 * text when it is free in the target and is renumbered when it is not
 * ("Review" → "Review2"); references between the pasted blocks follow their
 * renames; and only the edges BETWEEN copied blocks travel. Pure: the caller
 * mints ids.
 */

import {
  defaultNodeName,
  mapNodeTemplateFields,
  rewriteNodeReferences,
  WORKFLOW_NODE_NAME_PATTERN,
  type Workflow,
  type WorkflowEdge,
  type WorkflowNode
} from "@orquester/api";
import { workflowEdgeSchema, workflowNodeSchema } from "@orquester/config";

export const WORKFLOW_CLIPBOARD_MIME = "application/x-orquester-workflow";
export const WORKFLOW_CLIPBOARD_MARKER = "orquester.workflow-clipboard";
/** A paste without a pointer lands this far down-right of the copied blocks. */
export const PASTE_OFFSET = 32;
const GRID = 16;

export interface WorkflowClipboard {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

const snap = (value: number): number => Math.round(value / GRID) * GRID;

/** The selected blocks (and the edges between them) as clipboard text; null when nothing is selected. */
export function serializeWorkflowSelection(
  workflow: Pick<Workflow, "nodes" | "edges">,
  nodeIds: Iterable<string>
): string | null {
  const ids = new Set(nodeIds);
  const nodes = workflow.nodes.filter((node) => ids.has(node.id));
  if (nodes.length === 0) return null;
  const edges = workflow.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
  return JSON.stringify({ [WORKFLOW_CLIPBOARD_MARKER]: 1, nodes, edges }, null, 2);
}

/**
 * The payload in `text`, or null when it is not ours. Each block is checked
 * against its schema (a payload from a newer build keeps what this one can
 * read); an edge survives only when both of its ends did.
 */
export function parseWorkflowClipboard(text: string | null | undefined): WorkflowClipboard | null {
  if (typeof text !== "string" || !text.includes(WORKFLOW_CLIPBOARD_MARKER)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record[WORKFLOW_CLIPBOARD_MARKER] !== 1 || !Array.isArray(record.nodes)) return null;
  const nodes: WorkflowNode[] = [];
  const seen = new Set<string>();
  for (const entry of record.nodes) {
    const parsed = workflowNodeSchema.safeParse(entry);
    if (parsed.success && !seen.has(parsed.data.id)) {
      seen.add(parsed.data.id);
      nodes.push(parsed.data);
    }
  }
  if (nodes.length === 0) return null;
  const edges: WorkflowEdge[] = [];
  for (const entry of Array.isArray(record.edges) ? record.edges : []) {
    const parsed = workflowEdgeSchema.safeParse(entry);
    if (parsed.success && seen.has(parsed.data.source) && seen.has(parsed.data.target)) edges.push(parsed.data);
  }
  return { nodes, edges };
}

/** A free name for `wanted` among `taken`: itself when free, else renumbered ("Review2"). */
export function freeNodeName(wanted: string, type: WorkflowNode["type"], taken: ReadonlySet<string>): string {
  if (WORKFLOW_NODE_NAME_PATTERN.test(wanted) && !taken.has(wanted)) return wanted;
  const base = wanted.replace(/\d+$/, "").slice(0, 36);
  if (!WORKFLOW_NODE_NAME_PATTERN.test(base)) return defaultNodeName(type, taken);
  for (let n = 2; n < 100_000; n += 1) {
    const candidate = `${base}${n}`;
    if (candidate.length <= 40 && !taken.has(candidate)) return candidate;
  }
  return defaultNodeName(type, taken);
}

/** Rewrite every name in `renames` at once (so A→B, B→C never turns an A into a C). */
function renameReferences(node: WorkflowNode, renames: ReadonlyMap<string, string>): WorkflowNode {
  if (renames.size === 0) return node;
  const tokens = new Map<string, string>();
  let index = 0;
  for (const from of renames.keys()) tokens.set(from, `Qpaste${index++}Q`);
  let next = mapNodeTemplateFields(node, (value) => {
    let out = value;
    for (const [from, token] of tokens) out = rewriteNodeReferences(out, from, token);
    for (const [from, token] of tokens) out = rewriteNodeReferences(out, token, renames.get(from)!);
    return out;
  });
  if (next.type === "agent" && next.config.session.kind === "continue") {
    const renamed = renames.get(next.config.session.fromNode);
    if (renamed !== undefined) {
      next = structuredClone(next);
      if (next.type === "agent" && next.config.session.kind === "continue") next.config.session.fromNode = renamed;
    }
  }
  return next;
}

export interface PasteOptions {
  mintId: () => string;
  /** Put the pasted group's top-left corner here (a flow position). Default: the copy's own + {@link PASTE_OFFSET}. */
  at?: { x: number; y: number } | null;
  /** Extra offset, e.g. a second paste of the same copy. */
  offset?: number;
}

export interface PasteResult<W> {
  workflow: W;
  /** The new blocks' ids, in the payload's order. */
  nodeIds: string[];
}

/** `workflow` with `clip`'s blocks added: new ids and free names, inner references and edges kept. */
export function pasteWorkflowClipboard<W extends Pick<Workflow, "nodes" | "edges">>(
  workflow: W,
  clip: WorkflowClipboard,
  options: PasteOptions
): PasteResult<W> {
  const taken = new Set(workflow.nodes.map((node) => node.name));
  const ids = new Map<string, string>();
  const renames = new Map<string, string>();
  for (const node of clip.nodes) {
    ids.set(node.id, options.mintId());
    const name = freeNodeName(node.name, node.type, taken);
    taken.add(name);
    if (name !== node.name) renames.set(node.name, name);
  }
  const minX = Math.min(...clip.nodes.map((node) => node.position.x));
  const minY = Math.min(...clip.nodes.map((node) => node.position.y));
  const shift = options.offset ?? PASTE_OFFSET;
  const dx = options.at ? snap(options.at.x) - minX : shift;
  const dy = options.at ? snap(options.at.y) - minY : shift;

  const nodes = clip.nodes.map((node) => {
    const copy = renameReferences(structuredClone(node), renames);
    return {
      ...copy,
      id: ids.get(node.id)!,
      name: renames.get(node.name) ?? node.name,
      position: { x: snap(node.position.x + dx), y: snap(node.position.y + dy) }
    } as WorkflowNode;
  });
  const edges = clip.edges
    .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
    .map((edge) => ({ ...edge, id: options.mintId(), source: ids.get(edge.source)!, target: ids.get(edge.target)! }));
  return {
    workflow: { ...workflow, nodes: [...workflow.nodes, ...nodes], edges: [...workflow.edges, ...edges] },
    nodeIds: nodes.map((node) => node.id)
  };
}

/** Ctrl/Cmd+D: copy and paste the selection in one step, offset beside it. */
export function duplicateWorkflowNodes<W extends Pick<Workflow, "nodes" | "edges">>(
  workflow: W,
  nodeIds: Iterable<string>,
  mintId: () => string
): PasteResult<W> | null {
  const text = serializeWorkflowSelection(workflow, nodeIds);
  const clip = text === null ? null : parseWorkflowClipboard(text);
  if (clip === null) return null;
  return pasteWorkflowClipboard(workflow, clip, { mintId });
}
