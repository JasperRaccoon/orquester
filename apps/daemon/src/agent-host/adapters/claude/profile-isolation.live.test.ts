/**
 * Agent Profiles — Claude isolation against the REAL CLI, with no model call (spec 2026-10-18
 * §6.1, §8). OPT-IN: runs only with `ORQUESTER_CLAUDE_LIVE=1` (it spawns the installed `claude`;
 * `ORQUESTER_CLAUDE_BIN` overrides the binary, else `claude` on PATH). Nothing else in the suite
 * runs the real CLI.
 *
 * A fake account config dir under the OS temp dir — user CLAUDE.md and `rules/`, a skill, a
 * SYMLINKED skill, a command, an agent, user hooks, `enabledPlugins`, user and local MCP servers in
 * `.claude.json`, two installed marketplace plugins (one enabled only by the PROJECT's settings) —
 * and a project with its own CLAUDE.md, skill, command and `.mcp.json`. `HOME` is a temp dir too,
 * so the host's real config is never read.
 *
 * The SDK `query()` runs with an input stream that never sends a prompt; the assertions read
 * `getContextUsage()` (the skills the MODEL is shown, memory files, agents),
 * `mcpServerStatus()` and `reloadPlugins({holdOnCacheImpact: true})` (loaded plugins). A Global
 * launch of the same fixture is checked first, so every "absent" below is a real absence.
 */

import assert from "node:assert/strict";
import { accessSync, constants, existsSync, watch } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { after, describe, it } from "node:test";

import { query, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { writePreparedManifest } from "../../../session-profiles/manifest.ts";
import { claudePreparer } from "../../../session-profiles/preparers/claude.ts";
import { makeClaudeProfileFixture } from "../../../session-profiles/preparers/claude.testing.ts";
import type { ResolvedAgentProfile } from "../../../session-profiles/resolve.ts";
import { buildSessionToolsMcpServer } from "../../session-tools/mcp-server.ts";
import { createDeferred } from "./async-queue.ts";
import { buildClaudeQueryOptions } from "./launch.ts";
import { claudeProfileLaunchFiles, loadClaudeProfileLaunch, writeClaudeProfileLaunchFiles } from "./profile-launch.ts";
import type { ClaudeSessionToolsLaunch } from "./session-tools.ts";

function claudeBin(): string | null {
  if (process.env.ORQUESTER_CLAUDE_BIN) return process.env.ORQUESTER_CLAUDE_BIN;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    try {
      accessSync(join(dir, "claude"), constants.X_OK);
      return join(dir, "claude");
    } catch {
      // next
    }
  }
  return null;
}

const LIVE = process.env.ORQUESTER_CLAUDE_LIVE === "1";
const BIN = LIVE ? claudeBin() : null;
const skip = !LIVE ? "set ORQUESTER_CLAUDE_LIVE=1 to run against the real claude CLI" : BIN === null ? "no claude binary" : false;

/**
 * Outside the daemon user's home on purpose: Claude reads `.claude/skills` of every ancestor of the
 * cwd below `$HOME`, and this fixture's `HOME` is fake — under the real home, the real
 * `~/.claude/skills` would read as project skills. `ORQUESTER_CLAUDE_LIVE_TMP` overrides.
 */
const TMP = process.env.ORQUESTER_CLAUDE_LIVE_TMP ?? "/tmp";

const roots: string[] = [];
after(async () => {
  // `close()` does not wait for the CLI to exit, and it may still be writing its state files.
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true, maxRetries: 10 })));
});

