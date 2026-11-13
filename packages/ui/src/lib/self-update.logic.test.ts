import assert from "node:assert/strict";
import { test } from "node:test";
import type { SelfUpdateRun, SelfUpdateStatusResponse } from "@orquester/api";
import { lastRunFailure, nextUpdatePhase, readDismissedUpdate, updateToastKey, writeDismissedUpdate } from "./self-update.logic.ts";

const FROM = "1111111111111111111111111111111111111111";
const NEW = "2222222222222222222222222222222222222222";
const OLDER = "0000000000000000000000000000000000000000";

const status = (patch: Partial<SelfUpdateStatusResponse> = {}): SelfUpdateStatusResponse => ({
  current: FROM,
  branch: "main",
  repo: "owner/orquester",
  latest: NEW,
  behindBy: 3,
  checkedAt: "2026-11-13T10:00:00.000Z",
  error: null,
  canUpdate: true,
  run: null,
  requestStalled: false,
  ...patch
});

const run = (state: SelfUpdateRun["state"], from: string | null, startedAt = "2026-11-13T10:00:00.000Z"): SelfUpdateRun => ({
  state,
  from,
  startedAt
});

const REQUEST = { from: FROM, requestedAt: "2026-11-13T10:00:00.400Z" };

test("nextUpdatePhase keeps waiting while the daemon is down or this update has not finished", () => {
  assert.equal(nextUpdatePhase(REQUEST, null), "updating", "a failed poll is the restart, not an error");
  assert.equal(nextUpdatePhase(REQUEST, status()), "updating", "the updater has not written its run yet");
  assert.equal(nextUpdatePhase(REQUEST, status({ run: run("running", FROM) })), "updating");
  assert.equal(nextUpdatePhase(REQUEST, status({ current: null })), "updating", "an unknown commit is not a new one");
});

test("nextUpdatePhase is done once the server runs another commit or this update succeeded", () => {
  assert.equal(nextUpdatePhase(REQUEST, status({ current: NEW, behindBy: 0 })), "done");
  assert.equal(nextUpdatePhase(REQUEST, status({ run: run("succeeded", FROM) })), "done", "succeeded without a new commit");
});

test("nextUpdatePhase reports this update's failure or revert, whatever commit the updater saw", () => {
  assert.equal(nextUpdatePhase(REQUEST, status({ run: run("failed", FROM) })), "failed", "stamped to the second");
  assert.equal(nextUpdatePhase(REQUEST, status({ run: run("reverted", FROM) })), "reverted");
  // A build that failed earlier left the checkout ahead of the daemon: the run's from is that commit.
  assert.equal(nextUpdatePhase(REQUEST, status({ run: run("failed", OLDER, "2026-11-13T10:00:05.000Z") })), "failed");
});

test("nextUpdatePhase ignores the run before the request", () => {
  for (const state of ["failed", "reverted", "succeeded"] as const) {
    assert.equal(nextUpdatePhase(REQUEST, status({ run: run(state, FROM, "2026-11-13T09:59:59.000Z") })), "updating", state);
  }
});

test("nextUpdatePhase reports a request the host updater never took", () => {
  assert.equal(nextUpdatePhase(REQUEST, status({ requestStalled: true })), "stalled");
  assert.equal(nextUpdatePhase(REQUEST, status({ requestStalled: true, run: run("failed", FROM) })), "failed", "an outcome wins");
});

test("lastRunFailure shows the last run's failure only while the server still runs its commit", () => {
  assert.equal(lastRunFailure(status({ run: run("failed", FROM) })), "failed");
  assert.equal(lastRunFailure(status({ run: run("reverted", FROM) })), "reverted");
  assert.equal(lastRunFailure(status({ run: run("failed", OLDER) })), null, "deployed since");
  assert.equal(lastRunFailure(status({ run: run("succeeded", FROM) })), null);
  assert.equal(lastRunFailure(status()), null);
});

test("updateToastKey offers the branch head only to an install behind it that can update itself", () => {
  assert.equal(updateToastKey(status()), NEW);
  assert.equal(updateToastKey(status({ behindBy: 0 })), null, "up to date, ahead or diverged");
  assert.equal(updateToastKey(status({ canUpdate: false })), null, "a dev checkout or the desktop daemon");
  assert.equal(updateToastKey(status({ latest: null })), null, "never checked");
});

const memoryStorage = () => {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    map
  };
};

test("a dismissed update round-trips per connection", () => {
  const storage = memoryStorage();
  assert.equal(readDismissedUpdate(storage, "local"), null);
  writeDismissedUpdate(storage, "local", NEW);
  assert.equal(readDismissedUpdate(storage, "local"), NEW);
  assert.equal(readDismissedUpdate(storage, "remote-1"), null, "another server's toast stays");
});

test("a garbage or unreadable dismissal reads as none, and a failed write does not throw", () => {
  const storage = memoryStorage();
  writeDismissedUpdate(storage, "local", "not a sha");
  assert.equal(readDismissedUpdate(storage, "local"), null);
  const broken = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    }
  };
  assert.equal(readDismissedUpdate(broken, "local"), null);
  assert.doesNotThrow(() => writeDismissedUpdate(broken, "local", NEW));
});
