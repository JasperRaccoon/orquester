import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PortableItem, PortableMcpServer } from "./adapters/types.ts";
import { type ProfileConverter, createProfileConverter } from "./convert.ts";
import { isAgentProfileError } from "./errors.ts";
import { parseMarkdownDocument, serializeMarkdownDocument } from "./infra/index.ts";

interface Scratch {
  root: string;
  tempRoot: string;
  convert: ProfileConverter;
}

async function scratch(t: test.TestContext): Promise<Scratch> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "orquester-profile-convert-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tempRoot = join(root, "imports");
  return { root, tempRoot, convert: createProfileConverter({ tempRoot }) };
}

function rejectsWith(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(isAgentProfileError(error), `an AgentProfileError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

async function makeSkill(root: string, name: string, frontmatter: Record<string, unknown>, body = "Do the thing.\n"): Promise<string> {
  const dir = join(root, "source", name);
  await mkdir(join(dir, "scripts"), { recursive: true });
  await writeFile(join(dir, "SKILL.md"), serializeMarkdownDocument(frontmatter, body));
  await writeFile(join(dir, "scripts", "run.sh"), "#!/bin/sh\necho hi\n");
  await chmod(join(dir, "scripts", "run.sh"), 0o755);
  return dir;
}

test("skill conversion preserves content and executable support files without changing the source", async (t) => {
  const { root, convert } = await scratch(t);
  const dir = await makeSkill(root, "alpha", {
    name: "alpha", description: "Alpha skill", metadata: { owner: "me" }, model: "opus", "x-custom": 1
  });
  const before = await readFile(join(dir, "SKILL.md"), "utf8");
  const result = convert({ kind: "skill", name: "alpha", dir }, "claude", "codex");
  assert.ok(result.item.kind === "skill");
  assert.deepEqual(parseMarkdownDocument(await readFile(join(result.item.dir, "SKILL.md"), "utf8")), {
    frontmatter: { name: "alpha", description: "Alpha skill", metadata: { owner: "me" } },
    body: "Do the thing.\n",
    hadFrontmatter: true
  });
  assert.equal(await readFile(join(result.item.dir, "scripts", "run.sh"), "utf8"), "#!/bin/sh\necho hi\n");
  assert.equal((await stat(join(result.item.dir, "scripts", "run.sh"))).mode & 0o777, 0o755);
  assert.equal(await readFile(join(dir, "SKILL.md"), "utf8"), before);
});

test("MCP conversion preserves stdio and HTTP secrets without exposing them in notes or mutating the source", () => {
  const convert = createProfileConverter({ tempRoot: join(tmpdir(), "never-used") });
  const servers: PortableMcpServer[] = [
    { name: "jira", transport: "stdio", command: "npx", args: ["-y", "jira-mcp"], env: { JIRA_TOKEN: "s3cret-env" } },
    { name: "jira", transport: "http", url: "https://mcp.example.test/mcp", headers: { Authorization: "Bearer s3cret-header" } }
  ];
  for (const server of servers) {
    const before = structuredClone(server);
    const result = convert({ kind: "mcp", server: { ...server, advanced: { required: true } } }, "codex", "grok");
    assert.ok(result.item.kind === "mcp");
    assert.deepEqual(result.item.server, before);
    assert.ok(!JSON.stringify(result.notes).includes("s3cret"));
    if (result.item.server.env) result.item.server.env.JIRA_TOKEN = "changed";
    if (result.item.server.headers) result.item.server.headers.Authorization = "changed";
    assert.deepEqual(server, before);
  }
});

test("skill: Claude when_to_use becomes Grok when-to-use in place, and back", async (t) => {
  const { root, convert } = await scratch(t);
  const dir = await makeSkill(root, "a", { name: "alpha", description: "A", when_to_use: "Sometimes", model: "opus" });
  const toGrok = convert({ kind: "skill", name: "alpha", dir }, "claude", "grok");
  assert.deepEqual(toGrok.notes, []);
  assert.ok(toGrok.tempDir !== undefined, "renaming a key needs a copy");
  assert.ok(toGrok.item.kind === "skill");
  const grokDoc = parseMarkdownDocument(await readFile(join(toGrok.item.dir, "SKILL.md"), "utf8"));
  assert.deepEqual(grokDoc.frontmatter, { name: "alpha", description: "A", "when-to-use": "Sometimes", model: "opus" });

  const back = convert(toGrok.item, "grok", "claude");
  assert.ok(back.item.kind === "skill");
  const claudeDoc = parseMarkdownDocument(await readFile(join(back.item.dir, "SKILL.md"), "utf8"));
  assert.deepEqual(claudeDoc.frontmatter, { name: "alpha", description: "A", when_to_use: "Sometimes", model: "opus" });
});

test("skill: a missing or different frontmatter name is set to the item's name", async (t) => {
  const { root, convert } = await scratch(t);
  const missing = await makeSkill(root, "m", { description: "No name" });
  const r1 = convert({ kind: "skill", name: "m", dir: missing }, "claude", "opencode");
  assert.ok(r1.item.kind === "skill" && r1.tempDir !== undefined);
  const doc1 = parseMarkdownDocument(await readFile(join(r1.item.dir, "SKILL.md"), "utf8"));
  assert.equal(doc1.frontmatter.name, "m");

  const other = await makeSkill(root, "o", { description: "D", name: "other" });
  const r2 = convert({ kind: "skill", name: "o", dir: other }, "claude", "opencode");
  assert.ok(r2.item.kind === "skill");
  const doc2 = parseMarkdownDocument(await readFile(join(r2.item.dir, "SKILL.md"), "utf8"));
  assert.equal(doc2.frontmatter.name, "o");
});

test("skill names are checked against the rule", async (t) => {
  const { root, convert } = await scratch(t);
  const dir = await makeSkill(root, "x", { name: "x", description: "X" });
  for (const bad of ["Bad", "bad_name", "-bad", "bad-", "a--b", "", "a".repeat(65), "a/b"]) {
    rejectsWith(() => convert({ kind: "skill", name: bad, dir }, "claude", "grok"), "INVALID_NAME");
  }
  const long = "a".repeat(64);
  const ok = convert({ kind: "skill", name: long, dir }, "claude", "grok");
  assert.equal(ok.item.kind === "skill" && ok.item.name, long);
});

test("skill: a symlink inside refuses the copy and leaves no temp dir", async (t) => {
  const { root, tempRoot, convert } = await scratch(t);
  const dir = await makeSkill(root, "linked", { name: "linked", description: "L", "x-custom": 1 });
  await symlink("/etc/passwd", join(dir, "scripts", "passwd"));
  rejectsWith(() => convert({ kind: "skill", name: "linked", dir }, "claude", "codex"), "IMPORT_FAILED");
  assert.deepEqual(await readdir(tempRoot), [], "the partial copy is removed");
});

test("skill: the source directory may itself be a symlink", async (t) => {
  const { root, convert } = await scratch(t);
  const dir = await makeSkill(root, "real", { name: "real", description: "R", model: "x" });
  const link = join(root, "link");
  await symlink(dir, link);
  const result = convert({ kind: "skill", name: "real", dir: link }, "claude", "codex");
  assert.ok(result.item.kind === "skill" && result.tempDir !== undefined);
  assert.ok((await lstat(join(result.item.dir, "scripts", "run.sh"))).isFile());
});

test("skill: an unparseable SKILL.md is an invalid item", async (t) => {
  const { root, convert } = await scratch(t);
  const dir = join(root, "bad");
  await mkdir(dir);
  await writeFile(join(dir, "SKILL.md"), "---\nname: [oops\n---\nbody\n");
  rejectsWith(() => convert({ kind: "skill", name: "bad", dir }, "claude", "grok"), "INVALID_ITEM");
  rejectsWith(() => convert({ kind: "skill", name: "gone", dir: join(root, "gone") }, "claude", "grok"), "INVALID_ITEM");
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

test("command → Codex without a description gets one naming the command", async (t) => {
  const { convert } = await scratch(t);
  const result = convert({ kind: "command", name: "review", frontmatter: {}, body: "Review it.\n" }, "claude", "codex");
  assert.ok(result.item.kind === "skill");
  const document = parseMarkdownDocument(await readFile(join(result.item.dir, "SKILL.md"), "utf8"));
  assert.equal(document.frontmatter.name, "review");
  assert.ok(typeof document.frontmatter.description === "string" && document.frontmatter.description.length > 0);
  assert.equal(document.body, "Review it.\n");
});

test("command names are checked; Grok flattens one folder level", async (t) => {
  const { convert } = await scratch(t);
  for (const bad of ["Git/pr", "a/b/c", "/pr", "pr/", "a//b", "pr.md", "", "../x"]) {
    rejectsWith(() => convert({ kind: "command", name: bad, frontmatter: {}, body: "" }, "claude", "opencode"), "INVALID_NAME");
    rejectsWith(() => convert({ kind: "command", name: bad, frontmatter: {}, body: "" }, "claude", "codex"), "INVALID_NAME");
  }
  const flat = convert({ kind: "command", name: "git/pr", frontmatter: {}, body: "" }, "opencode", "grok");
  assert.equal(flat.item.kind === "command" && flat.item.name, "git-pr");
  const plain = convert({ kind: "command", name: "review", frontmatter: {}, body: "" }, "opencode", "grok");
  assert.deepEqual(plain.notes, []);
});

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

test("mcp advanced: ms ↔ s timeouts and the Codex/Grok-only fields", () => {
  const convert = createProfileConverter({ tempRoot: join(tmpdir(), "never-used") });
  function advanced(value: Record<string, unknown>, from: "claude" | "codex", to: "claude" | "codex" | "grok" | "opencode") {
    const result = convert({ kind: "mcp", server: { name: "jira", transport: "stdio", command: "jira", advanced: value } }, from, to);
    assert.ok(result.item.kind === "mcp");
    return result.item.server.advanced;
  }
  assert.deepEqual(advanced({ timeout: 1500 }, "claude", "codex"), { tool_timeout_sec: 2 });
  assert.deepEqual(advanced({ timeout: 30_000 }, "claude", "grok"), { tool_timeout_sec: 30 });
  assert.deepEqual(advanced({ timeout: 30_000 }, "claude", "opencode"), { timeout: 30_000 });
  assert.deepEqual(advanced({ tool_timeout_sec: 60 }, "codex", "claude"), { timeout: 60_000 });
  assert.deepEqual(advanced({ tool_timeout_sec: 60 }, "codex", "opencode"), { timeout: 60_000 });
  const codex = { startup_timeout_sec: 10, tool_timeout_sec: 60, enabled_tools: ["a"], disabled_tools: ["b"], bearer_token_env_var: "JIRA_TOKEN", required: true, weird: 1 };
  assert.deepEqual(advanced(codex, "codex", "grok"), { startup_timeout_sec: 10, tool_timeout_sec: 60, bearer_token_env_var: "JIRA_TOKEN" });
  assert.deepEqual(advanced(codex, "codex", "claude"), { timeout: 60_000 });
});

test("mcp: an empty advanced map is omitted; sse cannot go to Codex or OpenCode", () => {
  const convert = createProfileConverter({ tempRoot: join(tmpdir(), "never-used") });
  const result = convert(
    { kind: "mcp", server: { name: "m", transport: "stdio", command: "x", advanced: { required: true } } },
    "codex",
    "claude"
  );
  assert.ok(result.item.kind === "mcp");
  assert.equal(Object.hasOwn(result.item.server, "advanced"), false);
  const sse: PortableItem = { kind: "mcp", server: { name: "m", transport: "sse", url: "https://x.test/sse" } };
  rejectsWith(() => convert(sse, "claude", "codex"), "INVALID_ITEM");
  rejectsWith(() => convert(sse, "grok", "opencode"), "INVALID_ITEM");
  assert.equal(convert(sse, "claude", "grok").item.kind, "mcp");
});

test("mcp server names are checked", () => {
  const convert = createProfileConverter({ tempRoot: join(tmpdir(), "never-used") });
  const withName = (name: string): PortableItem => ({ kind: "mcp", server: { name, transport: "stdio", command: "x" } });
  for (const bad of ["1abc", "bad_", "a b", "a.b", "", "-x", "x".repeat(65)]) {
    rejectsWith(() => convert(withName(bad), "claude", "grok"), "INVALID_NAME");
  }
  for (const good of ["_ok", "Jira-Cloud", "a_b-c", "x".repeat(64)]) {
    assert.equal(convert(withName(good), "claude", "grok").item.kind, "mcp");
  }
});
