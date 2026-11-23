/**
 * Remote sign-in in the store: only a validated session token is ever sent; a 401 drops it and
 * shows the sign-in prompt (no retry loop); a sign-in stores the token the daemon returns and
 * nothing derived from the password. With the daemon's second factor on, the password earns a
 * challenge that only a code turns into the token.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";

import type { AuthLoginRequest, AuthSecondFactorChallenge, AuthSecondFactorLoginRequest } from "@orquester/api";

import { fakeIndexedDb } from "../lib/agent-chat/testing/indexed-db.ts";
import { ApiError, type ApiClient } from "../lib/api-client.ts";
import type { UiConnection } from "../types";
import { useAppStore } from "./app.ts";

const database = fakeIndexedDb();
globalThis.indexedDB = database.factory;
const storage = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key)
};
// Rebuilding a client opens the shared terminal WebSocket: keep it inert here.
(globalThis as { WebSocket?: unknown }).WebSocket = class {
  static OPEN = 1;
  readyState = 0;
  send(): void {}
  close(): void {}
};

const ENDPOINT = "https://orq.example.com";
const TOKEN = `orq_${"Zz09_-".repeat(7)}x`;
const LEGACY = btoa("admin:$2a$12$0123456789012345678901uFAKEfakeFAKEfakeFAKEfa");
const CONNECTION: UiConnection = { id: "remote", name: "Remote", kind: "remote", endpoint: ENDPOINT, status: "disconnected" };

let infoCalls: string[];
let loginAnswer: () => Promise<{ token: string } | AuthSecondFactorChallenge>;
let logins: AuthLoginRequest[];
let codeAnswer: (req: AuthSecondFactorLoginRequest) => Promise<{ token: string }>;
let codes: AuthSecondFactorLoginRequest[];

/** A fake client; `password` is the bearer it would send. */
function fakeApi(password?: string): ApiClient {
  return {
    connection: { ...CONNECTION, ...(password !== undefined ? { password } : {}) },
    authInfo: async () => ({ authRequired: true, requiresUsername: true }),
    info: async () => {
      infoCalls.push(password ?? "");
      throw new ApiError(401, "GET", "/api/info");
    },
    login: async (req: AuthLoginRequest) => {
      logins.push(req);
      return loginAnswer();
    },
    loginSecondFactor: async (req: AuthSecondFactorLoginRequest) => {
      codes.push(req);
      return codeAnswer(req);
    }
  } as unknown as ApiClient;
}

const store = () => useAppStore.getState();

beforeEach(async () => {
  await database.idle();
  for (const store of ["thread-meta", "thread-body"]) {
    for (const row of await database.all(store)) await database.remove(store, row.key as string);
  }
  storage.clear();
  infoCalls = [];
  logins = [];
  loginAnswer = async () => ({ token: TOKEN });
  codes = [];
  codeAnswer = async () => assert.fail("no code was expected");
  useAppStore.setState({ authPrompt: null, authError: null, connections: [CONNECTION], activeConnectionId: CONNECTION.id });
});

