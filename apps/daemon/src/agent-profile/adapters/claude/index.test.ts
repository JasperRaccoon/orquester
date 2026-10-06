import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProfileItem, ProfileItemDetail } from "@orquester/api";
import { agentProfileBackupsDir, agentProfileStashDir } from "@orquester/config";
import { AgentProfileError } from "../../errors.ts";
import { ProfileBackups, ProfileStash, parseMarkdownDocument } from "../../infra/index.ts";
import type { AdapterSnapshot, ProfileAdapterContext } from "../types.ts";
import { ClaudeProfileAdapter } from "./index.ts";

// Placeholder secrets: the fixture's env and header values. None may ever
// appear in a snapshot, a readItem answer or an error message.
const SECRETS = ["centur-password-PLACEHOLDER", "jira-token-PLACEHOLDER", "Bearer remote-token-PLACEHOLDER"];

interface Fixture {
  root: string;
  home: string;
  claudeDir: string;
  claudeJson: string;
  settingsPath: string;
  appdir: string;
  argvLog: string;
  adapter: ClaudeProfileAdapter;
  managedHookScript: string;
  makeAdapter: (options?: { bin?: string | null; claudeDir?: string }) => ClaudeProfileAdapter;
}

async function writeJson(path: string, value: unknown, mode?: number): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  if (mode !== undefined) await chmod(path, mode);
}

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
}

/**
 * A fake `claude` CLI: appends `{argv, home, cwd, claudeConfigDir}` to
 * `$HOME/argv.log` and mimics what the real CLI changes on disk.
 */
function fakeClaudeScript(): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const home = process.env.HOME;
fs.appendFileSync(path.join(home, "argv.log"), JSON.stringify({ argv: args, home, cwd: process.cwd(), claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null }) + "\\n");
const pluginsDir = path.join(home, ".claude", "plugins");
const installedPath = path.join(pluginsDir, "installed_plugins.json");
const knownPath = path.join(pluginsDir, "known_marketplaces.json");
const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const write = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2));
if (args[0] === "plugin" && args[1] === "install") {
  if (args[2] === "broken@claude-plugins-official") { process.stderr.write("Plugin not found; token=abc123secret\\n"); process.exit(1); }
  const doc = read(installedPath);
  const [name, mp] = args[2].split("@");
  const installPath = path.join(pluginsDir, "cache", mp, name, "1.0.0");
  fs.mkdirSync(path.join(installPath, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(installPath, ".claude-plugin", "plugin.json"), JSON.stringify({ name, version: "1.0.0", description: "Installed by the fake" }));
  doc.plugins[args[2]] = [{ scope: "user", installPath, version: "1.0.0", installedAt: "2026-09-28T00:00:00.000Z", lastUpdated: "2026-09-28T00:00:00.000Z" }];
  write(installedPath, doc);
} else if (args[0] === "plugin" && args[1] === "uninstall") {
  const doc = read(installedPath);
  delete doc.plugins[args[2]];
  write(installedPath, doc);
} else if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") {
  const doc = read(knownPath);
  doc["acme-tools"] = { source: { source: "github", repo: args[3] }, installLocation: path.join(pluginsDir, "marketplaces", "acme-tools"), lastUpdated: "2026-09-28T00:00:00.000Z" };
  write(knownPath, doc);
} else if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "remove") {
  const doc = read(knownPath);
  delete doc[args[3]];
  write(knownPath, doc);
}
`;
}

async function fixture(t: test.TestContext): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orquester-claude-profile-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const claudeDir = join(home, ".claude");
  const claudeJson = join(home, ".claude.json");
  const appdir = join(root, "appdir");
  const settingsPath = join(claudeDir, "settings.json");
  const managedHookScript = join(appdir, "daemon", "hooks", "agent-hook.sh");
  const managed = (event: string, matcher?: string) => ({
    ...(matcher !== undefined ? { matcher } : {}),
    hooks: [{ type: "command", command: `'${managedHookScript}' claude ${event}`, timeout: 10 }]
  });

  // ~/.claude.json — Claude's live state, shaped like this host's (values replaced).
  await writeJson(
    claudeJson,
    {
      numStartups: 312,
      installMethod: "native",
      autoUpdates: false,
      projects: { "/srv/app": { allowedTools: [], hasTrustDialogAccepted: true, mcpServers: {} } },
      mcpServers: {
        centur: {
          type: "stdio",
          command: "/usr/bin/node",
          args: ["/opt/mcp/centur-mcp/dist/index.js"],
          env: { CENTUR_EMAIL: "owner@example.com", CENTUR_PASSWORD: SECRETS[0], CENTUR_API_URL: "https://centur.example" }
        },
        "jira-cloud": {
          type: "stdio",
          command: "/usr/bin/node",
          args: ["/opt/mcp/jira/build/index.js"],
          env: { JIRA_API_TOKEN: SECRETS[1], JIRA_EMAIL: "owner@example.com", JIRA_HOST: "https://example.atlassian.net" }
        },
        remote: { type: "streamable-http", url: "https://mcp.example.com/mcp", headers: { Authorization: SECRETS[2] }, oauth: { clientId: "x" } }
      },
      oauthAccount: { emailAddress: "owner@example.com", organizationUuid: "00000000-0000-0000-0000-000000000000" },
      skillUsage: { handoff: { usageCount: 3 } }
    },
    0o600
  );

  // settings.json — Orquester's managed groups, a user hook, and keys the adapter does not own.
  await writeJson(
    settingsPath,
    {
      skillListingBudgetFraction: 0.02,
      env: { MCP_TIMEOUT: "60000" },
      attribution: { commit: "", pr: "", sessionUrl: false },
      model: "opus",
      deniedMcpServers: [{ serverName: "claude.ai Gmail" }, { serverName: "claude.ai Google Drive" }],
      hooks: {
        UserPromptSubmit: [
          { matcher: "", hooks: [{ type: "command", command: "python3 $HOME/.claude/hooks/reinject-claude-md.py", timeout: 10 }] },
          managed("UserPromptSubmit")
        ],
        PreToolUse: [managed("PreToolUse", "*")],
        Stop: [managed("Stop")]
      },
      enabledPlugins: {
        "superpowers@claude-plugins-official": true,
        "rust-analyzer-lsp@claude-plugins-official": false
      },
      extraKnownMarketplaces: {
        "claude-plugins-official": { source: { source: "github", repo: "anthropics/claude-plugins-official" } }
      },
      tui: "fullscreen",
      theme: "dark"
    },
    0o600
  );

  await writeText(join(claudeDir, "CLAUDE.md"), "# Global rules\n\nBe brief.\n");

  // Skills: a plain one, a symlinked one, and Claude's own synced/ directory.
  await writeText(
    join(claudeDir, "skills", "handoff", "SKILL.md"),
    "---\nname: handoff\ndescription: Creates a handoff document\n---\nWrite the handoff.\n"
  );
  const sharedSkill = join(root, "skill-sources", "chdb-sql");
  await writeText(join(sharedSkill, "SKILL.md"), "---\nname: chdb-sql\ndescription: SQL on files\n---\nUse chDB.\n");
  await writeText(join(sharedSkill, "references", "functions.md"), "fns\n");
  await symlink(sharedSkill, join(claudeDir, "skills", "chdb-sql"));
  await writeText(join(claudeDir, "skills", "synced", ".bucket-0c8117d0"), "");

  // Commands.
  await writeText(join(claudeDir, "commands", "review.md"), "---\ndescription: Review the diff\n---\nReview $ARGUMENTS\n");
  await writeText(join(claudeDir, "commands", "git", "pr.md"), "Open a PR.\n");

  // Plugins: installed, enabled by default, explicitly off, and one whose cache is gone.
  const pluginsDir = join(claudeDir, "plugins");
  const cache = (mp: string, name: string, version: string) => join(pluginsDir, "cache", mp, name, version);
  const superpowers = cache("claude-plugins-official", "superpowers", "6.4.1");
  await writeJson(join(superpowers, ".claude-plugin", "plugin.json"), {
    name: "superpowers",
    description: "Core skills library",
    version: "6.4.1"
  });
  await writeText(
    join(superpowers, "skills", "brainstorming", "SKILL.md"),
    "---\nname: brainstorming\ndescription: Explore intent first\n---\nBody\n"
  );
  await writeJson(join(superpowers, "hooks", "hooks.json"), {
    hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/hooks/start" }] }] }
  });
  const hookify = cache("claude-plugins-official", "hookify", "fbe07fb6ce7d");
  await writeJson(join(hookify, ".claude-plugin", "plugin.json"), { name: "hookify", description: "Hook rules" });
  await writeText(join(hookify, "commands", "hookify.md"), "---\ndescription: Create a rule\n---\nBody\n");
  await writeText(join(hookify, "agents", "analyzer.md"), "agent\n");
  await writeJson(join(hookify, ".mcp.json"), { mcpServers: { rules: { command: "node", args: ["server.js"], env: { RULES_KEY: "k" } } } });
  const rust = cache("claude-plugins-official", "rust-analyzer-lsp", "1.0.0");
  await writeJson(join(rust, ".claude-plugin", "plugin.json"), { name: "rust-analyzer-lsp", version: "1.0.0" });
  const record = (installPath: string, version: string) => [
    { scope: "user", installPath, version, installedAt: "2026-06-20T18:21:13.069Z", lastUpdated: "2026-09-28T13:39:46.832Z" }
  ];
  await writeJson(join(pluginsDir, "installed_plugins.json"), {
    version: 2,
    plugins: {
      "superpowers@claude-plugins-official": record(superpowers, "6.4.1"),
      "hookify@claude-plugins-official": record(hookify, "fbe07fb6ce7d"),
      "rust-analyzer-lsp@claude-plugins-official": record(rust, "1.0.0"),
      "codex@openai-codex": record(join(root, "gone", "codex", "1.0.6"), "1.0.6"),
      "project-only@claude-plugins-official": [
        { scope: "project", projectPath: "/srv/app", installPath: rust, version: "1.0.0" }
      ]
    }
  });
  const officialDir = join(pluginsDir, "marketplaces", "claude-plugins-official");
  await writeJson(join(officialDir, ".claude-plugin", "marketplace.json"), {
    name: "claude-plugins-official",
    plugins: [
      { name: "superpowers", description: "Core skills library", source: "./plugins/superpowers" },
      { name: "frontend-design", description: "Design guidance", version: "1.2.0" },
      { name: "hookify" }
    ]
  });
  await writeJson(join(pluginsDir, "known_marketplaces.json"), {
    "claude-plugins-official": {
      source: { source: "github", repo: "anthropics/claude-plugins-official" },
      installLocation: officialDir,
      lastUpdated: "2026-09-28T17:19:04.445Z"
    },
    "openai-codex": {
      source: { source: "github", repo: "openai/codex-plugin-cc" },
      installLocation: join(root, "gone", "openai-codex"),
      lastUpdated: "2026-07-25T01:55:01.803Z"
    }
  });

  // The fake CLI.
  const bin = join(root, "bin", "claude");
  await writeText(bin, fakeClaudeScript());
  await chmod(bin, 0o755);

  const makeAdapter = (options: { bin?: string | null; claudeDir?: string } = {}): ClaudeProfileAdapter => {
    const ctx: ProfileAdapterContext = {
      homes: {
        home,
        claudeDir: options.claudeDir ?? claudeDir,
        claudeJson,
        codexHome: join(home, ".codex"),
        grokHome: join(home, ".grok"),
        opencodeDir: join(home, ".config", "opencode"),
        agentsSkillsDir: join(home, ".agents", "skills")
      },
      appdir,
      bin: options.bin === undefined ? bin : options.bin,
      accountHomes: async () => [],
      logger: { info: () => undefined, warn: () => undefined },
      now: () => new Date("2026-09-28T12:00:00.000Z")
    };
    return new ClaudeProfileAdapter(ctx, {
      backups: new ProfileBackups({ dir: agentProfileBackupsDir(appdir) }),
      stash: new ProfileStash({ dir: agentProfileStashDir(appdir) })
    });
  };

  return {
    root,
    home,
    claudeDir,
    claudeJson,
    settingsPath,
    appdir,
    argvLog: join(home, "argv.log"),
    adapter: makeAdapter(),
    managedHookScript,
    makeAdapter
  };
}

function byId(snapshot: AdapterSnapshot, id: string): ProfileItem {
  const item = snapshot.items.find((i) => i.id === id);
  assert.ok(item, `expected item ${id} in ${snapshot.items.map((i) => i.id).join(", ")}`);
  return item;
}

async function item(adapter: ClaudeProfileAdapter, id: string): Promise<ProfileItem> {
  return byId(await adapter.snapshot(), id);
}

async function readJson(path: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path, "utf8"));
}

function assertCode(code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof AgentProfileError, `expected an AgentProfileError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    for (const secret of SECRETS) assert.ok(!error.message.includes(secret), "no secret in an error");
    return true;
  };
}

