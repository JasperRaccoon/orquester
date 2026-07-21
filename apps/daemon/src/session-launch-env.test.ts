import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { writeAddonEnvLaunchScript } from "./sessions.ts";

test("wrapper exports env and unsets requested keys", async () => {
  const w = await writeAddonEnvLaunchScript({ bin: "claude", args: ["--foo"] }, { CLAUDE_CONFIG_DIR: "/x/home" }, ["ANTHROPIC_API_KEY"]);
  const script = await readFile(w.args[0], "utf8");
  // This repo's shellQuote leaves shell-safe strings unquoted, so tolerate optional quotes.
  assert.match(script, /export CLAUDE_CONFIG_DIR='?\/x\/home'?/);
  assert.match(script, /unset ANTHROPIC_API_KEY/);
  assert.match(script, /exec '?claude'? '?--foo'?/);
  await w.cleanup();
});

test("wrapper still returns a script when only unsets are present (no env)", async () => {
  const w = await writeAddonEnvLaunchScript({ bin: "claude", args: [] }, {}, ["ANTHROPIC_API_KEY"]);
  assert.notEqual(w.bin, "claude"); // wrapped through a shell, not the bare bin
  const script = await readFile(w.args[0], "utf8");
  assert.match(script, /unset ANTHROPIC_API_KEY/);
  await w.cleanup();
});
