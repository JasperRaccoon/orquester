import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  appForPid,
  DesktopWindowNotFoundError,
  DesktopWindowTracker,
  formatWindowId,
  parseProcStat,
  parseWindowId,
  readProcStat,
  type ProcStat
} from "./windows.ts";
import { encodeXauthEntry, MIT_MAGIC_COOKIE } from "./x11/xauth.ts";

test("parseProcStat reads ppid and pgrp after a comm with spaces and parentheses", () => {
  assert.deepEqual(parseProcStat("4242 (my (odd) app) S 4100 4000 4000 0 -1 4194560 120 0 0 0"), { ppid: 4100, pgrp: 4000 });
  assert.deepEqual(parseProcStat("1 (systemd) S 0 1 1 0 -1"), { ppid: 0, pgrp: 1 });
  assert.equal(parseProcStat("garbage"), null);
  assert.equal(parseProcStat("5 (x) S"), null);
});

test("readProcStat reads this process and returns null for a missing pid", () => {
  const own = readProcStat(process.pid);
  assert.ok(own);
  assert.equal(own.ppid, process.ppid);
  assert.equal(readProcStat(0x7ffffffe), null);
});

/** A fake process table: pid → {ppid, pgrp}. */
const table = (entries: Record<number, ProcStat>) => (pid: number): ProcStat | null => entries[pid] ?? null;

test("appForPid: the process's own group matches", () => {
  const read = table({ 500: { ppid: 400, pgrp: 500 } });
  assert.equal(appForPid(500, (pgid) => (pgid === 500 ? "app1" : null), read), "app1");
});

test("appForPid: walks ancestors whose groups differ (a child that made its own group)", () => {
  // app (pgid 300) → shell 310 in group 310 → game 320 in group 320
  const read = table({
    320: { ppid: 310, pgrp: 320 },
    310: { ppid: 300, pgrp: 310 },
    300: { ppid: 200, pgrp: 300 },
    200: { ppid: 1, pgrp: 200 }
  });
  const app = appForPid(320, (pgid) => pgid === 300 ? "app2" : null, read);
  assert.equal(app, "app2");
});

test("appForPid: unmatched up to pid 1, a vanished process, and a ppid cycle all give null", () => {
  const none = (): string | null => null;
  const read = table({ 50: { ppid: 40, pgrp: 50 }, 40: { ppid: 1, pgrp: 40 }, 1: { ppid: 0, pgrp: 1 } });
  assert.equal(appForPid(50, none, read), null);
  assert.equal(appForPid(60, () => "x", read), null, "missing /proc entry");
  const cycle = table({ 70: { ppid: 71, pgrp: 70 }, 71: { ppid: 70, pgrp: 71 } });
  assert.equal(appForPid(70, none, cycle), null);
  assert.equal(appForPid(1, () => "x", read), null);
});

test("window ids are 0x-prefixed lowercase hex", () => {
  assert.equal(formatWindowId(0x40000a), "0x40000a");
  assert.equal(parseWindowId("0x40000a"), 0x40000a);
  assert.equal(parseWindowId("0x40000A"), 0x40000a);
  for (const bad of ["40000a", "0x", "0x0", "0x123456789", "0xzz", " 0x1"]) assert.equal(parseWindowId(bad), null, bad);
});

test("start rejects when the display is unreachable; actions on unknown windows throw DesktopWindowNotFoundError", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orq-windows-"));
  try {
    const xauthorityPath = join(dir, "Xauthority");
    await writeFile(xauthorityPath, encodeXauthEntry({ family: 0xffff, address: Buffer.alloc(0), number: "", name: MIT_MAGIC_COOKIE, data: Buffer.alloc(16, 1) }));
    // Display numbers are 16-bit in practice; nothing listens at this one.
    const tracker = new DesktopWindowTracker({ display: 65_432, xauthorityPath, appForPgid: () => null });
    await assert.rejects(tracker.start());
    assert.deepEqual(tracker.snapshot(), { windows: [], activeWindowId: null });
    await assert.rejects(tracker.action("0x400001", "close"), DesktopWindowNotFoundError);
    await assert.rejects(tracker.action("nope", "activate"), DesktopWindowNotFoundError);
    tracker.stop();

    const missingAuth = new DesktopWindowTracker({ display: 65_432, xauthorityPath: join(dir, "missing"), appForPgid: () => null });
    await assert.rejects(missingAuth.start(), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
