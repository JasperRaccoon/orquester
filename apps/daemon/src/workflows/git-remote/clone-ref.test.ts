import assert from "node:assert/strict";
import test from "node:test";

import {
  checkoutArgs,
  cloneArgs,
  cloneRefProblem,
  fetchCommitArgs,
  isFullSha,
  isMissingRemoteRef,
  mayBeAbbreviatedSha
} from "./clone-ref";

const SHA = "6dcb09b5b57875f334f61aebed695e2e4193db5e";

test("cloneRefProblem accepts branches, tags and shas", () => {
  for (const ok of ["main", "feature/retry", "v1.2.3", "release-2026.09", SHA, "a".repeat(250)]) {
    assert.equal(cloneRefProblem(ok), null, ok);
  }
});

test("cloneRefProblem refuses empty, long, option-like, whitespace and control characters", () => {
  for (const bad of [
    "",
    "a".repeat(251),
    "-b",
    "--upload-pack=x",
    "has space",
    "tab\there",
    "new\nline",
    "nul\u0000",
    "del\u007f",
    42,
    null
  ]) {
    assert.notEqual(cloneRefProblem(bad), null, JSON.stringify(bad));
  }
});

test("sha detection: only full ids skip --branch; short hex may be either", () => {
  assert.equal(isFullSha(SHA), true);
  assert.equal(isFullSha("b".repeat(64)), true);
  assert.equal(isFullSha(SHA.slice(0, 12)), false);
  assert.equal(mayBeAbbreviatedSha(SHA.slice(0, 7)), true);
  assert.equal(mayBeAbbreviatedSha("20260928"), true);
  assert.equal(mayBeAbbreviatedSha(SHA), false);
  assert.equal(mayBeAbbreviatedSha("main"), false);
  assert.equal(mayBeAbbreviatedSha("abc12"), false);
});

test("cloneArgs: a name rides --branch, a sha and no ref clone plainly, the URL follows --", () => {
  assert.deepEqual(cloneArgs("git@github.com:o/r.git", "r"), ["clone", "--", "git@github.com:o/r.git", "r"]);
  assert.deepEqual(cloneArgs("https://github.com/o/r.git", "wf-x", "v1.2.3"), [
    "clone",
    "--branch",
    "v1.2.3",
    "--",
    "https://github.com/o/r.git",
    "wf-x"
  ]);
  assert.deepEqual(cloneArgs("https://github.com/o/r.git", "wf-x", SHA), [
    "clone",
    "--",
    "https://github.com/o/r.git",
    "wf-x"
  ]);
  assert.deepEqual(checkoutArgs(SHA), ["checkout", "--detach", SHA]);
  assert.deepEqual(fetchCommitArgs(SHA), ["fetch", "origin", SHA]);
});

test("isMissingRemoteRef recognises git's messages", () => {
  assert.equal(isMissingRemoteRef("warning: Could not find remote branch nope to clone.\nfatal: Remote branch nope not found in upstream origin"), true);
  assert.equal(isMissingRemoteRef("fatal: couldn't find remote ref deadbeef"), true);
  assert.equal(isMissingRemoteRef("fatal: Authentication failed"), false);
});

test("resolveAbbreviatedSha: one commit by prefix, null when none or ambiguous", async () => {
  const { resolveAbbreviatedSha } = await import("./clone-ref");
  const a = `abcdef012345${"0".repeat(28)}`;
  const b = `abcdef012345${"1".repeat(28)}`;
  const listing = `${a}\trefs/heads/main\n${a}\tHEAD\n${"9".repeat(40)}\trefs/tags/v1\n`;
  assert.equal(resolveAbbreviatedSha(listing, "ABCDEF012345"), a);
  assert.equal(resolveAbbreviatedSha(listing, "123456789abc"), null);
  assert.equal(resolveAbbreviatedSha(`${listing}${b}\trefs/pull/1/head\n`, "abcdef012345"), null);
});
