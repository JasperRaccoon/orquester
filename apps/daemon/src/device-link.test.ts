import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceLinkStatus } from "@orquester/api";
import { AgentAccountsService } from "./agent-accounts.ts";
import { DeviceLinkService } from "./device-link.ts";
import { grokAuthJsonFromDeviceTokens, httpGrokDeviceAuth } from "./grok-device-auth.ts";
import { codexAuthJsonFromDeviceTokens, httpCodexDeviceAuth } from "./codex-device-auth.ts";

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.`;
}

async function accountsFixture(t: TestContext, prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const accountsDir = join(dir, "accounts");
  const accounts = new AgentAccountsService({
    indexFile: join(dir, "accounts.json"), accountsDir, userhome: dir, now: () => Date.now()
  });
  await accounts.init();
  return { accounts, accountsDir };
}

async function setup(t: TestContext, opts: { startStatus?: number; pollStatus?: number; pollBody?: unknown } = {}) {
  const { accounts, accountsDir } = await accountsFixture(t, "orq-grok-link-");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-09-28T12:00:00Z") });
  let starts = 0;
  let tokenRequests = 0;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
    if (String(url) === "https://auth.x.ai/oauth2/device/code") {
      starts += 1;
      return Response.json({
        verification_uri_complete: "https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH",
        user_code: starts === 1 ? "ABCD-EFGH" : "SECOND-CODE",
        device_code: `device-${starts}`, interval: 5, expires_in: 1800
      }, { status: opts.startStatus ?? 200 });
    }
    assert.equal(String(url), "https://auth.x.ai/oauth2/token");
    tokenRequests += 1;
    return Response.json(opts.pollBody ?? {
      access_token: "at-dev", refresh_token: "rt-dev", expires_in: 21600
    }, { status: opts.pollStatus ?? 200 });
  });
  const service = new DeviceLinkService({
    name: "Grok",
    auth: httpGrokDeviceAuth,
    credential: (tokens) => grokAuthJsonFromDeviceTokens(tokens),
    importAccount: (content) => accounts.importAccount({ content })
  });
  t.after(() => { service.cancel(); });
  return { service, accounts, accountsDir, tokenRequests: () => tokenRequests };
}

async function pollToCompletion(t: TestContext, service: DeviceLinkService<unknown, unknown>): Promise<void> {
  const completed = new Promise<void>((resolve) => {
    const changed = (status: DeviceLinkStatus) => {
      if (status.state !== "idle") return;
      service.events.off("changed", changed);
      resolve();
    };
    service.events.on("changed", changed);
  });
  t.mock.timers.tick(5_000);
  await completed;
}

test("a granted link imports the tokens as a managed grok account", async (t) => {
  const h = await setup(t);
  const started = await h.service.start();
  assert.deepEqual(started, { ok: true, link: {
    url: "https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH",
    userCode: "ABCD-EFGH", expiresAt: "2026-09-28T12:30:00.000Z"
  } });
  assert.equal(h.service.status().state, "linking");
  await pollToCompletion(t, h.service);
  const [account] = h.accounts.list().accounts;
  assert.equal(account?.agent, "grok");
  const native = JSON.parse(await readFile(join(h.accounts.homePath("grok", account.id), "auth.json"), "utf8"));
  const entry = native["https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828"];
  assert.equal(entry.key, "at-dev");
  assert.equal(entry.refresh_token, "rt-dev");
  assert.deepEqual(h.service.status(), { state: "idle", link: null, lastError: null });
});

test("a start failure is an upstream result carrying the status, and leaves nothing pending", async (t) => {
  const h = await setup(t, { startStatus: 500 });
  const res = await h.service.start();
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.code, "upstream");
  assert.equal(res.ok === false ? res.status : undefined, 500);
  assert.equal(h.service.status().state, "idle");
});

test("a second start while one is pending is a conflict; cancel drops it locally", async (t) => {
  const h = await setup(t);
  assert.equal((await h.service.start()).ok, true);
  const duplicate = await h.service.start();
  assert.equal(duplicate.ok === false && duplicate.code, "conflict");
  assert.equal(h.service.status().link?.userCode, "ABCD-EFGH");
  assert.equal(h.service.cancel().state, "idle");
  assert.equal(h.service.cancel().state, "idle");
  t.mock.timers.tick(5_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(h.tokenRequests(), 0, "cancelled authorization never reaches the token endpoint");
  assert.deepEqual(h.accounts.list().accounts, []);
});

test("a failed verdict lands on lastError and a fresh attempt clears it", async (t) => {
  const h = await setup(t, { pollStatus: 400, pollBody: { error: "access_denied", error_description: "authorization denied" } });
  assert.equal((await h.service.start()).ok, true);
  await pollToCompletion(t, h.service);
  assert.equal(h.service.status().lastError, "authorization denied");
  assert.equal((await h.service.start()).ok, true);
  assert.equal(h.service.status().lastError, null);
});

test("a failed import is reported as the link's error", async (t) => {
  const h = await setup(t);
  await rm(h.accountsDir, { recursive: true });
  await writeFile(h.accountsDir, "a file obstructs account persistence");
  t.mock.method(console, "error", () => undefined);
  assert.equal((await h.service.start()).ok, true);
  await pollToCompletion(t, h.service);
  assert.match(h.service.status().lastError ?? "", /\b(?:ENOTDIR|EEXIST)\b/, "the granted link failed specifically while creating its account home");
  assert.deepEqual(h.accounts.list().accounts, []);
});

async function setupCodex(t: TestContext, opts: { pendingPolls?: number; pollStatus?: number; tokenStatus?: number } = {}) {
  const { accounts } = await accountsFixture(t, "orq-codex-link-");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-10-18T12:00:00Z") });
  const requests: { url: string; body: string; contentType: string | null }[] = [];
  let polls = 0;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    requests.push({ url: String(url), body: String(init?.body ?? ""), contentType: headers.get("content-type") });
    switch (String(url)) {
      case "https://auth.openai.com/api/accounts/deviceauth/usercode":
        return Response.json({
          device_auth_id: "dev-auth-1", user_code: "WXYZ-1234", interval: "5",
          expires_at: "2026-10-18T12:15:00.000000+00:00"
        });
      case "https://auth.openai.com/api/accounts/deviceauth/token":
        polls += 1;
        if (polls <= (opts.pendingPolls ?? 0)) return Response.json({ error: "pending" }, { status: 403 });
        return Response.json(
          { authorization_code: "auth-code", code_challenge: "challenge", code_verifier: "verifier" },
          { status: opts.pollStatus ?? 200 }
        );
      case "https://auth.openai.com/oauth/token":
        return Response.json({
          id_token: jwt({ email: "codex@example.com", "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } }),
          access_token: "codex-at", refresh_token: "codex-rt"
        }, { status: opts.tokenStatus ?? 200 });
      default:
        throw new Error(`unexpected fetch ${String(url)}`);
    }
  });
  const service = new DeviceLinkService({
    name: "Codex",
    auth: httpCodexDeviceAuth,
    credential: (tokens) => codexAuthJsonFromDeviceTokens(tokens, Date.now()),
    importAccount: (content) => accounts.importAccount({ content })
  });
  t.after(() => { service.cancel(); });
  return { service, accounts, requests, polls: () => polls };
}

test("a Codex link polls past pending, exchanges the code, and imports a codex auth.json", async (t) => {
  const h = await setupCodex(t, { pendingPolls: 1 });
  const started = await h.service.start();
  assert.deepEqual(started, { ok: true, link: {
    url: "https://auth.openai.com/codex/device", userCode: "WXYZ-1234", expiresAt: "2026-10-18T12:15:00.000Z"
  } });
  assert.deepEqual(JSON.parse(h.requests[0].body), { client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });

  t.mock.timers.tick(5_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(h.polls(), 1);
  assert.equal(h.service.status().state, "linking", "403 is still pending");
  await pollToCompletion(t, h.service);

  const poll = h.requests.find((r) => r.url.endsWith("/deviceauth/token"));
  assert.deepEqual(JSON.parse(poll!.body), { device_auth_id: "dev-auth-1", user_code: "WXYZ-1234" });
  const exchange = h.requests.find((r) => r.url === "https://auth.openai.com/oauth/token");
  assert.equal(exchange?.contentType, "application/x-www-form-urlencoded");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(exchange!.body)), {
    grant_type: "authorization_code",
    code: "auth-code",
    redirect_uri: "https://auth.openai.com/deviceauth/callback",
    client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    code_verifier: "verifier"
  });

  const [account] = h.accounts.list().accounts;
  assert.equal(account?.agent, "codex");
  assert.equal(account?.email, "codex@example.com");
  const native = JSON.parse(await readFile(join(h.accounts.homePath("codex", account.id), "auth.json"), "utf8"));
  assert.equal(native.auth_mode, "chatgpt");
  assert.equal(native.OPENAI_API_KEY, null);
  assert.equal(native.tokens.access_token, "codex-at");
  assert.equal(native.tokens.refresh_token, "codex-rt");
  assert.equal(native.tokens.account_id, "acct-1");
  assert.equal(native.last_refresh, "2026-10-18T12:00:10.000Z");
  assert.deepEqual(h.service.status(), { state: "idle", link: null, lastError: null });
});

test("a Codex link whose code exchange fails ends with that error and imports nothing", async (t) => {
  const h = await setupCodex(t, { tokenStatus: 400 });
  assert.equal((await h.service.start()).ok, true);
  await pollToCompletion(t, h.service);
  assert.match(h.service.status().lastError ?? "", /OpenAI token exchange failed/);
  assert.deepEqual(h.accounts.list().accounts, []);
});

test("a Codex poll error other than pending is the link's verdict", async (t) => {
  const h = await setupCodex(t, { pollStatus: 500 });
  assert.equal((await h.service.start()).ok, true);
  await pollToCompletion(t, h.service);
  assert.match(h.service.status().lastError ?? "", /OpenAI device authorization failed/);
});
