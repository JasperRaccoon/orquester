/**
 * E20 — a provider CLI starts MCP servers of its own. Signalling only the
 * direct child leaves them running, reparented to init: one orphaned server
 * per chat session, for the life of the box.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { spawnProviderChild } from "./spawn.ts";

/** Alive per `kill(pid, 0)` — ESRCH means gone. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(label);
}

const node = process.execPath;

/**
 * A "provider" that spawns its own long-lived server and prints its pid — the
 * shape of a CLI bringing up an MCP server.
 */
const PARENT_SCRIPT = `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore"
});
process.stdout.write(String(child.pid) + "\\n");
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

    let out = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      out += chunk;
    });
    await waitFor(() => out.trim().length > 0, "the child never reported its grandchild");
    const grandchild = Number.parseInt(out.trim(), 10);
    assert.ok(Number.isFinite(grandchild) && grandchild > 0);
    assert.equal(isAlive(grandchild), true, "the grandchild is up before the kill");

    await child.kill();
    // The signal went to the group, so the grandchild goes too rather than
    // reparenting to init.
    await waitFor(() => !isAlive(grandchild), "the grandchild outlived the provider child");
  });

  it("an explicitly non-detached child still dies itself", async (t) => {
    if (process.platform === "win32") {
      t.skip("process groups are POSIX-only");
      return;
    }
    const child = spawnProviderChild({
      command: node,
      args: ["-e", "setInterval(() => {}, 1000)"],
      env: { PATH: process.env.PATH ?? "/usr/bin" },
      cwd: process.cwd(),
      detached: false
    });
    const pid = child.pid;
    assert.ok(pid !== undefined);
    await child.kill();
    await waitFor(() => !isAlive(pid!), "the child itself must always die");
  });
});
