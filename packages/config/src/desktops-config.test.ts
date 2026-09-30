import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESKTOP_DEFAULT_RENDER_THREADS,
  DESKTOP_MAX_RECENT_LAUNCHES,
  createDefaultDesktopsFile,
  desktopRuntimeDir,
  desktopsIndexPath,
  desktopsRuntimeDir,
  parseDesktopsFile,
  serializeDesktopsFile
} from "./index.ts";

const desktop = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "d-1",
  projectPath: "/ws/acme/game",
  createdAt: "2026-09-30T10:00:00.000Z",
  ...overrides
});

const app = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "a-1",
  desktopId: "d-1",
  command: "xterm",
  cwd: "/ws/acme/game",
  startedAt: "2026-09-30T10:01:00.000Z",
  ...overrides
});

test("desktop paths live under the daemon dir", () => {
  assert.equal(desktopsIndexPath("/appdir"), "/appdir/daemon/desktops.json");
  assert.equal(desktopsRuntimeDir("/appdir"), "/appdir/daemon/desktops");
  assert.equal(desktopRuntimeDir("/appdir", "abc"), "/appdir/daemon/desktops/abc");
});

test("defaults are applied to desktop and app records", () => {
  const file = parseDesktopsFile({ version: 1, desktops: [desktop({ apps: [app()] })] });
  assert.equal(file.desktops.length, 1);
  const [record] = file.desktops;
  assert.equal(record.title, "Desktop");
  assert.equal(record.order, 0);
  assert.equal(record.display, null);
  assert.deepEqual(record.size, { width: 1280, height: 800 });
  assert.equal(record.renderThreads, DESKTOP_DEFAULT_RENDER_THREADS);
  assert.equal(record.socketDir, null);
  const [launched] = record.apps;
  assert.deepEqual(launched.env, {});
  assert.equal(launched.exitCode, null);
  assert.equal(launched.pgid, null);
  assert.equal(launched.exitedAt, null);
  // A missing status is not trusted as running.
  assert.equal(launched.status, "exited");
  assert.deepEqual(parseDesktopsFile({}), createDefaultDesktopsFile());
});

test("unknown record fields and top-level keys survive a parse/serialise round trip", () => {
  const raw = {
    version: 1,
    futureKey: { nested: [1, 2] },
    desktops: [desktop({ audio: true, video: "h264", apps: [app({ status: "running", pgid: 42, gpu: "none" })] })],
    recent: {}
  };
  const out = serializeDesktopsFile(parseDesktopsFile(raw));
  assert.deepEqual(out.futureKey, { nested: [1, 2] });
  const [record] = out.desktops as Array<Record<string, unknown>>;
  assert.equal(record.audio, true);
  assert.equal(record.video, "h264");
  const [launched] = record.apps as Array<Record<string, unknown>>;
  assert.equal(launched.gpu, "none");
  assert.equal(launched.pgid, 42);
  assert.deepEqual(parseDesktopsFile(JSON.parse(JSON.stringify(out))), parseDesktopsFile(raw));
});

test("a bad record is kept verbatim in rejected while the good ones load", () => {
  const bad = { id: 7, projectPath: ["nope"] };
  const duplicate = desktop({ title: "Second d-1" });
  const file = parseDesktopsFile({ version: 1, desktops: [desktop(), bad, duplicate, desktop({ id: "d-2" })] });
  assert.deepEqual(file.desktops.map((d) => d.id), ["d-1", "d-2"]);
  assert.deepEqual(file.rejected, [bad, duplicate]);
  const out = serializeDesktopsFile(file);
  assert.deepEqual((out.desktops as unknown[]).slice(2), [bad, duplicate]);
});

test("the outer shape still throws (quarantine, never overwrite)", () => {
  assert.throws(() => parseDesktopsFile({ version: 2, desktops: [] }));
  assert.throws(() => parseDesktopsFile({ version: 1, desktops: "nope" }));
});

test("size is clamped to the display bounds", () => {
  const [small, large, odd] = parseDesktopsFile({
    version: 1,
    desktops: [
      desktop({ id: "s", size: { width: 10, height: 10 } }),
      desktop({ id: "l", size: { width: 100000, height: 100000 } }),
      desktop({ id: "o", size: { width: 1279.6, height: 800.4 } })
    ]
  }).desktops;
  assert.deepEqual(small.size, { width: 320, height: 240 });
  assert.deepEqual(large.size, { width: 7680, height: 4320 });
  assert.deepEqual(odd.size, { width: 1280, height: 800 });
});

test("recent launches are capped per project; unreadable entries are set aside, not used", () => {
  const launches = Array.from({ length: DESKTOP_MAX_RECENT_LAUNCHES + 5 }, (_, i) => ({
    command: `app-${i}`,
    cwd: "/ws/acme/game",
    lastUsedAt: "2026-09-30T10:00:00.000Z"
  }));
  const file = parseDesktopsFile({
    version: 1,
    desktops: [],
    recent: { "/ws/acme/game": [{ command: 5 }, ...launches], "/ws/acme/other": "nope" }
  });
  const recent = file.recent["/ws/acme/game"];
  assert.equal(recent.length, DESKTOP_MAX_RECENT_LAUNCHES);
  assert.equal(recent[0].command, "app-0");
  assert.deepEqual(recent[0].env, {});
  assert.equal(file.recent["/ws/acme/other"], undefined);
});

test("unreadable recent entries are written back verbatim", () => {
  const file = parseDesktopsFile({
    version: 1,
    desktops: [],
    recent: {
      "/ws/acme/game": [{ command: 5 }, { command: "xterm", cwd: "/ws/acme/game", lastUsedAt: "2026-09-30T10:00:00.000Z" }],
      "/ws/acme/other": "nope"
    }
  });
  const written = serializeDesktopsFile(file).recent as Record<string, unknown[]>;
  assert.deepEqual(written["/ws/acme/game"].slice(1), [{ command: 5 }]);
  assert.deepEqual(written["/ws/acme/other"], ["nope"]);
});

test("one unreadable app entry is kept verbatim and does not wipe the others", () => {
  const good = {
    id: "a-1",
    desktopId: "d-1",
    command: "xterm",
    cwd: "/ws/acme/game",
    startedAt: "2026-09-30T10:00:00.000Z"
  };
  const bad = { id: "a-2", desktopId: "d-1", pgid: "not-a-number", future: true };
  const file = parseDesktopsFile({ version: 1, desktops: [desktop({ apps: [good, bad] })] });
  assert.deepEqual(file.desktops[0].apps.map((app) => app.id), ["a-1"]);
  const written = serializeDesktopsFile(file).desktops as Array<{ apps: unknown[]; rejectedApps?: unknown }>;
  assert.equal(written[0].apps.length, 2);
  assert.deepEqual(written[0].apps[1], bad);
  assert.equal(written[0].rejectedApps, undefined);
});

test("records keep the client's projectPath spelling beside the realpath", () => {
  const file = parseDesktopsFile({ version: 1, desktops: [desktop({ projectRealPath: "/real/acme/game" })] });
  assert.equal(file.desktops[0].projectPath, "/ws/acme/game");
  assert.equal(file.desktops[0].projectRealPath, "/real/acme/game");
  assert.equal(parseDesktopsFile({ version: 1, desktops: [desktop()] }).desktops[0].projectRealPath, null);
});
