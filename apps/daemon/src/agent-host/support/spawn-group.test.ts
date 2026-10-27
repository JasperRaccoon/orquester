/**
 * E20 — a provider CLI starts MCP servers of its own. Signalling only the
 * direct child leaves them running, reparented to init: one orphaned server
 * per chat session, for the life of the box.
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { describe, it } from "node:test";

import { spawnProviderChild } from "./spawn.ts";

const node = process.execPath;

/**
 * A "provider" that spawns its own long-lived server and prints its pid — the
 * shape of a CLI bringing up an MCP server.
 */
const PARENT_SCRIPT = `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", \`
  process.stdout.write("ready");
  setInterval(() => {}, 1000);
\`], { stdio: ["ignore", "pipe", "ignore"] });
child.stdout.once("data", () => process.stdout.write(String(child.pid) + "\\n"));
process.on("SIGTERM", () => {
  if (child.exitCode !== null || child.signalCode !== null) process.exit(0);
  child.once("exit", () => process.exit(0));
});
setInterval(() => {}, 1000);
`;

describe("spawnProviderChild kills the whole process group (E20)", () => {
  it("a grandchild dies with the provider child", async (t) => {
    if (process.platform === "win32") {
      t.skip("process groups are POSIX-only");
      return;
    }
    const child = spawnProviderChild({
      command: node,
      args: ["-e", PARENT_SCRIPT],
      env: { PATH: process.env.PATH ?? "/usr/bin" },
      cwd: process.cwd()
    });

    const lines = createInterface({ input: child.stdout });
    const [announcedPid] = await once(lines, "line");
    lines.close();
    const grandchild = Number.parseInt(String(announcedPid), 10);
    assert.ok(Number.isFinite(grandchild) && grandchild > 0);
    t.after(() => {
      try { process.kill(grandchild, "SIGKILL"); } catch { /* Already gone. */ }
    });
    assert.doesNotThrow(() => process.kill(grandchild, 0), "the grandchild is up before the kill");

    // The parent exits only after its child has exited; parent-only signals reach escalation.
    assert.deepEqual(await child.kill(), { kind: "exit", code: 0, signal: null });
  });

});
