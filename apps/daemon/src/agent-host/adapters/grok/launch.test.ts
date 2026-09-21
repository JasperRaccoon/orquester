/**
 * Launch configuration: the version gate, the `session/set_model` decision
 * table, and the TOML patcher that turns the approvals surface on.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GROK_EXTRA_ENV,
  GROK_PRODUCT_SLUG,
  MINIMUM_GROK_VERSION,
  compareVersions,
  ensureGrokManagedConfig,
  grokReasoningEffort,
  hasReasoningEffortPreference,
  meetsMinimumGrokVersion,
  parseGrokVersion,
  patchGrokConfig,
  resolveGrokModelUpdate,
  versionGateMessage
} from "./launch.ts";

test("the version line the CLI actually prints parses", () => {
  assert.equal(parseGrokVersion("grok 1.0.34 (3736acbc8658) [stable]\n"), "1.0.34");
  assert.equal(parseGrokVersion("grok 1.0.3 (abc) [stable]"), "1.0.3");
  assert.equal(parseGrokVersion("nothing here"), null);
});

test("versions compare by numeric segment", () => {
  assert.equal(compareVersions("1.0.34", "1.0.3"), 1);
  assert.equal(compareVersions("1.0.3", "1.0.34"), -1);
  assert.equal(compareVersions("1.0.3", "1.0.3"), 0);
  assert.equal(compareVersions("2.0.0", "1.99.99"), 1);
});

test("the gate refuses below the minimum and names the required version", () => {
  assert.equal(meetsMinimumGrokVersion("1.0.34"), true);
  assert.equal(meetsMinimumGrokVersion(MINIMUM_GROK_VERSION), true);
  assert.equal(meetsMinimumGrokVersion("0.9.0"), false);
  assert.match(versionGateMessage("0.9.0"), new RegExp(MINIMUM_GROK_VERSION.replace(/\./g, "\\.")));
});

test("an unreadable version does not block a working CLI", () => {
  // Grok's version comes from the handshake itself, so `null` means the
  // protocol said nothing, not that the binary is old.
  assert.equal(meetsMinimumGrokVersion(null), true);
});

test("the child env turns the ask-user-question tool on and marks the referrer", () => {
  assert.equal(GROK_EXTRA_ENV["GROK_ASK_USER_QUESTION"], "1");
  assert.equal(typeof GROK_EXTRA_ENV["GROK_OAUTH2_REFERRER"], "string");
  assert.equal("GROK_HOME" in GROK_EXTRA_ENV, false, "the account home is bound by support/env.ts");
  assert.equal("XAI_API_KEY" in GROK_EXTRA_ENV, false);
});

// ---------------------------------------------------------------------------
// session/set_model
// ---------------------------------------------------------------------------

test("the product slug is never sent", () => {
  assert.equal(resolveGrokModelUpdate({ model: GROK_PRODUCT_SLUG }, { currentModelId: "grok-4.6" }), null);
});

test("nothing changed means no RPC at all", () => {
  assert.equal(
    resolveGrokModelUpdate({ model: "grok-4.6" }, { currentModelId: "grok-4.6" }),
    null,
    "a same-model reselection must not touch the CLI default"
  );
});

test("a model change sends a bare {modelId} when no effort was expressed", () => {
  assert.deepEqual(resolveGrokModelUpdate({ model: "grok-4.5" }, { currentModelId: "grok-4.6" }), {
    modelId: "grok-4.5"
  });
});

test("a valid effort rides as _meta.reasoningEffort", () => {
  assert.deepEqual(
    resolveGrokModelUpdate(
      { model: "grok-4.5", options: [{ id: "reasoningEffort", value: "low" }] },
      { currentModelId: "grok-4.6", currentReasoningEffort: "high" }
    ),
    { modelId: "grok-4.5", meta: { reasoningEffort: "low" } }
  );
});

test("an invalid effort is DROPPED, not forwarded", () => {
  const update = resolveGrokModelUpdate(
    { model: "grok-4.6", options: [{ id: "reasoningEffort", value: "not a token" }] },
    { currentModelId: "grok-4.6", currentReasoningEffort: "high" }
  );
  assert.deepEqual(update, { modelId: "grok-4.6" }, "the RPC goes out bare rather than failing");
});

test("an absent preference is never an explicit clear", () => {
  const update = resolveGrokModelUpdate({ model: "grok-4.5" }, { currentModelId: "grok-4.6", currentReasoningEffort: "xhigh" });
  assert.deepEqual(update, { modelId: "grok-4.5" });
  assert.equal("meta" in (update ?? {}), false);
});

test("effort token validation matches T3's shape guard", () => {
  const effort = (value: string): string | null =>
    grokReasoningEffort({ model: "grok-4.6", options: [{ id: "reasoningEffort", value }] });
  assert.equal(effort("xhigh"), "xhigh");
  assert.equal(effort("turbo_v2"), "turbo_v2");
  assert.equal(effort("not a token"), null);
  assert.equal(effort("-leading-dash"), null, "a value must never arrive as a flag");
  assert.equal(effort("a".repeat(33)), null);
  assert.equal(hasReasoningEffortPreference({ model: "x" }), false);
});

// ---------------------------------------------------------------------------
// The managed config
// ---------------------------------------------------------------------------

test("an empty config gains both managed keys", () => {
  const patched = patchGrokConfig("");
  assert.ok(patched !== null);
  assert.match(patched, /\[features\]\nsupport_permission = true/);
  assert.match(patched, /\[cli\]\nauto_update = false/);
});

test("an existing section is edited in place and everything else survives", () => {
  const source = [
    "# my notes",
    "[ui]",
    'theme = "dark"',
    "",
    "[features]",
    "support_permission = false",
    "other = 1",
    ""
  ].join("\n");
  const patched = patchGrokConfig(source);
  assert.ok(patched !== null);
  assert.match(patched, /support_permission = true/);
  assert.match(patched, /# my notes/);
  assert.match(patched, /theme = "dark"/);
  assert.match(patched, /other = 1/);
  assert.equal(/support_permission = false/.test(patched), false);
});

test("a config already correct is left untouched", () => {
  const source = "[features]\nsupport_permission = true\n\n[cli]\nauto_update = false\n";
  assert.equal(patchGrokConfig(source), null);
});

test("a missing key is appended to its existing section", () => {
  const patched = patchGrokConfig("[features]\nother = 1\n\n[cli]\nauto_update = false\n");
  assert.ok(patched !== null);
  assert.match(patched, /\[features\]\nother = 1\nsupport_permission = true/);
});

test("ensureGrokManagedConfig writes the file when it does not exist", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grok-config-"));
  assert.equal(await ensureGrokManagedConfig(dir), "patched");
  const written = await readFile(join(dir, "config.toml"), "utf8");
  assert.match(written, /support_permission = true/);
  assert.equal(await ensureGrokManagedConfig(dir), "unchanged");
});

test("ensureGrokManagedConfig preserves an existing file's other settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grok-config-"));
  await writeFile(join(dir, "config.toml"), '[ui]\npermission_mode = "default"\n', "utf8");
  assert.equal(await ensureGrokManagedConfig(dir), "patched");
  const written = await readFile(join(dir, "config.toml"), "utf8");
  assert.match(written, /permission_mode = "default"/);
  assert.match(written, /support_permission = true/);
});
