import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, watch } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LOCAL_EXECUTOR } from "./executor.ts";
import { processMatches, waitForExit } from "./procs.ts";

test("local executor: atomic text files, missing reads, listings", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orq-exec-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "a", "b.json");
  assert.equal(await LOCAL_EXECUTOR.readText(file), null);
  await LOCAL_EXECUTOR.writeText(file, "{}\n", { mode: 0o600 });
  assert.equal(await LOCAL_EXECUTOR.readText(file), "{}\n");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await LOCAL_EXECUTOR.list(join(dir, "a")), ["b.json"]);
  assert.deepEqual(await LOCAL_EXECUTOR.list(join(dir, "missing")), []);
  assert.equal(await LOCAL_EXECUTOR.exists(file), true);
  await LOCAL_EXECUTOR.remove(join(dir, "a"));
  assert.equal(await LOCAL_EXECUTOR.exists(file), false);
});

test("local executor: a detached process leads its own group and logs to its file; signals never reach kill(-1)", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orq-exec-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = join(dir, "out.log");
  const notifications = new AbortController();
  const started = (async () => {
    for await (const _event of watch(dir, { signal: notifications.signal })) {
      if ((await readFile(log, "utf8").catch(() => "")).includes("started")) return;
    }
  })();
  let pid: number | null = null;
  t.after(async () => {
    notifications.abort();
    await started.catch(() => undefined);
    if (pid !== null && await processMatches(pid, { key: "ANDROID_AVD_HOME", value: dir })) await LOCAL_EXECUTOR.signal(pid, pid, "SIGKILL");
  });
  pid = await LOCAL_EXECUTOR.spawnDetached("/bin/sh", ["-c", "echo started; exec sleep 30"], { env: { PATH: process.env.PATH, ANDROID_AVD_HOME: dir }, cwd: dir, logPath: log });
  await started;
  const stat = await LOCAL_EXECUTOR.procStat(pid);
  assert.equal(stat?.pgrp, pid);
  const kill = t.mock.method(process, "kill", () => true);
  try {
    assert.equal(await LOCAL_EXECUTOR.signal(null, -1, "SIGTERM"), false);
  } finally {
    kill.mock.restore();
  }
  assert.equal(await LOCAL_EXECUTOR.signal(pid, -1, "SIGTERM"), true);
  assert.equal(await waitForExit(pid, 5_000, 50, LOCAL_EXECUTOR), true);
  assert.match(await readFile(log, "utf8"), /started/);
  assert.equal(await LOCAL_EXECUTOR.isPortFree(await LOCAL_EXECUTOR.pickFreePort()), true);
});
