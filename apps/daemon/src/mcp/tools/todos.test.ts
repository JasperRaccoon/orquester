/**
 * list_todos / update_todos (unified MCP design 2026-10-15 §4 rows 22–23): the ported external
 * behaviour (scopes, results that always fit, whole writes) and the chat rules (own project by
 * default, the gate's matrix, plan mode, no toolset to turn on) — through the executor, the
 * in-process client and the daemon's real `/api/todos` routes over a real store.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createWriteStream, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createDefaultClientConfig, createDefaultDaemonConfig } from "@orquester/config";
import { createServer } from "../../index.ts";
import { TodoListManager } from "../../todos.ts";
import { FakeApprovalPort } from "../catalog/approval-double.ts";
import type { ThreadCaller } from "../catalog/contract.ts";
import { InjectDaemonApi } from "../daemon-api.ts";
import { executeToolCall } from "../executor.ts";

type CreateServerArgs = Parameters<typeof createServer>;
type Outcome = { ok: true; value: Record<string, unknown> } | { ok: false; code: string; message: string };
type Listed = { id: string; name: string; body: string; bodyTruncated?: true };

/** Workspaces `acme` (projects `api`, `web`) and `beta` (project `app`); the daemon's todo routes over a real store. */
async function harness(t: TestContext) {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "mcp-todos-")));
  const workspacesDir = join(root, "workspaces");
  for (const dir of ["acme/api/src", "acme/web", "beta/app"]) await mkdir(join(workspacesDir, dir), { recursive: true });
  const manager = new TodoListManager(join(root, "todos.json"), { warn() {} });
  const resolved = { daemonDir: join(root, "daemon"), workspacesDir, workspacesMetaFile: join(root, "workspaces.json"), fsRoot: workspacesDir };
  const app = createServer(
    createDefaultDaemonConfig({ env: {} }),
    resolved as unknown as CreateServerArgs[1],
    createDefaultClientConfig(join(root, "daemon.sock")),
    createWriteStream("/dev/null"),
    { todos: manager } as unknown as CreateServerArgs[4],
    { authRequired: false, mode: "local" }
  );
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const api = new InjectDaemonApi({ app, authorization: undefined, agentChat: null, broadcaster: { add() {}, remove() {} } as never, fsRoot: workspacesDir, workspacesDir });
  const port = new FakeApprovalPort({ outcome: "approved", approvalId: "" });
  const own = join(workspacesDir, "acme", "api");
  const chat = (over: Partial<ThreadCaller> = {}): ThreadCaller => ({
    kind: "thread", threadId: "me", title: "Plan", projectPath: own, workspace: "acme", cwd: own, agentId: "claude", callId: "c1",
    runtimeMode: "approval-required", planning: false, workflowOwned: false, exchange: null, ...over
  });
  /** One call through the executor: external by default, or as `caller`. */
  const call = async (name: string, args: Record<string, unknown>, caller?: ThreadCaller): Promise<Outcome> => {
    const result: CallToolResult = await executeToolCall(
      { approvals: port },
      { name, arguments: args },
      { caller: caller ?? { kind: "external" }, api, signal: new AbortController().signal }
    );
    const content = result.structuredContent as Record<string, unknown>;
    return result.isError ? { ok: false, code: content.code as string, message: content.message as string } : { ok: true, value: content };
  };
  const value = async (name: string, args: Record<string, unknown>, caller?: ThreadCaller): Promise<Record<string, unknown>> => {
    const outcome = await call(name, args, caller);
    assert.ok(outcome.ok, `${name}: ${outcome.ok ? "" : `${outcome.code} ${outcome.message}`}`);
    return outcome.value;
  };
  const refused = async (name: string, args: Record<string, unknown>, code: string, caller?: ThreadCaller): Promise<string> => {
    const outcome = await call(name, args, caller);
    assert.ok(!outcome.ok, `${name} succeeded`);
    assert.equal(outcome.code, code, outcome.message);
    return outcome.message;
  };
  const create = async (sel: Record<string, string>, name: string): Promise<string> => ((await value("update_todos", { action: "create", ...sel, name })).todo as { id: string }).id;
  return { root, workspacesDir, manager, port, own, chat, call, value, refused, create };
}

const resultSize = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

