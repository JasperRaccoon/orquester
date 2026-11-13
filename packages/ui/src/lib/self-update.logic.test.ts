import assert from "node:assert/strict";
import { test } from "node:test";
import type { SelfUpdateRun, SelfUpdateStatusResponse } from "@orquester/api";
import { nextUpdatePhase, readDismissedUpdate, updateToastKey, writeDismissedUpdate } from "./self-update.logic.ts";

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
  ...patch
});

const run = (state: SelfUpdateRun["state"], from: string | null): SelfUpdateRun => ({
  state,
  from,
  startedAt: "2026-11-13T10:00:00.000Z"
});

test("nextUpdatePhase keeps waiting while the daemon is down or still runs the old commit", () => {
  assert.equal(nextUpdatePhase(FROM, null), "updating", "a failed poll is the restart, not an error");
  assert.equal(nextUpdatePhase(FROM, status()), "updating", "the updater has not written its run yet");
  assert.equal(nextUpdatePhase(FROM, status({ run: run("running", FROM) })), "updating");
  assert.equal(nextUpdatePhase(FROM, status({ current: null })), "updating", "an unknown commit is not a new one");
});

test("nextUpdatePhase is done once the server runs another commit", () => {
  assert.equal(nextUpdatePhase(FROM, status({ current: NEW, behindBy: 0 })), "done");
  assert.equal(nextUpdatePhase(FROM, status({ current: NEW, run: run("succeeded", FROM) })), "done");
  assert.equal(nextUpdatePhase(FROM, status({ run: run("succeeded", FROM) })), "done", "succeeded without a new commit");
  const previous = run("succeeded", FROM);
  assert.equal(nextUpdatePhase(FROM, status({ run: previous }), previous), "updating", "the run before this request");
});

test("nextUpdatePhase reports this run's failure or revert, not an older run's", () => {
  assert.equal(nextUpdatePhase(FROM, status({ run: run("failed", FROM) })), "failed");
  assert.equal(nextUpdatePhase(FROM, status({ run: run("reverted", FROM) })), "reverted");
  assert.equal(nextUpdatePhase(FROM, status({ run: run("failed", OLDER) })), "updating", "a stale run from an older commit");
  assert.equal(nextUpdatePhase(FROM, status({ run: run("failed", null) })), "updating");
});

test("nextUpdatePhase ignores the failed run a retry from the same commit started after", () => {
  const previous = run("failed", FROM);
  assert.equal(nextUpdatePhase(FROM, status({ run: previous }), previous), "updating");
  const retry = { ...run("failed", FROM), startedAt: "2026-11-13T11:00:00.000Z" };
  assert.equal(nextUpdatePhase(FROM, status({ run: retry }), previous), "failed");
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
