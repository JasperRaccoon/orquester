import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ROUTER_PRESETS,
  type RouterProvider,
  compactEnvForModel,
  createDefaultCliProxyState,
  migrateLegacyOpenRouter,
  parseCliProxySecrets,
  parseCliProxyState,
  resolveRouterModel,
  routerProviderSchema,
  validateRouterProviders
} from "@orquester/config";

const NOW = "2026-08-04T00:00:00.000Z";

const tokenrouter: RouterProvider = {
  id: "tokenrouter",
  label: "TokenRouter",
  baseUrl: "https://api.tokenrouter.com/v1",
  preset: "tokenrouter",
  models: [{ name: "moonshotai/kimi-k3-free", contextWindow: 1_048_576, compactWindow: 450_000 }],
  keyVerifiedAt: null,
  createdAt: NOW
};
const openrouter: RouterProvider = {
  id: "openrouter",
  label: "OpenRouter",
  baseUrl: "https://openrouter.ai/api/v1",
  preset: "openrouter",
  models: [
    { name: "moonshotai/kimi-k3", alias: "kimi-k3", contextWindow: 1_048_576, compactWindow: 450_000 }
  ],
  keyVerifiedAt: null,
  createdAt: NOW
};

test("routerProviderSchema rejects bad ids, bad urls, bad model names", () => {
  assert.equal(routerProviderSchema.safeParse({ ...tokenrouter, id: "Bad_Id" }).success, false);
  assert.equal(routerProviderSchema.safeParse({ ...tokenrouter, baseUrl: "ftp://x" }).success, false);
  assert.equal(
    routerProviderSchema.safeParse({ ...tokenrouter, models: [{ name: "sp ace" }] }).success,
    false
  );
  assert.equal(routerProviderSchema.safeParse(tokenrouter).success, true);
});

test("validateRouterProviders rejects reserved/duplicate ids and cross-provider model collisions", () => {
  assert.match(validateRouterProviders([{ ...tokenrouter, id: "codex" }]) ?? "", /reserved/);
  assert.match(
    validateRouterProviders([tokenrouter, { ...openrouter, id: "tokenrouter" }]) ?? "",
    /duplicate provider id/
  );
  const clash = { ...openrouter, models: [{ name: "moonshotai/kimi-k3-free" }] };
  assert.match(validateRouterProviders([tokenrouter, clash]) ?? "", /moonshotai\/kimi-k3-free/);
  assert.equal(validateRouterProviders([tokenrouter, openrouter]), null);
});

test("resolveRouterModel matches name, alias, and acc-prefixed forms", () => {
  const providers = [tokenrouter, openrouter];
  assert.equal(resolveRouterModel(providers, "kimi-k3")?.providerId, "openrouter");
  assert.equal(resolveRouterModel(providers, "moonshotai/kimi-k3-free")?.providerId, "tokenrouter");
  assert.equal(resolveRouterModel(providers, "accdeadbeef/kimi-k3")?.providerId, "openrouter");
  assert.equal(resolveRouterModel(providers, "gpt-5.6-sol"), null);
});

test("compactEnvForModel resolves router models by name or alias, overrides win", () => {
  const byAlias = compactEnvForModel("kimi-k3", undefined, [openrouter]);
  assert.deepEqual(byAlias, { maxContextTokens: 1_048_576, autoCompactWindow: 450_000 });
  const byName = compactEnvForModel("moonshotai/kimi-k3", undefined, [openrouter]);
  assert.deepEqual(byName, byAlias);
  const overridden = compactEnvForModel("kimi-k3", { "kimi-k3": { compactWindow: 100_000 } }, [
    openrouter
  ]);
  assert.equal(overridden?.autoCompactWindow, 100_000);
});

test("state/secrets schemas default the new fields; old files still parse", () => {
  const state = parseCliProxyState({ enabled: true });
  assert.deepEqual(state.routerProviders, []);
  const secrets = parseCliProxySecrets({ apiKey: "a", managementSecret: "m", openRouterKey: "sk-or-x" });
  assert.notEqual(secrets, "corrupt");
  if (secrets !== "corrupt") assert.deepEqual(secrets.routerKeys, {});
});

test("migrateLegacyOpenRouter seeds the openrouter provider and mirrors the key", () => {
  const state = { ...createDefaultCliProxyState(), openRouterKeyVerifiedAt: "2026-07-01T00:00:00.000Z" };
  const secrets = { apiKey: "a", managementSecret: "m", openRouterKey: "sk-or-x", routerKeys: {} };
  const out = migrateLegacyOpenRouter(state, secrets, NOW);
  assert.equal(out.changed, true);
  assert.equal(out.secrets.routerKeys["openrouter"], "sk-or-x");
  assert.equal(out.secrets.openRouterKey, "sk-or-x"); // mirror kept
  const p = out.state.routerProviders.find((x) => x.id === "openrouter");
  assert.equal(p?.models[0]?.alias, "kimi-k3");
  assert.equal(p?.keyVerifiedAt, "2026-07-01T00:00:00.000Z");
  // idempotent
  assert.equal(migrateLegacyOpenRouter(out.state, out.secrets, NOW).changed, false);
});

test("ROUTER_PRESETS ship openrouter and tokenrouter with prefilled models", () => {
  const ids = ROUTER_PRESETS.map((p) => p.preset);
  assert.deepEqual([...ids].sort(), ["openrouter", "tokenrouter"]);
});
