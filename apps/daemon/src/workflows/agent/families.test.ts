import assert from "node:assert/strict";
import test from "node:test";
import { accountFamilyOf, cooldownKey, cooldownSubject } from "./families.ts";

test("accountFamilyOf: an agent's accounts are its own family's; OpenCode and unknown agents have none", () => {
  for (const refId of ["claude", "codex", "grok"]) assert.equal(accountFamilyOf(refId), refId, refId);
  assert.equal(accountFamilyOf("opencode"), null);
  assert.equal(accountFamilyOf("deepseek"), null);
  // Launchers a removed build offered: no family here, the catalogue refuses them.
  assert.equal(accountFamilyOf("claudex"), null);
  assert.equal(accountFamilyOf("claudemix"), null);
  assert.equal(accountFamilyOf("toString"), null, "no prototype keys");
});

test("cooldownSubject: one key per quota — accountless launches keyed by provider", () => {
  const key = (refId: string, model: string, accountId = "system"): string => {
    const s = cooldownSubject(refId, model, accountId);
    return cooldownKey(s.family, s.account);
  };
  // Managed accounts: the family and the account.
  assert.equal(key("claude", "opus", "a1"), "claude:a1");
  assert.equal(key("claude", "opus"), "claude:system");
  assert.equal(key("codex", "gpt-5.5"), "codex:system");
  assert.equal(key("grok", "grok-build", "g1"), "grok:g1");
  // Accountless: one key per provider.
  assert.equal(key("opencode", "anthropic/claude-sonnet"), "opencode:provider:anthropic");
  assert.equal(key("opencode", "openai/gpt-5"), "opencode:provider:openai");
  assert.equal(key("opencode", "bare-model"), "opencode:model:bare-model");
  assert.notEqual(key("opencode", "anthropic/claude-sonnet"), key("opencode", "openai/gpt-5"));
});
