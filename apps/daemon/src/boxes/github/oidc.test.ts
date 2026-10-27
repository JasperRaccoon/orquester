import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import test from "node:test";

import type { GithubOidcExpectation } from "../contracts.ts";
import {
  createGithubOidcVerifier,
  GITHUB_OIDC_ISSUER,
  githubOidcAudience,
  parseGithubOidcAuthorization
} from "./oidc.ts";

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const NOW_S = Math.floor(NOW / 1000);
const EXPECT: GithubOidcExpectation = {
  repository: "Arakuma-Studio/orquester-macos-boxes",
  runId: "1234567890",
  audience: "https://orq.example.com:8443"
};

function keyPair(): { privateKey: KeyObject; jwk: Record<string, unknown> } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { privateKey, jwk: publicKey.export({ format: "jwk" }) as Record<string, unknown> };
}

const primary = keyPair();
const other = keyPair();

function jwt(claims: Record<string, unknown>, options: { kid?: string; key?: KeyObject; alg?: string } = {}): string {
  const header = { alg: options.alg ?? "RS256", typ: "JWT", kid: options.kid ?? "key-1" };
  const payload = {
    iss: GITHUB_OIDC_ISSUER,
    aud: EXPECT.audience,
    repository: EXPECT.repository,
    run_id: EXPECT.runId,
    iat: NOW_S - 10,
    nbf: NOW_S - 10,
    exp: NOW_S + 300,
    ...claims
  };
  const data = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  const signature = sign("RSA-SHA256", Buffer.from(data), options.key ?? primary.privateKey);
  return `${data}.${signature.toString("base64url")}`;
}

/** A fetch serving GitHub's discovery document and a JWKS; counts JWKS fetches. */
function fakeGithub(keys: Array<Record<string, unknown>>): { fetch: typeof fetch; jwksFetches: () => number; setKeys: (k: Array<Record<string, unknown>>) => void } {
  let current = keys;
  let count = 0;
  const doFetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === `${GITHUB_OIDC_ISSUER}/.well-known/openid-configuration`) {
      return Response.json({ issuer: GITHUB_OIDC_ISSUER, jwks_uri: `${GITHUB_OIDC_ISSUER}/.well-known/jwks` });
    }
    if (url === `${GITHUB_OIDC_ISSUER}/.well-known/jwks`) {
      count += 1;
      return Response.json({ keys: current });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetch: doFetch, jwksFetches: () => count, setKeys: (k) => (current = k) };
}

const signal = new AbortController().signal;

test("accepts a correctly signed token for the expected run and caches the keys", async (t) => {
  const github = fakeGithub([{ ...primary.jwk, kid: "key-1", use: "sig", alg: "RS256" }]);
  const verify = createGithubOidcVerifier();
  t.mock.method(globalThis, "fetch", github.fetch);
  const options = { signal, now: () => NOW };
  assert.deepEqual(await verify(jwt({}), EXPECT, options), { ok: true });
  // Repository names compare case-insensitively; a numeric run_id claim is accepted.
  assert.deepEqual(await verify(jwt({ repository: "arakuma-studio/Orquester-macOS-boxes", run_id: 1234567890 }), EXPECT, options), { ok: true });
  assert.deepEqual(await verify(jwt({ aud: ["other", EXPECT.audience] }), EXPECT, options), { ok: true });
  assert.equal(github.jwksFetches(), 1);
});

test("rejects wrong claims, bad signatures and unsupported tokens with a reason", async (t) => {
  const github = fakeGithub([{ ...primary.jwk, kid: "key-1" }]);
  const verify = createGithubOidcVerifier();
  t.mock.method(globalThis, "fetch", github.fetch);
  const options = { signal, now: () => NOW };
  const cases: Array<[string, RegExp]> = [
    [jwt({ iss: "https://evil.example.com" }), /not issued by GitHub/],
    [jwt({ aud: "https://other.example.com" }), /audience/],
    [jwt({ repository: "someone/else" }), /different repository/],
    [jwt({ run_id: "999" }), /different workflow run/],
    [jwt({ exp: NOW_S - 120 }), /expired/],
    [jwt({ nbf: NOW_S + 300 }), /not valid yet/],
    [jwt({ iat: NOW_S + 300 }), /future/],
    [jwt({}, { key: other.privateKey }), /signature is invalid/],
    [jwt({}, { alg: "HS256" }), /algorithm/],
    ["not-a-jwt", /not a JWT/],
    ["a.b", /not a JWT/]
  ];
  for (const [token, reason] of cases) {
    const result = await verify(token, EXPECT, options);
    assert.equal(result.ok, false);
    assert.match((result as { message: string }).message, reason);
    assert.ok(!(result as { message: string }).message.includes(token), "the message never quotes the token");
  }
  // Within the skew window: expired 30 s ago still passes.
  assert.deepEqual(await verify(jwt({ exp: NOW_S - 30 }), EXPECT, options), { ok: true });
});

test("an unknown kid refetches the keys (rotation), but not more than once a minute", async (t) => {
  const github = fakeGithub([{ ...primary.jwk, kid: "key-1" }]);
  const verify = createGithubOidcVerifier();
  let now = NOW;
  t.mock.method(globalThis, "fetch", github.fetch);
  const options = { signal, now: () => now };
  assert.deepEqual(await verify(jwt({}), EXPECT, options), { ok: true });

  github.setKeys([{ ...primary.jwk, kid: "key-1" }, { ...other.jwk, kid: "key-2" }]);
  const rotated = jwt({}, { kid: "key-2", key: other.privateKey });
  assert.match(((await verify(rotated, EXPECT, options)) as { message: string }).message, /unknown key/);
  assert.equal(github.jwksFetches(), 1);

  now += 61_000;
  assert.deepEqual(await verify(rotated, EXPECT, options), { ok: true });
  assert.equal(github.jwksFetches(), 2);
});

test("a discovery failure is reported, not thrown", async (t) => {
  const verify = createGithubOidcVerifier();
  const failing = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
  t.mock.method(globalThis, "fetch", failing);
  const result = await verify(jwt({}), EXPECT, { signal, now: () => NOW });
  assert.equal(result.ok, false);
  assert.match((result as { message: string }).message, /signing keys.*HTTP 503/);
});

test("the GitHubOIDC authorization header and audience helpers", () => {
  const token = jwt({});
  assert.deepEqual(parseGithubOidcAuthorization(`GitHubOIDC ${token}`, "box-0123456789ab"), { jwt: token, boxId: "box-0123456789ab" });
  assert.equal(parseGithubOidcAuthorization(`Bearer ${token}`, "box-0123456789ab"), null);
  assert.equal(parseGithubOidcAuthorization(`GitHubOIDC ${token}`, undefined), null);
  assert.equal(parseGithubOidcAuthorization(`GitHubOIDC ${token}`, "bad id!"), null);
  assert.equal(githubOidcAudience("https://ryzen7700.taila64f1b.ts.net:8443/t4"), "https://ryzen7700.taila64f1b.ts.net:8443");
  assert.equal(githubOidcAudience("https://orq.example.com/"), "https://orq.example.com");
});
