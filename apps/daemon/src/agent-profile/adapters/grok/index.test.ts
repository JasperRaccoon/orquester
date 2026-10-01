import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProfileItem } from "@orquester/api";
import { agentProfileBackupsDir, agentProfileStashDir } from "@orquester/config";
import { AgentProfileError } from "../../errors.ts";
import { ProfileBackups, ProfileStash } from "../../infra/index.ts";
import type { AgentHomes } from "../types.ts";
import { GrokProfileAdapter } from "./index.ts";
import { parseToml } from "./toml-patch.ts";

// Secrets that must never leave the files they live in.
const SERENA_SECRET = "serena-secret-value-1";
const JIRA_SECRET = "jira-secret-value-2";
const CLAUDE_SECRET = "claude-secret-value-3";
const NEW_SECRET = "brand-new-secret-4";
const SECRETS = [SERENA_SECRET, JIRA_SECRET, CLAUDE_SECRET, NEW_SECRET];

const COMPAT_BLOCK = "# Claude's hooks would double-report status: keep them off.\n[compat.claude]\nhooks = false\n";

/** Shaped like this host's real `~/.grok/config.toml` (secrets replaced), plus comments and MCP servers. */
const CONFIG = `# Grok config — hand-edited
[cli]
installer = "npm"
auto_update = true

[marketplace]
default_skills_installs_purged = true
official_marketplace_auto_installed = true

  [[marketplace.sources]]
  name = "xAI Official"
  git = "https://github.com/xai-org/plugin-marketplace.git"

[ui]
permission_mode = "always-approve"

${COMPAT_BLOCK}
[plugins]
enabled = [
  "demo-plug", # installed from a path
  "feature-dev"
]

# Serena, for symbol search
[mcp_servers.serena]
command = "serena"
args = ["start-mcp-server"]
env = { SERENA_TOKEN = "${SERENA_SECRET}" }

[mcp_servers.jira]
url = "https://jira.example/mcp"

[mcp_servers.jira.headers]
Authorization = "Bearer ${JIRA_SECRET}"

[[hooks.PreToolUse]]
matcher = "Bash"
hooks = [ { type = "command", command = "echo toml-hook", timeout = 5 } ]
`;

interface Fixture {
  root: string;
  homes: AgentHomes;
  adapter: GrokProfileAdapter;
  stash: ProfileStash;
  argvLog: string;
  statePath: string;
  clock: { now: number };
  orquesterHooks: string;
  demoPluginPath: string;
  linkedPluginTarget: string;
}

interface FakeState {
  inspect?: unknown;
  inspectFails?: boolean;
  available?: unknown[];
}

/** The fake `grok`: records argv and env, answers from state.json, never touches a real home. */
const FAKE_GROK = `
const fs = require("node:fs");
const path = require("node:path");
const dir = __dirname;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "argv.log"), JSON.stringify({ args, HOME: process.env.HOME, GROK_HOME: process.env.GROK_HOME, cwd: process.cwd() }) + "\\n");
const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
const config = path.join(process.env.GROK_HOME, "config.toml");
const cmd = args.join(" ");
if (cmd === "inspect --json") {
  if (state.inspectFails) { process.stderr.write("inspect exploded\\n"); process.exit(3); }
  process.stdout.write(JSON.stringify(state.inspect));
} else if (args[0] === "plugin" && args[1] === "install") {
  process.stdout.write("Installed 1 plugin(s) from somewhere: " + args[2].split("@")[0] + "\\n");
} else if (args[0] === "plugin" && args[1] === "uninstall") {
  process.stdout.write("Uninstalled 1 plugin(s): " + args[2] + "\\n");
} else if (cmd === "plugin list --json --available") {
  process.stdout.write(JSON.stringify(state.available ?? []));
} else if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") {
  const name = path.basename(args[3]);
  fs.appendFileSync(config, "\\n[[marketplace.sources]]\\nname = \\"" + name + "\\"\\ngit = \\"https://github.com/" + args[3] + ".git\\"\\n");
  process.stdout.write("Added marketplace source: " + name + " (" + args[3] + ")\\n");
} else if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "remove") {
  process.stdout.write("Removed marketplace source and uninstalled 2 plugin(s): a, b\\n");
} else {
  process.stderr.write("unexpected: " + cmd + "\\n");
  process.exit(2);
}
`;

async function write(path: string, text: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
}

function inspectReport(fx: { homes: AgentHomes; demoPluginPath: string }): unknown {
  const { grokHome, claudeJson, claudeDir } = fx.homes;
  return {
    grokVersion: "1.0.34",
    hooks: [],
    skills: [
      { name: "own-skill", source: { type: "user", path: join(grokHome, "skills/own-skill/SKILL.md") } },
      { name: "plug-skill", description: "From the plugin", source: { type: "plugin", plugin_name: "demo-plug", path: join(fx.demoPluginPath, "skills/plug-skill/SKILL.md") } },
      { name: "plug-cmd", source: { type: "plugin", plugin_name: "demo-plug", path: join(fx.demoPluginPath, "commands/plug-cmd.md") } }
    ],
    plugins: [
      { name: "demo-plug", scope: "user", path: fx.demoPluginPath, enabled: true, provides: { skills: 1, agents: 0, hooks: true, mcpServers: 1 } },
      { name: "linked-plug", scope: "user", path: join(grokHome, "plugins/linked-plug"), enabled: true },
      { name: "claude-plug", scope: "user", path: join(claudeDir, "plugins/cache/x/claude-plug"), enabled: true }
    ],
    marketplaces: [],
    mcpServers: [
      { name: "serena", transport: "stdio", target: "serena", source: { type: "configToml", path: join(grokHome, "config.toml") } },
      { name: "claude-srv", transport: "stdio", target: "node", source: { type: "claudeJson", path: claudeJson }, vendor: "claude" },
      { name: "plug-srv", transport: "stdio", target: "x", source: { type: "plugin", plugin_name: "demo-plug", path: fx.demoPluginPath } }
    ]
  };
}

