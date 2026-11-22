import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { duplexPair, type Duplex } from "node:stream";
import test from "node:test";

import type { DeviceForwardLink, DeviceListener, DeviceMachine } from "./forwards.ts";
import { FakeDeviceHost, FakeHostFactory, startTestDeviceService } from "./testing.ts";

const signal = () => new AbortController().signal;

/** A link whose project is on `project`, where Metro answers when `metro`; it records listens and closes. */
function fakeLink(project: DeviceMachine, metro: boolean) {
  const listens: { machine: DeviceMachine; port: number; exact: boolean; closed: boolean }[] = [];
  let next = 21_000;
  const link: DeviceForwardLink = {
    projectMachine: () => project,
    async connect(_machine, port): Promise<Duplex> {
      const [mine, theirs] = duplexPair();
      theirs.once("data", () => {
        if (metro && port === 8081) theirs.end("HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n\r\npackager-status:running");
        else theirs.end("HTTP/1.1 404 Not Found\r\n\r\n");
      });
      return mine;
    },
    async listen(machine, port, _upstream, options): Promise<DeviceListener> {
      const entry = { machine, port, exact: options.exact, closed: false };
      listens.push(entry);
      const listening = options.exact ? port : next++;
      return { port: listening, alive: async () => !entry.closed, close: async () => void (entry.closed = true) };
    }
  };
  return { link, listens };
}

/** jasper, an own Linux machine: its `adb reverse` calls resolve `reversed` as they come. */
function jasperHost() {
  const host = new FakeDeviceHost("box:jasper", "byo", ["android"], "jasper (your Linux machine)");
  host.boxInfo = { boxId: "jasper", provider: "byo", hourlyUsd: 0, startedAt: "2026-11-22T00:00:00.000Z", deadlineAt: null };
  let reversed: (args: string[]) => void = () => undefined;
  const firstReverse = new Promise<string[]>((resolve) => (reversed = resolve));
  host.runImpl = async (command, args) => {
    if (command === "adb" && args.includes("reverse")) reversed([...args]);
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { host, firstReverse };
}

const ANDROID = { android: { enabled: true }, pool: { placement: "pool-only" } };

test("a device on another machine than its project gets Metro forwarded and adb reverse; forwards persist and close with the lease", async () => {
  const { link, listens } = fakeLink({ kind: "host" }, true);
  const { host, firstReverse } = jasperHost();
  const t = await startTestDeviceService({ factories: [new FakeHostFactory("byo", ["android"], [host])], settings: ANDROID, deps: { forwardLink: link } });
  try {
    const { lease } = await t.service.toolOpen("t1", { platform: "android" }, signal());
    assert.deepEqual(await firstReverse, ["-s", lease.deviceId, "reverse", "tcp:8081", "tcp:21000"]);
    // A change queued behind the automatic one sees it done.
    assert.deepEqual(await t.service.removeLeaseForward(lease.id, 9999), [{ devicePort: 8081, targetPort: 8081, auto: true }]);
    assert.deepEqual(listens.map((entry) => [entry.machine, entry.port, entry.exact]), [[{ kind: "box", boxId: "jasper" }, 8081, false]]);

    const forwards = await t.service.addLeaseForward(lease.id, { devicePort: 3000, targetPort: 3001 });
    assert.deepEqual(forwards, [
      { devicePort: 3000, targetPort: 3001, auto: false },
      { devicePort: 8081, targetPort: 8081, auto: true }
    ]);
    assert.ok(host.runs.some((run) => run.args.join(" ") === `-s ${lease.deviceId} reverse tcp:3000 tcp:21001`));
    await t.service.flush();
    const stored = JSON.parse(await readFile(join(t.dir, "device-leases.json"), "utf8"));
    assert.deepEqual(stored.leases[0].forwards.map((entry: { devicePort: number }) => entry.devicePort), [3000, 8081]);

    await t.service.toolClose("t1", { device: lease.id });
    assert.ok(listens.every((entry) => entry.closed), "every listener closed");
    for (const port of [3000, 8081]) assert.ok(host.runs.some((run) => run.args.join(" ") === `-s ${lease.deviceId} reverse --remove tcp:${port}`));
  } finally {
    await t.cleanup();
  }
});

test("a device on its project's machine needs no forward; one whose host goes loses its listeners", async () => {
  const same = fakeLink({ kind: "box", boxId: "jasper" }, true);
  const { host } = jasperHost();
  const factory = new FakeHostFactory("byo", ["android"], [host]);
  const t = await startTestDeviceService({ factories: [factory], settings: ANDROID, deps: { forwardLink: same.link } });
  try {
    const { lease } = await t.service.toolOpen("t1", { platform: "android" }, signal());
    assert.deepEqual(await t.service.removeLeaseForward(lease.id, 9999), []);
    // Asked for, a port on the same machine is `adb reverse` alone.
    await t.service.addLeaseForward(lease.id, { devicePort: 3000 });
    assert.deepEqual(same.listens, []);
    assert.ok(host.runs.some((run) => run.args.join(" ") === `-s ${lease.deviceId} reverse tcp:3000 tcp:3000`));
  } finally {
    await t.cleanup();
  }

  const other = fakeLink({ kind: "host" }, false);
  const second = jasperHost();
  const factory2 = new FakeHostFactory("byo", ["android"], [second.host]);
  const u = await startTestDeviceService({ factories: [factory2], settings: ANDROID, deps: { forwardLink: other.link } });
  try {
    const { lease } = await u.service.toolOpen("t1", { platform: "android" }, signal());
    await u.service.addLeaseForward(lease.id, { devicePort: 3000 });
    assert.equal(other.listens.length, 1, "no Metro on the project: only the asked-for port");
    factory2.ctx!.removeHost(second.host.id);
    // Queued behind the lost lease's close.
    assert.deepEqual(await u.service.removeLeaseForward(lease.id, 3000), []);
    assert.equal(other.listens[0]!.closed, true);
  } finally {
    await u.cleanup();
  }
});
