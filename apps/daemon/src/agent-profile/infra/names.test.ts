import assert from "node:assert/strict";
import test from "node:test";
import { AgentProfileError } from "../errors.ts";
import { assertSafeSegment } from "./names.ts";

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
