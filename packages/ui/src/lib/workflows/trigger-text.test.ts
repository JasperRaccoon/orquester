import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { nextRuns, presetToCron, validateCron } from "@orquester/api";

import type { GitRepoRef, GitTriggerEvent, SchedulePreset } from "@orquester/api";

import {
  cronInWords,
  eventForKind,
  formatJsonExample,
  gitEventText,
  gitPollingText,
  gitRepoText,
  hourlyStartsText,
  jsonExampleProblem,
  lastDayOfMonthCron,
  monthlySkipNote,
  presetForKind,
  PR_ACTION_TEXT,
  pullRequestWithBases,
  repoForKind,
  repoWithAccount,
  sameDays,
  scheduleHeadline,
  scheduleSummary,
  splitList,
  tagWithPattern,
  WEEKDAY_OPTIONS,
  WEEKDAY_QUICK_PICKS,
  zoneOffsetLabel
} from "./trigger-text.ts";

describe("schedule words", () => {
  it("reads a cron in words, or null", () => {
    assert.equal(cronInWords("0 9 * * 1-5"), "At 09:00, Monday through Friday");
    assert.equal(cronInWords("not a cron"), null);
  });

  it("heads with the preset's words while the cron matches it, else the cron's", () => {
    assert.equal(scheduleHeadline({ kind: "weekly", days: [1, 2, 3, 4, 5], time: "09:00" }, "0 9 * * 1,2,3,4,5"), "Weekdays at 09:00");
    assert.equal(scheduleHeadline({ kind: "cron" }, "*/15 * * * *"), "Every 15 minutes");
    // A preset whose cron was changed elsewhere: the cron is what runs.
    assert.equal(scheduleHeadline({ kind: "daily", time: "09:00" }, "0 10 * * *"), "At 10:00");
    assert.equal(scheduleHeadline({ kind: "cron" }, "@@@"), "Custom schedule");
  });

  it("summarises with the zone except for every-N-minutes", () => {
    assert.equal(scheduleSummary({ kind: "weekly", days: [1, 2, 3, 4, 5], time: "09:00" }, "0 9 * * 1,2,3,4,5", "Europe/Madrid"), "Weekdays at 09:00 (Europe/Madrid)");
    assert.equal(scheduleSummary({ kind: "minutes", every: 15 }, "*/15 * * * *", "Europe/Madrid"), "Every 15 min");
    assert.equal(scheduleSummary({ kind: "cron" }, "0 9 * * *", "UTC"), "At 09:00 (UTC)");
  });

  it("labels a zone's offset, none for UTC or an unknown zone", () => {
    const july = new Date("2026-07-01T00:00:00Z");
    assert.equal(zoneOffsetLabel("Europe/Madrid", july), "GMT+2");
    assert.equal(zoneOffsetLabel("Asia/Kolkata", july), "GMT+5:30");
    assert.equal(zoneOffsetLabel("UTC", july), null);
    assert.equal(zoneOffsetLabel("Not/AZone", july), null);
  });

  it("explains monthly days 29–31 the way the cron actually fires", () => {
    assert.equal(monthlySkipNote(28), null);
    assert.equal(monthlySkipNote(1), null);
    assert.match(monthlySkipNote(29) ?? "", /February/);
    assert.match(monthlySkipNote(31) ?? "", /April, June, September and November/);
    // The claim, checked against croner: day 31 skips the months without one.
    const months = nextRuns(presetToCron({ kind: "monthly", day: 31, time: "09:00" })!, "UTC", 7, "2026-01-01T00:00:00Z").map((iso) =>
      iso.slice(5, 7)
    );
    assert.deepEqual(months, ["01", "03", "05", "07", "08", "10", "12"]);
    const february = nextRuns(presetToCron({ kind: "monthly", day: 29, time: "09:00" })!, "UTC", 2, "2026-01-01T00:00:00Z");
    assert.deepEqual(february.map((iso) => iso.slice(0, 10)), ["2026-01-29", "2026-03-29"]);
  });

  it("builds a last-day-of-month cron the scheduler accepts", () => {
    const cron = lastDayOfMonthCron("09:30");
    assert.equal(cron, "30 9 L * *");
    assert.equal(validateCron(cron, "UTC"), null);
    assert.deepEqual(
      nextRuns(cron, "UTC", 2, "2026-01-01T00:00:00Z").map((iso) => iso.slice(0, 10)),
      ["2026-01-31", "2026-02-28"]
    );
  });

  it("lists an hourly schedule's first times from midnight", () => {
    assert.equal(hourlyStartsText(3, 30), "00:30, 03:30, 06:30, …");
    assert.equal(hourlyStartsText(12, 0), "00:00, 12:00");
    assert.equal(hourlyStartsText(8, 5), "00:05, 08:05, 16:05");
    assert.equal(hourlyStartsText(1, 0), "00:00, 01:00, 02:00, …");
  });

  it("offers every weekday once, Monday first, and quick picks by set", () => {
    assert.deepEqual(WEEKDAY_OPTIONS.map((day) => day.value), ["1", "2", "3", "4", "5", "6", "0"]);
    assert.deepEqual(WEEKDAY_QUICK_PICKS.map((pick) => pick.label), ["Weekdays", "Weekends", "Every day"]);
    assert.equal(sameDays([5, 4, 3, 2, 1], [1, 2, 3, 4, 5]), true);
    assert.equal(sameDays([0, 6, 6], [6, 0]), true);
    assert.equal(sameDays([1, 2], [1, 2, 3]), false);
  });
});

