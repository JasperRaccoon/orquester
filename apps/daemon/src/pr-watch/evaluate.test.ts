// Change detection and wording of pull request watches. Ported from T3 Code (MIT):
// `apps/server/src/orchestration-v2/pullRequestWatch.test.ts`, adapted to Orquester's types, plus
// the end-of-watch sections and the one-message-per-wake composition.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PullRequestWatchTold } from "@orquester/config";
import { parsePullRequestWatchMessage } from "@orquester/api/agent-chat";

import type { PullRequestCheck, PullRequestRemark, PullRequestStatus } from "../providers/types.ts";
import { evaluatePullRequestWatch, initialTold, PULL_REQUEST_WATCH_WAKE_LIMIT, pullRequestWakeMessage } from "./evaluate.ts";

const STARTED = "2026-10-02T12:00:00.000Z";
const VIEWER = ["agent-user"];

const watch = (overrides: Partial<PullRequestWatchTold> = {}): PullRequestWatchTold => ({ ...initialTold(STARTED), ...overrides });

const check = (name: string, status: PullRequestCheck["status"], required: boolean | null = null): PullRequestCheck => ({
  name,
  status,
  url: `https://ci.example/${name}`,
  required
});

type Detail = Pick<PullRequestStatus, "headSha" | "checks" | "mergeability" | "author">;

const detail = (overrides: Partial<Detail> = {}): Detail => ({
  headSha: "aaaaaaaaaa",
  checks: [check("lint", "success"), check("test", "pending")],
  mergeability: "clean",
  author: "agent-user",
  ...overrides
});

const remark = (login: string, createdAt: string, body = "Please rename this."): PullRequestRemark => ({
  id: `${login}-${createdAt}`,
  kind: "review-comment",
  author: login,
  body,
  createdAt,
  editedAt: null,
  url: `https://github.com/o/r/pull/1#${login}`,
  path: "src/index.ts",
  reviewState: null
});

const noRemarks: readonly PullRequestRemark[] = [];