function assertNoSecrets(value: unknown): void {
  const text = JSON.stringify(value);
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `secret leaked: ${secret}`);
}

async function readArgv(path: string): Promise<{ argv: string[]; home: string; cwd: string; claudeConfigDir: string | null }[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const MANAGED_IDS = (snapshot: AdapterSnapshot) => snapshot.items.filter((i) => i.kind === "hook" && i.locked).map((i) => i.id);

// ---------------------------------------------------------------------------

test("the snapshot lists every kind from a realistic ~/.claude, secrets masked", async (t) => {
  const f = await fixture(t);
  const snapshot = await f.adapter.snapshot();
  assert.deepEqual(snapshot.fileErrors, []);
  assertNoSecrets(snapshot);

  const ids = snapshot.items.map((i) => i.id);
  for (const id of [
    "mcp:centur",
    "mcp:jira-cloud",
    "mcp:remote",
    "mcp:plugin:hookify:rules",
    "skill:handoff",
    "skill:chdb-sql",
    "skill:superpowers:brainstorming",
    "plugin:superpowers@claude-plugins-official",
    "plugin:hookify@claude-plugins-official",
    "plugin:rust-analyzer-lsp@claude-plugins-official",
    "plugin:codex@openai-codex",
    "marketplace:claude-plugins-official",
    "marketplace:openai-codex",
    "command:review",
    "command:git/pr",
    "command:hookify:hookify"
  ]) {
    assert.ok(ids.includes(id), `missing ${id}`);
  }
  assert.ok(!ids.some((id) => id.includes("synced")), "the CLI-owned synced/ dir is not listed");
  assert.ok(!ids.includes("plugin:project-only@claude-plugins-official"), "project-scope plugins are not global");
  assert.equal(new Set(ids).size, ids.length, "ids are unique");

  const centur = byId(snapshot, "mcp:centur");
  assert.equal(centur.enabled, true);
  assert.equal(centur.meta?.transport, "stdio");
  assert.equal(byId(snapshot, "mcp:remote").meta?.transport, "http", "streamable-http is http");
  const pluginMcp = byId(snapshot, "mcp:plugin:hookify:rules");
  assert.deepEqual(
    [pluginMcp.source.type, pluginMcp.toggleable, pluginMcp.editable, pluginMcp.deletable],
    ["plugin", false, false, false]
  );

  assert.equal(byId(snapshot, "skill:chdb-sql").meta?.symlink, "true");
  assert.equal(byId(snapshot, "skill:handoff").description, "Creates a handoff document");
  const pluginSkill = byId(snapshot, "skill:superpowers:brainstorming");
  assert.equal(pluginSkill.toggleable, false, "skillOverrides ignores plugin skills");

  assert.equal(byId(snapshot, "plugin:superpowers@claude-plugins-official").enabled, true);
  assert.equal(byId(snapshot, "plugin:hookify@claude-plugins-official").enabled, true, "no enabledPlugins entry = default on");
  assert.equal(byId(snapshot, "plugin:rust-analyzer-lsp@claude-plugins-official").enabled, false);
  assert.deepEqual(
    byId(snapshot, "plugin:codex@openai-codex").warnings.map((w) => w.code),
    ["plugin-cache-missing"]
  );
  const detail = await f.adapter.readItem("plugin:hookify@claude-plugins-official");
  assert.equal(detail.kind, "plugin");
  assert.deepEqual((detail as Extract<ProfileItemDetail, { kind: "plugin" }>).plugin.provides, {
    commands: 1,
    mcpServers: 1,
    agents: 1
  });
  const sp = (await f.adapter.readItem("plugin:superpowers@claude-plugins-official")) as Extract<ProfileItemDetail, { kind: "plugin" }>;
  assert.deepEqual(sp.plugin.provides, { skills: 1, hooks: 1 });

  const hooks = snapshot.items.filter((i) => i.kind === "hook");
  assert.equal(hooks.length, 4);
  const locked = hooks.filter((h) => h.locked);
  assert.equal(locked.length, 3, "every agent-hook.sh group is locked");
  for (const h of locked) {
    assert.deepEqual([h.source.type, h.toggleable, h.editable, h.deletable], ["orquester", false, false, false]);
  }
  const userHook = hooks.find((h) => !h.locked)!;
  assert.equal(userHook.name, "python3 $HOME/.claude/hooks/reinject-claude-md.py");
  assert.equal(userHook.meta?.event, "UserPromptSubmit");
  assert.match(userHook.id, /^hook:UserPromptSubmit:[0-9a-f]{16}$/);

  const market = byId(snapshot, "marketplace:claude-plugins-official");
  assert.equal(market.meta?.source, "anthropics/claude-plugins-official");
  assert.equal(market.toggleable, false);

  assert.deepEqual(
    [snapshot.instructions.exists, snapshot.instructions.lines, snapshot.instructions.path],
    [true, 3, join(f.claudeDir, "CLAUDE.md")]
  );

  const plugins = await f.adapter.listMarketplacePlugins("claude-plugins-official");
  assert.deepEqual(plugins, [
    { name: "superpowers", description: "Core skills library", installed: true },
    { name: "frontend-design", description: "Design guidance", version: "1.2.0", installed: false },
    { name: "hookify", installed: true }
  ]);
  assert.deepEqual(await f.adapter.listMarketplacePlugins("openai-codex").catch((e) => e.code), "CONFIG_UNREADABLE");
  await assert.rejects(f.adapter.listMarketplacePlugins("nope"), assertCode("ITEM_NOT_FOUND"));

});

test("MCP: create, edit with kept and replaced secrets, rename, off/on through deniedMcpServers, delete", async (t) => {
  const f = await fixture(t);
  const liveBefore = await readJson(f.claudeJson);

  await f.adapter.create(
    {
      kind: "mcp",
      mcp: {
        name: "grafana",
        transport: "stdio",
        command: "npx",
        args: ["-y", "mcp-grafana"],
        env: [{ key: "GRAFANA_TOKEN", value: "grafana-SECRET-1" }]
      }
    },
    { onConflict: "fail" }
  );
  let live = await readJson(f.claudeJson);
  assert.deepEqual(live.mcpServers.grafana, {
    type: "stdio",
    command: "npx",
    args: ["-y", "mcp-grafana"],
    env: { GRAFANA_TOKEN: "grafana-SECRET-1" }
  });
  for (const key of Object.keys(liveBefore)) {
    if (key !== "mcpServers") assert.deepEqual(live[key], liveBefore[key], `${key} kept`);
  }
  assert.equal((await stat(f.claudeJson)).mode & 0o777, 0o600);

  await assert.rejects(
    f.adapter.create({ kind: "mcp", mcp: { name: "grafana", transport: "stdio", command: "x" } }, { onConflict: "fail" }),
    assertCode("ITEM_EXISTS")
  );
  const both = await f.adapter.create(
    { kind: "mcp", mcp: { name: "grafana", transport: "http", url: "https://g.example/mcp" } },
    { onConflict: "keep-both" }
  );
  assert.deepEqual(both.itemIds, ["mcp:grafana-2"]);

  // readItem: keys only.
  const detail = (await f.adapter.readItem("mcp:centur")) as Extract<ProfileItemDetail, { kind: "mcp" }>;
  assert.deepEqual(detail.mcp.env, [
    { key: "CENTUR_EMAIL", set: true },
    { key: "CENTUR_PASSWORD", set: true },
    { key: "CENTUR_API_URL", set: true }
  ]);
  assertNoSecrets(detail);
  const remote = (await f.adapter.readItem("mcp:remote")) as Extract<ProfileItemDetail, { kind: "mcp" }>;
  assert.deepEqual(remote.mcp.headers, [{ key: "Authorization", set: true }]);
  assertNoSecrets(remote);

  // Edit: keep the password, replace the URL, drop the email.
  let centur = await item(f.adapter, "mcp:centur");
  await f.adapter.update(centur.id, centur.revision, {
    kind: "mcp",
    mcp: {
      name: "centur",
      transport: "stdio",
      command: "/usr/bin/node",
      args: ["/opt/mcp/centur-mcp/dist/index.js", "--verbose"],
      env: [
        { key: "CENTUR_PASSWORD", keep: true },
        { key: "CENTUR_API_URL", value: "https://centur2.example" }
      ],
      advanced: { timeout: 30000 }
    }
  });
  live = await readJson(f.claudeJson);
  assert.deepEqual(live.mcpServers.centur, {
    type: "stdio",
    command: "/usr/bin/node",
    args: ["/opt/mcp/centur-mcp/dist/index.js", "--verbose"],
    env: { CENTUR_PASSWORD: SECRETS[0], CENTUR_API_URL: "https://centur2.example" },
    timeout: 30000
  });

  // Keeping a value that does not exist is refused without naming any value.
  centur = await item(f.adapter, "mcp:centur");
  await assert.rejects(
    f.adapter.update(centur.id, centur.revision, {
      kind: "mcp",
      mcp: { name: "centur", transport: "stdio", command: "node", env: [{ key: "NOPE", keep: true }] }
    }),
    assertCode("INVALID_ITEM")
  );

  // http edit keeps unknown keys (oauth) and the streamable-http spelling.
  const remoteItem = await item(f.adapter, "mcp:remote");
  await f.adapter.update(remoteItem.id, remoteItem.revision, {
    kind: "mcp",
    mcp: { name: "remote", transport: "http", url: "https://mcp.example.com/v2", headers: [{ key: "Authorization", keep: true }] }
  });
  live = await readJson(f.claudeJson);
  assert.deepEqual(live.mcpServers.remote, {
    type: "streamable-http",
    url: "https://mcp.example.com/v2",
    headers: { Authorization: SECRETS[2] },
    oauth: { clientId: "x" }
  });

  // Off → a deny entry; the other deny entries untouched. On → only it removed.
  const settingsBefore = await readFile(f.settingsPath, "utf8");
  let jira = await item(f.adapter, "mcp:jira-cloud");
  const off = await f.adapter.setEnabled(jira.id, jira.revision, false);
  assert.ok(off.notes.some((note) => note.includes("jira-cloud")));
  let settings = await readJson(f.settingsPath);
  assert.deepEqual(settings.deniedMcpServers, [
    { serverName: "claude.ai Gmail" },
    { serverName: "claude.ai Google Drive" },
    { serverName: "jira-cloud" }
  ]);
  jira = await item(f.adapter, "mcp:jira-cloud");
  assert.equal(jira.enabled, false);

  // Rename while off: the deny entry follows.
  await f.adapter.update(jira.id, jira.revision, {
    kind: "mcp",
    mcp: {
      name: "jira",
      transport: "stdio",
      command: "/usr/bin/node",
      args: ["/opt/mcp/jira/build/index.js"],
      env: [{ key: "JIRA_API_TOKEN", keep: true }]
    }
  });
  live = await readJson(f.claudeJson);
  assert.deepEqual(Object.keys(live.mcpServers), ["centur", "jira", "remote", "grafana", "grafana-2"], "renamed in place");
  assert.equal(live.mcpServers.jira.env.JIRA_API_TOKEN, SECRETS[1]);
  settings = await readJson(f.settingsPath);
  assert.deepEqual(settings.deniedMcpServers.at(-1), { serverName: "jira" });

  const renamed = await item(f.adapter, "mcp:jira");
  assert.equal(renamed.enabled, false);
  await f.adapter.setEnabled(renamed.id, renamed.revision, true);
  assert.equal(await readFile(f.settingsPath, "utf8"), settingsBefore, "on/off round trip leaves settings.json byte for byte");

  // Delete.
  const grafana = await item(f.adapter, "mcp:grafana");
  await f.adapter.remove(grafana.id, grafana.revision);
  live = await readJson(f.claudeJson);
  assert.equal("grafana" in live.mcpServers, false);
  assert.equal(live.numStartups, 312);
});

test("skills: create, edit, rename, off/on through skillOverrides, delete (a symlink loses only its link)", async (t) => {
  const f = await fixture(t);
  const settingsBefore = await readFile(f.settingsPath, "utf8");

  await f.adapter.create(
    { kind: "skill", document: { name: "release-notes", frontmatter: { description: "Draft release notes" }, body: "Steps.\n" } },
    { onConflict: "fail" }
  );
  const file = join(f.claudeDir, "skills", "release-notes", "SKILL.md");
  assert.deepEqual(parseMarkdownDocument(await readFile(file, "utf8")).frontmatter, {
    name: "release-notes",
    description: "Draft release notes"
  });
  await assert.rejects(
    f.adapter.create({ kind: "skill", document: { name: "synced", frontmatter: {}, body: "" } }, { onConflict: "fail" }),
    assertCode("INVALID_NAME")
  );

  let skill = await item(f.adapter, "skill:release-notes");
  await f.adapter.update(skill.id, skill.revision, {
    kind: "skill",
    document: { name: "release-notes", frontmatter: { "argument-hint": "[version]" }, body: "New steps.\n" }
  });
  const doc = parseMarkdownDocument(await readFile(file, "utf8"));
  assert.deepEqual(doc.frontmatter, { name: "release-notes", description: "Draft release notes", "argument-hint": "[version]" });
  assert.equal(doc.body, "New steps.\n");

  // Off writes "off"; on deletes the key (and the emptied map).
  skill = await item(f.adapter, "skill:release-notes");
  await f.adapter.setEnabled(skill.id, skill.revision, false);
  assert.deepEqual((await readJson(f.settingsPath)).skillOverrides, { "release-notes": "off" });
  skill = await item(f.adapter, "skill:release-notes");
  assert.equal(skill.enabled, false);

  // A rename carries the override along.
  await f.adapter.update(skill.id, skill.revision, {
    kind: "skill",
    document: { name: "changelog", frontmatter: {}, body: "New steps.\n" }
  });
  assert.deepEqual((await readJson(f.settingsPath)).skillOverrides, { changelog: "off" });
  skill = await item(f.adapter, "skill:changelog");
  assert.equal(parseMarkdownDocument(await readFile(join(f.claudeDir, "skills", "changelog", "SKILL.md"), "utf8")).frontmatter.name, "changelog");
  await f.adapter.setEnabled(skill.id, skill.revision, true);
  assert.equal(await readFile(f.settingsPath, "utf8"), settingsBefore, "skillOverrides gone again");

  // Editing a symlinked skill writes through the link.
  const linked = await item(f.adapter, "skill:chdb-sql");
  await f.adapter.update(linked.id, linked.revision, {
    kind: "skill",
    document: { name: "chdb-sql", frontmatter: {}, body: "Use chDB, edited.\n" }
  });
  assert.match(await readFile(join(f.root, "skill-sources", "chdb-sql", "SKILL.md"), "utf8"), /edited/);
  const linkedDetail = (await f.adapter.readItem("skill:chdb-sql")) as Extract<ProfileItemDetail, { kind: "skill" | "command" }>;
  assert.deepEqual(linkedDetail.files, ["references/functions.md"]);

  // Deleting it removes the link only.
  const linked2 = await item(f.adapter, "skill:chdb-sql");
  await f.adapter.remove(linked2.id, linked2.revision);
  assert.equal((await stat(join(f.root, "skill-sources", "chdb-sql", "SKILL.md"))).isFile(), true);
  assert.ok(!(await f.adapter.snapshot()).items.some((i) => i.id === "skill:chdb-sql"));

  // A plugin skill cannot be toggled, edited or deleted.
  const pluginSkill = await item(f.adapter, "skill:superpowers:brainstorming");
  await assert.rejects(f.adapter.setEnabled(pluginSkill.id, pluginSkill.revision, false), assertCode("NOT_TOGGLEABLE"));
  await assert.rejects(f.adapter.remove(pluginSkill.id, pluginSkill.revision), assertCode("NOT_DELETABLE"));
});

test("hooks: managed groups stay locked and byte-identical while user hooks are added, edited, stashed, restored and deleted", async (t) => {
  const f = await fixture(t);
  const original = await readFile(f.settingsPath, "utf8");
  const managedJson = async () => {
    const hooks = (await readJson(f.settingsPath)).hooks as Record<string, { hooks: { command: string }[] }[]>;
    return JSON.stringify(
      Object.entries(hooks).flatMap(([event, groups]) =>
        groups.filter((g) => g.hooks.some((h) => h.command.includes("agent-hook.sh"))).map((g) => [event, g])
      )
    );
  };
  const managedBefore = await managedJson();
  const snapshot = await f.adapter.snapshot();
  const [managedId] = MANAGED_IDS(snapshot);
  const managed = byId(snapshot, managedId!);
  await assert.rejects(f.adapter.setEnabled(managed.id, managed.revision, false), assertCode("ITEM_LOCKED"));
  await assert.rejects(f.adapter.remove(managed.id, managed.revision), assertCode("ITEM_LOCKED"));
  await assert.rejects(
    f.adapter.update(managed.id, managed.revision, { kind: "hook", hook: { event: "Stop", command: "x" } }),
    assertCode("ITEM_LOCKED")
  );

  // Create: a new group goes before the managed one.
  const created = await f.adapter.create(
    { kind: "hook", hook: { event: "PreToolUse", matcher: "Bash", command: "~/bin/guard.sh", timeoutSec: 5 } },
    { onConflict: "fail" }
  );
  const [hookId] = created.itemIds;
  let settings = await readJson(f.settingsPath);
  assert.deepEqual(settings.hooks.PreToolUse[0], {
    matcher: "Bash",
    hooks: [{ type: "command", command: "~/bin/guard.sh", timeout: 5 }]
  });
  assert.equal(settings.hooks.PreToolUse.length, 2);
  await assert.rejects(
    f.adapter.create({ kind: "hook", hook: { event: "PreToolUse", matcher: "Bash", command: "~/bin/guard.sh", timeoutSec: 5 } }, { onConflict: "fail" }),
    assertCode("ITEM_EXISTS")
  );
  await assert.rejects(
    f.adapter.create({ kind: "hook", hook: { event: "BeforeEverything", command: "x" } }, { onConflict: "fail" }),
    assertCode("INVALID_ITEM")
  );
  // A second handler with the same matcher joins the same group; a matcher on a matcher-less event is dropped.
  await f.adapter.create({ kind: "hook", hook: { event: "PreToolUse", matcher: "Bash", command: "~/bin/audit.sh" } }, { onConflict: "fail" });
  await f.adapter.create({ kind: "hook", hook: { event: "Stop", matcher: "ignored", command: "~/bin/done.sh" } }, { onConflict: "fail" });
  settings = await readJson(f.settingsPath);
  assert.equal(settings.hooks.PreToolUse[0].hooks.length, 2);
  assert.deepEqual(settings.hooks.Stop[0], { hooks: [{ type: "command", command: "~/bin/done.sh" }] });

  // Edit in place: the id moves, the handler keeps its place.
  let hook = await item(f.adapter, hookId!);
  const edited = await f.adapter.update(hook.id, hook.revision, {
    kind: "hook",
    hook: { event: "PreToolUse", matcher: "Bash", command: "~/bin/guard2.sh" }
  });
  const [editedId] = edited.itemIds;
  assert.notEqual(editedId, hookId);
  settings = await readJson(f.settingsPath);
  assert.deepEqual(settings.hooks.PreToolUse[0].hooks[0], { type: "command", command: "~/bin/guard2.sh" });

  // Off → stashed and removed from its group; listed as stashed; on → back in the group.
  hook = await item(f.adapter, editedId!);
  await f.adapter.setEnabled(hook.id, hook.revision, false);
  settings = await readJson(f.settingsPath);
  assert.deepEqual(settings.hooks.PreToolUse[0].hooks, [{ type: "command", command: "~/bin/audit.sh" }]);
  hook = await item(f.adapter, editedId!);
  assert.deepEqual([hook.enabled, hook.stashed, hook.editable], [false, true, false]);
  const stashedDetail = (await f.adapter.readItem(hook.id)) as Extract<ProfileItemDetail, { kind: "hook" }>;
  assert.deepEqual(stashedDetail.hook, { event: "PreToolUse", matcher: "Bash", command: "~/bin/guard2.sh" });
  await f.adapter.setEnabled(hook.id, hook.revision, true);
  settings = await readJson(f.settingsPath);
  assert.deepEqual(settings.hooks.PreToolUse[0].hooks, [
    { type: "command", command: "~/bin/audit.sh" },
    { type: "command", command: "~/bin/guard2.sh" }
  ]);
  hook = await item(f.adapter, editedId!);
  assert.equal(hook.enabled, true);

  // Delete: a stashed one from the stash, the others from settings.json.
  hook = await item(f.adapter, editedId!);
  await f.adapter.setEnabled(hook.id, hook.revision, false);
  for (const it of (await f.adapter.snapshot()).items) {
    if (it.kind === "hook" && !it.locked && it.name !== "python3 $HOME/.claude/hooks/reinject-claude-md.py") {
      await f.adapter.remove(it.id, it.revision);
    }
  }
  assert.equal(await managedJson(), managedBefore, "managed groups untouched");
  assert.equal(await readFile(f.settingsPath, "utf8"), original, "settings.json back byte for byte, unknown keys kept");
  assert.ok(!(await f.adapter.snapshot()).items.some((i) => i.stashed), "stash emptied");
});

test("a stashed hook whose twin is back in settings.json refuses to restore", async (t) => {
  const f = await fixture(t);
  const { itemIds } = await f.adapter.create(
    { kind: "hook", hook: { event: "SessionStart", command: "~/bin/hello.sh" } },
    { onConflict: "fail" }
  );
  const hook = await item(f.adapter, itemIds[0]!);
  await f.adapter.setEnabled(hook.id, hook.revision, false);
  const stashed = await item(f.adapter, hook.id);
  // Someone puts the same hook back by hand.
  const settings = await readJson(f.settingsPath);
  settings.hooks.SessionStart = [{ hooks: [{ type: "command", command: "~/bin/hello.sh" }] }];
  await writeJson(f.settingsPath, settings);
  // The live copy now wins the listing; the stashed one is still there to restore.
  const live = await item(f.adapter, hook.id);
  assert.equal(live.enabled, true);
  assert.deepEqual(live.warnings.map((w) => w.code), ["stashed-copy"]);
  await assert.rejects(f.adapter.setEnabled(stashed.id, stashed.revision, true), assertCode("STASH_CONFLICT"));
  // Deleting the live copy brings the stashed one back into the list, and it restores.
  await f.adapter.remove(live.id, live.revision);
  const back = await item(f.adapter, hook.id);
  assert.equal(back.stashed, true);
  await f.adapter.setEnabled(back.id, back.revision, true);
  assert.deepEqual((await readJson(f.settingsPath)).hooks.SessionStart, [{ hooks: [{ type: "command", command: "~/bin/hello.sh" }] }]);
});

test("commands: create, edit, rename, off/on by stash, restore conflict, delete", async (t) => {
  const f = await fixture(t);
  await f.adapter.create(
    { kind: "command", document: { name: "git/rebase", frontmatter: { description: "Rebase" }, body: "Rebase onto $1\n" } },
    { onConflict: "fail" }
  );
  const file = join(f.claudeDir, "commands", "git", "rebase.md");
  assert.equal(await readFile(file, "utf8"), "---\ndescription: Rebase\n---\nRebase onto $1\n");

  let command = await item(f.adapter, "command:git/rebase");
  await f.adapter.update(command.id, command.revision, {
    kind: "command",
    document: { name: "git/rebase", frontmatter: { "argument-hint": "[branch]" }, body: "Rebase onto $1 carefully\n" }
  });
  assert.equal(await readFile(file, "utf8"), "---\ndescription: Rebase\nargument-hint: \"[branch]\"\n---\nRebase onto $1 carefully\n");

  command = await item(f.adapter, "command:git/rebase");
  await f.adapter.update(command.id, command.revision, {
    kind: "command",
    document: { name: "rebase", frontmatter: {}, body: "Rebase onto $1 carefully\n" }
  });
  await assert.rejects(stat(file), { code: "ENOENT" });
  const moved = join(f.claudeDir, "commands", "rebase.md");

  // Off: moved to the stash, listed as stashed; on: back byte for byte.
  command = await item(f.adapter, "command:rebase");
  const bytes = await readFile(moved);
  await f.adapter.setEnabled(command.id, command.revision, false);
  await assert.rejects(stat(moved), { code: "ENOENT" });
  command = await item(f.adapter, "command:rebase");
  assert.deepEqual([command.enabled, command.stashed, command.description], [false, true, "Rebase"]);
  const stashedDetail = (await f.adapter.readItem(command.id)) as Extract<ProfileItemDetail, { kind: "skill" | "command" }>;
  assert.equal(stashedDetail.document.body, "Rebase onto $1 carefully\n");
  await assert.rejects(
    f.adapter.create({ kind: "command", document: { name: "rebase", frontmatter: {}, body: "x" } }, { onConflict: "fail" }),
    assertCode("ITEM_EXISTS"),
    "a stashed command still holds its name"
  );
  await f.adapter.setEnabled(command.id, command.revision, true);
  assert.deepEqual(await readFile(moved), bytes);

  // Restore conflict: something new took the path while it was off.
  command = await item(f.adapter, "command:rebase");
  await f.adapter.setEnabled(command.id, command.revision, false);
  const stashed = await item(f.adapter, "command:rebase");
  await writeText(moved, "someone else's command\n");
  const clash = await f.adapter.snapshot();
  assert.deepEqual(byId(clash, "command:rebase").warnings.map((w) => w.code), ["stashed-copy"]);
  await assert.rejects(f.adapter.setEnabled(stashed.id, stashed.revision, true), assertCode("STASH_CONFLICT"));
  assert.equal(await readFile(moved, "utf8"), "someone else's command\n", "the newcomer is untouched");
  const stash = new ProfileStash({ dir: agentProfileStashDir(f.appdir) });
  await rm(moved);
  const again = await item(f.adapter, "command:rebase");
  assert.equal(again.stashed, true);
  await f.adapter.setEnabled(again.id, again.revision, true);
  assert.deepEqual(await readFile(moved), bytes);

  // Delete: a live file (backed up) and a stashed one.
  const review = await item(f.adapter, "command:review");
  await f.adapter.remove(review.id, review.revision);
  await assert.rejects(stat(join(f.claudeDir, "commands", "review.md")), { code: "ENOENT" });
  command = await item(f.adapter, "command:rebase");
  await f.adapter.setEnabled(command.id, command.revision, false);
  command = await item(f.adapter, "command:rebase");
  await f.adapter.remove(command.id, command.revision);
  assert.ok(!(await f.adapter.snapshot()).items.some((i) => i.id === "command:rebase"));
  assert.equal(await stash.get("claude", "command", "command:rebase"), null);
});

test("stash restore of a command whose path is taken answers STASH_CONFLICT", async (t) => {
  const f = await fixture(t);
  const pr = await item(f.adapter, "command:git/pr");
  await f.adapter.setEnabled(pr.id, pr.revision, false);
  const stashed = await item(f.adapter, "command:git/pr");
  // A dangling symlink takes the path.
  await symlink(join(f.root, "nowhere.md"), join(f.claudeDir, "commands", "git", "pr.md"));
  const listed = await item(f.adapter, "command:git/pr");
  // The broken link is listed as the live command (with its error); the stashed entry reports the clash.
  assert.equal(listed.stashed, undefined);
  assert.deepEqual(listed.warnings.map((w) => w.code), ["unreadable", "stashed-copy"]);
  await assert.rejects(f.adapter.setEnabled(stashed.id, stashed.revision, true), assertCode("STASH_CONFLICT"));
  await rm(join(f.claudeDir, "commands", "git", "pr.md"));
  // With the link gone the stashed copy restores.
  const back = await item(f.adapter, "command:git/pr");
  await f.adapter.setEnabled(back.id, back.revision, true);
  assert.equal(await readFile(join(f.claudeDir, "commands", "git", "pr.md"), "utf8"), "Open a PR.\n");
});

test("plugins and marketplaces go through the claude CLI with HOME set and no CLAUDE_CONFIG_DIR; toggles write enabledPlugins", async (t) => {
  const f = await fixture(t);
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(f.root, "some-account-home");
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  });

  const installed = await f.adapter.create(
    { kind: "plugin", plugin: { plugin: "frontend-design", marketplace: "claude-plugins-official" } },
    { onConflict: "fail" }
  );
  assert.deepEqual(installed.itemIds, ["plugin:frontend-design@claude-plugins-official"]);
  let calls = await readArgv(f.argvLog);
  assert.deepEqual(calls.at(-1), {
    argv: ["plugin", "install", "frontend-design@claude-plugins-official", "--scope", "user"],
    home: f.home,
    cwd: f.home,
    claudeConfigDir: null
  });
  const fd = await item(f.adapter, "plugin:frontend-design@claude-plugins-official");
  assert.equal(fd.enabled, true);
  await assert.rejects(
    f.adapter.create({ kind: "plugin", plugin: { plugin: "frontend-design", marketplace: "claude-plugins-official" } }, { onConflict: "fail" }),
    assertCode("ITEM_EXISTS")
  );
  await assert.rejects(
    f.adapter.create({ kind: "plugin", plugin: { plugin: "--help", marketplace: "claude-plugins-official" } }, { onConflict: "fail" }),
    assertCode("INVALID_NAME")
  );
  await assert.rejects(
    f.adapter.create({ kind: "plugin", plugin: { spec: "npm-thing" } }, { onConflict: "fail" }),
    assertCode("INVALID_REQUEST")
  );
  // A failing CLI: 502 with redacted stderr.
  await assert.rejects(
    f.adapter.create({ kind: "plugin", plugin: { plugin: "broken", marketplace: "claude-plugins-official" } }, { onConflict: "fail" }),
    (error: unknown) => {
      assertCode("AGENT_CLI_FAILED")(error);
      assert.ok(!(error as Error).message.includes("abc123secret"));
      return true;
    }
  );

  // Toggle: enabledPlugins only.
  const settingsBefore = await readJson(f.settingsPath);
  const off = await f.adapter.setEnabled(fd.id, fd.revision, false);
  assert.deepEqual(off.itemIds, [fd.id]);
  let settings = await readJson(f.settingsPath);
  assert.equal(settings.enabledPlugins["frontend-design@claude-plugins-official"], false);
  assert.deepEqual({ ...settings, enabledPlugins: settingsBefore.enabledPlugins }, settingsBefore);
  const fdOff = await item(f.adapter, fd.id);
  await f.adapter.setEnabled(fdOff.id, fdOff.revision, true);
  settings = await readJson(f.settingsPath);
  assert.equal(settings.enabledPlugins["frontend-design@claude-plugins-official"], true);

  // Plugins are not editable.
  const fdOn = await item(f.adapter, fd.id);
  await assert.rejects(
    f.adapter.update(fdOn.id, fdOn.revision, { kind: "plugin", plugin: { plugin: "x", marketplace: "y" } }),
    assertCode("NOT_EDITABLE")
  );

  // Uninstall.
  await f.adapter.remove(fdOn.id, fdOn.revision);
  calls = await readArgv(f.argvLog);
  assert.deepEqual(calls.at(-1)?.argv, ["plugin", "uninstall", "frontend-design@claude-plugins-official", "--scope", "user"]);
  assert.ok(!(await f.adapter.snapshot()).items.some((i) => i.id === fd.id));

  // Marketplace add: the CLI names it; the new id comes from the file diff.
  const added = await f.adapter.create(
    { kind: "marketplace", marketplace: { name: "mine", source: { type: "github", repo: "acme/tools", ref: "v2" } } },
    { onConflict: "fail" }
  );
  calls = await readArgv(f.argvLog);
  assert.deepEqual(calls.at(-1)?.argv, ["plugin", "marketplace", "add", "acme/tools#v2", "--scope", "user"]);
  assert.deepEqual(added.itemIds, ["marketplace:acme-tools"]);
  await assert.rejects(
    f.adapter.create({ kind: "marketplace", marketplace: { source: { type: "git", url: "--upload-pack=evil" } } }, { onConflict: "fail" }),
    assertCode("INVALID_REQUEST")
  );
  await assert.rejects(
    f.adapter.create({ kind: "marketplace", marketplace: { source: { type: "path", path: "relative/dir" } } }, { onConflict: "fail" }),
    assertCode("INVALID_REQUEST")
  );

  // Marketplace remove: a note says its plugins go too.
  const official = await item(f.adapter, "marketplace:claude-plugins-official");
  await assert.rejects(f.adapter.setEnabled(official.id, official.revision, false), assertCode("NOT_TOGGLEABLE"));
  const removed = await f.adapter.remove(official.id, official.revision);
  calls = await readArgv(f.argvLog);
  assert.deepEqual(calls.at(-1)?.argv, ["plugin", "marketplace", "remove", "claude-plugins-official"]);
  assert.ok(removed.notes.some((note) => note.includes("superpowers")));
  for (const call of calls) {
    assert.equal(call.home, f.home);
    assert.equal(call.claudeConfigDir, null);
  }

  // Not installed: a clear 404, no spawn.
  const noBin = f.makeAdapter({ bin: null });
  await assert.rejects(
    noBin.create({ kind: "plugin", plugin: { plugin: "hookify", marketplace: "claude-plugins-official" } }, { onConflict: "replace" }),
    assertCode("AGENT_NOT_INSTALLED")
  );
});

