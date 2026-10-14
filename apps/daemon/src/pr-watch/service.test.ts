// The pull request watch service end to end against a provider fake (one per change kind), a fake
// thread summary and a recording `/turn` delivery, on a manual clock: no real time passes.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";

import type { SessionSummary } from "@orquester/api";
import { parsePullRequestWatchMessage } from "@orquester/api/agent-chat";
import { parsePullRequestWatchFile } from "@orquester/config";

import { GitRemoteError, type PullRequestRemark, type PullRequestStatus } from "../providers/types.ts";
import { PullRequestWatchError } from "./service.ts";
import { chat, check, cleanupHarnesses, harness, prStatus, REMOTE, sessionEvent, START, type Harness } from "./testing.ts";

afterEach(cleanupHarnesses);

/** A read every two minutes, on a pass every 30 s: one more pass covers the next read. */
const POLL = 150_000;

const KEY = `${REMOTE}#12`;

async function watching(h: Harness, status = prStatus()) {
  h.pulls.set(KEY, status);
  const created = await h.service.create("s1", { number: 12 });
  await h.service.idle();
  return created;
}

test("a number is read from the project's origin through its workspace account, and baselined", async () => {
  const h = await harness();
  const created = await watching(h, prStatus({ checks: [check("build", "failure"), check("lint", "success")] }));
  assert.equal(created.created, true);
  assert.deepEqual(h.reads[0], { accountId: "acct-1", repoUrl: REMOTE, number: 12, remarksSince: START });
  assert.equal(created.watch.repository, "acme/app");
  assert.equal(created.watch.url, "https://github.com/acme/app/pull/12");
  assert.deepEqual(created.watch.status?.checks, { total: 2, passed: 1, failed: 1, pending: 0 });
  // The failure the call's answer showed is not news later.
  await h.run(POLL);
  assert.equal(h.reads.length, 2);
  assert.equal(h.delivered.length, 0);
  // Persisted, credential-free.
  const disk = parsePullRequestWatchFile(JSON.parse(readFileSync(h.file, "utf8")));
  assert.equal(disk.watches.length, 1);
  assert.deepEqual(disk.watches[0]!.told.failedChecks, ["build"]);
  assert.equal(h.published.at(-1)?.watches.length, 1);
});

test("a failing check wakes the thread once, persisted before the post, under the automated prefix", async () => {
  const h = await harness();
  await watching(h);
  h.pulls.set(KEY, prStatus({ checks: [check("build", "failure"), check("lint", "success")] }));
  await h.run(POLL);
  assert.equal(h.delivered.length, 1);
  const wake = h.delivered[0]!;
  assert.equal(wake.fileHadIt, true);
  assert.ok(wake.commandId.startsWith("pr-watch:"));
  assert.equal(parsePullRequestWatchMessage(wake.input)?.summary, "#12: checks failed");
  assert.ok(wake.input.includes("- Checks failed on aaaaaaa:\n  - build https://ci/build"));
  // The same state is never reported again.
  h.sessions.set("s1", chat("s1", { latestTurn: { turnId: "t2", state: "completed", startedAt: START, completedAt: START } }));
  await h.run(POLL * 3);
  assert.equal(h.delivered.length, 1);
  const disk = parsePullRequestWatchFile(JSON.parse(readFileSync(h.file, "utf8")));
  assert.equal(disk.watches[0]!.pendingWake, null);
});