describe("establish", () => {
  it("never sends an older build's credential: it prompts for a sign-in instead", async () => {
    storage.set(`orquester.session:${ENDPOINT}`, LEGACY);
    storage.set(`orquester.auth:${ENDPOINT}`, "$2a$12$legacyhash");
    const api = fakeApi(LEGACY);
    useAppStore.setState({ api });
    await store().establish(api);
    assert.deepEqual(infoCalls, [], "no authenticated request was made");
    assert.deepEqual(store().authPrompt, { connectionId: CONNECTION.id });
    assert.equal(storage.has(`orquester.session:${ENDPOINT}`), false, "the invalid stored value is dropped");
    assert.equal(storage.has(`orquester.auth:${ENDPOINT}`), false, "the legacy password hash is purged");
  });

  it("a 401 drops the token, forgets it in memory and prompts once", async () => {
    storage.set(`orquester.session:${ENDPOINT}`, TOKEN);
    const api = fakeApi(TOKEN);
    useAppStore.setState({ api });
    await store().establish(api);
    assert.deepEqual(infoCalls, [TOKEN]);
    assert.ok(!store().api?.connection.password, "the client no longer carries the dead token");
    assert.equal(storage.has(`orquester.session:${ENDPOINT}`), false);
    assert.deepEqual(store().authPrompt, { connectionId: CONNECTION.id });
    assert.equal(store().connectionStatus, "error");
  });

  it("a stored token answered with the lockout's 429 is dead too: it is dropped for a sign-in, not waited out", async () => {
    // The daemon locks out an address only for refused tokens, so waiting out
    // Retry-After would just send the dead token again.
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      storage.set(`orquester.session:${ENDPOINT}`, TOKEN);
      const api = {
        ...fakeApi(TOKEN),
        info: async () => {
          infoCalls.push(TOKEN);
          throw new ApiError(429, "GET", "/api/info", { "retry-after": "25603" }, { code: "TOO_MANY_ATTEMPTS" });
        }
      } as unknown as ApiClient;
      useAppStore.setState({ api });
      await store().establish(api);
      assert.deepEqual(infoCalls, [TOKEN]);
      assert.equal(storage.has(`orquester.session:${ENDPOINT}`), false);
      assert.ok(!store().api?.connection.password, "the client no longer carries the dead token");
      assert.deepEqual(store().authPrompt, { connectionId: CONNECTION.id });
      assert.equal(store().lockedUntil, null, "no lockout countdown to wait out");
    } finally {
      mock.timers.reset();
    }
  });

  it("a 429 that is not the bearer lockout (a GitHub rate limit) keeps the sign-in", () => {
    storage.set(`orquester.session:${ENDPOINT}`, TOKEN);
    const api = fakeApi(TOKEN) as unknown as ApiClient;
    useAppStore.setState({ api, authPrompt: null });
    store().credentialRefused(api, new ApiError(429, "GET", "/api/github/links", {}, { code: "RATE_LIMITED" }));
    assert.equal(storage.get(`orquester.session:${ENDPOINT}`), TOKEN);
    assert.equal(store().authPrompt, null);
    store().credentialRefused(api, new ApiError(429, "GET", "/api/system/resources", {}, { code: "TOO_MANY_ATTEMPTS" }));
    assert.equal(storage.has(`orquester.session:${ENDPOINT}`), false, "the bearer lockout's 429 does drop it");
  });
});

describe("establish on a bad link", () => {
  it("an auth-info request that got no answer is retried, never taken for 'no sign-in needed'", async () => {
    storage.set(`orquester.session:${ENDPOINT}`, TOKEN);
    const api = {
      ...fakeApi(TOKEN),
      authInfo: async () => {
        throw new TypeError("Failed to fetch");
      }
    } as unknown as ApiClient;
    useAppStore.setState({ api });
    await assert.rejects(store().establish(api), TypeError, "the caller's backoff loop takes it");
    assert.deepEqual(infoCalls, [], "no request went out without the stored token");
    assert.equal(storage.get(`orquester.session:${ENDPOINT}`), TOKEN, "the sign-in is kept");
  });

  it("a daemon that answers without auth info (an older build's 404) still needs no sign-in", async () => {
    const api = {
      ...fakeApi(),
      authInfo: async () => {
        throw new ApiError(404, "GET", "/api/auth/info");
      }
    } as unknown as ApiClient;
    useAppStore.setState({ api, authPrompt: null });
    await store().establish(api);
    assert.deepEqual(infoCalls, [""], "the pre-check ran, unauthenticated, as before");
  });

});

describe("the chats this device saved", () => {
  // Existing schema keys are fixtures: clearing auth must delete both halves, only for that daemon.
  const ours = `remote|${ENDPOINT}\u0000s1`;
  const theirs = "remote|https://other.example\u0000s1";
  async function seed(keys: string[]) {
    for (const store of ["thread-meta", "thread-body"]) for (const key of keys) await database.put(store, { key });
  }
  async function assertKeys(expected: string[]) {
    for (const store of ["thread-meta", "thread-body"]) assert.deepEqual((await database.all(store)).map((row) => row.key), expected);
  }

  it("go with the credential when the daemon refuses it — that daemon's alone", async () => {
    await seed([ours, theirs]);
    const api = fakeApi(TOKEN);
    useAppStore.setState({ api });
    await store().establish(api);
    await database.idle();
    await assertKeys([theirs]);
  });

  it("go when the remote is removed", async () => {
    await seed([ours, theirs]);
    useAppStore.setState({ activeConnectionId: "local" });
    await store().removeRemote(CONNECTION.id);
    await database.idle();
    await assertKeys([theirs]);
  });

  it("go on sign-out", async () => {
    await seed([ours]);
    const api = { ...fakeApi(TOKEN), logout: async () => {} } as unknown as ApiClient;
    useAppStore.setState({ api });
    await store().signOut();
    await database.idle();
    await assertKeys([]);
  });
});

