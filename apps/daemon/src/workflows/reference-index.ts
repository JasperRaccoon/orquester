// Automated workflows — the reference index the definitions store keeps (`WorkflowService.references`).
//
// What it maps, for every stored definition:
// - workflow → the sub-workflows its `workflow` blocks run, and the reverse (who runs it, directly or
//   through others) — what a chat grant must also cover before it covers an edit or delete;
// - saved prompt → the workflows whose agent blocks use it (and those blocks).
// The rules are the MCP's own (`membersOf`, `savedPromptIdOfNode`): one source for "calls" and
// "uses". The index is global, not per project — a workflow in one project may run, or use a prompt
// of, another — and each answer names every workflow's own project (and workspace).
//
// It changes only with the store's map, in the same synchronous step (`WorkflowService` calls `set` /
// `delete` where it sets or deletes the map entry, and `rebuild` from `load`), so an answer never
// lags a save that has landed; `version` moves with every change, for callers that compare answers.
//
// Fail closed. A record `workflows.json` holds that this build cannot read (a newer shape, a repeated
// id) is kept as its strings: one that mentions an id makes that id's callers — and a prompt's
// uses — UNKNOWN (null / `unknownReason`), never "none". Before the first rebuild, and while the
// file cannot be read at all, every answer is unknown.

import type { Workflow, WorkflowProject, WorkflowReference } from "@orquester/api";
import { membersOf, savedPromptIdOfNode } from "../mcp/tools/workflow-preview.ts";

interface Entry {
  info: Omit<WorkflowReference, "workspace">;
  /** Insertion order: answers list workflows as the store does. */
  seq: number;
  calls: string[];
  /** promptId → the agent blocks using it. */
  prompts: Map<string, { id: string; name: string }[]>;
}

export type CallersAnswer =
  | { version: number; callers: Omit<WorkflowReference, "workspace">[]; unknownReason?: undefined }
  | { version: number; callers: null; unknownReason: string };

export interface PromptUsesAnswer {
  version: number;
  workflows: (Omit<WorkflowReference, "workspace"> & { nodes: { id: string; name: string }[] })[];
  unknownReason?: string;
}

const NOT_LOADED = "the workflow definitions are not loaded yet";
const UNREADABLE_RECORD = "a workflow definition this Orquester build cannot read mentions it";

/** Every string in a value (keys too), depth-first: what an unreadable record could reference. */
function stringsOf(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 64) return out;
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsOf(item, out, depth + 1);
  else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      stringsOf(item, out, depth + 1);
    }
  }
  return out;
}

export class WorkflowReferenceIndex {
  private readonly entries = new Map<string, Entry>();
  /** child id → the workflows whose blocks run it directly. */
  private readonly callersOf = new Map<string, Set<string>>();
  /** prompt id → the workflows whose agent blocks use it. */
  private readonly promptUsers = new Map<string, Set<string>>();
  /** The strings of each record the store keeps but cannot read. */
  private opaque: string[][] = [];
  /** Why every answer is unknown, or null. */
  private unavailable: string | null = NOT_LOADED;
  private seq = 0;
  private versionCounter = 0;

  get version(): number {
    return this.versionCounter;
  }

  /**
   * From the store's state: its readable definitions, the records it keeps but cannot read, and —
   * when the file could not be read at all — why (every answer is then unknown).
   */
  rebuild(input: { workflows: readonly Workflow[]; unreadable?: readonly unknown[]; unavailable?: string | null }): void {
    this.entries.clear();
    this.callersOf.clear();
    this.promptUsers.clear();
    this.opaque = (input.unreadable ?? []).map((record) => stringsOf(record));
    this.unavailable = input.unavailable ?? null;
    for (const workflow of input.workflows) this.index(workflow);
    this.versionCounter += 1;
  }

  /** A definition saved (created, replaced, patched, duplicated). */
  set(workflow: Workflow): void {
    this.unindex(workflow.id);
    this.index(workflow);
    this.versionCounter += 1;
  }

  /** A definition deleted. */
  delete(id: string): void {
    this.unindex(id);
    this.entries.delete(id);
    this.versionCounter += 1;
  }

  /** The sub-workflow ids `id`'s blocks run ([] when it is not stored). */
  calls(id: string): string[] {
    return [...(this.entries.get(id)?.calls ?? [])];
  }

