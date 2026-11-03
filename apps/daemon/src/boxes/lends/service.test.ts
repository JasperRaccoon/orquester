/**
 * Lending, through the service with a real broker, a real box store and files on a local "VM": what
 * reaches the VM, that it stays current with nothing asking, and every way a lend ends.
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { parseAgentAccounts } from "@orquester/config";

import { settle } from "../broker/testing.ts";
import { chat, claudeLogin, codexLogin, BOX, HOUR, ID_TOKEN_MARKER, lendWorld, MIN, NOW, REFRESH_MARKER, type LendWorld } from "./testing.ts";

const CLAUDE = "11111111-1111-4111-8111-111111111111";
const CODEX = "22222222-2222-4222-8222-222222222222";

async function world(t: Parameters<typeof lendWorld>[0], box: Parameters<typeof lendWorld>[1] = {}): Promise<LendWorld> {
  const w = await lendWorld(t, box);
  w.addAccount("claude", CLAUDE, "ana@example.com", NOW + 8 * HOUR);
  w.addAccount("codex", CODEX, "bo@example.com", NOW + 240 * HOUR);
  return w;
}

const LEND_CLAUDE = { accounts: [{ agent: "claude", accountId: CLAUDE }], minutes: 240, purposeNote: "paid evals" };
const LEND_BOTH = { ...LEND_CLAUDE, accounts: [...LEND_CLAUDE.accounts, { agent: "codex", accountId: CODEX }] };

const vmToken = async (w: LendWorld): Promise<unknown> => JSON.parse((await w.readVm(w.vmPath("claude", CLAUDE)))!).claudeAiOauth.accessToken;
const lentRow = (w: LendWorld, id = CLAUDE) => w.registry.summary(BOX)?.lentAccounts?.find((lent) => lent.accountId === id);
const storedLends = (w: LendWorld) => w.registry.get(BOX)?.accountLends ?? [];
const indexOnVm = async (w: LendWorld) => parseAgentAccounts(JSON.parse((await w.readVm(w.vmIndexPath))!));

async function allFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}

test("a host renewal mid-run reaches the VM's file with nothing asking", async (t) => {
  const w = await world(t);
  const result = await w.lends.lend(chat("chat-1"), BOX, LEND_CLAUDE);
  assert.equal(result.appdir, w.base);
  assert.equal(await vmToken(w), `${CLAUDE}-access`);
  assert.equal(result.lent[0]?.status, "active");
  assert.equal(result.lent[0]?.tokenExpiresAt, new Date(NOW + 8 * HOUR).toISOString());
  assert.equal(result.lent[0]?.home, join(w.base, "daemon", "agent-accounts", "claude", CLAUDE, "home"));

  const published = w.published.count;
  w.files.write(w.hostPath("claude", CLAUDE), claudeLogin("renewed-by-the-host", NOW + 9 * HOUR));
  await w.lends.settled();

  assert.equal(await vmToken(w), "renewed-by-the-host");
  assert.equal(w.refreshCalls.length, 0, "the host's renewal is adopted, never a second refresh");
  assert.equal(lentRow(w)?.tokenExpiresAt, new Date(NOW + 9 * HOUR).toISOString());
  assert.ok(w.published.count > published, "clients hear of the new token's expiry");
});

test("a token running short is renewed by the timer before it goes stale, with no request from the VM", async (t) => {
  const w = await world(t);
  await w.lends.lend(chat("chat-1"), BOX, { ...LEND_CLAUDE, minutes: 1440 });
  // Stale 30 minutes before the 8 hours are up; the delay is capped at 6 hours, so this takes two looks.
  t.mock.timers.tick(6 * HOUR);
  await w.lends.settled();
  assert.equal(w.refreshCalls.length, 0);
  t.mock.timers.tick(90 * MIN + 1);
  await w.lends.settled();
  assert.deepEqual(w.refreshCalls, [CLAUDE]);
  assert.match(String(await vmToken(w)), /^refreshed-/);
});

test("nothing a VM receives or the store records holds a refresh token or the real id token", async (t) => {
  const w = await world(t);
  await w.lends.lend(chat("chat-1"), BOX, LEND_BOTH);
  // Renewals write the file too.
  w.files.write(w.hostPath("codex", CODEX), codexLogin("renewed", NOW + 240 * HOUR));
  await w.lends.settled();

  const files = await allFiles(w.base);
  assert.ok(files.includes(w.vmPath("claude", CLAUDE)) && files.includes(w.vmPath("codex", CODEX)) && files.includes(w.vmIndexPath));
  for (const file of files) {
    const text = await readFile(file, "utf8");
    assert.ok(!text.includes(REFRESH_MARKER) && !text.includes(ID_TOKEN_MARKER), file);
    const idToken = file === w.vmPath("codex", CODEX) ? (JSON.parse(text).tokens.id_token as string) : "";
    assert.ok(!Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString().includes(ID_TOKEN_MARKER));
  }
  const records = await readFile(files.find((file) => file.endsWith("boxes.json"))!, "utf8");
  assert.ok(!records.includes(`${CLAUDE}-access`), "a record holds names and times, not a token");
  const summary = JSON.stringify(w.registry.summary(BOX));
  assert.ok(!summary.includes(`${CLAUDE}-access`) && !summary.includes(REFRESH_MARKER));
});

test("login and index files are 0600, and the index passes parseAgentAccounts and names only lent accounts", async (t) => {
  const w = await world(t);
  w.addAccount("claude", "33333333-3333-4333-8333-333333333333", "not-lent@example.com", NOW + 8 * HOUR);
  await w.lends.lend(chat("chat-1"), BOX, LEND_BOTH);
  for (const path of [w.vmPath("claude", CLAUDE), w.vmPath("codex", CODEX), w.vmIndexPath]) {
    assert.equal((await stat(path)).mode & 0o777, 0o600, path);
  }
  const index = await indexOnVm(w);
  assert.deepEqual(index.accounts.map((account) => [account.id, account.agent, account.label, account.needsReauth]), [
    [CLAUDE, "claude", "ana@example.com", false],
    [CODEX, "codex", "bo@example.com", false]
  ]);
  assert.deepEqual(index.defaults, { claude: null, codex: null, grok: null });
  assert.ok(!(await w.readVm(w.vmIndexPath))!.includes("not-lent"));
  // The folders are made through the box agent, for its working user.
  assert.ok(w.connection.calls.some((call) => call.method === "agent.ensurePaths" && (call.params as { paths: string[] }).paths.includes(join(w.base, "daemon"))));
});

test("a lent-only account gets no token over token.get, and none from the keeper's route once the lend ended", async (t) => {
  const w = await world(t);
  const { lent } = await w.lends.lend(chat("chat-1"), BOX, LEND_CLAUDE);
  const request = { boxId: BOX, agent: "claude" as const, accountId: CLAUDE };
  await assert.rejects(w.broker.getToken(request, new AbortController().signal), { code: "TOKEN_FORBIDDEN" });
  assert.equal((await w.broker.getLentToken(request, new AbortController().signal)).accessToken, `${CLAUDE}-access`);
  await w.lends.endOne(chat("chat-1"), BOX, lent[0]!.id);
  await assert.rejects(w.broker.getLentToken(request, new AbortController().signal), { code: "TOKEN_FORBIDDEN" });
});

test("ending a lend keeps the login while a chat in the box uses the account, or another lend does", async (t) => {
  const w = await world(t);
  const first = await w.lends.lend(chat("chat-1"), BOX, LEND_CLAUDE);
  const second = await w.lends.lend(chat("chat-2"), BOX, LEND_CLAUDE);
  assert.notEqual(first.lent[0]!.id, second.lent[0]!.id, "each chat has its own");

  await w.lends.endOne(chat("chat-1"), BOX, first.lent[0]!.id);
  assert.notEqual(await w.readVm(w.vmPath("claude", CLAUDE)), null, "the other chat's lend still uses it");
  assert.deepEqual((await indexOnVm(w)).accounts.map((account) => account.id), [CLAUDE]);

  w.sessions.push({ id: "a-chat", projectPath: "/ws/w/p/sub", accountId: CLAUDE });
  await w.lends.endOne(chat("chat-2"), BOX, second.lent[0]!.id);
  assert.notEqual(await w.readVm(w.vmPath("claude", CLAUDE)), null, "a Claude chat reads that very file");
  assert.equal(await w.readVm(w.vmIndexPath), null, "the index goes with the last lend");
  assert.deepEqual(storedLends(w), []);

  w.sessions.length = 0;
  const third = await w.lends.lend(chat("chat-3"), BOX, LEND_CLAUDE);
  await w.lends.endOne(chat("chat-3"), BOX, third.lent[0]!.id);
  assert.equal(await w.readVm(w.vmPath("claude", CLAUDE)), null);
});

test("a refused login stops every attempt until the host's login file changes", async (t) => {
  const w = await world(t);
  w.files.texts.set(w.hostPath("claude", CLAUDE), claudeLogin("short", NOW + 2 * HOUR));
  await w.lends.lend(chat("chat-1"), BOX, LEND_CLAUDE);
  w.refreshImpl = async () => "invalid-grant";

  t.mock.timers.tick(90 * MIN + 1);
  await w.lends.settled();
  assert.deepEqual(w.refreshCalls, [CLAUDE]);
  assert.equal(lentRow(w)?.status, "needs-login");
  assert.equal((await indexOnVm(w)).accounts[0]?.needsReauth, true);
  assert.equal(await vmToken(w), "short", "the VM keeps what it has");

  // Time passing and a rewrite with the same content ask nothing more.
  t.mock.timers.tick(HOUR);
  w.files.write(w.hostPath("claude", CLAUDE), claudeLogin("short", NOW + 2 * HOUR));
  await w.lends.settled();
  assert.equal(w.refreshCalls.length, 1);

  // The owner signed in again.
  w.files.write(w.hostPath("claude", CLAUDE), claudeLogin("signed-in-again", Date.now() + 8 * HOUR));
  await w.lends.settled();
  assert.equal(w.refreshCalls.length, 1);
  assert.equal(lentRow(w)?.status, "active");
  assert.equal(await vmToken(w), "signed-in-again");
  assert.equal((await indexOnVm(w)).accounts[0]?.needsReauth, false);
});

test("a transient failure keeps the VM's token, says so, and retries", async (t) => {
  const w = await world(t);
  w.files.texts.set(w.hostPath("claude", CLAUDE), claudeLogin("short", NOW + 2 * HOUR));
  await w.lends.lend(chat("chat-1"), BOX, LEND_CLAUDE);
  w.refreshImpl = async () => "failed";
  // Past the token's last usable minutes, so the broker has nothing to fall back on.
  t.mock.timers.tick(90 * MIN + 1);
  await w.lends.settled();
  t.mock.timers.setTime(NOW + 2 * HOUR - MIN);
  t.mock.timers.tick(60_000);
  await w.lends.settled();
  assert.equal(lentRow(w)?.status, "renewal-failing");
  assert.equal(await vmToken(w), "short");

  const calls = w.refreshCalls.length;
  w.refreshImpl = async (agent, id) => {
    w.files.write(w.hostPath(agent as "claude", id), claudeLogin("back", Date.now() + 8 * HOUR));
    return "refreshed";
  };
  t.mock.timers.tick(60_000);
  await w.lends.settled();
  assert.ok(w.refreshCalls.length > calls);
  assert.equal(lentRow(w)?.status, "active");
  assert.equal(await vmToken(w), "back");
});

test("an offline VM is not asked for anything; on reconnect its file is always rewritten, then the timer re-armed", async (t) => {
  const w = await world(t);
  await w.lends.lend(chat("chat-1"), BOX, { ...LEND_CLAUDE, minutes: 1440 });
  await writeFile(w.vmPath("claude", CLAUDE), "stale or damaged");
  const writes = () => w.connection.calls.length;

  w.setConnected(false);
  await w.lends.settled();
  assert.equal(lentRow(w)?.status, "waiting-for-vm");
  const before = writes();
  t.mock.timers.tick(7 * HOUR + 31 * MIN);
  await w.lends.settled();
  assert.equal(w.refreshCalls.length, 0, "the token ran short, and nothing was spent on a VM that is away");
  assert.equal(writes(), before);

  w.files.write(w.hostPath("claude", CLAUDE), claudeLogin("while-away", Date.now() + 8 * HOUR));
  await w.lends.settled();
  w.setConnected(true);
  await w.lends.settled();
  assert.equal(lentRow(w)?.status, "active");
  assert.equal(await vmToken(w), "while-away");

  // The same token, a damaged file: still rewritten.
  await writeFile(w.vmPath("claude", CLAUDE), "damaged again");
  w.setConnected(false);
  w.setConnected(true);
  await w.lends.settled();
  assert.equal(await vmToken(w), "while-away");

  t.mock.timers.tick(6 * HOUR);
  await w.lends.settled();
  assert.equal(w.refreshCalls.length, 0, "the capped look only");
  t.mock.timers.tick(90 * MIN + 1);
  await w.lends.settled();
  assert.deepEqual(w.refreshCalls, [CLAUDE], "re-armed");
});

test("a lend reaches its time limit: the files go and the timers stop", async (t) => {
  const w = await world(t);
  await w.lends.lend(chat("chat-1"), BOX, { ...LEND_CLAUDE, minutes: 60 });
  t.mock.timers.tick(60 * MIN);
  await w.lends.settled();
  assert.equal(await w.readVm(w.vmPath("claude", CLAUDE)), null);
  assert.equal(await w.readVm(w.vmIndexPath), null);
  assert.deepEqual(storedLends(w), []);
  assert.equal(w.registry.summary(BOX)?.lentAccounts, undefined);
  assert.equal(w.files.watcherCount(w.hostPath("claude", CLAUDE)), 0);

  const calls = w.connection.calls.length;
  t.mock.timers.tick(24 * HOUR);
  w.files.write(w.hostPath("claude", CLAUDE), claudeLogin("later", Date.now() + 8 * HOUR));
  await w.lends.settled();
  assert.equal(w.connection.calls.length, calls);
  assert.equal(await w.readVm(w.vmPath("claude", CLAUDE)), null);
  assert.equal(w.refreshCalls.length, 0);
});

test("a closed chat's lends end; another chat's stay", async (t) => {
  const w = await world(t);
  await w.lends.lend(chat("chat-1"), BOX, LEND_CLAUDE);
  await w.lends.lend(chat("chat-2"), BOX, { ...LEND_CLAUDE, accounts: [{ agent: "codex", accountId: CODEX }] });
  w.lends.chatClosed("chat-1");
  await w.lends.settled();
  assert.equal(await w.readVm(w.vmPath("claude", CLAUDE)), null);
  assert.notEqual(await w.readVm(w.vmPath("codex", CODEX)), null);
  assert.deepEqual((await indexOnVm(w)).accounts.map((account) => account.id), [CODEX]);
});

test("a restart resumes live lends and rewrites their files; it ends those past their limit or whose chat is gone", async (t) => {
  const w = await world(t);
  const third = "33333333-3333-4333-8333-333333333333";
  w.addAccount("claude", third, "cy@example.com", NOW + 8 * HOUR);
  await w.lends.lend(chat("kept"), BOX, { ...LEND_CLAUDE, minutes: 600 });
  await w.lends.lend(chat("closed-while-down"), BOX, { ...LEND_CLAUDE, minutes: 600, accounts: [{ agent: "codex", accountId: CODEX }] });
  await w.lends.lend(chat("kept"), BOX, { ...LEND_CLAUDE, minutes: 10, accounts: [{ agent: "claude", accountId: third }] });
  await w.lends.stop();

  w.closedChats.add("closed-while-down");
  await writeFile(w.vmPath("claude", CLAUDE), "stale");
  t.mock.timers.tick(30 * MIN);

  const restarted = w.newService();
  t.after(() => restarted.stop());
  await restarted.start();
  await restarted.settled();

  assert.deepEqual(storedLends(w).map((lend) => lend.accountId), [CLAUDE]);
  assert.equal(await w.readVm(w.vmPath("codex", CODEX)), null);
  assert.equal(await w.readVm(w.vmPath("claude", third)), null);
  assert.equal(await vmToken(w), `${CLAUDE}-access`);
  assert.equal(lentRow(w)?.status, "active");
  assert.deepEqual((await indexOnVm(w)).accounts.map((account) => account.id), [CLAUDE]);

  w.files.write(w.hostPath("claude", CLAUDE), claudeLogin("after-restart", Date.now() + 8 * HOUR));
  await restarted.settled();
  assert.equal(await vmToken(w), "after-restart");

  t.mock.timers.tick(570 * MIN);
  await restarted.settled();
  assert.deepEqual(storedLends(w), [], "its time limit came back with it");
});

test("a restart finds a VM still away: the lend waits, and the ended one is cleaned up when it returns", async (t) => {
  const w = await world(t);
  const { lent } = await w.lends.lend(chat("chat-1"), BOX, LEND_CLAUDE);
  w.setConnected(false);
  await w.lends.endOne(chat("chat-1"), BOX, lent[0]!.id);

  assert.equal(storedLends(w)[0]?.endReason, "returned", "the record stays until its files are gone");
  assert.ok(storedLends(w)[0]?.endedAt);
  assert.equal(w.registry.summary(BOX)?.lentAccounts, undefined, "an ended lend is not shown");
  assert.notEqual(await w.readVm(w.vmPath("claude", CLAUDE)), null);

  await w.lends.stop();
  const restarted = w.newService();
  t.after(() => restarted.stop());
  await restarted.start();
  await restarted.settled();
  assert.equal(storedLends(w).length, 1);

  w.setConnected(true);
  await restarted.settled();
  assert.equal(await w.readVm(w.vmPath("claude", CLAUDE)), null);
  assert.equal(await w.readVm(w.vmIndexPath), null);
  assert.deepEqual(storedLends(w), []);
});

test("an install is all or nothing: records first, a failure ends every lend of the call and names the account", async (t) => {
  const w = await world(t);
  const untouched = await w.lends.lend(chat("chat-1"), BOX, { ...LEND_CLAUDE, accounts: [{ agent: "codex", accountId: CODEX }] });
  const second = "33333333-3333-4333-8333-333333333333";
  w.addAccount("claude", second, "dee@example.com", NOW + 10 * MIN);
  w.refreshImpl = async () => "invalid-grant";

  const seen: number[] = [];
  const request = w.connection.request.bind(w.connection);
  w.connection.request = ((method: string, params: never, options: never) => {
    if (method === "agent.ensurePaths") seen.push(storedLends(w).length);
    return request(method as never, params, options);
  }) as typeof w.connection.request;

  await assert.rejects(
    w.lends.lend(chat("chat-1"), BOX, { ...LEND_CLAUDE, accounts: [{ agent: "claude", accountId: CLAUDE }, { agent: "claude", accountId: second }] }),
    (error: Error & { code: string }) => error.code === "ACCOUNT_NEEDS_LOGIN" && error.message.includes("dee@example.com")
  );
  assert.deepEqual(seen, [3], "persisted before the VM is touched");
  await w.lends.settled();
  assert.equal(await w.readVm(w.vmPath("claude", CLAUDE)), null, "the first account's login was taken back");
  assert.deepEqual(storedLends(w).map((lend) => lend.id), [untouched.lent[0]!.id]);
  assert.deepEqual((await indexOnVm(w)).accounts.map((account) => account.id), [CODEX]);
  assert.notEqual(await w.readVm(w.vmPath("codex", CODEX)), null);
});

test("a VM refusing a write fails the install, with nothing left behind", async (t) => {
  const w = await world(t);
  const write = w.connection.writeFile.bind(w.connection);
  w.connection.writeFile = async (path, data, options) => {
    if (path === w.vmIndexPath) throw new Error("disk full");
    return write(path, data, options);
  };
  await assert.rejects(w.lends.lend(chat("chat-1"), BOX, LEND_CLAUDE), { code: "LEND_INSTALL_FAILED" });
  assert.equal(await w.readVm(w.vmPath("claude", CLAUDE)), null);
  assert.deepEqual(storedLends(w), []);
});

test("a renewal racing an end writes nothing after the cleanup", async (t) => {
  const w = await world(t);
  w.files.texts.set(w.hostPath("claude", CLAUDE), claudeLogin("short", NOW + 2 * HOUR));
  const { lent } = await w.lends.lend(chat("chat-1"), BOX, LEND_CLAUDE);

  let finishRefresh: (() => void) | undefined;
  w.refreshImpl = (agent, id) =>
    new Promise((resolve) => {
      finishRefresh = () => {
        w.files.write(w.hostPath(agent as "claude", id), claudeLogin("too-late", Date.now() + 8 * HOUR));
        resolve("refreshed");
      };
    });
  t.mock.timers.tick(90 * MIN + 1);
  await settle(() => finishRefresh !== undefined);

  const write = w.connection.writeFile.bind(w.connection);
  const written: string[] = [];
  w.connection.writeFile = async (path, data, options) => {
    written.push(path);
    return write(path, data, options);
  };
  const ending = w.lends.endOne(chat("chat-1"), BOX, lent[0]!.id);
  await once(w.store.events, "changed");
  finishRefresh!();
  await ending;
  await w.lends.settled();
  assert.ok(!written.includes(w.vmPath("claude", CLAUDE)), "the new token was never written");
  assert.equal(await w.readVm(w.vmPath("claude", CLAUDE)), null);
});

test("an end aborts a wait in the broker", async (t) => {
  const w = await world(t);
  const { lent } = await w.lends.lend(chat("chat-1"), BOX, LEND_CLAUDE);
  // A host CLI is renewing right now and leaves no usable token: the keeper's request waits for it.
  const path = w.hostPath("claude", CLAUDE);
  w.hostLocal.add(CLAUDE);
  w.files.lockAges.set(join(path, "..", ".oauth_refresh.lock"), 0);
  const watchers = w.files.watcherCount(path);
  w.files.write(path, claudeLogin("nearly-gone", NOW + MIN));
  await settle(() => w.files.watcherCount(path) === watchers + 1, 2000);

  await w.lends.endOne(chat("chat-1"), BOX, lent[0]!.id);
  assert.equal(w.files.watcherCount(path), 0);
  assert.equal(await w.readVm(w.vmPath("claude", CLAUDE)), null);
});

test("approving an account the chat already has replaces its end time and leaves the token alone", async (t) => {
  const w = await world(t);
  const first = await w.lends.lend(chat("chat-1"), BOX, { ...LEND_CLAUDE, minutes: 60 });
  await writeFile(w.vmPath("claude", CLAUDE), "untouched");

  const preview = await w.lends.preview(chat("chat-1"), BOX, { claude: [CLAUDE] });
  assert.equal(preview.accounts[0]?.alreadyLent, true);

  const second = await w.lends.lend(chat("chat-1"), BOX, { ...LEND_CLAUDE, minutes: 120 });
  assert.equal(second.lent[0]?.id, first.lent[0]?.id);
  assert.equal(second.lent[0]?.expiresAt, new Date(NOW + 120 * MIN).toISOString());
  assert.equal(await w.readVm(w.vmPath("claude", CLAUDE)), "untouched");

  t.mock.timers.tick(60 * MIN);
  await w.lends.settled();
  assert.equal(storedLends(w).length, 1, "the old limit no longer applies");
  t.mock.timers.tick(60 * MIN);
  await w.lends.settled();
  assert.deepEqual(storedLends(w), []);
});

test("a temporary box's time limit clamps a lend", async (t) => {
  const w = await world(t, { purpose: "temporary", project: null, threadId: "chat-1", deadlineAt: new Date(NOW + 30 * MIN).toISOString() });
  const preview = await w.lends.preview(chat("chat-1", ""), BOX, { claude: ["ana"], minutes: 240 });
  assert.equal(preview.minutes, 30);
  assert.equal(preview.expiresAt, new Date(NOW + 30 * MIN).toISOString());
  const { lent } = await w.lends.lend(chat("chat-1", ""), BOX, { ...LEND_CLAUDE, minutes: 240 });
  assert.equal(lent[0]?.expiresAt, new Date(NOW + 30 * MIN).toISOString());

  t.mock.timers.setTime(NOW + 30 * MIN - 1);
  await assert.rejects(w.lends.preview(chat("chat-1", ""), BOX, { claude: ["ana"] }), { code: "BOX_NOT_READY" });
});

test("a preview resolves names and defaults the time, and changes nothing", async (t) => {
  const w = await world(t);
  w.addAccount("claude", "ab111111-0000-4000-8000-000000000000", "cy@example.com", NOW + HOUR);
  const preview = await w.lends.preview(chat("chat-1"), BOX, { claude: ["ana", "ANA@example.com", "ab11"], codex: [CODEX.slice(0, 8)] });
  assert.deepEqual(
    preview.accounts.map((account) => [account.label, account.alreadyLent, account.tokenExpiresAt]),
    [
      ["ana@example.com", false, new Date(NOW + 8 * HOUR).toISOString()],
      ["cy@example.com", false, new Date(NOW + HOUR).toISOString()],
      ["bo@example.com", false, new Date(NOW + 240 * HOUR).toISOString()]
    ]
  );
  assert.equal(preview.minutes, 240);
  assert.equal(preview.boxLabel, "p");
  assert.deepEqual(storedLends(w), []);
  assert.equal(await w.readVm(w.vmIndexPath), null);
  assert.equal(w.connection.calls.length, 0);
});

test("what cannot be lent is refused before any card, naming the fix", async (t) => {
  const w = await world(t);
  w.addAccount("claude", "ab111111-0000-4000-8000-000000000000", "dup@a.example", NOW + HOUR);
  w.addAccount("claude", "ab222222-0000-4000-8000-000000000000", "dup@b.example", NOW + HOUR);
  w.addAccount("codex", "cc111111-0000-4000-8000-000000000000", "flagged@example.com", NOW + HOUR);
  w.accounts.at(-1)!.needsReauth = true;
  w.accounts.push({ id: "dd111111-0000-4000-8000-000000000000", agent: "claude", label: "nologin@example.com", needsReauth: false });
  const refused = async (body: unknown, code: string, text?: string) =>
    assert.rejects(w.lends.preview(chat("chat-1"), BOX, body), (error: Error & { code: string }) => {
      assert.equal(error.code, code);
      if (text) assert.ok(error.message.includes(text), error.message);
      return true;
    });
  await refused({ claude: ["nobody"] }, "ACCOUNT_NOT_FOUND", "ana@example.com");
  await refused({ claude: ["dup"] }, "ACCOUNT_AMBIGUOUS", "dup@a.example");
  await refused({ claude: ["system"] }, "ACCOUNT_NOT_LENDABLE");
  await refused({ codex: ["flagged"] }, "ACCOUNT_NEEDS_LOGIN", "flagged@example.com");
  await refused({ claude: ["nologin"] }, "ACCOUNT_NEEDS_LOGIN", "nologin@example.com");
  await refused({}, "BOX_INVALID_REQUEST");
  await refused({ claude: ["a", "b", "c", "d", "e", "f", "g"] }, "BOX_INVALID_REQUEST");
  // Grok is refused, and an account is only lent as its own agent's.
  await assert.rejects(w.lends.lend(chat("chat-1"), BOX, { ...LEND_CLAUDE, accounts: [{ agent: "grok", accountId: CLAUDE }] }), { code: "BOX_INVALID_REQUEST" });
  await assert.rejects(w.lends.lend(chat("chat-1"), BOX, { ...LEND_CLAUDE, accounts: [{ agent: "claude", accountId: "system" }] }), { code: "ACCOUNT_NOT_LENDABLE" });
  await assert.rejects(w.lends.lend(chat("chat-1"), BOX, { ...LEND_CLAUDE, accounts: [{ agent: "codex", accountId: CLAUDE }] }), { code: "ACCOUNT_NOT_FOUND" });

  w.setConnected(false);
  await refused({ claude: ["ana"] }, "BOX_NOT_READY");
  w.setConnected(true);
  w.enabled.value = false;
  await refused({ claude: ["ana"] }, "BOXES_DISABLED");
  await assert.rejects(w.lends.lend(chat("chat-1"), BOX, LEND_CLAUDE), { code: "BOXES_DISABLED" });
  assert.deepEqual(storedLends(w), []);
});

test("with the plugin off, an existing lend can still be ended", async (t) => {
  const w = await world(t);
  const { lent } = await w.lends.lend(chat("chat-1"), BOX, LEND_CLAUDE);
  w.enabled.value = false;
  await w.lends.endOne({ kind: "user" }, BOX, lent[0]!.id);
  assert.equal(await w.readVm(w.vmPath("claude", CLAUDE)), null);
});

test("a destroyed box's lends are dropped with no cleanup, and its keepers stop", async (t) => {
  const w = await world(t);
  await w.lends.lend(chat("chat-1"), BOX, LEND_CLAUDE);
  const calls = w.connection.calls.length;
  await w.store.update(BOX, (record) => {
    record.state = "destroying";
  });
  await w.lends.settled();
  assert.deepEqual(storedLends(w), []);
  assert.equal(w.connection.calls.length, calls);
  assert.notEqual(await w.readVm(w.vmPath("claude", CLAUDE)), null);
  assert.equal(w.files.watcherCount(w.hostPath("claude", CLAUDE)), 0);
});

test("a machine released to its owner stays up, so its lent logins are removed", async (t) => {
  const w = await world(t, { provider: "byo" });
  await w.lends.lend(chat("chat-1"), BOX, LEND_CLAUDE);
  await w.store.update(BOX, (record) => {
    record.purpose = "machine";
    record.project = null;
  });
  await w.lends.settled();
  assert.equal(await w.readVm(w.vmPath("claude", CLAUDE)), null);
  assert.deepEqual(storedLends(w), []);
});

test("unknown fields survive every rewrite, and a lend of an unknown agent is ignored, not crashed on", async (t) => {
  const w = await world(t);
  const future = { id: "future", accountId: "gem-1", agent: "gemini", label: "g", createdAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW - HOUR).toISOString(), futureField: "kept" };
  await w.store.update(BOX, (record) => {
    (record as Record<string, unknown>).boxFuture = "kept";
    record.accountLends = [future];
  });
  await w.lends.stop();
  const restarted = w.newService();
  t.after(() => restarted.stop());
  await restarted.start();
  await restarted.settled();
  assert.equal(w.registry.summary(BOX)?.lentAccounts, undefined);

  const { lent } = await restarted.lend(chat("chat-1"), BOX, LEND_CLAUDE);
  await w.store.update(BOX, (record) => {
    const mine = record.accountLends!.find((lend) => lend.id === lent[0]!.id)!;
    (mine as Record<string, unknown>).futureField = "mine";
  });
  await restarted.lend(chat("chat-1"), BOX, { ...LEND_CLAUDE, minutes: 300 });
  assert.equal((storedLends(w).find((lend) => lend.id === lent[0]!.id) as Record<string, unknown>).futureField, "mine");
  assert.deepEqual((await indexOnVm(w)).accounts.map((account) => account.id), [CLAUDE], "not listed for a VM's eval");

  await restarted.endAll({ kind: "user" }, BOX);
  assert.deepEqual(storedLends(w), [future], "kept for the build that knows it");
  const raw = JSON.parse(await readFile((await allFiles(w.base)).find((file) => file.endsWith("boxes.json"))!, "utf8"));
  assert.equal(raw.boxes[BOX].boxFuture, "kept");
});
