import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { editToml, getTomlPath, parseToml, renderTomlValue } from "./toml-patch.ts";

/** Shaped like this host's real `~/.grok/config.toml`, plus comments and an MCP server. */
const HOST_CONFIG = `# Grok config — hand-edited notes survive every edit
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
max_thoughts_width = 120
permission_mode = "always-approve"

# Claude's hooks would double-report status: keep them off.
[compat.claude]
hooks = false

[plugins]
enabled = [
  "superpowers",
  "hookify", # the rule writer
  "feature-dev",
  "lua-lsp"
]

# Serena, for symbol search
[mcp_servers.serena]
command = "serena"
args = ["start-mcp-server"]
env = { SERENA_TOKEN = "redacted-token" }

[mcp_servers.jira]
command = "node"

[mcp_servers.jira.env]
JIRA_API_TOKEN = "redacted"
`;

const COMPAT_BLOCK = `# Claude's hooks would double-report status: keep them off.
[compat.claude]
hooks = false
`;

describe("grok toml-patch", () => {
  it("adds a root list above the first table and keeps every comment", () => {
    const out = editToml(HOST_CONFIG, [{ op: "set", path: ["disabled_mcp_servers"], value: ["serena"] }]);
    assert.deepEqual(parseToml(out).disabled_mcp_servers, ["serena"]);
    assert.ok(out.startsWith('disabled_mcp_servers = [ "serena" ]\n\n# Grok config'));
    assert.ok(out.includes(COMPAT_BLOCK));
    assert.ok(out.includes('  "hookify", # the rule writer'));
    assert.ok(out.includes("  [[marketplace.sources]]\n  name = \"xAI Official\""));
  });

  it("adds a key to an existing table right after its last key, not after the next table's comment", () => {
    const out = editToml(HOST_CONFIG, [{ op: "set", path: ["plugins", "disabled"], value: ["lua-lsp"] }]);
    assert.ok(out.includes('  "lua-lsp"\n]\ndisabled = [ "lua-lsp" ]\n\n# Serena, for symbol search\n[mcp_servers.serena]'));
    assert.deepEqual(getTomlPath(parseToml(out), ["plugins", "disabled"]), ["lua-lsp"]);
  });

  it("edits the multi-line plugins array in place", () => {
    const out = editToml(HOST_CONFIG, [
      { op: "set", path: ["plugins", "enabled"], value: ["superpowers", "hookify", "feature-dev"] }
    ]);
    assert.deepEqual(getTomlPath(parseToml(out), ["plugins", "enabled"]), ["superpowers", "hookify", "feature-dev"]);
    assert.ok(out.includes('  "hookify", # the rule writer'));
    assert.ok(out.includes(COMPAT_BLOCK));
  });

  it("appends a new [mcp_servers.<name>] table at the end instead of a root dotted key", () => {
    const out = editToml(HOST_CONFIG, [
      { op: "set", path: ["mcp_servers", "files"], value: { command: "npx", args: ["-y", "fs"], env: { A: "1" } } }
    ]);
    assert.ok(out.endsWith('\n\n[mcp_servers.files]\ncommand = "npx"\nargs = [ "-y", "fs" ]\nenv = { A = "1" }\n'));
    assert.ok(out.startsWith("# Grok config"));
  });

  it("deletes a table with its sub-tables and leaves the rest byte-for-byte", () => {
    const out = editToml(HOST_CONFIG, [{ op: "delete", path: ["mcp_servers", "jira"] }]);
    assert.equal(getTomlPath(parseToml(out), ["mcp_servers", "jira"]), undefined);
    assert.ok(out.includes("[mcp_servers.serena]"));
    assert.ok(!out.includes("JIRA_API_TOKEN"));
    assert.ok(out.includes(COMPAT_BLOCK));
  });

  it("edits values of an existing server, inline and sub-table env alike", () => {
    const doc = parseToml(HOST_CONFIG);
    const serena = { ...(getTomlPath(doc, ["mcp_servers", "serena"]) as object), env: { SERENA_TOKEN: "x", B: "2" }, enabled: false };
    const jira = { command: "node", env: { JIRA_API_TOKEN: "new" } };
    const out = editToml(HOST_CONFIG, [
      { op: "set", path: ["mcp_servers", "serena"], value: serena },
      { op: "set", path: ["mcp_servers", "jira"], value: jira }
    ]);
    const parsed = parseToml(out);
    assert.deepEqual(getTomlPath(parsed, ["mcp_servers", "serena", "env"]), { SERENA_TOKEN: "x", B: "2" });
    assert.equal(getTomlPath(parsed, ["mcp_servers", "serena", "enabled"]), false);
    assert.deepEqual(getTomlPath(parsed, ["mcp_servers", "jira", "env"]), { JIRA_API_TOKEN: "new" });
    assert.ok(out.includes("# Serena, for symbol search\n[mcp_servers.serena]"));
    assert.ok(out.includes("[mcp_servers.jira.env]"));
  });

  it("creates a missing table for a new key at the end", () => {
    const out = editToml(HOST_CONFIG, [{ op: "set", path: ["skills", "disabled"], value: ["wip"] }]);
    assert.ok(out.endsWith('\n\n[skills]\ndisabled = [ "wip" ]\n'));
  });

  it("indents a key added to an indented table like its siblings", () => {
    const text = `[a]\n  x = 1\n  # trailing\n\n[b]\ny = 2\n`;
    const out = editToml(text, [{ op: "set", path: ["a", "z"], value: true }]);
    assert.equal(out, `[a]\n  x = 1\n  z = true\n  # trailing\n\n[b]\ny = 2\n`);
  });

  it("falls back to the library when the parent is an inline table", () => {
    const text = `mcp_servers = { a = { command = "x" } }\n`;
    const out = editToml(text, [{ op: "set", path: ["mcp_servers", "b"], value: { command: "y" } }]);
    assert.deepEqual(parseToml(out).mcp_servers, { a: { command: "x" }, b: { command: "y" } });
  });

  it("writes into an empty document and skips no-op edits", () => {
    assert.equal(editToml("", [{ op: "set", path: ["skills", "disabled"], value: ["a"] }]), '[skills]\ndisabled = [ "a" ]\n');
    assert.equal(editToml(HOST_CONFIG, [{ op: "delete", path: ["nope", "x"] }]), HOST_CONFIG);
    assert.equal(editToml(HOST_CONFIG, [{ op: "set", path: ["compat", "claude", "hooks"], value: false }]), HOST_CONFIG);
  });

  it("edits the trailing-comma arrays Grok's own CLI writes", () => {
    const grokWritten = `disabled_mcp_servers = [\n    "own-srv",\n    "claude-srv",\n]\n\n[cli]\nauto_update = false\n`;
    const out = editToml(grokWritten, [{ op: "set", path: ["disabled_mcp_servers"], value: ["own-srv"] }]);
    assert.deepEqual(parseToml(out).disabled_mcp_servers, ["own-srv"]);
    assert.ok(out.endsWith("[cli]\nauto_update = false\n"));
    const removed = editToml(grokWritten, [{ op: "delete", path: ["disabled_mcp_servers"] }]);
    assert.equal(parseToml(removed).disabled_mcp_servers, undefined);
  });

  it("refuses to set below a value that is not a table", () => {
    assert.throws(() => editToml(HOST_CONFIG, [{ op: "set", path: ["cli", "installer", "x"], value: 1 }]), /not a table/);
  });

  it("renders values on one line with quoted keys where needed", () => {
    assert.equal(renderTomlValue({ "X-Y": "1", "a b": "q\"" }), '{ X-Y = "1", "a b" = "q\\"" }');
    assert.equal(renderTomlValue(["a"]), '[ "a" ]');
    assert.throws(() => parseToml("a = "), Error);
  });
});
