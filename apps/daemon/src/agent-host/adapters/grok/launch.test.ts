/**
 * Launch configuration: the version gate, the `session/set_model` decision
 * table, and the TOML patcher that turns the approvals surface on.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RUNTIME_MODES } from "@orquester/api/agent-chat";

import {
  GROK_EXTRA_ENV,
  GROK_PRODUCT_SLUG,
  MINIMUM_GROK_VERSION,
  compareVersions,
  GROK_CONFIG_PATH_ENV,
  grokReasoningEffort,
  grokSpawnArgs,
  hasReasoningEffortPreference,
  meetsMinimumGrokVersion,
  parseGrokVersion,
  renderGrokOverlayConfig,
  resolveGrokModelUpdate,
  versionGateMessage,
  writeGrokOverlayConfig
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
// The config overlay (R4 #4 — it used to write through a symlink)
// ---------------------------------------------------------------------------

test("the overlay carries the setting the approvals surface depends on", () => {
  const rendered = renderGrokOverlayConfig();
  assert.match(rendered, /\[features\]\nsupport_permission = true/);
  assert.match(rendered, /\[cli\]\nauto_update = false/);
  assert.equal(GROK_CONFIG_PATH_ENV, "GROK_CONFIG_PATH");
});

test("no runtime mode pins the permission mode in the overlay — it rides argv", () => {
  // The CLI drops every overlay table outside its allowlist (`models`,
  // `features`, a narrowed `toolset`, `shell_environment_policy`). Measured on
  // grok 1.0.34: `grok inspect --json` reports an overlay carrying
  // `[features]` + `[cli]` + `[ui]` as `sections: features`. A
  // `[ui] permission_mode` line here would pin nothing, so every mode names
  // itself on the command line instead — the flag tier, above the user's own
  // `[ui] permission_mode` (this host's says "always-approve").
  const rendered = renderGrokOverlayConfig();
  assert.doesNotMatch(rendered, /^\[ui\]$/m);
  assert.doesNotMatch(rendered, /permission_mode/);
  for (const mode of RUNTIME_MODES) {
    const args = grokSpawnArgs(mode);
    const named =
      (args[0] === "--permission-mode" && typeof args[1] === "string") ||
      args.includes("--always-approve");
    assert.ok(named, `${mode} must name its permission mode in argv`);
  }
});

test("the overlay is written into a host-owned dir and its path returned", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grok-overlay-"));
  const path = await writeGrokOverlayConfig(join(dir, "thread-1"));
  assert.ok(path !== null);
  assert.match(await readFile(path, "utf8"), /support_permission = true/);
  // Idempotent: a second start of the same thread rewrites it in place.
  assert.equal(await writeGrokOverlayConfig(join(dir, "thread-1")), path);
});

test("a SYMLINKED config is never written — the bug that rewrote the user's global config", async () => {
  // The managed account home's `config.toml` is a symlink to the daemon
  // user's `~/.grok/config.toml` on this host; the previous revision followed
  // it and rewrote the global file for every Grok process on the box.
  const dir = await mkdtemp(join(tmpdir(), "grok-overlay-"));
  const victim = join(dir, "the-users-real-config.toml");
  const original = '[ui]\ntheme = "dark"\n';
  await writeFile(victim, original, "utf8");

  const overlayDir = join(dir, "overlay");
  await mkdtemp(join(tmpdir(), "grok-overlay-x-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(overlayDir, { recursive: true });
  await symlink(victim, join(overlayDir, "orquester-grok.toml"));

  assert.equal(await writeGrokOverlayConfig(overlayDir), null, "the write is refused");
  assert.equal(await readFile(victim, "utf8"), original, "the link target is untouched");
});

test("an unwritable directory degrades to a warning, not a failed session", async () => {
  // `null` is the caller's signal to emit `grokConfigAdvisory()` and carry on.
  const dir = await mkdtemp(join(tmpdir(), "grok-overlay-"));
  const blocker = join(dir, "not-a-dir");
  await writeFile(blocker, "", "utf8");
  assert.equal(await writeGrokOverlayConfig(join(blocker, "nested")), null);
});