test("a project list is keyed by the project path, whichever spelling of the project is given", async (t) => {
  const h = await harness(t);
  const projectPath = join(h.workspacesDir, "acme", "api");
  const byName = await h.value("update_todos", { action: "create", project: "acme/api", name: "Bugs" });
  assert.equal((byName.todo as { scope: string }).scope, "project");
  const byPath = await h.create({ project: `${projectPath}/` }, "Ideas");
  assert.deepEqual(h.manager.list("project", projectPath).map((r) => r.id), [(byName.todo as { id: string }).id, byPath]);
  const listed = (await h.value("list_todos", { project: projectPath })).todos as { id: string }[];
  assert.deepEqual(listed.map((r) => r.id), [(byName.todo as { id: string }).id, byPath]);
  assert.deepEqual((await h.value("list_todos", { workspace: "acme" })).todos, [], "a workspace list is a different scope");
});

test("external callers pass exactly one of workspace or project, and the project must resolve inside the sandbox", async (t) => {
  const h = await harness(t);
  await mkdir(join(h.root, "outside"), { recursive: true });
  await h.refused("list_todos", {}, "INVALID_ARGUMENT");
  await h.refused("update_todos", { action: "create", workspace: "acme", project: "acme/api", name: "x" }, "INVALID_ARGUMENT");
  await h.refused("update_todos", { action: "create", project: "acme/missing", name: "x" }, "PROJECT_NOT_FOUND");
  await h.refused("update_todos", { action: "create", project: "acme/api/src", name: "x" }, "PROJECT_NOT_FOUND");
  await h.refused("update_todos", { action: "create", project: join(h.root, "outside"), name: "x" }, "PATH_NOT_ALLOWED");
  await h.refused("update_todos", { action: "create", workspace: "missing", name: "x" }, "PROJECT_NOT_FOUND");
  // Empty fields are refused by the schema, never read as omitted.
  await h.refused("list_todos", { project: "" }, "INVALID_ARGUMENT");
  await h.refused("update_todos", { action: "create", workspace: "", project: "acme/api", name: "x" }, "INVALID_ARGUMENT");
  assert.equal(h.manager.list("workspace", "acme").length + h.manager.list("workspace", "missing").length, 0, "nothing was created");
});

test("each action takes its own fields: a missing one or a stray one is INVALID_ARGUMENT before anything is written", async (t) => {
  const h = await harness(t);
  const id = await h.create({ workspace: "acme" }, "L");
  for (const [args, text] of [
    [{ action: "create", workspace: "acme" }, /needs name/],
    [{ action: "create", workspace: "acme", name: "x", body: "- [ ] a" }, /takes no body/],
    [{ action: "update", workspace: "acme" }, /needs id/],
    [{ action: "update", workspace: "acme", id }, /name, body or both/],
    [{ action: "update", workspace: "acme", id, item: 1 }, /takes no item/],
    [{ action: "toggle", workspace: "acme", id }, /needs item/],
    [{ action: "toggle", workspace: "acme", id, item: 1, body: "" }, /takes no body/],
    [{ action: "delete", workspace: "acme", id, name: "x" }, /takes no name/]
  ] as const) {
    assert.match(await h.refused("update_todos", args, "INVALID_ARGUMENT"), text);
  }
  assert.equal(h.manager.get(id)?.name, "L");
});

test("update renames and replaces the body; toggle ticks one item; delete removes the list", async (t) => {
  const h = await harness(t);
  const id = await h.create({ workspace: "acme" }, "Old");
  const updated = await h.value("update_todos", { action: "update", workspace: "acme", id, name: "New", body: "- [ ] build\n- [ ] ship" });
  assert.equal((updated.todo as Listed).name, "New");
  assert.equal((updated.todo as Listed).body, "- [ ] build\n- [ ] ship");
  assert.deepEqual(await h.value("update_todos", { action: "toggle", workspace: "acme", id, item: 2 }), { id, item: "ship", checked: true, body: "- [ ] build\n- [x] ship" });
  assert.deepEqual(await h.value("update_todos", { action: "toggle", workspace: "acme", id, item: "build", checked: true }), { id, item: "build", checked: true, body: "- [x] build\n- [x] ship" });
  assert.deepEqual(await h.value("update_todos", { action: "delete", workspace: "acme", id }), { deleted: true, id });
  assert.equal(h.manager.get(id), undefined);
  assert.match(await h.refused("update_todos", { action: "delete", workspace: "acme", id }, "NOT_FOUND"), /list_todos shows the ids/);
});

