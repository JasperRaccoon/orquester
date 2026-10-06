import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { editToml, getTomlPath, parseToml } from "./toml-patch.ts";

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

  it("deletes a table with its sub-tables and leaves the rest byte-for-byte", () => {
    const out = editToml(HOST_CONFIG, [{ op: "delete", path: ["mcp_servers", "jira"] }]);
    assert.equal(getTomlPath(parseToml(out), ["mcp_servers", "jira"]), undefined);
    assert.ok(out.includes("[mcp_servers.serena]"));
    assert.ok(!out.includes("JIRA_API_TOKEN"));
    assert.ok(out.includes(COMPAT_BLOCK));
  });


  it("adds a server when mcp_servers is an inline table", () => {
    const text = `mcp_servers = { a = { command = "x" } }\n`;
    const out = editToml(text, [{ op: "set", path: ["mcp_servers", "b"], value: { command: "y" } }]);
    assert.deepEqual(parseToml(out).mcp_servers, { a: { command: "x" }, b: { command: "y" } });
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
    assert.throws(() => editToml(HOST_CONFIG, [{ op: "set", path: ["cli", "installer", "x"], value: 1 }]));
  });
});
