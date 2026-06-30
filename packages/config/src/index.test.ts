import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { isValidName } from "./index.ts";
import { assertInsideFsRoot, FsSandboxError } from "./fs.ts";

test("isValidName rejects traversal and empties", () => {
  assert.equal(isValidName("project"), true);
  assert.equal(isValidName(".hidden"), false);
  assert.equal(isValidName("a/b"), false);
  assert.equal(isValidName("a\\b"), false);
  assert.equal(isValidName(""), false);
  assert.equal(isValidName(undefined), false);
});

test("assertInsideFsRoot allows in-root paths and rejects escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "fsroot-"));
  await mkdir(join(root, "ws"), { recursive: true });
  assert.equal(await assertInsideFsRoot(root, join(root, "ws")), join(root, "ws"));
  // not-yet-existing child still passes (deepest existing ancestor is realpath'd)
  assert.equal(await assertInsideFsRoot(root, join(root, "ws", "new")), join(root, "ws", "new"));
  await assert.rejects(() => assertInsideFsRoot(root, join(root, "..", "escape")), FsSandboxError);
  await assert.rejects(() => assertInsideFsRoot(root, "/etc"), FsSandboxError);
});
