import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CURATED_PROXY_MODEL_IDS,
  ROUTER_PRESETS,
  type RouterProvider,
  compactEnvForModel,
  createDefaultCliProxyState,
  getRouterKey,
  migrateLegacyOpenRouter,
  parseCliProxySecrets,
  parseCliProxyState,
  resolveRouterModel,
  routerKeyCheckUrl,
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

test("validateRouterProviders refuses a router model that shadows a curated model id", () => {
  // resolveRouterModel is the single routing source of truth: a router model named
  // `gpt-5.6-sol` would steal that curated pick (no acc<hex>/ prefix, seeded-account
  // gate skipped, two config.yaml providers for one id).
  const curated = CURATED_PROXY_MODEL_IDS[0] as string;
  assert.match(
    validateRouterProviders([{ ...tokenrouter, models: [{ name: curated }] }]) ?? "",
    /built-in model id/
  );
  assert.match(
    validateRouterProviders([
      { ...tokenrouter, models: [{ name: "vendor/whatever", alias: curated }] }
    ]) ?? "",
    /built-in model id/
  );
});

test("compactEnvForModel emits a router model's compact window even without a context window", () => {
  // The Routers model editor exposes "window" and "compact at" independently; a
  // compact-only entry must still arm auto-compaction rather than silently vanish.
  const compactOnly: RouterProvider = {
    ...tokenrouter,
    models: [{ name: "vendor/only-compact", compactWindow: 200_000 }]
  };
  assert.deepEqual(compactEnvForModel("vendor/only-compact", undefined, [compactOnly]), {
    autoCompactWindow: 200_000
  });
  // An override-supplied compact window works the same way.
  const bare: RouterProvider = { ...tokenrouter, models: [{ name: "vendor/bare" }] };
  assert.deepEqual(
    compactEnvForModel("vendor/bare", { "vendor/bare": { compactWindow: 50_000 } }, [bare]),
    { autoCompactWindow: 50_000 }
  );
  // Neither field set → still unknown (reactive-only), as before.
  assert.equal(compactEnvForModel("vendor/bare", undefined, [bare]), null);
});

test("migrateLegacyOpenRouter skips the seeded record when it would collide with a user provider", () => {
  // Router CRUD works while the proxy is OFF but the migration only runs on
  // init()/enable(), so a user can already serve `kimi-k3` themselves. Appending
  // the seeded openrouter record blindly would persist a duplicate model across
  // two providers — the exact invariant validateRouterProviders guards.
  const mine: RouterProvider = {
    id: "mygateway",
    label: "My Gateway",
    baseUrl: "https://gw.example/v1",
    preset: null,
    models: [{ name: "moonshotai/kimi-k3", alias: "kimi-k3" }],
    keyVerifiedAt: null,
    createdAt: NOW
  };
  const state = { ...createDefaultCliProxyState(), routerProviders: [mine] };
  const secrets = { apiKey: "a", managementSecret: "m", openRouterKey: "sk-or-x", routerKeys: {} };
  const out = migrateLegacyOpenRouter(state, secrets, NOW);
  assert.equal(out.secrets.routerKeys["openrouter"], "sk-or-x", "the key still migrates");
  assert.deepEqual(
    out.state.routerProviders.map((p) => p.id),
    ["mygateway"],
    "no colliding openrouter record appended"
  );
  assert.equal(validateRouterProviders(out.state.routerProviders), null);
  // Still idempotent: a second pass changes nothing.
  assert.equal(migrateLegacyOpenRouter(out.state, out.secrets, NOW).changed, false);
});

test("routerKeyCheckUrl only uses openrouter.ai when the baseUrl really points there", () => {
  // A preset chip prefills `preset:"openrouter"`, but the form lets the baseUrl be
  // edited to any gateway and the preset sticks. Trusting `preset` alone would send
  // a third party's key to openrouter.ai and stamp keyVerifiedAt from a service that
  // never saw the real gateway.
  assert.equal(routerKeyCheckUrl(openrouter), "https://openrouter.ai/api/v1/key");
  assert.equal(
    routerKeyCheckUrl({ ...openrouter, baseUrl: "https://evil.example/v1" }),
    "https://evil.example/v1/models"
  );
  assert.equal(
    routerKeyCheckUrl({ ...openrouter, baseUrl: "https://openrouter.ai.evil.example/v1" }),
    "https://openrouter.ai.evil.example/v1/models"
  );
  // Non-preset providers always use their own authed /models (trailing slashes trimmed).
  assert.equal(routerKeyCheckUrl(tokenrouter), "https://api.tokenrouter.com/v1/models");
  assert.equal(
    routerKeyCheckUrl({ ...tokenrouter, baseUrl: "https://api.tokenrouter.com/v1//" }),
    "https://api.tokenrouter.com/v1/models"
  );
});

test("getRouterKey never walks the prototype chain and rejects non-string values", () => {
  assert.equal(getRouterKey({}, "constructor"), undefined);
  assert.equal(getRouterKey({}, "hasOwnProperty"), undefined);
  assert.equal(getRouterKey({ openrouter: "sk-or-1" }, "openrouter"), "sk-or-1");
  assert.equal(getRouterKey({ openrouter: "" }, "openrouter"), undefined);
  // A JSON-parsed record with a hostile-but-RE-valid id works as an own key.
  const parsed = JSON.parse('{"constructor":"sk-x"}') as Record<string, string>;
  assert.equal(getRouterKey(parsed, "constructor"), "sk-x");
});

test("migrateLegacyOpenRouter refuses to attach the legacy key to a foreign-host 'openrouter' provider", () => {
  const foreign: RouterProvider = {
    id: "openrouter",
    label: "Not really",
    baseUrl: "https://evil.example/v1",
    preset: null,
    models: [{ name: "m/x" }],
    keyVerifiedAt: null,
    createdAt: NOW
  };
  const state = { ...createDefaultCliProxyState(), routerProviders: [foreign] };
  const secrets = { apiKey: "a", managementSecret: "m", openRouterKey: "sk-or-x", routerKeys: {} };
  const out = migrateLegacyOpenRouter(state, secrets, NOW);
  // The key must NOT be attached (next projection would send it to evil.example)
  // and the user's record must not be overwritten; legacy field stays for later.
  assert.equal(out.changed, false);
  assert.equal(getRouterKey(out.secrets.routerKeys, "openrouter"), undefined);
  assert.equal(out.secrets.openRouterKey, "sk-or-x");
  assert.deepEqual(out.state.routerProviders, [foreign]);
  // A genuine openrouter.ai record with the same id still receives the key.
  const genuine = { ...foreign, baseUrl: "https://openrouter.ai/api/v1" };
  const out2 = migrateLegacyOpenRouter({ ...state, routerProviders: [genuine] }, secrets, NOW);
  assert.equal(out2.changed, true);
  assert.equal(getRouterKey(out2.secrets.routerKeys, "openrouter"), "sk-or-x");
  assert.deepEqual(out2.state.routerProviders, [genuine]); // no duplicate seed
});
