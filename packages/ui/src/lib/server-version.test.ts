import assert from "node:assert/strict";
import { test } from "node:test";
import { serverVersionLabel } from "./server-version.ts";

test("serverVersionLabel shows only the short commit, never the package version", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const deployed = { version: "0.0.0", commit: sha };
  const noCommit = { version: "1.2.3", commit: null };
  assert.equal(serverVersionLabel(deployed), "0123456");
  assert.equal(serverVersionLabel(noCommit), null);
  assert.equal(serverVersionLabel({ commit: "not a sha" }), null);
  assert.equal(serverVersionLabel({}), null, "an older daemon reports no commit");
  assert.equal(serverVersionLabel(null), null);
});