async function write(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

const md = (name: string): string => `---\nname: ${name}\ndescription: ${name} description\n---\nbody\n`;

/** The fake account, home and project (see the module header). */
async function fakeWorld(root: string) {
  const home = join(root, "home");
  const configDir = join(root, "account", "home");
  const project = join(root, "work", "proj");
  await write(join(configDir, "CLAUDE.md"), "USER MEMORY\n");
  await write(join(configDir, "rules", "user-rule.md"), "USER RULE\n");
  await write(join(configDir, "skills", "user-skill", "SKILL.md"), md("user-skill"));
  await write(join(root, "shared-skills", "linked-skill", "SKILL.md"), md("linked-skill"));
  await symlink(join(root, "shared-skills", "linked-skill"), join(configDir, "skills", "linked-skill"));
  await write(join(configDir, "commands", "user-cmd.md"), "---\ndescription: user cmd\n---\nx\n");
  await write(join(configDir, "agents", "user-agent.md"), "---\nname: user-agent\ndescription: a user agent\n---\nYou are.\n");
  await write(join(configDir, "settings.json"), {
    enabledPlugins: { "gplug@fakemkt": true },
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: `touch '${join(root, "markers", "user-hook")}'` }] }] },
    permissions: { allow: ["Bash(ls:*)"] }
  });
  const marketplace = join(configDir, "plugins", "marketplaces", "fakemkt");
  await write(join(marketplace, ".claude-plugin", "marketplace.json"), {
    name: "fakemkt",
    owner: { name: "test" },
    plugins: [
      { name: "gplug", source: "./gplug" },
      { name: "gplug2", source: "./gplug2" }
    ]
  });
  const installed: Record<string, unknown[]> = {};
  for (const name of ["gplug", "gplug2"]) {
    for (const dir of [join(marketplace, name), join(configDir, "plugins", "cache", "fakemkt", name, "1.0.0")]) {
      await write(join(dir, ".claude-plugin", "plugin.json"), { name, version: "1.0.0" });
      await write(join(dir, "skills", `${name}-skill`, "SKILL.md"), md(`${name}-skill`));
      await write(join(dir, "commands", `${name}-cmd.md`), "x");
    }
    installed[`${name}@fakemkt`] = [
      {
        scope: "user",
        installPath: join(configDir, "plugins", "cache", "fakemkt", name, "1.0.0"),
        version: "1.0.0",
        installedAt: "2026-10-01T00:00:00.000Z",
        lastUpdated: "2026-10-01T00:00:00.000Z"
      }
    ];
  }
  await write(join(configDir, "plugins", "installed_plugins.json"), { version: 2, plugins: installed });
  await write(join(configDir, "plugins", "known_marketplaces.json"), {
    fakemkt: { source: { source: "directory", path: marketplace }, installLocation: marketplace, lastUpdated: "2026-10-01T00:00:00.000Z" }
  });
  const idle = { command: process.execPath, args: ["-e", "process.exit(1)"] };
  await write(join(configDir, ".claude.json"), {
    hasCompletedOnboarding: true,
    mcpServers: { usermcp: idle },
    projects: { [project]: { mcpServers: { localmcp: idle }, hasTrustDialogAccepted: true } }
  });

  await write(join(project, "CLAUDE.md"), "PROJECT MEMORY\n");
  await write(join(project, ".claude", "settings.json"), { enabledPlugins: { "gplug2@fakemkt": true } });
  await write(join(project, ".claude", "skills", "proj-skill", "SKILL.md"), md("proj-skill"));
  await write(join(project, ".claude", "commands", "proj-cmd.md"), "x");
  await write(join(project, ".mcp.json"), { mcpServers: { projmcp: idle } });
  await mkdir(home, { recursive: true });
  await mkdir(join(root, "markers"), { recursive: true });

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
  };
  return { home, configDir, project, env, markers: join(root, "markers") };
}

/** Resolves once `dir/name` exists (an `fs.watch` event, no polling). */
function fileAppears(dir: string, name: string): Promise<void> {
  return new Promise((resolve) => {
    const watcher = watch(dir, () => {
      if (existsSync(join(dir, name))) {
        watcher.close();
        resolve();
      }
    });
    if (existsSync(join(dir, name))) {
      watcher.close();
      resolve();
    }
  });
}

interface Observed {
  skills: string[];
  memory: string[];
  agents: string[];
  mcp: string[];
  plugins: string[];
}

/**
 * Starts the CLI with `options`, never sends a prompt, and reads what it loaded once Orquester's
 * in-process server has been listed (it connects after the handshake).
 */
