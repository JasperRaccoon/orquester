import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentHooks } from "./agent-hooks.ts";

const silent = { error: () => {} };

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "orq-agent-family-"));
}

test("a retired launcher id installs nothing", async () => {
  const s = await scratch();
  try {
    const hooks = new AgentHooks(join(s, "d"), join(s, "h"), silent);
    for (const id of ["claudex", "claudemix"]) {
      const home = join(s, id, ".claude");
      await hooks.ensureForEntry(id, { CLAUDE_CONFIG_DIR: home });
      assert.equal(existsSync(home), false, `${id} must not modify agent configuration`);
    }
  } finally {
    await rm(s, { recursive: true, force: true });
  }
});
