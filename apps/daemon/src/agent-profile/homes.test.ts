import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { resolveAgentHomes } from "./homes.ts";

const HOME = "/home/daemon";

test("resolveAgentHomes: the CLIs' defaults under HOME when no variable is set", () => {
  assert.deepEqual(resolveAgentHomes({}, HOME), {
    home: HOME,
    claudeDir: join(HOME, ".claude"),
    claudeJson: join(HOME, ".claude.json"),
    codexHome: join(HOME, ".codex"),
    grokHome: join(HOME, ".grok"),
    opencodeDir: join(HOME, ".config", "opencode"),
    agentsSkillsDir: join(HOME, ".agents", "skills")
  });
});

test("resolveAgentHomes: every override variable wins, and CLAUDE_CONFIG_DIR moves .claude.json with it", () => {
  const homes = resolveAgentHomes(
    {
      CLAUDE_CONFIG_DIR: "/cfg/claude",
      CODEX_HOME: "/cfg/codex",
      GROK_HOME: "/cfg/grok",
      OPENCODE_CONFIG_DIR: "/cfg/opencode"
    },
    HOME
  );
  assert.equal(homes.claudeDir, "/cfg/claude");
  assert.equal(homes.claudeJson, join("/cfg/claude", ".claude.json"));
  assert.equal(homes.codexHome, "/cfg/codex");
  assert.equal(homes.grokHome, "/cfg/grok");
  assert.equal(homes.opencodeDir, "/cfg/opencode");
  // ~/.agents/skills has no override: it is always under HOME.
  assert.equal(homes.agentsSkillsDir, join(HOME, ".agents", "skills"));
});

test("resolveAgentHomes: an empty variable counts as unset, as in agent-hooks and agent-accounts", () => {
  const homes = resolveAgentHomes({ CLAUDE_CONFIG_DIR: "", CODEX_HOME: "", GROK_HOME: "", OPENCODE_CONFIG_DIR: "" }, HOME);
  assert.equal(homes.claudeDir, join(HOME, ".claude"));
  assert.equal(homes.claudeJson, join(HOME, ".claude.json"));
  assert.equal(homes.codexHome, join(HOME, ".codex"));
  assert.equal(homes.grokHome, join(HOME, ".grok"));
  assert.equal(homes.opencodeDir, join(HOME, ".config", "opencode"));
});
