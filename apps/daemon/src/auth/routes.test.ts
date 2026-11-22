/**
 * The remote transport's auth end to end through `createServer`: login (success, wrong password,
 * throttling), the bearer accepted on HTTP, `/ws`, the download's `?token=` and `/mcp` — and the
 * legacy `base64("<user>:<bcrypt hash>")` credential refused on each — logout, the management
 * routes, the password retype check, and revocation closing open streams. Then the login second
 * factor: challenges, codes used once, the code lockouts (and that none of them touches a signed-in
 * owner), enabling, the management routes' proofs, API-token minting, and failing closed.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { test, type TestContext } from "node:test";
import bcrypt from "bcryptjs";
import { WebSocket } from "ws";

import { agentChatRoutes } from "@orquester/api/agent-chat";
import {
  authRoutes,
  authSessionPath,
  isSecondFactorChallenge,
  storageRoutes,
  type AuthIssuedTokenResponse,
  type AuthRecoveryCodesResponse,
  type AuthSecondFactorSetupResponse,
  type AuthSecondFactorStatusResponse,
  type AuthSessionsResponse
} from "@orquester/api";
import { createDefaultClientConfig, createDefaultDaemonConfig, type DaemonConfig } from "@orquester/config";

import { createServer } from "../index.ts";
import { SecondFactorStore } from "./second-factor.ts";
import { AuthSessionStore } from "./sessions.ts";
import { authenticatorCode } from "./testing.ts";
import { generateTotpSecret } from "./totp.ts";

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
  // The storage view's download has the same allowance — and only it, not its sibling routes.
  const query = (path: string, credential: string) => h.remote.inject({ method: "GET", url: `${path}?path=%2F&token=${encodeURIComponent(credential)}` });
  assert.equal((await query(storageRoutes.download, LEGACY)).statusCode, 401);
  assert.notEqual((await query(storageRoutes.download, token)).statusCode, 401);
  assert.equal((await query(storageRoutes.tree, token)).statusCode, 401);

  const mcp = (credential: string) => h.remote.inject({ method: "GET", url: "/mcp", headers: { authorization: `Bearer ${credential}` } });
  assert.equal((await mcp(LEGACY)).statusCode, 401);
  assert.equal((await mcp(token)).statusCode, 405, "past the bearer hook: /mcp is POST-only");
  // An API token made for an external MCP client.
  const created = await h.remote.inject({ method: "POST", url: authRoutes.tokens, headers: { authorization: `Bearer ${token}` }, payload: { label: "Claude Code on laptop", password: PASSWORD } });
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
  const responses: ServerResponse[] = [];
  h.remote.addHook("onRequest", (request, reply, done) => {
    if (request.url === "/events") responses.push(reply.raw);
    done();
  });
  t.after(async () => {
    for (const response of responses) response.destroy();
    await h.close();
  });
  const { token, session } = (await login(h)).json() as AuthIssuedTokenResponse;
  await h.remote.listen({ host: "127.0.0.1", port: 0 });
  const port = (h.remote.server.address() as AddressInfo).port;

  const stream = openStream(port, "/events", token);
  await h.sinkAdded;
  await h.store.revoke(session.id);
  assert.ok(responses.some((response) => response.writableEnded || response.destroyed || response.socket?.destroyed), "revocation ended the streaming response before returning");
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

// ---------------------------------------------------------------------------
// Second factor
// ---------------------------------------------------------------------------

const quiet = { warn: () => undefined, error: () => undefined };

function clock(start = Date.parse("2026-11-22T10:00:00.000Z")): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

/**
 * A harness whose second factor runs on a test clock, with the sign-in alerts captured (pushes and
 * log warnings). `enable`: turned on before the server starts (its secret and recovery codes).
 */