test("a stale revision is a conflict and nothing is written", async (t) => {
  const f = await fixture(t);
  const centur = await item(f.adapter, "mcp:centur");
  // A running Claude session edits the server meanwhile.
  const live = await readJson(f.claudeJson);
  live.mcpServers.centur.args.push("--changed");
  await writeJson(f.claudeJson, live, 0o600);
  const settingsBefore = await readFile(f.settingsPath, "utf8");
  await assert.rejects(f.adapter.setEnabled(centur.id, centur.revision, false), assertCode("PROFILE_CONFLICT"));
  await assert.rejects(f.adapter.remove(centur.id, centur.revision), assertCode("PROFILE_CONFLICT"));
  await assert.rejects(
    f.adapter.update(centur.id, centur.revision, { kind: "mcp", mcp: { name: "centur", transport: "stdio", command: "x" } }),
    assertCode("PROFILE_CONFLICT")
  );
  assert.equal(await readFile(f.settingsPath, "utf8"), settingsBefore);
  assert.deepEqual((await readJson(f.claudeJson)).mcpServers.centur.args.at(-1), "--changed");

  // A secret value change moves the revision too (without the revision revealing it).
  const fresh = await item(f.adapter, "mcp:centur");
  live.mcpServers.centur.env.CENTUR_PASSWORD = "another-PLACEHOLDER";
  await writeJson(f.claudeJson, live, 0o600);
  assert.notEqual((await item(f.adapter, "mcp:centur")).revision, fresh.revision);

  // Unknown ids.
  await assert.rejects(f.adapter.readItem("mcp:nope"), assertCode("ITEM_NOT_FOUND"));
  await assert.rejects(f.adapter.remove("skill:nope", "x"), assertCode("ITEM_NOT_FOUND"));
});

