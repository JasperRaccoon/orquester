import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManualClock } from "../testing/manual-trigger-clock.ts";
import { createScheduler } from "./scheduler.ts";
import { WorkflowStateStore } from "../state-store.ts";
import { advance, fakeHost, memoryState, node, silentLogger, workflow } from "./test-support.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

function schedule(id: string, cron: string, preset: Record<string, unknown> = { kind: "cron" }) {
  return node(id, "trigger.schedule", { preset, cron });
}

function setup(start: string, workflows = [workflow("wf", [schedule("s1", "*/15 * * * *", { kind: "minutes", every: 15 })])]) {
  const clock = new ManualClock(start);
  const host = fakeHost(workflows);
  const state = memoryState();
  const scheduler = createScheduler({ host, state, clock, logger: silentLogger });
  const run = (ms: number) => advance(clock, () => scheduler.idle(), ms);
  return { clock, host, state, scheduler, run };
}

test("a new trigger is scheduled from now and fires at its time, once, with the schedule payload", async () => {
  const { host, scheduler, state, run } = setup("2026-09-28T10:07:30.000Z");
  await scheduler.start();
  assert.deepEqual(scheduler.triggerState("wf", "s1"), { nextRunAt: "2026-09-28T10:15:00.000Z", lastFiredAt: null });
  assert.equal(host.fired.length, 0);

  await run(7 * MIN + 29_000);
  assert.equal(host.fired.length, 0, "not before its time");
  await run(1_000);
  assert.equal(host.fired.length, 1);
  const { text: _text, ...fire } = host.fired[0]!;
  assert.deepEqual(fire, {
    workflowId: "wf",
    triggerNodeId: "s1",
    kind: "schedule",
    payload: { kind: "schedule", firedAt: "2026-09-28T10:15:00.000Z", scheduledFor: "2026-09-28T10:15:00.000Z" }
  });
  assert.deepEqual(state.get().schedules["wf:s1"], {
    cron: "*/15 * * * *",
    timezone: "UTC",
    nextRunAt: "2026-09-28T10:30:00.000Z",
    lastFiredAt: "2026-09-28T10:15:00.000Z"
  });
  await run(15 * MIN);
  assert.equal(host.fired.length, 2);
  scheduler.stop();
});

test("the cursor is persisted before the fire", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "orq-scheduler-durable-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "workflow-state.json");
  const state = new WorkflowStateStore({ path: file });
  const clock = new ManualClock("2026-09-28T10:14:00.000Z");
  const host = fakeHost([workflow("wf", [schedule("s1", "*/15 * * * *", { kind: "minutes", every: 15 })])]);
  const seen: (string | null)[] = [];
  host.onFire = () => seen.push(JSON.parse(readFileSync(file, "utf8")).schedules["wf:s1"].nextRunAt);
  const scheduler = createScheduler({ host, state, clock, logger: silentLogger });
  await scheduler.start();
  await advance(clock, () => scheduler.idle(), MIN);
  assert.deepEqual(seen, ["2026-09-28T10:30:00.000Z"]);
  scheduler.stop();
});

test("the timer never sleeps more than 60 s, and a clock jump is noticed within a minute", async () => {
  const daily = [workflow("wf", [schedule("s1", "0 9 * * *", { kind: "daily", time: "09:00" })])];
  const { clock, host, scheduler, run } = setup("2026-09-28T10:00:00.000Z", daily);
  await scheduler.start();
  await run(10 * MIN);
  // The machine sleeps through tomorrow's 09:00 by 5 minutes; the next tick fires it (within grace).
  clock.jump("2026-09-29T09:05:00.000Z");
  await run(60_000);
  assert.equal(host.fired.length, 1);
  assert.equal((host.fired[0]!.payload as { scheduledFor: string }).scheduledFor, "2026-09-29T09:00:00.000Z");
  assert.equal(scheduler.triggerState("wf", "s1")!.nextRunAt, "2026-09-30T09:00:00.000Z");
  scheduler.stop();
  await run(48 * HOUR);
  assert.equal(host.fired.length, 1);
});

