// GitHub link previews: mapping, caching, dedupe, the concurrency cap, error mapping and the
// token's whereabouts — all against a scripted fetch. Nothing here reaches the network.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { GitHubPreviewTarget } from "@orquester/api";

import {
  CLOSED_TTL_MS,
  COMMIT_TTL_MS,
  GitHubLinkPreviewError,
  GitHubLinkPreviewService,
  NOT_FOUND_TTL_MS,
  OPEN_TTL_MS,
  UPSTREAM_TTL_MS,
  summarizeCheckRuns,
  type GitHubReadCredential
} from "./service.ts";

const TOKEN = "ghp_super_secret_token_value";
const HEAD = "a".repeat(40);
const SHA = "0123456789abcdef0123456789abcdef01234567";

const PULL: GitHubPreviewTarget = { kind: "pull", owner: "acme", repo: "app", number: 12 };
const ISSUE: GitHubPreviewTarget = { kind: "issue", owner: "acme", repo: "app", number: 7 };
const COMMIT: GitHubPreviewTarget = { kind: "commit", owner: "acme", repo: "app", sha: "0123456" };

interface Call {
  url: string;
  authorization: string | null;
}

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error;

function pullJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 12,
    html_url: "https://github.com/acme/app/pull/12",
    title: "Add the thing",
    state: "open",
    draft: false,
    merged_at: null,
    closed_at: null,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-02T00:00:00Z",
    user: { login: "octocat" },
    comments: 2,
    review_comments: 3,
    additions: 10,
    deletions: 4,
    changed_files: 2,
    head: { ref: "feature", sha: HEAD, label: "fork:feature", repo: { owner: { login: "fork" } } },
    base: { ref: "main", repo: { owner: { login: "acme" } } },
    ...overrides
  };
}

const CHECKS = {
  total_count: 5,
  check_runs: [
    { status: "completed", conclusion: "success" },
    { status: "completed", conclusion: "failure" },
    { status: "in_progress", conclusion: null },
    { status: "completed", conclusion: "skipped" },
    { status: "completed", conclusion: "success" }
  ]
};

/** A fetch answering by URL suffix; unknown URLs are a test failure, not a network call. */
function scripted(routes: Record<string, Reply | Reply[]>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, authorization: headers.get("authorization") });
    const path = url.replace("https://api.github.com", "");
    const entry = routes[path];
    assert.ok(entry !== undefined, `unexpected request ${path}`);
    const reply = Array.isArray(entry) ? (entry.length > 1 ? entry.shift()! : entry[0]!) : entry;
    if (reply instanceof Error) throw reply;
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json", ...reply.headers }
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function service(
  fetchImpl: typeof fetch,
  options: { credential?: GitHubReadCredential | null; now?: () => number; maxConcurrent?: number } = {}
) {
  const warnings: string[] = [];
  const resolved: Array<{ owner: string; projectPath?: string }> = [];
  const svc = new GitHubLinkPreviewService({
    fetch: fetchImpl,
    resolveCredential: async (input) => {
      resolved.push(input);
      return options.credential ?? null;
    },
    ...(options.now ? { now: options.now } : {}),
    ...(options.maxConcurrent ? { maxConcurrent: options.maxConcurrent } : {}),
    logger: { warn: (message: string) => warnings.push(message) }
  });
  return { svc, warnings, resolved };
}

async function refusal(promise: Promise<unknown>): Promise<GitHubLinkPreviewError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof GitHubLinkPreviewError, String(error));
    return error;
  }
  assert.fail("expected a refusal");
}

describe("summarizeCheckRuns", () => {
  it("counts passed, failed, pending and skipped runs", () => {
    assert.deepEqual(summarizeCheckRuns(CHECKS), { total: 5, passed: 2, failed: 1, pending: 1, skipped: 1 });
    assert.deepEqual(
      summarizeCheckRuns({
        check_runs: [
          { status: "completed", conclusion: "timed_out" },
          { status: "completed", conclusion: "cancelled" },
          { status: "completed", conclusion: "neutral" },
          { status: "queued", conclusion: "success" }
        ]
      }),
      { total: 4, passed: 0, failed: 2, pending: 1, skipped: 1 }
    );
    assert.equal(summarizeCheckRuns({}), null);
    assert.equal(summarizeCheckRuns(null), null);
  });
});

