import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  forgeLinkLabel,
  githubPreviewKey,
  githubPreviewTarget,
  parseChangeRequestLink,
  parseForgeLink,
  parseGitHubLink,
  type ForgeLink
} from "./forge-links.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";

/** Only the fields a case asserts; `forge`, `owner`, `repo` and `url` are checked separately. */
function target(href: string): Record<string, unknown> | null {
  const link = parseGitHubLink(href);
  if (!link) return null;
  const { forge: _forge, url: _url, owner: _owner, repo: _repo, ...rest } = link;
  return rest;
}

describe("parseGitHubLink", () => {
  it("reads pull requests, their tabs and their comment anchors", () => {
    assert.deepEqual(target("https://github.com/acme/app/pull/123"), { kind: "pull", number: 123 });
    assert.deepEqual(target("https://github.com/acme/app/pull/123/"), { kind: "pull", number: 123 });
    assert.deepEqual(target("https://github.com/acme/app/pull/123/files"), { kind: "pull", number: 123, tab: "files" });
    assert.deepEqual(target("https://github.com/acme/app/pull/123/changes"), { kind: "pull", number: 123, tab: "files" });
    assert.deepEqual(target("https://github.com/acme/app/pull/123/commits"), { kind: "pull", number: 123, tab: "commits" });
    assert.deepEqual(target("https://github.com/acme/app/pull/123/checks"), { kind: "pull", number: 123, tab: "checks" });
    assert.deepEqual(target("https://github.com/acme/app/pull/123/files#diff-abc"), { kind: "pull", number: 123, tab: "files" });
    assert.deepEqual(target("https://github.com/acme/app/pull/123#discussion_r1500"), { kind: "pull", number: 123, comment: true });
    assert.deepEqual(target("https://github.com/acme/app/pull/123#issuecomment-99"), { kind: "pull", number: 123, comment: true });
    assert.deepEqual(target("https://github.com/acme/app/pull/123#pullrequestreview-7"), { kind: "pull", number: 123, comment: true });
    assert.deepEqual(target("https://github.com/acme/app/pull/123?w=1"), { kind: "pull", number: 123 });
    assert.deepEqual(target("http://www.github.com/acme/app/pull/5"), { kind: "pull", number: 5 });
  });

  it("reads a commit inside a pull request as that commit", () => {
    assert.deepEqual(target(`https://github.com/acme/app/pull/12/commits/${SHA}`), { kind: "commit", sha: SHA, pullNumber: 12 });
    assert.deepEqual(target("https://github.com/acme/app/pull/12/commits/ABCDEF1"), { kind: "commit", sha: "abcdef1", pullNumber: 12 });
    assert.equal(target("https://github.com/acme/app/pull/12/commits/nothex!"), null);
  });

  it("reads issues and discussions", () => {
    assert.deepEqual(target("https://github.com/acme/app/issues/9"), { kind: "issue", number: 9 });
    assert.deepEqual(target("https://github.com/acme/app/issues/9#issuecomment-1"), { kind: "issue", number: 9, comment: true });
    assert.deepEqual(target("https://github.com/acme/app/discussions/41"), { kind: "discussion", number: 41 });
    assert.deepEqual(target("https://github.com/acme/app/discussions/41#discussioncomment-3"), {
      kind: "discussion",
      number: 41,
      comment: true
    });
    assert.equal(target("https://github.com/acme/app/issues"), null);
    assert.equal(target("https://github.com/acme/app/issues/new"), null);
    assert.equal(target("https://github.com/acme/app/issues/0"), null);
    assert.equal(target("https://github.com/acme/app/issues/012"), null);
    assert.equal(target("https://github.com/acme/app/issues/99999999999"), null);
  });

  it("reads commits by short or full SHA", () => {
    assert.deepEqual(target(`https://github.com/acme/app/commit/${SHA}`), { kind: "commit", sha: SHA });
    assert.deepEqual(target("https://github.com/acme/app/commit/abc1234"), { kind: "commit", sha: "abc1234" });
    assert.equal(target("https://github.com/acme/app/commit/abc12"), null);
    assert.equal(target(`https://github.com/acme/app/commit/${SHA}0`), null);
    assert.equal(target(`https://github.com/acme/app/commit/${SHA}.patch`), null);
  });

  it("reads repos, with or without .git", () => {
    const repo = parseGitHubLink("https://github.com/Acme/My.App");
    assert.equal(repo?.kind, "repo");
    assert.equal(repo?.owner, "Acme");
    assert.equal(repo?.repo, "My.App");
    assert.equal(parseGitHubLink("https://github.com/acme/app.git")?.repo, "app");
    assert.deepEqual(target("https://github.com/acme/app/"), { kind: "repo" });
  });

  it("reads blobs with line ranges and trees", () => {
    assert.deepEqual(target("https://github.com/acme/app/blob/main/src/index.ts"), {
      kind: "blob",
      ref: "main",
      path: "src/index.ts"
    });
    assert.deepEqual(target("https://github.com/acme/app/blob/main/src/index.ts#L10"), {
      kind: "blob",
      ref: "main",
      path: "src/index.ts",
      lines: { start: 10 }
    });
    assert.deepEqual(target("https://github.com/acme/app/blob/v1.2/src/a.ts#L10-L20"), {
      kind: "blob",
      ref: "v1.2",
      path: "src/a.ts",
      lines: { start: 10, end: 20 }
    });
    assert.deepEqual(target(`https://github.com/acme/app/blob/${SHA}/a.ts#L5C3-L9C1`), {
      kind: "blob",
      ref: SHA,
      path: "a.ts",
      lines: { start: 5, end: 9 }
    });
    // A reversed range reads in order; a range on one line is that line.
    assert.deepEqual((target("https://github.com/acme/app/blob/main/a.ts#L20-L10") as { lines: unknown }).lines, { start: 10, end: 20 });
    assert.deepEqual((target("https://github.com/acme/app/blob/main/a.ts#L7-L7") as { lines: unknown }).lines, { start: 7 });
    // An anchor that is not a line range is ignored.
    assert.deepEqual(target("https://github.com/acme/app/blob/main/README.md#install"), {
      kind: "blob",
      ref: "main",
      path: "README.md"
    });
    assert.deepEqual(target("https://github.com/acme/app/blob/main/docs/My%20File.md"), {
      kind: "blob",
      ref: "main",
      path: "docs/My File.md"
    });
    assert.deepEqual(target("https://github.com/acme/app/tree/main/packages/ui"), { kind: "tree", ref: "main", path: "packages/ui" });
    assert.deepEqual(target("https://github.com/acme/app/tree/dev"), { kind: "tree", ref: "dev", path: "" });
    assert.equal(target("https://github.com/acme/app/blob/main"), null);
    assert.equal(target("https://github.com/acme/app/blob"), null);
    assert.equal(target("https://github.com/acme/app/blob/main/%E0%A4%A"), null);
    // `URL` resolves an encoded traversal before the parser sees it: the link is to `b`.
    assert.deepEqual(target("https://github.com/acme/app/blob/main/a/%2E%2E/b"), { kind: "blob", ref: "main", path: "b" });
  });

  it("reads releases and Actions runs", () => {
    assert.deepEqual(target("https://github.com/acme/app/releases"), { kind: "release" });
    assert.deepEqual(target("https://github.com/acme/app/releases/latest"), { kind: "release", latest: true });
    assert.deepEqual(target("https://github.com/acme/app/releases/tag/v1.2.3"), { kind: "release", tag: "v1.2.3" });
    assert.deepEqual(target("https://github.com/acme/app/releases/tag/app%401.0"), { kind: "release", tag: "app@1.0" });
    assert.equal(target("https://github.com/acme/app/releases/download/v1/app.zip"), null);
    assert.deepEqual(target("https://github.com/acme/app/actions/runs/1234567"), { kind: "actions-run", runId: 1234567 });
    assert.deepEqual(target("https://github.com/acme/app/actions/runs/1234567/attempts/2"), { kind: "actions-run", runId: 1234567 });
    assert.deepEqual(target("https://github.com/acme/app/actions/runs/1234567/job/89"), { kind: "actions-run", runId: 1234567, jobId: 89 });
    assert.equal(target("https://github.com/acme/app/actions"), null);
    assert.equal(target("https://github.com/acme/app/actions/runs/x"), null);
  });

  it("rejects look-alike hosts, credentials, ports and other schemes", () => {
    for (const href of [
      "https://github.com.evil.example/acme/app/pull/1",
      "https://evilgithub.com/acme/app/pull/1",
      "https://github.co/acme/app/pull/1",
      "https://gist.github.com/acme/abc123",
      "https://api.github.com/repos/acme/app/pulls/1",
      "https://raw.githubusercontent.com/acme/app/main/a.ts",
      "https://github.com@evil.example/acme/app/pull/1",
      "https://user:pass@github.com/acme/app/pull/1",
      "https://github.com:8443/acme/app/pull/1",
      "ftp://github.com/acme/app/pull/1",
      "javascript:alert(1)//github.com/acme/app/pull/1",
      "https://evil.example/github.com/acme/app/pull/1",
      "github.com/acme/app/pull/1",
      "/acme/app/pull/1",
      "",
      "not a url"
    ]) {
      assert.equal(parseGitHubLink(href), null, href);
    }
    // A default port normalizes away: still GitHub.
    assert.equal(parseGitHubLink("https://github.com:443/acme/app/pull/1")?.kind, "pull");
    assert.equal(parseGitHubLink("https://GITHUB.COM/acme/app/pull/1")?.kind, "pull");
  });

  it("rejects GitHub's own pages and invalid names", () => {
    for (const href of [
      "https://github.com/",
      "https://github.com/acme",
      "https://github.com/settings/tokens",
      "https://github.com/orgs/acme/people",
      "https://github.com/marketplace/actions/checkout",
      "https://github.com/notifications/beta",
      "https://github.com/pulls/assigned",
      "https://github.com/-acme/app",
      "https://github.com/ac_me/app",
      "https://github.com/acme/ap p",
      "https://github.com/acme/app/wiki/Home",
      "https://github.com/acme/app/compare/main...dev",
      "https://github.com/acme/app/pull/1/unknown-tab",
      "https://github.com/acme//app/pull/1"
    ]) {
      assert.equal(parseGitHubLink(href), null, href);
    }
  });

  it("keeps owner and repo as written and the URL normalized", () => {
    const link = parseGitHubLink("https://github.com/Acme/App/pull/7");
    assert.equal(link?.forge, "github");
    assert.equal(link?.owner, "Acme");
    assert.equal(link?.repo, "App");
    assert.equal(link?.url, "https://github.com/Acme/App/pull/7");
  });
});

