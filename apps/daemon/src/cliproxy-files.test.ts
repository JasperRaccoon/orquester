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
  type CliProxySecrets,
  type RouterProvider
} from "@orquester/config";
import { renderConfigYaml, routerKimiAvailable, writeProjections, seedHome } from "./cliproxy-files.ts";

async function makeDir() {
  return mkdtemp(join(tmpdir(), "orq-cliproxy-files-"));
}

const secrets: CliProxySecrets = {
  apiKey: "LOCAL_API_KEY",
  managementSecret: "MGMT_SECRET",
  openRouterKey: null,
  routerKeys: {}
};

const openrouterProvider: RouterProvider = {
  id: "openrouter",
  label: "OpenRouter",
  baseUrl: "https://openrouter.ai/api/v1",
  preset: "openrouter",
  models: [{ name: "moonshotai/kimi-k3", alias: "kimi-k3" }],
  keyVerifiedAt: null,
  createdAt: "t"
};

test("config.yaml render: no router block without a key; block + alias with a key; bodies logging off", () => {
  const state = { ...createDefaultCliProxyState(), routerProviders: [openrouterProvider] };
  const y1 = renderConfigYaml(secrets, state);
  assert.ok(y1.includes("127.0.0.1"), "loopback host");
  assert.ok(y1.includes(String(state.port)), "port");
  assert.ok(y1.includes("LOCAL_API_KEY"), "api key");
  assert.ok(y1.includes("MGMT_SECRET"), "management secret");
  assert.ok(/log-request-body:\s*false/.test(y1), "request bodies off");
  assert.ok(/log-response-body:\s*false/.test(y1), "response bodies off");
  assert.ok(!y1.includes("openai-compatibility"), "no router block without a key");
  assert.ok(!y1.includes("kimi-k3"), "no alias without a key");

  const y2 = renderConfigYaml({ ...secrets, routerKeys: { openrouter: "OR_KEY" } }, state);
  assert.ok(y2.includes("openai-compatibility"), "router block present");
  assert.ok(y2.includes("OR_KEY"), "router key present");
  assert.ok(y2.includes("kimi-k3"), "alias present");
  assert.ok(y2.includes("moonshotai/kimi-k3"), "resolved model present");

  // The legacy field alone no longer projects anything — routerProviders is the
  // only source of truth (the manager migrates openRouterKey into one).
  assert.ok(
    !renderConfigYaml({ ...secrets, openRouterKey: "OR_KEY" }, createDefaultCliProxyState()).includes(
      "openai-compatibility"
    ),
    "legacy key alone renders no provider block"
  );
});

test("renderConfigYaml emits one openai-compatibility entry per keyed provider with models", () => {
  const state = {
    ...createDefaultCliProxyState(),
    routerProviders: [
      openrouterProvider,
      {
        id: "tokenrouter",
        label: "TokenRouter",
        baseUrl: "https://api.tokenrouter.com/v1",
        preset: "tokenrouter" as const,
        models: [{ name: "moonshotai/kimi-k3-free" }],
        keyVerifiedAt: null,
        createdAt: "t"
      },
      {
        id: "keyless",
        label: "NoKey",
        baseUrl: "https://x.example/v1",
        preset: null,
        models: [{ name: "m/x" }],
        keyVerifiedAt: null,
        createdAt: "t"
      },
      {
        id: "modelless",
        label: "NoModels",
        baseUrl: "https://y.example/v1",
        preset: null,
        models: [],
        keyVerifiedAt: null,
        createdAt: "t"
      }
    ]
  };
  const s = { ...secrets, routerKeys: { openrouter: "sk-or-1", tokenrouter: "sk-tr-1", modelless: "sk-m-1" } };
  const yaml = renderConfigYaml(s, state);
  assert.match(yaml, /name: "openrouter"/);
  assert.match(yaml, /name: "tokenrouter"/);
  assert.match(yaml, /base-url: "https:\/\/api\.tokenrouter\.com\/v1"/);
  assert.match(yaml, /alias: "kimi-k3"/);
  assert.match(yaml, /- api-key: "sk-tr-1"/);
  assert.doesNotMatch(yaml, /keyless/, "keyless provider skipped");
  assert.doesNotMatch(yaml, /modelless/, "provider with no models skipped");
  // Exactly one `openai-compatibility:` header for all providers.
  assert.equal(yaml.match(/^openai-compatibility:$/gm)?.length, 1);
  // models stays PROVIDER-level: exactly one indent level under the provider item
  assert.match(yaml, /    models:\n      - name: "moonshotai\/kimi-k3"/);
});

