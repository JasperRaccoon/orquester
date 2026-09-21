import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyClaudeProjectTrust,
  ensureGrokChatConfig,
  markClaudeProjectTrusted,
  setTomlKey
} from "./home-prep.ts";

// Reality findings from the real CLIs (SEAMS §2), each a silent failure if the
// daemon skips it.

test("a never-seen directory is marked trusted, with onboarding forced", () => {
  const next = applyClaudeProjectTrust({}, "/w/p");
  assert.ok(next);
  assert.equal(next.hasCompletedOnboarding, true);
  assert.deepEqual((next.projects as Record<string, unknown>)["/w/p"], {
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true
  });
});

test("an existing project's other settings are preserved", () => {
  const next = applyClaudeProjectTrust(
    {
      hasCompletedOnboarding: true,
      projects: { "/w/p": { allowedTools: ["Bash"], hasTrustDialogAccepted: false } }
    },
    "/w/p"
  );
  assert.ok(next);
  const project = (next.projects as Record<string, Record<string, unknown>>)["/w/p"];
  assert.deepEqual(project.allowedTools, ["Bash"]);
  assert.equal(project.hasTrustDialogAccepted, true);
});

test("an already-trusted project is a no-op (no write churn per turn)", () => {
  assert.equal(
    applyClaudeProjectTrust(
      {
        hasCompletedOnboarding: true,
        projects: { "/w/p": { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } }
      },
      "/w/p"
    ),
    null
  );
});

test("a malformed projects map is replaced rather than crashing the launch", () => {
  const next = applyClaudeProjectTrust({ projects: "nonsense" }, "/w/p");
  assert.ok(next);
  assert.equal(typeof next.projects, "object");
});

test("markClaudeProjectTrusted writes 0600 and survives an absent file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orq-home-prep-"));
  const file = join(dir, ".claude.json");
  assert.equal(await markClaudeProjectTrusted(file, "/w/p"), true);
  const written = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  assert.equal(
    (written.projects as Record<string, Record<string, unknown>>)["/w/p"].hasTrustDialogAccepted,
    true
  );
  // Second call changes nothing.
  assert.equal(await markClaudeProjectTrusted(file, "/w/p"), false);
  await rm(dir, { recursive: true, force: true });
});

test("an unreadable claude config never fails a launch", async () => {
  const warnings: unknown[] = [];
  // A directory where a file is expected: the write throws, the launch does not.
  const dir = await mkdtemp(join(tmpdir(), "orq-home-prep-"));
  assert.equal(
    await markClaudeProjectTrusted(dir, "/w/p", { warn: (...a) => warnings.push(a) }),
    false
  );
  assert.equal(warnings.length, 1);
  await rm(dir, { recursive: true, force: true });
});

// --- the minimal TOML writer -----------------------------------------------

test("a key is added to an existing table without touching the rest", () => {
  const source = ['[compat.claude]', 'hooks = false', '', '[features]', 'other = 1', ''].join("\n");
  const next = setTomlKey(source, "features", "support_permission", "true");
  assert.ok(next.includes("hooks = false"), "the critical compat key is untouched");
  assert.ok(next.includes("other = 1"));
  assert.ok(next.includes("support_permission = true"));
  assert.ok(next.indexOf("support_permission") > next.indexOf("[features]"));
});

test("an existing key is rewritten in place, and an identical one is a no-op", () => {
  const source = "[features]\nsupport_permission = false\n";
  const next = setTomlKey(source, "features", "support_permission", "true");
  assert.equal(next, "[features]\nsupport_permission = true\n");
  assert.equal(setTomlKey(next, "features", "support_permission", "true"), next);
});

test("a missing table is appended", () => {
  const next = setTomlKey("auto_update = true\n", "features", "support_permission", "true");
  assert.ok(next.includes("[features]"));
  assert.ok(next.trimEnd().endsWith("support_permission = true"));
});

test("a ROOT key lands above the first table, never inside one", () => {
  const source = "[features]\nsupport_permission = true\n";
  const next = setTomlKey(source, null, "auto_update", "false");
  assert.equal(next.indexOf("auto_update"), 0, "a root key below a header would belong to that table");
});

test("a root key already present is rewritten, not duplicated", () => {
  const next = setTomlKey("auto_update = true\n[features]\n", null, "auto_update", "false");
  assert.equal(next.split("auto_update").length - 1, 1);
  assert.ok(next.startsWith("auto_update = false"));
});

test("a same-named key in ANOTHER table is not mistaken for ours", () => {
  const source = "[other]\nsupport_permission = false\n";
  const next = setTomlKey(source, "features", "support_permission", "true");
  assert.ok(next.includes("[other]\nsupport_permission = false"));
  assert.ok(next.includes("[features]\nsupport_permission = true"));
});

test("ensureGrokChatConfig turns approvals on and auto-update off, idempotently", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orq-grok-"));
  await writeFile(join(dir, "config.toml"), "[compat.claude]\nhooks = false\n", "utf8");
  assert.equal(await ensureGrokChatConfig(dir), true);
  const written = await readFile(join(dir, "config.toml"), "utf8");
  assert.ok(written.includes("hooks = false"), "the hooks=false compat key must survive");
  assert.ok(/\[features\][\s\S]*support_permission = true/.test(written));
  assert.ok(written.startsWith("auto_update = false"));
  assert.equal(await ensureGrokChatConfig(dir), false, "no write churn on the second launch");
  await rm(dir, { recursive: true, force: true });
});

test("ensureGrokChatConfig creates the file when the home has none", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orq-grok-"));
  assert.equal(await ensureGrokChatConfig(dir), true);
  const written = await readFile(join(dir, "config.toml"), "utf8");
  assert.ok(written.includes("support_permission = true"));
  assert.ok(written.includes("auto_update = false"));
  await rm(dir, { recursive: true, force: true });
});
