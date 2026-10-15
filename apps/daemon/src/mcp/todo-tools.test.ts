/**
 * The todo tools' `/api/todos` client (unified MCP design 2026-10-15 D-19): the daemon's real todo
 * routes (`createServer`, inject only — nothing listens) over a real TodoListManager, reached
 * through the in-process `InjectDaemonApi` exactly as the catalog tools reach them.
 */
import { createWriteStream } from "node:fs";
import { mkdir,mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createDefaultClientConfig, createDefaultDaemonConfig } from "@orquester/config";
import { createServer } from "../index.ts";
import { TodoListManager } from "../todos.ts";
import { InjectDaemonApi } from "./daemon-api.ts";
import { createTodoList, deleteTodoList, listTodoLists, toggleTodoItem, updateTodoList, type TodoSelector } from "./todo-tools.ts";
import { ToolError } from "./errors.ts";
import { toSafeToolError } from "./result.ts";
import { FakeDaemonApi } from "./testing.ts";

type CreateServerArgs = Parameters<typeof createServer>;

/** A sandbox `<root>/w/p`, the daemon's todo routes over a real store, and the in-process client. */
async function makeTools(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "todo-tools-"));
  await mkdir(join(root, "w", "p"), { recursive: true });
  const todos = new TodoListManager(join(root, "todos.json"), { warn() {} });
  const resolved = { daemonDir: join(root, "daemon"), workspacesDir: root, workspacesMetaFile: join(root, "workspaces.json"), fsRoot: root };
  const app = createServer(
    createDefaultDaemonConfig({ env: {} }),
    resolved as unknown as CreateServerArgs[1],
    createDefaultClientConfig(join(root, "daemon.sock")),
    createWriteStream("/dev/null"),
    { todos } as unknown as CreateServerArgs[4],
    { authRequired: false, mode: "local" }
  );
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const api = new InjectDaemonApi({ app, authorization: undefined, agentChat: null, broadcaster: { add() {}, remove() {} } as never, fsRoot: root, workspacesDir: root });
  const W: TodoSelector = { workspace: "w" };
  const tools = {
    create: (sel: TodoSelector, name: string) => createTodoList(api, sel, name),
    list: (sel: TodoSelector) => listTodoLists(api, sel),
    update: (id: string, patch: { name?: string; body?: string }, sel: TodoSelector = W) => updateTodoList(api, sel, id, patch),
    remove: (id: string, sel: TodoSelector = W) => deleteTodoList(api, sel, id),
    toggleItem: (id: string, item: string | number, checked?: boolean, sel: TodoSelector = W) => toggleTodoItem(api, sel, id, item, checked)
  };
  return { root, todos, tools, api };
}

test("workspace scope create/list stores by workspace name and omits refKey", async (t) => {
  const { todos, tools } = await makeTools(t);

  const created = await tools.create({ workspace: "w" }, "Workspace tasks");

  assert.equal(created.scope, "workspace");
  assert.equal(created.name, "Workspace tasks");
  assert.equal("refKey" in created, false);
  assert.deepEqual(todos.list("workspace", "w").map((t) => t.id), [created.id]);
  assert.deepEqual(await tools.list({ workspace: "w" }), [created]);
});

test("a project list is keyed by the project path, as the GUI keys it", async (t) => {
  const { root, todos, tools } = await makeTools(t);
  const created = await tools.create({ workspace: "w", project: "p" }, "Bugs");
  assert.equal(created.scope, "project");
  assert.deepEqual(todos.list("project", join(root, "w", "p")).map((r) => r.id), [created.id]);
  assert.deepEqual(await tools.list({ workspace: "w" }), [], "a workspace's own lists are another scope");
});

