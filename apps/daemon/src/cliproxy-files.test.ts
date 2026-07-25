import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, writeFile, readFile, stat, lstat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createDefaultCliProxyState,
  cliproxyTokenFile,
  cliproxyHomeDir,
  type CliProxySecrets
} from "@orquester/config";
import { renderConfigYaml, writeProjections, seedHome } from "./cliproxy-files.ts";

async function makeDir() {
  return mkdtemp(join(tmpdir(), "orq-cliproxy-files-"));
}

const secrets: CliProxySecrets = {
  apiKey: "LOCAL_API_KEY",
  managementSecret: "MGMT_SECRET",
  openRouterKey: null
};

test("config.yaml render: no openrouter block without key; block + alias with key; bodies logging off", () => {
  const state = createDefaultCliProxyState();
  const y1 = renderConfigYaml(secrets, state);
  assert.ok(y1.includes("127.0.0.1"), "loopback host");
  assert.ok(y1.includes(String(state.port)), "port");
  assert.ok(y1.includes("LOCAL_API_KEY"), "api key");
  assert.ok(y1.includes("MGMT_SECRET"), "management secret");
  assert.ok(/log-request-body:\s*false/.test(y1), "request bodies off");
  assert.ok(/log-response-body:\s*false/.test(y1), "response bodies off");
  assert.ok(!y1.includes("openai-compatibility"), "no openrouter block without key");
  assert.ok(!y1.includes("kimi-k3"), "no alias without key");

  const y2 = renderConfigYaml({ ...secrets, openRouterKey: "OR_KEY" }, state);
  assert.ok(y2.includes("openai-compatibility"), "openrouter block present");
  assert.ok(y2.includes("OR_KEY"), "openrouter key present");
  assert.ok(y2.includes("kimi-k3"), "alias present");
  assert.ok(y2.includes("moonshotai/kimi-k3"), "resolved model present");
});

test("projections: token==apiKey; claudex.env contains ANTHROPIC_MODEL + CLAUDE_CONFIG_DIR; claudemix.env has haiku=backgroundModel and NO ANTHROPIC_MODEL", async () => {
  const dir = await makeDir();
  const state = { ...createDefaultCliProxyState(), defaultModel: "gpt-5.6-sol", backgroundModel: "gpt-5.6-cheap" };
  await writeProjections(dir, secrets, state);

  const tokenFile = cliproxyTokenFile(dir);
  assert.equal(await readFile(tokenFile, "utf8"), "LOCAL_API_KEY\n");
  assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);

  const claudex = await readFile(join(dir, "env", "claudex.env"), "utf8");
  assert.ok(claudex.includes("ANTHROPIC_MODEL=gpt-5.6-sol"), "claudex main model");
  assert.ok(claudex.includes("ANTHROPIC_DEFAULT_HAIKU_MODEL=gpt-5.6-cheap"), "claudex background model");
  assert.ok(claudex.includes(`CLAUDE_CONFIG_DIR=${cliproxyHomeDir(dir, "claudex")}`), "claudex home");
  assert.equal((await stat(join(dir, "env", "claudex.env"))).mode & 0o777, 0o600);

  // Picker slots: curated GPT rows always; Kimi's Fable slot only with a key.
  assert.ok(claudex.includes("ANTHROPIC_DEFAULT_OPUS_MODEL=gpt-5.6-sol"), "sol slot");
  assert.ok(claudex.includes("ANTHROPIC_DEFAULT_SONNET_MODEL=gpt-5.6-terra"), "terra slot");
  assert.ok(!claudex.includes("ANTHROPIC_DEFAULT_FABLE_MODEL"), "no kimi slot without a key");

  const claudemix = await readFile(join(dir, "env", "claudemix.env"), "utf8");
  assert.ok(claudemix.includes("ANTHROPIC_DEFAULT_HAIKU_MODEL=gpt-5.6-cheap"), "claudemix background model");
  assert.ok(claudemix.includes(`CLAUDE_CONFIG_DIR=${cliproxyHomeDir(dir, "claudemix")}`), "claudemix home");
  assert.ok(!/^ANTHROPIC_MODEL=/m.test(claudemix), "claudemix has no main model override");
  assert.ok(claudemix.includes("ANTHROPIC_CUSTOM_MODEL_OPTION=gpt-5.6-sol"), "claudemix custom GPT row");

  // Client-side tool search re-armed in both launchers (auto-disabled on a
  // non-first-party base URL; verified safe through the proxy on all routes).
  assert.ok(claudex.includes("ENABLE_TOOL_SEARCH=true"), "claudex tool search on");
  assert.ok(claudemix.includes("ENABLE_TOOL_SEARCH=true"), "claudemix tool search on");

  // With an OpenRouter key, claudex gains the Kimi Fable slot.
  await writeProjections(dir, { ...secrets, openRouterKey: "OR_KEY" }, state);
  const claudexOr = await readFile(join(dir, "env", "claudex.env"), "utf8");
  assert.ok(claudexOr.includes("ANTHROPIC_DEFAULT_FABLE_MODEL=kimi-k3"), "kimi slot with a key");
});

