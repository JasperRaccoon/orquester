/**
 * The approval-card reads (unified MCP design 2026-10-15 §7.1, §7.2): whole trees with hashes and
 * flags (symlinks never followed, caps → incomplete), a checkout's commit read from `.git`, what a
 * plugin directory ships, Claude's plugin source inside its marketplace, an import scan's detail,
 * and the routes.
 */

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import Fastify from "fastify";
import { claudePluginFetch, claudePluginSource } from "./adapters/claude/plugins.ts";
import type { PortableItem } from "./adapters/types.ts";
import { codexMarketplaceRoot, codexPluginLocation } from "./adapters/codex/index.ts";
import { ProfileImportStore } from "./import.ts";
import { AgentProfileService } from "./service.ts";
import { FakeProfileAdapter, fakeItem } from "./testing.ts";
import { pluginProvidesOf, readGitCommit, readInstalledPlugin, readPreviewTree } from "./preview-reads.ts";
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
  assert.ok(!JSON.stringify(tree).includes("secret elsewhere"), "a symlink is never followed");
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
  // One file (a command) reads as itself.
  const command = await readPreviewTree(join(skill, "SKILL.md"));
  assert.deepEqual(command.files.map((file) => file.path), ["SKILL.md"]);
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
  assert.deepEqual(await claudePluginSource(market, "far"), {
    source: { type: "remote", description: "github acme/far", fetch: { url: "https://github.com/acme/far.git" } }
  });
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
    pluginPreview: async (...args: unknown[]) => (calls.push(["pluginPreview", ...args]), { marketplace: "m", plugin: "p", commit: null, source: { type: "unavailable", reason: "r" }, provides: { skills: [], commands: [], agents: [], hooks: [], mcpServers: [] } }),
    keepBothName: async (...args: unknown[]) => (calls.push(["keepBothName", ...args]), "x-2"),
    copyPreview: async (...args: unknown[]) => (calls.push(["copyPreview", ...args]), { itemId: "skill:a", revision: "r", kind: "skill", name: "a", notes: [] })
  } as unknown as AgentProfileRouteDeps["service"];
  const app = Fastify({ logger: false });
  registerAgentProfileRoutes(app, { service, importsDir: "/tmp/unused" });
  const bare = Fastify({ logger: false });
  registerAgentProfileRoutes(bare, { service: {} as AgentProfileRouteDeps["service"], importsDir: "/tmp/unused" });
  t.after(async () => { await app.close(); await bare.close(); });
  assert.equal((await app.inject({ method: "GET", url: "/api/agent-profile/claude/items/skill%3Aa/files" })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/api/agent-profile/claude/imports/i" })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/api/agent-profile/claude/marketplaces/m/plugins/p" })).statusCode, 200);
  assert.deepEqual(calls, [["itemFiles", "claude", "skill:a"], ["importDetail", "claude", "i", "fail", {}], ["pluginPreview", "claude", "m", "p"]]);
  calls.length = 0;
  assert.deepEqual((await app.inject({ method: "GET", url: "/api/agent-profile/codex/names/keep-both?kind=skill&name=x" })).json(), { name: "x-2" });
  assert.equal((await app.inject({ method: "GET", url: "/api/agent-profile/codex/names/keep-both?kind=plugin&name=x" })).statusCode, 400);
  assert.equal((await app.inject({ method: "GET", url: "/api/agent-profile/claude/items/skill%3Aa/copy-preview?toAgent=codex&onConflict=keep-both" })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: "/api/agent-profile/claude/items/skill%3Aa/copy-preview?toAgent=nope" })).statusCode, 400);
  assert.equal((await app.inject({ method: "GET", url: "/api/agent-profile/claude/imports/i?onConflict=bogus" })).statusCode, 400);
  assert.equal((await app.inject({ method: "GET", url: "/api/agent-profile/claude/imports/i?onConflict=keep-both" })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: `/api/agent-profile/claude/imports/i?onConflict=keep-both&picks=${encodeURIComponent('["b","a"]')}&taken=${encodeURIComponent('{"skill":["x"]}')}` })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: `/api/agent-profile/claude/imports/i?taken=${encodeURIComponent('{"plugin":["x"]}')}` })).statusCode, 400);
  assert.deepEqual(calls, [
    ["keepBothName", "codex", "skill", "x", undefined], ["copyPreview", "claude", "skill:a", "codex", "keep-both", undefined], ["importDetail", "claude", "i", "keep-both", {}],
    ["importDetail", "claude", "i", "keep-both", { picks: ["b", "a"], taken: { skill: ["x"] } }]
  ]);
  assert.equal((await app.inject({ method: "GET", url: "/api/agent-profile/nope/imports/i" })).statusCode, 404);
  const missing = await bare.inject({ method: "GET", url: "/api/agent-profile/claude/items/skill%3Aa/files" });
  assert.equal(missing.statusCode, 503);
});