async function setup(t: test.TestContext, state: FakeState = {}): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orquester-grok-profile-")));
  const home = join(root, "home");
  const homes: AgentHomes = {
    home,
    claudeDir: join(home, ".claude"),
    claudeJson: join(home, ".claude.json"),
    codexHome: join(home, ".codex"),
    grokHome: join(home, ".grok"),
    opencodeDir: join(home, ".config/opencode"),
    agentsSkillsDir: join(home, ".agents/skills")
  };
  const g = homes.grokHome;
  await write(join(g, "config.toml"), CONFIG);
  const orquesterHooks = `${JSON.stringify(
    {
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "'/appdir/daemon/hooks/agent-hook.sh' grok Stop", timeout: 10 }] }],
        PreToolUse: [{ hooks: [{ type: "command", command: "'/appdir/daemon/hooks/agent-hook.sh' grok PreToolUse", timeout: 10 }] }]
      }
    },
    null,
    2
  )}\n`;
  await write(join(g, "hooks/orquester.json"), orquesterHooks);
  await write(join(g, "skills/own-skill/SKILL.md"), "---\nname: own-skill\ndescription: Own skill\nextra-key: kept\n---\nOwn body\n");
  await write(join(g, "skills/own-skill/notes.txt"), "notes\n");
  await write(join(g, "commands/my-cmd.md"), "---\ndescription: My command\n---\nDo the thing\n");
  await write(join(g, "bundled/skills/imagine/SKILL.md"), "---\nname: imagine\ndescription: Bundled\n---\nb\n");
  await write(join(homes.claudeDir, "skills/claude-skill/SKILL.md"), "---\nname: claude-skill\ndescription: Claude skill\n---\nc\n");
  await write(join(homes.agentsSkillsDir, "shared-skill/SKILL.md"), "---\nname: shared-skill\ndescription: Shared\n---\ns\n");
  await write(join(g, "AGENTS.md"), "# Grok rules\n");
  await write(join(g, "GROK.md"), "# Old notes\nkeep me\n");
  await write(
    homes.claudeJson,
    JSON.stringify({
      numStartups: 3,
      mcpServers: { "claude-srv": { type: "stdio", command: "node", args: ["srv.js"], env: { TOKEN: CLAUDE_SECRET } } },
      projects: { "/x": { mcpServers: { "project-only": { command: "p" } } } }
    })
  );
  const demoPluginPath = join(g, "installed-plugins/demo-plug-f13f37e3");
  await write(join(demoPluginPath, ".claude-plugin/plugin.json"), JSON.stringify({ name: "demo-plug", version: "1.2.3", description: "Demo plugin" }));
  await write(join(demoPluginPath, ".mcp.json"), JSON.stringify({ mcpServers: { "plug-srv": { command: "x", env: { K: "v" } } } }));
  await write(
    join(g, "installed-plugins/registry.json"),
    JSON.stringify({ version: 1, repos: { "demo-plug-f13f37e3": { path: demoPluginPath, plugins: { "demo-plug": { version: "1.2.3" } }, marketplace: { source_display_name: "mkt" } } } })
  );
  const linkedPluginTarget = join(homes.claudeDir, "plugins/cache/official/linked-plug/1.0.0");
  await write(join(linkedPluginTarget, "plugin.json"), JSON.stringify({ name: "linked-plug", version: "1.0.0" }));
  await mkdir(join(g, "plugins"), { recursive: true });
  await symlink(linkedPluginTarget, join(g, "plugins/linked-plug"));

  const binDir = join(root, "bin");
  await mkdir(binDir);
  const bin = join(binDir, "grok");
  await writeFile(bin, `#!${process.execPath}\n${FAKE_GROK}`);
  await chmod(bin, 0o755);
  const statePath = join(binDir, "state.json");
  const appdir = join(root, "appdir");
  const clock = { now: Date.parse("2026-09-28T12:00:00Z") };
  const stash = new ProfileStash({ dir: agentProfileStashDir(appdir) });
  const adapter = new GrokProfileAdapter(
    {
      homes,
      appdir,
      bin,
      accountHomes: async () => [],
      logger: { info: () => undefined, warn: () => undefined },
      now: () => new Date(clock.now)
    },
    { backups: new ProfileBackups({ dir: agentProfileBackupsDir(appdir) }), stash }
  );
  const fx: Fixture = { root, homes, adapter, stash, argvLog: join(binDir, "argv.log"), statePath, clock, orquesterHooks, demoPluginPath, linkedPluginTarget };
  await writeFile(statePath, JSON.stringify({ inspect: inspectReport(fx), ...state }));
  t.after(async () => {
    // Never a secret in any process argument; the compat pin and Orquester's hooks never touched.
    const log = await readFile(fx.argvLog, "utf8").catch(() => "");
    for (const secret of SECRETS) assert.ok(!log.includes(secret), "a secret reached a grok argv");
    assert.equal(await readFile(join(g, "hooks/orquester.json"), "utf8"), orquesterHooks);
    await rm(root, { recursive: true, force: true });
  });
  return fx;
}

async function calls(fx: Fixture): Promise<{ args: string[]; HOME: string; GROK_HOME: string; cwd: string }[]> {
  const log = await readFile(fx.argvLog, "utf8").catch(() => "");
  return log.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function config(fx: Fixture): Promise<string> {
  return readFile(join(fx.homes.grokHome, "config.toml"), "utf8");
}

async function item(fx: Fixture, id: string): Promise<ProfileItem> {
  const found = (await fx.adapter.snapshot()).items.find((entry) => entry.id === id);
  assert.ok(found, `no item ${id}`);
  return found;
}

async function rejects(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AgentProfileError, `not an AgentProfileError: ${String(error)}`);
    assert.equal(error.code, code, error.message);
    for (const secret of SECRETS) assert.ok(!error.message.includes(secret));
    return true;
  });
}

