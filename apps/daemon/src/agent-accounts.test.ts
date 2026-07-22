import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, stat, mkdir, writeFile, lstat } from "node:fs/promises";
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

test("first account for an agent becomes the default", async () => {
  const { svc } = await makeService();
  const acct = await svc.importAccount({ content: JSON.stringify({ tokens: { access_token: "a", id_token: jwt({ email: "e@e.com" }) } }) });
  assert.equal(svc.list().defaults.codex, acct.id);
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

async function makeServiceWithFetch(now: number, fetchImpl: typeof fetch) {
  const base = await mkdtemp(join(tmpdir(), "orq-fresh-"));
  const svc = new AgentAccountsService({
    indexFile: join(base, "agent-accounts.json"),
    accountsDir: join(base, "agent-accounts"),
    userhome: base,
    now: () => now,
    fetchImpl
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

test("ensureFreshForUsage refreshes an idle Codex account whose token is expiring", async () => {
  const now = 1_000_000;
  let called = 0;
  const svc = await makeServiceWithFetch(now, async () => {
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

test("ensureFreshForUsage does not refresh an account with a live session", async () => {
  const now = 1_000_000;
  let called = 0;
  const svc = await makeServiceWithFetch(now, async () => {
    called++;
    return new Response("{}", { status: 200 });
  });
  const acct = await svc.importAccount({ content: codexBlob(Math.floor((now + 60_000) / 1000)) });
  await svc.ensureFreshForUsage("codex", acct.id, new Set([acct.id]));
  assert.equal(called, 0);
});

test("ensureFreshForUsage skips a token that is not near expiry", async () => {
  const now = 1_000_000;
  let called = 0;
  const svc = await makeServiceWithFetch(now, async () => {
    called++;
    return new Response("{}", { status: 200 });
  });
  const acct = await svc.importAccount({ content: codexBlob(Math.floor((now + 60 * 60_000) / 1000)) });
  await svc.ensureFreshForUsage("codex", acct.id, new Set());
  assert.equal(called, 0);
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