describe("submitCredentials", () => {
  it("stores the returned token and the username, never the password", async () => {
    let connected = 0;
    useAppStore.setState({ api: fakeApi(), connect: async () => void (connected += 1) });
    await store().submitCredentials("  Admin ", "hunter2hunter2");
    assert.deepEqual(logins, [{ username: "admin", password: "hunter2hunter2" }]);
    assert.equal(storage.get(`orquester.session:${ENDPOINT}`), TOKEN);
    assert.equal(storage.get(`orquester.user:${ENDPOINT}`), "admin");
    assert.ok(![...storage.values()].some((value) => value.includes("hunter2")), "no password at rest");
    assert.equal(store().api?.connection.password, TOKEN);
    assert.equal(store().authPrompt, null);
    assert.equal(connected, 1);
  });

  it("a wrong password or a lockout keeps the prompt with its reason and stores nothing", async () => {
    useAppStore.setState({ api: fakeApi(), authPrompt: { connectionId: CONNECTION.id }, connect: async () => assert.fail("must not connect") });
    loginAnswer = async () => {
      throw new ApiError(401, "POST", "/api/auth/login");
    };
    await store().submitCredentials("admin", "wrong");
    assert.ok(store().authError?.trim(), "a rejected login supplies a reason");
    assert.deepEqual(store().authPrompt, { connectionId: CONNECTION.id });
    assert.equal(store().api?.connection.password, undefined);
    assert.equal(storage.size, 0);

    loginAnswer = async () => {
      throw new ApiError(429, "POST", "/api/auth/login", { "retry-after": "900" });
    };
    await store().submitCredentials("admin", "wrong");
    assert.match(store().authError ?? "", /\b900\s*(?:s|seconds?)\b/i, "the reason includes Retry-After seconds");
    assert.deepEqual(store().authPrompt, { connectionId: CONNECTION.id });
    assert.equal(store().api?.connection.password, undefined);
    assert.equal(storage.size, 0);
  });

  it("refuses a response that is not a token", async () => {
    useAppStore.setState({ api: fakeApi(), connect: async () => assert.fail("must not connect") });
    loginAnswer = async () => ({ token: LEGACY });
    await store().submitCredentials("admin", "pw");
    assert.equal(storage.has(`orquester.session:${ENDPOINT}`), false);
    assert.ok(store().authError, "an invalid token response supplies an error");
  });
});

