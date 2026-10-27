import assert from "node:assert/strict";
import test from "node:test";

import { allocateEmulatorPorts, consolePortCandidates, consolePortOf, emulatorArgs, grpcPortFor, kvmCommand, serialOf, signalLauncher, stopEmulator } from "./emulator.ts";
import { execFile, type ExecFn } from "./exec.ts";
import type { DeviceExecutor } from "./executor.ts";

test("flags: a lease boots read-only from the snapshot without saving; a golden boot is cold and writable", () => {
  const lease = emulatorArgs({ avd: "orq-pixel-9", consolePort: 5586, grpcPort: 8570 });
  for (const flag of ["-read-only", "-no-window", "-no-audio", "-no-boot-anim", "-no-metrics", "-grpc-use-token", "-no-snapshot-save"]) assert.ok(lease.includes(flag), flag);
  for (const [flag, value] of [["-avd", "orq-pixel-9"], ["-accel", "on"], ["-gpu", "swangle_indirect"], ["-port", "5586"], ["-grpc", "8570"], ["-camera-back", "none"], ["-camera-front", "none"]]) {
    assert.equal(lease[lease.indexOf(flag!) + 1], value);
  }
  const golden = emulatorArgs({ avd: "orq-pixel-9", consolePort: 5554, grpcPort: 8554, golden: true });
  assert.equal(golden.includes("-read-only"), false);
  assert.equal(golden.includes("-no-snapshot-save"), false);
  assert.ok(golden.includes("-no-snapshot-load"));
});

test("ports: even console ports in 5554–5682, above adb's scan range first; gRPC per console port", () => {
  const ports = consolePortCandidates();
  assert.equal(ports.length, 65);
  assert.equal(ports[0], 5586);
  assert.ok(ports.every((port) => port % 2 === 0 && port >= 5554 && port <= 5682));
  assert.equal(new Set(ports).size, ports.length);
  assert.equal(ports.at(-1), 5584);
  assert.equal(grpcPortFor(5554), 8554);
  assert.equal(grpcPortFor(5682), 8618);
  assert.equal(serialOf(5586), "emulator-5586");
  assert.equal(consolePortOf("emulator-5586"), 5586);
  assert.equal(consolePortOf("R58M"), null);
});

test("ports: skips taken ports and ports busy on the machine (console, adb +1, gRPC)", async () => {
  const busy = new Set([5587, 8572]); // 5586's adb port, 5590's gRPC port
  const got = await allocateEmulatorPorts(new Set([5588]), async (port) => !busy.has(port));
  assert.deepEqual(got, { consolePort: 5592, grpcPort: 8573 });
  assert.equal(await allocateEmulatorPorts(new Set(), async () => false), null);
});

test("kvm: direct execution preserves argv; sg shell quoting does not expand text", async () => {
  assert.deepEqual(kvmCommand("direct", "/sdk/emulator/emulator", ["-avd", "x"]), { command: "/sdk/emulator/emulator", args: ["-avd", "x"] });
  const wrapped = kvmCommand("sg", process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "it's", "$(printf injected)", "a b"]);
  assert.equal(wrapped.command, "sg");
  assert.equal(wrapped.args[0], "kvm");
  const result = await execFile("/bin/sh", ["-c", wrapped.args[2]!]);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ["it's", "$(printf injected)", "a b"]);
});

test("flags: a box lease boots its named snapshot with the snapshot's GPU mode, or cold when that failed", () => {
  const named = emulatorArgs({ avd: "orq-pixel-9", consolePort: 5586, grpcPort: 8570, gpu: "swiftshader_indirect", snapshot: "orq-golden" });
  assert.ok(named.includes("-read-only"));
  assert.equal(named[named.indexOf("-gpu") + 1], "swiftshader_indirect");
  assert.equal(named[named.indexOf("-snapshot") + 1], "orq-golden");
  assert.ok(named.includes("-no-snapshot-save"));
  const cold = emulatorArgs({ avd: "orq-pixel-9", consolePort: 5586, grpcPort: 8570, snapshot: "orq-golden", coldBoot: true });
  assert.ok(cold.includes("-no-snapshot-load") && cold.includes("-no-snapshot-save"));
  assert.equal(cold.includes("-snapshot"), false);
  // A named golden is cold and writable, and saves nothing on exit (`adb emu avd snapshot save` does).
  const golden = emulatorArgs({ avd: "orq-pixel-9", consolePort: 5554, grpcPort: 8554, golden: true, snapshot: "orq-golden" });
  assert.equal(golden.includes("-read-only"), false);
  assert.ok(golden.includes("-no-snapshot-load") && golden.includes("-no-snapshot-save"));
});

