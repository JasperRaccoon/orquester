/**
 * Refresh scheduling with the real pieces (spec 2026-10-19 boxes §7): the session router's
 * host-local account set, `AgentAccountsService`'s single refresher (fetch mocked), and the broker
 * over real files.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type { SessionSummary } from "@orquester/api";

import { ChatSessionManager } from "../../agent-chat/chat-sessions.ts";
import { ChatAwareSessionManager } from "../../agent-chat/session-router.ts";
import { AgentAccountsService } from "../../agent-accounts.ts";
import { writeFileAtomic } from "../../agent-hooks.ts";
import type { ISessionManager } from "../../sessions.ts";
import { AgentTokenError, createAgentTokenBroker } from "./broker.ts";
import { nodeCredentialFiles } from "./credentials.ts";
import { brokerWorld, jwt } from "./testing.ts";

const BOX_PROJECT = "/ws/w/p";
const HOST_PROJECT = "/ws/w/host";

function ptyRow(id: string, projectPath: string, accountId: string, status: SessionSummary["status"] = "running"): SessionSummary {
  return {
    id,
    kind: "agent",
    refId: "claude",
    title: id,
    projectPath,
    cwd: projectPath,
    cols: 80,
    rows: 24,
    status,
    order: 0,
    createdAt: "2026-10-20T00:00:00.000Z",
    accountId
  };
}

/** A router over a PTY backend that only lists rows, and a real chat backend. */
function router(ptyRows: SessionSummary[] = []) {
  const pty = {
    lifecycle: new EventEmitter(),
    list: () => ptyRows.map((row) => ({ ...row })),
    liveAccountIds: () => new Set(ptyRows.filter((r) => r.status === "running" && r.accountId).map((r) => r.accountId as string))
  } as unknown as ISessionManager;
  const chat = new ChatSessionManager({ requestPersist: () => undefined });
  const sessions = new ChatAwareSessionManager(pty, chat, {
    create: async () => {
      throw new Error("not used");
    },
    onClose: () => undefined,
    onRename: () => undefined
  });
  sessions.setBoxProjectPredicate((path) => path === BOX_PROJECT || path.startsWith(`${BOX_PROJECT}/`));
  const openChat = (id: string, projectPath: string, accountId: string) =>
    chat.create({ id, refId: "codex", title: id, projectPath, cwd: projectPath, order: 0, accountId, home: "account" });
  return { sessions, chat, openChat };
}

test("hostLocalAccountIds leaves out box-project sessions; liveAccountIds still counts them as in use", () => {
  const { sessions, openChat } = router([
    ptyRow("pty-box", `${BOX_PROJECT}/sub`, "acc-pty-box"),
    ptyRow("pty-host", HOST_PROJECT, "acc-pty-host"),
    ptyRow("pty-host-exited", HOST_PROJECT, "acc-exited", "exited")
  ]);
  openChat("chat-box", BOX_PROJECT, "acc-chat-box");
  openChat("chat-host", HOST_PROJECT, "acc-chat-host");
  assert.deepEqual([...sessions.hostLocalAccountIds()].sort(), ["acc-chat-host", "acc-pty-host"]);
  assert.deepEqual(
    [...sessions.liveAccountIds()].sort(),
    ["acc-chat-box", "acc-chat-host", "acc-pty-box", "acc-pty-host"],
    "account removal and the orphan-home sweep still see box sessions"
  );
});

