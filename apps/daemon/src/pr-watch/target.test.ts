import assert from "node:assert/strict";
import { test } from "node:test";

import { bitbucketCloudProvider } from "../providers/bitbucket-cloud.ts";
import { bitbucketServerProvider } from "../providers/bitbucket-server.ts";
import { githubProvider } from "../providers/github.ts";
import { parsePullRequestUrl, targetInRemote } from "./target.ts";

test("a GitHub pull request URL, with any tab, query or fragment", () => {
  for (const url of [
    "https://github.com/Octo-Org/hello-world/pull/42",
    "https://github.com/Octo-Org/hello-world/pull/42/files",
    "https://github.com/Octo-Org/hello-world/pull/42?w=1#discussion_r1",
    "  https://github.com/Octo-Org/hello-world/pull/42/  "
  ]) {
    const target = parsePullRequestUrl(url);
    assert.deepEqual(target, {
      repoUrl: "https://github.com/Octo-Org/hello-world",
      repoKey: "github.com/octo-org/hello-world",
      repository: "Octo-Org/hello-world",
      number: 42
    }, url);
    assert.deepEqual(githubProvider.parseRepoUrl(target!.repoUrl, {}), { owner: "Octo-Org", repo: "hello-world" });
  }
});

test("a Bitbucket Cloud pull request URL", () => {
  const target = parsePullRequestUrl("https://bitbucket.org/atlassianlabs/atlascode/pull-requests/1115/overview");
  assert.equal(target?.repoUrl, "https://bitbucket.org/atlassianlabs/atlascode");
  assert.equal(target?.number, 1115);
  assert.deepEqual(bitbucketCloudProvider.parseRepoUrl(target!.repoUrl, {}), { owner: "atlassianlabs", repo: "atlascode" });
});

test("a Bitbucket Server pull request URL becomes the repository's browse URL", () => {
  const target = parsePullRequestUrl("https://bb.corp.example/bitbucket/projects/PRJ/repos/api/pull-requests/101/overview");
  assert.equal(target?.repoUrl, "https://bb.corp.example/bitbucket/projects/PRJ/repos/api/browse");
  assert.equal(target?.repoKey, "bb.corp.example/prj/api");
  assert.deepEqual(bitbucketServerProvider.parseRepoUrl(target!.repoUrl, { baseUrl: "https://bb.corp.example/bitbucket" }), {
    owner: "PRJ",
    repo: "api"
  });
  const personal = parsePullRequestUrl("https://bb.corp.example/users/jdoe/repos/tools/pull-requests/7");
  assert.equal(personal?.repoUrl, "https://bb.corp.example/users/jdoe/repos/tools/browse");
  assert.equal(personal?.repoKey, "bb.corp.example/~jdoe/tools");
});

test("credentials in a URL never reach the target", () => {
  const target = parsePullRequestUrl("https://ghp_secret@github.com/o/r/pull/3");
  assert.equal(target?.repoUrl, "https://github.com/o/r");
});

test("anything else is not a pull request URL", () => {
  for (const url of [
    "",
    "github.com/o/r/pull/1",
    "https://github.com/o/r/issues/1",
    "https://github.com/o/r/pull/0",
    "https://github.com/o/r/pull/abc",
    "file:///etc/passwd",
    "https://github.com/pull/1",
    `https://github.com/o/r/pull/1${"x".repeat(2_000)}`
  ]) {
    assert.equal(parsePullRequestUrl(url), null, url);
  }
});

test("a number resolves against the project's remote, ssh or https", () => {
  assert.deepEqual(targetInRemote("git@github.com:o/r.git", 9), {
    repoUrl: "git@github.com:o/r.git",
    repoKey: "github.com/o/r",
    repository: "o/r",
    number: 9
  });
  assert.equal(targetInRemote("https://x-token@github.com/o/r.git", 9)?.repoUrl, "https://github.com/o/r.git");
  assert.equal(targetInRemote("git@github.com:o/r.git", 0), null);
  assert.equal(targetInRemote("not a remote", 3), null);
});