test("each change kind wakes once: checks passed, a comment, a review, a conflict", async () => {
  const h = await harness();
  await watching(h);
  const nextTurn = (n: number) =>
    h.sessions.set("s1", chat("s1", { latestTurn: { turnId: `t${n}`, state: "completed", startedAt: START, completedAt: START } }));
  const step = async (status: PullRequestStatus, n: number) => {
    h.pulls.set(KEY, status);
    await h.run(POLL);
    nextTurn(n);
  };

  await step(prStatus({ checks: [check("build", "success"), check("lint", "success")] }), 2);
  const comment: PullRequestRemark = {
    id: "ic:1",
    kind: "comment",
    author: "reviewer",
    body: "Please add a test.",
    createdAt: "2026-10-14T10:03:00.000Z",
    editedAt: null,
    path: null,
    url: "https://github.com/acme/app/pull/12#issuecomment-1",
    reviewState: null
  };
  const own: PullRequestRemark = { ...comment, id: "ic:2", author: "agent-bot", body: "Done." };
  await step(prStatus({ checks: [check("build", "success"), check("lint", "success")], remarks: [comment, own] }), 3);
  const review: PullRequestRemark = { ...comment, id: "rv:1", kind: "review", body: "", reviewState: "approved", createdAt: "2026-10-14T10:05:00.000Z" };
  await step(prStatus({ checks: [check("build", "success"), check("lint", "success")], remarks: [comment, own, review] }), 4);
  await step(prStatus({ checks: [check("build", "success"), check("lint", "success")], remarks: [comment, own, review], mergeability: "conflicting" }), 5);
  // Nothing new: no wake.
  await step(prStatus({ checks: [check("build", "success"), check("lint", "success")], remarks: [comment, own, review], mergeability: "conflicting" }), 6);

  assert.deepEqual(
    h.delivered.map((wake) => parsePullRequestWatchMessage(wake.input)?.summary),
    ["#12: checks passed", "#12: new comments", "#12: new comments", "#12: merge conflict"]
  );
  assert.ok(h.delivered[1]!.input.includes('reviewer: "Please add a test."'));
  assert.ok(!h.delivered[1]!.input.includes("Done."));
  assert.ok(h.delivered[2]!.input.includes("reviewer: approved"));
  assert.ok(h.delivered[3]!.input.includes("The branch now conflicts with main."));
});

test("a busy thread's news waits for its idle point and arrives as one coalesced message", async () => {
  const h = await harness();
  await watching(h);
  h.sessions.set("s1", chat("s1", { chatSessionStatus: "running", latestTurn: { turnId: "t2", state: "running", startedAt: START, completedAt: null } }));
  h.pulls.set(KEY, prStatus({ checks: [check("build", "failure"), check("lint", "success")] }));
  await h.run(POLL);
  assert.equal(h.delivered.length, 0);
  assert.equal(h.service.list("s1")[0]?.wakePending, true);
  h.pulls.set(KEY, prStatus({ checks: [check("build", "failure"), check("lint", "success")], mergeability: "conflicting" }));
  await h.run(POLL);
  assert.equal(h.delivered.length, 0);

  // The turn ends: the next session update is the idle point.
  h.sessions.set("s1", chat("s1", { latestTurn: { turnId: "t2", state: "completed", startedAt: START, completedAt: START } }));
  h.emit(sessionEvent("session.updated", "s1"));
  await h.service.idle();
  assert.equal(h.delivered.length, 1);
  assert.equal(parsePullRequestWatchMessage(h.delivered[0]!.input)?.summary, "#12: checks failed, merge conflict");
  assert.equal(h.service.list("s1")[0]?.wakePending, false);
});

test("approvals, questions and a continuing goal hold a wake too", async () => {
  const h = await harness();
  await watching(h);
  h.pulls.set(KEY, prStatus({ checks: [check("build", "failure"), check("lint", "success")] }));
  for (const busy of [{ hasPendingApprovals: true }, { hasPendingUserInput: true }, { goal: { continuing: true } }, { chatSessionStatus: "error" }]) {
    h.sessions.set("s1", chat("s1", busy as Partial<SessionSummary>));
    await h.run(POLL);
    assert.equal(h.delivered.length, 0, JSON.stringify(busy));
  }
});

test("one wake per idle point: after a send, the next waits for the thread's turn to move on", async () => {
  const h = await harness();
  await watching(h);
  h.pulls.set(KEY, prStatus({ checks: [check("build", "failure"), check("lint", "success")] }));
  await h.run(POLL);
  assert.equal(h.delivered.length, 1);
  // The summary still shows the old turn (the wake's turn not registered yet), and new news lands.
  h.pulls.set(KEY, prStatus({ checks: [check("build", "failure"), check("lint", "failure")] }));
  await h.run(POLL);
  assert.equal(h.delivered.length, 1);
  // The wake's turn ran and completed: its latest turn moved on.
  h.sessions.set("s1", chat("s1", { latestTurn: { turnId: "t9", state: "completed", startedAt: START, completedAt: START } }));
  h.emit(sessionEvent("session.updated", "s1"));
  await h.service.idle();
  assert.equal(h.delivered.length, 2);
  assert.ok(h.delivered[1]!.input.includes("  - lint https://ci/lint"));
});

