import { statSync } from "node:fs";
import { join } from "node:path";
import type { TodoScope } from "@orquester/api";
import { isValidName, type TodoRecord } from "@orquester/config";
import { TodoError, type TodoListManager } from "../todos.ts";
import { TabNotFound, ToolError } from "./terminal-control.ts";

export type TodoProjection = {
  id: string;
  name: string;
  scope: "workspace" | "project";
  body: string;
  createdAt: string;
  updatedAt: string;
};

export type TodoSelector = { workspace: string; project?: string };

export type TodoToolsDeps = {
  todos: TodoListManager;
  workspacesDir: string;
};

export type TodoToggleResult = { id: string; item: string; checked: boolean; body: string };

type ResolvedScope = {
  scope: TodoScope;
  refKey: string;
};

type BodyLine = {
  text: string;
  newline: string;
};

type TaskLine = {
  index: number;
  lineIndex: number;
  prefix: string;
  mark: string;
  afterMark: string;
  suffix: string;
  item: string;
  checked: boolean;
};

const TASK_LINE = /^(\s*[-*]\s+\[)( |x|X)(\]\s*)(.*)$/;

function statSafe(path: string) {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

function projectTodo(record: TodoRecord): TodoProjection {
  return {
    id: record.id,
    name: record.name,
    scope: record.scope,
    body: record.body,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}

function splitBodyLines(body: string): BodyLine[] {
  const lines: BodyLine[] = [];
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\r" && ch !== "\n") continue;
    const newline = ch === "\r" && body[i + 1] === "\n" ? "\r\n" : ch;
    lines.push({ text: body.slice(start, i), newline });
    i += newline.length - 1;
    start = i + 1;
  }
  if (start < body.length) {
    lines.push({ text: body.slice(start), newline: "" });
  }
  return lines;
}

function joinBodyLines(lines: BodyLine[]): string {
  return lines.map((line) => `${line.text}${line.newline}`).join("");
}

function taskLines(lines: BodyLine[]): TaskLine[] {
  const tasks: TaskLine[] = [];
  for (const [lineIndex, line] of lines.entries()) {
    const match = TASK_LINE.exec(line.text);
    if (!match) continue;
    const [, prefix, mark, afterMark, suffix] = match;
    tasks.push({
      index: tasks.length + 1,
      lineIndex,
      prefix,
      mark,
      afterMark,
      suffix,
      item: suffix.trim(),
      checked: mark.toLowerCase() === "x"
    });
  }
  return tasks;
}

function availableItems(tasks: TaskLine[]): string {
  return tasks.map((task) => `${task.index}. ${task.item}`).join(", ");
}

function todoNotFound(id: string): ToolError {
  return new ToolError(`No todo with id ${id}.`);
}

function rethrowTodoError(id: string, error: unknown): never {
  if (error instanceof TodoError && error.status === 404) {
    throw todoNotFound(id);
  }
  if (error instanceof TodoError) {
    throw new ToolError(error.message);
  }
  throw error;
}

export class TodoTools {
  constructor(private readonly deps: TodoToolsDeps) {}

  list(sel: TodoSelector): TodoProjection[] {
    const { scope, refKey } = this.resolveScope(sel);
    return this.deps.todos.list(scope, refKey).map(projectTodo);
  }

  async create(sel: TodoSelector, name: string): Promise<TodoProjection> {
    const { scope, refKey } = this.resolveScope(sel);
    return projectTodo(await this.deps.todos.create(scope, refKey, name));
  }

  async update(id: string, patch: { name?: string; body?: string }): Promise<TodoProjection> {
    try {
      return projectTodo(await this.deps.todos.update(id, patch));
    } catch (error) {
      rethrowTodoError(id, error);
    }
  }

  async remove(id: string): Promise<{ deleted: true }> {
    try {
      await this.deps.todos.delete(id);
      return { deleted: true };
    } catch (error) {
      rethrowTodoError(id, error);
    }
  }

  async toggleItem(
    id: string,
    item: string | number,
    checked?: boolean
  ): Promise<TodoToggleResult> {
    const todo = this.deps.todos.get(id);
    if (!todo) {
      throw todoNotFound(id);
    }

    const lines = splitBodyLines(todo.body);
    const tasks = taskLines(lines);
    if (tasks.length === 0) {
      throw new ToolError("No task items in todo.");
    }

    const task = this.resolveTask(tasks, item);
    const nextChecked = checked ?? !task.checked;
    if (checked !== undefined && nextChecked === task.checked) {
      return { id: todo.id, item: task.item, checked: task.checked, body: todo.body };
    }
    lines[task.lineIndex].text = `${task.prefix}${nextChecked ? "x" : " "}${task.afterMark}${task.suffix}`;
    const body = joinBodyLines(lines);
    const updated = await this.update(id, { body });
    return { id: updated.id, item: task.item, checked: nextChecked, body: updated.body };
  }

  private resolveScope(sel: TodoSelector): ResolvedScope {
    if (!isValidName(sel.workspace)) {
      throw new TabNotFound("Invalid workspace name.");
    }
    if (sel.project !== undefined && !isValidName(sel.project)) {
      throw new TabNotFound("Invalid workspace/project name.");
    }

    const workspacePath = join(this.deps.workspacesDir, sel.workspace);
    if (!statSafe(workspacePath)?.isDirectory()) {
      throw new TabNotFound(`No workspace "${sel.workspace}".`);
    }
    if (sel.project === undefined) {
      return { scope: "workspace", refKey: sel.workspace };
    }

    const projectPath = join(workspacePath, sel.project);
    if (!statSafe(projectPath)?.isDirectory()) {
      throw new TabNotFound(`No project "${sel.project}" in "${sel.workspace}".`);
    }
    return { scope: "project", refKey: projectPath };
  }

  private resolveTask(tasks: TaskLine[], item: string | number): TaskLine {
    if (typeof item === "number") {
      if (!Number.isInteger(item) || item < 1 || item > tasks.length) {
        throw new ToolError(`No task item at index ${item}. Available items: ${availableItems(tasks)}.`);
      }
      return tasks[item - 1];
    }

    const needle = item.trim();
    if (!needle) {
      throw new ToolError(`Task item text is required. Available items: ${availableItems(tasks)}.`);
    }

    const matches = tasks.filter((task) => task.item.toLowerCase() === needle.toLowerCase());
    if (matches.length === 0) {
      throw new ToolError(`No task item matching "${item}". Available items: ${availableItems(tasks)}.`);
    }
    if (matches.length > 1) {
      throw new ToolError(`Task item "${item}" is ambiguous; use index. Available items: ${availableItems(tasks)}.`);
    }
    return matches[0];
  }
}