test("routerKimiAvailable tracks a keyed provider serving kimi-k3 by name or alias", () => {
  const state = { ...createDefaultCliProxyState(), routerProviders: [openrouterProvider] };
  assert.equal(routerKimiAvailable(state, secrets), false, "no key → unavailable");
  assert.equal(
    routerKimiAvailable(state, { ...secrets, routerKeys: { openrouter: "k" } }),
    true,
    "keyed provider with the kimi-k3 alias → available"
  );
  const byName = {
    ...createDefaultCliProxyState(),
    routerProviders: [
      { ...openrouterProvider, id: "tr", label: "TokenRouter", models: [{ name: "kimi-k3" }] }
    ]
  };
  assert.equal(routerKimiAvailable(byName, { ...secrets, routerKeys: { tr: "k" } }), true, "bare name matches");
  const other = {
    ...createDefaultCliProxyState(),
    routerProviders: [{ ...openrouterProvider, models: [{ name: "moonshotai/kimi-k3-free" }] }]
  };
  assert.equal(
    routerKimiAvailable(other, { ...secrets, routerKeys: { openrouter: "k" } }),
    false,
    "a different model id does not arm the kimi-k3 slot"
  );
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

  // With a keyed router provider serving kimi-k3, claudex gains the Fable slot.
  await writeProjections(
    dir,
    { ...secrets, routerKeys: { openrouter: "OR_KEY" } },
    { ...state, routerProviders: [openrouterProvider] }
  );
  const claudexOr = await readFile(join(dir, "env", "claudex.env"), "utf8");
  assert.ok(claudexOr.includes("ANTHROPIC_DEFAULT_FABLE_MODEL=kimi-k3"), "kimi slot with a key");
});

test("claudex.env Fable slot follows kimi-k3 availability across providers", async () => {
  const dir = await makeDir();
  const state = createDefaultCliProxyState();
  const envFile = join(dir, "env", "claudex.env");

  // A keyed provider serving the kimi-k3 alias arms the slot, labelled with the
  // provider that actually serves it.
  await writeProjections(
    dir,
    { ...secrets, routerKeys: { openrouter: "OR_KEY" } },
    { ...state, routerProviders: [openrouterProvider] }
  );
  const armed = await readFile(envFile, "utf8");
  assert.ok(armed.includes("ANTHROPIC_DEFAULT_FABLE_MODEL=kimi-k3"), "fable slot armed");
  assert.ok(armed.includes("ANTHROPIC_DEFAULT_FABLE_MODEL_NAME=Kimi K3"), "fable slot named");
  assert.ok(
    armed.includes("ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION=Moonshot Kimi via OpenRouter"),
    "fable description names the serving provider"
  );

  // A different provider serving the same pick relabels the slot.
  await writeProjections(
    dir,
    { ...secrets, routerKeys: { tokenrouter: "TR_KEY" } },
    {
      ...state,
      routerProviders: [
        {
          id: "tokenrouter",
          label: "TokenRouter",
          baseUrl: "https://api.tokenrouter.com/v1",
          preset: "tokenrouter",
          models: [{ name: "moonshotai/kimi-k3", alias: "kimi-k3" }],
          keyVerifiedAt: null,
          createdAt: "t"
        }
      ]
    }
  );
  const relabelled = await readFile(envFile, "utf8");
  assert.ok(
    relabelled.includes("ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION=Moonshot Kimi via TokenRouter"),
    "fable description follows the serving provider"
  );

  // No provider serves kimi-k3 → no Fable rows at all.
  await writeProjections(
    dir,
    { ...secrets, routerKeys: { tokenrouter: "TR_KEY" } },
    {
      ...state,
      routerProviders: [
        {
          id: "tokenrouter",
          label: "TokenRouter",
          baseUrl: "https://api.tokenrouter.com/v1",
          preset: "tokenrouter",
          models: [{ name: "moonshotai/kimi-k3-free" }],
          keyVerifiedAt: null,
          createdAt: "t"
        }
      ]
    }
  );
  const disarmed = await readFile(envFile, "utf8");
  assert.ok(!disarmed.includes("ANTHROPIC_DEFAULT_FABLE_MODEL"), "no fable rows without a kimi-k3 provider");
});

