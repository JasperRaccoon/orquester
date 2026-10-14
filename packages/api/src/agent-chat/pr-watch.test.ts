import assert from "node:assert/strict";
import { test } from "node:test";

import {
  agentChatRoutes,
  isPullRequestWatchesChangedEvent,
  parsePullRequestWatchMessage,
  PR_WATCH_MESSAGE_PREFIX,
  type PullRequestWatchSummary
} from "./index.ts";

test("pr-watch routes are session-scoped and encode the watch id", () => {
  assert.equal(agentChatRoutes.prWatches("s1"), "/api/sessions/s1/pr-watches");
  assert.equal(agentChatRoutes.prWatch("s1", "a/b"), "/api/sessions/s1/pr-watches/a%2Fb");
});

test("a wake parses into its summary line and body; other text does not", () => {
  const text = `${PR_WATCH_MESSAGE_PREFIX}#12: checks failed\nUpdate on pull request #12…\n- Checks failed`;
  assert.deepEqual(parsePullRequestWatchMessage(text), {
    summary: "#12: checks failed",
    body: "Update on pull request #12…\n- Checks failed"
  });
  assert.deepEqual(parsePullRequestWatchMessage(`${PR_WATCH_MESSAGE_PREFIX}#3: merged`), { summary: "#3: merged", body: "" });
  assert.equal(parsePullRequestWatchMessage("Please look at [Pull request watch] #12"), null);
  assert.equal(parsePullRequestWatchMessage(`${PR_WATCH_MESSAGE_PREFIX}  \nbody`), null);
});

test("the changed event is shape-checked", () => {
  const watch: PullRequestWatchSummary = {
    id: "w",
    sessionId: "s",
    repository: "o/r",
    number: 1,
    url: "https://github.com/o/r/pull/1",
    title: "",
    startedAt: "2026-10-14T00:00:00.000Z",
    lastCheckedAt: null,
    status: null,
    lastError: null,
    wakePending: false
  };
  assert.equal(isPullRequestWatchesChangedEvent({ sessionId: "s", watches: [watch] }), true);
  assert.equal(isPullRequestWatchesChangedEvent({ sessionId: "s", watches: [{ ...watch, number: "1" }] }), false);
  assert.equal(isPullRequestWatchesChangedEvent({ watches: [] }), false);
  assert.equal(isPullRequestWatchesChangedEvent(null), false);
});
