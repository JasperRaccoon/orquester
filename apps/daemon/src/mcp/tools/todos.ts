// Catalog family module `todos` (Notes: list_todos, update_todos) — unified MCP design 2026-10-15
// §4 rows 22–23, plan Task 12. Both audiences; Read / Act in the `notes` toolset. Every read and
// write goes through `/api/todos` (`../todo-tools.ts`, D-19).
//
// Scope: a project's lists claim that project (the gate's matrix, §5.2). A workspace's own lists
// belong to no project: in the caller's own workspace they are the caller's; in another workspace
// a write claims that workspace as a pending target (a card, never a grant) and a read below Full
// access is refused — the claim has no workspace-level read target (reported to the coordinator).

import { basename, join } from "node:path";
import { z } from "zod";
import { resolveProject } from "../addressing.ts";
import { ToolError } from "../errors.ts";
import { clipText, fitJsonBytes, MAX_RESULT_BYTES, resultBytes } from "../result.ts";
import {
  createTodoList,
  deleteTodoList,
  listTodoLists,
  todoListRef,
  toggleTodoItem,
  updateTodoList,
  type TodoProjection,
  type TodoSelector
} from "../todo-tools.ts";
import { closedWorld, defineTool, READ_ONLY, type AnyOrquesterTool, type ScopeClaim, type ScopeContext } from "../catalog/contract.ts";

// min(1), and `!== undefined` below: an empty field is a field given, never read as omitted — beside the other one
// it would put the list in the other scope.
const scopeFields = {
  workspace: z.string().min(1).optional().describe("Workspace name, for that workspace's own lists. Pass this or `project`."),
  project: z.string().min(1).optional().describe("Absolute project path or \"<workspace>/<project>\", for that project's lists.")
};

const CHAT_DEFAULT_NOTE = "Without workspace or project: this chat's project.";

/**
 * Exactly one of `workspace` / `project`, the project resolved like every other tool's. A chat
 * caller naming neither means its own project (§5.1).
 */
async function selectorOf(args: { workspace?: string; project?: string }, ctx: ScopeContext): Promise<TodoSelector> {
  const given = (args.workspace !== undefined ? 1 : 0) + (args.project !== undefined ? 1 : 0);
  if (given === 0 && ctx.caller.kind === "thread" && ctx.caller.projectPath && ctx.caller.workspace) {
    return { workspace: ctx.caller.workspace, project: basename(ctx.caller.projectPath) };
  }
  if (given !== 1) throw new ToolError("INVALID_ARGUMENT", "Pass exactly one of workspace or project.");
  if (args.project === undefined) return { workspace: args.workspace! };
  const ref = await resolveProject(ctx.api, args.project);
  // resolveProject only returns a `<workspace>/<project>` directory; the guard narrows the types.
  if (!ref.workspace || !ref.name) throw new ToolError("PROJECT_NOT_FOUND", "Todo lists need a project inside a workspace.");
  return { workspace: ref.workspace, project: ref.name };
}

/** What a call on `sel`'s lists claims (see the module notes). */
async function claimFor(sel: TodoSelector, ctx: ScopeContext, access: "read" | "act"): Promise<ScopeClaim> {
  await todoListRef(ctx.api, sel); // PROJECT_NOT_FOUND before anything is judged
  const claim: ScopeClaim = { projects: [], sessions: [], reads: access === "read" ? "metadata" : "none", writes: access === "act", causesTurnIn: [] };
  if (sel.project !== undefined) return { ...claim, projects: [join(ctx.api.workspacesDir, sel.workspace, sel.project)] };
  const caller = ctx.caller;
  if (caller.kind !== "thread" || caller.workspace === sel.workspace) return claim;
  if (access === "act") return { ...claim, pendingProjects: [{ workspace: sel.workspace }] };
  if (caller.runtimeMode !== "full-access") {
    throw new ToolError(
      "PERMISSION_DENIED",
      `Workspace "${clipText(sel.workspace, 100)}" is not this chat's: reading its own lists needs Full access. Read a project's lists there (project), or ask the user.`
    );
  }
  return claim;
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
 * out. A body is never cut silently: an update replaces a whole body, so an agent that edits a cut one and writes it
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
  description:
    "The shared todo lists of a workspace or of one project, oldest first, each with its id and markdown body. When they do not all fit one result the oldest are left out (truncated:true, omittedLists counts them). A newest list too big on its own keeps the head of its body: a list marked bodyTruncated is incomplete — never write it back whole. The user sees and edits the same lists live in the Todo tab.",
  chatNote: CHAT_DEFAULT_NOTE,
  input: scopeFields,
  audiences: ["external", "chat"],
  toolset: "notes",
  tier: "read",
  scope: async (args, ctx) => claimFor(await selectorOf(args, ctx), ctx, "read"),
  annotations: READ_ONLY,
  resultKind: "json",
  async run(args, ctx) {
    return fitTodos(await listTodoLists(ctx.api, await selectorOf(args, ctx)));
  }
});

