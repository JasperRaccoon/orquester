import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHooks, agentFamily } from "./agent-hooks.ts";
import { claudeTimeoutEnv } from "./agent-timeout-env.ts";

const silent = { error: () => {} };

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "orq-agent-family-"));
}

test("agentFamily maps each launcher id onto its family", () => {
  assert.equal(agentFamily("claude"), "claude");
  assert.equal(agentFamily("codex"), "codex");
  assert.equal(agentFamily("opencode"), "opencode");
  assert.equal(agentFamily("grok"), "grok");
  assert.equal(agentFamily("gemini"), null);
  assert.equal(agentFamily("deepseek"), null);
  // The retired model-proxy launchers are no family at all.
  assert.equal(agentFamily("claudex"), null);
  assert.equal(agentFamily("claudemix"), null);
});

test("grok is its own family and gets no claude timeout env", () => {
  assert.equal(claudeTimeoutEnv("grok", 30), null);
});

test("claude installs claude-family hooks at its CLAUDE_CONFIG_DIR, never the opencode plugin", async () => {
  const s = await scratch();
  try {
    const home = join(s, "acc", ".claude");
    const hooks = new AgentHooks(join(s, "d"), join(s, "h"), silent);
    await hooks.ensureForEntry("claude", { CLAUDE_CONFIG_DIR: home });

    // The claude-style installer ran (settings.json), NOT installOpenCode
    // (which would drop a plugin/orquester-status.js instead).
    assert.ok(existsSync(join(home, "settings.json")), "claude-style installer ran");
    assert.ok(!existsSync(join(home, "plugin", "orquester-status.js")), "opencode installer did NOT run");
    const settings = JSON.parse(await readFile(join(home, "settings.json"), "utf8"));
    const command: string = settings.hooks.Stop[0].hooks[0].command;
    assert.ok(command.endsWith(" claude Stop"), "hook source is the claude family");
  } finally {
    await rm(s, { recursive: true, force: true });
  }
});

test("a retired launcher id installs nothing", async () => {
  const s = await scratch();
  try {
    const home = join(s, "mix", ".claude");
    const hooks = new AgentHooks(join(s, "d"), join(s, "h"), silent);
    await hooks.ensureForEntry("claudemix", { CLAUDE_CONFIG_DIR: home });
    assert.ok(!existsSync(join(home, "settings.json")), "no managed hooks for an unknown id");
  } finally {
    await rm(s, { recursive: true, force: true });
  }
});
