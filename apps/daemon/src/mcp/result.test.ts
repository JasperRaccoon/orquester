import { test } from "node:test";
import assert from "node:assert/strict";
import { FsSandboxError } from "@orquester/config/fs";
import { TodoError } from "../todos.ts";
import { ToolError } from "./errors.ts";
import { ok,toSafeToolError } from "./result.ts";

test("oversized MCP results remain byte-bounded, flagged and valid UTF-8", () => {
  for (const text of ["x".repeat(60_100), "é".repeat(60_000)]) {
    const r = ok({ text });
    assert.ok(Buffer.byteLength(r.content[0].text, "utf8") <= 60_000);
    assert.equal(r.structuredContent.truncated, true);
    assert.ok(!r.content[0].text.includes("�"));
    assert.ok(r.content[0].text.startsWith('{"text":"' + text.slice(0, 20)));
  }
});

test("the MCP result cap accepts exactly 60000 bytes and flags one byte over", () => {
  const exact = { s: "a".repeat(59_992) };
  assert.equal(Buffer.byteLength(JSON.stringify(exact), "utf8"), 60_000);
  assert.deepEqual(ok(exact).structuredContent, exact);
  const oneOver = ok({ s: "a".repeat(59_993) });
  assert.equal(oneOver.structuredContent.truncated, true);
  assert.ok(Buffer.byteLength(oneOver.content[0].text, "utf8") <= 60_000);
});

test("ToolError surfaces code and message; sandbox errors never echo the path; unknown errors are generic", (t) => {
  t.mock.method(console, "error", () => {});
  const a = toSafeToolError(new ToolError("SESSION_NOT_FOUND", "No session abc", { id: "abc" }));
  assert.equal(a.isError, true); assert.equal(a.content[0].text, "SESSION_NOT_FOUND: No session abc");
  assert.deepEqual(a.structuredContent, { code: "SESSION_NOT_FOUND", message: "No session abc", detail: { id: "abc" } });
  const b = toSafeToolError(new FsSandboxError("Path is outside the sandbox: /etc/shadow"));
  assert.ok(!b.content[0].text.includes("/etc/shadow")); assert.equal(b.structuredContent.code, "PATH_NOT_ALLOWED");

  const unknown = new Error("ENOENT /home/alice/.ssh/id_rsa");
  const c = toSafeToolError(unknown);
  assert.ok(!c.content[0].text.includes("/home/alice")); assert.equal(c.structuredContent.code, "INTERNAL");
  // The detail stays server-side: logged, never returned.

});

test("TodoError maps its status to a code and keeps its (safe) message", () => {
  const notFound = toSafeToolError(new TodoError(404, "todo not found"));
  assert.deepEqual(notFound.structuredContent, { code: "NOT_FOUND", message: "todo not found" });
  assert.equal(notFound.content[0].text, "NOT_FOUND: todo not found");
  assert.equal(toSafeToolError(new TodoError(400, "bad")).structuredContent.code, "INVALID_ARGUMENT");
  assert.equal(toSafeToolError(new TodoError(409, "clash")).structuredContent.code, "CONFLICT");
});

test("an error message is capped whatever it echoes: at most 4_000 code points, a cut one ending in …", () => {
  const junk = "z".repeat(2 * 1024 * 1024);
  const echoing = [
    toSafeToolError(new ToolError("SESSION_NOT_FOUND", `No session with id "${junk}". Use list_sessions.`)),
    toSafeToolError(new TodoError(404, `No todo list "${junk}"`))
  ];
  for (const e of echoing) {
    const { code, message } = e.structuredContent;
    assert.ok([...message].length <= 4_000, `${code}: ${[...message].length} code points`);
    assert.ok(message.endsWith("z…"), `${code}: the cut is marked`);
    assert.equal(e.content[0].text, `${code}: ${message}`, `${code}: the text carries the same capped message`);
  }
  // A message within the cap is untouched, detail included.
  const short = toSafeToolError(new ToolError("PENDING_REQUEST", "Answer the agent first.", { approvals: ["r1"] }));
  assert.deepEqual(short.structuredContent, { code: "PENDING_REQUEST", message: "Answer the agent first.", detail: { approvals: ["r1"] } });
});
