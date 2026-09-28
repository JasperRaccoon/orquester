import assert from "node:assert/strict";
import test from "node:test";
import type { PullRequestInfo } from "../../providers/types.ts";
import { detectPullRequests, eventKeyOf, pushFired, sameSha } from "./git-events.ts";
import { matchesAnyGlob, matchesGlob } from "./glob.ts";

test("glob: anchored, `*` stops at `/`, `**` crosses it, `?` is one character", () => {
  assert.equal(matchesGlob("main", "main"), true);
  assert.equal(matchesGlob("main", "main/old"), false);
  assert.equal(matchesGlob("release/*", "release/1.0"), true);
  assert.equal(matchesGlob("release/*", "release/1.0/hotfix"), false);
  assert.equal(matchesGlob("release/*", "x/release/1.0"), false);
  assert.equal(matchesGlob("release/**", "release/1.0/hotfix"), true);
  assert.equal(matchesGlob("**", "any/thing"), true);
  assert.equal(matchesGlob("v*", "v1.2.0"), true);
  assert.equal(matchesGlob("v*", "release-v1"), false);
  assert.equal(matchesGlob("v?.?", "v1.2"), true);
  assert.equal(matchesGlob("v?.?", "v1.10"), false);
  assert.equal(matchesGlob("*-rc*", "v2-rc1"), true);
  assert.equal(matchesGlob("", "main"), false);
  assert.equal(matchesGlob("  ", "main"), false);
  assert.equal(matchesAnyGlob(["dev", "feature/*"], "feature/x"), true);
  assert.equal(matchesAnyGlob([], "main"), false);
  // A hostile pattern stays linear-ish (a DP, no regex backtracking).
  const started = Date.now();
  assert.equal(matchesGlob(`${"*a".repeat(60)}b`, "a".repeat(1000)), false);
  assert.ok(Date.now() - started < 1000);
});

test("sameSha compares an abbreviation (Bitbucket Cloud's 12 hex) as a prefix", () => {
  const full = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(sameSha(full, full.slice(0, 12)), true);
  assert.equal(sameSha(full.slice(0, 12).toUpperCase(), full), true);
  assert.equal(sameSha(full, `f${full.slice(1)}`), false);
  assert.equal(sameSha("abc", "abcdef"), false, "too short to be an abbreviation");
});

test("eventKeyOf ignores order and blanks, changes with the filter", () => {
  assert.equal(eventKeyOf({ kind: "push", branches: ["b", "a", " "] }), eventKeyOf({ kind: "push", branches: ["a", "b"] }));
  assert.notEqual(eventKeyOf({ kind: "push", branches: ["a"] }), eventKeyOf({ kind: "push", branches: [] }));
  assert.notEqual(
    eventKeyOf({ kind: "pull_request", actions: ["opened"] }),
    eventKeyOf({ kind: "pull_request", actions: ["opened"], baseBranches: ["main"] })
  );
});

test("pushFired keeps the newest 1000", () => {
  const ring = pushFired(Array.from({ length: 999 }, (_, i) => `k${i}`), ["a", "b"]);
  assert.equal(ring.length, 1000);
  assert.equal(ring[0], "k1");
  assert.equal(ring.at(-1), "b");
});

function pr(number: number, state: PullRequestInfo["state"], headSha: string, extra: Partial<PullRequestInfo> = {}): PullRequestInfo {
  return {
    number,
    title: `PR ${number}`,
    body: "",
    url: `https://github.com/o/r/pull/${number}`,
    author: "dev",
    head: `feature/${number}`,
    base: "main",
    headSha,
    state,
    updatedAt: "2026-09-28T10:00:00.000Z",
    ...extra
  };
}

test("pull requests: an old PR scrolling into the page is recorded silently; one opened and merged between polls yields both", () => {
  const repo = { url: "https://github.com/o/r", name: "o/r" };
  const event = { kind: "pull_request" as const, actions: ["opened" as const, "merged" as const] };
  const base = detectPullRequests(event, { baselined: false, seen: {} }, [pr(10, "open", "a".repeat(40))], repo);
  assert.equal(base.events.length, 0);
  assert.equal(base.seen["@high"], "10");
  const next = detectPullRequests(event, { baselined: true, seen: base.seen }, [pr(11, "merged", "b".repeat(40)), pr(3, "merged", "c".repeat(40))], repo);
  assert.deepEqual(
    next.events.map((e) => e.key),
    [`pr:11:opened:${"b".repeat(40)}`, `pr:11:merged:${"b".repeat(40)}`]
  );
  assert.equal(next.seen["pr:3"], `merged:${"c".repeat(40)}`);
});
