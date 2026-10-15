/**
 * Task items of a todo list's markdown body ("- [ ] item" / "- [x] item" lines) and the ATOMIC
 * toggle route `POST /api/todos/:id/toggle` (`@orquester/api` `ToggleTodoItemRequest`). The
 * route reads the stored list, edits that one item's mark and hands the store the new body
 * without yielding between the read and the write — `TodoListManager.update` replaces the record
 * synchronously before it persists — so no other write can land in between and be lost.
 *
 * Pure parsing (no service is imported for values): the daemon's routes use it.
 */

import type { FastifyInstance } from "fastify";
import type { ToggleTodoItemRequest, ToggleTodoItemResponse } from "@orquester/api";
import { clipText, MAX_ECHO_CHARS } from "./mcp/result.ts";
import type { TodoListManager } from "./todos.ts";

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

/** A refusal of the caller's item (400 on the route): the message names the list's items. */
export class TodoItemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TodoItemError";
  }
}

/**
 * `body` with one task item checked or unchecked: by its 1-based index among the task items, or by
 * its exact text (trimmed, case-insensitive). `checked` omitted flips it; `changed: false` when the
 * item already had that state (the body is returned as it was). Every other byte is kept.
 */
export function toggleTaskItem(body: string, item: string | number, checked?: boolean): { item: string; checked: boolean; body: string; changed: boolean } {
  const lines = splitBodyLines(body);
  const tasks = taskLines(lines);
  if (tasks.length === 0) {
    throw new TodoItemError("No task items in todo.");
  }
  const task = resolveTask(tasks, item);
  const nextChecked = checked ?? !task.checked;
  if (nextChecked === task.checked) {
    return { item: task.item, checked: task.checked, body, changed: false };
  }
  lines[task.lineIndex].text = `${task.prefix}${nextChecked ? "x" : " "}${task.afterMark}${task.suffix}`;
  return { item: task.item, checked: nextChecked, body: lines.map((line) => `${line.text}${line.newline}`).join(""), changed: true };
}

function resolveTask(tasks: TaskLine[], item: string | number): TaskLine {
  if (typeof item === "number") {
    if (!Number.isInteger(item) || item < 1 || item > tasks.length) {
      throw new TodoItemError(`No task item at index ${item}. Available items: ${availableItems(tasks)}.`);
    }
    return tasks[item - 1];
  }

  const needle = item.trim();
  if (!needle) {
    throw new TodoItemError(`Task item text is required. Available items: ${availableItems(tasks)}.`);
  }

  // Lowercased ONCE: the caller's text can be megabytes, and lowercasing it per item blocked the event loop for
  // seconds on a long list.
  const wanted = needle.toLowerCase();
  const matches = tasks.filter((task) => task.item.toLowerCase() === wanted);
  if (matches.length === 0) {
    throw new TodoItemError(`No task item matching ${quoted(item)}. Available items: ${availableItems(tasks)}.`);
  }
  if (matches.length > 1) {
    throw new TodoItemError(`Task item ${quoted(item)} is ambiguous; use index. Available items: ${availableItems(tasks)}.`);
  }
  return matches[0];
}

/** `POST /api/todos/:id/toggle` (both transports, like the other todo routes). */
export function registerTodoToggleRoute(app: FastifyInstance, todos: Pick<TodoListManager, "get" | "update">): void {
  app.post<{ Params: { id: string }; Body: ToggleTodoItemRequest }>("/api/todos/:id/toggle", async (request, reply) => {
    const body = (request.body ?? {}) as Partial<ToggleTodoItemRequest>;
    const item = body.item;
    const validItem = (typeof item === "string") || (typeof item === "number" && Number.isInteger(item) && item >= 1);
    if (!validItem || (body.checked !== undefined && typeof body.checked !== "boolean")) {
      return reply.code(400).send({ code: "TODO_ERROR", message: "item (a 1-based index or the item's text) is required; checked must be a boolean." });
    }
    const todo = todos.get(request.params.id);
    if (!todo) return reply.code(404).send({ code: "TODO_ERROR", message: "todo not found" });
    let toggled: ReturnType<typeof toggleTaskItem>;
    try {
      toggled = toggleTaskItem(todo.body, item as string | number, body.checked);
    } catch (error) {
      if (error instanceof TodoItemError) return reply.code(400).send({ code: "TODO_ERROR", message: error.message });
      throw error;
    }
    // No await between the read above and this call: update() replaces the record before it yields.
    const record = toggled.changed ? await todos.update(todo.id, { body: toggled.body }) : todo;
    const answer: ToggleTodoItemResponse = { id: record.id, item: toggled.item, checked: toggled.checked, body: record.body };
    return reply.send(answer);
  });
}
