// The pull request watch read (`getPullRequestStatus`) of each provider: state, head, mergeability,
// checks and remarks mapped from API payloads, with every request going to a stubbed `fetch`.
//
// GitHub and Bitbucket Cloud payloads are trimmed captures of public pull requests
// (./fixtures/*-pr-watch-*.json: cli/cli#14679, atlassianlabs/atlascode#1115, read anonymously on
// 2026-10-14); the Bitbucket Cloud approval / change-request activity entries and every Bitbucket
// Server payload are synthetic, written from the providers' REST references.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { bitbucketCloudProvider, resetBitbucketCloudWatchState } from "./bitbucket-cloud";
import { bitbucketServerProvider } from "./bitbucket-server";
import { githubProvider, resetGithubWatchState } from "./github";
import { GitRemoteError } from "./types";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  resetGithubWatchState();
  resetBitbucketCloudWatchState();
});

interface Seen {
  url: string;
  headers: Record<string, string>;
}

/** Answer each fetch from `routes` (first pattern the URL's path+query matches); 404 otherwise. */
function stubRoutes(routes: Array<[RegExp, () => Response]>): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])
    );
    seen.push({ url, headers });
    const parsed = new URL(url);
    const target = parsed.pathname + parsed.search;
    for (const [pattern, respond] of routes) if (pattern.test(target)) return respond();
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return seen;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

// --- GitHub ------------------------------------------------------------------

const GH_SHA = "2de1e0886a0cf896165db70e7729b28bd5b0febc";

function githubRoutes(over: { pull?: Record<string, unknown>; checkRuns?: unknown; issueComments?: unknown } = {}): Array<[RegExp, () => Response]> {
  const pull = { ...(fixture("github-pr-watch-pull.json") as Record<string, unknown>), ...over.pull };
  return [
    [/^\/repos\/cli\/cli\/pulls\/14679$/, () => json(pull)],
    [new RegExp(`/commits/${GH_SHA}/check-runs`), () => json(over.checkRuns ?? fixture("github-pr-watch-check-runs.json"))],
    [new RegExp(`/commits/${GH_SHA}/status`), () => json(fixture("github-pr-watch-status.json"))],
    [/\/issues\/14679\/comments/, () => json(over.issueComments ?? [])],
    [/\/pulls\/14679\/comments/, () => json(fixture("github-pr-watch-review-comments.json"))],
    [/\/pulls\/14679\/reviews/, () => json(fixture("github-pr-watch-reviews.json"))]
  ];
}

test("github: an open pull request maps state, head, base, mergeability, checks and remarks", async () => {
  const seen = stubRoutes(githubRoutes());
  const status = await githubProvider.getPullRequestStatus(
    { token: "ghp_test" },
    { owner: "cli", repo: "cli" },
    14679,
    { remarksSince: "2026-10-14T05:00:00.000Z" }
  );
  assert.equal(status.state, "open");
  assert.equal(status.headSha, GH_SHA);
  assert.equal(status.baseBranch, "trunk");
  assert.equal(status.url, "https://github.com/cli/cli/pull/14679");
  assert.equal(status.mergeability, "clean");
  assert.deepEqual(
    status.checks.map((check) => [check.name, check.status]),
    [
      ["CodeQL", "success"],
      ["copilot-pull-request-reviewer", "success"],
      ["check-requirements / close-unmet-requirements", "skipped"],
      ["ready-for-review", "skipped"]
    ]
  );
  assert.equal(status.checks[0]!.url, "https://github.com/cli/cli/runs/115691177693");
  assert.deepEqual(
    status.remarks?.map((remark) => [remark.id, remark.kind, remark.author, remark.path, remark.reviewState]),
    [
      ["rc:4266994277", "review-comment", "Copilot", "pkg/cmd/auth/login/login_test.go", null],
      ["rv:5513319160", "review", "copilot-pull-request-reviewer[bot]", null, "commented"]
    ]
  );
  // Captured as CONTRIBUTOR: not vouched for by the repository, so never quoted.
  assert.deepEqual(status.remarks?.map((remark) => remark.trusted), [false, false]);
  // The review comment's updated_at differs from created_at by a second: an edit.
  assert.equal(status.remarks?.[0]?.editedAt, "2026-10-14T05:07:25Z");
  for (const request of seen) assert.equal(request.headers.authorization, "Bearer ghp_test");
  const comments = seen.find((request) => request.url.includes("/issues/14679/comments"))!;
  assert.equal(new URL(comments.url).searchParams.get("since"), "2026-10-14T05:00:00.000Z");
});

