/**
 * Test doubles for the agent profile service and routes: an in-memory
 * {@link ProfileAdapter} whose every call is recorded and can be held open.
 * Imported by `*.test.ts` only.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentProfileAgentId,
  ProfileConflictPolicy,
  ProfileInstructionsInfo,
  ProfileItem,
  ProfileItemDetail,
  ProfileItemDraft,
  ProfileItemKind
} from "@orquester/api";
import type { AdapterMutationResult, AdapterSnapshot, PortableItem, ProfileAdapter } from "./adapters/types.ts";
import { profileErrors } from "./errors.ts";

export function fakeItem(kind: ProfileItemKind, name: string, patch: Partial<ProfileItem> = {}): ProfileItem {
  return {
    id: `${kind}:${name}`,
    kind,
    name,
    enabled: true,
    toggleable: true,
    editable: true,
    deletable: true,
    locked: false,
    source: { type: "user", label: "User" },
    revision: `rev-${name}`,
    warnings: [],
    ...patch
  };
}

export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function draftName(draft: ProfileItemDraft): string {
  switch (draft.kind) {
    case "mcp":
      return draft.mcp.name;
    case "skill":
    case "command":
      return draft.document.name;
    case "hook":
      return `${draft.hook.event}-hook`;
    case "plugin":
      return "plugin" in draft.plugin ? `${draft.plugin.plugin}@${draft.plugin.marketplace}` : draft.plugin.spec;
    case "marketplace":
      return draft.marketplace.name ?? "market";
  }
}

function portableName(item: PortableItem): string {
  return item.kind === "mcp" ? item.server.name : item.name;
}

/**
 * An adapter over an in-memory item list. `calls` records every call by name;
 * `hold(method)` makes the next call of that method wait until released;
 * `failNext(method, error)` makes it throw.
 */
export class FakeProfileAdapter implements ProfileAdapter {
  items: ProfileItem[] = [];
  instructionsText = "";
  calls: string[] = [];
  closed = 0;
  paths: string[];
  /** Portable items handed to `importItem`, in order. */
  imported: PortableItem[] = [];
  /** The temp skill dirs `exportItem` created. */
  exportedDirs: string[] = [];
  private holds = new Map<string, Deferred<void>[]>();
  private failures = new Map<string, unknown>();
  private snapshotWaiters: Array<() => void> = [];

  constructor(
    readonly agent: AgentProfileAgentId,
    options: { paths?: string[] } = {}
  ) {
    this.paths = options.paths ?? [`/fake/${agent}/config`];
  }

  /** The next call of `method` blocks until the returned deferred resolves. */
  hold(method: string): Deferred<void> {
    const gate = deferred<void>();
    const list = this.holds.get(method) ?? [];
    list.push(gate);
    this.holds.set(method, list);
    return gate;
  }

  failNext(method: string, error: unknown): void {
    this.failures.set(method, error);
  }

  /** Resolves after the next `snapshot()` call has produced its result. */
  nextSnapshot(): Promise<void> {
    return new Promise((resolve) => this.snapshotWaiters.push(resolve));
  }

  private async enter(method: string): Promise<void> {
    this.calls.push(method);
    const gate = this.holds.get(method)?.shift();
    if (gate) await gate.promise;
    if (this.failures.has(method)) {
      const error = this.failures.get(method);
      this.failures.delete(method);
      throw error;
    }
  }

  private info(): ProfileInstructionsInfo {
    return {
      path: `/fake/${this.agent}/AGENTS.md`,
      exists: this.instructionsText !== "",
      bytes: this.instructionsText.length,
      lines: this.instructionsText === "" ? 0 : this.instructionsText.split("\n").length,
      revision: this.instructionsText === "" ? "" : `text-${this.instructionsText.length}`,
      warnings: []
    };
  }

