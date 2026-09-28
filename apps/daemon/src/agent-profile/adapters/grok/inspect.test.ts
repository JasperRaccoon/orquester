import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseGrokInspect } from "./inspect.ts";

const FIXTURE = join(fileURLToPath(import.meta.url), "../../../../../test/fixtures/grok/12-cli-text/grok-inspect.json");

test("the recorded grok 1.0.34 inspect report parses into servers, skills and plugins", async () => {
  const report = parseGrokInspect(await readFile(FIXTURE, "utf8"));
  assert.ok(report);
  assert.deepEqual(
    report.mcpServers.map((server) => [server.name, server.sourceType]),
    [
      ["serena", "configToml"],
      ["jira-cloud", "claudeJson"],
      ["agent-browser", "claudeJson"]
    ]
  );
  assert.equal(report.skills[0]?.name, "chdb-datastore");
  assert.equal(report.skills[0]?.sourceType, "user");
  assert.deepEqual(report.plugins[0], {
    name: "hookify",
    scope: "user",
    path: "~/.claude/plugins/marketplaces/claude-plugins-official/plugins/hookify",
    provides: { skills: 1, agents: 1, hooks: true, mcpServers: 0 }
  });
});

test("plugin sources keep their plugin name; anything that is not a report is null", () => {
  const report = parseGrokInspect(
    JSON.stringify({
      mcpServers: [{ name: "p", source: { type: "plugin", plugin_name: "demo", path: "/x" } }, { nope: true }],
      skills: [{ name: "s", source: { type: "plugin", plugin_name: "demo", path: "/x/skills/s/SKILL.md" } }]
    })
  );
  assert.deepEqual(report?.mcpServers, [{ name: "p", sourceType: "plugin", sourcePath: "/x", pluginName: "demo" }]);
  assert.deepEqual(report?.plugins, []);
  assert.equal(parseGrokInspect("not json"), null);
  assert.equal(parseGrokInspect("{}"), null);
});