/** A fake machine: process table, environments, and every signal sent. */
function fakeMachine(procs: { pid: number; comm: string; pgrp: number; startTicks: number; env: Record<string, string> }[]) {
  const signals: string[] = [];
  const table = new Map(procs.map((proc) => [proc.pid, proc]));
  const executor = {
    procStat: async (pid: number) => {
      const proc = table.get(pid);
      return proc ? { pid, comm: proc.comm, state: "S", ppid: 1, pgrp: proc.pgrp, cpuTicks: 0, startTicks: proc.startTicks } : null;
    },
    procStats: async () => [...table.values()].map((proc) => ({ pid: proc.pid, comm: proc.comm, state: "S", ppid: 1, pgrp: proc.pgrp, cpuTicks: 0, startTicks: proc.startTicks })),
    environ: async (pid: number) => (table.has(pid) ? new Map(Object.entries(table.get(pid)!.env)) : null),
    signal: async (pgid: number | null, pid: number, signal: NodeJS.Signals) => {
      signals.push(`${signal} ${pgid ?? "-"} ${pid}`);
      // The emulator dies on any signal to it or its group.
      for (const proc of [...table.values()]) if (proc.pid === pid || (pgid !== null && proc.pgrp === pgid)) table.delete(proc.pid);
      return true;
    }
  } as unknown as DeviceExecutor;
  return { executor, signals, table };
}

test("stop: a reused pid (another program, another appdir, or a later start) is never signalled", async () => {
  const marker = { key: "ANDROID_AVD_HOME", value: "/app/avd" };
  const ours = { key: "ANDROID_AVD_HOME", value: "/app/avd" };
  const execs: string[][] = [];
  const exec: ExecFn = async (_command, args) => (execs.push([...args]), { exitCode: 0, stdout: "", stderr: "" });
  const base = { exec, adb: "adb", env: {}, serial: "emulator-5586", pid: 4242, pgid: 4240, marker, graceMs: 50 };
  for (const proc of [
    { pid: 4242, comm: "bash", pgrp: 4240, startTicks: 100, env: { [ours.key]: ours.value } },
    { pid: 4242, comm: "qemu-system-x86", pgrp: 4240, startTicks: 100, env: { [ours.key]: "/other/avd" } },
    { pid: 4242, comm: "qemu-system-x86", pgrp: 4240, startTicks: 999, env: { [ours.key]: ours.value } }
  ]) {
    const machine = fakeMachine([proc]);
    assert.equal(await stopEmulator({ ...base, startTicks: 100, executor: machine.executor }), "gone");
    assert.deepEqual(machine.signals, []);
  }
  assert.deepEqual(execs, [], "not even adb emu kill");
});

test("stop: our emulator gets emu kill, then SIGTERM to its group; the launcher's group only while it carries the marker", async () => {
  const marker = { key: "ANDROID_AVD_HOME", value: "/app/avd" };
  const env = { [marker.key]: marker.value };
  const machine = fakeMachine([
    { pid: 4242, comm: "qemu-system-x86", pgrp: 4240, startTicks: 100, env },
    { pid: 4240, comm: "sg", pgrp: 4240, startTicks: 90, env }
  ]);
  const exec: ExecFn = async () => ({ exitCode: 0, stdout: "", stderr: "" });
  const how = await stopEmulator({ exec, adb: "adb", env: {}, serial: "emulator-5586", pid: 4242, pgid: 4240, marker, startTicks: 100, graceMs: 50, executor: machine.executor });
  assert.equal(how, "sigterm");
  assert.deepEqual(machine.signals, ["SIGTERM 4240 4242"]);
  // A launcher group now held by a foreign process is left alone.
  const foreign = fakeMachine([{ pid: 4300, comm: "vim", pgrp: 4240, startTicks: 5, env: {} }]);
  assert.equal(await signalLauncher(foreign.executor, 4240, marker, "SIGKILL"), false);
  assert.deepEqual(foreign.signals, []);
});
