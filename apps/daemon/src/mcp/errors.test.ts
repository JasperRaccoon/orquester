import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolError, daemonError, expectOk } from "./errors.ts";

test("daemonError reads the chat envelope, the flat shape and a bare string", () => {
  const a = daemonError({ status: 409, body: { error: { code: "COMMAND_REJECTED", message: "busy", detail: { x: 1 } } } });
  assert.equal(a.code, "COMMAND_REJECTED"); assert.equal(a.message, "busy"); assert.deepEqual(a.detail, { x: 1 });
  const b = daemonError({ status: 400, body: { code: "RESUME_UNAVAILABLE", message: "bad id" } });
  assert.equal(b.code, "RESUME_UNAVAILABLE"); assert.equal(b.message, "bad id");
  const c = daemonError({ status: 400, body: { error: "model is only valid for claudex/claudemix", entryId: "codex" } });
  assert.equal(c.code, "INVALID_ARGUMENT"); assert.equal(c.message, "model is only valid for claudex/claudemix");
  const d = daemonError({ status: 404, body: "not json" });
  assert.equal(d.code, "NOT_FOUND"); assert.match(d.message, /404/);
  const e = daemonError({ status: 503, body: null });
  assert.equal(e.code, "HOST_UNAVAILABLE");
});

test("expectOk returns the body below 400 and throws above", () => {
  assert.deepEqual(expectOk({ status: 200, body: { seq: 3 } }, "turn"), { seq: 3 });
  assert.throws(() => expectOk({ status: 404, body: { error: { code: "THREAD_NOT_FOUND", message: "no" } } }, "thread"),
    (err: unknown) => err instanceof ToolError && err.code === "THREAD_NOT_FOUND");
});