test("wrapper: generated script has no 'source', reads token file path, claudex handles --model", async () => {
  const dir = await makeDir();
  await writeProjections(dir, secrets, createDefaultCliProxyState());
  const appdir = dirname(dir);
  const binPath = (name: string) => join(appdir, ".npm-global", "bin", name);

  const sh = await readFile(binPath("claudex"), "utf8");
  assert.ok(!/\bsource\b|^\s*\.\s/m.test(sh), "no shell sourcing");
  assert.ok(sh.includes("cliproxy/token"), "reads the token file");
  assert.ok(sh.includes("--model"), "claudex supports --model");
  assert.equal((await stat(binPath("claudex"))).mode & 0o777, 0o700);

  const mix = await readFile(binPath("claudemix"), "utf8");
  assert.ok(!/\bsource\b|^\s*\.\s/m.test(mix), "no shell sourcing (claudemix)");
  assert.equal((await stat(binPath("claudemix"))).mode & 0o777, 0o700);
});

test("model charset: writeProjections rejects defaultModel 'x; rm -rf'", async () => {
  const dir = await makeDir();
  const badState = { ...createDefaultCliProxyState(), defaultModel: "x; rm -rf" };
  await assert.rejects(() => writeProjections(dir, secrets, badState));
});

test("seedHome: 0700, marker, .claude.json identity stripped, projects/ absent, skills symlinked", async () => {
  const dir = await makeDir();
  const sysDir = await mkdtemp(join(tmpdir(), "orq-sysclaude-"));
  await mkdir(join(sysDir, "skills"), { recursive: true });
  await mkdir(join(sysDir, "plugins"), { recursive: true });
  await writeFile(
    join(sysDir, ".claude.json"),
    JSON.stringify({ oauthAccount: { email: "x" }, userID: "uid", hasCompletedOnboarding: false, mcpServers: { a: 1 } })
  );
  await writeFile(join(sysDir, "settings.json"), "{}");

  await seedHome(dir, "claudex", sysDir, join(sysDir, ".claude.json"));
  const home = cliproxyHomeDir(dir, "claudex");

  assert.equal((await stat(home)).mode & 0o777, 0o700);
  assert.equal((await readFile(join(home, ".orq-cliproxy-home"), "utf8")).trim(), "claudex");

  const cj = JSON.parse(await readFile(join(home, ".claude.json"), "utf8"));
  assert.equal(cj.oauthAccount, undefined, "oauthAccount stripped");
  assert.equal(cj.userID, undefined, "userID stripped");
  assert.equal(cj.hasCompletedOnboarding, true, "onboarding forced");

  assert.ok(!existsSync(join(home, "projects")), "projects/ never seeded");
  assert.ok((await lstat(join(home, "skills"))).isSymbolicLink(), "skills symlinked");
  assert.ok(existsSync(join(home, "settings.json")), "settings.json seeded");

  // Re-entry with the correct marker is a no-op (no throw).
  await seedHome(dir, "claudex", sysDir, join(sysDir, ".claude.json"));
});

test("seedHome: HOME-level system .claude.json (sibling of ~/.claude) seeds the onboarding flag", async () => {
  const dir = await makeDir();
  // Production layout without CLAUDE_CONFIG_DIR: ~/.claude/ is the config dir,
  // but .claude.json sits NEXT TO it at HOME level — reading <dir>/.claude.json
  // found nothing and every proxy session got the first-run onboarding flow.
  const homeLevel = await mkdtemp(join(tmpdir(), "orq-syshome-"));
  const sysDir = join(homeLevel, ".claude");
  await mkdir(sysDir, { recursive: true });
  await writeFile(join(homeLevel, ".claude.json"), JSON.stringify({ userID: "uid", theme: "dark" }));

  await seedHome(dir, "claudex", sysDir, join(homeLevel, ".claude.json"));
  const cj = JSON.parse(await readFile(join(cliproxyHomeDir(dir, "claudex"), ".claude.json"), "utf8"));
  assert.equal(cj.hasCompletedOnboarding, true, "onboarding forced");
  assert.equal(cj.userID, undefined, "identity stripped");
  assert.equal(cj.theme, "dark", "shared config copied");
});

