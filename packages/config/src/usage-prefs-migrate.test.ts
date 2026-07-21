import { test } from "node:test";
import assert from "node:assert/strict";
import { usagePrefsSchema, usageAgentEnabled } from "./index.ts";

test("legacy claude/codex booleans migrate into agents record", () => {
  const p = usagePrefsSchema.parse({ enabled: true, claude: true, codex: false });
  assert.equal(p.agents.claude, true);
  assert.equal(p.agents.codex, false);
});

test("new agents record passes through", () => {
  const p = usagePrefsSchema.parse({ enabled: true, agents: { claude: false } });
  assert.equal(usageAgentEnabled(p, "claude"), false);
  assert.equal(usageAgentEnabled(p, "codex"), true); // unknown → default enabled
});

test("disabled master switch overrides per-agent", () => {
  const p = usagePrefsSchema.parse({ enabled: false, agents: { claude: true } });
  assert.equal(usageAgentEnabled(p, "claude"), false);
});