test("pluginProvidesOf: hooks and MCP servers a manifest declares by path (one, or a list) count too", async (t) => {
  const root = await tempRoot(t);
  const plugin = join(root, "p");
  await write(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "p", hooks: "./config/hooks.json", mcpServers: ["./config/servers.json", "${CLAUDE_PLUGIN_ROOT}/more.json"] }));
  await write(join(plugin, "config", "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo start" }] }] } }));
  await write(join(plugin, "config", "servers.json"), JSON.stringify({ mcpServers: { a: { command: "a-server" } } }));
  await write(join(plugin, "more.json"), JSON.stringify({ b: { url: "https://b.example/mcp" } }));
  await write(join(plugin, "hooks", "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }] } }));
  const provides = pluginProvidesOf(await readPreviewTree(plugin));
  assert.deepEqual(provides.hooks.map((hook) => `${hook.event}:${hook.command}`).sort(), ["SessionStart:echo start", "Stop:echo stop"]);
  assert.deepEqual(provides.mcpServers.map((server) => server.name).sort(), ["a", "b"]);
});

test("ProfileImportStore.inspect shows picks as they will be imported: frontmatter mapped, a Codex command made a skill", async (t) => {
  const root = await tempRoot(t);
  const store = new ProfileImportStore({
    dir: join(root, "imports"),
    existing: async () => new Set(),
    logger: { info: () => undefined, warn: () => undefined },
    clone: async (_url, _ref, dest) => {
      await write(join(dest, "skills", "alpha", "SKILL.md"), "---\nname: other-name\ndescription: A\nlicense: MIT\n---\nalpha body");
      await write(join(dest, "commands", "pr.md"), "---\ndescription: Open a PR\n---\nDo it.");
    }
  });
  t.after(() => store.stop());
  const scan = await store.scanGit("codex", "https://git.example/acme/kit.git");
  const detail = await store.inspect("codex", scan.importId);
  const alpha = detail.candidates.find((candidate) => candidate.kind === "skill" && candidate.files.some((file) => file.text?.includes("alpha body")))!;
  const skillText = alpha.files.find((file) => file.path === "SKILL.md")!.text!;
  assert.match(skillText, new RegExp(`^---\\nname: ${alpha.name}\\n`), "the name key is the item's name");
  assert.doesNotMatch(skillText, /license/, "keys the agent does not know are dropped");
  assert.ok(alpha.notes?.some((note) => /license/.test(note)));
  const command = detail.candidates.find((candidate) => candidate.name === "pr")!;
  assert.equal(command.kind, "skill");
  assert.deepEqual(command.files.map((file) => file.path), ["SKILL.md"]);
  assert.match(command.files[0]!.text!, /Do it\./);
  assert.ok(command.notes?.some((note) => /imported as a skill/.test(note)));
  assert.equal(command.files[0]!.sha256, sha(command.files[0]!.text!), "the hash is the shown text's");
});

test("AgentProfileService.mcpCandidate: header and env values and every Codex env reference, daemon-side only", async () => {
  class Adapter extends FakeProfileAdapter {
    override async exportItem(id: string): Promise<PortableItem> {
      if (id !== "mcp:orq") return super.exportItem(id);
      return { kind: "mcp", server: { name: "orq", transport: "http", url: "https://x.example/mcp", headers: { Authorization: "Bearer h" },
        advanced: { bearer_token_env_var: "TOKEN_A", env_http_headers: { "X-Auth": "TOKEN_B" }, env_vars: ["TOKEN_C"] } } };
    }
  }
  const adapter = new Adapter("codex");
  adapter.items = [fakeItem("mcp", "orq")];
  const service = new AgentProfileService({ adapters: { codex: adapter }, agentInfo: () => ({ installed: true }), converter: (item) => ({ item, notes: [] }), logger: { warn: () => undefined, error: () => undefined } });
  assert.deepEqual(await service.mcpCandidate("codex", "mcp:orq"), { name: "orq", url: "https://x.example/mcp", values: ["Bearer h"], envRefs: ["TOKEN_A", "TOKEN_B", "TOKEN_C"] });
  assert.equal(await service.mcpCandidate("codex", "skill:x"), null);
});

