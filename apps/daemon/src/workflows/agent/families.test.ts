import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cliproxyStateFile, type RouterProvider } from "@orquester/config";
import { proxyAccountFamily } from "../../agent-chat/service.ts";
import {
  accountFamilyOf,
  cooldownFamilyOf,
  cooldownKey,
  createUsesAccount,
  defaultUsesAccount,
  isProxyLauncher,
  routerProvidersFromDisk
} from "./families.ts";

test("accountFamilyOf follows the daemon's proxyAccountFamily(refId) ?? refId", () => {
  for (const refId of ["claude", "claudex", "claudemix", "codex", "grok"]) {
    assert.equal(accountFamilyOf(refId), proxyAccountFamily(refId) ?? refId, refId);
  }
  assert.equal(accountFamilyOf("claudex"), "codex");
  assert.equal(accountFamilyOf("claudemix"), "claude");
  assert.equal(accountFamilyOf("opencode"), null);
  assert.equal(accountFamilyOf("deepseek"), null);
  assert.equal(accountFamilyOf("toString"), null, "no prototype keys");
});

test("isProxyLauncher is exactly the proxy launchers", () => {
  for (const refId of ["claude", "claudex", "claudemix", "codex", "grok", "opencode"]) {
    assert.equal(isProxyLauncher(refId), proxyAccountFamily(refId) !== null, refId);
  }
});

const providers = [
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", preset: "openrouter", models: [{ name: "moonshotai/kimi-k3", alias: "kimi-k3" }], keyVerifiedAt: null, createdAt: "2026-09-01T00:00:00.000Z" }
] as RouterProvider[];

test("usesAccount: router and xAI claudex models carry no account; claudemix always does", () => {
  const uses = createUsesAccount(() => providers);
  assert.equal(uses("claudex", "gpt-5.5"), true);
  assert.equal(uses("claudex", "kimi-k3"), false, "by alias");
  assert.equal(uses("claudex", "moonshotai/kimi-k3"), false, "by name");
  assert.equal(uses("claudex", "acc1a2b/kimi-k3"), false, "account-prefixed");
  assert.equal(uses("claudex", "grok-4.5"), false);
  assert.equal(uses("claudex", "grok-build-0.1"), false);
  assert.equal(uses("claudemix", "kimi-k3"), true);
  assert.equal(uses("claude", "claude-opus-5"), true);
  assert.equal(uses("codex", "gpt-5.5"), true);
  assert.equal(uses("grok", "grok-build"), true);
  assert.equal(uses("opencode", "anthropic/claude-sonnet"), false);
  assert.equal(defaultUsesAccount("claudex", "kimi-k3"), true, "without the proxy state a router model is unknown");
  assert.equal(defaultUsesAccount("claudex", "grok-4.5"), false);
});

test("cooldownFamilyOf keys accountless launches under their refId", () => {
  const uses = createUsesAccount(() => providers);
  assert.equal(cooldownFamilyOf("claudex", "gpt-5.5", uses), "codex");
  assert.equal(cooldownFamilyOf("claudex", "kimi-k3", uses), "claudex");
  assert.equal(cooldownFamilyOf("claudemix", "claude-opus-5", uses), "claude");
  assert.equal(cooldownFamilyOf("opencode", "x", uses), "opencode");
  assert.equal(cooldownKey("claude", "system"), "claude:system");
});

test("routerProvidersFromDisk reads the proxy state, [] when absent or corrupt", async () => {
  const daemonDir = await mkdtemp(join(tmpdir(), "orquester-wf-families-"));
  assert.deepEqual(routerProvidersFromDisk(daemonDir), []);
  const file = cliproxyStateFile(daemonDir);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, "{not json", "utf8");
  assert.deepEqual(routerProvidersFromDisk(daemonDir), []);
  await writeFile(file, JSON.stringify({ routerProviders: providers }), "utf8");
  assert.deepEqual(routerProvidersFromDisk(daemonDir).map((p) => p.id), ["openrouter"]);
});
