/**
 * daemon.json at boot (`daemon-config.ts`): no routine rewrite, and a boot that
 * finds it emptied comes back on the last good copy instead of crash-looping.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";

import { resolveDaemonPaths, type DaemonPaths } from "@orquester/config";

import { lastGoodDaemonConfigPath, loadDaemonConfig } from "./daemon-config.ts";

const env = { ORQUESTER_HTTP_ENABLED: "true", ORQUESTER_HTTP_PASSWORD: "correct-horse-battery-staple" };

async function appdir(t: TestContext): Promise<DaemonPaths> {
  const dir = await mkdtemp(join(tmpdir(), "orquester-daemon-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  t.mock.method(console, "error", () => undefined);
  t.mock.method(console, "warn", () => undefined);
  return resolveDaemonPaths({ homeDir: dir, platform: "linux", cwd: dir, appdir: dir, env: {} });
}

test("a restart with the HTTP password in the environment leaves daemon.json as it was", async (t) => {
  const paths = await appdir(t);
  await loadDaemonConfig(paths, env);
  const before = await stat(paths.configPath);

  await loadDaemonConfig(paths, env);

  assert.equal((await stat(paths.configPath)).ino, before.ino);
});

test("a boot that finds daemon.json emptied restores the last good one and keeps the empty file aside", async (t) => {
  const paths = await appdir(t);
  await mkdir(dirname(paths.configPath), { recursive: true });
  await writeFile(paths.configPath, JSON.stringify({ workspacesDir: "/srv/work", logsDir: "/srv/logs" }));
  const good = await loadDaemonConfig(paths, env);
  const goodText = await readFile(paths.configPath, "utf8");
  await writeFile(paths.configPath, "");

  const restored = await loadDaemonConfig(paths, env);

  assert.deepEqual(restored, good);
  assert.equal(await readFile(paths.configPath, "utf8"), goodText);
  assert.equal(await readFile(lastGoodDaemonConfigPath(paths.configPath), "utf8"), goodText);
  const aside = (await readdir(dirname(paths.configPath))).filter((name) => name.startsWith("daemon.json.corrupt-"));
  assert.equal(aside.length, 1);
  assert.equal(await readFile(join(dirname(paths.configPath), aside[0]!), "utf8"), "");
});

test("an unreadable daemon.json with no last good copy fails the boot and is left untouched", async (t) => {
  const paths = await appdir(t);
  await mkdir(dirname(paths.configPath), { recursive: true });
  await writeFile(paths.configPath, "{");

  await assert.rejects(loadDaemonConfig(paths, env), /daemon\.json is unreadable/);

  assert.equal(await readFile(paths.configPath, "utf8"), "{");
});
