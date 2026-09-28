import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GitStatusResponse, GitWorkingDiffResponse } from "./index.ts";
import { resolvePromptVariables, type PromptVariableSource } from "./prompt-variables.ts";

function status(overrides: Partial<GitStatusResponse> = {}): GitStatusResponse {
  return { isRepo: true, branch: "main", detached: false, upstream: null, ahead: 0, behind: 0, lastFetched: null, files: [], ...overrides };
}
function workingDiff(overrides: Partial<GitWorkingDiffResponse> = {}): GitWorkingDiffResponse {
  return { isRepo: true, diff: "", truncated: false, untracked: [], ...overrides };
}
function git(
  gitStatus: PromptVariableSource["gitStatus"] = async () => status(),
  gitWorkingDiff: PromptVariableSource["gitWorkingDiff"] = async () => workingDiff()
): Partial<PromptVariableSource> {
  return { gitStatus, gitWorkingDiff };
}
async function render(body: string, source: Partial<PromptVariableSource> = {}): Promise<string> {
  const result = await resolvePromptVariables(body, {
    projectPath: "/w/acme/app", now: () => new Date("2026-09-01T00:00:00Z"), gitStatus: async () => status(), gitWorkingDiff: async () => workingDiff(), ...source
  });
  assert.equal(result.ok, true);
  return result.ok ? result.text : "";
}

describe("git variables", () => {
  it("{branch}: detached or no repository", async () => {
    const detached = git(() => Promise.resolve(status({ branch: null, detached: true })));
    assert.equal(await render("{branch}", detached), "(detached HEAD)");
    const noRepo = git(() => Promise.resolve(status({ isRepo: false, branch: null })));
    assert.equal(await render("{branch}", noRepo), "(no git repository)");
  });

  it("{changedFiles}: one line per file, renames with both paths", async () => {
    const source = git(() =>
      Promise.resolve(
        status({
          files: [
            { path: "src/a.ts", status: "modified", staged: false, unstaged: true },
            { path: "src/new.ts", status: "renamed", staged: true, unstaged: false, oldPath: "src/old.ts" },
            { path: "notes.md", status: "untracked", staged: false, unstaged: true }
          ]
        })
      )
    );
    assert.equal(
      await render("{changedFiles}", source),
      "modified src/a.ts\nrenamed src/old.ts -> src/new.ts\nuntracked notes.md"
    );
  });

  it("{changedFiles}: not a repo, and capped", async () => {
    const noRepo = git(() => Promise.resolve(status({ isRepo: false })));
    assert.equal(await render("{changedFiles}", noRepo), "(no git repository)");
    const many = Array.from({ length: 503 }, (_, index) => ({
      path: `f${index}`,
      status: "modified" as const,
      staged: false,
      unstaged: true
    }));
    const lines = (await render("{changedFiles}", git(() => Promise.resolve(status({ files: many }))))).split("\n");
    assert.equal(lines.length, 501);
    assert.equal(lines.at(-1), "… 3 more files");
  });

  it("{diff}: the patch, then the cut, then the untracked files", async () => {
    const source = git(undefined, () =>
      Promise.resolve(
        workingDiff({
          diff: "diff --git a/x b/x\n+added\n",
          truncated: true,
          untracked: ["new.txt", "docs/todo.md"]
        })
      )
    );
    assert.equal(
      await render("{diff}", source),
      "diff --git a/x b/x\n+added\n… diff truncated at 64 KB\n\nUntracked files:\n- new.txt\n- docs/todo.md"
    );
  });

  it("{diff}: untracked alone, clean, and not a repo", async () => {
    const untrackedOnly = git(undefined, () => Promise.resolve(workingDiff({ untracked: ["a"] })));
    assert.equal(await render("{diff}", untrackedOnly), "Untracked files:\n- a");
    assert.equal(await render("{diff}"), "(no uncommitted changes)");
    const noRepo = git(undefined, () => Promise.resolve(workingDiff({ isRepo: false })));
    assert.equal(await render("{diff}", noRepo), "(no git repository)");
  });
});
