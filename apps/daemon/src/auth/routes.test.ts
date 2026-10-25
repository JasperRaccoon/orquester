/**
 * The remote transport's auth end to end through `createServer`: login (success, wrong password,
 * throttling), the bearer accepted on HTTP, `/ws`, the download's `?token=` and `/mcp` — and the
 * legacy `base64("<user>:<bcrypt hash>")` credential refused on each — logout, the management
 * routes, the password retype check, and revocation closing open streams.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import bcrypt from "bcryptjs";
import { WebSocket } from "ws";

import { agentChatRoutes } from "@orquester/api/agent-chat";
import { authRoutes, authSessionPath, type AuthIssuedTokenResponse, type AuthSessionsResponse } from "@orquester/api";
import { createDefaultClientConfig, createDefaultDaemonConfig, type DaemonConfig } from "@orquester/config";

import { createServer } from "../index.ts";
import { AuthSessionStore } from "./sessions.ts";

type CreateServerArgs = Parameters<typeof createServer>;

const USERNAME = "admin";
const PASSWORD = "correct horse battery";
// Cost 4: the real cost (12) would only slow the suite down.
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);
const LEGACY = Buffer.from(`${USERNAME}:${PASSWORD_HASH}`).toString("base64");

interface Harness {
  config: DaemonConfig;
  store: AuthSessionStore;
  remote: ReturnType<typeof createServer>;
  local: ReturnType<typeof createServer>;
  close: () => Promise<void>;
  /** Resolves once the event stream has registered its sink. */
  sinkAdded: Promise<void>;
  sinkRemoved: Promise<void>;
}

async function harness(
  logStream: NodeJS.WritableStream = new Writable({ write: (_chunk, _encoding, done) => done() }),
  extraServices: Record<string, unknown> = {}
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "orquester-auth-routes-"));
  const config = createDefaultDaemonConfig({ env: {} });
  config.workspacesDir = join(root, "workspaces");
  config.transports.http.username = USERNAME;
  config.transports.http.passwordHash = PASSWORD_HASH;
  const store = new AuthSessionStore();
  await store.syncPassword(PASSWORD_HASH);
  let added!: () => void;
  let removed!: () => void;
  const sinkAdded = new Promise<void>((resolve) => (added = resolve));
  const sinkRemoved = new Promise<void>((resolve) => (removed = resolve));
  const services = {
    authSessions: store,
    buildInfo: { version: null, commit: null },
    broadcaster: { add: () => added(), remove: () => removed(), publish: () => undefined },
    gitWatcher: { subscribe: () => undefined, unsubscribe: () => undefined },
    plugins: { workspacesChanged: async () => undefined },
    ...extraServices
  } as unknown as CreateServerArgs[4];
  const resolved = {
    baseDir: root,
    daemonDir: root,
    configPath: join(root, "daemon.json"),
    workspacesDir: join(root, "workspaces"),
    workspacesMetaFile: join(root, "workspaces.json"),
    fsRoot: join(root, "workspaces"),
    logsDir: join(root, "logs"),
    vars: { userhome: root, user: "test", cwd: root, appdir: root }
  } as unknown as CreateServerArgs[1];
  const build = (mode: "local" | "remote") =>
    createServer(config, resolved, createDefaultClientConfig(join(root, "daemon.sock")), logStream as CreateServerArgs[3], services, {
      authRequired: mode === "remote",
      mode
    });
  const remote = build("remote");
  let local: ReturnType<typeof createServer> | undefined;
  return {
    config, store, remote, sinkAdded, sinkRemoved,
    get local() { return local ??= build("local"); },
    close: async () => {
      await Promise.all([remote.close(), local?.close()]);
      await rm(root, { recursive: true, force: true });
    }
  };
}

async function login(h: Harness, password = PASSWORD, ip = "203.0.113.1", username = USERNAME) {
  return h.remote.inject({
    method: "POST",
    url: authRoutes.login,
    remoteAddress: ip,
    headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0" },
    payload: { username, password }
  });
}

const info = (h: Harness, token: string) => h.remote.inject({ method: "GET", url: "/api/info", headers: { authorization: `Bearer ${token}` } });

