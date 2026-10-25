/**
 * The token broker's rules (spec 2026-10-19 boxes §7): only access tokens leave, box sessions
 * never count as refreshers, concurrent requests share one refresh, a host-local holder's CLI
 * re-reads the file (the daemon refreshes above the floor, or with no usable token left; a Claude
 * CLI holding its refresh lock is waited for), invalid_grant reaches the box.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentAccountError } from "../../agent-account-paths.ts";
import type { AccountRefreshOutcome } from "../../agent-accounts.ts";
import {
  AgentTokenError,
  COOLDOWN_MIN_LIFE_MS,
  createAgentTokenBroker,
  DEFAULT_MIN_VALID_SECONDS,
  HELD_REFRESH_FLOOR_MS,
  MAX_REJECTED_TOKEN_LENGTH,
  REFRESH_COOLDOWN_MS
} from "./broker.ts";
import { brokerWorld, claudeCreds, codexAuth, grokAuth, homeOf, MIN, NOW, settle, storedBox, type BrokerWorld } from "./testing.ts";

const CLAUDE_ID = "11111111-1111-4111-8111-111111111111";
const CODEX_ID = "22222222-2222-4222-8222-222222222222";
const GROK_ID = "33333333-3333-4333-8333-333333333333";
const claudePath = `${homeOf("claude", CLAUDE_ID)}/.credentials.json`;
const codexPath = `${homeOf("codex", CODEX_ID)}/auth.json`;
const grokPath = `${homeOf("grok", GROK_ID)}/auth.json`;

function world(): BrokerWorld {
  const w = brokerWorld();
  w.accounts.set(CLAUDE_ID, { id: CLAUDE_ID, agent: "claude" });
  w.accounts.set(CODEX_ID, { id: CODEX_ID, agent: "codex" });
  w.accounts.set(GROK_ID, { id: GROK_ID, agent: "grok" });
  // One chat per account in the box's project.
  w.sessions.push(
    { id: "chat-claude", projectPath: "/ws/w/p", accountId: CLAUDE_ID },
    { id: "chat-codex", projectPath: "/ws/w/p", accountId: CODEX_ID },
    { id: "chat-grok", projectPath: "/ws/w/p/sub", accountId: GROK_ID }
  );
  return w;
}

const signal = () => new AbortController().signal;

async function rejectsWith(promise: Promise<unknown>, code: string, status?: number): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AgentTokenError, `expected AgentTokenError, got ${String(error)}`);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  });
}

test("a fresh token is handed out as is, with only the access token and non-secret facts", async () => {
  const w = world();
  w.files.write(claudePath, claudeCreds("claude-access-A", NOW + 5 * 60 * MIN));
  w.files.write(codexPath, codexAuth(Math.floor((NOW + 10 * 24 * 60 * MIN) / 1000)));
  w.files.write(grokPath, grokAuth("grok-access-A", NOW + 3 * 60 * MIN));
  const broker = createAgentTokenBroker(w.deps);

  const claude = await broker.getToken({ boxId: "box-1", agent: "claude", accountId: CLAUDE_ID }, signal());
  assert.deepEqual(claude, {
    accessToken: "claude-access-A",
    expiresAt: NOW + 5 * 60 * MIN,
    extra: { subscriptionType: "max", rateLimitTier: "default_claude_max_20x", scopes: "user:inference user:profile user:sessions:claude_code" }
  });
  const codex = await broker.getToken({ boxId: "box-1", agent: "codex", accountId: CODEX_ID }, signal());
  assert.deepEqual(Object.keys(codex).sort(), ["accessToken", "expiresAt", "extra"]);
  assert.deepEqual(codex.extra, { chatgptAccountId: "ws-1" }, "tokens.account_id wins over the claim");
  const grok = await broker.getToken({ boxId: "box-1", agent: "grok", accountId: GROK_ID }, signal());
  assert.deepEqual(grok, { accessToken: "grok-access-A", expiresAt: NOW + 3 * 60 * MIN });

  for (const grant of [claude, codex, grok]) {
    assert.doesNotMatch(JSON.stringify(grant), /SECRET/, "no refresh token, id token or MCP secret in a grant");
  }
  assert.equal(w.refreshCalls.length, 0);
  assert.equal(w.files.watcherCount(claudePath), 0, "the watch ends with the request");
});

test("no refresh token ever leaves the broker, before or after a refresh", async () => {
  const w = world();
  w.files.write(claudePath, claudeCreds("claude-access-OLD", NOW + 20 * MIN));
  w.files.write(codexPath, codexAuth(Math.floor((NOW + 20 * MIN) / 1000)));
  w.files.write(grokPath, grokAuth("grok-access-OLD", NOW + 20 * MIN));
  const broker = createAgentTokenBroker(w.deps);
  const grants = [
    await broker.getToken({ boxId: "box-1", agent: "claude", accountId: CLAUDE_ID }, signal()),
    await broker.getToken({ boxId: "box-1", agent: "codex", accountId: CODEX_ID }, signal()),
    await broker.getToken({ boxId: "box-1", agent: "grok", accountId: GROK_ID }, signal())
  ];
  assert.equal(w.refreshCalls.length, 3, "each short token was refreshed");
  assert.equal(grants[0].accessToken, "claude-access-NEW");
  assert.equal(grants[2].accessToken, "grok-access-NEW");
  for (const grant of grants) {
    const text = JSON.stringify(grant);
    assert.doesNotMatch(text, /SECRET/);
    assert.doesNotMatch(text, /refresh|id_token|idToken/i);
  }
});

test("a token below minValidSeconds is refreshed when no host-local session holds the account", async () => {
  const w = world();
  w.files.write(claudePath, claudeCreds("claude-access-OLD", NOW + (DEFAULT_MIN_VALID_SECONDS * 1000 - MIN)));
  const broker = createAgentTokenBroker(w.deps);
  const grant = await broker.getToken({ boxId: "box-1", agent: "claude", accountId: CLAUDE_ID }, signal());
  assert.equal(grant.accessToken, "claude-access-NEW");
  assert.deepEqual(w.refreshCalls, [{ agent: "claude", id: CLAUDE_ID, allowHeld: false }]);

  // A caller asking for less life does not trigger one.
  w.files.write(claudePath, claudeCreds("claude-access-SHORT", NOW + 20 * MIN));
  const short = await broker.getToken({ boxId: "box-1", agent: "claude", accountId: CLAUDE_ID, minValidSeconds: 10 * 60 }, signal());
  assert.equal(short.accessToken, "claude-access-SHORT");
  assert.equal(w.refreshCalls.length, 1);
});

test("box sessions are not refreshers: an account only box chats use is refreshed on demand", async () => {
  const w = world();
  // Every session using the account is in the box project, so the router's host-local set is empty
  // (`hostLocalAccountIds`, proved in refresh-scheduling.test.ts) even though the account is in use.
  assert.equal(w.hostLocal.has(CODEX_ID), false);
  w.files.write(codexPath, codexAuth(Math.floor((NOW + 5 * MIN) / 1000)));
  const broker = createAgentTokenBroker(w.deps);
  const grant = await broker.getToken({ boxId: "box-1", agent: "codex", accountId: CODEX_ID }, signal());
  assert.equal(w.refreshCalls.length, 1);
  assert.equal(grant.extra?.chatgptAccountId, "ws-1");
});

test("concurrent requests for one account share one refresh", async () => {
  const w = world();
  w.files.write(grokPath, grokAuth("grok-access-OLD", NOW + MIN));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const original = w.refreshImpl;
  w.refreshImpl = async (agent, id) => {
    await gate;
    return original(agent, id);
  };
  const broker = createAgentTokenBroker(w.deps);
  const requests = [1, 2, 3].map(() => broker.getToken({ boxId: "box-1", agent: "grok", accountId: GROK_ID }, signal()));
  await settle(() => w.refreshCalls.length > 0);
  release();
  const grants = await Promise.all(requests);
  assert.equal(w.refreshCalls.length, 1, "one refresh for three requests");
  assert.deepEqual(new Set(grants.map((g) => g.accessToken)), new Set(["grok-access-NEW"]));
});

const claudeLock = `${homeOf("claude", CLAUDE_ID)}/.oauth_refresh.lock`;

test("a host-local Codex or Grok holder: refreshed above the floor; below it a usable token goes out, and with none the daemon refreshes", async () => {
  for (const [agent, accountId, path, write] of [
    ["codex", CODEX_ID, codexPath, (at: number, label: string) => codexAuth(Math.floor(at / 1000), label)],
    ["grok", GROK_ID, grokPath, (at: number, label: string) => grokAuth(`grok-access-${label}`, at)]
  ] as const) {
    const w = world();
    w.hostLocal.add(accountId);
    const broker = createAgentTokenBroker(w.deps);
    const ask = () => broker.getToken({ boxId: "box-1", agent, accountId }, signal());

    // 37 min left: short of minValidSeconds, far outside the CLI's own 5-minute window, and the CLI
    // re-reads its file before spending its own refresh token.
    w.files.write(path, write(NOW + 37 * MIN, "old"));
    assert.equal((await ask()).expiresAt, NOW + 8 * 60 * MIN, agent);
    assert.deepEqual(w.refreshCalls, [{ agent, id: accountId, allowHeld: true }]);

    // Below the floor, still good for 8 minutes: handed out as is — the CLI may be renewing.
    w.refreshCalls.length = 0;
    w.files.write(path, write(NOW + 8 * MIN, "left"));
    assert.equal((await ask()).expiresAt, NOW + 8 * MIN, agent);
    assert.equal(w.refreshCalls.length, 0);

    // Nearly spent, or already expired: the box fails without a renewal, so the daemon renews it.
    for (const at of [NOW + 4 * MIN, NOW - 60 * MIN]) {
      w.refreshCalls.length = 0;
      w.files.write(path, write(at, "spent"));
      assert.equal((await ask()).expiresAt, NOW + 8 * 60 * MIN, agent);
      assert.deepEqual(w.refreshCalls, [{ agent, id: accountId, allowHeld: true }]);
    }
  }
});

test("a host-local Claude holder: refreshed above the floor or with nothing usable left, never while its CLI holds the refresh lock", async () => {
  const w = world();
  w.hostLocal.add(CLAUDE_ID);
  const broker = createAgentTokenBroker(w.deps);
  const ask = () => broker.getToken({ boxId: "box-1", agent: "claude", accountId: CLAUDE_ID }, signal());

  // 30 min left: the CLI cannot be refreshing (it does inside the last 5) and it adopts the file.
  w.files.write(claudePath, claudeCreds("claude-access-OLD", NOW + 30 * MIN));
  assert.equal((await ask()).accessToken, "claude-access-NEW");
  assert.deepEqual(w.refreshCalls, [{ agent: "claude", id: CLAUDE_ID, allowHeld: true }]);

  // Below the floor: no refresh — the token, still good for 9 minutes, is handed out as is.
  w.refreshCalls.length = 0;
  w.files.write(claudePath, claudeCreds("claude-access-OLD", NOW + HELD_REFRESH_FLOOR_MS - MIN));
  assert.equal((await ask()).accessToken, "claude-access-OLD");
  assert.equal(w.refreshCalls.length, 0);

  // Below the floor and nearly spent: refreshed.
  w.files.write(claudePath, claudeCreds("claude-access-OLD", NOW + COOLDOWN_MIN_LIFE_MS - MIN));
  assert.equal((await ask()).accessToken, "claude-access-NEW");
  assert.deepEqual(w.refreshCalls, [{ agent: "claude", id: CLAUDE_ID, allowHeld: true }]);

  // The CLI holds its refresh lock (fresh mtime): no refresh. A usable token goes out...
  w.refreshCalls.length = 0;
  w.files.lockAges.set(claudeLock, 2_000);
  w.files.write(claudePath, claudeCreds("claude-access-OLD", NOW + 30 * MIN));
  assert.equal((await ask()).accessToken, "claude-access-OLD");
  // ...and with none the request waits for the CLI's rewrite.
  w.files.write(claudePath, claudeCreds("claude-access-OLD", NOW + COOLDOWN_MIN_LIFE_MS - MIN));
  let settled = false;
  const locked = ask().finally(() => (settled = true));
  await settle(() => w.files.watcherCount(claudePath) === 1);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(settled, false, "still waiting");
  // An unrelated rewrite (still short) does not end the wait.
  w.files.write(claudePath, claudeCreds("claude-access-OLD2", NOW + COOLDOWN_MIN_LIFE_MS - 2 * MIN));
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(settled, false);
  w.files.write(claudePath, claudeCreds("claude-access-CLI", NOW + 8 * 60 * MIN, "claude-refresh-CLI-SECRET"));
  assert.equal((await locked).accessToken, "claude-access-CLI");
  assert.equal(w.refreshCalls.length, 0, "the daemon spent nothing");
  assert.equal(w.files.watcherCount(claudePath), 0);

  // A stale lock (a crashed CLI) does not block.
  w.files.lockAges.set(claudeLock, 5 * MIN);
  w.files.write(claudePath, claudeCreds("claude-access-OLD", NOW + 30 * MIN));
  assert.equal((await ask()).accessToken, "claude-access-NEW");
});

test("a waiting request whose holder's session ends: the daemon refreshes then", async () => {
  const w = world();
  w.hostLocal.add(CLAUDE_ID);
  w.files.lockAges.set(claudeLock, 2_000);
  w.files.write(claudePath, claudeCreds("claude-access-OLD", NOW + 2 * MIN));
  const broker = createAgentTokenBroker(w.deps);
  const pending = broker.getToken({ boxId: "box-1", agent: "claude", accountId: CLAUDE_ID }, signal());
  await settle(() => w.files.watcherCount(claudePath) === 1);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(w.refreshCalls.length, 0);

  w.hostLocal.delete(CLAUDE_ID);
  w.sessionsChanged();
  assert.equal((await pending).accessToken, "claude-access-NEW");
  assert.deepEqual(w.refreshCalls, [{ agent: "claude", id: CLAUDE_ID, allowHeld: false }]);
});

test("a wait ends with TOKEN_WAIT_TIMEOUT when the request's signal aborts", async () => {
  const w = world();
  w.hostLocal.add(CLAUDE_ID);
  w.files.lockAges.set(claudeLock, 2_000);
  w.files.write(claudePath, claudeCreds("claude-access-OLD", NOW + MIN));
  const broker = createAgentTokenBroker(w.deps);
  const controller = new AbortController();
  const pending = broker.getToken({ boxId: "box-1", agent: "claude", accountId: CLAUDE_ID }, controller.signal);
  await settle(() => w.files.watcherCount(claudePath) === 1);
  controller.abort();
  await rejectsWith(pending, "TOKEN_WAIT_TIMEOUT", 504);
  assert.equal(w.files.watcherCount(claudePath), 0);
  assert.equal(w.refreshCalls.length, 0);
});

test("invalid_grant reaches the box as TOKEN_NEEDS_REAUTH; other refresh failures as TOKEN_UNAVAILABLE", async () => {
  const w = world();
  w.files.write(claudePath, claudeCreds("claude-access-OLD", NOW - MIN));
  const outcomes: AccountRefreshOutcome[] = ["invalid-grant", "failed", "unavailable"];
  const broker = createAgentTokenBroker(w.deps);
  for (const [i, outcome] of outcomes.entries()) {
    w.refreshImpl = async () => outcome;
    await rejectsWith(
      broker.getToken({ boxId: "box-1", agent: "claude", accountId: CLAUDE_ID }, signal()),
      i === 0 ? "TOKEN_NEEDS_REAUTH" : "TOKEN_UNAVAILABLE",
      i === 0 ? 409 : 503
    );
  }
});

test("no renewal possible (no refresh token, service unreachable): a still-usable token is handed out, never a rejected or nearly spent one", async () => {
  const w = world();
  const broker = createAgentTokenBroker(w.deps);
  for (const outcome of ["unavailable", "failed"] as const) {
    w.refreshImpl = async () => outcome;
    // Below minValidSeconds but with 20 min left: the box gets it.
    w.files.write(grokPath, grokAuth("grok-access-LEFT", NOW + 20 * MIN));
    const grant = await broker.getToken({ boxId: "box-1", agent: "grok", accountId: GROK_ID }, signal());
    assert.equal(grant.accessToken, "grok-access-LEFT", outcome);
    // The provider refused it already: never handed out again.
    await rejectsWith(
      broker.getToken({ boxId: "box-1", agent: "grok", accountId: GROK_ID, rejectedAccessToken: "grok-access-LEFT" }, signal()),
      "TOKEN_UNAVAILABLE",
      503
    );
    // Too little life left to be worth handing out.
    w.files.write(grokPath, grokAuth("grok-access-SPENT", NOW + COOLDOWN_MIN_LIFE_MS - MIN));
    await rejectsWith(broker.getToken({ boxId: "box-1", agent: "grok", accountId: GROK_ID }, signal()), "TOKEN_UNAVAILABLE", 503);
  }
});

test("a refresh that finds the account newly held waits for that CLI instead of spinning", async () => {
  const w = world();
  w.files.write(codexPath, codexAuth(Math.floor((NOW + MIN) / 1000)));
  w.refreshImpl = async () => {
    w.hostLocal.add(CODEX_ID); // a host chat started in the sub-second window
    return "held";
  };
  const broker = createAgentTokenBroker(w.deps);
  const pending = broker.getToken({ boxId: "box-1", agent: "codex", accountId: CODEX_ID }, signal());
  await settle(() => w.refreshCalls.length === 1);
  for (let i = 0; i < 40; i++) await Promise.resolve();
  assert.equal(w.refreshCalls.length, 1, "no retry loop");
  const fresh = Math.floor((NOW + 9 * 24 * 60 * MIN) / 1000);
  w.files.write(codexPath, codexAuth(fresh));
  assert.equal((await pending).expiresAt, fresh * 1000);
});

test("authorization: managed accounts the box's own launches use, live boxes only", async () => {
  const w = world();
  w.files.write(claudePath, claudeCreds("claude-access-A", NOW + 5 * 60 * MIN));
  const broker = createAgentTokenBroker(w.deps);
  const ask = (overrides: Record<string, unknown>) =>
    broker.getToken({ boxId: "box-1", agent: "claude", accountId: CLAUDE_ID, ...overrides } as never, signal());

  await rejectsWith(ask({ accountId: "system" }), "TOKEN_FORBIDDEN", 403);
  await rejectsWith(ask({ boxId: "box-unknown" }), "TOKEN_FORBIDDEN", 403);
  await rejectsWith(ask({ accountId: "44444444-4444-4444-8444-444444444444" }), "TOKEN_ACCOUNT_NOT_FOUND", 404);
  await rejectsWith(ask({ agent: "codex" }), "TOKEN_FORBIDDEN", 403);
  await rejectsWith(ask({ agent: "opencode" }), "TOKEN_INVALID_REQUEST", 400);
  await rejectsWith(ask({ minValidSeconds: -1 }), "TOKEN_INVALID_REQUEST", 400);

  // A host chat using the account is not this box's launch.
  w.sessions.splice(0, w.sessions.length, { id: "chat-host", projectPath: "/ws/w/other", accountId: CLAUDE_ID });
  await rejectsWith(ask({}), "TOKEN_FORBIDDEN", 403);

  // A temporary box: its owning chat's account.
  w.boxes.set("tmp-1", storedBox({ id: "tmp-1", purpose: "temporary", project: null, threadId: "chat-host" }));
  assert.equal((await ask({ boxId: "tmp-1" })).accessToken, "claude-access-A");

  // Destroyed boxes get nothing.
  w.boxes.set("tmp-1", storedBox({ id: "tmp-1", purpose: "temporary", project: null, threadId: "chat-host", state: "destroyed" }));
  await rejectsWith(ask({ boxId: "tmp-1" }), "TOKEN_FORBIDDEN", 403);

  // A home that fails assertOwnedAccountHome is never read.
  w.sessions.push({ id: "chat-box", projectPath: "/ws/w/p", accountId: CLAUDE_ID });
  w.files.ownedHomeError = new AgentAccountError("Account home is a symlink: claude/x");
  await rejectsWith(ask({}), "TOKEN_UNAVAILABLE", 503);
});

test("a rejected access token that is still current is renewed, not handed out again", async () => {
  const w = world();
  // Days of life left, but the provider refused it (Codex's refresh request after a 401).
  w.files.write(codexPath, codexAuth(Math.floor((NOW + 10 * 24 * 60 * MIN) / 1000), "refused"));
  const broker = createAgentTokenBroker(w.deps);
  const current = await broker.getToken({ boxId: "box-1", agent: "codex", accountId: CODEX_ID }, signal());
  assert.equal(w.refreshCalls.length, 0, "a long-lived token is handed out as is");

  const renewed = await broker.getToken(
    { boxId: "box-1", agent: "codex", accountId: CODEX_ID, rejectedAccessToken: current.accessToken },
    signal()
  );
  assert.notEqual(renewed.accessToken, current.accessToken);
  assert.deepEqual(w.refreshCalls, [{ agent: "codex", id: CODEX_ID, allowHeld: false }]);

  // A rejected token that is no longer current (another request renewed it meanwhile): the current one, no refresh.
  const again = await broker.getToken(
    { boxId: "box-1", agent: "codex", accountId: CODEX_ID, rejectedAccessToken: current.accessToken },
    signal()
  );
  assert.equal(again.accessToken, renewed.accessToken);
  assert.equal(w.refreshCalls.length, 1);
});

test("the refresh cooldown: right after a refresh, asking for more life or rejecting the new token does not refresh again", async () => {
  const w = world();
  // A provider whose tokens live one hour: a 60-minute minValidSeconds can never be met.
  w.refreshImpl = async (_agent, id) => {
    w.files.write(`${homeOf("claude", id)}/.credentials.json`, claudeCreds(`claude-access-${w.refreshCalls.length}`, w.clock.now + 60 * MIN));
    return "refreshed";
  };
  w.files.write(claudePath, claudeCreds("claude-access-OLD", NOW + 20 * MIN));
  const broker = createAgentTokenBroker(w.deps);
  const ask = (extra: Record<string, unknown> = {}) =>
    broker.getToken({ boxId: "box-1", agent: "claude", accountId: CLAUDE_ID, minValidSeconds: 60 * 60, ...extra }, signal());

  const first = await ask();
  assert.equal(first.accessToken, "claude-access-1");
  assert.equal(w.refreshCalls.length, 1);
  // 59.9 minutes left < the asked 60: without the cooldown, every call would refresh.
  w.clock.now += 6_000;
  for (let i = 0; i < 5; i++) assert.equal((await ask()).accessToken, "claude-access-1");
  assert.equal((await ask({ rejectedAccessToken: "claude-access-1" })).accessToken, "claude-access-1");
  assert.equal(w.refreshCalls.length, 1, "one refresh, however often the box asks");

  // Past the cooldown, a short token is renewed again.
  w.clock.now = NOW + REFRESH_COOLDOWN_MS;
  assert.equal((await ask()).accessToken, "claude-access-2");
  assert.equal(w.refreshCalls.length, 2);

  // Inside the cooldown but with under 5 minutes left: renewed, the cooldown never hands out a dying token.
  w.refreshImpl = async (_agent, id) => {
    w.files.write(`${homeOf("claude", id)}/.credentials.json`, claudeCreds("claude-access-SHORT", w.clock.now + 4 * MIN));
    return "refreshed";
  };
  w.clock.now += COOLDOWN_MIN_LIFE_MS * 12;
  assert.equal((await ask()).accessToken, "claude-access-SHORT");
  assert.equal(w.refreshCalls.length, 3);
  w.refreshImpl = async (_agent, id) => {
    w.files.write(`${homeOf("claude", id)}/.credentials.json`, claudeCreds("claude-access-LONG", w.clock.now + 60 * MIN));
    return "refreshed";
  };
  w.clock.now += MIN;
  assert.equal((await ask()).accessToken, "claude-access-LONG");
  assert.equal(w.refreshCalls.length, 4);
});

test("concurrent requests rejecting the same token share one refresh", async () => {
  const w = world();
  w.files.write(grokPath, grokAuth("grok-access-REFUSED", NOW + 3 * 60 * MIN));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const original = w.refreshImpl;
  w.refreshImpl = async (agent, id) => {
    await gate;
    return original(agent, id);
  };
  const broker = createAgentTokenBroker(w.deps);
  const requests = [1, 2, 3].map(() =>
    broker.getToken({ boxId: "box-1", agent: "grok", accountId: GROK_ID, rejectedAccessToken: "grok-access-REFUSED" }, signal())
  );
  await settle(() => w.refreshCalls.length > 0);
  release();
  const grants = await Promise.all(requests);
  assert.equal(w.refreshCalls.length, 1, "one refresh for three requests");
  assert.deepEqual(new Set(grants.map((g) => g.accessToken)), new Set(["grok-access-NEW"]));
});

test("a rejected token of a host-held account is renewed by the daemon, above the floor or below it", async () => {
  const w = world();
  for (const id of [CLAUDE_ID, CODEX_ID, GROK_ID]) w.hostLocal.add(id);
  w.files.write(claudePath, claudeCreds("claude-access-REFUSED", NOW + 5 * 60 * MIN));
  w.files.write(codexPath, codexAuth(Math.floor((NOW + 10 * 24 * 60 * MIN) / 1000), "refused"));
  w.files.write(grokPath, grokAuth("grok-access-REFUSED", NOW + 8 * MIN));
  const broker = createAgentTokenBroker(w.deps);
  const claude = await broker.getToken(
    { boxId: "box-1", agent: "claude", accountId: CLAUDE_ID, rejectedAccessToken: "claude-access-REFUSED" },
    signal()
  );
  assert.equal(claude.accessToken, "claude-access-NEW");
  const refused = await broker.getToken({ boxId: "box-1", agent: "codex", accountId: CODEX_ID }, signal());
  const codex = await broker.getToken(
    { boxId: "box-1", agent: "codex", accountId: CODEX_ID, rejectedAccessToken: refused.accessToken },
    signal()
  );
  assert.notEqual(codex.accessToken, refused.accessToken);
  // Below the floor: a refused token is no usable one.
  const grok = await broker.getToken(
    { boxId: "box-1", agent: "grok", accountId: GROK_ID, rejectedAccessToken: "grok-access-REFUSED" },
    signal()
  );
  assert.equal(grok.accessToken, "grok-access-NEW");
  assert.deepEqual(w.refreshCalls, [
    { agent: "claude", id: CLAUDE_ID, allowHeld: true },
    { agent: "codex", id: CODEX_ID, allowHeld: true },
    { agent: "grok", id: GROK_ID, allowHeld: true }
  ]);
});

test("a rejected token of a held Claude account whose CLI holds the refresh lock: the request waits for that CLI's rewrite", async () => {
  const w = world();
  w.hostLocal.add(CLAUDE_ID);
  w.files.lockAges.set(claudeLock, 2_000);
  w.files.write(claudePath, claudeCreds("claude-access-REFUSED", NOW + 5 * 60 * MIN));
  const broker = createAgentTokenBroker(w.deps);
  let settled = false;
  const pending = broker
    .getToken({ boxId: "box-1", agent: "claude", accountId: CLAUDE_ID, rejectedAccessToken: "claude-access-REFUSED" }, signal())
    .finally(() => (settled = true));
  await settle(() => w.files.watcherCount(claudePath) === 1);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(settled, false, "the refused token is not handed out again");
  assert.equal(w.refreshCalls.length, 0, "the CLI is refreshing");

  w.files.write(claudePath, claudeCreds("claude-access-CLI", NOW + 8 * 60 * MIN));
  assert.equal((await pending).accessToken, "claude-access-CLI");
  assert.equal(w.refreshCalls.length, 0);
});

test("rejectedAccessToken must be a non-empty string of bounded length", async () => {
  const w = world();
  w.files.write(claudePath, claudeCreds("claude-access-A", NOW + 5 * 60 * MIN));
  const broker = createAgentTokenBroker(w.deps);
  for (const rejectedAccessToken of ["", 42, "x".repeat(MAX_REJECTED_TOKEN_LENGTH + 1)]) {
    await rejectsWith(
      broker.getToken({ boxId: "box-1", agent: "claude", accountId: CLAUDE_ID, rejectedAccessToken } as never, signal()),
      "TOKEN_INVALID_REQUEST",
      400
    );
  }
  assert.equal(w.refreshCalls.length, 0);
});
