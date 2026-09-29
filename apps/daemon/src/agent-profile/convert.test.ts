import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AGENT_PROFILE_AGENTS,
  type AgentProfileAgentId,
  MCP_ADVANCED_FIELDS,
  MCP_TRANSPORTS,
  type McpTransport,
  PROFILE_FRONTMATTER_FIELDS
} from "@orquester/api";
import type { PortableItem, PortableMcpServer } from "./adapters/types.ts";
import { CODEX_COMMAND_NOTE, type ProfileConverter, createProfileConverter, mapMcpAdvanced } from "./convert.ts";
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

const SKILL_FRONTMATTER: Record<AgentProfileAgentId, Record<string, unknown>> = {
  claude: {
    name: "alpha",
    description: "Alpha skill",
    when_to_use: "When alpha",
    "argument-hint": "[x]",
    "allowed-tools": "Read",
    model: "opus",
    "disable-model-invocation": true,
    "user-invocable": false,
    metadata: { owner: "me" },
    "x-custom": "kept?"
  },
  codex: { name: "alpha", description: "Alpha skill", metadata: { owner: "me" }, "x-custom": "kept?" },
  grok: {
    name: "alpha",
    description: "Alpha skill",
    "when-to-use": "When alpha",
    "argument-hint": "[x]",
    "allowed-tools": "Read",
    model: "grok-4",
    "disable-model-invocation": true,
    "user-invocable": false,
    metadata: { owner: "me" },
    "x-custom": "kept?"
  },
  opencode: {
    name: "alpha",
    description: "Alpha skill",
    license: "MIT",
    compatibility: "opencode",
    metadata: { owner: "me" },
    "x-custom": "kept?"
  }
};

const COMMAND_FRONTMATTER: Record<AgentProfileAgentId, Record<string, unknown>> = {
  claude: { description: "Open a PR", "argument-hint": "[title]", "allowed-tools": "Bash", model: "opus", "disable-model-invocation": true },
  codex: { description: "Open a PR", "argument-hint": "[title]" },
  grok: { description: "Open a PR", "argument-hint": "[title]" },
  opencode: { description: "Open a PR", agent: "build", model: "x", subtask: true }
};

const canonical = (key: string): string => key.toLowerCase().replaceAll("_", "-");

function fieldKeys(agent: AgentProfileAgentId, kind: "skill" | "command"): Set<string> {
  return new Set((PROFILE_FRONTMATTER_FIELDS[agent][kind] ?? []).map((field) => field.key));
}

async function makeSkill(root: string, name: string, frontmatter: Record<string, unknown>, body = "Do the thing.\n"): Promise<string> {
  const dir = join(root, "source", name);
  await mkdir(join(dir, "scripts"), { recursive: true });
  await writeFile(join(dir, "SKILL.md"), serializeMarkdownDocument(frontmatter, body));
  await writeFile(join(dir, "scripts", "run.sh"), "#!/bin/sh\necho hi\n");
  await chmod(join(dir, "scripts", "run.sh"), 0o755);
  return dir;
}

function dropNote(notes: string[]): string | undefined {
  return notes.find((note) => note.startsWith("Dropped frontmatter keys"));
}

/** The keys a drop note names. */
function droppedIn(note: string | undefined): string[] {
  if (note === undefined) return [];
  return note.slice(note.indexOf(": ") + 2, -1).split(", ");
}

// ---------------------------------------------------------------------------
// Every pair × every kind
// ---------------------------------------------------------------------------

