import { z } from "zod";
import { resolveProject } from "../addressing.ts";
import { ToolError } from "../errors.ts";
import type { TodoSelector } from "../todo-tools.ts";
import { closedWorld, defineTool, DESTRUCTIVE, MUTATING, MUTATING_IDEMPOTENT, READ_ONLY, type ToolContext, type ToolDef } from "../tool.ts";

const scopeFields = {
  workspace: z.string().optional().describe("Workspace name, for that workspace's own lists. Pass this or `project`."),
  project: z.string().optional().describe("Absolute project path or \"<workspace>/<project>\", for that project's lists. Pass this or `workspace`.")
};
const idField = z.string().min(1).describe("The todo list id from list_todos or create_todo.");

/** Spec §7.9: exactly one of `workspace` / `project`, the project resolved like every other tool's. */
async function scope(ctx: ToolContext, args: { workspace?: string; project?: string }): Promise<TodoSelector> {
  if (Boolean(args.workspace) === Boolean(args.project)) throw new ToolError("INVALID_ARGUMENT", "Pass exactly one of workspace or project.");
  if (!args.project) return { workspace: args.workspace! };
  const ref = await resolveProject(ctx.api, args.project);
  // resolveProject only returns a `<workspace>/<project>` directory; the guard narrows the types.
  if (!ref.workspace || !ref.name) throw new ToolError("PROJECT_NOT_FOUND", "Todo lists need a project inside a workspace.");
  return { workspace: ref.workspace, project: ref.name };
}

const listTodos = defineTool({
  name: "list_todos",
  title: "List todo lists",
  description: "The shared todo lists of a workspace or of one project, oldest first, each with its markdown body. The human sees and edits the same lists live in the Todo tab.",
  input: scopeFields,
  annotations: READ_ONLY,
  async run(args, ctx) {
    return { todos: ctx.todos.list(await scope(ctx, args)) };
  }
});

const createTodo = defineTool({
  name: "create_todo",
  title: "Create a todo list",
  description: "Create a shared todo list in a workspace or a project. Its body starts empty: fill it with update_todo ('- [ ] item' lines).",
  input: { ...scopeFields, name: z.string().min(1).describe("List name.") },
  annotations: closedWorld(MUTATING),
  async run(args, ctx) {
    return { todo: await ctx.todos.create(await scope(ctx, args), args.name) };
  }
});

const updateTodo = defineTool({
  name: "update_todo",
  title: "Update a todo list",
  description: "Rename a todo list and/or replace its whole markdown body ('- [ ] item' / '- [x] item' lines). To tick one item use toggle_todo_item, which cannot clobber an edit made meanwhile.",
  input: { id: idField, name: z.string().min(1).optional().describe("New list name."), body: z.string().optional().describe("The new markdown body, replacing the old one whole.") },
  annotations: closedWorld(MUTATING_IDEMPOTENT),
  async run(args, ctx) {
    return { todo: await ctx.todos.update(args.id, { name: args.name, body: args.body }) };
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
  description: "Check or uncheck one item of a todo list, atomically, by its 1-based index among the list's items or by its exact text. Omit `checked` to flip it.",
  input: {
    id: idField,
    item: z.union([z.string(), z.number().int().min(1)]).describe("The item's exact text, or its 1-based index among the list's items."),
    checked: z.boolean().optional().describe("The state to set; omit to flip the item.")
  },
  // Omitting `checked` flips the item: a repeated identical call is not a no-op, so this is not idempotent.
  annotations: closedWorld(MUTATING),
  async run(args, ctx) {
    return { ...(await ctx.todos.toggleItem(args.id, args.item, args.checked)) };
  }
});

export const todoTools: ToolDef[] = [listTodos, createTodo, updateTodo, deleteTodo, toggleTodoItem] as ToolDef[];
