import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  PROFILE_HASH_LENGTH,
  contentHash,
  hookItemId,
  itemId,
  parseHookItemId,
  parseItemId,
  stableStringify
} from "./hash.ts";

test("stableStringify sorts keys recursively and follows JSON's rules otherwise", () => {
  assert.equal(stableStringify({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } }), '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
  assert.equal(stableStringify({ a: undefined, b: () => 1, c: null }), '{"c":null}');
  assert.equal(stableStringify([undefined, Number.NaN, Infinity, 1]), "[null,null,null,1]");
  assert.equal(stableStringify(new Date("2026-09-28T00:00:00.000Z")), '"2026-09-28T00:00:00.000Z"');
  assert.equal(stableStringify(undefined), "null");
  assert.equal(stableStringify("a\"b"), '"a\\"b"');
});

test("contentHash is 16 hex, independent of key order, and hashes strings raw", () => {
  const a = contentHash({ x: 1, y: [1, 2] });
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(PROFILE_HASH_LENGTH, 16);
  assert.equal(contentHash({ y: [1, 2], x: 1 }), a);
  assert.notEqual(contentHash({ x: 1, y: [2, 1] }), a);
  const text = "hello\n";
  assert.equal(contentHash(text), createHash("sha256").update(text).digest("hex").slice(0, 16));
  assert.equal(contentHash(Buffer.from(text)), contentHash(text));
});

test("itemId and parseItemId round trip; malformed ids are null", () => {
  assert.equal(itemId("mcp", "jira-cloud"), "mcp:jira-cloud");
  assert.deepEqual(parseItemId("plugin:superpowers@claude-plugins-official"), {
    kind: "plugin",
    name: "superpowers@claude-plugins-official"
  });
  assert.deepEqual(parseItemId("command:git/pr"), { kind: "command", name: "git/pr" });
  for (const bad of ["", "mcp", "mcp:", ":name", "agent:x", "instructions:x"]) {
    assert.equal(parseItemId(bad), null, bad);
  }
});

test("hookItemId hashes the normalized {matcher, handler} and ignores key order", () => {
  const handler = { type: "command", command: "echo hi", timeoutSec: 5 };
  const id = hookItemId("PreToolUse", { matcher: "Bash", ...handler });
  const expected = createHash("sha256")
    .update(stableStringify({ matcher: "Bash", handler }))
    .digest("hex")
    .slice(0, 16);
  assert.equal(id, `hook:PreToolUse:${expected}`);
  assert.equal(hookItemId("PreToolUse", { timeoutSec: 5, command: "echo hi", type: "command", matcher: "Bash" }), id);
  // Event, matcher and handler each move the id.
  assert.notEqual(hookItemId("PostToolUse", { matcher: "Bash", ...handler }), id);
  assert.notEqual(hookItemId("PreToolUse", { matcher: "Edit", ...handler }), id);
  assert.notEqual(hookItemId("PreToolUse", { matcher: "Bash", ...handler, timeoutSec: 6 }), id);
  // No matcher, an empty one and null are the same; an unset optional field vanishes.
  const bare = hookItemId("Stop", { command: "x" });
  assert.equal(hookItemId("Stop", { matcher: "", command: "x" }), bare);
  assert.equal(hookItemId("Stop", { matcher: null, command: "x", timeoutSec: undefined }), bare);
});

test("parseHookItemId splits event and hash", () => {
  const id = hookItemId("PreToolUse", { matcher: "Bash", command: "x" });
  const parsed = parseHookItemId(id);
  assert.equal(parsed?.event, "PreToolUse");
  assert.equal(parsed?.hash, id.slice(-16));
  assert.equal(parseHookItemId("hook:PreToolUse"), null);
  assert.equal(parseHookItemId("hook:PreToolUse:xyz"), null);
  assert.equal(parseHookItemId("mcp:PreToolUse:0123456789abcdef"), null);
  assert.deepEqual(parseHookItemId("hook:Stop:0123456789abcdef"), { event: "Stop", hash: "0123456789abcdef" });
});