test("a settings.json that does not parse: the snapshot is partial, its writes refused, other files still writable", async (t) => {
  const f = await fixture(t);
  await writeFile(f.settingsPath, '{ "hooks": { oops');
  const snapshot = await f.adapter.snapshot();
  assert.deepEqual(snapshot.fileErrors.map((e) => e.path), [f.settingsPath]);
  assert.ok(!snapshot.items.some((i) => i.kind === "hook"), "no hooks read from a broken file");
  const centur = byId(snapshot, "mcp:centur");
  await assert.rejects(f.adapter.setEnabled(centur.id, centur.revision, false), assertCode("CONFIG_UNREADABLE"));
  await assert.rejects(
    f.adapter.create({ kind: "hook", hook: { event: "Stop", command: "x" } }, { onConflict: "fail" }),
    assertCode("CONFIG_UNREADABLE")
  );
  assert.equal(await readFile(f.settingsPath, "utf8"), '{ "hooks": { oops');
  // .claude.json is its own file: MCP definitions can still be created.
  await f.adapter.create({ kind: "mcp", mcp: { name: "ok", transport: "sse", url: "https://sse.example/sse" } }, { onConflict: "fail" });
  assert.deepEqual((await readJson(f.claudeJson)).mcpServers.ok, { type: "sse", url: "https://sse.example/sse" });

  // A broken .claude.json: no MCP rows, MCP writes refused.
  await writeFile(f.claudeJson, "[]");
  const partial = await f.adapter.snapshot();
  assert.ok(partial.fileErrors.some((e) => e.path === f.claudeJson));
  await assert.rejects(
    f.adapter.create({ kind: "mcp", mcp: { name: "x", transport: "sse", url: "https://sse.example/sse" } }, { onConflict: "fail" }),
    assertCode("CONFIG_UNREADABLE")
  );
});

