import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { GitStatusResponse, GitWorkingDiffResponse } from "@orquester/api";
import type { ProviderModel } from "@orquester/api/agent-chat";

import {
  agentLabelFor,
  CHANGED_FILES_MAX_LINES,
  modelLabelFor,
  projectNamesFromPath,
  resolveSavedPrompt,
  type ResolveSavedPromptInput,
  type SavedPromptGitApi
} from "./variables.ts";

const PROJECT = "/w/acme/app";
// A fixed local clock: 2026-03-07 09:05.
const NOW = new Date(2026, 2, 7, 9, 5, 30);

function status(overrides: Partial<GitStatusResponse> = {}): GitStatusResponse {
  return {
    isRepo: true,
    branch: "main",
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    lastFetched: null,
    files: [],
    ...overrides
  };
}

function workingDiff(overrides: Partial<GitWorkingDiffResponse> = {}): GitWorkingDiffResponse {
  return { isRepo: true, diff: "", truncated: false, untracked: [], ...overrides };
}

class FakeGit implements SavedPromptGitApi {
  statusCalls: string[] = [];
  diffCalls: { path: string; maxBytes: number | undefined }[] = [];
  signals: (AbortSignal | undefined)[] = [];
  constructor(
    public statusAnswer: () => Promise<GitStatusResponse> = () => Promise.resolve(status()),
    public diffAnswer: () => Promise<GitWorkingDiffResponse> = () => Promise.resolve(workingDiff())
  ) {}
  gitStatus(path: string, signal?: AbortSignal): Promise<GitStatusResponse> {
    this.statusCalls.push(path);
    this.signals.push(signal);
    return this.statusAnswer();
  }
  gitWorkingDiff(path: string, maxBytes?: number, signal?: AbortSignal): Promise<GitWorkingDiffResponse> {
    this.diffCalls.push({ path, maxBytes });
    this.signals.push(signal);
    return this.diffAnswer();
  }
}

async function render(
  body: string,
  input: Partial<ResolveSavedPromptInput> = {}
): Promise<string> {
  const result = await resolveSavedPrompt({
    body,
    projectPath: PROJECT,
    sessionId: "s1",
    api: new FakeGit(),
    now: NOW,
    ...input
  });
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  return result.ok ? result.text : "";
}

describe("project and clock variables", () => {
  it("names the project and workspace from the store, else from the path", async () => {
    assert.equal(
      await render("{project} in {workspace} at {projectPath}", {
        projectName: "App",
        workspaceName: "Acme"
      }),
      "App in Acme at /w/acme/app"
    );
    assert.equal(await render("{project} in {workspace}"), "app in acme");
    assert.equal(
      await render("{projectPath}", { projectPath: "/w/acme/app/" }),
      "/w/acme/app",
      "the same directory, written once"
    );
    assert.deepEqual(projectNamesFromPath("C:\\w\\acme\\app\\"), { project: "app", workspace: "acme" });
    assert.deepEqual(projectNamesFromPath(""), { project: "", workspace: "" });
  });

  it("renders the local date and time, zero-padded, 24 h", async () => {
    assert.equal(await render("{date} {time}"), "2026-03-07 09:05");
    assert.equal(await render("{time}", { now: new Date(2026, 11, 31, 23, 59) }), "23:59");
  });
});

describe("chat variables", () => {
  it("renders the chat's agent and model", async () => {
    assert.equal(
      await render("{agent} on {model}", { agentLabel: "Claude Code", modelLabel: "Opus 4.1" }),
      "Claude Code on Opus 4.1"
    );
  });

  it("renders both as empty without a target chat", async () => {
    assert.equal(
      await render("[{agent}|{model}]", { sessionId: null, agentLabel: "Claude", modelLabel: "Opus" }),
      "[|]"
    );
  });

  it("labels an agent by its registry name and a model by its catalogue name, else the raw id", () => {
    assert.equal(agentLabelFor("claude", [{ id: "claude", name: "Claude Code" }]), "Claude Code");
    assert.equal(agentLabelFor("mystery", [{ id: "claude", name: "Claude Code" }]), "mystery");
    const models: ProviderModel[] = [
      { slug: "opus", name: "Claude Opus 4.1", shortName: "Opus 4.1", capabilities: null },
      { slug: "sonnet", name: "Claude Sonnet 4.5", capabilities: null }
    ];
    assert.equal(modelLabelFor(models, "opus"), "Opus 4.1");
    assert.equal(modelLabelFor(models, "sonnet"), "Claude Sonnet 4.5");
    assert.equal(modelLabelFor(models, "gpt-5.1-codex"), "gpt-5.1-codex", "not in the catalogue");
    assert.equal(modelLabelFor(undefined, "gpt-5"), "gpt-5");
    assert.equal(modelLabelFor(models, null), "");
  });
});

