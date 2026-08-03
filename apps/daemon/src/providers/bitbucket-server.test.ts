import assert from "node:assert/strict";
import test from "node:test";

import {
  bitbucketServerProvider,
  parseServerRepoUrl,
  pickCloneUrls,
  serverVersionSupportsEd25519
} from "./bitbucket-server";

const ctx = { baseUrl: "https://bb.corp.com/bitbucket", sshHost: "bb.corp.com:7999" };

test("parseRepoUrl accepts scm/ssh/browse/personal/shorthand forms anchored to the account", () => {
  assert.deepEqual(parseServerRepoUrl("https://bb.corp.com/bitbucket/scm/PRJ/repo.git", ctx), {
    owner: "PRJ",
    repo: "repo"
  });
  assert.deepEqual(parseServerRepoUrl("ssh://git@bb.corp.com:7999/PRJ/repo.git", ctx), {
    owner: "PRJ",
    repo: "repo"
  });
  assert.deepEqual(
    parseServerRepoUrl("https://bb.corp.com/bitbucket/projects/PRJ/repos/repo/browse", ctx),
    { owner: "PRJ", repo: "repo" }
  );
  assert.deepEqual(
    parseServerRepoUrl("https://bb.corp.com/bitbucket/users/jdoe/repos/site/browse", ctx),
    { owner: "~jdoe", repo: "site" }
  );
  assert.deepEqual(parseServerRepoUrl("PRJ/repo", ctx), { owner: "PRJ", repo: "repo" });
  assert.deepEqual(parseServerRepoUrl("~jdoe/site", ctx), { owner: "~jdoe", repo: "site" });
  assert.equal(parseServerRepoUrl("https://other-host.com/scm/PRJ/repo.git", ctx), null);
  assert.equal(parseServerRepoUrl("https://github.com/o/r", ctx), null);
});

test("pickCloneUrls tolerates name:'http' meaning https and missing ssh", () => {
  assert.deepEqual(
    pickCloneUrls([
      { name: "http", href: "https://bb.corp.com/bitbucket/scm/PRJ/repo.git" },
      { name: "ssh", href: "ssh://git@bb.corp.com:7999/PRJ/repo.git" }
    ]),
    {
      https: "https://bb.corp.com/bitbucket/scm/PRJ/repo.git",
      ssh: "ssh://git@bb.corp.com:7999/PRJ/repo.git"
    }
  );
  assert.deepEqual(pickCloneUrls([{ name: "http", href: "https://h/scm/P/r.git" }]), {
    https: "https://h/scm/P/r.git",
    ssh: undefined
  });
});

test("credential host includes non-standard ports; strips creds embedded by the API", () => {
  assert.deepEqual(bitbucketServerProvider.credentialSpec({ ...ctx, login: "jdoe" }), {
    host: "bb.corp.com",
    username: "jdoe"
  });
  assert.deepEqual(
    bitbucketServerProvider.credentialSpec({ baseUrl: "https://bb.corp.com:8443/bb", login: "jdoe" }),
    { host: "bb.corp.com:8443", username: "jdoe" }
  );
});

test("ed25519 version gate", () => {
  assert.equal(serverVersionSupportsEd25519("10.4.0"), true);
  assert.equal(serverVersionSupportsEd25519("6.6.1"), true);
  assert.equal(serverVersionSupportsEd25519("6.5.9"), false);
  assert.equal(serverVersionSupportsEd25519("garbage"), true); // unknown → assume modern
});

test("sshProbe uses the account sshHost and reports HTTPS-only when absent", () => {
  const probe = bitbucketServerProvider.sshProbe({ ...ctx, login: "jdoe" })!;
  assert.equal(probe.target, "git@bb.corp.com");
  assert.equal(probe.port, 7999);
  assert.equal(bitbucketServerProvider.sshProbe({ baseUrl: ctx.baseUrl, login: "jdoe" }), null);
});
