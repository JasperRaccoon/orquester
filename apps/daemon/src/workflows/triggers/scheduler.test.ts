import assert from "node:assert/strict";
import test from "node:test";
import { ManualClock } from "./clock.ts";
import { createScheduler, SCHEDULER_MAX_TIMER_MS } from "./scheduler.ts";
import { WorkflowStateStore } from "../state-store.ts";
import { advance, fakeHost, memoryState, node, recordingLogger, workflow } from "./test-support.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

function schedule(id: string, cron: string, preset: Record<string, unknown> = { kind: "cron" }) {
  return node(id, "trigger.schedule", { preset, cron });
}

function setup(start: string, workflows = [workflow("wf", [schedule("s1", "*/15 * * * *", { kind: "minutes", every: 15 })])]) {
  const clock = new ManualClock(start);
  const host = fakeHost(workflows);
  const state = memoryState();
  const logger = recordingLogger();
  const scheduler = createScheduler({ host, state, clock, logger });
  const run = (ms: number) => advance(clock, () => scheduler.idle(), ms);
  return { clock, host, state, logger, scheduler, run };
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
  assert.deepEqual(host.fired[0], {
    workflowId: "wf",
    triggerNodeId: "s1",
    kind: "schedule",
    payload: { kind: "schedule", firedAt: "2026-09-28T10:15:00.000Z", scheduledFor: "2026-09-28T10:15:00.000Z" },
    text: "Scheduled · Every 15 min"
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

test("the cursor is persisted before the fire", async () => {
  const { host, scheduler, state, run } = setup("2026-09-28T10:14:00.000Z");
  const seen: (string | null)[] = [];
  host.onFire = () => seen.push(state.get().schedules["wf:s1"]!.nextRunAt);
  await scheduler.start();
  await run(MIN);
  assert.deepEqual(seen, ["2026-09-28T10:30:00.000Z"]);
  scheduler.stop();
});

test("the timer never sleeps more than 60 s, and a clock jump is noticed within a minute", async () => {
  const daily = [workflow("wf", [schedule("s1", "0 9 * * *", { kind: "daily", time: "09:00" })])];
  const { clock, host, scheduler, run } = setup("2026-09-28T10:00:00.000Z", daily);
  await scheduler.start();
  assert.deepEqual(clock.pending(), [SCHEDULER_MAX_TIMER_MS]);
  await run(10 * MIN);
  assert.ok(clock.pending().every((ms) => ms <= SCHEDULER_MAX_TIMER_MS));
  // The machine sleeps through tomorrow's 09:00 by 5 minutes; the next tick fires it (within grace).
  clock.jump("2026-09-29T09:05:00.000Z");
  await run(SCHEDULER_MAX_TIMER_MS);
  assert.equal(host.fired.length, 1);
  assert.equal((host.fired[0]!.payload as { scheduledFor: string }).scheduledFor, "2026-09-29T09:00:00.000Z");
  assert.equal(scheduler.triggerState("wf", "s1")!.nextRunAt, "2026-09-30T09:00:00.000Z");
  scheduler.stop();
  assert.deepEqual(clock.pending(), [], "stop cancels the timer");
});

test("time zones and DST: Berlin across the October change, New York across both, Kolkata", async () => {
  const workflows = [
    workflow("berlin", [schedule("s", "0 9 * * *", { kind: "daily", time: "09:00" })], { settings: { timezone: "Europe/Berlin" } }),
    workflow("kolkata", [schedule("s", "0 9 * * *", { kind: "daily", time: "09:00" })], { settings: { timezone: "Asia/Kolkata" } })
  ];
  const { host, scheduler, run } = setup("2026-10-23T12:00:00.000Z", workflows);
  await scheduler.start();
  await run(4 * 24 * HOUR);
  const fires = (id: string) => host.fired.filter((r) => r.workflowId === id).map((r) => (r.payload as { scheduledFor: string }).scheduledFor);
  // CEST (UTC+2) until 2026-10-25 01:00Z, CET (UTC+1) after: 09:00 local moves from 07:00Z to 08:00Z.
  assert.deepEqual(fires("berlin"), ["2026-10-24T07:00:00.000Z", "2026-10-25T08:00:00.000Z", "2026-10-26T08:00:00.000Z", "2026-10-27T08:00:00.000Z"]);
  assert.deepEqual(fires("kolkata"), ["2026-10-24T03:30:00.000Z", "2026-10-25T03:30:00.000Z", "2026-10-26T03:30:00.000Z", "2026-10-27T03:30:00.000Z"]);
  scheduler.stop();

  // New York: 02:30 does not exist on 2027-03-14 and 01:30 happens twice on 2027-11-07 — one run each day.
  const ny = [
    workflow("spring", [schedule("s", "30 2 * * *")], { settings: { timezone: "America/New_York" } }),
    workflow("fall", [schedule("s", "30 1 * * *")], { settings: { timezone: "America/New_York" } })
  ];
  const spring = setup("2027-03-13T12:00:00.000Z", [ny[0]!]);
  await spring.scheduler.start();
  await spring.run(3 * 24 * HOUR);
  const springFires = spring.host.fired.map((r) => (r.payload as { scheduledFor: string }).scheduledFor);
  assert.equal(springFires.length, 3, "one run a day, none lost or doubled");
  assert.equal(springFires[1], "2027-03-15T06:30:00.000Z");
  spring.scheduler.stop();

  const fall = setup("2027-11-06T12:00:00.000Z", [ny[1]!]);
  await fall.scheduler.start();
  await fall.run(3 * 24 * HOUR);
  const fallFires = fall.host.fired.map((r) => (r.payload as { scheduledFor: string }).scheduledFor);
  assert.deepEqual(fallFires, ["2027-11-07T05:30:00.000Z", "2027-11-08T06:30:00.000Z", "2027-11-09T06:30:00.000Z"]);
  fall.scheduler.stop();
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
  assert.deepEqual(clock.pending(), []);
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
  assert.deepEqual(clock.pending(), []);
  scheduler.stop();
});

test("an unrelated edit keeps the cursor; a disabled node is not scheduled; an invalid cron warns once and never fires", async () => {
  const { host, scheduler, logger, clock, run } = setup("2026-09-28T10:07:00.000Z", [
    workflow("wf", [
      schedule("s1", "*/15 * * * *", { kind: "minutes", every: 15 }),
      node("off", "trigger.schedule", { preset: { kind: "cron" }, cron: "* * * * *" }, { disabled: true }),
      schedule("bad", "61 * * * *")
    ])
  ]);
  await scheduler.start();
  assert.equal(scheduler.triggerState("wf", "off"), null);
  assert.deepEqual(scheduler.triggerState("wf", "bad"), { nextRunAt: null, lastFiredAt: null });
  assert.equal(logger.lines.filter((line) => line.startsWith("warn:")).length, 1);
  clock.jump("2026-09-28T10:10:00.000Z");
  host.changed();
  await scheduler.idle();
  assert.equal(scheduler.triggerState("wf", "s1")!.nextRunAt, "2026-09-28T10:15:00.000Z", "unchanged cron keeps its next time");
  assert.equal(logger.lines.filter((line) => line.startsWith("warn:")).length, 1, "warned once");
  await run(HOUR);
  assert.deepEqual(new Set(host.fired.map((r) => r.triggerNodeId)), new Set(["s1"]));
  scheduler.stop();
});

test("a failed cursor write skips that one run but never stops the timer", async () => {
  const clock = new ManualClock("2026-09-28T10:14:00.000Z");
  const host = fakeHost([workflow("wf", [schedule("s1", "*/15 * * * *", { kind: "minutes", every: 15 })])]);
  let failWrites = false;
  const state = new WorkflowStateStore({
    path: "/nonexistent/workflow-state.json",
    logger: { warn() {}, error() {} },
    write: async () => {
      if (failWrites) throw new Error("ENOSPC");
    }
  });
  const logger = recordingLogger();
  const scheduler = createScheduler({ host, state, clock, logger });
  const run = (ms: number) => advance(clock, () => scheduler.idle(), ms);
  await scheduler.start();
  failWrites = true;
  await run(MIN); // 10:15 — the write fails: no run, but the next time is armed
  assert.equal(host.fired.length, 0);
  assert.equal(scheduler.triggerState("wf", "s1")!.nextRunAt, "2026-09-28T10:30:00.000Z");
  assert.ok(clock.pending().length > 0, "the timer is still armed");
  assert.ok(logger.lines.some((line) => line.includes("could not persist")));
  failWrites = false;
  await run(15 * MIN); // 10:30 — writes work again
  assert.equal(host.fired.length, 1);
  assert.equal((host.fired[0]!.payload as { scheduledFor: string }).scheduledFor, "2026-09-28T10:30:00.000Z");
  scheduler.stop();
});

test("a failed write while reconciling still arms the timer", async () => {
  const clock = new ManualClock("2026-09-28T10:14:00.000Z");
  const host = fakeHost([workflow("wf", [schedule("s1", "*/15 * * * *", { kind: "minutes", every: 15 })])]);
  let failWrites = true;
  const state = new WorkflowStateStore({
    path: "/nonexistent/workflow-state.json",
    logger: { warn() {}, error() {} },
    write: async () => {
      if (failWrites) throw new Error("EROFS");
    }
  });
  const scheduler = createScheduler({ host, state, clock, logger: recordingLogger() });
  await scheduler.start();
  assert.ok(clock.pending().length > 0);
  failWrites = false;
  await advance(clock, () => scheduler.idle(), MIN);
  assert.equal(host.fired.length, 1);
  scheduler.stop();
});