describe("evaluatePullRequestWatch", () => {
  it("reports each failure at once, even while another check never finishes", () => {
    const bot = check("CodeRabbit", "pending");
    const first = detail({ checks: [check("lint", "failure"), check("test", "pending"), bot] });
    const lint = evaluatePullRequestWatch(watch(), first, noRemarks, VIEWER);
    assert.deepEqual(lint.changes, [{ kind: "checks-failed", failed: [check("lint", "failure")] }]);
    assert.deepEqual(evaluatePullRequestWatch(lint.next, first, noRemarks, VIEWER).changes, []);

    const second = detail({ checks: [check("lint", "failure"), check("test", "failure"), bot] });
    const test = evaluatePullRequestWatch(lint.next, second, noRemarks, VIEWER);
    assert.deepEqual(test.changes, [{ kind: "checks-failed", failed: [check("test", "failure")] }]);

    // A rerun leaves the list while it runs, so failing again is reported again.
    const rerun = evaluatePullRequestWatch(test.next, first, noRemarks, VIEWER);
    assert.equal(evaluatePullRequestWatch(rerun.next, second, noRemarks, VIEWER).changes.length, 1);

    // A push reports its failures, even ones that failed between two reads.
    const pushed = detail({ ...second, headSha: "bbbbbbbbbb" });
    assert.equal(evaluatePullRequestWatch(test.next, pushed, noRemarks, VIEWER).changes.length, 1);
  });

  it("reports passed once the required checks pass, whatever the others do", () => {
    const green = detail({ checks: [check("test", "success", true), check("lint", "success", true), check("bot", "pending")] });
    const passed = evaluatePullRequestWatch(watch(), green, noRemarks, VIEWER);
    assert.deepEqual(passed.changes, [{ kind: "checks-passed", count: 2, required: true }]);
    assert.deepEqual(evaluatePullRequestWatch(passed.next, green, noRemarks, VIEWER).changes, []);

    // Where nothing is marked required, every check has to pass.
    const plain = detail({ checks: [check("test", "success"), check("bot", "pending")] });
    assert.deepEqual(evaluatePullRequestWatch(watch(), plain, noRemarks, VIEWER).changes, []);
  });

  it("reports passed again when a required check shows up already passed", () => {
    const tests = detail({ checks: [check("Tests", "success", true), check("Smoke Tests", "pending")] });
    const first = evaluatePullRequestWatch(watch(), tests, noRemarks, VIEWER);
    assert.deepEqual(first.changes, [{ kind: "checks-passed", count: 1, required: true }]);
    const gated = detail({
      checks: [check("Tests", "success", true), check("Smoke Tests", "success"), check("Smoke Tests Gate", "success", true)]
    });
    const second = evaluatePullRequestWatch(first.next, gated, noRemarks, VIEWER);
    assert.deepEqual(second.changes, [{ kind: "checks-passed", count: 2, required: true }]);
    assert.deepEqual(evaluatePullRequestWatch(second.next, gated, noRemarks, VIEWER).changes, []);
  });

  it("does not report passed again for a new passed check where none is required", () => {
    const first = evaluatePullRequestWatch(watch(), detail({ checks: [check("test", "success")] }), noRemarks, VIEWER);
    assert.deepEqual(first.changes, [{ kind: "checks-passed", count: 1, required: false }]);
    const both = detail({ checks: [check("test", "success"), check("lint", "success")] });
    assert.deepEqual(evaluatePullRequestWatch(first.next, both, noRemarks, VIEWER).changes, []);
  });

  it("does not wake a watch whose passed state was recorded without its checks", () => {
    const green = detail({ checks: [check("test", "success", true)] });
    const saved = evaluatePullRequestWatch(watch({ headSha: "aaaaaaaaaa", passed: true }), green, noRemarks, VIEWER);
    assert.deepEqual(saved.changes, []);
    assert.deepEqual(saved.next.passedChecks, ["test"]);
  });

  it("keeps remarks for a later read when the conversation was not read whole", () => {
    const comments = [remark("reviewer", "2026-10-02T12:06:00Z")];
    const partial = evaluatePullRequestWatch(watch(), detail(), null, VIEWER);
    assert.deepEqual(partial.changes, []);
    assert.equal(evaluatePullRequestWatch(partial.next, detail(), comments, VIEWER).changes[0]?.kind, "remarks");
  });

  it("reports a remark that shows up late with the same time as a reported one", () => {
    const first = remark("reviewer", "2026-10-02T12:06:00Z");
    const late = { ...remark("bot", "2026-10-02T12:06:00Z"), id: "late" };
    const reported = evaluatePullRequestWatch(watch(), detail(), [first], VIEWER);
    const again = evaluatePullRequestWatch(reported.next, detail(), [first, late], VIEWER);
    assert.deepEqual(again.changes, [{ kind: "remarks", remarks: [late] }]);
    assert.deepEqual(again.next.remarkIds, [first.id, "late"]);
  });

  it("reports edits after the watermark once and counts them toward the wake limit", () => {
    const old = remark("greptile[bot]", "2026-10-02T11:00:00Z");
    const watching = watch({ headSha: "aaaaaaaaaa", remarkIds: [old.id], wakes: PULL_REQUEST_WATCH_WAKE_LIMIT - 1 });
    assert.deepEqual(evaluatePullRequestWatch(watching, detail(), [old], VIEWER).changes, []);
    const edited = { ...old, editedAt: "2026-10-02T12:06:00Z" };
    const report = evaluatePullRequestWatch(watching, detail(), [edited], VIEWER);
    assert.deepEqual(report.changes, [{ kind: "remarks", remarks: [edited] }]);
    assert.equal(report.next.remarksThrough, edited.editedAt);
    assert.equal(report.exhausted, true);
    assert.deepEqual(evaluatePullRequestWatch(report.next, detail(), [edited], VIEWER).changes, []);
  });

  it("does not treat a failed check read as a rerun", () => {
    const failed = detail({ checks: [check("lint", "failure")] });
    const reported = evaluatePullRequestWatch(watch(), failed, noRemarks, VIEWER);
    assert.equal(reported.changes.length, 1);
    const unreadable = evaluatePullRequestWatch(reported.next, detail({ checks: [] }), noRemarks, VIEWER);
    assert.deepEqual(evaluatePullRequestWatch(unreadable.next, failed, noRemarks, VIEWER).changes, []);
  });

  it("without a viewer (an anonymous read), the pull request's author is taken to be the agent", () => {
    const contributor = detail({ author: "contributor" });
    const reply = remark("contributor", "2026-10-02T12:06:00Z");
    assert.deepEqual(evaluatePullRequestWatch(watch(), contributor, [reply], VIEWER).changes, [{ kind: "remarks", remarks: [reply] }]);
    assert.deepEqual(evaluatePullRequestWatch(watch(), contributor, [reply], []).changes, []);
  });

  it("reports remarks from others once and never the agent's own (by login or account ref)", () => {
    const comments = [
      remark("agent-user", "2026-10-02T12:05:00Z", "Fixed in the latest push."),
      { ...remark("Agent User", "2026-10-02T12:05:30Z"), authorRef: "{uuid-1}" },
      remark("macroscope-app[bot]", "2026-10-02T12:06:00Z"),
      remark("reviewer", "2026-10-02T11:00:00Z", "Older than the watch.")
    ];
    const report = evaluatePullRequestWatch(watch(), detail(), comments, ["agent-user", "{uuid-1}"]);
    assert.deepEqual(report.changes, [{ kind: "remarks", remarks: [comments[2]!] }]);
    assert.equal(report.next.remarksThrough, "2026-10-02T12:06:00Z");
    assert.deepEqual(evaluatePullRequestWatch(report.next, detail(), comments, VIEWER).changes, []);
  });

  it("reports a conflict once, until the branch is clean again", () => {
    const conflicting = detail({ mergeability: "conflicting" });
    const first = evaluatePullRequestWatch(watch(), conflicting, noRemarks, VIEWER);
    assert.deepEqual(first.changes, [{ kind: "conflicting" }]);
    const recomputing = evaluatePullRequestWatch(first.next, detail({ mergeability: "unknown" }), noRemarks, VIEWER);
    assert.deepEqual(evaluatePullRequestWatch(recomputing.next, conflicting, noRemarks, VIEWER).changes, []);
    const clean = evaluatePullRequestWatch(first.next, detail(), noRemarks, VIEWER);
    assert.deepEqual(evaluatePullRequestWatch(clean.next, conflicting, noRemarks, VIEWER).changes, [{ kind: "conflicting" }]);
  });

  it("does not spend the comment wake limit on check results, and the head moving resets it", () => {
    const tired = watch({ headSha: "aaaaaaaaaa", wakes: PULL_REQUEST_WATCH_WAKE_LIMIT - 1 });
    const result = evaluatePullRequestWatch(tired, detail({ checks: [check("lint", "failure")] }), noRemarks, VIEWER);
    assert.equal(result.exhausted, false);
    assert.equal(result.next.wakes, 0);
    const comments = [remark("reviewer", "2026-10-02T12:10:00Z")];
    assert.equal(evaluatePullRequestWatch(tired, detail(), comments, VIEWER).exhausted, true);
    const pushed = evaluatePullRequestWatch(tired, detail({ headSha: "cccccccccc" }), comments, VIEWER);
    assert.equal(pushed.exhausted, false);
    assert.equal(pushed.next.wakes, 1);
  });

  it("an abbreviated head (Bitbucket Cloud) is the same head as its full sha", () => {
    const failed = detail({ headSha: "31b8ff8dad0a", checks: [check("build", "failure")] });
    const told = evaluatePullRequestWatch(watch(), failed, noRemarks, VIEWER).next;
    const full = detail({ headSha: "31b8ff8dad0a49a75e6148b1a274f43191aabb77", checks: [check("build", "failure")] });
    assert.deepEqual(evaluatePullRequestWatch(told, full, noRemarks, VIEWER).changes, []);
  });
});

