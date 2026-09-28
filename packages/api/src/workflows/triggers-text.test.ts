import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { repoDisplayName } from "./triggers-text.ts";

describe("repoDisplayName", () => {
  it("reads owner/repo from any clone URL", () => {
    assert.equal(repoDisplayName("https://github.com/a/b.git"), "a/b");
    assert.equal(repoDisplayName("https://github.com/a/b/"), "a/b");
    assert.equal(repoDisplayName("git@ssh.bitbucket.org:team/repo.git"), "team/repo");
    assert.equal(repoDisplayName("ssh://git@host:7999/proj/repo.git"), "proj/repo");
    assert.equal(repoDisplayName("https://git.example.com/scm/PROJ/repo.git"), "PROJ/repo");
    assert.equal(repoDisplayName("repo"), "repo");
  });
});