test("instructions: read, create, write with a revision, conflict on a stale one", async (t) => {
  const f = await fixture(t);
  const { text, info } = await f.adapter.readInstructions();
  assert.equal(text, "# Global rules\n\nBe brief.\n");
  assert.equal(info.bytes, text.length);
  assert.ok(info.mtime);
  await assert.rejects(f.adapter.writeInstructions("x", ""), assertCode("PROFILE_CONFLICT"));
  await f.adapter.writeInstructions("# Rules\n", info.revision);
  assert.equal(await readFile(join(f.claudeDir, "CLAUDE.md"), "utf8"), "# Rules\n");
  await assert.rejects(f.adapter.writeInstructions("again", info.revision), assertCode("PROFILE_CONFLICT"));

  await rm(join(f.claudeDir, "CLAUDE.md"));
  const missing = await f.adapter.readInstructions();
  assert.deepEqual([missing.text, missing.info.exists, missing.info.revision, missing.info.lines], ["", false, "", 0]);
  await f.adapter.writeInstructions("new\nfile", "");
  assert.equal((await f.adapter.readInstructions()).info.lines, 2);
});

test("export and import round trip: MCP with real secrets, a skill directory, a command", async (t) => {
  const source = await fixture(t);
  const target = await fixture(t);
  // Target starts without them.
  const targetLive = await readJson(target.claudeJson);
  delete targetLive.mcpServers.centur;
  await writeJson(target.claudeJson, targetLive, 0o600);
  await rm(join(target.claudeDir, "skills", "handoff"), { recursive: true });
  await rm(join(target.claudeDir, "commands", "review.md"));

  const mcp = await source.adapter.exportItem("mcp:centur");
  assert.equal(mcp.kind, "mcp");
  assert.equal(mcp.kind === "mcp" && mcp.server.env?.CENTUR_PASSWORD, SECRETS[0], "export carries the real value");
  await target.adapter.importItem(mcp, { onConflict: "fail" });
  assert.deepEqual((await readJson(target.claudeJson)).mcpServers.centur, (await readJson(source.claudeJson)).mcpServers.centur);
  const again = await target.adapter.importItem(mcp, { onConflict: "keep-both" });
  assert.deepEqual(again.itemIds, ["mcp:centur-2"]);

  const skill = await source.adapter.exportItem("skill:chdb-sql");
  assert.equal(skill.kind, "skill");
  if (skill.kind !== "skill") return;
  assert.ok(skill.dir.startsWith(source.appdir), "exported into the appdir's tmp");
  await target.adapter.importItem({ ...skill, name: "chdb-sql" }, { onConflict: "keep-both" });
  const copied = join(target.claudeDir, "skills", "chdb-sql-2");
  assert.equal(parseMarkdownDocument(await readFile(join(copied, "SKILL.md"), "utf8")).frontmatter.name, "chdb-sql-2");
  assert.equal(await readFile(join(copied, "references", "functions.md"), "utf8"), "fns\n");
  assert.equal((await stat(copied)).isDirectory(), true, "copied, not linked");
  await rm(skill.dir, { recursive: true });

  const command = await source.adapter.exportItem("command:review");
  assert.deepEqual(command, { kind: "command", name: "review", frontmatter: { description: "Review the diff" }, body: "Review $ARGUMENTS\n" });
  await target.adapter.importItem(command, { onConflict: "fail" });
  assert.equal(
    await readFile(join(target.claudeDir, "commands", "review.md"), "utf8"),
    await readFile(join(source.claudeDir, "commands", "review.md"), "utf8")
  );

  await assert.rejects(source.adapter.exportItem("plugin:hookify@claude-plugins-official"), assertCode("INVALID_REQUEST"));
});

