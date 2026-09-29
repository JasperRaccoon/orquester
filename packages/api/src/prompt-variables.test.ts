import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { GitStatusResponse, GitWorkingDiffResponse } from "./index.ts";
import {
  resolvePromptVariables,
  type PromptVariableSource
} from "./prompt-variables.ts";

const PROJECT = "/w/acme/app";
// 2026-03-07 23:30 UTC: already the 8th in Tokyo, still the 7th in New York.
const NOW = new Date("2026-03-07T23:30:00Z");

function status(overrides: Partial<GitStatusResponse> = {}): GitStatusResponse {
  return { isRepo: true, branch: "main", detached: false, upstream: null, ahead: 0, behind: 0, lastFetched: null, files: [], ...overrides };
}
function workingDiff(overrides: Partial<GitWorkingDiffResponse> = {}): GitWorkingDiffResponse {
  return { isRepo: true, diff: "", truncated: false, untracked: [], ...overrides };
}

function source(overrides: Partial<PromptVariableSource> = {}): PromptVariableSource {
  return {
    projectPath: PROJECT,
    gitStatus: () => Promise.resolve(status()),
    gitWorkingDiff: () => Promise.resolve(workingDiff({ diff: "+x\n" })),
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
    assert.equal(await render("{date} {time}", { timeZone: "Nowhere/Land", now: () => local }), "2026-03-07 09:05");
  });

  it("names the failed read and the variables that needed it", async () => {
    const failing = source({ gitStatus: () => Promise.reject(new Error("status failed")) });
    const statusResult = await resolvePromptVariables("{changedFiles} {diff} {branch}", failing);
    assert.equal(statusResult.ok, false);
    if (!statusResult.ok) {
      assert.equal(statusResult.failure, "git-status");
      assert.deepEqual(statusResult.variables, ["changedFiles", "branch"]);
    }
    const diffFails = source({ gitWorkingDiff: () => Promise.reject(new Error("diff failed")) });
    const diffResult = await resolvePromptVariables("{diff}", diffFails);
    assert.equal(diffResult.ok, false);
    if (!diffResult.ok) {
      assert.equal(diffResult.failure, "git-diff");
      assert.deepEqual(diffResult.variables, ["diff"]);
    }
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

  it("no project reads as no repository", async () => {
    assert.equal(await render("{branch}|{diff}", { projectPath: "" }), "(no git repository)|(no git repository)");
  });
});