test("github: a re-run's newest run stands for its check; a failing status counts", async () => {
  stubRoutes(
    githubRoutes({
      checkRuns: {
        check_runs: [
          { id: 2, name: "build", status: "in_progress", conclusion: null, html_url: "https://x/2" },
          { id: 1, name: "build", status: "completed", conclusion: "failure", html_url: "https://x/1" },
          { id: 3, name: "lint", status: "completed", conclusion: "timed_out", html_url: "https://x/3" },
          { id: 4, name: "deploy", status: "completed", conclusion: "action_required", html_url: "https://x/4" }
        ]
      }
    })
  );
  const status = await githubProvider.getPullRequestStatus(null, { owner: "cli", repo: "cli" }, 14679);
  assert.deepEqual(
    status.checks.map((check) => [check.name, check.status]),
    [
      ["build", "pending"],
      ["lint", "failure"],
      ["deploy", "action-required"]
    ]
  );
});

test("github: a conflict, a mergeability still computing, and a merged pull request read nothing more", async () => {
  stubRoutes(githubRoutes({ pull: { mergeable: false, mergeable_state: "dirty" } }));
  assert.equal((await githubProvider.getPullRequestStatus(null, { owner: "cli", repo: "cli" }, 14679)).mergeability, "conflicting");

  stubRoutes(githubRoutes({ pull: { mergeable: null, mergeable_state: "unknown" } }));
  assert.equal((await githubProvider.getPullRequestStatus(null, { owner: "cli", repo: "cli" }, 14679)).mergeability, "unknown");

  const seen = stubRoutes(githubRoutes({ pull: { state: "closed", merged_at: "2026-10-14T06:00:00Z", merged: true } }));
  const merged = await githubProvider.getPullRequestStatus(null, { owner: "cli", repo: "cli" }, 14679);
  assert.equal(merged.state, "merged");
  assert.deepEqual([merged.checks, merged.remarks], [[], []]);
  assert.equal(seen.length, 1);
});

test("github: remarks past the pages a read follows are reported as unknown, not as none", async () => {
  let page = 0;
  stubRoutes([
    [/\/issues\/14679\/comments/, () => {
      page += 1;
      return json([{ id: page, user: { login: "x" }, body: "b", created_at: "2026-10-14T06:00:00Z", updated_at: "2026-10-14T06:00:00Z" }], 200, {
        link: `<https://api.github.com/repos/cli/cli/issues/14679/comments?page=${page + 1}>; rel="next"`
      });
    }],
    ...githubRoutes()
  ]);
  const status = await githubProvider.getPullRequestStatus(null, { owner: "cli", repo: "cli" }, 14679);
  assert.equal(status.remarks, null);
});