test("a hand-broken settings.json or ~/.claude.json never has its text (a secret) quoted in fileErrors or errors", async (t) => {
  const f = await fixture(t);
  const centur = await item(f.adapter, "mcp:centur");
  // V8's SyntaxError quotes the text around a bad token — here an unquoted token value.
  await writeFile(f.settingsPath, '{"env": {"ANTHROPIC_API_KEY": sk-LEAKED-PLACEHOLDER}}');
  let snapshot = await f.adapter.snapshot();
  const settingsError = snapshot.fileErrors.find((e) => e.path === f.settingsPath);
  assert.ok(settingsError);
  assert.ok(!JSON.stringify(snapshot).includes("sk-LEAK"), "no quoted text in the snapshot");
  await assert.rejects(f.adapter.setEnabled(centur.id, centur.revision, false), (error: unknown) => {
    assertCode("CONFIG_UNREADABLE")(error);
    assert.ok(!(error as Error).message.includes("sk-LEAK"), (error as Error).message);
    return true;
  });

  await writeFile(f.claudeJson, '{"mcpServers": {"jira": {"env": {"JIRA_API_TOKEN": sk-LEAKED-PLACEHOLDER}}}}');
  snapshot = await f.adapter.snapshot();
  assert.ok(snapshot.fileErrors.some((e) => e.path === f.claudeJson));
  assert.ok(!JSON.stringify(snapshot).includes("sk-LEAK"), "no quoted text in the snapshot");
  await assert.rejects(
    f.adapter.create({ kind: "mcp", mcp: { name: "x", transport: "sse", url: "https://sse.example/sse" } }, { onConflict: "fail" }),
    (error: unknown) => {
      assertCode("CONFIG_UNREADABLE")(error);
      assert.ok(!(error as Error).message.includes("sk-LEAK"), (error as Error).message);
      return true;
    }
  );
});