test("codexPluginLocation: the checkout is the manifest's root (either layout); a relative source resolves against it", () => {
  const manifest = "/m/acme/.agents/plugins/marketplace.json";
  assert.equal(codexMarketplaceRoot(manifest), "/m/acme");
  assert.equal(codexMarketplaceRoot("/m/other/catalog.json"), "/m/other");
  assert.equal(codexMarketplaceRoot("/m/dir"), "/m/dir");
  const summary = (path?: string) => ({ version: null, localVersion: "1.0.0", source: { type: "local", ...(path !== undefined ? { path } : {}) } });
  assert.deepEqual(codexPluginLocation(manifest, summary("./plugins/hello")), { marketplaceDir: "/m/acme", version: "1.0.0", source: { type: "local", dir: "/m/acme/plugins/hello" } });
  assert.deepEqual(codexPluginLocation(manifest, summary("/abs/plugins/hello")), { marketplaceDir: "/m/acme", version: "1.0.0", source: { type: "local", dir: "/abs/plugins/hello" } });
  // Lexically outside: still where Codex reads it from; the service decides containment on realpaths.
  assert.deepEqual(codexPluginLocation(manifest, summary("../../etc")).source, { type: "local", dir: "/etc" });
  assert.equal(codexMarketplaceRoot("/m/claude-layout/.claude-plugin/marketplace.json"), "/m/claude-layout");
  assert.deepEqual(codexPluginLocation(null, { version: "2", localVersion: null, source: { type: "git", url: "https://g.example/p.git" } }),
    { marketplaceDir: null, version: "2", source: { type: "remote", description: "git https://g.example/p.git", fetch: { url: "https://g.example/p.git" } } });
});

test("pluginPreview: a plugin directory outside the marketplace checkout (on realpaths, a symlink included) is marked: its commit does not pin it", async (t) => {
  const root = await tempRoot(t);
  const market = join(root, "market");
  const elsewhere = join(root, "elsewhere", "p");
  await write(join(market, ".git", "HEAD"), `${"a".repeat(40)}\n`);
  await write(join(market, "plugins", "inside", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "inside" }));
  await write(join(elsewhere, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "p" }));
  await symlink(elsewhere, join(market, "plugins", "linked"));
  class Adapter extends FakeProfileAdapter {
    async pluginSource(_marketplace: string, plugin: string) {
      return { marketplaceDir: market, source: { type: "local" as const, dir: plugin === "abs" ? elsewhere : join(market, "plugins", plugin) } };
    }
  }
  const service = new AgentProfileService({ adapters: { codex: new Adapter("codex") }, agentInfo: () => ({ installed: true }), converter: (item) => ({ item, notes: [] }), logger: { warn: () => undefined, error: () => undefined } });
  const inside = await service.pluginPreview("codex", "m", "inside");
  assert.equal(inside.outsideCheckout, undefined);
  assert.equal(inside.commit, "a".repeat(40));
  for (const plugin of ["abs", "linked"]) {
    const outside = await service.pluginPreview("codex", "m", plugin);
    assert.equal(outside.outsideCheckout, true, plugin);
    assert.equal(outside.source.type, "local");
  }
});