async function observe(options: Options, tools: { listed: Promise<void> }): Promise<Observed> {
  const never: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<SDKUserMessage>>(() => {}) })
  };
  const run = query({ prompt: never, options: { ...options, persistSession: false } });
  try {
    await run.initializationResult();
    await tools.listed;
    const usage = await run.getContextUsage();
    const mcp = await run.mcpServerStatus();
    const plugins = await run.reloadPlugins({ holdOnCacheImpact: true });
    return {
      skills: (usage.skills?.skillFrontmatter ?? []).map((skill) => skill.name).sort(),
      memory: usage.memoryFiles.map((file) => file.path).sort(),
      agents: usage.agents.map((agent) => agent.agentType).sort(),
      mcp: mcp.map((server) => server.name).sort(),
      plugins: plugins.plugins.map((plugin) => plugin.source ?? plugin.name).filter((id) => !id.endsWith("@builtin")).sort()
    };
  } finally {
    run.close();
  }
}

const noop = async () => ({ behavior: "allow" as const, updatedInput: {} });

/** Orquester's in-process server as the adapter builds it, with one tool; `listed` = the CLI listed it. */
function sessionTools(): ClaudeSessionToolsLaunch & { listed: Promise<void> } {
  const listed = createDeferred<void>();
  const instance = buildSessionToolsMcpServer(
    {
      list: () => {
        listed.resolve();
        return [{ name: "ping", description: "ping", inputSchema: { type: "object" as const } }];
      },
      accepts: () => false
    },
    async () => ({ content: [] })
  );
  return {
    server: { type: "sdk", name: "orquester", instance },
    instructions: "ORQUESTER",
    allowedTools: ["mcp__orquester__ping"],
    deny: [],
    names: () => new Set(["ping"]),
    release: () => {},
    listed: listed.promise
  };
}

async function profileOptions(
  root: string,
  world: Awaited<ReturnType<typeof fakeWorld>>,
  settings: Partial<ResolvedAgentProfile["settings"]> = {}
): Promise<{ options: Options; tools: { listed: Promise<void> } }> {
  const tag = JSON.stringify(settings).replace(/[^a-zA-Z]+/g, "-");
  const fixture = await makeClaudeProfileFixture(join(root, "profile-src"), settings);
  fixture.resolved.hooks.push({ id: "h9", name: "start", event: "SessionStart", command: `touch '${join(world.markers, "profile-hook")}'` });
  // No network from the fixture's servers: a refused local port and a command that exits.
  fixture.resolved.mcpServers = fixture.resolved.mcpServers.map((server) =>
    server.transport === "http" ? { ...server, url: "http://127.0.0.1:9/mcp" } : { ...server, command: process.execPath, args: ["-e", "process.exit(1)"] }
  );
  const preparedDir = join(root, "prepared", `v${tag}`);
  await mkdir(preparedDir, { recursive: true, mode: 0o700 });
  const agentSection = await claudePreparer.prepare(fixture.context({ stagingDir: preparedDir, preparedDir }));
  await writePreparedManifest(preparedDir, {
    schema: 1,
    profileId: "p1",
    revision: "3",
    agent: "claude",
    accountKey: "shared",
    preparedAt: new Date().toISOString(),
    agentSection
  });
  const launch = await loadClaudeProfileLaunch(
    { profile: { profileId: "p1", revision: "3", preparedDir }, cwd: world.project },
    { configDir: world.configDir, claudeJson: join(world.configDir, ".claude.json"), home: world.home }
  );
  assert.ok(launch !== null);
  const files = claudeProfileLaunchFiles(join(root, "appdir-tmp"), `thread${tag}`);
  const tools = sessionTools();
  const built = buildClaudeQueryOptions({
    cwd: world.project,
    executablePath: BIN!,
    env: world.env,
    runtimeMode: "approval-required",
    models: [],
    attachmentsDir: join(root, "attachments"),
    canUseTool: noop,
    sessionTools: tools,
    profile: { launch, files }
  });
  assert.ok(built.profileFiles !== undefined);
  await writeClaudeProfileLaunchFiles(files, built.profileFiles);
  return { options: built.options, tools };
}

