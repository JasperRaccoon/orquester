// Route-level coverage for GET /api/github/link-preview: the URL is re-parsed on the daemon, the
// refusal envelope, Retry-After, and the bearer gate on the remote transport. Inject only — nothing
// listens, nothing reaches GitHub.

import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import Fastify from "fastify";
import { githubLinkRoutes, type GitHubLinkPreview, type GitHubPreviewTarget } from "@orquester/api";
import { createDefaultClientConfig, createDefaultDaemonConfig } from "@orquester/config";

import { createServer } from "../index.ts";
import { registerGitHubLinkRoutes } from "./routes.ts";
import { GitHubLinkPreviewError, GitHubLinkPreviewService } from "./service.ts";

const TOKEN = "ghp_route_secret";

const PREVIEW: GitHubLinkPreview = {
  kind: "issue",
  owner: "acme",
  repo: "app",
  number: 7,
  url: "https://github.com/acme/app/issues/7",
  title: "It breaks",
  state: "open",
  stateReason: null,
  author: "octocat",
  createdAt: null,
  updatedAt: null,
  closedAt: null,
  comments: 0
};

function harness(t: TestContext, preview: (target: GitHubPreviewTarget, projectPath?: string) => Promise<GitHubLinkPreview>) {
  const app = Fastify();
  const seen: Array<{ target: GitHubPreviewTarget; projectPath: string | undefined }> = [];
  registerGitHubLinkRoutes(app, {
    service: {
      preview: async (target, projectPath) => {
        seen.push({ target, projectPath });
        return preview(target, projectPath);
      }
    }
  });
  t.after(() => app.close());
  const get = (query: Record<string, string>) =>
    app.inject({ method: "GET", url: `${githubLinkRoutes.preview}?${new URLSearchParams(query).toString()}` });
  return { get, seen };
}

test("answers the preview for a GitHub PR, issue or commit link, with the project path", async (t) => {
  const { get, seen } = harness(t, async () => PREVIEW);
  const response = await get({ url: "https://github.com/acme/app/issues/7#issuecomment-1", projectPath: "/w/ws/app" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { preview: PREVIEW });
  assert.deepEqual(seen[0], { target: { kind: "issue", owner: "acme", repo: "app", number: 7 }, projectPath: "/w/ws/app" });
  await get({ url: "https://github.com/acme/app/pull/3/commits/abcdef1" });
  assert.deepEqual(seen[1], { target: { kind: "commit", owner: "acme", repo: "app", sha: "abcdef1" }, projectPath: undefined });
});

test("refuses anything that is not a GitHub PR, issue or commit link without reading", async (t) => {
  const { get, seen } = harness(t, async () => PREVIEW);
  for (const url of [
    "",
    "https://github.com/acme/app",
    "https://github.com/acme/app/blob/main/a.ts",
    "https://github.com.evil.example/acme/app/pull/1",
    "https://gitlab.com/g/p/-/merge_requests/1",
    "http://169.254.169.254/latest/meta-data",
    "x".repeat(5000)
  ]) {
    const response = await get({ url });
    assert.equal(response.statusCode, 400, url);
    assert.equal((response.json() as { code: string }).code, "INVALID_LINK");
  }
  const missing = await harness(t, async () => PREVIEW).get({});
  assert.equal(missing.statusCode, 400);
  assert.equal(seen.length, 0);
});

test("maps refusals to statuses with { code, message } and Retry-After on a 429", async (t) => {
  const cases: Array<[GitHubLinkPreviewError | Error, number, string]> = [
    [new GitHubLinkPreviewError("NOT_FOUND", "acme/app#7 was not found."), 404, "NOT_FOUND"],
    [new GitHubLinkPreviewError("RATE_LIMITED", "GitHub's rate limit is spent.", 61_500), 429, "RATE_LIMITED"],
    [new GitHubLinkPreviewError("UPSTREAM", "GitHub could not be read."), 502, "UPSTREAM"],
    [new Error(`boom ${TOKEN}`), 502, "UPSTREAM"]
  ];
  for (const [error, status, code] of cases) {
    const { get } = harness(t, async () => {
      throw error;
    });
    const response = await get({ url: "https://github.com/acme/app/pull/1" });
    assert.equal(response.statusCode, status, code);
    const body = response.json() as { code: string; message: string; retryAfterMs?: number };
    assert.equal(body.code, code);
    assert.ok(body.message.length > 0);
    assert.ok(!response.body.includes(TOKEN), "an unexpected error's text never reaches the client");
    if (status === 429) {
      assert.equal(body.retryAfterMs, 61_500);
      assert.equal(response.headers["retry-after"], "62");
    } else {
      assert.equal(response.headers["retry-after"], undefined);
    }
  }
});

test("the real service behind the route never answers the token", async (t) => {
  const app = Fastify();
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${TOKEN}`);
    return new Response(JSON.stringify({ title: `t`, state: "open", user: { login: "octocat" } }), { status: 200 });
  }) as typeof fetch;
  const service = new GitHubLinkPreviewService({
    fetch: fetchImpl,
    resolveCredential: async () => ({ accountId: "gh1", token: TOKEN }),
    logger: { warn: () => {} }
  });
  registerGitHubLinkRoutes(app, { service });
  t.after(() => app.close());
  const response = await app.inject({
    method: "GET",
    url: `${githubLinkRoutes.preview}?url=${encodeURIComponent("https://github.com/acme/app/issues/7")}`
  });
  assert.equal(response.statusCode, 200);
  assert.ok(!response.body.includes(TOKEN));
  assert.ok(!response.body.includes("gh1"), "the account id stays on the daemon too");
});

test("the remote transport requires the bearer; the local one does not", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orquester-github-link-routes-"));
  type Args = Parameters<typeof createServer>;
  const passwordHash = "$2a$12$0123456789012345678901uFAKEfakeFAKEfakeFAKEfa";
  const bearer = `Bearer ${Buffer.from(`admin:${passwordHash}`).toString("base64")}`;
  const config = createDefaultDaemonConfig({ env: {} });
  config.transports.http.username = "admin";
  config.transports.http.passwordHash = passwordHash;
  const githubLinks = { preview: async () => PREVIEW };
  const build = (options: Args[5]) =>
    createServer(
      config,
      { daemonDir: root, workspacesDir: root, fsRoot: root } as unknown as Args[1],
      createDefaultClientConfig(join(root, "daemon.sock")),
      createWriteStream("/dev/null"),
      { githubLinks, repoIdentities: { list: () => [] } } as unknown as Args[4],
      options
    );
  const local = build({ authRequired: false, mode: "local" });
  const remote = build({ authRequired: true, mode: "remote" });
  t.after(async () => {
    await local.close();
    await remote.close();
    await rm(root, { recursive: true, force: true });
  });
  const url = `${githubLinkRoutes.preview}?url=${encodeURIComponent("https://github.com/acme/app/issues/7")}`;
  assert.equal((await local.inject({ method: "GET", url })).statusCode, 200);
  assert.equal((await remote.inject({ method: "GET", url })).statusCode, 401);
  const authed = await remote.inject({ method: "GET", url, headers: { authorization: bearer } });
  assert.equal(authed.statusCode, 200);
  assert.equal((authed.json() as { preview: GitHubLinkPreview }).preview.title, "It breaks");
});
