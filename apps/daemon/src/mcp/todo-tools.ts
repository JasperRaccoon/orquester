import { statSync } from "node:fs";
import { join } from "node:path";
import type { TodoScope } from "@orquester/api";
import { isValidName, type TodoRecord } from "@orquester/config";
import { TodoError, type TodoListManager } from "../todos.ts";
import { ToolError } from "./errors.ts";
import { clipText, MAX_ECHO_CHARS } from "./result.ts";

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

/**
 * How many of a list's items a refusal names, and the most of each: the list's own text, of any length and count. 70,
 * not more: beside a quote escaped at its longest (602 characters), the longest refusal — the ambiguous one, 40 items at
 * 70 — is 3 701 characters for a 3 000-item list, so MAX_ERROR_MESSAGE_CHARS (result.ts) never cuts its tail, whatever
 * the input. At 80 it was 4 101.
 */
const MAX_LISTED_ITEMS = 40;
const MAX_LISTED_ITEM_CHARS = 70;

function availableItems(tasks: TaskLine[]): string {
  const listed = tasks.slice(0, MAX_LISTED_ITEMS).map((task) => `${task.index}. ${clipText(task.item, MAX_LISTED_ITEM_CHARS)}`).join(", ");
  return tasks.length > MAX_LISTED_ITEMS ? `${listed}, … (${tasks.length} items)` : listed;
}

/**
 * A caller's value — a list id, an item's text — as a refusal quotes it: capped, quoted and escaped onto one line. The
 * cap is in code points and comes BEFORE the escaping, so a control character or a lone surrogate costs six characters:
 * a quote is at most 602.
 */
const quoted = (text: string): string => JSON.stringify(clipText(text, MAX_ECHO_CHARS));

/**
 * The store's 404 for a list it does not have ("todo not found"), said where the id is known: the id, quoted, and
 * where the ids are.
 */
function missingList(id: string): TodoError {
  return new TodoError(404, `No todo list with id ${quoted(id)}; list_todos shows the ids.`);
}

/** A store refusal, the 404 for this id named; anything else untouched. */
const namingMissing = (id: string) => (error: unknown): never => {
  throw error instanceof TodoError && error.status === 404 ? missingList(id) : error;
};

/**
 * The todo tools' access to the daemon's todo store. A store refusal is a TodoError and is let through: result.ts maps
 * its status to the code it deserves (404 NOT_FOUND, 409 CONFLICT, else INVALID_ARGUMENT) with its (safe) message — a
 * missing list is not a bad argument. The 404 alone is reworded, to name the id it could not find.
 */
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
    return projectTodo(await this.deps.todos.update(id, patch).catch(namingMissing(id)));
  }

  async remove(id: string): Promise<{ deleted: true }> {
    await this.deps.todos.delete(id).catch(namingMissing(id));
    return { deleted: true };
  }

  async toggleItem(
    id: string,
    item: string | number,
    checked?: boolean
  ): Promise<TodoToggleResult> {
    const todo = this.deps.todos.get(id);
    if (!todo) {
      // The store's refusal for a list it does not have, as update and delete answer.
      throw missingList(id);
    }

    const lines = splitBodyLines(todo.body);
    const tasks = taskLines(lines);
    if (tasks.length === 0) {
      throw new ToolError("INVALID_ARGUMENT", "No task items in todo.");
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
      throw new ToolError("PROJECT_NOT_FOUND", "Invalid workspace name.");
    }
    if (sel.project !== undefined && !isValidName(sel.project)) {
      throw new ToolError("PROJECT_NOT_FOUND", "Invalid workspace/project name.");
    }

    const workspacePath = join(this.deps.workspacesDir, sel.workspace);
    if (!statSafe(workspacePath)?.isDirectory()) {
      throw new ToolError("PROJECT_NOT_FOUND", `No workspace "${sel.workspace}".`);
    }
    if (sel.project === undefined) {
      return { scope: "workspace", refKey: sel.workspace };
    }

    const projectPath = join(workspacePath, sel.project);
    if (!statSafe(projectPath)?.isDirectory()) {
      throw new ToolError("PROJECT_NOT_FOUND", `No project "${sel.project}" in "${sel.workspace}".`);
    }
    return { scope: "project", refKey: projectPath };
  }

  private resolveTask(tasks: TaskLine[], item: string | number): TaskLine {
    if (typeof item === "number") {
      if (!Number.isInteger(item) || item < 1 || item > tasks.length) {
        throw new ToolError("INVALID_ARGUMENT", `No task item at index ${item}. Available items: ${availableItems(tasks)}.`);
      }
      return tasks[item - 1];
    }

    const needle = item.trim();
    if (!needle) {
      throw new ToolError("INVALID_ARGUMENT", `Task item text is required. Available items: ${availableItems(tasks)}.`);
    }

    // Lowercased ONCE: the caller's text can be megabytes, and lowercasing it per item blocked the event loop for
    // seconds on a long list.
    const wanted = needle.toLowerCase();
    const matches = tasks.filter((task) => task.item.toLowerCase() === wanted);
    if (matches.length === 0) {
      throw new ToolError("INVALID_ARGUMENT", `No task item matching ${quoted(item)}. Available items: ${availableItems(tasks)}.`);
    }
    if (matches.length > 1) {
      throw new ToolError("INVALID_ARGUMENT", `Task item ${quoted(item)} is ambiguous; use index. Available items: ${availableItems(tasks)}.`);
    }
    return matches[0];
  }
}
