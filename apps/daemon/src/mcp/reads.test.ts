import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeDaemonApi } from "./testing.ts";
import { ToolError } from "./errors.ts";
import { listSessions, findSession, requireChatSession, readThread, sendCommand } from "./reads.ts";

const chat = { id: "c1", kind: "agent-chat", refId: "claude", title: "Claude", projectPath: "/w/a/p", cwd: "/w/a/p", cols: 0, rows: 0, status: "running", order: 1, createdAt: "2026-09-22T00:00:00.000Z" };
const shell = { ...chat, id: "t1", kind: "shell", refId: "bash" };

test("listSessions passes projectPath through and findSession filters the list", async () => {
  const api = new FakeDaemonApi().on("GET", "/api/sessions", { status: 200, body: [chat, shell] });
  assert.equal((await listSessions(api, "/w/a/p")).length, 2);
  assert.deepEqual(api.calls[0], { method: "GET", path: "/api/sessions", query: { projectPath: "/w/a/p" } });
  assert.equal((await findSession(api, "t1")).id, "t1");
  await assert.rejects(findSession(api, "zz"), (e: { code: string }) => e.code === "SESSION_NOT_FOUND");
  await assert.rejects(requireChatSession(api, "t1"), (e: { code: string }) => e.code === "NOT_A_CHAT_SESSION");
  assert.equal((await requireChatSession(api, "c1")).kind, "agent-chat");
});

test("readThread unwraps the snapshot and surfaces daemon errors", async () => {
  const snap = { head: { id: "c1" }, items: [], turns: [], checkpoints: [], pending: { approvals: [], userInputs: [] }, roster: [], seq: 4 };
  const api = new FakeDaemonApi().on("GET", "/api/sessions/c1/thread", { status: 200, body: { kind: "snapshot", thread: snap } })
    .on("GET", "/api/sessions/gone/thread", { status: 404, body: { error: { code: "THREAD_NOT_FOUND", message: "No chat session with that id." } } });
  assert.deepEqual(await readThread(api, "c1"), snap);
  await assert.rejects(readThread(api, "gone"), (e: { code: string }) => e.code === "THREAD_NOT_FOUND");
});

test("sendCommand mints a UUID commandId, posts the body and returns the receipt", async () => {
  const api = new FakeDaemonApi().on("POST", "/api/sessions/c1/turn", { status: 200, body: { seq: 9 } });
  assert.deepEqual(await sendCommand(api, "c1", "turn", { input: "hi" }), { seq: 9 });
  const body = api.calls[0].body as { commandId: string; input: string };
  assert.match(body.commandId, /^[0-9a-f-]{36}$/); assert.equal(body.input, "hi");
  const api2 = new FakeDaemonApi().on("POST", "/api/sessions/c1/session/stop", { status: 200, body: { seq: 1 } });
  await sendCommand(api2, "c1", "session/stop", {});
  assert.equal(api2.calls[0].path, "/api/sessions/c1/session/stop");
  const api3 = new FakeDaemonApi().on("POST", "/api/sessions/c1/account", { status: 200, body: { seq: 2 } });
  await sendCommand(api3, "c1", "account", { accountId: "system" });
  assert.equal(api3.calls[0].path, "/api/sessions/c1/account");
});

