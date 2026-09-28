import assert from "node:assert/strict";
import test from "node:test";

import { repoForUrl } from "./RepoPicker.tsx";

const repos = [
  { fullName: "acme/api", owner: "acme", name: "api", private: true, sshUrl: "git@github.com:acme/api.git", httpsUrl: "https://github.com/acme/api.git", defaultBranch: "main", description: null },
  { fullName: "acme/web", owner: "acme", name: "web", private: false, sshUrl: "git@github.com:acme/web.git", defaultBranch: "dev", description: null }
];

test("a stored clone URL maps back to the repo it was picked from", () => {
  assert.equal(repoForUrl(repos, "git@github.com:acme/api.git")?.fullName, "acme/api");
  assert.equal(repoForUrl(repos, "https://github.com/acme/api.git")?.fullName, "acme/api");
  assert.equal(repoForUrl(repos, " acme/web ")?.fullName, "acme/web");
});

test("a typed URL no listed repo has, an empty value, or no list picks nothing", () => {
  assert.equal(repoForUrl(repos, "git@github.com:other/x.git"), null);
  assert.equal(repoForUrl(repos, ""), null);
  assert.equal(repoForUrl(null, "git@github.com:acme/api.git"), null);
});
