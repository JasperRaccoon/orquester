import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { TodoListManager } from "../todos.ts";
import { TodoTools } from "./todo-tools.ts";
import { TabNotFound, ToolError } from "./terminal-control.ts";

async function makeTools() {
  const root = await mkdtemp(join(tmpdir(), "todo-tools-"));
  await mkdir(join(root, "w", "p"), { recursive: true });
  const todos = new TodoListManager(join(root, "todos.json"), { warn() {} });
  return { root, todos, tools: new TodoTools({ todos, workspacesDir: root }) };
}

test("workspace scope create/list stores by workspace name and omits refKey", async () => {
  const { todos, tools } = await makeTools();

  const created = await tools.create({ workspace: "w" }, "Workspace tasks");

  assert.equal(created.scope, "workspace");
  assert.equal(created.name, "Workspace tasks");
  assert.equal("refKey" in created, false);
  assert.deepEqual(todos.list("workspace", "w").map((t) => t.id), [created.id]);
  assert.deepEqual(tools.list({ workspace: "w" }), [created]);
});

test("project scope create/list stores by joined project path and omits refKey", async () => {
  const { root, todos, tools } = await makeTools();

  const created = await tools.create({ workspace: "w", project: "p" }, "Project tasks");

  assert.equal(created.scope, "project");
  assert.equal("refKey" in created, false);
  assert.deepEqual(todos.list("project", join(root, "w", "p")).map((t) => t.id), [created.id]);
  assert.deepEqual(tools.list({ workspace: "w", project: "p" }), [created]);
});

test("invalid names and missing directories reject as TabNotFound before creating todos", async () => {
  const { root, todos, tools } = await makeTools();
  await mkdir(join(root, "escape"), { recursive: true });

  await assert.rejects(() => tools.create({ workspace: "../w" }, "bad"), TabNotFound);
  await assert.rejects(() => tools.create({ workspace: "w", project: "../escape" }, "bad"), TabNotFound);
  await assert.rejects(() => tools.create({ workspace: "missing" }, "bad"), TabNotFound);
  await assert.rejects(() => tools.create({ workspace: "w", project: "missing" }, "bad"), TabNotFound);
  assert.equal(todos.list("workspace", "w").length, 0);
  assert.equal(todos.list("project", join(root, "w", "p")).length, 0);
  assert.equal(todos.list("project", join(root, "escape")).length, 0);
});

test("update renames and replaces body; remove deletes", async () => {
  const { tools } = await makeTools();
  const created = await tools.create({ workspace: "w" }, "Old");

  const updated = await tools.update(created.id, { name: "New", body: "- [ ] one" });
  assert.equal(updated.name, "New");
  assert.equal(updated.body, "- [ ] one");

  assert.deepEqual(await tools.remove(created.id), { deleted: true });
  assert.deepEqual(tools.list({ workspace: "w" }), []);
});

test("toggleItem by 1-based index flips and explicitly sets while preserving non-task lines", async () => {
  const { tools } = await makeTools();
  const todo = await tools.create({ workspace: "w" }, "Tasks");
  await tools.update(todo.id, {
    body: ["Intro", "- [ ] first task", "middle", "* [x] second task"].join("\n")
  });

  const flipped = await tools.toggleItem(todo.id, 1);
  assert.equal(flipped.item, "first task");
  assert.equal(flipped.checked, true);
  assert.equal(flipped.body, ["Intro", "- [x] first task", "middle", "* [x] second task"].join("\n"));

  const setFalse = await tools.toggleItem(todo.id, 2, false);
  assert.equal(setFalse.item, "second task");
  assert.equal(setFalse.checked, false);
  assert.equal(setFalse.body, ["Intro", "- [x] first task", "middle", "* [ ] second task"].join("\n"));
});

test("toggleItem by text is exact after trim and case-insensitive", async () => {
  const { tools } = await makeTools();
  const todo = await tools.create({ workspace: "w" }, "Tasks");
  await tools.update(todo.id, { body: "- [ ]   Write Tests  \n- [ ] write docs" });

  const result = await tools.toggleItem(todo.id, "write tests", true);

  assert.equal(result.item, "Write Tests");
  assert.equal(result.checked, true);
  assert.equal(result.body, "- [x]   Write Tests  \n- [ ] write docs");
});

test("toggleItem explicit same-state set preserves the existing body", async () => {
  const { tools } = await makeTools();
  const todo = await tools.create({ workspace: "w" }, "Tasks");
  await tools.update(todo.id, { body: "- [X] Already done" });

  const result = await tools.toggleItem(todo.id, "already done", true);

  assert.equal(result.checked, true);
  assert.equal(result.body, "- [X] Already done");
});

test("toggleItem errors are safe and actionable", async () => {
  const { tools } = await makeTools();
  const empty = await tools.create({ workspace: "w" }, "Empty");
  await assert.rejects(() => tools.toggleItem(empty.id, 1), (err) => {
    assert.ok(err instanceof ToolError);
    assert.match(err.message, /No task items/i);
    return true;
  });

  const todo = await tools.create({ workspace: "w" }, "Tasks");
  await tools.update(todo.id, { body: "- [ ] Alpha\n- [X] Beta\n* [ ] beta" });

  await assert.rejects(() => tools.toggleItem(todo.id, "Gamma"), (err) => {
    assert.ok(err instanceof ToolError);
    assert.match(err.message, /No task item matching "Gamma"/);
    assert.match(err.message, /Alpha/);
    assert.match(err.message, /Beta/);
    return true;
  });

  await assert.rejects(() => tools.toggleItem(todo.id, "beta"), (err) => {
    assert.ok(err instanceof ToolError);
    assert.match(err.message, /ambiguous/i);
    assert.match(err.message, /use index/i);
    return true;
  });

  await assert.rejects(() => tools.toggleItem("missing", 1), ToolError);
});