describe("git words", () => {
  it("names every pull-request action", () => {
    assert.deepEqual(Object.keys(PR_ACTION_TEXT).sort(), ["closed", "merged", "opened", "updated"]);
    assert.equal(PR_ACTION_TEXT.updated.label, "New commits");
  });

  it("says each event in words", () => {
    assert.equal(gitEventText({ kind: "push", branches: [] }), "Push to the default branch");
    assert.equal(gitEventText({ kind: "push", branches: ["main", " release/* "] }), "Push to main or release/*");
    assert.equal(gitEventText({ kind: "tag", pattern: "v*" }), "New tag matching v*");
    assert.equal(gitEventText({ kind: "tag" }), "Any new tag");
    assert.equal(gitEventText({ kind: "release", includePrereleases: false }), "New release");
    assert.equal(gitEventText({ kind: "release", includePrereleases: true }), "New release or pre-release");
    assert.equal(gitEventText({ kind: "pull_request", actions: ["opened", "updated"] }), "PR opened or new commits");
    assert.equal(
      gitEventText({ kind: "pull_request", actions: ["merged", "closed"], baseBranches: ["main"] }),
      "PR merged or closed without merging → main"
    );
  });

  it("says which repository and with which access", () => {
    assert.equal(gitRepoText({ kind: "project" }), "This workflow's project");
    assert.equal(gitRepoText({ kind: "url", url: "https://github.com/acme/app.git" }), "acme/app · public");
    assert.equal(gitRepoText({ kind: "url", url: "git@github.com:acme/app.git", accountId: "a1" }, "Work"), "acme/app · as Work");
    assert.equal(gitRepoText({ kind: "url", url: "git@github.com:acme/app.git", accountId: "gone" }, null), "acme/app · as an unknown account");
    assert.equal(gitRepoText({ kind: "url", url: " " }), "No repository chosen · public");
  });

  it("states the poller's cadence per event", () => {
    assert.match(gitPollingText("push"), /once a minute/);
    assert.match(gitPollingText("tag"), /once a minute/);
    assert.match(gitPollingText("pull_request"), /2 minutes \(3 on Bitbucket Cloud\)/);
    assert.match(gitPollingText("release"), /2 minutes/);
  });

  it("splits a comma list", () => {
    assert.deepEqual(splitList(" main, release/* ,, "), ["main", "release/*"]);
    assert.deepEqual(splitList(""), []);
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
    assert.match(problem!, /^Not valid JSON — line 3, column 3: /);
    assert.ok(!/position \d/.test(problem!), "the raw position is replaced by line and column");
  });

  it("formats valid JSON with two-space indents, null otherwise", () => {
    assert.equal(formatJsonExample('{"a":1,"b":[1,2]}'), '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}');
    assert.equal(formatJsonExample(""), null);
    assert.equal(formatJsonExample("{"), null);
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
      assert.equal(presetForKind(stored.kind, stored), stored, `${preset.kind} is kept as is`);
    }
  });

  it("switching the schedule kind starts it fresh, keeping the time of day", () => {
    assert.deepEqual(presetForKind("minutes", { kind: "daily", time: "07:30" }), { kind: "minutes", every: 15 });
    assert.deepEqual(presetForKind("hours", { kind: "minutes", every: 5 }), { kind: "hours", every: 1, atMinute: 0 });
    assert.deepEqual(presetForKind("weekly", { kind: "daily", time: "07:30" }), { kind: "weekly", days: [1, 2, 3, 4, 5], time: "07:30" });
    assert.deepEqual(presetForKind("monthly", { kind: "weekly", days: [1], time: "18:00" }), { kind: "monthly", day: 1, time: "18:00" });
    assert.deepEqual(presetForKind("daily", { kind: "minutes", every: 5 }), { kind: "daily", time: "09:00" });
    assert.deepEqual(presetForKind("cron", { kind: "daily", time: "07:30" }), { kind: "cron" });
  });

  it("re-picking the current repository kind keeps the URL and account", () => {
    const url = loose<GitRepoRef>({ kind: "url", url: "git@github.com:acme/app.git", accountId: "a1" });
    assert.equal(repoForKind("url", url), url);
    const project = loose<GitRepoRef>({ kind: "project" });
    assert.equal(repoForKind("project", project), project);
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
      assert.equal(eventForKind(stored.kind, stored), stored, `${event.kind} is kept as is`);
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
