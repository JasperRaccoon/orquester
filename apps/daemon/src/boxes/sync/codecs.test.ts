import assert from "node:assert/strict";
import { test } from "node:test";

import { parse as parseToml } from "@decimalturn/toml-patch";

import { syncCodec, type CodecContext } from "./codecs.ts";
import { executableConfigKeys } from "./rules.ts";

const identity: CodecContext = { paths: { kind: "identity" } };
const windows: CodecContext = { paths: { kind: "windows-prefix", prefix: "C:\\orq" } };
const buf = (text: string): Buffer => Buffer.from(text, "utf8");

test("the box copy blanks nested credential values while preserving settings that name credentials", () => {
  const doc = {
    mcpServers: { gh: { command: "gh-mcp", env: { GH_TOKEN: "ghp_x", MODE: "fast" }, headers: { Authorization: "Bearer y" } } },
    env: { GITHUB_TOKEN: "t", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000", API_KEY_ENV_VAR: "NAME" },
    apiKeyHelper: "/bin/helper",
    provider: { openai: { options: { apiKey: "sk-1" } } },
    empty: { token: "" }
  };
  const copy = syncCodec("mcp-json").toBox(buf(JSON.stringify(doc)), null, identity);
  assert.ok(copy);
  assert.deepEqual(JSON.parse(copy.toString("utf8")), {
    mcpServers: { gh: { command: "gh-mcp", env: { GH_TOKEN: "", MODE: "" }, headers: { Authorization: "" } } },
    env: { GITHUB_TOKEN: "", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000", API_KEY_ENV_VAR: "NAME" },
    apiKeyHelper: "/bin/helper",
    provider: { openai: { options: { apiKey: "" } } },
    empty: { token: "" }
  });
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
  const keys = executableConfigKeys("opencode", "opencode.json");
  assert.equal(codec.executableKeysChanged(codec.hostView(host, identity), edited, keys), false);
  assert.equal(codec.executableKeysChanged(codec.hostView(host, identity), replaced, keys), true);
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

test("codex-toml: the project trust Codex adds in a box stays there and never reaches the host", () => {
  const codec = syncCodec("codex-toml");
  const doc = (bytes: Buffer) => JSON.parse(JSON.stringify(parseToml(bytes.toString("utf8"))));
  const host = buf('# mine\nmodel = "x"\n\n[mcp_servers.gh]\ncommand = "gh-mcp"\nenv = { GH_TOKEN = "ghp_secret" }\n\n[projects."/host/trusted"]\ntrust_level = "trusted"\n');
  const trusted = buf('# mine\nmodel = "x"\n\n[mcp_servers.gh]\ncommand = "gh-mcp"\nenv = { GH_TOKEN = "" }\n\n[projects."/host/trusted"]\ntrust_level = "untrusted"\n\n[projects."/w/box-project"]\ntrust_level = "trusted"\n');

  // A host push owns its trust entries while retaining the box's local entries.
  const hostLater = buf(host.toString("utf8").replace('model = "x"', 'model = "y"'));
  assert.deepEqual(doc(codec.toBox(hostLater, trusted, identity)!), {
    model: "y",
    mcp_servers: { gh: { command: "gh-mcp", env: { GH_TOKEN: "" } } },
    projects: { "/host/trusted": { trust_level: "trusted" }, "/w/box-project": { trust_level: "trusted" } }
  });
  const hostUntrusts = buf(host.toString("utf8").replace('trust_level = "trusted"', 'trust_level = "untrusted"'));
  assert.equal(doc(codec.toBox(hostUntrusts, trusted, identity)!).projects["/host/trusted"].trust_level, "untrusted");

  const edited = buf(trusted.toString("utf8").replace('model = "x"', 'model = "z"'));
  assert.deepEqual(doc(codec.boxView(edited, host, identity)), {
    model: "z",
    mcp_servers: { gh: { command: "gh-mcp", env: { GH_TOKEN: "" } } },
    projects: { "/host/trusted": { trust_level: "trusted" } }
  });
  const approved = codec.toHost(edited, host, identity);
  assert.deepEqual(doc(approved), {
    model: "z",
    mcp_servers: { gh: { command: "gh-mcp", env: { GH_TOKEN: "ghp_secret" } } },
    projects: { "/host/trusted": { trust_level: "trusted" } }
  });
  const approvedText = approved.toString("utf8");
  assert.ok(approvedText.includes("# mine"));

  // With no host trust, only unrelated project settings survive the box edit.
  const plain = buf('model = "x"\n');
  const boxOnly = buf('model = "y"\n\n[projects."/w/p"]\ntrust_level = "trusted"\n');
  assert.deepEqual(doc(codec.toHost(boxOnly, plain, identity)), { model: "y" });
  const withOther = buf(`${boxOnly.toString("utf8")}other = 1\n`);
  assert.deepEqual(doc(codec.boxView(withOther, plain, identity)), { model: "y", projects: { "/w/p": { other: 1 } } });
  assert.deepEqual(doc(codec.toHost(withOther, plain, identity)), { model: "y", projects: { "/w/p": { other: 1 } } });
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
  const shareable = {
    mcpServers: { gh: { command: "gh", env: { GH_TOKEN: "" } } },
    projects: { "/w/p": { hasTrustDialogAccepted: true, mcpServers: {} } }
  };
  assert.deepEqual(JSON.parse(codec.hostView(hostLater, identity)!.toString("utf8")), shareable);
  assert.deepEqual(JSON.parse(codec.boxView(boxState, hostLater, identity).toString("utf8")), shareable);

  // Approving a new server in the box: host keeps its own state and the blanked secret.
  const boxEdited = JSON.parse(boxState.toString("utf8"));
  boxEdited.mcpServers.fs = { command: "fs-mcp" };
  const approved = JSON.parse(codec.toHost(buf(JSON.stringify(boxEdited)), host, identity).toString("utf8"));
  assert.equal(approved.mcpServers.gh.env.GH_TOKEN, "ghp_1");
  assert.deepEqual(approved.mcpServers.fs, { command: "fs-mcp" });
  assert.equal(approved.oauthAccount.emailAddress, "me@example.com");
  assert.equal(approved.numStartups, 4);
  assert.equal(approved.projects["/w/p"].lastCost, 3);
  assert.equal(
    codec.executableKeysChanged(codec.hostView(host, identity), codec.boxView(buf(JSON.stringify(boxEdited)), host, identity), executableConfigKeys("claude", ".claude.json")),
    true
  );
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

test("S4: a blanked secret is never restored next to a target the box changed", () => {
  const codec = syncCodec("mcp-json");
  const host = buf(
    JSON.stringify(
      {
        mcpServers: {
          gh: { type: "http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer ghp_secret" } },
          db: { command: "db-mcp", env: { DB_PASSWORD: "pw_secret", DB_HOST: "db.internal" } }
        },
        env: { ANTHROPIC_API_KEY: "sk-ant-secret", ANTHROPIC_BASE_URL: "https://api.anthropic.com" }
      },
      null,
      2
    )
  );
  const box = JSON.parse(codec.toBox(host, null, identity)!.toString("utf8"));
  const approve = (edit: (doc: typeof box) => void) => {
    const doc = structuredClone(box);
    edit(doc);
    return JSON.parse(codec.toHost(buf(JSON.stringify(doc, null, 2)), host, identity).toString("utf8"));
  };

  // Targets unchanged: every secret comes back (the env table's own host too).
  const same = approve((doc) => (doc.theme = "dark"));
  assert.equal(same.mcpServers.gh.headers.Authorization, "Bearer ghp_secret");
  assert.equal(same.mcpServers.db.env.DB_PASSWORD, "pw_secret");
  assert.equal(same.mcpServers.db.env.DB_HOST, "db.internal");
  assert.equal(same.env.ANTHROPIC_API_KEY, "sk-ant-secret");

  // Redirected: the URL a header goes to, the command an env reaches, a base URL next to a key, a host in the env table.
  const redirected = approve((doc) => {
    doc.mcpServers.gh.url = "https://evil.example/mcp";
    doc.mcpServers.db.command = "exfiltrate";
    doc.env.ANTHROPIC_BASE_URL = "https://evil.example";
  });
  assert.equal(redirected.mcpServers.gh.headers.Authorization, "");
  assert.equal(redirected.mcpServers.db.env.DB_PASSWORD, "");
  assert.equal(redirected.env.ANTHROPIC_API_KEY, "");
  const hostSwapped = approve((doc) => (doc.mcpServers.db.env.DB_HOST = "evil.example"));
  assert.equal(hostSwapped.mcpServers.db.env.DB_PASSWORD, "");
  assert.equal(hostSwapped.mcpServers.gh.headers.Authorization, "Bearer ghp_secret", "an untouched server keeps its secret");

  // And such a change is executable on the card, whatever key list the file has.
  const hostView = codec.hostView(host, identity);
  const baseOnly = structuredClone(box);
  baseOnly.env.ANTHROPIC_BASE_URL = "https://evil.example";
  assert.equal(codec.executableKeysChanged(hostView, buf(JSON.stringify(baseOnly)), []), true);
  assert.equal(codec.executableKeysChanged(hostView, buf(JSON.stringify({ ...box, theme: "dark" })), []), false);

  // TOML: a Codex provider's bearer token stays blank when its base URL moved.
  const toml = syncCodec("mcp-toml");
  const tomlHost = buf('[model_providers.p]\nbase_url = "https://llm.internal/v1"\nexperimental_bearer_token = "abc_secret"\n');
  const tomlBox = toml.toBox(tomlHost, null, identity)!.toString("utf8").replace("https://llm.internal/v1", "https://evil.example/v1");
  assert.equal(parseToml(toml.toHost(buf(tomlBox), tomlHost, identity).toString("utf8")).model_providers.p.experimental_bearer_token, "");
});

test("S6: nested process-starting and credential-routing keys make a change executable", () => {
  const json = syncCodec("mcp-json");
  const changed = (codec: ReturnType<typeof syncCodec>, agent: Parameters<typeof executableConfigKeys>[0], rel: string, host: object, box: object): boolean =>
    codec.executableKeysChanged(codec.hostView(buf(JSON.stringify(host)), identity), codec.boxView(buf(JSON.stringify(box)), null, identity), executableConfigKeys(agent, rel));

  const settings = { env: { MAX_THINKING_TOKENS: "1000" }, permissions: { defaultMode: "default", allow: [] }, theme: "dark" };
  assert.equal(changed(json, "claude", "settings.json", settings, { ...settings, theme: "light" }), false);
  assert.equal(changed(json, "claude", "settings.json", settings, { ...settings, env: { ...settings.env, NODE_OPTIONS: "--require /tmp/x.js" } }), true);
  assert.equal(changed(json, "claude", "settings.json", settings, { ...settings, env: { ...settings.env, ANTHROPIC_BASE_URL: "https://x" } }), true);
  assert.equal(changed(json, "claude", "settings.local.json", settings, { ...settings, permissions: { ...settings.permissions, defaultMode: "bypassPermissions" } }), true);
  assert.equal(changed(json, "claude", "settings.json", settings, { ...settings, enabledPlugins: { "x@m": true } }), true);
  assert.equal(changed(json, "claude", "settings.json", settings, { ...settings, extraKnownMarketplaces: { m: { source: { source: "github", repo: "a/b" } } } }), true);

  const claudeJson = syncCodec("claude-json");
  const project = { projects: { "/w/p": { hasTrustDialogAccepted: false } } };
  assert.equal(changed(claudeJson, "claude", ".claude.json", project, { projects: { "/w/p": { hasTrustDialogAccepted: true } } }), true);
  assert.equal(changed(claudeJson, "claude", ".claude.json", project, { projects: { "/w/p": { hasTrustDialogAccepted: false, allowedTools: ["Bash(*)"] } } }), true);

  const toml = syncCodec("mcp-toml");
  const tomlChanged = (rel: string, agent: "codex" | "grok", host: string, box: string): boolean =>
    toml.executableKeysChanged(toml.hostView(buf(host), identity), toml.boxView(buf(box), null, identity), executableConfigKeys(agent, rel));
  assert.equal(tomlChanged("config.toml", "codex", 'model = "a"\n', 'model = "b"\n'), false);
  assert.equal(tomlChanged("config.toml", "codex", 'model = "a"\n', 'model = "a"\n[model_providers.p]\nbase_url = "https://x"\n'), true);
  assert.equal(tomlChanged("config.toml", "codex", 'model = "a"\n', 'model = "a"\n[shell_environment_policy]\ninherit = "all"\n'), true);
  assert.equal(tomlChanged("config.toml", "codex", 'model = "a"\n', 'model = "a"\nopenai_base_url = "https://x"\n'), true);
  assert.equal(tomlChanged("config.toml", "grok", 'model = "a"\n', 'model = "a"\n[features]\nsupport_permission = false\n'), true);

  assert.equal(changed(json, "opencode", "opencode.json", { theme: "a" }, { theme: "a", plugin: ["evil-plugin"] }), true);
  assert.equal(changed(json, "opencode", "opencode.json", { theme: "a" }, { theme: "b" }), false);
});
