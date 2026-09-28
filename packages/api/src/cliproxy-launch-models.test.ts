import { test } from "node:test";
import assert from "node:assert/strict";
import type { CliProxyStatus } from "./index.ts";
import { proxyLaunchModels } from "./cliproxy-launch-models.ts";

const base = {
  state: "healthy", reasons: [], detail: null, version: null, defaultModel: "gpt-5.6-sol", backgroundModel: "",
  modelOverrides: {}, providers: [], routerProviders: [], accounts: [], activeSessionCount: 0, testedClaudeCliVersion: null,
  xai: { state: "none", email: null, expiredAt: null, lastQuotaError: null, lastLinkError: null, link: null }
} as unknown as CliProxyStatus;

test("a keyed router provider adds its alias (or name) with its label; an unkeyed one adds nothing", () => {
  const status = { ...base, routerProviders: [
    { id: "r1", label: "OpenRouter", preset: "openrouter", baseUrl: "https://x", keyState: "verified", keyVerifiedAt: null,
      models: [{ name: "moonshot/kimi-k3", alias: "kimi-k3" }, { name: "other/model" }] },
    { id: "r2", label: "Unkeyed", preset: null, baseUrl: "https://y", keyState: "none", keyVerifiedAt: null, models: [{ name: "nope" }] }
  ] } as unknown as CliProxyStatus;
  const models = proxyLaunchModels(status, []);
  assert.deepEqual(models.filter((m) => m.providerLabel === "OpenRouter").map((m) => m.id), ["kimi-k3", "other/model"]);
  assert.ok(!models.some((m) => m.id === "nope"));
});

test("xAI models appear while linked or expired, labelled as the Grok account", () => {
  for (const state of ["linked", "expired"]) {
    const status = { ...base, xai: { ...base.xai, state } } as unknown as CliProxyStatus;
    assert.deepEqual(proxyLaunchModels(status, ["grok-build-0.1"]), [
      { id: "grok-build-0.1", providerLabel: "Grok account" }
    ]);
  }
  assert.ok(!proxyLaunchModels(base, []).some((m) => m.id === "grok-build-0.1"));
});

test("a non-empty catalogue filters the picks to what the proxy serves, falling back to all picks when none match", () => {
  const ids = proxyLaunchModels(base, ["gpt-5.6-sol"]).map((m) => m.id);
  assert.deepEqual(ids, ["gpt-5.6-sol"]);
  assert.ok(proxyLaunchModels(base, ["unrelated"]).some((m) => m.id === "gpt-5.6-sol"));
});
