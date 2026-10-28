import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type GitHubLinkPreview, type GitHubPullPreview } from "@orquester/api";

import { checksPresentation, previewTimeline } from "./pill.logic";

const PULL: GitHubPullPreview = {
  kind: "pull",
  owner: "a",
  repo: "b",
  number: 1,
  url: "https://github.com/a/b/pull/1",
  title: "t",
  state: "open",
  author: "me",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
  closedAt: null,
  mergedAt: null,
  comments: 0,
  headRef: "f",
  baseRef: "main",
  headLabel: null,
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  checks: null
};

const issue = (state: "open" | "closed", stateReason: "completed" | "not_planned" | null = null): GitHubLinkPreview => ({
  kind: "issue",
  owner: "a",
  repo: "b",
  number: 2,
  url: "https://github.com/a/b/issues/2",
  title: "t",
  state,
  stateReason,
  author: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: null,
  closedAt: "2026-10-03T00:00:00Z",
  comments: 0
});

describe("checksPresentation", () => {
  it("leads with the worst outcome", () => {
    assert.equal(checksPresentation(null), null);
    assert.equal(checksPresentation({ total: 0, passed: 0, failed: 0, pending: 0, skipped: 0 }), null);
    assert.deepEqual(checksPresentation({ total: 5, passed: 2, failed: 1, pending: 1, skipped: 1 }), {
      tone: "failed",
      label: "5 checks: 1 failing, 1 pending, 2 passed, 1 skipped"
    });
    assert.deepEqual(checksPresentation({ total: 2, passed: 1, failed: 0, pending: 1, skipped: 0 }), {
      tone: "pending",
      label: "2 checks: 1 pending, 1 passed"
    });
    assert.deepEqual(checksPresentation({ total: 1, passed: 1, failed: 0, pending: 0, skipped: 0 }), {
      tone: "passed",
      label: "1 check: 1 passed"
    });
    assert.equal(checksPresentation({ total: 1, passed: 0, failed: 0, pending: 0, skipped: 1 })?.tone, "neutral");
  });
});

describe("previewTimeline", () => {
  it("says when the item last changed state", () => {
    assert.deepEqual(previewTimeline(PULL), { verb: "opened", at: "2026-10-01T00:00:00Z" });
    assert.deepEqual(previewTimeline({ ...PULL, state: "merged", mergedAt: "2026-10-05T00:00:00Z" }), {
      verb: "merged",
      at: "2026-10-05T00:00:00Z"
    });
    assert.deepEqual(previewTimeline(issue("closed")), { verb: "closed", at: "2026-10-03T00:00:00Z" });
    assert.deepEqual(
      previewTimeline({
        kind: "commit",
        owner: "a",
        repo: "b",
        sha: "a".repeat(40),
        url: "https://github.com/a/b/commit/x",
        title: "t",
        body: "",
        author: null,
        authoredAt: "2026-10-01T00:00:00Z",
        committedAt: null
      }),
      { verb: "committed", at: "2026-10-01T00:00:00Z" }
    );
  });
});
