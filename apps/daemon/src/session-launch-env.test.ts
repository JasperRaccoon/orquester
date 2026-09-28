import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliproxyStateFile, type RouterProvider } from "@orquester/config";
import { writeAddonEnvLaunchScript } from "./sessions.ts";
import { cliproxyContributor } from "./index.ts";

const DIR = "/nonexistent/daemon";
const ACCOUNT = "abcdef12-3456-7890-abcd-ef1234567890";
const OTHER = "11112222-3456-7890-abcd-ef1234567890";

const NOW = "2026-08-04T00:00:00.000Z";

/** A TokenRouter-style provider: no alias, and a model name the retired
 *  kimi/moonshotai routing regex happened to match (moonshotai/…). */
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

test("launcher child receives env overrides, removals and literal arguments", async () => {
  const child = {
    bin: process.execPath,
    args: ["-e", "process.stdout.write(JSON.stringify({ home: process.env.CLAUDE_CONFIG_DIR, key: process.env.ANTHROPIC_API_KEY, args: process.argv.slice(1) }))", "a b", "$(echo injected)"]
  };
  const launch = await writeAddonEnvLaunchScript(child, { CLAUDE_CONFIG_DIR: "/x/home with 'quotes'" }, ["ANTHROPIC_API_KEY"]);
  try {
    const { stdout } = await promisify(execFile)(launch.bin, launch.args, { env: { ...process.env, ANTHROPIC_API_KEY: "inherited-secret" } });
    assert.deepEqual(JSON.parse(stdout), { home: "/x/home with 'quotes'", args: ["a b", "$(echo injected)"] });
  } finally {
    await launch.cleanup();
  }
});

test("launcher removes inherited credentials even without env overrides", async () => {
  const launch = await writeAddonEnvLaunchScript({
    bin: process.execPath,
    args: ["-e", "process.stdout.write(JSON.stringify({ key: process.env.ANTHROPIC_API_KEY }))"]
  }, {}, ["ANTHROPIC_API_KEY"]);
  try {
    const { stdout } = await promisify(execFile)(launch.bin, launch.args, { env: { ...process.env, ANTHROPIC_API_KEY: "inherited-secret" } });
    assert.deepEqual(JSON.parse(stdout), {});
  } finally {
    await launch.cleanup();
  }
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

test("cliproxyContributor: a router model's own metadata drives the window, with no pct", () => {
  // Compact metadata for a router model comes from the provider record only —
  // there is no curated/hardcoded kimi entry behind it any more.
  const res = cliproxyContributor("claudex", { model: "kimi-k3" }, DIR);
  assert.ok(res);
  assert.equal(res.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined, "unconfigured id: no window");
  assert.equal(res.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, undefined);
});

test("cliproxyContributor: a configured router model emits its 1M window, 450k compact, no pct", async () => {
  const dir = await daemonDirWithSeeded([], [OPENROUTER]);
  const res = cliproxyContributor("claudex", { model: "kimi-k3" }, dir);
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
  state.modelOverrides = { "gpt-5.6-sol": { compactWindow: 500000 } };
  await writeFile(stateFile, JSON.stringify(state));
  const res = cliproxyContributor("claudex", { model: "gpt-5.6-sol" }, dir);
  assert.ok(res);
  assert.equal(res.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "500000");
  assert.equal(res.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "200000", "unoverridden fields stay curated");
});

test("cliproxyContributor: an xAI OAuth model launches BARE with its curated compact env", async () => {
  // Same rule as router models, different reason: CLIProxyAPI routes grok ids to
  // the linked xai credential internally, so an acc<hex>/ prefix could only
  // misroute them (spec 2026-08-05 §B.3). Two seeded codex accounts make the pick
  // ambiguous, so a NON-exempt model here WOULD carry a prefix.
  const dir = await daemonDirWithSeeded([
    { provider: "codex", accountId: ACCOUNT },
    { provider: "codex", accountId: OTHER }
  ]);
  const res = cliproxyContributor("claudex", { accountId: ACCOUNT, model: "grok-build-0.1" }, dir);
  assert.ok(res);
  assert.equal(res.accountId, undefined, "grok models are served by the linked xAI account, not a seeded one");
  assert.equal(res.env.ANTHROPIC_MODEL, "grok-build-0.1", "no acc<hex>/ prefix");
  assert.equal(res.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "256000");
  // 190k, not the 256k ceiling: xAI doubles the whole request's price past 200k input.
  assert.equal(res.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "190000");
});
