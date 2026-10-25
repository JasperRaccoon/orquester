import assert from "node:assert/strict";
import test from "node:test";
import { protectSecrets, revealSecrets } from "./secret-text.ts";

test("a secret whose value is another secret's name never corrupts a marker", () => {
  const secrets = { API_TOKEN: "TOKEN_VALUE_1", NAME: "API_TOKEN" };
  const text = "a TOKEN_VALUE_1 b API_TOKEN c";
  const kept = protectSecrets(text, secrets);
  assert.equal(revealSecrets(kept, secrets), text);
});

test("a marker for a secret that no longer exists is sent as nothing; text without markers is untouched", () => {
  assert.equal(revealSecrets("a \uE000GONE\uE001 b", {}), "a  b");
  assert.equal(revealSecrets("plain", {}), "plain");
  assert.equal(protectSecrets("plain", {}), "plain");
});