test("auth info discloses no salt; login mints a working token and the stored hash is no bearer", async (t) => {
  const h = await harness();
  t.after(h.close);

  const authInfo = (await h.remote.inject({ method: "GET", url: authRoutes.info })).json();
  assert.deepEqual(authInfo, { authRequired: true, requiresUsername: true });

  const res = await login(h);
  assert.equal(res.statusCode, 200);
  const issued = res.json() as AuthIssuedTokenResponse;
  assert.match(issued.token, /^orq_/);
  assert.equal(issued.session.label, "Firefox on Linux");
  assert.equal(issued.session.kind, "device");
  assert.equal((await info(h, issued.token)).statusCode, 200);

  assert.equal((await info(h, LEGACY)).statusCode, 401, "the legacy base64(user:hash) credential");
  assert.equal((await info(h, PASSWORD_HASH)).statusCode, 401, "the bare hash");
  assert.equal((await h.remote.inject({ method: "GET", url: "/api/info" })).statusCode, 401);
});

test("a wrong password or username is refused, and repeated guesses lock the IP out", async (t) => {
  const h = await harness();
  t.after(h.close);

  const wrongUser = await login(h, PASSWORD, "203.0.113.9", "someone");
  assert.equal(wrongUser.statusCode, 401);
  assert.equal(wrongUser.json().code, "INVALID_CREDENTIALS");

  const ip = "203.0.113.2";
  // Every guess counts — no burst collapse at the login route.
  for (let i = 0; i < 5; i += 1) assert.equal((await login(h, `wrong-${i}`, ip)).statusCode, 401);
  const locked = await login(h, PASSWORD, ip);
  assert.equal(locked.statusCode, 429, "even the right password waits out the lockout");
  assert.ok(Number(locked.headers["retry-after"]) > 0);
  assert.equal((await login(h, PASSWORD, "203.0.113.3")).statusCode, 200, "another IP is unaffected");
  assert.equal((await login(h, "", "203.0.113.4")).statusCode, 400);
});

test("the download's ?token= and /mcp accept a session token and refuse the legacy credential", async (t) => {
  const h = await harness();
  t.after(h.close);
  const { token } = (await login(h)).json() as AuthIssuedTokenResponse;

  const download = (credential: string) => h.remote.inject({ method: "GET", url: `/api/fs/download?p=Lw&token=${encodeURIComponent(credential)}` });
  assert.equal((await download(LEGACY)).statusCode, 401);
  assert.notEqual((await download(token)).statusCode, 401);

  const mcp = (credential: string) => h.remote.inject({ method: "GET", url: "/mcp", headers: { authorization: `Bearer ${credential}` } });
  assert.equal((await mcp(LEGACY)).statusCode, 401);
  assert.equal((await mcp(token)).statusCode, 405, "past the bearer hook: /mcp is POST-only");
  // An API token made for an external MCP client.
  const created = await h.remote.inject({ method: "POST", url: authRoutes.tokens, headers: { authorization: `Bearer ${token}` }, payload: { label: "Claude Code on laptop" } });
  assert.equal(created.statusCode, 200);
  const api = created.json() as AuthIssuedTokenResponse;
  assert.equal(api.session.kind, "api");
  assert.equal(api.session.expiresAt, null);
  assert.equal((await mcp(api.token)).statusCode, 405);
});

test("/ws accepts a session token, refuses the legacy credential, and closes when the session is revoked", async (t) => {
  const h = await harness();
  t.after(h.close);
  const { token, session } = (await login(h)).json() as AuthIssuedTokenResponse;
  await h.remote.listen({ host: "127.0.0.1", port: 0 });
  const port = (h.remote.server.address() as AddressInfo).port;

  const legacy = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(LEGACY)}`);
  const legacyCode = await new Promise<number>((resolve) => legacy.on("close", (code) => resolve(code)));
  assert.equal(legacyCode, 1008);

  const client = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`);
  await new Promise<void>((resolve, reject) => {
    client.on("open", () => resolve());
    client.on("error", reject);
  });
  const closed = new Promise<number>((resolve) => client.on("close", (code) => resolve(code)));
  assert.equal(await h.store.revoke(session.id), true);
  assert.equal(await closed, 1008);
});

test("revoking a session ends its open event stream", async (t) => {
  const h = await harness();
  t.after(h.close);
  const { token, session } = (await login(h)).json() as AuthIssuedTokenResponse;
  await h.remote.listen({ host: "127.0.0.1", port: 0 });
  const port = (h.remote.server.address() as AddressInfo).port;

  const stream = openStream(port, "/events", token);
  await h.sinkAdded;
  await h.store.revoke(session.id);
  await stream.terminated;
  await h.sinkRemoved;
});

