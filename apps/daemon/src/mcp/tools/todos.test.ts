import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { TodoListManager } from "../../todos.ts";
import { ToolError } from "../errors.ts";
import { MAX_RESULT_BYTES, ok, toSafeToolError } from "../result.ts";
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

test("an empty workspace or project is refused, never read as omitted: the list never lands in the other scope", async (t) => {
  const { workspacesDir, manager, ctx } = await harness(t);
  for (const name of ["list_todos", "create_todo"]) {
    for (const field of ["workspace", "project"]) {
      const parsed = z.object(tool(name).input).safeParse({ [field]: "", name: "x" });
      assert.equal(parsed.success, false, `${name}: the schema refuses an empty ${field}`);
    }
  }
  // Past the schema too: one empty field beside a real one is two fields given, not one.
  await assert.rejects(tool("create_todo").run({ workspace: "acme", project: "", name: "x" }, ctx), code("INVALID_ARGUMENT"));
  await assert.rejects(tool("create_todo").run({ workspace: "", project: "acme/api", name: "x" }, ctx), code("INVALID_ARGUMENT"));
  await assert.rejects(tool("list_todos").run({ project: "" }, ctx), code("PROJECT_NOT_FOUND"));
  await assert.rejects(tool("list_todos").run({ workspace: "" }, ctx), code("PROJECT_NOT_FOUND"));
  assert.equal(manager.list("workspace", "acme").length + manager.list("project", join(workspacesDir, "acme", "api")).length, 0, "nothing was created");
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
});

