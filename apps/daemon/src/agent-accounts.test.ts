import { after, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, stat, mkdir, writeFile, lstat, readlink, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { AgentAccountsService } from "./agent-accounts.ts";

const fixtureRoot = await mkdtemp(join(tmpdir(), "orq-accounts-fixtures-"));
after(() => rm(fixtureRoot, { recursive: true, force: true }));

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.`;
}

async function makeService() {
  const base = await mkdtemp(join(fixtureRoot, "orq-accts-"));
  const svc = new AgentAccountsService({
    indexFile: join(base, "agent-accounts.json"),
    accountsDir: join(base, "agent-accounts"),
    userhome: base,
    now: () => 1_000
  });
  await svc.init();
  return { base, svc };
}

test("import a codex blob derives identity and writes a 0700 home + marker", async () => {
  const { svc } = await makeService();
  const blob = JSON.stringify({ tokens: { access_token: "a", account_id: "acc1", id_token: jwt({ email: "c@x.com" }) } });
  const acct = await svc.importAccount({ content: blob });
  assert.equal(acct.agent, "codex");
  assert.equal(acct.email, "c@x.com");
  assert.equal(acct.label, "c@x.com");
  const home = svc.homePath("codex", acct.id);
  const auth = JSON.parse(await readFile(join(home, "auth.json"), "utf8"));
  assert.equal(auth.tokens.access_token, "a");
  const marker = (await readFile(join(home, ".orq-account"), "utf8")).trim();
  assert.equal(marker, acct.id);
  assert.equal((await stat(home)).mode & 0o777, 0o700);
});

test("import claude requires a label and stores subscriptionType as plan", async () => {
  const { svc } = await makeService();
  const blob = JSON.stringify({ claudeAiOauth: { accessToken: "t", refreshToken: "r", subscriptionType: "max" } });
  await assert.rejects(() => svc.importAccount({ content: blob }), /label/i);
  const acct = await svc.importAccount({ content: blob, label: "Work" });
  assert.equal(acct.agent, "claude");
  assert.equal(acct.label, "Work");
  assert.equal(acct.plan, "max");
  const creds = JSON.parse(await readFile(join(svc.homePath("claude", acct.id), ".credentials.json"), "utf8"));
  assert.equal(creds.claudeAiOauth.refreshToken, "r");
});

test("import claude rejects a blob with empty OAuth tokens", async () => {
  const { svc } = await makeService();
  const blob = JSON.stringify({
    claudeAiOauth: {
      accessToken: "",
      refreshToken: "",
      expiresAt: 0,
      refreshTokenExpiresAt: 1791749244038,
      scopes: ["user:inference"],
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x"
    }
  });
  for (const content of [
    blob,
    JSON.stringify({ claudeAiOauth: {} }),
    JSON.stringify({ claudeAiOauth: { accessToken: 1, refreshToken: null } })
  ]) {
    await assert.rejects(
      () => svc.importAccount({ content, label: "Work" }),
      (e: Error) => e.name === "AgentAccountError" && /contains no OAuth tokens/.test(e.message)
    );
  }
  assert.equal(svc.list().accounts.filter((a) => a.agent === "claude").length, 0);
});

test("import claude accepts a refresh-token-only blob", async () => {
  const { svc } = await makeService();
  const blob = JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "r", expiresAt: 0 } });
  const acct = await svc.importAccount({ content: blob, label: "Work" });
  assert.equal(acct.agent, "claude");
  const creds = JSON.parse(await readFile(join(svc.homePath("claude", acct.id), ".credentials.json"), "utf8"));
  assert.equal(creds.claudeAiOauth.refreshToken, "r");
});

test("resolveLaunchEnv selects Claude/Codex homes and unsets competing API credentials", async () => {
  const { svc } = await makeService();
  const claude = await svc.importAccount({ content: JSON.stringify({ claudeAiOauth: { accessToken: "t" } }), label: "L" });
  const cEnv = await svc.resolveLaunchEnv("claude", claude.id);
  assert.equal(cEnv?.env.CLAUDE_CONFIG_DIR, svc.homePath("claude", claude.id));
  assert.deepEqual(cEnv?.unset, ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]);
  const codex = await svc.importAccount({ content: JSON.stringify({ tokens: { access_token: "a", id_token: jwt({ email: "z@z.com" }) } }) });
  const xEnv = await svc.resolveLaunchEnv("codex", codex.id);
  assert.equal(xEnv?.env.CODEX_HOME, svc.homePath("codex", codex.id));
  assert.deepEqual(xEnv?.unset, ["OPENAI_API_KEY"]);
});

test("resolveLaunchEnv returns the EFFECTIVE account id (explicit and default)", async () => {
  const { svc } = await makeService();
  const a = await svc.importAccount({ content: JSON.stringify({ claudeAiOauth: { accessToken: "t" } }), label: "A" });
  const b = await svc.importAccount({ content: JSON.stringify({ claudeAiOauth: { accessToken: "u" } }), label: "B" });
  // Explicit selection reports itself.
  assert.equal((await svc.resolveLaunchEnv("claude", b.id))?.accountId, b.id);
  // No explicit id → resolves to (and reports) the per-agent default, so the
  // session is recorded under the account it actually uses — liveAccountIds()
  // then sees it and the refresher won't rotate its live token.
  assert.equal(svc.list().defaults.claude, a.id);
  const defaultLaunch = await svc.resolveLaunchEnv("claude");
  assert.equal(defaultLaunch?.accountId, a.id);
  assert.equal(defaultLaunch?.env.CLAUDE_CONFIG_DIR, svc.homePath("claude", a.id));
});

test("resolveLaunchEnv honors the SYSTEM_ACCOUNT_ID sentinel over a default", async () => {
  const { svc } = await makeService();
  await svc.importAccount({ content: JSON.stringify({ claudeAiOauth: { accessToken: "t" } }), label: "L" });
  // A default exists, but an explicit System launch must bypass it (null → $HOME).
  assert.equal(await svc.resolveLaunchEnv("claude", "system"), null);
  assert.equal(await svc.resolveLaunchEnv("gemini"), null, "an agent without managed accounts uses System");
});

test("remove deletes the home and clears it from defaults", async () => {
  const { svc } = await makeService();
  const acct = await svc.importAccount({ content: JSON.stringify({ tokens: { access_token: "a", id_token: jwt({ email: "d@d.com" }) } }) });
  await svc.removeAccount(acct.id);
  assert.equal(svc.list().accounts.length, 0);
  assert.equal(svc.list().defaults.codex, null);
  await assert.rejects(() => stat(svc.homePath("codex", acct.id)));
});

test("index and API responses carry no token material", async () => {
  const { svc, base } = await makeService();
  await svc.importAccount({ content: JSON.stringify({ claudeAiOauth: { accessToken: "SECRET" } }), label: "L" });
  const indexRaw = await readFile(join(base, "agent-accounts.json"), "utf8");
  assert.equal(indexRaw.includes("SECRET"), false);
  assert.equal(JSON.stringify(svc.list()).includes("SECRET"), false);
});

async function makeServiceWithFetch(t: TestContext, now: number | (() => number), fetchImpl: typeof fetch) {
  t.mock.method(globalThis, "fetch", fetchImpl);
  const base = await mkdtemp(join(fixtureRoot, "orq-fresh-"));
  const svc = new AgentAccountsService({
    indexFile: join(base, "agent-accounts.json"),
    accountsDir: join(base, "agent-accounts"),
    userhome: base,
    now: typeof now === "number" ? () => now : now
  });
  await svc.init();
  return svc;
}

function codexBlob(accessExpSec: number): string {
  return JSON.stringify({
    tokens: {
      access_token: jwt({ exp: accessExpSec }),
      refresh_token: "OLDR",
      account_id: "acc1",
      id_token: jwt({ email: "c@x.com" })
    }
  });
}

test("ensureFreshForUsage refreshes an idle Codex account whose token is expiring", async (t) => {
  const now = 1_000_000;
  let called = 0;
  const svc = await makeServiceWithFetch(t, now, async () => {
    called++;
    return new Response(JSON.stringify({ access_token: "NEW", refresh_token: "NEWR", id_token: jwt({ email: "fresh@x.com" }) }), { status: 200 });
  });
  const acct = await svc.importAccount({ content: codexBlob(Math.floor((now + 60_000) / 1000)) });
  const before = await stat(join(svc.homePath("codex", acct.id), "auth.json"));
  await svc.ensureFreshForUsage("codex", acct.id, new Set());
  assert.equal(called, 1);
  // Replaced by rename: a running host Codex reloads auth.json before refreshing (never a torn read).
  const after = await stat(join(svc.homePath("codex", acct.id), "auth.json"));
  assert.notEqual(after.ino, before.ino, "a new file renamed over the old one");
  assert.equal(after.mode & 0o777, 0o600);
  const auth = JSON.parse(await readFile(join(svc.homePath("codex", acct.id), "auth.json"), "utf8"));
  assert.equal(auth.tokens.access_token, "NEW");
  assert.equal(auth.tokens.refresh_token, "NEWR");
  assert.equal(auth.tokens.id_token, jwt({ email: "fresh@x.com" }));
  assert.equal(auth.tokens.account_id, "acc1"); // preserved
});

test("an empty or missing refresh token is never posted: Claude, Codex and Grok accounts are unavailable to refresh", async (t) => {
  const now = 1_000_000;
  let called = 0;
  const svc = await makeServiceWithFetch(t, now, async () => {
    called++;
    return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
  });
  const expiring = Math.floor((now + 60_000) / 1000);
  const codexEmpty = await svc.importAccount({
    content: JSON.stringify({ tokens: { access_token: jwt({ exp: expiring }), refresh_token: "", account_id: "acc1", id_token: jwt({ email: "c@x.com" }) } })
  });
  const codexNone = await svc.importAccount({ content: JSON.stringify({ tokens: { access_token: jwt({ exp: expiring }), account_id: "acc2" } }), label: "No refresh" });
  const claudeEmpty = await svc.importAccount({ content: JSON.stringify({ claudeAiOauth: { accessToken: "t", refreshToken: "", expiresAt: now + 60_000 } }), label: "Claude" });
  const claudeNone = await svc.importAccount({ content: JSON.stringify({ claudeAiOauth: { accessToken: "t", expiresAt: now + 60_000 } }), label: "Claude 2" });
  const grokNone = await svc.importAccount({
    content: JSON.stringify({ "https://auth.x.ai::client": { key: "k", expires_at: new Date(now + 60_000).toISOString(), email: "g@x.com" } })
  });
  for (const account of [codexEmpty, codexNone, claudeEmpty, claudeNone, grokNone]) {
    assert.equal(await svc.refreshNow(account.agent as "claude" | "codex" | "grok", account.id), "unavailable", account.label);
    await svc.ensureFreshForUsage(account.agent as "claude" | "codex" | "grok", account.id, new Set());
  }
  assert.equal(called, 0, "no token endpoint was called");
  assert.equal(svc.list().accounts.some((account) => account.needsReauth), false, "nothing was marked for re-auth");
});

test("ensureFreshForUsage does not refresh an account with a live session", async (t) => {
  const now = 1_000_000;
  let called = 0;
  const svc = await makeServiceWithFetch(t, now, async () => {
    called++;
    return new Response("{}", { status: 200 });
  });
  const acct = await svc.importAccount({ content: codexBlob(Math.floor((now + 60_000) / 1000)) });
  await svc.ensureFreshForUsage("codex", acct.id, new Set([acct.id]));
  assert.equal(called, 0);
});

test("account login metadata follows CLI credential changes, including live accounts", async (t) => {
  const { svc, base } = await makeService();
  t.after(() => rm(base, { recursive: true, force: true }));
  const expiry = Date.parse("2026-10-19T12:00:00Z");
  const credentials = (refreshTokenExpiresAt: number, accessToken = "secret", refreshToken = "refresh-secret") =>
    JSON.stringify({ claudeAiOauth: { accessToken, refreshToken, expiresAt: 1, refreshTokenExpiresAt } });
  const account = await svc.importAccount({ label: "Work", content: credentials(expiry) });
  assert.equal(account.loginExpiresAt, new Date(expiry).toISOString());
  const path = join(svc.homePath("claude", account.id), ".credentials.json");
  const events: unknown[] = [];
  svc.events.on("changed", (payload) => events.push(payload));
  await writeFile(path, credentials(expiry + 86_400_000));
  await svc.ensureFreshForUsage("claude", account.id, new Set([account.id]));
  assert.equal(svc.list().accounts[0]?.loginExpiresAt, new Date(expiry + 86_400_000).toISOString());
  assert.equal(events.length, 1);
  await svc.refreshLoginStatuses();
  assert.equal(events.length, 1, "unchanged credentials do not broadcast");
  await writeFile(path, credentials(expiry, "", ""));
  await svc.refreshLoginStatuses();
  assert.equal(svc.list().accounts[0]?.needsReauth, true);
  await writeFile(path, credentials(expiry + 2 * 86_400_000));
  await svc.init();
  assert.equal(svc.list().accounts[0]?.needsReauth, false);
  assert.equal(svc.list().accounts[0]?.loginExpiresAt, new Date(expiry + 2 * 86_400_000).toISOString());
  assert.equal(JSON.stringify(events).includes("secret"), false);
  assert.equal((await readFile(join(base, "agent-accounts.json"), "utf8")).includes("secret"), false);
});

test("ensureFreshForUsage skips a token that is not near expiry", async (t) => {
  const now = 1_000_000;
  let called = 0;
  const svc = await makeServiceWithFetch(t, now, async () => {
    called++;
    return new Response("{}", { status: 200 });
  });
  const acct = await svc.importAccount({ content: codexBlob(Math.floor((now + 60 * 60_000) / 1000)) });
  await svc.ensureFreshForUsage("codex", acct.id, new Set());
  assert.equal(called, 0);
});

test("an account the retired model proxy owned is refreshed by the account service again", async (t) => {
  const now = 1_000_000;
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    access_token: "NEW", refresh_token: "NEWR", id_token: jwt({ email: "c@x.com" })
  }), { status: 200 }));
  const base = await mkdtemp(join(fixtureRoot, "orq-fresh-legacy-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const opts = {
    indexFile: join(base, "agent-accounts.json"),
    accountsDir: join(base, "agent-accounts"),
    userhome: base,
    now: () => now
  };
  const first = new AgentAccountsService(opts);
  await first.init();
  const acct = await first.importAccount({ content: codexBlob(Math.floor((now + 60_000) / 1000)) });
  const index = JSON.parse(await readFile(opts.indexFile, "utf8"));
  index.accounts[0].proxyOwned = true;
  await writeFile(opts.indexFile, JSON.stringify(index));
  const svc = new AgentAccountsService(opts);
  await svc.init();
  await svc.ensureFreshForUsage("codex", acct.id, new Set());
  const auth = JSON.parse(await readFile(join(svc.homePath("codex", acct.id), "auth.json"), "utf8"));
  assert.equal(auth.tokens.access_token, "NEW");
  assert.equal(auth.tokens.refresh_token, "NEWR");
  assert.equal(auth.tokens.account_id, "acc1");
});

test("resolveLaunchEnv seeds a Claude home: onboarding, mcps, stripped identity, symlinked skills/plugins", async () => {
  delete process.env.CLAUDE_CONFIG_DIR;
  const base = await mkdtemp(join(fixtureRoot, "orq-seed-"));
  await writeFile(
    join(base, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: "sys@x" }, userID: "u1", mcpServers: { foo: { command: "x" } }, hasCompletedOnboarding: false, tipsHistory: { a: 1 } })
  );
  await mkdir(join(base, ".claude", "skills"), { recursive: true });
  await mkdir(join(base, ".claude", "plugins"), { recursive: true });
  const svc = new AgentAccountsService({ indexFile: join(base, "idx.json"), accountsDir: join(base, "agent-accounts"), userhome: base, now: () => 1 });
  await svc.init();
  const acct = await svc.importAccount({ content: JSON.stringify({ claudeAiOauth: { accessToken: "t" } }), label: "L" });
  await svc.resolveLaunchEnv("claude", acct.id);
  const home = svc.homePath("claude", acct.id);
  const cj = JSON.parse(await readFile(join(home, ".claude.json"), "utf8"));
  assert.equal(cj.hasCompletedOnboarding, true);
  assert.deepEqual(Object.keys(cj.mcpServers), ["foo"]);
  assert.equal("oauthAccount" in cj, false);
  assert.equal("userID" in cj, false);
  assert.deepEqual(cj.tipsHistory, { a: 1 });
  assert.equal((await lstat(join(home, "skills"))).isSymbolicLink(), true);
  assert.equal((await lstat(join(home, "plugins"))).isSymbolicLink(), true);
});

test("Claude re-sync refreshes mcpServers but preserves the account's own identity", async () => {
  delete process.env.CLAUDE_CONFIG_DIR;
  const base = await mkdtemp(join(fixtureRoot, "orq-seed2-"));
  await mkdir(join(base, ".claude"), { recursive: true });
  await writeFile(join(base, ".claude.json"), JSON.stringify({ mcpServers: { foo: {} }, hasCompletedOnboarding: false }));
  const svc = new AgentAccountsService({ indexFile: join(base, "idx.json"), accountsDir: join(base, "agent-accounts"), userhome: base, now: () => 1 });
  await svc.init();
  const acct = await svc.importAccount({ content: JSON.stringify({ claudeAiOauth: { accessToken: "t" } }), label: "L" });
  const home = svc.homePath("claude", acct.id);
  await svc.resolveLaunchEnv("claude", acct.id);
  const cj1 = JSON.parse(await readFile(join(home, ".claude.json"), "utf8"));
  cj1.oauthAccount = { emailAddress: "acct@x" }; // claude bound its own identity
  await writeFile(join(home, ".claude.json"), JSON.stringify(cj1));
  await writeFile(join(base, ".claude.json"), JSON.stringify({ mcpServers: { foo: {}, bar: {} }, hasCompletedOnboarding: false })); // system added an MCP
  await svc.resolveLaunchEnv("claude", acct.id);
  const cj2 = JSON.parse(await readFile(join(home, ".claude.json"), "utf8"));
  assert.deepEqual(Object.keys(cj2.mcpServers).sort(), ["bar", "foo"]);
  assert.equal(cj2.oauthAccount.emailAddress, "acct@x");
});

test("resolveLaunchEnv shares Claude settings.json (symlink, replaces a stale real file)", async () => {
  delete process.env.CLAUDE_CONFIG_DIR;
  const base = await mkdtemp(join(fixtureRoot, "orq-set-"));
  await mkdir(join(base, ".claude"), { recursive: true });
  await writeFile(join(base, ".claude.json"), JSON.stringify({ mcpServers: {} }));
  await writeFile(join(base, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ user: 1 }] } }));
  const svc = new AgentAccountsService({ indexFile: join(base, "idx.json"), accountsDir: join(base, "agent-accounts"), userhome: base, now: () => 1 });
  await svc.init();
  const acct = await svc.importAccount({ content: JSON.stringify({ claudeAiOauth: { accessToken: "t" } }), label: "L" });
  const home = svc.homePath("claude", acct.id);
  await writeFile(join(home, "settings.json"), JSON.stringify({ hooks: { Stop: [{ managed: 1 }] } })); // stale daemon-written file
  await svc.resolveLaunchEnv("claude", acct.id);
  assert.equal((await lstat(join(home, "settings.json"))).isSymbolicLink(), true);
  const via = JSON.parse(await readFile(join(home, "settings.json"), "utf8"));
  assert.deepEqual(via.hooks.Stop, [{ user: 1 }]); // reads through to the shared system settings
});

test("resolveLaunchEnv shares Codex config.toml + hooks.json (replaces stale real files)", async () => {
  delete process.env.CODEX_HOME;
  const base = await mkdtemp(join(fixtureRoot, "orq-chooks-"));
  await mkdir(join(base, ".codex"), { recursive: true });
  await writeFile(join(base, ".codex", "config.toml"), "model='sys'\n[mcp_servers.foo]\n");
  await writeFile(join(base, ".codex", ".personality_migration"), "1");
  await writeFile(join(base, ".codex", ".sandbox_migration"), "2");
  await writeFile(join(base, ".codex", "hooks.json"), JSON.stringify({ hooks: { Stop: [{ user: 1 }] } }));
  const svc = new AgentAccountsService({ indexFile: join(base, "idx.json"), accountsDir: join(base, "agent-accounts"), userhome: base, now: () => 1 });
  await svc.init();
  const acct = await svc.importAccount({ content: JSON.stringify({ tokens: { access_token: "a", id_token: jwt({ email: "z@z" }) } }) });
  const home = svc.homePath("codex", acct.id);
  await writeFile(join(home, "config.toml"), "model='stale'\n"); // stale real file (old daemon trust write)
  await svc.resolveLaunchEnv("codex", acct.id);
  assert.equal((await lstat(join(home, "config.toml"))).isSymbolicLink(), true);
  assert.match(await readFile(join(home, "config.toml"), "utf8"), /mcp_servers\.foo/);
  assert.equal((await lstat(join(home, "hooks.json"))).isSymbolicLink(), true);
  assert.equal(await readFile(join(home, ".personality_migration"), "utf8"), "1");
  assert.equal(await readFile(join(home, ".sandbox_migration"), "utf8"), "2");
});

test("resolveLaunchEnv symlinks an empty/absent Codex sessions/ to the shared store", async () => {
  delete process.env.CODEX_HOME;
  const base = await mkdtemp(join(fixtureRoot, "orq-hist2-"));
  await mkdir(join(base, ".codex", "sessions", "s1"), { recursive: true });
  const svc = new AgentAccountsService({ indexFile: join(base, "idx.json"), accountsDir: join(base, "agent-accounts"), userhome: base, now: () => 1 });
  await svc.init();
  const acct = await svc.importAccount({ content: JSON.stringify({ tokens: { access_token: "a", id_token: jwt({ email: "z@z" }) } }) });
  const home = svc.homePath("codex", acct.id);
  await svc.resolveLaunchEnv("codex", acct.id);
  assert.equal((await lstat(join(home, "sessions"))).isSymbolicLink(), true);
  assert.equal((await lstat(join(home, "sessions", "s1"))).isDirectory(), true); // reads through to shared sessions
});

test("shared history recursively merges a COLLIDING project dir, then symlinks", async () => {
  delete process.env.CLAUDE_CONFIG_DIR;
  const base = await mkdtemp(join(fixtureRoot, "orq-histc-"));
  await mkdir(join(base, ".claude", "projects", "P"), { recursive: true }); // system project P
  await writeFile(join(base, ".claude", "projects", "P", "s1.jsonl"), "sys");
  const svc = new AgentAccountsService({ indexFile: join(base, "idx.json"), accountsDir: join(base, "agent-accounts"), userhome: base, now: () => 1 });
  await svc.init();
  const acct = await svc.importAccount({ content: JSON.stringify({ claudeAiOauth: { accessToken: "t" } }), label: "L" });
  const home = svc.homePath("claude", acct.id);
  await mkdir(join(home, "projects", "P"), { recursive: true }); // SAME project name (collides)
  await writeFile(join(home, "projects", "P", "s2.jsonl"), "acct"); // but a different session file
  await mkdir(join(home, "projects", "Q"), { recursive: true });
  await writeFile(join(home, "projects", "Q", "s3.jsonl"), "other project");
  await svc.resolveLaunchEnv("claude", acct.id);
  assert.equal((await lstat(join(home, "projects"))).isSymbolicLink(), true); // merged fully → symlinked
  assert.equal(await readFile(join(base, ".claude", "projects", "P", "s1.jsonl"), "utf8"), "sys"); // system's kept
  assert.equal(await readFile(join(base, ".claude", "projects", "P", "s2.jsonl"), "utf8"), "acct"); // account's merged in
  assert.equal(await readFile(join(home, "projects", "P", "s1.jsonl"), "utf8"), "sys");
  assert.equal(await readFile(join(base, ".claude", "projects", "Q", "s3.jsonl"), "utf8"), "other project");
});

const GROK_BLOB = JSON.stringify({
  "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
    key: "at",
    refresh_token: "rt",
    email: "g@x.com",
    user_id: "u-9",
    expires_at: "2026-08-06T03:29:17Z"
  }
});

test("import a grok auth.json derives identity and resolves GROK_HOME at launch", async () => {
  const { svc } = await makeService();
  const acct = await svc.importAccount({ content: GROK_BLOB });
  assert.equal(acct.agent, "grok");
  assert.equal(acct.email, "g@x.com");
  assert.equal(acct.label, "g@x.com");
  assert.equal(svc.list().defaults.grok, acct.id);
  const auth = JSON.parse(await readFile(join(svc.homePath("grok", acct.id), "auth.json"), "utf8"));
  assert.equal(Object.keys(auth).length, 1);
  const env = await svc.resolveLaunchEnv("grok", acct.id);
  assert.equal(env?.env.GROK_HOME, svc.homePath("grok", acct.id));
  assert.deepEqual(env?.unset, ["XAI_API_KEY"]);
  assert.equal(env?.accountId, acct.id);
});

function expiringGrokBlob(now: number): string {
  return JSON.stringify({
    "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
      key: "at",
      refresh_token: "rt",
      email: "g@x.com",
      expires_at: new Date(now + 60_000).toISOString()
    }
  });
}

test("a Grok refresh replaces auth.json by rename (as the CLI does), 0600, nothing left behind", async (t) => {
  const now = Date.parse("2026-10-18T00:00:00Z");
  let called = 0;
  const svc = await makeServiceWithFetch(t, now, async () => {
    called++;
    return new Response(JSON.stringify({ access_token: "NEW", refresh_token: "NEWR", expires_in: 3600 }), { status: 200 });
  });
  const acct = await svc.importAccount({ content: expiringGrokBlob(now) });
  const home = svc.homePath("grok", acct.id);
  const before = await stat(join(home, "auth.json"));
  await svc.ensureFreshForUsage("grok", acct.id, new Set());
  assert.equal(called, 1);
  const after = await stat(join(home, "auth.json"));
  assert.notEqual(after.ino, before.ino, "a new file renamed over the old one");
  assert.equal(after.mode & 0o777, 0o600);
  const entry = JSON.parse(await readFile(join(home, "auth.json"), "utf8"))["https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828"];
  assert.equal(entry.key, "NEW");
  assert.equal(entry.refresh_token, "NEWR");
  assert.equal(entry.email, "g@x.com");
  assert.deepEqual((await readdir(home)).filter((name) => name.endsWith(".tmp")), []);
});

test("the refresher re-reads the live sessions before spending a refresh token (a chat that just started)", async (t) => {
  const now = Date.parse("2026-10-18T00:00:00Z");
  let called = 0;
  const svc = await makeServiceWithFetch(t, now, async () => {
    called++;
    return new Response(JSON.stringify({ access_token: "NEW" }), { status: 200 });
  });
  const acct = await svc.importAccount({ content: expiringGrokBlob(now) });
  // A Grok chat (Global or Agent Profile: both pin the account) starts after the caller's snapshot.
  const live = new Set<string>([acct.id]);
  svc.startRefresher(() => live);
  t.after(() => svc.stopRefresher());
  await svc.ensureFreshForUsage("grok", acct.id, new Set());
  assert.equal(called, 0);
  live.clear();
  await svc.ensureFreshForUsage("grok", acct.id, new Set());
  assert.equal(called, 1);
});

test("the refresher renews held accounts before their CLI, respects its lock, and renews after the lock clears on the next hourly tick", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let now = Date.parse("2026-10-18T00:00:00Z");
  const urls: string[] = [];
  let refreshRequested: () => void = () => {};
  const nextRequest = () => new Promise<void>((resolve) => { refreshRequested = resolve; });
  const svc = await makeServiceWithFetch(t, () => now, async (input) => {
    urls.push(String(input));
    refreshRequested();
    return new Response(
      JSON.stringify({ access_token: jwt({ exp: Math.floor(now / 1000) + 864_000 }), refresh_token: "NEWR", expires_in: 28_800 }),
      { status: 200 }
    );
  });
  t.after(() => svc.stopRefresher());
  // Import Claude first: observing the later Codex request means the first scan
  // already checked and skipped Claude's lock, without inspecting the scanner.
  const claude = await svc.importAccount({
    content: JSON.stringify({ claudeAiOauth: { accessToken: "at", refreshToken: "rt", expiresAt: now + 80 * 60_000 } }),
    label: "L"
  });
  const codex = await svc.importAccount({ content: codexBlob(Math.floor((now + 40 * 60_000) / 1000)) });
  const lock = join(svc.homePath("claude", claude.id), ".oauth_refresh.lock");
  await mkdir(lock);
  const held = new Set([claude.id, codex.id]);
  let requested = nextRequest();
  svc.startRefresher(() => held);
  await requested;
  // refreshNow joins this account's in-flight request through the public service API.
  assert.equal(await svc.refreshNow("codex", codex.id), "refreshed");
  assert.deepEqual(urls, ["https://auth.openai.com/oauth/token"]);
  const auth = JSON.parse(await readFile(join(svc.homePath("codex", codex.id), "auth.json"), "utf8"));
  assert.equal(auth.tokens.refresh_token, "NEWR");

  await rm(lock, { recursive: true });
  requested = nextRequest();
  now += 60 * 60_000;
  t.mock.timers.tick(60 * 60_000);
  await requested;
  assert.equal(await svc.refreshNow("claude", claude.id, { allowHeld: true }), "refreshed");
  assert.deepEqual(urls, ["https://auth.openai.com/oauth/token", "https://platform.claude.com/v1/oauth/token"]);
  const credentials = JSON.parse(await readFile(join(svc.homePath("claude", claude.id), ".credentials.json"), "utf8"));
  assert.equal(credentials.claudeAiOauth.refreshToken, "NEWR");
});

test("an invalid_grant for a refresh token a host CLI already rotated is that CLI's refresh, not a login to redo", async (t) => {
  const now = 1_000_000;
  let home = "";
  const svc = await makeServiceWithFetch(t, now, async () => {
    await writeFile(join(home, "auth.json"), codexBlob(Math.floor(now / 1000) + 864_000).replace("OLDR", "CLIR"));
    return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
  });
  const acct = await svc.importAccount({ content: codexBlob(Math.floor((now + 60_000) / 1000)) });
  home = svc.homePath("codex", acct.id);
  const outcome = await svc.refreshNow("codex", acct.id);
  assert.equal(svc.getRecord(acct.id)?.needsReauth, false);
  assert.equal(outcome, "refreshed");
  // The file still holding what was posted: a real invalid_grant.
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
  assert.equal(await svc.refreshNow("codex", acct.id), "invalid-grant");
  assert.equal(svc.getRecord(acct.id)?.needsReauth, true);
});

// ---------------------------------------------------------------------------
// Agent profile §5: the owner's instructions, commands, rules and skills are
// shared into every managed account home.
// ---------------------------------------------------------------------------

async function linkingFixture(agent: "claude" | "codex" | "grok") {
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  delete process.env.GROK_HOME;
  const base = await mkdtemp(join(fixtureRoot, `orq-link-${agent}-`));
  const system = join(base, agent === "claude" ? ".claude" : agent === "codex" ? ".codex" : ".grok");
  await mkdir(system, { recursive: true });
  const svc = new AgentAccountsService({ indexFile: join(base, "idx.json"), accountsDir: join(base, "agent-accounts"), userhome: base, now: () => 1 });
  await svc.init();
  const blob =
    agent === "claude"
      ? { content: JSON.stringify({ claudeAiOauth: { accessToken: "t" } }), label: "L" }
      : agent === "codex"
        ? { content: JSON.stringify({ tokens: { access_token: "a", id_token: jwt({ email: "z@z" }) } }) }
        : { content: GROK_BLOB };
  const acct = await svc.importAccount(blob);
  const home = svc.homePath(agent, acct.id);
  return { base, system, svc, acct, home, id8: acct.id.slice(0, 8), launch: () => svc.resolveLaunchEnv(agent, acct.id) };
}

test("Claude: CLAUDE.md is linked even before it exists (a dangling link reads as missing) and commands/ is created 0700", async () => {
  const f = await linkingFixture("claude");
  await f.launch();
  assert.equal(await readlink(join(f.home, "CLAUDE.md")), join(f.system, "CLAUDE.md"));
  await assert.rejects(readFile(join(f.home, "CLAUDE.md"), "utf8"), { code: "ENOENT" }, "dangling: the CLI sees no file");
  assert.equal(await readlink(join(f.home, "commands")), join(f.system, "commands"));
  assert.equal((await stat(join(f.system, "commands"))).mode & 0o777, 0o700);
  // The owner writes the global file once; every account sees it at once.
  await writeFile(join(f.system, "CLAUDE.md"), "be terse\n");
  assert.equal(await readFile(join(f.home, "CLAUDE.md"), "utf8"), "be terse\n");
  await writeFile(join(f.system, "commands", "ship.md"), "ship it");
  assert.equal(await readFile(join(f.home, "commands", "ship.md"), "utf8"), "ship it");
  // Idempotent: a second launch changes nothing.
  await f.launch();
  assert.equal(await readlink(join(f.home, "CLAUDE.md")), join(f.system, "CLAUDE.md"));
  assert.equal((await readdir(f.home)).includes("agents"), false, "agents/ is not shared");
});

test("Claude: an account's own CLAUDE.md moves to the shared path when the owner has none", async () => {
  const f = await linkingFixture("claude");
  await writeFile(join(f.home, "CLAUDE.md"), "account notes");
  await f.launch();
  assert.equal((await lstat(join(f.home, "CLAUDE.md"))).isSymbolicLink(), true);
  assert.equal(await readFile(join(f.system, "CLAUDE.md"), "utf8"), "account notes");
});

test("Claude: a differing CLAUDE.md keeps the owner's and saves the account's beside it; an identical one is dropped", async () => {
  const f = await linkingFixture("claude");
  await writeFile(join(f.system, "CLAUDE.md"), "owner");
  await writeFile(join(f.home, "CLAUDE.md"), "account");
  await f.launch();
  assert.equal(await readFile(join(f.home, "CLAUDE.md"), "utf8"), "owner");
  assert.equal(await readFile(join(f.system, `CLAUDE.md.account-${f.id8}.bak`), "utf8"), "account");

  const g = await linkingFixture("claude");
  await writeFile(join(g.system, "CLAUDE.md"), "same");
  await writeFile(join(g.home, "CLAUDE.md"), "same");
  await g.launch();
  assert.equal((await lstat(join(g.home, "CLAUDE.md"))).isSymbolicLink(), true);
  assert.deepEqual((await readdir(g.system)).filter((n) => n.includes(".bak")), []);
});

test("Claude: a real commands/ merges in — unique moved, identical dropped, a collision kept as <name>-<id8>", async () => {
  const f = await linkingFixture("claude");
  await mkdir(join(f.system, "commands", "team"), { recursive: true });
  await writeFile(join(f.system, "commands", "b.md"), "owner b");
  await writeFile(join(f.system, "commands", "c.md"), "same c");
  await mkdir(join(f.home, "commands", "team"), { recursive: true });
  await writeFile(join(f.home, "commands", "a.md"), "account a");
  await writeFile(join(f.home, "commands", "b.md"), "account b");
  await writeFile(join(f.home, "commands", "c.md"), "same c");
  await writeFile(join(f.home, "commands", "team", "deploy.md"), "deploy");
  await f.launch();
  assert.equal(await readlink(join(f.home, "commands")), join(f.system, "commands"));
  const shared = join(f.system, "commands");
  assert.equal(await readFile(join(shared, "a.md"), "utf8"), "account a");
  assert.equal(await readFile(join(shared, "b.md"), "utf8"), "owner b");
  assert.equal(await readFile(join(shared, `b-${f.id8}.md`), "utf8"), "account b");
  assert.equal(await readFile(join(shared, "c.md"), "utf8"), "same c");
  assert.equal(await readFile(join(shared, `team-${f.id8}`, "deploy.md"), "utf8"), "deploy", "a colliding dir is one item, kept whole");
  assert.deepEqual((await readdir(shared)).sort(), ["a.md", "b.md", `b-${f.id8}.md`, "c.md", "team", `team-${f.id8}`].sort());
});

test("Claude: a symlink pointing elsewhere is replaced by the shared link", async () => {
  const f = await linkingFixture("claude");
  await mkdir(join(f.base, "elsewhere"), { recursive: true });
  await symlink(join(f.base, "elsewhere"), join(f.home, "commands"));
  await f.launch();
  assert.equal(await readlink(join(f.home, "commands")), join(f.system, "commands"));
});

test("Codex: skills/ merges user skills, drops the account's bundled .system when the shared dir has one", async () => {
  const f = await linkingFixture("codex");
  await mkdir(join(f.system, "skills", ".system", "imagegen"), { recursive: true });
  await writeFile(join(f.system, "skills", ".system", "imagegen", "SKILL.md"), "bundled v2");
  await mkdir(join(f.system, "skills", "dup"), { recursive: true });
  await writeFile(join(f.system, "skills", "dup", "SKILL.md"), "owner dup");
  await mkdir(join(f.home, "skills", ".system", "imagegen"), { recursive: true });
  await writeFile(join(f.home, "skills", ".system", "imagegen", "SKILL.md"), "bundled v1");
  await mkdir(join(f.home, "skills", "mine"), { recursive: true });
  await writeFile(join(f.home, "skills", "mine", "SKILL.md"), "my skill");
  await mkdir(join(f.home, "skills", "dup"), { recursive: true });
  await writeFile(join(f.home, "skills", "dup", "SKILL.md"), "account dup");
  await f.launch();
  const shared = join(f.system, "skills");
  assert.equal(await readlink(join(f.home, "skills")), shared);
  assert.equal(await readFile(join(shared, ".system", "imagegen", "SKILL.md"), "utf8"), "bundled v2", "the shared .system is kept");
  assert.equal(await readFile(join(shared, "mine", "SKILL.md"), "utf8"), "my skill");
  assert.equal(await readFile(join(shared, "dup", "SKILL.md"), "utf8"), "owner dup");
  assert.equal(await readFile(join(shared, `dup-${f.id8}`, "SKILL.md"), "utf8"), "account dup", "never lose a user skill");
  assert.deepEqual((await readdir(shared)).sort(), [".system", "dup", `dup-${f.id8}`, "mine"].sort());
});

test("Codex: AGENTS.md is shared — linked even before it exists, and an account's own copy moves across", async () => {
  const f = await linkingFixture("codex");
  await writeFile(join(f.home, "AGENTS.md"), "account rules");
  await f.launch();
  assert.equal(await readlink(join(f.home, "AGENTS.md")), join(f.system, "AGENTS.md"));
  assert.equal(await readFile(join(f.system, "AGENTS.md"), "utf8"), "account rules");

  const g = await linkingFixture("codex");
  await g.launch();
  assert.equal(await readlink(join(g.home, "AGENTS.md")), join(g.system, "AGENTS.md"), "dangling until the owner writes it");
});

test("Codex: the account's .system moves across when the shared skills/ has none; an absent shared dir is created", async () => {
  const f = await linkingFixture("codex");
  await mkdir(join(f.home, "skills", ".system", "imagegen"), { recursive: true });
  await writeFile(join(f.home, "skills", ".system", "imagegen", "SKILL.md"), "bundled");
  await f.launch();
  assert.equal((await lstat(join(f.home, "skills"))).isSymbolicLink(), true);
  assert.equal(await readFile(join(f.system, "skills", ".system", "imagegen", "SKILL.md"), "utf8"), "bundled");

  const g = await linkingFixture("codex");
  await g.launch();
  assert.equal(await readlink(join(g.home, "skills")), join(g.system, "skills"));
  assert.equal((await stat(join(g.system, "skills"))).mode & 0o777, 0o700);
});

test("Grok: AGENTS.md, commands/ and rules/ are shared; agents/ is not", async () => {
  const f = await linkingFixture("grok");
  await writeFile(join(f.system, "AGENTS.md"), "grok rules");
  await mkdir(join(f.home, "rules"), { recursive: true });
  await writeFile(join(f.home, "rules", "style.md"), "account style");
  await mkdir(join(f.system, "agents"), { recursive: true });
  await f.launch();
  assert.equal(await readFile(join(f.home, "AGENTS.md"), "utf8"), "grok rules");
  assert.equal(await readlink(join(f.home, "commands")), join(f.system, "commands"));
  assert.equal(await readlink(join(f.home, "rules")), join(f.system, "rules"));
  assert.equal(await readFile(join(f.system, "rules", "style.md"), "utf8"), "account style");
  await assert.rejects(lstat(join(f.home, "agents")), { code: "ENOENT" });
});

test("nothing is linked into an agent home the daemon user does not have", async () => {
  delete process.env.GROK_HOME;
  const base = await mkdtemp(join(fixtureRoot, "orq-link-nohome-"));
  const svc = new AgentAccountsService({ indexFile: join(base, "idx.json"), accountsDir: join(base, "agent-accounts"), userhome: base, now: () => 1 });
  await svc.init();
  const acct = await svc.importAccount({ content: GROK_BLOB });
  await svc.resolveLaunchEnv("grok", acct.id);
  const home = svc.homePath("grok", acct.id);
  await assert.rejects(lstat(join(home, "AGENTS.md")), { code: "ENOENT" });
  await assert.rejects(lstat(join(home, "commands")), { code: "ENOENT" });
  await assert.rejects(lstat(join(base, ".grok")), { code: "ENOENT" }, "the agent home itself is never created");
});

test("Claude: two accounts launched at once both keep their own command and CLAUDE.md (no move overwrites another)", async () => {
  const f = await linkingFixture("claude");
  const other = await f.svc.importAccount({ content: JSON.stringify({ claudeAiOauth: { accessToken: "u" } }), label: "M" });
  const homes: Array<[string, string]> = [
    [f.acct.id, f.home],
    [other.id, f.svc.homePath("claude", other.id)]
  ];
  for (const [id, home] of homes) {
    await mkdir(join(home, "commands"), { recursive: true });
    await writeFile(join(home, "commands", "review.md"), `review from ${id}`);
    await writeFile(join(home, "CLAUDE.md"), `notes from ${id}`);
  }
  await Promise.all(homes.map(([id]) => f.svc.resolveLaunchEnv("claude", id)));
  const commands = join(f.system, "commands");
  const reviews = await Promise.all((await readdir(commands)).map((name) => readFile(join(commands, name), "utf8")));
  const notes = await Promise.all(
    (await readdir(f.system)).filter((name) => name.startsWith("CLAUDE.md")).map((name) => readFile(join(f.system, name), "utf8"))
  );
  for (const [id, home] of homes) {
    assert.ok(reviews.includes(`review from ${id}`), `${id}'s command survived: ${JSON.stringify(reviews)}`);
    assert.ok(notes.includes(`notes from ${id}`), `${id}'s CLAUDE.md survived: ${JSON.stringify(notes)}`);
    assert.equal(await readlink(join(home, "commands")), commands);
    assert.equal(await readlink(join(home, "CLAUDE.md")), join(f.system, "CLAUDE.md"));
  }
});

