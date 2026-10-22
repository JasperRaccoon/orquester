import assert from "node:assert/strict";
import { test } from "node:test";
import { serverVersionLabel } from "./server-version.ts";

test("serverVersionLabel shows the version and short commit, either alone, or nothing", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(serverVersionLabel({ version: "1.2.3", commit: sha }), "1.2.3 · 0123456");
  assert.equal(serverVersionLabel({ version: "1.2.3", commit: null }), "1.2.3");
  assert.equal(serverVersionLabel({ version: null, commit: sha }), "0123456");
  assert.equal(serverVersionLabel({ commit: "not a sha" }), null);
  assert.equal(serverVersionLabel({}), null, "an older daemon reports neither");
  assert.equal(serverVersionLabel(null), null);
});
