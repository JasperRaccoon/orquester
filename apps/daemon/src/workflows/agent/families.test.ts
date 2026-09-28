import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cliproxyStateFile, type RouterProvider } from "@orquester/config";
import { proxyAccountFamily } from "../../agent-chat/service.ts";
import {
  accountFamilyOf,
  cooldownKey,
  cooldownSubject,
  createUsesAccount,
  defaultUsesAccount,
  isProxyLauncher,
  routerProvidersFromDisk
} from "./families.ts";

test("accountFamilyOf follows the daemon's proxyAccountFamily(refId) ?? refId", () => {
  for (const refId of ["claude", "claudex", "claudemix", "codex", "grok"]) {
    assert.equal(accountFamilyOf(refId), proxyAccountFamily(refId) ?? refId, refId);
  }
  assert.equal(accountFamilyOf("claudex"), "codex");
  assert.equal(accountFamilyOf("claudemix"), "claude");
  assert.equal(accountFamilyOf("opencode"), null);
  assert.equal(accountFamilyOf("deepseek"), null);
  assert.equal(accountFamilyOf("toString"), null, "no prototype keys");
});

test("isProxyLauncher is exactly the proxy launchers", () => {
  for (const refId of ["claude", "claudex", "claudemix", "codex", "grok", "opencode"]) {
    assert.equal(isProxyLauncher(refId), proxyAccountFamily(refId) !== null, refId);
  }
});

const providers = [
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", preset: "openrouter", models: [{ name: "moonshotai/kimi-k3", alias: "kimi-k3" }], keyVerifiedAt: null, createdAt: "2026-09-01T00:00:00.000Z" }
] as RouterProvider[];

test("usesAccount: router and xAI claudex models carry no account; claudemix always does", () => {
  const uses = createUsesAccount(() => providers);
  assert.equal(uses("claudex", "gpt-5.5"), true);
  assert.equal(uses("claudex", "kimi-k3"), false, "by alias");
  assert.equal(uses("claudex", "moonshotai/kimi-k3"), false, "by name");
  assert.equal(uses("claudex", "acc1a2b/kimi-k3"), false, "account-prefixed");
  assert.equal(uses("claudex", "grok-4.5"), false);
  assert.equal(uses("claudex", "grok-build-0.1"), false);
  assert.equal(uses("claudemix", "kimi-k3"), true);
  assert.equal(uses("claude", "claude-opus-5"), true);
  assert.equal(uses("codex", "gpt-5.5"), true);
  assert.equal(uses("grok", "grok-build"), true);
  assert.equal(uses("opencode", "anthropic/claude-sonnet"), false);
  assert.equal(defaultUsesAccount("claudex", "kimi-k3"), true, "without the proxy state a router model is unknown");
  assert.equal(defaultUsesAccount("claudex", "grok-4.5"), false);
});

test("routerProvidersFromDisk reads the proxy state, [] when absent or corrupt", async () => {
  const daemonDir = await mkdtemp(join(tmpdir(), "orquester-wf-families-"));
  assert.deepEqual(routerProvidersFromDisk(daemonDir), []);
  const file = cliproxyStateFile(daemonDir);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, "{not json", "utf8");
  assert.deepEqual(routerProvidersFromDisk(daemonDir), []);
  await writeFile(file, JSON.stringify({ routerProviders: providers }), "utf8");
  assert.deepEqual(routerProvidersFromDisk(daemonDir).map((p) => p.id), ["openrouter"]);
});

test("cooldownSubject: one key per quota — accountless launches keyed by provider, the proxy's pick apart", () => {
  const uses = createUsesAccount(() => [
    ...providers,
    { ...providers[0]!, id: "tokenrouter", label: "TokenRouter", preset: "tokenrouter", models: [{ name: "deepseek-v4" }] }
  ] as RouterProvider[]);
  const key = (refId: string, model: string, accountId = "system"): string => {
    const s = cooldownSubject(refId, model, accountId, uses);
    return cooldownKey(s.family, s.account);
  };
  // Managed accounts: the family and the account, as before.
  assert.equal(key("claude", "opus", "a1"), "claude:a1");
  assert.equal(key("claude", "opus"), "claude:system");
  assert.equal(key("codex", "gpt-5.5"), "codex:system");
  assert.equal(key("claudex", "gpt-5.5", "c1"), "codex:c1", "a seeded codex account is that account's quota");
  assert.equal(key("claudemix", "opus", "a1"), "claude:a1");
  // The proxy launchers' own pick is never the family's system login.
  assert.equal(key("claudex", "gpt-5.5"), "claudex:proxy");
  assert.equal(key("claudemix", "opus"), "claudemix:proxy");
  // Accountless: one key per provider.
  assert.equal(key("opencode", "anthropic/claude-sonnet"), "opencode:provider:anthropic");
  assert.equal(key("opencode", "openai/gpt-5"), "opencode:provider:openai");
  assert.equal(key("opencode", "bare-model"), "opencode:model:bare-model");
  assert.equal(key("claudex", "kimi-k3"), "claudex:router:openrouter");
  assert.equal(key("claudex", "acc1a2b/kimi-k3"), "claudex:router:openrouter");
  assert.equal(key("claudex", "deepseek-v4"), "claudex:router:tokenrouter");
  assert.equal(key("claudex", "grok-4.5"), "claudex:xai");
  assert.equal(key("claudex", "grok-build-0.1"), "claudex:xai");
  assert.notEqual(key("claudex", "kimi-k3"), key("claudex", "grok-4.5"));
  assert.notEqual(key("claudex", "grok-4.5"), key("codex", "gpt-5.5"));
  // Without the proxy state xAI is still known; a router model reads as an account launch (the proxy's pick).
  assert.deepEqual(cooldownSubject("claudex", "grok-4.5", "system"), { family: "claudex", account: "xai" });
  assert.deepEqual(cooldownSubject("claudex", "kimi-k3", "system"), { family: "claudex", account: "proxy" });
  // A bare predicate that knows a model is accountless but names no provider keys it by the model.
  const plain = (refId: string, model: string): boolean => !(refId === "claudex" && model === "kimi-k3");
  assert.deepEqual(cooldownSubject("claudex", "kimi-k3", "system", plain), { family: "claudex", account: "model:kimi-k3" });
});
