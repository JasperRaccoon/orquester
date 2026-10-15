/**
 * The todo tools' access to the shared todo lists (unified MCP design 2026-10-15 D-19): every read
 * and write goes through the daemon's own `/api/todos` routes over `DaemonApi`, so the lists an
 * agent changes are the GUI's by construction (the `todos` bus channel included). Pure: no daemon
 * service is imported (the agent host loads the catalog statically).
 *
 * A list is addressed by its scope — a workspace (by name) or a project — and its id; a write first
 * finds the id among that scope's lists, so the scope a tool claims to the gate is the list's own.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { CreateTodoRequest, TodoListRecord, TodoScope, UpdateTodoRequest } from "@orquester/api";
import { isValidName } from "@orquester/config";
import type { DaemonApi, DaemonResponse } from "./daemon-api.ts";
import { ToolError } from "./errors.ts";
import { clipText, MAX_ECHO_CHARS } from "./result.ts";
import type { TodoListManager } from "../todos.ts";

export type TodoProjection = {
  id: string;
  name: string;
  scope: "workspace" | "project";
  body: string;
  createdAt: string;
  updatedAt: string;
};

export type TodoSelector = { workspace: string; project?: string };

type TodoToggleResult = { id: string; item: string; checked: boolean; body: string };

/** Where a list lives on the wire: `scope` + `refKey` (the workspace name, or the project path). */
export type TodoListRef = {
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
  afterMark: string;
  suffix: string;
  item: string;
  checked: boolean;
};