test("seedHome: no system .claude.json anywhere still writes hasCompletedOnboarding", async () => {
  const dir = await makeDir();
  const sysDir = await mkdtemp(join(tmpdir(), "orq-sysempty-"));
  await seedHome(dir, "claudex", sysDir, join(sysDir, ".claude.json"));
  const cj = JSON.parse(await readFile(join(cliproxyHomeDir(dir, "claudex"), ".claude.json"), "utf8"));
  assert.equal(cj.hasCompletedOnboarding, true);
});

test("seedHome: seeds managed model-pinned subagents; kimi rides the OpenRouter flag", async () => {
  const dir = await makeDir();
  const sysDir = await mkdtemp(join(tmpdir(), "orq-sysclaude-"));
  await writeFile(join(sysDir, ".claude.json"), "{}");
  const agents = join(cliproxyHomeDir(dir, "claudemix"), "agents");

  // Key state unknown (secrets not loaded): GPT agents seeded, kimi untouched.
  await seedHome(dir, "claudemix", sysDir, join(sysDir, ".claude.json"));
  const sol = await readFile(join(agents, "gpt-sol.md"), "utf8");
  assert.ok(sol.includes("name: gpt-sol"), "sol named");
  assert.ok(sol.includes("model: gpt-5.6-sol"), "sol pinned");
  assert.ok(existsSync(join(agents, "gpt-terra.md")), "terra seeded");
  assert.ok(existsSync(join(agents, "gpt-luna.md")), "luna seeded");
  assert.ok(!existsSync(join(agents, "kimi.md")), "kimi absent while key state unknown");

  // Key present: kimi appears, pinned to kimi-k3.
  await seedHome(dir, "claudemix", sysDir, join(sysDir, ".claude.json"), true);
  assert.ok((await readFile(join(agents, "kimi.md"), "utf8")).includes("model: kimi-k3"), "kimi pinned");

  // Key gone: the managed kimi.md is removed; user agents are never touched.
  await writeFile(join(agents, "mine.md"), "---\nname: mine\n---\nbody\n");
  await seedHome(dir, "claudemix", sysDir, join(sysDir, ".claude.json"), false);
  assert.ok(!existsSync(join(agents, "kimi.md")), "kimi removed with the key");
  assert.equal(await readFile(join(agents, "mine.md"), "utf8"), "---\nname: mine\n---\nbody\n", "user agent untouched");
});

test("seedHome: forces autoCompactEnabled:true into an existing settings.json, preserving other keys", async () => {
  const dir = await makeDir();
  const sysDir = await mkdtemp(join(tmpdir(), "orq-sysac-"));
  await writeFile(join(sysDir, "settings.json"), JSON.stringify({ autoCompactEnabled: false, theme: "dark" }));
  await seedHome(dir, "claudex", sysDir, join(sysDir, ".claude.json"));
  const settings = JSON.parse(
    await readFile(join(cliproxyHomeDir(dir, "claudex"), "settings.json"), "utf8")
  );
  assert.equal(settings.autoCompactEnabled, true, "managed key forced");
  assert.equal(settings.theme, "dark", "other keys preserved");
});

test("seedHome: creates settings.json with managed keys when the system has none", async () => {
  const dir = await makeDir();
  const sysDir = await mkdtemp(join(tmpdir(), "orq-sysnone-"));
  await seedHome(dir, "claudex", sysDir, join(sysDir, ".claude.json"));
  const settings = JSON.parse(
    await readFile(join(cliproxyHomeDir(dir, "claudex"), "settings.json"), "utf8")
  );
  assert.equal(settings.autoCompactEnabled, true);
});

test("seedHome: settings merge is idempotent and survives a malformed file", async () => {
  const dir = await makeDir();
  const sysDir = await mkdtemp(join(tmpdir(), "orq-sysbad-"));
  await seedHome(dir, "claudex", sysDir, join(sysDir, ".claude.json"));
  const file = join(cliproxyHomeDir(dir, "claudex"), "settings.json");
  await writeFile(file, "{not json");
  await seedHome(dir, "claudex", sysDir, join(sysDir, ".claude.json")); // must not throw
  const settings = JSON.parse(await readFile(file, "utf8"));
  assert.equal(settings.autoCompactEnabled, true, "malformed file replaced with managed keys");
});