describe("Claude profile isolation against the real CLI (no model call)", { skip, timeout: 240_000 }, () => {
  it("a Global launch of the fixture sees the user's items (baseline)", async () => {
    const root = await mkdtemp(join(TMP, "orq-claude-live-"));
    roots.push(root);
    const world = await fakeWorld(root);
    const tools = sessionTools();
    const { options } = buildClaudeQueryOptions({
      cwd: world.project,
      executablePath: BIN!,
      env: world.env,
      runtimeMode: "approval-required",
      models: [],
      attachmentsDir: join(root, "attachments"),
      canUseTool: noop,
      sessionTools: tools
    });
    const userHook = fileAppears(world.markers, "user-hook");
    const seen = await observe(options, tools);
    await userHook;
    for (const name of ["user-skill", "linked-skill", "user-cmd", "gplug:gplug-skill", "gplug2:gplug2-skill", "proj-skill", "proj-cmd"]) {
      assert.ok(seen.skills.includes(name), `Global lists ${name}: ${seen.skills.join(", ")}`);
    }
    assert.ok(seen.memory.some((path) => path.endsWith(join("account", "home", "CLAUDE.md"))), seen.memory.join(", "));
    assert.ok(seen.agents.includes("user-agent"), seen.agents.join(", "));
    for (const name of ["usermcp", "localmcp", "projmcp", "orquester"]) {
      assert.ok(seen.mcp.includes(name), `Global has ${name}: ${seen.mcp.join(", ")}`);
    }
    assert.deepEqual(seen.plugins, ["gplug2@fakemkt", "gplug@fakemkt"]);
  });

  it("a profile launch sees only the profile's items, the project's own and Orquester's", async () => {
    const root = await mkdtemp(join(TMP, "orq-claude-live-"));
    roots.push(root);
    const world = await fakeWorld(root);
    const launched = await profileOptions(root, world);
    const profileHook = fileAppears(world.markers, "profile-hook");
    const seen = await observe(launched.options, launched.tools);
    // SessionStart hooks run at startup, side by side: the profile's ran, the user's did not.
    await profileHook;
    assert.equal(existsSync(join(world.markers, "user-hook")), false, "the user's SessionStart hook stays out");
    assert.deepEqual(seen.skills, [
      "dev-kit:git:pr",
      "dev-kit:review",
      "proj-cmd",
      "proj-skill",
      "toolbox:fmt",
      "toolbox:lint",
      "workflow-authoring"
    ]);
    assert.deepEqual(seen.memory, [join(world.project, "CLAUDE.md")], "no user CLAUDE.md or rules");
    assert.equal(seen.agents.includes("user-agent"), false, seen.agents.join(", "));
    assert.deepEqual(seen.mcp, ["docs", "orquester", "plugin:toolbox:db", "projmcp", "search"]);
    assert.deepEqual(seen.plugins, ["dev-kit@inline", "toolbox@inline"], "no installed plugin, not even the project-enabled one");
  });

  it("the Workflow tool off drops workflow-authoring; built-ins shown lifts the allow-list", async () => {
    const root = await mkdtemp(join(TMP, "orq-claude-live-"));
    roots.push(root);
    const world = await fakeWorld(root);
    const offLaunch = await profileOptions(root, world, { claudeWorkflowTool: false });
    const off = await observe(offLaunch.options, offLaunch.tools);
    assert.equal(off.skills.includes("workflow-authoring"), false, off.skills.join(", "));
    const shownLaunch = await profileOptions(root, world, { hideBuiltinSkills: false });
    const shown = await observe(shownLaunch.options, shownLaunch.tools);
    assert.ok(shown.skills.includes("workflow-authoring"));
    assert.ok(shown.skills.length > off.skills.length, "built-in skills listed");
    for (const name of ["user-skill", "linked-skill", "user-cmd", "gplug:gplug-skill", "gplug2:gplug2-skill"]) {
      assert.equal(shown.skills.includes(name), false, `${name} stays out with built-ins shown`);
    }
  });
});