test("the snapshot lists every kind from its real home, with sources, locks and no secret", async (t) => {
  const fx = await setup(t);
  const snap = await fx.adapter.snapshot();
  const byId = new Map(snap.items.map((entry) => [entry.id, entry]));
  assert.deepEqual(snap.fileErrors, []);
  for (const secret of SECRETS) assert.ok(!JSON.stringify(snap).includes(secret));

  const serena = byId.get("mcp:serena");
  assert.equal(serena?.source.type, "user");
  assert.equal(serena?.editable, true);
  assert.equal(byId.get("mcp:jira")?.meta?.transport, "http");
  const claudeSrv = byId.get("mcp:claude-srv");
  assert.deepEqual(claudeSrv?.source, { type: "inherited", label: "From Claude", ownerAgent: "claude" });
  assert.deepEqual([claudeSrv?.toggleable, claudeSrv?.editable, claudeSrv?.deletable], [true, false, false]);
  assert.equal(byId.get("mcp:plug-srv")?.source.label, "Plugin · demo-plug");
  assert.equal(byId.has("mcp:project-only"), false);

  assert.equal(byId.get("skill:own-skill")?.editable, true);
  assert.equal(byId.get("skill:claude/claude-skill")?.source.label, "From Claude");
  assert.equal(byId.get("skill:agents/shared-skill")?.source.label, "Shared · ~/.agents");
  assert.deepEqual([byId.get("skill:bundled/imagine")?.source.type, byId.get("skill:bundled/imagine")?.toggleable], ["bundled", true]);
  assert.equal(byId.get("skill:plugin/demo-plug/plug-skill")?.source.pluginId, "demo-plug");
  assert.equal(byId.get("command:plugin/demo-plug/plug-cmd")?.kind, "command");
  assert.equal(byId.get("command:my-cmd")?.description, "My command");

  const hooks = snap.items.filter((entry) => entry.kind === "hook");
  const locked = hooks.filter((entry) => entry.locked);
  assert.equal(locked.length, 2);
  for (const entry of locked) {
    assert.deepEqual([entry.toggleable, entry.editable, entry.deletable, entry.source.type], [false, false, false, "orquester"]);
  }
  const tomlHook = hooks.find((entry) => entry.meta?.file === "config.toml");
  assert.equal(tomlHook?.name, "echo toml-hook");
  assert.deepEqual([tomlHook?.toggleable, tomlHook?.editable, tomlHook?.deletable], [false, false, false]);

  const demo = byId.get("plugin:demo-plug");
  assert.deepEqual([demo?.enabled, demo?.deletable, demo?.meta?.version, demo?.meta?.marketplace], [true, true, "1.2.3", "mkt"]);
  assert.deepEqual([byId.get("plugin:linked-plug")?.enabled, byId.get("plugin:linked-plug")?.deletable], [false, true]);
  assert.deepEqual([byId.get("plugin:claude-plug")?.source.label, byId.get("plugin:claude-plug")?.deletable], ["From Claude", false]);

  const market = byId.get("marketplace:xAI Official");
  assert.equal(market?.meta?.source, "xai-org/plugin-marketplace");
  assert.equal(market?.deletable, true);

  assert.equal(snap.instructions.exists, true);
  assert.equal(snap.instructions.lines, 1);
  assert.equal(snap.instructions.legacyPath, join(fx.homes.grokHome, "GROK.md"));
  assert.equal(snap.instructions.warnings[0]?.code, "legacy-grok-md");

  const [run] = (await calls(fx)).filter((call) => call.args[0] === "inspect");
  assert.deepEqual(run, { args: ["inspect", "--json"], HOME: fx.homes.home, GROK_HOME: fx.homes.grokHome, cwd: fx.homes.grokHome });
});

test("MCP servers: create, read masked, edit with kept secrets, rename, delete — comments and the compat pin survive", async (t) => {
  const fx = await setup(t);
  const created = await fx.adapter.create(
    {
      kind: "mcp",
      mcp: {
        name: "files",
        transport: "stdio",
        command: "npx",
        args: ["-y", "fs"],
        env: [{ key: "API_KEY", value: NEW_SECRET }],
        advanced: { startup_timeout_sec: 45 }
      }
    },
    { onConflict: "fail" }
  );
  assert.deepEqual(created.itemIds, ["mcp:files"]);
  let text = await config(fx);
  assert.ok(text.includes(COMPAT_BLOCK));
  assert.ok(text.includes("# Serena, for symbol search\n[mcp_servers.serena]"));
  assert.ok(text.includes('  "demo-plug", # installed from a path'));
  assert.deepEqual((parseToml(text).mcp_servers as Record<string, unknown>).files, {
    command: "npx", args: ["-y", "fs"], env: { API_KEY: NEW_SECRET }, startup_timeout_sec: 45
  });

  const detail = await fx.adapter.readItem("mcp:files");
  assert.equal(detail.kind, "mcp");
  if (detail.kind === "mcp") {
    assert.deepEqual(detail.mcp.env, [{ key: "API_KEY", set: true }]);
    assert.deepEqual(detail.mcp.advanced, { startup_timeout_sec: 45 });
  }
  assert.ok(!JSON.stringify(detail).includes(NEW_SECRET));
  await rejects(fx.adapter.create({ kind: "mcp", mcp: { name: "files", transport: "stdio", command: "x" } }, { onConflict: "fail" }), "ITEM_EXISTS");
  await rejects(fx.adapter.create({ kind: "mcp", mcp: { name: "bad_", transport: "stdio", command: "x" } }, { onConflict: "fail" }), "INVALID_NAME");
  await rejects(
    fx.adapter.create({ kind: "mcp", mcp: { name: "h", transport: "stdio", command: "x", headers: [{ key: "A", value: "b" }] } }, { onConflict: "fail" }),
    "INVALID_ITEM"
  );

  // Edit the http server: keep its secret header, add one, set an advanced field.
  const jira = await item(fx, "mcp:jira");
  await fx.adapter.update("mcp:jira", jira.revision, {
    kind: "mcp",
    mcp: {
      name: "jira",
      transport: "http",
      url: "https://jira.example/mcp/v2",
      headers: [{ key: "Authorization", keep: true }, { key: "X-Team", value: "core" }],
      advanced: { tool_timeout_sec: 60 }
    }
  });
  let doc = parseToml(await config(fx));
  assert.deepEqual((doc.mcp_servers as Record<string, unknown>).jira, {
    url: "https://jira.example/mcp/v2",
    headers: { Authorization: `Bearer ${JIRA_SECRET}`, "X-Team": "core" },
    tool_timeout_sec: 60
  });
  await rejects(
    fx.adapter.update("mcp:jira", jira.revision, { kind: "mcp", mcp: { name: "jira", transport: "http", url: "https://x" } }),
    "PROFILE_CONFLICT"
  );

  // Removing an env entry drops it; renaming moves the table and keeps it off.
  const serena = await item(fx, "mcp:serena");
  await fx.adapter.setEnabled("mcp:serena", serena.revision, false);
  const off = await item(fx, "mcp:serena");
  const renamed = await fx.adapter.update("mcp:serena", off.revision, {
    kind: "mcp",
    mcp: { name: "serena2", transport: "stdio", command: "serena", args: ["start-mcp-server"] }
  });
  assert.deepEqual(renamed.itemIds, ["mcp:serena2"]);
  doc = parseToml(await config(fx));
  const servers = doc.mcp_servers as Record<string, Record<string, unknown>>;
  assert.equal(servers.serena, undefined);
  assert.deepEqual(servers.serena2, { command: "serena", args: ["start-mcp-server"], enabled: false });
  assert.deepEqual(doc.disabled_mcp_servers, ["serena2"]);

  const s2 = await item(fx, "mcp:serena2");
  await fx.adapter.remove("mcp:serena2", s2.revision);
  doc = parseToml(await config(fx));
  assert.equal((doc.mcp_servers as Record<string, unknown>).serena2, undefined);
  assert.equal(doc.disabled_mcp_servers, undefined);
  text = await config(fx);
  assert.ok(text.includes(COMPAT_BLOCK));
  assert.ok(text.startsWith("# Grok config — hand-edited\n"), JSON.stringify(text.slice(0, 80)));
});

