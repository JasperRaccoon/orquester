// Test helpers for the trigger modules (fake TriggerHost, workflows, a no-I/O state store).

import type { Workflow, WorkflowNode } from "@orquester/api";
import { workflowRecordSchema } from "@orquester/config";
import type { FireRequest, TriggerHost, WorkflowLogger } from "../contracts.ts";
import { WorkflowStateStore } from "../state-store.ts";
import type { ManualClock } from "./clock.ts";

export interface FakeHost extends TriggerHost {
  workflows: Workflow[];
  fired: FireRequest[];
  skipped: { request: FireRequest; reason: "missed" | "overlap" }[];
  /** Replaces a workflow (by id) and notifies listeners. */
  put(workflow: Workflow): void;
  remove(id: string): void;
  changed(): void;
  /** Called inside `fire` (to observe the state at fire time). */
  onFire?: (request: FireRequest) => void;
}

export function fakeHost(workflows: Workflow[] = []): FakeHost {
  const listeners = new Set<() => void>();
  const host: FakeHost = {
    workflows,
    fired: [],
    skipped: [],
    enabledTriggers(type) {
      return host.workflows
        .filter((workflow) => workflow.enabled)
        .flatMap((workflow) =>
          workflow.nodes
            .filter((node) => node.type === type)
            .map((node) => ({ workflow, node: node as never }))
        );
    },
    async fire(request) {
      host.onFire?.(request);
      host.fired.push(request);
      return { runId: `run-${host.fired.length}` };
    },
    async recordSkipped(request, reason) {
      host.skipped.push({ request, reason });
    },
    onDefinitionsChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    put(workflow) {
      host.workflows = [...host.workflows.filter((w) => w.id !== workflow.id), workflow];
      host.changed();
    },
    remove(id) {
      host.workflows = host.workflows.filter((w) => w.id !== id);
      host.changed();
    },
    changed() {
      for (const listener of listeners) listener();
    }
  };
  return host;
}

export function node(id: string, type: WorkflowNode["type"], config: Record<string, unknown>, extra: Record<string, unknown> = {}): WorkflowNode {
  return { id, type, name: id.replace(/[^A-Za-z0-9_]/g, "_").replace(/^[^A-Za-z]/, "N"), position: { x: 0, y: 0 }, config, ...extra } as WorkflowNode;
}

export function workflow(id: string, nodes: WorkflowNode[], overrides: Record<string, unknown> = {}): Workflow {
  return workflowRecordSchema.parse({
    id,
    name: id,
    enabled: true,
    revision: 1,
    project: { kind: "existing", projectPath: "/w/ws/app" },
    settings: { timezone: "UTC" },
    nodes,
    edges: [],
    createdAt: "2026-09-28T10:00:00.000Z",
    updatedAt: "2026-09-28T10:00:00.000Z",
    ...overrides
  });
}

export function memoryState(): WorkflowStateStore {
  return new WorkflowStateStore({ path: "/nonexistent/workflow-state.json", write: async () => undefined });
}

export function recordingLogger(): WorkflowLogger & { lines: string[] } {
  const lines: string[] = [];
  const at = (level: string) => (msg: string, meta?: Record<string, unknown>) => void lines.push(`${level}: ${msg}${meta ? ` ${JSON.stringify(meta)}` : ""}`);
  return { lines, debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

/**
 * Moves the manual clock forward by `ms`, one due timer at a time, waiting for the async work each
 * timer starts (`idle`) before looking for the next one.
 */
export async function advance(clock: ManualClock, idle: () => Promise<void>, ms: number): Promise<void> {
  let remaining = ms;
  await idle();
  for (;;) {
    const next = clock.pending()[0];
    if (next === undefined || next > remaining) {
      clock.advance(remaining);
      await idle();
      return;
    }
    clock.advance(next);
    remaining -= next;
    await idle();
  }
}
