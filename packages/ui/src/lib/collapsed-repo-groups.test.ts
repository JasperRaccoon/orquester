import test from "node:test";
import assert from "node:assert/strict";

import { parseCollapsedRepoGroups } from "./collapsed-repo-groups.ts";

const keys = (raw: unknown) => [...parseCollapsedRepoGroups(raw)];

test("a stored JSON list of repo keys is the collapsed set", () => {
  assert.deepEqual(keys(JSON.stringify(["github.com/o/a", "gitlab.com/g/sub/b"])), [
    "github.com/o/a",
    "gitlab.com/g/sub/b"
  ]);
  assert.deepEqual(keys(JSON.stringify(["github.com/o/a", "github.com/o/a"])), ["github.com/o/a"]);
});

test("anything that is not a list of repo keys starts every group expanded", () => {
  for (const raw of [null, undefined, "", "not json", "{}", '"github.com/o/a"', "42", 7, ["github.com/o/a"]]) {
    assert.deepEqual(keys(raw), []);
  }
});

test("entries that are not repo keys are dropped, the rest kept", () => {
  const raw = JSON.stringify([
    "github.com/o/a",
    "/home/me/repo",
    "C:/repo",
    "github.com/O/Upper",
    "github.com/o/../x",
    "repo",
    42,
    null,
    { repoKey: "github.com/o/b" },
    "github.com/o/b"
  ]);
  assert.deepEqual(keys(raw), ["github.com/o/a", "github.com/o/b"]);
});

test("a runaway list is bounded", () => {
  const many = Array.from({ length: 501 }, (_, i) => `github.com/o/r${i}`);
  assert.equal(parseCollapsedRepoGroups(JSON.stringify(many)).size, 500);
});