describe("git variables", () => {
  it("{branch}: the branch, detached, or no repository", async () => {
    assert.equal(await render("{branch}"), "main");
    const detached = new FakeGit(() => Promise.resolve(status({ branch: null, detached: true })));
    assert.equal(await render("{branch}", { api: detached }), "(detached HEAD)");
    const noRepo = new FakeGit(() => Promise.resolve(status({ isRepo: false, branch: null })));
    assert.equal(await render("{branch}", { api: noRepo }), "(no git repository)");
  });

  it("{changedFiles}: one line per file, renames with both paths", async () => {
    const git = new FakeGit(() =>
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
      await render("{changedFiles}", { api: git }),
      "modified src/a.ts\nrenamed src/old.ts -> src/new.ts\nuntracked notes.md"
    );
  });

  it("{changedFiles}: clean, not a repo, and capped", async () => {
    assert.equal(await render("{changedFiles}"), "(no uncommitted changes)");
    const noRepo = new FakeGit(() => Promise.resolve(status({ isRepo: false })));
    assert.equal(await render("{changedFiles}", { api: noRepo }), "(no git repository)");
    const many = Array.from({ length: CHANGED_FILES_MAX_LINES + 3 }, (_, index) => ({
      path: `f${index}`,
      status: "modified" as const,
      staged: false,
      unstaged: true
    }));
    const lines = (await render("{changedFiles}", { api: new FakeGit(() => Promise.resolve(status({ files: many }))) })).split("\n");
    assert.equal(lines.length, CHANGED_FILES_MAX_LINES + 1);
    assert.equal(lines.at(-1), "… 3 more files");
  });

  it("{diff}: the patch, then the cut, then the untracked files", async () => {
    const git = new FakeGit(undefined, () =>
      Promise.resolve(
        workingDiff({
          diff: "diff --git a/x b/x\n+added\n",
          truncated: true,
          untracked: ["new.txt", "docs/todo.md"]
        })
      )
    );
    assert.equal(
      await render("{diff}", { api: git }),
      "diff --git a/x b/x\n+added\n… diff truncated at 64 KB\n\nUntracked files:\n- new.txt\n- docs/todo.md"
    );
    assert.deepEqual(git.diffCalls, [{ path: PROJECT, maxBytes: 64 * 1024 }]);
  });

  it("{diff}: the patch alone, untracked alone, clean, and not a repo", async () => {
    const patchOnly = new FakeGit(undefined, () => Promise.resolve(workingDiff({ diff: "+x\n" })));
    assert.equal(await render("{diff}", { api: patchOnly }), "+x");
    const untrackedOnly = new FakeGit(undefined, () => Promise.resolve(workingDiff({ untracked: ["a"] })));
    assert.equal(await render("{diff}", { api: untrackedOnly }), "Untracked files:\n- a");
    assert.equal(await render("{diff}"), "(no uncommitted changes)");
    const noRepo = new FakeGit(undefined, () => Promise.resolve(workingDiff({ isRepo: false })));
    assert.equal(await render("{diff}", { api: noRepo }), "(no git repository)");
  });

  it("no project open reads as no repository, and asks git nothing", async () => {
    const git = new FakeGit();
    assert.equal(
      await render("{branch}|{changedFiles}|{diff}", { api: git, projectPath: "" }),
      "(no git repository)|(no git repository)|(no git repository)"
    );
    assert.equal(git.statusCalls.length + git.diffCalls.length, 0);
  });
});