/** A long-lived GET as a client holds it: `terminated` settles when the daemon cuts it. */
function openStream(port: number, path: string, token: string): { firstData: Promise<string>; terminated: Promise<void> } {
  let gotData!: (chunk: string) => void;
  let done!: () => void;
  const firstData = new Promise<string>((resolve) => (gotData = resolve));
  const terminated = new Promise<void>((resolve) => (done = resolve));
  const req = httpRequest({ host: "127.0.0.1", port, path, headers: { authorization: `Bearer ${token}` } }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => gotData(chunk));
    res.on("close", () => done());
    res.on("error", () => done());
  });
  req.on("error", () => done());
  req.end();
  return { firstData, terminated };
}

/** Terminal sessions whose output stream the test drives; `scrollback` waits on `gate`. */
function fakeSessions() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let asked!: () => void;
  const scrollbackAsked = new Promise<void>((resolve) => (asked = resolve));
  const state = { subscribed: 0, unsubscribed: 0, release, scrollbackAsked };
  return {
    state,
    sessions: {
      get: (id: string) => ({ id, status: "running" }),
      list: () => [],
      scrollback: async () => {
        asked();
        await gate;
        return "replay\n";
      },
      subscribe: () => {
        state.subscribed += 1;
        return () => {
          state.unsubscribed += 1;
        };
      }
    }
  };
}

test("revoking a session ends its terminal output stream", async (t) => {
  const terminal = fakeSessions();
  terminal.state.release();
  const h = await harness(undefined, { sessions: terminal.sessions });
  t.after(h.close);
  const { token, session } = (await login(h)).json() as AuthIssuedTokenResponse;
  await h.remote.listen({ host: "127.0.0.1", port: 0 });
  const port = (h.remote.server.address() as AddressInfo).port;

  const stream = openStream(port, "/api/sessions/s1/output", token);
  assert.equal(await stream.firstData, "replay\n");
  assert.equal(terminal.state.subscribed, 1);
  await h.store.revoke(session.id);
  await stream.terminated;
  assert.equal(terminal.state.unsubscribed, 1, "the PTY subscription is released");
});

test("a stream that opens after its session was revoked is cut as it opens", async (t) => {
  const terminal = fakeSessions();
  const h = await harness(undefined, { sessions: terminal.sessions });
  t.after(h.close);
  const { token, session } = (await login(h)).json() as AuthIssuedTokenResponse;
  await h.remote.listen({ host: "127.0.0.1", port: 0 });
  const port = (h.remote.server.address() as AddressInfo).port;

  // Past the bearer hook, still capturing scrollback (before the route hijacks) when revoked.
  const stream = openStream(port, "/api/sessions/s1/output", token);
  await terminal.state.scrollbackAsked;
  await h.store.revoke(session.id);
  terminal.state.release();
  await stream.terminated;
  assert.equal(terminal.state.unsubscribed, terminal.state.subscribed, "nothing stays subscribed");
});

test("revoking a session ends its agent-chat event stream and the host subscription", async (t) => {
  const upstream = new PassThrough();
  let aborted = false;
  const deps = {
    client: {
      open: async () => ({
        status: 200,
        body: upstream,
        abort: () => {
          aborted = true;
          upstream.destroy();
        }
      })
    },
    isHostHealthy: () => true,
    chatSession: (id: string) => ({ id, kind: "agent-chat" })
  };
  const agentChat = {
    routeDeps: () => deps,
    protectedPids: () => [],
    authorizeHostRequest: () => false,
    sessionToolThread: () => null,
    chat: { has: () => true, get: () => undefined }
  };
  const h = await harness(undefined, { agentChat });
  t.after(h.close);
  const { token, session } = (await login(h)).json() as AuthIssuedTokenResponse;
  await h.remote.listen({ host: "127.0.0.1", port: 0 });
  const port = (h.remote.server.address() as AddressInfo).port;

  const stream = openStream(port, agentChatRoutes.events("t1"), token);
  upstream.write(`${JSON.stringify({ kind: "synchronized", hostInstanceId: "h1" })}\n`);
  assert.match(await stream.firstData, /synchronized/);
  await h.store.revoke(session.id);
  await stream.terminated;
  assert.equal(aborted, true, "the host subscription is cancelled too");
});

test("a login whose password changed while it was checked mints nothing", async (t) => {
  const h = await harness();
  t.after(h.close);
  // The change already reached the sessions (they are bound to the new hash) while this login
  // checked the old one.
  await h.store.syncPassword(bcrypt.hashSync("the new password", 4));
  const res = await login(h);
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, "INVALID_CREDENTIALS");
  assert.deepEqual(h.store.list(null), []);
});