test("a merge ends the watch at once and tells the thread; no more reads", async () => {
  const h = await harness();
  await watching(h);
  h.sessions.set("s1", chat("s1", { chatSessionStatus: "running", latestTurn: { turnId: "t2", state: "running", startedAt: START, completedAt: null } }));
  h.pulls.set(KEY, prStatus({ state: "merged", checks: [], remarks: [] }));
  await h.run(POLL);
  assert.deepEqual(h.service.list("s1"), []);
  assert.deepEqual(h.published.at(-1), { sessionId: "s1", watches: [] });
  const readsAtEnd = h.reads.length;
  h.sessions.set("s1", chat("s1", { latestTurn: { turnId: "t2", state: "completed", startedAt: START, completedAt: START } }));
  h.emit(sessionEvent("session.updated", "s1"));
  await h.service.idle();
  assert.equal(h.delivered.length, 1);
  assert.equal(parsePullRequestWatchMessage(h.delivered[0]!.input)?.summary, "#12: merged, stopped watching");
  await h.run(POLL * 3);
  assert.equal(h.reads.length, readsAtEnd);
  assert.deepEqual(parsePullRequestWatchFile(JSON.parse(readFileSync(h.file, "utf8"))).watches, []);
});

test("a close ends the watch with its own message", async () => {
  const h = await harness();
  await watching(h);
  h.pulls.set(KEY, prStatus({ state: "closed", checks: [], remarks: [] }));
  await h.run(POLL);
  assert.equal(h.delivered.length, 1);
  assert.ok(h.delivered[0]!.input.includes("was closed without being merged"));
  assert.ok(h.delivered[0]!.input.includes("watch_pull_request"));
});

test("a wake the host could not take survives a restart and is re-posted under the same id", async () => {
  const h = await harness();
  await watching(h);
  h.outcome.next = () => ({ kind: "unavailable" });
  h.pulls.set(KEY, prStatus({ checks: [check("build", "failure"), check("lint", "success")] }));
  await h.run(POLL);
  assert.equal(h.delivered.length, 1);
  const commandId = h.delivered[0]!.commandId;
  h.outcome.next = () => ({ kind: "sent" });
  await h.restart();
  assert.equal(h.delivered.length, 2);
  assert.equal(h.delivered[1]!.commandId, commandId);
  assert.equal(h.delivered[1]!.input, h.delivered[0]!.input);
  // Restarted, the watch is read again and stays deduplicated.
  await h.run(POLL);
  assert.equal(h.delivered.length, 2);
  assert.equal(h.service.list("s1").length, 1);
});

test("a refusal of the moment is retried, then given up; a deleted thread ends its watches", async () => {
  const h = await harness();
  await watching(h);
  h.outcome.next = () => ({ kind: "refused", retryable: true, message: "compacting" });
  h.pulls.set(KEY, prStatus({ checks: [check("build", "failure"), check("lint", "success")] }));
  await h.run(POLL);
  await h.run(30_000);
  await h.run(30_000);
  assert.equal(h.delivered.length, 3);
  assert.equal(new Set(h.delivered.map((wake) => wake.commandId)).size, 1);
  await h.run(30_000);
  assert.equal(h.delivered.length, 3);

  h.sessions.delete("s1");
  h.emit(sessionEvent("session.closed", "s1"));
  await h.service.idle();
  assert.throws(() => h.service.list("s1"), PullRequestWatchError);
  assert.deepEqual(parsePullRequestWatchFile(JSON.parse(readFileSync(h.file, "utf8"))).watches, []);
});

test("a thread gone while the daemon was away loses its watches at the next pass", async () => {
  const h = await harness();
  await watching(h);
  h.sessions.delete("s1");
  await h.run(30_000);
  assert.deepEqual(parsePullRequestWatchFile(JSON.parse(readFileSync(h.file, "utf8"))).watches, []);
});