test("list_todos keeps one result: the oldest lists are left out first, and the result says so and how many", async (t) => {
  const h = await harness(t);
  for (let i = 0; i < 12; i += 1) {
    const id = await h.create({ workspace: "acme" }, `List ${i}`);
    await h.value("update_todos", { action: "update", workspace: "acme", id, body: `- [ ] ${"x".repeat(6_000)}` });
  }
  const stored = h.manager.list("workspace", "acme");
  const r = await h.value("list_todos", { workspace: "acme" });
  const todos = r.todos as Listed[];
  const kept = todos.map((x) => x.id);
  assert.equal(r.truncated, true);
  assert.ok(kept.length > 0 && kept.length < stored.length, `${kept.length} kept`);
  assert.deepEqual(kept, stored.slice(stored.length - kept.length).map((s) => s.id), "the newest lists, still oldest first");
  assert.equal(r.omittedLists, stored.length - kept.length, "how many lists were left out");
  assert.deepEqual(todos.map((x) => [x.body, "bodyTruncated" in x]), stored.slice(stored.length - kept.length).map((s) => [s.body, false]));
  assert.ok(resultSize(r) <= 60_000, `${resultSize(r)} bytes`);
  assert.deepEqual(await h.value("list_todos", { project: "acme/api" }), { todos: [] }, "a small set is whole and says nothing about truncation");
});

test("list_todos: a newest list too big for a result on its own keeps its name and the head of its body, marked bodyTruncated", async (t) => {
  const h = await harness(t);
  const id = await h.create({ workspace: "acme" }, "Huge");
  const body = `- [ ] ${"y".repeat(70_000)}`;
  await h.value("update_todos", { action: "update", workspace: "acme", id, body });
  const r = await h.value("list_todos", { workspace: "acme" });
  const [only] = r.todos as Listed[];
  assert.equal(r.truncated, true);
  assert.equal(only!.id, id);
  assert.ok(body.startsWith(only!.body) && only!.body.length > 0);
  assert.equal(only!.bodyTruncated, true);
  assert.equal("omittedLists" in r, false);
  assert.ok(resultSize(r) <= 60_000);
});

test("toggle on a 3 000-item list: the toggle is whole, its result one result marked bodyTruncated; a same-state retry writes nothing", async (t) => {
  const h = await harness(t);
  const id = await h.create({ workspace: "acme" }, "Backlog");
  const body = Array.from({ length: 3_000 }, (_, i) => `- [ ] task ${i + 1}: 項目 "quoted" \\ ${"x".repeat(10)}`).join("\n");
  await h.value("update_todos", { action: "update", workspace: "acme", id, body });
  const r = await h.value("update_todos", { action: "toggle", workspace: "acme", id, item: 2 });
  assert.deepEqual([r.id, r.checked, r.bodyTruncated], [id, true, true]);
  assert.ok(resultSize(r) <= 60_000);
  assert.ok((r.body as string).includes("- [x] task 2:"));
  assert.equal(h.manager.get(id)!.body, body.replace("- [ ] task 2:", "- [x] task 2:"), "the stored body: item 2 ticked, every other item as it was");
  const updatedAt = h.manager.get(id)!.updatedAt;
  let updates = 0;
  const onUpdated = () => { updates += 1; };
  h.manager.lifecycle.on("updated", onUpdated);
  t.after(() => { h.manager.lifecycle.off("updated", onUpdated); });
  await h.value("update_todos", { action: "toggle", workspace: "acme", id, item: 2, checked: true });
  assert.equal(updates, 0, "nothing was written");
  assert.equal(h.manager.get(id)!.updatedAt, updatedAt);
  // A rename keeps the whole body; its result is one result.
  const renamed = await h.value("update_todos", { action: "update", workspace: "acme", id, name: "Renamed" });
  assert.equal((renamed.todo as Listed).bodyTruncated, true);
  assert.ok(resultSize(renamed) <= 60_000);
  assert.equal(h.manager.get(id)!.body, body.replace("- [ ] task 2:", "- [x] task 2:"));
});

test("a name too long for any result is the one thing cut, never the id", async (t) => {
  const h = await harness(t);
  const name = "N".repeat(70_000);
  const created = await h.value("update_todos", { action: "create", workspace: "acme", name });
  const todo = created.todo as Listed;
  assert.ok(resultSize(created) <= 60_000);
  assert.match(todo.name, /^N+…$/);
  assert.equal(h.manager.get(todo.id)!.name, name, "stored whole");
});

// --- Chat callers (§5.2) -------------------------------------------------------------------------

