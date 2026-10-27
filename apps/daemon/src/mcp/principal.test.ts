/**
 * The principal plumbing (unified MCP design 2026-10-15; `@orquester/api` `principal.ts`): the
 * token rules (≥ 128 bits, single use, 30 s, released by the minter), the hook on BOTH apps (no
 * header = user; a bad token = 401, never user; the header never reaches a route), the in-process
 * client minting per request, the external `/mcp` transport's `external {credentialId}`, and the
 * remote stripping of socket-trusted fields.
 */

import assert from "node:assert/strict";
import test from "node:test";

import Fastify, { type FastifyInstance } from "fastify";
import { createDefaultClientConfig, createDefaultDaemonConfig } from "@orquester/config";
import { PRINCIPAL_TOKEN_HEADER, PRINCIPAL_TOKEN_INVALID, type CallerPrincipal } from "@orquester/api/agent-chat";

import { createServer } from "../index.ts";
import { InjectDaemonApi } from "./daemon-api.ts";
import { chatSummary } from "./fixtures.ts";
import {
  externalCredentialId,
  mintPrincipalToken,
  registerPrincipalHook,
  resolvePrincipalToken
} from "./principal.ts";
import { testAuthSessions } from "../auth/testing.ts";

const AGENT: CallerPrincipal = { kind: "agent", threadId: "t1", projectPath: "/w/acme/api", agent: "claude", title: "T" };

test("tokens: ≥ 128 bits of base64url, distinct, single use, released by the minter, expired after the TTL", (t) => {
  const a = mintPrincipalToken(AGENT);
  const b = mintPrincipalToken(AGENT);
  assert.notEqual(a.token, b.token);
  assert.match(a.token, /^[A-Za-z0-9_-]+$/);
  assert.ok(Buffer.from(a.token, "base64url").length >= 16);
  assert.deepEqual(resolvePrincipalToken(a.token), AGENT);
  assert.equal(resolvePrincipalToken(a.token), null, "consumed on its first resolve");
  b.release();
  assert.equal(resolvePrincipalToken(b.token), null, "released by the minter");
  a.release();
  assert.equal(resolvePrincipalToken("not-a-token"), null);

  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const late = mintPrincipalToken(AGENT);
  now += 30_000;
  assert.equal(resolvePrincipalToken(late.token), null, "expired");
  late.release();
});

test("a minted principal is a copy: changing the minter's object changes nothing a route reads", () => {
  const mine = { ...AGENT } as { kind: "agent"; threadId: string; projectPath: string };
  const minted = mintPrincipalToken(mine);
  mine.threadId = "someone-else";
  assert.equal((resolvePrincipalToken(minted.token) as { threadId: string }).threadId, "t1");
  minted.release();
});

function hookedApp(): { app: FastifyInstance; seen: { principal: CallerPrincipal; header: unknown }[] } {
  const app = Fastify();
  registerPrincipalHook(app);
  const seen: { principal: CallerPrincipal; header: unknown }[] = [];
  app.get("/api/who", async (request) => {
    seen.push({ principal: request.principal, header: request.headers[PRINCIPAL_TOKEN_HEADER] });
    return { ok: true };
  });
  return { app, seen };
}

test("the hook: no header is the user; a live token is its principal and the header never reaches the route; a bad token is 401, never the user", async () => {
  const { app, seen } = hookedApp();
  try {
    assert.equal((await app.inject({ method: "GET", url: "/api/who" })).statusCode, 200);
    const minted = mintPrincipalToken(AGENT);
    assert.equal((await app.inject({ method: "GET", url: "/api/who", headers: { [PRINCIPAL_TOKEN_HEADER]: minted.token } })).statusCode, 200);
    // The same token again (replayed), an unknown one, an empty one.
    for (const token of [minted.token, "AAAAAAAAAAAAAAAAAAAAAA", ""]) {
      const refused = await app.inject({ method: "GET", url: "/api/who", headers: { [PRINCIPAL_TOKEN_HEADER]: token } });
      assert.equal(refused.statusCode, 401, `token ${JSON.stringify(token)}`);
      assert.equal(JSON.parse(refused.body).code, PRINCIPAL_TOKEN_INVALID);
      if (token) assert.doesNotMatch(refused.body, new RegExp(token), "the token is never echoed");
    }
    minted.release();
    assert.deepEqual(seen, [
      { principal: { kind: "user" }, header: undefined },
      { principal: AGENT, header: undefined }
    ]);
  } finally {
    await app.close();
  }
});