test("MCP on/off mirrors grok mcp disable/enable, for own and inherited servers alike", async (t) => {
  const fx = await setup(t);
  const claudeBefore = await readFile(fx.homes.claudeJson, "utf8");
  const serena = await item(fx, "mcp:serena");
  await fx.adapter.setEnabled("mcp:serena", serena.revision, false);
  let doc = parseToml(await config(fx));
  assert.deepEqual(doc.disabled_mcp_servers, ["serena"]);
  assert.equal((doc.mcp_servers as Record<string, Record<string, unknown>>).serena?.enabled, false);
  assert.equal((await item(fx, "mcp:serena")).enabled, false);

  const claudeSrv = await item(fx, "mcp:claude-srv");
  await fx.adapter.setEnabled("mcp:claude-srv", claudeSrv.revision, false);
  doc = parseToml(await config(fx));
  assert.deepEqual(doc.disabled_mcp_servers, ["serena", "claude-srv"]);
  assert.equal((await item(fx, "mcp:claude-srv")).enabled, false);

  await fx.adapter.setEnabled("mcp:serena", (await item(fx, "mcp:serena")).revision, true);
  await fx.adapter.setEnabled("mcp:claude-srv", (await item(fx, "mcp:claude-srv")).revision, true);
  doc = parseToml(await config(fx));
  assert.equal(doc.disabled_mcp_servers, undefined);
  assert.equal((doc.mcp_servers as Record<string, Record<string, unknown>>).serena?.enabled, true);
  assert.equal(await readFile(fx.homes.claudeJson, "utf8"), claudeBefore);

  const plug = await item(fx, "mcp:plug-srv");
  await rejects(fx.adapter.update("mcp:plug-srv", plug.revision, { kind: "mcp", mcp: { name: "plug-srv", transport: "stdio", command: "y" } }), "NOT_EDITABLE");
  await rejects(fx.adapter.remove("mcp:claude-srv", (await item(fx, "mcp:claude-srv")).revision), "NOT_DELETABLE");
  const claudeDetail = await fx.adapter.readItem("mcp:claude-srv");
  assert.ok(!JSON.stringify(claudeDetail).includes(CLAUDE_SECRET));

  const exported = await fx.adapter.exportItem("mcp:claude-srv");
  assert.equal(exported.kind === "mcp" ? exported.server.env?.TOKEN : undefined, CLAUDE_SECRET);
  const imported = await fx.adapter.importItem(exported, { onConflict: "keep-both" });
  assert.deepEqual(imported.itemIds, ["mcp:claude-srv-2"]);
  doc = parseToml(await config(fx));
  assert.deepEqual((doc.mcp_servers as Record<string, unknown>)["claude-srv-2"], { command: "node", args: ["srv.js"], env: { TOKEN: CLAUDE_SECRET } });
});

