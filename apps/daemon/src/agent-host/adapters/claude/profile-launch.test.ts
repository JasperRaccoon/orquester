/**
 * Agent Profiles — what a Claude profile thread launches with (`profile-launch.ts`): the prepared
 * section read through the manifest, the account's carried runtime settings, the project's own
 * skills and `.mcp.json`, the plugin switch-offs, and the 0600 launch files.
 */

import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { BoxProjectFs } from "../../../boxes/remote/fs/project-fs.ts";
import { localBoxConnection } from "../../../boxes/testing.ts";
import { writePreparedManifest } from "../../../session-profiles/manifest.ts";
import { rootedReadsBoxConnection } from "../../boxes/testing.ts";
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
    assert.equal(launch.disableBuiltinTools, undefined, "built-in tools stay on unless the section turns them off");
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

  it("boxes: reads a box project's files in its box — the host directory is an empty stub", async () => {
    const { root, cwd, where, profile } = await setup();
    // The project lives in the box: its files move under the box's root, the host keeps a stub.
    const boxRoot = join(root, "box");
    await mkdir(join(boxRoot, cwd, ".."), { recursive: true });
    await rename(cwd, join(boxRoot, cwd));
    await mkdir(cwd, { recursive: true });

    const fromStub = await loadClaudeProfileLaunch({ profile, cwd }, where);
    assert.ok(fromStub !== null);
    assert.equal("projmcp" in fromStub.mcpServers, false, "the stub has no .mcp.json");
    assert.equal(fromStub.skills?.includes("proj-skill"), false);

    const projectFs = new BoxProjectFs(rootedReadsBoxConnection(localBoxConnection(), boxRoot));
    const launch = await loadClaudeProfileLaunch({ profile, cwd }, { ...where, projectFs });
    assert.ok(launch !== null);
    // Exactly what the same files give on this machine (the test above).
    assert.deepEqual(launch.skills, ["dev-kit:review", "dev-kit:git:pr", "toolbox:fmt", "toolbox:lint", "workflow-authoring", "proj-cmd", "proj-skill"]);
    assert.deepEqual(launch.disabledPluginIds, ["gplug@mkt", "other@mkt", "projplug@mkt"]);
    assert.deepEqual(Object.keys(launch.mcpServers), ["projmcp", "search", "docs", "plugin:toolbox:db"]);
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

  it("a profile without built-in tools lifts no project or ancestor .mcp.json server, only its own", async () => {
    const { root, preparedDir, cwd, where, profile } = await setup();
    // An ancestor's `.mcp.json` (the daemon user's `~/.mcp.json` above a `~/.orquester` appdir).
    await write(join(root, ".mcp.json"), { mcpServers: { ancestor: { command: "a" } } });
    const plain = await loadClaudeProfileLaunch({ profile, cwd }, where);
    assert.ok(plain !== null);
    assert.equal("ancestor" in plain.mcpServers, true, "a user profile keeps the project walk");
    const manifest = JSON.parse(await readFile(join(preparedDir, "manifest.json"), "utf8"));
    manifest.agentSection.disableBuiltinTools = true;
    await writeFile(join(preparedDir, "manifest.json"), JSON.stringify(manifest));
    const launch = await loadClaudeProfileLaunch({ profile, cwd }, where);
    assert.ok(launch !== null);
    assert.equal(launch.disableBuiltinTools, true);
    assert.deepEqual(Object.keys(launch.mcpServers).sort(), ["docs", "plugin:toolbox:db", "search"]);
    assert.equal((launch.mcpServers.search as { env: Record<string, string> }).env.API_KEY, FIXTURE_SECRETS.env, "the profile's own server");
  });

  it("refuses a section path that leaves the prepared dir", async () => {
    const { root, preparedDir, cwd, where, profile } = await setup();
    await writeFile(join(root, "escape.md"), "outside instructions");
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

  it("create their 0700 parent and refuse one that is not a private, real directory of this user", async () => {
    const root = await mkdtemp(join(tmpdir(), "orq-claude-profile-files-"));
    roots.push(root);
    // A fresh tmp dir: the shared `claude-profile-launch` parent is created 0700.
    const files = claudeProfileLaunchFiles(root, "thread-1");
    await writeClaudeProfileLaunchFiles(files, { settings: { a: 1 } });
    assert.equal((await lstat(join(root, "claude-profile-launch"))).mode & 0o777, 0o700);

    // A parent someone else could read or plant in (a shared TMPDIR): refused, nothing written.
    const loose = await mkdtemp(join(tmpdir(), "orq-claude-profile-files-"));
    roots.push(loose);
    await mkdir(join(loose, "claude-profile-launch"), { mode: 0o755 });
    await chmod(join(loose, "claude-profile-launch"), 0o755);
    const looseFiles = claudeProfileLaunchFiles(loose, "thread-1");
    await assert.rejects(writeClaudeProfileLaunchFiles(looseFiles, { settings: { secret: 1 } }), ProfileLaunchError);
    await assert.rejects(lstat(looseFiles.dir), "no per-thread dir in a loose parent");

    // A parent that is a symlink (to a dir the attacker reads): refused, the target stays empty.
    const linked = await mkdtemp(join(tmpdir(), "orq-claude-profile-files-"));
    roots.push(linked);
    const target = join(linked, "elsewhere");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, join(linked, "claude-profile-launch"));
    await assert.rejects(writeClaudeProfileLaunchFiles(claudeProfileLaunchFiles(linked, "thread-1"), { settings: { secret: 1 } }), ProfileLaunchError);
    assert.deepEqual(await readdir(target), []);

    // A per-thread dir planted as a symlink inside a private parent: refused too.
    const planted = await mkdtemp(join(tmpdir(), "orq-claude-profile-files-"));
    roots.push(planted);
    await mkdir(join(planted, "claude-profile-launch"), { mode: 0o700 });
    const plantedTarget = join(planted, "target");
    await mkdir(plantedTarget, { mode: 0o700 });
    await symlink(plantedTarget, join(planted, "claude-profile-launch", "thread-1"));
    await assert.rejects(writeClaudeProfileLaunchFiles(claudeProfileLaunchFiles(planted, "thread-1"), { settings: { secret: 1 } }), ProfileLaunchError);
    assert.deepEqual(await readdir(plantedTarget), []);
  });
});
