import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GIT_WORKING_DIFF_DEFAULT_MAX_BYTES, type GitStatusResponse, type GitWorkingDiffResponse } from "./index.ts";
import {
  formatPromptDate,
  formatPromptTime,
  normalizePromptProjectPath,
  PROMPT_DIFF_MAX_BYTES,
  promptVariableErrorText,
  resolvePromptVariables,
  type PromptVariableSource
} from "./prompt-variables.ts";
import { escapePromptVariables } from "./saved-prompts.ts";

const PROJECT = "/w/acme/app";
// 2026-03-07 23:30 UTC: already the 8th in Tokyo, still the 7th in New York.
const NOW = new Date("2026-03-07T23:30:00Z");

function status(overrides: Partial<GitStatusResponse> = {}): GitStatusResponse {
  return { isRepo: true, branch: "main", detached: false, upstream: null, ahead: 0, behind: 0, lastFetched: null, files: [], ...overrides };
}
function workingDiff(overrides: Partial<GitWorkingDiffResponse> = {}): GitWorkingDiffResponse {
  return { isRepo: true, diff: "", truncated: false, untracked: [], ...overrides };
}

function source(overrides: Partial<PromptVariableSource> = {}): PromptVariableSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    projectPath: PROJECT,
    gitStatus: (path) => {
      calls.push(`status ${path}`);
      return Promise.resolve(status());
    },
    gitWorkingDiff: (path, maxBytes) => {
      calls.push(`diff ${path} ${maxBytes}`);
      return Promise.resolve(workingDiff({ diff: "+x\n" }));
    },
    now: () => NOW,
    timeZone: "UTC",
    ...overrides
  };
}

async function render(body: string, overrides: Partial<PromptVariableSource> = {}): Promise<string> {
  const result = await resolvePromptVariables(body, source(overrides));
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  return result.ok ? result.text : "";
}

describe("resolvePromptVariables", () => {
  it("renders every variable", async () => {
    assert.equal(
      await render("{project}|{workspace}|{projectPath}|{branch}|{changedFiles}|{diff}|{date}|{time}|{agent}|{model}", {
        agentLabel: "Claude Code",
        modelLabel: "Opus"
      }),
      "app|acme|/w/acme/app|main|(no uncommitted changes)|+x|2026-03-07|23:30|Claude Code|Opus"
    );
  });

  it("dates and times follow the given zone", async () => {
    assert.equal(await render("{date} {time}", { timeZone: "Asia/Tokyo" }), "2026-03-08 08:30");
    assert.equal(await render("{date} {time}", { timeZone: "America/New_York" }), "2026-03-07 18:30");
    assert.equal(await render("{date} {time}", { timeZone: "Europe/Madrid" }), "2026-03-08 00:30");
  });

  it("without a zone, the runtime's local clock (the browser's)", async () => {
    const local = new Date(2026, 2, 7, 9, 5, 30);
    assert.equal(await render("{date} {time}", { timeZone: undefined, now: () => local }), "2026-03-07 09:05");
    assert.equal(formatPromptDate(local), "2026-03-07");
    assert.equal(formatPromptTime(local), "09:05");
    assert.equal(formatPromptTime(local, "Nowhere/Land"), "09:05", "an unknown zone falls back to local");
  });

  it("the clock is read at most once, and only when used", async () => {
    let reads = 0;
    await render("{date} {time} {date}", { now: () => (reads += 1, NOW) });
    assert.equal(reads, 1);
    reads = 0;
    await render("{project}", { now: () => (reads += 1, NOW) });
    assert.equal(reads, 0);
  });

  it("reads only what the body uses, the diff with the default cap", async () => {
    const quiet = source();
    await resolvePromptVariables("{project} {date}", quiet);
    assert.deepEqual(quiet.calls, []);
    const both = source();
    await resolvePromptVariables("{branch} {changedFiles} {diff}", both);
    assert.deepEqual(both.calls, [`status ${PROJECT}`, `diff ${PROJECT} ${GIT_WORKING_DIFF_DEFAULT_MAX_BYTES}`]);
    assert.equal(PROMPT_DIFF_MAX_BYTES, GIT_WORKING_DIFF_DEFAULT_MAX_BYTES);
  });

  it("names the failed read and the variables that needed it", async () => {
    const failing = source({ gitStatus: () => Promise.reject(Object.assign(new Error("boom"), { serverMessage: "fatal: not a repo" })) });
    assert.deepEqual(await resolvePromptVariables("{changedFiles} {diff} {branch}", failing), {
      ok: false,
      reason: "Couldn't read git status: fatal: not a repo",
      failure: "git-status",
      variables: ["changedFiles", "branch"]
    });
    const diffFails = source({ gitWorkingDiff: () => Promise.reject(new Error("timeout")) });
    assert.deepEqual(await resolvePromptVariables("{diff}", diffFails), {
      ok: false,
      reason: "Couldn't read the git diff: timeout",
      failure: "git-diff",
      variables: ["diff"]
    });
  });

  it("an aborted resolve is cancelled", async () => {
    const controller = new AbortController();
    const aborting = source({
      signal: controller.signal,
      gitStatus: () => {
        controller.abort();
        return Promise.resolve(status());
      }
    });
    const result = await resolvePromptVariables("{branch}", aborting);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.failure, "cancelled");
  });

  it("text inserted by a workflow expression and escaped stays literal", async () => {
    const inserted = escapePromptVariables("user wrote {diff} and {date}");
    assert.equal(await render(`Title: ${inserted}. Today: {date}`), "Title: user wrote {diff} and {date}. Today: 2026-03-07");
  });

  it("no project reads as no repository", async () => {
    assert.equal(await render("{branch}|{diff}", { projectPath: "" }), "(no git repository)|(no git repository)");
  });
});

describe("helpers", () => {
  it("normalizePromptProjectPath", () => {
    assert.equal(normalizePromptProjectPath("/w/a/"), "/w/a");
    assert.equal(normalizePromptProjectPath("/"), "/");
    assert.equal(normalizePromptProjectPath(""), "");
  });

  it("promptVariableErrorText", () => {
    assert.equal(promptVariableErrorText({ serverMessage: " x " }), "x");
    assert.equal(promptVariableErrorText(new Error("y")), "y");
    assert.equal(promptVariableErrorText("z"), "z");
    assert.equal(promptVariableErrorText(null), "Something went wrong.");
  });
});
