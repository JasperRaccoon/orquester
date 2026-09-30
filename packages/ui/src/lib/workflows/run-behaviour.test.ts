import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { movedTimeoutPatch } from "./run-behaviour.ts";
import { node } from "./testing.ts";

describe("movedTimeoutPatch", () => {
  it("moves the value as the daemon applies it, capped at the type's maximum", () => {
    assert.deepEqual(movedTimeoutPatch(node("c", "code", {}, { timeoutMinutes: 10 })), { timeoutMinutes: 10 });
    assert.deepEqual(movedTimeoutPatch(node("c", "shell", {}, { timeoutMinutes: 5000 })), { timeoutMinutes: 1440 });
    assert.deepEqual(movedTimeoutPatch(node("h", "http", {}, { timeoutMinutes: 2 })), { timeoutSeconds: 120 });
    assert.deepEqual(movedTimeoutPatch(node("h", "http", {}, { timeoutMinutes: 600 })), { timeoutSeconds: 3600 });
  });

  it("has nothing to move for other types or without a value", () => {
    assert.equal(movedTimeoutPatch(node("a", "agent", {}, { timeoutMinutes: 10 })), null);
    assert.equal(movedTimeoutPatch(node("c", "code")), null);
  });
});
