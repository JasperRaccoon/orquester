import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { type EmulatorRecord, parseHostState, planReattach, readHostState, serializeHostState, writeHostState } from "./state.ts";

const emulator = (serial: string, pid: number, leaseId: string | null, golden = false): EmulatorRecord => ({
  serial,
  pid,
  pgid: pid - 1,
  consolePort: Number(serial.slice(9)),
  grpcPort: 8570,
  profile: "pixel-9",
  avd: "orq-pixel-9",
  leaseId,
  golden,
  startedAt: "2026-10-27T00:00:00.000Z",
  logPath: `/logs/${serial}.log`
});

test("state file: unreadable entries are dropped, unknown keys kept on rewrite", () => {
  const parsed = parseHostState(
    JSON.stringify({
      version: 1,
      future: { keep: true },
      hub: { pid: 10, port: 4000, startedAt: "x" },
      emulators: [emulator("emulator-5586", 20, "L1"), { serial: "broken" }, "nope"]
    })
  );
  assert.equal(parsed.emulators.length, 1);
  assert.deepEqual(parsed.hub, { pid: 10, port: 4000, startedAt: "x" });
  const again = JSON.parse(serializeHostState(parsed));
  assert.deepEqual(again.future, { keep: true });
  assert.equal(again.emulators[0].serial, "emulator-5586");
  assert.deepEqual(parseHostState("not json"), { version: 1, hub: null, emulators: [], extra: {} });
  assert.equal(parseHostState(JSON.stringify({ hub: { pid: "x" } })).hub, null);
});

test("reattach: keep what runs under a live lease, reap running orphans and golden boots, forget the gone", () => {
  const state = parseHostState(
    JSON.stringify({
      hub: { pid: 10, port: 4000 },
      emulators: [emulator("emulator-5586", 20, "live"), emulator("emulator-5588", 21, "released"), emulator("emulator-5590", 22, "live2"), emulator("emulator-5592", 23, null, true), emulator("emulator-5594", 24, null)]
    })
  );
  const plan = planReattach(state, new Set([10, 20, 21, 23, 24]), new Set(["live", "live2"]));
  assert.deepEqual(plan.keep.map((e) => e.serial), ["emulator-5586"]);
  assert.deepEqual(plan.reap.map((e) => e.serial), ["emulator-5588", "emulator-5592", "emulator-5594"]);
  assert.deepEqual(plan.forget.map((e) => e.serial), ["emulator-5590"]);
  assert.equal(plan.hub, "reattach");
  assert.equal(planReattach(state, new Set([20]), new Set()).hub, "forget");
  assert.equal(planReattach(parseHostState("{}"), new Set(), new Set()).hub, "none");
});

test("state file: written atomically with mode 0600; a missing file reads empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orq-devices-state-"));
  try {
    const file = join(dir, "hub.json");
    assert.deepEqual((await readHostState(file)).emulators, []);
    await writeHostState(file, { version: 1, hub: null, emulators: [emulator("emulator-5586", 20, "L")], extra: {} });
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await readHostState(file)).emulators[0]?.leaseId, "L");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