test("skills and commands: create, edit, toggle via [skills] disabled (inherited too), delete", async (t) => {
  const fx = await setup(t);
  await fx.adapter.create(
    { kind: "skill", document: { name: "new-skill", frontmatter: { description: "New" }, body: "Body\n" } },
    { onConflict: "fail" }
  );
  assert.equal(await readFile(join(fx.homes.grokHome, "skills/new-skill/SKILL.md"), "utf8"), "---\nname: new-skill\ndescription: New\n---\nBody\n");
  await rejects(fx.adapter.create({ kind: "skill", document: { name: "new-skill", frontmatter: {}, body: "" } }, { onConflict: "fail" }), "ITEM_EXISTS");
  const both = await fx.adapter.create({ kind: "skill", document: { name: "new-skill", frontmatter: {}, body: "x" } }, { onConflict: "keep-both" });
  assert.deepEqual(both.itemIds, ["skill:new-skill-2"]);

  const own = await item(fx, "skill:own-skill");
  await fx.adapter.update("skill:own-skill", own.revision, {
    kind: "skill",
    document: { name: "own-skill", frontmatter: { description: "Changed" }, body: "New body\n" }
  });
  assert.equal(
    await readFile(join(fx.homes.grokHome, "skills/own-skill/SKILL.md"), "utf8"),
    "---\nname: own-skill\ndescription: Changed\nextra-key: kept\n---\nNew body\n"
  );
  const detail = await fx.adapter.readItem("skill:own-skill");
  assert.deepEqual(detail.kind === "skill" ? detail.files : [], ["notes.txt"]);
  await rejects(
    fx.adapter.update("skill:own-skill", (await item(fx, "skill:own-skill")).revision, {
      kind: "skill",
      document: { name: "renamed", frontmatter: {}, body: "" }
    }),
    "INVALID_REQUEST"
  );

  // Own, Claude's, the shared one and a bundled one all turn off by name in [skills] disabled.
  for (const id of ["skill:own-skill", "skill:claude/claude-skill", "skill:agents/shared-skill", "skill:bundled/imagine", "command:my-cmd"]) {
    await fx.adapter.setEnabled(id, (await item(fx, id)).revision, false);
    assert.equal((await item(fx, id)).enabled, false);
  }
  let doc = parseToml(await config(fx));
  assert.deepEqual((doc.skills as Record<string, unknown>).disabled, ["own-skill", "claude-skill", "shared-skill", "imagine", "my-cmd"]);
  assert.ok((await config(fx)).includes(COMPAT_BLOCK));
  await fx.adapter.setEnabled("skill:claude/claude-skill", (await item(fx, "skill:claude/claude-skill")).revision, true);
  await rejects(
    fx.adapter.remove("skill:claude/claude-skill", (await item(fx, "skill:claude/claude-skill")).revision),
    "NOT_DELETABLE"
  );
  await rejects(
    fx.adapter.update("skill:claude/claude-skill", (await item(fx, "skill:claude/claude-skill")).revision, {
      kind: "skill",
      document: { name: "claude-skill", frontmatter: {}, body: "" }
    }),
    "NOT_EDITABLE"
  );

  // Delete an off skill: its directory goes and so does its [skills] disabled entry.
  await fx.adapter.remove("skill:own-skill", (await item(fx, "skill:own-skill")).revision);
  assert.equal(await lstat(join(fx.homes.grokHome, "skills/own-skill")).catch(() => null), null);
  doc = parseToml(await config(fx));
  assert.deepEqual((doc.skills as Record<string, unknown>).disabled, ["shared-skill", "imagine", "my-cmd"]);

  // Commands: flat only; rename carries the off state.
  await rejects(fx.adapter.create({ kind: "command", document: { name: "git/pr", frontmatter: {}, body: "" } }, { onConflict: "fail" }), "INVALID_NAME");
  await fx.adapter.create({ kind: "command", document: { name: "review", frontmatter: { description: "Review" }, body: "Go\n" } }, { onConflict: "fail" });
  assert.equal(await readFile(join(fx.homes.grokHome, "commands/review.md"), "utf8"), "---\ndescription: Review\n---\nGo\n");
  const renamed = await fx.adapter.update("command:my-cmd", (await item(fx, "command:my-cmd")).revision, {
    kind: "command",
    document: { name: "my-command", frontmatter: {}, body: "Do it\n" }
  });
  assert.deepEqual(renamed.itemIds, ["command:my-command"]);
  assert.equal(await readFile(join(fx.homes.grokHome, "commands/my-command.md"), "utf8"), "---\ndescription: My command\n---\nDo it\n");
  assert.equal((await item(fx, "command:my-command")).enabled, false);
  doc = parseToml(await config(fx));
  assert.deepEqual((doc.skills as Record<string, unknown>).disabled, ["shared-skill", "imagine", "my-command"]);
  await fx.adapter.remove("command:review", (await item(fx, "command:review")).revision);
  assert.deepEqual((await readdir(join(fx.homes.grokHome, "commands"))).sort(), ["my-command.md"]);

  // A plugin skill turns off by its bare name too.
  await fx.adapter.setEnabled("skill:plugin/demo-plug/plug-skill", (await item(fx, "skill:plugin/demo-plug/plug-skill")).revision, false);
  doc = parseToml(await config(fx));
  assert.ok(((doc.skills as Record<string, unknown>).disabled as string[]).includes("plug-skill"));

  // Copy a skill out and back in under another name.
  const exported = await fx.adapter.exportItem("skill:new-skill");
  t.after(() => (exported.kind === "skill" ? rm(exported.dir, { recursive: true, force: true }) : undefined));
  const imported = await fx.adapter.importItem(exported, { onConflict: "keep-both" });
  assert.deepEqual(imported.itemIds, ["skill:new-skill-3"]);
  assert.match(await readFile(join(fx.homes.grokHome, "skills/new-skill-3/SKILL.md"), "utf8"), /^---\nname: new-skill-3\n/);
});

test("hooks: create into profile.json, off by stash and back, edit, delete; Orquester's and config.toml's are refused", async (t) => {
  const fx = await setup(t);
  const created = await fx.adapter.create(
    { kind: "hook", hook: { event: "PreToolUse", matcher: "Bash", command: "echo guard", timeoutSec: 7 } },
    { onConflict: "fail" }
  );
  const id = created.itemIds[0] as string;
  const profilePath = join(fx.homes.grokHome, "hooks/profile.json");
  assert.deepEqual(JSON.parse(await readFile(profilePath, "utf8")), {
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo guard", timeout: 7 }] }] }
  });
  const again = await fx.adapter.create({ kind: "hook", hook: { event: "PreToolUse", matcher: "Bash", command: "echo guard", timeoutSec: 7 } }, { onConflict: "replace" });
  assert.deepEqual(again.itemIds, [id]);
  await rejects(fx.adapter.create({ kind: "hook", hook: { event: "Nope", command: "x" } }, { onConflict: "fail" }), "INVALID_ITEM");

  // Off: the handler moves to the stash; the file keeps an empty hooks object.
  await fx.adapter.setEnabled(id, (await item(fx, id)).revision, false);
  assert.deepEqual(JSON.parse(await readFile(profilePath, "utf8")), { hooks: {} });
  const off = await item(fx, id);
  assert.deepEqual([off.enabled, off.stashed], [false, true]);
  // Edit while off stays in the stash under its new identity.
  const edited = await fx.adapter.update(id, off.revision, { kind: "hook", hook: { event: "PreToolUse", matcher: "Bash", command: "echo guard2" } });
  const id2 = edited.itemIds[0] as string;
  assert.notEqual(id2, id);
  await fx.adapter.setEnabled(id2, (await item(fx, id2)).revision, true);
  assert.deepEqual(JSON.parse(await readFile(profilePath, "utf8")), {
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo guard2" }] }] }
  });
  assert.equal((await fx.stash.list("grok")).length, 0);

  // Edit in place; a matcher change moves it to a new group; then delete.
  const moved = await fx.adapter.update(id2, (await item(fx, id2)).revision, { kind: "hook", hook: { event: "Stop", command: "echo done", matcher: "ignored" } });
  const id3 = moved.itemIds[0] as string;
  assert.deepEqual(JSON.parse(await readFile(profilePath, "utf8")), {
    hooks: { Stop: [{ hooks: [{ type: "command", command: "echo done" }] }] }
  });
  await fx.adapter.remove(id3, (await item(fx, id3)).revision);
  assert.deepEqual(JSON.parse(await readFile(profilePath, "utf8")), { hooks: {} });

  const snap = await fx.adapter.snapshot();
  const locked = snap.items.find((entry) => entry.kind === "hook" && entry.locked) as ProfileItem;
  await rejects(fx.adapter.setEnabled(locked.id, locked.revision, false), "ITEM_LOCKED");
  await rejects(fx.adapter.remove(locked.id, locked.revision), "ITEM_LOCKED");
  await rejects(fx.adapter.update(locked.id, locked.revision, { kind: "hook", hook: { event: "Stop", command: "x" } }), "ITEM_LOCKED");
  const tomlHook = snap.items.find((entry) => entry.meta?.file === "config.toml") as ProfileItem;
  await rejects(fx.adapter.setEnabled(tomlHook.id, tomlHook.revision, false), "NOT_TOGGLEABLE");
  assert.equal(await config(fx), CONFIG);
});

