import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeDaemonApi } from "./testing.ts";
import { ToolError } from "./errors.ts";
import { readThread,sendCommand } from "./reads.ts";

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

test("a thrown daemon call surfaces HOST_UNAVAILABLE without its private path", async (t) => {
  t.mock.method(console, "error", () => {});
  const api = new FakeDaemonApi().on("POST", "/api/sessions/c1/turn", () => { throw new Error("EACCES /home/x/secret"); });
  await assert.rejects(sendCommand(api, "c1", "turn", { input: "x" }, { retryDelayMs: () => 0 }),
    (e: { code: string; message: string }) => e.code === "HOST_UNAVAILABLE" && !e.message.includes("/home/x/secret"));
});

test("readThread refuses any answer that is not a snapshot as INTERNAL, an empty one included", async () => {
  const api = new FakeDaemonApi().on("GET", "/api/sessions/c1/thread", { status: 200, body: { kind: "events", seq: 5, events: [] } })
    .on("GET", "/api/sessions/c2/thread", { status: 200, body: null });
  for (const id of ["c1", "c2"]) {
    await assert.rejects(readThread(api, id), (e: unknown) => e instanceof ToolError && e.code === "INTERNAL", id);
  }
});
