import assert from "node:assert/strict";
import test from "node:test";

import { bitbucketCloudProvider, toCloudRepoSummary } from "./bitbucket-cloud";

test("parseRepoUrl accepts bitbucket.org https/ssh (old + new host)/shorthand", () => {
  const ctx = {};
  assert.deepEqual(bitbucketCloudProvider.parseRepoUrl("https://bitbucket.org/ws/r", ctx), {
    owner: "ws",
    repo: "r"
  });
  assert.deepEqual(bitbucketCloudProvider.parseRepoUrl("git@bitbucket.org:ws/r.git", ctx), {
    owner: "ws",
    repo: "r"
  });
  assert.deepEqual(bitbucketCloudProvider.parseRepoUrl("git@ssh.bitbucket.org:ws/r.git", ctx), {
    owner: "ws",
    repo: "r"
  });
  assert.deepEqual(bitbucketCloudProvider.parseRepoUrl("ws/r", ctx), { owner: "ws", repo: "r" });
  assert.equal(bitbucketCloudProvider.parseRepoUrl("https://github.com/o/r", ctx), null);
});

test("parseRepoUrl accepts the https form with the embedded username the Clone dialog copies", () => {
  // Bitbucket Cloud's "Clone" button yields https://<nickname>@bitbucket.org/ws/r.git
  const ctx = {};
  assert.deepEqual(
    bitbucketCloudProvider.parseRepoUrl("https://jdoe@bitbucket.org/ws/r.git", ctx),
    { owner: "ws", repo: "r" }
  );
  assert.deepEqual(
    bitbucketCloudProvider.parseRepoUrl("https://x-bitbucket-api-token-auth@bitbucket.org/ws/r", ctx),
    { owner: "ws", repo: "r" }
  );
  // The userinfo segment must not let another host through.
  assert.equal(bitbucketCloudProvider.parseRepoUrl("https://bitbucket.org@evil.com/ws/r", ctx), null);
});

test("cloneUrls always emits the NEW ssh host", async () => {
  assert.deepEqual(
    await bitbucketCloudProvider.cloneUrls({ token: "t" }, { owner: "ws", repo: "r" }),
    { ssh: "git@ssh.bitbucket.org:ws/r.git", https: "https://bitbucket.org/ws/r.git" }
  );
});

test("toCloudRepoSummary rewrites the API's (possibly stale) ssh host and maps fields", () => {
  const s = toCloudRepoSummary({
    full_name: "ws/r",
    slug: "r",
    is_private: true,
    mainbranch: { name: "main" },
    description: null,
    links: {
      clone: [
        { name: "https", href: "https://user@bitbucket.org/ws/r.git" },
        { name: "ssh", href: "git@bitbucket.org:ws/r.git" }
      ]
    }
  });
  assert.equal(s.sshUrl, "git@ssh.bitbucket.org:ws/r.git");
  assert.equal(s.httpsUrl, "https://bitbucket.org/ws/r.git"); // credentials stripped from href
  assert.equal(s.fullName, "ws/r");
  assert.equal(s.owner, "ws");
  assert.equal(s.private, true);
  assert.equal(s.defaultBranch, "main");
});

test("credentialSpec uses the static token username; sshProbe parses the Cloud greeting", () => {
  assert.deepEqual(bitbucketCloudProvider.credentialSpec({ login: "nick" }), {
    host: "bitbucket.org",
    username: "x-bitbucket-api-token-auth"
  });
  const probe = bitbucketCloudProvider.sshProbe({ login: "nick" })!;
  assert.equal(probe.target, "git@ssh.bitbucket.org");
  assert.equal(
    probe.parse(
      "authenticated via ssh key.\nYou can use git to connect to Bitbucket. logged in as nick."
    ).ok,
    true
  );
});