test("a hook turned back on whose file is gone recreates it", async (t) => {
  const fx = await setup(t);
  const { itemIds } = await fx.adapter.create({ kind: "hook", hook: { event: "SessionStart", command: "echo hi" } }, { onConflict: "fail" });
  const id = itemIds[0] as string;
  await fx.adapter.setEnabled(id, (await item(fx, id)).revision, false);
  await rm(join(fx.homes.grokHome, "hooks/profile.json"));
  await fx.adapter.setEnabled(id, (await item(fx, id)).revision, true);
  assert.deepEqual(JSON.parse(await readFile(join(fx.homes.grokHome, "hooks/profile.json"), "utf8")), {
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] }
  });
});

test("plugins: toggle through [plugins] lists, install and uninstall through grok, remove a linked plugin", async (t) => {
  const fx = await setup(t);
  await fx.adapter.setEnabled("plugin:demo-plug", (await item(fx, "plugin:demo-plug")).revision, false);
  let doc = parseToml(await config(fx));
  assert.deepEqual(doc.plugins, { enabled: ["feature-dev"], disabled: ["demo-plug"] });
  await fx.adapter.setEnabled("plugin:demo-plug", (await item(fx, "plugin:demo-plug")).revision, true);
  await fx.adapter.setEnabled("plugin:linked-plug", (await item(fx, "plugin:linked-plug")).revision, true);
  doc = parseToml(await config(fx));
  assert.deepEqual(doc.plugins, { enabled: ["feature-dev", "demo-plug", "linked-plug"], disabled: [] });
  assert.ok((await config(fx)).includes(COMPAT_BLOCK));

  const installed = await fx.adapter.create({ kind: "plugin", plugin: { plugin: "gdrive", marketplace: "mkt" } }, { onConflict: "fail" });
  assert.deepEqual(installed.itemIds, ["plugin:gdrive"]);
  await rejects(fx.adapter.create({ kind: "plugin", plugin: { spec: "--evil" } }, { onConflict: "fail" }), "INVALID_ITEM");
  await rejects(fx.adapter.create({ kind: "plugin", plugin: { plugin: "demo-plug", marketplace: "mkt" } }, { onConflict: "fail" }), "ITEM_EXISTS");

  await fx.adapter.remove("plugin:demo-plug", (await item(fx, "plugin:demo-plug")).revision);
  await fx.adapter.remove("plugin:linked-plug", (await item(fx, "plugin:linked-plug")).revision);
  assert.equal(await lstat(join(fx.homes.grokHome, "plugins/linked-plug")).catch(() => null), null);
  assert.ok(await lstat(join(fx.linkedPluginTarget, "plugin.json")));
  await rejects(fx.adapter.remove("plugin:claude-plug", (await item(fx, "plugin:claude-plug")).revision), "NOT_DELETABLE");
  await rejects(fx.adapter.update("plugin:claude-plug", (await item(fx, "plugin:claude-plug")).revision, { kind: "plugin", plugin: { spec: "x" } }), "NOT_EDITABLE");

  const cli = (await calls(fx)).filter((call) => call.args[0] === "plugin").map((call) => call.args);
  assert.deepEqual(cli, [
    ["plugin", "install", "gdrive@mkt", "--trust"],
    ["plugin", "uninstall", "demo-plug"]
  ]);
});

test("marketplaces: add through grok with a branch, list its plugins, remove", async (t) => {
  const fx = await setup(t, {
    available: [
      { status: "installed", name: "demo-plug", version: "1.2.3", marketplace: "team-plugins" },
      { status: "available", name: "gdrive", description: "Drive", version: "0.1.0", marketplace: "team-plugins" },
      { status: "available", name: "other", marketplace: "elsewhere" }
    ]
  });
  const added = await fx.adapter.create(
    { kind: "marketplace", marketplace: { source: { type: "github", repo: "acme/team-plugins", ref: "stable" } } },
    { onConflict: "fail" }
  );
  assert.deepEqual(added.itemIds, ["marketplace:team-plugins"]);
  const doc = parseToml(await config(fx));
  assert.deepEqual((doc.marketplace as Record<string, unknown[]>).sources?.[1], {
    name: "team-plugins",
    git: "https://github.com/acme/team-plugins.git",
    branch: "stable"
  });
  const market = await item(fx, "marketplace:team-plugins");
  assert.deepEqual(market.meta, { source: "acme/team-plugins", branch: "stable" });
  await rejects(
    fx.adapter.create({ kind: "marketplace", marketplace: { source: { type: "git", url: "https://user:tok@git.example/x.git" } } }, { onConflict: "fail" }),
    "INVALID_ITEM"
  );

  assert.deepEqual(await fx.adapter.listMarketplacePlugins("team-plugins"), [
    { name: "demo-plug", version: "1.2.3", installed: true },
    { name: "gdrive", description: "Drive", version: "0.1.0", installed: false }
  ]);

  await fx.adapter.remove("marketplace:xAI Official", (await item(fx, "marketplace:xAI Official")).revision);
  const cli = (await calls(fx)).filter((call) => call.args[0] === "plugin").map((call) => call.args);
  assert.deepEqual(cli, [
    ["plugin", "marketplace", "add", "acme/team-plugins"],
    ["plugin", "list", "--json", "--available"],
    ["plugin", "marketplace", "remove", "xAI Official"]
  ]);
});