test("copyPreview and keep-both import detail: written under the target's own keep-both name, SKILL.md carrying it; temp copies removed", async (t) => {
  const root = await tempRoot(t);
  class Adapter extends FakeProfileAdapter {
    async keepBothNames(requests: readonly { kind: "mcp" | "skill" | "command"; name: string }[]) {
      return requests.map((request) => `${request.name}-2`);
    }
  }
  const claude = new Adapter("claude");
  claude.items = [fakeItem("skill", "handoff"), fakeItem("command", "deploy"), fakeItem("mcp", "jira")];
  const codex = new Adapter("codex");
  const store = new ProfileImportStore({
    dir: join(root, "imports"), existing: async () => new Set(["skill:alpha"]), logger: { info: () => undefined, warn: () => undefined },
    clone: async (_url, _ref, dest) => write(join(dest, "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: A\n---\nbody")
  });
  t.after(() => store.stop());
  const service = new AgentProfileService({
    adapters: { claude, codex, grok: new Adapter("grok") }, agentInfo: () => ({ installed: true }), converter: (item) => ({ item, notes: ["converted"] }), imports: store,
    logger: { warn: () => undefined, error: () => undefined }
  });
  const skill = await service.copyPreview("claude", "skill:handoff", "codex", "keep-both");
  assert.equal(skill.name, "handoff-2");
  assert.deepEqual(skill.notes, ["converted"]);
  assert.match(skill.tree!.files.find((file) => file.path === "SKILL.md")!.text!, /^---\nname: handoff-2\n/);
  for (const dir of claude.exportedDirs) await assert.rejects(stat(dir), { code: "ENOENT" }, "the exported copy is removed");
  const plain = await service.copyPreview("claude", "skill:handoff", "codex", "fail");
  assert.equal(plain.name, "handoff");
  const command = await service.copyPreview("claude", "command:deploy", "grok", "keep-both");
  assert.deepEqual([command.name, command.tree?.files.map((file) => file.path)], ["deploy-2", ["deploy-2.md"]]);
  const mcp = await service.copyPreview("claude", "mcp:jira", "codex", "replace");
  assert.deepEqual([mcp.name, mcp.tree], ["jira", undefined]);

  const scan = await service.scanGit("claude", "https://git.example/acme/skills.git");
  const detail = await service.importDetail("claude", scan.importId, "keep-both");
  const alpha = detail.candidates[0]!;
  assert.equal(alpha.writtenName, "alpha-2");
  assert.match(alpha.files.find((file) => file.path === "SKILL.md")!.text!, /^---\nname: alpha-2\n/);
  assert.equal((await service.importDetail("claude", scan.importId)).candidates[0]!.writtenName, undefined);
});

test("readInstalledPlugin: the reported version, symlinked versions only inside the plugin cache, and unreadable reasons", async (t) => {
  const root = await tempRoot(t);
  const cache = join(root, "home", ".codex", "plugins", "cache");
  const plugin = join(cache, "mkt", "p");
  const manifest = (dir: string, name: string) => write(join(dir, ".codex-plugin", "plugin.json"), JSON.stringify({ name }));
  await manifest(join(plugin, "1.0.0"), "p-one");
  await manifest(join(cache, "mkt", "shared-2.0.0"), "p-two");
  await symlink(join(cache, "mkt", "shared-2.0.0"), join(plugin, "2.0.0"));
  const read = await readInstalledPlugin(plugin, "2.0.0");
  assert.equal(read.unreadable, undefined);
  assert.match(read.tree.files[0]!.text!, /p-two/, "a symlinked version inside the plugin cache is followed");
  const both = await readInstalledPlugin(plugin, undefined);
  assert.deepEqual(both.tree.files.map((file) => file.path), ["1.0.0/.codex-plugin/plugin.json", "2.0.0/.codex-plugin/plugin.json"]);
  // A version directory leading out of the plugin cache: unreadable, never followed.
  await manifest(join(root, "elsewhere"), "evil");
  await symlink(join(root, "elsewhere"), join(plugin, "3.0.0"));
  const outside = await readInstalledPlugin(plugin, "3.0.0");
  assert.match(outside.unreadable ?? "", /contents not readable \(the version directory "3\.0\.0" leads outside the plugin cache\)/);
  assert.deepEqual(outside.tree.files, []);
  assert.equal((await readInstalledPlugin(join(cache, "mkt", "gone"), undefined)).unreadable, "contents not readable (cache missing)");
  if (process.getuid?.() !== 0) {
    const locked = join(cache, "mkt", "locked");
    await mkdir(join(locked, "1.0.0"), { recursive: true });
    await chmod(locked, 0o000);
    try {
      assert.equal((await readInstalledPlugin(locked, undefined)).unreadable, "contents not readable (EACCES)", "a permission error is not a missing cache");
    } finally {
      await chmod(locked, 0o755);
    }
  }
});

test("readInstalledPlugin: the cache root comes from the path as named — an account home reaching the cache through a symlink still follows sibling versions", async (t) => {
  const root = await tempRoot(t);
  // The system cache lives under a directory not named plugins/cache; the account home links to it.
  const store = join(root, "system", "plugin-store");
  await write(join(store, "mkt", "shared-2.0.0", ".codex-plugin", "plugin.json"), JSON.stringify({ name: "p-two" }));
  await mkdir(join(store, "mkt", "p"), { recursive: true });
  await symlink(join(store, "mkt", "shared-2.0.0"), join(store, "mkt", "p", "2.0.0"));
  await mkdir(join(root, "account", ".codex", "plugins"), { recursive: true });
  await symlink(store, join(root, "account", ".codex", "plugins", "cache"));
  const read = await readInstalledPlugin(join(root, "account", ".codex", "plugins", "cache", "mkt", "p"), "2.0.0");
  assert.equal(read.unreadable, undefined);
  assert.match(read.tree.files[0]!.text!, /p-two/);
});

test("claudePluginFetch: which catalogue sources a git clone can fetch", () => {
  assert.deepEqual(claudePluginFetch({ source: "github", repo: "acme/x", ref: "v1" }), { url: "https://github.com/acme/x.git", ref: "v1" });
  assert.equal(claudePluginFetch({ source: "github", repo: "../evil" }), undefined);
  assert.deepEqual(claudePluginFetch({ source: "url", url: "https://g.example/x.git" }), { url: "https://g.example/x.git" });
  assert.deepEqual(claudePluginFetch({ source: "git-subdir", url: "https://g.example/m.git", path: "./plugins/p/" }), {
    url: "https://g.example/m.git",
    path: "plugins/p"
  });
  assert.equal(claudePluginFetch({ source: "npm", package: "x" }), undefined);
});
