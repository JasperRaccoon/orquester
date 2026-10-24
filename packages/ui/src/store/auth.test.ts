/**
 * Remote sign-in in the store: only a validated session token is ever sent; a 401 drops it and
 * shows the sign-in prompt (no retry loop); a sign-in stores the token the daemon returns and
 * nothing derived from the password.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { AuthLoginRequest } from "@orquester/api";

import { ApiError, type ApiClient } from "../lib/api-client.ts";
import type { UiConnection } from "../types";
import { useAppStore } from "./app.ts";

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
let loginAnswer: () => Promise<{ token: string }>;
let logins: AuthLoginRequest[];

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
    }
  } as unknown as ApiClient;
}

const store = () => useAppStore.getState();

beforeEach(() => {
  storage.clear();
  infoCalls = [];
  logins = [];
  loginAnswer = async () => ({ token: TOKEN });
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
    assert.match(store().authError ?? "", /sign in again/i);
  });
});

describe("establish on a bad link", () => {
  it("an auth-info request that got no answer is retried, never taken for 'no sign-in needed'", async () => {
    storage.set(`orquester.session:${ENDPOINT}`, TOKEN);
    const signals: Array<AbortSignal | undefined> = [];
    const api = {
      ...fakeApi(TOKEN),
      authInfo: async (signal?: AbortSignal) => {
        signals.push(signal);
        throw new TypeError("Failed to fetch");
      }
    } as unknown as ApiClient;
    useAppStore.setState({ api });
    await assert.rejects(store().establish(api), TypeError, "the caller's backoff loop takes it");
    assert.deepEqual(infoCalls, [], "no request went out without the stored token");
    assert.equal(storage.get(`orquester.session:${ENDPOINT}`), TOKEN, "the sign-in is kept");
    assert.ok(signals[0] instanceof AbortSignal, "the request is bounded by a timeout");
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

  it("the credential pre-check is bounded by a timeout too", async () => {
    storage.set(`orquester.session:${ENDPOINT}`, TOKEN);
    let signal: AbortSignal | undefined;
    const api = {
      ...fakeApi(TOKEN),
      info: async (given?: AbortSignal) => {
        signal = given;
        throw new TypeError("Failed to fetch");
      }
    } as unknown as ApiClient;
    useAppStore.setState({ api });
    await assert.rejects(store().establish(api), TypeError);
    assert.ok(signal instanceof AbortSignal);
    assert.equal(storage.get(`orquester.session:${ENDPOINT}`), TOKEN);
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
    assert.equal(store().authError, "Incorrect username or password.");
    assert.equal(storage.size, 0);

    loginAnswer = async () => {
      throw new ApiError(429, "POST", "/api/auth/login", { "retry-after": "900" });
    };
    await store().submitCredentials("admin", "wrong");
    assert.equal(store().authError, "Too many failed attempts. Try again in 900s.");
    assert.deepEqual(store().authPrompt, { connectionId: CONNECTION.id });
  });

  it("refuses a response that is not a token", async () => {
    useAppStore.setState({ api: fakeApi(), connect: async () => assert.fail("must not connect") });
    loginAnswer = async () => ({ token: LEGACY });
    await store().submitCredentials("admin", "pw");
    assert.equal(storage.has(`orquester.session:${ENDPOINT}`), false);
    assert.match(store().authError ?? "", /invalid session token/);
  });
});
