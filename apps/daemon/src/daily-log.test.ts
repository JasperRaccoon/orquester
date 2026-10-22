import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { DailyLogStream, type DailyLogClock } from "./daily-log.ts";

/** A clock whose time and pending timer the test moves by hand. */
class FakeClock implements DailyLogClock {
  timer: { fn: () => void; at: number } | null = null;
  constructor(public ms: number) {}
  now(): number {
    return this.ms;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    this.timer = { fn, at: this.ms + ms };
    return this.timer;
  }
  clearTimeout(handle: unknown): void {
    if (this.timer === handle) this.timer = null;
  }
  /** Move to the pending timer's time and fire it. */
  fire(): void {
    const timer = this.timer;
    assert.ok(timer, "a timer is pending");
    this.timer = null;
    this.ms = timer.at;
    timer.fn();
  }
}

const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orq-daily-log-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("rolls over at local midnight without losing a line, and the timer fires at midnight", async () => {
  const clock = new FakeClock(local(2026, 10, 21, 23, 59));
  const log = new DailyLogStream({ logsDir: () => dir, clock });
  assert.equal(clock.timer?.at, local(2026, 10, 22), "armed for the next local midnight");
  for (let i = 0; i < 100; i += 1) log.write(`before ${i}\n`);
  clock.fire();
  assert.equal(log.path, join(dir, "2026-10-22.log"));
  for (let i = 0; i < 100; i += 1) log.write(`after ${i}\n`);
  assert.equal(clock.timer?.at, local(2026, 10, 23), "re-armed for the day after");
  await log.close();
  const before = await readFile(join(dir, "2026-10-21.log"), "utf8");
  const after = await readFile(join(dir, "2026-10-22.log"), "utf8");
  assert.equal(before, Array.from({ length: 100 }, (_, i) => `before ${i}\n`).join(""));
  assert.equal(after, Array.from({ length: 100 }, (_, i) => `after ${i}\n`).join(""));
  assert.equal(clock.timer, null, "close clears the timer");
});

test("a write after midnight goes to the new day even before the timer fires", async () => {
  const clock = new FakeClock(local(2026, 10, 21, 22));
  const log = new DailyLogStream({ logsDir: () => dir, clock });
  log.write("late\n");
  clock.ms = local(2026, 10, 23, 1); // slept through a whole day
  log.write("woke\n");
  await log.close();
  assert.equal(await readFile(join(dir, "2026-10-21.log"), "utf8"), "late\n");
  assert.equal(await readFile(join(dir, "2026-10-23.log"), "utf8"), "woke\n");
});

test("continues today's file at boot and starts a new part at the size cap", async () => {
  await writeFile(join(dir, "2026-10-22.log"), "x".repeat(8));
  const clock = new FakeClock(local(2026, 10, 22, 12));
  const log = new DailyLogStream({ logsDir: () => dir, clock, maxBytes: 10 });
  log.write("ab"); // 10 bytes: still fits
  log.write("cdef"); // would pass the cap: part 1
  log.write("ghijklmnopq"); // larger than the cap alone: part 2, written whole
  log.write("r");
  await log.close();
  assert.equal(await readFile(join(dir, "2026-10-22.log"), "utf8"), "xxxxxxxxab");
  assert.equal(await readFile(join(dir, "2026-10-22.1.log"), "utf8"), "cdef");
  assert.equal(await readFile(join(dir, "2026-10-22.2.log"), "utf8"), "ghijklmnopq");
  assert.equal(await readFile(join(dir, "2026-10-22.3.log"), "utf8"), "r");

  // A restart the same day continues the last part, or the next one when it is full.
  const again = new DailyLogStream({ logsDir: () => dir, clock, maxBytes: 10 });
  assert.equal(again.path, join(dir, "2026-10-22.3.log"));
  await again.close();
  const full = new DailyLogStream({ logsDir: () => dir, clock, maxBytes: 1 });
  assert.equal(full.path, join(dir, "2026-10-22.4.log"));
  await full.close();
});

test("prunes daily files older than the retention at boot and at each midnight, nothing else", async () => {
  const names = ["2026-10-01.log", "2026-10-07.log", "2026-10-07.3.log", "2026-10-08.log", "2026-10-21.log", "notes.txt", "2020-01-01.log.gz"];
  for (const name of names) await writeFile(join(dir, name), "old\n");
  const clock = new FakeClock(local(2026, 10, 22, 9));
  const log = new DailyLogStream({ logsDir: () => dir, clock, retentionDays: 14 });
  await log.settled();
  assert.deepEqual((await readdir(dir)).sort(), ["2020-01-01.log.gz", "2026-10-08.log", "2026-10-21.log", "2026-10-22.log", "notes.txt"]);
  clock.fire(); // 2026-10-23 00:00: 2026-10-08 is now 15 days old
  await log.settled();
  assert.deepEqual((await readdir(dir)).sort(), ["2020-01-01.log.gz", "2026-10-21.log", "2026-10-22.log", "2026-10-23.log", "notes.txt"]);
  await log.close();
});

test("a changed logs directory takes effect at the next rollover", async () => {
  let current = dir;
  const clock = new FakeClock(local(2026, 10, 21, 23));
  const log = new DailyLogStream({ logsDir: () => current, clock });
  log.write("one\n");
  current = join(dir, "moved");
  clock.fire();
  log.write("two\n");
  await log.close();
  assert.equal(await readFile(join(dir, "2026-10-21.log"), "utf8"), "one\n");
  assert.equal(await readFile(join(dir, "moved", "2026-10-22.log"), "utf8"), "two\n");
});
