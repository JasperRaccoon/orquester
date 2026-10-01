import assert from "node:assert/strict";
import test from "node:test";

import { AccountError } from "../account-error";
import { bitbucketServerProvider, serverVersionSupportsEd25519 } from "./bitbucket-server";
import { GitRemoteError } from "./types";

const ctx = { baseUrl: "https://bb.corp.com/bitbucket", sshHost: "bb.corp.com:7999" };

test("parseRepoUrl accepts scm/ssh/browse/personal/shorthand forms anchored to the account", () => {
  assert.deepEqual(bitbucketServerProvider.parseRepoUrl("https://bb.corp.com/bitbucket/scm/PRJ/repo.git", ctx), {
    owner: "PRJ",
    repo: "repo"
  });
  assert.deepEqual(bitbucketServerProvider.parseRepoUrl("ssh://git@bb.corp.com:7999/PRJ/repo.git", ctx), {
    owner: "PRJ",
    repo: "repo"
  });
  assert.deepEqual(
    bitbucketServerProvider.parseRepoUrl("https://bb.corp.com/bitbucket/projects/PRJ/repos/repo/browse", ctx),
    { owner: "PRJ", repo: "repo" }
  );
  assert.deepEqual(
    bitbucketServerProvider.parseRepoUrl("https://bb.corp.com/bitbucket/users/jdoe/repos/site/browse", ctx),
    { owner: "~jdoe", repo: "site" }
  );
  assert.deepEqual(bitbucketServerProvider.parseRepoUrl("PRJ/repo", ctx), { owner: "PRJ", repo: "repo" });
  assert.deepEqual(bitbucketServerProvider.parseRepoUrl("~jdoe/site", ctx), { owner: "~jdoe", repo: "site" });
  assert.equal(bitbucketServerProvider.parseRepoUrl("https://other-host.com/scm/PRJ/repo.git", ctx), null);
  assert.equal(bitbucketServerProvider.parseRepoUrl("https://github.com/o/r", ctx), null);
});

test("parseRepoUrl accepts the https form with the embedded username the Clone dialog copies", () => {
  // DC's "Clone" button yields https://<username>@host/context/scm/KEY/slug.git
  assert.deepEqual(bitbucketServerProvider.parseRepoUrl("https://jdoe@bb.corp.com/bitbucket/scm/PRJ/repo.git", ctx), {
    owner: "PRJ",
    repo: "repo"
  });
  assert.deepEqual(
    bitbucketServerProvider.parseRepoUrl("https://jdoe@bb.corp.com/bitbucket/projects/PRJ/repos/repo/browse", ctx),
    { owner: "PRJ", repo: "repo" }
  );
  assert.deepEqual(
    bitbucketServerProvider.parseRepoUrl("https://jdoe@bb.corp.com/bitbucket/users/jdoe/repos/site/browse", ctx),
    { owner: "~jdoe", repo: "site" }
  );
  // Still anchored to this account's instance: userinfo can't smuggle in another host.
  assert.equal(
    bitbucketServerProvider.parseRepoUrl("https://bb.corp.com@evil.example.com/bitbucket/scm/PRJ/repo.git", ctx),
    null
  );
});

test("pickCloneUrls tolerates name:'http' meaning https and missing ssh", async (t) => {
  let clone = [
    { name: "http", href: "https://bb.corp.com/bitbucket/scm/PRJ/repo.git" },
    { name: "ssh", href: "ssh://git@bb.corp.com:7999/PRJ/repo.git" }
  ];
  t.mock.method(globalThis, "fetch", async () => Response.json({ links: { clone } }));
  const creds = { token: "fake", baseUrl: ctx.baseUrl };
  const ref = { owner: "PRJ", repo: "repo" };
  assert.deepEqual(await bitbucketServerProvider.cloneUrls(creds, ref), {
    https: "https://bb.corp.com/bitbucket/scm/PRJ/repo.git",
    ssh: "ssh://git@bb.corp.com:7999/PRJ/repo.git"
  });
  clone = [{ name: "http", href: "https://h/scm/P/r.git" }];
  assert.deepEqual(await bitbucketServerProvider.cloneUrls(creds, ref), {
    https: "https://h/scm/P/r.git", ssh: undefined
  });
  clone = [];
  await assert.rejects(bitbucketServerProvider.cloneUrls(creds, ref),
    (error: unknown) => error instanceof AccountError && error.status === 502);
});

