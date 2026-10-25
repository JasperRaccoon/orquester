/**
 * `claudeSettingsEnvs` and the two values read from it: which settings files the CLI applies, in
 * which order — the local file at the repository's main checkout (a worktree's included), a
 * leftover one in the cwd under it, the user's at the flag tier in a profile chat — and, for a box
 * chat (Ephemeral AI VMs §8.5), the project's files read through the box's filesystem while the
 * user file stays the host account home's.
 */

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ClaudeNamesFs } from "../../../agent-isolation/claude-names.ts";
import { claudeSettingsEnvs, claudeSettingsNodeOptions, claudeToolSearchSetting } from "./settings-env.ts";

/** A read-only filesystem holding independent file bytes and directory entries. */
function mapFs(files: Record<string, string>, directories: readonly string[] = []): ClaudeNamesFs {
  return {
    stat: async (path: string) => directories.includes(path)
      ? ({ kind: "dir", size: 0 } as never)
      : path in files ? ({ kind: "file", size: files[path]!.length } as never) : null,
    readdir: async () => [],
    read: async (path: string) => {
      const text = files[path];
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return Buffer.from(text, "utf8");
    }
  };
}

async function tempRoot(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orq-claude-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeSettings(dir: string, file: "settings.json" | "settings.local.json", env: Record<string, unknown>): Promise<void> {
  await mkdir(join(dir, ".claude"), { recursive: true });
  await writeFile(join(dir, ".claude", file), JSON.stringify({ env }));
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "init.defaultBranch=main", ...args], { cwd, stdio: "ignore" });
}

test("a box chat reads the project's settings in the box and the user's on the host", async (t) => {
  const home = await tempRoot(t);
  await writeFile(join(home, "settings.json"), JSON.stringify({ env: { NODE_OPTIONS: "--user", ENABLE_TOOL_SEARCH: "false" } }));
  const project = "/var/lib/orquester/workspaces/ws/boxproj";
  const box = mapFs({
    [join(project, ".claude", "settings.json")]: JSON.stringify({ env: { NODE_OPTIONS: "--from-box-project" } })
  });

  const envs = await claudeSettingsEnvs({ env: { CLAUDE_CONFIG_DIR: home }, cwd: project, sources: "global", projectFs: box });

  // user < project < local: the box's project file wins over the host user file.
  assert.equal(claudeSettingsNodeOptions(envs), "--from-box-project");
  assert.equal(claudeToolSearchSetting(envs, {}), "false", "the host account's user-only value still loads");
});

test("ENABLE_TOOL_SEARCH: local over project over user over the process env", async (t) => {
  const root = await tempRoot(t);
  const home = join(root, "home");
  const project = join(root, "proj");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  const env = { CLAUDE_CONFIG_DIR: home };
  const setting = async (processEnv: Record<string, string> = {}) => {
    const envs = await claudeSettingsEnvs({ env, cwd: project, sources: "global" });
    return { nodeOptions: claudeSettingsNodeOptions(envs), toolSearch: claudeToolSearchSetting(envs, processEnv) };
  };

  assert.deepEqual(await setting(), { nodeOptions: undefined, toolSearch: undefined });
  assert.deepEqual(await setting({ ENABLE_TOOL_SEARCH: "auto" }), { nodeOptions: undefined, toolSearch: "auto" });

  await writeFile(join(home, "settings.json"), JSON.stringify({ env: { NODE_OPTIONS: "--user", ENABLE_TOOL_SEARCH: "auto" } }));
  assert.deepEqual(await setting({ ENABLE_TOOL_SEARCH: "false" }), { nodeOptions: "--user", toolSearch: "auto" });

  await writeSettings(project, "settings.json", { NODE_OPTIONS: "--project", ENABLE_TOOL_SEARCH: "false" });
  assert.deepEqual(await setting(), { nodeOptions: "--project", toolSearch: "false" });

  await writeSettings(project, "settings.local.json", { NODE_OPTIONS: "--local", ENABLE_TOOL_SEARCH: "auto:30" });
  assert.deepEqual(await setting(), { nodeOptions: "--local", toolSearch: "auto:30" });

  // An unknown value must not trigger the adapter's auto-mode override.
  await writeSettings(project, "settings.local.json", { NODE_OPTIONS: "--local", ENABLE_TOOL_SEARCH: false });
  assert.deepEqual(await setting({ ENABLE_TOOL_SEARCH: "auto" }), { nodeOptions: "--local", toolSearch: undefined });
});

