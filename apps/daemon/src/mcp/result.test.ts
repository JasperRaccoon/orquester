import { test } from "node:test";
import assert from "node:assert/strict";
import { FsSandboxError } from "@orquester/config/fs";
import { ToolError } from "./errors.ts";
import { ok, toSafeToolError, capText, MAX_RESULT_BYTES } from "./result.ts";

test("ok returns the object as text and structuredContent", () => {
  const r = ok({ sessions: [] });
  assert.equal(r.content[0].text, JSON.stringify({ sessions: [] }));
  assert.deepEqual(r.structuredContent, { sessions: [] });
});

test("ok caps oversized text and says so", () => {
  const r = ok({ text: "x".repeat(MAX_RESULT_BYTES + 100) });
  assert.ok(Buffer.byteLength(r.content[0].text, "utf8") <= MAX_RESULT_BYTES);
  assert.equal((r.structuredContent as { truncated?: boolean }).truncated, true);
  assert.ok(r.content[0].text.startsWith('{"text":"xxx'), "the text keeps the leading part of the result");
  assert.deepEqual(r.structuredContent, { truncated: true, truncationNote: `Result exceeded ${MAX_RESULT_BYTES} bytes; narrow the request (fewer turns, smaller maxChars).` });
  assert.ok(Buffer.byteLength(JSON.stringify(r.structuredContent), "utf8") <= MAX_RESULT_BYTES);
  // A cut through a multibyte character backs off to a whole character: no stray U+FFFD.
  const m = ok({ t: "é".repeat(MAX_RESULT_BYTES) });
  assert.ok(Buffer.byteLength(m.content[0].text, "utf8") <= MAX_RESULT_BYTES);
  assert.ok(!m.content[0].text.includes("\uFFFD"));
});

test("ToolError surfaces code and message; sandbox errors never echo the path; unknown errors are generic", () => {
  const a = toSafeToolError(new ToolError("SESSION_NOT_FOUND", "No session abc", { id: "abc" }));
  assert.equal(a.isError, true); assert.equal(a.content[0].text, "SESSION_NOT_FOUND: No session abc");
  assert.deepEqual(a.structuredContent, { code: "SESSION_NOT_FOUND", message: "No session abc", detail: { id: "abc" } });
  const b = toSafeToolError(new FsSandboxError("Path is outside the sandbox: /etc/shadow"));
  assert.ok(!b.content[0].text.includes("/etc/shadow")); assert.equal(b.structuredContent.code, "PATH_NOT_ALLOWED");
  const c = toSafeToolError(new Error("ENOENT /home/alice/.ssh/id_rsa"));
  assert.ok(!c.content[0].text.includes("/home/alice")); assert.equal(c.structuredContent.code, "INTERNAL");
});

test("capText cuts on a character boundary and flags it", () => {
  assert.deepEqual(capText("hello", 10), { text: "hello", truncated: false });
  const r = capText("héllo wörld", 5);
  assert.equal(r.truncated, true); assert.equal(r.text.length, 5);
  // Astral characters count once each: three emoji fit in 3, and 2 never splits a surrogate pair.
  assert.deepEqual(capText("😀😀😀", 3), { text: "😀😀😀", truncated: false });
  assert.deepEqual(capText("😀😀😀", 2), { text: "😀😀", truncated: true });
});
