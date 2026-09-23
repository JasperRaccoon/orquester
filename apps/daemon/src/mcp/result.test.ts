import { test } from "node:test";
import assert from "node:assert/strict";
import { FsSandboxError } from "@orquester/config/fs";
import { TodoError } from "../todos.ts";
import { ToolError } from "./errors.ts";
import { ok, toSafeToolError, capText, fitJsonBytes, jsonBytes, MAX_RESULT_BYTES } from "./result.ts";

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

test("ToolError surfaces code and message; sandbox errors never echo the path; unknown errors are generic", (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const a = toSafeToolError(new ToolError("SESSION_NOT_FOUND", "No session abc", { id: "abc" }));
  assert.equal(a.isError, true); assert.equal(a.content[0].text, "SESSION_NOT_FOUND: No session abc");
  assert.deepEqual(a.structuredContent, { code: "SESSION_NOT_FOUND", message: "No session abc", detail: { id: "abc" } });
  const b = toSafeToolError(new FsSandboxError("Path is outside the sandbox: /etc/shadow"));
  assert.ok(!b.content[0].text.includes("/etc/shadow")); assert.equal(b.structuredContent.code, "PATH_NOT_ALLOWED");
  assert.equal(logged.mock.callCount(), 0, "a coded error is not logged");
  const unknown = new Error("ENOENT /home/alice/.ssh/id_rsa");
  const c = toSafeToolError(unknown);
  assert.ok(!c.content[0].text.includes("/home/alice")); assert.equal(c.structuredContent.code, "INTERNAL");
  // The detail stays server-side: logged, never returned.
  assert.equal(logged.mock.callCount(), 1);
  assert.equal(logged.mock.calls[0].arguments[1], unknown);
});

test("capText cuts on a character boundary and flags it", () => {
  assert.deepEqual(capText("hello", 10), { text: "hello", truncated: false });
  const r = capText("héllo wörld", 5);
  assert.equal(r.truncated, true); assert.equal(r.text.length, 5);
  // Astral characters count once each: three emoji fit in 3, and 2 never splits a surrogate pair.
  assert.deepEqual(capText("😀😀😀", 3), { text: "😀😀😀", truncated: false });
  assert.deepEqual(capText("😀😀😀", 2), { text: "😀😀", truncated: true });
});

test("jsonBytes is a string's size inside a JSON result: escaped, UTF-8, without its quotes", () => {
  assert.equal(jsonBytes(""), 0);
  assert.equal(jsonBytes("abc"), 3);
  assert.equal(jsonBytes("é"), 2);
  assert.equal(jsonBytes("😀"), 4);
  assert.equal(jsonBytes("\"\\\n"), 6);
  assert.equal(jsonBytes("\u0001"), 6);
});

test("fitJsonBytes keeps the longest whole-character prefix whose JSON size fits the budget", () => {
  assert.deepEqual(fitJsonBytes("hello", 5), { text: "hello", truncated: false });
  assert.deepEqual(fitJsonBytes("hello", 4), { text: "hell", truncated: true });
  assert.deepEqual(fitJsonBytes("éé", 3), { text: "é", truncated: true });
  assert.deepEqual(fitJsonBytes("😀😀", 7), { text: "😀", truncated: true }, "a surrogate pair is never split");
  assert.deepEqual(fitJsonBytes("abc", 0), { text: "", truncated: true });
  assert.deepEqual(fitJsonBytes("abc", -1), { text: "", truncated: true });
  // Every budget: a prefix that fits, and one more character would not.
  const mixed = "aé\"😀\n\\z".repeat(3);
  for (let budget = 0; budget <= jsonBytes(mixed) + 1; budget += 1) {
    const { text, truncated } = fitJsonBytes(mixed, budget);
    assert.ok(mixed.startsWith(text) && jsonBytes(text) <= budget, `budget ${budget}`);
    assert.equal(truncated, text !== mixed, `budget ${budget}`);
    const next = [...mixed.slice(text.length)][0];
    if (next !== undefined) assert.ok(jsonBytes(text + next) > budget, `budget ${budget}: "${text}" is the longest fitting prefix`);
  }
});

test("TodoError maps its status to a code and keeps its (safe) message", () => {
  const notFound = toSafeToolError(new TodoError(404, "todo not found"));
  assert.deepEqual(notFound.structuredContent, { code: "NOT_FOUND", message: "todo not found" });
  assert.equal(notFound.content[0].text, "NOT_FOUND: todo not found");
  assert.equal(toSafeToolError(new TodoError(400, "bad")).structuredContent.code, "INVALID_ARGUMENT");
  assert.equal(toSafeToolError(new TodoError(409, "clash")).structuredContent.code, "CONFLICT");
});