test("logout, list, revoke one and revoke-others", async (t) => {
  const h = await harness();
  t.after(h.close);
  const a = (await login(h, PASSWORD, "203.0.113.5")).json() as AuthIssuedTokenResponse;
  const b = (await login(h, PASSWORD, "203.0.113.6")).json() as AuthIssuedTokenResponse;
  const c = (await login(h, PASSWORD, "203.0.113.7")).json() as AuthIssuedTokenResponse;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  const listed = (await h.remote.inject({ method: "GET", url: authRoutes.sessions, headers: auth(a.token) })).json() as AuthSessionsResponse;
  assert.equal(listed.sessions.length, 3);
  assert.deepEqual(listed.sessions.filter((s) => s.current).map((s) => s.id), [a.session.id], "this device");
  assert.ok(!JSON.stringify(listed).includes("orq_"), "no token in a listing");
  assert.ok(!JSON.stringify(listed).includes("tokenDigest"), "nor a digest");

  assert.equal((await h.remote.inject({ method: "DELETE", url: authSessionPath(b.session.id), headers: auth(a.token) })).statusCode, 204);
  assert.equal((await info(h, b.token)).statusCode, 401);
  assert.equal((await h.remote.inject({ method: "DELETE", url: authSessionPath("missing"), headers: auth(a.token) })).statusCode, 404);

  const others = await h.remote.inject({ method: "POST", url: authRoutes.revokeOthers, headers: auth(a.token) });
  assert.deepEqual(others.json(), { revoked: 1 });
  assert.equal((await info(h, c.token)).statusCode, 401);
  assert.equal((await info(h, a.token)).statusCode, 200);

  assert.equal((await h.remote.inject({ method: "POST", url: authRoutes.logout, headers: auth(a.token) })).statusCode, 204);
  assert.equal((await info(h, a.token)).statusCode, 401);
  assert.equal((await h.remote.inject({ method: "POST", url: authRoutes.logout })).statusCode, 401, "logout needs a session");
});

test("the password retype check answers ok/false without failing the session", async (t) => {
  const h = await harness();
  t.after(h.close);
  const { token } = (await login(h)).json() as AuthIssuedTokenResponse;
  const verify = (password: string) =>
    h.remote.inject({ method: "POST", url: authRoutes.verifyPassword, headers: { authorization: `Bearer ${token}` }, payload: { password } });
  const wrong = await verify("nope");
  assert.equal(wrong.statusCode, 200);
  assert.deepEqual(wrong.json(), { ok: false });
  assert.deepEqual((await verify(PASSWORD)).json(), { ok: true });
  assert.equal((await h.remote.inject({ method: "POST", url: authRoutes.verifyPassword, payload: { password: PASSWORD } })).statusCode, 401);
});

test("changing the password signs every device out and keeps API tokens", async (t) => {
  // This case verifies password/session lifecycle with real bcrypt, without repeating its cost-12 work.
  const salt = bcrypt.genSaltSync(4);
  t.mock.method(bcrypt, "genSaltSync", () => salt);
  const h = await harness();
  t.after(h.close);
  const device = (await login(h)).json() as AuthIssuedTokenResponse;
  const api = (await h.local.inject({ method: "POST", url: authRoutes.tokens, payload: { label: "ci" } })).json() as AuthIssuedTokenResponse;
  assert.equal((await info(h, api.token)).statusCode, 200);

  const saved = await h.local.inject({
    method: "PUT",
    url: "/api/config/daemon",
    payload: { transports: { http: { enabled: false, password: "a brand new password" } } }
  });
  assert.equal(saved.statusCode, 200);
  assert.equal((await info(h, device.token)).statusCode, 401);
  assert.equal((await info(h, api.token)).statusCode, 200);
  assert.equal((await login(h, PASSWORD, "203.0.113.8")).statusCode, 401, "the old password no longer signs in");
  assert.equal((await login(h, "a brand new password", "203.0.113.8")).statusCode, 200);
});

test("neither the password nor a token reaches the request log", async (t) => {
  const lines: string[] = [];
  const log = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    }
  });
  const h = await harness(log);
  t.after(h.close);
  const { token } = (await login(h)).json() as AuthIssuedTokenResponse;
  await h.remote.inject({ method: "GET", url: `/api/fs/download?p=Lw&token=${encodeURIComponent(token)}` });
  await info(h, token);
  const text = lines.join("");
  assert.ok(text.includes("/api/fs/download"), "the requests were logged");
  assert.ok(!text.includes(token) && !text.includes(token.slice(4)), "no token in the log");
  assert.ok(!text.includes(PASSWORD), "no password in the log");
});