test("a hook naming agent-hook.sh is refused: it would turn its user group into Orquester's managed one", async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.settingsPath, "utf8");
  // Joining the user UserPromptSubmit group would make isManagedGroup() claim it — and the
  // daemon's next hook install replaces every managed group, dropping the user's reinject hook.
  await assert.rejects(
    f.adapter.create(
      { kind: "hook", hook: { event: "UserPromptSubmit", command: `'${f.managedHookScript}' claude SessionStart` } },
      { onConflict: "fail" }
    ),
    assertCode("INVALID_ITEM")
  );
  const reinject = (await f.adapter.snapshot()).items.find((i) => i.kind === "hook" && i.name.includes("reinject-claude-md.py"));
  assert.ok(reinject);
  await assert.rejects(
    f.adapter.update(reinject.id, reinject.revision, { kind: "hook", hook: { event: "UserPromptSubmit", command: "sh agent-hook.sh" } }),
    assertCode("INVALID_ITEM")
  );
  assert.equal(await readFile(f.settingsPath, "utf8"), before);
});

test("off then on keeps a plugin's version pin and a skill's partial override", async (t) => {
  const f = await fixture(t);
  const settings = await readJson(f.settingsPath);
  settings.enabledPlugins["superpowers@claude-plugins-official"] = ["^6.0.0"];
  settings.skillOverrides = { handoff: "user-invocable-only" };
  await writeJson(f.settingsPath, settings, 0o600);
  const pluginId = "plugin:superpowers@claude-plugins-official";

  let plugin = await item(f.adapter, pluginId);
  assert.equal(plugin.enabled, true, "a pin list is on");
  await f.adapter.setEnabled(plugin.id, plugin.revision, false);
  assert.equal((await readJson(f.settingsPath)).enabledPlugins["superpowers@claude-plugins-official"], false);
  plugin = await item(f.adapter, pluginId);
  await f.adapter.setEnabled(plugin.id, plugin.revision, true);
  assert.deepEqual((await readJson(f.settingsPath)).enabledPlugins["superpowers@claude-plugins-official"], ["^6.0.0"]);

  let skill = await item(f.adapter, "skill:handoff");
  assert.equal(skill.enabled, true, "user-invocable-only is not off");
  await f.adapter.setEnabled(skill.id, skill.revision, false);
  assert.equal((await readJson(f.settingsPath)).skillOverrides.handoff, "off");
  skill = await item(f.adapter, "skill:handoff");
  await f.adapter.setEnabled(skill.id, skill.revision, true);
  assert.deepEqual((await readJson(f.settingsPath)).skillOverrides, { handoff: "user-invocable-only" });
  // Renamed while off, it still comes back with its own override.
  skill = await item(f.adapter, "skill:handoff");
  await f.adapter.setEnabled(skill.id, skill.revision, false);
  skill = await item(f.adapter, "skill:handoff");
  await f.adapter.update(skill.id, skill.revision, { kind: "skill", document: { name: "handover", frontmatter: {}, body: "Write it.\n" } });
  skill = await item(f.adapter, "skill:handover");
  assert.equal(skill.enabled, false);
  await f.adapter.setEnabled(skill.id, skill.revision, true);
  assert.deepEqual((await readJson(f.settingsPath)).skillOverrides, { handover: "user-invocable-only" });

  // A value set by hand in between wins over an older memory: off (pin kept), on by hand, off, on.
  plugin = await item(f.adapter, pluginId);
  await f.adapter.setEnabled(plugin.id, plugin.revision, false);
  const byHand = await readJson(f.settingsPath);
  byHand.enabledPlugins["superpowers@claude-plugins-official"] = true;
  await writeJson(f.settingsPath, byHand, 0o600);
  plugin = await item(f.adapter, pluginId);
  await f.adapter.setEnabled(plugin.id, plugin.revision, false);
  plugin = await item(f.adapter, pluginId);
  await f.adapter.setEnabled(plugin.id, plugin.revision, true);
  assert.equal((await readJson(f.settingsPath)).enabledPlugins["superpowers@claude-plugins-official"], true);
  assert.ok(!(await f.adapter.snapshot()).items.some((i) => i.stashed), "remembered values are not listed");
});

