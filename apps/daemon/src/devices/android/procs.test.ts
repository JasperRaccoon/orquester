import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { descendantsOf, establishedOnPort, isProcessAlive, parseMemAvailable, parseProcNetTcp, parseProcStat, processMatches, waitForExit } from "./procs.ts";

test("stat: comm with spaces and parentheses, ppid, pgrp, cpu ticks", () => {
  const stat = parseProcStat("4242 (qemu-system (x) 86) S 4240 4240 4240 0 -1 4194560 1 0 0 0 1500 250 0 0 20 0 9 0");
  assert.deepEqual(stat, { pid: 4242, comm: "qemu-system (x) 86", state: "S", ppid: 4240, pgrp: 4240, cpuTicks: 1750 });
  assert.equal(parseProcStat("garbage"), null);
});

test("descendants: children and grandchildren only", () => {
  const s = (pid: number, ppid: number) => ({ pid, ppid, pgrp: 1, comm: "x", state: "S", cpuTicks: 0 });
  const all = [s(10, 1), s(11, 10), s(12, 11), s(13, 1), s(14, 10)];
  assert.deepEqual(descendantsOf(10, all).map((stat) => stat.pid).sort(), [11, 12, 14]);
});

test("/proc/net/tcp: established connections accepted on a port", () => {
  const text = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:B8B3 00000000:0000 0A 00000000:00000000 00:00000000 00000000   999        0 1 1 0 100 0 0 10 0
   1: 0100007F:B8B3 0100007F:D2F0 01 00000000:00000000 00:00000000 00000000   999        0 2 1 0 20 4 30 10 -1
   2: 0100007F:D2F0 0100007F:B8B3 01 00000000:00000000 00:00000000 00000000   999        0 3 1 0 20 4 30 10 -1`;
  const rows = parseProcNetTcp(text);
  assert.equal(rows.length, 3);
  assert.equal(establishedOnPort(rows, 0xb8b3), 1);
  assert.equal(establishedOnPort(rows, 1234), 0);
});

test("meminfo: MemAvailable in bytes", () => {
  assert.equal(parseMemAvailable("MemTotal: 100 kB\nMemAvailable:    2048 kB\n"), 2048 * 1024);
  assert.equal(parseMemAvailable("MemTotal: 1 kB\n"), null);
});

test("processMatches: a live process is ours only with the appdir marker in its environment", async () => {
  const child = spawn("sleep", ["30"], { env: { ...process.env, ANDROID_AVD_HOME: "/tmp/orq-marker-test" } });
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await processMatches(child.pid!, { key: "ANDROID_AVD_HOME", value: "/tmp/orq-marker-test" }, ["sleep"]), true);
    assert.equal(await processMatches(child.pid!, { key: "ANDROID_AVD_HOME", value: "/elsewhere" }), false);
    assert.equal(await processMatches(child.pid!, { key: "ANDROID_AVD_HOME", value: "/tmp/orq-marker-test" }, ["qemu"]), false);
  } finally {
    child.kill("SIGKILL");
  }
  assert.equal(await waitForExit(child.pid!, 5_000), true);
  assert.equal(await isProcessAlive(child.pid!), false);
});
