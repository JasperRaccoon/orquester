import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliproxyStateFile, type RouterProvider } from "@orquester/config";
import { writeAddonEnvLaunchScript } from "./sessions.ts";
import { cliproxyContributor, composeExtraEnv } from "./index.ts";

const DIR = "/nonexistent/daemon";
const ACCOUNT = "abcdef12-3456-7890-abcd-ef1234567890";
const OTHER = "11112222-3456-7890-abcd-ef1234567890";

const NOW = "2026-08-04T00:00:00.000Z";

/** A TokenRouter-style provider: no alias, and a model name the retired
 *  `isOpenRouterModel` regex happened to match (moonshotai/…). */
const TOKENROUTER: RouterProvider = {
  id: "tokenrouter",
  label: "TokenRouter",
  baseUrl: "https://api.tokenrouter.com/v1",
  preset: "tokenrouter",
  models: [
    { name: "moonshotai/kimi-k3-free", contextWindow: 1_048_576, compactWindow: 450_000 },
    // Deliberately a name NO regex would have classified as router-served.
    { name: "zai/glm-5", alias: "glm-5", contextWindow: 200_000, compactWindow: 150_000 }
  ],
  keyVerifiedAt: null,
  createdAt: NOW
};

const OPENROUTER: RouterProvider = {
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

/** Temp daemonDir with a state.json seeding the given accounts (and router providers). */
async function daemonDirWithSeeded(
  accounts: Array<{ provider: "codex" | "claude"; accountId: string }>,
  routerProviders: RouterProvider[] = []
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orq-launchenv-"));
  const stateFile = cliproxyStateFile(dir);
  await mkdir(join(stateFile, ".."), { recursive: true });
  await writeFile(
    stateFile,
    JSON.stringify({
      seededAccounts: accounts.map((a) => ({
        provider: a.provider,
        accountId: a.accountId,
        label: "x",
        prefix: `acc${a.accountId.slice(0, 8)}`
      })),
      routerProviders
    })
  );
  return dir;
}

test("wrapper exports env and unsets requested keys", async () => {
  const w = await writeAddonEnvLaunchScript({ bin: "claude", args: ["--foo"] }, { CLAUDE_CONFIG_DIR: "/x/home" }, ["ANTHROPIC_API_KEY"]);
  const script = await readFile(w.args[0], "utf8");
  // This repo's shellQuote leaves shell-safe strings unquoted, so tolerate optional quotes.
  assert.match(script, /export CLAUDE_CONFIG_DIR='?\/x\/home'?/);
  assert.match(script, /unset ANTHROPIC_API_KEY/);
  assert.match(script, /exec '?claude'? '?--foo'?/);
  await w.cleanup();
});

test("wrapper still returns a script when only unsets are present (no env)", async () => {
  const w = await writeAddonEnvLaunchScript({ bin: "claude", args: [] }, {}, ["ANTHROPIC_API_KEY"]);
  assert.notEqual(w.bin, "claude"); // wrapped through a shell, not the bare bin
  const script = await readFile(w.args[0], "utf8");
  assert.match(script, /unset ANTHROPIC_API_KEY/);
  await w.cleanup();
});

test("cliproxyContributor pins the account and prefixes the model for a real account", () => {
  const res = cliproxyContributor("claudex", { accountId: ACCOUNT, model: "gpt-5.6-sol" }, DIR);
  assert.ok(res);
  assert.equal(res.accountId, ACCOUNT);
  assert.equal(res.env.ANTHROPIC_MODEL, "accabcdef12/gpt-5.6-sol");
  assert.equal(
    res.env.CLAUDE_CODE_SUBAGENT_MODEL,
    undefined,
    "no subagent pin — subagents must follow in-session /model switches"
  );
});

test("cliproxyContributor records no account for the System pick (round-robin)", () => {
  const res = cliproxyContributor("claudex", { accountId: "system", model: "gpt-5.6-sol" }, DIR);
  assert.ok(res);
  assert.equal(res.accountId, undefined);
  assert.equal(res.env.ANTHROPIC_MODEL, "gpt-5.6-sol");
});

test("cliproxyContributor records no account for a router model (by alias)", async () => {
  const dir = await daemonDirWithSeeded(
    [
      { provider: "codex", accountId: ACCOUNT },
      { provider: "codex", accountId: OTHER } // ambiguous → a non-router pick WOULD be prefixed
    ],
    [OPENROUTER]
  );
  const res = cliproxyContributor("claudex", { accountId: ACCOUNT, model: "kimi-k3" }, dir);
  assert.ok(res);
  assert.equal(res.accountId, undefined);
  assert.equal(res.env.ANTHROPIC_MODEL, "kimi-k3");
});

test("cliproxyContributor: a router model launches BARE with the provider's compact env", async () => {
  const dir = await daemonDirWithSeeded(
    [
      { provider: "codex", accountId: ACCOUNT },
      { provider: "codex", accountId: OTHER }
    ],
    [TOKENROUTER]
  );
  const res = cliproxyContributor(
    "claudex",
    { accountId: ACCOUNT, model: "moonshotai/kimi-k3-free" },
    dir
  );
  assert.ok(res);
  assert.equal(res.accountId, undefined, "router models are served by the provider key, not an account");
  assert.equal(res.env.ANTHROPIC_MODEL, "moonshotai/kimi-k3-free", "no acc<hex>/ prefix");
  assert.equal(res.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "1048576");
  assert.equal(res.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "450000");
});

test("cliproxyContributor: routing is data-driven, not name-shaped (zai/glm-5 via alias)", async () => {
  const dir = await daemonDirWithSeeded(
    [
      { provider: "codex", accountId: ACCOUNT },
      { provider: "codex", accountId: OTHER }
    ],
    [TOKENROUTER]
  );
  const res = cliproxyContributor("claudex", { accountId: ACCOUNT, model: "glm-5" }, dir);
  assert.ok(res);
  assert.equal(res.accountId, undefined);
  assert.equal(res.env.ANTHROPIC_MODEL, "glm-5");
  assert.equal(res.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "200000");
  assert.equal(res.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "150000");
});

test("cliproxyContributor: a non-router model still carries the acc prefix when ambiguous", async () => {
  const dir = await daemonDirWithSeeded(
    [
      { provider: "codex", accountId: ACCOUNT },
      { provider: "codex", accountId: OTHER }
    ],
    [TOKENROUTER]
  );
  const res = cliproxyContributor("claudex", { accountId: ACCOUNT, model: "gpt-5.6-sol" }, dir);
  assert.ok(res);
  assert.equal(res.accountId, ACCOUNT);
  assert.equal(res.env.ANTHROPIC_MODEL, "accabcdef12/gpt-5.6-sol");
});

test("cliproxyContributor pins the account for claudemix", () => {
  const res = cliproxyContributor("claudemix", { accountId: ACCOUNT, model: "claude-fable-5" }, DIR);
  assert.ok(res);
  assert.equal(res.accountId, ACCOUNT);
  assert.equal(res.env.ANTHROPIC_MODEL, "accabcdef12/claude-fable-5[1m]");
});

test("cliproxyContributor: the sole seeded account of a provider launches BARE (no acc prefix leak)", async () => {
  const dir = await daemonDirWithSeeded([
    { provider: "codex", accountId: ACCOUNT },
    { provider: "claude", accountId: OTHER } // different provider — no ambiguity
  ]);
  const res = cliproxyContributor("claudex", { accountId: ACCOUNT, model: "gpt-5.6-sol" }, dir);
  assert.ok(res);
  assert.equal(res.env.ANTHROPIC_MODEL, "gpt-5.6-sol", "no prefix when routing is unambiguous");
  assert.equal(res.accountId, ACCOUNT, "account still recorded for attribution");
});

test("cliproxyContributor: a second seeded account of the same provider forces the prefix", async () => {
  const dir = await daemonDirWithSeeded([
    { provider: "codex", accountId: ACCOUNT },
    { provider: "codex", accountId: OTHER }
  ]);
  const res = cliproxyContributor("claudex", { accountId: ACCOUNT, model: "gpt-5.6-sol" }, dir);
  assert.ok(res);
  assert.equal(res.env.ANTHROPIC_MODEL, "accabcdef12/gpt-5.6-sol");
});

test("cliproxyContributor returns null for a non-proxy entry", () => {
  assert.equal(cliproxyContributor("codex", { accountId: "x", model: undefined }, DIR), null);
});

test("cliproxyContributor: gpt launch emits window + compact window + pct", () => {
  const res = cliproxyContributor("claudex", { accountId: "system", model: "gpt-5.6-sol" }, DIR);
  assert.ok(res);
  assert.equal(res.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "200000");
  assert.equal(res.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "200000");
  assert.equal(res.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, "75");
});

test("cliproxyContributor: kimi launch emits 1M window, 450k compact window, no pct", () => {
  const res = cliproxyContributor("claudex", { model: "kimi-k3" }, DIR);
  assert.ok(res);
  assert.equal(res.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "1048576");
  assert.equal(res.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "450000");
  assert.equal(res.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, undefined);
});

test("cliproxyContributor: a PREFIXED claudemix launch rides the [1m] suffix (stripped client-side)", () => {
  // Unreadable state (DIR) forces the routing prefix. The prefixed id is
  // claude-family-classified enough that MAX_CONTEXT_TOKENS is refused, yet
  // window detection falls back to 200k — [1m] is the working lever.
  const res = cliproxyContributor("claudemix", { accountId: ACCOUNT, model: "claude-fable-5" }, DIR);
  assert.ok(res);
  assert.equal(res.env.ANTHROPIC_MODEL, "accabcdef12/claude-fable-5[1m]");
  assert.equal(res.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined, "never for claude ids");
  assert.equal(res.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "1048576");
  assert.equal(res.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, undefined);
});

test("cliproxyContributor: a 200k-class contextWindow override suppresses the [1m] suffix", async () => {
  const dir = await daemonDirWithSeeded([
    { provider: "claude", accountId: ACCOUNT },
    { provider: "claude", accountId: OTHER }
  ]);
  const stateFile = cliproxyStateFile(dir);
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  state.modelOverrides = { "claude-3-5-haiku": { contextWindow: 200000 } };
  await writeFile(stateFile, JSON.stringify(state));
  const res = cliproxyContributor("claudemix", { accountId: ACCOUNT, model: "claude-3-5-haiku" }, dir);
  assert.ok(res);
  assert.equal(res.env.ANTHROPIC_MODEL, "accabcdef12/claude-3-5-haiku", "no [1m] on a 200k-class model");
});

test("cliproxyContributor: a BARE claudemix launch (sole seeded claude account) stays arming-only", async () => {
  const dir = await daemonDirWithSeeded([{ provider: "claude", accountId: ACCOUNT }]);
  const res = cliproxyContributor("claudemix", { accountId: ACCOUNT, model: "claude-fable-5" }, dir);
  assert.ok(res);
  assert.equal(res.env.ANTHROPIC_MODEL, "claude-fable-5", "sole account launches bare");
  assert.equal(res.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "1048576");
  assert.equal(res.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined, "native recognition — no override");
});

test("cliproxyContributor: claudemix modelless launch still gets the arming window", () => {
  const res = cliproxyContributor("claudemix", {}, DIR);
  assert.ok(res);
  assert.equal(res.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "1048576");
});

test("cliproxyContributor: claudex modelless launch resolves the configured defaultModel", async () => {
  const dir = await daemonDirWithSeeded([]); // writes a parseable state.json (defaultModel: gpt-5.6-sol)
  const res = cliproxyContributor("claudex", {}, dir);
  assert.ok(res);
  assert.equal(res.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "200000");
});

test("cliproxyContributor: state modelOverrides beat curated defaults at launch", async () => {
  const dir = await daemonDirWithSeeded([]);
  const stateFile = cliproxyStateFile(dir);
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  state.modelOverrides = { "kimi-k3": { compactWindow: 500000 } };
  await writeFile(stateFile, JSON.stringify(state));
  const res = cliproxyContributor("claudex", { model: "kimi-k3" }, dir);
  assert.ok(res);
  assert.equal(res.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "500000");
});

test("composeExtraEnv carries accountId from b when a is null", () => {
  const merged = composeExtraEnv(null, { env: {}, accountId: "acc-x" });
  assert.equal(merged?.accountId, "acc-x");
});

test("composeExtraEnv prefers a's accountId when both set", () => {
  const merged = composeExtraEnv({ env: {}, accountId: "a" }, { env: {}, accountId: "b" });
  assert.equal(merged?.accountId, "a");
});
