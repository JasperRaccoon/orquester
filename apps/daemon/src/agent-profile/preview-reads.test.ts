/**
 * The approval-card reads (unified MCP design 2026-10-15 §7.1, §7.2): whole trees with hashes and
 * flags (symlinks never followed, caps → incomplete), a checkout's commit read from `.git`, what a
 * plugin directory ships, Claude's plugin source inside its marketplace, an import scan's detail,
 * and the routes.
 */

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import Fastify from "fastify";
import { claudePluginSource } from "./adapters/claude/plugins.ts";
import { ProfileImportStore } from "./import.ts";
import { pluginProvidesOf, readGitCommit, readPreviewTree, treeDigest } from "./preview-reads.ts";
import { registerAgentProfileRoutes, type AgentProfileRouteDeps } from "./routes.ts";

async function write(path: string, text: string | Buffer): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
}

async function tempRoot(t: test.TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orq-preview-reads-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

test("readPreviewTree: text in full, executables and binaries flagged with hashes, symlinks listed not followed, .git skipped", async (t) => {
  const root = await tempRoot(t);
  const skill = join(root, "skill");
  await write(join(skill, "SKILL.md"), "---\nname: x\n---\nbody");
  await write(join(skill, "scripts", "run.sh"), "#!/bin/sh\necho hi\n");
  await write(join(skill, "scripts", "plain.txt"), "plain");
  await chmod(join(skill, "scripts", "plain.txt"), 0o755);
  const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2]);
  await write(join(skill, "bin", "tool"), elf);
  await write(join(skill, "data.bin"), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
  await write(join(root, "outside.txt"), "secret elsewhere");
  await symlink(join(root, "outside.txt"), join(skill, "link"));
  await write(join(skill, ".git", "HEAD"), "ref: refs/heads/main\n");
  const tree = await readPreviewTree(skill);
  assert.equal(tree.complete, true);
  assert.deepEqual(tree.files.map((file) => [file.path, file.flag ?? "", file.text ?? null]), [
    ["bin/tool", "executable", null],
    ["data.bin", "binary", null],
    ["link", "symlink", null],
    ["scripts/plain.txt", "executable", "plain"],
    ["scripts/run.sh", "executable", "#!/bin/sh\necho hi\n"],
    ["SKILL.md", "", "---\nname: x\n---\nbody"]
  ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  assert.equal(tree.files.find((file) => file.path === "bin/tool")!.sha256, sha(elf));
  assert.equal(tree.files.find((file) => file.path === "link")!.target, join(root, "outside.txt"));
  assert.ok(!JSON.stringify(tree).includes("secret elsewhere"), "a symlink is never followed");
  // One file (a command) reads as itself; a digest moves when any byte does.
  const command = await readPreviewTree(join(skill, "SKILL.md"));
  assert.deepEqual(command.files.map((file) => file.path), ["SKILL.md"]);
  const before = treeDigest(tree);
  await write(join(skill, "scripts", "plain.txt"), "plain!");
  assert.notEqual(treeDigest(await readPreviewTree(skill)), before);
});

test("readPreviewTree: past the byte cap the tree is incomplete, never cut silently", async (t) => {
  const root = await tempRoot(t);
  await write(join(root, "big", "a.txt"), "x".repeat(2 * 1024 * 1024 + 10));
  const tree = await readPreviewTree(join(root, "big"));
  assert.equal(tree.complete, false);
});

test("readGitCommit: a symbolic HEAD through loose and packed refs, a detached HEAD, a worktree's .git file; null elsewhere", async (t) => {
  const root = await tempRoot(t);
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  await write(join(root, "loose", ".git", "HEAD"), "ref: refs/heads/main\n");
  await write(join(root, "loose", ".git", "refs", "heads", "main"), `${a}\n`);
  await write(join(root, "packed", ".git", "HEAD"), "ref: refs/heads/main\n");
  await write(join(root, "packed", ".git", "packed-refs"), `# pack-refs with: peeled\n${b} refs/heads/main\n`);
  await write(join(root, "detached", ".git", "HEAD"), `${b}\n`);
  await write(join(root, "wt", ".git"), `gitdir: ${join(root, "loose", ".git")}\n`);
  assert.equal(await readGitCommit(join(root, "loose")), a);
  assert.equal(await readGitCommit(join(root, "packed")), b);
  assert.equal(await readGitCommit(join(root, "detached")), b);
  assert.equal(await readGitCommit(join(root, "wt")), a);
  assert.equal(await readGitCommit(join(root, "nothing")), null);
});

test("pluginProvidesOf and claudePluginSource: what a plugin ships, and where it lives in its marketplace", async (t) => {
  const root = await tempRoot(t);
  const market = join(root, "market");
  await write(join(market, ".claude-plugin", "marketplace.json"), JSON.stringify({
    metadata: { pluginRoot: "./plugins" },
    plugins: [
      { name: "deploy", source: "./plugins/deploy", version: "1.2.0" },
      { name: "bare", source: "bare" },
      { name: "far", source: { source: "github", repo: "acme/far" } },
      { name: "escape", source: "../../etc" }
    ]
  }));
  const plugin = join(market, "plugins", "deploy");
  await write(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "deploy", mcpServers: { inline: { url: "https://x.example/mcp", headers: { Authorization: "secret" } } } }));
  await write(join(plugin, "skills", "ship", "SKILL.md"), "ship");
  await write(join(plugin, "commands", "git", "pr.md"), "pr");
  await write(join(plugin, "agents", "reviewer.md"), "reviewer");
  await write(join(plugin, "hooks", "hooks.json"), JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./hooks/post.sh" }] }] } }));
  await write(join(plugin, ".mcp.json"), JSON.stringify({ mcpServers: { deployer: { command: "node", args: ["server.js"], env: { TOKEN: "t0ken" } } } }));
  const provides = pluginProvidesOf(await readPreviewTree(plugin));
  assert.deepEqual(provides, {
    skills: ["ship"], commands: ["git/pr"], agents: ["reviewer"],
    hooks: [{ event: "PostToolUse", matcher: "Bash", command: "./hooks/post.sh" }],
    mcpServers: [
      { name: "deployer", command: "node", args: ["server.js"], envKeys: ["TOKEN"], headerKeys: [] },
      { name: "inline", url: "https://x.example/mcp", envKeys: [], headerKeys: ["Authorization"] }
    ]
  });
  assert.ok(!JSON.stringify(provides).includes("t0ken"), "env values are never part of what a plugin provides");
  assert.deepEqual(await claudePluginSource(market, "deploy"), { version: "1.2.0", source: { type: "local", dir: plugin } });
  assert.deepEqual(await claudePluginSource(market, "bare"), { source: { type: "local", dir: join(market, "plugins", "bare") } });
  assert.deepEqual(await claudePluginSource(market, "far"), { source: { type: "remote", description: "github acme/far" } });
  await assert.rejects(claudePluginSource(market, "escape"), /outside the marketplace/);
  await assert.rejects(claudePluginSource(market, "ghost"), /does not list/);
});

test("ProfileImportStore.inspect: an open scan's source and every candidate in full; a taken scan is gone", async (t) => {
  const root = await tempRoot(t);
  const commit = "c".repeat(40);
  const store = new ProfileImportStore({
    dir: join(root, "imports"),
    existing: async () => new Set(["skill:beta"]),
    logger: { info: () => undefined, warn: () => undefined },
    clone: async (_url, _ref, dest) => {
      await write(join(dest, "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: A\n---\nalpha body");
      await write(join(dest, "skills", "alpha", "run.sh"), "#!/bin/sh\n");
      await write(join(dest, "skills", "beta", "SKILL.md"), "---\nname: beta\ndescription: B\n---\nbeta body");
      await write(join(dest, ".git", "HEAD"), `${commit}\n`);
    }
  });
  t.after(() => store.stop());
  const scan = await store.scanGit("claude", "https://git.example/acme/skills.git");
  const detail = await store.inspect("claude", scan.importId);
  assert.deepEqual(detail.source, { type: "git", url: "https://git.example/acme/skills.git", commit });
  const alpha = detail.candidates.find((candidate) => candidate.name === "alpha")!;
  assert.deepEqual(alpha.files.map((file) => [file.path, file.flag ?? "", file.text ?? null]), [["run.sh", "executable", "#!/bin/sh\n"], ["SKILL.md", "", "---\nname: alpha\ndescription: A\n---\nalpha body"]]);
  assert.equal(detail.candidates.find((candidate) => candidate.name === "beta")!.exists, true);
  await assert.rejects(store.inspect("codex", scan.importId), /expired or does not exist/);
  const taken = await store.take("claude", scan.importId, [alpha.ref]);
  await taken.release();
  await assert.rejects(store.inspect("claude", scan.importId), /expired or does not exist/);
});

test("routes: the card reads answer what the service reads, and 503 without it", async (t) => {
  const calls: unknown[][] = [];
  const service = {
    itemFiles: async (...args: unknown[]) => (calls.push(["itemFiles", ...args]), { itemId: "skill:a", revision: "r", files: [], complete: true }),
    importDetail: async (...args: unknown[]) => (calls.push(["importDetail", ...args]), { importId: "i", source: { type: "upload", name: "x.zip" }, candidates: [] }),
    pluginPreview: async (...args: unknown[]) => (calls.push(["pluginPreview", ...args]), { marketplace: "m", plugin: "p", commit: null, source: { type: "unavailable", reason: "r" }, provides: { skills: [], commands: [], agents: [], hooks: [], mcpServers: [] } })
  } as unknown as AgentProfileRouteDeps["service"];
  const app = Fastify({ logger: false });
  registerAgentProfileRoutes(app, { service, importsDir: "/tmp/unused" });
  const bare = Fastify({ logger: false });
  registerAgentProfileRoutes(bare, { service: {} as AgentProfileRouteDeps["service"], importsDir: "/tmp/unused" });
  t.after(async () => { await app.close(); await bare.close(); });
  assert.equal((await app.inject({ method: "GET", url: "/api/agent-profile/claude/items/skill%3Aa/files" })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/api/agent-profile/claude/imports/i" })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/api/agent-profile/claude/marketplaces/m/plugins/p" })).statusCode, 200);
  assert.deepEqual(calls, [["itemFiles", "claude", "skill:a"], ["importDetail", "claude", "i"], ["pluginPreview", "claude", "m", "p"]]);
  assert.equal((await app.inject({ method: "GET", url: "/api/agent-profile/nope/imports/i" })).statusCode, 404);
  const missing = await bare.inject({ method: "GET", url: "/api/agent-profile/claude/items/skill%3Aa/files" });
  assert.equal(missing.statusCode, 503);
});
