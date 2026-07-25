import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCliProxyState, createDefaultCliProxyState,
  parseCliProxySecrets, cliproxyDir, cliproxyHomeDir, MODEL_NAME_RE,
  CLAUDE_ARMING_COMPACT_WINDOW, CURATED_PROXY_MODEL_IDS, compactEnvForModel
} from "@orquester/config";

test("state: defaults on garbage, valid passes through", () => {
  const d = parseCliProxyState({ nonsense: true });
  assert.equal(d.enabled, false);
  assert.equal(d.port, 8317);
  const ok = parseCliProxyState({ ...createDefaultCliProxyState(), enabled: true, defaultModel: "kimi-k3" });
  assert.equal(ok.enabled, true);
  assert.equal(ok.defaultModel, "kimi-k3");
});

test("secrets: corrupt fails closed, never defaults", () => {
  assert.equal(parseCliProxySecrets({ apiKey: 42 }), "corrupt");
  assert.equal(parseCliProxySecrets("not even an object"), "corrupt");
  const ok = parseCliProxySecrets({ apiKey: "a", managementSecret: "b", openRouterKey: null });
  assert.notEqual(ok, "corrupt");
});

test("paths + model charset", () => {
  assert.equal(cliproxyDir("/x/daemon"), "/x/daemon/cliproxy");
  assert.equal(cliproxyHomeDir("/x/daemon", "claudex"), "/x/daemon/cliproxy/claude-home-claudex");
  assert.ok(MODEL_NAME_RE.test("moonshotai/kimi-k3"));
  assert.ok(!MODEL_NAME_RE.test("bad model; rm -rf"));
});

test("compactEnvForModel: curated gpt model resolves window + pct", () => {
  assert.deepEqual(compactEnvForModel("gpt-5.6-sol"), {
    maxContextTokens: 200000,
    autoCompactWindow: 200000,
    autoCompactPct: 75
  });
});

test("compactEnvForModel: kimi resolves 1M window with 450k compact window, no pct", () => {
  assert.deepEqual(compactEnvForModel("kimi-k3"), {
    maxContextTokens: 1048576,
    autoCompactWindow: 450000
  });
});

test("compactEnvForModel: acc-prefixed model resolves like its bare id", () => {
  assert.deepEqual(compactEnvForModel("acc65eebd90/gpt-5.6-terra"), {
    maxContextTokens: 200000,
    autoCompactWindow: 200000,
    autoCompactPct: 75
  });
});

test("compactEnvForModel: claude ids (bare or prefixed) get the arming value only", () => {
  assert.deepEqual(compactEnvForModel("claude-fable-5"), {
    autoCompactWindow: CLAUDE_ARMING_COMPACT_WINDOW
  });
  assert.deepEqual(compactEnvForModel("acc14137047/claude-opus-5"), {
    autoCompactWindow: CLAUDE_ARMING_COMPACT_WINDOW
  });
});

test("compactEnvForModel: overrides beat curated defaults, per field", () => {
  assert.deepEqual(
    compactEnvForModel("gpt-5.6-sol", { "gpt-5.6-sol": { compactWindow: 180000, compactPct: 60 } }),
    { maxContextTokens: 200000, autoCompactWindow: 180000, autoCompactPct: 60 }
  );
});

test("compactEnvForModel: the OpenRouter full name resolves like its curated alias", () => {
  assert.deepEqual(compactEnvForModel("moonshotai/kimi-k3"), {
    maxContextTokens: 1048576,
    autoCompactWindow: 450000
  });
});

test("compactEnvForModel: uncurated non-claude id with no override emits nothing", () => {
  assert.equal(compactEnvForModel("glm-5-air"), null);
});

test("compactEnvForModel: an override alone makes an uncurated id resolvable", () => {
  assert.deepEqual(compactEnvForModel("glm-5-air", { "glm-5-air": { contextWindow: 128000 } }), {
    maxContextTokens: 128000,
    autoCompactWindow: 128000
  });
});

test("cliProxyState: modelOverrides roundtrip and absent-field default", () => {
  assert.deepEqual(createDefaultCliProxyState().modelOverrides, {});
  const parsed = parseCliProxyState({
    ...createDefaultCliProxyState(),
    modelOverrides: { "kimi-k3": { compactWindow: 500000 } }
  });
  assert.deepEqual(parsed.modelOverrides, { "kimi-k3": { compactWindow: 500000 } });
});

test("CURATED_PROXY_MODEL_IDS keeps the picker order sol, terra, luna, kimi", () => {
  assert.deepEqual(CURATED_PROXY_MODEL_IDS, ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "kimi-k3"]);
});