async function factorHarness(t: TestContext, opts: { enable?: boolean; logStream?: NodeJS.WritableStream } = {}) {
  const time = clock();
  const factor = new SecondFactorStore({ now: time.now, logger: quiet });
  const secret = generateTotpSecret();
  let recoveryCodes: string[] = [];
  if (opts.enable !== false) {
    const codes = await factor.enable(secret, authenticatorCode(secret, time.now()));
    assert.ok(Array.isArray(codes));
    recoveryCodes = codes;
    // The enrolling code's step is used: the next code comes from the next step.
    time.advance(30_000);
  }
  const pushes: string[] = [];
  const warnings: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => warnings.push(args.map(String).join(" ")));
  const h = await harness(opts.logStream, { secondFactor: factor, push: { notifySignInAlert: async (body: string) => void pushes.push(body) } });
  t.after(h.close);
  /** The current authenticator code; each call moves to a fresh step so none is a replay. */
  const freshCode = () => {
    time.advance(30_000);
    return authenticatorCode(secret, time.now());
  };
  return { h, time, factor, secret, recoveryCodes, pushes, warnings, freshCode };
}

async function passwordStep(h: Harness, ip: string): Promise<string> {
  const res = await login(h, PASSWORD, ip);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(isSecondFactorChallenge(body), "a challenge, not a token");
  assert.equal("token" in body, false);
  return body.challenge;
}

const codeStep = (h: Harness, challenge: string, code: string, ip: string) =>
  h.remote.inject({ method: "POST", url: authRoutes.secondFactorLogin, remoteAddress: ip, payload: { challenge, code } });

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** Signs in with password + authenticator code from `ip`; returns the device token. */
async function signIn(h: Harness, code: string, ip: string): Promise<string> {
  const res = await codeStep(h, await passwordStep(h, ip), code, ip);
  assert.equal(res.statusCode, 200);
  return (res.json() as AuthIssuedTokenResponse).token;
}

test("with the factor on, the password yields a challenge; challenge + code yields a working token, once", async (t) => {
  const { h, freshCode } = await factorHarness(t);
  const ip = "198.51.100.1";
  const challenge = await passwordStep(h, ip);
  const code = freshCode();
  const res = await codeStep(h, challenge, code, ip);
  assert.equal(res.statusCode, 200);
  const issued = res.json() as AuthIssuedTokenResponse;
  assert.equal(issued.session.kind, "device");
  assert.equal(issued.session.label, "Firefox on Linux", "labelled from the user agent at the password step");
  assert.equal((await info(h, issued.token)).statusCode, 200);

  assert.equal((await codeStep(h, challenge, freshCode(), ip)).json().code, "CHALLENGE_EXPIRED", "a challenge is single use");
  const replay = await codeStep(h, await passwordStep(h, ip), code, ip);
  assert.equal(replay.statusCode, 401);
  assert.equal(replay.json().code, "INVALID_CODE", "a used code is refused");
});

test("a recovery code signs in once", async (t) => {
  const { h, recoveryCodes } = await factorHarness(t);
  const ip = "198.51.100.2";
  assert.equal((await codeStep(h, await passwordStep(h, ip), recoveryCodes[0]!.toUpperCase(), ip)).statusCode, 200);
  assert.equal((await codeStep(h, await passwordStep(h, ip), recoveryCodes[0]!, ip)).json().code, "INVALID_CODE");
  assert.equal((await codeStep(h, await passwordStep(h, ip), recoveryCodes[1]!, ip)).statusCode, 200);
});

test("wrong codes exhaust a challenge, re-entering the password does not reset the IP's code lockout, and the owner is told", async (t) => {
  const { h, time, factor, pushes, warnings, freshCode } = await factorHarness(t);
  const ip = "198.51.100.3";
  const first = await passwordStep(h, ip);
  for (let i = 0; i < 4; i += 1) {
    const res = await codeStep(h, first, "000000", ip);
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().code, "INVALID_CODE");
  }
  // The alternation attack: a correct password again (which clears the password count) …
  const second = await passwordStep(h, ip);
  assert.equal((await codeStep(h, second, "111111", ip)).json().code, "INVALID_CODE");
  // … does not clear the code count: the 5th wrong code locked the IP, even for a right code.
  const locked = await codeStep(h, await passwordStep(h, ip), freshCode(), ip);
  assert.equal(locked.statusCode, 429);
  assert.ok(Number(locked.headers["retry-after"]) > 0);
  assert.equal((await signIn(h, freshCode(), "198.51.100.4")).startsWith("orq_"), true, "another IP is unaffected");

  // Five wrong codes void one challenge.
  const exhausted = await passwordStep(h, "198.51.100.5");
  for (let i = 0; i < 5; i += 1) assert.equal((await codeStep(h, exhausted, "222222", "198.51.100.5")).json().code, "INVALID_CODE");
  assert.equal((await codeStep(h, exhausted, freshCode(), "198.51.100.5")).json().code, "CHALLENGE_EXPIRED");

  // Told: the first wrong code of each challenge, with the IP and never the code.
  assert.equal(factor.status().lastFailedChallenge?.ip, "198.51.100.5", "the latest one, for Settings");
  assert.ok(pushes.length >= 2 && pushes.every((body) => /198\.51\.100\.[35]/.test(body)));
  const alerts = warnings.filter((line) => line.includes("wrong second-factor code"));
  assert.ok(alerts.some((line) => line.includes(ip)));
  assert.ok(!alerts.some((line) => /000000|111111|222222/.test(line)), "no code in the log");

  time.advance(15 * 60 * 1000);
  assert.equal((await signIn(h, freshCode(), ip)).startsWith("orq_"), true, "the lockout lapses");
});

