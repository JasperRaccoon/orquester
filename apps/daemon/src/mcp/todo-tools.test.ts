import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { TodoError, TodoListManager } from "../todos.ts";
import { TodoTools } from "./todo-tools.ts";
import { ToolError } from "./errors.ts";
import { MAX_ERROR_MESSAGE_CHARS } from "./result.ts";

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

test("invalid names and missing directories reject as PROJECT_NOT_FOUND before creating todos", async () => {
  const { root, todos, tools } = await makeTools();
  await mkdir(join(root, "escape"), { recursive: true });
  const projectNotFound = (err: unknown) => err instanceof ToolError && err.code === "PROJECT_NOT_FOUND";

  await assert.rejects(() => tools.create({ workspace: "../w" }, "bad"), projectNotFound);
  await assert.rejects(() => tools.create({ workspace: "w", project: "../escape" }, "bad"), projectNotFound);
  await assert.rejects(() => tools.create({ workspace: "missing" }, "bad"), projectNotFound);
  await assert.rejects(() => tools.create({ workspace: "w", project: "missing" }, "bad"), projectNotFound);
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

  // A list that does not exist is the store's 404, for result.ts to map (NOT_FOUND) — named: the id and where the ids are.
  const missing = (err: unknown) => err instanceof TodoError && err.status === 404 && err.message === 'No todo list with id "missing"; list_todos shows the ids.';
  await assert.rejects(() => tools.toggleItem("missing", 1), missing);
  await assert.rejects(() => tools.update("missing", { name: "x" }), missing);
  await assert.rejects(() => tools.remove("missing"), missing);
});

test("a missing list's id is echoed capped and escaped: one short line whatever the caller sent", async () => {
  const { tools } = await makeTools();
  const cases: [string, RegExp][] = [
    ["x".repeat(500), /^No todo list with id "x{99}…"; list_todos shows the ids\.$/],
    ["a\nb\"c", /^No todo list with id "a\\nb\\"c"; list_todos shows the ids\.$/]
  ];
  for (const [id, expected] of cases) {
    await assert.rejects(() => tools.remove(id), (err) => err instanceof TodoError && err.status === 404 && expected.test(err.message));
  }
  // Any other store refusal passes through untouched.
  const conflict = new TodoError(409, "todo changed meanwhile");
  const refusing = new TodoTools({ todos: { update: async () => { throw conflict; }, delete: async () => { throw conflict; } } as never, workspacesDir: "/w" });
  await assert.rejects(() => refusing.update("t1", { body: "" }), (err) => err === conflict);
  await assert.rejects(() => refusing.remove("t1"), (err) => err === conflict);
});

test("a refusal quotes the caller's item capped and escaped, and a long list's items bounded, never the whole list", async () => {
  const { tools } = await makeTools();
  const todo = await tools.create({ workspace: "w" }, "Tasks");
  await tools.update(todo.id, { body: "- [ ] Alpha\n- [ ] Beta" });
  const refusal = async (item: string | number, id = todo.id): Promise<string> => {
    const err = await tools.toggleItem(id, item).then(() => assert.fail("toggleItem resolved"), (e: unknown) => e);
    assert.ok(err instanceof ToolError && err.code === "INVALID_ARGUMENT", String(err));
    return err.message;
  };
  // An unknown item: its text quoted, at most 100 code points, escaped onto one line; the items still listed.
  const junk = await refusal(`${"q".repeat(2 * 1024 * 1024)}"\n`);
  assert.match(junk, /^No task item matching "q{99}…"\. Available items: 1\. Alpha, 2\. Beta\.$/);
  assert.equal(await refusal('say "hi"\nnow'), 'No task item matching "say \\"hi\\"\\nnow". Available items: 1. Alpha, 2. Beta.');
  // An ambiguous item — two items with the same long text: the quote and each listed item are capped.
  const long = "L".repeat(5_000);
  const twins = await tools.create({ workspace: "w" }, "Twins");
  await tools.update(twins.id, { body: `- [ ] ${long}\n- [ ] ${long}` });
  const ambiguous = await refusal(long, twins.id);
  assert.match(ambiguous, /^Task item "L{99}…" is ambiguous; use index\. Available items: 1\. L{79}…, 2\. L{79}…\.$/);
  // A 3 000-item list: the first 40 items listed, then how many there are.
  const big = await tools.create({ workspace: "w" }, "Big");
  await tools.update(big.id, { body: Array.from({ length: 3_000 }, (_, i) => `- [ ] task ${i + 1}`).join("\n") });
  const outOfRange = await refusal(5_000, big.id);
  assert.ok(outOfRange.startsWith("No task item at index 5000. Available items: 1. task 1, 2. task 2, "), outOfRange.slice(0, 120));
  assert.ok(outOfRange.endsWith("40. task 40, … (3000 items)."), outOfRange.slice(-60));
  assert.ok(outOfRange.length < 1_000, `${outOfRange.length} characters`);
  // The longest refusal there can be — the quote at its cap, 40 listed items at theirs — still ends whole under the
  // error cap (result.ts), so that backstop never cuts its tail.
  const wide = await tools.create({ workspace: "w" }, "Wide");
  await tools.update(wide.id, { body: Array.from({ length: 3_000 }, (_, i) => `- [ ] ${i} ${"w".repeat(300)}`).join("\n") });
  const longest = await refusal("y".repeat(10_000), wide.id);
  assert.ok(longest.endsWith(", … (3000 items)."), longest.slice(-40));
  assert.ok([...longest].length <= MAX_ERROR_MESSAGE_CHARS, `${[...longest].length} code points`);
});
