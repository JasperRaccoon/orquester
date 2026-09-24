import { z } from "zod";
import { resolveProject } from "../addressing.ts";
import { ToolError } from "../errors.ts";
import { clipText, fitJsonBytes, MAX_RESULT_BYTES, resultBytes } from "../result.ts";
import type { TodoProjection, TodoSelector } from "../todo-tools.ts";
import { closedWorld, defineTool, DESTRUCTIVE, MUTATING, MUTATING_IDEMPOTENT, READ_ONLY, type ToolContext, type ToolDef } from "../tool.ts";

// min(1), and `!== undefined` in scope(): an empty field is a field given, never read as omitted — beside the other one
// it would put the list in the other scope.
const scopeFields = {
  workspace: z.string().min(1).optional().describe("Workspace name, for that workspace's own lists. Pass this or `project`."),
  project: z.string().min(1).optional().describe("Absolute project path or \"<workspace>/<project>\", for that project's lists. Pass this or `workspace`.")
};
const idField = z.string().min(1).describe("The todo list id from list_todos or create_todo.");

/** Spec §7.9: exactly one of `workspace` / `project`, the project resolved like every other tool's. */
async function scope(ctx: ToolContext, args: { workspace?: string; project?: string }): Promise<TodoSelector> {
  if ((args.workspace !== undefined) === (args.project !== undefined)) throw new ToolError("INVALID_ARGUMENT", "Pass exactly one of workspace or project.");
  if (args.project === undefined) return { workspace: args.workspace! };
  const ref = await resolveProject(ctx.api, args.project);
  // resolveProject only returns a `<workspace>/<project>` directory; the guard narrows the types.
  if (!ref.workspace || !ref.name) throw new ToolError("PROJECT_NOT_FOUND", "Todo lists need a project inside a workspace.");
  return { workspace: ref.workspace, project: ref.name };
}

/** A listed todo list: `bodyTruncated` marks one whose body is only its head — written back whole, it would lose the rest. */
type ListedTodo = TodoProjection & { bodyTruncated?: true };

/** The most of a list's name, or of a toggled item, a result keeps when even an empty body leaves it over one result. */
const LAST_RESORT_TEXT_CHARS = 200;
const clipName = <T extends { name: string }>(v: T): T => ({ ...v, name: clipText(v.name, LAST_RESORT_TEXT_CHARS) });
const clipItem = <T extends { item: string }>(v: T): T => ({ ...v, item: clipText(v.item, LAST_RESORT_TEXT_CHARS) });

/**
 * `value` — one list's `body` and the fields around it — within one result, as `wrap` places it there: whole when it
 * fits; else its body cut to the head that fits, marked `bodyTruncated: true`, and everything else whole. Only a text
 * of tens of KB that leaves no room even for an empty body (a list's name, a toggled item) is cut too, by `spare`. The
 * result always fits, so ok() never has to cut it: a SUCCESSFUL write must never read as a failed one — a client that
 * retried a flip on that would undo it.
 */
function fitBody<T extends { body: string }>(value: T, wrap: (v: T) => unknown, spare: (v: T) => T): T | (T & { bodyTruncated: true }) {
  if (resultBytes(wrap(value)) <= MAX_RESULT_BYTES) return value;
  const fits = (v: T): boolean => resultBytes(wrap(v)) <= MAX_RESULT_BYTES;
  const base = fits({ ...value, body: "", bodyTruncated: true }) ? value : spare(value);
  if (fits(base)) return base; // only the huge text was in the way: the body stays whole, and unmarked
  const cut: T & { bodyTruncated: true } = { ...base, body: "", bodyTruncated: true };
  // What the body's escaped text may take: the cap less everything else, its empty quotes and the mark included.
  cut.body = fitJsonBytes(base.body, MAX_RESULT_BYTES - resultBytes(wrap(cut))).text;
  return cut;
}

/** list_todos' result with `omitted` of the lists left out. */
const listResult = (todos: ListedTodo[], omitted: number) => ({ todos, truncated: true as const, ...(omitted > 0 ? { omittedLists: omitted } : {}) });

/**
 * Lists that fit one result (ok() would otherwise cut the JSON and lose them all): the newest ones, the oldest left out
 * first, still oldest first — `truncated` when anything was left out or cut, `omittedLists` counting the lists left
 * out. A body is never cut silently: update_todo replaces a whole body, so an agent that edits a cut one and writes it
 * back deletes its tail. Only a newest list too big for a result on its own is cut (`fitBody`) — to the head of its
 * body, marked `bodyTruncated`.
 */