test("ENABLE_TOOL_SEARCH in a profile chat: the carried user value wins; an isolated one reads the user's only", async (t) => {
  const root = await tempRoot(t);
  const home = join(root, "home");
  const project = join(root, "proj");
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "settings.json"), JSON.stringify({ env: { NODE_OPTIONS: "--user", ENABLE_TOOL_SEARCH: "auto" } }));
  await writeSettings(project, "settings.local.json", { NODE_OPTIONS: "--local", ENABLE_TOOL_SEARCH: "false" });
  const env = { CLAUDE_CONFIG_DIR: home };
  for (const sources of ["profile", "isolated"] as const) {
    const loaded = await claudeSettingsEnvs({ env, cwd: project, sources });
    assert.equal(claudeToolSearchSetting(loaded, {}), "auto", sources);
    assert.equal(claudeSettingsNodeOptions(loaded), "--user", sources);
  }

  await writeFile(join(home, "settings.json"), JSON.stringify({ env: {} }));
  await writeSettings(project, "settings.json", { NODE_OPTIONS: "--project" });
  const isolated = await claudeSettingsEnvs({ env, cwd: project, sources: "isolated" });
  assert.equal(claudeToolSearchSetting(isolated, {}), undefined, "no project or local file loads");
  assert.equal(claudeSettingsNodeOptions(isolated), undefined);
});

test("the local file is read at the repository root, over one left in a subdirectory cwd", async (t) => {
  const root = await tempRoot(t);
  const home = join(root, "home");
  const repo = join(root, "repo");
  const sub = join(repo, "packages", "app");
  await mkdir(home, { recursive: true });
  await mkdir(sub, { recursive: true });
  git(repo, "init", "-q");
  const env = { CLAUDE_CONFIG_DIR: home };
  const setting = async () => claudeToolSearchSetting(await claudeSettingsEnvs({ env, cwd: sub, sources: "global", home }), {});

  // The project file is the cwd's, not the root's.
  await writeSettings(repo, "settings.json", { ENABLE_TOOL_SEARCH: "auto" });
  assert.equal(await setting(), undefined);

  // A leftover local file in the cwd still applies...
  await writeSettings(sub, "settings.local.json", { ENABLE_TOOL_SEARCH: "auto" });
  assert.equal(await setting(), "auto");
  // ...under the root's.
  await writeSettings(repo, "settings.local.json", { ENABLE_TOOL_SEARCH: "false" });
  assert.equal(await setting(), "false");
});

test("a worktree's local file is its main checkout's", async (t) => {
  const root = await tempRoot(t);
  const home = join(root, "home");
  const main = join(root, "main");
  const worktree = join(root, "wt");
  await mkdir(home, { recursive: true });
  await mkdir(main, { recursive: true });
  git(main, "init", "-q");
  git(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  git(main, "worktree", "add", "-q", worktree);
  const env = { CLAUDE_CONFIG_DIR: home };
  const setting = async (cwd: string) => claudeToolSearchSetting(await claudeSettingsEnvs({ env, cwd, sources: "global", home }), {});

  await writeSettings(main, "settings.local.json", { ENABLE_TOOL_SEARCH: "auto" });
  assert.equal(await setting(worktree), "auto");
  await mkdir(join(worktree, "src"), { recursive: true });
  assert.equal(await setting(join(worktree, "src")), "auto", "from a subdirectory of the worktree too");

  // A .git file that does not point back at the worktree keeps the worktree itself.
  const forged = join(root, "forged");
  await mkdir(forged, { recursive: true });
  await writeFile(join(forged, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}\n`);
  assert.equal(await setting(forged), undefined);
});

test("a repository rooted at the home keeps its local file in the cwd", async (t) => {
  const home = await tempRoot(t);
  const cwd = join(home, "proj");
  await mkdir(cwd, { recursive: true });
  git(home, "init", "-q");
  await writeSettings(home, "settings.local.json", { ENABLE_TOOL_SEARCH: "auto" });
  const env = { CLAUDE_CONFIG_DIR: join(home, ".claude") };

  assert.equal(claudeToolSearchSetting(await claudeSettingsEnvs({ env, cwd, sources: "global", home }), {}), undefined);
  // Elsewhere the same root is used.
  assert.equal(claudeToolSearchSetting(await claudeSettingsEnvs({ env, cwd, sources: "global", home: "/nonexistent-home" }), {}), "auto");
});

test("a box chat reads the root local file on POSIX and the cwd local file on Windows", async () => {
  const repo = "/var/lib/orquester/workspaces/ws/boxproj";
  const cwd = join(repo, "app");
  const box = mapFs({
    [join(repo, ".claude", "settings.local.json")]: JSON.stringify({ env: { ENABLE_TOOL_SEARCH: "auto" } }),
    [join(cwd, ".claude", "settings.local.json")]: JSON.stringify({ env: { ENABLE_TOOL_SEARCH: "false" } })
  }, [join(repo, ".git")]);
  for (const [platform, expected] of [["linux", "auto"], ["win32", "false"]] as const) {
    const envs = await claudeSettingsEnvs({
      env: { CLAUDE_CONFIG_DIR: "/nonexistent-config" }, cwd, sources: "global", projectFs: box, platform
    });
    assert.equal(claudeToolSearchSetting(envs, {}), expected, platform);
  }
});
