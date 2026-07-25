import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliproxyStateFile } from "@orquester/config";
import { writeAddonEnvLaunchScript } from "./sessions.ts";
import { cliproxyContributor, composeExtraEnv } from "./index.ts";

const DIR = "/nonexistent/daemon";
const ACCOUNT = "abcdef12-3456-7890-abcd-ef1234567890";
const OTHER = "11112222-3456-7890-abcd-ef1234567890";

/** Temp daemonDir with a state.json seeding the given accounts. */
async function daemonDirWithSeeded(
  accounts: Array<{ provider: "codex" | "claude"; accountId: string }>
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
      }))
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

test("cliproxyContributor records no account for an OpenRouter/Kimi model", () => {
  const res = cliproxyContributor("claudex", { accountId: ACCOUNT, model: "kimi-k3" }, DIR);
  assert.ok(res);
  assert.equal(res.accountId, undefined);
  assert.equal(res.env.ANTHROPIC_MODEL, "kimi-k3");
});

test("cliproxyContributor pins the account for claudemix", () => {
  const res = cliproxyContributor("claudemix", { accountId: ACCOUNT, model: "claude-fable-5" }, DIR);
  assert.ok(res);
  assert.equal(res.accountId, ACCOUNT);
  assert.equal(res.env.ANTHROPIC_MODEL, "accabcdef12/claude-fable-5");
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

test("cliproxyContributor: claudemix claude launch gets the arming window only", () => {
  const res = cliproxyContributor("claudemix", { accountId: ACCOUNT, model: "claude-fable-5" }, DIR);
  assert.ok(res);
  assert.equal(res.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "1048576");
  assert.equal(res.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined, "never for claude ids");
  assert.equal(res.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, undefined);
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
