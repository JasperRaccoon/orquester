import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TodoListManager } from "../../todos.ts";
import { ToolError } from "../errors.ts";
import { FakeDaemonApi } from "../testing.ts";
import { TodoTools } from "../todo-tools.ts";
import { DESTRUCTIVE, MUTATING, MUTATING_IDEMPOTENT, READ_ONLY, type ToolContext } from "../tool.ts";
import { todoTools } from "./todos.ts";

const tool = (name: string) => todoTools.find((t) => t.name === name)!;
const code = (expected: string) => (err: unknown) => err instanceof ToolError && err.code === expected;

/** A sandbox holding workspace `acme` with project `api`, and a real TodoListManager behind TodoTools. */
async function harness(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "mcp-todo-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspacesDir = join(root, "workspaces");
  await mkdir(join(workspacesDir, "acme", "api", "src"), { recursive: true });
  const manager = new TodoListManager(join(root, "todos.json"), { warn() {} });
  const api = new FakeDaemonApi();
  api.fsRoot = workspacesDir;
  api.workspacesDir = workspacesDir;
  const ctx: ToolContext = { api, todos: new TodoTools({ todos: manager, workspacesDir }), files: {} as never, signal: new AbortController().signal, now: () => Date.parse("2026-09-22T12:00:00.000Z") };
  return { root, workspacesDir, manager, ctx };
}

test("the five todo tools, in order, with the spec's annotations (a flip is not idempotent)", () => {
  assert.deepEqual(todoTools.map((t) => t.name), ["list_todos", "create_todo", "update_todo", "delete_todo", "toggle_todo_item"]);
  // The todo store is the daemon's own: no open world behind any of them.
  assert.deepEqual(todoTools.map((t) => t.annotations), [READ_ONLY, MUTATING, MUTATING_IDEMPOTENT, DESTRUCTIVE, MUTATING].map((a) => ({ ...a, openWorldHint: false })));
  for (const t of todoTools) assert.ok(t.title && t.description.length <= 400, t.name);
});

test("a workspace list is keyed by the workspace name; list_todos wraps the lists in an object", async (t) => {
  const { manager, ctx } = await harness(t);
  const created = await tool("create_todo").run({ workspace: "acme", name: "Release" }, ctx);
  const todo = created.todo as { id: string; name: string; scope: string; body: string };
  assert.equal(todo.name, "Release"); assert.equal(todo.scope, "workspace"); assert.equal(todo.body, "");
  assert.deepEqual(manager.list("workspace", "acme").map((r) => r.id), [todo.id]);
  assert.deepEqual(await tool("list_todos").run({ workspace: "acme" }, ctx), { todos: [created.todo] });
});

test("a project list is keyed by the project path, whichever spelling of the project is given", async (t) => {
  const { workspacesDir, manager, ctx } = await harness(t);
  const projectPath = join(workspacesDir, "acme", "api");
  const byName = (await tool("create_todo").run({ project: "acme/api", name: "Bugs" }, ctx)).todo as { id: string; scope: string };
  const byPath = (await tool("create_todo").run({ project: `${projectPath}/`, name: "Ideas" }, ctx)).todo as { id: string };
  assert.equal(byName.scope, "project");
  assert.deepEqual(manager.list("project", projectPath).map((r) => r.id), [byName.id, byPath.id]);
  const listed = (await tool("list_todos").run({ project: projectPath }, ctx)).todos as { id: string }[];
  assert.deepEqual(listed.map((r) => r.id), [byName.id, byPath.id]);
  assert.deepEqual((await tool("list_todos").run({ workspace: "acme" }, ctx)).todos, [], "a workspace list is a different scope");
});

test("exactly one of workspace or project, and the project must resolve inside the sandbox", async (t) => {
  const { root, manager, ctx } = await harness(t);
  await mkdir(join(root, "outside"), { recursive: true });
  await assert.rejects(tool("list_todos").run({}, ctx), code("INVALID_ARGUMENT"));
  await assert.rejects(tool("create_todo").run({ workspace: "acme", project: "acme/api", name: "x" }, ctx), code("INVALID_ARGUMENT"));
  await assert.rejects(tool("create_todo").run({ project: "acme/missing", name: "x" }, ctx), code("PROJECT_NOT_FOUND"));
  await assert.rejects(tool("create_todo").run({ project: "acme/api/src", name: "x" }, ctx), code("PROJECT_NOT_FOUND"), "a sub-directory is not a project");
  await assert.rejects(tool("create_todo").run({ project: join(root, "outside"), name: "x" }, ctx), code("PATH_NOT_ALLOWED"));
  await assert.rejects(tool("create_todo").run({ workspace: "missing", name: "x" }, ctx), code("PROJECT_NOT_FOUND"));
  assert.equal(manager.list("workspace", "acme").length + manager.list("workspace", "missing").length, 0, "nothing was created");
});

test("update_todo renames and replaces the body; toggle_todo_item ticks one item; delete_todo removes the list", async (t) => {
  const { manager, ctx } = await harness(t);
  const { id } = (await tool("create_todo").run({ workspace: "acme", name: "Old" }, ctx)).todo as { id: string };
  const updated = await tool("update_todo").run({ id, name: "New", body: "- [ ] build\n- [ ] ship" }, ctx);
  assert.equal((updated.todo as { name: string }).name, "New");
  assert.equal((updated.todo as { body: string }).body, "- [ ] build\n- [ ] ship");
  assert.deepEqual(await tool("toggle_todo_item").run({ id, item: 2 }, ctx), { id, item: "ship", checked: true, body: "- [ ] build\n- [x] ship" });
  assert.deepEqual(await tool("toggle_todo_item").run({ id, item: "build", checked: true }, ctx), { id, item: "build", checked: true, body: "- [x] build\n- [x] ship" });
  assert.deepEqual(await tool("delete_todo").run({ id }, ctx), { deleted: true, id });
  assert.equal(manager.get(id), undefined);
  await assert.rejects(tool("delete_todo").run({ id }, ctx), code("INVALID_ARGUMENT"));
  await assert.rejects(tool("update_todo").run({ id, name: "again" }, ctx), code("INVALID_ARGUMENT"));
  await assert.rejects(tool("toggle_todo_item").run({ id, item: 1 }, ctx), code("INVALID_ARGUMENT"));
});
