import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { writeAddonEnvLaunchScript } from "./sessions.ts";

test("launcher child receives env overrides, removals and literal arguments", async () => {
  const child = {
    bin: process.execPath,
    args: ["-e", "process.stdout.write(JSON.stringify({ home: process.env.CLAUDE_CONFIG_DIR, key: process.env.ANTHROPIC_API_KEY, args: process.argv.slice(1) }))", "a b", "$(echo injected)"]
  };
  const launch = await writeAddonEnvLaunchScript(child, { CLAUDE_CONFIG_DIR: "/x/home with 'quotes'" }, ["ANTHROPIC_API_KEY"]);
  try {
    const { stdout } = await promisify(execFile)(launch.bin, launch.args, { env: { ...process.env, ANTHROPIC_API_KEY: "inherited-secret" } });
    assert.deepEqual(JSON.parse(stdout), { home: "/x/home with 'quotes'", args: ["a b", "$(echo injected)"] });
  } finally {
    await launch.cleanup();
  }
});

test("launcher removes inherited credentials even without env overrides", async () => {
  const launch = await writeAddonEnvLaunchScript({
    bin: process.execPath,
    args: ["-e", "process.stdout.write(JSON.stringify({ key: process.env.ANTHROPIC_API_KEY }))"]
  }, {}, ["ANTHROPIC_API_KEY"]);
  try {
    const { stdout } = await promisify(execFile)(launch.bin, launch.args, { env: { ...process.env, ANTHROPIC_API_KEY: "inherited-secret" } });
    assert.deepEqual(JSON.parse(stdout), {});
  } finally {
    await launch.cleanup();
  }
});
