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

  const claudemix = await readFile(join(dir, "env", "claudemix.env"), "utf8");
  assert.ok(claudemix.includes("ANTHROPIC_DEFAULT_HAIKU_MODEL=gpt-5.6-cheap"), "claudemix background model");
  assert.ok(claudemix.includes(`CLAUDE_CONFIG_DIR=${cliproxyHomeDir(dir, "claudemix")}`), "claudemix home");
  assert.ok(!/^ANTHROPIC_MODEL=/m.test(claudemix), "claudemix has no main model override");
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

  await seedHome(dir, "claudex", sysDir);
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
  await seedHome(dir, "claudex", sysDir);
});