test("boot: a run missed by less than the grace fires once; beyond it one missed stub, never a burst", async () => {
  // Within grace: the daemon was down 10 minutes past the scheduled time.
  const within = setup("2026-09-28T10:25:00.000Z");
  await within.state.update((draft) => {
    draft.schedules["wf:s1"] = { cron: "*/15 * * * *", timezone: "UTC", nextRunAt: "2026-09-28T10:15:00.000Z", lastFiredAt: null };
  });
  await within.scheduler.start();
  assert.equal(within.host.fired.length, 1);
  assert.equal(within.host.skipped.length, 0);
  assert.equal((within.host.fired[0]!.payload as { scheduledFor: string }).scheduledFor, "2026-09-28T10:15:00.000Z");
  assert.equal(within.scheduler.triggerState("wf", "s1")!.nextRunAt, "2026-09-28T10:30:00.000Z");
  within.scheduler.stop();

  // Three days down: ~288 slots passed — ONE skipped stub, zero runs, next slot from now.
  const long = setup("2026-10-01T10:20:00.000Z");
  await long.state.update((draft) => {
    draft.schedules["wf:s1"] = { cron: "*/15 * * * *", timezone: "UTC", nextRunAt: "2026-09-28T10:15:00.000Z", lastFiredAt: "2026-09-28T10:00:00.000Z" };
  });
  await long.scheduler.start();
  assert.equal(long.host.fired.length, 0);
  assert.equal(long.host.skipped.length, 1);
  assert.equal(long.host.skipped[0]!.reason, "missed");
  assert.equal((long.host.skipped[0]!.request.payload as { scheduledFor: string }).scheduledFor, "2026-09-28T10:15:00.000Z");
  assert.deepEqual(long.scheduler.triggerState("wf", "s1"), { nextRunAt: "2026-10-01T10:30:00.000Z", lastFiredAt: "2026-09-28T10:00:00.000Z" });
  await long.run(10 * MIN);
  assert.equal(long.host.fired.length, 1, "then the schedule simply resumes");
  assert.equal(long.host.skipped.length, 1);
  long.scheduler.stop();
});

test("edits rearm: a changed cron or zone recomputes from now; disable prunes, re-enable never fires a stale time; delete prunes", async () => {
  const { clock, host, scheduler, state, run } = setup("2026-09-28T10:07:00.000Z");
  await scheduler.start();
  assert.equal(scheduler.triggerState("wf", "s1")!.nextRunAt, "2026-09-28T10:15:00.000Z");

  host.put(workflow("wf", [schedule("s1", "0 * * * *", { kind: "hours", every: 1, atMinute: 0 })]));
  await scheduler.idle();
  assert.equal(scheduler.triggerState("wf", "s1")!.nextRunAt, "2026-09-28T11:00:00.000Z");

  host.put(workflow("wf", [schedule("s1", "0 * * * *", { kind: "hours", every: 1, atMinute: 0 })], { settings: { timezone: "Asia/Kolkata" } }));
  await scheduler.idle();
  // Kolkata is UTC+05:30: the next local top of the hour is 10:30Z.
  assert.equal(scheduler.triggerState("wf", "s1")!.nextRunAt, "2026-09-28T10:30:00.000Z");
  assert.equal(state.get().schedules["wf:s1"]!.timezone, "Asia/Kolkata");

  // Disabled: pruned, nothing fires while disabled.
  host.put(workflow("wf", [schedule("s1", "0 * * * *", { kind: "hours", every: 1, atMinute: 0 })], { enabled: false, settings: { timezone: "Asia/Kolkata" } }));
  await scheduler.idle();
  assert.equal(scheduler.triggerState("wf", "s1"), null);
  assert.deepEqual(state.get().schedules, {});
  clock.jump("2026-09-28T10:40:00.000Z");

  // Re-enabled after 10:30Z passed: computed from now, the 10:30 slot is not fired.
  host.put(workflow("wf", [schedule("s1", "0 * * * *", { kind: "hours", every: 1, atMinute: 0 })], { settings: { timezone: "Asia/Kolkata" } }));
  await scheduler.idle();
  assert.equal(host.fired.length + host.skipped.length, 0);
  assert.equal(scheduler.triggerState("wf", "s1")!.nextRunAt, "2026-09-28T11:30:00.000Z");
  await run(50 * MIN);
  assert.equal(host.fired.length, 1);

  host.remove("wf");
  await scheduler.idle();
  assert.deepEqual(state.get().schedules, {});
  scheduler.stop();
});

