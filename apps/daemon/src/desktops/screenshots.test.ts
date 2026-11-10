import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESKTOP_SCREENSHOTS_KEPT } from "@orquester/api";
import { desktopScreenshotsDir } from "@orquester/config";
import { DesktopScreenshotStore } from "./screenshots.ts";

const META = { width: 640, height: 400, scale: 2, origin: { x: 0, y: 0 }, display: { width: 1280, height: 800 } };

test("the newest 50 screenshots of a desktop are kept (0700 dir, 0600 files), their facts outlive a restart, and all go with the desktop", async (t) => {
  const appdir = await mkdtemp(join(tmpdir(), "orq-desktop-shots-"));
  t.after(() => rm(appdir, { recursive: true, force: true }));
  const store = new DesktopScreenshotStore(appdir, { warn: () => {} });
  const ids: string[] = [];
  for (let i = 0; i <= DESKTOP_SCREENSHOTS_KEPT; i += 1) {
    ids.push(await store.save("d1", { mimeType: i === 0 ? "image/jpeg" : "image/png", data: Buffer.from(`shot ${i}`) }, META));
  }
  const dir = desktopScreenshotsDir(appdir, "d1");
  assert.equal((await readdir(dir)).length, DESKTOP_SCREENSHOTS_KEPT * 2, "an image and its facts each");
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(dir, `${ids[1]}.png`))).mode & 0o777, 0o600);
  assert.equal(await store.read("d1", ids[0]!), null, "the oldest went");
  assert.equal(await store.meta("d1", ids[0]!), null);
  assert.deepEqual(await store.read("d1", ids.at(-1)!), { mimeType: "image/png", data: Buffer.from(`shot ${DESKTOP_SCREENSHOTS_KEPT}`) });
  assert.equal(await store.read("d1", "../d1"), null, "ids are the store's own");

  const restarted = new DesktopScreenshotStore(appdir, { warn: () => {} });
  assert.deepEqual(await restarted.meta("d1", ids[1]!), { mimeType: "image/png", ...META });
  // Its cap covers what an earlier run kept.
  await restarted.save("d1", { mimeType: "image/png", data: Buffer.from("after") }, META);
  assert.equal(await restarted.read("d1", ids[1]!), null);

  await restarted.remove("d1");
  assert.equal(await stat(dir).catch(() => null), null);
  assert.equal(await restarted.meta("d1", ids.at(-1)!), null);
});
