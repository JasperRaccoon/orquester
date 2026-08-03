import assert from "node:assert/strict";
import test from "node:test";

import { AccountError } from "../account-error";
import {
  bitbucketServerProvider,
  describeFetchFailure,
  parseServerRepoUrl,
  pickCloneUrls,
  resolveDcLogin,
  serverVersionSupportsEd25519,
  toServerRepoSummary
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

test("parseRepoUrl accepts the https form with the embedded username the Clone dialog copies", () => {
  // DC's "Clone" button yields https://<username>@host/context/scm/KEY/slug.git
  assert.deepEqual(parseServerRepoUrl("https://jdoe@bb.corp.com/bitbucket/scm/PRJ/repo.git", ctx), {
    owner: "PRJ",
    repo: "repo"
  });
  assert.deepEqual(
    parseServerRepoUrl("https://jdoe@bb.corp.com/bitbucket/projects/PRJ/repos/repo/browse", ctx),
    { owner: "PRJ", repo: "repo" }
  );
  assert.deepEqual(
    parseServerRepoUrl("https://jdoe@bb.corp.com/bitbucket/users/jdoe/repos/site/browse", ctx),
    { owner: "~jdoe", repo: "site" }
  );
  // Still anchored to this account's instance: userinfo can't smuggle in another host.
  assert.equal(
    parseServerRepoUrl("https://bb.corp.com@evil.example.com/bitbucket/scm/PRJ/repo.git", ctx),
    null
  );
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

test("an SSH-only instance (HTTP(S) SCM disabled) still yields clone URLs and repo rows", () => {
  // Admins can disable HTTP(S) access instance-wide: every repo then carries
  // only the `ssh` clone link. That must not fail the whole listing.
  assert.deepEqual(pickCloneUrls([{ name: "ssh", href: "ssh://git@bb.corp.com:7999/PRJ/repo.git" }]), {
    https: undefined,
    ssh: "ssh://git@bb.corp.com:7999/PRJ/repo.git"
  });
  const summary = toServerRepoSummary({
    project: { key: "PRJ" },
    slug: "repo",
    public: false,
    links: { clone: [{ name: "ssh", href: "ssh://git@bb.corp.com:7999/PRJ/repo.git" }] }
  });
  assert.equal(summary?.sshUrl, "ssh://git@bb.corp.com:7999/PRJ/repo.git");
  assert.equal(summary?.httpsUrl, undefined);
  assert.equal(summary?.fullName, "PRJ/repo");
  // A repo with no usable transport at all is skipped, not fatal.
  assert.equal(toServerRepoSummary({ project: { key: "PRJ" }, slug: "repo", links: { clone: [] } }), null);
  assert.throws(() => pickCloneUrls([]), (error: unknown) => error instanceof AccountError);
});

test("ssh:// URLs parse against the baseUrl host when sshHost was never resolved", () => {
  // A brand-new DC account has no repos yet → `sshHost` is undefined, but the
  // repo picker still hands us ssh:// URLs to clone.
  const noSsh = { baseUrl: "https://bb.corp.com/bitbucket" };
  assert.deepEqual(parseServerRepoUrl("ssh://git@bb.corp.com:7999/PRJ/repo.git", noSsh), {
    owner: "PRJ",
    repo: "repo"
  });
  assert.deepEqual(parseServerRepoUrl("ssh://git@bb.corp.com/~jdoe/site.git", noSsh), {
    owner: "~jdoe",
    repo: "site"
  });
  // Still anchored to this account's instance.
  assert.equal(parseServerRepoUrl("ssh://git@evil.example.com:7999/PRJ/repo.git", noSsh), null);
});

test("TLS failures map to an actionable CA hint", () => {
  const tls = describeFetchFailure(
    Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("self-signed certificate"), {
        code: "DEPTH_ZERO_SELF_SIGNED_CERT"
      })
    })
  );
  assert.match(tls, /CA certificate/i);
  assert.match(tls, /DEPTH_ZERO_SELF_SIGNED_CERT/);

  const refused = describeFetchFailure(
    Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })
    })
  );
  assert.match(refused, /ECONNREFUSED/);
  assert.doesNotMatch(refused, /CA certificate/i);

  assert.equal(describeFetchFailure(new Error("boom")), "boom");
});

test("resolveDcLogin trusts the instance's X-AUSERNAME over the typed username", () => {
  assert.equal(resolveDcLogin("jdoe", "jdoe"), "jdoe");
  assert.equal(resolveDcLogin("JDoe", "jdoe"), "JDoe"); // instance casing wins
  assert.equal(resolveDcLogin("j%20doe", "j doe"), "j doe"); // percent-decoded
  assert.equal(resolveDcLogin(null, "jdoe"), "jdoe"); // header absent → typed value
  assert.throws(
    () => resolveDcLogin("bob", "alice"),
    (error: unknown) =>
      error instanceof AccountError && /bob/.test(error.message) && /alice/.test(error.message)
  );
  assert.throws(
    () => resolveDcLogin("anonymous", "alice"),
    (error: unknown) => error instanceof AccountError && error.status === 400
  );
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
