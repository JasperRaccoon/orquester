// Test helpers for the workflow modules (not exported from the package).

import { workflowRecordSchema } from "@orquester/config";

import { defaultNodeConfig } from "./block-types.ts";
import type { Workflow, WorkflowNode, WorkflowNodeType } from "./types.ts";

export const T0 = "2026-09-28T10:00:00.000Z";

/** A node of `type` with its default config, overridden by `config` (shallow). */
export function testNode(
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

export function testEdge(source: string, target: string, sourceHandle = "success", id?: string) {
  return { id: id ?? `${source}-${sourceHandle}-${target}`, source, target, sourceHandle };
}

/** A schema-valid workflow (parsed, defaults applied). */
export function testWorkflow(
  nodes: WorkflowNode[],
  edges: ReturnType<typeof testEdge>[] = [],
  overrides: Record<string, unknown> = {}
): Workflow {
  return workflowRecordSchema.parse({
    id: "wf-1",
    name: "Test",
    enabled: false,
    revision: 0,
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