test("instructions: write with a revision, and GROK.md folded into AGENTS.md", async (t) => {
  const fx = await setup(t);
  const { text, info } = await fx.adapter.readInstructions();
  assert.equal(text, "# Grok rules\n");
  await rejects(fx.adapter.writeInstructions("x", "stale"), "PROFILE_CONFLICT");
  await fx.adapter.writeInstructions("# Grok rules\nMore\n", info.revision);
  const current = await fx.adapter.readInstructions();
  assert.equal(current.info.lines, 2);
  await rejects(fx.adapter.migrateLegacyInstructions(info.revision), "PROFILE_CONFLICT");
  const result = await fx.adapter.migrateLegacyInstructions(current.info.revision);
  assert.equal(result.notes.length, 1);
  assert.equal(
    await readFile(join(fx.homes.grokHome, "AGENTS.md"), "utf8"),
    "# Grok rules\nMore\n\n<!-- moved from GROK.md -->\n# Old notes\nkeep me\n"
  );
  assert.equal(await lstat(join(fx.homes.grokHome, "GROK.md")).catch(() => null), null);
  const after = await fx.adapter.readInstructions();
  assert.equal(after.info.legacyPath, undefined);
  assert.deepEqual(after.info.warnings, []);
  await rejects(fx.adapter.migrateLegacyInstructions(after.info.revision), "INVALID_REQUEST");
});

test("with no AGENTS.md the migration makes GROK.md's text the file", async (t) => {
  const fx = await setup(t);
  await rm(join(fx.homes.grokHome, "AGENTS.md"));
  const { info } = await fx.adapter.readInstructions();
  assert.deepEqual([info.exists, info.revision], [false, ""]);
  await fx.adapter.migrateLegacyInstructions("");
  assert.equal(await readFile(join(fx.homes.grokHome, "AGENTS.md"), "utf8"), "# Old notes\nkeep me\n");
});

test("an unreadable config.toml is a file error without its secrets, and refuses every write to it", async (t) => {
  const fx = await setup(t);
  await writeFile(join(fx.homes.grokHome, "config.toml"), `[mcp_servers.x]\nenv = { T = "${NEW_SECRET}\n`);
  const snap = await fx.adapter.snapshot();
  assert.equal(snap.fileErrors.length, 1);
  assert.equal(snap.fileErrors[0]?.path, join(fx.homes.grokHome, "config.toml"));
  assert.ok(!JSON.stringify(snap).includes(NEW_SECRET));
  await rejects(fx.adapter.create({ kind: "mcp", mcp: { name: "y", transport: "stdio", command: "y" } }, { onConflict: "fail" }), "CONFIG_UNREADABLE");
  const own = await item(fx, "skill:own-skill");
  await rejects(fx.adapter.setEnabled("skill:own-skill", own.revision, false), "CONFIG_UNREADABLE");
  await rejects(fx.adapter.create({ kind: "plugin", plugin: { spec: "a/b" } }, { onConflict: "fail" }), "CONFIG_UNREADABLE");
  // Files other than config.toml still take writes.
  await fx.adapter.create({ kind: "skill", document: { name: "still-works", frontmatter: {}, body: "" } }, { onConflict: "fail" });
  assert.equal((await calls(fx)).filter((call) => call.args[0] === "plugin").length, 0);
});

test("an unreadable hook file is a file error and refuses writes to it", async (t) => {
  const fx = await setup(t);
  await writeFile(join(fx.homes.grokHome, "hooks/profile.json"), `{"hooks": {"Stop": [ "${NEW_SECRET}" x`);
  const snap = await fx.adapter.snapshot();
  assert.equal(snap.fileErrors[0]?.path, join(fx.homes.grokHome, "hooks/profile.json"));
  assert.ok(!JSON.stringify(snap).includes(NEW_SECRET));
  await rejects(fx.adapter.create({ kind: "hook", hook: { event: "Stop", command: "x" } }, { onConflict: "fail" }), "CONFIG_UNREADABLE");
});

test("when grok inspect fails, inherited servers come from ~/.claude.json with a warning", async (t) => {
  const fx = await setup(t, { inspectFails: true });
  const snap = await fx.adapter.snapshot();
  const claudeSrv = snap.items.find((entry) => entry.id === "mcp:claude-srv");
  assert.equal(claudeSrv?.warnings[0]?.code, "inspect-failed");
  assert.equal(claudeSrv?.toggleable, true);
  assert.equal(snap.items.some((entry) => entry.id === "mcp:plug-srv"), false);
  assert.deepEqual(snap.fileErrors, []);
  const plugins = snap.items.filter((entry) => entry.kind === "plugin").map((entry) => entry.id).sort();
  assert.deepEqual(plugins, ["plugin:demo-plug", "plugin:linked-plug"]);
  await fx.adapter.setEnabled("mcp:claude-srv", (claudeSrv as ProfileItem).revision, false);
  assert.deepEqual(parseToml(await config(fx)).disabled_mcp_servers, ["claude-srv"]);
});

test("a plugin installed together with others from one source is not deletable alone (grok would uninstall them all)", async (t) => {
  const fx = await setup(t);
  // What `grok plugin install <repo>` of a repo holding two plugins records (observed with 1.0.34).
  const repoPath = join(fx.homes.grokHome, "installed-plugins/multi-ae6d97ee");
  await write(
    join(fx.homes.grokHome, "installed-plugins/registry.json"),
    JSON.stringify({
      version: 1,
      repos: {
        "demo-plug-f13f37e3": { path: fx.demoPluginPath, plugins: { "demo-plug": { version: "1.2.3" } } },
        "multi-ae6d97ee": { path: repoPath, plugins: { alpha: { version: "1.0.0" }, beta: { version: "1.0.0" } } }
      }
    })
  );
  const state = JSON.parse(await readFile(fx.statePath, "utf8"));
  state.inspect.plugins.push(
    { name: "alpha", scope: "user", path: join(repoPath, "alpha"), enabled: true },
    { name: "beta", scope: "user", path: join(repoPath, "beta"), enabled: true }
  );
  await writeFile(fx.statePath, JSON.stringify(state));

  const alpha = await item(fx, "plugin:alpha");
  assert.equal(alpha.deletable, false);
  assert.ok(alpha.warnings.some((w) => w.code === "shared-install" && w.message.includes("beta")));
  assert.equal((await item(fx, "plugin:beta")).deletable, false);
  assert.equal((await item(fx, "plugin:demo-plug")).deletable, true, "a plugin alone in its install stays deletable");
  await rejects(fx.adapter.remove(alpha.id, alpha.revision), "NOT_DELETABLE");
  assert.deepEqual((await calls(fx)).filter((call) => call.args[0] === "plugin"), [], "grok was never asked to uninstall");
  // Its switch still works, and affects it alone.
  await fx.adapter.setEnabled(alpha.id, alpha.revision, true);
  assert.deepEqual((parseToml(await config(fx)).plugins as Record<string, unknown>).enabled, ["demo-plug", "feature-dev", "alpha"]);
});