test("an SSH-only instance (HTTP(S) SCM disabled) still yields clone URLs and repo rows", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ isLastPage: true, values: [
    { project: { key: "PRJ" }, slug: "repo", public: false,
      links: { clone: [{ name: "ssh", href: "ssh://git@bb.corp.com:7999/PRJ/repo.git" }] } },
    { project: { key: "PRJ" }, slug: "uncloneable", links: { clone: [] } }
  ] }));
  const repos = await bitbucketServerProvider.listRepos({ token: "fake", baseUrl: ctx.baseUrl });
  assert.deepEqual(repos.map((repo) => ({ ssh: repo.sshUrl, https: repo.httpsUrl, name: repo.fullName })), [
    { ssh: "ssh://git@bb.corp.com:7999/PRJ/repo.git", https: undefined, name: "PRJ/repo" }
  ]);
});

test("ssh:// URLs parse against the baseUrl host when sshHost was never resolved", () => {
  // A brand-new DC account has no repos yet → `sshHost` is undefined, but the
  // repo picker still hands us ssh:// URLs to clone.
  const noSsh = { baseUrl: "https://bb.corp.com/bitbucket" };
  assert.deepEqual(bitbucketServerProvider.parseRepoUrl("ssh://git@bb.corp.com:7999/PRJ/repo.git", noSsh), {
    owner: "PRJ",
    repo: "repo"
  });
  assert.deepEqual(bitbucketServerProvider.parseRepoUrl("ssh://git@bb.corp.com/~jdoe/site.git", noSsh), {
    owner: "~jdoe",
    repo: "site"
  });
  // Still anchored to this account's instance.
  assert.equal(bitbucketServerProvider.parseRepoUrl("ssh://git@evil.example.com:7999/PRJ/repo.git", noSsh), null);
});

test("resolveDcLogin trusts the instance's X-AUSERNAME over the typed username", async (t) => {
  let header: string | undefined;
  t.mock.method(globalThis, "fetch", async () => Response.json({}, {
    headers: header === undefined ? {} : { "X-AUSERNAME": header }
  }));
  const identity = (username: string) => bitbucketServerProvider.getIdentity({ token: "fake", baseUrl: ctx.baseUrl, username });
  for (const [wire, typed, expected] of [
    ["jdoe", "jdoe", "jdoe"], ["JDoe", "jdoe", "JDoe"], ["j%20doe", "j doe", "j doe"], [undefined, "jdoe", "jdoe"]
  ]) {
    header = wire;
    assert.equal((await identity(typed!)).login, expected);
  }
  for (header of ["bob", "anonymous"]) {
    await assert.rejects(identity("alice"),
      (error: unknown) => error instanceof AccountError && error.status === 400);
  }
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

test("SSH key uploads preserve manual fallback, duplicate and algorithm errors", async (t) => {
  let status = 401;
  let message = "rejected";
  t.mock.method(globalThis, "fetch", async () => Response.json({ errors: [{ message }] }, { status }));
  const upload = () => bitbucketServerProvider.uploadSshKey(
    { token: "t", baseUrl: ctx.baseUrl },
    { login: "me", name: "Me", email: "me@example.invalid" },
    "ssh-ed25519 key",
    "test"
  );
  for (status of [401, 403]) {
    assert.deepEqual(await upload(), { manualUrl: `${ctx.baseUrl}/plugins/servlet/ssh/account/keys` });
  }
  for (const [httpStatus, detail, expected] of [
    [409, "duplicate", /already registered/],
    [400, "key algorithm rejected", /fall back to RSA-4096/]
  ] as const) {
    status = httpStatus;
    message = detail;
    await assert.rejects(upload(), (error: unknown) => {
      assert.ok(error instanceof AccountError);
      assert.equal(error.status, httpStatus);
      assert.match(error.message, expected);
      return true;
    });
  }
  status = 500;
  await assert.rejects(upload(), (error: unknown) => {
    assert.ok(error instanceof GitRemoteError);
    assert.equal(error.status, 502);
    assert.equal(error.httpStatus, 500);
    assert.equal(error.kind, "upstream");
    return true;
  });
});
