import assert from "node:assert/strict";
import test from "node:test";
import { githubProvider } from "./github";

test("parseRepoUrl accepts https, ssh and shorthand forms", () => {
  const ctx = {};
  assert.deepEqual(githubProvider.parseRepoUrl("https://github.com/o/r", ctx), { owner: "o", repo: "r" });
  assert.deepEqual(githubProvider.parseRepoUrl("git@github.com:o/r.git", ctx), { owner: "o", repo: "r" });
  assert.deepEqual(githubProvider.parseRepoUrl("o/r", ctx), { owner: "o", repo: "r" });
  assert.equal(githubProvider.parseRepoUrl("https://bitbucket.org/o/r", ctx), null);
});

test("credentialSpec and sshProbe match today's behavior", () => {
  assert.deepEqual(githubProvider.credentialSpec({ login: "octo" }), { host: "github.com", username: "octo" });
  const probe = githubProvider.sshProbe({ login: "octo" })!;
  assert.equal(probe.target, "git@github.com");
  assert.deepEqual(probe.parse("Hi octo! You've successfully authenticated"), {
    ok: true,
    login: "octo",
    message: "Hi octo! You've successfully authenticated"
  });
});

test("cloneUrls derives both transports", async () => {
  assert.deepEqual(await githubProvider.cloneUrls({ token: "t" }, { owner: "o", repo: "r" }), {
    ssh: "git@github.com:o/r.git",
    https: "https://github.com/o/r.git"
  });
});