test("an MCP server's revision moves when its secret changes", async (t) => {
  const fx = await setup(t);
  const serena = await item(fx, "mcp:serena");
  await writeFile(join(fx.homes.grokHome, "config.toml"), (await config(fx)).replace(SERENA_SECRET, "rotated-secret-value"));
  assert.notEqual((await item(fx, "mcp:serena")).revision, serena.revision);
});

test("create with replace over a symlinked skill or command replaces the link, never the shared target", async (t) => {
  const fx = await setup(t);
  // The owner linked Claude's skill and command into Grok's own directories.
  const claudeSkill = join(fx.homes.claudeDir, "skills/claude-skill");
  const claudeSkillText = await readFile(join(claudeSkill, "SKILL.md"), "utf8");
  await write(join(claudeSkill, "reference.md"), "ref\n");
  await symlink(claudeSkill, join(fx.homes.grokHome, "skills/linked-skill"));
  const claudeCommand = join(fx.homes.claudeDir, "commands/shared.md");
  await write(claudeCommand, "---\ndescription: Claude's\n---\nClaude's text\n");
  await symlink(claudeCommand, join(fx.homes.grokHome, "commands/shared.md"));

  await fx.adapter.create({ kind: "skill", document: { name: "linked-skill", frontmatter: { description: "Grok's" }, body: "Grok's\n" } }, { onConflict: "replace" });
  await fx.adapter.create({ kind: "command", document: { name: "shared", frontmatter: {}, body: "Grok's command\n" } }, { onConflict: "replace" });

  assert.equal(await readFile(join(claudeSkill, "SKILL.md"), "utf8"), claudeSkillText, "Claude's skill untouched");
  assert.equal(await readFile(claudeCommand, "utf8"), "---\ndescription: Claude's\n---\nClaude's text\n", "Claude's command untouched");
  const skillDir = join(fx.homes.grokHome, "skills/linked-skill");
  assert.equal((await lstat(skillDir)).isDirectory(), true, "a real directory now");
  assert.deepEqual(await readdir(skillDir), ["SKILL.md"], "no file of the old skill lingers");
  assert.equal(await readFile(join(skillDir, "SKILL.md"), "utf8"), "---\nname: linked-skill\ndescription: Grok's\n---\nGrok's\n");
  assert.equal((await lstat(join(fx.homes.grokHome, "commands/shared.md"))).isFile(), true);
  assert.equal(await readFile(join(fx.homes.grokHome, "commands/shared.md"), "utf8"), "Grok's command\n");
});

test("turning off a hook whose identical copy is already stashed replaces that copy instead of refusing", async (t) => {
  const fx = await setup(t);
  const { itemIds } = await fx.adapter.create({ kind: "hook", hook: { event: "SessionStart", command: "echo hi" } }, { onConflict: "fail" });
  const id = itemIds[0] as string;
  await fx.adapter.setEnabled(id, (await item(fx, id)).revision, false);
  // Put back by hand: the live handler hides its stashed twin.
  const profilePath = join(fx.homes.grokHome, "hooks/profile.json");
  const live = { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] } };
  await writeFile(profilePath, `${JSON.stringify(live, null, 2)}\n`);
  assert.equal((await item(fx, id)).enabled, true);
  await fx.adapter.setEnabled(id, (await item(fx, id)).revision, false);
  assert.deepEqual(JSON.parse(await readFile(profilePath, "utf8")), { hooks: {} });
  assert.equal((await fx.stash.list("grok")).length, 1);
  await fx.adapter.setEnabled(id, (await item(fx, id)).revision, true);
  assert.deepEqual(JSON.parse(await readFile(profilePath, "utf8")), live);
});

test("an inspect still running when a write lands is not cached: the next snapshot sees the write", async (t) => {
  const fx = await setup(t);
  // A runCli whose answers the test releases one by one.
  const pending: { answer: (stdout: string) => void }[] = [];
  const arrived: (() => void)[] = [];
  const nextCall = (): Promise<void> => new Promise((resolve) => arrived.push(resolve));
  const adapter = new GrokProfileAdapter(
    {
      homes: fx.homes,
      appdir: join(fx.root, "appdir"),
      bin: "grok",
      accountHomes: async () => [],
      logger: { info: () => undefined, warn: () => undefined },
      now: () => new Date(fx.clock.now)
    },
    {
      backups: new ProfileBackups({ dir: agentProfileBackupsDir(join(fx.root, "appdir")) }),
      stash: fx.stash,
      runCli: () =>
        new Promise((resolve) => {
          pending.push({ answer: (stdout) => resolve({ code: 0, signal: null, stdout, stderr: "", timedOut: false }) });
          arrived.shift()?.();
        })
    }
  );
  const before = JSON.parse(await readFile(fx.statePath, "utf8")).inspect;
  const after = { ...before, plugins: [...before.plugins, { name: "gdrive", scope: "user", path: join(fx.homes.grokHome, "installed-plugins/gdrive-1"), enabled: true }] };
  const answerNext = async (stdout: string): Promise<void> => {
    if (pending.length === 0) await nextCall();
    const call = pending.shift()!;
    call.answer(stdout);
  };

  // An install loads (one inspect), then runs grok for a while…
  const install = adapter.create({ kind: "plugin", plugin: { plugin: "gdrive", marketplace: "mkt" } }, { onConflict: "fail" });
  await answerNext(JSON.stringify(before));
  if (pending.length === 0) await nextCall();
  // …while a snapshot (its cache expired) starts another inspect that answers from before the install.
  fx.clock.now += 60_000;
  const stale = adapter.snapshot();
  if (pending.length < 2) await nextCall();
  pending.shift()!.answer("Installed 1 plugin(s) from mkt: gdrive\n");
  await install;
  pending.shift()!.answer(JSON.stringify(before));
  await stale;

  // The next snapshot must not reuse that pre-install answer.
  const fresh = adapter.snapshot();
  await answerNext(JSON.stringify(after));
  assert.ok((await fresh).items.some((entry) => entry.id === "plugin:gdrive"));
});
