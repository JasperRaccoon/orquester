import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, stat, mkdir, writeFile, lstat, readlink, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { AgentAccountsService } from "./agent-accounts.ts";

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.`;
}

async function makeService() {
  const base = await mkdtemp(join(tmpdir(), "orq-accts-"));
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

test("resolveLaunchEnv maps claude to CLAUDE_CONFIG_DIR + unset, codex to CODEX_HOME", async () => {
  const { svc } = await makeService();
  const claude = await svc.importAccount({ content: JSON.stringify({ claudeAiOauth: { accessToken: "t" } }), label: "L" });
  const cEnv = await svc.resolveLaunchEnv("claude", claude.id);
  assert.equal(cEnv?.env.CLAUDE_CONFIG_DIR, svc.homePath("claude", claude.id));
  assert.deepEqual(cEnv?.unset, ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]);
  const codex = await svc.importAccount({ content: JSON.stringify({ tokens: { access_token: "a", id_token: jwt({ email: "z@z.com" }) } }) });
  const xEnv = await svc.resolveLaunchEnv("codex", codex.id);
  assert.equal(xEnv?.env.CODEX_HOME, svc.homePath("codex", codex.id));
});

test("resolveLaunchEnv falls back to the default account, then System(null)", async () => {
  const { svc } = await makeService();
  const claude = await svc.importAccount({ content: JSON.stringify({ claudeAiOauth: { accessToken: "t" } }), label: "L" });
  const dflt = await svc.resolveLaunchEnv("claude"); // no id → default
  assert.equal(dflt?.env.CLAUDE_CONFIG_DIR, svc.homePath("claude", claude.id));
  const none = await svc.resolveLaunchEnv("gemini"); // no accounts for agent → System
  assert.equal(none, null);
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
  assert.equal((await svc.resolveLaunchEnv("claude"))?.accountId, a.id);
});

test("resolveLaunchEnv honors the SYSTEM_ACCOUNT_ID sentinel over a default", async () => {
  const { svc } = await makeService();
  await svc.importAccount({ content: JSON.stringify({ claudeAiOauth: { accessToken: "t" } }), label: "L" });
  // A default exists, but an explicit System launch must bypass it (null → $HOME).
  assert.equal(await svc.resolveLaunchEnv("claude", "system"), null);
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

async function makeServiceWithFetch(t: TestContext, now: number, fetchImpl: typeof fetch) {
  t.mock.method(globalThis, "fetch", fetchImpl);
  const base = await mkdtemp(join(tmpdir(), "orq-fresh-"));
  const svc = new AgentAccountsService({
    indexFile: join(base, "agent-accounts.json"),
    accountsDir: join(base, "agent-accounts"),
    userhome: base,
    now: () => now
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
    return new Response(JSON.stringify({ access_token: "NEW", refresh_token: "NEWR", id_token: jwt({ email: "c@x.com" }) }), { status: 200 });
  });
  const acct = await svc.importAccount({ content: codexBlob(Math.floor((now + 60_000) / 1000)) });
  await svc.ensureFreshForUsage("codex", acct.id, new Set());
  assert.equal(called, 1);
  const auth = JSON.parse(await readFile(join(svc.homePath("codex", acct.id), "auth.json"), "utf8"));
  assert.equal(auth.tokens.access_token, "NEW");
  assert.equal(auth.tokens.refresh_token, "NEWR");
  assert.equal(auth.tokens.account_id, "acc1"); // preserved
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
  const base = await mkdtemp(join(tmpdir(), "orq-fresh-legacy-"));
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

test("resolveLaunchEnv unsets OPENAI_API_KEY for a managed Codex session", async () => {
  const { svc } = await makeService();
  const acct = await svc.importAccount({ content: JSON.stringify({ tokens: { access_token: "a", id_token: jwt({ email: "z@z.com" }) } }) });
  const env = await svc.resolveLaunchEnv("codex", acct.id);
  assert.equal(env?.env.CODEX_HOME, svc.homePath("codex", acct.id));
  assert.deepEqual(env?.unset, ["OPENAI_API_KEY"]);
});

test("resolveLaunchEnv seeds a Claude home: onboarding, mcps, stripped identity, symlinked skills/plugins", async () => {
  delete process.env.CLAUDE_CONFIG_DIR;
  const base = await mkdtemp(join(tmpdir(), "orq-seed-"));
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
  const base = await mkdtemp(join(tmpdir(), "orq-seed2-"));
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

test("resolveLaunchEnv seeds a Codex home: symlinked config.toml + migration markers", async () => {
  delete process.env.CODEX_HOME;
  const base = await mkdtemp(join(tmpdir(), "orq-seedc-"));
  await mkdir(join(base, ".codex"), { recursive: true });
  await writeFile(join(base, ".codex", "config.toml"), "model='x'\n[mcp_servers.foo]\n");
  await writeFile(join(base, ".codex", ".personality_migration"), "1");
  await writeFile(join(base, ".codex", ".sandbox_migration"), "2");
  const svc = new AgentAccountsService({ indexFile: join(base, "idx.json"), accountsDir: join(base, "agent-accounts"), userhome: base, now: () => 1 });
  await svc.init();
  const acct = await svc.importAccount({ content: JSON.stringify({ tokens: { access_token: "a", id_token: jwt({ email: "z@z" }) } }) });
  await svc.resolveLaunchEnv("codex", acct.id);
  const home = svc.homePath("codex", acct.id);
  assert.equal((await lstat(join(home, "config.toml"))).isSymbolicLink(), true);
  assert.equal(await readFile(join(home, ".personality_migration"), "utf8"), "1");
  assert.equal(await readFile(join(home, ".sandbox_migration"), "utf8"), "2");
});

test("resolveLaunchEnv shares Claude settings.json (symlink, replaces a stale real file)", async () => {
  delete process.env.CLAUDE_CONFIG_DIR;
  const base = await mkdtemp(join(tmpdir(), "orq-set-"));
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
  const base = await mkdtemp(join(tmpdir(), "orq-chooks-"));
  await mkdir(join(base, ".codex"), { recursive: true });
  await writeFile(join(base, ".codex", "config.toml"), "model='sys'\n[mcp_servers.foo]\n");
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
});

test("resolveLaunchEnv shares chat history: symlinks projects/ (Claude), merging a non-empty home in", async () => {
  delete process.env.CLAUDE_CONFIG_DIR;
  const base = await mkdtemp(join(tmpdir(), "orq-hist-"));
  await mkdir(join(base, ".claude", "projects", "p1"), { recursive: true });
  await writeFile(join(base, ".claude", "projects", "p1", "sys.jsonl"), "sys");
  const svc = new AgentAccountsService({ indexFile: join(base, "idx.json"), accountsDir: join(base, "agent-accounts"), userhome: base, now: () => 1 });
  await svc.init();
  const acct = await svc.importAccount({ content: JSON.stringify({ claudeAiOauth: { accessToken: "t" } }), label: "L" });
  const home = svc.homePath("claude", acct.id);
  await mkdir(join(home, "projects", "p2"), { recursive: true }); // account's own local conversation
  await writeFile(join(home, "projects", "p2", "acct.jsonl"), "acct");
  await svc.resolveLaunchEnv("claude", acct.id);
  assert.equal((await lstat(join(home, "projects"))).isSymbolicLink(), true);
  assert.equal(await readFile(join(base, ".claude", "projects", "p2", "acct.jsonl"), "utf8"), "acct"); // merged into shared store
  assert.equal(await readFile(join(home, "projects", "p1", "sys.jsonl"), "utf8"), "sys"); // system history now visible via the link
});

test("resolveLaunchEnv symlinks an empty/absent Codex sessions/ to the shared store", async () => {
  delete process.env.CODEX_HOME;
  const base = await mkdtemp(join(tmpdir(), "orq-hist2-"));
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
  const base = await mkdtemp(join(tmpdir(), "orq-histc-"));
  await mkdir(join(base, ".claude", "projects", "P"), { recursive: true }); // system project P
  await writeFile(join(base, ".claude", "projects", "P", "s1.jsonl"), "sys");
  const svc = new AgentAccountsService({ indexFile: join(base, "idx.json"), accountsDir: join(base, "agent-accounts"), userhome: base, now: () => 1 });
  await svc.init();
  const acct = await svc.importAccount({ content: JSON.stringify({ claudeAiOauth: { accessToken: "t" } }), label: "L" });
  const home = svc.homePath("claude", acct.id);
  await mkdir(join(home, "projects", "P"), { recursive: true }); // SAME project name (collides)
  await writeFile(join(home, "projects", "P", "s2.jsonl"), "acct"); // but a different session file
  await svc.resolveLaunchEnv("claude", acct.id);
  assert.equal((await lstat(join(home, "projects"))).isSymbolicLink(), true); // merged fully → symlinked
  assert.equal(await readFile(join(base, ".claude", "projects", "P", "s1.jsonl"), "utf8"), "sys"); // system's kept
  assert.equal(await readFile(join(base, ".claude", "projects", "P", "s2.jsonl"), "utf8"), "acct"); // account's merged in
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

// ---------------------------------------------------------------------------
// Agent profile §5: the owner's instructions, commands, rules and skills are
// shared into every managed account home.
// ---------------------------------------------------------------------------

async function linkingFixture(agent: "claude" | "codex" | "grok") {
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
  delete process.env.GROK_HOME;
  const base = await mkdtemp(join(tmpdir(), `orq-link-${agent}-`));
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
  const base = await mkdtemp(join(tmpdir(), "orq-link-nohome-"));
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

test("Claude: overlapping launches of one account never drop the owner's shared commands", async () => {
  for (let lag = 0; lag < 40; lag += 1) {
    const f = await linkingFixture("claude");
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
  assert.equal(await readlink(join(f.system, "CLAUDE.md")), join(f.base, "not-yet.md"), "the owner's link is kept");
  assert.equal(await readFile(join(f.home, "CLAUDE.md"), "utf8"), "account", "the account's copy is left in place");
});
