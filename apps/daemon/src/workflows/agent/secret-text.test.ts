import assert from "node:assert/strict";
import test from "node:test";
import { protectSecrets, revealSecrets } from "./secret-text.ts";

const SECRETS = { API_TOKEN: "abcd-1234-efgh", TOKEN: "abcd", SHORT: "xy" };

test("protectSecrets hides every value (longest first, ≥ 4 chars); revealSecrets restores the exact text", () => {
  const text = "token=abcd-1234-efgh; prefix abcd; short xy; again abcd-1234-efgh";
  const kept = protectSecrets(text, SECRETS);
  assert.equal(kept, "token=\uE000API_TOKEN\uE001; prefix \uE000TOKEN\uE001; short xy; again \uE000API_TOKEN\uE001");
  assert.equal(revealSecrets(kept, SECRETS), text);
});

test("a secret whose value is another secret's name never corrupts a marker", () => {
  const secrets = { API_TOKEN: "TOKEN_VALUE_1", NAME: "API_TOKEN" };
  const text = "a TOKEN_VALUE_1 b API_TOKEN c";
  const kept = protectSecrets(text, secrets);
  assert.equal(revealSecrets(kept, secrets), text);
});

test("a marker for a secret that no longer exists is sent as nothing; text without markers is untouched", () => {
  assert.equal(revealSecrets("a \uE000GONE\uE001 b", SECRETS), "a  b");
  assert.equal(revealSecrets("plain", SECRETS), "plain");
  assert.equal(protectSecrets("plain", {}), "plain");
});
