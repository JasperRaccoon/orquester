// Test helpers for the workflow editor's modules (not exported from the package).

import { defaultNodeConfig, type Workflow, type WorkflowNode, type WorkflowNodeType } from "@orquester/api";
import { workflowRecordSchema } from "@orquester/config";

export const T0 = "2026-09-28T10:00:00.000Z";

/** A node of `type` with its default config, overridden by `config` (shallow). */
export function node(
  id: string,
  type: WorkflowNodeType,
  config: Record<string, unknown> = {},
  extra: Partial<WorkflowNode> & { name?: string } = {}
): WorkflowNode {
  return {
    id,
    type,
    name: extra.name ?? id,
    position: { x: 0, y: 0 },
    ...extra,
    config: { ...(defaultNodeConfig(type) as Record<string, unknown>), ...config }
  } as WorkflowNode;
}

export function edge(source: string, target: string, sourceHandle = "success", id?: string) {
  return { id: id ?? `${source}-${sourceHandle}-${target}`, source, target, sourceHandle };
}

/** A schema-valid workflow (parsed, defaults applied). */
export function workflow(
  nodes: WorkflowNode[],
  edges: ReturnType<typeof edge>[] = [],
  overrides: Record<string, unknown> = {}
): Workflow {
  return workflowRecordSchema.parse({
    id: "wf-1",
    name: "Test",
    enabled: false,
    revision: 1,
    project: { kind: "existing", projectPath: "/w/ws/app" },
    settings: { timezone: "UTC" },
    nodes,
    edges,
    createdAt: T0,
    updatedAt: T0,
    ...overrides
  });
}

/** Sequential ids: "id-1", "id-2", … */
export function sequentialIds(prefix = "id"): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}-${n}`;
  };
}

/**
 * Static markup as it reads: tags dropped, entities decoded, whitespace runs
 * collapsed — so a check can look for a guide text however it was marked up.
 */
export function markupText(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|quot|amp|lt|gt|apos|nbsp);/gi, (entity, code: string) => {
      const lower = code.toLowerCase();
      if (lower.startsWith("#x")) return String.fromCodePoint(parseInt(lower.slice(2), 16));
      if (lower.startsWith("#")) return String.fromCodePoint(Number(lower.slice(1)));
      return ({ quot: '"', amp: "&", lt: "<", gt: ">", apos: "'", nbsp: " " } as Record<string, string>)[lower] ?? entity;
    })
    .replace(/\s+/g, " ");
}