test("an unrelated edit keeps the cursor; a disabled node is not scheduled; an invalid cron warns once and never fires", async () => {
  const { host, scheduler, clock, run } = setup("2026-09-28T10:07:00.000Z", [
    workflow("wf", [
      schedule("s1", "*/15 * * * *", { kind: "minutes", every: 15 }),
      node("off", "trigger.schedule", { preset: { kind: "cron" }, cron: "* * * * *" }, { disabled: true }),
      schedule("bad", "61 * * * *")
    ])
  ]);
  await scheduler.start();
  assert.equal(scheduler.triggerState("wf", "off"), null);
  assert.deepEqual(scheduler.triggerState("wf", "bad"), { nextRunAt: null, lastFiredAt: null });
  clock.jump("2026-09-28T10:10:00.000Z");
  host.changed();
  await scheduler.idle();
  assert.equal(scheduler.triggerState("wf", "s1")!.nextRunAt, "2026-09-28T10:15:00.000Z", "unchanged cron keeps its next time");
  await run(HOUR);
  assert.deepEqual(new Set(host.fired.map((r) => r.triggerNodeId)), new Set(["s1"]));
  scheduler.stop();
});

test("a failed cursor write skips that one run but never stops the timer", async (t) => {
  const clock = new ManualClock("2026-09-28T10:14:00.000Z");
  const host = fakeHost([workflow("wf", [schedule("s1", "*/15 * * * *", { kind: "minutes", every: 15 })])]);
  const root = await mkdtemp(join(tmpdir(), "orq-scheduler-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "workflow-state.json");
  const state = new WorkflowStateStore({ path: file, logger: { warn() {}, error() {} } });
  const scheduler = createScheduler({ host, state, clock, logger: silentLogger });
  const run = (ms: number) => advance(clock, () => scheduler.idle(), ms);
  await scheduler.start();
  await rm(file);
  await mkdir(file);
  await run(MIN); // 10:15 — the write fails: no run, but the next time is armed
  assert.equal(host.fired.length, 0);
  assert.equal(scheduler.triggerState("wf", "s1")!.nextRunAt, "2026-09-28T10:30:00.000Z");
  await rm(file, { recursive: true });
  await run(15 * MIN); // 10:30 — writes work again
  assert.equal(host.fired.length, 1);
  assert.equal((host.fired[0]!.payload as { scheduledFor: string }).scheduledFor, "2026-09-28T10:30:00.000Z");
  scheduler.stop();
});

test("a failed write while reconciling still arms the timer", async (t) => {
  const clock = new ManualClock("2026-09-28T10:14:00.000Z");
  const host = fakeHost([workflow("wf", [schedule("s1", "*/15 * * * *", { kind: "minutes", every: 15 })])]);
  const root = await mkdtemp(join(tmpdir(), "orq-scheduler-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "workflow-state.json");
  await mkdir(file);
  const state = new WorkflowStateStore({ path: file, logger: { warn() {}, error() {} } });
  const scheduler = createScheduler({ host, state, clock, logger: silentLogger });
  await scheduler.start();
  await rm(file, { recursive: true });
  await advance(clock, () => scheduler.idle(), MIN);
  assert.equal(host.fired.length, 1);
  scheduler.stop();
});
