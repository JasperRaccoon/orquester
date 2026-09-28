/**
 * Launch configuration: the version gate, the `session/set_model` decision
 * table, and the TOML patcher that turns the approvals surface on.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  meetsMinimumGrokVersion,
  parseGrokVersion,
  resolveGrokModelUpdate,
  versionGateMessage,
  writeGrokOverlayConfig
} from "./launch.ts";

test("the version line the CLI actually prints parses", () => {
  assert.equal(parseGrokVersion("grok 1.0.34 (3736acbc8658) [stable]\n"), "1.0.34");
  assert.equal(parseGrokVersion("grok 1.0.3 (abc) [stable]"), "1.0.3");
  assert.equal(parseGrokVersion("nothing here"), null);
});

test("the gate refuses below the minimum and names the required version", () => {
  assert.equal(meetsMinimumGrokVersion("1.0.34"), true);
  assert.equal(meetsMinimumGrokVersion("1.0.3"), true);
  assert.equal(meetsMinimumGrokVersion("0.9.0"), false);
  assert.equal(meetsMinimumGrokVersion("1.0.2"), false);
  assert.match(versionGateMessage("0.9.0"), /1\.0\.3/);
});

test("an unreadable version does not block a working CLI", () => {
  // Grok's version comes from the handshake itself, so `null` means the
  // protocol said nothing, not that the binary is old.
  assert.equal(meetsMinimumGrokVersion(null), true);
});

// ---------------------------------------------------------------------------
// session/set_model
// ---------------------------------------------------------------------------

test("the product slug is never sent", () => {
  assert.equal(resolveGrokModelUpdate({ model: "grok-build" }, { currentModelId: "grok-4.6" }), null);
});

test("nothing changed means no RPC at all", () => {
  assert.equal(
    resolveGrokModelUpdate({ model: "grok-4.6" }, { currentModelId: "grok-4.6" }),
    null,
    "a same-model reselection must not touch the CLI default"
  );
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
    resolveGrokModelUpdate(
      { model: "grok-4.6", options: [{ id: "reasoningEffort", value }] },
      { currentModelId: "grok-4.5" }
    )?.meta?.reasoningEffort ?? null;
  assert.equal(effort("xhigh"), "xhigh");
  assert.equal(effort("turbo_v2"), "turbo_v2");
  assert.equal(effort("not a token"), null);
  assert.equal(effort("-leading-dash"), null, "a value must never arrive as a flag");
  assert.equal(effort("a".repeat(33)), null);
});

// ---------------------------------------------------------------------------
// The config overlay (R4 #4 — it used to write through a symlink)
// ---------------------------------------------------------------------------

/** The overlay tests' scratch directories, removed once the file is done. */
const overlayDirs: string[] = [];
after(async () => {
  for (const dir of overlayDirs) {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

async function overlayScratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "grok-overlay-"));
  overlayDirs.push(dir);
  return dir;
}

test("the overlay is written into a host-owned dir and its path returned", async () => {
  const dir = await overlayScratch();
  const path = await writeGrokOverlayConfig(join(dir, "thread-1"));
  assert.ok(path !== null);
  const rendered = await readFile(path, "utf8");
  assert.match(rendered, /\[features\]\nsupport_permission = true/);
  assert.match(rendered, /\[cli\]\nauto_update = false/);
  assert.doesNotMatch(rendered, /^\[ui\]$/m);
  assert.doesNotMatch(rendered, /permission_mode/);
  // Idempotent: a second start of the same thread rewrites it in place.
  assert.equal(await writeGrokOverlayConfig(join(dir, "thread-1")), path);
});

test("a SYMLINKED config is never written — the bug that rewrote the user's global config", async () => {
  // The managed account home's `config.toml` is a symlink to the daemon
  // user's `~/.grok/config.toml` on this host; the previous revision followed
  // it and rewrote the global file for every Grok process on the box.
  const dir = await overlayScratch();
  const victim = join(dir, "the-users-real-config.toml");
  const original = '[ui]\ntheme = "dark"\n';
  await writeFile(victim, original, "utf8");

  const overlayDir = join(dir, "overlay");
  await mkdir(overlayDir, { recursive: true });
  await symlink(victim, join(overlayDir, "orquester-grok.toml"));

  assert.equal(await writeGrokOverlayConfig(overlayDir), null, "the write is refused");
  assert.equal(await readFile(victim, "utf8"), original, "the link target is untouched");
});

test("an unwritable directory degrades to a warning, not a failed session", async () => {
  // `null` is the caller's signal to emit `grokConfigAdvisory()` and carry on.
  const dir = await overlayScratch();
  const blocker = join(dir, "not-a-dir");
  await writeFile(blocker, "", "utf8");
  assert.equal(await writeGrokOverlayConfig(join(blocker, "nested")), null);
});