test("Claude: overlapping launches of one account never drop the owner's shared commands", async (t) => {
  const f = await linkingFixture("claude");
  t.after(() => rm(f.base, { recursive: true, force: true }));
  for (let lag = 0; lag < 40; lag += 1) {
    // The previous launch linked home/commands; remove that link before resetting the shared dir.
    await rm(join(f.home, "commands"), { recursive: true, force: true });
    await rm(join(f.system, "commands"), { recursive: true, force: true });
    await mkdir(join(f.system, "commands"), { recursive: true });
    await writeFile(join(f.system, "commands", "owner.md"), "owner");
    await mkdir(join(f.home, "commands"), { recursive: true });
    await writeFile(join(f.home, "commands", "owner.md"), "owner");
    await writeFile(join(f.home, "commands", "mine.md"), "mine");
    const first = f.launch();
    // Start the second launch a few event-loop turns into the first (no timers involved).
    for (let i = 0; i < lag; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    await Promise.all([first, f.launch()]);
    assert.deepEqual((await readdir(join(f.system, "commands"))).sort(), ["mine.md", "owner.md"], `lag ${lag}`);
    assert.equal(await readFile(join(f.system, "commands", "owner.md"), "utf8"), "owner");
  }
});

test("Claude: a shared CLAUDE.md that is itself a link (dotfiles) is compared by what it names", async () => {
  const f = await linkingFixture("claude");
  await writeFile(join(f.base, "dotfiles-CLAUDE.md"), "same");
  await symlink(join(f.base, "dotfiles-CLAUDE.md"), join(f.system, "CLAUDE.md"));
  await writeFile(join(f.home, "CLAUDE.md"), "same");
  await f.launch();
  assert.equal(await readlink(join(f.home, "CLAUDE.md")), join(f.system, "CLAUDE.md"));
  assert.deepEqual((await readdir(f.system)).filter((name) => name.includes(".bak")), [], "an identical copy is not a conflict");
  assert.equal(await readlink(join(f.system, "CLAUDE.md")), join(f.base, "dotfiles-CLAUDE.md"), "the owner's link is kept");
});

test("Claude: an account copy never replaces a dangling shared CLAUDE.md link", async () => {
  const f = await linkingFixture("claude");
  await symlink(join(f.base, "not-yet.md"), join(f.system, "CLAUDE.md"));
  await writeFile(join(f.home, "CLAUDE.md"), "account");
  await f.launch();
  assert.equal(await readlink(join(f.system, "CLAUDE.md")).catch(() => null), join(f.base, "not-yet.md"), "the owner's link is kept");
  assert.equal(await readFile(join(f.home, "CLAUDE.md"), "utf8"), "account", "the account's copy is left in place");
});

// --- orphan account homes ---------------------------------------------------

const ORPHAN = "836bbf19-80d7-4dc8-adb2-a851fed9bc1f";

/** What a CLI still running under a deleted account leaves: a home with its own `projects/`. */
async function orphanHome(base: string, agent: string, id: string, files: Record<string, string>) {
  const home = join(base, "agent-accounts", agent, id, "home");
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(home, path, ".."), { recursive: true });
    await writeFile(join(home, path), content);
  }
  return join(base, "agent-accounts", agent, id);
}