/** A tool call as buildServer answers it: the result, or the coded error a throw maps to. */
async function answer(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<{ code?: string; message?: string }> {
  try { await tool(name).run(args, ctx); return {}; } catch (error) { return toSafeToolError(error).structuredContent; }
}

test("the five todo tools answer with the code the failure deserves: a missing list is NOT_FOUND, not a bad argument, and names the id", async (t) => {
  const { ctx } = await harness(t);
  for (const [name, args] of [["update_todo", { id: "nope", name: "x" }], ["delete_todo", { id: "nope" }], ["toggle_todo_item", { id: "nope", item: 1 }]] as const) {
    assert.deepEqual(await answer(name, args, ctx), { code: "NOT_FOUND", message: 'No todo list with id "nope"; list_todos shows the ids.' }, name);
  }
  // The id is the caller's text, of any length: it is echoed capped, so a junk id never makes a huge error.
  const junk = "z".repeat(2 * 1024 * 1024);
  for (const [name, args] of [["update_todo", { id: junk, body: "" }], ["delete_todo", { id: junk }], ["toggle_todo_item", { id: junk, item: 1 }]] as const) {
    const { code, message } = await answer(name, args, ctx);
    assert.equal(code, "NOT_FOUND", name);
    assert.match(message!, /^No todo list with id "z+…"; list_todos shows the ids\.$/, name);
    assert.ok(message!.length <= 160, `${name}: ${message!.length} characters`);
  }
  assert.equal((await answer("list_todos", { workspace: "missing" }, ctx)).code, "PROJECT_NOT_FOUND");
  assert.equal((await answer("create_todo", { workspace: "missing", name: "x" }, ctx)).code, "PROJECT_NOT_FOUND");
  // A list that exists but holds no such item is still the caller's argument.
  const { id } = (await tool("create_todo").run({ workspace: "acme", name: "L" }, ctx)).todo as { id: string };
  await tool("update_todo").run({ id, body: "- [ ] one" }, ctx);
  assert.equal((await answer("toggle_todo_item", { id, item: 2 }, ctx)).code, "INVALID_ARGUMENT");
});

const resultSize = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
type Listed = { id: string; name: string; body: string; bodyTruncated?: true };

test("list_todos keeps one result: the oldest lists are left out first, and the result says so and how many", async (t) => {
  const { manager, ctx } = await harness(t);
  for (let i = 0; i < 12; i += 1) {
    const { id } = (await tool("create_todo").run({ workspace: "acme", name: `List ${i}` }, ctx)).todo as { id: string };
    await tool("update_todo").run({ id, body: `- [ ] ${"x".repeat(6_000)}` }, ctx);
  }
  const stored = manager.list("workspace", "acme"); // oldest first, as list_todos lists them
  const r = await tool("list_todos").run({ workspace: "acme" }, ctx);
  const todos = r.todos as Listed[];
  const kept = todos.map((x) => x.id);
  assert.equal(r.truncated, true);
  assert.ok(kept.length > 0 && kept.length < stored.length, `${kept.length} kept`);
  assert.deepEqual(kept, stored.slice(stored.length - kept.length).map((s) => s.id), "the newest lists, still oldest first");
  assert.equal(r.omittedLists, stored.length - kept.length, "how many lists were left out");
  // Every list that is listed is listed whole: an agent may edit one and write it back.
  assert.deepEqual(todos.map((x) => [x.body, "bodyTruncated" in x]), stored.slice(stored.length - kept.length).map((s) => [s.body, false]));
  const bytes = resultSize(r);
  assert.ok(bytes <= MAX_RESULT_BYTES, `${bytes} bytes`);
  assert.equal(ok(r).structuredContent, r, "bounded by the tool itself: ok() passes it through");
  // As many as fit: the next-oldest list would not have.
  const nextOldest = stored[stored.length - kept.length - 1]!;
  const withOneMore = { todos: [{ ...nextOldest, refKey: undefined }, ...todos], truncated: true, omittedLists: stored.length - kept.length - 1 };
  assert.ok(resultSize(withOneMore) > MAX_RESULT_BYTES, "one more list would not have fitted");
  // A small set is whole, and says nothing about truncation.
  const small = await tool("list_todos").run({ project: "acme/api" }, ctx);
  assert.deepEqual(small, { todos: [] });
});

test("list_todos: a newest list too big for a result on its own keeps its name and the head of its body, marked bodyTruncated", async (t) => {
  const { ctx } = await harness(t);
  const { id } = (await tool("create_todo").run({ workspace: "acme", name: "Huge" }, ctx)).todo as { id: string };
  const body = `- [ ] ${"y".repeat(70_000)}`;
  await tool("update_todo").run({ id, body }, ctx);
  const r = await tool("list_todos").run({ workspace: "acme" }, ctx);
  const [only] = r.todos as Listed[];
  assert.equal(r.truncated, true);
  assert.equal(only!.id, id); assert.equal(only!.name, "Huge");
  assert.ok(body.startsWith(only!.body) && only!.body.length > 50_000, `kept ${only!.body.length} characters`);
  assert.equal(only!.bodyTruncated, true, "the cut body says so: written back whole, it would delete the tail");
  assert.equal("omittedLists" in r, false, "no list was left out");
  assert.ok(resultSize(r) <= MAX_RESULT_BYTES);
});

test("list_todos: beside older lists, a newest list too big on its own is still the one kept, cut and marked, and the rest are counted out", async (t) => {
  const { manager, ctx } = await harness(t);
  for (let i = 0; i < 4; i += 1) {
    const { id } = (await tool("create_todo").run({ workspace: "acme", name: `List ${i}` }, ctx)).todo as { id: string };
    await tool("update_todo").run({ id, body: `- [ ] item ${i}` }, ctx);
  }
  // The store's own order says which list is the newest (two lists can share a createdAt millisecond).
  const { id } = manager.list("workspace", "acme").at(-1)!;
  const body = Array.from({ length: 5_000 }, (_, i) => `- [ ] task ${i}: 項目 "quoted"`).join("\n"); // ~150 KB, escapes and CJK included
  await tool("update_todo").run({ id, body }, ctx);
  const r = await tool("list_todos").run({ workspace: "acme" }, ctx);
  const todos = r.todos as Listed[];
  assert.deepEqual(todos.map((x) => x.id), [id]);
  assert.deepEqual([r.truncated, r.omittedLists, todos[0]!.bodyTruncated], [true, 3, true]);
  assert.ok(body.startsWith(todos[0]!.body), "the head of the body, never a mangled middle");
  const size = resultSize(r);
  assert.ok(size <= MAX_RESULT_BYTES && size > MAX_RESULT_BYTES - 16, `${size} bytes: within the cap, and filled to it`);
});

test("list_todos' description warns that a bodyTruncated list is incomplete", () => {
  const description = tool("list_todos").description;
  assert.ok(description.includes("a list marked bodyTruncated is incomplete — never write it back whole"), description);
  assert.match(description, /omittedLists/);
});

/** A 3 000-item list, CJK, quotes and backslashes included: about 140 KB of JSON body, over twice one result. */
async function bigList(ctx: ToolContext): Promise<{ id: string; body: string }> {
  const { id } = (await tool("create_todo").run({ workspace: "acme", name: "Backlog" }, ctx)).todo as { id: string };
  const body = Array.from({ length: 3_000 }, (_, i) => `- [ ] task ${i + 1}: 項目 "quoted" \\ ${"x".repeat(10)}`).join("\n");
  await tool("update_todo").run({ id, body }, ctx);
  return { id, body };
}

test("toggle_todo_item on a 3 000-item list: the toggle is whole, and its result is one result — visibly a success, the body's head marked bodyTruncated", async (t) => {
  const { manager, ctx } = await harness(t);
  const { id, body } = await bigList(ctx);
  // Item 2 lies inside the head one result can carry, so the returned body can — and must — show the new state.
  const checked = body.replace("- [ ] task 2:", "- [x] task 2:");
  const r = await tool("toggle_todo_item").run({ id, item: 2 }, ctx);
  assert.deepEqual([r.id, r.item, r.checked, r.bodyTruncated], [id, `task 2: 項目 "quoted" \\ ${"x".repeat(10)}`, true, true], "the id, the item and its new state, whole");
  const size = resultSize(r);
  assert.ok(size <= MAX_RESULT_BYTES && size > MAX_RESULT_BYTES - 16, `${size} bytes: within one result, filled to it`);
  assert.equal(ok(r).structuredContent, r, "ok() passes it through: never the truncation note");
  const head = r.body as string;
  assert.ok(head.includes("- [x] task 2:"), "the returned head shows the item ticked");
  assert.ok(checked.startsWith(head), "the head of the new body");
  assert.ok(!body.startsWith(head), "not the head of the old one");
  assert.equal(manager.get(id)!.body, checked, "the write itself is whole: item 2 ticked, the other 2 999 as they were");
  // Flipping it again is visibly a success too: the head shows the item unticked, and the list is restored exactly.
  const back = await tool("toggle_todo_item").run({ id, item: 2 }, ctx);
  assert.deepEqual([back.checked, back.bodyTruncated, ok(back).structuredContent === back], [false, true, true]);
  assert.ok(body.startsWith(back.body as string) && !checked.startsWith(back.body as string), "the head of the restored body");
  assert.equal(manager.get(id)!.body, body);
  // Item 2 999 lies past the returned head: the result cannot show it, so the STORED body is what proves the toggle whole.
  const far = body.replace("- [ ] task 2999:", "- [x] task 2999:");
  const past = await tool("toggle_todo_item").run({ id, item: 2_999 }, ctx);
  assert.deepEqual([past.item, past.checked, past.bodyTruncated], [`task 2999: 項目 "quoted" \\ ${"x".repeat(10)}`, true, true]);
  assert.ok(!(past.body as string).includes("task 2999:"), "the item lies past the returned head");
  assert.equal(manager.get(id)!.body, far, "the stored body: item 2 999 ticked, every other item as it was");
  await tool("toggle_todo_item").run({ id, item: 2_999 }, ctx);
  assert.equal(manager.get(id)!.body, body, "flipped back, the list is exactly as it started");
  // A retry with the state already set writes nothing — the store emits no update and updatedAt stays — and still
  // answers with the item, its state and the body's head.
  const updatedAt = manager.get(id)!.updatedAt;
  let updates = 0;
  const onUpdated = () => { updates += 1; };
  manager.lifecycle.on("updated", onUpdated);
  t.after(() => { manager.lifecycle.off("updated", onUpdated); });
  const same = await tool("toggle_todo_item").run({ id, item: 2, checked: false }, ctx);
  assert.equal(updates, 0, "nothing was written");
  assert.equal(manager.get(id)!.updatedAt, updatedAt, "updatedAt unchanged");
  assert.deepEqual([same.checked, same.bodyTruncated, resultSize(same) <= MAX_RESULT_BYTES], [false, true, true]);
  assert.ok(body.startsWith(same.body as string), "the head of the unchanged body");
  // The listener does see a write: the retry's silence above is real.
  await tool("toggle_todo_item").run({ id, item: 2, checked: true }, ctx);
  assert.equal(updates, 1);
});

test("update_todo on a 3 000-item list: a rename keeps the whole body, a rewrite stores it whole, and each result is one result marked bodyTruncated", async (t) => {
  const { manager, ctx } = await harness(t);
  const { id, body } = await bigList(ctx);
  const renamed = await tool("update_todo").run({ id, name: "Renamed" }, ctx);
  const todo = renamed.todo as Listed;
  assert.deepEqual([todo.id, todo.name, todo.bodyTruncated], [id, "Renamed", true], "the id and the new name, whole");
  const size = resultSize(renamed);
  assert.ok(size <= MAX_RESULT_BYTES && size > MAX_RESULT_BYTES - 16, `${size} bytes: within one result, filled to it`);
  assert.equal(ok(renamed).structuredContent, renamed, "ok() passes it through: never the truncation note");
  assert.ok(body.startsWith(todo.body), "the head of the body");
  assert.equal(manager.get(id)!.body, body, "a rename never touches the body");
  // Writing the whole body again: stored whole, answered bounded.
  const rewritten = await tool("update_todo").run({ id, body: `${body}\n- [ ] one more` }, ctx);
  assert.equal((rewritten.todo as Listed).bodyTruncated, true);
  assert.ok(resultSize(rewritten) <= MAX_RESULT_BYTES && ok(rewritten).structuredContent === rewritten, "one result");
  assert.equal(manager.get(id)!.body, `${body}\n- [ ] one more`, "the write itself is whole");
});

test("a todo write's result is whole when it fits; a name too long for any result is the one thing cut, never the id", async (t) => {
  const { ctx } = await harness(t);
  const small = (await tool("create_todo").run({ workspace: "acme", name: "Small" }, ctx)).todo as Listed;
  assert.equal("bodyTruncated" in small, false, "nothing cut, nothing marked");
  const name = "N".repeat(70_000);
  const created = await tool("create_todo").run({ workspace: "acme", name }, ctx);
  const todo = created.todo as Listed;
  assert.ok(resultSize(created) <= MAX_RESULT_BYTES && ok(created).structuredContent === created, "one result, visibly a success");
  assert.match(todo.name, /^N+…$/, "the name, cut and marked");
  assert.deepEqual([todo.body, "bodyTruncated" in todo], ["", false], "the (empty) body is whole, so it is not marked");
  const listed = await tool("list_todos").run({ workspace: "acme" }, ctx);
  assert.ok(resultSize(listed) <= MAX_RESULT_BYTES && ok(listed).structuredContent === listed, "list_todos too");
  const renamed = await tool("update_todo").run({ id: todo.id, name, body: "- [ ] a" }, ctx);
  assert.equal((renamed.todo as Listed).id, todo.id);
  assert.ok(resultSize(renamed) <= MAX_RESULT_BYTES && ok(renamed).structuredContent === renamed, "update_todo too");
});

test("update_todo's body warns never to send a body marked bodyTruncated and names the safe routes; the writes say their results can be cut", () => {
  assert.equal(tool("update_todo").input.body.description, "The new markdown body, replacing the old one whole. Never send a body marked bodyTruncated — list_todos, and this tool's and toggle_todo_item's results, mark a body cut to fit: it is only the list's head, and the rest would be lost. Tick items with toggle_todo_item (it edits the full stored body), rename with `name` alone (the body is kept), or put new items in a new list.");
  for (const name of ["update_todo", "toggle_todo_item"]) assert.match(tool(name).description, /the result's body is only its head \(bodyTruncated:true\)/, name);
});
