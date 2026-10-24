import test from "node:test";
import assert from "node:assert/strict";

import { asSessionToken, clearStoredToken, loadStoredToken, storeToken } from "./auth.ts";
import { toRemoteConfig, toUiConnection } from "./connections.ts";

const ENDPOINT = "https://orq.example.com";
const TOKEN = `orq_${"a1B2-c3_D4".repeat(4)}xyz`;
const LEGACY = btoa("admin:$2a$12$0123456789012345678901uFAKEfakeFAKEfakeFAKEfa");

/** Run `body` against an in-memory localStorage seeded with `seed`; returns what is left. */
function withStorage(seed: Record<string, string>, body: () => void): Map<string, string> {
  const store = new Map(Object.entries(seed));
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key)
    }
  });
  try {
    body();
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
  return store;
}

test("only token-shaped values count as a session token", () => {
  assert.equal(TOKEN.length, 47);
  assert.equal(asSessionToken(TOKEN), TOKEN);
  assert.equal(asSessionToken(LEGACY), undefined, "an older build's base64(user:hash) credential");
  assert.equal(asSessionToken("$2a$12$0123456789012345678901uFAKEfakeFAKEfakeFAKEfa"), undefined);
  assert.equal(asSessionToken(`${TOKEN} `), undefined);
  assert.equal(asSessionToken(`orq_${"a".repeat(42)}`), undefined);
  assert.equal(asSessionToken(42), undefined);
  assert.equal(asSessionToken(undefined), undefined);
});

test("a stored token round-trips; garbage is dropped from storage; the legacy hash is purged", () => {
  let loaded: string | undefined;
  const left = withStorage({ [`orquester.auth:${ENDPOINT}`]: "$2a$12$legacyhash" }, () => {
    storeToken(ENDPOINT, TOKEN);
    loaded = loadStoredToken(ENDPOINT);
  });
  assert.equal(loaded, TOKEN);
  assert.equal(left.has(`orquester.auth:${ENDPOINT}`), false, "the password-equivalent hash does not linger");

  const garbage = withStorage({ [`orquester.session:${ENDPOINT}`]: LEGACY }, () => {
    loaded = loadStoredToken(ENDPOINT);
  });
  assert.equal(loaded, undefined);
  assert.equal(garbage.has(`orquester.session:${ENDPOINT}`), false);

  const cleared = withStorage({ [`orquester.session:${ENDPOINT}`]: TOKEN, [`orquester.user:${ENDPOINT}`]: "admin" }, () => {
    clearStoredToken(ENDPOINT);
  });
  assert.deepEqual([...cleared.keys()], [`orquester.user:${ENDPOINT}`], "the username stays to pre-fill the next sign-in");
});

test("storage that throws reads as no token", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("SecurityError");
    }
  });
  try {
    assert.equal(loadStoredToken(ENDPOINT), undefined);
    assert.doesNotThrow(() => storeToken(ENDPOINT, TOKEN));
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("a remote's configured password is carried only when it is a token", () => {
  const remote = { id: "vps", name: "VPS", kind: "remote" as const, baseUrl: ENDPOINT };
  assert.equal(toUiConnection({ ...remote, password: TOKEN }).password, TOKEN);
  assert.equal(toUiConnection({ ...remote, password: LEGACY }).password, undefined);
  assert.equal(toRemoteConfig(toUiConnection({ ...remote, password: LEGACY })).password, undefined);
});