describe("a sign-in with the second factor on", () => {
  const CHALLENGE = "challenge-1";
  const inFiveMinutes = () => new Date(Date.now() + 5 * 60_000).toISOString();
  const refused = (code: string) => new ApiError(401, "POST", "/api/auth/login/second-factor", undefined, { code, message: "refused" });

  it("asks for a code after the password; a wrong one keeps that step, the right one connects", async () => {
    let connected = 0;
    useAppStore.setState({ api: fakeApi(), authPrompt: { connectionId: CONNECTION.id }, connectionError: null, connect: async () => void (connected += 1) });
    loginAnswer = async () => ({ secondFactorRequired: true, challenge: CHALLENGE, expiresAt: inFiveMinutes() });
    await store().submitCredentials("Admin", "hunter2hunter2");
    assert.equal(store().authPrompt?.secondFactor?.challenge, CHALLENGE, "the prompt moved to the code step");
    assert.equal(store().api?.connection.password, undefined, "a challenge is not a credential");

    codeAnswer = async ({ code }) => {
      if (code !== "123456") throw refused("INVALID_CODE");
      return { token: TOKEN };
    };
    await store().submitSecondFactor("000000");
    assert.ok(store().authError?.trim(), "a wrong code supplies a reason");
    assert.equal(store().authPrompt?.secondFactor?.challenge, CHALLENGE, "a wrong code keeps the code step");
    assert.equal(store().connectionError, null, "a refused code is not a session that ended");
    assert.ok(![...storage.values()].some((value) => value.includes(CHALLENGE)), "the challenge is never stored");

    await store().submitSecondFactor(" 123456 ");
    assert.deepEqual(codes, [
      { challenge: CHALLENGE, code: "000000" },
      { challenge: CHALLENGE, code: "123456" }
    ]);
    assert.equal(storage.get(`orquester.session:${ENDPOINT}`), TOKEN);
    assert.equal(storage.get(`orquester.user:${ENDPOINT}`), "admin");
    assert.ok(![...storage.values()].some((value) => value.includes(CHALLENGE) || value.includes("hunter2")));
    assert.equal(store().api?.connection.password, TOKEN);
    assert.equal(store().authPrompt, null);
    assert.equal(connected, 1);
  });

  it("returns to the password when the daemon says the challenge expired", async () => {
    useAppStore.setState({ api: fakeApi(), connect: async () => assert.fail("must not connect") });
    useAppStore.setState({ authPrompt: { connectionId: CONNECTION.id, secondFactor: { challenge: CHALLENGE, username: "admin" } } });
    codeAnswer = async () => {
      throw refused("CHALLENGE_EXPIRED");
    };
    await store().submitSecondFactor("123456");
    assert.deepEqual(store().authPrompt, { connectionId: CONNECTION.id }, "back at the password step");
    assert.ok(store().authError?.trim(), "the user is told why");
    assert.equal(storage.size, 0);
  });

  it("sends the code even when this device's clock is already past the server's expiresAt", async () => {
    let connected = 0;
    useAppStore.setState({ api: fakeApi(), authPrompt: { connectionId: CONNECTION.id }, connect: async () => void (connected += 1) });
    // A client clock running ten minutes fast sees a five-minute challenge as long gone.
    loginAnswer = async () => ({ secondFactorRequired: true, challenge: CHALLENGE, expiresAt: new Date(Date.now() - 5 * 60_000).toISOString() });
    await store().submitCredentials("admin", "hunter2hunter2");
    codeAnswer = async () => ({ token: TOKEN });
    await store().submitSecondFactor("123456");
    assert.deepEqual(codes, [{ challenge: CHALLENGE, code: "123456" }]);
    assert.equal(storage.get(`orquester.session:${ENDPOINT}`), TOKEN);
    assert.equal(store().authPrompt, null);
    assert.equal(connected, 1);
  });
});

describe("the remote list on a client whose home is the remote (web)", () => {
  const REMOTES = [{ id: "other", name: "Other", kind: "remote" as const, baseUrl: "https://other.example" }];

  /** Set the web client up the way its page does: its home connection is the remote itself. */
  async function signedInHome(listRemotes: () => Promise<unknown>) {
    useAppStore.setState({ connect: async () => undefined, connectionStatus: "disconnected" });
    await store().initConnections({ localConnection: CONNECTION, localTransporter: { kind: "stub" } as never, defaultUseTitlebar: false });
    storage.set(`orquester.session:${ENDPOINT}`, TOKEN);
    useAppStore.setState({ api: { ...fakeApi(TOKEN), listRemotes } as unknown as ApiClient, connectionStatus: "connected" });
  }

  it("is read with the sign-in", async () => {
    await signedInHome(async () => REMOTES);
    await store().loadRemotes();
    assert.deepEqual(
      store().connections.map((c) => c.id),
      [CONNECTION.id, "other"]
    );
  });

  it("a refused sign-in there asks for a new one instead of being retried on every connect", async () => {
    await signedInHome(async () => {
      throw new ApiError(401, "GET", "/api/config/remotes");
    });
    await store().loadRemotes();
    assert.equal(storage.has(`orquester.session:${ENDPOINT}`), false);
    assert.deepEqual(store().authPrompt, { connectionId: CONNECTION.id });
  });
});