function fitTodos(todos: TodoProjection[]): { todos: ListedTodo[]; truncated?: true; omittedLists?: number } {
  if (resultBytes({ todos }) <= MAX_RESULT_BYTES) return { todos };
  // Everything but the lists, as returned with `omitted` of them left out.
  const frame = (omitted: number): number => resultBytes(listResult([], omitted));
  const kept: ListedTodo[] = [];
  let used = 0;
  for (let i = todos.length - 1; i >= 0; i -= 1) {
    const cost = resultBytes(todos[i]) + (kept.length ? 1 : 0); // the separating comma
    // One more list costs far more than `omittedLists` can shrink by, so the first list that does not fit ends it.
    if (frame(i) + used + cost > MAX_RESULT_BYTES) break;
    used += cost;
    kept.unshift(todos[i]!);
  }
  if (!kept.length) kept.push(fitBody(todos[todos.length - 1]!, (t) => listResult([t], todos.length - 1), clipName));
  return listResult(kept, todos.length - kept.length);
}

const listTodos = defineTool({
  name: "list_todos",
  title: "List todo lists",
  description: "The shared todo lists of a workspace or of one project, oldest first, each with its markdown body. When they do not all fit one result the oldest are left out (truncated:true, omittedLists counts them). A newest list too big on its own keeps the head of its body: a list marked bodyTruncated is incomplete — never write it back whole. The human sees and edits the same lists live in the Todo tab.",
  input: scopeFields,
  annotations: READ_ONLY,
  async run(args, ctx) {
    return fitTodos(ctx.todos.list(await scope(ctx, args)));
  }
});

const createTodo = defineTool({
  name: "create_todo",
  title: "Create a todo list",
  description: "Create a shared todo list in a workspace or a project. Its body starts empty: fill it with update_todo ('- [ ] item' lines).",
  input: { ...scopeFields, name: z.string().min(1).describe("List name.") },
  annotations: closedWorld(MUTATING),
  async run(args, ctx) {
    return { todo: fitBody(await ctx.todos.create(await scope(ctx, args), args.name), (todo) => ({ todo }), clipName) };
  }
});

const updateTodo = defineTool({
  name: "update_todo",
  title: "Update a todo list",
  description: "Rename a todo list and/or replace its whole markdown body ('- [ ] item' / '- [x] item' lines). To tick one item use toggle_todo_item, which cannot clobber an edit made meanwhile. On a list too big for one result, the result's body is only its head (bodyTruncated:true); the write itself is whole.",
  input: {
    id: idField,
    name: z.string().min(1).optional().describe("New list name."),
    body: z.string().optional().describe("The new markdown body, replacing the old one whole. Never send a body marked bodyTruncated — list_todos, and this tool's and toggle_todo_item's results, mark a body cut to fit: it is only the list's head, and the rest would be lost. Tick items with toggle_todo_item (it edits the full stored body), rename with `name` alone (the body is kept), or put new items in a new list.")
  },
  annotations: closedWorld(MUTATING_IDEMPOTENT),
  async run(args, ctx) {
    return { todo: fitBody(await ctx.todos.update(args.id, { name: args.name, body: args.body }), (todo) => ({ todo }), clipName) };
  }
});

const deleteTodo = defineTool({
  name: "delete_todo",
  title: "Delete a todo list",
  description: "Delete a todo list and its body.",
  input: { id: idField },
  annotations: closedWorld(DESTRUCTIVE),
  async run(args, ctx) {
    await ctx.todos.remove(args.id);
    return { deleted: true, id: args.id };
  }
});

const toggleTodoItem = defineTool({
  name: "toggle_todo_item",
  title: "Toggle a todo item",
  description: "Check or uncheck one item of a todo list, atomically, by its 1-based index among the list's items or by its exact text. Omit `checked` to flip it; pass it to make a retry harmless. On a list too big for one result, the result's body is only its head (bodyTruncated:true); the toggle itself is whole.",
  input: {
    id: idField,
    item: z.union([z.string(), z.number().int().min(1)]).describe("The item's exact text, or its 1-based index among the list's items."),
    checked: z.boolean().optional().describe("The state to set; omit to flip the item.")
  },
  // Omitting `checked` flips the item: a repeated identical call is not a no-op, so this is not idempotent.
  annotations: closedWorld(MUTATING),
  async run(args, ctx) {
    return { ...fitBody(await ctx.todos.toggleItem(args.id, args.item, args.checked), (result) => result, clipItem) };
  }
});

export const todoTools: ToolDef[] = [listTodos, createTodo, updateTodo, deleteTodo, toggleTodoItem] as ToolDef[];
