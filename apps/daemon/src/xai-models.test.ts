import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type RouterProvider,
  compactEnvForModel,
  resolveXaiModel,
  validateRouterProviders
} from "@orquester/config";

const NOW = "2026-08-05T00:00:00.000Z";

const router: RouterProvider = {
  id: "openrouter",
  label: "OpenRouter",
  baseUrl: "https://openrouter.ai/api/v1",
  preset: "openrouter",
  models: [{ name: "moonshotai/kimi-k3", alias: "kimi-k3" }],
  keyVerifiedAt: null,
  createdAt: NOW
};

test("resolveXaiModel matches bare and acc-prefixed ids only", () => {
  assert.equal(resolveXaiModel("grok-build-0.1")?.id, "grok-build-0.1");
  assert.equal(resolveXaiModel("acc1f/grok-4.5")?.id, "grok-4.5");
  assert.equal(resolveXaiModel("accDEADBEEF/grok-build-0.1")?.id, "grok-build-0.1");
  // Only ONE prefix is stripped, and the match is exact — no prefix/substring
  // matching that could capture a future `grok-4.5-mini` router alias.
  assert.equal(resolveXaiModel("acc1f/acc2a/grok-4.5"), null);
  assert.equal(resolveXaiModel("grok-4.5-mini"), null);
  assert.equal(resolveXaiModel("xai/grok-4.5"), null);
  assert.equal(resolveXaiModel("gpt-5.6-sol"), null);
  assert.equal(resolveXaiModel(""), null);
});

test("compactEnvForModel resolves xai models from XAI_OAUTH_MODELS", () => {
  assert.deepEqual(compactEnvForModel("grok-build-0.1"), {
    maxContextTokens: 256_000,
    autoCompactWindow: 190_000
  });
  assert.deepEqual(compactEnvForModel("acc1f/grok-4.5"), {
    maxContextTokens: 500_000,
    autoCompactWindow: 190_000
  });
});

test("compactEnvForModel lets modelOverrides win over the xai defaults", () => {
  assert.deepEqual(
    compactEnvForModel("grok-4.5", { "grok-4.5": { contextWindow: 300_000, compactWindow: 120_000, compactPct: 70 } }),
    { maxContextTokens: 300_000, autoCompactWindow: 120_000, autoCompactPct: 70 }
  );
  // A partial override keeps the other window from the curated entry.
  assert.deepEqual(compactEnvForModel("grok-build-0.1", { "grok-build-0.1": { compactWindow: 100_000 } }), {
    maxContextTokens: 256_000,
    autoCompactWindow: 100_000
  });
});

test("validateRouterProviders rejects router models shadowing an xai model id", () => {
  assert.match(
    validateRouterProviders([{ ...router, models: [{ name: "grok-build-0.1" }] }]) ?? "",
    /grok-build-0\.1.*built-in/
  );
  assert.match(
    validateRouterProviders([{ ...router, models: [{ name: "x-ai/grok-4.5", alias: "grok-4.5" }] }]) ?? "",
    /grok-4\.5.*built-in/
  );
  // The full name is free as long as it isn't the built-in id itself.
  assert.equal(validateRouterProviders([{ ...router, models: [{ name: "x-ai/grok-4.5" }] }]), null);
});