test("wrong codes spread over many IPs lock all code entry; the signed-in owner keeps working and can turn the factor off", async (t) => {
  const { h, factor, pushes, freshCode } = await factorHarness(t);
  const owner = await signIn(h, freshCode(), "192.0.2.10");
  for (let i = 0; i < 10; i += 1) {
    const ip = `203.0.113.${100 + i}`;
    const challenge = await passwordStep(h, ip);
    for (let j = 0; j < 2; j += 1) assert.equal((await codeStep(h, challenge, "000000", ip)).statusCode, 401);
  }
  const fresh = await codeStep(h, await passwordStep(h, "192.0.2.77"), freshCode(), "192.0.2.77");
  assert.equal(fresh.statusCode, 429, "an untouched IP with the right code waits out the global lockout");
  assert.ok(pushes.some((body) => body.includes("paused")), "the owner is told of the lockout");

  // The owner is not locked out: API requests, a WebSocket, and turning the factor off.
  assert.equal((await info(h, owner)).statusCode, 200);
  await h.remote.listen({ host: "127.0.0.1", port: 0 });
  const port = (h.remote.server.address() as AddressInfo).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(owner)}`);
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  ws.close();
  const disabled = await h.remote.inject({ method: "POST", url: authRoutes.secondFactorDisable, headers: bearer(owner), payload: { password: PASSWORD, code: freshCode() } });
  assert.equal(disabled.statusCode, 204);
  assert.equal(factor.isEnabled(), false);
});

test("a completed sign-in clears the global wrong-code count, so scattered typos never add up to a lockout", async (t) => {
  const { h, freshCode } = await factorHarness(t);
  const typos = async (from: number) => {
    for (let i = 0; i < 4; i += 1) {
      const ip = `203.0.113.${from + i}`;
      const challenge = await passwordStep(h, ip);
      for (let j = 0; j < 4; j += 1) assert.equal((await codeStep(h, challenge, "000000", ip)).statusCode, 401);
    }
  };
  await typos(10); // 16 wrong codes, under the global limit
  assert.equal((await signIn(h, freshCode(), "192.0.2.10")).startsWith("orq_"), true);
  await typos(20); // 16 more: 32 in all, but the sign-in in between reset the count
  assert.equal((await signIn(h, freshCode(), "192.0.2.11")).startsWith("orq_"), true, "not globally locked");
});

test("an expired challenge, another IP's challenge and one from before a password change are refused", async (t) => {
  const { h, time, freshCode } = await factorHarness(t);
  const ip = "198.51.100.6";
  const challenge = await passwordStep(h, ip);
  const elsewhere = await codeStep(h, challenge, freshCode(), "198.51.100.7");
  assert.equal(elsewhere.statusCode, 401);
  assert.equal(elsewhere.json().code, "CHALLENGE_EXPIRED");
  assert.equal((await codeStep(h, challenge, freshCode(), ip)).statusCode, 200, "the other IP's attempt did not use it up");

  const late = await passwordStep(h, ip);
  time.advance(5 * 60 * 1000);
  assert.equal((await codeStep(h, late, freshCode(), ip)).json().code, "CHALLENGE_EXPIRED");

  const stale = await passwordStep(h, ip);
  h.config.transports.http.passwordHash = bcrypt.hashSync("rotated", 4);
  assert.equal((await codeStep(h, stale, freshCode(), ip)).json().code, "CHALLENGE_EXPIRED");
});

test("enabling: setup needs the password, the pending secret's code turns it on, other device sessions go and API tokens stay", async (t) => {
  const lines: string[] = [];
  const logStream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    }
  });
  const { h, time } = await factorHarness(t, { enable: false, logStream });
  const caller = (await login(h, PASSWORD, "198.51.100.8")).json() as AuthIssuedTokenResponse;
  const other = (await login(h, PASSWORD, "198.51.100.9")).json() as AuthIssuedTokenResponse;
  const api = (await h.local.inject({ method: "POST", url: authRoutes.tokens, payload: { label: "ci" } })).json() as AuthIssuedTokenResponse;
  const post = (url: string, token: string, payload: object) => h.remote.inject({ method: "POST", url, headers: { ...bearer(token), host: "agents.example.io" }, payload });

  const noPassword = await post(authRoutes.secondFactorSetup, caller.token, {});
  assert.equal(noPassword.statusCode, 403);
  assert.deepEqual([noPassword.json().code, noPassword.json().field], ["INVALID_PROOF", "password"]);
  assert.equal((await post(authRoutes.secondFactorSetup, caller.token, { password: "wrong" })).json().field, "password");
  const setup = await post(authRoutes.secondFactorSetup, caller.token, { password: PASSWORD });
  assert.equal(setup.statusCode, 200);
  const { secret, otpauthUri } = setup.json() as AuthSecondFactorSetupResponse;
  assert.match(otpauthUri, /^otpauth:\/\/totp\/Orquester:admin%40agents\.example\.io\?secret=[A-Z2-7]{32}&issuer=Orquester/);

  const code = authenticatorCode(secret, time.now());
  assert.equal((await post(authRoutes.secondFactorEnable, other.token, { code })).json().code, "NO_PENDING_SETUP", "the pending secret is the caller's");
  const wrong = await post(authRoutes.secondFactorEnable, caller.token, { code: "000000" });
  assert.deepEqual([wrong.statusCode, wrong.json().field], [403, "code"]);
  const enabled = await post(authRoutes.secondFactorEnable, caller.token, { code });
  assert.equal(enabled.statusCode, 200);
  const { recoveryCodes } = enabled.json() as AuthRecoveryCodesResponse;
  assert.equal(recoveryCodes.length, 10);

  assert.equal((await info(h, caller.token)).statusCode, 200, "the caller stays");
  assert.equal((await info(h, other.token)).statusCode, 401, "other device sessions are revoked");
  assert.equal((await info(h, api.token)).statusCode, 200, "API tokens stay");
  assert.equal((await post(authRoutes.secondFactorSetup, caller.token, { password: PASSWORD })).json().code, "SECOND_FACTOR_ENABLED");

  const status = (await h.remote.inject({ method: "GET", url: authRoutes.secondFactor, headers: bearer(caller.token) })).json() as AuthSecondFactorStatusResponse;
  assert.equal(status.enabled, true);
  assert.equal(status.recoveryCodesRemaining, 10);
  assert.ok(!JSON.stringify(status).includes(secret));
  await passwordStep(h, "198.51.100.8");
  const log = lines.join("");
  assert.ok(log.includes(authRoutes.secondFactorEnable), "the requests were logged");
  assert.ok(![secret, code, PASSWORD, ...recoveryCodes].some((value) => log.includes(value)), "no secret, code or password in the request log");
});

test("management proofs: a wrong one is 403 (never 401); new recovery codes replace the old; the socket needs no proof", async (t) => {
  const { h, factor, recoveryCodes, freshCode } = await factorHarness(t);
  const owner = await signIn(h, freshCode(), "198.51.100.10");
  const post = (url: string, payload: object) => h.remote.inject({ method: "POST", url, headers: bearer(owner), payload });
  for (const [payload, field] of [
    [{ password: PASSWORD }, "code"],
    [{ password: PASSWORD, code: "000000" }, "code"],
    [{ password: "wrong", code: freshCode() }, "password"],
    [{ code: freshCode() }, "password"]
  ] as const) {
    const res = await post(authRoutes.secondFactorRecoveryCodes, payload);
    assert.deepEqual([res.statusCode, res.json().code, res.json().field], [403, "INVALID_PROOF", field]);
  }
  assert.equal((await info(h, owner)).statusCode, 200, "the session is still good");

  const renewed = await post(authRoutes.secondFactorRecoveryCodes, { password: PASSWORD, code: recoveryCodes[0]! });
  assert.equal(renewed.statusCode, 200);
  const fresh = (renewed.json() as AuthRecoveryCodesResponse).recoveryCodes;
  assert.equal((await post(authRoutes.secondFactorDisable, { password: PASSWORD, code: recoveryCodes[1]! })).json().field, "code", "the old codes stopped working");
  assert.equal((await codeStep(h, await passwordStep(h, "198.51.100.11"), fresh[0]!, "198.51.100.11")).statusCode, 200);

  await factor.recordFailedChallenge("198.51.100.12");
  assert.equal((await h.local.inject({ method: "POST", url: authRoutes.secondFactorDismissAlert })).statusCode, 204);
  assert.equal(factor.status().lastFailedChallenge, null);
  assert.equal((await h.local.inject({ method: "POST", url: authRoutes.secondFactorRecoveryCodes, payload: {} })).statusCode, 200);
  assert.equal((await h.local.inject({ method: "POST", url: authRoutes.secondFactorDisable, payload: {} })).statusCode, 204);
  assert.equal((await h.local.inject({ method: "POST", url: authRoutes.secondFactorDisable, payload: {} })).json().code, "SECOND_FACTOR_DISABLED");
  const setup = await h.local.inject({ method: "POST", url: authRoutes.secondFactorSetup, payload: {} });
  assert.equal(setup.statusCode, 200, "setup over the socket needs no password");
});

test("API tokens: minting remotely needs the password, and a code while the factor is on; the socket needs neither", async (t) => {
  const { h, freshCode } = await factorHarness(t);
  const owner = await signIn(h, freshCode(), "198.51.100.13");
  const mint = (payload: object) => h.remote.inject({ method: "POST", url: authRoutes.tokens, headers: bearer(owner), payload: { label: "mcp", ...payload } });
  const bare = await mint({});
  assert.deepEqual([bare.statusCode, bare.json().field], [403, "password"]);
  assert.equal((await mint({ password: PASSWORD })).json().field, "code");
  const minted = await mint({ password: PASSWORD, code: freshCode() });
  assert.equal(minted.statusCode, 200);
  assert.equal((minted.json() as AuthIssuedTokenResponse).session.kind, "api");
  assert.equal((await h.local.inject({ method: "POST", url: authRoutes.tokens, payload: { label: "local" } })).statusCode, 200);
});

test("a second-factor file that does not parse: the right password gets 503, never a token, and the file is left alone", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orquester-auth-2fa-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "auth-second-factor.json");
  const garbage = '{"version":1,"totp":';
  await writeFile(file, garbage);
  const factor = new SecondFactorStore({ file, logger: quiet });
  await factor.load();
  const h = await harness(undefined, { secondFactor: factor });
  t.after(h.close);
  const { token } = await h.store.create("device", "signed in before");

  const res = await login(h);
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().code, "SECOND_FACTOR_UNAVAILABLE");
  assert.equal("token" in res.json(), false);
  assert.equal((await login(h, "wrong")).statusCode, 401, "the password is still checked first");
  assert.equal((await h.local.inject({ method: "POST", url: authRoutes.login, payload: { username: USERNAME, password: PASSWORD } })).statusCode, 503);
  assert.equal((await info(h, token)).statusCode, 200, "existing sessions keep working");
  const mint = await h.remote.inject({ method: "POST", url: authRoutes.tokens, headers: bearer(token), payload: { label: "x", password: PASSWORD } });
  assert.equal(mint.statusCode, 503);
  assert.equal((await h.local.inject({ method: "POST", url: authRoutes.secondFactorDisable, payload: {} })).statusCode, 503);
  const status = (await h.local.inject({ method: "GET", url: authRoutes.secondFactor })).json() as AuthSecondFactorStatusResponse;
  assert.deepEqual([status.enabled, status.unavailable], [true, true]);
  await factor.flush();
  assert.equal(await readFile(file, "utf8"), garbage);
});
