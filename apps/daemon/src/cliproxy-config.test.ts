import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCliProxyState, createDefaultCliProxyState,
  parseCliProxySecrets, cliproxyDir, cliproxyHomeDir, MODEL_NAME_RE
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
