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

/** A read-only filesystem over a map of path → text, recording every file read. */
function mapFs(files: Record<string, string>): ClaudeNamesFs & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    stat: async (path: string) => (path in files ? ({ kind: "file", size: files[path]!.length } as never) : null),
    readdir: async () => [],
    read: async (path: string) => {
      reads.push(path);
      const text = files[path];
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return Buffer.from(text, "utf8");
    }
  } as ClaudeNamesFs & { reads: string[] };
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
  await writeFile(join(home, "settings.json"), JSON.stringify({ env: { NODE_OPTIONS: "--user" } }));
  const project = "/var/lib/orquester/workspaces/ws/boxproj";
  const box = mapFs({
    [join(project, ".claude", "settings.json")]: JSON.stringify({ env: { NODE_OPTIONS: "--from-box-project" } })
  });

  const envs = await claudeSettingsEnvs({ env: { CLAUDE_CONFIG_DIR: home }, cwd: project, sources: "global", projectFs: box });

  // user < project < local: the box's project file wins over the host user file.
  assert.equal(claudeSettingsNodeOptions(envs), "--from-box-project");
  assert.deepEqual(box.reads.sort(), [join(project, ".claude", "settings.json"), join(project, ".claude", "settings.local.json")].sort());
  assert.ok(!box.reads.includes(join(home, "settings.json")), "the user file is never read from the box");
});

test("without a box filesystem the project files are read on the host", async (t) => {
  const root = await tempRoot(t);
  const home = join(root, "home");
  const project = join(root, "proj");
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "settings.json"), JSON.stringify({ env: { NODE_OPTIONS: "--user" } }));
  await writeSettings(project, "settings.local.json", { NODE_OPTIONS: "--local" });

  const env = { CLAUDE_CONFIG_DIR: home };
  assert.equal(claudeSettingsNodeOptions(await claudeSettingsEnvs({ env, cwd: project, sources: "global" })), "--local");
  // A profile chat carries the user's at the flag tier, so there it wins.
  assert.equal(claudeSettingsNodeOptions(await claudeSettingsEnvs({ env, cwd: project, sources: "profile" })), "--user");
});

test("ENABLE_TOOL_SEARCH: local over project over user over the process env", async (t) => {
  const root = await tempRoot(t);
  const home = join(root, "home");
  const project = join(root, "proj");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  const env = { CLAUDE_CONFIG_DIR: home };
  const setting = async (processEnv: Record<string, string> = {}) =>
    claudeToolSearchSetting(await claudeSettingsEnvs({ env, cwd: project, sources: "global" }), processEnv);

  assert.equal(await setting(), undefined);
  assert.equal(await setting({ ENABLE_TOOL_SEARCH: "auto" }), "auto", "the process env applies when no file sets it");

  await writeFile(join(home, "settings.json"), JSON.stringify({ env: { ENABLE_TOOL_SEARCH: "auto" } }));
  assert.equal(await setting({ ENABLE_TOOL_SEARCH: "false" }), "auto", "a settings file beats the process env");

  await writeSettings(project, "settings.json", { ENABLE_TOOL_SEARCH: "false" });
  assert.equal(await setting(), "false");

  await writeSettings(project, "settings.local.json", { ENABLE_TOOL_SEARCH: "auto:30" });
  assert.equal(await setting(), "auto:30");

  // A value that is not a string is not one to override, and does not fall through to a lower one.
  await writeSettings(project, "settings.local.json", { ENABLE_TOOL_SEARCH: false });
  assert.equal(await setting({ ENABLE_TOOL_SEARCH: "auto" }), undefined);
});

test("ENABLE_TOOL_SEARCH in a profile chat: the carried user value wins; an isolated one reads the user's only", async (t) => {
  const root = await tempRoot(t);
  const home = join(root, "home");
  const project = join(root, "proj");
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "settings.json"), JSON.stringify({ env: { ENABLE_TOOL_SEARCH: "auto" } }));
  await writeSettings(project, "settings.local.json", { ENABLE_TOOL_SEARCH: "false" });
  const env = { CLAUDE_CONFIG_DIR: home };

  assert.equal(claudeToolSearchSetting(await claudeSettingsEnvs({ env, cwd: project, sources: "profile" }), {}), "auto");
  assert.equal(claudeToolSearchSetting(await claudeSettingsEnvs({ env, cwd: project, sources: "global" }), {}), "false");

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

test("a box chat finds the repository root in the box", async () => {
  const repo = "/var/lib/orquester/workspaces/ws/boxproj";
  const cwd = join(repo, "app");
  const box = mapFs({
    [join(repo, ".git")]: "",
    [join(repo, ".claude", "settings.local.json")]: JSON.stringify({ env: { ENABLE_TOOL_SEARCH: "auto" } })
  });
  const envs = await claudeSettingsEnvs({ env: { CLAUDE_CONFIG_DIR: "/nonexistent-config" }, cwd, sources: "global", projectFs: box });
  assert.equal(claudeToolSearchSetting(envs, {}), "auto");
  assert.ok(box.reads.includes(join(cwd, ".claude", "settings.local.json")), "the cwd's leftover local file is read too");
});
