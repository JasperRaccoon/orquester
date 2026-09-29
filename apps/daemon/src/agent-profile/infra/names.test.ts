import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentProfileError } from "../errors.ts";
import { assertInside, assertSafeSegment } from "./names.ts";

function code(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    assert.ok(error instanceof AgentProfileError, "an AgentProfileError");
    return error.code;
  }
}

test("assertSafeSegment refuses separators, NUL, .., leading dots and empty", () => {
  for (const ok of ["review", "my-skill", "a.b", "x_y", "CAPS"]) {
    assert.equal(code(() => assertSafeSegment(ok)), null, ok);
  }
  for (const bad of ["", "a/b", "a\\b", "a\0b", "..", "a..b", ".hidden", "."]) {
    assert.equal(code(() => assertSafeSegment(bad)), "INVALID_NAME", JSON.stringify(bad));
  }
});

test("assertInside resolves symlinks and refuses escapes", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orquester-profile-names-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inside = join(root, "tree");
  const outside = join(root, "elsewhere");
  await mkdir(join(inside, "sub"), { recursive: true });
  await mkdir(outside);
  await symlink(outside, join(inside, "escape"));

  assert.equal(await assertInside(inside, join(inside, "sub", "new.md")), join(inside, "sub", "new.md"));
  await assert.rejects(assertInside(inside, join(inside, "..", "elsewhere")), { code: "INVALID_REQUEST" });
  await assert.rejects(assertInside(inside, join(inside, "escape", "file")), { code: "INVALID_REQUEST" });
});
