import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { nextRuns, validateCron } from "@orquester/api";

import type { GitRepoRef, GitTriggerEvent, SchedulePreset } from "@orquester/api";

import {
  eventForKind,
  jsonExampleProblem,
  lastDayOfMonthCron,
  presetForKind,
  pullRequestWithBases,
  repoForKind,
  repoWithAccount,
  tagWithPattern
} from "./trigger-text.ts";

describe("last-day schedule", () => {
  it("builds a last-day-of-month cron the scheduler accepts", () => {
    const cron = lastDayOfMonthCron("09:30");
    assert.equal(cron, "30 9 L * *");
    assert.equal(validateCron(cron, "UTC"), null);
    assert.deepEqual(
      nextRuns(cron, "UTC", 2, "2026-01-01T00:00:00Z").map((iso) => iso.slice(0, 10)),
      ["2026-01-31", "2026-02-28"]
    );
  });
});

describe("manual example input", () => {
  it("accepts empty or valid JSON", () => {
    assert.equal(jsonExampleProblem(""), null);
    assert.equal(jsonExampleProblem("  \n"), null);
    assert.equal(jsonExampleProblem('{ "a": 1 }'), null);
    assert.equal(jsonExampleProblem("42"), null);
  });

  it("points at the line and column of a mistake", () => {
    const problem = jsonExampleProblem('{\n  "a": 1\n  "b": 2\n}');
    assert.ok(problem !== null);
    assert.match(problem!, /line 3, column 3/);
    assert.ok(!/position \d/.test(problem!), "the raw position is replaced by line and column");
  });
});

describe("kind switches and edits", () => {
  /** A stored object with a field this build does not know (configs pass unknown keys through). */
  const loose = <T>(value: T): T => ({ ...value, futureField: { keep: true } }) as T;

  it("re-picking the current schedule kind changes nothing", () => {
    const presets: SchedulePreset[] = [
      { kind: "minutes", every: 5 },
      { kind: "hours", every: 6, atMinute: 45 },
      { kind: "daily", time: "07:30" },
      { kind: "weekly", days: [0, 6], time: "10:00" },
      { kind: "monthly", day: 28, time: "23:15" },
      { kind: "cron" }
    ];
    for (const preset of presets) {
      const stored = loose(preset);
      assert.deepEqual(presetForKind(stored.kind, stored), stored, `${preset.kind} is kept as is`);
    }
  });

  it("switching the schedule kind starts it fresh, keeping the time of day", () => {
    assert.deepEqual(presetForKind("weekly", { kind: "daily", time: "07:30" }), { kind: "weekly", days: [1, 2, 3, 4, 5], time: "07:30" });
    assert.deepEqual(presetForKind("monthly", { kind: "weekly", days: [1], time: "18:00" }), { kind: "monthly", day: 1, time: "18:00" });
    assert.deepEqual(presetForKind("cron", { kind: "daily", time: "07:30" }), { kind: "cron" });
  });

  it("re-picking the current repository kind keeps the URL and account", () => {
    const url = loose<GitRepoRef>({ kind: "url", url: "git@github.com:acme/app.git", accountId: "a1" });
    assert.deepEqual(repoForKind("url", url), url);
    const project = loose<GitRepoRef>({ kind: "project" });
    assert.deepEqual(repoForKind("project", project), project);
    assert.deepEqual(repoForKind("project", url), { kind: "project" });
    assert.deepEqual(repoForKind("url", project), { kind: "url", url: "" });
  });

  it("changing the account keeps every other repository field", () => {
    const url = loose({ kind: "url" as const, url: "git@github.com:acme/app.git", accountId: "a1" });
    assert.deepEqual(repoWithAccount(url, "a2"), { kind: "url", url: "git@github.com:acme/app.git", accountId: "a2", futureField: { keep: true } });
    const publicRepo = repoWithAccount(url, "");
    assert.deepEqual(publicRepo, { kind: "url", url: "git@github.com:acme/app.git", futureField: { keep: true } });
    assert.ok(!("accountId" in publicRepo), "public = no accountId key at all");
  });

  it("re-picking the current event kind changes nothing", () => {
    const events: GitTriggerEvent[] = [
      { kind: "push", branches: ["main", "release/*"] },
      { kind: "tag", pattern: "release-*" },
      { kind: "tag" },
      { kind: "release", includePrereleases: true },
      { kind: "pull_request", actions: ["merged"], baseBranches: ["main"] }
    ];
    for (const event of events) {
      const stored = loose(event);
      assert.deepEqual(eventForKind(stored.kind, stored), stored, `${event.kind} is kept as is`);
    }
    assert.deepEqual(eventForKind("tag", { kind: "push", branches: ["main"] }), { kind: "tag", pattern: "v*" });
    assert.deepEqual(eventForKind("pull_request", { kind: "tag" }), { kind: "pull_request", actions: ["opened", "updated"] });
    assert.deepEqual(eventForKind("push", { kind: "tag" }), { kind: "push", branches: [] });
    assert.deepEqual(eventForKind("release", { kind: "tag" }), { kind: "release", includePrereleases: false });
  });

  it("edits within an event keep its other fields", () => {
    const tag = loose({ kind: "tag" as const, pattern: "v*" });
    assert.deepEqual(tagWithPattern(tag, "release-*"), { kind: "tag", pattern: "release-*", futureField: { keep: true } });
    const anyTag = tagWithPattern(tag, "");
    assert.deepEqual(anyTag, { kind: "tag", futureField: { keep: true } });
    assert.ok(!("pattern" in anyTag));
    const pr = loose({ kind: "pull_request" as const, actions: ["opened" as const], baseBranches: ["main"] });
    assert.deepEqual(pullRequestWithBases(pr, ["dev"]), { kind: "pull_request", actions: ["opened"], baseBranches: ["dev"], futureField: { keep: true } });
    const anyBase = pullRequestWithBases(pr, []);
    assert.deepEqual(anyBase, { kind: "pull_request", actions: ["opened"], futureField: { keep: true } });
    assert.ok(!("baseBranches" in anyBase));
  });
});
