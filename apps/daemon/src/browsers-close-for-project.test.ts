import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserManager } from "./browsers.ts";

// closeForProject is the delete cascade (project, workspace and DELETE /api/fs):
// it must close the tabs of every project at or below the deleted path, under
// either spelling the route has, and nothing else. Tabs only record here — no
// Chromium launches until something subscribes.

async function managerWithTabs(t: test.TestContext, projects: string[]): Promise<BrowserManager> {
  const dir = await mkdtemp(join(tmpdir(), "orq-browsers-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manager = new BrowserManager({
    indexFile: join(dir, "browsers.json"),
    profilesDir: join(dir, "profiles"),
    resolveChromium: () => "/usr/bin/chromium"
  });
  for (const project of projects) await manager.create(project);
  return manager;
}

const projectsOf = (manager: BrowserManager): string[] => manager.list().map((tab) => tab.projectPath).sort();

test("closes the project's tabs and those of projects below it, not siblings sharing a prefix", async (t) => {
  const manager = await managerWithTabs(t, ["/ws/acme/game", "/ws/acme/game/sub", "/ws/acme/game-2", "/ws/other/app"]);
  await manager.closeForProject("/ws/acme/game");
  assert.deepEqual(projectsOf(manager), ["/ws/acme/game-2", "/ws/other/app"]);
});

test("matches any of the spellings passed (raw join and realpath)", async (t) => {
  const manager = await managerWithTabs(t, ["/tmp/ws/acme/game", "/private/tmp/ws/acme/site", "/ws/keep"]);
  await manager.closeForProject("/tmp/ws/acme", "/private/tmp/ws/acme");
  assert.deepEqual(projectsOf(manager), ["/ws/keep"]);
});
