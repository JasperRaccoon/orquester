/**
 * Agent Profiles — what a Claude profile thread launches with (`profile-launch.ts`): the prepared
 * section read through the manifest, the account's carried runtime settings, the project's own
 * skills and `.mcp.json`, the plugin switch-offs, and the 0600 launch files.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { writePreparedManifest } from "../../../session-profiles/manifest.ts";
import { claudePreparer } from "../../../session-profiles/preparers/claude.ts";
import { FIXTURE_SECRETS, makeClaudeProfileFixture } from "../../../session-profiles/preparers/claude.testing.ts";
import { ProfileLaunchError } from "../profile-manifest.ts";
import {
  claudeProfileLaunchFiles,
  loadClaudeProfileLaunch,
  removeClaudeProfileLaunchFiles,
  writeClaudeProfileLaunchFiles
} from "./profile-launch.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function write(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "orq-claude-profile-launch-"));
  roots.push(root);
  const fixture = await makeClaudeProfileFixture(root);
  const preparedDir = join(root, "prepared", "v-1");
  await mkdir(preparedDir, { recursive: true, mode: 0o700 });
  const section = await claudePreparer.prepare(fixture.context({ stagingDir: preparedDir, preparedDir }));
  await writePreparedManifest(preparedDir, {
    schema: 1,
    profileId: "p1",
    revision: "3",
    agent: "claude",
    accountKey: "shared",
    preparedAt: "2026-10-18T00:00:00.000Z",
    agentSection: section
  });

  const configDir = join(root, "acc", "home");
  await write(join(configDir, "settings.json"), {
    model: "opus",
    env: { TOKEN: "x" },
    hooks: { Stop: [{ hooks: [{ type: "command", command: "user hook" }] }] },
    enabledPlugins: { "gplug@mkt": true },
    deniedMcpServers: [{ serverName: "user-off" }, { serverUrl: "https://evil/*" }],
    disabledMcpjsonServers: ["off0"]
  });
  await write(join(configDir, "plugins", "installed_plugins.json"), { version: 2, plugins: { "gplug@mkt": [], "other@mkt": [] } });
  const home = join(root, "home");
  const cwd = join(home, "work", "proj");
  await write(join(configDir, ".claude.json"), { mcpServers: { usermcp: { command: "u" } }, projects: { [cwd]: { disabledMcpjsonServers: ["off2"] } } });
  await write(join(cwd, ".mcp.json"), {
    mcpServers: {
      projmcp: { command: "p" },
      off0: { command: "o" },
      off1: { command: "o" },
      off2: { command: "o" },
      search: { command: "project-version" }
    }
  });
  await write(join(cwd, ".claude", "settings.json"), { enabledPlugins: { "projplug@mkt": true }, disabledMcpjsonServers: ["off1"] });
  await write(join(cwd, ".claude", "skills", "proj-skill", "SKILL.md"), "---\nname: proj-skill\n---\nx\n");
  await write(join(cwd, ".claude", "commands", "proj-cmd.md"), "x");
  await write(join(home, ".claude", "skills", "home-skill", "SKILL.md"), "---\nname: home-skill\n---\nx\n");

  const where = { configDir, claudeJson: join(configDir, ".claude.json"), home };
  const profile = { profileId: "p1", revision: "3", preparedDir };
  return { root, preparedDir, configDir, cwd, where, profile };
}

describe("loadClaudeProfileLaunch", () => {
  it("is null for a Global thread, without reading anything", async () => {
    assert.equal(await loadClaudeProfileLaunch({ cwd: "/nowhere" }, { configDir: "/x", claudeJson: "/x/.claude.json", home: "/x" }), null);
  });

  it("assembles the launch from the prepared dir, the account and the project", async () => {
    const { preparedDir, cwd, where, profile } = await setup();
    const launch = await loadClaudeProfileLaunch({ profile, cwd }, where);
    assert.ok(launch !== null);
    assert.deepEqual(launch.plugins, [
      { type: "local", path: join(preparedDir, "plugin") },
      { type: "local", path: join(preparedDir, "plugins", "pl1"), skipMcpDiscovery: true }
    ]);
    // The prepared allow-list plus the project's own commands and skills (not the home's).
    assert.deepEqual(launch.skills, ["dev-kit:review", "dev-kit:git:pr", "toolbox:fmt", "toolbox:lint", "workflow-authoring", "proj-cmd", "proj-skill"]);
    assert.equal(launch.instructions, "Be brief.");
    assert.deepEqual(launch.hooks.Stop, [{ hooks: [{ type: "command", command: "echo stop" }] }]);
    assert.equal(launch.disableWorkflows, false);
    // Runtime settings carried; item keys (hooks, enabledPlugins) and serverName denials dropped.
    assert.deepEqual(launch.carriedSettings, {
      model: "opus",
      env: { TOKEN: "x" },
      deniedMcpServers: [{ serverUrl: "https://evil/*" }],
      disabledMcpjsonServers: ["off0"]
    });
    assert.deepEqual(launch.disabledPluginIds, ["gplug@mkt", "other@mkt", "projplug@mkt"]);
    // The project's servers minus every disabled list, then the profile's (which win a name).
    assert.deepEqual(Object.keys(launch.mcpServers), ["projmcp", "search", "docs", "plugin:toolbox:db"]);
    assert.equal((launch.mcpServers.search as { env: Record<string, string> }).env.API_KEY, FIXTURE_SECRETS.env);
    assert.equal("usermcp" in launch.mcpServers, false, "user-scope servers stay out");
  });

  it("tolerates a missing or invalid user settings.json", async () => {
    const { configDir, cwd, where, profile } = await setup();
    await writeFile(join(configDir, "settings.json"), "{ not json");
    assert.deepEqual((await loadClaudeProfileLaunch({ profile, cwd }, where))?.carriedSettings, {});
    await rm(join(configDir, "settings.json"));
    assert.deepEqual((await loadClaudeProfileLaunch({ profile, cwd }, where))?.carriedSettings, {});
  });

  it("fails the start for a missing manifest, another revision, or a missing prepared file", async () => {
    const { preparedDir, cwd, where, profile } = await setup();
    await assert.rejects(
      loadClaudeProfileLaunch({ profile: { ...profile, revision: "4" }, cwd }, where),
      (error: unknown) => error instanceof ProfileLaunchError && /another version/.test(error.message)
    );
    await assert.rejects(
      loadClaudeProfileLaunch({ profile: { ...profile, preparedDir: join(preparedDir, "nope") }, cwd }, where),
      (error: unknown) => error instanceof ProfileLaunchError && /manifest is missing/.test(error.message)
    );
    await rm(join(preparedDir, "mcp-servers.json"));
    await assert.rejects(
      loadClaudeProfileLaunch({ profile, cwd }, where),
      (error: unknown) => error instanceof ProfileLaunchError && /MCP server file is missing/.test(error.message)
    );
  });

  it("refuses a section path that leaves the prepared dir", async () => {
    const { preparedDir, cwd, where, profile } = await setup();
    const manifest = JSON.parse(await readFile(join(preparedDir, "manifest.json"), "utf8"));
    manifest.agentSection.instructionsFile = "../../escape.md";
    await writeFile(join(preparedDir, "manifest.json"), JSON.stringify(manifest));
    await assert.rejects(loadClaudeProfileLaunch({ profile, cwd }, where), ProfileLaunchError);
  });
});

describe("Claude profile launch files", () => {
  it("are 0600 in a 0700 per-thread dir, replaced on rewrite and removed whole", async () => {
    const root = await mkdtemp(join(tmpdir(), "orq-claude-profile-files-"));
    roots.push(root);
    const files = claudeProfileLaunchFiles(root, "thread-1");
    await writeClaudeProfileLaunchFiles(files, { settings: { a: 1 }, mcpConfig: { mcpServers: { s: { env: { K: "v" } } } } });
    assert.equal((await stat(files.dir)).mode & 0o777, 0o700);
    assert.equal((await stat(files.settings)).mode & 0o777, 0o600);
    assert.equal((await stat(files.mcpConfig)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(files.settings, "utf8")), { a: 1 });

    await writeClaudeProfileLaunchFiles(files, { settings: { b: 2 } });
    assert.deepEqual(JSON.parse(await readFile(files.settings, "utf8")), { b: 2 });
    await assert.rejects(stat(files.mcpConfig), "a launch without servers leaves no stale MCP file");

    await removeClaudeProfileLaunchFiles(files);
    await assert.rejects(stat(files.dir));
    await removeClaudeProfileLaunchFiles(files);
  });
});
