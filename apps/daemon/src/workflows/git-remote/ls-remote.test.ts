import assert from "node:assert/strict";
import test from "node:test";

import { parseLsRemote } from "./ls-remote";


const A = "19f33c6764993e3cb961341967ac3b3c07579ef0";
const B = "7ada497f806e271f569e1399b5e61d17fcb77cb4";
const C = "6dcb09b5b57875f334f61aebed695e2e4193db5e";

test("parseLsRemote reads heads, lightweight and annotated tags, and the HEAD symref", () => {
  const stdout = [
    "ref: refs/heads/main\tHEAD",
    `${A}\tHEAD`,
    `${A}\trefs/heads/main`,
    `${C}\trefs/heads/feature/retry`,
    `${A}\trefs/pull/1/head`,
    `${C}\trefs/pull/1/merge`,
    `${A}\trefs/tags/v1`,
    `${B}\trefs/tags/v2`,
    `${A}\trefs/tags/v2^{}`,
    ""
  ].join("\n");
  assert.deepEqual(parseLsRemote(stdout), {
    heads: { main: A, "feature/retry": C },
    tags: { v1: { sha: A, commit: A }, v2: { sha: B, commit: A } },
    defaultBranch: "main"
  });
});

test("parseLsRemote: a peeled line before its tag, CRLF, junk and uppercase shas", () => {
  const stdout = [
    `${A}\trefs/tags/rel^{}`,
    `${B.toUpperCase()}\trefs/tags/rel\r`,
    "warning: redirecting to https://example.invalid/",
    "not-a-sha\trefs/heads/x",
    `${A}refs/heads/no-tab`,
    `${A}\trefs/heads/`,
    `${A}\trefs/remotes/origin/main`
  ].join("\n");
  assert.deepEqual(parseLsRemote(stdout), { heads: {}, tags: { rel: { sha: B, commit: A } } });
});

test("parseLsRemote: no HEAD line → no defaultBranch; a __proto__ branch stays an own key", () => {
  const result = parseLsRemote(`${A}\trefs/heads/__proto__\n${C}\trefs/heads/main\n`);
  assert.equal(result.defaultBranch, undefined);
  assert.equal(Object.keys(result.heads).length, 2);
  assert.equal(Object.getOwnPropertyDescriptor(result.heads, "__proto__")?.value, A);
  assert.equal(Object.getPrototypeOf(result.heads), Object.prototype);
});

test("parseLsRemote: SHA-256 object ids", () => {
  const long = "a".repeat(64);
  assert.deepEqual(parseLsRemote(`${long}\trefs/heads/main\n`).heads, { main: long });
});
