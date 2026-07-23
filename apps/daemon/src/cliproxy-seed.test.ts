import test from "node:test";
import assert from "node:assert/strict";
import {
  accountPrefix,
  claudeStorageFromCredentials,
  codexStorageFromAuthJson,
  jwtClaims
} from "./cliproxy-seed.ts";

const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const fakeJwt = (payload: object) => `x.${b64url(payload)}.y`;

test("jwtClaims decodes the payload segment and tolerates malformed input", () => {
  assert.deepEqual(jwtClaims(fakeJwt({ a: 1, b: "x" })), { a: 1, b: "x" });
  assert.deepEqual(jwtClaims("not-a-jwt"), {});
  assert.deepEqual(jwtClaims(""), {});
});

test("codex conversion maps fields from tokens + id_token claim", () => {
  const idClaims = { email: "a@b.com", exp: 111, "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" } };
  const acClaims = { exp: 1785569405 };
  const authJson = {
    tokens: { id_token: fakeJwt(idClaims), access_token: fakeJwt(acClaims), refresh_token: "rt", account_id: "raw" },
    last_refresh: "2026-07-22T07:30:06Z"
  };
  const { file, storage } = codexStorageFromAuthJson(authJson) as any;
  assert.equal(storage.type, "codex");
  assert.equal(storage.email, "a@b.com");
  assert.equal(storage.account_id, "acct-123");
  assert.equal(storage.access_token, authJson.tokens.access_token);
  assert.equal(storage.refresh_token, "rt");
  assert.equal(storage.last_refresh, "2026-07-22T07:30:06Z");
  assert.equal(storage.expired, "2026-08-01T07:30:05Z"); // RFC3339 of exp 1785569405
  assert.match(file, /^codex-.*\.json$/);
});

test("claude conversion maps from claudeAiOauth and stamps a routing prefix", () => {
  const creds = { claudeAiOauth: { accessToken: "at", refreshToken: "rt", expiresAt: 1784791605497 } };
  const { file, storage } = claudeStorageFromCredentials(creds, "14137047-98b2-4cf1") as any;
  assert.equal(storage.type, "claude");
  assert.equal(storage.access_token, "at");
  assert.equal(storage.refresh_token, "rt");
  assert.equal(storage.expired, "2026-07-23T07:26:45Z"); // RFC3339 of 1784791605497 ms
  assert.equal(storage.prefix, "acc14137047"); // acc + first 8 hex, dashes stripped
  assert.match(file, /^claude-acc14137047\.json$/);
});

test("two accounts of one provider get distinct prefixes → individually routable", () => {
  const a = accountPrefix("65eebd90-01d1-4063-b743-c4a5713f5519");
  const b = accountPrefix("14137047-98b2-4cf1-9b54-b18a22a85a62");
  assert.notEqual(a, b);
  assert.equal(a, "acc65eebd90"); // "acc" + first 8 hex of the dash-stripped uuid
});

test("invalid shapes throw, not silently produce garbage", () => {
  assert.throws(() => codexStorageFromAuthJson({}, "x"), /missing tokens/);
  assert.throws(() => claudeStorageFromCredentials({}, "x"), /missing claudeAiOauth/);
});