test("turning off a hook whose identical copy is already stashed replaces that copy instead of refusing", async (t) => {
  const f = await fixture(t);
  const { itemIds } = await f.adapter.create({ kind: "hook", hook: { event: "SessionStart", command: "~/bin/hello.sh" } }, { onConflict: "fail" });
  let hook = await item(f.adapter, itemIds[0]!);
  await f.adapter.setEnabled(hook.id, hook.revision, false);
  // The same hook is put back by hand: the live one hides the stashed copy.
  const settings = await readJson(f.settingsPath);
  settings.hooks.SessionStart = [{ hooks: [{ type: "command", command: "~/bin/hello.sh" }] }];
  await writeJson(f.settingsPath, settings, 0o600);
  hook = await item(f.adapter, itemIds[0]!);
  assert.equal(hook.enabled, true);
  await f.adapter.setEnabled(hook.id, hook.revision, false);
  assert.equal((await readJson(f.settingsPath)).hooks.SessionStart, undefined);
  hook = await item(f.adapter, itemIds[0]!);
  assert.deepEqual([hook.enabled, hook.stashed, hook.warnings], [false, true, []]);
  await f.adapter.setEnabled(hook.id, hook.revision, true);
  assert.deepEqual((await readJson(f.settingsPath)).hooks.SessionStart, [{ hooks: [{ type: "command", command: "~/bin/hello.sh" }] }]);
});

test("the claude CLI gets CLAUDE_CONFIG_DIR only when the daemon's own moved the config dir", async (t) => {
  const f = await fixture(t);
  const moved = join(f.root, "moved-claude");
  await writeJson(join(moved, "plugins", "installed_plugins.json"), { version: 2, plugins: {} });
  const adapter = f.makeAdapter({ claudeDir: moved });
  await adapter.create({ kind: "plugin", plugin: { plugin: "hookify", marketplace: "claude-plugins-official" } }, { onConflict: "fail" });
  const calls = await readArgv(f.argvLog);
  assert.deepEqual([calls.at(-1)?.home, calls.at(-1)?.claudeConfigDir], [f.home, moved]);
});

test("a server whose name Claude accepts but the profile's naming rule does not can still be edited in place", async (t) => {
  const f = await fixture(t);
  const live = await readJson(f.claudeJson);
  live.mcpServers["1password"] = { type: "stdio", command: "op-mcp", args: [], env: { OP_TOKEN: "op-PLACEHOLDER" } };
  await writeJson(f.claudeJson, live, 0o600);
  const server = await item(f.adapter, "mcp:1password");
  await f.adapter.update(server.id, server.revision, {
    kind: "mcp",
    mcp: { name: "1password", transport: "stdio", command: "op-mcp", args: ["--read-only"], env: [{ key: "OP_TOKEN", keep: true }] }
  });
  assert.deepEqual((await readJson(f.claudeJson)).mcpServers["1password"], {
    type: "stdio",
    command: "op-mcp",
    args: ["--read-only"],
    env: { OP_TOKEN: "op-PLACEHOLDER" }
  });
  // A rename still has to pass the rule.
  const edited = await item(f.adapter, "mcp:1password");
  await assert.rejects(
    f.adapter.update(edited.id, edited.revision, { kind: "mcp", mcp: { name: "2password", transport: "stdio", command: "op-mcp" } }),
    assertCode("INVALID_NAME")
  );
});
