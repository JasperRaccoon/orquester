import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { testNode } from "./testing.ts";
import { formatNextRun, repoDisplayName, triggerSummaryText } from "./triggers-text.ts";

const git = (config: Record<string, unknown>) => testNode("g", "trigger.git", config);

describe("triggerSummaryText", () => {
  it("manual and non-triggers", () => {
    assert.equal(triggerSummaryText(testNode("m", "trigger.manual")), "Run manually");
    assert.equal(triggerSummaryText(testNode("a", "agent")), "");
  });

  it("schedule, with the next run", () => {
    const node = testNode("s", "trigger.schedule", { preset: { kind: "minutes", every: 15 }, cron: "*/15 * * * *" });
    assert.equal(triggerSummaryText(node), "Every 15 min");
    const now = new Date("2026-09-28T12:00:00Z");
    assert.equal(
      triggerSummaryText(node, { nextRunAt: "2026-09-28T12:45:00Z", timeZone: "Europe/Madrid", now }),
      "Every 15 min · next 14:45"
    );
    assert.equal(triggerSummaryText(node, { nextRunAt: null }), "Every 15 min");
  });

  it("git events", () => {
    assert.equal(triggerSummaryText(git({ repo: { kind: "project" }, event: { kind: "push", branches: ["main"] } })), "Push to main · this project");
    assert.equal(
      triggerSummaryText(git({ repo: { kind: "project" }, event: { kind: "push", branches: [] } }), { projectName: "app" }),
      "Push to the default branch · app"
    );
    assert.equal(
      triggerSummaryText(git({ repo: { kind: "url", url: "git@github.com:AppsStats/Apps-Stats.git" }, event: { kind: "tag", pattern: "v*" } })),
      "New tag v* · AppsStats/Apps-Stats"
    );
    assert.equal(
      triggerSummaryText(git({ repo: { kind: "url", url: "https://github.com/owner/repo" }, event: { kind: "pull_request", actions: ["opened", "merged"] } })),
      "PR opened, merged · owner/repo"
    );
    assert.equal(
      triggerSummaryText(git({ repo: { kind: "url", url: "https://github.com/owner/repo" }, event: { kind: "pull_request", actions: ["opened"], baseBranches: ["main"] } })),
      "PR opened → main · owner/repo"
    );
    assert.equal(
      triggerSummaryText(git({ repo: { kind: "url", url: "https://github.com/owner/repo.git" }, event: { kind: "release", includePrereleases: false } })),
      "Release · owner/repo"
    );
    assert.equal(triggerSummaryText(git({ repo: { kind: "project" }, event: { kind: "tag" } })), "New tag · this project");
  });
});

describe("repoDisplayName", () => {
  it("reads owner/repo from any clone URL", () => {
    assert.equal(repoDisplayName("https://github.com/a/b.git"), "a/b");
    assert.equal(repoDisplayName("https://github.com/a/b/"), "a/b");
    assert.equal(repoDisplayName("git@ssh.bitbucket.org:team/repo.git"), "team/repo");
    assert.equal(repoDisplayName("ssh://git@host:7999/proj/repo.git"), "proj/repo");
    assert.equal(repoDisplayName("https://git.example.com/scm/PROJ/repo.git"), "PROJ/repo");
    assert.equal(repoDisplayName("repo"), "repo");
  });
});

describe("formatNextRun", () => {
  const now = new Date("2026-09-28T12:00:00Z"); // a Monday
  it("today, this week, later", () => {
    assert.equal(formatNextRun("2026-09-28T16:05:00Z", "UTC", now), "16:05");
    assert.equal(formatNextRun("2026-09-29T16:05:00Z", "UTC", now), "Tue 16:05");
    assert.equal(formatNextRun("2026-10-20T08:00:00Z", "UTC", now), "Oct 20 08:00");
    assert.equal(formatNextRun("2026-09-28T23:30:00Z", "Europe/Madrid", now), "Tue 01:30", "the zone decides the day");
    assert.equal(formatNextRun("not a date", "UTC", now), null);
    assert.equal(formatNextRun("2026-09-28T16:05:00Z", "Bad/Zone", now)?.length, 5, "an unknown zone falls back to the runtime's");
  });
});
