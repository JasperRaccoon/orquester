import assert from "node:assert/strict";
import test from "node:test";

import { allocateEmulatorPorts, consolePortCandidates, consolePortOf, emulatorArgs, grpcPortFor, kvmCommand, serialOf, shellQuote } from "./emulator.ts";

test("flags: a lease boots read-only from the snapshot without saving; a golden boot is cold and writable", () => {
  const lease = emulatorArgs({ avd: "orq-pixel-9", consolePort: 5586, grpcPort: 8570 });
  assert.deepEqual(lease, [
    "-read-only",
    "-avd",
    "orq-pixel-9",
    "-no-window",
    "-no-audio",
    "-no-boot-anim",
    "-no-metrics",
    "-accel",
    "on",
    "-gpu",
    "swangle_indirect",
    "-port",
    "5586",
    "-grpc",
    "8570",
    "-grpc-use-token",
    "-camera-back",
    "none",
    "-camera-front",
    "none",
    "-no-snapshot-save"
  ]);
  const golden = emulatorArgs({ avd: "orq-pixel-9", consolePort: 5554, grpcPort: 8554, golden: true });
  assert.equal(golden.includes("-read-only"), false);
  assert.equal(golden.includes("-no-snapshot-save"), false);
  assert.equal(golden.at(-1), "-no-snapshot-load");
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
  assert.deepEqual(got, { consolePort: 5592, grpcPort: grpcPortFor(5592) });
  assert.equal(await allocateEmulatorPorts(new Set(), async () => false), null);
});

test("kvm: direct runs the binary; sg wraps it in one quoted exec", () => {
  assert.deepEqual(kvmCommand("direct", "/sdk/emulator/emulator", ["-avd", "x"]), { command: "/sdk/emulator/emulator", args: ["-avd", "x"] });
  assert.deepEqual(kvmCommand("sg", "/a b/emulator", ["-avd", "it's"]), { command: "sg", args: ["kvm", "-c", `exec '/a b/emulator' -avd 'it'\\''s'`] });
  assert.equal(shellQuote(["-port", "5554", "a=b"]), "-port 5554 a=b");
});