async function service(t: TestContext, now: number, fetchImpl: typeof fetch) {
  t.mock.method(Date, "now", () => now);
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(String(input));
    return fetchImpl(input, init);
  });
  const base = await mkdtemp(join(tmpdir(), "orq-broker-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const accountsDir = join(base, "agent-accounts");
  const svc = new AgentAccountsService({ indexFile: join(base, "agent-accounts.json"), accountsDir, userhome: base, now: () => now });
  await svc.init();
  return { svc, accountsDir, calls };
}

function codexBlob(expSeconds: number, refreshToken = "codex-refresh-SECRET"): string {
  return JSON.stringify({
    tokens: { access_token: jwt({ exp: expSeconds }), refresh_token: refreshToken, account_id: "ws-1", id_token: jwt({ email: "c@example.com" }) }
  });
}

function claudeBlob(accessToken: string, expiresAt: number): string {
  return JSON.stringify({ claudeAiOauth: { accessToken, refreshToken: "claude-refresh-SECRET", expiresAt, scopes: ["user:inference"] } });
}

function realBroker(
  svc: AgentAccountsService, accountsDir: string, sessions: ChatAwareSessionManager, now: number,
  files = nodeCredentialFiles(accountsDir)
) {
  const fakes = brokerWorld(); // its registry: box-1 owns BOX_PROJECT
  return createAgentTokenBroker({
    accounts: svc,
    registry: fakes.deps.registry,
    sessions: () => sessions.list(),
    hostLocalAccountIds: () => sessions.hostLocalAccountIds(),
    onSessionsChanged: (listener) => {
      for (const event of ["created", "updated", "exited", "closed"]) sessions.lifecycle.on(event, listener);
      return () => {
        for (const event of ["created", "updated", "exited", "closed"]) sessions.lifecycle.off(event, listener);
      };
    },
    files,
    now: () => now
  });
}

test("an account only box chats use is refreshed by the daemon; a host chat on it blocks that", async (t) => {
  const now = Date.parse("2026-10-20T00:00:00Z");
  const { svc, calls } = await service(t, now, async () =>
    new Response(JSON.stringify({ access_token: jwt({ exp: Math.floor(now / 1000) + 864_000 }), refresh_token: "NEW-SECRET" }), { status: 200 })
  );
  const { sessions, openChat } = router();
  const acct = await svc.importAccount({ content: codexBlob(Math.floor((now + 60_000) / 1000)) });
  openChat("chat-box", BOX_PROJECT, acct.id);

  // The usage path with the router's host-local set (how index.ts calls it).
  await svc.ensureFreshForUsage("codex", acct.id, sessions.hostLocalAccountIds());
  assert.equal(calls.length, 1, "a box session does not stop the refresh");

  // The refresher's own last-moment re-check reads the same set (startRefresher's source).
  svc.startRefresher(() => sessions.hostLocalAccountIds());
  svc.stopRefresher();
  openChat("chat-host", HOST_PROJECT, acct.id);
  assert.equal(await svc.refreshNow("codex", acct.id), "held", "a host-local holder is the refresher");
  await svc.ensureFreshForUsage("codex", acct.id, sessions.hostLocalAccountIds());
  assert.equal(calls.filter((url) => url.includes("auth.openai.com")).length, 1);
});

test("broker over the real service: concurrent requests and the usage path share one refresh; nothing secret leaves", async (t) => {
  const now = Date.parse("2026-10-20T00:00:00Z");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const refreshStarted = new Promise<void>((resolve) => (started = resolve));
  const newExp = Math.floor(now / 1000) + 864_000;
  const { svc, accountsDir, calls } = await service(t, now, async () => {
    started();
    await gate;
    return new Response(JSON.stringify({ access_token: jwt({ exp: newExp }), refresh_token: "codex-refresh-NEW-SECRET", id_token: jwt({ email: "id-SECRET" }) }), {
      status: 200
    });
  });
  const { sessions, openChat } = router();
  const acct = await svc.importAccount({ content: codexBlob(Math.floor((now + 60_000) / 1000)) });
  openChat("chat-box", BOX_PROJECT, acct.id);
  const broker = realBroker(svc, accountsDir, sessions, now);

  const signal = new AbortController().signal;
  const requests = [
    broker.getToken({ boxId: "box-1", agent: "codex", accountId: acct.id }, signal),
    broker.getToken({ boxId: "box-1", agent: "codex", accountId: acct.id }, signal)
  ];
  const usage = svc.ensureFreshForUsage("codex", acct.id, sessions.hostLocalAccountIds());
  // Every caller is now parked on the one in-flight refresh.
  await refreshStarted;
  release();
  const grants = await Promise.all(requests);
  await usage;
  assert.equal(calls.length, 1, "one refresh grant was posted");
  for (const grant of grants) {
    assert.equal(grant.expiresAt, newExp * 1000);
    assert.deepEqual(grant.extra, { chatgptAccountId: "ws-1" });
    assert.doesNotMatch(JSON.stringify(grant), /SECRET/);
  }
  const onDisk = JSON.parse(await readFile(join(svc.homePath("codex", acct.id), "auth.json"), "utf8"));
  assert.equal(onDisk.tokens.refresh_token, "codex-refresh-NEW-SECRET", "the rotated refresh token stays in the account home");
});

test("invalid_grant: the account is flagged needsReauth and the box gets TOKEN_NEEDS_REAUTH", async (t) => {
  const now = Date.parse("2026-10-20T00:00:00Z");
  const { svc, accountsDir, calls } = await service(t, now, async () =>
    new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
  );
  const { sessions, openChat } = router();
  const acct = await svc.importAccount({ content: codexBlob(Math.floor((now - 60_000) / 1000)) });
  openChat("chat-box", BOX_PROJECT, acct.id);
  const broker = realBroker(svc, accountsDir, sessions, now);
  await assert.rejects(
    broker.getToken({ boxId: "box-1", agent: "codex", accountId: acct.id }, new AbortController().signal),
    (error: unknown) => error instanceof AgentTokenError && error.code === "TOKEN_NEEDS_REAUTH" && error.status === 409
  );
  assert.equal(calls.length, 1);
  assert.equal(svc.getRecord(acct.id)?.needsReauth, true);
  assert.equal(svc.list().accounts.find((a) => a.id === acct.id)?.needsReauth, true);
});

test("a held Claude account whose CLI holds the refresh lock, over real files: the CLI's rename-replace ends the wait", async (t) => {
  const now = Date.parse("2026-10-20T00:00:00Z");
  const { svc, accountsDir, calls } = await service(t, now, async () => new Response("{}", { status: 500 }));
  const { sessions, openChat } = router();
  const acct = await svc.importAccount({ content: claudeBlob("claude-access-OLD", now + 60_000), label: "L" });
  openChat("chat-box", BOX_PROJECT, acct.id);
  openChat("chat-host", HOST_PROJECT, acct.id);
  const home = svc.homePath("claude", acct.id);
  await mkdir(join(home, ".oauth_refresh.lock")); // the CLI is refreshing right now
  const files = nodeCredentialFiles(accountsDir);
  const read = files.read.bind(files);
  const watch = files.watch.bind(files);
  let armed!: () => void;
  const watchArmed = new Promise<void>((resolve) => { armed = resolve; });
  let notified!: () => void;
  const nativeChange = new Promise<void>((resolve) => { notified = resolve; });
  files.watch = (path, onChange) => {
    const stop = watch(path, () => {
      onChange();
      notified();
    });
    armed(); // The real fs.watch call has returned with its listener registered.
    return stop;
  };
  let firstRead!: () => void;
  const readOld = new Promise<void>((resolve) => { firstRead = resolve; });
  files.read = async (path) => {
    const contents = await read(path);
    if (path === join(home, ".credentials.json")) firstRead();
    return contents;
  };
  const broker = realBroker(svc, accountsDir, sessions, now, files);
  const pending = broker.getToken({ boxId: "box-1", agent: "claude", accountId: acct.id }, new AbortController().signal);

  // Both the native listener and the old-token read precede the CLI's atomic replacement.
  await Promise.all([watchArmed, readOld]);
  await writeFileAtomic(join(home, ".credentials.json"), claudeBlob("claude-access-CLI", now + 8 * 3_600_000), 0o600);
  await nativeChange;
  assert.equal((await pending).accessToken, "claude-access-CLI");
  assert.equal(calls.length, 0, "the daemon never posted a refresh grant");
});

test("a held Codex account with nothing usable left is renewed through the real account service", async (t) => {
  const now = Date.parse("2026-10-20T00:00:00Z");
  const fresh = Math.floor(now / 1000) + 864_000;
  const { svc, accountsDir, calls } = await service(t, now, async () =>
    new Response(JSON.stringify({ access_token: jwt({ exp: fresh }), refresh_token: "codex-refresh-NEW-SECRET" }), { status: 200 })
  );
  const { sessions, openChat } = router();
  const acct = await svc.importAccount({ content: codexBlob(Math.floor((now - 60_000) / 1000)) });
  openChat("chat-box", BOX_PROJECT, acct.id);
  openChat("chat-host", HOST_PROJECT, acct.id);
  const broker = realBroker(svc, accountsDir, sessions, now);
  const grant = await broker.getToken({ boxId: "box-1", agent: "codex", accountId: acct.id }, new AbortController().signal);
  assert.equal(grant.expiresAt, fresh * 1000);
  assert.equal(calls.length, 1, "the expired token was renewed by the daemon although a host chat holds it");
});