test("writeProjections rejects a poisoned router model name or alias", async () => {
  const dir = await makeDir();
  const state = createDefaultCliProxyState();
  await assert.rejects(() =>
    writeProjections(dir, { ...secrets, routerKeys: { openrouter: "k" } }, {
      ...state,
      routerProviders: [{ ...openrouterProvider, models: [{ name: "x; rm -rf" }] }]
    })
  );
  await assert.rejects(() =>
    writeProjections(dir, { ...secrets, routerKeys: { openrouter: "k" } }, {
      ...state,
      routerProviders: [{ ...openrouterProvider, models: [{ name: "ok/model", alias: "bad alias" }] }]
    })
  );
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

test("seedHome: scrubs model-routing env keys from a copied settings.json, keeps the rest", async () => {
  const dir = await makeDir();
  const sysDir = await mkdtemp(join(tmpdir(), "orq-sysclaude-"));
  await writeFile(join(sysDir, ".claude.json"), "{}");
  await writeFile(
    join(sysDir, "settings.json"),
    JSON.stringify({
      theme: "dark",
      env: { MCP_TIMEOUT: "60000", CLAUDE_CODE_SUBAGENT_MODEL: "opus", ANTHROPIC_BASE_URL: "http://stale:1" }
    })
  );

  await seedHome(dir, "claudex", sysDir, join(sysDir, ".claude.json"));
  const file = join(cliproxyHomeDir(dir, "claudex"), "settings.json");
  const settings = JSON.parse(await readFile(file, "utf8"));
  assert.equal(settings.env.CLAUDE_CODE_SUBAGENT_MODEL, undefined, "subagent pin scrubbed");
  assert.equal(settings.env.ANTHROPIC_BASE_URL, undefined, "endpoint scrubbed");
  assert.equal(settings.env.MCP_TIMEOUT, "60000", "non-routing env kept");
  assert.equal(settings.theme, "dark", "other settings kept");
  assert.equal(settings.autoCompactEnabled, true, "managed keys still merged");

  // Re-seed heals a home whose settings picked the keys up from an OLD copy.
  const polluted = { ...settings, env: { ...settings.env, CLAUDE_CODE_SUBAGENT_MODEL: "opus" } };
  await writeFile(file, JSON.stringify(polluted));
  await seedHome(dir, "claudex", sysDir, join(sysDir, ".claude.json"));
  const healed = JSON.parse(await readFile(file, "utf8"));
  assert.equal(healed.env.CLAUDE_CODE_SUBAGENT_MODEL, undefined, "existing home healed on re-seed");
});

test("seedHome: seeds managed model-pinned subagents; kimi rides the router availability flag", async () => {
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

test("seedHome: seeds the managed delegation CLAUDE.md into claudemix only, kimi line riding the key", async () => {
  const dir = await makeDir();
  const sysDir = await mkdtemp(join(tmpdir(), "orq-sysclaude-"));
  await writeFile(join(sysDir, ".claude.json"), "{}");

  // claudex never gets the memory file; claudemix with unknown key state doesn't either.
  await seedHome(dir, "claudex", sysDir, join(sysDir, ".claude.json"), true);
  assert.ok(!existsSync(join(cliproxyHomeDir(dir, "claudex"), "CLAUDE.md")), "claudex has no managed memory");
  await seedHome(dir, "claudemix", sysDir, join(sysDir, ".claude.json"));
  const memFile = join(cliproxyHomeDir(dir, "claudemix"), "CLAUDE.md");
  assert.ok(!existsSync(memFile), "unknown key state writes nothing");

  // Known key state writes it; kimi mentions track the flag.
  await seedHome(dir, "claudemix", sysDir, join(sysDir, ".claude.json"), true);
  const withKimi = await readFile(memFile, "utf8");
  assert.ok(withKimi.includes('subagent_type values: "gpt-sol"'), "names the subagent types");
  assert.ok(withKimi.includes('"kimi"') && withKimi.includes("kimi-k3"), "kimi listed with a key");
  await seedHome(dir, "claudemix", sysDir, join(sysDir, ".claude.json"), false);
  const withoutKimi = await readFile(memFile, "utf8");
  assert.ok(!withoutKimi.includes("kimi"), "kimi absent without a key");
  assert.ok(withoutKimi.includes("gpt-luna"), "gpt rows remain");
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

test("seedHome: the managed grok subagent rides the xai link gate, independent of kimi", async () => {
  const dir = await makeDir();
  const sysDir = await mkdtemp(join(tmpdir(), "orq-sysclaude-"));
  await writeFile(join(sysDir, ".claude.json"), "{}");
  const agents = join(cliproxyHomeDir(dir, "claudemix"), "agents");

  // Link state unknown (5-arg legacy call): grok untouched, kimi still gated on its own flag.
  await seedHome(dir, "claudemix", sysDir, join(sysDir, ".claude.json"), true);
  assert.ok(existsSync(join(agents, "kimi.md")), "kimi seeded by its own gate");
  assert.ok(!existsSync(join(agents, "grok.md")), "grok absent while the link state is unknown");

  // Linked: grok appears pinned to the coding-trained default, with no key at all.
  await seedHome(dir, "claudemix", sysDir, join(sysDir, ".claude.json"), false, true);
  const grok = await readFile(join(agents, "grok.md"), "utf8");
  assert.ok(grok.includes("name: grok"), "grok named");
  assert.ok(grok.includes("model: grok-build-0.1"), "grok pinned to the default of the curated pair");
  assert.ok(!existsSync(join(agents, "kimi.md")), "the two gates are independent");

  // Unlinked: the managed grok.md is removed again.
  await seedHome(dir, "claudemix", sysDir, join(sysDir, ".claude.json"), false, false);
  assert.ok(!existsSync(join(agents, "grok.md")), "grok removed with the account");
});

test("seedHome: the delegation CLAUDE.md names grok only while the xai account is linked", async () => {
  const dir = await makeDir();
  const sysDir = await mkdtemp(join(tmpdir(), "orq-sysclaude-"));
  await writeFile(join(sysDir, ".claude.json"), "{}");
  const memFile = join(cliproxyHomeDir(dir, "claudemix"), "CLAUDE.md");

  await seedHome(dir, "claudemix", sysDir, join(sysDir, ".claude.json"), false, true);
  const withGrok = await readFile(memFile, "utf8");
  assert.ok(withGrok.includes('"grok"') && withGrok.includes("grok-build-0.1"), "grok listed while linked");
  assert.ok(withGrok.includes("# Model proxy: delegating to GPT / Grok"), "title tracks the gates");
  assert.ok(!withGrok.includes("kimi"), "kimi stays on its own gate");

  await seedHome(dir, "claudemix", sysDir, join(sysDir, ".claude.json"), true, false);
  const withoutGrok = await readFile(memFile, "utf8");
  assert.ok(!withoutGrok.includes("grok"), "grok absent once unlinked");
  assert.ok(withoutGrok.includes("# Model proxy: delegating to GPT / Kimi"));
});
