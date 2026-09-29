import assert from "node:assert/strict";
import test from "node:test";
import { hookItemId } from "./hash.ts";

test("hookItemId hashes the normalized {matcher, handler} and ignores key order", () => {
  const handler = { type: "command", command: "echo hi", timeoutSec: 5 };
  const id = hookItemId("PreToolUse", { matcher: "Bash", ...handler });
  // Persisted ID format from the profile design §4.3; literal SHA-256 vector.
  assert.equal(id, "hook:PreToolUse:b976b1ed3ad45e74");
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