test("InjectDaemonApi forwards agent and external principals without changing plain user calls", async () => {
  const { app, seen } = hookedApp();
  const api = new InjectDaemonApi({ app, authorization: undefined, agentChat: null, broadcaster: { add() {}, remove() {} } as never, fsRoot: "/", workspacesDir: "/" });
  try {
    assert.equal((await api.request("GET", "/api/who", { principal: AGENT })).status, 200);
    assert.equal((await api.request("GET", "/api/who", { principal: { kind: "external", credentialId: "cred_x" } })).status, 200);
    assert.equal((await api.request("GET", "/api/who")).status, 200);
    assert.deepEqual(seen.map((entry) => entry.principal), [AGENT, { kind: "external", credentialId: "cred_x" }, { kind: "user" }]);
  } finally {
    await app.close();
  }
});

test("the external credential id names the identity, never the secret, and is stable", () => {
  const id = externalCredentialId("admin");
  assert.equal(id, externalCredentialId("admin"));
  assert.notEqual(id, externalCredentialId("other"));
  assert.match(id, /^cred_[0-9a-f]{24}$/);
  assert.doesNotMatch(id, /admin/);
});

// --- Both apps, through the daemon's own createServer (inject only: nothing listens) ---

type CreateServerArgs = Parameters<typeof createServer>;
const USERNAME = "admin";
const PASSWORD_HASH = "$2a$12$0123456789012345678901uFAKEfakeFAKEfakeFAKEfa";
const { authSessions: AUTH_SESSIONS, bearer: BEARER } = await testAuthSessions();

function daemonApp(mode: "local" | "remote", services: Record<string, unknown>): { app: FastifyInstance; principals: { url: string; principal: CallerPrincipal }[] } {
  const config = createDefaultDaemonConfig({ env: {} });
  config.transports.http.username = USERNAME;
  config.transports.http.passwordHash = PASSWORD_HASH;
  const root = "/nonexistent-orquester-principal-test";
  const resolved = { daemonDir: root, workspacesDir: root, workspacesMetaFile: `${root}/workspaces.json`, fsRoot: root } as unknown as CreateServerArgs[1];
  const app = createServer(config, resolved, createDefaultClientConfig(`${root}/daemon.sock`), { write() {} }, { authSessions: AUTH_SESSIONS, ...services } as unknown as CreateServerArgs[4], { authRequired: mode === "remote", mode });
  const principals: { url: string; principal: CallerPrincipal }[] = [];
  app.addHook("preHandler", async (request) => {
    principals.push({ url: request.url, principal: request.principal });
    // As server.test.ts: a consumed mock request reads as destroyed, like a real one.
    (request.raw as unknown as { destroyed: boolean }).destroyed = true;
  });
  return { app, principals };
}

test("both apps resolve principals: the socket app and the HTTP app (behind its bearer); a bad token is 401 on each", async () => {
  for (const mode of ["local", "remote"] as const) {
    const { app, principals } = daemonApp(mode, { sessions: { list: () => [chatSummary()] } });
    const auth = mode === "remote" ? { authorization: BEARER } : {};
    try {
      const minted = mintPrincipalToken(AGENT);
      const ok = await app.inject({ method: "GET", url: "/api/sessions", headers: { ...auth, [PRINCIPAL_TOKEN_HEADER]: minted.token } });
      assert.equal(ok.statusCode, 200, `${mode}: ${ok.body}`);
      minted.release();
      const plain = await app.inject({ method: "GET", url: "/api/sessions", headers: auth });
      assert.equal(plain.statusCode, 200);
      const bad = await app.inject({ method: "GET", url: "/api/sessions", headers: { ...auth, [PRINCIPAL_TOKEN_HEADER]: "forged" } });
      assert.equal(bad.statusCode, 401, mode);
      assert.equal(JSON.parse(bad.body).code, PRINCIPAL_TOKEN_INVALID);
      assert.deepEqual(principals.map((entry) => entry.principal), [AGENT, { kind: "user" }], mode);
      if (mode === "remote") {
        // An unauthenticated request never reaches the registry: the bearer hook answers first.
        const anonymous = await app.inject({ method: "GET", url: "/api/sessions", headers: { [PRINCIPAL_TOKEN_HEADER]: "forged" } });
        assert.equal(JSON.parse(anonymous.body).code, "UNAUTHORIZED");
      }
    } finally {
      await app.close();
    }
  }
});