  /** Every workflow that runs `id` as a sub-workflow, directly or through others; null callers = unknown. */
  callers(id: string): CallersAnswer {
    const version = this.versionCounter;
    if (this.unavailable !== null) return { version, callers: null, unknownReason: this.unavailable };
    const found: Entry[] = [];
    const seen = new Set<string>([id]);
    let frontier = [id];
    while (frontier.length > 0) {
      const level: Entry[] = [];
      for (const child of frontier) {
        for (const parent of this.callersOf.get(child) ?? []) {
          if (seen.has(parent)) continue;
          seen.add(parent);
          const entry = this.entries.get(parent);
          if (entry) level.push(entry);
        }
      }
      level.sort((a, b) => a.seq - b.seq);
      found.push(...level);
      frontier = level.map((entry) => entry.info.workflowId);
    }
    // An unreadable record that names the workflow, or any of its callers, may run it.
    if (this.mentionedByOpaque(seen)) return { version, callers: null, unknownReason: UNREADABLE_RECORD };
    return { version, callers: found.map((entry) => ({ ...entry.info })) };
  }

  /** The callers' ids, sorted and joined by "," ("" for none) — null when unknown. What a precondition compares. */
  callersKey(id: string): string | null {
    const answer = this.callers(id);
    return answer.callers === null ? null : callersKey(answer.callers.map((caller) => caller.workflowId));
  }

  /** Every stored workflow whose agent blocks use `promptId`, with those blocks; `unknownReason` when it may be more. */
  promptUses(promptId: string): PromptUsesAnswer {
    const version = this.versionCounter;
    const entries = [...(this.promptUsers.get(promptId) ?? [])]
      .map((id) => this.entries.get(id))
      .filter((entry): entry is Entry => entry !== undefined)
      .sort((a, b) => a.seq - b.seq);
    const workflows = entries.map((entry) => ({ ...entry.info, nodes: (entry.prompts.get(promptId) ?? []).map((node) => ({ ...node })) }));
    const unknownReason = this.unavailable ?? (this.mentionedByOpaque(new Set([promptId])) ? UNREADABLE_RECORD : undefined);
    return { version, workflows, ...(unknownReason ? { unknownReason } : {}) };
  }

  private mentionedByOpaque(ids: ReadonlySet<string>): boolean {
    if (this.opaque.length === 0) return false;
    for (const strings of this.opaque) {
      for (const text of strings) {
        for (const id of ids) if (text.includes(id)) return true;
      }
    }
    return false;
  }

  private index(workflow: Workflow): void {
    const calls: string[] = [];
    for (const child of membersOf(workflow).childIds) if (!calls.includes(child)) calls.push(child);
    const prompts = new Map<string, { id: string; name: string }[]>();
    for (const node of workflow.nodes ?? []) {
      const promptId = savedPromptIdOfNode(node);
      if (promptId === null) continue;
      const nodes = prompts.get(promptId) ?? [];
      nodes.push({ id: node.id, name: node.name });
      prompts.set(promptId, nodes);
    }
    const previous = this.entries.get(workflow.id);
    const entry: Entry = {
      info: { workflowId: workflow.id, name: workflow.name, enabled: workflow.enabled, revision: workflow.revision, project: workflow.project as WorkflowProject },
      seq: previous?.seq ?? (this.seq += 1),
      calls,
      prompts
    };
    this.entries.set(workflow.id, entry);
    for (const child of calls) {
      const set = this.callersOf.get(child) ?? new Set<string>();
      set.add(workflow.id);
      this.callersOf.set(child, set);
    }
    for (const promptId of prompts.keys()) {
      const set = this.promptUsers.get(promptId) ?? new Set<string>();
      set.add(workflow.id);
      this.promptUsers.set(promptId, set);
    }
  }

  /** Drop `id`'s edges (its entry stays until replaced or deleted). */
  private unindex(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    for (const child of entry.calls) {
      const set = this.callersOf.get(child);
      set?.delete(id);
      if (set?.size === 0) this.callersOf.delete(child);
    }
    for (const promptId of entry.prompts.keys()) {
      const set = this.promptUsers.get(promptId);
      set?.delete(id);
      if (set?.size === 0) this.promptUsers.delete(promptId);
    }
  }
}

/** A caller set as one comparable string: the ids sorted, joined by ",". */
export function callersKey(ids: readonly string[]): string {
  return [...new Set(ids)].sort().join(",");
}