describe("parseChangeRequestLink", () => {
  it("reads GitLab merge requests on gitlab.com and gitlab hosts", () => {
    assert.deepEqual(parseChangeRequestLink("https://gitlab.com/group/sub/project/-/merge_requests/42"), {
      forge: "gitlab",
      kind: "pull",
      url: "https://gitlab.com/group/sub/project/-/merge_requests/42",
      host: "gitlab.com",
      repository: "group/sub/project",
      number: 42
    });
    assert.equal(parseChangeRequestLink("https://gitlab.example.org/a/b/-/merge_requests/3/diffs")?.number, 3);
    assert.equal(parseChangeRequestLink("https://gitlab.com/project/-/merge_requests/3"), null);
    assert.equal(parseChangeRequestLink("https://example.org/a/b/-/merge_requests/3"), null);
    assert.equal(parseChangeRequestLink("https://notgitlab.com/a/b/-/merge_requests/3"), null);
    assert.equal(parseChangeRequestLink("https://gitlab.com/a/b/-/issues/3"), null);
  });

  it("reads Bitbucket Cloud pull requests", () => {
    assert.deepEqual(parseChangeRequestLink("https://bitbucket.org/team/repo/pull-requests/8/diff"), {
      forge: "bitbucket",
      kind: "pull",
      url: "https://bitbucket.org/team/repo/pull-requests/8/diff",
      host: "bitbucket.org",
      repository: "team/repo",
      number: 8
    });
    assert.equal(parseChangeRequestLink("https://bitbucket.org.evil.example/team/repo/pull-requests/8"), null);
    assert.equal(parseChangeRequestLink("https://bitbucket.org/team/repo/issues/8"), null);
  });

  it("parseForgeLink prefers GitHub and falls through to the others", () => {
    assert.equal(parseForgeLink("https://github.com/a/b/pull/1")?.forge, "github");
    assert.equal(parseForgeLink("https://bitbucket.org/a/b/pull-requests/1")?.forge, "bitbucket");
    assert.equal(parseForgeLink("https://example.com/a/b/pull/1"), null);
  });
});