describe("pullRequestWakeMessage", () => {
  it("tells the agent what changed under the automated prefix", () => {
    const report = evaluatePullRequestWatch(watch(), detail({ checks: [check("lint", "failure")] }), [
      remark("reviewer", "2026-10-02T12:10:00Z", "<!-- bot -->Needs a test.")
    ], VIEWER);
    const text = pullRequestWakeMessage([
      { kind: "update", number: 12, url: "https://github.com/o/r/pull/12", report, baseBranch: "main", headSha: report.next.headSha }
    ]);
    assert.deepEqual(parsePullRequestWatchMessage(text)?.summary, "#12: checks failed, new comments");
    assert.ok(text.includes("Update on pull request #12 (https://github.com/o/r/pull/12), which Orquester is watching for you:"));
    assert.ok(text.includes("- Checks failed on aaaaaaa:\n  - lint https://ci.example/lint"));
    assert.ok(text.includes('  - reviewer on src/index.ts: "Needs a test."'));
    assert.ok(text.includes("unwatch_pull_request"));
  });

  it("joins several pull requests and their ends into one message", () => {
    const report = evaluatePullRequestWatch(watch(), detail({ mergeability: "conflicting" }), noRemarks, VIEWER);
    const text = pullRequestWakeMessage([
      { kind: "update", number: 3, url: "u3", report, baseBranch: "develop", headSha: null },
      { kind: "ended", number: 4, url: "u4", end: { kind: "merged" } },
      { kind: "ended", number: 5, url: "u5", end: { kind: "closed" } },
      { kind: "ended", number: 6, url: "u6", end: { kind: "unreadable", reason: "auth rejected" } }
    ]);
    assert.equal(
      parsePullRequestWatchMessage(text)?.summary,
      "#3: merge conflict; #4: merged, stopped watching; #5: closed, stopped watching; #6: stopped watching, could not read it"
    );
    assert.ok(text.includes("- The branch now conflicts with develop."));
    assert.ok(text.includes("Pull request #4 (u4) was merged, so Orquester stopped watching it."));
    assert.ok(text.includes("Pull request #5 (u5) was closed without being merged"));
    assert.ok(text.includes("failed to read it 8 times in a row (auth rejected)"));
    assert.ok(text.includes("Orquester keeps watching"));
  });

  it("an end alone does not promise more updates", () => {
    const text = pullRequestWakeMessage([{ kind: "ended", number: 4, url: "u4", end: { kind: "merged" } }]);
    assert.ok(!text.includes("keeps watching"));
  });
});
