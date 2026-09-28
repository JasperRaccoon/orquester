import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cliproxyStateFile, type RouterProvider } from "@orquester/config";
import {
  cooldownKey,
  cooldownSubject,
  createUsesAccount,
  routerProvidersFromDisk
} from "./families.ts";

const providers = [
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", preset: "openrouter", models: [{ name: "moonshotai/kimi-k3", alias: "kimi-k3" }], keyVerifiedAt: null, createdAt: "2026-09-01T00:00:00.000Z" }
] as RouterProvider[];

test("routerProvidersFromDisk reads the proxy state, [] when absent or corrupt", async (t) => {
  const daemonDir = await mkdtemp(join(tmpdir(), "orquester-wf-families-"));
  t.after(() => rm(daemonDir, { recursive: true, force: true }));
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
