import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, sep } from "node:path";
import type { TodoScope } from "@orquester/api";
import { type TodoRecord, parseTodosConfig } from "@orquester/config";

export class TodoError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "TodoError";
  }
}

/**
 * Daemon-owned to-do lists. In-memory map mirrored to `todos.json` with an atomic
 * tmp+rename write and reloaded on boot — the same durability model as the session index.
 * `lifecycle` emits "created" | "updated" | "deleted", each with the TodoRecord.
 */
export class TodoListManager {
  private readonly todos = new Map<string, TodoRecord>();
  readonly lifecycle = new EventEmitter();
  private loaded = false;

  constructor(
    private readonly indexPath: string,
    private readonly logger: Pick<Console, "warn"> = console
  ) {}

  async load(): Promise<void> {
    try {
      const text = await readFile(this.indexPath, "utf8");
      const parsed = parseTodosConfig(JSON.parse(text));
      this.todos.clear();
      for (const rec of parsed.todos) this.todos.set(rec.id, rec);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        // Corrupt/unreadable: keep the map empty but DON'T overwrite the file.
        this.logger.warn(`Failed to read todos index: ${String(error)}`);
      }
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const tmpPath = `${this.indexPath}.tmp`;
    try {
      await mkdir(dirname(this.indexPath), { recursive: true });
      const data = { version: 1 as const, todos: [...this.todos.values()] };
      await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      await rename(tmpPath, this.indexPath);
    } catch (error) {
      console.error("Failed to persist todos index", error);
    }
  }

  list(scope: TodoScope, refKey: string): TodoRecord[] {
    return [...this.todos.values()]
      .filter((t) => t.scope === scope && t.refKey === refKey)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
  }

  get(id: string): TodoRecord | undefined {
    return this.todos.get(id);
  }

  async create(scope: TodoScope, refKey: string, name?: string): Promise<TodoRecord> {
    if (scope !== "workspace" && scope !== "project") throw new TodoError(400, "invalid scope");
    if (!refKey) throw new TodoError(400, "refKey required");
    const now = new Date().toISOString();
    const record: TodoRecord = {
      id: randomUUID(),
      name: name?.trim() || "Untitled",
      scope,
      refKey,
      body: "",
      createdAt: now,
      updatedAt: now
    };
    this.todos.set(record.id, record);
    await this.persist();
    this.lifecycle.emit("created", record);
    return record;
  }

  async update(id: string, patch: { name?: string; body?: string }): Promise<TodoRecord> {
    const record = this.todos.get(id);
    if (!record) throw new TodoError(404, "todo not found");
    if (patch.name !== undefined) record.name = patch.name.trim() || "Untitled";
    if (patch.body !== undefined) record.body = patch.body;
    record.updatedAt = new Date().toISOString();
    await this.persist();
    this.lifecycle.emit("updated", record);
    return record;
  }

  async delete(id: string): Promise<void> {
    const record = this.todos.get(id);
    if (!record) throw new TodoError(404, "todo not found");
    this.todos.delete(id);
    await this.persist();
    this.lifecycle.emit("deleted", record);
  }

  async deleteByProjectPath(path: string): Promise<void> {
    const removed = [...this.todos.values()].filter((t) => t.scope === "project" && t.refKey === path);
    if (removed.length === 0) return;
    for (const r of removed) this.todos.delete(r.id);
    await this.persist();
    for (const r of removed) this.lifecycle.emit("deleted", r);
  }

  async deleteByWorkspace(name: string, workspacePath: string): Promise<void> {
    const prefix = workspacePath + sep;
    const removed = [...this.todos.values()].filter(
      (t) =>
        (t.scope === "workspace" && t.refKey === name) ||
        (t.scope === "project" && (t.refKey === workspacePath || t.refKey.startsWith(prefix)))
    );
    if (removed.length === 0) return;
    for (const r of removed) this.todos.delete(r.id);
    await this.persist();
    for (const r of removed) this.lifecycle.emit("deleted", r);
  }
}