test("invalid names and missing directories reject as PROJECT_NOT_FOUND before creating todos", async (t) => {
  const { root, todos, tools } = await makeTools(t);
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

test("a write names the list's own scope: an id from another scope is NOT_FOUND and nothing changes", async (t) => {
  const { tools, todos } = await makeTools(t);
  const project = await tools.create({ workspace: "w", project: "p" }, "Project list");
  const notFound = (err: unknown) => err instanceof ToolError && err.code === "NOT_FOUND" && err.message.includes(project.id);
  await assert.rejects(() => tools.update(project.id, { name: "x" }), notFound);
  await assert.rejects(() => tools.remove(project.id), notFound);
  await assert.rejects(() => tools.toggleItem(project.id, 1), notFound);
  assert.equal(todos.get(project.id)?.name, "Project list");
  assert.deepEqual(await tools.remove(project.id, { workspace: "w", project: "p" }), { deleted: true });
  assert.equal(todos.get(project.id), undefined);
});

test("toggleItem by 1-based index flips and explicitly sets while preserving non-task lines", async (t) => {
  const { tools } = await makeTools(t);
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

test("toggleItem by text is exact after trim and case-insensitive", async (t) => {
  const { tools } = await makeTools(t);
  const todo = await tools.create({ workspace: "w" }, "Tasks");
  await tools.update(todo.id, { body: "- [ ]   Write Tests  \n- [ ] write docs" });

  const result = await tools.toggleItem(todo.id, "write tests", true);

  assert.equal(result.item, "Write Tests");
  assert.equal(result.checked, true);
  assert.equal(result.body, "- [x]   Write Tests  \n- [ ] write docs");
});

test("toggleItem explicit same-state set preserves the existing body", async (t) => {
  const { tools } = await makeTools(t);
  const todo = await tools.create({ workspace: "w" }, "Tasks");
  await tools.update(todo.id, { body: "- [X] Already done" });

  const result = await tools.toggleItem(todo.id, "already done", true);

  assert.equal(result.checked, true);
  assert.equal(result.body, "- [X] Already done");
});

test("toggleItem errors are safe and actionable", async (t) => {
  const { tools } = await makeTools(t);
  const empty = await tools.create({ workspace: "w" }, "Empty");
  await assert.rejects(() => tools.toggleItem(empty.id, 1), (err) => {
    assert.ok(err instanceof ToolError && err.code === "INVALID_ARGUMENT");
    return true;
  });

  const todo = await tools.create({ workspace: "w" }, "Tasks");
  await tools.update(todo.id, { body: "- [ ] Alpha\n- [X] Beta\n* [ ] beta" });

  await assert.rejects(() => tools.toggleItem(todo.id, "Gamma"), (err) => {
    assert.ok(err instanceof ToolError && err.code === "INVALID_ARGUMENT");
    assert.match(err.message, /Gamma/);
    assert.match(err.message, /Alpha/);
    assert.match(err.message, /Beta/);
    return true;
  });

  await assert.rejects(() => tools.toggleItem(todo.id, "beta"), (err) => {
    assert.ok(err instanceof ToolError && err.code === "INVALID_ARGUMENT");
    assert.match(err.message, /Beta/);
    assert.match(err.message, /beta/);
    return true;
  });

  // A list that does not exist is NOT_FOUND — named: the id and where the ids are.
  const missing = (err: unknown) => err instanceof ToolError && err.code === "NOT_FOUND" && err.message.includes("missing") && /list_todos/.test(err.message);
  await assert.rejects(() => tools.toggleItem("missing", 1), missing);
  await assert.rejects(() => tools.update("missing", { name: "x" }), missing);
  await assert.rejects(() => tools.remove("missing"), missing);
});

test("a missing list's id is echoed capped and escaped: one short line whatever the caller sent", async (t) => {
  const { tools } = await makeTools(t);
  const cases: [string, RegExp][] = [
    ["x".repeat(500), /"x{99}…"/],
    ["a\nb\"c", /"a\\nb\\"c"/]
  ];
  for (const [id, expected] of cases) {
    await assert.rejects(() => tools.remove(id), (err) => err instanceof ToolError && err.code === "NOT_FOUND" && expected.test(err.message) && !err.message.includes("\n") && err.message.length < 200);
  }
});

test("the routes' other refusals map as the store's always did: 409 CONFLICT, 4xx INVALID_ARGUMENT, a 5xx never echoed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "todo-tools-fake-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "w"), { recursive: true });
  const api = new FakeDaemonApi();
  api.fsRoot = api.workspacesDir = root;
  const listed = { id: "t1", name: "L", scope: "workspace", refKey: "w", body: "- [ ] a", createdAt: "2026-10-15T00:00:00.000Z", updatedAt: "2026-10-15T00:00:00.000Z" };
  api.on("GET", "/api/todos", { status: 200, body: [listed] });
  api.on("PUT", "/api/todos/t1", { status: 409, body: { code: "TODO_ERROR", message: "todo changed meanwhile" } });
  await assert.rejects(() => updateTodoList(api, { workspace: "w" }, "t1", { body: "" }), (err) => err instanceof ToolError && err.code === "CONFLICT" && err.message === "todo changed meanwhile");
  api.on("PUT", "/api/todos/t1", { status: 400, body: { code: "TODO_ERROR", message: "name too long" } });
  await assert.rejects(() => toggleTodoItem(api, { workspace: "w" }, "t1", 1), (err) => err instanceof ToolError && err.code === "INVALID_ARGUMENT" && err.message === "name too long");
  api.on("DELETE", "/api/todos/t1", { status: 500, body: { code: "TODO_ERROR", message: "EACCES /secret/host/path" } });
  await assert.rejects(() => deleteTodoList(api, { workspace: "w" }, "t1"), (err) => err instanceof ToolError && err.code === "INTERNAL" && !err.message.includes("/secret"));
  assert.deepEqual(api.calls[0], { method: "GET", path: "/api/todos", query: { scope: "workspace", refKey: "w" } });
});

test("a refusal quotes the caller's item capped and escaped, and a long list's items bounded, never the whole list", async (t) => {
  const { tools } = await makeTools(t);
  const todo = await tools.create({ workspace: "w" }, "Tasks");
  await tools.update(todo.id, { body: "- [ ] Alpha\n- [ ] Beta" });
  const refusal = async (item: string | number, id = todo.id): Promise<string> => {
    const err = await tools.toggleItem(id, item).then(() => assert.fail("toggleItem resolved"), (e: unknown) => e);
    assert.ok(err instanceof ToolError && err.code === "INVALID_ARGUMENT", String(err));
    return err.message;
  };
  // An unknown item: its text quoted, at most 100 code points, escaped onto one line; the items still listed.
  const junk = await refusal(`${"q".repeat(2 * 1024 * 1024)}"\n`);
  assert.match(junk, /"q{99}…"/);
  assert.match(junk, /1\. Alpha, 2\. Beta/);
  const escaped = await refusal('say "hi"\nnow');
  assert.ok(escaped.includes('say \\"hi\\"\\nnow') && !escaped.includes("\n"));
  // An ambiguous item — two items with the same long text: the quote and each listed item are capped.
  const long = "L".repeat(5_000);
  const twins = await tools.create({ workspace: "w" }, "Twins");
  await tools.update(twins.id, { body: `- [ ] ${long}\n- [ ] ${long}` });
  const ambiguous = await refusal(long, twins.id);
  assert.match(ambiguous, /"L{99}…"/);
  assert.match(ambiguous, /1\. L{69}…, 2\. L{69}…/);
  // A 3 000-item list: the first 40 items listed, then how many there are.
  const big = await tools.create({ workspace: "w" }, "Big");
  await tools.update(big.id, { body: Array.from({ length: 3_000 }, (_, i) => `- [ ] task ${i + 1}`).join("\n") });
  const outOfRange = await refusal(5_000, big.id);
  assert.match(outOfRange, /5000/);
  assert.match(outOfRange, /1\. task 1, 2\. task 2/);
  assert.match(outOfRange, /40\. task 40/);
  assert.match(outOfRange, /3000 items/);
  assert.ok(!outOfRange.includes("41. task 41"));
  assert.ok(outOfRange.length < 1_000, `${outOfRange.length} characters`);
});

test("the longest refusal there can be ends whole under the error cap, whatever the input: the quote escaped at its longest, 40 items at their cap", async (t) => {
  const { tools } = await makeTools(t);
  const refusal = async (id: string, item: string): Promise<string> => {
    const err = await tools.toggleItem(id, item).then(() => assert.fail("toggleItem resolved"), (e: unknown) => e);
    assert.ok(err instanceof ToolError && err.code === "INVALID_ARGUMENT", String(err));
    return err.message;
  };
  // quoted() clips to 100 code points and THEN escapes: a control character or a lone surrogate is six characters, so a
  // quote takes up to 602. The ambiguous template is the longest one; two items share the control-character text.
  const control = "\u0001".repeat(100);
  const lines = Array.from({ length: 3_000 }, (_, i) => `- [ ] ${i} ${"w".repeat(300)}`);
  lines[0] = `- [ ] ${control}`;
  lines[1] = `- [ ] ${control}`;
  const wide = await tools.create({ workspace: "w" }, "Wide");
  await tools.update(wide.id, { body: lines.join("\n") });
  const ambiguous = await refusal(wide.id, control);
  assert.ok(ambiguous.includes(`"${"\\u0001".repeat(100)}"`));
  const lone = await refusal(wide.id, "\ud800".repeat(100));
  assert.ok(lone.includes(`"${"\\ud800".repeat(100)}"`));
  for (const message of [ambiguous, lone]) {
    assert.match(message, /3000 items/);
    assert.ok([...message].length <= 4_000, `${[...message].length} code points`);
    // So the backstop (result.ts) never cuts its tail: toSafeToolError hands it on untouched.
    assert.equal(toSafeToolError(new ToolError("INVALID_ARGUMENT", message)).structuredContent.message, message);
  }
});