const UPDATE_ACTIONS = ["create", "update", "toggle", "delete"] as const;
type UpdateAction = (typeof UPDATE_ACTIONS)[number];

const updateInput = {
  action: z.enum(UPDATE_ACTIONS),
  ...scopeFields,
  id: z.string().min(1).optional().describe("The list's id (list_todos), for update, toggle and delete."),
  name: z.string().min(1).optional().describe("create: the new list's name. update: its new name."),
  body: z
    .string()
    .optional()
    .describe("update: the whole new markdown body ('- [ ] item' lines), replacing the old one. Never a body marked bodyTruncated."),
  item: z.union([z.string(), z.number().int().min(1)]).optional().describe("toggle: the item's 1-based index among the list's items, or its exact text."),
  checked: z.boolean().optional().describe("toggle: the state to set; omit to flip the item.")
};
type UpdateArgs = z.infer<z.ZodObject<typeof updateInput>>;

/** The fields each action takes (required, then allowed) — anything else given is refused, never ignored. */
const ACTION_FIELDS: Readonly<Record<UpdateAction, { required: readonly (keyof UpdateArgs)[]; allowed: readonly (keyof UpdateArgs)[] }>> = {
  create: { required: ["name"], allowed: [] },
  update: { required: ["id"], allowed: ["name", "body"] },
  toggle: { required: ["id", "item"], allowed: ["checked"] },
  delete: { required: ["id"], allowed: [] }
};

function checkAction(args: UpdateArgs): void {
  const fields = ACTION_FIELDS[args.action];
  for (const key of fields.required) {
    if (args[key] === undefined) throw new ToolError("INVALID_ARGUMENT", `update_todos ${args.action} needs ${key}.`);
  }
  for (const key of ["id", "name", "body", "item", "checked"] as const) {
    if (args[key] !== undefined && !fields.required.includes(key) && !fields.allowed.includes(key)) {
      throw new ToolError("INVALID_ARGUMENT", `update_todos ${args.action} takes no ${key}.`);
    }
  }
  if (args.action === "update" && args.name === undefined && args.body === undefined) {
    throw new ToolError("INVALID_ARGUMENT", "update_todos update needs name, body or both.");
  }
}

const updateTodos = defineTool({
  name: "update_todos",
  title: "Change todo lists",
  description:
    "Change the shared todo lists of a workspace or a project; the user sees them live in the Todo tab. action create: a new empty list named `name`. update: rename it (`name`) and/or replace its whole markdown body (`body`). toggle: check or uncheck one `item` in the stored body (atomic, keeps edits made meanwhile) — prefer it to rewriting the body. delete: remove the list. update, toggle and delete name the list by `id` with its workspace or project. On a list too big for one result, the result's body is only its head (bodyTruncated:true); the write itself is whole.",
  chatNote: CHAT_DEFAULT_NOTE,
  input: updateInput,
  audiences: ["external", "chat"],
  toolset: "notes",
  tier: "act",
  async scope(args, ctx) {
    checkAction(args);
    return claimFor(await selectorOf(args, ctx), ctx, "act");
  },
  // The most dangerous action is delete; a toggle without `checked` flips, so a retry is not a no-op.
  annotations: closedWorld({ readOnlyHint: false, destructiveHint: true, idempotentHint: false }),
  resultKind: "json",
  async run(args, ctx) {
    checkAction(args);
    const sel = await selectorOf(args, ctx);
    switch (args.action) {
      case "create":
        return { todo: fitBody(await createTodoList(ctx.api, sel, args.name!), (todo) => ({ todo }), clipName) };
      case "update":
        return { todo: fitBody(await updateTodoList(ctx.api, sel, args.id!, { name: args.name, body: args.body }), (todo) => ({ todo }), clipName) };
      case "toggle":
        return { ...fitBody(await toggleTodoItem(ctx.api, sel, args.id!, args.item!, args.checked), (result) => result, clipItem) };
      case "delete":
        await deleteTodoList(ctx.api, sel, args.id!);
        return { deleted: true, id: args.id! };
    }
  }
});

/** This family in the catalog (`../catalog/index.ts`). */
export const todosFamily: readonly AnyOrquesterTool[] = [listTodos, updateTodos];
