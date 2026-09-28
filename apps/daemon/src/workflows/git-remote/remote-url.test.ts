import assert from "node:assert/strict";
import test from "node:test";

import { redactUrlUserinfo, remoteUrlProblem, repoDisplayName, repoKeyOf, stripUrlCredentials } from "./remote-url";

test("repoKeyOf: every GitHub form of one repo has one key", () => {
  const forms = [
    "https://github.com/Octo-Org/Hello-World",
    "https://github.com/Octo-Org/Hello-World.git",
    "https://github.com/octo-org/hello-world/",
    "https://GitHub.com/octo-org/hello-world.git/",
    "http://github.com/octo-org/hello-world",
    "https://octocat@github.com/octo-org/hello-world.git",
    "https://x-access-token:ghp_secret@github.com/octo-org/hello-world.git",
    "https://github.com:443/octo-org/hello-world.git",
    "https://github.com/octo-org/hello-world/tree/main/src",
    "git@github.com:octo-org/hello-world.git",
    "git@github.com:octo-org/hello-world",
    "github.com:octo-org/hello-world.git",
    "ssh://git@github.com/octo-org/hello-world.git",
    "ssh://git@ssh.github.com:443/octo-org/hello-world.git",
    "git://github.com/octo-org/hello-world.git",
    "  https://github.com/octo-org/hello-world.git  "
  ];
  for (const form of forms) {
    assert.equal(repoKeyOf(form), "github.com/octo-org/hello-world", form);
  }
});

test("repoKeyOf: Bitbucket Cloud's old and new SSH hosts are one host", () => {
  for (const form of [
    "https://bitbucket.org/acme/web-app.git",
    "https://jdoe@bitbucket.org/acme/web-app.git",
    "git@bitbucket.org:acme/web-app.git",
    "git@ssh.bitbucket.org:acme/web-app.git",
    "ssh://git@ssh.bitbucket.org/acme/web-app.git",
    "https://bitbucket.org/acme/web-app/src/main/"
  ]) {
    assert.equal(repoKeyOf(form), "bitbucket.org/acme/web-app", form);
  }
});

test("repoKeyOf: Bitbucket Server/DC forms reduce to host/project/repo", () => {
  for (const form of [
    "https://bb.corp.example/bitbucket/scm/PRJ/api.git",
    "https://jdoe@bb.corp.example:8443/bitbucket/scm/prj/api.git",
    "https://bb.corp.example/scm/PRJ/api",
    "ssh://git@bb.corp.example:7999/PRJ/api.git",
    "https://bb.corp.example/bitbucket/projects/PRJ/repos/api/browse",
    "https://bb.corp.example/bitbucket/projects/PRJ/repos/api/browse/src/main.ts"
  ]) {
    assert.equal(repoKeyOf(form), "bb.corp.example/prj/api", form);
  }
  assert.equal(repoKeyOf("https://bb.corp.example/bitbucket/users/jdoe/repos/site/browse"), "bb.corp.example/~jdoe/site");
  assert.equal(repoKeyOf("ssh://git@bb.corp.example:7999/~jdoe/site.git"), "bb.corp.example/~jdoe/site");
});

test("repoKeyOf: other hosts keep their whole path (GitLab subgroups)", () => {
  assert.equal(repoKeyOf("https://gitlab.com/group/sub/repo.git"), "gitlab.com/group/sub/repo");
  assert.equal(repoKeyOf("git@gitlab.com:group/sub/repo.git"), "gitlab.com/group/sub/repo");
});

test("repoKeyOf: refuses what git would not be handed", () => {
  for (const bad of [
    "",
    "octo-org/hello-world",
    "https://github.com/only-owner",
    "file:///tmp/repo",
    "/tmp/repo",
    "ext::sh -c touch% /tmp/pwned",
    "--upload-pack=touch /tmp/x",
    "https://github.com/o/r\nx",
    "https://github.com/o/r x"
  ]) {
    assert.equal(repoKeyOf(bad), null, JSON.stringify(bad));
  }
});

test("repoDisplayName keeps the original case", () => {
  assert.equal(repoDisplayName("git@github.com:AppsStats/Apps-Stats.git"), "AppsStats/Apps-Stats");
  assert.equal(repoDisplayName("https://bb.corp.example/bitbucket/scm/PRJ/api.git"), "PRJ/api");
  assert.equal(repoDisplayName("https://gitlab.com/group/sub/repo.git"), "group/sub/repo");
  assert.equal(repoDisplayName("  not a url  "), "not a url");
});

test("remoteUrlProblem accepts the four transports and refuses the rest", () => {
  for (const ok of [
    "https://github.com/o/r.git",
    "http://git.local/o/r.git",
    "ssh://git@host:2222/o/r.git",
    "git://host/o/r.git",
    "git@github.com:o/r.git",
    "host.example:o/r"
  ]) {
    assert.equal(remoteUrlProblem(ok), null, ok);
  }
  for (const bad of ["-uhttps://x", "file:///etc", "ext::sh", "fd::3", "/abs/path", "https://h/o/r\t", "a b:c/d"]) {
    assert.notEqual(remoteUrlProblem(bad), null, bad);
  }
});

test("stripUrlCredentials drops the whole http(s) userinfo (a token may be the user) and an ssh password", () => {
  assert.equal(stripUrlCredentials("https://x-access-token:ghp_secret@github.com/o/r.git"), "https://github.com/o/r.git");
  assert.equal(stripUrlCredentials("https://ghp_secret@github.com/o/r.git"), "https://github.com/o/r.git");
  assert.equal(stripUrlCredentials("https://:tok@github.com/o/r.git"), "https://github.com/o/r.git");
  assert.equal(stripUrlCredentials("https://jdoe@bitbucket.org/a/b.git"), "https://bitbucket.org/a/b.git");
  assert.equal(stripUrlCredentials("git://tok@example.com/a/b.git"), "git://example.com/a/b.git");
  assert.equal(stripUrlCredentials("ssh://git@github.com/o/r.git"), "ssh://git@github.com/o/r.git");
  assert.equal(stripUrlCredentials("ssh://git:pw@github.com/o/r.git"), "ssh://git@github.com/o/r.git");
  assert.equal(stripUrlCredentials("git@github.com:o/r.git"), "git@github.com:o/r.git");
});

test("redactUrlUserinfo hides a token user in http(s) text and a password anywhere, keeps ssh logins", () => {
  assert.equal(
    redactUrlUserinfo("fatal: unable to access 'https://ghp_secret@github.com/o/r.git/': 403"),
    "fatal: unable to access 'https://***@github.com/o/r.git/': 403"
  );
  assert.equal(redactUrlUserinfo("see https://u:p@h/x"), "see https://***@h/x");
  assert.equal(redactUrlUserinfo("ssh://git@github.com/o/r"), "ssh://git@github.com/o/r");
  assert.equal(redactUrlUserinfo("no url here"), "no url here");
});