test("chat: without workspace or project a call is on this chat's project; its own lists are Act with no card", async (t) => {
  const h = await harness(t);
  const id = ((await h.value("update_todos", { action: "create", name: "Mine" }, h.chat())).todo as { id: string }).id;
  assert.deepEqual(h.manager.list("project", h.own).map((r) => r.id), [id]);
  assert.deepEqual(((await h.value("list_todos", {}, h.chat())).todos as Listed[]).map((r) => r.id), [id]);
  await h.value("update_todos", { action: "update", id, body: "- [ ] a" }, h.chat());
  // The own workspace's own lists are the chat's too.
  await h.value("update_todos", { action: "create", workspace: "acme", name: "Team" }, h.chat());
  assert.equal(h.port.cards.length, 0, "no card");
  // A chat with no project must say where.
  await h.refused("list_todos", {}, "INVALID_ARGUMENT", h.chat({ projectPath: "", workspace: "" }));
});

test("chat: another project of the workspace reads freely and acts behind a card below Full access", async (t) => {
  const h = await harness(t);
  const id = await h.create({ project: "acme/web" }, "Web");
  await h.value("list_todos", { project: "acme/web" }, h.chat());
  assert.equal(h.port.cards.length, 0, "metadata read: no card");
  await h.value("update_todos", { action: "update", project: "acme/web", id, name: "Web 2" }, h.chat());
  assert.equal(h.port.cards.length, 1);
  assert.equal(h.port.cards[0]!.family, "cross-project");
  await h.value("update_todos", { action: "update", project: "acme/web", id, name: "Web 3" }, h.chat({ runtimeMode: "full-access" }));
  assert.equal(h.port.cards.length, 1, "Full access acts in its own workspace without a card");
  assert.equal(h.manager.get(id)!.name, "Web 3");
});

test("chat: another workspace's own lists (S13 workspace target) — a read below Full access is a card, a write always cards; never grantable", async (t) => {
  const h = await harness(t);
  const id = await h.create({ workspace: "beta" }, "Beta");
  // Below Full access: a card, never a refusal (the port double approves it).
  const read = await h.value("list_todos", { workspace: "beta" }, h.chat({ runtimeMode: "auto" }));
  assert.deepEqual((read.todos as { id: string }[]).map((todo) => todo.id), [id]);
  const readCard = h.port.cards.at(-1)!;
  assert.deepEqual([readCard.kind, readCard.family, readCard.grantOptions], ["boundary", "cross-workspace-read", []]);
  assert.match(readCard.scope.label, /workspace beta/);
  // Full access reads without a card.
  const before = h.port.cards.length;
  await h.value("list_todos", { workspace: "beta" }, h.chat({ runtimeMode: "full-access" }));
  assert.equal(h.port.cards.length, before);
  // A write there always cards, in Full access too, and offers no grant (no project to grant for).
  await h.value("update_todos", { action: "toggle", workspace: "beta", id, item: 1 }, h.chat({ runtimeMode: "full-access" })).catch(() => undefined);
  const card = h.port.cards.at(-1)!;
  assert.equal(card.family, "cross-project");
  assert.deepEqual(card.grantOptions, []);
  assert.equal(card.targetProjectPath, undefined);
  // The chat's own workspace lists: no card.
  const own = h.port.cards.length;
  await h.value("list_todos", { workspace: "acme" }, h.chat());
  assert.equal(h.port.cards.length, own);
  // A denied card refuses, as for a project target.
  h.port.answerWith({ outcome: "denied", approvalId: "" });
  await h.refused("list_todos", { workspace: "beta" }, "APPROVAL_DENIED", h.chat({ runtimeMode: "auto" }));
  // A workflow-owned chat never acts there.
  await h.refused("update_todos", { action: "update", workspace: "beta", id, name: "x" }, "PERMISSION_DENIED", h.chat({ workflowOwned: true, runtimeMode: "full-access" }));
});

test("chat: writes are refused while planning; otherwise any chat may use them, nothing to turn on first", async (t) => {
  const h = await harness(t);
  assert.match(await h.refused("update_todos", { action: "create", name: "x" }, "PERMISSION_DENIED", h.chat({ planning: true })), /planning/);
  await h.value("list_todos", {}, h.chat({ planning: true }));
  // A chat of any agent, with no settings anywhere: update_todos (once in an off-by-default toolset) just runs.
  for (const agentId of ["claude", "codex"] as const) {
    const outcome = await h.call("update_todos", { action: "create", name: `from ${agentId}` }, h.chat({ agentId }));
    assert.ok(outcome.ok, outcome.ok ? "" : `${outcome.code} ${outcome.message}`);
  }
});