describe("forgeLinkLabel", () => {
  const label = (href: string, currentRepoKey?: string): string => {
    const link = parseForgeLink(href);
    assert.ok(link, href);
    return forgeLinkLabel(link, { currentRepoKey: currentRepoKey ?? null });
  };
  const OWN = "github.com/acme/app";

  it("names issues and PRs with owner/repo, dropping it inside the project's own repo", () => {
    assert.equal(label("https://github.com/acme/app/pull/123"), "acme/app#123");
    assert.equal(label("https://github.com/acme/app/pull/123", OWN), "#123");
    assert.equal(label("https://github.com/Acme/App/pull/123", OWN), "#123");
    assert.equal(label("https://github.com/acme/other/pull/123", OWN), "acme/other#123");
    assert.equal(label("https://github.com/acme/app/issues/4", OWN), "#4");
    assert.equal(label("https://github.com/acme/app/discussions/4"), "acme/app#4");
    assert.equal(label("https://github.com/acme/app/pull/123/files", OWN), "#123 (files)");
    assert.equal(label("https://github.com/acme/app/pull/123/commits"), "acme/app#123 (commits)");
    assert.equal(label("https://github.com/acme/app/pull/123#discussion_r1", OWN), "#123 (comment)");
    assert.equal(label("https://github.com/acme/app/issues/5#issuecomment-1"), "acme/app#5 (comment)");
  });

  it("names commits by their short SHA", () => {
    assert.equal(label(`https://github.com/acme/app/commit/${SHA}`), "acme/app@0123456");
    assert.equal(label(`https://github.com/acme/app/commit/${SHA}`, OWN), "0123456");
    assert.equal(label(`https://github.com/acme/app/pull/3/commits/${SHA}`), "acme/app@0123456");
  });

  it("names files, folders, releases and runs under the repo name", () => {
    assert.equal(label("https://github.com/acme/app"), "acme/app");
    assert.equal(label("https://github.com/acme/app", OWN), "acme/app");
    assert.equal(label("https://github.com/acme/app/blob/main/src/index.ts#L10-L20"), "app › src/index.ts#L10-20");
    assert.equal(label("https://github.com/acme/app/blob/main/src/index.ts#L10", OWN), "src/index.ts#L10");
    assert.equal(label("https://github.com/acme/app/blob/main/a/b/c/d/e.ts"), "app › …/c/d/e.ts");
    assert.equal(label("https://github.com/acme/app/tree/main/packages/ui"), "app › packages/ui/");
    assert.equal(label("https://github.com/acme/app/tree/main", OWN), "app › main");
    assert.equal(label("https://github.com/acme/app/releases/tag/v1.2.3"), "app › v1.2.3");
    assert.equal(label("https://github.com/acme/app/releases/tag/v1.2.3", OWN), "v1.2.3");
    assert.equal(label("https://github.com/acme/app/releases/latest"), "app › latest release");
    assert.equal(label("https://github.com/acme/app/releases"), "app › releases");
    assert.equal(label("https://github.com/acme/app/actions/runs/77"), "app › run 77");
    assert.equal(label("https://github.com/acme/app/actions/runs/77/job/8", OWN), "run 77 › job 8");
  });

  it("names GitLab MRs with ! and Bitbucket PRs with #", () => {
    assert.equal(label("https://gitlab.com/g/p/-/merge_requests/42"), "g/p!42");
    assert.equal(label("https://bitbucket.org/team/repo/pull-requests/8"), "team/repo#8");
  });
});