test("a rate limit waits as long as the host asks and never counts as a failure", async () => {
  const h = await harness();
  await watching(h);
  h.pulls.set(KEY, new GitRemoteError(429, "rate limited", "rate_limited", 403, 30 * 60_000));
  await h.run(POLL);
  const reads = h.reads.length;
  assert.equal(h.service.list("s1")[0]?.lastError, "rate limited");
  await h.run(20 * 60_000);
  assert.equal(h.reads.length, reads);
  h.pulls.set(KEY, prStatus());
  // 30 min after the refusal, not before: one read in the next 10 min.
  await h.run(10 * 60_000);
  assert.equal(h.reads.length, reads + 1);
  assert.equal(h.service.list("s1")[0]?.lastError, null);
});

test("eight failed reads in a row end the watch and tell the thread", async () => {
  const h = await harness();
  await watching(h);
  h.pulls.set(KEY, new GitRemoteError(400, "GitHub GET … → 401", "auth", 401));
  await h.run(24 * 60 * 60_000);
  assert.deepEqual(h.service.list("s1"), []);
  assert.equal(h.delivered.length, 1);
  assert.ok(h.delivered[0]!.input.includes("failed to read it 8 times in a row (auth rejected)"));
  assert.equal(h.reads.length, 1 + 8);
});

test("stopping a watch drops its news and its reads", async () => {
  const h = await harness();
  const { watch } = await watching(h);
  h.sessions.set("s1", chat("s1", { chatSessionStatus: "running" }));
  h.pulls.set(KEY, prStatus({ checks: [check("build", "failure"), check("lint", "success")] }));
  await h.run(POLL);
  await h.service.remove("s1", watch.id);
  h.sessions.set("s1", chat("s1"));
  h.emit(sessionEvent("session.updated", "s1"));
  await h.run(POLL * 2);
  assert.equal(h.delivered.length, 0);
  assert.equal(h.reads.length, 2);
  await assert.rejects(h.service.remove("s1", watch.id), (error: unknown) => error instanceof PullRequestWatchError && error.code === "WATCH_NOT_FOUND");
});

test("creating: duplicates, the per-thread cap, closed pull requests, unreadable ones, a passing failure", async () => {
  const h = await harness();
  await watching(h);
  const again = await h.service.create("s1", { url: "https://github.com/ACME/app/pull/12/files" });
  assert.equal(again.created, false);

  const refused = async (request: { url?: string; number?: number }, code: string) =>
    assert.rejects(h.service.create("s1", request), (error: unknown) => error instanceof PullRequestWatchError && error.code === code);
  await refused({}, "INVALID_ARGUMENT");
  await refused({ url: "https://github.com/acme/app/pull/1", number: 1 }, "INVALID_ARGUMENT");
  await refused({ url: "https://example.com/nope" }, "INVALID_ARGUMENT");
  await refused({ number: 404 }, "PULL_REQUEST_NOT_FOUND");
  h.pulls.set(`${REMOTE}#13`, prStatus({ number: 13, state: "merged" }));
  await refused({ number: 13 }, "PULL_REQUEST_NOT_OPEN");
  h.pulls.set(`${REMOTE}#14`, new GitRemoteError(400, "bad token", "auth", 401));
  await refused({ number: 14 }, "PULL_REQUEST_UNREADABLE");
  await assert.rejects(h.service.create("nope", { number: 12 }), (error: unknown) => error instanceof PullRequestWatchError && error.code === "THREAD_NOT_FOUND");

  h.pulls.set(`${REMOTE}#15`, new GitRemoteError(502, "GitHub GET → 502", "upstream", 502));
  const blind = await h.service.create("s1", { number: 15 });
  assert.equal(blind.created, true);
  assert.match(blind.note ?? "", /first successful check/);

  for (let n = 20; n < 28; n += 1) {
    h.pulls.set(`${REMOTE}#${n}`, prStatus({ number: n }));
    await h.service.create("s1", { number: n });
  }
  h.pulls.set(`${REMOTE}#30`, prStatus({ number: 30 }));
  await refused({ number: 30 }, "WATCH_LIMIT");
});

test("threads watching one pull request through one account share a read, each told once", async () => {
  const h = await harness();
  h.sessions.set("s2", chat("s2"));
  await watching(h);
  await h.service.create("s2", { number: 12 });
  const before = h.reads.length;
  h.pulls.set(KEY, prStatus({ checks: [check("build", "failure"), check("lint", "success")] }));
  await h.run(POLL);
  assert.equal(h.reads.length, before + 1);
  assert.deepEqual(h.delivered.map((wake) => wake.sessionId).sort(), ["s1", "s2"]);
});
