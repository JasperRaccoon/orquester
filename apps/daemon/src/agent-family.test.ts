import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHooks, agentFamily } from "./agent-hooks.ts";

const silent = { error: () => {} };

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "orq-agent-family-"));
}

test("agentFamily maps the claudex/claudemix ids onto the claude family", () => {
  assert.equal(agentFamily("claude"), "claude");
  assert.equal(agentFamily("claudex"), "claude");
  assert.equal(agentFamily("claudemix"), "claude");
  assert.equal(agentFamily("codex"), "codex");
  assert.equal(agentFamily("opencode"), "opencode");
  assert.equal(agentFamily("gemini"), null);
  assert.equal(agentFamily("deepseek"), null);
});

test("claudex/claudemix map to claude family for BOTH target and installer dispatch", async () => {
  const s = await scratch();
  try {
    const home = join(s, "acc", ".claude");
    const hooks = new AgentHooks(join(s, "d"), join(s, "h"), silent);
    await hooks.ensureForEntry("claudex", { CLAUDE_CONFIG_DIR: home });

    // The claude-style installer ran (settings.json), NOT installOpenCode
    // (which would drop a plugin/orquester-status.js instead).
    assert.ok(existsSync(join(home, "settings.json")), "claude-style installer ran");
    assert.ok(!existsSync(join(home, "plugin", "orquester-status.js")), "opencode installer did NOT run");
    const settings = JSON.parse(await readFile(join(home, "settings.json"), "utf8"));
    const command: string = settings.hooks.Stop[0].hooks[0].command;
    assert.ok(command.endsWith(" claude Stop"), "hook source is the claude family, not the raw id");
  } finally {
    await rm(s, { recursive: true, force: true });
  }
});

test("claudemix installs claude-family hooks at its CLAUDE_CONFIG_DIR", async () => {
  const s = await scratch();
  try {
    const home = join(s, "mix", ".claude");
    const hooks = new AgentHooks(join(s, "d"), join(s, "h"), silent);
    await hooks.ensureForEntry("claudemix", { CLAUDE_CONFIG_DIR: home });
    assert.ok(existsSync(join(home, "settings.json")), "claude-style installer ran for claudemix");
  } finally {
    await rm(s, { recursive: true, force: true });
  }
});