describe("only what the body uses is read", () => {
  it("no git variable: git is never asked", async () => {
    const git = new FakeGit();
    await render("{project} {date} {agent}", { api: git });
    assert.deepEqual(git.statusCalls, []);
    assert.deepEqual(git.diffCalls, []);
  });

  it("{branch} and {changedFiles} share one status read; no diff read", async () => {
    const git = new FakeGit();
    await render("{branch} {changedFiles} {branch}", { api: git });
    assert.deepEqual(git.statusCalls, [PROJECT]);
    assert.deepEqual(git.diffCalls, []);
  });

  it("{diff} alone reads only the diff", async () => {
    const git = new FakeGit();
    await render("{diff}", { api: git });
    assert.deepEqual(git.statusCalls, []);
    assert.equal(git.diffCalls.length, 1);
  });

  it("an escaped {{diff}} is text, not a read", async () => {
    const git = new FakeGit();
    assert.equal(await render("Write {{diff}} here", { api: git }), "Write {diff} here");
    assert.equal(git.diffCalls.length, 0);
  });

  it("status and diff are read in parallel, with the caller's signal", async () => {
    let releaseStatus!: () => void;
    const git = new FakeGit(
      () =>
        new Promise((resolve) => {
          releaseStatus = () => resolve(status());
        })
    );
    const controller = new AbortController();
    const pending = resolveSavedPrompt({
      body: "{branch}\n{diff}",
      projectPath: PROJECT,
      sessionId: "s1",
      api: git,
      now: NOW,
      signal: controller.signal
    });
    await Promise.resolve();
    assert.equal(git.statusCalls.length, 1);
    assert.equal(git.diffCalls.length, 1, "the diff is asked before the status answers");
    assert.ok(git.signals.every((signal) => signal === controller.signal));
    releaseStatus();
    assert.deepEqual(await pending, { ok: true, text: "main\n(no uncommitted changes)" });
  });
});

describe("text that is not a known variable", () => {
  it("unknown names and code braces stay as written", async () => {
    assert.equal(
      await render("{issue} ${x} { a: 1 } {Project} {branch}"),
      "{issue} ${x} { a: 1 } {Project} main"
    );
  });
});

describe("failures", () => {
  it("a failed git read resolves nothing, and says why", async () => {
    const git = new FakeGit(() =>
      Promise.reject(Object.assign(new Error("API failed with status 500"), { serverMessage: "fatal: bad object" }))
    );
    assert.deepEqual(
      await resolveSavedPrompt({ body: "{branch}", projectPath: PROJECT, sessionId: "s1", api: git }),
      { ok: false, reason: "Couldn't read git status: fatal: bad object" }
    );
    const diffFails = new FakeGit(undefined, () => Promise.reject(new Error("timeout")));
    assert.deepEqual(
      await resolveSavedPrompt({ body: "{diff}", projectPath: PROJECT, sessionId: "s1", api: diffFails }),
      { ok: false, reason: "Couldn't read the git diff: timeout" },
      "a failed diff read says so"
    );
    assert.deepEqual(
      await resolveSavedPrompt({ body: "{branch} {diff}", projectPath: PROJECT, sessionId: "s1", api: diffFails }),
      { ok: false, reason: "Couldn't read the git diff: timeout" },
      "the status read succeeded, the diff read did not"
    );
    const bothFail = new FakeGit(
      () => Promise.reject(new Error("status down")),
      () => Promise.reject(new Error("diff down"))
    );
    assert.deepEqual(
      await resolveSavedPrompt({ body: "{diff} {branch}", projectPath: PROJECT, sessionId: "s1", api: bothFail }),
      { ok: false, reason: "Couldn't read git status: status down" },
      "both failed: the status one is named"
    );
  });

  it("an aborted resolve answers nothing to deliver", async () => {
    const controller = new AbortController();
    const git = new FakeGit(() => {
      controller.abort();
      return Promise.reject(new DOMException("aborted", "AbortError"));
    });
    const result = await resolveSavedPrompt({
      body: "{branch}",
      projectPath: PROJECT,
      sessionId: "s1",
      api: git,
      signal: controller.signal
    });
    assert.equal(result.ok, false);
  });
});