for (const from of AGENT_PROFILE_AGENTS) {
  for (const to of AGENT_PROFILE_AGENTS) {
    test(`skill ${from} → ${to}`, async (t) => {
      const { root, tempRoot, convert } = await scratch(t);
      const source = SKILL_FRONTMATTER[from];
      const dir = await makeSkill(root, `alpha-${from}`, source);
      const before = await readFile(join(dir, "SKILL.md"), "utf8");
      const item: PortableItem = { kind: "skill", name: "alpha", dir };
      const result = convert(item, from, to);
      if (from === to) {
        assert.equal(result.item, item, "identity");
        assert.deepEqual(result.notes, []);
        return;
      }
      assert.equal(result.item.kind, "skill");
      if (result.item.kind !== "skill") return;
      assert.equal(result.item.name, "alpha");
      assert.equal(await readFile(join(dir, "SKILL.md"), "utf8"), before, "the source is never modified");
      // Every pair here drops at least x-custom, so a copy is made under the temp root.
      assert.ok(result.item.dir.startsWith(`${tempRoot}/convert-`), result.item.dir);
      assert.equal((await stat(join(result.item.dir, "scripts", "run.sh"))).mode & 0o777, 0o755, "other files copied, modes kept");

      const converted = parseMarkdownDocument(await readFile(join(result.item.dir, "SKILL.md"), "utf8"));
      assert.equal(converted.body, "Do the thing.\n");
      assert.equal(converted.frontmatter.name, "alpha");
      assert.equal(converted.frontmatter.description, "Alpha skill");
      assert.deepEqual(converted.frontmatter.metadata, { owner: "me" }, "metadata always kept");
      const allowed = fieldKeys(to, "skill");
      for (const key of Object.keys(converted.frontmatter)) {
        assert.ok(allowed.has(key) || ["name", "description", "metadata"].includes(key), `${key} is a ${to} field`);
      }
      const note = dropNote(result.notes);
      assert.ok(note !== undefined, "a drop note");
      const dropped = droppedIn(note);
      assert.ok(dropped.includes("x-custom"));
      for (const key of Object.keys(source)) {
        const kept = Object.keys(converted.frontmatter).some((k) => canonical(k) === canonical(key));
        assert.ok(kept !== dropped.includes(key), `${key} is either kept or named as dropped`);
        if (kept) {
          const target = Object.keys(converted.frontmatter).find((k) => canonical(k) === canonical(key))!;
          assert.deepEqual(converted.frontmatter[target], source[key], `${key} keeps its value`);
        }
      }
    });

    test(`command ${from} → ${to}`, async (t) => {
      const { tempRoot, convert } = await scratch(t);
      const frontmatter = { ...COMMAND_FRONTMATTER[from], "x-custom": 1 };
      const item: PortableItem = { kind: "command", name: "git/pr", frontmatter, body: "Open a PR for $ARGUMENTS\n" };
      const result = convert(item, from, to);
      if (from === to) {
        assert.equal(result.item, item);
        assert.deepEqual(result.notes, []);
        return;
      }
      if (to === "codex") {
        assert.equal(result.item.kind, "skill");
        if (result.item.kind !== "skill") return;
        assert.equal(result.item.name, "git-pr");
        assert.ok(result.item.dir.startsWith(`${tempRoot}/convert-`));
        assert.ok(result.notes.includes(CODEX_COMMAND_NOTE));
        const document = parseMarkdownDocument(await readFile(join(result.item.dir, "SKILL.md"), "utf8"));
        assert.deepEqual(document.frontmatter, { name: "git-pr", description: "Open a PR" });
        assert.equal(document.body, "Open a PR for $ARGUMENTS\n");
        assert.ok(dropNote(result.notes)?.includes("x-custom"));
        return;
      }
      assert.equal(result.item.kind, "command");
      if (result.item.kind !== "command") return;
      assert.equal(result.item.name, to === "grok" ? "git-pr" : "git/pr");
      assert.equal(result.notes.some((note) => note.includes("flat")), to === "grok");
      assert.equal(result.item.body, item.body);
      assert.equal(result.item.frontmatter.description, "Open a PR");
      const allowed = fieldKeys(to, "command");
      for (const key of Object.keys(result.item.frontmatter)) {
        assert.ok(allowed.has(key), `${key} is a ${to} command field`);
      }
      const dropped = droppedIn(dropNote(result.notes));
      assert.ok(dropped.includes("x-custom"));
      for (const key of Object.keys(frontmatter)) {
        assert.equal(Object.hasOwn(result.item.frontmatter, key), !dropped.includes(key), `${key} kept xor dropped`);
      }
      assert.deepEqual(item.frontmatter, frontmatter, "the input is not mutated");
    });

    for (const transport of ["stdio", "http", "sse"] as const satisfies readonly McpTransport[]) {
      test(`mcp ${transport} ${from} → ${to}`, (t) => {
        const convert = createProfileConverter({ tempRoot: join(tmpdir(), "never-used") });
        const server: PortableMcpServer =
          transport === "stdio"
            ? { name: "jira", transport, command: "npx", args: ["-y", "jira-mcp"], env: { JIRA_TOKEN: "s3cret-env-value" } }
            : { name: "jira", transport, url: "https://mcp.example.test/mcp", headers: { Authorization: "Bearer s3cret-header-value" } };
        const advanced: Record<string, unknown> = {};
        for (const field of MCP_ADVANCED_FIELDS[from]) {
          advanced[field.key] =
            field.type === "number" ? 30 : field.type === "boolean" ? true : field.type === "string-list" ? ["a"] : "TOKEN_VAR";
        }
        const item: PortableItem = { kind: "mcp", server: { ...server, advanced } };
        const supported = from === to || MCP_TRANSPORTS[to].includes(transport);
        if (!supported) {
          assert.throws(
            () => convert(item, from, to),
            (error: unknown) => {
              assert.ok(isAgentProfileError(error));
              assert.equal(error.code, "INVALID_ITEM");
              assert.ok(!error.message.includes("s3cret"), "no secret in the error");
              return true;
            }
          );
          return;
        }
        const result = convert(item, from, to);
        if (from === to) {
          assert.equal(result.item, item);
          assert.deepEqual(result.notes, []);
          return;
        }
        assert.equal(result.item.kind, "mcp");
        if (result.item.kind !== "mcp") return;
        const out = result.item.server;
        assert.equal(out.name, "jira");
        assert.equal(out.transport, transport);
        assert.deepEqual(out.env, server.env, "env values carried");
        assert.deepEqual(out.headers, server.headers, "header values carried");
        assert.deepEqual(out.args, server.args);
        assert.ok(!JSON.stringify(result.notes).includes("s3cret"), "no secret in a note");
        const allowed = new Set(MCP_ADVANCED_FIELDS[to].map((field) => field.key));
        for (const key of Object.keys(out.advanced ?? {})) {
          assert.ok(allowed.has(key), `${key} is a ${to} advanced field`);
        }
        if (out.env !== undefined) {
          out.env.JIRA_TOKEN = "changed";
          assert.equal(server.env?.JIRA_TOKEN, "s3cret-env-value", "the output is a copy");
        }
        t.diagnostic(`${from}→${to}: ${result.notes.join(" | ")}`);
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

test("skill: Claude when_to_use becomes Grok when-to-use in place, and back", async (t) => {
  const { root, convert } = await scratch(t);
  const dir = await makeSkill(root, "a", { name: "alpha", description: "A", when_to_use: "Sometimes", model: "opus" });
  const toGrok = convert({ kind: "skill", name: "alpha", dir }, "claude", "grok");
  assert.deepEqual(toGrok.notes, []);
  assert.ok(toGrok.item.kind === "skill");
  assert.notEqual(toGrok.item.dir, dir, "renaming a key needs a copy");
  const grokDoc = parseMarkdownDocument(await readFile(join(toGrok.item.dir, "SKILL.md"), "utf8"));
  assert.deepEqual(Object.keys(grokDoc.frontmatter), ["name", "description", "when-to-use", "model"]);
  assert.equal(grokDoc.frontmatter["when-to-use"], "Sometimes");

  const back = convert(toGrok.item, "grok", "claude");
  assert.ok(back.item.kind === "skill");
  const claudeDoc = parseMarkdownDocument(await readFile(join(back.item.dir, "SKILL.md"), "utf8"));
  assert.deepEqual(claudeDoc.frontmatter, { name: "alpha", description: "A", when_to_use: "Sometimes", model: "opus" });
});

test("skill: nothing to change keeps the source directory and makes no temp dir", async (t) => {
  const { root, tempRoot, convert } = await scratch(t);
  const dir = await makeSkill(root, "plain", { name: "plain", description: "Plain" });
  const result = convert({ kind: "skill", name: "plain", dir }, "claude", "codex");
  assert.equal(result.item.kind === "skill" && result.item.dir, dir);
  assert.deepEqual(result.notes, []);
  await assert.rejects(readdir(tempRoot), { code: "ENOENT" });
});

test("skill: a missing or different frontmatter name is set to the item's name", async (t) => {
  const { root, convert } = await scratch(t);
  const missing = await makeSkill(root, "m", { description: "No name" });
  const r1 = convert({ kind: "skill", name: "m", dir: missing }, "claude", "opencode");
  assert.ok(r1.item.kind === "skill");
  assert.notEqual(r1.item.dir, missing);
  const doc1 = parseMarkdownDocument(await readFile(join(r1.item.dir, "SKILL.md"), "utf8"));
  assert.deepEqual(Object.keys(doc1.frontmatter), ["name", "description"]);
  assert.equal(doc1.frontmatter.name, "m");

  const other = await makeSkill(root, "o", { description: "D", name: "other" });
  const r2 = convert({ kind: "skill", name: "o", dir: other }, "claude", "opencode");
  assert.ok(r2.item.kind === "skill");
  const doc2 = parseMarkdownDocument(await readFile(join(r2.item.dir, "SKILL.md"), "utf8"));
  assert.deepEqual(Object.keys(doc2.frontmatter), ["description", "name"], "the name keeps its place");
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
  assert.ok(result.item.kind === "skill");
  assert.notEqual(result.item.dir, link);
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
  assert.deepEqual(document.frontmatter, { name: "review", description: "Converted from the /review command" });
  assert.deepEqual(result.notes, [CODEX_COMMAND_NOTE]);
});

test("command names are checked; Grok flattens one folder level", async (t) => {
  const { convert } = await scratch(t);
  for (const bad of ["Git/pr", "a/b/c", "/pr", "pr/", "a//b", "pr.md", "", "../x"]) {
    rejectsWith(() => convert({ kind: "command", name: bad, frontmatter: {}, body: "" }, "claude", "opencode"), "INVALID_NAME");
    rejectsWith(() => convert({ kind: "command", name: bad, frontmatter: {}, body: "" }, "claude", "codex"), "INVALID_NAME");
  }
  const flat = convert({ kind: "command", name: "git/pr", frontmatter: {}, body: "" }, "opencode", "grok");
  assert.equal(flat.item.kind === "command" && flat.item.name, "git-pr");
  assert.deepEqual(flat.notes, ['Grok commands are flat: "git/pr" is imported as "git-pr".']);
  const plain = convert({ kind: "command", name: "review", frontmatter: {}, body: "" }, "opencode", "grok");
  assert.deepEqual(plain.notes, []);
});

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

test("mcp advanced: ms ↔ s timeouts and the Codex/Grok-only fields", () => {
  assert.deepEqual(mapMcpAdvanced({ timeout: 1500 }, "codex"), {
    advanced: { tool_timeout_sec: 2 },
    notes: ["The 1500 ms timeout was rounded up to 2 s for Codex."]
  });
  assert.deepEqual(mapMcpAdvanced({ timeout: 30_000 }, "grok"), { advanced: { tool_timeout_sec: 30 }, notes: [] });
  assert.deepEqual(mapMcpAdvanced({ timeout: 30_000 }, "opencode"), { advanced: { timeout: 30_000 }, notes: [] });
  assert.deepEqual(mapMcpAdvanced({ timeout: 45_000 }, "claude"), { advanced: { timeout: 45_000 }, notes: [] });
  assert.deepEqual(mapMcpAdvanced({ tool_timeout_sec: 60 }, "claude"), { advanced: { timeout: 60_000 }, notes: [] });
  assert.deepEqual(mapMcpAdvanced({ tool_timeout_sec: 60 }, "opencode"), { advanced: { timeout: 60_000 }, notes: [] });

  const codex = {
    startup_timeout_sec: 10,
    tool_timeout_sec: 60,
    enabled_tools: ["a"],
    disabled_tools: ["b"],
    bearer_token_env_var: "JIRA_TOKEN",
    required: true,
    weird: 1
  };
  assert.deepEqual(mapMcpAdvanced(codex, "grok"), {
    advanced: { startup_timeout_sec: 10, tool_timeout_sec: 60, bearer_token_env_var: "JIRA_TOKEN" },
    notes: ["Dropped MCP settings Grok does not use: enabled_tools, disabled_tools, required, weird."]
  });
  assert.deepEqual(mapMcpAdvanced(codex, "claude"), {
    advanced: { timeout: 60_000 },
    notes: [
      "Dropped MCP settings Claude does not use: startup_timeout_sec, enabled_tools, disabled_tools, bearer_token_env_var, required, weird."
    ]
  });
  assert.deepEqual(mapMcpAdvanced({ startup_timeout_sec: 5, bearer_token_env_var: "T", tool_timeout_sec: 9 }, "codex"), {
    advanced: { startup_timeout_sec: 5, bearer_token_env_var: "T", tool_timeout_sec: 9 },
    notes: []
  });
  assert.deepEqual(mapMcpAdvanced({ timeout: "soon" }, "codex"), {
    advanced: {},
    notes: ["Dropped MCP settings Codex does not use: timeout."]
  });
  assert.deepEqual(mapMcpAdvanced(undefined, "codex"), { advanced: {}, notes: [] });
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