test("sendCommand retries HOST_UNAVAILABLE with the SAME commandId up to 3 times, then throws; other errors are final", async () => {
  let n = 0;
  const api = new FakeDaemonApi().on("POST", "/api/sessions/c1/turn", () => (++n < 3
    ? { status: 503, body: { error: { code: "HOST_UNAVAILABLE", message: "restarting" } } }
    : { status: 200, body: { seq: 5 } }));
  assert.deepEqual(await sendCommand(api, "c1", "turn", { input: "x" }, { retryDelayMs: () => 0 }), { seq: 5 });
  const ids = new Set(api.calls.map((c) => (c.body as { commandId: string }).commandId));
  assert.equal(ids.size, 1); assert.equal(api.calls.length, 3);
  const always = new FakeDaemonApi().on("POST", "/api/sessions/c1/turn", { status: 503, body: { error: { code: "HOST_UNAVAILABLE", message: "restarting" } } });
  await assert.rejects(sendCommand(always, "c1", "turn", { input: "x" }, { retryDelayMs: () => 0 }), (e: { code: string }) => e.code === "HOST_UNAVAILABLE");
  assert.equal(always.calls.length, 4);
  const rejected = new FakeDaemonApi().on("POST", "/api/sessions/c1/turn", { status: 409, body: { error: { code: "COMMAND_REJECTED", message: "no" } } });
  await assert.rejects(sendCommand(rejected, "c1", "turn", { input: "x" }), (e: { code: string }) => e.code === "COMMAND_REJECTED");
  assert.equal(rejected.calls.length, 1);
});

test("a thrown daemon call surfaces a fixed HOST_UNAVAILABLE message and logs the cause", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const api = new FakeDaemonApi().on("POST", "/api/sessions/c1/turn", () => { throw new Error("EACCES /home/x/secret"); });
  await assert.rejects(sendCommand(api, "c1", "turn", { input: "x" }, { retryDelayMs: () => 0 }),
    (e: { code: string; message: string }) => e.code === "HOST_UNAVAILABLE" && e.message === "The daemon call failed.");
  assert.equal(logged.mock.callCount(), 4);
  assert.equal(logged.mock.calls[0].arguments[0], "[mcp] daemon call failed");
  assert.match(String(logged.mock.calls[0].arguments[1]), /EACCES/);
});

test("sendCommand waits only between attempts, never after the last one", async (t) => {
  t.mock.method(console, "error", () => {});
  const waits: number[] = [];
  const retryDelayMs = (attempt: number) => { waits.push(attempt); return 0; };
  const thrown = new FakeDaemonApi().on("POST", "/api/sessions/c1/turn", () => { throw new Error("socket hang up"); });
  await assert.rejects(sendCommand(thrown, "c1", "turn", { input: "x" }, { retryDelayMs }), (e: { code: string }) => e.code === "HOST_UNAVAILABLE");
  assert.equal(thrown.calls.length, 4);
  assert.equal(new Set(thrown.calls.map((c) => (c.body as { commandId: string }).commandId)).size, 1);
  assert.deepEqual(waits, [0, 1, 2]);
  waits.length = 0;
  const unavailable = new FakeDaemonApi().on("POST", "/api/sessions/c1/turn", { status: 503, body: { error: { code: "HOST_UNAVAILABLE", message: "restarting" } } });
  await assert.rejects(sendCommand(unavailable, "c1", "turn", { input: "x" }, { retryDelayMs }), (e: { code: string }) => e.code === "HOST_UNAVAILABLE");
  assert.deepEqual(waits, [0, 1, 2]);
});

test("sendCommand: the minted commandId always wins over one in the caller's body", async () => {
  const api = new FakeDaemonApi().on("POST", "/api/sessions/c1/turn", { status: 200, body: { seq: 3 } });
  await sendCommand(api, "c1", "turn", { commandId: "caller-chosen", input: "x" });
  const body = api.calls[0].body as { commandId: string; input: string };
  assert.notEqual(body.commandId, "caller-chosen");
  assert.match(body.commandId, /^[0-9a-f-]{36}$/); assert.equal(body.input, "x");
});

test("readThread refuses any answer that is not a snapshot as INTERNAL, an empty one included", async () => {
  const api = new FakeDaemonApi().on("GET", "/api/sessions/c1/thread", { status: 200, body: { kind: "events", seq: 5, events: [] } })
    .on("GET", "/api/sessions/c2/thread", { status: 200, body: null });
  for (const id of ["c1", "c2"]) {
    await assert.rejects(readThread(api, id), (e: unknown) => e instanceof ToolError && e.code === "INTERNAL" && e.message === "Expected a thread snapshot.", id);
  }
});
