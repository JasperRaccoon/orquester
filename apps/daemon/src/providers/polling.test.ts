// The polling listings behind the git trigger (pull requests, releases): each provider's mapping
// from recorded-shape API payloads (./fixtures), ETag/304 handling, auth/scope/rate-limit errors.
// Every request goes to a stubbed `fetch` — nothing here reaches a forge.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { bitbucketCloudProvider } from "./bitbucket-cloud";
import { bitbucketServerProvider } from "./bitbucket-server";
import { githubProvider } from "./github";
import { GitRemoteError, retryAfterMs } from "./types";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

interface Seen {
  url: string;
  headers: Record<string, string>;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Answer every fetch with `respond(url)`, recording the URL and headers sent. */
function stubFetch(respond: (url: string, headers: Record<string, string>) => Response): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])
    );
    seen.push({ url, headers });
    return respond(url, headers);
  }) as typeof fetch;
  return seen;
}

const json = (body: string, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(body, { status, headers: { "content-type": "application/json", ...headers } });

// --- GitHub ------------------------------------------------------------------

test("github: pulls map open/merged/closed, newest-updated first, with the ETag", async () => {
  const seen = stubFetch(() => json(fixture("github-pulls.json"), 200, { etag: 'W/"abc123"' }));
  const page = await githubProvider.listPullRequests(
    { token: "ghp_test" },
    { owner: "octo-org", repo: "hello-world" }
  );
  assert.equal(
    seen[0].url,
    "https://api.github.com/repos/octo-org/hello-world/pulls?state=all&sort=updated&direction=desc&per_page=50"
  );
  assert.equal(seen[0].headers.authorization, "Bearer ghp_test");
  assert.equal(seen[0].headers["if-none-match"], undefined);
  assert.ok(!page.notModified);
  assert.equal(page.etag, 'W/"abc123"');
  assert.deepEqual(page.items[0], {
    number: 42,
    title: "Add retry to the uploader",
    body: "Retries 5xx responses with backoff.\r\n\r\nFixes #40",
    url: "https://github.com/octo-org/hello-world/pull/42",
    author: "octocat",
    head: "feature/retry",
    base: "main",
    headSha: "6dcb09b5b57875f334f61aebed695e2e4193db5e",
    state: "open",
    updatedAt: "2026-09-27T08:00:00Z"
  });
  assert.deepEqual(
    page.items.map((pr) => [pr.number, pr.state, pr.body]),
    [
      [42, "open", "Retries 5xx responses with backoff.\r\n\r\nFixes #40"],
      [41, "merged", ""],
      [39, "closed", ""]
    ]
  );
});

test("github: a matching ETag is sent as If-None-Match and a 304 is notModified", async () => {
  const seen = stubFetch(() => new Response(null, { status: 304 }));
  const page = await githubProvider.listPullRequests(
    { token: "ghp_test" },
    { owner: "o", repo: "r" },
    { etag: 'W/"abc123"' }
  );
  assert.deepEqual(page, { notModified: true });
  assert.equal(seen[0].headers["if-none-match"], 'W/"abc123"');
});

test("github: anonymous reads send no Authorization header", async () => {
  const seen = stubFetch(() => json("[]"));
  const page = await githubProvider.listPullRequests(null, { owner: "o", repo: "r" });
  assert.equal(seen[0].headers.authorization, undefined);
  assert.deepEqual(page, { items: [] });
});

test("github: releases map drafts, prereleases and a nameless release", async () => {
  const seen = stubFetch(() => json(fixture("github-releases.json"), 200, { etag: '"rel1"' }));
  const page = await githubProvider.listReleases({ token: "t" }, { owner: "octo-org", repo: "hello-world" });
  assert.equal(seen[0].url, "https://api.github.com/repos/octo-org/hello-world/releases?per_page=50");
  assert.ok(!page.notModified);
  assert.equal(page.etag, '"rel1"');
  assert.deepEqual(page.items, [
    {
      id: "180000002",
      name: "v2.0.0-rc.1",
      tag: "v2.0.0-rc.1",
      body: "Release candidate.",
      url: "https://github.com/octo-org/hello-world/releases/tag/v2.0.0-rc.1",
      prerelease: true,
      draft: false,
      publishedAt: "2026-09-27T09:05:00Z"
    },
    {
      id: "180000001",
      name: "Hello World 1.4",
      tag: "v1.4.0",
      body: "## Changes\n- faster\n",
      url: "https://github.com/octo-org/hello-world/releases/tag/v1.4.0",
      prerelease: false,
      draft: false,
      publishedAt: "2026-09-01T09:10:00Z"
    },
    {
      id: "180000003",
      name: "2.0 (draft)",
      tag: "v2.0.0",
      body: "",
      url: "https://github.com/octo-org/hello-world/releases/tag/untagged-3f2a",
      prerelease: false,
      draft: true,
      publishedAt: null
    }
  ]);
});

test("github: a spent rate limit is a 429 rate_limited error with the reset", async () => {
  const reset = Math.floor(Date.now() / 1000) + 120;
  stubFetch(() =>
    json('{"message":"API rate limit exceeded"}', 403, {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(reset)
    })
  );
  await assert.rejects(
    githubProvider.listPullRequests(null, { owner: "o", repo: "r" }),
    (error: unknown) => {
      assert.ok(error instanceof GitRemoteError);
      assert.equal(error.kind, "rate_limited");
      assert.equal(error.status, 429);
      assert.equal(error.httpStatus, 403);
      assert.ok(error.retryAfterMs !== undefined && error.retryAfterMs > 100_000);
      return true;
    }
  );
});

test("github: a bad token is a 400 auth error; a missing repo a not_found", async () => {
  stubFetch(() => json('{"message":"Bad credentials"}', 401));
  await assert.rejects(githubProvider.listReleases({ token: "bad" }, { owner: "o", repo: "r" }), (error: unknown) => {
    assert.ok(error instanceof GitRemoteError);
    assert.equal(error.kind, "auth");
    assert.equal(error.status, 400);
    return true;
  });
  stubFetch(() => json('{"message":"Not Found"}', 404));
  await assert.rejects(githubProvider.listPullRequests(null, { owner: "o", repo: "r" }), (error: unknown) => {
    assert.ok(error instanceof GitRemoteError);
    assert.equal(error.kind, "not_found");
    assert.equal(error.status, 502);
    return true;
  });
});

// --- Bitbucket Cloud ---------------------------------------------------------

test("bitbucket cloud: pullrequests map OPEN/MERGED/DECLINED with the abbreviated head hash", async () => {
  const seen = stubFetch(() => json(fixture("bitbucket-cloud-pullrequests.json")));
  const page = await bitbucketCloudProvider.listPullRequests(
    { token: "ATATTfake", email: "me@example.invalid" },
    { owner: "acme", repo: "web-app" }
  );
  assert.equal(
    seen[0].url,
    "https://api.bitbucket.org/2.0/repositories/acme/web-app/pullrequests?state=OPEN&state=MERGED&state=DECLINED&sort=-updated_on&pagelen=50"
  );
  assert.equal(
    seen[0].headers.authorization,
    "Basic " + Buffer.from("me@example.invalid:ATATTfake").toString("base64")
  );
  assert.ok(!page.notModified);
  assert.equal(page.etag, undefined);
  assert.deepEqual(page.items[0], {
    number: 17,
    title: "Fix login redirect",
    body: "Redirects back to the page the user came from.",
    url: "https://bitbucket.org/acme/web-app/pull-requests/17",
    author: "jdoe",
    head: "bugfix/login-redirect",
    base: "main",
    headSha: "1a2b3c4d5e6f",
    state: "open",
    updatedAt: "2026-09-27T14:02:03.654321+00:00"
  });
  assert.deepEqual(
    page.items.map((pr) => [pr.number, pr.state, pr.author, pr.base]),
    [
      [17, "open", "jdoe", "main"],
      [16, "merged", "Build Bot", "main"],
      [15, "closed", "jdoe", "develop"]
    ]
  );
});

test("bitbucket cloud: a token without read:pullrequest is a missing_scope error", async () => {
  stubFetch(() => json(fixture("bitbucket-cloud-missing-scope.json"), 403));
  await assert.rejects(
    bitbucketCloudProvider.listPullRequests({ token: "t", email: "e@example.invalid" }, { owner: "a", repo: "b" }),
    (error: unknown) => {
      assert.ok(error instanceof GitRemoteError);
      assert.equal(error.kind, "missing_scope");
      assert.equal(error.status, 400);
      assert.match(error.message, /read:pullrequest/);
      return true;
    }
  );
});

test("bitbucket cloud: a plain 401 stays an auth error; anonymous and 304 work", async () => {
  stubFetch(() => json('{"type":"error","error":{"message":"Unauthorized"}}', 401));
  await assert.rejects(
    bitbucketCloudProvider.listPullRequests({ token: "t", email: "e@example.invalid" }, { owner: "a", repo: "b" }),
    (error: unknown) => error instanceof GitRemoteError && error.kind === "auth" && error.status === 400
  );
  const seen = stubFetch(() => new Response(null, { status: 304 }));
  assert.deepEqual(
    await bitbucketCloudProvider.listPullRequests(null, { owner: "a", repo: "b" }, { etag: '"e1"' }),
    { notModified: true }
  );
  assert.equal(seen[0].headers.authorization, undefined);
  assert.equal(seen[0].headers["if-none-match"], '"e1"');
});

test("bitbucket cloud and server have no releases", async () => {
  const seen = stubFetch(() => json("{}"));
  assert.deepEqual(await bitbucketCloudProvider.listReleases(null, { owner: "a", repo: "b" }), {
    items: [],
    unsupported: true
  });
  assert.deepEqual(
    await bitbucketServerProvider.listReleases({ token: "t", baseUrl: "https://h" }, { owner: "a", repo: "b" }),
    { items: [], unsupported: true }
  );
  assert.equal(seen.length, 0);
});

// --- Bitbucket Server / DC ---------------------------------------------------

test("bitbucket server: pull-requests map states and sort by updatedDate", async () => {
  const all = JSON.parse(fixture("bitbucket-server-pull-requests.json")) as { values: { state: string }[] };
  const seen = stubFetch((url) => {
    const state = /state=([A-Z]+)/.exec(url)?.[1];
    return json(JSON.stringify({ isLastPage: true, values: all.values.filter((pr) => pr.state === state) }));
  });
  const page = await bitbucketServerProvider.listPullRequests(
    { token: "dc-token", baseUrl: "https://bb.corp.example/bitbucket/" },
    { owner: "PRJ", repo: "api" }
  );
  const prefix = "https://bb.corp.example/bitbucket/rest/api/1.0/projects/PRJ/repos/api/pull-requests";
  assert.deepEqual(
    seen.map((s) => s.url),
    [
      `${prefix}?state=OPEN&order=NEWEST&limit=50&start=0`,
      `${prefix}?state=MERGED&order=NEWEST&limit=50`,
      `${prefix}?state=DECLINED&order=NEWEST&limit=50`
    ]
  );
  assert.equal(seen[0].headers.authorization, "Bearer dc-token");
  assert.ok(!page.notModified);
  assert.deepEqual(
    page.items.map((pr) => [pr.number, pr.state, pr.updatedAt]),
    [
      [100, "merged", new Date(1758990000000).toISOString()],
      [101, "open", new Date(1758960000000).toISOString()],
      [99, "closed", new Date(1758100000000).toISOString()]
    ]
  );
  assert.deepEqual(
    page.items.find((pr) => pr.number === 101),
    {
      number: 101,
      title: "PROJ-12 Add health endpoint",
      body: "Adds /health.",
      url: "https://bb.corp.example/bitbucket/projects/PRJ/repos/api/pull-requests/101",
      author: "jdoe",
      head: "feature/health",
      base: "master",
      headSha: "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567",
      state: "open",
      updatedAt: new Date(1758960000000).toISOString()
    }
  );
});

test("bitbucket server: every OPEN page is read (a long-lived PR never drops off) and a PR last seen open is looked up", async () => {
  const pr = (id: number, state: string, updated: number) => ({
    id,
    title: `PR ${id}`,
    state,
    updatedDate: updated,
    fromRef: { displayId: `f/${id}`, latestCommit: String(id).padStart(40, "0") },
    toRef: { displayId: "master" }
  });
  const seen = stubFetch((url) => {
    if (url.includes("state=OPEN") && url.endsWith("start=0")) {
      return json(JSON.stringify({ isLastPage: false, nextPageStart: 50, values: [pr(300, "OPEN", 30)] }));
    }
    if (url.includes("state=OPEN") && url.endsWith("start=50")) {
      // The oldest open PR, created long ago: on a creation-ordered `state=ALL` page it had dropped off.
      return json(JSON.stringify({ isLastPage: true, values: [pr(3, "OPEN", 5)] }));
    }
    if (url.includes("state=")) return json(JSON.stringify({ isLastPage: true, values: [] }));
    if (url.endsWith("/pull-requests/7")) return json(JSON.stringify(pr(7, "MERGED", 40)));
    if (url.endsWith("/pull-requests/8")) return json('{"errors":[{"message":"gone"}]}', 404);
    return json("{}", 500);
  });
  const page = await bitbucketServerProvider.listPullRequests(
    { token: "t", baseUrl: "https://h" },
    { owner: "PRJ", repo: "api" },
    { knownOpen: [3, 7, 8] }
  );
  assert.ok(!page.notModified);
  assert.deepEqual(
    page.items.map((p) => [p.number, p.state]),
    [
      [7, "merged"],
      [300, "open"],
      [3, "open"]
    ]
  );
  assert.equal(page.etag, undefined);
  assert.ok(!seen.some((s) => s.url.endsWith("/pull-requests/3")), "a PR the listing holds is not looked up");
});

test("bitbucket server: needs an account; personal projects keep the ~; a 403 is auth", async () => {
  await assert.rejects(
    bitbucketServerProvider.listPullRequests(null, { owner: "PRJ", repo: "api" }),
    (error: unknown) => error instanceof GitRemoteError && error.kind === "unsupported"
  );
  const seen = stubFetch(() => json('{"errors":[{"message":"no"}]}', 403));
  await assert.rejects(
    bitbucketServerProvider.listPullRequests({ token: "t", baseUrl: "https://h" }, { owner: "~jdoe", repo: "site" }),
    (error: unknown) => error instanceof GitRemoteError && error.kind === "auth" && error.status === 400
  );
  assert.match(seen[0].url, /\/projects\/~jdoe\/repos\/site\/pull-requests/);
});

test("retryAfterMs reads seconds and HTTP dates", () => {
  assert.equal(retryAfterMs("30"), 30_000);
  assert.equal(retryAfterMs(null), undefined);
  assert.equal(retryAfterMs("nonsense"), undefined);
  const now = Date.parse("2026-09-28T10:00:00Z");
  assert.equal(retryAfterMs("Mon, 28 Sep 2026 10:01:00 GMT", now), 60_000);
});
