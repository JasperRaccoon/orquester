import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentAccountsService } from "./agent-accounts.ts";
import { ClaudeOAuthLinkService } from "./claude-oauth-link.ts";
import { parseClaudeAuthorizationCode } from "./claude-oauth.ts";

async function setup(t: TestContext, opts: { tokenStatus?: number; profileStatus?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "orq-claude-link-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const accounts = new AgentAccountsService({
    indexFile: join(dir, "accounts.json"), accountsDir: join(dir, "accounts"), userhome: dir, now: () => Date.now()
  });
  await accounts.init();
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-10-18T12:00:00Z") });
  const exchanges: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === "https://platform.claude.com/v1/oauth/token") {
      exchanges.push(JSON.parse(String(init?.body)));
      if (opts.tokenStatus && opts.tokenStatus !== 200) {
        return Response.json({ error: "invalid_grant", error_description: "Invalid code" }, { status: opts.tokenStatus });
      }
      return Response.json({
        access_token: "claude-at", refresh_token: "claude-rt", expires_in: 28800,
        scope: "user:inference user:profile", account: { uuid: "u-1", email_address: "me@example.com" }
      });
    }
    assert.equal(String(url), "https://api.anthropic.com/api/oauth/profile");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer claude-at");
    return Response.json(
      { organization: { organization_type: "claude_max", rate_limit_tier: "default_claude_max_20x" } },
      { status: opts.profileStatus ?? 200 }
    );
  });
  const service = new ClaudeOAuthLinkService({
    importAccount: (content, identity) => accounts.importAccount({ content }, identity)
  });
  t.after(() => { service.cancel(); });
  return { service, accounts, exchanges };
}

function started(service: ClaudeOAuthLinkService): URL {
  const res = service.start();
  assert.equal(res.ok, true);
  return new URL(res.ok ? res.link.url : "");
}

test("start hands out the CLI's Claude.ai authorize URL with a PKCE challenge", async (t) => {
  const h = await setup(t);
  const url = started(h.service);
  assert.equal(`${url.origin}${url.pathname}`, "https://claude.com/cai/oauth/authorize");
  const q = url.searchParams;
  assert.equal(q.get("code"), "true");
  assert.equal(q.get("client_id"), "9d1c250a-e61b-44d9-88ed-5944d1962f5e");
  assert.equal(q.get("response_type"), "code");
  assert.equal(q.get("redirect_uri"), "https://platform.claude.com/oauth/code/callback");
  assert.ok(q.get("scope")?.split(" ").includes("user:inference"));
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.ok(q.get("code_challenge"));
  assert.ok(q.get("state"));
  assert.deepEqual(h.service.status().state, "linking");
  assert.equal(h.service.status().link?.expiresAt, "2026-10-18T12:15:00.000Z");
  const again = h.service.start();
  assert.equal(again.ok === false && again.code, "conflict");
});

test("a pasted code#state becomes a labelled Claude account with the CLI's credentials file", async (t) => {
  const h = await setup(t);
  const url = started(h.service);
  const state = url.searchParams.get("state")!;
  const res = await h.service.submit(`  auth-code#${state}\n`);
  assert.equal(res.ok, true);

  const [exchange] = h.exchanges;
  assert.equal(exchange.grant_type, "authorization_code");
  assert.equal(exchange.code, "auth-code");
  assert.equal(exchange.state, state);
  assert.equal(exchange.redirect_uri, "https://platform.claude.com/oauth/code/callback");
  assert.equal(
    createHash("sha256").update(String(exchange.code_verifier)).digest("base64url"),
    url.searchParams.get("code_challenge"),
    "the verifier matches the challenge the authorize URL carried"
  );

  const [account] = h.accounts.list().accounts;
  assert.equal(account?.agent, "claude");
  assert.equal(account?.label, "me@example.com");
  assert.equal(account?.email, "me@example.com");
  assert.equal(account?.plan, "max");
  const creds = JSON.parse(await readFile(join(h.accounts.homePath("claude", account.id), ".credentials.json"), "utf8"));
  assert.deepEqual(creds, {
    claudeAiOauth: {
      accessToken: "claude-at",
      refreshToken: "claude-rt",
      expiresAt: Date.parse("2026-10-18T12:00:00Z") + 28800_000,
      scopes: ["user:inference", "user:profile"],
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x"
    }
  });
  assert.deepEqual(h.service.status(), { state: "idle", link: null, lastError: null });
});

test("a failed profile lookup leaves the plan unknown but still links", async (t) => {
  const h = await setup(t, { profileStatus: 500 });
  const state = started(h.service).searchParams.get("state")!;
  assert.equal((await h.service.submit(`auth-code#${state}`)).ok, true);
  assert.equal(h.accounts.list().accounts[0]?.plan, null);
});

test("malformed, foreign, and rejected codes are refused and keep the sign-in pending", async (t) => {
  const h = await setup(t, { tokenStatus: 400 });
  const state = started(h.service).searchParams.get("state")!;

  const malformed = await h.service.submit("no-hash-here");
  assert.equal(malformed.ok === false && malformed.code, "invalid");
  const foreign = await h.service.submit("auth-code#someone-elses-state");
  assert.equal(foreign.ok === false && foreign.code, "invalid");
  assert.equal(h.exchanges.length, 0, "neither reached the token endpoint");

  const rejected = await h.service.submit(`auth-code#${state}`);
  assert.equal(rejected.ok === false && rejected.code, "invalid");
  assert.match(rejected.ok === false ? rejected.error : "", /Invalid code/);
  assert.equal(h.service.status().state, "linking");
  assert.deepEqual(h.accounts.list().accounts, []);
});

test("submitting with nothing pending is refused; an unused sign-in expires", async (t) => {
  const h = await setup(t);
  const idle = await h.service.submit("auth-code#state");
  assert.equal(idle.ok === false && idle.code, "idle");
  started(h.service);
  t.mock.timers.tick(15 * 60_000);
  assert.equal(h.service.status().state, "idle");
  assert.match(h.service.status().lastError ?? "", /expired/);
});

test("the pasted code may be the callback URL itself", () => {
  assert.deepEqual(
    parseClaudeAuthorizationCode("https://platform.claude.com/oauth/code/callback?code=abc&state=xyz"),
    { code: "abc", state: "xyz" }
  );
  assert.equal(parseClaudeAuthorizationCode("https://platform.claude.com/oauth/code/callback?code=abc"), null);
  assert.equal(parseClaudeAuthorizationCode("#state"), null);
});