const TASK_LINE = /^(\s*[-*]\s+\[)( |x|X)(\]\s*)(.*)$/;

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function projectTodo(record: TodoListRecord): TodoProjection {
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

/** The 404 for a list a scope does not have, said where the id is known: the id, quoted, and where the ids are. */
function missingList(id: string): ToolError {
  return new ToolError("NOT_FOUND", `No todo list with id ${quoted(id)} there; list_todos shows the ids.`);
}

/**
 * A failed `/api/todos` request as a ToolError. The routes answer `{code: "TODO_ERROR", message}` with
 * the store's status: 404 is the list named by `id` (reworded to name it), 409 CONFLICT, any other
 * 4xx INVALID_ARGUMENT with the store's (safe) text — the codes the in-process store's refusals
 * always mapped to. A 5xx is never echoed (`daemonError`).
 */
function todoError(res: DaemonResponse, id?: string): ToolError {
  if (res.status === 404 && id !== undefined) return missingList(id);
  if (res.status >= 500) return new ToolError("INTERNAL", "The daemon failed handling the todo request.");
  const body = res.body !== null && typeof res.body === "object" ? (res.body as { message?: unknown }) : {};
  const message = typeof body.message === "string" && body.message.trim() !== "" ? body.message : `The daemon answered ${res.status}.`;
  return new ToolError(res.status === 404 ? "NOT_FOUND" : res.status === 409 ? "CONFLICT" : "INVALID_ARGUMENT", message);
}

/**
 * The wire address of a selector's lists: a workspace by name, or a project by its path — the key
 * the GUI uses. Both must exist under the workspaces root (`PROJECT_NOT_FOUND` otherwise).
 */
export async function todoListRef(api: Pick<DaemonApi, "workspacesDir">, sel: TodoSelector): Promise<TodoListRef> {
  if (!isValidName(sel.workspace)) {
    throw new ToolError("PROJECT_NOT_FOUND", "Invalid workspace name.");
  }
  if (sel.project !== undefined && !isValidName(sel.project)) {
    throw new ToolError("PROJECT_NOT_FOUND", "Invalid workspace/project name.");
  }
  const workspacePath = join(api.workspacesDir, sel.workspace);
  if (!(await isDirectory(workspacePath))) {
    throw new ToolError("PROJECT_NOT_FOUND", `No workspace "${sel.workspace}".`);
  }
  if (sel.project === undefined) {
    return { scope: "workspace", refKey: sel.workspace };
  }
  const projectPath = join(workspacePath, sel.project);
  if (!(await isDirectory(projectPath))) {
    throw new ToolError("PROJECT_NOT_FOUND", `No project "${sel.project}" in "${sel.workspace}".`);
  }
  return { scope: "project", refKey: projectPath };
}

async function listRecords(api: DaemonApi, ref: TodoListRef): Promise<TodoListRecord[]> {
  const res = await api.request("GET", "/api/todos", { query: { scope: ref.scope, refKey: ref.refKey } });
  if (res.status >= 400) throw todoError(res);
  return Array.isArray(res.body) ? (res.body as TodoListRecord[]) : [];
}

/** The list `id` among the selector's lists (`NOT_FOUND` when that scope has none by that id). */
async function findRecord(api: DaemonApi, sel: TodoSelector, id: string): Promise<TodoListRecord> {
  const record = (await listRecords(api, await todoListRef(api, sel))).find((todo) => todo.id === id);
  if (!record) throw missingList(id);
  return record;
}

async function putRecord(api: DaemonApi, id: string, patch: UpdateTodoRequest): Promise<TodoListRecord> {
  const res = await api.request("PUT", `/api/todos/${encodeURIComponent(id)}`, { body: patch });
  if (res.status >= 400) throw todoError(res, id);
  return res.body as TodoListRecord;
}

/** The selector's lists, oldest first (the store's order). */
export async function listTodoLists(api: DaemonApi, sel: TodoSelector): Promise<TodoProjection[]> {
  return (await listRecords(api, await todoListRef(api, sel))).map(projectTodo);
}

export async function createTodoList(api: DaemonApi, sel: TodoSelector, name: string): Promise<TodoProjection> {
  const ref = await todoListRef(api, sel);
  const body: CreateTodoRequest = { scope: ref.scope, refKey: ref.refKey, name };
  const res = await api.request("POST", "/api/todos", { body });
  if (res.status >= 400) throw todoError(res);
  return projectTodo(res.body as TodoListRecord);
}

/** Rename and/or replace the whole body of the selector's list `id`. */
export async function updateTodoList(api: DaemonApi, sel: TodoSelector, id: string, patch: { name?: string; body?: string }): Promise<TodoProjection> {
  await findRecord(api, sel, id);
  const body: UpdateTodoRequest = {};
  if (patch.name !== undefined) body.name = patch.name;
  if (patch.body !== undefined) body.body = patch.body;
  return projectTodo(await putRecord(api, id, body));
}

export async function deleteTodoList(api: DaemonApi, sel: TodoSelector, id: string): Promise<{ deleted: true }> {
  await findRecord(api, sel, id);
  const res = await api.request("DELETE", `/api/todos/${encodeURIComponent(id)}`);
  if (res.status >= 400) throw todoError(res, id);
  return { deleted: true };
}

/**
 * Check or uncheck one item of the selector's list `id`, by its 1-based index among the list's
 * items or by its exact text (trimmed, case-insensitive). It edits the STORED body as read just
 * before the write — never a copy the agent holds — and only that item's mark. An explicit
 * `checked` equal to the item's state writes nothing.
 */
export async function toggleTodoItem(
  api: DaemonApi,
  sel: TodoSelector,
  id: string,
  item: string | number,
  checked?: boolean
): Promise<TodoToggleResult> {
  const todo = await findRecord(api, sel, id);
  const lines = splitBodyLines(todo.body);
  const tasks = taskLines(lines);
  if (tasks.length === 0) {
    throw new ToolError("INVALID_ARGUMENT", "No task items in todo.");
  }
  const task = resolveTask(tasks, item);
  const nextChecked = checked ?? !task.checked;
  if (checked !== undefined && nextChecked === task.checked) {
    return { id: todo.id, item: task.item, checked: task.checked, body: todo.body };
  }
  lines[task.lineIndex].text = `${task.prefix}${nextChecked ? "x" : " "}${task.afterMark}${task.suffix}`;
  const body = lines.map((line) => `${line.text}${line.newline}`).join("");
  const updated = await putRecord(api, id, { body });
  return { id: updated.id, item: task.item, checked: nextChecked, body: updated.body };
}

function resolveTask(tasks: TaskLine[], item: string | number): TaskLine {
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

/**
 * TEMPORARY (deleted with `catalog/legacy.ts` in Task 14): `LegacyToolServices.todos` and the
 * pre-catalog `ToolContext.todos` still name this, and the daemon still builds one; no tool reads
 * it any more — the todo tools go through `/api/todos` (the functions above).
 */
export class TodoTools {
  constructor(readonly deps: { todos: TodoListManager; workspacesDir: string }) {}
}