test("the external /mcp acts as external {credentialId} on every daemon call; the /mcp request itself and a direct REST call are the user's", async () => {
  const { app, principals } = daemonApp("remote", {
    sessions: { list: () => [chatSummary()] },
    registry: { list: () => ({ shells: [], ides: [], fileExplorers: [], browsers: [], agents: [] }) },
    agentAccounts: { list: () => ({ accounts: [], defaults: {} }) }
  });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json", authorization: BEARER },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_sessions", arguments: {} } }
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(JSON.parse(res.body).result.isError, undefined, res.body);
    await app.inject({ method: "GET", url: "/api/sessions", headers: { authorization: BEARER } });
    const external = { kind: "external", credentialId: externalCredentialId(USERNAME) };
    assert.deepEqual(principals[0], { url: "/mcp", principal: { kind: "user" } });
    const inner = principals.slice(1, -1);
    assert.ok(inner.length > 0 && inner.every((entry) => JSON.stringify(entry.principal) === JSON.stringify(external)), JSON.stringify(inner));
    assert.deepEqual(principals.at(-1)!.principal, { kind: "user" }, "a direct REST call with the bearer is the user");
  } finally {
    await app.close();
  }
});

test("through createServer's real routes: the remote app strips trusted turn, merge-back and interrupt fields; the socket app keeps them", async () => {
  const causedBy = { threadId: "a", exchangeId: "x", hop: 1 };
  const cause = { kind: "parent-stopped", parentSessionId: "p", parentTitle: "P", action: "interrupted" };
  for (const mode of ["remote", "local"] as const) {
    const forwarded: unknown[] = [];
    const merged: unknown[] = [];
    // Just enough of the chat service for the §6.2 command routes: the host client records the body it would forward.
    const routeDeps = new Proxy(
      {
        client: { json: async (_method: string, _path: string, body: unknown) => { forwarded.push(body); return { status: 200, body: { seq: 1 } }; } },
        isHostHealthy: () => true,
        chatSession: () => chatSummary({ id: "s1" }),
        noteSeq: () => {}
      } as Record<string, unknown>,
      { get: (target, key) => (key in target ? target[key as string] : () => undefined) }
    );
    const { app } = daemonApp(mode, {
      sessions: { list: () => [chatSummary({ id: "s1" })] },
      agentChat: { routeDeps: () => routeDeps, chat: { has: () => true, get: () => chatSummary({ id: "s1" }) } },
      lineage: { mergeBack: async (_id: string, body: unknown) => { merged.push(body); return { parentSessionId: "p", delivery: "queued", mergeId: "m" }; } }
    });
    const auth = mode === "remote" ? { authorization: BEARER } : {};
    try {
      const turn = await app.inject({ method: "POST", url: "/api/sessions/s1/turn", headers: auth, payload: { commandId: "c", input: "hi", causedBy } });
      assert.equal(turn.statusCode, 200, `${mode} turn: ${turn.body}`);
      const merge = await app.inject({ method: "POST", url: "/api/sessions/s1/merge-back", headers: auth, payload: { text: "r", causedBy } });
      assert.equal(merge.statusCode, 200, `${mode} merge-back: ${merge.body}`);
      const interrupt = await app.inject({ method: "POST", url: "/api/sessions/s1/interrupt", headers: auth, payload: { commandId: "i", cause, cascade: false } });
      assert.equal(interrupt.statusCode, 200, `${mode} interrupt: ${interrupt.body}`);
      if (mode === "remote") {
        assert.deepEqual(forwarded, [{ commandId: "c", input: "hi" }, { commandId: "i" }]);
        assert.deepEqual(merged, [{ text: "r" }]);
      } else {
        assert.deepEqual(forwarded, [{ commandId: "c", input: "hi", causedBy }, { commandId: "i", cause, cascade: false }], "socket-trusted on the socket app");
        assert.deepEqual(merged, [{ text: "r", causedBy }]);
      }
    } finally {
      await app.close();
    }
  }
});
