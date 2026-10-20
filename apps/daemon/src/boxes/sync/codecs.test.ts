import assert from "node:assert/strict";
import { test } from "node:test";

import { parse as parseToml } from "@decimalturn/toml-patch";

import { secretPaths, syncCodec, type CodecContext } from "./codecs.ts";

const identity: CodecContext = { paths: { kind: "identity" } };
const windows: CodecContext = { paths: { kind: "windows-prefix", prefix: "C:\\orq" } };
const buf = (text: string): Buffer => Buffer.from(text, "utf8");

test("secret paths: MCP env/headers and credential-named keys, not names of secrets", () => {
  const doc = {
    mcpServers: { gh: { command: "gh-mcp", env: { GH_TOKEN: "ghp_x", MODE: "fast" }, headers: { Authorization: "Bearer y" } } },
    env: { GITHUB_TOKEN: "t", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000", API_KEY_ENV_VAR: "NAME" },
    apiKeyHelper: "/bin/helper",
    provider: { openai: { options: { apiKey: "sk-1" } } },
    empty: { token: "" }
  };
  const paths = secretPaths(doc).map((path) => path.join("."));
  assert.deepEqual(paths.sort(), [
    "env.GITHUB_TOKEN",
    "mcpServers.gh.env.GH_TOKEN",
    "mcpServers.gh.env.MODE",
    "mcpServers.gh.headers.Authorization",
    "provider.openai.options.apiKey"
  ]);
});

test("mcp-json blanks secrets in the box copy and restores them on approval, keeping comments", () => {
  const codec = syncCodec("mcp-json");
  const host = buf('{\n  // my servers\n  "mcp": { "db": { "type": "local", "environment": { "PASSWORD": "hunter2" } } },\n  "theme": "dark"\n}\n');
  const boxCopy = codec.toBox(host, null, identity)!;
  const text = boxCopy.toString("utf8");
  assert.ok(!text.includes("hunter2"), "the secret never reaches the box copy");
  assert.ok(text.includes("// my servers"));
  assert.ok(codec.hostView(host, identity)!.equals(boxCopy));
  // The agent adds a server next to the blanked one.
  const edited = buf(text.replace('"theme": "dark"', '"theme": "light"'));
  const restored = codec.toHost(edited, host, identity).toString("utf8");
  assert.ok(restored.includes("hunter2"));
  assert.ok(restored.includes('"theme": "light"'));
  assert.ok(restored.includes("// my servers"));
  // A value the agent set itself wins over the host's.
  const replaced = buf(text.replace('"PASSWORD": ""', '"PASSWORD": "new"'));
  assert.ok(codec.toHost(replaced, host, identity).toString("utf8").includes('"PASSWORD": "new"'));
  assert.equal(codec.executableKeysChanged(codec.hostView(host, identity), edited), false);
  assert.equal(codec.executableKeysChanged(codec.hostView(host, identity), replaced), true);
});

test("an unparseable config is never synced", () => {
  assert.equal(syncCodec("mcp-json").hostView(buf("{ broken"), identity), null);
  assert.equal(syncCodec("mcp-toml").toBox(buf("a = = 1"), null, identity), null);
});

test("mcp-toml blanks env and bearer tokens and restores them", () => {
  const codec = syncCodec("mcp-toml");
  const host = buf('# top\nmodel = "x"\n\n[mcp_servers.gh]\ncommand = "gh-mcp"\nenv = { GH_TOKEN = "ghp_secret" }\n\n[model_providers.p]\nexperimental_bearer_token = "abc"\nenv_key = "P_KEY"\n');
  const boxCopy = codec.toBox(host, null, identity)!.toString("utf8");
  assert.ok(!boxCopy.includes("ghp_secret") && !boxCopy.includes('"abc"'));
  assert.ok(boxCopy.includes("# top"));
  assert.ok(boxCopy.includes('env_key = "P_KEY"'));
  const edited = boxCopy.replace('model = "x"', 'model = "y"');
  const restored = parseToml(codec.toHost(buf(edited), host, identity).toString("utf8"));
  assert.equal(restored.model, "y");
  assert.equal(restored.mcp_servers.gh.env.GH_TOKEN, "ghp_secret");
  assert.equal(restored.model_providers.p.experimental_bearer_token, "abc");
});

test("claude-json syncs only MCP servers and project trust, merging into the box CLI's own state", () => {
  const codec = syncCodec("claude-json");
  const host = buf(
    JSON.stringify({
      oauthAccount: { emailAddress: "me@example.com" },
      userID: "u1",
      primaryApiKey: "sk-ant-x",
      numStartups: 4,
      mcpServers: { gh: { command: "gh", env: { GH_TOKEN: "ghp_1" } } },
      projects: { "/w/p": { hasTrustDialogAccepted: true, lastCost: 3, mcpServers: {} } }
    })
  );
  const fresh = JSON.parse(codec.toBox(host, null, identity)!.toString("utf8"));
  assert.equal(fresh.hasCompletedOnboarding, true);
  assert.equal(fresh.oauthAccount, undefined);
  assert.equal(fresh.userID, undefined);
  assert.equal(fresh.primaryApiKey, undefined);
  assert.equal(fresh.numStartups, undefined);
  assert.equal(fresh.mcpServers.gh.env.GH_TOKEN, "");
  assert.deepEqual(fresh.projects["/w/p"], { hasTrustDialogAccepted: true, mcpServers: {} });

  // The box CLI's own keys survive a later push, and host-only state changes are no change.
  const boxState = buf(JSON.stringify({ ...fresh, numStartups: 9, projects: { "/w/p": { ...fresh.projects["/w/p"], lastCost: 1 } } }));
  const pushed = JSON.parse(codec.toBox(host, boxState, identity)!.toString("utf8"));
  assert.equal(pushed.numStartups, 9);
  assert.equal(pushed.projects["/w/p"].lastCost, 1);
  const hostLater = buf(JSON.stringify({ ...JSON.parse(host.toString("utf8")), numStartups: 5 }));
  assert.ok(codec.hostView(hostLater, identity)!.equals(codec.boxView(boxState, identity)));

  // Approving a new server in the box: host keeps its own state and the blanked secret.
  const boxEdited = JSON.parse(boxState.toString("utf8"));
  boxEdited.mcpServers.fs = { command: "fs-mcp" };
  const approved = JSON.parse(codec.toHost(buf(JSON.stringify(boxEdited)), host, identity).toString("utf8"));
  assert.equal(approved.mcpServers.gh.env.GH_TOKEN, "ghp_1");
  assert.deepEqual(approved.mcpServers.fs, { command: "fs-mcp" });
  assert.equal(approved.oauthAccount.emailAddress, "me@example.com");
  assert.equal(approved.numStartups, 4);
  assert.equal(approved.projects["/w/p"].lastCost, 3);
  assert.equal(codec.executableKeysChanged(codec.hostView(host, identity), codec.boxView(buf(JSON.stringify(boxEdited)), identity)), true);
});

test("claude-json maps project keys to Windows box paths and back", () => {
  const codec = syncCodec("claude-json");
  const host = buf(JSON.stringify({ projects: { "/w/p": { hasTrustDialogAccepted: true } } }));
  const box = JSON.parse(codec.toBox(host, null, windows)!.toString("utf8"));
  assert.deepEqual(Object.keys(box.projects), ["C:\\orq\\w\\p"]);
  box.projects["C:\\orq\\w\\p"].allowedTools = ["Bash"];
  const approved = JSON.parse(codec.toHost(buf(JSON.stringify(box)), host, windows).toString("utf8"));
  assert.deepEqual(approved.projects["/w/p"], { hasTrustDialogAccepted: true, allowedTools: ["Bash"] });
});
