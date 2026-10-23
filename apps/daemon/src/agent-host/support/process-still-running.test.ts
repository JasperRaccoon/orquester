import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";

import { processStillRunning } from "./leftover-processes.ts";

test(
  "processStillRunning: a live process runs, an exited one is gone, a recycled pid is not it",
  { skip: process.platform !== "linux" },
  async () => {
    const seen = new Map<string, number>();
    assert.equal(processStillRunning(process.pid, seen, "self"), true);
    assert.equal(processStillRunning(process.pid, seen, "self"), true, "the same process at the second look");
    seen.set("self", -1);
    assert.equal(processStillRunning(process.pid, seen, "self"), false, "another starttime: the pid was recycled");

    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const pid = child.pid!;
    await once(child, "exit");
    assert.equal(processStillRunning(pid, new Map(), "child"), false, "an exited (reaped) child is gone");
  }
);