describe("GitHubLinkPreviewService", () => {
  it("previews an open PR with its branches and a checks summary", async () => {
    const { calls, fetchImpl } = scripted({
      "/repos/acme/app/pulls/12": { status: 200, body: pullJson() },
      [`/repos/acme/app/commits/${HEAD}/check-runs?per_page=100`]: { status: 200, body: CHECKS }
    });
    const { svc } = service(fetchImpl);
    const preview = await svc.preview(PULL);
    assert.equal(preview.kind, "pull");
    assert.ok(preview.kind === "pull");
    assert.equal(preview.title, "Add the thing");
    assert.equal(preview.state, "open");
    assert.equal(preview.author, "octocat");
    assert.equal(preview.comments, 5);
    assert.equal(preview.headRef, "feature");
    assert.equal(preview.baseRef, "main");
    assert.equal(preview.headLabel, "fork:feature");
    assert.equal(preview.additions, 10);
    assert.deepEqual(preview.checks, { total: 5, passed: 2, failed: 1, pending: 1, skipped: 1 });
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.authorization === null), "anonymous without a credential");
  });

  it("maps draft, merged and closed PRs, and skips checks once closed", async () => {
    const states: Array<[Record<string, unknown>, string]> = [
      [{ draft: true }, "draft"],
      [{ state: "closed", merged_at: "2026-10-03T00:00:00Z" }, "merged"],
      [{ state: "closed" }, "closed"]
    ];
    for (const [overrides, expected] of states) {
      const { calls, fetchImpl } = scripted({
        "/repos/acme/app/pulls/12": { status: 200, body: pullJson(overrides) },
        [`/repos/acme/app/commits/${HEAD}/check-runs?per_page=100`]: { status: 200, body: CHECKS }
      });
      const preview = await service(fetchImpl).svc.preview(PULL);
      assert.ok(preview.kind === "pull");
      assert.equal(preview.state, expected);
      assert.equal(calls.length, expected === "draft" ? 2 : 1, expected);
      if (expected !== "draft") assert.equal(preview.checks, null);
    }
  });

  it("still previews a PR whose checks cannot be read", async () => {
    const { fetchImpl } = scripted({
      "/repos/acme/app/pulls/12": { status: 200, body: pullJson() },
      [`/repos/acme/app/commits/${HEAD}/check-runs?per_page=100`]: { status: 403, body: { message: "Resource not accessible" } }
    });
    const preview = await service(fetchImpl).svc.preview(PULL);
    assert.ok(preview.kind === "pull");
    assert.equal(preview.checks, null);
  });

  it("previews an issue, and reads an /issues/N that is a PR as the PR", async () => {
    const issue = scripted({
      "/repos/acme/app/issues/7": {
        status: 200,
        body: {
          html_url: "https://github.com/acme/app/issues/7",
          title: "It breaks",
          state: "closed",
          state_reason: "not_planned",
          user: { login: "reporter" },
          comments: 4,
          created_at: "2026-09-01T00:00:00Z",
          closed_at: "2026-09-02T00:00:00Z"
        }
      }
    });
    const preview = await service(issue.fetchImpl).svc.preview(ISSUE);
    assert.ok(preview.kind === "issue");
    assert.equal(preview.state, "closed");
    assert.equal(preview.stateReason, "not_planned");
    assert.equal(preview.comments, 4);

    const pr = scripted({
      "/repos/acme/app/issues/7": { status: 200, body: { title: "x", state: "closed", pull_request: { url: "…" } } },
      "/repos/acme/app/pulls/7": { status: 200, body: pullJson({ number: 7, state: "closed", merged_at: "2026-10-03T00:00:00Z" }) }
    });
    const asPull = await service(pr.fetchImpl).svc.preview(ISSUE);
    assert.ok(asPull.kind === "pull");
    assert.equal(asPull.number, 7);
    assert.equal(asPull.state, "merged");
  });

  it("previews a commit with its headline and body", async () => {
    const { fetchImpl } = scripted({
      "/repos/acme/app/commits/0123456": {
        status: 200,
        body: {
          sha: SHA,
          html_url: `https://github.com/acme/app/commit/${SHA}`,
          author: null,
          commit: {
            message: "fix: the thing\r\n\r\nLonger explanation.\r\n",
            author: { name: "Jane Doe", date: "2026-10-01T00:00:00Z" },
            committer: { date: "2026-10-01T01:00:00Z" }
          }
        }
      }
    });
    const preview = await service(fetchImpl).svc.preview(COMMIT);
    assert.ok(preview.kind === "commit");
    assert.equal(preview.sha, SHA);
    assert.equal(preview.title, "fix: the thing");
    assert.equal(preview.body, "Longer explanation.");
    assert.equal(preview.author, "Jane Doe");
    assert.equal(preview.committedAt, "2026-10-01T01:00:00Z");
  });

  it("never trusts a non-GitHub html_url", async () => {
    const { fetchImpl } = scripted({
      "/repos/acme/app/pulls/12": { status: 200, body: pullJson({ html_url: "https://evil.example/x", state: "closed" }) }
    });
    const preview = await service(fetchImpl).svc.preview(PULL);
    assert.equal(preview.url, "https://github.com/acme/app/pull/12");
  });

  it("caches by state: open briefly, closed longer, commits longest", async () => {
    let now = 1_000_000;
    const { calls, fetchImpl } = scripted({
      "/repos/acme/app/pulls/12": { status: 200, body: pullJson({ state: "closed" }) },
      "/repos/acme/app/issues/7": { status: 200, body: { title: "open one", state: "open" } },
      "/repos/acme/app/commits/0123456": { status: 200, body: { sha: SHA, commit: { message: "m" } } }
    });
    const { svc } = service(fetchImpl, { now: () => now });
    const count = (suffix: string) => calls.filter((call) => call.url.endsWith(suffix)).length;

    await svc.preview(PULL);
    await svc.preview(ISSUE);
    await svc.preview(COMMIT);
    now += OPEN_TTL_MS - 1;
    await svc.preview(PULL);
    await svc.preview(ISSUE);
    assert.equal(count("/pulls/12"), 1);
    assert.equal(count("/issues/7"), 1);
    now += 2;
    await svc.preview(ISSUE);
    assert.equal(count("/issues/7"), 2, "an open issue re-reads after the short TTL");
    await svc.preview(PULL);
    assert.equal(count("/pulls/12"), 1, "a closed PR is still cached");
    now += CLOSED_TTL_MS;
    await svc.preview(PULL);
    assert.equal(count("/pulls/12"), 2);
    await svc.preview(COMMIT);
    assert.equal(count("/commits/0123456"), 1);
    now += COMMIT_TTL_MS;
    await svc.preview(COMMIT);
    assert.equal(count("/commits/0123456"), 2);
  });

  it("shares one read between concurrent asks", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let requests = 0;
    const fetchImpl = (async () => {
      requests += 1;
      await gate;
      return new Response(JSON.stringify(pullJson({ state: "closed" })), { status: 200 });
    }) as typeof fetch;
    const { svc } = service(fetchImpl);
    const asks = [svc.preview(PULL), svc.preview(PULL), svc.preview({ ...PULL, owner: "ACME", repo: "App" })];
    // Every ask has to reach the in-flight map before the read settles.
    await new Promise((resolve) => setImmediate(resolve));
    release();
    const previews = await Promise.all(asks);
    assert.equal(requests, 1);
    assert.ok(previews.every((preview) => preview.title === "Add the thing"));
  });

  it("runs at most maxConcurrent reads at once", async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      const number = Number(/pulls\/(\d+)/.exec(String(input))?.[1]);
      return new Response(JSON.stringify(pullJson({ number, state: "closed" })), { status: 200 });
    }) as typeof fetch;
    const { svc } = service(fetchImpl, { maxConcurrent: 2 });
    const asks = [1, 2, 3, 4, 5].map((number) => svc.preview({ ...PULL, number }));
    for (let settled = 0; settled < 5; ) {
      await new Promise((resolve) => setImmediate(resolve));
      const next = releases.shift();
      if (next) {
        next();
        settled += 1;
      }
    }
    await Promise.all(asks);
    assert.equal(peak, 2);
  });

  it("maps 404 to NOT_FOUND and caches it", async () => {
    let now = 0;
    const { calls, fetchImpl } = scripted({ "/repos/acme/app/pulls/12": { status: 404, body: { message: "Not Found" } } });
    const { svc } = service(fetchImpl, { now: () => now });
    const error = await refusal(svc.preview(PULL));
    assert.equal(error.code, "NOT_FOUND");
    assert.equal(error.status, 404);
    assert.match(error.message, /private repository/);
    await refusal(svc.preview(PULL));
    assert.equal(calls.length, 1);
    now += NOT_FOUND_TTL_MS + 1;
    await refusal(svc.preview(PULL));
    assert.equal(calls.length, 2);
  });

  it("maps a spent quota to RATE_LIMITED and stops calling until it resets", async () => {
    let now = 1_700_000_000_000;
    const reset = Math.floor(now / 1000) + 120;
    const { calls, fetchImpl } = scripted({
      "/repos/acme/app/pulls/12": {
        status: 403,
        body: { message: "API rate limit exceeded" },
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }
      },
      "/repos/acme/app/issues/7": { status: 200, body: { title: "t", state: "open" } }
    });
    const { svc } = service(fetchImpl, { now: () => now });
    const error = await refusal(svc.preview(PULL));
    assert.equal(error.code, "RATE_LIMITED");
    assert.equal(error.status, 429);
    assert.ok(error.retryAfterMs !== undefined && error.retryAfterMs >= 100_000 && error.retryAfterMs <= 120_000);
    // Another item on the same credential is refused without a call.
    const blocked = await refusal(svc.preview(ISSUE));
    assert.equal(blocked.code, "RATE_LIMITED");
    assert.equal(calls.length, 1);
    now += 121_000;
    const issue = await svc.preview(ISSUE);
    assert.equal(issue.title, "t");
  });

  it("reads 429 with Retry-After as RATE_LIMITED", async () => {
    const { fetchImpl } = scripted({ "/repos/acme/app/pulls/12": { status: 429, headers: { "retry-after": "90" } } });
    const error = await refusal(service(fetchImpl).svc.preview(PULL));
    assert.equal(error.code, "RATE_LIMITED");
    assert.equal(error.retryAfterMs, 90_000);
  });

  it("maps network failures and 5xx to UPSTREAM, cached briefly", async () => {
    let now = 0;
    const { calls, fetchImpl } = scripted({
      "/repos/acme/app/pulls/12": [new TypeError("fetch failed"), { status: 502 }, { status: 200, body: pullJson({ state: "closed" }) }]
    });
    const { svc } = service(fetchImpl, { now: () => now });
    assert.equal((await refusal(svc.preview(PULL))).code, "UPSTREAM");
    await refusal(svc.preview(PULL));
    assert.equal(calls.length, 1);
    now += UPSTREAM_TTL_MS + 1;
    const upstream = await refusal(svc.preview(PULL));
    assert.equal(upstream.code, "UPSTREAM");
    assert.match(upstream.message, /HTTP 502/);
    now += UPSTREAM_TTL_MS + 1;
    assert.equal((await svc.preview(PULL)).title, "Add the thing");
  });

  it("uses the stored token only in the Authorization header, never in a URL, message or preview", async () => {
    const { calls, fetchImpl } = scripted({
      "/repos/acme/app/pulls/12": { status: 200, body: pullJson() },
      [`/repos/acme/app/commits/${HEAD}/check-runs?per_page=100`]: { status: 200, body: CHECKS },
      "/repos/acme/app/issues/7": { status: 404, body: { message: `Bad credentials ${TOKEN}` } }
    });
    const { svc, warnings, resolved } = service(fetchImpl, { credential: { accountId: "gh1", token: TOKEN } });
    const preview = await svc.preview(PULL, "/w/ws/app");
    assert.deepEqual(resolved[0], { owner: "acme", projectPath: "/w/ws/app" });
    assert.ok(calls.every((call) => call.authorization === `Bearer ${TOKEN}`));
    assert.ok(calls.every((call) => !call.url.includes(TOKEN)));
    assert.ok(!JSON.stringify(preview).includes(TOKEN));
    const error = await refusal(svc.preview(ISSUE));
    assert.ok(!error.message.includes(TOKEN));
    assert.ok(!error.message.includes("private repository"), "an authenticated 404 does not suggest connecting an account");
    assert.ok(warnings.every((warning) => !warning.includes(TOKEN)));
  });

  it("falls back to one anonymous read when GitHub refuses the token", async () => {
    const { calls, fetchImpl } = scripted({
      "/repos/acme/app/pulls/12": [
        { status: 401, body: { message: "Bad credentials" } },
        { status: 200, body: pullJson({ state: "closed" }) }
      ]
    });
    const { svc } = service(fetchImpl, { credential: { accountId: "gh1", token: TOKEN } });
    const preview = await svc.preview(PULL);
    assert.equal(preview.title, "Add the thing");
    assert.deepEqual(
      calls.map((call) => call.authorization),
      [`Bearer ${TOKEN}`, null]
    );
  });

  it("an anonymous 403 that is no rate limit reads as NOT_FOUND", async () => {
    const { fetchImpl } = scripted({ "/repos/acme/app/pulls/12": { status: 403, body: { message: "Repository access blocked" } } });
    assert.equal((await refusal(service(fetchImpl).svc.preview(PULL))).code, "NOT_FOUND");
  });

  it("keeps separate cache entries per credential", async () => {
    const { calls, fetchImpl } = scripted({ "/repos/acme/app/pulls/12": { status: 200, body: pullJson({ state: "closed" }) } });
    let credential: GitHubReadCredential | null = null;
    const svc = new GitHubLinkPreviewService({ fetch: fetchImpl, resolveCredential: async () => credential, logger: { warn: () => {} } });
    await svc.preview(PULL);
    credential = { accountId: "gh1", token: TOKEN };
    await svc.preview(PULL);
    await svc.preview(PULL);
    assert.equal(calls.length, 2);
  });

  it("treats a failing credential lookup as anonymous", async () => {
    const { calls, fetchImpl } = scripted({ "/repos/acme/app/pulls/12": { status: 200, body: pullJson({ state: "closed" }) } });
    const svc = new GitHubLinkPreviewService({
      fetch: fetchImpl,
      resolveCredential: async () => {
        throw new Error("accounts.json is unreadable");
      },
      logger: { warn: () => {} }
    });
    await svc.preview(PULL);
    assert.equal(calls[0]?.authorization, null);
  });
});
