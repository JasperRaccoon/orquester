import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { PullRequestWatchSummary } from "@orquester/api/agent-chat";
import { PR_WATCH_MESSAGE_PREFIX } from "@orquester/api/agent-chat";

import { UserMessageRow } from "../timeline/rows/MessageRows.tsx";
import { describePullRequestWatch } from "./pr-watch-strip.ts";

const NOW = Date.parse("2026-10-14T10:10:00.000Z");

function watch(over: Partial<PullRequestWatchSummary> = {}): PullRequestWatchSummary {
  return {
    id: "w1",
    sessionId: "s1",
    repository: "acme/app",
    number: 12,
    url: "https://github.com/acme/app/pull/12",
    title: "Add retries",
    startedAt: "2026-10-14T10:00:00.000Z",
    lastCheckedAt: "2026-10-14T10:07:00.000Z",
    status: { state: "open", mergeability: "clean", headSha: "abc", baseBranch: "main", checks: { total: 3, passed: 3, failed: 0, pending: 0 } },
    lastError: null,
    wakePending: false,
    ...over
  };
}

const checks = (passed: number, failed: number, pending: number) => ({ total: passed + failed + pending, passed, failed, pending });

describe("a pull request watch chip", () => {
  it("says what the last read showed, in the shared tones", () => {
    const status = watch().status!;
    const cases: Array<[Partial<PullRequestWatchSummary>, string, string]> = [
      [{}, "checks passed", "ok"],
      [{ status: { ...status, checks: checks(1, 0, 2) } }, "checks running", "info"],
      [{ status: { ...status, checks: checks(1, 2, 0) } }, "2 failed", "danger"],
      [{ status: { ...status, checks: checks(1, 1, 0), mergeability: "conflicting" } }, "1 failed · conflict", "danger"],
      [{ status: { ...status, checks: checks(0, 0, 0) } }, "watching", "muted"],
      [{ status: null, lastCheckedAt: null }, "checking…", "muted"],
      [{ status: null, lastError: "auth rejected" }, "can't read", "warn"],
      [{ lastError: "rate limited" }, "checks passed", "warn"]
    ];
    for (const [over, detail, tone] of cases) {
      const chip = describePullRequestWatch(watch(over), NOW);
      assert.equal(chip.label, "#12");
      assert.equal(chip.detail, detail, JSON.stringify(over));
      assert.equal(chip.tone, tone, JSON.stringify(over));
    }
  });

  it("its tooltip and stop button name the pull request", () => {
    const chip = describePullRequestWatch(
      watch({ wakePending: true, lastError: "timed out", status: { ...watch().status!, mergeability: "conflicting" } }),
      NOW
    );
    assert.equal(chip.stopLabel, "Stop watching pull request #12");
    assert.equal(
      chip.title,
      [
        "Watching acme/app#12 — Add retries",
        "Checks: 3 passed, 0 failed, 0 running",
        "Conflicts with main",
        "Checked 3 minutes ago",
        "Last read failed: timed out",
        "An update waits for this thread to be idle"
      ].join("\n")
    );
  });
});

describe("a pull request watch message in the timeline", () => {
  const row = (text: string) =>
    ({
      kind: "message",
      id: "m1",
      createdAt: "2026-10-14T10:00:00.000Z",
      message: { id: "m1", role: "user", text, streaming: false, turnId: "t1", createdAt: "2026-10-14T10:00:00.000Z", updatedAt: "2026-10-14T10:00:00.000Z" },
      revertTurnCount: 1
    }) as never;

  it("reads as an automated notice, not the user's bubble", () => {
    const html = renderToStaticMarkup(
      createElement(UserMessageRow, { row: row(`${PR_WATCH_MESSAGE_PREFIX}#12: checks failed\nUpdate on pull request #12 …\n- Checks failed on abc1234:`) })
    );
    assert.match(html, /data-automated-message="pr-watch"/);
    assert.match(html, /Automated/);
    assert.match(html, /#12: checks failed/);
    assert.match(html, /- Checks failed on abc1234:/);
    assert.doesNotMatch(html, /\[Pull request watch\]/);
  });

  it("any other user message stays the user's bubble", () => {
    const html = renderToStaticMarkup(createElement(UserMessageRow, { row: row("Please fix the build") }));
    assert.doesNotMatch(html, /data-automated-message/);
    assert.match(html, /Please fix the build/);
  });
});
