import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeKey } from "./keys.ts";

test("named keys map to bytes", () => {
  assert.equal(encodeKey("Enter"), "\r");
  assert.equal(encodeKey("Escape"), "\x1b");
  assert.equal(encodeKey("Up"), "\x1b[A");
  assert.equal(encodeKey("Space"), " ");
  assert.equal(encodeKey("Tab"), "\t");
  assert.equal(encodeKey("BackTab"), "\x1b[Z");
});

test("C-<letter> maps to a control code (case-insensitive)", () => {
  assert.equal(encodeKey("C-c"), "\x03");
  assert.equal(encodeKey("C-d"), "\x04");
  assert.equal(encodeKey("C-J"), "\n");          // Ctrl-J == newline
});

test("unknown keys throw", () => {
  assert.throws(() => encodeKey("Frobnicate"), /Unknown key/);
  assert.throws(() => encodeKey("C-1"), /Unknown key/);
});