test("pruneOrphanHomes moves an orphan's history into the shared store and removes it", async () => {
  const { base, svc } = await makeService();
  const shared = join(base, ".claude", "projects");
  await mkdir(join(shared, "-w-p"), { recursive: true });
  await writeFile(join(shared, "-w-p", "same.jsonl"), "line\n");
  const dir = await orphanHome(base, "claude", ORPHAN, {
    "projects/-w-p/same.jsonl": "line\n",
    "projects/-w-p/only-here.jsonl": "kept\n",
    ".claude.json": "{}"
  });

  const removed = await svc.pruneOrphanHomes(new Set());

  assert.deepEqual(removed, [dir]);
  await assert.rejects(() => lstat(dir), "the orphan is gone");
  assert.equal(await readFile(join(shared, "-w-p", "only-here.jsonl"), "utf8"), "kept\n");
  assert.equal(await readFile(join(shared, "-w-p", "same.jsonl"), "utf8"), "line\n");
});

test("pruneOrphanHomes keeps an orphan whose transcript differs from the shared copy", async () => {
  const { base, svc } = await makeService();
  const shared = join(base, ".claude", "projects");
  await mkdir(join(shared, "-w-p"), { recursive: true });
  await writeFile(join(shared, "-w-p", "s.jsonl"), "short\n");
  const dir = await orphanHome(base, "claude", ORPHAN, { "projects/-w-p/s.jsonl": "short\nand longer\n" });

  assert.deepEqual(await svc.pruneOrphanHomes(new Set()), []);
  assert.equal(await readFile(join(dir, "home", "projects", "-w-p", "s.jsonl"), "utf8"), "short\nand longer\n");
});

test("pruneOrphanHomes never touches a registered account, one in use, or a foreign dir", async () => {
  const { base, svc } = await makeService();
  await mkdir(join(base, ".claude", "projects"), { recursive: true });
  const acct = await svc.importAccount({ content: JSON.stringify({ claudeAiOauth: { accessToken: "t" } }), label: "L" });
  const inUse = await orphanHome(base, "claude", ORPHAN, { "projects/-w-p/a.jsonl": "x" });
  const foreign = await orphanHome(base, "claude", "not-an-account", { "notes.txt": "mine" });

  assert.deepEqual(await svc.pruneOrphanHomes(new Set([ORPHAN])), []);
  await lstat(svc.homePath("claude", acct.id));
  await lstat(inUse);
  await lstat(foreign);
});
