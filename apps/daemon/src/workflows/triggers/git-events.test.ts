import assert from "node:assert/strict";
import test from "node:test";
import type { PullRequestInfo } from "../../providers/types.ts";
import { detectPullRequests, detectPush, pushFired, sameSha } from "./git-events.ts";
import { matchesAnyGlob, matchesGlob } from "./glob.ts";

test("glob: anchored, `*` stops at `/`, `**` crosses it, `?` is one character", () => {
  assert.equal(matchesGlob("main", "main"), true);
  assert.equal(matchesGlob("main", "main/old"), false);
  assert.equal(matchesGlob("release/*", "release/1.0"), true);
  assert.equal(matchesGlob("release/*", "release/1.0/hotfix"), false);
  assert.equal(matchesGlob("release/*", "x/release/1.0"), false);
  assert.equal(matchesGlob("release/**", "release/1.0/hotfix"), true);
  assert.equal(matchesGlob("**", "any/thing"), true);
  assert.equal(matchesGlob("***", "any/thing"), true);
  assert.equal(matchesGlob("release/****/fix*", "release/1.0/hot/fix123"), true);
  assert.equal(matchesGlob("release/*?*", "release/1.0/hotfix"), false);
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
  assert.equal(matchesGlob(`${"*a".repeat(60)}b`, "a".repeat(1000)), false);
});

test("sameSha compares an abbreviation (Bitbucket Cloud's 12 hex) as a prefix", () => {
  const full = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(sameSha(full, full.slice(0, 12)), true);
  assert.equal(sameSha(full.slice(0, 12).toUpperCase(), full), true);
  assert.equal(sameSha(full, `f${full.slice(1)}`), false);
  assert.equal(sameSha("abc", "abcdef"), false, "too short to be an abbreviation");
});

test("pushFired keeps the newest 1000", () => {
  assert.deepEqual(pushFired([], []), []);
  assert.deepEqual(pushFired(["a"], ["b"]), ["a", "b"]);
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
  const next = detectPullRequests(event, { baselined: true, seen: base.seen }, [pr(11, "merged", "b".repeat(40)), pr(3, "merged", "c".repeat(40))], repo);
  assert.deepEqual(
    next.events.map((e) => [e.payload.pr!.number, e.payload.pr!.action]),
    [[11, "opened"], [11, "merged"]]
  );
});

test("pull requests: a lower-numbered new PR walked after a higher one still opens (the mark is the page's base)", () => {
  const repo = { url: "https://github.com/o/r", name: "o/r" };
  const event = { kind: "pull_request" as const, actions: ["opened" as const] };
  const base = detectPullRequests(event, { baselined: false, seen: {} }, [pr(10, "open", "a".repeat(40))], repo);
  // Newest-updated first on the wire: #11 was updated after #12 was opened, so #12 is walked first.
  const next = detectPullRequests(
    event,
    { baselined: true, seen: base.seen },
    [pr(11, "open", "b".repeat(40)), pr(12, "open", "c".repeat(40))],
    repo
  );
  assert.deepEqual(next.events.map((e) => e.payload.pr!.number), [12, 11]);
});

test("pull requests: dedup keys name the transition — a force-push rollback and a second close after a reopen fire", () => {
  const repo = { url: "https://github.com/o/r", name: "o/r" };
  const event = { kind: "pull_request" as const, actions: ["updated" as const, "closed" as const] };
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  let seen = detectPullRequests(event, { baselined: false, seen: {} }, [pr(5, "open", A)], repo).seen;
  const fired = new Set<string>();
  const step = (items: PullRequestInfo[]) => {
    const detection = detectPullRequests(event, { baselined: true, seen }, items, repo);
    seen = detection.seen;
    const fresh = detection.events.filter((e) => !fired.has(e.key));
    for (const e of fresh) fired.add(e.key);
    return fresh.map((e) => [e.payload.pr!.action, e.payload.pr!.headSha]);
  };
  assert.deepEqual(step([pr(5, "open", B)]), [["updated", B]]);
  assert.deepEqual(step([pr(5, "open", A)]), [["updated", A]], "the rollback is an update too");
  assert.deepEqual(step([pr(5, "closed", A)]), [["closed", A]]);
  assert.deepEqual(step([pr(5, "open", A)]), [], "a reopen is no configured action");
  assert.deepEqual(step([pr(5, "closed", A)]), [["closed", A]], "closed again after the reopen");
  // An old-format seen value (no cycle) still parses.
  const legacy = detectPullRequests(event, { baselined: true, seen: { "pr:5": `open:${A}`, "@high": "5" } }, [pr(5, "open", B)], repo);
  assert.deepEqual(legacy.events.map((e) => [e.payload.pr!.action, e.payload.pr!.headSha]), [["updated", B]]);
});

test("push: a force-push rollback (A..B then B..A) is a new dedup key, not a repeat of the first push to A", () => {
  const repo = { url: "https://github.com/o/r", name: "o/r" };
  const event = { kind: "push" as const, branches: ["main"] };
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const refs = (sha: string) => ({ heads: { main: sha }, tags: {} });
  const base = detectPush(event, { baselined: false, seen: {} }, refs(A), undefined, repo)!;
  const toB = detectPush(event, { baselined: true, seen: base.seen }, refs(B), undefined, repo)!;
  const back = detectPush(event, { baselined: true, seen: toB.seen }, refs(A), undefined, repo)!;
  assert.deepEqual(toB.events.map((e) => [e.payload.previousSha, e.payload.sha]), [[A, B]]);
  assert.deepEqual(back.events.map((e) => [e.payload.previousSha, e.payload.sha]), [[B, A]]);
  assert.notEqual(toB.events[0]!.key, back.events[0]!.key);
  // A pre-upgrade ring key for A never matches the rollback's key.
  assert.notEqual(back.events[0]!.key, `push:refs/heads/main:${A}`);
});