test("github: a spent rate limit is a rate_limited GitRemoteError with when to retry", async () => {
  stubRoutes([[/pulls\/14679$/, () => json({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0", "retry-after": "120" })]]);
  await assert.rejects(
    githubProvider.getPullRequestStatus(null, { owner: "cli", repo: "cli" }, 14679),
    (error: unknown) => error instanceof GitRemoteError && error.kind === "rate_limited" && error.retryAfterMs === 120_000
  );
});

// --- Bitbucket Cloud -----------------------------------------------------------

function cloudRoutes(over: { diffstat?: unknown; pull?: Record<string, unknown> } = {}): Array<[RegExp, () => Response]> {
  const prefix = "/2.0/repositories/atlassianlabs/atlascode/pullrequests/1115";
  return [
    [new RegExp(`^${prefix}$`), () => json({ ...(fixture("bitbucket-cloud-pr-watch-pull.json") as Record<string, unknown>), ...over.pull })],
    [new RegExp(`^${prefix}/statuses`), () => json(fixture("bitbucket-cloud-pr-watch-statuses.json"))],
    [new RegExp(`^${prefix}/comments`), () => json(fixture("bitbucket-cloud-pr-watch-comments.json"))],
    [new RegExp(`^${prefix}/activity`), () => json(fixture("bitbucket-cloud-pr-watch-activity.json"))],
    [new RegExp(`^${prefix}/diffstat`), () => json(over.diffstat ?? fixture("bitbucket-cloud-pr-watch-diffstat.json"))]
  ];
}

test("bitbucket cloud: maps the pull request, its head's statuses, comments since, verdicts and diffstat", async () => {
  const seen = stubRoutes(cloudRoutes());
  const status = await bitbucketCloudProvider.getPullRequestStatus(
    { token: "atl", email: "me@example.com" },
    { owner: "atlassianlabs", repo: "atlascode" },
    1115,
    { remarksSince: "2026-06-09T22:07:03.000Z" }
  );
  assert.equal(status.state, "open");
  assert.equal(status.headSha, "31b8ff8dad0a");
  assert.equal(status.baseBranch, "main");
  assert.equal(status.url, "https://bitbucket.org/atlassianlabs/atlascode/pull-requests/1115");
  assert.equal(status.mergeability, "clean");
  // The status names the full hash; the pull request the abbreviated one.
  assert.deepEqual(status.checks, [
    { name: "Pipeline - branches: **", status: "success", url: "https://bitbucket.org/atlassianlabs/atlascode/pipelines/results/4455", required: null }
  ]);
  assert.deepEqual(
    status.remarks?.map((remark) => [remark.id, remark.kind, remark.author, remark.path, remark.reviewState, remark.editedAt]),
    [
      ["c:808855610", "review-comment", "Rovo Dev", "src/util/shell.test.ts", null, null],
      ["ap:{0b0e8f2a-0000-4000-8000-000000000001}:2026-06-10T09:00:00.000Z", "review", "ana", null, "approved", null],
      ["cr:{0b0e8f2a-0000-4000-8000-000000000002}:2026-06-10T09:30:00.000Z", "review", "bo", null, "changes requested", null]
    ]
  );
  assert.equal(status.remarks?.[0]?.authorRef, "712020:0ce54ba4-841e-47d9-943e-872f93f78020");
  assert.ok(seen.every((request) => request.headers.authorization?.startsWith("Basic ")));
});

test("bitbucket cloud: a merge-conflict diffstat entry is a conflict; a declined pull request is closed", async () => {
  stubRoutes(cloudRoutes({ diffstat: { values: [{ type: "diffstat", status: "merge conflict", new: { path: "a" } }] } }));
  const conflicted = await bitbucketCloudProvider.getPullRequestStatus(null, { owner: "atlassianlabs", repo: "atlascode" }, 1115);
  assert.equal(conflicted.mergeability, "conflicting");

  const seen = stubRoutes(cloudRoutes({ pull: { state: "DECLINED" } }));
  const declined = await bitbucketCloudProvider.getPullRequestStatus(null, { owner: "atlassianlabs", repo: "atlascode" }, 1115);
  assert.equal(declined.state, "closed");
  assert.equal(seen.length, 1);
});

// --- Bitbucket Server / Data Center ----------------------------------------------

const DC = { token: "dc-token", baseUrl: "https://bb.corp.example/bitbucket" };
const DC_PREFIX = "/bitbucket/rest/api/1.0/projects/PRJ/repos/api/pull-requests/101";
const DC_SHA = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567";

function dcRoutes(over: { merge?: () => Response; builds?: () => Response; state?: string } = {}): Array<[RegExp, () => Response]> {
  const pull = (fixture("bitbucket-server-pull-requests.json") as { values: Record<string, unknown>[] }).values[0]!;
  return [
    [new RegExp(`^${DC_PREFIX}$`), () => json({ ...pull, state: over.state ?? "OPEN" })],
    [new RegExp(`^${DC_PREFIX}/merge$`), over.merge ?? (() => json({ canMerge: false, conflicted: true, outcome: "CONFLICTED", vetoes: [] }))],
    [
      new RegExp(`^/bitbucket/rest/build-status/1.0/commits/${DC_SHA}`),
      over.builds ??
        (() =>
          json({
            values: [
              { state: "FAILED", key: "ci", name: "CI", url: "https://ci/1", dateAdded: 1_760_000_000_000 },
              { state: "INPROGRESS", key: "ci", name: "CI", url: "https://ci/2", dateAdded: 1_760_000_100_000 },
              { state: "SUCCESSFUL", key: "lint", name: "Lint", url: "https://ci/3", dateAdded: 1_760_000_000_000 }
            ],
            isLastPage: true
          }))
    ],
    [
      new RegExp(`^${DC_PREFIX}/activities`),
      () =>
        json({
          values: [
            { id: 9, action: "APPROVED", createdDate: 1_760_000_300_000, user: { name: "ana", slug: "ana" } },
            { id: 8, action: "REVIEWED", createdDate: 1_760_000_250_000, user: { name: "bo", slug: "bo" } },
            {
              id: 7,
              action: "COMMENTED",
              commentAction: "ADDED",
              createdDate: 1_760_000_200_000,
              user: { name: "cy", slug: "cy" },
              comment: { id: 55, text: "Rename this", author: { name: "cy", slug: "cy" }, createdDate: 1_760_000_200_000, updatedDate: 1_760_000_200_000 },
              commentAnchor: { path: "src/health.ts" }
            },
            { id: 6, action: "COMMENTED", commentAction: "ADDED", createdDate: 1_700_000_000_000, user: { name: "old" }, comment: { id: 1, text: "old" } }
          ],
          isLastPage: false,
          nextPageStart: 4
        })
    ]
  ];
}

test("bitbucket server: maps builds (newest per key), the merge check and the activity stream since", async () => {
  const seen = stubRoutes(dcRoutes());
  const status = await bitbucketServerProvider.getPullRequestStatus(DC, { owner: "PRJ", repo: "api" }, 101, {
    remarksSince: new Date(1_760_000_000_000).toISOString()
  });
  assert.equal(status.state, "open");
  assert.equal(status.headSha, DC_SHA);
  assert.equal(status.mergeability, "conflicting");
  assert.deepEqual(
    status.checks.map((check) => [check.name, check.status]),
    [
      ["CI", "pending"],
      ["Lint", "success"]
    ]
  );
  assert.deepEqual(
    status.remarks?.map((remark) => [remark.id, remark.kind, remark.author, remark.path, remark.reviewState]),
    [
      ["c:55", "review-comment", "cy", "src/health.ts", null],
      ["a:8", "review", "bo", null, "needs work"],
      ["a:9", "review", "ana", null, "approved"]
    ]
  );
  assert.equal(status.remarks?.[0]?.url, "https://bb.corp.example/bitbucket/projects/PRJ/repos/api/pull-requests/101/overview?commentId=55");
  // An older entry ends the read: no second activity page.
  assert.equal(seen.filter((request) => request.url.includes("/activities")).length, 1);
  assert.ok(seen.every((request) => request.headers.authorization === "Bearer dc-token"));
});

test("bitbucket server: no build-status API means no checks; an unanswered merge check is unknown; no account is refused", async () => {
  stubRoutes(dcRoutes({ builds: () => json({}, 404), merge: () => json({ errors: [] }, 409) }));
  const status = await bitbucketServerProvider.getPullRequestStatus(DC, { owner: "PRJ", repo: "api" }, 101);
  assert.deepEqual(status.checks, []);
  assert.equal(status.mergeability, "unknown");

  await assert.rejects(
    bitbucketServerProvider.getPullRequestStatus(null, { owner: "PRJ", repo: "api" }, 101),
    (error: unknown) => error instanceof GitRemoteError && error.kind === "unsupported"
  );
});

// --- fix round 1: trust, conditional requests, rate windows -------------------

test("github: only OWNER / MEMBER / COLLABORATOR remarks are trusted", async () => {
  const comment = (id: number, association: string) => ({
    id,
    user: { login: `u${id}` },
    body: "b",
    created_at: "2026-10-14T06:00:00Z",
    updated_at: "2026-10-14T06:00:00Z",
    author_association: association
  });
  stubRoutes([
    [/\/issues\/14679\/comments/, () => json(["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "NONE"].map((a, i) => comment(i + 1, a)))],
    ...githubRoutes()
  ]);
  const status = await githubProvider.getPullRequestStatus(null, { owner: "cli", repo: "cli" }, 14679);
  assert.deepEqual(
    status.remarks?.filter((remark) => remark.id.startsWith("ic:")).map((remark) => [remark.author, remark.trusted]),
    [["u1", true], ["u2", true], ["u3", true], ["u4", false], ["u5", false], ["u6", false]]
  );
});

test("github: a second read is conditional, and a 304 reuses the cached answer", async () => {
  const etagged = githubRoutes().map(([pattern, respond]): [RegExp, () => Response] => [
    pattern,
    () => {
      const res = respond();
      const headers = new Headers(res.headers);
      headers.set("etag", `"${pattern.source.length}"`);
      return new Response(res.body, { status: res.status, headers });
    }
  ]);
  stubRoutes(etagged);
  const first = await githubProvider.getPullRequestStatus({ token: "t" }, { owner: "cli", repo: "cli" }, 14679);
  const seen = stubRoutes([[/./, () => new Response(null, { status: 304 })]]);
  const second = await githubProvider.getPullRequestStatus({ token: "t" }, { owner: "cli", repo: "cli" }, 14679);
  assert.ok(seen.length > 0);
  assert.ok(seen.every((request) => request.headers["if-none-match"]?.startsWith('"')));
  assert.deepEqual(second, first);
  // Another reader never gets this reader's cached answers.
  const other = stubRoutes(githubRoutes());
  await githubProvider.getPullRequestStatus({ token: "other" }, { owner: "cli", repo: "cli" }, 14679);
  assert.ok(other.every((request) => request.headers["if-none-match"] === undefined));
});

test("github: an anonymous reader near its hourly limit is refused until the reset, without a request", async () => {
  const reset = Math.ceil(Date.now() / 1000) + 1_800;
  stubRoutes([[/pulls\/14679$/, () => json(fixture("github-pr-watch-pull.json"), 200, { "x-ratelimit-remaining": "5", "x-ratelimit-reset": String(reset) })]]);
  await assert.rejects(
    githubProvider.getPullRequestStatus(null, { owner: "cli", repo: "cli" }, 14679),
    (error: unknown) => error instanceof GitRemoteError && error.kind === "rate_limited" && (error.retryAfterMs ?? 0) > 1_700_000
  );
  const seen = stubRoutes(githubRoutes());
  await assert.rejects(githubProvider.getPullRequestStatus(null, { owner: "cli", repo: "cli" }, 14679), GitRemoteError);
  assert.equal(seen.length, 0);
  // A token reader has its own window.
  await githubProvider.getPullRequestStatus({ token: "t" }, { owner: "cli", repo: "cli" }, 14679);
});

test("bitbucket cloud: remarks are never trusted; a second read is conditional and a 304 reuses the answer", async () => {
  const withEtags = cloudRoutes().map(([pattern, respond]): [RegExp, () => Response] => [
    pattern,
    () => {
      const res = respond();
      const headers = new Headers(res.headers);
      headers.set("etag", `"bb${pattern.source.length}"`);
      return new Response(res.body, { status: res.status, headers });
    }
  ]);
  stubRoutes(withEtags);
  const creds = { token: "atl", email: "me@example.com" };
  const repo = { owner: "atlassianlabs", repo: "atlascode" };
  const first = await bitbucketCloudProvider.getPullRequestStatus(creds, repo, 1115, { remarksSince: "2026-06-09T22:07:03.000Z" });
  assert.ok(first.remarks?.every((remark) => !remark.trusted));
  const seen = stubRoutes([[/./, () => new Response(null, { status: 304 })]]);
  const second = await bitbucketCloudProvider.getPullRequestStatus(creds, repo, 1115, { remarksSince: "2026-06-09T22:07:03.000Z" });
  assert.ok(seen.every((request) => request.headers["if-none-match"]?.startsWith('"bb')));
  assert.deepEqual(second, first);
});