  async snapshot(): Promise<AdapterSnapshot> {
    await this.enter("snapshot");
    const result = { instructions: this.info(), items: this.items.map((item) => ({ ...item })), fileErrors: [] };
    const waiters = this.snapshotWaiters.splice(0);
    queueMicrotask(() => waiters.forEach((resolve) => resolve()));
    return result;
  }

  async readItem(id: string): Promise<ProfileItemDetail> {
    await this.enter("readItem");
    const item = this.items.find((entry) => entry.id === id);
    if (!item) throw profileErrors.notFound(id);
    return { kind: "hook", item, hook: { event: "Stop", command: "true" } };
  }

  async create(draft: ProfileItemDraft, options: { onConflict: ProfileConflictPolicy }): Promise<AdapterMutationResult> {
    await this.enter("create");
    const name = draftName(draft);
    const id = `${draft.kind}:${name}`;
    if (this.items.some((item) => item.id === id) && options.onConflict === "fail") throw profileErrors.exists(name);
    this.items.push(fakeItem(draft.kind, name));
    return { itemIds: [id], notes: [] };
  }

  async update(id: string, revision: string, draft: ProfileItemDraft): Promise<AdapterMutationResult> {
    await this.enter("update");
    const item = this.find(id, revision);
    item.description = `updated ${draft.kind}`;
    item.revision = `${item.revision}+`;
    return { itemIds: [id], notes: [] };
  }

  async setEnabled(id: string, revision: string, enabled: boolean): Promise<AdapterMutationResult> {
    await this.enter("setEnabled");
    const item = this.find(id, revision);
    item.enabled = enabled;
    return { itemIds: [id], notes: [] };
  }

  async remove(id: string, revision: string): Promise<AdapterMutationResult> {
    await this.enter("remove");
    this.find(id, revision);
    this.items = this.items.filter((item) => item.id !== id);
    return { itemIds: [id], notes: [] };
  }

  async readInstructions(): Promise<{ text: string; info: ProfileInstructionsInfo }> {
    await this.enter("readInstructions");
    return { text: this.instructionsText, info: this.info() };
  }

  async writeInstructions(text: string, revision: string): Promise<AdapterMutationResult> {
    await this.enter("writeInstructions");
    if (revision !== this.info().revision) throw profileErrors.conflict();
    this.instructionsText = text;
    return { itemIds: [], notes: [] };
  }

  async exportItem(id: string): Promise<PortableItem> {
    await this.enter("exportItem");
    const item = this.items.find((entry) => entry.id === id);
    if (!item) throw profileErrors.notFound(id);
    if (item.kind === "skill") {
      const dir = await mkdtemp(join(tmpdir(), "orq-profile-export-"));
      await writeFile(join(dir, "SKILL.md"), `---\nname: ${item.name}\n---\nbody\n`);
      this.exportedDirs.push(dir);
      return { kind: "skill", name: item.name, dir };
    }
    if (item.kind === "command") return { kind: "command", name: item.name, frontmatter: {}, body: "do it" };
    if (item.kind === "mcp") {
      return { kind: "mcp", server: { name: item.name, transport: "stdio", command: "srv" } };
    }
    throw profileErrors.invalidItem(`${item.kind} is not portable`);
  }

  async importItem(item: PortableItem, options: { onConflict: ProfileConflictPolicy }): Promise<AdapterMutationResult> {
    await this.enter("importItem");
    const name = portableName(item);
    const id = `${item.kind}:${name}`;
    if (this.items.some((entry) => entry.id === id) && options.onConflict === "fail") throw profileErrors.exists(name);
    this.imported.push(item);
    this.items.push(fakeItem(item.kind, name));
    return { itemIds: [id], notes: [] };
  }

  watchPaths(): string[] {
    return [...this.paths];
  }

  async close(): Promise<void> {
    this.closed += 1;
  }

  private find(id: string, revision: string): ProfileItem {
    const item = this.items.find((entry) => entry.id === id);
    if (!item) throw profileErrors.notFound(id);
    if (item.revision !== revision) throw profileErrors.conflict();
    return item;
  }
}