describe("githubPreviewTarget", () => {
  it("fetches PRs, issues and commits only", () => {
    const of = (href: string) => githubPreviewTarget(parseForgeLink(href) as ForgeLink);
    assert.deepEqual(of("https://github.com/a/b/pull/1/files"), { kind: "pull", owner: "a", repo: "b", number: 1 });
    assert.deepEqual(of("https://github.com/a/b/issues/2"), { kind: "issue", owner: "a", repo: "b", number: 2 });
    assert.deepEqual(of(`https://github.com/a/b/pull/1/commits/${SHA}`), { kind: "commit", owner: "a", repo: "b", sha: SHA });
    for (const href of [
      "https://github.com/a/b",
      "https://github.com/a/b/discussions/3",
      "https://github.com/a/b/blob/main/x",
      "https://github.com/a/b/releases",
      "https://github.com/a/b/actions/runs/3",
      "https://gitlab.com/g/p/-/merge_requests/2"
    ]) {
      assert.equal(of(href), null, href);
    }
  });

  it("keys targets case-insensitively", () => {
    assert.equal(
      githubPreviewKey({ kind: "pull", owner: "Acme", repo: "App", number: 3 }),
      githubPreviewKey({ kind: "pull", owner: "acme", repo: "app", number: 3 })
    );
    assert.notEqual(
      githubPreviewKey({ kind: "pull", owner: "acme", repo: "app", number: 3 }),
      githubPreviewKey({ kind: "issue", owner: "acme", repo: "app", number: 3 })
    );
    assert.equal(githubPreviewKey({ kind: "commit", owner: "a", repo: "b", sha: "ABCDEF1" }), "commit:a/b@abcdef1");
  });
});
